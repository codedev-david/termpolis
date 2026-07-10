# The Weave — a self-weaving cognitive fabric (v1.23)

- **Date:** 2026-07-09
- **Status:** Approved (design); implementation pending
- **Repo:** termpolis
- **Release:** v1.23.0 (minor)

## Problem

Termpolis has two strong-but-disconnected knowledge stores and a learning layer that
recalls rather than predicts:

- The **memory brain** knows *what we learned* (decisions, fixes, gotchas) but returns
  text, never a code location.
- The **code graph** knows *what calls what* but answers only to an explicit symbol
  name and is never driven by an issue description.
- There is **no join key** between them (verified: memory ids `mem-…` vs symbol ids
  `<file>#<name>@<line>` never co-occur; `MemoryEntry` has no file/symbol field —
  `types/index.ts:317-331`, `codeGraph.ts:4-6` calls the bridge "a later bridge").
- The **predictive graph layer is inert**: the only automatic causal (`solves`) edge
  ships as dead code — reflection emits `{relation:'solves'}` with no `to`
  (`mnemeReflect.ts:209,262`) and `connectLesson` drops targetless links
  (`mnemeGround.ts:105-108`). Causal priors only bite inside `memory_graph`, which is
  off the default recall path (graph fusion default-off, `swarmMemory.ts:1187`).
- **Cross-repo transfer is partial** and **cross-repo durability has a silent
  destructive delete**: the 30-min consolidation wires `forget=memoryDelete`
  (`index.ts:2024`), a permanent id+hash tombstone (`swarmMemory.ts:1741-1748`) that
  purges aged untagged chatter fleet-wide, contradicting the "never destructive"
  docstring (`mnemeConsolidate.ts:7-8`). Recall is hard-capped at the newest 500k
  entries (`swarmMemory.ts:96-97,386-389`).
- The **code graph is a single global store repos clobber** (no project key, every
  build `clearAll()`s — `codeGraph.ts:49-54,196`), and a non-git dir wipes it
  (`codeIngest.ts:172-174` resolves `[]`, bypassing the throw-only guard).

## Goal

A continuously self-weaving fabric that links *what-you-learned* to *where-it-lives*
across **all repos**, mines cross-repo analogies **ahead of time**, and turns recall
into ranked **issue → location** prediction — proactive and on-demand. One unified
brain, relevance-scoped. Native-free, local-first, append-only JSONL. No new runtime
dependencies.

## Non-goals

- No cloud, no new native modules, no new heavyweight ML models (reuse the existing
  local embedder + tree-sitter WASM).
- Not replacing the code graph or memory store — extending and joining them.
- Hard per-repo walls are out of scope (user chose one unified brain); we control
  noise with relevance scoping, and leave a seam for zones later.

## Architecture (the fabric)

```
        issue text ─────────────────────────────────────────┐
                                                             ▼
 ┌─────────────┐   entity/token      ┌───────────────┐   code_locate / anticipate
 │ MEMORY brain│ ───────────────────▶│  THE WEAVE     │──▶ ranked {file,symbol,why[]}
 │ (lessons,   │   resolve + rank     │  (bridge +     │
 │  entities)  │◀────────────────────│   miner +      │   proactive on error/problem
 └─────┬───────┘   analogous-to       │   scorer)      │   + on-demand tool
       │ codeRefs[]                    └──────┬────────┘
       ▼ (join key)                           │ located-in / analogous-to edges
 ┌─────────────┐   symbol resolve             │ (materialized ahead of time)
 │ CODE graph  │◀─────────────────────────────┘
 │ (per-repo)  │   centrality / blast-radius (code_impact)
 └─────────────┘
        ▲
        │ background miner (idle + scheduled): entity→symbol, cross-repo code &
        │ answer analogies, gated by weight floor + provenance + confidence
```

## Components (each a bounded, independently testable unit)

### C1 — Foundation: per-repo, durable code graph
**Purpose:** make the code graph a reliable multi-repo substrate the bridge can stand on.
**Changes (`codeGraph.ts`, `codeIngest.ts`, `codeWatch.ts`, `index.ts`):**
- Key all graph state by `projectKey` (reuse `projectKeyOf` from `swarmMemory.ts:73-79`):
  `Map<projectKey, GraphState>` instead of module-global singletons. Queries take an
  optional `projectKey`; default = active repo; explicit = that repo; `undefined` in a
  cross-repo query = union (for the miner).
- Persist one file per repo: `code-graph/<projectKey>.json` (atomic tmp+rename, as today).
- **Fix the wipe bug:** never `clearAll()`+persist when discovery returns empty *and*
  the dir is a known repo — guard on "files.length === 0 && previousGraphNonEmpty" →
  skip, log anomaly. Give `codeIngest.listFiles` a `safeGit` fallback so a transient
  git-off-PATH doesn't resolve `[]`.
- Wire the existing incremental `reindexFile` (`codeGraph.ts:170`) into the fs.watch
  path (debounced) instead of full `reindexRepoGraph`; keep full rebuild for first index.
**Tests:** two repos coexist without clobber; query scoping (active/explicit/union);
non-git dir preserves prior graph; incremental single-file update; persistence round-trip
per repo.
**Risk:** migration of the old single `code-graph.json`. Mitigation: one-time import
into the active repo's keyed file; else lazy rebuild.

### C2 — The bridge (join key)
**Purpose:** give memories a structured code anchor and back.
**Changes (`types/index.ts`, `swarmMemory.ts`, `codeGraph.ts`, `mnemeGround.ts`):**
- Add optional `codeRefs?: CodeRef[]` to `MemoryEntry` where
  `CodeRef = { file: string; symbol?: string; symbolId?: string; projectKey?: string }`.
  Structured, not free text — so no cross-store id traversal is required (avoids the
  `memoryGraphQuery` drop-unresolved-id problem, `swarmMemory.ts:1505`).
- Add `resolveToken(token, projectKey?) → { symbols: SymbolRec[]; files: string[] }` and
  an `idsByBasename` index to `codeGraph.ts` (it already has `idsByName`/`idsByFile`).
- At entity/lesson grounding (`mnemeGround.ts` / `ensureEntityNode` `index.ts:156`),
  resolve file/function entity names through `resolveToken` and stamp `codeRefs` on the
  memory entry (best-effort; empty when no match).
- Add `symbolHistory(symbolId|file) → MemoryEntry[]`: reverse lookup from a code symbol
  to memories whose `codeRefs` include it. This is the "what do we know about this
  function" direction.
**Tests:** a lesson naming `exportTerminal.ts`/`reflowForMessage` gets a resolved
`codeRef`; `symbolHistory` returns it; no-match yields empty; projectKey scoping applied.
**Risk:** name over-approximation (same basename across repos) — mitigate with projectKey
preference and a confidence flag on the ref.

### C3 — Revive automatic causal edges (quick win)
**Purpose:** make "error → fix" traversable automatically.
**Changes (`mnemeReflect.ts`, `mnemeGround.ts`):**
- In `connectLesson`, when a procedural lesson carries a `problem`, `ensureEntity` the
  error/problem token and mint `link(lessonId, errorEntityId, 'solves')` with a real
  target (replacing the target-less emission). Keep the "never from a failed episode"
  guard (`mnemeReflect.ts:199`) and `ENTITY_STOPWORDS`.
**Tests:** a completed episode with a problem mints a `solves` edge to the error entity;
inverse `solved-by` traversal surfaces the fix; failed episode mints nothing.
**Risk:** generic error tokens → stopword guard + min length.

### C4 — Background connection-miner (flagship)
**Purpose:** continuously draw non-obvious edges ahead of time so reasoning is fast.
**New module `mnemeWeave.ts` + scheduler wiring (`index.ts`, `memoryIndexer.ts`):**
- Runs on the existing indexer tick (idle/scheduled), bounded per pass, best-effort.
- Three miners, each emitting typed, provenance-tagged, confidence-weighted edges,
  gated by a tunable weight floor:
  1. **Bridge miner** — resolve un-anchored code-referencing entities → symbols (C2),
     stamp `codeRefs` / mint `located-in` edges.
  2. **Cross-repo code-structure analogy** — cluster functions/symbols across repos by
     embedding of their signature+doc (reuse local embedder); mint `analogous-to` (code)
     edges between near-duplicates in *different* projectKeys above a cosine floor.
  3. **Cross-repo answer/decision analogy** — for decisions/lessons, find semantically
     close counterparts in other repos; mint `analogous-to` (knowledge) edges.
- Idempotent (upsert by from+to+relation, `memoryGraph.ts:84`), decay-aware, and never
  mints below the floor. Emits `weaveStats` (edges by relation, confidence histogram).
**Tests:** miner mints bridge + both analogy edge kinds on a fixture with two repos;
respects the weight floor; idempotent across two passes; skips within-repo for the
cross-repo miners; bounded per pass.
**Risk:** noise/compute. Mitigation: floors, per-pass cap, runs only on idle tick,
all edges carry provenance so they're auditable and prunable.

### C5 — Issue → location predictor (proactive + on-demand)
**Purpose:** answer "where is this / where do I fix it" with a ranked list.
**Changes (`mnemeRetrieval.ts`, new `codeLocate` in `index.ts`, `mcpServer.ts`, proactive hook):**
- `code_locate(issueText, projectKey?) → Array<{ file, symbol, score, why: Lesson[] }>`:
  run existing `proactiveQuery` to pull file/identifier/error tokens → `resolveToken`
  into candidate symbols/files → union with memory entities/lessons those tokens match →
  expand via fabric edges (`located-in`, `analogous-to`, `solves`) → score by
  `codeImpact` centrality × attached-lesson `learnedUtility` × recency × analogy strength.
- Extend `memory_anticipate` to optionally attach the located sites.
- **Proactive:** a hook that, when an error/problem is detected in agent output (reuse
  the existing outbound/error detection), computes `code_locate` and surfaces a ranked
  "look here first" notice + injects it into agent context.
**Tests:** issue text mentioning a known error surfaces the right file/symbol ranked
first; "why" carries the causal lesson; empty on unknown; projectKey scoping; proactive
hook fires on an error line and not on normal output.
**Risk:** false positives → require ≥1 supporting lesson or a strong token; cap results.

### C6 — Rock-solid cross-repo memory
**Purpose:** never silently lose memory; make transfer strong but low-noise.
**Changes (`mnemeConsolidate*.ts`, `memoryIndexer.ts`, `swarmMemory.ts`):**
- **Cold-archive tier instead of destructive delete:** replace `forget=memoryDelete`
  in the scheduled pass with `archive` → move eligible cold chatter to
  `swarm-memory.archive.jsonl` (still integrity-tracked), removed from the hot window but
  **recoverable** and reachable by an explicit deep/archive search. Keep tombstones only
  for genuine user deletes. Fix the "never destructive" docstring to match reality.
- **Recall beyond 500k:** tiered recall — hot window (ANN) + on-demand archive scan for
  deep queries; raise/stream so nothing is permanently unrecallable. Make the cap
  configurable and documented.
- **Relevance-scoped cross-repo transfer:** default search stays unified (cross-repo),
  but out-of-project hits get a relevance multiplier (< 1.0) so same-project stays on top
  and cross-repo surfaces only when genuinely strong. Primer merges scored, not bucketed.
**Tests:** consolidation archives (not deletes) and archived entries are recoverable +
deep-searchable; hot cap eviction still bounded; cross-repo hit ranks below an
equal-similarity in-project hit but above a weak in-project hit; curated kinds never
archived.
**Risk:** archive growth → archive compaction is safe (append-only, never deletes).

### C7 — Learning upgrade
**Purpose:** richer lessons, graph-fused recall, measurable quality.
**Changes (`index.ts` distiller wiring, `swarmMemory.ts` fusion, `recallMetrics.ts`,
`memoryGraph.ts`, `mnemeGraphLogic.ts`):**
- **Wire the headless LLM distiller** (`mnemeDistiller.ts`, currently unwired) opt-in,
  value-gated (only high-value episodes), producing richer lessons + resolved
  problem/solution entity targets (feeds C3 precision).
- **Graph fusion into default recall, benchmark-gated:** apply `relationPrior` in the
  fused path and enable `expandWithGraph` in `memorySearch` **only** once a *real*
  relevance-labeled corpus (replacing the 22-item synthetic `recallBenchmark`) proves
  lift; otherwise keep opt-in. Ship the corpus + the gate.
- **Live recall quality:** compute nDCG/MRR from real feedback events (not just offline).
- **Undirected `memory_related`** (`neighboursOf` not `edgesFrom`, `swarmMemory.ts:1464`).
- **Auto-link weight floor** (`swarmMemory.ts:879`) + relation-quality `graphStats`.
**Tests:** distiller wiring invoked on high-value episode only; fusion improves the real
benchmark before flip (or stays off); `memory_related` surfaces incoming-edge neighbours;
weight floor drops junk; graphStats reports relation breakdown; live nDCG computed.
**Risk:** distiller cost/latency → value gate + bound; fusion regressions → benchmark gate.

## Cross-cutting

- **Back-compat / migration:** all new fields optional; old memories without `codeRefs`
  work unchanged and get anchored lazily by the miner. One-time code-graph store
  migration (C1). Brain export/import gains the per-repo code-graph files + archive.
- **Coverage:** branch gate is razor-thin (≥85% CI). Every new branch gets a unit test;
  run the CI-style coverage (bge model hidden, grammars copied) before each push; keep a
  margin above 85.
- **Native-free:** reuse local embedder + tree-sitter WASM only. No new deps.
- **Safety:** all miners/schedulers best-effort in try/catch; nothing on a hot path;
  floors + provenance make every auto edge auditable and prunable.

## Build sequence

C1 (foundation) → C3 (quick causal win) → C2 (bridge) → C4 (miner) → C5 (predictor) →
C6 (rock-solid memory) → C7 (learning). Each lands green (its tests + full suite +
coverage) and is committed before the next. Release as **v1.23.0** once all seven are in,
the full suite is green, coverage holds above gate, and the features are verified working
end-to-end.

## Success criteria

1. `code_locate("<a past error>")` returns the correct file+symbol ranked first with the
   causal lesson as "why".
2. The background miner materializes bridge + cross-repo analogy edges on a two-repo
   fixture, gated and idempotent.
3. Consolidation archives (never permanently deletes) and archived memory is recoverable
   and deep-searchable.
4. Cross-repo hits surface, relevance-scoped below equal in-project hits.
5. Automatic `solves` edges mint and are traversable.
6. Full test suite green; branch coverage ≥ 85% with margin; both CI pipelines green;
   v1.23.0 tagged, released with full asset set, and the release email fired.
