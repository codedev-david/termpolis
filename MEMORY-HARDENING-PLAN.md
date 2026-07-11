# Memory & Learning Hardening Plan — ships in v1.19.4

> **Self-contained handoff.** Do NOT rely on the Termpolis memory brain to carry this context — that broken trust is exactly what we are fixing. Everything you need is in this file plus its companion `memory-audit-confirmed.json` (full code-quoted evidence for all 35 findings).

## Status
- Produced by a 12-dimension **adversarial audit** of the memory + learning subsystem — every finding was refuted against the real code before it counted.
- **35 findings CONFIRMED** (below; full evidence in `memory-audit-confirmed.json`).
- The verify + auto-synthesis phases were **cut short by a Claude usage limit** (reset 11pm ET, 2026-07-04). ~54 more raw findings were generated but NOT yet verified — see **Wave 2** at the bottom.
- You will likely need fresh token headroom (post-11pm, or the other account via `/switch-account`) to finish overnight.

## Why this matters
Termpolis shared memory is THE feature — it lets a new session pick up without re-explaining context. That only holds if memory never silently loses, corrupts, mis-ranks, or misreports data. This pass makes it fool-proof and reviews whether the *learning* loop is genuinely sound (measurably improves recall), not merely bug-free. Trigger: a confirmed bug where memory ranked an old re-ingested transcript as "most recent" because entries store ingestion time, not conversation time.

## Repo state (verify before starting)
- Branch `main`, version **1.19.3**. Confirm CI is green on HEAD and the tree is clean.
- Already on `main`, UNTAGGED, to ship in the SAME release:
  - `1fa68ba` — "Loaded N memories" banner for Codex/Gemini/Qwen
  - `870c8c4` — worker-thread typing-lag fix
  - `a07eec0` — embed-worker diagnostic log
- Next tag: **v1.19.4**.

## Release coordination — everything ships as ONE release: v1.19.4
This hardening is NOT a standalone drop. When the whole list is green, cut ONE release, `v1.19.4`, bundling the three commits above PLUS every hardening commit from this plan. Use the repo `release-notify` skill: bump 1.19.3 -> 1.19.4, commit, tag `v1.19.4`, watch BOTH the Tests and Release pipelines to green, send the release email. One tag, one auto-update, everything together.

## How to execute (autonomous, overnight)
1. Verify the baseline: `main` green, tree clean.
2. **Strict TDD, one item at a time, top of the ranked list down.** Each finding "Failure" line IS the test spec: write a test that reproduces it, watch it FAIL, apply the **Fix**, watch it PASS. No fix without a failing test first.
3. Run headless after each item: `npm test` (vitest) to green; `npm run build` (typecheck) and `npm run lint` clean before release.
4. Do NOT lean on the memory brain for context — this file is the source of truth.
5. Do NOT stop to ask. Drive to a released, verified v1.19.4. If a finding proves invalid on close reading, say so in the commit and move on.
6. **Definition of done:** every item landed with a passing test; Wave 2 triaged; full suite + build + lint green; bundled with `1fa68ba` / `870c8c4` / `a07eec0`; released as **v1.19.4**; both pipelines green; release email sent.

## Priority 0 — the anchor bug (already approved; do first)
**`ts` = ingestion time, not conversation time.** `conversationIngest.ts` parses real per-message timestamps into `chunk.startTs`/`endTs` (conversationIngest.ts:98, 231-232) but the store-write drops them (conversationIngest.ts:492-500; `IngestMemory.write` has no `ts` field, line 465), so `memoryWrite` falls back to `ts: input.ts ?? Date.now()` (swarmMemory.ts:554); `memoryList` returns insertion order (swarmMemory.ts:1225) and `memorySearch` folds `ts` into its score (swarmMemory.ts:983-985). Old re-ingested transcripts therefore rank as "most recent."
**Fix (3 parts):** (1) thread `ts: chunk.endTs ?? chunk.startTs` through the ingest writer and add `ts?: number` to the `IngestMemory.write` type; (2) make `memoryList` sort by `ts` desc instead of insertion order; (3) confirm `memorySearch` recency now uses real conversation time. Also fix the sibling: graph edges stamped `Date.now()` at ingest (memoryGraph.ts:209) — same class.
**Test:** ingest a synthetic transcript with OLD per-message timestamps; assert the stored entry `ts` equals the conversation time and that `memoryList`/`memorySearch` order it by real age, not ingest order.

## Learning-methodology soundness (required — not optional)
Beyond bug-fixing, prove the learning loop actually works:
- **Measure:** run the offline recall benchmark (`recallBenchmark`, shipped v1.18.2 — real bge + IR metrics) for a BEFORE baseline; re-run AFTER and confirm recall improves or holds with zero regression.
- **Review** the findings tagged `learning` / `retrieval` / `retention` below (consolidation "sleep", reflection, feedback, cross-agent teaching, curiosity, meta): ensure none drift, corrupt, or delete high-value memories, and that importance/decay scoring is evidence-based.
- **Gate:** any learning mechanism that cannot be shown net-positive on the benchmark ships OFF by default (precedent: graph-fusion was made opt-in after the benchmark showed no default-on benefit, acdf4ee).

## Confirmed findings — ranked by severity / blast-radius
Work top-down. Full code-quoted evidence for each is in `memory-audit-confirmed.json`.

### 1. Unbounded `clearedBefore` epoch = one bad clock (or one corrupt line) permanently wipes the whole brain on every device and silently locks out all future writes
**Severity:** critical  |  **Area:** sync  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:172

**Failure (your test spec):** 1) A user's machine has a wrong clock (dead CMOS battery / manual misconfig / VM with drifted RTC) reading year 2099, or a shard line is corrupted/hand-edited so `clearedBefore` is huge. 2) On that machine `memoryClear()` runs (`memory:clear` IPC, index.ts:1140), executing `clearEpoch = Date.now()` (line 1252) and appending `{"clearedBefore": 4102444800000}` to the shard (line 1253). 3) That shard syncs everywhere. 4) On EVERY device, `parseShardLine` does `if (obj.clearedBefore > clearEpoch) clearEpoch = obj.clearedBefore` with NO upper bound (line 172), so clearEpoch jumps to the year-2099 value. 5) `reloadFrom` then drops every entry via `if ((e.ts || 0) <= clearEpoch) continue` (line 206) — all real memories (ts ~1.7e12 < 4.1e12) vanish. 6) The poison line is append-only and persists forever, and `reloadFrom` resets clearEpoch to 0 then re-derives it from that line on EVERY reload (30-min timer, index.ts:1903), so the wipe re-applies indefinitely. 7) Worse, every NEW write also gets `ts: Date.now()` ~1.7e12 (line 554) which is still <= clearEpoch, so it is swallowed on the next reload — the brain permanently refuses to remember anything new. Reinforcement deltas are discarded too (`r.ts <= clearEpoch`, line 223).

**Fix:** Never trust an unbounded wall-clock epoch. On merge, clamp/reject absurd values: `if (obj.clearedBefore > clearEpoch && obj.clearedBefore <= Date.now() + MAX_SKEW) clearEpoch = obj.clearedBefore`. Better, stop using a wall-clock cutoff for clears entirely: have `memoryClear` enumerate the concrete set of currently-live entry ids into tombstones, or issue a monotonic per-device logical clear COUNTER tagged with the issuing deviceId, so a mis-clocked machine cannot poison the global epoch. Also persist a device-local monotonic floor so a bogus future epoch can be detected and refused.

**Why it matters:** A single device with a mis-set clock, or a single corrupted/edited shard byte, silently and permanently destroys the entire shared memory on all devices AND disables all future learning, with no UI path to recover (only manual shard-file surgery). This is the maximal 'memory silently loses all data' failure and it is reachable via an ordinary clock misconfiguration, not just deliberate corruption.

---

### 2. memory_search and memory_primer never drop superseded memories — only memory_graph does, so a decision the agent explicitly marked obsolete resurfaces as the top/leading recall
**Severity:** high  |  **Area:** contract  |  **Where:** src/main/swarmMemory.ts:986

**Failure (your test spec):** 1) Agent stores decision D1 'Use REST for the sync API' (memory_write → id mem-A). 2) Later it stores D2 'Switched sync API to gRPC; REST is deprecated' (id mem-B) and, exactly as the memory_link tool tells it to ('a decision that supersedes an older one'), calls memory_link{from:mem-B, to:mem-A, relation:'supersedes'}. 3) A new session calls memory_search{query:'sync API transport'} or loads memory_primer. memorySearch (swarmMemory.ts:862-1025) scores/ranks/gates/diversifies but NEVER calls filterSuperseded — which is imported (line 12) yet used at only one site, memoryGraphQuery line 1134. buildContextPrimer (contextPrimer.ts:95-181) also never calls it. 4) D1 (higher cosine to 'REST', or simply both present) is returned to the agent — often ranked at or above D2 — with no 'superseded' marker. The agent acts on the deprecated REST decision. memoryGraphQuery's own comment (line 1132-1133) 'never hand back a memory that a later one supersedes' proves the guarantee exists ONLY for graph traversal, not for the two primary recall paths.

**Fix:** Apply the existing filterSuperseded(hits, getAllEdges()) at the end of memorySearch (before searchCache.set) and inside buildContextPrimer's gate, or at minimum tag superseded hits with a '⚠ SUPERSEDED by <id>' label in renderLine the same way the stale-file guard works. supersededIds/filterSuperseded are already implemented in mnemeGraphLogic.ts.

**Why it matters:** The memory_link tool actively solicits supersedes/superseded-by edges and implies they keep stale answers from resurfacing; but the paths agents actually recall through (search, primer) ignore them. The brain silently presents replaced knowledge as current — the exact 'resurface stale content as fresh' failure the audit targets, and it worsens as the store grows.

---

### 3. Turning cross-machine sync OFF silently discards all reinforcement-learning (usage) counts and can revert to a stale/empty local store
**Severity:** high  |  **Area:** durability  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:1513

**Failure (your test spec):** setSyncDir(null) snapshots the unioned memories into legacyPath with `const snap = entries.map(serializeEntry).join('\n'); fs.writeFileSync(legacyPath, snap ? snap + '\n' : '')` (1513-1514), then re-inits local-only. Two durability defects: (1) serializeEntry (777-782) emits ONLY MemoryEntry objects — it does NOT emit the `{reinforce:[...]}` delta control lines. usageMap is rebuilt exclusively from those delta lines on reload (reloadFrom 219-227, replaying pendingReinforce). So after the toggle, usageMap is empty: every BB13/BB14 usage/'helpful' signal the fleet accumulated is permanently gone, and ranking (learnedUtility uses `useCount`, 983) regresses — memories the user repeatedly confirmed helpful lose their learned boost. (2) The snapshot writeFileSync is non-atomic and its failure is swallowed (`catch { /* best effort */ }`, 1515). If it throws (disk full, or OOM building a multi-GB join() string over a large synced brain), legacyPath is left as a STALE pre-sync file (or empty), then initSwarmMemory(local) loads that — so turning sync off can silently revert the brain to an ancient snapshot and drop everything accumulated while sync was on.

**Fix:** When snapshotting for sync-off, also serialize the current usageMap as `{reinforce:[...]}` lines (and any live tombstones/clearEpoch) into legacyPath so learning survives the round-trip. Write the snapshot atomically (temp+fsync+rename) and, if it fails, ABORT the switch (do not overwrite the sync config / re-init) so the user isn't dropped onto a stale local store.

**Why it matters:** A reversible-looking UI action (stop syncing) silently and permanently erases the learning layer and, on any write hiccup, most of the store — with no error surfaced. That is exactly 'regress/drift its learning' plus silent data-loss.

---

### 4. loadOrCreateSalt regenerates and OVERWRITES the encryption salt on any transient read failure or corruption — permanently locking out all encrypted memory
**Severity:** high  |  **Area:** durability  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:1441

**Failure (your test spec):** The salt is critical key material (deriveKey = scryptSync(passphrase, salt), memoryCrypto.ts:28-30). loadOrCreateSalt tries to read it, and on ANY exception OR any non-16-byte result falls through to `const s = newSalt(); fs.writeFileSync(p, s.toString('base64'))` (1440-1441) — it OVERWRITES the existing salt file in the synced folder. The salt lives in the sync folder (SALT_FILE, 125). Reachable: user re-enters their (correct) passphrase via setSyncPassphrase (1478 calls loadOrCreateSalt) while the cloud-synced .termpolis-salt is momentarily unavailable, half-synced (wrong length), or corrupted by a bad merge → a brand-new salt is generated and written over the real one. deriveKey now yields a different key. If a peer's ciphertext happens to be present, findAnyEncryptedLine+decrypt fails → the user is told 'Incorrect passphrase for the existing encrypted memory' (1482) despite typing the right one; if no peer ciphertext is present yet, the new key is silently cached and this device re-encrypts under it — and every peer's existing ciphertext (encrypted under the original salt) becomes permanently undecryptable once the overwritten salt propagates.

**Fix:** Only create a salt when the file genuinely does not exist (fs.existsSync === false). If the salt file exists but is unreadable or malformed, THROW/abort (surface 'memory salt unavailable, retry') instead of minting and writing a replacement — never overwrite an existing salt. Optionally keep a local backup copy of the salt in userData and cross-check before regenerating.

**Why it matters:** A transient unavailability or single-byte corruption of a non-secret helper file destroys the one piece of material needed to ever read the encrypted store again, and the failure masquerades as a wrong-passphrase error. That is silent, irreversible loss of the entire encrypted brain.

---

### 5. Init failure sets memPath=null for the WHOLE session — every subsequent write is silently discarded while memory_write still returns success
**Severity:** high  |  **Area:** durability  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:278

**Failure (your test spec):** initSwarmMemory wraps mkdirSync(syncDir)/copyFileSync/writeFileSync/reloadFrom in one try; on ANY throw it does `recordSwarmError(...); memPath = null` (277-278). The most reachable trigger: cross-machine sync is enabled and the sync folder is a cloud/network path (Dropbox/OneDrive/SMB) that is offline or not-yet-mounted at launch → `fs.mkdirSync(syncDir, { recursive: true })` (253) throws → memPath=null. There is no retry and no other code path ever re-assigns memPath (only 254/269/278 and setSyncDir). For the rest of the session: appendShardLine's `if (!memPath) return` (630) makes persist() a no-op, memoryClear's `if (!memPath) return` (1248) makes clear a no-op, yet memoryWrite still embeds, pushes to `entries`, and returns the entry as success (582/624). The user works a full session; ingest + reflection + manual memory_write all appear to succeed; the entire session's memory is RAM-only and is gone on the next launch. The only signal is one telemetry event the user never sees.

**Fix:** On init failure, fall back to the local legacyPath as a writable target instead of nulling memPath (so writes still persist somewhere), and expose a durable 'memory is read-only / degraded' state through getSyncStatus() so the UI can warn the user. Additionally, attempt a lazy re-init on the first write after failure (retry mkdir/open) rather than giving up for the entire process lifetime.

**Why it matters:** A momentary folder-unavailable at startup (extremely common with cloud-synced folders and laptops resuming from sleep) permanently poisons the whole session into silent data-loss mode, with the API continuing to report every write as successful. This is the archetypal 'silently fail and continue' failure the audit targets, at the worst possible scope (all writes, whole session).

---

### 6. memoryWrite reports SUCCESS after a swallowed disk-append failure — the entry lives only in RAM and vanishes on next launch
**Severity:** high  |  **Area:** durability  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:633

**Failure (your test spec):** appendShardLine catches ANY fs.appendFileSync error and only records telemetry: `catch (err) { recordSwarmError('swarmMemory.persist.failed', err, ...) }` (633-637) — it never rethrows. persist() (640-642) returns void, and memoryWrite ignores it: after `persist(entry)` (574) it unconditionally does `entries.push(stored)` / `seenHashes.add` (582-583) and `return entry` (624). Concrete path: user is editing files, an antivirus/backup/Dropbox handle briefly locks <deviceId>.jsonl (routine on Windows — the repo even documents this race in contextPinStore.ts:94), OR the disk is momentarily full. Agent calls memory_write('decision: we chose Postgres over Mongo because X'). appendFileSync throws EBUSY/ENOSPC → swallowed. memory_write returns the entry with an id → the MCP tool reports success → the agent believes the decision is durably saved and moves on. The line never reached disk. Next launch, reloadFrom reads the shard, the decision is absent, and the agent re-litigates a settled decision. No user-visible error at any point.

**Fix:** Make persistence failure observable to the caller. appendShardLine should return a boolean (or throw); persist() should propagate it; memoryWrite should either throw (so the MCP handler surfaces a real error to the agent) or attach a `durable:false` flag on the returned entry AND retry-on-next-flush. At minimum, do not add the entry to seenHashes when the append failed, so a later re-ingest/retry can re-attempt the write instead of the content-hash guard permanently masking the lost line.

**Why it matters:** For a 'memory brain that must never silently lie to or lose data,' this is the core violation: the write API's success return is decoupled from durability. A single transient IO hiccup during normal operation silently drops exactly the high-value curated memory (decision/fact/result) the feature exists to preserve, and the agent is actively misled into thinking it was saved.

---

### 7. Whole-shard rewrite for encryption enable/disable is non-atomic — an interrupted rewrite truncates or corrupts the entire device shard
**Severity:** high  |  **Area:** durability  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:1468

**Failure (your test spec):** rewriteSelfShard reads the whole shard into memory, transforms every line, then rewrites in place with `fs.writeFileSync(memPath, out.length ? out.join('\n') + '\n' : '')` (1468) — no temp-file+rename, unlike the repo's own atomicWriteJson (agentMcpRegistry.ts:29) and contextPinStore.ts:88-92. writeFileSync opens with 'w', which TRUNCATES the file first and then streams the (potentially many-MB) buffer. If the process crashes / loses power / hits ENOSPC after truncation but before the full buffer is flushed, the shard is left empty or half-written — and the write error is swallowed (`catch { /* best effort */ }`, 1468). This path runs during setSyncPassphrase (enable encryption / unlock a new device, 1487) and disableSyncEncryption (1496): a user with a large synced brain turns encryption on, the machine is put to sleep / force-quit mid-rewrite, and their entire device shard is now truncated. Because each device only writes its own shard, that content isn't recoverable from peers if they haven't synced it.

**Fix:** Rewrite via temp-file + fsync + atomic rename (reuse the atomicWriteJson pattern): write to memPath+'.tmp', fsync it, then renameSync over memPath, with the contextPinStore Windows fallback. Do not swallow the write error — surface it and keep the original file intact on failure.

**Why it matters:** This converts a routine settings toggle into a whole-shard wipe on any ill-timed interruption. The codebase already has the atomic-write primitive; the memory brain — the one store where loss is unacceptable — is the one that skips it.

---

### 8. embeddingsAvailable latches false permanently on the FIRST null/failed embed — one transient inference error disables the semantic brain for the whole session with no retry
**Severity:** high  |  **Area:** embedding  |  **Where:** src/main/swarmMemory.ts:1540

**Failure (your test spec):** `embed()` caches a single boolean and never re-probes: line 1540 `if (embeddingsAvailable === false) return null` short-circuits every future call, and both the null-result branch (1543-1546) and the catch branch (1549-1551) set `embeddingsAvailable = false`. Grep confirms it is only ever reset to null at initSwarmMemory/reset (lines 249, 308) — there is NO periodic re-probe. Concrete trigger without any worker: (1) The in-process backend throws ONCE — `be(bucket)` raising a transient onnxruntime-web WASM runtime error under momentary memory pressure, or `loadDefaultBackend` throwing once on first load because the .onnx file is briefly locked by Windows Defender's on-access scan. (2) That single throw makes `embedText` return null for that call (embedBatch leaves the slot null / getBackend returns null). Note this ALSO trips a second permanent latch inside localEmbedder: a load throw calls `markFailed()` → `loadFailed = true` (localEmbedder.ts:115-119, 224), after which `getBackend()` returns null forever (line 110). (3) `swarmMemory.embed()` sets `embeddingsAvailable = false`. (4) From then on, for the remainder of the session, EVERY memoryWrite stores an entry with no embedding and EVERY memorySearch runs keyword-only — even though the model would now load and run fine. Only an app relaunch (re-init) clears it, and if the root cause is deterministic the relaunch reproduces it.

**Fix:** Do not cache `false` as a terminal state from a single per-call null. Either re-probe each call (localEmbedder already owns the truly-dead latch via `loadFailed`, so swarmMemory caching false is redundant and harmful), or replace the boolean with a bounded retry/backoff that periodically re-attempts, or only latch false when `isEmbedderReady()===false AND a load was actually attempted`. Also call `recordSwarmError('swarmMemory.embed.failed', ...)` on the transition so the degradation is observable.

**Why it matters:** A memory brain that must 'never silently lie' instead flips itself into permanent keyword-only mode on the first hiccup and, because the flag is sticky, denies itself any recovery. Every fact written during the degraded window is persisted vector-less to disk (see the companion backfill finding), so the damage outlives the transient error and even outlives the session. This is the same CLASS as the confirmed ts bug: a silent, sticky degradation of stored-memory quality that misleads every later recall.

---

### 9. Worker embed that resolves null (crash/exit/model-absent-in-worker) is treated as SUCCESS, so the in-process fallback is skipped and semantic memory silently dies
**Severity:** high  |  **Area:** embedding  |  **Where:** src/main/localEmbedder.ts:282

**Failure (your test spec):** Production wires a real worker_thread (index.ts:1672 `setWorkerSpawner(() => createWorkerTransport())`, spawned lazily on first embed). The worker embeds one text per message; on the main side, `createWorkerTransport` (embedWorker.ts:43-45) installs `failAll = () => { for (const resolve of pending.values()) resolve(null) }` on BOTH the worker 'error' and 'exit' events — i.e. a worker crash RESOLVES the pending embed with `null`, it does not reject. Step by step: (1) The embedding worker crashes mid-request — e.g. an onnxruntime-web WASM fault/OOM during `session.run` on a pathological chunk, or the worker's own model load returns null so its `embedText` yields null (embedWorker.ts:22). (2) `w.embed(text)` resolves to `null`. (3) In `tryWorkerEmbed` the `Promise.race` resolves (no throw), so it returns `{ ok: true, vec: null }` (line 282) — a null vector is reported as a SUCCESSFUL embed. (4) In `embedBatch` the worker loop (lines 349-354) sees `r.ok === true`, pushes `null`, keeps `ok = true`, and returns `[null]` WITHOUT ever reaching the in-process `getBackend()` fallback below. (5) `embedText` returns null; `swarmMemory.embed()` treats null as a dead embedder and latches `embeddingsAvailable = false` (swarmMemory.ts:1544). Result: a single worker crash converts the entire session to keyword-only recall, and the perfectly-good in-process backend is never tried — the exact opposite of the design contract quoted at localEmbedder.ts:239-240 and index.ts:1669-1671 ("any spawn/timeout/failure disables the worker and falls back to the in-process embedder").

**Fix:** Treat a null worker result as a miss, not a success. In `tryWorkerEmbed` return `{ ok: vec !== null, vec }` (localEmbedder.ts:282) so `embedBatch` breaks and falls through to the in-process backend; and/or in `embedWorker.ts` change `failAll` to REJECT pending promises on 'error'/'exit' (lines 43-45) so a crash surfaces as a real failure. Add a unit test where the injected worker resolves null and assert the in-process backend is used.

**Why it matters:** The worker layer was added purely as a main-thread-offload optimization and was explicitly promised to be recall-safe ("recall cannot regress"). Because a null-resolving worker is indistinguishable from success here, a transient worker fault silently downgrades the product's core value (semantic memory) to keyword search for the whole session — and unlike the timeout path (which correctly returns ok:false and falls back), this path never even consults the working in-process embedder. The tests only cover the worker THROWING (localEmbedder.test.ts:327), never the worker resolving null, so this gap is unguarded.

---

### 10. Deletes and clears are stored only in the deleter's shard, not co-located with the data — losing/lagging that one shard resurrects everything it deleted
**Severity:** high  |  **Area:** sync  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:192

**Failure (your test spec):** clearEpoch and tombstones are NOT persisted device-locally; `reloadFrom` resets them (`clearEpoch = 0`, `tombstones.clear()`, lines 192-194) and re-derives them ONLY from the shard files currently present (lines 171-172). Scenario A (clear): Device A and B are synced with thousands of memories physically stored in `a.jsonl` and `b.jsonl`. User clears on A → the `{clearedBefore:T}` control line lands ONLY in `a.jsonl`. B drops ts<=T entries on reload — correct. Now A is decommissioned and `a.jsonl` is removed from the sync folder (or a fresh Device C syncs before `a.jsonl` has propagated). On C/B's next `reloadFrom`, no shard contains a `clearedBefore` line, so `clearEpoch` stays 0, and every previously-cleared memory still living in `b.jsonl` reappears as if the clear never happened. Scenario B (delete): `memoryDelete` writes `{deleted:id}` only to THIS device's shard (line 1313) while the deleted entry lives in a peer's shard; drop the deleter's shard and the tombstone is gone → the entry resurrects on the next union reload (line 204-210).

**Fix:** Co-locate durability with the data: persist clearEpoch and the tombstone set device-locally in userData as a monotonic floor that never resets to 0 on reload, and have every device re-emit the union of tombstones/clear-epoch it has ever observed into its OWN shard (or a dedicated always-present `_deletes.jsonl`) so deletion records replicate independently of the originating shard's survival.

**Why it matters:** 'Deleted'/'cleared' is the strongest promise a memory store makes. Here deletion durability is only as good as the single shard that happens to hold the tombstone/epoch, which is a different file from the data it suppresses. Ordinary sync lag, a removed/replaced device, or a fresh device joining mid-propagation silently resurfaces content the user explicitly purged — the store lies about what was forgotten.

---

### 11. Encryption salt is created non-atomically per device — same passphrase yields different keys, and each device then silently drops the other's shards from recall as 'locked'
**Severity:** high  |  **Area:** sync  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:1433

**Failure (your test spec):** `loadOrCreateSalt` (lines 1433-1443) reads the shared `<syncDir>/.termpolis-salt`, and if it is missing/short simply creates a NEW random salt and writes it. `setSyncPassphrase` derives the key from `deriveKey(passphrase, loadOrCreateSalt())` (line 1478). Scenario: user enables encryption on Device A and (before `.termpolis-salt` has propagated, or while offline) enables it on Device B with the SAME passphrase. A creates saltA, encrypts `a.jsonl` under keyA=derive(pw,saltA). B creates saltB, overwrites `.termpolis-salt` with saltB, encrypts `b.jsonl` under keyB=derive(pw,saltB). The derived keys are cached device-locally (never synced), so A keeps keyA and B keeps keyB permanently. Now on reload each device reads the peer's ciphertext, `decryptLine` returns null, and `parseShardLine` sets `lockedShards = true` and skips the line (line 165). Result: with the correct shared passphrase, A can never read B's memories and vice-versa — half the brain is silently omitted from every recall, and `getSyncStatus().locked` just shows true with no explanation. (Secondary: `.termpolis-salt` is a dotfile and not a `.jsonl`; if the user's sync tool ignores dotfiles, cross-device decryption is broken by construction.)

**Fix:** Make the salt write-once and authoritative: create it with exclusive-create (`fs.writeFileSync(p, s, { flag: 'wx' })`) and, on EEXIST, re-read the winner rather than overwriting. If this device already holds ciphertext under a salt that differs from the shared one, surface an explicit conflict instead of silently locking peers out. Store the salt under a synced (non-dot) name or embed it in a shard control line so propagation is guaranteed.

**Why it matters:** Two devices, one passphrase, and the store silently returns only a fraction of memories on each — the agent is misled about what it knows, and the user has no signal that a salt race (not a wrong passphrase) caused it. Encryption, an opt-in trust feature, becomes a silent partial-data-loss feature.

---

### 12. memory_anticipate fetches only `limit` semantic hits THEN filters to procedural/high-importance, so it returns an empty 'nothing known' whenever a stored lesson sits just below the fetch cutoff — defeating the anti-re-derivation tool
**Severity:** medium  |  **Area:** contract  |  **Where:** src/main/index.ts:1872

**Failure (your test spec):** 1) The fleet earlier stored a procedural lesson 'Fix ELIFECYCLE on build by clearing node_modules/.cache' (memoryType:'procedural'). 2) Agent hits the error and calls memory_anticipate{task:'npm run build fails with ELIFECYCLE'}. 3) proactiveQuery extracts signals; memoryAnticipate calls memorySearch{query, limit: 5} (index.ts:1872) with diversify undefined → the plain top-5 by rank. Because the corpus also has many episodic transcript chunks mentioning 'build'/'ELIFECYCLE' that out-score the lone lesson on raw cosine+recency, the procedural lesson lands at rank 6. 4) Line 1873 filters the 5 fetched hits to memoryType==='procedural' || importance>=0.6; none of the top-5 qualify → returns []. The tool (whose contract is 'surface solutions the fleet has ALREADY found ... check it first, act second', mcpServer.ts:399-408) tells the agent nothing is known, so it re-derives a fix that already exists.

**Fix:** Over-fetch then filter to limit: memorySearch({ query: q, limit: (opts.limit ?? 5) * 8 }) and slice the procedural/high-importance survivors to opts.limit; or push the memoryType/importance predicate into memorySearch as a filter so ranking happens over the eligible pool. Same fix pattern applies to any 'fetch N then post-filter' handler.

**Why it matters:** This is the one tool explicitly sold as the re-derivation preventer, and its filter-after-fetch order turns a present lesson into a false negative. Worse, agent-written memories can't set importance (no schema field) so only reflection-authored lessons clear the 0.6 bar, making the top-5 window even more likely to exclude them.

---

### 13. memory_pool only pools the most-recent ~200 hot-window entries, which in any actively-ingesting brain are dominated by non-lesson transcript chunks — so it reports little/no cross-agent corroboration that in fact exists
**Severity:** medium  |  **Area:** contract  |  **Where:** src/main/index.ts:1865

**Failure (your test spec):** 1) Over weeks, Claude and Codex each independently stored the lesson 'Always run migrations before seeding' (2-source corroboration). 2) The background indexer ingests transcript chunks every 90s (index.ts:1936-1943), each a kind:'message' entry with memoryType undefined, so the newest 200 inserted entries are almost all ingested messages. 3) Agent calls memory_pool. Handler does memoryList({limit:200}) — newest-first by insertion (swarmMemory.ts:1223-1229) — then .filter(m.memoryType==='semantic'||'procedural') (index.ts:1866). The two old lessons are far older than the 200 newest inserts, so they never enter the list; the filter yields few or zero lessons. 4) poolLessons returns [] or a thin set, so the tool (contract: 'Pool the shared brain's lessons across ALL agents ... the fleet's most-trusted, cross-validated knowledge', mcpServer.ts:388-397) tells the agent the fleet has no corroborated knowledge when it has plenty.

**Fix:** Pool over lessons, not recency: select from the full hot window filtered to memoryType semantic/procedural (e.g., a dedicated iterator or memoryList variant that filters before applying the count cap), then cap. The `limit` should bound the number of LESSONS considered, not the number of raw recent rows scanned.

**Why it matters:** The pool is presented as fleet-wide, cross-validated truth but is actually a keyhole onto the last few hundred inserts — and because ingestion constantly floods that window with messages, the durable distilled lessons are precisely what gets excluded. The agent under-trusts real corroboration.

---

### 14. memory_write 'max 16KB' silently truncates the tail of longer content and returns success — the conclusion of a long decision/architecture note is dropped with no signal
**Severity:** medium  |  **Area:** contract  |  **Where:** src/main/swarmMemory.ts:537

**Failure (your test spec):** 1) Agent writes a 20KB architecture decision whose final paragraph is the actual ruling ('...therefore we will NOT adopt gRPC'). 2) memoryWrite hits line 537-539: content = input.content.slice(0, MAX_CONTENT) with MAX_CONTENT = 16*1024 (line 74). The last ~4KB — including the ruling — is discarded. 3) effectiveHash is computed over the TRUNCATED text (line 546), the truncated entry is stored and returned as a normal success. The tool description only says 'Text content to store (max 16KB)' (mcpServer.ts:269) with no statement that overflow is truncated rather than rejected. 4) Later recall returns the decision's setup without its conclusion; the agent confidently acts on a half-decision, and because the hash is of the truncated text, a corrected full re-write is treated as a DIFFERENT entry (no dedup), leaving both fragments in the store.

**Fix:** Either reject content over MAX_CONTENT with a clear error the agent can react to (chunk-and-link), or return { truncated: true, storedChars, originalChars } so the caller knows. Update the tool description to state the exact overflow behavior. Prefer rejecting so the agent can split the note rather than losing its tail.

**Why it matters:** Silent truncation is silent data loss at the exact boundary where long, high-value reasoning lives, and the agent is told the write succeeded. 'Never silently lose data' is violated for any content over 16KB.

---

### 15. memory_write silently de-dupes by content and throws away the new call's project/tags/taskId, so project-scoped recall silently misses the fact the agent believes it just filed
**Severity:** medium  |  **Area:** contract  |  **Where:** src/main/swarmMemory.ts:547

**Failure (your test spec):** 1) A transcript chunk 'Use pnpm, not npm, in this repo' was ingested earlier with no project (or project='other-repo'). 2) Agent working in C:/repos/foo calls memory_write{content:'Use pnpm, not npm, in this repo', project:'C:/repos/foo', tags:['tooling']}. The MCP handler (index.ts:1769-1777) forwards project verbatim. 3) memoryWrite computes effectiveHash = contentHash(content) (NFC + whitespace-collapsed, case-preserved), sees seenHashes.has(hash) is true, and at line 548-549 returns the pre-existing entry, skipping persist + index + the projectSlug assignment entirely. The agent gets back id/success and assumes the note is now filed under 'foo' with tag 'tooling'. 4) A later memory_search{query:'package manager', project:'C:/repos/foo'} filters pool with e.project === 'foo' (line 882) — the note has project undefined/'other-repo', so it is NOT returned. The current-directory-priority promise in the tool description ('pass your working directory ... so the memory is recalled with current-directory priority', mcpServer.ts:272) silently fails.

**Fix:** On a dedup hit, backfill missing metadata onto the existing entry before returning it: if existing.project is empty set it to projectSlug, union tags, adopt taskId (mirrors memoryPatchProjects). And/or return a { deduped: true, mergedInto: existing.id } flag so the agent knows its write collapsed into another entry rather than being stored as-specified.

**Why it matters:** The write reports success while discarding the very metadata that governs recall scope, and the agent has no way to know its association was dropped. Two agents (or a re-ingest) writing the same sentence race to own its project tag, and whoever loses is invisible under project-scoped search — a silent completeness hole in the product's headline 'current-directory recall'.

---

### 16. 90-second active-session re-ingest deposits a new overlapping duplicate chunk on every turn (unstable trailing chunk)
**Severity:** medium  |  **Area:** dedup  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/conversationIngest.ts:268

**Failure (your test spec):** The fast indexer re-ingests the ACTIVE session every 90s (index.ts:1935 fastIntervalMs=90_000, 1939 freshSinceTs=now-10min). chunkTurns is a single greedy forward pass that flushes a NOT-yet-full trailing buffer at the end (conversationIngest.ts:268 flush()), and makeChunk hashes the chunk TEXT (line 224 `${source}${sessionId}${text}`). Fully-packed chunks are stable across passes (earlier packing never depends on later turns), but the final partial chunk grows as new turns arrive: pass 1 stores partial B1=turns[7..9] (hash HB1); 90s later the user added turn 10, so re-chunking yields B2=turns[7..10] (hash HB2!=HB1) -> hasHash false -> WRITTEN, while B1 stays; next pass B3=turns[7..11]; etc. Each new turn in the fill cycle deposits one more strict-superset chunk while every prior partial lingers. Nothing prunes them: isForgettable requires kind==='message' AND age>=14 days (swarmMemory.ts:388-394), and these partials are brand-new (fresh ts).

**Fix:** Do not persist the trailing not-yet-full chunk on the incremental pass: emit only sealed (full) chunks and carry the tail forward to the next pass, or seal the final partial only when the session file is known complete (session ended). Alternatively delete superseded prefix chunks for a session when a superset chunk is written, or hash on stable turn-id boundaries so a growing tail reuses one identity.

**Why it matters:** The most-recalled context — the live session — becomes the most polluted: memory_search returns a stack of overlapping near-identical copies of the same recent exchange, crowding out diverse hits, and (because ts is ingestion time) they all rank as freshest, compounding the known ts bug. Embeddings/RAM/disk are wasted linearly in turns.

---

### 17. Dedup check is not atomic across the embed await — two concurrent writes of identical content both insert a duplicate
**Severity:** medium  |  **Area:** dedup  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:547

**Failure (your test spec):** memoryWrite checks seenHashes.has(effectiveHash) at line 547, then `await embed(content)` at line 570 (which yields the event loop), then finally entries.push + seenHashes.add at 582-583. Two concurrent writers of the SAME content interleave: both pass the line-547 check (neither has added the hash yet), both await embed, both then insert -> two entries with the same hash in the window and two lines on disk. Reachable in the product's core scenario: two swarm agents call MCP memory_write with the same fact in the same tick (index.ts:1092), or the user clicks 'Ingest conversations' (index.ts:1177) while the 90s fast pass (index.ts:1936) is mid-flight over the active session. The indexer's `running` guard (memoryIndexer.ts:49) only serializes the indexer's own passes — it does not cover these external memoryWrite entry points.

**Fix:** Reserve the hash synchronously before the await: on a line-547 miss, immediately add effectiveHash to seenHashes (or a dedicated in-flight set) so a concurrent writer sees it; re-check after embed and drop if another write already landed the hash. Or serialize memoryWrite through a single-consumer queue.

**Why it matters:** Dedup exists specifically so a multi-agent swarm never stores the same fact twice, and it fails under exactly the concurrency the product is built around. The duplicate crowds search until the next reload; worse, if one copy is later deleted, memoryDelete removes the hash from seenHashes (line 1306) leaving the survivor permanently un-dedupable.

---

### 18. Entries written while the embedder is down are never back-filled, and content-hash dedup blocks any refresh — they stay permanently excluded from semantic (vector) recall
**Severity:** medium  |  **Area:** embedding  |  **Where:** src/main/swarmMemory.ts:547

**Failure (your test spec):** There is no re-embed/backfill pass anywhere (verified by grep across src/main). Once the embedder has been down (dev without the model, a broken install, or after either latch finding above), the store permanently contains vector-less entries that never recover: (1) During a down-window, `memoryWrite` computes `embed()` → null (best-effort, swarmMemory.ts:568-572), so the entry is persisted to disk and pushed to the hot window with NO embedding and is never added to the packed vectorStore. (2) The embedder later recovers (relaunch, model finishes downloading, transient error clears). (3) The same content is written again — extremely common: agents re-state facts, and the auto-indexer re-ingests overlapping transcripts every launch. `memoryWrite`'s dedup returns the EXISTING vector-less entry before the embed block (lines 547-550: `if (seenHashes.has(effectiveHash)) { ... return existing }`), so it is never embedded. (4) In `memorySearch`, with a healthy 384-dim query, the packed path scores only embedded entries; the legacy loop skips entries with no `.embedding` (line 932); and the keyword safety-net only runs `if (scored.length === 0)` (line 937), which is false whenever any embedded entry matched. So the vector-less entries can surface ONLY via the BM25 lexical fusion (exact-token overlap, line 949+) — never via semantic similarity. A paraphrased query can never retrieve them.

**Fix:** Add an idempotent backfill: on the dedup hit, if the existing entry lacks a packed vector and the embedder is now available, compute and index its embedding before returning (swarmMemory.ts:547-550). Additionally, run a bounded background pass on launch that embeds any hot-window entry lacking a vector once `isEmbedderReady()` is true.

**Why it matters:** The store silently and permanently splits into first-class (semantically recallable) and second-class (keyword-only) memories with no reconciliation. A fact captured during a model outage is invisible to exactly the paraphrase/semantic queries that RAG exists to serve, and dedup guarantees it can never be upgraded. This is a durable, on-disk, cross-session degradation of stored-memory quality — the same solidity class as the confirmed ts bug.

---

### 19. Project slug is basename-only, so distinct repos with the same folder name share one scope (cross-project recall leak)
**Severity:** medium  |  **Area:** project  |  **Where:** src/main/swarmMemory.ts:53

**Failure (your test spec):** normalizeProjectSlug keeps only the last path segment: `const base = pathOrName.trim().replace(/[\\/]+$/,'').split(/[\\/]/).pop() || ''` then lowercases it (line 54). The project filter is strict equality on that slug — passesFilter: `if (opts.project && e.project !== opts.project) return false` (line 788) and the pool filter `pool = pool.filter(e => e.project === opts.project)` (line 882). Step by step: (1) User has two unrelated repos `~/work/acme/api` and `~/work/globex/api` (a shared basename like `api`/`app`/`web`/`server`/`frontend`/`src` is extremely common, and git worktrees / a repo cloned twice produce identical basenames too). (2) While in globex/api an agent stores `memory_write` with project derived from cwd → slug `api`, content 'Globex api authenticates with header X-Globex-Key'. It persists with `project:'api'` (swarmMemory.ts:561). (3) Later, in acme/api, memory_primer/memory_search runs with project from cwd → also `api`. (4) passesFilter sees `e.project('api') === opts.project('api')` → the Globex secret is returned as an acme/api memory and injected under the current-project header. The agent now believes acme/api uses X-Globex-Key.

**Fix:** Key project identity by something stable and unique, not the bare basename: prefer the git repo identity (remote URL, or `rev-parse --show-toplevel` path hash) when available; otherwise incorporate a disambiguating parent segment or a hash of the full normalized path. Store both the display slug and the full-path/repo key, and filter on the unique key so `.../acme/api` and `.../globex/api` never collide.

**Why it matters:** This is the exact 'silently lie to the recalling agent' failure class: the core value prop is current-directory recall, and basename collapse makes it hand one project's decisions/facts/secrets to a different project with the same folder name. On Windows/macOS (case-insensitive) the lowercase fold is fine, but the basename collapse leaks regardless of OS. It is silent — no error, just wrong context.

---

### 20. Gemini transcripts carry no cwd, so every Gemini-sourced memory is permanently project-unscoped and un-backfillable
**Severity:** medium  |  **Area:** project  |  **Where:** src/main/conversationIngest.ts:206

**Failure (your test spec):** parseClaudeTranscript and parseCodexRollout attach `cwd` to each turn (lines 109/113 and 167), but parseGeminiSession pushes turns WITHOUT any cwd: `turns.push({ role, text, ts: parseTs(...), source: 'gemini', sessionId })` (line 206) — it never reads a directory. makeChunk then sets `const cwd = turns[0].cwd` (line 220) → undefined. On write, project is only added `...(chunk.cwd && { project: chunk.cwd })` (line 499) → omitted, and the backfill push is guarded `if (chunk.cwd)` (line 360) → never happens. Step by step: (1) User runs Gemini CLI in project `foo`; Termpolis ingests `~/.gemini/tmp/<proj>/chats/session-*.json`. (2) All resulting memories have no `project`. (3) In project `foo`, a project-scoped search (`e.project === 'foo'`) excludes them because `undefined !== 'foo'` (swarmMemory.ts:788). (4) They surface only in global recall, and in the primer can only reach the 'This project' bucket via the buggy substring promotion (F2) — never by correct tagging.

**Fix:** Derive cwd for Gemini from the on-disk path — the layout `~/.gemini/tmp/<proj>/chats/session-*.json` encodes the project dir — and thread it into each IngestTurn (and any cwd field present in the session JSON). Pass it through makeChunk so Gemini chunks get a project like the other sources.

**Why it matters:** A whole first-class source is silently second-class for the flagship current-directory recall feature: the agent working in a Gemini-heavy project gets a primer that omits that project's own Gemini history, with no indication anything is missing.

---

### 21. Primer promotes any global memory whose CONTENT merely contains the slug substring into the 'This project' bucket
**Severity:** medium  |  **Area:** project  |  **Where:** src/main/contextPrimer.ts:142

**Failure (your test spec):** In the project branch, every global hit is bucketed by: `if (h.project === project || (h.content || '').toLowerCase().includes(project)) promoted.push(h)` (line 142), and promoted hits are rendered under `This project (${project}) — past conversations first:` (line 164). The `includes(project)` arm is a raw substring test on user content with no word boundary and no minimum length. Step by step: (1) User launches Termpolis in `~/repos/app`; memory_primer fires with project=`app` (index.ts:1815) and a global search runs (contextPrimer.ts:122). (2) A memory from a totally different project — content 'Refactored the mapping layer; the webhook must append the signature' — is in globalHits. 'mapping' and 'append' both contain the substring 'app'. (3) Line 142 promotes it; line 164 renders it under 'This project (app) — past conversations first:'. (4) The agent is told this unrelated memory is current-project context. For common short slugs (`app`,`api`,`web`,`go`,`ui`,`db`,`os`,`qa`) a large fraction of the whole store is falsely promoted (e.g. slug `go` matches 'going','category','logo','algorithm').

**Fix:** Drop the substring arm. Promote only on an exact tag match (`h.project === project`). If a content-based fallback is kept for legacy untagged entries, require a word-boundary regex AND a minimum slug length (e.g. >= 4 chars) AND ideally that the hit already cleared the relevance gate — never a bare `.includes()`.

**Why it matters:** It actively mislabels other projects' memories as belonging to the current project — the strongest form of misleading recall, because the header explicitly asserts project relevance and the primer is the default launch-seeding path. The shorter/commoner the directory name, the worse the contamination.

---

### 22. Delete-by-id leaves the content-hash twin alive, so a deleted memory resurfaces via dedup
**Severity:** medium  |  **Area:** sync  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:1312

**Failure (your test spec):** `memoryDelete` tombstones by ID only (`tombstones.add(id)`, `{deleted:id}`, lines 1312-1313), while reload de-duplicates by content-hash keeping one surviving id (line 207). Scenario: the same fact is written independently on Device A and Device B (identical content → identical `contentHash`, but different ids id_A/id_B). In the union reload, `adds` is sorted oldest-first (line 201) and the first-seen id wins while the second is skipped as a hash dup (line 207) — but the skipped one is NOT tombstoned. The user deletes the visible copy (say id_A). On the next `reloadFrom`, id_A is tombstoned and dropped, so id_B (same content, never tombstoned) is now the surviving copy and reappears in search/list. The 'deleted' memory is back verbatim. The same happens single-device for any content that was ever de-duplicated.

**Fix:** Delete by content identity as well: when tombstoning an id, also tombstone its content hash (emit `{deletedHash:hash}`) and have `reloadFrom` drop any entry whose hash is tombstoned; or resolve a delete to every in-window entry sharing the target's hash and tombstone all their ids.

**Why it matters:** Deletion must remove the information, not one row that happens to hold it. Because dedup is content-addressed but deletion is id-addressed, deleting de-duplicated content silently fails and the agent keeps recalling material the user believed purged.

---

### 23. Clear scope is defined by wall-clock ts across devices, so ordinary clock skew makes 'clear all' both under-delete (stale survives) and over-delete (fresh writes vanish)
**Severity:** medium  |  **Area:** sync  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:206

**Failure (your test spec):** Every entry is stamped with the writing device's wall clock (`ts: input.ts ?? Date.now()`, line 554) and clear compares those cross-device timestamps against one device's `Date.now()` (clearEpoch, line 1252; filter line 206). UNDER-DELETE: Desktop clock runs 15 min fast; it wrote memories now stamped ts=T+15min. On the laptop the user runs 'clear all memory' → clearEpoch = laptop-now = T. When the desktop's shard syncs in, its entries have ts=T+15min > T, so they SURVIVE the clear (line 206) and resurface — the user believes the brain was wiped but stale desktop memories keep getting recalled. OVER-DELETE: Conversely, a laptop whose clock is 1 hour BEHIND a desktop that just issued a clear (clearEpoch = desktop-now). Every memory the laptop writes for the next hour gets ts < clearEpoch, so on the next 30-min `reloadMemoryFromSync` (index.ts:1903) each freshly-written memory is silently swallowed by the epoch filter — the laptop's brain refuses to retain anything the user saves for an hour, with no error.

**Fix:** Do not scope deletion by comparing wall-clock timestamps across devices. Either capture the concrete set of live entry ids at clear time into tombstones (deletion by identity, not by time), or adopt a hybrid logical clock (HLC) for both entry ts and the clear epoch so ordering is causal and skew-independent.

**Why it matters:** Clock skew of minutes-to-hours between a laptop and desktop is completely normal. It makes the core 'clear' operation neither complete (stale content leaks back) nor safe (new content disappears), both silently. The agent recalling memory is misled in both directions on the very operation meant to give the user deterministic control over the store.

---

### 24. memory_primer is headed 'most relevant first' but reorders conversation chunks ahead of higher-relevance decisions/facts and strips all timestamps — the leading item is neither most-relevant nor dated, so the agent can't tell an old chat from a current one
**Severity:** low  |  **Area:** contract  |  **Where:** src/main/contextPrimer.ts:149

**Failure (your test spec):** 1) For project 'foo', the gate yields a high-relevance decision D (score 0.82) and a low-relevance stale conversation chunk C (score 0.31, an old 'let's try X' musing that was abandoned). 2) buildContextPrimer's project bucket sort (lines 147-149) pushes all isConversation hits to the top regardless of score, so C is emitted BEFORE D. 3) The digest is wrapped with the header 'Relevant context from your memory (most relevant first)' (line 173), and renderLine (lines 82-93) emits '- [claude] <snippet>' with NO date/timestamp. 4) The agent, told the first line is the most relevant context, over-weights an abandoned idea and cannot distinguish a year-old conversation from yesterday's — there is no recency signal anywhere in the primer, even though each underlying entry has a ts.

**Fix:** Either change the header to match reality ('past conversations first, then most relevant') or drop the conversation-first reorder and sort purely by score. Add a compact relative-age marker to renderLine (e.g., '[claude · 8mo ago]') using the entry ts so the agent can weigh recency, and surface a 'superseded' marker for entries with a superseded-by edge.

**Why it matters:** The primer is the first thing the agent 'holds' about a project. Labeling a conversation-first, recency-blind ordering as 'most relevant first' is a direct recency/relevance mislead, and without any date the agent cannot apply its own judgment about staleness. Combines with the superseded-not-filtered gap to make stale context lead the session.

---

### 25. contentHash collapses all whitespace, so whitespace-significant content (e.g. Python) false-dedups and the second write is silently lost
**Severity:** low  |  **Area:** dedup  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:527

**Failure (your test spec):** contentHash normalizes with `.replace(/\s+/g, ' ').trim()` (line 527), collapsing every run of spaces/tabs/newlines to one space. An agent stores snippet A via memory_write: `def f():\n    return risky()` then snippet B `def f():\n        return risky()` (deeper indentation -> different nesting/behavior). Both normalize to `def f(): return risky()` -> identical hash -> B hits seenHashes and returns A (line 549); B is never stored. Same for YAML, diffs, Markdown code fences, or ASCII tables where whitespace is semantic.

**Fix:** Do not collapse newlines/indentation in the identity hash. Normalize only Unicode form plus trailing whitespace (e.g. NFC + per-line right-trim), or hash the raw content. Keep whitespace-collapse as a separate near-duplicate SIGNAL, never as the identity key.

**Why it matters:** Memory silently loses genuinely distinct content and hands back the wrong version — the 'never silently lie' guarantee is broken for any content where whitespace carries meaning, which for a developer tool is common.

---

### 26. Appends are never fsync'd — memory_write acknowledges data that a power loss then discards
**Severity:** low  |  **Area:** durability  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:632

**Failure (your test spec):** appendShardLine relies solely on `fs.appendFileSync(...)` (632), which opens/writes/closes but performs NO fsync/fdatasync — the bytes land in the OS page cache and are flushed lazily. memoryWrite returns success the instant appendFileSync returns. If the machine loses power (or the OS crashes / battery dies) within the flush window, the most recently 'saved' memories — potentially the entire last burst written by the 90s/30-min ingest passes or a series of manual memory_write calls — are gone even though every call reported success and no error was recorded anywhere. Because the id/hash was already admitted to seenHashes in RAM, nothing re-drives those specific writes either.

**Fix:** For high-value writes (decision/fact/result and control lines), open the shard with an explicit fd, appendFileSync, then fs.fsyncSync(fd) before returning success (batch/debounce the fsync for bulk message-chunk ingest to bound cost). Combine with the frame-repair fix (finding #3) so a crash costs at most the un-fsync'd tail and never a subsequent entry.

**Why it matters:** The store's durability contract is 'append-only, retains everything written,' but without fsync a write is acknowledged before it is durable, so a crash silently rolls back confirmed memories. For a product whose thesis is never silently losing data, acknowledged-but-not-durable is a real gap.

---

### 27. A crash mid-append leaves an unterminated line that silently swallows the NEXT good write (no JSONL frame repair on init)
**Severity:** low  |  **Area:** durability  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:632

**Failure (your test spec):** Lines are framed by a trailing '\n' appended AFTER the payload: `fs.appendFileSync(memPath, (encKey ? encryptLine(encKey, raw) : raw) + '\n')` (632). Entries can be ~24 KB (up to 16 KB content + a serialized 384-float embedding), so a write spans several filesystem pages. If the process is SIGKILLed / force-quit / OOM-killed / loses power partway through the append (writeFileSync loops over multiple write() syscalls), the shard ends with a truncated line and NO newline, e.g. `...{"id":"mem-A","content":"foo`. On relaunch reloadFrom does `raw.split('\n')` (199) and parseShardLine JSON.parses each; the truncated tail fails and is skipped (169) — fine so far. But memPath is now set to that file, and the NEXT memoryWrite appends at EOF (O_APPEND): the bytes become `...foo{"id":"mem-B",...}\n`, i.e. mem-B is now on the SAME physical line as the truncated mem-A. On the following reload, split('\n') yields one line `...foo{"id":"mem-B",...}` which fails JSON.parse and is skipped — so mem-B (a perfectly good, fully-written memory) is silently lost too. init never checks/repairs the trailing-newline frame (local branch 270-271, sync seed 257-263 via copyFileSync preserve whatever framing exists).

**Fix:** Guarantee frame integrity on open: in initSwarmMemory, if the shard is non-empty and its last byte is not '\n', append a single '\n' (or truncate the trailing partial line) before any new append. Cheaper alternative: have appendShardLine stat/seek and write a leading '\n' when the file doesn't already end in one. This makes a torn tail cost at most the torn entry, never a subsequent one.

**Why it matters:** The 'killed mid-write' case the audit calls out doesn't just lose the torn entry — it corrupts the frame so that the first healthy write after recovery is also destroyed, and both losses are completely silent. Append-only durability is the store's whole safety story, and unguarded line framing quietly breaks it.

---

### 28. Corrupt/undecryptable JSONL lines are skipped silently with no count or telemetry — partial shard corruption deletes memories invisibly
**Severity:** low  |  **Area:** durability  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:169

**Failure (your test spec):** parseShardLine does `try { obj = JSON.parse(plain) } catch { return /* skip malformed line */ }` (169) with no counter and no telemetry, and reloadFrom (188-228) never tallies how many lines failed. Scenario: a shard file is partially corrupted — a bad three-way sync/merge of <deviceId>.jsonl, disk bit-rot, an editor that re-saved with a different encoding/BOM, or the torn-line merge from finding #3 — mangling, say, 5,000 of 200,000 lines. On next launch those 5,000 memories simply don't load. memoryStats()/getSyncStatus().count report the lower number as if that were the truth; nothing logs that anything was dropped. The user has no way to know their brain quietly shrank, and no signal to restore from a backup before the good copy is overwritten by the next rewrite.

**Fix:** Count parse failures (and encrypted-but-undecryptable lines separately) in reloadFrom; when the count is non-zero, recordSwarmError with the file and tally, and expose a `corruptLinesSkipped` field on getSyncStatus()/memoryStats() so the UI can warn. Consider quarantining the corrupt shard (copy to .corrupt) before any subsequent rewrite so the raw bytes remain recoverable.

**Why it matters:** Silent, uncounted skipping of unparseable lines means on-disk corruption is indistinguishable from 'nothing was there,' defeating any chance of detection or recovery — the exact 'swallow and continue' pattern flagged as a solidity failure.

---

### 29. No dimension contract between the embedder output and EMBED_DIM (MAX_EMBEDDING_DIM=1024 ≠ EMBED_DIM=384) — a model/dim change silently drops vectors to the slow path or makes the packed store unsearchable
**Severity:** low  |  **Area:** embedding  |  **Where:** src/main/swarmMemory.ts:1543

**Failure (your test spec):** The embed accept-gate and the index/search gates use DIFFERENT dimensions and there is no assertion that the model actually outputs EMBED_DIM. `embed()` accepts any vector with `length <= MAX_EMBEDDING_DIM` (1024) (swarmMemory.ts:1534, 1543), but `indexEntryVector` only packs vectors with `length === EMBED_DIM` (384) and silently drops everything else to the per-object 'legacy' path (line 649: `if (... entry.embedding.length !== EMBED_DIM) return`), and both search fast-paths are gated on `queryEmb.length === EMBED_DIM` (lines 894, 1190). Meanwhile `loadDefaultBackend` trusts whatever hidden size the ONNX file reports — `const H = hidden.dims[hidden.dims.length - 1]` (localEmbedder.ts:215-216) with no check against EMBED_DIM. Scenario: a release accidentally bundles bge-BASE (768-dim) instead of bge-small, or a future version bumps the model. (1) `embed()` now returns 768-dim vectors (768 <= 1024, so accepted; embeddingsAvailable=true — looks healthy). (2) New writes fail the `=== 384` check, so nothing is ever added to the packed vectorStore and the number[] is never freed (RAM regression). (3) Queries are 768-dim, so `queryEmb.length === EMBED_DIM` is false and the entire packed fast-path is skipped; any pre-existing 384-dim packed vectors become unreachable (query dim never matches). No error is raised at any step. Recall silently collapses onto the legacy per-object scan / BM25.

**Fix:** Assert the contract: in `loadDefaultBackend`, verify the first forward pass yields H === EMBED_DIM and treat a mismatch as a hard load failure (markFailed + telemetry); set MAX_EMBEDDING_DIM = EMBED_DIM (or make embed() reject `length !== EMBED_DIM`) so a non-conforming vector can never be accepted; and stamp the store/HNSW fingerprint with the model dim so a dimension change invalidates the index instead of silently mixing dims.

**Why it matters:** The packed vector store is the primary semantic index, and its correctness silently depends on an un-asserted equality between a hardcoded constant and the model's real output dimension. A wrong bundled model or a dim change produces no error, no telemetry, and a quietly broken index — the classic 'dim mismatch' robustness failure, made worse because the two dimension constants openly disagree so the mismatch is not even caught at the accept-gate.

---

### 30. Legacy project backfill is wired only to the manual button, not the auto-indexer, and is in-memory-only (docstring is wrong)
**Severity:** low  |  **Area:** project  |  **Where:** src/main/swarmMemory.ts:399

**Failure (your test spec):** memoryPatchProjects' docstring claims (lines 399-401) 'the auto-indexer re-runs ingest every launch, so the tags re-derive for free each session.' But the automatic indexer calls runConversationIngest WITHOUT patchProjects — `run` at index.ts:1904-1907 and `fastRun` at index.ts:1937-1940 pass `{ hasHash, write, link }` only. The ONLY caller that passes `patchProjects: memoryPatchProjects` is the manual IPC `memory:ingest-conversations` (index.ts:1179), which fires solely from a user click (Memory.tsx:252). Moreover the patch mutates live objects in RAM only — `e.project = slug` (line 412) is never persisted, and reloadFrom rebuilds `entries` purely from JSONL (line 188-211), which never contains a backfilled project. Step by step: (1) User upgrades from a pre-`project` build; their existing transcript chunks have no project. (2) On every launch the auto-indexer re-scans transcripts, sees the chunks already stored (hasHash true), but with no patchProjects callback the skipped-chunk cwd is discarded (conversationIngest.ts:337-338 no-op). (3) Those legacy entries stay project-less forever, invisible to project-scoped primer/search. (4) Even if the user clicks 'Ingest conversations' once, the tags are RAM-only and vanish on the next launch/sync reload.

**Fix:** Pass `patchProjects: memoryPatchProjects` in the auto-indexer's `run` (and `fastRun`) at index.ts:1904/1937, so backfill actually re-derives each pass as the comment promises. To survive reload, persist backfilled project as an additive control line (like the reinforce/tombstone deltas) applied in reloadFrom, or re-tag on write. Fix the docstring to match reality.

**Why it matters:** Current-directory recall silently fails for the entire pre-feature backlog (and after any sync reload), so the agent's project-scoped primer omits real history for the project it is standing in — a silent recall gap presented as complete. The reassuring code comment masks it.

---

### 31. Curated agent memory_write defaults to unscoped: project is only set if the model remembers to pass it, so high-value decisions miss project recall
**Severity:** low  |  **Area:** project  |  **Where:** src/main/mcpServer.ts:482

**Failure (your test spec):** The MCP memory_write handler forwards `project: args.project` verbatim (mcpServer.ts:482) and the IPC memory_write passes `project: input.project` (index.ts:1777) — there is no fallback to the calling terminal's cwd. The schema only *asks* the model to 'pass your working directory' (mcpServer.ts:272). Ingested transcript chunks DO get a cwd-derived project (conversationIngest.ts:499), but agent-authored decisions/facts/notes do not unless the model opts in every call. Step by step: (1) In project `foo`, the agent calls memory_write kind='decision' content='We chose Postgres over SQLite for foo' and omits `project` (common — it's optional). (2) It stores with no project (swarmMemory.ts:536,561 skip it). (3) On the next launch in `foo`, memory_primer scopes to `foo`; the strict filter excludes the decision (undefined !== 'foo'). (4) The decision is relegated to the 'Other saved context (may NOT apply to this project)' bucket (contextPrimer.ts:167) — i.e. the project's own decision is labeled as possibly-not-its.

**Fix:** At the server/IPC boundary, default `project` from the calling terminal's cwd when the agent omits it (the app already knows the terminal's directory). Keep the explicit arg as an override. This makes curated writes scoped-by-default and consistent with ingested chunks.

**Why it matters:** Scoping is inverted: low-value bulk transcript chunks are reliably project-tagged while the highest-value curated knowledge usually isn't, so project-scoped recall systematically under-serves and even mislabels the very memories it exists to resurface.

---

### 32. cwd is captured first-wins per transcript and applied to all chunks, mis-tagging sessions that span directories
**Severity:** low  |  **Area:** project  |  **Where:** src/main/conversationIngest.ts:220

**Failure (your test spec):** Claude parsing latches the first cwd and never updates it: `if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd` (line 95); Codex takes cwd only from the one session_meta payload (line 146). makeChunk then stamps ALL chunks of the transcript with `turns[0].cwd` (line 220), discarding any later, differing cwd. Step by step: (1) A session's transcript records work first under `~/repos/foo` and later under `~/repos/bar` (resumed elsewhere, `/add-dir`, or a tool that changes the recorded cwd). (2) Every chunk — including the bar work — is tagged project=`foo`. (3) Recall in `bar` (project=`bar`) misses that work entirely, while recall in `foo` surfaces bar's memories as foo's. Related fragility: a Codex rollout read mid-write before its session_meta line is flushed yields cwd=undefined for the whole file, leaving those memories unscoped like the Gemini case.

**Fix:** Preserve per-turn cwd (already present on IngestTurn) and split chunks on cwd change so each chunk carries the cwd of its own turns; have makeChunk use the chunk's turns rather than always turns[0]. For Codex, fall back to the file path or a later cwd if session_meta is absent.

**Why it matters:** A single collapsed cwd both loses recall for the true project and leaks it into the first one — the same misattribution pattern as the ts-at-ingestion bug, but on the project axis. It corrupts scoping precisely for the power-user sessions that move between repos.

---

### 33. Full-shard rewrites (passphrase set/disable, sync-off snapshot, local clear) are non-atomic — a crash or a mid-write sync read truncates the entire shard
**Severity:** low  |  **Area:** sync  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:1468

**Failure (your test spec):** Several paths rewrite the whole shard/store in place with a bare `fs.writeFileSync` (no temp-file + atomic rename): `rewriteSelfShard` (line 1468, used by `setSyncPassphrase` and `disableSyncEncryption` to re-encrypt/decrypt the ENTIRE shard), the sync-off snapshot `fs.writeFileSync(legacyPath, snap...)` (line 1514), and local `memoryClear` truncation (line 1255). Scenario: user enables encryption on a large brain; `setSyncPassphrase` calls `rewriteSelfShard` which reads the full shard, encrypts every line, and writes it back in one `writeFileSync`. If the app is killed / OS crashes / power fails partway, or a cloud-sync agent reads the file mid-write, the shard is left truncated — every entry after the cut point is permanently lost, and a partial file may even be propagated to peers as the authoritative shard. The whole brain is the payload of a single non-atomic write.

**Fix:** Write every full-file rewrite atomically: write to a temp file in the same directory, fsync, then `fs.renameSync(tmp, target)` (atomic replace). Apply to rewriteSelfShard, the setSyncDir snapshot, and the local memoryClear truncation.

**Why it matters:** The durable JSONL is the source of truth; rewriting it non-atomically means a routine operation (toggling encryption, turning sync off) can lose the bulk of the store to an ill-timed crash or a concurrent sync read, and can publish a truncated shard to other devices.

---

### 34. A sync reload during a background HNSW build swaps the vector store under the build, which then marks itself fresh and persists a mis-wired graph → silently wrong search rankings
**Severity:** low  |  **Area:** sync  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:660

**Failure (your test spec):** For a large store (>= hnswThreshold, default 50k), a search kicks a background HNSW build (`ensureHnsw`, lines 704-733) whose insert loop reads vectors via a closure `(r) => vectorStore.get(r)` over the MODULE-level `vectorStore` and iterates a snapshot of old rows. The 30-min `reloadMemoryFromSync` timer (index.ts:1903) — or any peer-driven reload — calls `reloadFrom` → `rebuildVectorIndex`, which REPLACES `vectorStore = new VectorStore(...)` and clears/repopulates `rowToEntry` (lines 660-667), but does NOT reset `hnswBuilding` or cancel the in-flight build. The still-running build now reads NEW-store vectors at OLD row indices (both are 0-based, so `rowToEntry.has(row)` is often true but points at a different entry), wiring neighbours from mismatched vectors. On completion, `if (rowToEntry.size === rows.length)` can be true after a same-sized reload, so it sets `hnswStale = false` and PERSISTS this corrupt graph (line 727) under the new entries' fingerprint. Subsequent searches use it (and reload it next launch), returning semantically wrong nearest-neighbours with no error.

**Fix:** Guard the build with a generation token: increment a `buildGen` in `reloadFrom`/`rebuildVectorIndex`, capture it at build start, and have the async loop abort (and skip the freshness/persist step) if `buildGen` changed. Equivalently, have `reloadFrom` invalidate the in-flight build (set a cancelled flag the loop checks each iteration) so a graph built against a replaced store can never mark itself fresh or persist.

**Why it matters:** Sync reloads are frequent (timer + peer merges) and large stores are the design target (500k window). A reload landing during a build silently produces and persists a graph that mis-ranks recall — the agent gets confidently wrong 'most relevant' memories, the hardest failure to notice.

---

### 35. deviceId is per-machine-file, not per-install — a restored backup / cloned disk / imaged VM makes two machines write the SAME shard file concurrently, breaking the single-writer invariant the whole CRDT relies on
**Severity:** low  |  **Area:** sync  |  **Where:** C:/Users/DavidEngelhart/repos/termpolis/src/main/swarmMemory.ts:128

**Failure (your test spec):** deviceId is read from `<userData>/device-id` and only generated when that file is absent (loadOrCreateDeviceId, lines 128-137); the shard path is `<syncDir>/<deviceId>.jsonl` (line 254). The single-instance lock (index.ts:1645) only prevents two processes on ONE machine. Scenario: user restores their laptop from a full backup image onto a new machine (or clones a VM template, or the old laptop keeps running after a migration) — both machines now carry the identical `device-id` file. Both point at the same Dropbox/Syncthing sync folder. Both compute the same memPath `<syncDir>/abc123.jsonl` and both `fs.appendFileSync` to it (line 632). Two independent OS processes appending multi-KB JSON lines (entries carry 384-float embeddings) to one file give no atomicity guarantee (esp. on Windows / over a cloud-sync FS), so lines interleave into a corrupt half-line; `parseShardLine` then hits `JSON.parse` failure and silently `return`s (line 169), dropping BOTH entries. Additionally the cloud tool sees two writers mutating one file and generates conflicted copies, and `rewriteSelfShard`/`copyFileSync` (encryption toggle, migration) can wholesale clobber the other machine's just-appended data.

**Fix:** Key the shard on a per-INSTALL identity that cannot ride along in a backup: generate deviceId lazily AND detect collisions — e.g. on startup acquire an OS lock on `<syncDir>/<deviceId>.jsonl` (proper-lockfile); if another live writer holds it, mint a fresh random id and migrate. Alternatively bind deviceId to a machine fingerprint and regenerate when it no longer matches (restored image), so a clone never inherits the writer identity.

**Why it matters:** The entire merge model is documented as safe because of 'single-writer-per-file' (lines 116-121). deviceId keyed to a backed-up/cloned file silently violates that invariant, converting the append-only log into a concurrently-mutated file with interleaved-write corruption and lost entries — exactly the 'reset/reinstall/restore' path the store must survive.

---


## Wave 2 — unverified backlog (verify, then fix)
The audit produced ~89 raw findings; the 35 above are adversarially confirmed. The rest had their verification cut off by the usage limit. Recover them from the per-agent journal:
`C:\Users\DavidEngelhart\.claude\projects\C--Users-DavidEngelhart\5e3b601e-65c5-41ac-bf8f-3f8e2c56b0e5\subagents\workflows\wf_1f26f8f2-597\journal.jsonl`
(one JSON result line per agent; audit-phase agents carry a `findings[]` array in their result). For each: read the cited code, confirm it is real and reachable, then fix it TDD like the rest. Fold every real one into v1.19.4.
Optional: re-run the audit verify+synth via `Workflow({scriptPath:'C:\Users\DavidEngelhart\.claude\projects\C--Users-DavidEngelhart\5e3b601e-65c5-41ac-bf8f-3f8e2c56b0e5\workflows\scripts\memory-hardening-audit-wf_1f26f8f2-597.js', resumeFromRunId:'wf_1f26f8f2-597'})` once tokens reset — completed agents replay from cache, only the throttled ones re-run.

## Memory subsystem file map
- `swarmMemory.ts` — the store: write / list / search, dedup, eviction, sync shards, clear + tombstones, ranking. NOTE: legacy filename — this IS the whole memory brain, not the "swarm" feature; on-disk store is `swarm-memory.jsonl`.
- `conversationIngest.ts` — transcript parse + chunk + ingest
- `codeIngest.ts` — code indexing
- `transcriptWatchers/{claudeCode,codex,gemini}Watcher.ts` — file watchers
- `localEmbedder.ts` / `embedWorker.ts` — embedding (worker thread + graceful fallback)
- `vectorStore.ts` / `hnswIndex.ts` / `lexicalIndex.ts` — retrieval
- `mneme{Retrieval,Consolidate,Reflect,Society,Curiosity,Meta,Episode}.ts` — the learning loop
- `memoryGraph.ts` — knowledge graph
- `contextPrimer.ts` — session primer
- `mcpServer.ts` — the memory_* MCP tool surface
- `index.ts` — wiring (primer / recall / inject, ~1099-1230)

---
_Generated from the memory-hardening adversarial audit (35 confirmed findings). Companion data: `memory-audit-confirmed.json`. Ships in v1.19.4._