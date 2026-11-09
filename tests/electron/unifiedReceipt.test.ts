import { describe, it, expect, beforeEach } from 'vitest'
import { leverRows, type LeverInputs } from '../../src/main/headroom/leverRows'
import { compareArms, MIN_ARM_REQUESTS, type ArmComparison } from '../../src/main/headroom/armCompare'
import { summarizeUnifiedSavings } from '../../src/main/headroom/unifiedReceipt'
import { resetLedger } from '../../src/main/headroom/savingsLedger'
import { resetProxyLedger } from '../../src/main/headroomProxy/proxyLedger'
import { resetArmLedger } from '../../src/main/headroom/armLedger'
import { claimFirstPrompt, emitFirstPrompt, primerCounts, resetPrimerGuard, armOf } from '../../src/main/primerSessionGuard'

const empty = compareArms(undefined)
const base = (over: Partial<LeverInputs> = {}): LeverInputs => ({
  arms: empty, byModel: {}, steeredRequests: 0, unsteeredRequests: 0, steeredAvgOutput: 0, unsteeredAvgOutput: 0,
  primer: { focused: 0, holdout: 0, relays: 0 }, ...over,
})
const withArms = (over: Partial<ArmComparison>): ArmComparison => ({
  ...empty,
  late: { ...empty.late, requests: 900 },
  holdout: { ...empty.holdout, requests: 600 },
  ...over,
})
const row = (rows: ReturnType<typeof leverRows>, id: string) => rows.find((r) => r.id === id)!

describe('receipt lever rows', () => {
  it('lists the six levers in order', () => {
    expect(leverRows(base()).map((r) => r.id)).toEqual(['routing', 'late-elision', 'relay', 'focused-recall', 'graph-first', 'lean-output'])
  })

  it("rows stay 'collecting' until the arm comparison is significant", () => {
    const thin = withArms({ late: { ...empty.late, requests: 900 }, holdout: { ...empty.holdout, requests: 120 } })
    expect(row(leverRows(base({ arms: thin })), 'late-elision').status).toEqual({ kind: 'collecting', n: 120, of: MIN_ARM_REQUESTS })
    // Enough requests, interval still spans zero: not a measurement.
    const unclear = withArms({ verdict: 'no-clear-difference', costDeltaPct: -3, costMarginPct: 6 })
    expect(row(leverRows(base({ arms: unclear })), 'late-elision').status).toEqual({ kind: 'no-clear-difference', deltaPct: -3, marginPct: 6 })
    // A verdict without its numbers is still collecting, never a measurement.
    const broken = withArms({ verdict: 'late-cheaper', costDeltaPct: null, costMarginPct: null })
    expect(row(leverRows(base({ arms: broken })), 'late-elision').status.kind).toBe('collecting')
    const unclearBroken = withArms({ verdict: 'no-clear-difference', costDeltaPct: null, costMarginPct: null })
    expect(row(leverRows(base({ arms: unclearBroken })), 'late-elision').status.kind).toBe('collecting')
    for (const verdict of ['late-cheaper', 'late-costlier'] as const) {
      const sig = withArms({ verdict, costDeltaPct: verdict === 'late-cheaper' ? -9 : 7, costMarginPct: 4 })
      expect(row(leverRows(base({ arms: sig })), 'late-elision').status).toEqual({ kind: 'measured', deltaPct: verdict === 'late-cheaper' ? -9 : 7, marginPct: 4 })
    }
  })

  it('lean output collects until both steering arms have the minimum, then reports means only', () => {
    const few = row(leverRows(base({ steeredRequests: 4000, unsteeredRequests: 300 })), 'lean-output')
    expect(few.status).toEqual({ kind: 'collecting', n: 300, of: MIN_ARM_REQUESTS })
    const many = row(leverRows(base({ steeredRequests: 4000, unsteeredRequests: 800, steeredAvgOutput: 410, unsteeredAvgOutput: 1520 })), 'lean-output')
    expect(many.status).toEqual({ kind: 'observed' })
    expect(many.detail).toContain('410')
    expect(many.detail).toContain('1,520')
    expect(many.detail).toContain('not a controlled comparison')
  })

  it('routing shows each family share of requests and is never called a saving', () => {
    const byModel = {
      opus: { requests: 30, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 },
      sonnet: { requests: 70, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 },
      haiku: { requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 },
    }
    const r = row(leverRows(base({ byModel })), 'routing')
    expect(r.detail).toBe('sonnet 70% · opus 30% of 100 requests')
    expect(r.status).toEqual({ kind: 'observed' })
    expect(row(leverRows(base()), 'routing').detail).toBe('No requests counted by model yet.')
  })

  it('relay and focused recall state their counts, and junk input reads as zero', () => {
    const rows = leverRows(base({ primer: { focused: 12, holdout: 2, relays: 3 } }))
    expect(row(rows, 'relay').detail).toContain('3 prompts relayed')
    expect(row(rows, 'focused-recall').detail).toContain('12 focused and 2 holdout sessions')
    const junk = leverRows({ ...base(), primer: { focused: NaN, holdout: -1, relays: Infinity }, byModel: undefined as never })
    expect(row(junk, 'relay').detail).toContain('0 prompts')
    expect(row(junk, 'focused-recall').detail).toContain('0 focused and 0 holdout')
  })
})

describe('primer counts and the receipt', () => {
  beforeEach(() => { resetPrimerGuard(); resetLedger(); resetProxyLedger(); resetArmLedger() })

  it('counts each session once by its arm, and relays after a compaction', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `sess-${i}`)
    for (const id of ids) { claimFirstPrompt(id, 1); claimFirstPrompt(id, 2) }
    emitFirstPrompt('sess-1', 'hello', undefined, undefined, true)
    emitFirstPrompt('sess-2', 'hello', undefined)
    const holdout = ids.filter((id) => armOf(id) === 'holdout').length
    expect(primerCounts()).toEqual({ focused: 40 - holdout, holdout, relays: 1 })
    resetPrimerGuard()
    expect(primerCounts()).toEqual({ focused: 0, holdout: 0, relays: 0 })
  })

  it('the unified receipt carries the lever rows, collecting on an empty ledger', () => {
    const r = summarizeUnifiedSavings()
    expect(r.levers).toHaveLength(6)
    expect(row(r.levers, 'late-elision').status).toEqual({ kind: 'collecting', n: 0, of: MIN_ARM_REQUESTS })
  })
})
