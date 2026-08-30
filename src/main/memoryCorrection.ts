// memoryCorrection.ts
//
// Correcting the brain at the moment it is wrong, without leaving the task.
//
// WHY THIS AND NOT MORE AUDITING: the app already detects bad memories in bulk —
// `memory_conflicts` finds contradictions, `memory_audit` finds staleness, NLI
// contradiction scoring runs over the store. All of it is a REVIEW surface: you go
// somewhere else, later, and grade a list. That is the wrong shape for the failure
// that actually happens, which is a single wrong fact surfacing in the middle of real
// work. In that moment the user knows exactly what is wrong and why, and has no way to
// say so without breaking off what they were doing — so they don't, and the same wrong
// fact surfaces again next week. A brain that cannot be corrected where it is wrong
// gets routed around, and a routed-around brain is a dead one.
//
// DESIGN — corrections are an OVERLAY, never a mutation.
//
// A retraction tombstones; it does not delete. Three reasons, in order of how much
// they cost when ignored:
//   1. The store is an append-only JSONL that syncs across machines. An in-place edit
//      is not representable in it; a correction is.
//   2. Corrections are themselves fallible. `revoke` has to be able to put a memory
//      back, which is impossible once the content is gone.
//   3. "Why did the agent believe X?" is answerable only if X and its retraction both
//      survive. Erasing the evidence erases the debugging.
//
// Pure: no fs, no electron, no store access. The overlay is data; persistence and
// recall wiring live at the edges.

export type CorrectionKind = 'retract' | 'amend' | 'demote'

export interface Correction {
  /** Id of the memory being corrected. */
  id: string
  kind: CorrectionKind
  /** Free text from whoever corrected it. Carried into recall output so the next
   *  reader sees WHY, not just that something was struck out. */
  reason: string
  /** Required for 'amend': what the memory should have said. */
  replacement?: string
  /** Agent id or 'user'. */
  by: string
  ts: number
  /** Set when a later `revoke` undid this correction; revoked corrections stay in the
   *  log and stop applying. */
  revokedAt?: number
}

/** How far a demoted memory is pushed down. Multiplicative on the retrieval score, so
 *  a demoted memory can still win if nothing else is remotely relevant — which is the
 *  correct behaviour for "unreliable", as distinct from "wrong". */
export const DEMOTE_FACTOR = 0.35

export interface CorrectionOverlay {
  /** Latest live correction per memory id. */
  byId: Map<string, Correction>
  /** Full history including revoked and superseded entries, oldest first. */
  log: Correction[]
}

export function emptyOverlay(): CorrectionOverlay {
  return { byId: new Map(), log: [] }
}

export interface CorrectionInput {
  id: string
  kind: CorrectionKind
  reason?: string
  replacement?: string
  by?: string
  ts?: number
}

export interface CorrectionResult {
  ok: boolean
  error?: string
  correction?: Correction
}

/** Record a correction. Later corrections supersede earlier ones for the same id, so a
 *  user who demotes and then retracts ends up retracted rather than in a merged state
 *  nobody asked for. */
export function applyCorrection(overlay: CorrectionOverlay, input: CorrectionInput): CorrectionResult {
  const id = typeof input?.id === 'string' ? input.id.trim() : ''
  if (!id) return { ok: false, error: 'a memory id is required' }
  if (input.kind !== 'retract' && input.kind !== 'amend' && input.kind !== 'demote') {
    return { ok: false, error: `unknown correction kind "${String(input.kind)}"` }
  }
  const replacement = typeof input.replacement === 'string' ? input.replacement.trim() : ''
  // An amend with no replacement is the commonest mistake and it silently degrades to
  // a no-op that LOOKS like it worked, so it is rejected loudly instead.
  if (input.kind === 'amend' && !replacement) {
    return { ok: false, error: "an 'amend' correction needs a replacement" }
  }

  const correction: Correction = {
    id,
    kind: input.kind,
    reason: (input.reason ?? '').trim() || '(no reason given)',
    ...(replacement ? { replacement } : {}),
    by: input.by ?? 'user',
    ts: input.ts ?? Date.now(),
  }
  overlay.byId.set(id, correction)
  overlay.log.push(correction)
  return { ok: true, correction }
}

/** Undo the live correction on a memory. The correction stays in the log, marked. */
export function revokeCorrection(overlay: CorrectionOverlay, id: string, ts = Date.now()): CorrectionResult {
  const live = overlay.byId.get(id)
  if (!live) return { ok: false, error: `no live correction for ${id}` }
  live.revokedAt = ts
  overlay.byId.delete(id)
  return { ok: true, correction: live }
}

export function correctionFor(overlay: CorrectionOverlay, id: string): Correction | null {
  return overlay.byId.get(id) ?? null
}

/** Rebuild an overlay from a persisted log — replay, so the on-disk form is the log
 *  and the map is always derived. Replaying in order reproduces supersession for free. */
export function overlayFromLog(log: Correction[]): CorrectionOverlay {
  const overlay = emptyOverlay()
  for (const entry of log) {
    overlay.log.push(entry)
    if (entry.revokedAt) overlay.byId.delete(entry.id)
    else overlay.byId.set(entry.id, entry)
  }
  return overlay
}

export interface RecallCandidate {
  id: string
  content: string
  score: number
}

export interface CorrectedCandidate extends RecallCandidate {
  /** Set when a correction touched this result. */
  correction?: { kind: CorrectionKind; reason: string; by: string }
}

/** Apply the overlay to a ranked recall list.
 *
 *  Retracted entries are dropped rather than annotated: a retraction means the fact is
 *  wrong, and showing a wrong fact with a "this is wrong" label still spends the
 *  context window on it and still risks the model using it. Amend and demote both
 *  keep the entry, because both mean "not that, but nearby".
 *
 *  Re-sorted after scoring so a demotion actually changes the order rather than just
 *  the number attached to it. */
export function applyOverlayToRecall<T extends RecallCandidate>(
  overlay: CorrectionOverlay,
  candidates: T[],
): (T & Pick<CorrectedCandidate, 'correction'>)[] {
  const out: (T & Pick<CorrectedCandidate, 'correction'>)[] = []
  for (const candidate of candidates) {
    const correction = overlay.byId.get(candidate.id)
    if (!correction) {
      out.push({ ...candidate })
      continue
    }
    if (correction.kind === 'retract') continue

    const meta = { kind: correction.kind, reason: correction.reason, by: correction.by }
    if (correction.kind === 'amend') {
      out.push({ ...candidate, content: correction.replacement ?? candidate.content, correction: meta })
    } else {
      out.push({ ...candidate, score: candidate.score * DEMOTE_FACTOR, correction: meta })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

export interface Provenance {
  rank: number
  score: number
  /** Milliseconds since the memory was written. */
  ageMs: number
  source?: string
  agentId?: string
}

/** The one-line "why did this come back?" attached to each recall hit.
 *
 *  Provenance is half of what makes correction possible at all: a user cannot judge a
 *  recalled fact they cannot date or attribute. Age is the field that matters most in
 *  practice — a confidently-worded fact from four months ago is the single most common
 *  thing worth correcting, and without a date it reads exactly like a fresh one. */
export function explainRecall(p: Provenance, correction?: Correction | null): string {
  const days = Math.floor(p.ageMs / 86_400_000)
  const age = days >= 1 ? `${days}d old` : 'today'
  const bits = [`#${p.rank}`, `score ${p.score.toFixed(2)}`, age]
  if (p.source) bits.push(`via ${p.source}`)
  else if (p.agentId) bits.push(`by ${p.agentId}`)
  if (correction) bits.push(`${correction.kind}: ${correction.reason}`)
  return bits.join(' · ')
}

export interface CorrectionStats {
  live: number
  retracted: number
  amended: number
  demoted: number
  revoked: number
}

export function correctionStats(overlay: CorrectionOverlay): CorrectionStats {
  const stats: CorrectionStats = { live: 0, retracted: 0, amended: 0, demoted: 0, revoked: 0 }
  for (const correction of overlay.byId.values()) {
    stats.live++
    if (correction.kind === 'retract') stats.retracted++
    else if (correction.kind === 'amend') stats.amended++
    else stats.demoted++
  }
  stats.revoked = overlay.log.filter(c => c.revokedAt).length
  return stats
}
