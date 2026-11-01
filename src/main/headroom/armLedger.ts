import { ARM_CLUSTERS } from './elisionPolicy'

/**
 * What each arm of the first-sight experiment cost, counted per group of conversations.
 *
 * About one conversation in ten keeps running the old first-sight behaviour (elisionPolicy.ts) so
 * that the new one can be checked on the same person's own work, not just on the history it was
 * fitted to. This is the ledger that comparison reads. Per request it keeps what the request cost in
 * billed units, whether it was a turn that only fetched elided text, and what that turn cost; per
 * arm it keeps them in ARM_CLUSTERS groups of conversations, because requests of one conversation
 * resemble each other and the comparison's uncertainty has to be measured between groups
 * (armCompare.ts), not between requests.
 *
 * The `legacy` arm is a single total: those are the requests of a run on the Settings kill switch,
 * which nobody randomised, so they are shown and never compared.
 *
 * Pure bookkeeping with no I/O and no clock, like the elision ledger beside it. It is saved inside
 * proxy-totals.json, which changes at the same pace, so it costs no write of its own.
 */

export interface ArmCounts {
  /** Requests that cost something and were not refused. */
  requests: number
  /** Of those, the ones that were not a turn spent only on fetching elided text: the unit of work. */
  work: number
  /** Billed units, all of them, the retrieval turns included. */
  units: number
  /** Turns whose only tool calls were retrieve_full. */
  turns: number
  /** What those turns cost: the cached prefix read again and the call they wrote. */
  turnUnits: number
}

export const ARM_NAMES = ['late', 'holdout', 'legacy'] as const
export type LedgerArm = (typeof ARM_NAMES)[number]

export interface ArmState {
  late: ArmCounts[]
  holdout: ArmCounts[]
  legacy: ArmCounts
}

const zero = (): ArmCounts => ({ requests: 0, work: 0, units: 0, turns: 0, turnUnits: 0 })
const empty = (): ArmState => ({
  late: Array.from({ length: ARM_CLUSTERS }, zero),
  holdout: Array.from({ length: ARM_CLUSTERS }, zero),
  legacy: zero(),
})

let state: ArmState = empty()

/** A finite number above zero, else zero. */
const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

export interface ArmSample {
  /** Billed units of the request. */
  units: number
  /** Whether it was a turn whose only tool calls were retrieve_full. */
  pureTurn: boolean
  /** The part of a pure turn's cost that is the turn: prefix read again plus output. */
  turnUnits: number
}

/**
 * Count one request. Anything it cannot place is dropped rather than put somewhere it does not
 * belong: an arm it does not know, a group that does not exist, or a cost that is not a positive
 * number (a request the API refused costs nothing and says nothing about either policy).
 */
export function recordArmRequest(arm: LedgerArm, cluster: number, sample: ArmSample): void {
  if (!sample || typeof sample.units !== 'number' || !Number.isFinite(sample.units) || sample.units <= 0) return
  let c: ArmCounts
  if (arm === 'legacy') c = state.legacy
  else if ((arm === 'late' || arm === 'holdout') && Number.isInteger(cluster) && cluster >= 0 && cluster < ARM_CLUSTERS) c = state[arm][cluster]
  else return
  c.requests += 1
  c.units += sample.units
  if (sample.pureTurn) {
    c.turns += 1
    c.turnUnits += count(sample.turnUnits)
  } else {
    c.work += 1
  }
}

/** The counts, copied: a caller cannot edit the ledger through what it is handed. */
export function armState(): ArmState {
  return { late: state.late.map((c) => ({ ...c })), holdout: state.holdout.map((c) => ({ ...c })), legacy: { ...state.legacy } }
}

function readCounts(raw: unknown): ArmCounts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return zero()
  const o = raw as Record<string, unknown>
  return { requests: count(o.requests), work: count(o.work), units: count(o.units), turns: count(o.turns), turnUnits: count(o.turnUnits) }
}

function readGroups(raw: unknown): ArmCounts[] {
  const list = Array.isArray(raw) ? raw : []
  return Array.from({ length: ARM_CLUSTERS }, (_, i) => readCounts(list[i]))
}

/**
 * Replace the counts with what a file held. A shape it does not recognise reads as empty, a damaged
 * number as zero, and a list of groups of the wrong length as the groups it has, so a damaged or
 * foreign file cannot grow the table or put NaN into a sum.
 */
export function loadArmState(raw: unknown): void {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  state = { late: readGroups(o.late), holdout: readGroups(o.holdout), legacy: readCounts(o.legacy) }
}

/** Empty the ledger. For the lifetime-meter reset, and for tests. */
export function resetArmLedger(): void {
  state = empty()
}
