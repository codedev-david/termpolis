// mnemeWeave.ts
//
// The Weave (v1.23 C4) — the continuous BACKGROUND connection-miner. It runs on the idle
// indexer tick and draws non-obvious edges AHEAD OF TIME so the agents reason faster because
// the connections are already there. Two miners:
//
//   1. Bridge  — backfill structured code anchors (codeRefs) onto older code-referencing
//                memories that predate the C2 bridge, so symbolHistory / the locator can reach
//                them (what-you-learned -> where-it-lives).
//   2. Analogy — mint CROSS-REPO `analogous-code` / `analogous-knowledge` edges between
//                embedding-near memories that live in DIFFERENT repos: "this function/answer
//                echoes one over in that other project." This is the cross-repo relationship
//                the owner asked for — drawn for faster reasoning, not recomputed per query.
//
// PURE / injectable by design (mirrors mnemeReflect/mnemeGround/mnemeReflex): no electron, no
// fs, no store, no clock. index.ts wires the real store deps and calls it fire-and-forget.
// Every edge is upsert-idempotent, gated by a cosine floor, bounded per pass, and carries
// weave provenance so it is auditable and prunable.

import type { CodeRef } from './codeGraph'

/** The minimal shape of a memory the miner reasons over (a projection of MemoryEntry). */
export interface WeaveEntry {
  id: string
  kind?: string
  memoryType?: string
  source?: string
  projectKey?: string
  entities?: string[]
  hasCodeRefs?: boolean
}

/** An embedding-nearest neighbour of a memory, with its repo key so we can gate on cross-repo. */
export interface WeaveNeighbour {
  id: string
  score: number
  projectKey?: string
}

export interface WeaveDeps {
  /** A bounded sample of embedded memories to consider this pass (newest / highest-value). */
  candidates: () => WeaveEntry[]
  /** Embedding-nearest neighbours of a memory id (excluding itself). */
  neighbours: (id: string, k: number) => WeaveNeighbour[]
  /** Mint a typed edge (upsert — re-minting the same edge is a no-op). */
  link: (from: string, to: string, relation: string, weight: number) => void
  /** Bridge miner: resolve entity names to code anchors (via the code graph). */
  resolveCode?: (names: string[], projectKey?: string) => CodeRef[]
  /** Bridge miner: durably stamp resolved anchors onto a memory that lacked them. */
  backfillCodeRefs?: (id: string, refs: CodeRef[]) => void
}

export interface WeaveOptions {
  /** Minimum cosine similarity for an analogy edge (high — analogies must be strong). */
  cosineFloor?: number
  /** Max NEW edges minted per pass, so a background tick stays cheap. */
  maxPerPass?: number
  /** Neighbours to examine per candidate. */
  neighbourK?: number
}

export interface WeaveStats {
  considered: number
  bridged: number
  codeAnalogies: number
  knowledgeAnalogies: number
  minted: number
}

export const WEAVE_REL_CODE = 'analogous-code'
export const WEAVE_REL_KNOWLEDGE = 'analogous-knowledge'
const DEFAULT_FLOOR = 0.82
const DEFAULT_MAX = 200
const DEFAULT_K = 6

/** A memory is "code-ish" (a code chunk or a code entity) vs "knowledge" (a decision/lesson). */
function isCodeMemory(e: { source?: string; memoryType?: string }): boolean {
  return e.source === 'code' || e.memoryType === 'entity'
}

/**
 * Run one weave pass. Deterministic given its deps; safe to call repeatedly (idempotent edges).
 * Returns what it drew so the caller can surface weaveStats.
 */
export function runWeave(deps: WeaveDeps, opts: WeaveOptions = {}): WeaveStats {
  const floor = opts.cosineFloor ?? DEFAULT_FLOOR
  const maxPerPass = Math.max(1, opts.maxPerPass ?? DEFAULT_MAX)
  const k = Math.max(1, opts.neighbourK ?? DEFAULT_K)

  const cands = deps.candidates() || []
  const stats: WeaveStats = { considered: cands.length, bridged: 0, codeAnalogies: 0, knowledgeAnalogies: 0, minted: 0 }
  const byId = new Map(cands.map((e) => [e.id, e]))

  // 1) Bridge miner — backfill code anchors on un-anchored code-referencing memories.
  if (deps.resolveCode && deps.backfillCodeRefs) {
    for (const e of cands) {
      if (e.hasCodeRefs) continue
      if (!e.entities || e.entities.length === 0) continue
      let refs: CodeRef[] = []
      try {
        refs = deps.resolveCode(e.entities, e.projectKey)
      } catch {
        refs = [] // a resolver hiccup never breaks the pass
      }
      if (refs.length) {
        try {
          deps.backfillCodeRefs(e.id, refs)
          stats.bridged++
        } catch {
          /* best effort */
        }
      }
    }
  }

  // 2) Analogy miner — CROSS-REPO embedding-near pairs become typed edges (drawn once, symmetric).
  const seen = new Set<string>()
  for (const e of cands) {
    if (stats.minted >= maxPerPass) break
    if (!e.projectKey) continue // an unscoped memory has no repo to be cross-repo FROM
    let ns: WeaveNeighbour[] = []
    try {
      ns = deps.neighbours(e.id, k) || []
    } catch {
      ns = []
    }
    for (const n of ns) {
      if (stats.minted >= maxPerPass) break
      if (n.score < floor) continue
      if (!n.projectKey || n.projectKey === e.projectKey) continue // CROSS-repo only
      // Symmetric edge: canonicalize the endpoints so A~B and B~A are one edge (idempotent
      // regardless of which side the pass visits first).
      const [from, to] = e.id < n.id ? [e.id, n.id] : [n.id, e.id]
      // Classify by BOTH ends when the neighbour is a known candidate; else fall back to `e`.
      const other = byId.get(n.id)
      const code = isCodeMemory(e) || (other ? isCodeMemory(other) : false)
      const relation = code ? WEAVE_REL_CODE : WEAVE_REL_KNOWLEDGE
      const dedup = `${from}\0${to}\0${relation}`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      try {
        deps.link(from, to, relation, n.score)
      } catch {
        continue // a graph hiccup never breaks the pass
      }
      stats.minted++
      if (code) stats.codeAnalogies++
      else stats.knowledgeAnalogies++
    }
  }

  return stats
}
