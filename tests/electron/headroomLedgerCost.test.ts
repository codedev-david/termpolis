import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProxyResultMsg } from '../../src/main/headroomProxy/proxySupervisor'

/**
 * D11 for the Electron main thread. Every answer the proxy child reads reaches the main process as a frame, and
 * recordProxyResult runs once for each, on the thread that also draws the window and answers the terminals. It is a few
 * dozen additions and a handful of map updates (measured 0.1 to 0.5 microseconds a result on the author's machine), and
 * nothing here would notice if it stopped being: a stall in it, or a file written on every result, passed every test.
 *
 * Two things are held, neither by an absolute time. No file call is made while results are recorded (the totals are
 * written later, by a debounced save, which this does not call): counted by the same wrapper that the clock test puts
 * on crypto, over the calls that read, write, make or look at a file, sync or not. And the time is held relative to a
 * baseline in the same process that builds the same message and adds up the same numbers, best of several rounds,
 * with a margin of a hundred times and five milliseconds: recording runs a few times the baseline, a spin of two
 * milliseconds a result (a few thousand times it) and a write a result (a thousand times) are far outside it, and a slow
 * moment of the machine is a slow moment of both.
 */

const FS = vi.hoisted(() => ({
  armed: false,
  calls: [] as string[],
  names: [
    'readFileSync', 'writeFileSync', 'appendFileSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'mkdirSync', 'openSync',
    'renameSync', 'unlinkSync', 'copyFileSync', 'rmSync', 'readFile', 'writeFile', 'appendFile', 'stat', 'lstat', 'mkdir', 'rename',
    'unlink', 'open', 'createReadStream', 'createWriteStream',
  ],
}))
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const wrapped: Record<string, unknown> = { ...real }
  for (const name of FS.names) {
    const fn = (real as unknown as Record<string, unknown>)[name]
    if (typeof fn === 'function') wrapped[name] = (...a: unknown[]): unknown => { if (FS.armed) FS.calls.push(name); return (fn as (...b: unknown[]) => unknown)(...a) }
  }
  return { ...wrapped, default: wrapped }
})

const ARMS = ['late', 'holdout', 'legacy'] as const
const OFFERS = ['direct', 'deferred', 'absent'] as const

/** A result as the child posts it, in the mix a busy run makes: plain turns, retrieval turns, hops, three arms, 300 conversations, a stash now and then. */
function message(i: number): ProxyResultMsg {
  const turn = i % 5 === 0 ? { toolCalls: 1, retrieveCalls: 1, pure: true } : i % 11 === 0 ? { toolCalls: 1, retrieveCalls: 0, pure: false, hop: true } : { toolCalls: i % 3, retrieveCalls: 0, pure: false }
  const stats: Record<string, unknown> = {
    trBlocks: i % 4, trOrigChars: 4_000 + (i % 7) * 1_000, trCompChars: 1_200 + (i % 7) * 100, images: 0, imgOrigBytes: 0, imgCompBytes: 0,
    convKey: 1 + (i % 300), arm: ARMS[i % 3], armCluster: i % 20, retrieveOffer: OFFERS[i % 3],
  }
  const stashes = i % 50 === 0 ? [{ token: `hr_${(1_000_000 + i).toString(16).padStart(16, '0')}`, original: 'x'.repeat(200), meta: { kind: 'compact', tool: 'Read', chars: 200, view: 80, policy: 'late' } }] : []
  return { kind: 'result', changed: i % 2 === 0, stashes, status: 200, stats, usage: { input_tokens: 10, cache_read_input_tokens: 50_000 + (i % 13) * 1_000, cache_creation_input_tokens: 400, output_tokens: 90 + (i % 17) }, turn } as unknown as ProxyResultMsg
}

/** What the baseline does with a message: the same numbers added up, which is all it has in common with recording it. */
function touch(m: ProxyResultMsg): number {
  const s = m.stats as unknown as Record<string, number>
  const u = m.usage as unknown as Record<string, number>
  return s.trOrigChars + s.trCompChars + s.convKey + s.armCluster + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens + m.stashes.length
}

describe('recording a result on the main thread', () => {
  beforeEach(() => { FS.armed = false; FS.calls.length = 0 })

  it('makes no file call, and takes no more than a wide multiple of building the message and adding up its numbers', async () => {
    vi.resetModules()
    const { recordProxyResult, resetProxyLedger, currentProxyTotals } = await import('../../src/main/headroomProxy/proxyLedger')
    const N = 10_000
    let real = Infinity
    let base = Infinity
    let sink = 0
    for (let round = 0; round < 7; round++) {
      resetProxyLedger()
      FS.armed = true
      let t0 = process.hrtime.bigint()
      for (let i = 0; i < N; i++) recordProxyResult(message(i))
      real = Math.min(real, Number(process.hrtime.bigint() - t0) / 1e6)
      FS.armed = false
      t0 = process.hrtime.bigint()
      for (let i = 0; i < N; i++) sink += touch(message(i))
      base = Math.min(base, Number(process.hrtime.bigint() - t0) / 1e6)
    }
    // The loop did its work: every result was counted, so a fast run is not a run that skipped it.
    expect(currentProxyTotals().requests).toBe(N)
    expect(sink).toBeGreaterThan(0)
    expect(FS.calls).toEqual([])
    // Measured here: recording ran 1.5 to 5 times the baseline.
    expect(real, `recording ${N} results took ${real.toFixed(2)} ms against ${base.toFixed(2)} ms for the baseline`).toBeLessThanOrEqual(100 * base + 5)
  }, 120_000)

  it('and the file counter counts: a result recorded after the wrapper sees a call is reported', async () => {
    const fs = await import('fs')
    FS.armed = true
    try { fs.existsSync(__filename); fs.statSync(__filename) } finally { FS.armed = false }
    expect(FS.calls).toEqual(['existsSync', 'statSync'])
  })
})
