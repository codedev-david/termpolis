import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProxyResultMsg } from '../../src/main/headroomProxy/proxySupervisor'
const {
  recordProxyResult, summarizeProxySavings, resetProxyLedger, resetProxyCounters, loadProxyBase,
  saveProxyTotalsToDisk, loadProxyBaseFromDisk, currentProxyTotals,
} = await import('../../src/main/headroomProxy/proxyLedger')
const { resetCcr } = await import('../../src/main/headroom/ccrStore')
const { resetDepthCurveAll } = await import('../../src/main/headroom/sessionDepth')

/**
 * R1 criterion 2: the receipt used to charge a retrieval only the size of the text fetched, about
 * 0.1% of the bill, while the turn that fetched it re-read the whole cached prefix. These pin the
 * charge arithmetic: cache READ at 0.1x plus OUTPUT at 5x, over pure retrieval turns only.
 */

type Turn = { toolCalls: number; retrieveCalls: number; pure: boolean }
const PURE: Turn = { toolCalls: 1, retrieveCalls: 1, pure: true }
const MIXED: Turn = { toolCalls: 2, retrieveCalls: 1, pure: false }
const TEXT_ONLY: Turn = { toolCalls: 0, retrieveCalls: 0, pure: false }

const usage = (read: number, out: number, create = 500, input = 10) =>
  ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: create, output_tokens: out })

function msg(u: ReturnType<typeof usage>, turn?: Turn): ProxyResultMsg {
  const m: Record<string, unknown> = {
    kind: 'result', changed: false, stashes: [], status: 200,
    stats: { trBlocks: 0, trOrigChars: 0, trCompChars: 0, images: 0, imgOrigBytes: 0, imgCompBytes: 0 },
    usage: u,
  }
  if (turn) m.turn = turn
  return m as unknown as ProxyResultMsg
}

/** The charge, written out once here from the spec rather than imported from the code under test. */
const charge = (read: number, out: number): number => 0.1 * read + 5 * out

let dir: string
beforeEach(() => { resetProxyLedger(); resetCcr(); resetDepthCurveAll(); dir = mkdtempSync(join(tmpdir(), 'tp-r1-turns-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('retrieval-turn charge', () => {
  it('sums 0.1 x cache_read + 5 x output over the pure turns of a replayed sequence, and only those', () => {
    const seq: Array<[ReturnType<typeof usage>, Turn | undefined]> = [
      [usage(100_000, 140), PURE],
      [usage(120_000, 300), MIXED],
      [usage(180_000, 120), PURE],
      [usage(90_000, 800), TEXT_ONLY],
      [usage(75_000, 60), undefined], // a message from before the field existed
      [usage(0, 50), PURE], // a cold-cache turn: nothing to read, still a turn
    ]
    for (const [u, t] of seq) recordProxyResult(msg(u, t))
    const s = summarizeProxySavings().session
    expect(s.retrievalTurns).toBe(3)
    expect(s.retrievalTurnUnits).toBeCloseTo(charge(100_000, 140) + charge(180_000, 120) + charge(0, 50), 6)
    expect(s.retrievalTurnUnits).toBeCloseTo(10_700 + 18_600 + 250, 6)
  })

  it('a mixed turn adds nothing: its other tool calls are work the session wanted anyway', () => {
    recordProxyResult(msg(usage(500_000, 900), MIXED))
    const s = summarizeProxySavings().session
    expect(s.retrievalTurns).toBe(0)
    expect(s.retrievalTurnUnits).toBe(0)
  })

  it('charges cache reads and output only: fresh input and cache writes are not the cost of the fetch', () => {
    recordProxyResult(msg(usage(50_000, 100, 90_000, 4_000), PURE))
    expect(summarizeProxySavings().session.retrievalTurnUnits).toBeCloseTo(charge(50_000, 100), 6)
  })

  it('still counts the turn when the usage block is missing, charging nothing', () => {
    const m = msg(usage(0, 0), PURE) as unknown as Record<string, unknown>
    delete m.usage
    recordProxyResult(m as unknown as ProxyResultMsg)
    const s = summarizeProxySavings().session
    expect(s.retrievalTurns).toBe(1)
    expect(s.retrievalTurnUnits).toBe(0)
  })

  it('does not let a malformed turn field charge anything', () => {
    for (const bad of [null, 7, 'pure', { pure: 'yes' }, { pure: 1 }, []]) {
      const m = msg(usage(100_000, 100)) as unknown as Record<string, unknown>
      m.turn = bad
      recordProxyResult(m as unknown as ProxyResultMsg)
    }
    const s = summarizeProxySavings().session
    expect(s.retrievalTurns).toBe(0)
    expect(s.retrievalTurnUnits).toBe(0)
  })

  it('folds into the cumulative figure on top of the persisted baseline', () => {
    loadProxyBase({ retrievalTurns: 5, retrievalTurnUnits: 90_000 })
    recordProxyResult(msg(usage(100_000, 140), PURE))
    const r = summarizeProxySavings()
    expect(r.session.retrievalTurns).toBe(1)
    expect(r.cumulative.retrievalTurns).toBe(6)
    expect(r.cumulative.retrievalTurnUnits).toBeCloseTo(90_000 + charge(100_000, 140), 6)
  })

  it('resetProxyCounters zeroes the retrieval counters with the rest of the lifetime meter', () => {
    loadProxyBase({ retrievalTurns: 5, retrievalTurnUnits: 90_000 })
    recordProxyResult(msg(usage(100_000, 140), PURE))
    resetProxyCounters()
    const c = summarizeProxySavings().cumulative
    expect(c.retrievalTurns).toBe(0)
    expect(c.retrievalTurnUnits).toBe(0)
  })
})

describe('turn requests, the denominator of the retrieval-turn share', () => {
  it('counts every response whose shape was read, pure or not', () => {
    recordProxyResult(msg(usage(100_000, 140), PURE))
    recordProxyResult(msg(usage(120_000, 300), MIXED))
    recordProxyResult(msg(usage(90_000, 800), TEXT_ONLY))
    const s = summarizeProxySavings().session
    expect(s.turnRequests).toBe(3)
    expect(s.retrievalTurns).toBe(1)
    expect(s.requests).toBe(3)
  })

  it('does not count a response from before the shape existed, or a malformed one', () => {
    recordProxyResult(msg(usage(100_000, 140))) // no turn field at all
    for (const bad of [null, 7, 'pure', { pure: 'yes' }, { pure: 1 }, []]) {
      const m = msg(usage(100_000, 100)) as unknown as Record<string, unknown>
      m.turn = bad
      recordProxyResult(m as unknown as ProxyResultMsg)
    }
    const s = summarizeProxySavings().session
    expect(s.requests).toBe(7) // every one is a request...
    expect(s.turnRequests).toBe(0) // ...and none of them is a shape that was read
  })

  it('differs from requests on a ledger that predates the shape, which is why it is its own counter', () => {
    loadProxyBase({ requests: 400_000, retrievalTurns: 0, turnRequests: 0 })
    recordProxyResult(msg(usage(100_000, 140), PURE))
    recordProxyResult(msg(usage(100_000, 140), TEXT_ONLY))
    const c = summarizeProxySavings().cumulative
    expect(c.requests).toBe(400_002)
    expect(c.turnRequests).toBe(2)
    expect(c.retrievalTurns / c.turnRequests).toBe(0.5) // not 1 / 400,002
  })

  it('round-trips, loads as zero from an old file, and is zeroed with the lifetime meter', () => {
    recordProxyResult(msg(usage(100_000, 140), PURE))
    saveProxyTotalsToDisk(dir)
    resetProxyLedger()
    loadProxyBaseFromDisk(dir)
    expect(currentProxyTotals().turnRequests).toBe(1)
    writeFileSync(join(dir, 'proxy-totals.json'), JSON.stringify({ requests: 5 }), 'utf8')
    loadProxyBaseFromDisk(dir)
    expect(currentProxyTotals().turnRequests).toBe(0)
    recordProxyResult(msg(usage(100_000, 140), PURE))
    resetProxyCounters()
    expect(summarizeProxySavings().cumulative.turnRequests).toBe(0)
  })
})

describe('retrieval-turn persistence', () => {
  it('round-trips through proxy-totals.json', () => {
    recordProxyResult(msg(usage(100_000, 140), PURE))
    recordProxyResult(msg(usage(180_000, 120), PURE))
    const before = currentProxyTotals()
    saveProxyTotalsToDisk(dir)
    resetProxyLedger()
    expect(currentProxyTotals().retrievalTurns).toBe(0)
    loadProxyBaseFromDisk(dir)
    const after = currentProxyTotals()
    expect(after.retrievalTurns).toBe(2)
    expect(after.retrievalTurnUnits).toBeCloseTo(before.retrievalTurnUnits, 6)
    expect(after.retrievalTurnUnits).toBeCloseTo(charge(100_000, 140) + charge(180_000, 120), 6)
  })

  it('loads an old proxy-totals.json that has none of the new fields as zeros, keeping the old ones', () => {
    // The shape v1.54.4 wrote: no retrievalTurns, no retrievalTurnUnits, no stub tally.
    const old = {
      requests: 477_099, textOrigTokens: 22_730_000_000, textSavedTokens: 17_520_000_000, images: 47_934,
      imageOrigBytes: 14_820_000_000, imageSavedBytes: 8_250_000_000, cacheReadTokens: 79_310_000_000,
      cacheCreationTokens: 1_890_000_000, inputTokens: 79_900_000, outputTokens: 499_300_000, retrieves: 76_433,
      givebackTokens: 107_800_000, toolUseOrigTokens: 0, toolUseSavedTokens: 57_400_000, worstSavedPct: 3,
      belowFloorRequests: 28_540, floorEligibleRequests: 354_967, sysChars: 1, toolsChars: 2, tpToolsChars: 3,
      maxToolCount: 50, steeredRequests: 78_434, steeredOutputTokens: 1, unsteeredRequests: 273_454, unsteeredOutputTokens: 2,
    }
    writeFileSync(join(dir, 'proxy-totals.json'), JSON.stringify(old), 'utf8')
    loadProxyBaseFromDisk(dir)
    const c = summarizeProxySavings().cumulative
    expect(c.requests).toBe(477_099)
    expect(c.retrieves).toBe(76_433)
    expect(c.retrievalTurns).toBe(0)
    expect(c.retrievalTurnUnits).toBe(0)
    // Adding to it from zero works: the migrated base is a real number, not NaN or undefined.
    recordProxyResult(msg(usage(100_000, 140), PURE))
    expect(summarizeProxySavings().cumulative.retrievalTurns).toBe(1)
    expect(summarizeProxySavings().cumulative.retrievalTurnUnits).toBeCloseTo(charge(100_000, 140), 6)
  })

  it('treats a damaged value in the new fields as zero instead of poisoning the sum', () => {
    for (const bad of ['12', null, -5, Number.NaN, {}, [], true]) {
      writeFileSync(join(dir, 'proxy-totals.json'), JSON.stringify({ requests: 3, retrievalTurns: bad, retrievalTurnUnits: bad }), 'utf8')
      resetProxyLedger()
      loadProxyBaseFromDisk(dir)
      const c = currentProxyTotals()
      expect(c.requests).toBe(3)
      expect(c.retrievalTurns).toBe(0)
      expect(c.retrievalTurnUnits).toBe(0)
    }
  })

  it('writes the new fields as plain numbers in the file', () => {
    recordProxyResult(msg(usage(100_000, 140), PURE))
    saveProxyTotalsToDisk(dir)
    const raw = JSON.parse(readFileSync(join(dir, 'proxy-totals.json'), 'utf8')) as Record<string, unknown>
    expect(raw.retrievalTurns).toBe(1)
    expect(typeof raw.retrievalTurnUnits).toBe('number')
  })
})
