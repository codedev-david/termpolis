import { describe, it, expect, vi, afterEach } from 'vitest'
import { modelHoldBridge, relaunchAgentWithModel, relaunchClaudeWithModel, relaunchHeld } from '../../src/renderer/src/lib/modelRelaunch'
import type { HeldRelaunch, ModelHoldBridge } from '../../src/renderer/src/lib/modelRelaunch'
import type { ModelCatalog } from '../../src/renderer/src/lib/modelCatalog'

function fakeIo() {
  const writes: string[] = []
  const sleeps: number[] = []
  return {
    writes,
    sleeps,
    write: (data: string) => { writes.push(data) },
    sleep: async (ms: number) => { sleeps.push(ms) },
  }
}

describe('relaunchClaudeWithModel', () => {
  it('sends Ctrl+C, two Ctrl+D presses, then relaunches with --model and --continue', async () => {
    const io = fakeIo()
    await relaunchClaudeWithModel('sonnet', io)
    expect(io.writes).toEqual(['\x03', '\x04', '\x04', 'claude --model sonnet --continue\r'])
  })

  it('validates the alias the same way claudeModelArg does (no injection)', async () => {
    const io = fakeIo()
    await relaunchClaudeWithModel('sonnet; rm -rf /', io)
    expect(io.writes).toEqual([])
  })

  it('no-ops for an empty/placeholder alias', async () => {
    const io = fakeIo()
    await relaunchClaudeWithModel('', io)
    expect(io.writes).toEqual([])
  })

  it('waits between each keystroke with the documented timing', async () => {
    const io = fakeIo()
    await relaunchClaudeWithModel('opus', io)
    expect(io.sleeps).toEqual([150, 150, 1500])
  })

  it('builds the relaunch command for every valid Claude alias', async () => {
    for (const alias of ['fable', 'opus', 'sonnet', 'haiku']) {
      const io = fakeIo()
      await relaunchClaudeWithModel(alias, io)
      expect(io.writes[3]).toBe(`claude --model ${alias} --continue\r`)
    }
  })
})

const CAT: ModelCatalog = {
  claude: { provider: 'claude', models: [{ id: 'opus', label: 'Opus' }], source: 'builtin', fetchedAt: 0 },
  codex: { provider: 'codex', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }], source: 'cli', fetchedAt: 1 },
  gemini: { provider: 'gemini', models: [{ id: 'gemini-3.8-flash-high', label: 'Flash' }], source: 'cli', fetchedAt: 1 },
}

describe('relaunchAgentWithModel', () => {
  // Codex 0.153.4 exits on a single Ctrl+C at an idle composer (a probe in ConPTY, impl-launch-switch),
  // so the Ctrl+D that followed it reached the shell, where it closes a bash terminal; agy's Ctrl+C
  // stops a turn or arms its own exit (R2). Both exit with their own command now, typed into a box
  // cleared first, after an Esc that stops a turn at work: no Ctrl+C, no Ctrl+D.
  it('exits Codex with its own /quit, never Ctrl+C or Ctrl+D, and resumes its last session', async () => {
    const io = fakeIo()
    await relaunchAgentWithModel('codex', 'gpt-5.6-sol', CAT, io)
    expect(io.writes).toEqual(['\x1b', '\x15'.repeat(20), '/quit', '\r', 'codex --model gpt-5.6-sol resume --last\r'])
    expect(io.sleeps).toEqual([150, 150, 150, 1500])
  })

  it('exits the Antigravity CLI with its own /exit, never Ctrl+C or Ctrl+D, and --continue', async () => {
    const io = fakeIo()
    await relaunchAgentWithModel('gemini', 'gemini-3.8-flash-high', CAT, io)
    expect(io.writes).toEqual(['\x1b', '\x15'.repeat(20), '/exit', '\r', 'agy --model gemini-3.8-flash-high --continue\r'])
    expect(io.writes.join('')).not.toMatch(/[\x03\x04]/)
  })

  it('still sends two Ctrl+D for Claude', async () => {
    const io = fakeIo()
    await relaunchAgentWithModel('claude', 'opus', CAT, io)
    expect(io.writes).toEqual(['\x03', '\x04', '\x04', 'claude --model opus --continue\r'])
    expect(io.sleeps).toEqual([150, 150, 1500])
  })

  it('writes NOTHING when the model is not one the catalog offers', async () => {
    // The guard has to come before the exit sequence: killing the agent and then
    // failing to relaunch it would be strictly worse than doing nothing.
    for (const [p, id] of [['codex', 'gpt-9-imaginary'], ['claude', 'claude-opus-5-5'], ['gemini', '']] as const) {
      const io = fakeIo()
      await relaunchAgentWithModel(p, id, CAT, io)
      expect(io.writes).toEqual([])
      expect(io.sleeps).toEqual([])
    }
  })

  it('no-ops when no catalog has arrived for a discovered provider', async () => {
    const io = fakeIo()
    await relaunchAgentWithModel('codex', 'gpt-5.6-sol', null, io)
    expect(io.writes).toEqual([])
  })
})

describe('relaunchHeld: the picker under the terminal\'s relaunch lock (§7.5)', () => {
  afterEach(() => { delete (window as any).accounts })

  function held(over: Partial<HeldRelaunch> = {}) {
    const calls: string[] = []
    const writes: Array<[string, string | undefined]> = []
    const main: ModelHoldBridge = {
      modelHold: vi.fn(async (req) => { calls.push(`hold ${req.terminalId} ${req.line}`); return { success: true as const, data: { key: 'k1' } } }),
      modelRelease: vi.fn(async (id: string, key: string) => { calls.push(`release ${id} ${key}`) }),
    }
    const r: HeldRelaunch = {
      terminalId: 't1',
      provider: 'codex',
      modelId: 'gpt-5.6-sol',
      catalog: CAT,
      begin: vi.fn(() => { calls.push('begin'); return true }),
      end: vi.fn(() => { calls.push('end') }),
      main,
      // Its arguments as given: a write with no key has no third one, as before the hold.
      write: (...args: [string, string, string?]) => { writes.push([args[1], args[2]]); calls.push(`write ${args[0]} ${args.length}`) },
      sleep: async () => undefined,
      ...over,
    }
    return { r, calls, writes, main }
  }

  it('holds both halves before the first key, types every key with main\'s key, and lets both go after', async () => {
    const { r, calls, writes } = held()
    expect(await relaunchHeld(r)).toBeNull()
    expect(writes).toEqual([
      ['\x1b', 'k1'], ['\x15'.repeat(20), 'k1'], ['/quit', 'k1'], ['\r', 'k1'], ['codex --model gpt-5.6-sol resume --last\r', 'k1'],
    ])
    expect(calls[0]).toBe('begin')
    expect(calls[1]).toBe('hold t1 codex --model gpt-5.6-sol resume --last')
    expect(calls.filter((c) => c.startsWith('write'))).toEqual(Array(5).fill('write t1 3'))
    expect(calls.slice(-2)).toEqual(['release t1 k1', 'end'])
  })

  it('types nothing, and takes nothing, for a model the catalog doesn\'t offer', async () => {
    const { r, calls } = held({ modelId: 'gpt-9-imaginary' })
    expect(await relaunchHeld(r)).toBeNull()
    expect(calls).toEqual([])
  })

  it('types nothing while the store holds the terminal, and lets go of no hold it never had', async () => {
    const { r, calls } = held({ begin: vi.fn(() => false) })
    expect(await relaunchHeld(r)).toBe('an account switch or another model change is running in this terminal')
    expect(calls).toEqual([])
    expect(r.end).not.toHaveBeenCalled()
  })

  it('types nothing when main refuses its hold, or can\'t be asked, and lets the store\'s half go', async () => {
    const refused = held()
    refused.main.modelHold = vi.fn(async () => ({ success: false as const, error: 'an account switch or another model change is running in this terminal' }))
    expect(await relaunchHeld(refused.r)).toBe('an account switch or another model change is running in this terminal')
    expect(refused.writes).toEqual([])
    expect(refused.main.modelRelease).not.toHaveBeenCalled()
    expect(refused.r.end).toHaveBeenCalledTimes(1)
    const broken = held()
    broken.main.modelHold = vi.fn(async () => { throw new Error('ipc gone') })
    expect(await relaunchHeld(broken.r)).toBe('ipc gone')
    expect(broken.writes).toEqual([])
    expect(broken.r.end).toHaveBeenCalledTimes(1)
  })

  it('lets both go when typing fails halfway, and a release that fails is no error', async () => {
    const { r, calls, main } = held({ write: () => { throw 'pty closed' } })
    main.modelRelease = vi.fn(async () => { throw new Error('gone') })
    expect(await relaunchHeld(r)).toBe('pty closed')
    await Promise.resolve()
    expect(main.modelRelease).toHaveBeenCalledWith('t1', 'k1')
    expect(calls[calls.length - 1]).toBe('end')
  })

  it('types with the store\'s half alone where this preload has no hold of main\'s', async () => {
    const { r, writes, calls } = held({ main: null, provider: 'gemini', modelId: 'gemini-3.8-flash-high' })
    expect(await relaunchHeld(r)).toBeNull()
    expect(calls.filter((c) => c.startsWith('write'))).toEqual(Array(5).fill('write t1 2'))
    expect(writes[writes.length - 1][0]).toBe('agy --model gemini-3.8-flash-high --continue\r')
    expect(r.end).toHaveBeenCalledTimes(1)
  })

  it('finds main\'s hold on the accounts bridge, only when it has both halves', () => {
    expect(modelHoldBridge()).toBeNull()
    ;(window as any).accounts = { modelHold: vi.fn() }
    expect(modelHoldBridge()).toBeNull()
    ;(window as any).accounts = { modelHold: vi.fn(), modelRelease: vi.fn() }
    expect(modelHoldBridge()).toBe((window as any).accounts)
  })
})
