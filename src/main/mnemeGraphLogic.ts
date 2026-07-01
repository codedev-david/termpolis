// Mneme Phase 3 — the behavior that makes causal / temporal / supersession edges
// actually MEAN something during scoring and retrieval. Today those relations
// (`solves`, `caused-by`, `supersedes`, temporal validity) are stored on edges but
// are inert labels: nothing reads them at query time. This module is the pure logic
// that reads them —
//   • `relationPrior`  — a per-relation scoring multiplier so a causal/solution edge
//                        pulls its neighbour up and a weak `relates-to` edge does not.
//   • supersession     — `supersededIds` / `filterSuperseded` drop memories that a
//                        newer memory has explicitly replaced, so retrieval stops
//                        surfacing stale answers.
//   • temporal validity— `isTemporallyValid` / `activeEdges` respect the [validFrom,
//                        validTo] window on an edge so a connection that is not yet /
//                        no longer true is excluded from traversal.
//
// PURE + injectable, matching the memoryEconomy / memoryGraph convention: no IO, no
// module state, and the clock is ALWAYS the injected `now` param — never Date.now() —
// so every branch is deterministic under test. `Edge` is a structural shape (a
// superset of MemoryEdge with the append-safe temporal fields) so callers can pass
// their stored edges straight in.

export type Edge = {
  from: string
  to: string
  relation: string
  weight?: number
  ts?: number
  validFrom?: number // ms — edge is not valid before this instant (open-ended when unset)
  validTo?: number   // ms — edge is not valid after this instant (open-ended when unset)
}

// Per-relation scoring multipliers. Causal / solution links are the highest-signal
// connections in the brain (a bug → its fix, a cause → its effect) so they get the
// biggest lift; a supersession points at the current answer so it gets a smaller
// lift; structural links (`part-of`, `refers-to`) are neutral; a bare `relates-to`
// (and anything unrecognized) is DAMPED below neutral so a generic "these two things
// co-occur" edge can never outrank a typed, meaningful one.
const CAUSAL_PRIOR = 1.3
const SUPERSEDES_PRIOR = 1.15
const STRUCTURAL_PRIOR = 1.0
const WEAK_PRIOR = 0.9

const RELATION_PRIORS: Record<string, number> = {
  'solves': CAUSAL_PRIOR,
  'solved-by': CAUSAL_PRIOR,
  'causes': CAUSAL_PRIOR,
  'caused-by': CAUSAL_PRIOR,
  'supersedes': SUPERSEDES_PRIOR,
  'part-of': STRUCTURAL_PRIOR,
  'refers-to': STRUCTURAL_PRIOR,
  'relates-to': WEAK_PRIOR,
}

/**
 * Scoring multiplier for a relation. Causal/solution relations
 * (`solves`/`solved-by`/`causes`/`caused-by`) → 1.3; `supersedes` → 1.15;
 * `part-of`/`refers-to` → 1.0 (neutral); `relates-to` and any unknown relation →
 * 0.9 (damped). Pure — a plain lookup with a neutral-damped default.
 */
export function relationPrior(relation: string): number {
  return RELATION_PRIORS[relation] ?? WEAK_PRIOR
}

/**
 * The set of memory ids that some OTHER memory has explicitly replaced, read from
 * both directions of the supersession relation:
 *   • the `from` of every `superseded-by` edge  (X `superseded-by` Y ⇒ X is stale)
 *   • the `to`   of every `supersedes` edge      (X `supersedes` Y    ⇒ Y is stale)
 * Any other relation contributes nothing. Pure.
 */
export function supersededIds(edges: Edge[]): Set<string> {
  const ids = new Set<string>()
  for (const e of edges) {
    if (e.relation === 'superseded-by') ids.add(e.from)
    else if (e.relation === 'supersedes') ids.add(e.to)
  }
  return ids
}

/**
 * Whether an edge is temporally in-force at `now`. False when it has a `validFrom`
 * and `now` is before it, or a `validTo` and `now` is after it; otherwise true —
 * an unset bound is open-ended on that side (a bound-free edge is always valid).
 * Boundaries are inclusive (`now === validFrom` and `now === validTo` are valid).
 * Pure — the clock is injected, never read.
 */
export function isTemporallyValid(edge: Edge, now: number): boolean {
  if (edge.validFrom !== undefined && now < edge.validFrom) return false
  if (edge.validTo !== undefined && now > edge.validTo) return false
  return true
}

/**
 * Drop hits whose id has been superseded by a newer memory (see {@link supersededIds}),
 * so retrieval stops surfacing an answer that a later memory has explicitly replaced.
 * Order-preserving. Pure — `edges` is the caller's edge list.
 */
export function filterSuperseded<T extends { id: string }>(hits: T[], edges: Edge[]): T[] {
  const superseded = supersededIds(edges)
  return hits.filter((h) => !superseded.has(h.id))
}

/**
 * The subset of `edges` that are temporally in-force at `now` (see
 * {@link isTemporallyValid}) — the edges a traversal is allowed to walk right now.
 * Order-preserving. Pure.
 */
export function activeEdges(edges: Edge[], now: number): Edge[] {
  return edges.filter((e) => isTemporallyValid(e, now))
}
