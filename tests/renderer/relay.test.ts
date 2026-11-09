// v1.55.0 Task 10: the relay hands a session on through a memory handoff note.
import { describe, it, expect } from 'vitest'
import { HANDOFF_PROMPT, HANDOFF_WAIT_MS, handoffIdFrom, relayLaunchLine, requestHandoff, launchFromHandoff, type RelayIO } from '../../src/renderer/src/lib/relay'

const ID = 'mem-1762600000000-3-a1b2c3'
let t0 = 0

/** A fake terminal: a clock that moves with every sleep, scripted output and shellAlone answers. */
function fakeIo(opts: { output?: (polls: number) => string; alone?: Array<boolean | null>; aborted?: () => boolean } = {}): RelayIO & { writes: string[] } {
  let t = 0
  let polls = 0
  const alone = [...(opts.alone ?? [])]
  const writes: string[] = []
  return {
    writes,
    write: (d) => { writes.push(d) },
    sleep: async (ms) => { t += ms },
    now: () => t,
    outputMark: async () => 100,
    outputSince: async () => opts.output?.(++polls) ?? '',
    shellAlone: async () => (alone.length > 1 ? alone.shift()! : alone[0] ?? null),
    aborted: opts.aborted,
  }
}

describe('handoffIdFrom', () => {
  it('takes the last memory id in the output, through ANSI colour', () => {
    expect(handoffIdFrom(`saw mem-1700000000000-1-ffffff earlier\n\x1b[32m${ID}\x1b[0m`)).toBe(ID)
    expect(handoffIdFrom('no id here')).toBeNull()
    expect(handoffIdFrom(null)).toBeNull()
  })
})

describe('relayLaunchLine', () => {
  it('keeps the launch flags, sets the model and asks the new session to read the handoff first', () => {
    const line = relayLaunchLine('haiku', null, 'claude --permission-mode plan --model opus', ID)
    expect(line).toContain('--permission-mode plan')
    expect(line).toContain('--model haiku')
    expect(line).not.toContain('--model opus')
    expect(line.endsWith(`"Continue from handoff ${ID}: call memory_search for it first."`)).toBe(true)
  })

  it('with no known model keeps the bare agent, and refuses a model that is not offered', () => {
    expect(relayLaunchLine(null, null, 'claude --model opus', ID).startsWith('claude "Continue')).toBe(true)
    expect(relayLaunchLine('nope' as never, null, 'claude', ID)).toBe('')
  })
})

describe('requestHandoff', () => {
  it('pastes the prompt, presses Enter on its own, and returns the id once it shows', async () => {
    const io = fakeIo({ output: (n) => (n < 3 ? 'thinking…' : `Saved. ${ID}`) })
    expect(await requestHandoff(io)).toEqual({ started: true, id: ID })
    expect(io.writes).toEqual([`\x1b[200~${HANDOFF_PROMPT}\x1b[201~`, '\r'])
  })

  it('relay aborts cleanly if no id appears: nothing is quit, and one line says why', async () => {
    const io = fakeIo({ output: () => 'still working' })
    const res = await requestHandoff(io)
    expect(res).toEqual({ started: false, reason: expect.stringContaining('keeps running') })
    expect(io.writes).not.toContain('\x03')
    expect(io.now!()).toBeGreaterThanOrEqual(HANDOFF_WAIT_MS)
  })

  it('stops when cancelled, and survives output that cannot be read', async () => {
    const io = fakeIo({ aborted: () => true })
    expect(await requestHandoff(io)).toEqual({ started: false, reason: expect.stringContaining('cancelled') })
    const broken = fakeIo()
    broken.outputMark = async () => { throw new Error('gone') }
    broken.outputSince = async () => { throw new Error('gone') }
    expect((await requestHandoff(broken)).started).toBe(false)
    const blind = fakeIo({ aborted: () => blind.writes.length > 1 && t0++ > 0 })
    delete blind.outputMark
    delete blind.outputSince
    expect((await requestHandoff(blind)).started).toBe(false)
  })
})

describe('launchFromHandoff', () => {
  it('startRelay launches with the routed model and the handoff id once the OS says the agent quit', async () => {
    const io = fakeIo({ alone: [false, true] })
    expect(await launchFromHandoff(io, ID, 'sonnet', null, 'claude --model opus')).toEqual({ started: true, id: ID })
    expect(io.writes.slice(0, 3)).toEqual(['\x03', '\x03', '\x03'])
    expect(io.writes[3]).toBe(`claude --model sonnet "Continue from handoff ${ID}: call memory_search for it first."\r`)
  })

  it('types nothing when the agent never quits, or the model cannot start', async () => {
    const stuck = fakeIo({ alone: [false] })
    const res = await launchFromHandoff(stuck, ID, 'sonnet', null, 'claude')
    expect(res).toEqual({ started: false, reason: expect.stringContaining(ID) })
    expect(stuck.writes).toEqual(['\x03', '\x03', '\x03'])
    const bad = fakeIo({ alone: [true] })
    expect((await launchFromHandoff(bad, ID, 'nope' as never, null, 'claude')).started).toBe(false)
    expect(bad.writes).toEqual([])
  })
})
