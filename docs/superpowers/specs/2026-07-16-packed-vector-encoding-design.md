# Fast brain — kill the launch dead-window, stop the growth, never crash at size

**Status:** approved (design), pending implementation plan
**Date:** 2026-07-16
**Target:** v1.28.0
**Supersedes:** the earlier "packed vector encoding" draft, which optimised for disk size. Measurement
showed that was ~13% of the real problem.

## Goals (author's words)

1. **Fast** — the app is snappy and the brain is usable almost immediately after launch.
2. **Excellent memory** — recall stays solid and correct; it keeps learning from itself and conversations.
3. **No future crashing** — no matter how large the memory gets.

Disk size is explicitly **not** a goal. It matters only where it buys latency or headroom.

## The problem, measured

The window appears in ~232 ms (main never awaits the brain: `void startMemoryHost(...)`). But the
**brain is dead for ~10 s** after launch. Measured at the real entry count (93,988):

| Cost at every launch | Time | Why |
|---|---|---|
| **BM25 / lexical index rebuild** | **~5 s** | **Never persisted.** Only HNSW is. (Prior measurement: Map-hashing 16.4M tokens.) |
| **HNSW rebuild** | **effectively every launch** | It *is* persisted, then discarded: `loadPersistedHnsw` requires `obj.fp === entriesFingerprint()`, and that fingerprint is a **sha1 over every entry id**. One new memory → fingerprint differs → a 94k-node graph is thrown away. Persistence that never hits. |
| Embedding JSON parse | **~1.3 s** | `serializeEntry` re-inlines the 384-dim vector as a JSON **decimal array** (~7.7 KB of text). Hydration benchmark at 93,988 entries: **1,493 ms** legacy vs **178 ms** packed (**8.4×**). |
| Decrypt | ~1.6 s | inherent to at-rest encryption |

So the dead window is dominated by **rebuilding two indexes we already know how to persist** — one
never saved, the other saved and reflexively discarded.

Separately, the store grows ~13 KB per memory (571,939,248 B / 93,988 entries) because of the same
decimal-vector encoding. That is what crossed V8's string limit and crash-looped v1.27.4.

## Design

Three changes, ordered by measured value.

### 1. Persist the lexical/BM25 index with a verifiable delta reconcile (~5 s)

Mirror what HNSW already does, but reconcile instead of all-or-nothing:

- Persist `{ v, entryIds: string[], index: <packed> }` beside the shard.
- On load: diff persisted `entryIds` against current entries → **add** new ids, **remove** departed ids.
  A typical launch is a few hundred deltas, not 93,988.
- **Safety valve:** if the format/version is unknown, or the delta exceeds a threshold (e.g. >25% of
  entries), discard and rebuild from scratch. Slow-but-correct always beats fast-but-wrong.

### 2. Make HNSW persistence actually load (rebuild → delta)

Replace the sha1-over-all-ids gate with the same delta reconcile: load the persisted graph, insert the
new rows, let the existing `HNSW_REPAIR_RATIO = 0.15` allow-filter handle dead rows as it does today.
Keep a full rebuild as the fallback when the delta is large or the format is stale.

### 3. Packed vectors — base64 f32 under a new `emb` key (~1.3 s, and stops the growth)

```jsonc
// legacy: "embedding":[0.0234567890123,...]   ~7.7 KB of decimal text
// packed: "emb":"Gxk8PZqZ..."                 ~2.0 KB  (base64 of the Float32Array bytes)
```

- **New key**, not a repurposed `embedding`: an older build seeing `embedding:"base64…"` would test
  `.length !== EMBED_DIM` against a 2048-char *string* — truthy, wrong, unpredictable. An unknown key
  is simply ignored.
- **Read both formats forever** via one `decodeEmbedding()` helper. No flag day.
- **f32, not int8.** int8 would be ~12× smaller and v1.24 measured recall@10 identical — but that was
  *in-memory* search with the f32 source still on disk as ground truth. Making int8 canonical destroys
  the originals **irreversibly** and forecloses any future model/reranker/metric wanting precision.
  It buys runway we do not need (below), at a door that never reopens. int8 remains the existing
  **in-memory** toggle (`setVectorQuantization`).
- **Migration:** one-time, first v1.28.0 launch, in the child, via **`rewriteSelfShard`** — a
  line-for-line map that preserves every line, keeps undecryptable lines verbatim, and is atomic
  (temp+rename), already exercised by encryption enable/disable.
  **Not `compactSelfShard`**, which rewrites to the CRDT *contribution* (drops superseded edits,
  coalesces usage) — a semantic rewrite riding on a format change, and carrying
  `if (!syncDir && evictedAny) return`, a guard that exists because a local-only store overflowing the
  500k hot window would have its on-disk overflow **dropped**. At 93,988/500,000 that guard would not
  fire, i.e. it would not save us.
  `packEmbeddingLine` is pure and total: tombstones, `reinforce`, `patch`, already-packed, and
  unparseable lines pass through **byte-identical**; unparseable input returns the input rather than
  throwing. Marker `vector-format.json {"v":2}` written only after a successful rewrite, so a failed
  run retries next launch instead of being skipped.

## Goal 3: never crash at size

- **V8 string cliff — already fixed** (v1.27.4 byte readers + source guard).
- **~2 GB Buffer ceiling** on `readFileSync(file)`: packing moves this from ~165k to ~800k memories,
  which is **beyond the 500k hot window** — so it stops being the binding constraint. Above it,
  `readFileSync` throws a *catchable* `ERR_FS_FILE_TOO_LARGE` (degrade, not abort).
- **The real long-term wall is child RAM**, not disk: the hot window caps at 500k entries and 93,988
  already cost ~947 MB. That is ~4 years away at the observed rate (~260 memories/night) and the
  eviction path (`evictedAny` → on-disk overflow) already exists. **Explicitly out of scope**, and
  recorded here so it is discovered on purpose rather than at 500k.

## Expected outcome

| | Today | v1.28.0 |
|---|---|---|
| **Brain dead-window after launch** | **~10 s** | **~2–3 s** |
| Store (94k entries) | 572 MB | ~165 MB |
| Growth per memory | ~13 KB | ~2.4 KB |
| Memories before the ~2 GB disk ceiling | ~165k | ~800k (past the 500k hot window) |

## Risks

| Risk | Mitigation |
|---|---|
| **A stale index silently returns wrong recall** — the one risk that threatens "excellent memory"; worse than being slow | Delta reconcile is asserted **equivalent to a from-scratch build** (below), plus a size/threshold safety valve that rebuilds when in doubt |
| Migration corrupts or drops lines | `rewriteSelfShard` is line-for-line + atomic temp+rename; undecryptable lines verbatim; original intact on crash |
| Precision drift | f32 round-trip must be **bit-exact**; asserted |
| Silent no-op (still writing decimals) | Test asserts the written line contains `emb` and not `embedding` |
| Downgrade to ≤1.27.x | `emb` unknown → those entries load vectorless → keyword fallback; **self-heals** via existing `ensureEntryVector` / `memoryBackfillVectors` |

## Testing

The load-bearing test is **equivalence**, not speed:

1. **Reconcile == rebuild.** For a store mutated N ways (adds, deletes, edits), a persisted+reconciled
   index must answer **identically** to a from-scratch build — same hits, same order, same scores.
   Mutation-test it: corrupt the persisted index and the test must fail.
2. Prior lesson honoured: *you cannot detect a corrupt index by searching for a memory* — the `allow`
   gate hides it. **Assert the index's size/contents directly**, not via search.
3. `packEmbedding`/`decodeEmbedding` round-trip **bit-exact** f32; `decodeEmbedding` accepts legacy
   `number[]`, packed `emb`, null for absent/wrong-dim.
4. Migration: entry count and every id preserved; undecryptable lines verbatim; marker written once;
   second launch is a no-op; encrypted store re-encrypts.
5. Real-scale, gated: run against a **copy** of the author's 572 MB store (never the original) and
   assert the dead-window drops and recall is unchanged vs pre-migration.
