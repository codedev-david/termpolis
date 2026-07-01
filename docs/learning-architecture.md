# Termpolis Learning Architecture — "Mneme"

> The plan to make Termpolis's local memory *learn*, not just retrieve — a cross-agent
> cognitive layer over Claude Code / Codex / Gemini CLI / Qwen Code.
> Grounded in the code as of 2026-07-01 (recon of swarmMemory, memoryGraph, memoryEconomy,
> memoryIndexer, conversationIngest, contextPrimer, mcpServer, index). Line numbers are
> recon-time anchors and will drift — re-grep before editing.

## 0. North star

Turn the brain from **perceive + retrieve** into the full loop:

**Perceive → Reflect → Consolidate (sleep) → Retrieve (learned + proactive) → Internalize**

persisted as one continuous, cross-agent identity. The agent's model is the *rented cortex*;
Mneme is the rest of the brain.

| Brain organ | Function | Mneme module | Phase |
|---|---|---|---|
| Neocortex | fluid reasoning | the agent's LLM (untouched) | — |
| Hippocampus | episodic→semantic consolidation | `mnemeReflect` + `mnemeConsolidate` | P1/P2 |
| Prefrontal cortex | metacognition / self-competence | `mnemeMeta` | P1 |
| Cerebellum / basal ganglia | procedural skill memory | `procedural` memoryType + skill lessons | P1 |
| Limbic / drive | curiosity, salience | `mnemeCuriosity` | P5 |
| Society of mind | debate, pooled learning | swarm + shared brain | P5 |

## 1. Hard design constraints (from recon — do NOT fight these)

1. **Store is append-only, grow-only CRDT; records are immutable.** `memoryWrite` early-returns
   on a content-hash hit and never edits (`swarmMemory.ts:457-461`). → All *mutable* learning
   state (importance, useCount, lastUsedTs, competence, supersession) must be a **replayed delta
   control-line** — mirror `{reinforce:[{id,used,ts}]}` (`swarmMemory.ts:1202`, parsed
   `parseShardLine:156-170`, replayed `reloadFrom:206-215`) — or a **graph edge**. Never a record edit.
2. **JSONL keeps unknown fields** (parse keeps the whole object; persist stringifies the whole
   object) — new optional fields are backward-compatible with no migration. **The write literal at
   `swarmMemory.ts:463-474` is the choke point**: a field persists only if added there (+ `WriteInput`).
3. **No in-process LLM.** Every model call runs through the `claude` CLI in a node-pty terminal;
   the only main-process model is the local ONNX embedder. Reflection therefore uses a **pluggable
   distiller**: deterministic-extractive (default, zero-token, unit-testable) + optional headless
   `claude -p --model haiku --dangerously-skip-permissions` (economy alias) behind an injectable seam.
4. **Graph nodes are bare id-strings — there is no node object.** Represent entities and summaries
   as **typed memory entries** (`memoryType:'entity'|'summary'`) so every existing resolver keeps
   working. Relations (`solves`, `caused-by`, `superseded-by`) already exist but are **inert** — Mneme
   adds the behavior (scoring + filtering).
5. **Importance must fuse multiplicatively and capped** (mirror `fuseImportance`,
   `memoryEconomy.ts:72-77`) so it can never lift a zero-relevance hit over the gate
   (`memorySearch:874-881`, `MIN_RELEVANCE=0.25`).
6. **Injected clock (`now` param), never inline `Date.now()`** in scored logic (the
   memoryEconomy/memoryGraph convention) — required for deterministic tests.
7. **No edge GC** — supersession/consolidation must add edge pruning or tolerate dangling edges
   (they're dropped at resolve time).
8. **Coverage gates (Windows CI): lines 90 / functions 90 / branches 85 / statements 90.** Every new
   `src/main/**/*.ts` is auto-included. Keep learning logic in **pure injectable modules** (like
   `contextPrimer`/`memoryEconomy`), tested model-free via `_setEmbeddingsAvailable(false)` and `vi.fn` injection.

## 2. Shared data model

### 2.1 MemoryEntry additions
Add to `interface MemoryEntry` (`swarmMemory.ts:24-36`), the write literal (`463-474`), `WriteInput`
(`412-421`), and the renderer mirror (`src/renderer/src/types/index.ts:275-285`):
```ts
memoryType?: 'episodic' | 'semantic' | 'procedural' | 'entity' | 'summary' // cognitive facet — ORTHOGONAL to `kind`
importance?: number      // 0..1 base salience at write (reflection sets this high for lessons)
originEpisode?: string   // the task/session id a lesson was distilled from
```
`kind` stays the content/source facet; `memoryType` is the cognitive facet. Defaults: ingested
transcript/code = `episodic`; distilled lesson = `semantic`|`procedural`; entity/summary explicit.
Thread `memoryType` deliberately through the five `kind`-keyed sites (rank priors, AUTO_LINK_KINDS,
isForgettable, primer isConversation) — do not overload `kind`.

### 2.2 Mutable learning state → `{learn}` delta control-line
Mirror `{reinforce}`. New control line appended to the device shard and replayed on reload:
```
{"learn":[{"id":"mem-…","useCount":1,"lastUsedTs":123,"importanceDelta":0.1,"competence":{…}}]}
```
Parsed in `parseShardLine`, replayed into new in-memory maps in `reloadFrom`; consumed as one new
**capped multiplicative** term in the `memorySearch` rank decoration (`~879`).

### 2.3 Lesson — reflection output (pure type, `mnemeReflect.ts`)
```ts
interface Lesson {
  memoryType: 'semantic' | 'procedural'
  kind: 'decision' | 'fact' | 'note'
  content: string                                   // the distilled, reusable statement
  problem?: string; solution?: string; gotcha?: string
  entities: string[]                                // files/functions/features/errors referenced
  importance: number                                // 0..1
  links: { to?: string; relation: string }[]        // solves / caused-by / part-of / supersedes …
}
```

### 2.4 Episode — reflection input
```ts
interface Episode { id: string; project?: string; source: string; turns: EpisodeTurn[]; outcome?: Outcome }
interface Outcome { kind: 'test' | 'commit' | 'error' | 'manual'; success: boolean; detail?: string }
```

### 2.5 CompetenceRecord — metacognition (`mnemeMeta.ts`)
```ts
interface CompetenceRecord { domain: string; attempts: number; successes: number; lastTs: number; confidence: number }
```
`domain` = project | entity | task-type. `confidence` = smoothed success rate (Wilson lower bound).
Persisted via `{learn … competence}` deltas.

## 3. Phases, modules, acceptance

### P1 — Reflect + Ground + Metacognize  → this is the **v1.17.0** milestone
- **`mnemeReflect.ts`** (pure, injectable): `distillEpisode(episode, {llm?, now}): Promise<Lesson[]>`.
  Deterministic extractor (error→fix pairs, decisions, gotchas from turn structure) + optional
  `llm(prompt)` enhancer; importance from outcome + signal density. Unit-tested model-free.
- **`mnemeEpisode.ts`** (pure): assemble an `Episode` from a transcript / swarm task result; boundary
  detection helpers.
- **`mnemeDistiller.ts`**: headless `claude -p --model haiku` via `execFile` (mirror `codeIngest.ts:21`)
  behind an injectable seam; falls back to the extractive path.
- **`mnemeGround.ts`** (consequence loop): capture test/commit/error outcomes (the `runTests`/`gitCommit`
  IPC already exist) → attach to lessons as `solves`/`caused-by` edges + importance/competence deltas.
  Confirmed-good → importance↑; confirmed-bad → importance↓ + `superseded-by`.
- **`mnemeMeta.ts`** (pure): fold outcomes into `CompetenceRecord`; new MCP tool `memory_selfcheck(domain)`
  → confidence + known failures; inject one competence line into the primer.
- **Wiring**: fire-and-forget `onTaskComplete` at `swarmManager.updateTask` (`86-97`) + the `compaction`
  path at the central `subscribeEvents` block (`index.ts:1674-1689`); `.unref()` + debounce discipline.
- **Acceptance (all required to tag 1.17.0):** an error→fix episode yields a stored `procedural`
  lesson; a later *paraphrased* query recalls it; a confirmed-bad outcome demotes/supersedes it;
  competence updates from outcomes. Full suite green, coverage ≥90/85, lint/build/typecheck clean,
  plus a real end-to-end proof (model-gated) that a distilled lesson is recalled and applied later.

### P2 — Sleep (consolidation)  `mnemeConsolidate.ts`
Third indexer cadence (extend `startIndexer` wiring, `index.ts:1613-1640`): semantic near-dup merge
(reuse `diversifyHits`), cluster→summary (generative → `memoryType:'summary'` + `part-of` edges),
**activate the dormant `memoryForget`** (`swarmMemory.ts:1150`) with importance×recency×usage decay,
supersession resolution (add filtering behavior + edge pruning/GC). Archival, never destructive.

### P3 — Connect (causal/temporal graph + hybrid retrieval)
Entity extraction → `entity` nodes + `refers-to`/`part-of` edges; per-relation causal priors in
`memoryGraphQuery` (`swarmMemory.ts:998`); temporal validity fields on `MemoryEdge` (append-safe) +
supersession filtering; flip `graphFusionEnabled` (`swarmMemory.ts:723`) on with tuning + a recall test.

### P4 — Learn-to-retrieve + proactive
Extend `memoryFeedback` to actually use its `query` arg → learned utility re-rank (new capped term);
proactive pre-surface by wiring the redundancy watcher → memory injection before re-derivation;
optional local re-ranker head.

### P5 — Society + Curiosity + Identity
Cross-agent debate/critique over the shared brain (lessons tagged by source diversity); curiosity
(detect low-competence/high-frequency domains → propose exploration); continuous identity (an
`identity` memoryType + long-horizon goal store, synced across machines).

## 4. Test strategy
- Each organ's logic is a **pure injectable module** in `src/main`, tested like
  `tests/electron/contextPrimer.test.ts` (`vi.fn` deps, no electron/fs, injected `now`, injected `llm`).
- Store integration tested like `tests/electron/swarmMemory.test.ts` (tmp dir, `_resetForTests`,
  `_setEmbeddingsAvailable(false)`, delta-line reload assertions).
- MCP tools tested like `tests/electron/mcpMemoryRoundtrip.test.ts` (`executeTool` + partial handlers).
- IPC tested like `tests/electron/mainProcess.test.ts` (captured handler map, `{success,data}` envelope).
- End-to-end recall of a distilled lesson behind `describe.skipIf(!hasBundledModel)` (package-verify CI).

## 5. Token economy
Reflection default = deterministic (0 tokens). LLM enhancement = cheapest tier (haiku), only at task
boundaries, and **net-negative** because the lessons it stores prevent re-derivation later.
Consolidation compresses raw episodes into summaries (fewer tokens injected). Everything is opt-in and
measured (recall utility, re-derivations avoided) — the "receipt" that proves the savings.

## 6. Build order
P1 (→ **v1.17.0**) → P2 → P3 → P4 → P5. Each phase ships only when its tests are green and the gates
hold. The version tags to 1.17.0 the moment P1 is provably alive and learning — not before.
