# Termpolis Headroom Proxy — Design Spec (v1.29.0)

**Status:** Approved (David, 2026-07-20, full autonomy). Ship as minor **v1.29.0**.
**In-house.** No external deps (no headroomlabs package, no Python/HF model). Native TypeScript.

## 1. Goal

Cut the tokens Claude Code actually sends to Anthropic — the **native Read/Bash tool-results and pasted/returned images** that (measured across 484 real sessions) are 90%+ of token spend and 0% reachable by the v1.28.1 MCP-output compressor. Lower burn rate → more work per session before compaction and rate limits. Proven feasible + cache-safe by two spikes (Gate 1: subscription OAuth survives a local proxy; Gate 2: deterministic live-zone compression preserves the prompt cache while cutting ingested tokens ~51%).

## 2. Decisions (locked)

- **ALWAYS-ON for Claude Code. NOT optional.** No user "disable" toggle. Every Claude terminal launches through the proxy.
- **Automatic safety fallback (not a user setting):** if the proxy process is unhealthy at launch, that terminal launches **direct** (no `ANTHROPIC_BASE_URL`), so Claude Code is never *broken* by the feature — worst case is "no compression this session."
- **Code/Read compression = aggressive + `retrieve_full`** safety net. **Bash/logs = aggressive. Images = downscale+re-encode.**
- **Claude-only.** Codex on ChatGPT-subscription ignores `OPENAI_BASE_URL` and bypasses the proxy (proven) — out of scope.
- **Separate process** (Electron `utilityProcess`, same pattern as the memory brain) — the main thread never does compression work.

## 3. Architecture

```
Claude Code (spawned by Termpolis, env ANTHROPIC_BASE_URL=127.0.0.1:PORT)
      │  POST /v1/messages (OAuth Bearer, streaming)
      ▼
headroomProxy  (utilityProcess, local HTTP server on 127.0.0.1:PORT)
   ├─ parse body → rewrite tool_result text + image blocks (deterministic, fail-open)
   ├─ forward to https://api.anthropic.com (headers/auth/betas untouched)
   ├─ stream SSE response back UNCHANGED
   └─ parse real `usage` from response → record savings (cache_creation/input deltas)
      ▼
Anthropic
```

- Main process **supervises** the proxy: spawn on app ready, health-check, **auto-restart on crash** (same port), track health for the launch gate.
- Launch wiring: when a Claude profile launches AND the proxy is healthy, inject env: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1`, `ENABLE_TOOL_SEARCH=true`. Non-Claude agents: unchanged.

## 4. Modules

**New child entry:** `src/main/headroomProxy/proxyMain.ts` — the utilityProcess entry: HTTP server + request rewriter + upstream forwarder + streaming + usage parsing. Reports savings to main via `process.parentPort` messages.

**New main-side:** `src/main/headroomProxy/proxySupervisor.ts` — spawn/health/restart/port; `getProxyEnv()` returns the env map when healthy (else null); receives savings messages → ledger.

**Reused/extended from v1.28.1 (`src/main/headroom/`):**
- `compressors.ts`, `compactText.ts`, `config.ts` (thresholds), `ccrStore.ts`, `savingsLedger.ts`, `retrieveFull`. The proxy's text compression calls the SAME deterministic compactors.

**New compression:**
- `src/main/headroomProxy/wireCompress.ts` — pure: `rewriteMessagesBody(json) → { body, stats }`. Walks `messages[].content[]`; for `tool_result` text → deterministic compact (aggressive); for `image` blocks → `compressImage`. Leaves `system`, `tools`, `tool_use`, `thinking`, `cache_control`, and ALL other fields byte-identical. Fail-open: on any anomaly, return the original body untouched.
- `src/main/headroomProxy/imageCompress.ts` — `compressImageDataUrl(base64, mediaType) → { base64, mediaType, changed }`. Decode → downscale to ≤1568px long edge → re-encode (PNG kept for screenshots/UI; large photos → JPEG q80). Deterministic. Prefer Electron `nativeImage` (no native dep); **fail-open per image** (any error → original image untouched). Original cached in CCR for `retrieve_full`.
- `src/main/headroomProxy/usageParse.ts` — pure: parse Anthropic SSE (gzip/br/deflate aware) → `{ input_tokens, cache_read, cache_creation, output_tokens }`.

**Receipt/dashboard:** extend `savingsLedger` with a proxy channel recording REAL usage-based savings; extend `TokenSavingsSettings.tsx` with a **% tokens saved** view (session + cumulative, by type Bash/Read/image, cache-hit health). No disable toggle (always-on); read-only receipt.

## 5. Cache-safety invariants (proven + from Claude Code gateway docs)

1. **Deterministic compression** — same tool_result/image → byte-identical output every turn (this is *why* the cache holds; Gate 2 measured `cache_read` stable at ~80k, `nondet=0`).
2. Never reorder/merge the `system` array or the attribution block; never move `cache_control` markers.
3. Forward `anthropic-beta` header + matching body fields (e.g. `thinking`) together — never strip one.
4. Stream the response (never buffer to the client); parse a *copy* for usage.
5. A **build-failing determinism guard test**: re-compress the same input twice → assert identical bytes.

## 6. Reliability (always-on ⇒ must never break the agent)

- **Fail-open at every layer.** Body parse fail, unknown shape, compressor throw, image decode fail → forward ORIGINAL bytes. Never emit a corrupted request.
- **Supervised child**: crash → auto-restart within ~1s on the same port (Claude Code retries transient connection errors → a blip, not a break).
- **Health-gated launch**: proxy not healthy → launch Claude direct.
- **Stable by construction**: proxy holds no unbounded state; CCR is capped; per-request work is bounded; a hard body-size cap skips rewriting oversized bodies (forward as-is).

## 7. Testing (100%, hardcore)

- **Unit (pure, deterministic golden):** wireCompress (tool_result text compacted; image block compressed; `system`/`tools`/`thinking`/`tool_use`/`cache_control` byte-identical; unknown shape → passthrough), compactText/compressors (reused), imageCompress (deterministic bytes, dimension cap, token-estimate drop, fail-open on garbage), usageParse (gzip + br + plain SSE; missing usage → zeros).
- **Determinism guard (build-failing):** re-compress same body twice → identical.
- **Fail-open mutation:** force each stage to throw → assert original body forwarded, never throws.
- **Rewriter safety:** a corpus of realistic Anthropic request bodies (system array + betas + thinking + tool_use + tool_result(string|array) + image + cache_control) → assert only tool_result/image bytes change; everything else identical; valid JSON out.
- **Integration (mock upstream):** a local stub mimicking Anthropic SSE + usage → drive multi-turn → assert compressed bodies smaller, streaming passthrough intact, usage parsed, fail-open on malformed upstream.
- **Supervisor:** spawn → healthy; kill child → auto-restart + healthy again; unhealthy → `getProxyEnv()` returns null (direct launch).
- **Savings proof (automated):** replay the Gate-2 scenario against the mock upstream → assert measured token reduction with cache preserved.
- **Perf:** main-thread work per launch is O(1) (env map only); compression happens in the child.
- Full suite green (**not** focused — the v1.27.4 lesson), coverage gates (97/96/93/96), typecheck (node+web), lint clean, production build green.

## 8. Rollout

Commit incrementally to main. Update `README.md`, termpolis-web (`index.html` FEATURES + `docs.html`), then bump **1.29.0**, tag, watch BOTH pipelines to green (handle GitHub flakiness / ship clean patch if needed — the v1.28.0→.1 playbook), verify assets + release email. MEMORY.md: one line for the minor.

## 9. Out of scope

Codex/Gemini/Qwen proxying; ML/AST compression; compressing non-Claude traffic; a user disable toggle.
