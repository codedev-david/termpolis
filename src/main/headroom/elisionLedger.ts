import { classKey, parseClassKey, type ElisionMeta } from './elisionMeta'

/**
 * The elision ledger: of the text the wire proxy took out, how much did the model ask for back?
 *
 * Until v1.55 nothing in the app could answer that. The receipt priced a `retrieve_full` by the
 * text it returned and credited every elided token for every request that re-sent it, so the move
 * in late August from 13% of results asked back to 66% never appeared anywhere. This counts, by
 * class (kind, tool, size band), each elision once when its token is first stored and each
 * redemption once when it is first redeemed, and keeps the most recent elisions in a rolling
 * window beside the lifetime counts so that a change of regime shows up in days.
 *
 * Pure bookkeeping: no I/O (elisionStore.ts persists it) and no clock. The window is ordered by
 * arrival, so no timestamp is needed, and anything under src/main/headroom is swept by the
 * cache-safety guard that forbids reading one.
 */

/** How many of the most recent elisions the rolling view remembers. */
export const ELISION_WINDOW = 2000

export interface ClassCounts {
  elided: number
  redeemed: number
  /** Characters removed from the wire, summed over the class. */
  chars: number
  /** Characters of the view left in their place, summed over the class. */
  view: number
}
export interface ElisionState {
  classes: Record<string, ClassCounts>
  /** Redemptions of a token whose class nothing recorded: a stash written before v1.55, or one this
   *  run never saw stored. Kept apart so the per-class rates stay exact. */
  legacyRedeemed: number
}

const zero = (): ClassCounts => ({ elided: 0, redeemed: 0, chars: 0, view: 0 })

let classes = new Map<string, ClassCounts>()
let legacyRedeemed = 0
/** Moves on every change to the lifetime counts, so a writer can tell that there is something new to
 *  save without comparing them. A counter and not a clock: nothing under here may read one. */
let revision = 0
export function elisionRevision(): number { return revision }

interface Live { key: string; chars: number; view: number; redeemed: boolean }
/** token -> its newest elision, oldest first (a Map keeps insertion order). */
const recent = new Map<string, Live>()

/** Count one elision. The caller decides that a token is new: this does not second-guess it, and a
 *  token that comes back (its stash was lost) holds one live place in the window, the newest. */
export function recordElision(token: string, meta: ElisionMeta): void {
  revision++
  const key = classKey(meta)
  const c = classes.get(key) ?? zero()
  c.elided += 1
  c.chars += meta.chars
  c.view += meta.view
  classes.set(key, c)
  recent.delete(token)
  recent.set(token, { key, chars: meta.chars, view: meta.view, redeemed: false })
  // One entry in at a time, so at most one over: drop the oldest.
  if (recent.size > ELISION_WINDOW) recent.delete(recent.keys().next().value as string)
}

/**
 * Count one redemption, in the class the stash recorded or else the class this run saw the token
 * elided in. The caller gates this on the token's FIRST redemption (ccrMarkRedeemed). A redemption
 * may predate the ledger or the window: it still counts for life, and the class then shows more
 * asked than elided, which is the honest reading of a ledger that started late.
 */
export function recordRedemption(token: string | undefined, meta?: ElisionMeta): void {
  revision++
  const live = token === undefined ? undefined : recent.get(token)
  const key = meta ? classKey(meta) : live?.key
  if (key === undefined) { legacyRedeemed += 1; return }
  const c = classes.get(key) ?? zero()
  c.redeemed += 1
  classes.set(key, c)
  if (live) live.redeemed = true
}

/** The window, by class: what the last ELISION_WINDOW elisions looked like and which were asked back. */
export function recentByClass(): Map<string, ClassCounts> {
  const out = new Map<string, ClassCounts>()
  for (const e of recent.values()) {
    const c = out.get(e.key) ?? zero()
    c.elided += 1
    c.chars += e.chars
    c.view += e.view
    if (e.redeemed) c.redeemed += 1
    out.set(e.key, c)
  }
  return out
}

/** The lifetime counts, copied: a caller cannot edit the ledger through what it is handed. */
export function elisionState(): ElisionState {
  const out: Record<string, ClassCounts> = {}
  for (const [k, v] of classes) out[k] = { ...v }
  return { classes: out, legacyRedeemed }
}

/** A count read back from disk: a finite number above zero, else zero. */
const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

/**
 * Replace the lifetime counts with what a file held. A shape it does not recognise reads as empty,
 * and a class key it could not have built is dropped, so a damaged or foreign file cannot grow the
 * table or put NaN into a rate. The window is this run's by design and is left alone.
 */
export function loadElisionState(raw: unknown): void {
  revision++
  classes = new Map()
  legacyRedeemed = 0
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const r = raw as { classes?: unknown; legacyRedeemed?: unknown }
  legacyRedeemed = count(r.legacyRedeemed)
  const cs = r.classes
  if (!cs || typeof cs !== 'object' || Array.isArray(cs)) return
  for (const [key, v] of Object.entries(cs as Record<string, unknown>)) {
    if (parseClassKey(key) === null || !v || typeof v !== 'object' || Array.isArray(v)) continue
    const o = v as Record<string, unknown>
    classes.set(key, { elided: count(o.elided), redeemed: count(o.redeemed), chars: count(o.chars), view: count(o.view) })
  }
}

/** Empty the ledger and the window. For the lifetime-meter reset, and for tests. */
export function resetElisionLedger(): void {
  revision++
  classes = new Map()
  legacyRedeemed = 0
  recent.clear()
}
