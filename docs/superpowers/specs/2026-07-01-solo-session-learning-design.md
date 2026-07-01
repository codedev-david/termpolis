# Solo-Session Learning — design spec

**Date:** 2026-07-01
**Ships as:** v1.17.2
**Status:** implemented + shipped (v1.17.2)

## Problem

The Mneme learning brain (v1.17.0/1.17.1) only *learns* — distills procedural/semantic
lessons and records self-competence — when a **swarm task** completes
(`index.ts:1579`, `reflectOnTask` → `onTaskComplete`, `source: 'swarm'`). Individual
(non-swarm) agent terminals never trigger reflection. Because most real usage is solo
agent terminals (swarm is cumbersome), the store accumulates episodic transcript/code
memory but distills **zero lessons** and records **zero outcomes**. Consequence, verified
live: `memory_anticipate` → `[]`, `memory_pool` → `[]`, `memory_selfcheck` → `unproven`.

The learning engine is already **source-agnostic**: `assembleEpisode()`,
`distillEpisode()`, `groundEpisode()`, `recordOutcome()` don't care whether the episode
came from a swarm or a solo terminal. Only the **trigger** and **episode-from-transcript
assembly** are missing.

## Goal

Make the learning loop fire from **solo agent terminals** — Claude Code, Codex, Gemini
CLI, Qwen Code — with zero user ceremony, so a solo user's brain learns and the
cross-agent learning tools (`memory_pool`, `memory_anticipate`, `memory_selfcheck`)
return real data.

## Non-goals

- No change to swarm reflection (keep `onTaskComplete` behavior intact).
- No model-based distillation by default (deterministic zero-token stays the default;
  the Haiku distiller seam remains opt-in/future).
- No new UI surface beyond one Settings opt-out toggle.

## Trigger (decided)

**Idle-settle + flush-on-close.** The renderer hook debounces the agent terminal's
output; ~60s after an activity burst settles (a natural "task pause") it fires a
reflection pass on the transcript delta since the last pass. It also flushes on terminal
close (hook cleanup). Rationale: approximates "a task just finished" with no explicit
signal, learns incrementally (crash-safe — mid-session passes capture most learning),
and avoids arbitrary mid-task fragmentation.

## Components

### New: `src/main/mnemeSession.ts` (pure, model-free — mirrors `mnemeEpisode.ts`)
- `sessionDelta(turns, cursor)` — given parsed transcript turns and a per-terminal
  cursor (last-reflected turn count + content hash), return the **fresh** turns since
  last reflection (empty if nothing new). Content-hash based so re-reads are no-ops.
- `inferOutcome(turns)` — conservative classification reusing the ERROR/FIX signal
  vocabulary: tail shows an unresolved error → `{kind:'error', success:false}`; tail
  shows a fix / "works now" / tests-pass → `{kind:'test'|'manual', success:true}`;
  otherwise `undefined` (→ no competence recorded). High precision over recall.
- `buildSessionEpisode({id, project, source, turns, outcome})` — thin adapter to
  `assembleEpisode` with `source = <agentId>`.

### New: `onSessionEpisode(episode, deps)` in `src/main/mnemeReflex.ts`
- Sibling to `onTaskComplete`. Records competence **only** when `episode.outcome` is
  defined (a confident signal) — unlike swarm which always records. Then
  `groundEpisode` (distill + write). Returns `{fired, lessons, written}`.

### New: main IPC `memory:reflect-session`
- Args `{terminalId, cwd, agent}`. Reads the active transcript via `readActiveTranscript`
  (index.ts:737 pattern), computes the delta via `mnemeSession`, runs `onSessionEpisode`,
  advances the per-terminal cursor. Fully guarded / fire-and-forget (never breaks the
  terminal). Deterministic distiller by default.

### New: renderer hook `useSessionReflection(terminalId, detectedAgent, cwd)`
- Lives beside `useAutoPrimer`/`useCompactionReprimer`; wired in `TerminalPane`.
- Debounce (~60s) keyed off terminal output/activity; on settle → call the IPC.
- Cleanup (unmount/close) → final flush IPC.
- Gated on `isSoloLearningEnabled()` (default ON) and a non-null `detectedAgent`, so it's
  automatically cross-agent.

### New: Settings toggle
- `termpolis.memory.learnFromSessions` (localStorage, default ON — opt-out), rendered in
  `SettingsPane` next to the auto-primer toggle. `isSoloLearningEnabled()` mirrors
  `isAutoPrimerEnabled()`.

### Per-terminal cursor state (main)
- A `Map<terminalId, {turns:number, hash:string}>` so each pass only reflects new turns.
  In-memory (a missed cursor just re-hashes; the content-addressed store dedups any
  overlap, so at worst a no-op).

## Data flow

```
agent output settles (~60s) ─▶ useSessionReflection ─▶ IPC memory:reflect-session
   └─ or terminal close ──────▶ (flush)                    │
                                                           ▼
              readActiveTranscript(cwd/agent) ─▶ mnemeSession.sessionDelta(cursor)
                                                           │ fresh turns?
                                                    yes ──▶ inferOutcome ─▶ buildSessionEpisode
                                                           ▼
                                        onSessionEpisode ─▶ [competence if outcome]
                                                         └▶ distillEpisode ─▶ groundEpisode ─▶ store
                                                           ▼
                              memory_pool / memory_anticipate / memory_selfcheck now populated
```

## Error handling

Every layer is best-effort and guarded (matches existing `reflectOnTask`): a transcript
read failure, distiller throw, or store-write failure must never break or delay the
terminal. Failures are swallowed; the cursor only advances on a successful pass.

## Testing (TDD, repo coverage gates: lines ≥90 / branches ≥84)

- `mnemeSession.test.ts` — delta/cursor (fresh vs no-new vs overlap), `inferOutcome`
  (error / fix / neutral), episode assembly, empty/trivial gating.
- `mnemeReflex` — extend tests: `onSessionEpisode` records competence only on a confident
  outcome; distills + grounds; is a no-op on a non-reflectable episode.
- IPC + hook — follow existing `aiProfiles`/`useAutoPrimer` test patterns (debounce fires
  once per settle; cleanup flushes; disabled toggle → no call; non-agent → no call).
- Regression: existing swarm `onTaskComplete` path unchanged (348-test suite stays green).

## Rollout

Deterministic + default-ON + opt-out. Ship as v1.17.2 (version bump + `v1.17.2` tag →
release.yml). Proof: run a solo Claude terminal in a repo, let it settle, then
`memory_selfcheck`/`memory_pool`/`memory_anticipate` return real data.

## Follow-up: Qwen (v1.17.3)

Qwen Code writes no parseable on-disk transcript (undocumented/unstable format; confirmed:
`~/.qwen/` holds only settings). So the disk-transcript reflection above can't cover Qwen.
Instead — since Qwen is MCP-native — its launch primer (`buildPrimerPointer(cwd, selfRecord)`,
wired in `useAutoPrimer` for detected Qwen agents) asks Qwen to call `memory_write` itself
with a concise lesson at task end. Higher fidelity (the agent summarizes its own work),
reuses the existing primer injection, and is gated by the same auto-primer setting. Result:
all four agents contribute learning — Claude/Codex/Gemini via automatic disk-transcript
reflection, Qwen via MCP self-record.
