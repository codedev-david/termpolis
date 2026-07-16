# Packed vector encoding — stop writing embeddings as decimal text

**Status:** approved (design), pending implementation plan
**Date:** 2026-07-16
**Target:** v1.28.0

## Problem

The memory shard grows ~13 KB per memory and had reached **571,939,248 bytes / 93,988 entries** on the
author's machine. In v1.27.4 it crossed V8's max string length (536,870,888 B) and crash-looped the
app; v1.27.4 fixed the *crash* (byte-streaming loaders) but not the *growth*.

The growth is not "too many memories". It is an encoding choice:

```ts
// swarmMemory.ts — serializeEntry()
const v = vectorStore.get(row)
return JSON.stringify(v ? { ...e, embedding: Array.from(v) } : e)
```

Every write re-inlines the 384-dim embedding as a JSON **decimal array** — `Array.from(Float32Array)`
produces 384 numbers rendered like `0.023456789012345678` (~20 chars each), ~7.7 KB of text per
memory. Measured on the real store (never trust an unmeasured number):

| Sample | Bytes/line |
|---|---|
| Oldest lines (pre-embeddings) | ~497 |
| Newest lines | **~13,082** |

~85% of every modern line is the vector, and ~100% of the growth is. The same 384 floats cost 1,536
bytes packed. The decimal text is also the load cost: hydrating the store JSON-parses ~36M floats.

## Goals

1. Cut store size and growth rate without losing a single memory.
2. Cut load time by removing the 36M-float JSON parse.
3. Keep the shard self-contained (a synced/imported peer still gets vectors free).
4. Preserve full f32 precision — the change must be reversible.

## Non-goals (explicitly rejected)

- **Age-out.** Deleting knowledge to fix an encoding bug.
- **Cold-archive tier.** Demoting knowledge to fix an encoding bug; adds a slow path and states.
- **int8 on disk.** Tempting (~48 MB) and v1.24 measured recall@10 identical — but that was measured
  for *in-memory* search with the f32 source still on disk as ground truth. Making int8 canonical
  **destroys the originals irreversibly** for all 94k memories and forecloses any future model,
  reranker, or metric that wants the precision. f32 already yields ~8 years of runway (below). We do
  not spend a one-way door on runway we do not need. int8 remains available as the existing
  **in-memory** runtime toggle (`setVectorQuantization`).
- **Compaction gate changes.** A healthy store is never 50% dead; compaction was never the lever.

## Design

### 1. Wire format — a NEW field

```jsonc
// legacy: "embedding":[0.0234567890123,0.0119...]   ~7.7 KB
// packed: "emb":"Gxk8PZqZ..."                       ~2.0 KB  (base64 of the Float32Array bytes)
```

A **new** key (`emb`), not a repurposed `embedding`. Overloading `embedding` to hold a string would
make older builds evaluate `entry.embedding.length !== EMBED_DIM` against a 2048-char *string* —
truthy, wrong length, unpredictable downstream. An unknown field is simply ignored.

Self-validating: decode → `bytes.length / 4` must equal `EMBED_DIM`, else treat as absent (and let
the existing backfill re-embed). No dim/format header needed today; a future int8 format would add its
own key rather than overload this one.

### 2. Read path — accept both, permanently

One pure helper resolves either shape:

```ts
decodeEmbedding(entry): Float32Array | null   // entry.emb (base64) | entry.embedding (number[]) | null
```

Feeds the existing `indexEntryVector`. No flag day, no format epoch: legacy lines keep working forever,
including lines written by peers on older builds.

### 3. Write path

`serializeEntry` emits `emb` and stops emitting `embedding`. Single call site.

### 4. Migration — `rewriteSelfShard`, NOT `compactSelfShard`

One-time, on first v1.28.0 launch, in the memory utilityProcess (off the main thread):

```ts
rewriteSelfShard((plain) => {
  const migrated = packEmbeddingLine(plain)                  // pure: decimal[] -> emb base64
  return encKey ? encryptLine(encKey, migrated) : migrated   // the store may be encrypted
})
```

`packEmbeddingLine` is pure and total: a line with a legacy `embedding: number[]` of the right dim is
rewritten to `emb`; **everything else passes through byte-identical** — tombstones, `deletedHash`,
`clearedBefore`/`clearedIds`, `reinforce`, `patch`, already-packed lines, and any line it cannot parse.
Unparseable input returns the input, never a throw: a migration must not be able to lose a line it
merely failed to understand.

**Call site:** `initSwarmMemory`, after the initial `reloadFrom` — i.e. inside the memory
utilityProcess, never on the main thread. **Marker:** `vector-format.json` in userData alongside the
shard (`{"v":2}`); absent or `v < 2` triggers the migration, and it is written only after
`rewriteSelfShard` returns successfully, so a failed run retries next launch rather than being skipped.

**Why not compaction** (the trap): `compactSelfShardImpl` rewrites the shard to its *CRDT
contribution* — dropping superseded edits and adds for deleted entries, coalescing usage. That is a
semantic rewrite riding on a format change. It also carries `if (!syncDir && evictedAny) return`,
which exists because a local-only store whose entries overflow the 500k hot window would have its
on-disk overflow **dropped**. Today the author is at 93,988 of 500,000 so it would be allowed — i.e.
the guard would not save us, and the risk is invisible until someone crosses the window.

`rewriteSelfShard` is a pure line-for-line map: every line preserved, undecryptable lines kept
**verbatim**, atomic temp+rename, already exercised by encryption enable/disable. It has no
dependence on the hot window or eviction state.

Triggered by a `vector-format` marker file (absent/`<2` → migrate → write `{v:2}`), so it runs once.
Expected cost ~5–8 s once (the code's own measured table: 794 ms read + ~1.6 s decrypt + ~1.8 s
re-encrypt + write), paid in the child. A crash mid-migration leaves the original shard intact.

### 5. Backward compatibility

A **downgrade** to ≤1.27.x reads `emb` as an unknown field → those entries load without vectors →
keyword fallback for them. It **self-heals**: `ensureEntryVector` / `memoryBackfillVectors` re-embed
any entry lacking a vector. Degraded and self-correcting; never broken, never lost.

Cross-machine sync: a peer on an older build loses semantic recall on new-format lines until it
upgrades or re-embeds. Acceptable — the author's store is local-only, and the failure mode is
degradation, not loss.

## Expected outcome

| | Today | v1.28.0 |
|---|---|---|
| Store (94k entries) | 572 MB | **~145 MB** |
| Growth per memory | ~13 KB | **~2.4 KB** |
| Entries before the ~2 GB Buffer ceiling | ~165k | **~800k** |
| Load | JSON-parses ~36M floats | base64 decode, no float parse |

At the observed rate (~260 memories/night ≈ 3.4 MB today → ~0.6 MB packed), ~1.85 GB of headroom is
**~8 years**. This is why no age-out is needed.

The BM25 index build (~5 s, Map-hashing 16.4M tokens) is unchanged and remains the load floor — it is
irreducible per prior measurement and runs in the child, costing boot latency, not UI responsiveness.

## Risks

| Risk | Mitigation |
|---|---|
| Migration corrupts the shard | `atomicWriteLines` temp+rename; original intact on crash; abort on undecryptable → kept verbatim |
| Precision drift | f32 round-trip must be **bit-exact**; asserted in tests |
| Migration drops entries | `rewriteSelfShard` is line-for-line; test asserts entry count + every id survives |
| Silent no-op (writes still decimal) | Test asserts the written line contains `emb` and NOT `embedding` |
| Downgrade loses recall | Self-heals via existing backfill; documented |

## Testing

1. `packEmbedding`/`decodeEmbedding` round-trip **bit-exact** for f32 (incl. denormals, ±0, NaN-free real vectors).
2. `decodeEmbedding` accepts legacy `number[]`, packed `emb`, and returns null for absent/wrong-dim.
3. A store written by v1.28.0 reloads with identical vectors → identical search scores vs pre-migration.
4. Migration: entry count preserved, every id preserved, undecryptable lines verbatim, marker written once, second launch is a no-op.
5. Encrypted-store migration re-encrypts (round-trips through `encryptLine`).
6. Size assertion: a synthetic 1k-entry store shrinks ≥3× after migration.
7. Gated real-scale run against a **copy** of the author's 572 MB store (never the original).
