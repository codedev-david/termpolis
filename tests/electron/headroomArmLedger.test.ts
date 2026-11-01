import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import {
  recordArmRequest, armState, loadArmState, resetArmLedger, ARM_NAMES,
} from '../../src/main/headroom/armLedger'
import { ARM_CLUSTERS } from '../../src/main/headroom/elisionPolicy'
import {
  recordProxyResult, summarizeProxySavings, resetProxyLedger, resetProxyCounters,
  saveProxyTotalsToDisk, loadProxyBaseFromDisk,
} from '../../src/main/headroomProxy/proxyLedger'
import type { ProxyResultMsg } from '../../src/main/headroomProxy/proxySupervisor'

const sample = (units: number, pureTurn = false, turnUnits = 0): { units: number; pureTurn: boolean; turnUnits: number } => ({ units, pureTurn, turnUnits })

describe('the arm ledger', () => {
  beforeEach(() => resetArmLedger())

  it('starts empty: every group of both arms, and the legacy total, at zero', () => {
    const s = armState()
    expect(s.late).toHaveLength(ARM_CLUSTERS)
    expect(s.holdout).toHaveLength(ARM_CLUSTERS)
    for (const c of [...s.late, ...s.holdout, s.legacy]) expect(c).toEqual({ requests: 0, work: 0, units: 0, turns: 0, turnUnits: 0 })
    expect(ARM_NAMES).toEqual(['late', 'holdout', 'legacy'])
  })

  it('counts a working request as a request, a unit of work and its cost', () => {
    recordArmRequest('late', 3, sample(700))
    recordArmRequest('late', 3, sample(300))
    expect(armState().late[3]).toEqual({ requests: 2, work: 2, units: 1000, turns: 0, turnUnits: 0 })
    expect(armState().late[2].requests).toBe(0)
  })

  it('counts a turn spent only on fetching elided text as a request and a turn, but not as work', () => {
    recordArmRequest('holdout', 7, sample(500))
    recordArmRequest('holdout', 7, sample(300, true, 250))
    expect(armState().holdout[7]).toEqual({ requests: 2, work: 1, units: 800, turns: 1, turnUnits: 250 })
  })

  it('keeps the old-policy kill switch as one total, since its requests were not randomised', () => {
    recordArmRequest('legacy', 0, sample(100))
    recordArmRequest('legacy', 19, sample(200, true, 90))
    expect(armState().legacy).toEqual({ requests: 2, work: 1, units: 300, turns: 1, turnUnits: 90 })
    expect(armState().late.every((c) => c.requests === 0)).toBe(true)
  })

  it('records nothing for an arm it does not know, a group that does not exist, or a cost that is not one', () => {
    recordArmRequest('none' as never, 0, sample(100))
    recordArmRequest('' as never, 0, sample(100))
    recordArmRequest(undefined as never, 0, sample(100))
    for (const cluster of [-1, ARM_CLUSTERS, 99, 2.5, Number.NaN, undefined, '3', null]) recordArmRequest('late', cluster as never, sample(100))
    for (const units of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined, '7']) recordArmRequest('late', 0, sample(units as never))
    recordArmRequest('late', 0, undefined as never)
    const s = armState()
    for (const c of [...s.late, ...s.holdout, s.legacy]) expect(c.requests).toBe(0)
  })

  it('clamps a turn cost that is not a number to nothing rather than poisoning the sum', () => {
    recordArmRequest('late', 0, sample(100, true, Number.NaN))
    recordArmRequest('late', 0, sample(100, true, -3))
    expect(armState().late[0]).toEqual({ requests: 2, work: 0, units: 200, turns: 2, turnUnits: 0 })
  })

  it('hands out a copy: changing it changes nothing', () => {
    recordArmRequest('late', 1, sample(10))
    const s = armState()
    s.late[1].requests = 99
    s.legacy.units = 99
    expect(armState().late[1].requests).toBe(1)
    expect(armState().legacy.units).toBe(0)
  })

  it('round-trips through its saved shape', () => {
    recordArmRequest('late', 0, sample(10))
    recordArmRequest('late', 19, sample(20, true, 5))
    recordArmRequest('holdout', 4, sample(30))
    recordArmRequest('legacy', 0, sample(40))
    const saved = JSON.parse(JSON.stringify(armState()))
    resetArmLedger()
    expect(armState().late[0].requests).toBe(0)
    loadArmState(saved)
    expect(armState()).toEqual(saved)
  })

  it('reads anything that is not its saved shape as empty', () => {
    recordArmRequest('late', 0, sample(10))
    for (const bad of [undefined, null, 5, 'x', [], true, {}, { late: 5, holdout: 'x', legacy: [] }]) {
      loadArmState(bad)
      const s = armState()
      for (const c of [...s.late, ...s.holdout, s.legacy]) expect(c.requests, JSON.stringify(bad)).toBe(0)
      recordArmRequest('late', 0, sample(10))
    }
  })

  it('reads a damaged number as zero and a short or long list of groups as what it can use', () => {
    loadArmState({
      late: [{ requests: 3, work: 2, units: 50, turns: 1, turnUnits: 4 }, { requests: -1, work: 'x', units: Number.NaN, turns: null }, 'junk', null],
      holdout: new Array(ARM_CLUSTERS + 5).fill({ requests: 1, work: 1, units: 1, turns: 0, turnUnits: 0 }),
      legacy: { requests: 2, work: 2, units: Number.POSITIVE_INFINITY, turns: 0, turnUnits: 0 },
    })
    const s = armState()
    expect(s.late).toHaveLength(ARM_CLUSTERS)
    expect(s.late[0]).toEqual({ requests: 3, work: 2, units: 50, turns: 1, turnUnits: 4 })
    expect(s.late[1]).toEqual({ requests: 0, work: 0, units: 0, turns: 0, turnUnits: 0 })
    expect(s.late[2].requests).toBe(0)
    expect(s.holdout).toHaveLength(ARM_CLUSTERS)
    expect(s.holdout.every((c) => c.requests === 1)).toBe(true)
    expect(s.legacy).toEqual({ requests: 2, work: 2, units: 0, turns: 0, turnUnits: 0 })
  })

  it('is emptied by a reset', () => {
    recordArmRequest('holdout', 2, sample(10))
    resetArmLedger()
    expect(armState().holdout[2].requests).toBe(0)
  })
})

// --- through the proxy ledger ---------------------------------------------------------------

type Arm = 'none' | 'late' | 'holdout' | 'legacy'
interface Opts {
  arm?: Arm | undefined
  cluster?: number
  usage?: Partial<{ input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number }>
  pure?: boolean
  status?: number
  origChars?: number
  compChars?: number
}
function result(o: Opts = {}): ProxyResultMsg {
  return {
    kind: 'result', changed: true, status: o.status ?? 200, stashes: [],
    usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50, ...o.usage },
    turn: { toolCalls: o.pure ? 1 : 0, retrieveCalls: o.pure ? 1 : 0, pure: !!o.pure },
    stats: {
      trBlocks: 1, trOrigChars: o.origChars ?? 40_000, trCompChars: o.compChars ?? 4_000, tuBlocks: 0, tuOrigChars: 0, tuCompChars: 0,
      images: 0, imgOrigBytes: 0, imgCompBytes: 0, sysChars: 0, toolsChars: 0, toolCount: 0, tpToolsChars: 0, msgCount: 10,
      thinkBudget: 0, steered: false,
      kinds: { plain: 0, compact: 0, dedup: 0, diff: 0, aged: 0, agedEarly: 0 },
      arm: (o.arm === undefined ? 'none' : o.arm) as Arm, armCluster: o.cluster ?? 0,
    },
  } as unknown as ProxyResultMsg
}

describe('the proxy ledger and the arms', () => {
  beforeEach(() => resetProxyLedger())

  it('prices a request in billed units: input 1, cache read 0.1, cache write 1.25, output 5', () => {
    recordProxyResult(result({ arm: 'late', cluster: 6 }))
    // 100 + 1000 x 0.1 + 200 x 1.25 + 50 x 5
    expect(armState().late[6]).toEqual({ requests: 1, work: 1, units: 700, turns: 0, turnUnits: 0 })
  })

  it('prices a turn that only fetched elided text by the prefix it read again and the call it wrote', () => {
    recordProxyResult(result({ arm: 'holdout', cluster: 2, pure: true }))
    // 1000 x 0.1 + 50 x 5
    expect(armState().holdout[2]).toEqual({ requests: 1, work: 0, units: 700, turns: 1, turnUnits: 350 })
  })

  it('files each request under the arm it ran under', () => {
    recordProxyResult(result({ arm: 'late', cluster: 1 }))
    recordProxyResult(result({ arm: 'holdout', cluster: 1 }))
    recordProxyResult(result({ arm: 'legacy' }))
    const s = armState()
    expect([s.late[1].requests, s.holdout[1].requests, s.legacy.requests]).toEqual([1, 1, 1])
  })

  it('leaves out a request that was not transformed, one the API refused, and one that cost nothing', () => {
    recordProxyResult(result({ arm: 'none' }))
    recordProxyResult(result({ arm: undefined }))
    recordProxyResult(result({ arm: 'late', status: 429 }))
    recordProxyResult(result({ arm: 'late', status: 0 }))
    recordProxyResult(result({ arm: 'late', status: 500 }))
    recordProxyResult(result({ arm: 'late', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } }))
    const s = armState()
    for (const c of [...s.late, ...s.holdout, s.legacy]) expect(c.requests).toBe(0)
    expect(summarizeProxySavings().cumulative.requests).toBe(6) // still counted as requests, as before
  })

  it('reads a result from a child that predates the arm as no arm', () => {
    const r = result({ arm: 'late' })
    delete (r.stats as unknown as Record<string, unknown>).arm
    delete (r.stats as unknown as Record<string, unknown>).armCluster
    expect(() => recordProxyResult(r)).not.toThrow()
    expect(armState().late.every((c) => c.requests === 0)).toBe(true)
  })

  it('does not count a late request as evidence about the floor: late removes less tool text on purpose', () => {
    recordProxyResult(result({ arm: 'late', origChars: 40_000, compChars: 40_000 })) // nothing removed
    expect(summarizeProxySavings().cumulative.floorEligibleRequests).toBe(0)
    expect(summarizeProxySavings().cumulative.belowFloorRequests).toBe(0)
    expect(summarizeProxySavings().cumulative.worstSavedPct).toBe(100)
    for (const arm of ['holdout', 'legacy', 'none'] as const) recordProxyResult(result({ arm, origChars: 40_000, compChars: 40_000 }))
    expect(summarizeProxySavings().cumulative.floorEligibleRequests).toBe(3)
    expect(summarizeProxySavings().cumulative.belowFloorRequests).toBe(3)
  })

  it('still counts a late request in the totals the receipt shows, as removed or not', () => {
    recordProxyResult(result({ arm: 'late', origChars: 40_000, compChars: 4_000 }))
    const c = summarizeProxySavings().cumulative
    expect(c.requests).toBe(1)
    expect(c.textOrigTokens).toBe(10_000)
    expect(c.textSavedTokens).toBe(9_000)
  })

  it('gives the controller the saved share of the requests the old policy handled, leaving late out', () => {
    for (let i = 0; i < 10; i++) recordProxyResult(result({ arm: 'legacy', origChars: 40_000, compChars: 8_000 })) // 80% removed
    for (let i = 0; i < 30; i++) recordProxyResult(result({ arm: 'late', origChars: 40_000, compChars: 36_000 })) // 10% removed
    const c = summarizeProxySavings().cumulative
    // Each request carries 10,000 tokens; the old policy removed 8,000 of them, late 1,000.
    expect(c.savedPct).toBe(Math.round(((10 * 8_000 + 30 * 1_000) / (40 * 10_000)) * 100)) // 28: the blend
    expect(c.floorSavedPct).toBe(80) // what the controller must read
  })

  it('reads the floor share as the lifetime share before anything has run late', () => {
    recordProxyResult(result({ arm: 'legacy', origChars: 40_000, compChars: 20_000 }))
    const c = summarizeProxySavings().cumulative
    expect(c.floorSavedPct).toBe(c.savedPct)
    expect(summarizeProxySavings().session.floorSavedPct).toBe(50)
  })

  it('reads the floor share as zero for a ledger with nothing in it, not as a division by zero', () => {
    expect(summarizeProxySavings().cumulative.floorSavedPct).toBe(0)
  })

  it('reads the floor share as zero when everything so far ran late', () => {
    recordProxyResult(result({ arm: 'late', origChars: 40_000, compChars: 36_000 }))
    expect(summarizeProxySavings().cumulative.floorSavedPct).toBe(0)
  })
})

describe('the arms in proxy-totals.json', () => {
  let dir: string
  beforeEach(() => {
    resetProxyLedger()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-arms-'))
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const file = (): string => path.join(dir, 'proxy-totals.json')

  it('are saved with the totals, in the same file, and restored with them', () => {
    recordProxyResult(result({ arm: 'late', cluster: 5 }))
    recordProxyResult(result({ arm: 'holdout', cluster: 9, pure: true }))
    saveProxyTotalsToDisk(dir)
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'))
    expect(saved.requests).toBe(2)
    expect(saved.arms.late[5].requests).toBe(1)
    expect(saved.arms.holdout[9]).toMatchObject({ requests: 1, turns: 1 })
    expect(saved.lateTextOrigTokens).toBe(10_000)
    resetProxyLedger()
    expect(armState().late[5].requests).toBe(0)
    loadProxyBaseFromDisk(dir)
    expect(armState().late[5].requests).toBe(1)
    expect(armState().holdout[9]).toMatchObject({ requests: 1, turns: 1, work: 0 })
    expect(summarizeProxySavings().cumulative.lateTextOrigTokens).toBe(10_000)
  })

  it('keep counting from what a restart restored', () => {
    recordProxyResult(result({ arm: 'late', cluster: 5 }))
    saveProxyTotalsToDisk(dir)
    resetProxyLedger()
    loadProxyBaseFromDisk(dir)
    recordProxyResult(result({ arm: 'late', cluster: 5 }))
    expect(armState().late[5].requests).toBe(2)
  })

  it('load as empty from a v1.54 file, which has neither the arms nor the late counters, and keep the rest', () => {
    fs.writeFileSync(file(), JSON.stringify({ requests: 477_099, textOrigTokens: 22_730_000_000, textSavedTokens: 17_520_000_000, retrieves: 76_433 }), 'utf8')
    loadProxyBaseFromDisk(dir)
    const c = summarizeProxySavings().cumulative
    expect(c.requests).toBe(477_099)
    expect(c.lateTextOrigTokens).toBe(0)
    expect(c.lateTextSavedTokens).toBe(0)
    expect(c.floorSavedPct).toBe(c.savedPct)
    expect(armState().late.every((x) => x.requests === 0)).toBe(true)
  })

  it('load as empty from a damaged arms section, and from damaged late counters', () => {
    fs.writeFileSync(file(), JSON.stringify({ requests: 5, arms: 'oops', lateTextOrigTokens: 'x', lateTextSavedTokens: -4 }), 'utf8')
    loadProxyBaseFromDisk(dir)
    expect(summarizeProxySavings().cumulative.lateTextOrigTokens).toBe(0)
    expect(summarizeProxySavings().cumulative.lateTextSavedTokens).toBe(0)
    expect(armState().late.every((x) => x.requests === 0)).toBe(true)
  })

  it('are zeroed by the lifetime reset, with the totals', () => {
    recordProxyResult(result({ arm: 'late' }))
    resetProxyCounters()
    expect(armState().late[0].requests).toBe(0)
    expect(summarizeProxySavings().cumulative.requests).toBe(0)
  })

  it('leave the totals a v1.54 reader would use as they were: the extra key is ignored by a loader that does not know it', () => {
    recordProxyResult(result({ arm: 'late' }))
    saveProxyTotalsToDisk(dir)
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'))
    for (const k of ['requests', 'textOrigTokens', 'textSavedTokens', 'cacheReadTokens', 'outputTokens', 'retrieves']) expect(typeof saved[k]).toBe('number')
  })
})
