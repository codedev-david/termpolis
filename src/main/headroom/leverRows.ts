import type { ArmComparison } from './armCompare'
import type { UsageTotals } from '../headroomProxy/proxyLedger'

/**
 * One row per 1.55.0 lever on the savings receipt, stated as plainly as the data allows.
 *
 * A row says "measured against the holdout" only when the comparison behind it cleared its 99% bar
 * (armCompare.ts). Before that it says "collecting (n of N)", where n is the thinner arm's count and N
 * the count a verdict needs. A lever with no randomised holdout behind it, or one whose per-arm cost
 * this release does not record, is "observed": a count, never called a saving.
 *
 * Pure: no I/O, no clock.
 */

export type LeverId = 'routing' | 'late-elision' | 'relay' | 'focused-recall' | 'graph-first' | 'lean-output'

export type LeverStatus =
  | { kind: 'collecting'; n: number; of: number }
  /** Cleared the 99% interval: `deltaPct` against the holdout, negative is cheaper. */
  | { kind: 'measured'; deltaPct: number; marginPct: number }
  /** Enough data, and the 99% interval still spans zero. */
  | { kind: 'no-clear-difference'; deltaPct: number; marginPct: number }
  | { kind: 'observed' }

export interface LeverRow { id: LeverId; label: string; detail: string; status: LeverStatus }

export interface LeverInputs {
  arms: ArmComparison
  byModel: Readonly<Record<string, UsageTotals>>
  steeredRequests: number
  unsteeredRequests: number
  steeredAvgOutput: number
  unsteeredAvgOutput: number
  /** Sessions whose first prompt was seen since launch, by primer arm, and the relays sent after a compaction. */
  primer: { focused: number; holdout: number; relays: number }
}

const pos = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')

function routingRow(byModel: Readonly<Record<string, UsageTotals>>): LeverRow {
  const rows = Object.entries(byModel).map(([fam, t]) => [fam, pos(t?.requests)] as const).filter(([, n]) => n > 0)
  const total = rows.reduce((s, [, n]) => s + n, 0)
  const detail = total > 0
    ? `${rows.sort((a, b) => b[1] - a[1]).map(([fam, n]) => `${fam} ${Math.round((n / total) * 100)}%`).join(' · ')} of ${fmt(total)} requests`
    : 'No requests counted by model yet.'
  return { id: 'routing', label: 'Routing', detail, status: { kind: 'observed' } }
}

function lateRow(arms: ArmComparison): LeverRow {
  const label = 'Late elision'
  const detail = 'Cost per working request, Late against the holdout.'
  const n = Math.min(pos(arms.late?.requests), pos(arms.holdout?.requests))
  const delta = arms.costDeltaPct
  const margin = arms.costMarginPct
  if ((arms.verdict === 'late-cheaper' || arms.verdict === 'late-costlier') && delta !== null && margin !== null) {
    return { id: 'late-elision', label, detail, status: { kind: 'measured', deltaPct: delta, marginPct: margin } }
  }
  if (arms.verdict === 'no-clear-difference' && delta !== null && margin !== null) {
    return { id: 'late-elision', label, detail, status: { kind: 'no-clear-difference', deltaPct: delta, marginPct: margin } }
  }
  return { id: 'late-elision', label, detail, status: { kind: 'collecting', n, of: pos(arms.minRequests) } }
}

function leanRow(inp: LeverInputs, minRequests: number): LeverRow {
  const steered = pos(inp.steeredRequests)
  const unsteered = pos(inp.unsteeredRequests)
  const n = Math.min(steered, unsteered)
  if (n < minRequests) {
    return { id: 'lean-output', label: 'Lean output', detail: 'Output tokens per turn, steered against unsteered requests.', status: { kind: 'collecting', n, of: minRequests } }
  }
  // Means only, with no spread between groups of conversations: never enough to call a difference.
  const detail = `About ${fmt(pos(inp.steeredAvgOutput))} output tokens per steered turn against ${fmt(pos(inp.unsteeredAvgOutput))} unsteered; not a controlled comparison.`
  return { id: 'lean-output', label: 'Lean output', detail, status: { kind: 'observed' } }
}

export function leverRows(inp: LeverInputs): LeverRow[] {
  const minRequests = pos(inp.arms?.minRequests)
  const focused = pos(inp.primer?.focused)
  const holdout = pos(inp.primer?.holdout)
  const arms = `${fmt(focused)} focused and ${fmt(holdout)} holdout sessions since launch`
  return [
    routingRow(inp.byModel ?? {}),
    lateRow(inp.arms),
    { id: 'relay', label: 'Relay', detail: `${fmt(pos(inp.primer?.relays))} prompts relayed after a compaction since launch.`, status: { kind: 'observed' } },
    { id: 'focused-recall', label: 'Focused recall', detail: `${arms}; their cost is not compared in this release.`, status: { kind: 'observed' } },
    { id: 'graph-first', label: 'Graph first', detail: 'An outline is offered before a whole read of a file over 1,500 lines; Read bytes by arm are not counted in this release.', status: { kind: 'observed' } },
    leanRow(inp, minRequests),
  ]
}
