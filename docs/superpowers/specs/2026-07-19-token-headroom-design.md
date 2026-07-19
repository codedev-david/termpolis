# Token Headroom — Design Spec (v1.28.0)

**Status:** Approved 2026-07-19. Ship as minor **v1.28.0**.
**Goal:** A Headroom-style, local-first token-savings layer that reduces the tokens Termpolis
sends to the agent — *provably*, with **zero performance impact**, **100% test coverage on the new
modules**, and a **real savings receipt** in dashboard settings.

## 1. Problem & north star

AI coding sessions burn token/rate-limit budget fast. The biggest, safest win is the verbose JSON
that Termpolis's *own* MCP tools return (a 100-hit `code_search`, a raw `read_output` dump, a deep
`get_file_tree`). Headroom's headline numbers (60–95%) come from exactly this class of content.

David's north star is **token maximization** — more useful work per session before compaction and
rate limits. We slow the burn on everything Termpolis touches, measure it honestly, and prove it.

## 2. Scope decision (why "owned outputs", not a proxy)

- **In scope:** compress the outputs of Termpolis's own MCP tools + steer output verbosity at launch.
- **Out of scope (Phase 2, opt-in only):** a network proxy that rewrites the CLI↔provider traffic.
  Rejected for v1 because its *only* marginal territory over this design is the agent's **cached
  prefix**; rewriting cached bytes busts Anthropic prompt caching (cache reads ≈ 10% of fresh input),
  which can cost *more* than it saves, and byte-rewriting OAuth subscription traffic contradicts
  Termpolis's transparent-secure-hosted posture. This is why Headroom's coding-agent number is only
  15–20% while tool-output compression is 60–95%.

**Non-interference guarantee:** compression sits on the *outbound* render path (what the agent
*reads*), strictly downstream of the brain. The brain store stays full-fidelity; recall
ranking/gating runs on real data; **all `memory_*` tools are exempt (byte-identical passthrough)**.

## 3. Architecture — one choke point, fully deterministic

Single interception surface: `src/main/mcpServer.ts` `tools/call` handler (currently line 682–687).

```ts
const result = await executeTool(name, args || {}, handlers)
const text = compressToolResult(name, result)   // fail-open → original JSON on any issue
return { jsonrpc: '2.0', result: { content: [{ type: 'text', text }] }, id }
```

**No ML model / no Python / no HuggingFace** (deliberate departure from Headroom's Kompress). Pure
TypeScript, single-pass, linear structural transforms in the main process. This is what makes it
fast, dependency-free, and testable to 100%.

### Module map (small, isolated, independently testable)

| Module (new, `src/main/headroom/`) | Responsibility | Purity |
|---|---|---|
| `tokenEstimate.ts` | re-export `estimateTokens` from `memoryEconomy` | pure |
| `contentRouter.ts` | `route(toolName, result) → CompressorKind \| 'exempt' \| 'passthrough'` | pure |
| `compressors/structuralJson.ts` | lossless JSON shrink (whitespace, null/empty drop, dedup) | pure |
| `compressors/resultList.ts` | top-K full + tabularized/elided tail + CCR token | pure |
| `compressors/fileTree.ts` | collapse uniform/deep subtrees, cap breadth + CCR token | pure |
| `compressors/rawText.ts` | dedup repeated lines, collapse ws, head+tail window + CCR token | pure |
| `ccrStore.ts` | in-memory session LRU: `stash(orig)→token`, `retrieve(token)→orig\|null` | stateful (bounded) |
| `savingsLedger.ts` | in-memory buffered event log + async batched flush + `summarize()` | stateful (bounded) |
| `compressToolResult.ts` | orchestrator: route → compress → stash → record → return text | fail-open |
| `outputSteering.ts` | build terseness/effort directive block for the injected system prompt | pure |

### Tool routing table

- **Compress (result-list):** `code_search`, `code_callers`, `code_callees`, `code_impact`,
  `code_explore`, `code_locate`.
- **Compress (file tree):** `get_file_tree`.
- **Compress (raw text):** `read_output`.
- **Compress (structural JSON, lossless):** `get_git_status` and any other verbose object result.
- **EXEMPT (byte-identical passthrough):** every `memory_*` tool (`memory_search`, `memory_primer`,
  `memory_list`, `memory_related`, `memory_graph`, `memory_*`), plus control tools with no payload
  (`create_terminal`, `write_to_terminal`, `close_terminal`, `run_command` ack, `list_terminals`,
  `swarm_*`). Rationale: memory outputs are already the compressed-pointer pattern (~75-token primer,
  400-char snippet caps, load-bearing `- [` line format the recall banner counts). Recompressing them
  is redundant and would corrupt that count.

## 4. Compression pipeline (Model C = structural always-on + reversible offload)

1. `compressToolResult(name, result)`:
   - `kind = route(name, result)`. If `exempt`/`passthrough` → return `JSON.stringify(result, null, 2)` unchanged.
   - Serialize once; if `estimateTokens(serialized) < FLOOR` (default ~800) → passthrough (nothing to gain).
   - If serialized bytes > `MAX_COMPRESS_BYTES` (hard cap, e.g. 4 MB) → passthrough (perf guard; never churn a giant blob on the main thread).
   - Else run the routed compressor → `{ text, savedTokens, ccrToken? }`.
   - If a `ccrToken` was produced, `ccrStore.stash(original)` under it (in-memory).
   - `savingsLedger.record({ tool, origTokens, compTokens, savedTokens, ccrToken, kind: 'compress' })`.
   - Return `text`.
2. **Reversibility:** the compressed text ends with a machine-parseable footer, e.g.
   `\n[headroom: N items elided · call retrieve_full("<token>") for the complete result]`.
3. **Retrieve:** new MCP tool **`retrieve_full`** `{ token: string }` → returns the stashed original
   (full JSON) or, on miss/expiry, a clear `"This result has expired — re-run the original tool."`
   string (never throws). A hit records `{ kind: 'retrieve', tokens: <returned> }` so net savings nets it out.

### Thresholds / aggressiveness (setting-driven)

| Level | FLOOR (tokens) | resultList top-K | fileTree breadth cap |
|---|---|---|---|
| Conservative | 1500 | 25 | 200 |
| Balanced (default) | 800 | 12 | 100 |
| Aggressive | 400 | 6 | 50 |

## 5. Output-token steering

- Append a toggleable directive block to the Claude system-prompt file Termpolis already writes
  (`aiProfiles.ts:79`, via `memoryPreparePrimerFile`). Content: terseness (skip preamble/postamble,
  no restating the question, minimal narration) + light effort nudge (don't over-reason routine reads).
- **Honest scoping:** true per-request effort-dialing needs the proxy; this is *standing* steering.
  Its savings are **estimated (counterfactual)** and displayed as a **separate labeled line** in the
  receipt — never mixed into the measured headline.
- Other agents (Codex/Gemini/Qwen): one-line terseness note folded into the existing typed pointer
  (`useAutoPrimer`). Lighter touch.

## 6. Savings receipt (dashboard settings) — the proof

- `savingsLedger` events (in-memory ring + async JSONL flush under `%APPDATA%\Termpolis\headroom\`):
  `{ ts, tool, origTokens, compTokens, savedTokens, ccrToken?, kind: 'compress' | 'retrieve' }`.
- `summarize()` → `{ session, cumulative }` each with `{ netSaved, byTool, retrieveRate, events }`.
  **Net saved = Σ compress.savedTokens − Σ retrieve.tokens.** Honest lower bound, no multiplier.
- IPC: `tokenSavings:getReceipt`, `tokenSavings:getSettings`, `tokenSavings:setSettings`.
- New `src/renderer/src/components/SettingsPane/TokenSavingsSettings.tsx`:
  - Toggles: Compression on/off, Aggressiveness (Conservative/Balanced/Aggressive), Output steering on/off.
  - Receipt: session + cumulative net tokens saved, by-tool breakdown, retrieve rate, top savers, sparkline.
  - **Headline = measured tokens-removed** (deterministic, attributable). Beneath it, a **corroboration
    line** from the real provider token counts the context-pressure feature already parses from Claude's
    transcript (independent real-world proof). Steering savings shown separately, labeled "estimated".
- Settings persistence: localStorage flags in renderer (mirror `isAutoPrimerEnabled`) mirrored to main
  via IPC so the compressor reads live settings.

## 7. Performance (hard requirement — designed main-thread-safe)

The app has a severe freeze history (568 MB string fatal; main-thread profiler feedback-loop; 10 s
`initMemoryGraph`). This feature is built to add **no measurable main-thread cost**:

- Compression operates on a **single, bounded** tool result (KB–low-MB), not the store. It is
  **linear, single-pass**; no O(n²) (upsertEdge lesson), no whole-file reads.
- **Hard byte cap** `MAX_COMPRESS_BYTES` → above it, passthrough (never churn a giant result).
- **CCR is in-memory session LRU** (cap ~50 blobs / ~50 MB, LRU evict) — **no sync disk I/O on the
  hot path**. Restart → empty cache → stale token yields "re-run the tool".
- **Ledger buffers in memory**, flushes async/batched (best-effort, try/catch, never blocks a response
  — mirrors existing `recordMetric`).
- **Perf-budget test:** compressing a synthetic 100-hit `code_search` and a 5 MB `read_output`
  completes under a fixed budget (e.g. < 20 ms), asserted in CI.

## 8. Error handling — fail-open everywhere

- `compressToolResult` wraps everything in try/catch → returns the original `JSON.stringify(result)`
  on ANY error. A compression bug degrades to "no savings", never a corrupted/broken tool result.
- CCR stash failure → return the *original* (never emit a token that can't be honored).
- `retrieve_full` unknown/expired token → "re-run the tool" text, never a throw.
- Ledger failure → swallowed.

## 9. Testing — the 100% bar (proves actual token-spend savings)

- **Per-compressor golden tests:** exact input → exact output, exact `savedTokens` (pure fns).
- **Round-trip fidelity:** `stash → retrieve` byte-identical, every compressor that offloads.
- **Honest-ledger test:** retrieves net out; a retrieved item contributes ≤ 0 net; no inflation.
- **Brain non-interference guard (source-level):** a test that fails the build if any `memory_*`
  tool is routed to a compressor, plus assertion that memory outputs pass byte-identical. (Same
  guard-test pattern as `noWholeFileJsonlRead` / `noMainThreadInstruments`.)
- **Fail-open mutation test:** force a compressor to throw → dispatch returns the original result
  unchanged (agent still gets correct data).
- **E2E token-spend proof:** run a real 100-hit `code_search` + large `read_output` through the
  *actual* `handleJsonRpc` dispatch, capture bytes-to-agent with vs without compression, assert a
  measured reduction (e.g. `code_search ≥ 80%`, overall net > 0). **This is the test that shows
  actual savings.**
- **Perf-budget test** (§7).
- Coverage: repo floor (lines ≥ 90, stmts/fn ≥ 89, branches ≥ 84); **new `headroom/` modules target
  100%** (pure fns make this achievable). Full suite green before tag (focused runs lie — v1.27.4).

## 10. Release

Build → **full** suite green → perf test green → savings-proof test green → bump `1.28.0` → push tag
→ `release.yml`, via the `release-notify` skill. Coordinate: do not tag until the in-flight v1.27.8
release has completed. MEMORY.md discipline: one index line for the minor.

## 11. Out of scope (explicitly deferred)

- Network proxy / live-zone compression / CacheAligner (Phase 2, opt-in "aggressive mode").
- AST-aware code compression and prose ML compression (Kompress).
- Compressing non-Termpolis (native Claude Code Read/Bash/Grep) traffic.
