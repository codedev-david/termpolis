// The probe that decides whether a linked job's CLI is told not to save its session. Wrong one way,
// a job's session lands in this computer's memory; wrong the other, every job sent to a computer
// with an older CLI fails on an unknown flag. So: only a help text that lists the flag says yes,
// a burst of jobs shares one probe, and a probe that got no answer is retried soon.
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { DeliverFn } from '../../src/main/secondOpinion'
import {
  NO_PERSIST_FLAGS,
  PROBE_RETRY_MS,
  PROBE_TIMEOUT_MS,
  PROBE_TTL_MS,
  createNoPersistProbe,
} from '../../src/main/cliFlagProbe'

const CLAUDE_HELP = [
  'Usage: claude [options] [command] [prompt]',
  '  --no-chrome                           Disable Claude in Chrome integration',
  '  --no-session-persistence              Disable session persistence - sessions',
  '                                        will not be saved to disk (only works with --print)',
].join('\n')
const OLD_CLAUDE_HELP = 'Usage: claude [options] [command] [prompt]\n  -p, --print   Print response and exit'
const CODEX_HELP = 'Usage: codex exec [OPTIONS] [PROMPT]\n\n      --skip-git-repo-check\n      --ephemeral\n          Run without persisting session files to disk\n'

function setup(reply: Awaited<ReturnType<DeliverFn>> | ((bin: string) => Promise<Awaited<ReturnType<DeliverFn>>>)) {
  const clock = { t: 1_000 }
  const deliver = vi.fn<DeliverFn>(async (bin) => (typeof reply === 'function' ? reply(bin) : reply))
  const probe = createNoPersistProbe({ deliver, now: () => clock.t })
  return { clock, deliver, probe }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('what it asks', () => {
  it("runs each CLI's own --help through deliver, with nothing to swap in and the probe's own limit", async () => {
    const { deliver, probe } = setup(async (bin) => ({ stdout: bin === 'claude' ? CLAUDE_HELP : CODEX_HELP, code: 0 }))
    await probe('claude')
    await probe('codex')
    expect(deliver.mock.calls.map(([bin, args, prompt, token, opts]) => [bin, args, prompt, args.includes(token), opts])).toEqual([
      ['claude', ['--help'], '', false, { timeoutMs: PROBE_TIMEOUT_MS }],
      ['codex', ['exec', '--help'], '', false, { timeoutMs: PROBE_TIMEOUT_MS }],
    ])
    expect(NO_PERSIST_FLAGS.claude?.flag).toBe('--no-session-persistence')
    expect(NO_PERSIST_FLAGS.codex?.flag).toBe('--ephemeral')
  })

  it('never probes agy, which has no such flag', async () => {
    const { deliver, probe } = setup({ stdout: CLAUDE_HELP, code: 0 })
    expect(await probe('gemini')).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
  })
})

describe('what it answers', () => {
  it('says yes only when the help lists the flag as an option of its own', async () => {
    expect(await setup({ stdout: CLAUDE_HELP, code: 0 }).probe('claude')).toBe(true)
    expect(await setup({ stdout: CODEX_HELP, code: 0 }).probe('codex')).toBe(true)
    // On stderr, as some CLIs print help.
    expect(await setup({ stdout: '', stderr: CODEX_HELP, code: 0 }).probe('codex')).toBe(true)
    expect(await setup({ stdout: OLD_CLAUDE_HELP, code: 0 }).probe('claude')).toBe(false)
    // A longer option that merely starts with the flag is not the flag.
    expect(await setup({ stdout: '  --ephemeral-mode   other', code: 0 }).probe('codex')).toBe(false)
    expect(await setup({ stdout: 'see --no-session-persistence-x', code: 0 }).probe('claude')).toBe(false)
  })

  it('says no when deliver fails, rejects or never settles', async () => {
    expect(await setup({ stdout: '', stderr: 'claude: command not found', code: 1 }).probe('claude')).toBe(false)
    expect(await setup(async () => { throw new Error('spawn EPERM') }).probe('claude')).toBe(false)
    vi.useFakeTimers()
    const hung = setup(() => new Promise(() => {}))
    const answer = hung.probe('codex')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 5_000)
    expect(await answer).toBe(false)
  })
})

describe('how long an answer is kept', () => {
  it('shares one probe between every job that asks while it runs', async () => {
    let release!: () => void
    const { deliver, probe } = setup(() => new Promise((resolve) => (release = () => resolve({ stdout: CLAUDE_HELP, code: 0 }))))
    const burst = [probe('claude'), probe('claude'), probe('claude')]
    expect(deliver).toHaveBeenCalledTimes(1)
    release()
    expect(await Promise.all(burst)).toEqual([true, true, true])
  })

  it('keeps an answer, yes or no, for the TTL and then asks again', async () => {
    const { clock, deliver, probe } = setup({ stdout: OLD_CLAUDE_HELP, code: 0 })
    expect(await probe('claude')).toBe(false)
    clock.t += PROBE_TTL_MS - 1
    expect(await probe('claude')).toBe(false)
    expect(deliver).toHaveBeenCalledTimes(1)
    // The CLI was updated meanwhile.
    deliver.mockResolvedValue({ stdout: CLAUDE_HELP, code: 0 })
    clock.t += 1
    expect(await probe('claude')).toBe(true)
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('retries a probe that got no answer after a minute, not ten', async () => {
    const { clock, deliver, probe } = setup({ stdout: '', stderr: 'EBUSY', code: 1 })
    expect(await probe('codex')).toBe(false)
    clock.t += PROBE_RETRY_MS - 1
    await probe('codex')
    expect(deliver).toHaveBeenCalledTimes(1)
    clock.t += 1
    deliver.mockResolvedValue({ stdout: CODEX_HELP, code: 0 })
    expect(await probe('codex')).toBe(true)
  })

  it('counts a help that exits 0 but prints nothing as no answer', async () => {
    const { clock, deliver, probe } = setup({ stdout: '  ', code: 0 })
    expect(await probe('claude')).toBe(false)
    clock.t += PROBE_RETRY_MS
    await probe('claude')
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('keeps each agent apart', async () => {
    const { deliver, probe } = setup(async (bin) => ({ stdout: bin === 'claude' ? CLAUDE_HELP : OLD_CLAUDE_HELP, code: 0 }))
    expect(await probe('claude')).toBe(true)
    expect(await probe('codex')).toBe(false)
    expect(await probe('claude')).toBe(true)
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('uses the real clock and the default limits when none are given', async () => {
    const deliver = vi.fn<DeliverFn>(async () => ({ stdout: CODEX_HELP, code: 0 }))
    const probe = createNoPersistProbe({ deliver })
    expect(await probe('codex')).toBe(true)
    expect(await probe('codex')).toBe(true)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})
