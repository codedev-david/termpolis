# Token Maximization in Termpolis — Model Broker + Memory Economics

**Date:** 2026-06-13
**Author:** Claude (autonomous session) for David
**North star:** Help users who burn through their token/usage budget fast spend *far*
less while still getting amazing results. Two levers: (1) run the **cheapest viable
model** per task, and (2) **recall instead of re-derive** via the memory brain.

This doc records what shipped in this change, the honest token economics of the
memory brain, how the design aligns with David's **Memex** approach, and the
concrete path to take it *beyond the swarm* (the common single-agent case).

---

## 1. What shipped in this change (swarm model broker)

Termpolis orchestrates **CLI agents** (Claude Code, Codex, Gemini, Qwen) — it does
not call model APIs directly. So "brokering a model" = passing a validated
`--model <alias>` to the agent CLI it launches. Three pieces, all unit-tested:

- **`src/renderer/src/lib/modelBroker.ts`** — the pure brain. A per-agent tier
  registry (`AGENT_MODEL_TIERS`) and the rules:
  - `economy → haiku` (claude-haiku-4-5, ~$1/$5 per MTok)
  - `standard → sonnet` (claude-sonnet-4-6, ~$3/$15)
  - `premium → opus` (claude-opus-4-8, ~$5/$25)
  - `recommendTier({complexity, tokenIntensity})`: complexity ≥4 → premium (never
    downshift hard work), ≤2 → economy, 3 → economy when token-heavy else standard.
  - `resolveModelFlag`, `tierCostRatio`, `estimateSavingsPct`, `brokerModel`.
  - Cost weights are the output-price ratio to Opus: economy 0.2, standard 0.6,
    premium 1.0 → **~80% / ~40% / 0% token-cost savings** vs. always-Opus.
- **`src/main/agentCommandSanitizer.ts`** — the **security boundary**. The swarm
  conductor may now append exactly one strictly-validated `--model <opus|sonnet|
  haiku>` to a Claude command; everything else (`-p`, `--sandbox`, prompts, shell
  injection) is still stripped, and the command is **rebuilt from the trusted base**
  so nothing can ride along. `AGENT_MODEL_ALIASES` is the authoritative allowlist
  (Claude only today). Adversarially tested (injection, glued aliases, `--model=`,
  unknown aliases, non-Claude agents).
- **`src/renderer/src/lib/conductorPrompt.ts`** — STEP 4 now tells the conductor
  (which *is* an AI) to pick a cheaper model for the simpler subtasks. This is the
  "the AI suggests a lesser model and Termpolis acts on it" behaviour, scoped to the
  swarm. Absent a `--model`, behaviour is identical to before (no regression).

**Net effect today:** in a swarm, the conductor downshifts simple/boilerplate
subtasks to Haiku/Sonnet and keeps Opus for the hard parts — real savings, enforced
safely.

---

## 2. Does the shared memory actually save tokens? (honest answer)

**Short answer: yes, *conditionally* — and the code does not measure it.**

Evidence (`src/main/swarmMemory.ts`, `contextPrimer.ts`, `index.ts`,
`localEmbedder.ts`):

| Thing | Reality |
|---|---|
| Hot window cap | **500,000 entries** (`swarmMemory.ts` `DEFAULT_MAX_ENTRIES`), not tokens. 16 KB/entry content cap. ~0.75–1 GB RAM when full. |
| Recall injected on launch (`memory_primer`) | ~40 entries × ≤600 chars ≈ **~6k prompt tokens** (cap 100 entries). |
| Mid-session `memory_search` | default 10 results ≈ **~1–2.5k tokens**. |
| Stored on disk | append-only JSONL, effectively unbounded; only the 500k-entry RAM index is capped. At a full window that's on the order of **hundreds of millions of tokens** of *stored* text (never sent to a model at once). |
| Embeddings | **local WASM (bge-small), 0 API tokens, ~free.** |
| Token accounting | **None.** No "tokens saved" metric anywhere. |

**The economics:** recall *costs* ~6–9k tokens/session to inject, and *saves* tokens
only when it prevents more expensive re-work (re-reading files, re-exploring,
re-deriving a prior solution — easily 5k–50k tokens). So it **breaks even after
avoiding ~2k tokens of re-work** and is net-positive whenever a relevant memory
replaces real re-derivation. It is **not** a guaranteed cost-cutter, and it can be
net-negative if it injects 6k tokens of irrelevant context. The honest framing for
users: *memory trades a small, bounded recall cost for avoiding unbounded
re-derivation* — usually a win, but worth measuring (see Phase 3).

**Key correction to any "memory saves tokens" marketing:** today it's a *developer
convenience* (hold context across sessions). To make it a *provable* token-saver we
need accounting (Phase 3) and tighter, more relevant recall.

---

## 3. Alignment with Memex (David's existing idea)

Memex (`brain/src/memex/llm/`) already does cost-aware model routing, and its
vocabulary maps 1:1 onto this broker:

| Memex | Termpolis broker | Notes |
|---|---|---|
| `claude_cheap → Haiku` | `economy → haiku` | transforms / boilerplate |
| `claude_compose → Sonnet` | `standard → sonnet` | the default lane |
| `claude_heavy → Opus` | `premium → opus` | refactor / debug / architecture |
| Router decides **before** the call (regex + tiny Haiku classifier) | Conductor decides per subtask | Memex's pre-call routing is more reliable than asking the worker to self-assess |
| Reactive **429 downgrade** Opus→Sonnet→Haiku (`claude.py`) | *not yet* | high-value, see Phase 2 |
| `memex spend --days 30` cost tracker | *not yet* | see Phase 3 |
| Prompt caching (repeat turns ~10%) | inherited from the agent CLIs | |

**Important nuance David raised** ("use a lesser model *if the AI model suggests
this*"): Memex deliberately does **not** let the worker model self-suggest a
downgrade — it routes *before* calling. That's more reliable (no wasted premium call
to decide it should've been cheap). Termpolis's swarm conductor is the equivalent
"router that is itself an AI." We should keep the *decision before the expensive
call*, and only use an agent-emitted hint as a secondary signal.

---

## 4. Beyond the swarm — the plan for the common (single-agent) case

Most users run **one** Claude Code agent, not a swarm. That's where the token bleed
is worst, so it's the highest-value place to broker. Phases, in priority order:

### Phase 2a — Per-launch model selection (single agent) ← do next
- Add `model?: 'opus' | 'sonnet' | 'haiku'` to the `AIProfile` type and a small
  picker in the profile/launch UI (the AIProfiles command field already hints
  `claude --model opus`). For built-in Claude, default empty (Opus).
- `launchAgentProfile` appends `--model <model>` for Claude when set — mirrors the
  existing `--append-system-prompt-file` injection. **No sanitizer involved** (it's
  the user's own non-swarm launch).
- Optional global **"Economy mode"** default (e.g. Sonnet) so one toggle downshifts
  every Claude session. This alone can cut a heavy user's spend ~40%.
- Surface `estimateSavingsPct` next to the picker ("Sonnet ≈ 40% cheaper than Opus").

### Phase 2b — Reactive downgrade on limits (Memex parity)
- When an agent hits a usage/rate ceiling, suggest/relaunch at the next tier down
  (Opus→Sonnet→Haiku), like Memex's `_downgrade_model`. Termpolis can detect this
  from agent output (the egress/efficiency watchers already parse output) and offer
  a one-click "continue on Sonnet".

### Phase 3 — Spend & savings tracking (make it provable)
- A `memex spend`-style panel: per-model, per-session token + dollar spend, and
  **estimated savings vs. always-Opus** (the broker already computes the ratio).
  `efficiencyAnalyzer.ts` + `costTracker.ts` already collect tokens in/out — extend
  them to attribute by model and show the running savings. This is what turns "we
  think it saves tokens" into a number the user can see.
- Add the missing **memory ROI**: count when a `memory_search`/primer result was
  actually used and estimate the re-work it replaced.

### Phase 4 — Extend model control to the other agents
- Validate the `--model`/`-m` flags + model names for Gemini, Codex, Qwen and add
  them to `AGENT_MODEL_ALIASES` (the sanitizer) and `AGENT_MODEL_TIERS` (the broker).
  Claude-only today on purpose (known-safe).

### The "AI-suggested downgrade" channel (David's phrasing), done right
- Primary: decide **before** the expensive call (router/conductor) — already done
  for the swarm; Phase 2a does it for single agents via explicit choice.
- Secondary: let an agent emit a structured hint (e.g. a line like
  `TERMPOLIS_MODEL_HINT: haiku`) that Termpolis parses and applies on the *next*
  turn/subtask. Cheap to add once Phase 2 exists; never let it *upgrade* without a
  reason, and always validate the alias through the broker/sanitizer.

---

## 5. Security & guardrails
- The sanitizer is the single enforcement point for swarm `--model`; only the exact
  `opus|sonnet|haiku` enum survives, command rebuilt from the trusted base.
- Single-agent model flags are the user's own choice (no sanitizer needed) but should
  still be constrained to the known aliases in the UI.
- Never downshift correctness-critical work automatically — `recommendTier` keeps
  complexity ≥4 on premium by design.

---

## 6. Context economy — shipped this build (token-window savings)

The recall path now injects **signal, not noise**, with a safety floor so it never
starves the agent (the "don't shoot ourselves in the foot" guardrail we discussed):

- **`src/main/memoryEconomy.ts`** (pure, fully tested): `estimateTokens`,
  `gateByScore` (relevance cutoff WITH a floor + cap), `dedupeHits`,
  `truncateContent`, `summarizePrimerCost`, and a `TtlLruCache` (built + tested,
  wired into the search path in the next build).
- **`contextPrimer.ts`**: now **over-fetches** candidates (4× the inject limit,
  capped at 100) then **gates** them — drops sub-0.25 similarity noise but always
  keeps a floor of the top hits — and **dedupes** + **truncates**. It records the
  **injected token cost** (`getLastPrimerCost`) so tuning is measurable (lever C),
  and the closing line now pushes **search-first** ("your local memory search is
  fast and offline: call memory_search before re-deriving") — Memex's single
  biggest lever.

Net: when little is relevant the primer shrinks toward only what matters; when lots
is relevant the floor + cap keep it useful. Measured, gated, never-starving.

**Memex-informed (`brain/src/memex/...`):** Memex's speed comes from hybrid
keyword+vector search, **pre-filtering before KNN**, an **LRU+TTL result cache**,
and a **search-first** system-prompt convention. Termpolis already has HNSW
(sub-linear) + local embeddings; we ported the *ideas* in-memory (no SQLite/FTS5
dependency): the cache utility is built+tested, and search-first guidance is in the
primer. Hybrid keyword+vector scoring and wiring the cache into `memorySearch` (with
write-invalidation) are the next search-speed step.

## 7. Connected memory / knowledge graph — next major phase

David's vision: Termpolis "learns and builds connections like an LLM internally" so
agents solve tasks with knowledge *outside the model's training*, fast.

**Head start:** Termpolis's **HNSW index is already a connection graph** — every
memory is linked to its nearest neighbors. So *implicit* associative recall exists
today; the search/recall work above makes it fast and clean. Two layers remain:

- **Layer 1 (implicit, exists):** similarity links via HNSW/vectors. Expose a
  `memory_related(id|query)` 1-hop traversal so an agent can ask "what connects to
  this?" — a thin wrapper over the existing vector search. Cheapest first step.
- **Layer 2 (explicit, the build):** a typed knowledge graph — edges like
  `bug → solved-by → fix`, `decision → supersedes → decision`, `file → part-of →
  feature` — accumulating as work happens. Components: an edge store (id→id + typed
  relation + weight, persisted alongside the JSONL), lightweight relation extraction
  on write (link a new memory to its top-K neighbors + named entities), an n-hop
  typed traversal API, and a `memory_graph` MCP tool the agent uses to follow
  chains. Over time: more memories + denser edges = faster recall of out-of-training
  knowledge — exactly the goal.
- **Honest framing:** an LLM's "connections" are learned weights, not a literal
  graph; but the *intent* (recall by association) is what a graph/HNSW delivers —
  and it's inspectable and grows with the user's real work instead of freezing at a
  training cutoff.

## 8. Status
- **Shipped & tested in v1.14.0:** swarm model broker; voice tap-or-hold +
  rebindable send key; sidebar dropdown clamp; context-economy (relevance-gate +
  floor + dedup + truncate + token accounting + search-first), Memex-informed.
- **Shipped & tested in v1.14.1:** single-agent **model picker** (per-profile launch
  `--model` + a live `/model` hot-swap from the terminal header + savings hints —
  cheaper for routine work, Opus for the hard parts); the **`TtlLruCache` search
  cache** (write-invalidated, so repeats are instant and never stale); and
  **`memory_related`** — the 1-hop connected-memory traversal (MCP tool + function),
  step 1 of §7.
- **Designed, not yet built:** reactive 429-downgrade, spend/savings panel, hybrid
  keyword+vector scoring, externalize-big-cold-artifacts, and the explicit typed
  knowledge graph (§7, Layer 2).
- **Recommendation:** next, the typed **knowledge graph** (§7 Layer 2) — edges that
  accumulate as work happens (`bug → solved-by → fix`) — building on `memory_related`.
