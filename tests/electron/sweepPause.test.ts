// sweepPause: what a code-graph sweep waits on at each yield boundary. The loop governor first (HP-3), then the typing
// gate (nothing within 500 ms of a keystroke, capped at 2 s), so a background index of a big project stands aside while
// someone types, as the conversation ingest and the indexer's passes already do.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sweepPause } from '../../src/main/sweepPause'
import { noteTyping, resetTypingQuiet, typingGateStats, QUIET_MS, QUIET_MAX_WAIT_MS } from '../../src/main/typingQuiet'
import { shedRegistry } from '../../src/main/loopGovernor'
import { buildCodeGraph, codeGraphSweepCounters, _resetCodeGraphForTests } from '../../src/main/codeGraph'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = 'export function alpha() { return beta() }\nexport function beta() { return 1 }\n'
const files = (n: number): string[] => Array.from({ length: n }, (_, i) => `/repo/src/f${i}.ts`)

beforeEach(() => {
  resetTypingQuiet()
  shedRegistry.setShed(false)
  _resetCodeGraphForTests()
})
afterEach(() => {
  vi.useRealTimers()
  shedRegistry.setShed(false)
  resetTypingQuiet()
})

/** Settles every promise callback that is ready, without moving any clock. */
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }

describe('sweepPause, with the real governor and typing gate', () => {
  it('resolves at once, with no timer, when the loop is calm and nobody has typed', async () => {
    vi.useFakeTimers()
    let done = false
    void sweepPause().then(() => { done = true })
    await settle()
    expect(done).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(typingGateStats().waits).toBe(0)
  })

  it('a key just typed holds it for the quiet period, and no longer', async () => {
    vi.useFakeTimers()
    noteTyping(Date.now())
    let done = false
    void sweepPause().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(typingGateStats()).toMatchObject({ waits: 1, capped: 0 })
  })

  it('a line that never goes quiet holds it only up to the cap', async () => {
    vi.useFakeTimers()
    let done = false
    noteTyping(Date.now())
    void sweepPause().then(() => { done = true })
    for (let t = 0; t < QUIET_MAX_WAIT_MS - 100; t += 100) {
      await vi.advanceTimersByTimeAsync(100)
      noteTyping(Date.now())
    }
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toBe(true)
    expect(typingGateStats()).toMatchObject({ waits: 1, capped: 1 })
  })

  it('while the governor sheds it waits for SHED to end before the typing gate is asked', async () => {
    vi.useFakeTimers()
    shedRegistry.setShed(true)
    let done = false
    void sweepPause().then(() => { done = true })
    await settle()
    expect(done).toBe(false)
    shedRegistry.setShed(false)
    await settle()
    expect(done).toBe(true)
  })
})

describe('sweepPause, with its waits injected', () => {
  it('asks the governor first and the typing gate only once the governor has let it go', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const notShed = (): Promise<void> => new Promise<void>((r) => { order.push('notShed'); release = () => { order.push('notShed done'); r() } })
    const typingQuiet = async (): Promise<void> => { order.push('typingQuiet') }
    const p = sweepPause({ notShed, typingQuiet })
    await settle()
    expect(order).toEqual(['notShed'])
    release()
    await p
    expect(order).toEqual(['notShed', 'notShed done', 'typingQuiet'])
  })
})

describe('a code-graph sweep given sweepPause stands aside for typing', () => {
  it('holds at its first boundary while keys arrive, and finishes once the line is quiet', async () => {
    let quiet: () => void = () => {}
    let asked = 0
    const typingQuiet = (): Promise<void> => { asked++; return asked === 1 ? new Promise<void>((r) => { quiet = r }) : Promise.resolve() }
    const run = buildCodeGraph({ listFiles: async () => files(40), readFile: async () => SRC, pause: () => sweepPause({ typingQuiet }) }, 'typing')
    // Wait until it reaches its first boundary and waits there. Time-bounded, not tick-counted: the parser's first
    // load is asynchronous and takes as long as the machine needs (a count of 200 setImmediate turns ran out under
    // a parallel typecheck and lint).
    await vi.waitFor(() => { expect(asked).toBe(1) }, { timeout: 15_000, interval: 5 })
    const before = codeGraphSweepCounters().parsed
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    expect(codeGraphSweepCounters().parsed).toBe(before)
    expect(before).toBeLessThan(40)
    quiet()
    const stats = await run
    expect(stats.files).toBe(40)
    expect(codeGraphSweepCounters()).toMatchObject({ parsed: 40, pauses: 2 })
  })
})

describe('the conversation ingest waits on the same pause, in the same order', () => {
  it("ingestRuntime's quiet is sweepPause (the governor, then the typing gate), not its own pair of waits", () => {
    const text = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'ingestRuntime.ts'), 'utf8')
    expect(text).toMatch(/quiet: \(\) => sweepPause\(\),/)
    expect(text).toMatch(/import \{ sweepPause \} from '\.\/sweepPause'/)
    expect(text).not.toMatch(/whenTypingQuiet|whenNotShed\(/)
  })
})
