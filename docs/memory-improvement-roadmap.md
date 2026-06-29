# Termpolis Local-Memory — Improvement Roadmap & Implementation Guide

> **Purpose.** This is the durable, agent-followable plan for improving Termpolis's
> local-memory "brain" (the vector + knowledge-graph system under `src/main/`).
> It is the synthesized output of a 29-agent design review of 24 proposals, each
> adversarially verified to fit Termpolis's hard constraints. **All 24 survived as
> "modify"** — the value is as much in the *sub-parts that were cut* (the guardrails)
> as in what's kept.

---

## 0. How to use this document (read this first)

You are (probably) a future coding agent picking up memory work. Do this:

1. **Read §1 (Hard Constraints) every time.** They govern every change. A proposal
   that violates one is wrong for this codebase, full stop.
2. **Read §2 (Architecture today)** to orient on the current files.
3. **Pick the next item from §6 (Sequencing).** Land Tier-1 quick wins before any
   structural work — the spines depend on them.
4. For each item: implement the **what**, touch only the listed **files**, and
   honor the **DROP/guardrail** notes — those are landmines that a prior design pass
   already hit. Do **not** re-add them.
5. **Verify** with §7 before claiming done.
6. Keep every new module **pure and unit-tested** (this codebase has ~3,955 tests;
   match that bar).

---

## 1. HARD CONSTRAINTS (non-negotiable)

Every change MUST satisfy all of these:

1. **No native binaries.** Ships as ordinary JS. No new `.node`/`.dll`/native addon
   deps. WASM *data* (onnxruntime-web `.wasm`) is OK. This rules out LanceDB,
   hnswlib-node, onnxruntime-node, sqlite-vec native, faiss-node, a real graph-DB
   server, etc.
2. **ABI-agnostic** across Electron versions; adds **no new unsigned-binary surface**
   (Windows Defender cloud-ML false-positive avoidance is an explicit design goal).
3. **In-process, never freeze the UI.** Embedding/index work runs on Electron main.
   Anything CPU-heavy must yield to the event loop or move to a `worker_thread`
   (allowed; native is not).
4. **Local-first and fully offline** for core memory ops. No network, no external
   service, no cloud LLM in the hot path.
5. **Append-only JSONL** shards in `userData`, optionally **AES-256-GCM per-line**
   encrypted. New persistence stays append-friendly and tolerates plaintext +
   ciphertext lines. **Device-sync is a CRDT** — never write device-local ephemeral
   state into synced shards (it silently mutates other devices' data).
6. **Graceful degradation:** if the embed model isn't loaded, keyword search still
   works. Preserve that path.
7. **Pure, unit-testable modules** preferred (the codebase tests pure helpers heavily).
8. **Single-user scale:** thousands → low-millions of chunks. Reject web-scale
   machinery that a local single-user store will never need.

**Never propose (auto-reject):** a real vector DB / graph DB / native ANN binary /
any LLM-HyDE / any network call. The whole point is pure-TS/WASM, offline,
append-only, keyword-degradable.

---

## 2. The architecture today (orientation)

| File | Role today |
|---|---|
| `src/main/localEmbedder.ts` + `bertTokenizer.ts` | `bge-small-en-v1.5` q8, **384-dim**, mean-pooled, via onnxruntime-web (WASM), in-process, `numThreads=1`. Query gets a bge instruction prefix. Degrades to "no embeddings" → keyword. |
| `src/main/vectorStore.ts` | ONE packed `Float32Array`, L2-normalized rows, cosine = dot product. Brute-force top-k below the HNSW threshold. |
| `src/main/hnswIndex.ts` | Pure-TS HNSW. `M=16/M0=32/efC=100/efS=96`. Activates only **above 50,000 vectors**; below that it's brute force. Neighbor selection is naive "closest-m" (`select()`), **not** the Malkov heuristic. `efSearch` fixed. Deletions handled by an `allow()` filter (rows never compacted). |
| `src/main/swarmMemory.ts` | Orchestrator: `memorySearch` (vector **or** keyword, never blended), `memoryRelated` (today just re-runs vector search — does **not** walk edges), `memoryGraphQuery`, write + auto-link, the `searchCache`. Ranking sorts by score, `ts` only a tie-break. |
| `src/main/memoryGraph.ts` | Typed weighted directed edges between entries. Adjacency `Map` + `memory-graph.jsonl` append-log. `bfsTraverse` (depth 2, limit 20). Edges from explicit `memory_link` + auto-link on **curated writes** (top-K vector neighbors, relation `relates-to`, weight=cosine). **Transcript/code chunks get no edges.** |
| `src/main/memoryEconomy.ts` | `gateByScore` (min-score + floor + cap), `dedupeHits`, `truncateContent`, `TtlLruCache`. Pure. |
| `src/main/conversationIngest.ts` + `memoryIndexer.ts` | Background ingest of Claude/Codex/Gemini transcripts every 30 min, idempotent SHA-256 dedup, ~2000-char chunks. Append-only raw dialogue; **no consolidation, no usage feedback, no semantic dedup.** |
| `src/main/mcpServer.ts` | MCP tool surface (`memory_search`, `memory_related`, `memory_graph`, `memory_link`, `memory_write`, …). |

**The shape of the plan:** cheap **pure helpers first** → two **structural spines**
(a calibrated **retrieval** spine and a bidirectional **graph + learning** spine) →
an **int8 + worker-thread speed backbone**.

---

## 3. TIER 1 — Quick wins (do these first)

All **Small**, pure, unit-testable, scale-independent. They unblock the spines.

### QW1 — Fuse recency + per-kind importance into the rank
- **Lever:** retrieval. **Files:** `memoryEconomy.ts`, `swarmMemory.ts`.
- **What:** pure `rankScore({relevance,ts,kind,now},weights)`:
  `final = relevance * (1 + alpha*exp(-max(0,now-ts)/tau)) * kindPrior(kind)`,
  `alpha=0.25`, **30-day half-life**, `kindPrior` decision/fact `1.15` → message `1.0`.
  **CLAMP `deltaT>=0`** (synced peer clocks can skew future). **DECORATE** — compute
  `final` once per candidate, sort by the stored value (never call `exp` inside the
  comparator over the 500k keyword pool). Inject `now` for deterministic tests; keep
  `||b.ts` tie-break. Hold `kindPrior` spread `<=1.15` so `contextPrimer`'s message-led
  project bucket isn't starved.
- **Why:** recent/curated context beats stale raw-transcript noise on near-ties;
  also helps the keyword-fallback path where coarse scores tie constantly.

### QW2 — Adaptive per-query relevance gate
- **Lever:** retrieval. **Files:** `memoryEconomy.ts`, `contextPrimer.ts`.
- **What:** `adaptiveGate(hits,{floor,cap,relFrac,absoluteFloor})`: keep
  `score >= max(absoluteFloor=0.25, max(0,topScore)*relFrac=0.6)`, retain the
  keep-at-least-`floor(3)` valve + `cap`. Clamp guards against a negative-cosine
  `topScore` filtering the top hit. Drop-in at `contextPrimer.ts:78-79`. Keep
  `gateByScore` aliased to preserve coverage. **CUT** the rank-fusion largest-gap/knee
  branch (no fusion scores exist yet — ships with QW→BM25).
- **Why:** trims irrelevant injections on a clear relevance cliff (inject 3–4 not 6)
  without starving recall.

### QW3 — Pareto-safe adaptive efSearch
- **Lever:** speed. **Files:** `hnswIndex.ts`, `swarmMemory.ts`.
- **What:** tiny pure `efForK(k,efS,mult,max)`: `ef = efSearch ?? min(max(efS, round(k*4)), 200)`.
  Property: `ef >= today for EVERY k` (k<=96 stays 96; k=97–100 → 200). Add optional
  `efSearch?` override to `search()`. **DROP** the aggressive `EF_MIN=32` small-k cut
  (risks the recall@10>=0.9 gate; revisit only after heuristic-select ships).
- **Why:** strictly better recall on the rare large-k digest/primer path, zero risk
  on the dominant k=10 path.

### QW4 — One read-time near-duplicate / diversity pass
- **Lever:** retrieval. **Files:** `memoryEconomy.ts`, `contextPrimer.ts`, `swarmMemory.ts`.
- **What:** single pure helper applied right after `dedupeHits` over the already
  4×-over-fetched candidate pool (<=100 items, microseconds): greedy **MMR-lite** that
  drops any candidate whose similarity to an already-kept hit exceeds a tunable
  threshold. Cosine when `memorySearch` attaches each result's packed vector
  (`vectorStore.get(row)`), else token-Jaccard/trigram on the snippet. Strict superset
  of `dedupeHits`; no-ops with no embeddings. This is the **non-destructive home** for
  the rejected write-time semantic-dedup.
- **Why:** the same decision/paraphrase stops occupying several of the 6 primer slots.

### QW5 — Edge forgetting-curve
- **Lever:** connections. **Files:** `memoryGraph.ts`, `swarmMemory.ts`.
- **What:** pure `effectiveWeight(weight,ts,now,HALF_LIFE)=weight*0.5^((now-ts)/HALF_LIFE)`
  (named `HALF_LIFE`/`EPSILON`). Carry `e.weight`/`e.ts` through `GraphHit` (additive).
  Replace `memoryGraphQuery`'s hop-only score (`line 709`) with
  `max(0,1-distance*0.15)*effectiveWeight`, drop hits `< EPSILON`. **DROP** last-write-wins
  merge, reinforceEdge writes in the hot path, and any compaction.
- **Why:** `memoryGraphQuery` finally uses the cosine weight it already stores instead
  of pure hop-count; stale edges decay out of traversal. Zero new writes/deps.

### QW6 — Make `memory_related` a typed-edge + vector hybrid
- **Lever:** connections. **Files:** `swarmMemory.ts`, `memoryEconomy.ts`, `mcpServer.ts`.
- **What:** reimplement `memoryRelated(id)`: pull 1-hop `edgesFrom(id)` `{id,relation,weight}`,
  union with today's vector neighbours via a pure `mergeRelated()` in `memoryEconomy.ts`
  that dedups by id, **SATURATES** edge weight into 0..1 (`min(w,1)` or `w/(w+1)`) so a
  default `weight=1` link can't trivially outrank a strong vector hit, scores
  `final=blend(saturatedEdge,vectorSim)`, surfaces `relation`, keeps `score>0`. Query-mode
  unchanged. **DROP** query-mode edge expansion and any fused-result cache.
- **Why:** `memory_related` stops being a relabeled vector search and matches its
  documented "follow the thread" contract; degrades better (edges return hits with
  embeddings off).

---

## 4. TIER 2 — Bigger bets (grouped by spine)

### 4A. Retrieval spine (calibrated hybrid → diversity → PRF)

**BB1 — Calibrated hybrid retrieval: BM25 + dense via RRF** · **L** · *spine root*
- **Files:** new `src/main/lexicalIndex.ts`, `swarmMemory.ts`, `memoryEconomy.ts`.
- **What:** pure BM25 over the hot window (`idf`, `k1=1.2`, `b=0.75`, query-term-only
  postings scan), maintained beside the vector index at **every** mutation site
  (`indexEntryVector`, `memoryWrite` trim+orphan-rebuild, `memoryDelete`, `reloadFrom`,
  `rebuildVectorIndex`, `memoryClear`). Always compute dense top-N **and** lexical top-N;
  fuse with **RRF (K=60)**. **BLOCKING fixes:** RRF feeds `gateByScore({minScore:0.25})`
  and breaks the 0..1 contract — use RRF for **order only** and report a calibrated 0..1
  score (or min-max normalize **and** retune `MIN_RELEVANCE`), with a test that runs real
  `memorySearch` output through `gateByScore`. Reconcile the two dense paths into ONE
  ranked list. v1 tokenizer = `NFC + lowercase + split \W+ + drop len<=2` ONLY (no
  suffix-strip — mangles identifiers). Initial build via `setImmediate`, **not** a worker.
- **Gain:** large precision/recall lift on exact tokens (paths, symbols, error codes,
  CLI flags) where bge-small blurs; promotes the weak keyword fallback into a co-equal
  fused signal and becomes the graceful-degrade path when the embedder is down.
- **Depends on:** QW1 + QW2 first (scale-independent). This is the scoring-spine root —
  MMR, PRF, the adaptive-gate knee all ride on its calibrated score.

**BB2 — MMR vector diversity re-rank inside `memorySearch`** · **M**
- **Files:** new `src/main/mmrRerank.ts`, `swarmMemory.ts`, `contextPrimer.ts`.
- **What:** pure (injected `simFn`, Jaccard fallback). Apply in ONE place —
  `memorySearch` where rows/vectors exist: over-fetch `limit*4` (cap 100), run
  `gateByScore` FIRST (keep minScore+floor=3) but raise its cap to candidate count,
  MMR-rerank survivors to `limit` (`lambda>=0.7`), `simFn` dots normalized
  `vectorStore.get(row)` views. Behind an opt-in `SearchOptions.diversify` flag. **DROP**
  the separate Jaccard MMR pass in `contextPrimer` (double-reorders) — primer just passes
  `diversify:true`. Supersedes QW4 for the vector path.
- **Depends on:** BB1's single ranked dense list first.

**BB3 — Offline pseudo-relevance feedback (Rocchio dense), default-OFF** · **M** · *experimental*
- **Files:** `swarmMemory.ts`.
- **What:** ship ONLY the self-contained dense kernel: pure
  `rocchioExpand(q,topVecs,beta=0.3)=normalize(q+beta*mean)`. After the first dense pass,
  when embeddings present AND top-1 cosine is MODERATE AND results are thin, read top-m
  (~3) hit vectors, run ONE more `searchTopK(q')` with the same filter, **UNION by MAX
  cosine** (NOT RRF — preserves the 0..1 contract). **DROP** the entire RM3-lite/BM25/IDF
  lexical half. Skip when embedder down or a big main-thread brute scan would result.
  Default-OFF; validate real recall lift on a labeled set before enabling.
- **Depends on:** independent once the lexical half is cut. **Lowest-confidence retrieval
  bet — sequence last, gate on a measured eval.**

### 4B. Graph + learning spine (reverse edges → fusion → usage/feedback/decay)

**BB4 — Bidirectional graph traversal (reverse-edge index + relation inversion)** · **M** · *spine root*
- **Files:** `memoryGraph.ts`, `swarmMemory.ts`.
- **What:** auto-links only ever point new→old, so `traverseGraph` on a canonical
  (high-in-degree) node returns `[]`. Add an optional **reverse adjacency Map** built in
  `indexEdge` alongside the forward map; extend `bfsTraverse` to also expand incoming
  edges emitting `GraphHit{id:e.from, from:node, relation:invert(e.relation)}`; pass both
  maps in `traverseGraph` (`directed:true` keeps the legacy path so all 5 bfs tests pass).
  Pure `RELATION_INVERSE` table (`solves<->solved-by`, `supersedes<->superseded-by`, …).
  Export `neighboursOf(id)` merging in+out, deduped by neighbour id keeping max weight.
  Self-contained: static weight floor, NOT the un-landed reinforce-decay.
- **Gain:** ~doubles reachable nodes per seed; stops `memory_graph` returning empty from
  the most-queried older "answer" nodes. **The single biggest connectivity unlock** and a
  prerequisite for graph fusion.

**BB5 — Graph-proximity weighted-path scoring + edge-blended `memory_related`** · **M**
- **Files:** `memoryGraph.ts`, `swarmMemory.ts`.
- **What:** (a) extend `bfsTraverse` to carry accumulated `pathWeight`, **CLAMP** each
  edge weight to `(0,1]` before multiplying (`addMemoryEdge` has no upper bound — a stray
  `weight:5` would dominate); `memoryGraphQuery` score = `clampedPathProduct * gamma^(distance-1)`,
  `gamma~0.8`, sort by score, keep relation/distance. BFS shortest-path greedy approximation
  is fine at depth 2–3 (adjacency is weight-sorted) — **do NOT reach for Dijkstra**.
  (b) blend `edgesFrom` neighbours with vector neighbours via RRF. **DROP** folding a graph
  term into the cached `memorySearch` path; defer write-side reinforcement/decay.
- **Depends on:** BB4 (reverse index); pairs with QW5 (shared `effectiveWeight`).

**BB6 — Transcript "follows" backbone (per-session temporal auto-links)** · **M**
- **Files:** `conversationIngest.ts`, `index.ts` (call sites), `memoryGraph.ts`.
- **What:** Part (a) ONLY. In `runConversationIngest`'s write closure, track
  `lastIdBySession`; after each write with a `sessionId`, call an injected optional
  `link(prev,cur,'follows',1)`; wire `link`→`memoryLink` at both `index.ts` call sites.
  **DROP** part (b) entirely (near-dup `duplicates` edges via per-write `nearestNeighbours`
  — O(n²) main-thread, depends on nonexistent compaction, floods the graph). Idempotent via
  `upsertEdge` dedup + the ingest skip path. Don't touch `memoryWrite`'s kind gate.
- **Gain:** message chunks (the bulk, currently edge-less) gain a per-session backbone —
  "what else happened in that debugging session" recall, and gives fusion real edges to
  walk, at near-zero cost (no extra embed, works keyword-only).

**BB7 — GraphRAG one-hop fusion in the hot retrieval path** · **M**
- **Files:** `memoryGraph.ts`, `swarmMemory.ts`.
- **What:** pure DI helper `expandWithGraph(scored, neighboursOf, getEntry, opts)`. After
  the sort, expand top-`S=5` seeds one hop, keep edges `weight>=TAU`,
  `fused=seedScore*weight*LAMBDA(<=0.5)`, respect `passesFilter`, dedup keeping best, cap
  added neighbours, **SKIP** neighbours where `getEntry` is undefined (edges outlive
  trimmed/tombstoned entries). Flag-gated; byte-identical when `graphStats().edges===0`.
  **FIX the stale-cache trap:** `memoryLink`/`addMemoryEdge` MUST `bumpSearchGen()` or
  explicit edges won't invalidate `searchCache`. Wire to existing `edgesFrom` (O(1)) to
  stay off-budget; swap to `neighboursOf` later with zero helper change.
- **Depends on:** BB4 (`neighboursOf`) and BB6 (edges to walk). **Measure recall delta vs a
  plain vector-limit bump — much auto-edge gain is illusory re-ranking; reliable lift is
  along explicit typed + curated edges.**

### 4C. Speed backbone

**BB8 — Int8 scalar-quantized vector store with Float32 rescoring** · **L**
- **Files:** `vectorStore.ts`, `swarmMemory.ts`.
- **What:** `Int8Array` packed store (scale 127 on L2-normalized rows) → 384 B/vec.
  Two-stage `searchTopK`: int8×int8 gather top-`(k*4)` into a bounded min-heap, then
  asymmetric float-query × int8 **rescore** to top-k. Gate behind an explicit constructor
  flag (`quantize:true`), **NOT** `dim===384` (dim-2/3 unit tests stay on the float seam).
  **DROP** the HnswIndex distance-fn refactor / metric mix — HNSW only READS vectors;
  integrate via a **dequantizing `getVec`**. **DROP** "raise the 50k HNSW threshold". FIX
  `serializeEntry`/`get()` (pull the original float from the device shard for the snapshot,
  or test the round-trip — `get()` is asserted exact to 5dp). **MERGE GATE:** keep the
  recall@10-vs-brute test green with int8 AND add a 384-dim path test. Bump
  `memory-hnsw.json` version (distances change).
- **Gain:** ~4× less vector RAM (768→194MB at the 500k cap) and ~2–3× faster brute-force
  scan in the `<50k` / HNSW-rebuilding window. A power-user-near-the-cap win.

**BB9 — HNSW heuristic (diversity) neighbor selection with backfill** · **M**
- **Files:** `hnswIndex.ts`.
- **What:** `selectHeuristic(base,candidates,m)` = HNSW Alg-4 diversity pruning, used in
  `add()` and the prune branch, behind `opts.heuristic` (default true); `select()` retained
  for tests/fallback; takes an injected `dist(rowA,rowB)` so it stays pure. Use today's
  **full-precision float `d()`** for candidate distances (do NOT couple to int8). ADD
  `keepPrunedConnections` backfill (strict Alg-4 can under-fill degree and LOWER recall).
  Do NOT bump the on-disk graph version. Micro-benchmark the **synchronous incremental
  `add`** (`swarmMemory.ts:468`) per-insert cost, not just the yielded build.
- **Gain:** more uniform node degree / hub control / steadier traversal latency in the
  50k–1M regime; equal recall at lower `efSearch`. No-op below 50k.

**BB10 — In-memory HNSW orphan compaction (replace the synchronous disk-reload)** · **M**
- **Files:** `vectorStore.ts`, `swarmMemory.ts`.
- **What:** pure `VectorStore.compact(liveRows)`: build a fresh `Float32Array` (NOT int8)
  of live rows in entries-array order, return old→new remap. Trigger when
  `orphanRatio > ~0.45` (raise from 0.2 — else it fires 4× more than the 0.5 reload it
  replaces) and no build in flight. **CRITICAL fix:** the "self-invalidates" premise is
  FALSE — `entriesFingerprint` is unchanged by compaction, so you MUST `fs.rmSync(hnswFile())`
  inside `compact` or the next search loads the old-row graph against the remapped store
  (silent mis-scoring). Then null `hnsw` and let the yielded `ensureHnsw` rebuild.
- **Gain:** bounds steady-state vector RAM to ~live size; avoids the synchronous
  `reloadFrom` disk-read+decrypt stall on churn.

**BB11 — Embedding `worker_thread` (move ONNX inference off the UI thread)** · **L**
- **Files:** new `src/main/embedWorker.ts`, `localEmbedder.ts`, electron-vite config.
- **What:** minimal main-process worker: load `BertTokenizer` + ORT session once, keep
  warm, handle `{id,text}→Float32`. Lazy-spawn on first embed; spawn/load **TIMEOUT** trips
  the existing in-process fallback, then keyword. **DROP** `numThreads` escalation
  (nested-pthread + threaded-wasm artifact risk; sublinear on a 33M-param q8 model; SIMD is
  already auto-selected). **DROP** the batch/zero-copy protocol (both call sites embed ONE
  text today). ADD the omitted work: a **second electron-vite rollup input** for
  `embedWorker` + explicit dev-vs-packaged path resolution (reuse `resolveAssetDir`). Keep
  the proxy transport injectable for vitest.
- **Gain:** removes residual per-chunk forward-pass stalls on Electron main during
  background ingest — the genuine un-jank — and is the foundation for real batching.

**BB12 — Token-bounded bucketed embedding batches (ingest throughput)** · **M**
- **Files:** `localEmbedder.ts`, `swarmMemory.ts`.
- **What:** bound each `session.run` by **total encoded tokens** (~1024), NOT a fixed
  count of 16–32 (count-batching is the version that VIOLATES the main-thread budget —
  one run of 16–32 near-max chunks is a multi-hundred-ms-to-second freeze). Hard-cap
  `<=16` chunks as a belt. Length-bucket (sort by encoded length, slice into token-bounded
  sub-batches) so the win lands on the many tiny tail chunks. Push bucketing into
  `embedBatch` as a pure helper. Refactor `memoryWrite` + `memoryWriteBatch` to share ONE
  dedup/persist helper. Scope to first/backlog drain only.
- **Gain:** ~1.3–2× first-index throughput on short chunks (NOT the oversold 3–10×).
- **Depends on:** BB11 for any larger headroom (do count-batching in the worker, never main).

### 4D. Continual-learning plumbing (rides on the graph spine)

**BB13 — Usage-reinforcement ranking ("learn, not accumulate")** · **M**
- **Files:** `swarmMemory.ts`, `memoryEconomy.ts`.
- **What:** in-memory usage map + pure `fuseImportance(baseScore,usage,now)` with small
  **CAPPED** weights (nudges/breaks ties, never overrides), inserted before the sort at
  `~660`; vitest monotonicity+saturation. Persist as append-only
  `{reinforce:[{id,du,dr}]}` control lines carrying **DELTAS** since last flush (NOT
  cumulative — sync shards would double-count), and ADD the matching `parseShardLine`
  replay branch **in the same change** (unknown control lines are dropped today). On replay
  SKIP tombstoned ids and `ts<=clearEpoch`. Batch the weak retrieved-proxy on the 30-min
  tick; DEMOTE it (tiny weight, log-saturated). Do NOT bump `searchGen` on reinforcement.
  Bound the map with eviction of old low-count ids.
- **Depends on:** the **strong** signal comes from BB14 — land the plumbing now (dormant,
  low-risk); don't bill the gain until the feedback tool exists.

**BB14 — Agent "this memory helped" feedback tool (the keystone signal)** · **S**
- **Files:** `mcpServer.ts`, `swarmMemory.ts`.
- **What:** MCP `memory_feedback({id,helpful,query?})`. `helpful=true` → additive
  CRDT-safe `used` counter persisted as `{reinforce:[{id,used:1}]}` AND (same change) the
  `parseShardLine` replay branch AND a small usage term in the sort — otherwise it's dead
  code. **DROP** the `helpful=false` capped soft-suppress until forgetting-curve-decay
  exists to consume it. Reuse the existing `addMemoryEdge`/`memory_link` path for any edge
  effect. Coach usage in the tool description.
- **Gain:** the cleanest, lowest-noise reinforcement input — far better than
  retrieval-count proxies. It's what makes usage-ranking actually "learn".
- **⚠ Ship WITH BB13** (shares the replay branch + sort term). Do NOT land standalone
  (no consumer = JSONL bloat + dead code).

**BB15 — Device-local forgetting (anti-thrash forgot-set + cold-chunk predicate)** · **M**
- **Files:** `swarmMemory.ts`, a `userData` file (like `memory-hnsw.json`).
- **What:** keep ONLY the constraint-safe core. Pure `isForgettable(entry,now,cfg)`:
  `kind==='message'` ONLY (never note/curated) AND `age>=~14 days` AND no tags AND no
  outgoing edges. **CUT** the spaced-repetition curve / strength / `used==0` logic (no
  persistable usage signal; degrades to age-pruning + mass-forgets un-queried chunks after
  restart). The piece worth keeping is the **forgot-set** that stops the 30-min idempotent
  re-ingest thrash — store it **DEVICE-LOCAL** (userData), **NOT** as `{forgot:hash}` in
  synced shards (that silently deletes data another device uses). CAP the forgot-set (last
  ~50k, evict oldest). Run capped (`<=200/tick`) with `setImmediate` yield; compact orphan
  rows after each batch.
- **Gain:** modest RAM/working-set trim for unusually large local brains. The device-local
  forgot-set is the real prize — the prerequisite that makes any future forgetting
  non-thrashing. **Defensible no-ship if brains rarely approach 500k.**

**BB16 — Graph densification over the bulk (consolidation, trimmed L→M)** · **M**
- **Files:** `swarmMemory.ts`, `memoryGraph.ts`.
- **What:** **DROP** the entire leader/canopy clustering + medoid + synthetic cluster-note
  + dual-tier subsystem (redundant with semantic retrieval — a medoid is a re-labeled
  verbatim chunk; `memory_related` already spans the bulk). Keep ONE surgical change:
  extend the EXISTING side-effect-free auto-link `nearestNeighbours` scan to
  `kind:'message'/'note'` but gated at **HIGH cosine (~0.6)**, `K=1`, bounded per indexer
  tick, so only genuinely tight relations get a `relates-to` edge. Derive "already-linked"
  from append-only edges on load (never mutate/re-persist entries). Skip linking near the
  hot-window trim boundary. Any `memory_consolidate_pending()` MCP tool is EXPERIMENTAL.
- **Depends on:** overlaps BB6; feeds BB7. Lowest-confidence learning structural bet.

---

## 5. GUARDRAILS — the sub-parts that were CUT (do not re-add)

All 24 proposals survived as "modify"; **none** were rejected outright. These are the
landmines a prior design pass already removed — re-adding any of them re-breaks a
constraint:

| Cut | Why |
|---|---|
| **Multi-threaded WASM (`numThreads=4`)** | nested-pthread + threaded-wasm artifact-resolution risk in bundled Electron, sublinear on a 33M-param q8 model; SIMD already auto-selected. Single-thread worker keeps the win. |
| **Count-based 16–32 main-thread batches** | one uninterruptible run = multi-hundred-ms-to-second UI freeze. Use token-bounded (~1024) buckets; count-batching only inside the worker. |
| **Write-time semantic dedup (cosine collapse/merge/skip)** | O(n) probe per write on the bulk path = aggregate O(n²) on main; "merge"/"skip" is silent IRREVERSIBLE loss. Moved to a non-destructive read-time pass (QW4/BB2). |
| **Spaced-repetition forgetting on a non-existent usage signal** | degrades to age-pruning + mass-forgets un-queried chunks after restart. Kept only the device-local anti-thrash forgot-set + cold-chunk predicate. |
| **`{forgot:hash}` in synced shards** | propagates across the device-sync CRDT — one idle device silently deletes data another actively retrieves. Forgot-set must be device-local. |
| **Label-propagation / union-find topic communities** | an L-sized 4-file subsystem that percolates the auto-link graph into one giant useless component, INERT for the message/note kinds the primer injects. Reduced to a pure `diversifyHits` helper (QW4). |
| **Consolidation clustering + medoids + synthetic nodes + LLM-distill tier** | a medoid is a re-labeled verbatim chunk; its `part-of` edges re-encode adjacency semantic search computes on demand. Reduced to a high-threshold auto-link extension (BB16). |
| **HNSW int8 distance-fn refactor (build/search metric mix)** | HNSW only READS vectors; mixing metrics has unvalidated recall impact for a µs gain. Integrate via a dequantizing `getVec` instead; full-precision graph construction. |
| **Edge LWW merge + co-retrieval reinforcement writes in the search hot path** | LWW clobbers a strong explicit `memory_link` with a later weak auto-link; co-retrieval writes put synchronous `fs.appendFileSync` into the cached read path + a rich-get-richer loop. Lazy read-time decay (QW5) delivers the benefit. |
| **RRF / RM3-lite / IDF lexical half of Rocchio; RRF over homogeneous dense lists** | depends on the separate BM25 index and mis-applies rank-fusion to two cosine lists, destroying the calibrated 0..1 score contract. Ship dense-only union-by-max-cosine (BB3). |
| **Adaptive-gate largest-gap "knee" + graph term in the cached `memorySearch` path** | the knee targets rank-fusion scores that don't exist yet (ships with BB1); the seed-id graph term adds `searchCache`-key + hot-path risk unjustified at single-user scale. |
| **A real vector DB / graph DB / native ANN binary / any LLM-HyDE / network call** | never proposed — would fail the hard constraints on sight. Everything stays pure-TS/WASM, offline, append-only, single-user, keyword-degradable. |

---

## 6. Recommended sequencing

1. **Quick wins, in any order:** QW1, QW2, QW3, QW5, QW6, then QW4. (All Small, pure,
   independent. QW1 + QW2 specifically unblock the retrieval spine.)
2. **Graph spine root:** BB4 (bidirectional traversal) — biggest connectivity unlock;
   amplifies QW6.
3. **Retrieval spine root:** BB1 (BM25 + RRF) — needs QW1/QW2; everything calibrated rides
   on it.
4. **On top of BB4:** BB5 (weighted-path scoring) and BB6 (`follows` backbone, independent).
5. **On top of BB1:** BB2 (MMR rerank).
6. **Graph fusion:** BB7 — needs BB4 + BB6. *Measure vs a plain vector-limit bump before
   committing.*
7. **Speed backbone (independent, any time):** BB11 (worker) → BB12 (bucketed batches);
   BB9 (heuristic select); BB8 (int8) ± BB10 (compaction).
8. **Learning plumbing:** BB13 + **BB14 together** (keystone signal). Then BB15 (forgetting),
   BB16 (densification) — lowest confidence; gate on measured value.
9. **Last / experimental:** BB3 (Rocchio PRF) — gate on a labeled-set eval.

---

## 7. Verification checklist (every change)

- [ ] New modules are **pure** and have unit tests (match the ~3,955-test bar).
- [ ] `npm run build` is green.
- [ ] Full suite green **with git on PATH** (a handful of integration tests `spawnSync git`;
      without git they false-fail ~140 — that's environment, not you).
- [ ] e2e smoke still green (`test.yml`) — the renderer/WebGL guard etc. are unrelated but
      the suite must stay green.
- [ ] The specific test each item calls for (e.g. BB1: real `memorySearch` output through
      `gateByScore`; BB8: recall@10-vs-brute with int8 + a 384-dim path test).
- [ ] No new runtime dep that isn't pure-JS/WASM. No network in the hot path. Keyword
      fallback still works with the embedder disabled.
- [ ] If persistence changed: append-only, tolerant of plaintext+ciphertext lines, and
      **nothing device-local written into synced shards**.

---

*Source: 29-agent adversarial design review (workflow `termpolis-memory-improvements`),
24 proposals, all "modify". Regenerate/extend by re-running that workflow against the
current `src/main/` memory stack.*
