// mnemeWeave.ts
//
// The Weave (v1.23 C4) — the continuous BACKGROUND connection-miner. It runs on the idle
// indexer tick and draws non-obvious edges AHEAD OF TIME so the agents reason faster because
// the connections are already there. Three miners:
//
//   1. Bridge   — backfill structured code anchors (codeRefs) onto older code-referencing
//                 memories that predate the C2 bridge, so symbolHistory / the locator can reach
//                 them (what-you-learned -> where-it-lives).
//   2. Analogy  — mint `analogous-code` / `analogous-knowledge` edges between embedding-near
//                 memories: "this function/answer echoes that one." Drawn for faster reasoning,
//                 not recomputed per query.
//   3. Explains — the "WHAT IS THIS CODE FOR?" bridge: mint a REAL typed graph edge from the
//                 semantic memory (decision/fact/lesson/conversation) that explains a piece of
//                 code TO the indexed code chunk itself — `semantic --explains--> code`. This is
//                 what joins the structural code graph to the semantic memory that gives it
//                 purpose; a `codeRefs` FIELD alone is not a counted edge, so before this the
//                 two stores never actually touched.
//
// v1.24 RELAXATION — the weave was effectively dormant (3 edges in a real user's brain) because
// the analogy miner was CROSS-REPO ONLY and gated at cosine 0.82. Analogies are now mined
// INTRA-repo as well (a repo is exactly where echoes live), and the floor is WEAVE_COSINE_FLOOR
// (0.72), exported so it can be tuned. Self-links and duplicate pairs are rejected, and every
// miner keeps its own bounded per-pass budget so a background tick can never explode.
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
  /** v1.24 — the structured code anchors this memory carries (the C2 bridge join key). The
   *  explains miner uses them as its file/symbol overlap signal. */
  codeRefs?: CodeRef[]
  /** v1.24 — for a `source:'code'` chunk, the file it was chunked FROM (chunkCode prefixes the
   *  content with `path:start-end`, which is the same anchor memoryPruneCodePath keys off). */
  filePath?: string
}

/** An embedding-nearest neighbour of a memory, with its repo key so we can tag/scope the pair. */
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
  /** Explains miner (optional): OVERRIDE where a memory's code anchors come from — e.g. answer
   *  from the code graph instead of the projection. Raw values are fine: they are normalized
   *  exactly like the built-in ones. Defaults to `weaveAnchors(entry)`. */
  anchorsOf?: (e: WeaveEntry) => string[]
}

export interface WeaveOptions {
  /** Minimum cosine similarity for a woven edge (both the analogy and explains miners). */
  cosineFloor?: number
  /** Max NEW analogy edges per pass, so a background tick stays cheap. */
  maxPerPass?: number
  /** Max NEW `explains` edges per pass. Its OWN budget, so a flood of analogies (cheap, plentiful)
   *  can never starve the code<->purpose bridge (rare, valuable). */
  maxExplainsPerPass?: number
  /** Neighbours to examine per candidate. */
  neighbourK?: number
}

export interface WeaveStats {
  considered: number
  bridged: number
  codeAnalogies: number
  knowledgeAnalogies: number
  explains: number
  minted: number
}

export const WEAVE_REL_CODE = 'analogous-code'
export const WEAVE_REL_KNOWLEDGE = 'analogous-knowledge'
/** v1.24 — `semantic --explains--> code`: the memory that says what a code chunk is FOR. */
export const WEAVE_REL_EXPLAINS = 'explains'

/** Cosine floor for every woven edge. Was 0.82 (so high the weave never fired); 0.72 still means
 *  "clearly about the same thing" while actually producing edges. Tune here, not at call sites. */
export const WEAVE_COSINE_FLOOR = 0.72
/** Bound on NEW analogy edges per background pass. */
export const WEAVE_MAX_PER_PASS = 200
/** Bound on NEW `explains` edges per background pass. */
export const WEAVE_MAX_EXPLAINS_PER_PASS = 100
/** Neighbours examined per candidate. */
export const WEAVE_NEIGHBOUR_K = 6

/** A memory is "code-ish" (a code chunk or a code entity) vs "knowledge" (a decision/lesson). */
function isCodeMemory(e: { source?: string; memoryType?: string }): boolean {
  return e.source === 'code' || e.memoryType === 'entity'
}

/** STRICTER than isCodeMemory: an actual indexed code chunk (the thing the code graph is made of),
 *  not merely an entity node that names a symbol. The `explains` miner points AT one of these. */
function isCodeChunk(e: WeaveEntry): boolean {
  return e.source === 'code'
}

/** A memory that can EXPLAIN code: a decision / fact / lesson / conversation. A code chunk cannot
 *  explain itself, and a bare entity node is a NAME, not an explanation. */
function isExplainer(e: WeaveEntry): boolean {
  return !isCodeChunk(e) && e.memoryType !== 'entity'
}

/** Normalize raw anchors (paths, symbols, symbol ids) into comparable tokens: lowercased, forward
 *  -slashed, and additionally indexed by BARE BASENAME so an absolute chunk path
 *  (`C:/repo/src/main/loader.ts`) overlaps a repo-relative codeRef (`src/main/loader.ts`). This is
 *  the same file-vs-basename match symbolHistory() uses. Idempotent. */
function normalizeAnchors(raw: Array<string | undefined>, out: Set<string> = new Set()): Set<string> {
  for (const r of raw) {
    const s = (r ?? '').trim().toLowerCase().replace(/\\/g, '/')
    if (!s) continue
    out.add(s)
    const base = s.split('/').pop()
    if (base && base !== s) out.add(base)
  }
  return out
}

/**
 * The file/symbol anchors a memory is about — the overlap signal the `explains` miner gates on.
 * Reads only the projection (codeRefs / filePath / entities), so it stays pure and testable.
 */
export function weaveAnchors(e: WeaveEntry): string[] {
  const raw: Array<string | undefined> = [e.filePath]
  for (const r of e.codeRefs ?? []) raw.push(r.file, r.symbol, r.symbolId)
  for (const name of e.entities ?? []) raw.push(name)
  return [...normalizeAnchors(raw)]
}

/**
 * Run one weave pass. Deterministic given its deps; safe to call repeatedly (idempotent edges).
 * Returns what it drew so the caller can surface weaveStats.
 */
export function runWeave(deps: WeaveDeps, opts: WeaveOptions = {}): WeaveStats {
  const floor = opts.cosineFloor ?? WEAVE_COSINE_FLOOR
  const maxPerPass = Math.max(1, opts.maxPerPass ?? WEAVE_MAX_PER_PASS)
  const maxExplains = Math.max(1, opts.maxExplainsPerPass ?? WEAVE_MAX_EXPLAINS_PER_PASS)
  const k = Math.max(1, opts.neighbourK ?? WEAVE_NEIGHBOUR_K)

  const cands = deps.candidates() || []
  const stats: WeaveStats = { considered: cands.length, bridged: 0, codeAnalogies: 0, knowledgeAnalogies: 0, explains: 0, minted: 0 }
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

  // Anchor lookup for the explains miner: the injected resolver if there is one, else the
  // projection reader. Memoized per pass (each candidate is asked about once, not once per
  // neighbour) and never throws — a hiccup just means "no anchors", i.e. no edge.
  const resolveAnchors = deps.anchorsOf ?? weaveAnchors
  const anchorCache = new Map<string, Set<string>>()
  const anchorsFor = (e: WeaveEntry): Set<string> => {
    const hit = anchorCache.get(e.id)
    if (hit) return hit
    let set: Set<string>
    try {
      set = normalizeAnchors(resolveAnchors(e) ?? [])
    } catch {
      set = new Set()
    }
    anchorCache.set(e.id, set)
    return set
  }
  const sharesAnchor = (a: Set<string>, b: Set<string>): boolean => {
    if (a.size === 0 || b.size === 0) return false
    const [small, large] = a.size <= b.size ? [a, b] : [b, a]
    for (const t of small) if (large.has(t)) return true
    return false
  }

  // Mint once — dedup by from+to+relation so a pair seen from both ends (or twice in one
  // neighbour list) is drawn exactly ONCE per pass. Returns false when it was a duplicate or
  // the graph write failed, so the caller never counts an edge it did not draw.
  const seen = new Set<string>()
  const mint = (from: string, to: string, relation: string, weight: number): boolean => {
    const dedup = `${from}\0${to}\0${relation}`
    if (seen.has(dedup)) return false
    seen.add(dedup)
    try {
      deps.link(from, to, relation, weight)
    } catch {
      return false // a graph hiccup never breaks the pass
    }
    stats.minted++
    return true
  }
  const analogyDone = (): boolean => stats.codeAnalogies + stats.knowledgeAnalogies >= maxPerPass
  const explainsDone = (): boolean => stats.explains >= maxExplains

  // 2) + 3) One walk over the neighbourhood so the ANN is queried ONCE per candidate; each miner
  //         spends its own budget on it.
  for (const e of cands) {
    if (analogyDone() && explainsDone()) break
    let ns: WeaveNeighbour[] = []
    try {
      ns = deps.neighbours(e.id, k) || []
    } catch {
      ns = []
    }
    for (const n of ns) {
      if (analogyDone() && explainsDone()) break
      if (n.id === e.id) continue // never self-link (the cross-repo guard used to absorb this)
      if (n.score < floor) continue // the cosine gate — both miners
      const other = byId.get(n.id)

      // 2) Analogy — embedding-near pairs become typed edges (drawn once, symmetric). Since v1.24
      //    an INTRA-repo pair counts too: the echoes worth pre-drawing mostly live in ONE repo.
      //    Both ends must still be repo-scoped (an unscoped memory is global, not an analogue).
      if (!analogyDone() && e.projectKey && n.projectKey) {
        // Symmetric edge: canonicalize the endpoints so A~B and B~A are one edge (idempotent
        // regardless of which side the pass visits first).
        const [from, to] = e.id < n.id ? [e.id, n.id] : [n.id, e.id]
        // Classify by BOTH ends when the neighbour is a known candidate; else fall back to `e`.
        const code = isCodeMemory(e) || (other ? isCodeMemory(other) : false)
        const relation = code ? WEAVE_REL_CODE : WEAVE_REL_KNOWLEDGE
        if (mint(from, to, relation, n.score)) {
          if (code) stats.codeAnalogies++
          else stats.knowledgeAnalogies++
        }
      }

      // 3) Explains — "what is this code FOR?". Exactly one end must be an indexed code chunk and
      //    the other a memory that can explain it; they must be embedding-near (floor, above) AND
      //    talk about the same file/symbol (anchor overlap) — two independent signals, so a merely
      //    chatty neighbour never claims to explain code. DIRECTED: semantic --explains--> code.
      //    A neighbour outside the candidate set is skipped: its kind and anchors are unknowable.
      if (!explainsDone() && other) {
        const codeEnd = isCodeChunk(e) ? e : isCodeChunk(other) ? other : undefined
        const semanticEnd = codeEnd ? (codeEnd === e ? other : e) : undefined
        if (codeEnd && semanticEnd && isExplainer(semanticEnd) && sharesAnchor(anchorsFor(codeEnd), anchorsFor(semanticEnd))) {
          if (mint(semanticEnd.id, codeEnd.id, WEAVE_REL_EXPLAINS, n.score)) stats.explains++
        }
      }
    }
  }

  return stats
}
