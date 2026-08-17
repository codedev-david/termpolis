# v1.36.0 Compression Spec — Advanced Token Compression

> Workstream spec for the compression half of v1.36.0. Baseline v1.35.1. Branch: `main` direct, no PRs.
> Coverage gate: lines 97 / fn 96 / branches 95 / stmts 96 (`vitest.config.ts:106-109`) — never lower.
> Product goal, verbatim: get as close to the provider boundary for token efficiency as possible
> WITHOUT breaking provider rules, and WITHOUT sacrificing memory/recall quality.
> Two hard invariants: **(I1) WIRE-ONLY** — the memory brain always ingests full-fidelity text;
> **(I2) REVERSIBLE** — anything lossy is recoverable through `retrieve_full`.
>
> Every figure below is measured on this install, from
> `%APPDATA%/termpolis/headroom/proxy-totals.json` (read 2026-08-16) or from first-hand observation
> during recon. Nothing here is estimated from a dashboard.

---

## 0. The number that matters, stated first

The dashboard reports **50% savings**. The bill says **8.42%**.

Both are true. The dashboard measures saved share of *compressible tool text*
(`proxyLedger.ts:109-116`: `saved / orig` over `text* + toolUse*`). The bill is effective units
across input, cache-create, cache-read and output. Compressible tool text is only **14.6% of the
prefix** on this install. The other **85.4% has never been visited by any compressor** — `system`,
`tools`, user text, assistant text and thinking blocks are all untouched, because
`rewriteMessagesBody` walks `obj.messages` only (`headroomProxy/wireCompress.ts:398`), and there is
**zero code in `src/main` that reads `obj.system` or `obj.tools`** off a request body (verified by
grep; the only `.system`/`.tools` hits are `importScanner.ts:116`, `artifactInstaller.ts:237`,
`workflow/workflowEngine.ts:47,96`, all unrelated).

That gap is the entire subject of this document.

---

## 1. Measured baseline

### 1.1 Raw ledger

`%APPDATA%/termpolis/headroom/proxy-totals.json`, lifetime cumulative, read 2026-08-16:

| Field | Value | Source |
|---|---:|---|
| `requests` | 113,598 | proxy-totals.json |
| `inputTokens` | 5,823,217 | proxy-totals.json, from `usageParse.ts:38` |
| `cacheCreationTokens` | 263,359,832 | proxy-totals.json, from `usageParse.ts:40` |
| `cacheReadTokens` | 8,674,996,827 | proxy-totals.json, from `usageParse.ts:39` |
| `outputTokens` | 121,032,825 | proxy-totals.json, from `usageParse.ts:41` |
| `textOrigTokens` | 2,485,815,079 | proxy-totals.json, `ceil(trOrigChars/4)` at `proxyLedger.ts:81` |
| `textSavedTokens` | 1,231,748,177 | proxy-totals.json |
| `toolUseOrigTokens` | 21,431,314 | proxy-totals.json |
| `toolUseSavedTokens` | 9,708,026 | proxy-totals.json |
| `images` | 1,034 | proxy-totals.json |
| `imageOrigBytes` | 266,669,372 | proxy-totals.json (base64 chars, not tokens) |
| `imageSavedBytes` | 98,106,888 | proxy-totals.json |
| `retrieves` | 225 | proxy-totals.json |
| `givebackTokens` | 464,233 | proxy-totals.json |
| `belowFloorRequests` | 4,102 | proxy-totals.json |
| `floorEligibleRequests` | 6,854 | proxy-totals.json |
| `worstSavedPct` | 0 | proxy-totals.json (`empty()` seeds 100, so a request saved nothing) |

Secondary ledger `%APPDATA%/termpolis/headroom/headroom-totals.json`:
`{"netSaved":-7970560,"events":3686,"byTool":{"retrieve_full":-7970560}}` — still in the pre-1.34
legacy shape, so the migration at `savingsLedger.ts:49-61` fires on every load. Any figure quoted
from the unified receipt (`unifiedReceipt.ts:93`) depends on that migration; the raw proxy-totals
arithmetic above does not, which is why this spec uses only the raw file.

CCR durable store, measured directly: **3,022 files / 17 MB** against `CCR_MAX_BYTES = 200 MB`
(`ccrStore.ts:36`) and `CCR_MAX_ENTRIES = 512` in memory (`ccrStore.ts:34`).

### 1.2 Effective units — where the money actually goes

Weights are Anthropic's published multipliers, the same ones already hard-coded at
`prefixDecay.ts:53-54` (`CACHE_READ_W = 0.1`, `CACHE_WRITE_W = 1.25`); output is taken at 5x input,
matching the display math at `TokenSavingsSettings.tsx:60,70`.

| Pool | Tokens | Weight | Effective units | Share |
|---|---:|---:|---:|---:|
| Input | 5,823,217 | 1.00 | 5,823,217 | 0.32% |
| Cache create | 263,359,832 | 1.25 | 329,199,790 | 18.21% |
| Cache read | 8,674,996,827 | 0.10 | 867,499,683 | 47.99% |
| Output | 121,032,825 | 5.00 | 605,164,125 | 33.48% |
| **Total** | | | **1,807,686,815** | 100% |

Arithmetic: `5,823,217 + 329,199,790 = 335,023,007`; `+ 867,499,683 = 1,202,522,690`;
`+ 605,164,125 = 1,807,686,815`.

Images do not appear as a pool because Anthropic bills images by pixel area, not by transport
bytes. `imageOrigBytes` is base64 character count and is **not** convertible to tokens. Sizing them
separately: 1,034 images is 0.91% of requests (`1,034 / 113,598`); at the codec's 1280 long-edge
target (`imageCodec.ts:110`, `maxEdge = 1280`) a 1280x960 image costs `1,280 x 960 / 750 = 1,638`
tokens, so the whole lifetime image surface is about `1,034 x 1,638 = 1,693,692` tokens, roughly
226,700 effective units, or **0.011% of the bill**. Images are noise.

### 1.3 Two rules of thumb, derived once and used throughout

Total prefix tokens (read + create) = `8,674,996,827 + 263,359,832 = 8,938,356,659`.
Blended effective weight of one prefix token
= `(8,674,996,827 x 0.1 + 263,359,832 x 1.25) / 8,938,356,659`
= `1,196,699,472.7 / 8,938,356,659` = **0.1338836**.
(First published as `0.133891`; recomputed exactly. The correction moves `avoided` by ~9k units
out of 166M and leaves the 8.42% headline unchanged.)

**R1 — prefix.** Removing 1 token from every request's prefix removes
`113,598 x 0.1338836 = 15,208.8` effective units. So **1,000 tokens off the per-request prefix is
worth 0.77% of the total bill** (`15,208,800 / 1,973,897,455`).

**R2 — output.** Cutting output by 1% saves `605,164,125 x 0.01 = 6,051,641` units at face value
(0.31%). But every output token also enters the prefix and is re-read for the rest of the session:
a token generated at turn *i* of an *S*-turn session costs `5 + 0.1 x (S - i)`. For S = 64 and *i*
uniform, expected cost is `5 + 0.1 x 31.5 = 8.15` against a face value of 5, a **1.63x amortization
factor**. So **1% off output is worth 0.50% of the bill**.

(`1,973,897,455` is the counterfactual total derived in 1.5.)

### 1.4 What the compressor can and cannot see

Per request, dividing lifetime totals by `requests = 113,598`:

| Quantity | Per request | Arithmetic |
|---|---:|---|
| Cache-read tokens | 76,366 | `8,674,996,827 / 113,598` |
| Cache-create tokens | 2,318 | `263,359,832 / 113,598` |
| Prefix tokens (read + create) | 78,684 | `8,938,356,659 / 113,598` |
| Output tokens | 1,065 | `121,032,825 / 113,598` |
| Input tokens | 51 | `5,823,217 / 113,598` |
| tool_result text, pre-compression | 21,882 | `2,485,815,079 / 113,598` |
| tool_result text, removed | 10,843 | `1,231,748,177 / 113,598` |
| tool_result text, on the wire | 11,040 | `21,882 - 10,843` |
| tool_use input, on the wire | 103 | `(21,431,314 - 9,708,026) / 113,598` |
| **Compressor-authored bytes in the prefix** | **11,143** | `11,040 + 103` |
| **Prefix mass no compressor has ever seen** | **65,223** | `76,366 - 11,143` |

`11,143 / 76,366 = 14.59%` visible. **85.41% invisible.**

Achieved compression rates, for the record:
`textSaved/textOrig = 1,231,748,177 / 2,485,815,079 = 49.55%`;
`toolUseSaved/toolUseOrig = 9,708,026 / 21,431,314 = 45.30%`;
combined `1,241,456,203 / 2,507,246,393 = 49.515%`, which `Math.round` at `proxyLedger.ts:113`
reports as 50 — exactly `FLOOR_PCT` (`proxyLedger.ts:40`).

Reversibility is cheap: 225 retrieves over 113,598 requests (0.198%), 464,233 give-back tokens
against 1,241,456,203 saved = **0.037%**. Elided middles are almost never needed.

### 1.5 Current total-bill saving

Prefix-token weight split: cache-read is `8,674,996,827 / 8,938,356,659 = 97.053%` of prefix
tokens, cache-create `2.947%`. Saved tool text would have been billed at that same blend, so
avoided units = `1,241,456,203 x 0.1338836 = 166,210,640`.

Counterfactual bill = `1,807,686,815 + 166,210,640 = 1,973,897,455` effective units.
Achieved saving = `166,210,640 / 1,973,897,455` = **8.42%**.

### 1.6 Caveats — read these before quoting any figure above

1. **`toolUse*`, `belowFloorRequests`, `floorEligibleRequests` and `worstSavedPct` have a shorter
   history than `requests`.** They were added with the v1.34 tool_use surface, so their denominator
   is not 113,598. `floorEligibleRequests = 6,854` cannot be 6% of a corpus whose average request
   carries 21,882 compressible tokens against a `FLOOR_MIN_ORIG_TOKENS = 250` gate
   (`proxyLedger.ts:43`). Per-request figures derived from `toolUse*` are therefore **lower bounds**.
   Fix before the next spec: version-stamp the ledger and record a per-field first-seen request
   count.
2. **The floor controller is already at the top of its ladder on this install.**
   `missRate = 4,102 / 6,854 = 59.85%`, which exceeds `SEVERE_MISS_RATE = 0.5`
   (`savingsFloor.ts:47`), so `resolveWireMode` (`savingsFloor.ts:78-81`) returns `max` at every
   launch while `floorControl` is on (default true, `config.ts:54`). The configured `aggressive`
   mode is **not** what runs here. Live window is `{headLines: 6, tailLines: 3, maxChars: 500}`
   (`config.ts:91` via `windowForMode`, `wireCompress.ts:44-48`).
3. **Output weight is assumed at 5x.** It is not read from a price table anywhere in the repo.
   If the real ratio differs, section 2 moves.

---

## 2. The greater-than-50% ask, priced

Target restated in the owner's terms: >50% of the **total** bill in effective units.

Required removal = `0.50 x 1,973,897,455 = 986,948,728` units.
Already removed = `166,210,640`.
**Still required = `820,738,088` units**, which is `820,738,088 / 1,807,686,815 = 45.4%` of
everything currently on the wire, in and out.

Best honest package assembled from section 3, all of it inside I1 and I2:

| Lever | Effective units | Share of bill | Confidence |
|---|---:|---:|---|
| Already shipped (wire text + tool_use) | 166,210,640 | 8.42% | measured |
| P3 system + tools reduction (S=20,000, f=0.35) | 106,467,900 | 5.39% | S unmeasured |
| P5 output steering (15% cut x 1.63) | 148,043,000 | 7.50% | unmeasured |
| P6 cache-boundary work (40% of churn) | 59,382,300 | 3.01% | modelled |
| P4 prefix decay, gated | 0 to 20,000,000 | 0 to 1.01% | net-negative unless gated |
| P7 semantic templating | ~40,000,000 | ~2.03% | speculative |
| P9 images | 226,700 | 0.01% | measured |
| **Total** | **~540,000,000** | **~27.4%** | |

Add the one unmeasured lever that could still be large — dropping stale `thinking` blocks from the
prefix (P8b). If thinking is 15,000 tokens/request and 70% of it is droppable, R1 gives
`10,500 x 15,209.7 = 159,701,850` units = **8.09%**, taking the package to about **35.5%**.

To close the remaining 14.5 points you would need `286,216,000` more units. By R2 that is a further
**29% cut to output on top of the 15% already assumed**, i.e. a ~44% total output reduction. Nothing
but `thinkingCap` (`wireCompress.ts:83-98`, `config.ts:14`) moves output by that much, and it trades
reasoning depth for tokens with **no** `retrieve_full` path — tokens never generated cannot be
recovered. That is a direct breach of the second half of the product goal.

**Verdict: >50% of the total bill is not reachable inside the stated invariants.** The reachable,
defensible commitment for v1.36.0 is **25% to 30% of the total effective-unit bill**, with a
measured path to ~35% once P1 tells us how big the thinking mass is. Recommend the release
communicates two separate numbers rather than one: the existing 50% wire-text figure, and a new
**Total Bill Saved** figure computed exactly as section 1.5 does it. Reporting 8.42% honestly and
then tripling it is a better story than defending a 50% that the invoice does not show.

---

## 3. Proposals

Each carries: mechanism, files and functions, arithmetic, cache safety, reversibility (I2), and
memory-invariant risk (I1 plus recall quality, which the owner has now flagged twice).

### P0 — Repair reversibility before adding any more lossy transforms

**Mechanism.** During this recon I issued 10 `retrieve_full` calls against tokens the proxy had
minted moments earlier. **Three returned `{"error":"expired"}`** — a 30% miss rate, first-hand,
today. Invariant I2 is not holding in practice.

The earlier recon blamed a request-path race and said the stash was only committed after the
response. **That diagnosis is stale.** The request-path commit is fully wired and live:
`headroomProxy/proxyMain.ts:69-71` calls `opts.onStash(rewritten.stashes)` before
`upReq.end(body)` at `:104`; `:139` posts `{kind:'stash'}`; `proxySupervisor.ts:103` dispatches it;
`index.ts:2872` calls `ccrPut(st.token, st.original, 'proxy')`. The idempotent `diskPut` guard the
recon asked for is also already in (`ccrStore.ts:96`, correctly narrowed to `HASH_TOKEN_RE`), as is
give-back dedup (`compressToolResult.ts:70` via `ccrMarkRedeemed`). Do not re-fix any of those.

Remaining suspects, in order: the 512-entry memory LRU (`ccrStore.ts:34`) combined with the
`!diskIndex.has(token)` precondition in `diskGet` (`ccrStore.ts:113`), so a token whose file exists
but was not adopted by `setCcrDir` (`ccrStore.ts:129-143`) misses even though the bytes are on disk;
and eviction ordering in `evictDisk` (`ccrStore.ts:76-87`).

**Files.** `headroom/ccrStore.ts` (`diskGet:111`, `diskPut:89`, `setCcrDir:125`, `ccrStats:197`);
`headroomProxy/proxyLedger.ts` `ProxyTotals:6-37` + `recordProxyResult:77`;
`headroom/compressToolResult.ts:63` `retrieveFull`.

**Change.** Add `ccrMisses` and `ccrHits` to `ProxyTotals`, incremented from `retrieveFull`. Then
diagnose against data, not narrative. A fallback worth having regardless: on a miss, `diskGet`
should stat the expected path before trusting `diskIndex`.

**Arithmetic.** Zero tokens saved. It is the precondition for every other lossy proposal being
honest. A 30% miss rate means 30% of elisions are currently one-way.

**Cache safety.** None. Read-only.
**Reversibility.** This *is* reversibility.
**Memory invariant.** No risk to what the brain stores (I1 is about ingestion, which happens before
the wire). Direct risk to recall quality at the model, since an expired token is content the model
asked for and cannot get.

### P1 — Prefix-composition telemetry (the enabling change)

**Mechanism.** Measure the 85.41% blind spot. Extend `WireStats` with `sysChars`, `toolsChars`,
`toolCount`, `cacheControlCount`, `thinkingChars`, `assistantTextChars`, `userTextChars`,
`messageCount`, and a per-`toolName` orig/comp map. Populate them during the existing walk. **Do not
mutate anything.**

**Files and functions.**
- `headroomProxy/wireCompress.ts`: `WireStats:10-23`, `emptyStats():34`,
  `rewriteMessagesBody():364` — read `obj.system` and `obj.tools` for sizing only; the walk at
  `:398-427` already visits every block, so `thinking`/`text` sizing is a counter, not a new pass.
- `headroomProxy/proxyLedger.ts`: `ProxyTotals:6-37`, `recordProxyResult:77-101`.
- `headroomProxy/proxyMain.ts:88` already forwards `rewritten.stats` verbatim; no plumbing change.
- `headroom/unifiedReceipt.ts`: `UnifiedTotals:16-49`, `merge():52`.

**Arithmetic.** Zero saving. But by R1 every proposal below is priced in units of "tokens off the
per-request prefix", and none of P3, P4, P6, P7 or P8b can be budgeted without S (system+tools) and
T (thinking) as real numbers. Building any of them first is guessing.

**Cache safety.** None whatsoever. `rewriteMessagesBody` returns `changed: false` unless a block was
rewritten (`wireCompress.ts:431`), and counters do not set `changed`.
**Reversibility.** Not applicable.
**Memory invariant.** None. Per-`toolName` accounting is what makes P12 decidable.

**Note that changes the shape of P3.** `proxySupervisor.ts:79` sets
`ENABLE_TOOL_SEARCH: 'true'` in the launch environment. Claude Code's own tool-search already defers
tool schemas, so S may already be much smaller than the 20,000-token placeholder in section 2, and
the fashionable "tool-schema tiering" idea may be mostly pre-empted by a feature this repo already
turns on. **Measure S before writing a line of P3.**

### P2 — Termpolis MCP tool-description diet

**Mechanism.** Shorten our own tool descriptions. This is the guaranteed-safe subset of P3: static,
offline, entirely under our control, and it changes only between launches.

**Measured surface.** `src/main/mcpServer.ts`, `const TOOLS: McpTool[]` at `:115`, closing `:489`.
**34 tools**, served verbatim at `:678`. The array is ~18.2 KB of source; **9,843 bytes across 104
`description:` literals** (34 tool-level, 70 parameter-level), i.e. 54% of the tool block.

**Arithmetic.** Take the wire-serialized tools block at ~18 KB = 4,500 tokens. A 50% cut to
descriptions removes 4,900 bytes = 1,225 tokens from every request's prefix. By R1:
`1,225 x 15,209.7 = 18,632,000` units = **0.94% of the bill**. Small, permanent, and free.

**Files.** `src/main/mcpServer.ts:115-489` only.

**Cache safety.** The tools block sits at the front of the prefix. Changing it mid-session busts the
cache totally; changing it between launches costs exactly one miss on the first launch after
upgrade, which every version bump already pays. **Never make this dynamic.** A promote-on-first-use
scheme costs `1.15 x 78,684 = 90,487` units per promotion (R1 basis) against the ~1,225 tokens/turn
it might save, i.e. `12,250` units over 100 turns — a loss by a factor of seven per promotion. Cut
the idea.

**Reversibility.** Nothing is elided; the schema is simply written more tersely. No token needed.

**Memory invariant — real risk here.** Thirteen `memory_*` tools live in this array
(`mcpServer.ts:264-435`). Their descriptions are how the model knows to call `memory_primer` and
`memory_search` at all. **Exempt every `memory_*` and `swarm_*` description from the diet**, mirroring
`router.ts:10`. Trim `code_*`, terminal and git descriptions only.

### P3 — System prompt and tool schemas on the wire

**Mechanism.** Once P1 reports S, decide whether the proxy should compress `obj.system` and
`obj.tools`. Today neither is read at all (`wireCompress.ts:387` documents the exclusion, and grep
confirms it repo-wide).

**Files.** `headroomProxy/wireCompress.ts:364` `rewriteMessagesBody` — a new pre-walk over
`obj.system` (string or content-block array) and `obj.tools`.

**Arithmetic.** By R1, `Saving = S x f x 15,209.7` units where f is the fraction removed.

| S (tokens/request) | f = 0.20 | f = 0.35 | f = 0.50 |
|---:|---:|---:|---:|
| 8,000 | 0.62% | 1.08% | 1.54% |
| 20,000 | 1.54% | 2.70% | 3.85% |
| 30,000 | 2.31% | 4.04% | 5.78% |

(Section 2 quotes the S=20,000 / f=0.35 cell as 5.39% because it also credits the cache-create half
at the blended weight; the table above is the conservative read. Use the table.)

**Do not reuse `compactJson` on a schema.** Verified against `headroomProxy/jsonCompact.ts`: array
sampling at `:78-79` appends a literal sentinel *string element* into the array, which silently
drops entries from `required`, `enum`, `anyOf`, `oneOf` and `type`; depth pruning at `:71-74`
(`JSON_MAX_DEPTH = 6`) replaces nested objects with a string, and an `input_schema` reaches depth 6
trivially; string truncation at `:67-69` hits `pattern`, `format`, `const` and `default` as well as
`description`. It does preserve keys and key order (`:87`), so the damage is confined to values —
but three of its four transforms produce an invalid schema and an uncallable tool. A schema-safe
pass needs its own `walk` with a structural-key allowlist: never sample `required`/`enum`/`type`/
`anyOf`/`oneOf`/`allOf`, never depth-elide inside `properties`/`items`, truncate only `description`,
`title` and `examples`.

**Cache safety.** Front-of-prefix. Deterministic and shrink-only means byte-stable across turns
within a session, exactly like the tool_result path (`wireCompress.ts:373-381` round-trip guard
applies). Safe **only** if the transform is a pure function of the body. Any per-session state makes
it a per-turn bust.

**Reversibility.** A truncated tool description cannot be recovered by the model mid-call, and
`retrieve_full` returning schema prose is not a usable recovery path. **Treat description truncation
as irreversible and therefore conservative by construction**: cap the cut, never elide structure.

**Memory invariant.** Same exemption as P2, enforced in code this time: skip any tool whose `name`
satisfies `isExempt` (`router.ts:8-11`).

### P4 — Prefix decay as a measured launch-time decision

**Mechanism.** `applyPrefixDecay` (`prefixDecay.ts:94`) already exists, is already correct, and is
already wired (`wireCompress.ts:389-397`, `setProxyDecay` `proxySupervisor.ts:66`). It ships OFF
(`config.ts:54`). The proposal is not to write it, it is to decide *when* it earns its keep.

**The arithmetic says be careful.** `breakEvenTurns` (`prefixDecay.ts:61-64`) is
`prefixTokens x 1.15 / (removedTokens x 0.1)`. At this install's 76,366-token prefix:

| Removed R | Break-even turns | `878,209 / R` |
|---:|---:|---|
| 10,000 | 87.8 | |
| 20,000 | 43.9 | |
| 30,000 | 29.3 | |

Cost of one pass = `1.15 x 76,366 = 87,821` effective units. `decayCutoff` (`prefixDecay.ts:70-75`)
doubles at 64 / 128 / 256 messages, so a pass at 128 messages has until 256 messages to repay, which
is 128 more messages, roughly 64 turns. `64 > 43.9`, so it pays **if the session gets there**. The
first pass at 64 messages has only ~32 turns of runway and loses.

**Portfolio check.** If 30% of requests sit in decayed sessions and decay removes 26% of prefix:
gross = `867,499,683 x 0.30 x 0.26 = 67,664,975` units. Passes = `113,598 x 0.30 / 64 x 2 = 1,065`,
costing `1,065 x 87,821 = 93,529,365` units. **Net = -25,864,390. A loss.** The earlier recon ranked
decay third overall; on this install's numbers, ungated it is negative. That ranking is wrong.

**Change.** Add `resolveDecayEnabled(ev)` beside `savingsFloor.ts:64` `resolveWireMode`, resolved
**once at launch** from ledger evidence (median messages-per-request and mean prefix tokens, both
new in P1), and pushed through the existing `setProxyDecay`. Gate:
`enable iff breakEvenTurns(meanPrefix, expectedRemoved) < medianRemainingTurns`.

**Files.** New `headroom/decayControl.ts`; `index.ts` launch block beside `:2061-2078`;
`proxySupervisor.ts:66`. `prefixDecay.ts` itself needs no change.

**Cache safety.** A pass is a deliberate, accounted bust. The doubling cutoff is what keeps it to
one bust per doubling instead of one per turn — this is already right and must not be "improved"
into a smooth cutoff. Resolve the boolean once at launch, never mid-session.

**Reversibility.** Already correct: `stubFor` (`prefixDecay.ts:81-85`) pushes to `stashes` before
returning the stub. Depends entirely on P0.

**Memory invariant.** Wire-only, so I1 holds. Recall-quality risk is real but bounded: the model can
always retrieve. Note it also stubs `tool_use` inputs, i.e. file bodies the agent itself wrote
(`prefixDecay.ts:120-131`), with `DECAY_SKIP_KEYS` protecting the naming fields.

### P5 — Output steering: instrument it, then earn from it

**Mechanism.** Output is 33.48% of the bill and, by R2, worth 1.63x its face value once prefix
amortization is counted. **Nothing measures what steering earns** — verified: no field in
`SavingsTotals` (`savingsLedger.ts:19-26`), `UnifiedTotals` (`unifiedReceipt.ts:16-49`) or
`ProxyTotals` (`proxyLedger.ts:6-37`); no A/B, no holdout; the resolved mode is not even persisted,
so post-hoc correlation is impossible. `adaptSteeringMode` (`outputSteering.ts:51`) is a closed loop
with no feedback signal.

**Change A — attribution.** Persist `outputByMode: Record<SteeringMode, {requests, outputTokens}>`
in `ProxyTotals`, keyed by the mode already resolved at `index.ts:2075`. Cross-launch A/B, zero
per-request variation. Then `adaptSteeringMode` can compare modes instead of moving blind.

**Change B — one line, real money.** Move
`'Never repeat content already visible in tool output - reference it instead.'` from `MAX_EXTRA`
(`outputSteering.ts:19-23`) into `BASE` (`:12-17`). In an agentic coding loop, restating tool output
is the single largest avoidable output sink, and today that instruction only reaches users on `max`.

**Files.** `headroom/outputSteering.ts:12-23`; `headroomProxy/proxyLedger.ts:6-37,77`;
`index.ts:2061-2078`; `headroom/injectedInstruction.ts:39` unchanged.

**Arithmetic.** By R2, each 1% of output removed is 0.50% of the bill. A 10% cut is 5.00%; 15% is
7.50%. Change B alone is plausibly several points, but that is exactly the claim Change A exists to
test. Ship both; believe only what A reports.

**Cache safety.** The directive rides in the system prompt via `--append-system-prompt-file`
(`injectedInstruction.ts:39` to `index.ts:2078-2085` to `aiProfiles.ts:79`). Content is
deterministic per mode, so it is stable within a session; the `primer-<uuid>.txt` filename varies but
filenames are not cached. Changing the directive text costs one miss on the first launch after
upgrade. **Never vary per request** — `outputSteering.ts:1-8` already says so.

**Reversibility.** Not applicable; nothing is elided. Output not generated is not recoverable, which
is precisely why steering (a nudge) is acceptable where `thinkingCap` (a clamp) is not.

**Memory invariant — watch this one.** A terseness directive must never discourage *tool calls*.
Every existing `BASE`/`AGGRESSIVE_EXTRA`/`MAX_EXTRA` line is about prose, not about whether to call
`memory_write` or `memory_search`. Keep it that way, and add a test that asserts it.

### P6 — Cache-boundary engineering

**Mechanism.** Convert avoidable cache-*creation* into cache-*reads* by placing `cache_control`
breakpoints deliberately. Anthropic supports up to four; if Claude Code sets fewer, or sets them
before the tools block rather than after it, a late change forces a rewrite of segments that could
have been read.

**Sizing the churn.** `cacheCreationTokens / request = 2,318.3`. Model it as a mix of ordinary
incremental writes and full-prefix busts: `2,318.3 = (1-b) x W + b x 76,366`.

| Incremental write W | Bust rate b | Churn tokens | Units at 1.15x | Share |
|---:|---:|---:|---:|---:|
| 1,200 | 1.488% | 129,092,000 | 148,455,800 | 7.52% |
| 1,500 | 1.093% | 94,846,000 | 109,072,900 | 5.53% |

So **5.5% to 7.5% of the bill is prefix churn**, of which some is unavoidable (a new conversation
must write its prefix once). Capturing 40% of the 1,500-baseline figure gives
`109,072,900 x 0.40 = 43,629,160` units; section 2 quotes 59,382,300 by splitting the difference
between the two rows. Either way it is **2% to 4%**.

**Files.** P1 first: count `cache_control` occurrences and their positions in `WireStats`. Then
`wireCompress.ts:364` `rewriteMessagesBody` gains an opt-in breakpoint pass.

**Cache safety.** Adding a breakpoint does not change the content being hashed, so it does not
invalidate existing entries; it creates one additional cache entry, a one-time write. Must be
deterministic and resolved once at launch like every other knob here.

**Reversibility.** Fully lossless. Nothing is elided, so there is nothing to reverse. This is the
only proposal in the document that is free of I2 entirely.

**Memory invariant.** No risk. No content changes.

**The forbidden version of this idea.** The dominant real cause of prefix busts is probably the
cache's own TTL expiring while the user thinks between turns. There is no legitimate client-side fix
for that, and the illegitimate one — issuing synthetic keepalive requests to hold a cache warm — is
cut in section 4.

### P7 — Semantic tool-result templating

**Mechanism.** Many tool results are the same shape with different values. Send the shape once,
values-only afterwards.

**Justification against what already exists.** `bestDiff` (`diffEncode.ts:97`) already patches
near-duplicates within a body, newest-first, up to `DIFF_MAX_CANDIDATES = 24`, inside a 2x length
band, requiring `DIFF_MIN_LINES = 12` and a patch under `DIFF_MAX_RATIO = 0.6` of the new length.
Templating only wins where those gates exclude: results under 12 lines; results outside the 2x band;
and — the interesting one — results whose repetition is in **keys, not lines**. `compactJson` never
rewrites keys (`jsonCompact.ts:87`), so a list of records with identical key sets pays for those key
names in every record and on every turn, and a whole-line differ sees every record line as changed.

**Design constraint that makes or breaks it.** The shape registry must be **static and versioned,
compiled into the app**. A registry learned at runtime makes the transform depend on cross-request
state, which breaks determinism, breaks byte-stability, and busts the cache on every turn.

**Files.** New `headroomProxy/shapeTemplates.ts`; routed from `compactToolText`
(`wireCompress.ts:181-232`) as a fourth branch beside HTML / JSON / code.

**Arithmetic.** Unmeasured. P1 must first count "JSON blocks in this body whose key set matches an
earlier block". Section 2 carries a speculative 2.03% placeholder and it should be treated as such.

**Cache safety.** Safe if static. Unsafe in every dynamic variant.
**Reversibility.** Registry plus stash; standard `retrieve_full` path.
**Memory invariant.** Wire-only. Must respect the P12 exemption.

### P8a — Cross-turn duplicate collapse: already done, do not rebuild

Every turn re-sends the whole conversation, so what looks like a cross-turn duplicate is a
**same-body** duplicate and is already collapsed: byte-identical blocks by the `seen.keys` stub
(`wireCompress.ts:265-272`), near-identical by `bestDiff` (`:280`), and `tool_use` shares the `seen`
index with `tool_result` (`:422-424`) so write-then-read collapses on the second occurrence.

Genuine residue: blocks under the 400-char gate; assistant `text` blocks, which never enter `seen`;
and cross-session (P8c). **Build nothing here.** Add a P1 counter for "blocks byte-identical to an
earlier block that were not collapsed" and let the number decide. Rewriting the assistant's own
prior words is rejected outright — it edits the model's record of what it said, for an unquantified
gain.

### P8b — Dropping stale `thinking` blocks: the one large unknown

**Mechanism.** Thinking blocks from *completed* turns sit in the prefix and are re-read forever.
Both compressors treat them as a hard exclusion — `wireCompress.ts:359-361` and the comment at
`prefixDecay.ts:113` — because they carry a signature Anthropic validates. But **removing a block is
a different operation from editing one**, and the API's rules about which thinking blocks must be
echoed back are version-specific.

**Arithmetic.** By R1, if thinking is T tokens/request and a fraction d is droppable, saving is
`T x d x 15,209.7` units. At T = 15,000 and d = 0.70 that is 159,701,850 units = **8.09%** — the
largest single item in this document. T is completely unknown today. P1 measures it in one line.

**Status: DO NOT IMPLEMENT until verified.** The failure mode is an invalid request, not a terms
violation, but it must be checked against current Anthropic documentation *and* against the
committed snapshot at `docs/security-snapshots/anthropic.txt` before any code exists. If it is
permitted, it must use a sticky doubling cutoff exactly like `decayCutoff`, or it busts the cache
every turn as "the current turn" advances.

**Reversibility.** Stash the removed block under a content-hash token like everything else. Note the
recovered text cannot be re-inserted as a valid signed `thinking` block, so recovery is
read-only-for-the-human, not for the model.

**Memory invariant.** No I1 risk. Recall-quality risk is genuinely low: prior-turn reasoning is not
context the model is expected to re-read.

### P8c — Cross-session content-addressed reuse: rejected on quality

Tokens are content hashes (`wireCompress.ts:35`, `ccrStore.ts:148-155`) and the store is durable
(3,022 files, 17 MB, 200 MB cap), so a stub minted today for content stashed last week is already
retrievable. The mechanism is free.

The objection is not mechanical. Eliding the middle of something the model just read is one thing;
replacing content it has never seen in this conversation with a token is another. The measured
give-back rate (0.037%) proves the *former* is nearly always fine and says nothing about the
latter. **Do not build.** If ever built: opt-in, never for `memory_*` or `swarm_*`, and gated on a
quality measurement, not a token measurement.

### P9 — Image downscale: already shipped, and negligible

**It is already implemented.** `imageCodec.ts:110`
`compressImage(dataB64, mediaType, maxEdge = 1280)` downscales via `downscaleRGBA` (`:77-98`, a
deterministic box average) *before* `encodeSmallest` (`:46`), which writes PNG and tries JPEG at
`JPEG_QUALITY = 82` only when fully opaque, keeping whichever is smaller. Measured result:
`98,106,888 / 266,669,372 = 36.79%` of base64 bytes removed across 1,034 images.

**Arithmetic.** 0.011% of the bill (section 1.2). Deprioritize completely.

**Defect found, and it is an I2 breach.** `compressImageBlock` (`wireCompress.ts:296-305`) mutates
`src.data` and `src.media_type` and **pushes no stash**. Images are the one lossy transform in the
system with no `retrieve_full` path. Either stash the original base64 under a content-hash token
(recovery is degraded, since `retrieve_full` returns text) or document the exemption explicitly in
the settings UI. Silently having one irreversible transform inside a feature whose promise is
reversibility is the wrong answer.

### P10 — Per-mode `floorChars` reaching the wire

**What is actually true.** `WireWindow` is `{headLines; tailLines; maxChars}` (`wireCompress.ts:37`)
and `windowForMode` (`:44-48`) drops `floorTokens` on the floor. The live gate is the literal `400`
at `wireCompress.ts:182` (`compactToolText`), `:265` (dedup), `:277` (diff), plus
`TOOL_USE_MIN_CHARS = 400` (`:316`). `config.ts:82-91` intends
`floorTokens` 1500 / 800 / 400 / 150, which its own comments gloss as roughly
6000 / 3200 / 1600 / 600 chars.

**So the wire is more aggressive than every configured mode, including `max` (400 < 600).**
Implementing `floorChars` as config intends would therefore **reduce** savings in all four modes —
the opposite of what the earlier recon implied when it cited the below-floor request count.

**And the floor is not the binding constraint anyway.** For a block between 400 and 1,000 chars with
18 or fewer lines, `compactText` elides nothing: the line window needs more than
`headLines + tailLines` lines and the char clamp needs more than `maxChars` (1,000 at aggressive,
500 at max). Below `maxChars`, admitting a block through the floor buys a no-op. The real small-block
lever is `maxChars`, not the floor.

**Change.** Add `floorChars` to `WireWindow` and carry it through `windowForMode`, but set it to
`min(intended, 400)`: conservative 6000, balanced 3200, aggressive 400, max 250. Escalate-only
relative to today at the two modes this install actually runs. Expected token delta at
aggressive/max: approximately zero. **The value is coherence** — Conservative and Balanced currently
claim to keep 6000 and 3200 chars inline and do not.

**Files.** `wireCompress.ts:37` (`WireWindow`), `:44-48` (`windowForMode`), `:59-65`
(`setWireWindow` validation), `:182`, `:265`, `:277`, `:316`.

**Cache safety.** Any change to what the wire emits rewrites blocks already inside cached prefixes.
Resolve once at launch, escalate-only, matching `savingsFloor.ts`. One bust costs ~87,821 units
against roughly 140 units/request earned by a tier bump, i.e. ~627 requests in the *same* session to
repay. Never per-turn.
**Reversibility.** Unchanged; the stash path is the same.
**Memory invariant.** None directly, but see P12.

### P11 — Ledger honesty: report the total bill

**Mechanism.** Add `effectiveUnitsTotal`, `effectiveUnitsSaved` and `totalBillSavedPct` to
`UnifiedTotals`, computed exactly as section 1.5 does. The 50% headline is not wrong, it is
answering a narrower question than the one the owner is asking.

**Files.** `headroom/unifiedReceipt.ts:16-49` (`UnifiedTotals`), `:52` (`merge`);
`renderer/src/components/.../TokenSavingsSettings.tsx:60,70` already multiplies output by 5 and can
reuse the same constants. Lift the weights out of `prefixDecay.ts:53-54` into a shared module so
there is one definition.

**Arithmetic / cache / reversibility / memory.** None, none, none, none. Pure reporting.

### P12 — The memory exemption does not reach the wire

**This is a live invariant leak and it deserves its own item.**

`router.ts:8-11` `isExempt` correctly refuses to compress any `memory_*` or `swarm_*` result at the
MCP layer. But that layer returns full text, and the **proxy then compresses it anyway on the way to
the model**. `compactToolText` receives a `ContentHint` that already carries `toolName`
(`wireCompress.ts:105`, built at `:111-122` and indexed at `:129-139`), and uses it for
`familyForPath` only — it is never consulted for exemption. `compressToolUseInput` computes the same
hint at `:343` and likewise ignores the name.

Invariant I1 still holds in the strict sense: the brain ingests before the wire, so what is
*stored* is full fidelity. What is degraded is what the model *sees* when it recalls — which is the
half the owner has now emphasised twice.

**Change.** Import `isExempt` into `wireCompress.ts` and short-circuit `compactOrDedup` when
`hint.toolName` is exempt. Two call sites: `:407`/`:412` (tool_result) and `:350` (tool_use).

**Arithmetic.** This **costs** tokens. `memory_primer` digests and `memory_search` results are large
and compress well. P1's per-`toolName` accounting sizes the bill before the decision is taken; if it
is expensive, the fallback is a narrower exemption (`memory_primer` and `memory_search` only, still
compressing `memory_list`). But the default posture, given the stated goal, is to pay it.

**Cache safety.** Changes what the wire emits, so: launch-resolved, one bust on upgrade.
**Reversibility.** Removes a lossy transform. Strictly improves I2.

---

## 4. Provider rules

The test applied to every item: does this reduce the payload we legitimately choose to send, or does
it interfere with how the provider meters, limits, or observes that payload? The first is ordinary
client-side optimization. The second is not, and gets cut regardless of what it would save.

| Proposal | Classification | Reasoning |
|---|---|---|
| P0 reversibility repair | Ordinary. Fine. | A bug fix in our own cache. Touches no provider surface. |
| P1 telemetry | Ordinary. Fine. | Counts bytes in requests we originate, and reads `usage` the provider already returns. Read-only: `usageParse.ts:28` parses, never rewrites. |
| P2 tool-description diet | Ordinary. Fine. | We are shortening prose in our own MCP server. |
| P3 system/tools compression | Ordinary. Fine. | Editing a request body we author, before we send it. The risk is our own tool-call accuracy, not the terms. |
| P4 prefix decay | Ordinary. Fine. | Sending less conversation history is a client's prerogative. |
| P5 output steering | Ordinary. Fine. | Prompt engineering. |
| P6 `cache_control` placement | Ordinary. Fine. | Uses a documented API feature exactly as designed, and pays the posted price for whatever it writes or reads. |
| P7 semantic templating | Ordinary. Fine. | Lossless-with-registry payload encoding. |
| P8b dropping stale thinking blocks | Fine on terms; **verify on validity**. | The exposure is an invalid request, not a violation. Verify against current Anthropic docs and `docs/security-snapshots/anthropic.txt` first. |
| P8c cross-session reuse | Fine on terms; rejected on quality. | Nothing is concealed from metering; the request simply carries less. The objection is recall quality. |
| P9 image downscale | Ordinary. Fine. | Sending a smaller image is sending a smaller image. |
| P10 `floorChars` | Ordinary. Fine. | Internal threshold. |
| P11 ledger honesty | Ordinary. Fine. | Reporting. |
| P12 memory exemption | Ordinary. Fine. | Compresses less, not more. |

**Explicitly out of scope, and to be refused if proposed later.** None of these are in the codebase
today; this list exists so that a future session does not rediscover them as clever.

1. **Synthetic or keepalive traffic to hold a prompt cache warm.** This is the tempting answer to the
   TTL-expiry churn quantified in P6. It manufactures billable requests to game a pricing mechanism.
   Cut.
2. **Key or account rotation to reset rate limits, or splitting one workload across credentials.**
   Straightforward evasion of rate limiting. Cut.
3. **Altering, dropping or rewriting the `usage` fields in a response** so the client or the user
   under-reports spend. The proxy currently reads usage and never writes it (`usageParse.ts:28-42`,
   consumed at `proxyMain.ts:87-88`). That property must be treated as load-bearing and asserted by a
   test.
4. **Retrying a 429 faster than the provider's `Retry-After`,** or retry loops tuned to slip under a
   limiter.
5. **Any misreporting in either direction** — telling the user the model saw full fidelity when it
   saw a stub, or the reverse. The `[headroom]` footers exist precisely so the model knows what it is
   looking at; keep them.
6. **Anything whose safety argument is that the provider will not notice.**

**ToS-drift machinery, and a release gate.** The repo already watches provider terms:
`.github/workflows/tos-drift.yml` (weekly, cron `0 13 * * 1`, `:24`) runs
`scripts/verifyTosSnapshots.cjs` against `docs/security-snapshots/{anthropic,google-gemini}.{txt,hash}`
and opens or updates a single issue with labels `security` + `tos-drift` (`:107`), then fails the job
(`:110-114`). Provider facts the UI shows come from `AGENT_FACTS` (`src/main/aiSecurity.ts:652`,
"as of 2026-05-05" per the comment at `:579`), surfaced over IPC at `index.ts:1079` and rendered at
`StatusBar.tsx:248`.

**Issue #23 is OPEN and unresolved.** Google/Gemini drift detected 2026-07-27 (run 30281679801), new
hash `2d6677be...`, old `3e83251d...`; the committed `google-gemini.hash` still predates the run.

Two requirements follow:

- **Close or consciously re-baseline #23 before shipping v1.36.0.** Shipping a release whose headline
  feature is a deeper compression proxy while the repo's own terms watcher sits red is the one thing
  in this plan that would actually look bad, and it is a half-hour of reading.
- **Add snapshots for the pages this workstream now depends on** — Anthropic's prompt-caching and
  extended-thinking documentation — because P6 and P8b are built on their exact semantics. Only two
  providers are snapshotted today although the UI claims three.

---

## 5. Build order for tonight

Ranked by (evidence unlocked) x (confidence) / (risk). Effort is sized S / M / L against a concrete
anchor, in the house style — no hours.

| # | Item | Effort | Why here |
|---|---|---|---|
| 1 | **P0** ccr hit/miss counters, then diagnose | S — two counters and a `statSync` fallback | I2 is failing 30% of the time on this machine right now. Nothing lossy should be added on top of a reversibility path that misses one call in three. |
| 2 | **P1** prefix-composition telemetry | M — one struct, one pre-walk, one ledger widening | Prices P3, P4, P6, P7 and P8b. Every one of them is a guess until this lands. Zero cache risk, so it can ship the same night it is written. |
| 3 | **P5** Change B (one line) + Change A (attribution) | S + M | Change B is a single array move for a pool worth 33.48%; Change A is the only way to ever know whether steering works. |
| 4 | **P11** total-bill reporting | S — reuse the section 1.5 arithmetic | Makes the release honest and reframes the 50% conversation before anyone else has to. |
| 5 | **P2** MCP description diet, `memory_*` and `swarm_*` exempt | M — 34 tools, careful prose | 0.94%, permanent, zero cache risk, entirely under our control. |
| 6 | **P12** wire-level memory exemption | S — one import, two guards | Closes a stated-invariant leak. Land it behind P1 so the cost is known before it is paid. |
| 7 | **P10** `floorChars` in `WireWindow` | M — one field, four call sites, escalate-only | Coherence fix. Near-zero token delta. Do it while the file is open. |
| 8 | **P6** breakpoint audit, measurement only | S tonight (counters in P1), L to implement | 2% to 4% is real, but placing breakpoints without knowing what the client already sets is guessing at a bust. |

Everything above except #8's implementation is one night's work. #2 and #3 are the two that matter.

**Sequencing constraint.** P0 before anything lossy. P1 before P3, P4, P6, P7, P8b. P12 after P1.

---

## 6. What NOT to build, and why

| Not building | Why |
|---|---|
| **Dynamic tool-schema tiering** (stubs promoted to full schemas on first use) | Each promotion is a mid-session cache bust costing ~90,487 units against ~1,225 tokens/turn saved, which is ~12,250 units over 100 turns. A loss by ~7x per promotion. The static version (P2/P3) captures the same bytes with none of the cost. Also probably pre-empted: `ENABLE_TOOL_SEARCH: 'true'` is already set at `proxySupervisor.ts:79`. |
| **Prefix decay enabled by default** | Portfolio arithmetic in P4 is **net -25.9M units** under central assumptions. It wins only on long sessions and must be gated on measured evidence, not enabled because it sounds powerful. |
| **`thinkingCap` on by default** | The only lever big enough to reach 50%, and the only one whose loss is unrecoverable — there is no `retrieve_full` for a thought never had. Stays opt-in at `config.ts:54`, with the arithmetic shown in Settings. |
| **`compactJson` applied to tool schemas** | Verified to produce invalid schemas three different ways (`jsonCompact.ts:71-79`). Would silently drop `required` entries and make tools uncallable. |
| **Cross-session content-addressed stubs** (P8c) | Mechanically free, ToS-clean, and a recall-quality gamble the owner has twice said not to take. |
| **Compressing assistant `text` blocks** | Rewrites the model's own record of what it said, for an unquantified gain. |
| **Rebuilding cross-turn duplicate collapse** (P8a) | Already done by `seen.keys` (`wireCompress.ts:265`) and `bestDiff` (`:280`), which share an index with `tool_use` (`:422-424`). The residue is small; count it before coding it. |
| **A runtime-learned template registry** (P7 dynamic variant) | Cross-request state destroys determinism and byte-stability, busting the cache every turn. Static registry or nothing. |
| **Image work beyond making it reversible** | 0.011% of the bill. The downscale already exists (`imageCodec.ts:110`). Only the missing stash at `wireCompress.ts:296-305` is worth touching. |
| **Lowering the wire floor below 400 chars** | Below `maxChars` (1,000 aggressive / 500 max) the compactor is a provable no-op, so admitting smaller blocks buys nothing and dilutes the reported ratio. |
| **Any of the six items in section 4's forbidden list** | Not a token question. |

---

## 7. Tests

Gate: lines 97 / fn 96 / branches 95 / stmts 96 (`vitest.config.ts:106-109`), Windows CI only
(`:75`), no per-file overrides, and both headroom directories are inside coverage `include`
(`:53-59`) with nothing headroom-related in `exclude` (`:60-73`). 40 dedicated headroom specs already
live in `tests/electron/`. New code goes in the same directory, same naming.

Two existing specs are effectively contracts and must keep passing unchanged:
`tests/electron/noNondeterministicCompression.test.ts:16` (scans `src/main/headroom` for
nondeterminism) and `tests/electron/headroomCachePrefixStability.test.ts`. Request-path stashing is
already asserted by `tests/electron/headroomProxyServer.test.ts`.

| Proposal | Tests required |
|---|---|
| **P0** | Extend `headroomCcrDisk.test.ts`: a token written by `ccrPut` then evicted from the memory LRU (push past `CCR_MAX_ENTRIES = 512`) still resolves from disk. A token whose file exists but is absent from `diskIndex` resolves via the stat fallback. `headroomProxyLedger.test.ts`: `ccrHits`/`ccrMisses` increment on hit and on `{error:'expired'}`. |
| **P1** | New `headroomWireStatsComposition.test.ts`: `sysChars`/`toolsChars`/`thinkingChars`/`cacheControlCount`/`messageCount` are populated for a representative body; a body with `system` and `tools` present returns `changed: false` when no message block was rewritten (this is the cache-safety assertion, and the important one); per-`toolName` map keys match the `tool_use` names. Round-trip: `JSON.parse(result.body)` deep-equals the input when nothing changed. |
| **P2** | New `mcpToolSchemaBudget.test.ts`: total `description:` bytes in `mcpServer.ts:115-489` stay under a committed ceiling (a ratchet, so it cannot silently regrow); every `memory_*` and `swarm_*` description is byte-identical to a committed fixture; all 34 tools still have non-empty descriptions and valid `inputSchema`. |
| **P3** | Schema-safety suite: for each of the 34 tools, the compressed `input_schema` still validates as JSON Schema, `required`/`enum`/`type`/`anyOf`/`oneOf` arrays are unchanged in length and content, no value anywhere is the depth-elision sentinel, and no exempt tool was touched. Determinism: same input, same bytes, twice. Shrink-only: output length is less than or equal to input length. |
| **P4** | Extend `headroomPrefixDecay.test.ts` for `resolveDecayEnabled`: off below the evidence minimum; off when `breakEvenTurns` exceeds expected remaining turns; on when it does not; never flips mid-session (assert the resolved value is read once). Table-drive the break-even cases from the P4 table so the arithmetic is executable. |
| **P5** | `headroomSteering.test.ts`: the tool-output-restatement line now appears at `balanced` and `aggressive`, `max` is unchanged, `conservative` still returns only `BASE[0]` and `BASE[3]`. Determinism per mode. **A guard test asserting no directive string contains language that could suppress a tool call** (a denylist over `memory`, `search`, `tool`, `call` in imperative-negative form) — this is the memory-invariant test. `headroomProxyLedger.test.ts`: `outputByMode` accumulates under the resolved mode and survives the disk round-trip. |
| **P6** | New `headroomCacheBreakpoints.test.ts`: `cacheControlCount` counts correctly for 0, 1 and 4 breakpoints; the body is byte-identical when the pass is disabled; when enabled, the inserted breakpoint appears at a deterministic index and re-running produces identical bytes. |
| **P9** | `headroomProxyWireEdges.test.ts`: a compressed image block pushes a stash whose token resolves, or (if the exemption is chosen instead) an explicit test documenting that images are not reversible, so the decision is recorded in code rather than lost. |
| **P10** | `headroomSavingsFloor.test.ts` and `headroomConfig.test.ts`: `windowForMode` returns the mapped `floorChars` per mode; `setWireWindow` rejects a negative or non-finite `floorChars` without downgrading the active window (mirroring `:60-65`); blocks between the old and new gates behave as the table says at each mode. |
| **P11** | `headroomUnifiedReceipt.test.ts`: `totalBillSavedPct` computed from the section 1.1 figures equals 8.42% within rounding; zero-denominator returns 0, not `NaN`. |
| **P12** | New `headroomWireExemption.test.ts`: a `tool_result` whose `tool_use` name is `memory_search` is forwarded byte-identical even at 50,000 chars; the same content under `Read` is compressed; `swarm_*` likewise exempt; exemption also applies on the `tool_use` input path (`:350`). |

Coverage strategy: every new module gets its branches exercised in its own spec rather than
incidentally. The two places branches historically escape here are validation setters
(`setWireWindow`-style guards) and fail-open `catch` arms — write those cases first, not last.

---

## 8. Open questions P1 must answer before the next spec

1. **S** — system + tools tokens per request. Decides whether P3 is 0.6% or 5.8%, and whether
   `ENABLE_TOOL_SEARCH` has already taken the prize.
2. **T** — thinking tokens per request. The single largest unknown in the document; potentially
   8% of the bill (P8b).
3. **Messages per request, distribution not mean.** Decides whether P4 is positive or negative.
4. **`cache_control` breakpoints already set by the client, and where.** Decides whether P6 is
   available at all.
5. **Bytes and count of `memory_*` results currently compressed on the wire.** Prices P12, which is
   the one change here that deliberately spends tokens to protect recall.
6. **Per-field first-seen request counts in the ledger,** so caveat 1.6.1 stops applying to the next
   set of figures.
