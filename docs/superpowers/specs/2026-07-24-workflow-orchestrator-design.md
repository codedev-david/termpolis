# Workflow Orchestrator — Design Spec

**Date:** 2026-07-24
**Status:** Approved for planning (design locked in brainstorming)
**Supersedes:** the static `WorkflowTemplates` launcher (terminal-layout presets)

---

## 1. Summary

Upgrade Termpolis's "Workflow" feature from a **static terminal-layout launcher** into a
**Workflow Orchestrator**: a general-purpose, **local, deterministic** automation engine —
conceptually "n8n / GitHub Actions / Azure Logic Apps, but local, terminal-native, and
AI-agent-aware."

A user authors an ordered pipeline of typed **steps** (run a script, drive an AI agent, invoke a
tool, branch/loop), wires **gates** and **data flow** between them, and runs it. Steps execute in
**real Termpolis panes** the user can watch. There is **no LLM in the control flow** — the engine is
a deterministic step interpreter. Agents are things the engine *drives*, not the thing that decides
what runs next.

### Goals

- Author any end-to-end local process: test → AI-fix → re-test → commit → notify; build a Docker
  image and smoke-test it; run a Python ETL then email a report; run/compose an AI skill as a step.
- **Command** step is the universal "run anything" primitive (bash/zsh/pwsh/cmd, python, node,
  docker, git, any CLI) — inline text **or** a script-file path in the repo.
- Deterministic, inspectable, reproducible runs with captured exit codes / output / status.
- A **permanent sidebar section under Workspaces** listing saved + active workflows; active ones
  pulse; click to expand full steps + live progress.
- A **Design** surface (Azure-Logic-Apps-style trigger + action cards, inline "+" insertion) and a
  **Run** surface (progress timeline + live real panes).
- Definitions are **declarative YAML** under `<workspace>/.termpolis/workflows/` — versionable,
  diffable, hand-editable, and they ride the existing brain export/import.

### Non-goals (v1) / YAGNI

- **No AI-driven control flow.** (That is the existing Swarm/Conductor — complementary, not this.)
- **No cloud / remote execution.** Local only.
- **Triggers v1 = manual "Run" only.** Schedule / on-git-push / file-watch appear greyed in the
  trigger dropdown as roadmap, and are **not** built.
- **No parallel step execution.** v1 is a linear sequence with branch/loop/retry control. Fan-out is
  roadmap.
- **No visual drag-to-reorder** beyond insert / delete / move-up-down. Free-form canvas is roadmap.
- **No secrets vault** for workflows in v1 — steps read the same env the shell already sees. (The
  existing Commit/Push Secret Shield still guards anything a Command step tries to commit.)

---

## 2. Terminology

| Term | Meaning |
|------|---------|
| **Workflow** | A named, ordered list of steps + a trigger. Persisted as one YAML file. |
| **Step** | One typed unit of work: `command` \| `agent` \| `skill` \| `control`. Has a stable `id`. |
| **Trigger** | What starts a run. v1: `manual`. Roadmap: `schedule`, `gitPush`, `fileWatch`. |
| **Gate** | A step's `when:` condition; step runs only if it evaluates true (else `skipped`). |
| **Data flow** | Later steps interpolate `${steps.<id>.output \| .exitCode \| .status}`. |
| **Run** | One execution instance of a workflow: an ordered list of step results + overall status. |

---

## 3. Data Model

New first-class type `Workflow` (distinct from the legacy launcher `WorkflowTemplate`, which is
retired — see §8). Types live in `src/renderer/src/types/index.ts` (shared renderer/main via the
existing type-only imports).

```ts
export type WorkflowStepType = 'command' | 'agent' | 'skill' | 'control'
export type WorkflowTriggerType = 'manual' | 'schedule' | 'gitPush' | 'fileWatch'  // only 'manual' active in v1

export interface WorkflowTrigger {
  type: WorkflowTriggerType
  // roadmap fields (schedule cron, watch glob) parsed-but-ignored in v1
  config?: Record<string, string>
}

// Discriminated union on `type`.
export interface CommandStep {
  id: string
  type: 'command'
  name: string
  when?: string                 // gate expression; default = run if previous step didn't fail
  source: 'inline' | 'file'
  command?: string              // when source==='inline' (may contain ${steps.*} refs)
  scriptPath?: string           // when source==='file'; workspace-relative path to a script
  shell?: ShellType             // per-step shell; default = workspace/default shell
  cwd?: string                  // default = workspace cwd
  timeoutMs?: number            // default 600_000 (10 min), matches existing test-runner cap
  visible?: boolean             // true = spawn a watchable pane; false = headless exec (default true)
  continueOnError?: boolean     // default false
}

export interface AgentStep {
  id: string
  type: 'agent'
  name: string
  when?: string
  agent: 'claude' | 'codex' | 'gemini'   // roster per v1.30.3 (Qwen removed)
  prompt: string                          // may contain ${steps.*} refs
  cwd?: string
  idleMs?: number               // idle window that counts as "done"; default 8_000
  timeoutMs?: number            // hard cap; default 900_000 (15 min)
  doneMarker?: string           // optional sentinel; if set, "done" = marker seen (overrides idle)
  continueOnError?: boolean
}

export interface SkillStep {
  id: string
  type: 'skill'
  name: string
  when?: string
  tool: string                  // MCP tool name (e.g. 'memory_search', 'code_search') or skill id
  args?: Record<string, unknown>// values may contain ${steps.*} refs (string fields only)
  timeoutMs?: number            // default 120_000
  continueOnError?: boolean
}

export interface ControlStep {
  id: string
  type: 'control'
  name: string
  when?: string
  action: 'wait' | 'branch' | 'loop' | 'notify'
  // wait:   waitMs
  // branch: condition (expr) + goto (step id) when true, else fall through
  // loop:   over the immediately-preceding step: maxIterations + until (expr) OR retry-on-fail
  // notify: message (interpolated); surfaces a renderer toast / system notification
  config: Record<string, string | number>
}

export type WorkflowStep = CommandStep | AgentStep | SkillStep | ControlStep

export interface Workflow {
  id: string                    // stable slug, also the YAML filename
  name: string
  description?: string
  version: 1
  trigger: WorkflowTrigger
  steps: WorkflowStep[]
}
```

### Run state (ephemeral — not persisted in the definition)

```ts
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
export type RunStatus  = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface StepResult {
  stepId: string
  status: StepStatus
  exitCode?: number
  output: string                // captured (tail-capped, mirrors the 32 KB terminal buffer cap)
  startedAt?: number            // epoch ms, stamped in the main process
  endedAt?: number
  iteration?: number            // for loop steps
  error?: string
}

export interface WorkflowRun {
  runId: string
  workflowId: string
  status: RunStatus
  steps: StepResult[]           // one per executed step (loops append per-iteration)
  startedAt: number
  endedAt?: number
}
```

---

## 4. Storage Format

**Definitions:** one YAML file per workflow at
`<workspace>/.termpolis/workflows/<id>.yml`. Repo-local → versionable, diffable, hand-editable, and
carried by the existing brain export/import. Example:

```yaml
id: test-fix-commit
name: Test → AI-fix → Commit
version: 1
trigger: { type: manual }
steps:
  - id: test
    type: command
    name: Run unit tests
    source: inline
    command: npm test
    continueOnError: true          # we WANT to inspect a failure and branch on it

  - id: fix
    type: agent
    name: Ask Claude to fix failures
    when: steps.test.exitCode != 0
    agent: claude
    prompt: |
      The test run failed with:
      ${steps.test.output}
      Fix the failing tests, then stop.

  - id: retest
    type: command
    name: Re-run tests
    when: steps.test.exitCode != 0
    source: inline
    command: npm test

  - id: commit
    type: command
    name: Commit the fix
    when: steps.retest.exitCode == 0
    source: inline
    command: git commit -am "fix: workflow auto-repair"

  - id: done
    type: control
    name: Notify
    action: notify
    config: { message: "Workflow complete ✅" }
```

**Run history (optional, additive):** append-only JSONL at
`<workspace>/.termpolis/workflows/runs/<workflowId>.jsonl` (one line per finished run, tail-capped).
Live run state is in-memory in the renderer store; the JSONL is for "last run" recall across
restarts and is **not** required for v1 correctness (behind a small `writeRunLog` that no test
depends on for the happy path).

**Serialization decision (for review):** use the pure-JS **`yaml`** npm package (no native deps,
widely used) to (de)serialize. It preserves the hand-editable/comment goal that motivated choosing
YAML. **Alternative considered:** zero-dep JSON (`*.json`) — rejected as the default because it loses
comments and reads worse by hand, but it is the fallback if we want zero new dependencies. *This is
the one open dependency question flagged for the spec-review gate (§12).*

---

## 5. Execution Engine

New module `src/main/workflow/` (main process — it owns the PTYs and fs):

- `workflowEngine.ts` — the runner: sequential interpreter over `steps`, gate evaluation, variable
  interpolation, per-step dispatch, branch/loop/retry, cancellation, timeouts, run-event emission.
- `workflowExpr.ts` — **pure** expression + interpolation module (no I/O): evaluates `when:` /
  branch `condition` expressions and resolves `${steps.<id>.<field>}` references against accumulated
  `StepResult`s. Deliberately tiny + total (see §6 grammar) so it is trivially 100%-testable.
- `workflowStore.ts` — **pure-ish** load/save/list/delete of YAML files + schema validation
  (`validateWorkflow(obj): {ok, errors}`). fs calls isolated behind a thin injectable interface so
  the validator/serializer are unit-tested without disk.
- `workflowSteps.ts` — per-type executors behind a common `StepExecutor` interface, so each is tested
  in isolation with a fake substrate.

### Substrate reuse (confirmed in code, not new)

- **Command step** → `spawnTerminal(id, shell, cwd, onData, onExit)` (managed node-pty). Output is
  accumulated exactly like the existing `terminalOutputBuffers` (32 KB tail cap); `onExit` yields the
  exit code. `visible:true` attaches the pane to the Run view (a real terminal the user watches);
  `visible:false` runs headless (reusing the exit-code/output **capture mechanism** of the existing
  test-runner exec at `index.ts:2113` — but **not** its runner allowlist; Command steps are
  intentionally unrestricted per §9). Script-file (`source:'file'`) runs the file via the chosen shell
  (`bash script.sh` / `python script.py` inferred by extension, overridable).
- **Agent step** → spawn/reuse a Claude/Codex/Gemini pane, write the prompt, and detect completion
  with the existing **`agentStatusDetector`** (`idle` state held for `idleMs`) with a hard
  `timeoutMs` cap; optional `doneMarker` sentinel overrides idle when present. Captured output = the
  pane buffer tail.
- **Skill step** → call the in-process MCP tool handler (same `McpToolHandlers` the server dispatches
  through) or an agent skill; capture the structured result as `output`.
- **Control step** → pure engine-internal logic (no substrate): `wait` sleeps (via injected timer),
  `branch` jumps to a `goto` step id when its condition holds, `loop` re-runs the preceding step up
  to `maxIterations` until `until` holds (or retries on failure), `notify` emits a renderer toast /
  system notification.

### Run lifecycle & events

`startRun(workflow, ctx)` walks steps in order. For each step: evaluate `when` (skip → `skipped`
result), interpolate refs, dispatch to the executor, record a `StepResult`, then apply control flow.
A **failed** step (non-zero exit / agent timeout / tool error) stops the run unless
`continueOnError` (then it records `failed` but proceeds) — matching the YAML example's need to
branch on a failure. The engine streams events to the renderer over a dedicated IPC channel:
`run:started`, `step:started`, `step:output` (throttled chunks), `step:status`, `step:finished`,
`run:finished`. `cancelRun(runId)` kills any live PTY/agent pane and marks remaining steps
`cancelled`.

**Determinism guardrails:** timestamps are stamped in main via `Date.now()` (allowed there; the
engine is not a Workflow-tool script). No randomness in control flow. Same definition + same step
outputs ⇒ same path taken.

---

## 6. Expression Grammar (`when:` / branch conditions / interpolation)

Kept intentionally minimal + total so it is exhaustively testable and can never execute arbitrary
code (no `eval`).

**Interpolation:** `${steps.<id>.output}`, `${steps.<id>.exitCode}`, `${steps.<id>.status}`.
Unknown ids/fields interpolate to empty string (and are reported as a validation warning at author
time). Both `${...}` and `{{...}}` accepted (the mockup used `{{ }}`); normalized to one.

**Conditions:** a single comparison `LHS OP RHS` where
- `LHS` = a `steps.<id>.<field>` reference (or a literal),
- `OP` ∈ `== != < <= > >= =~` (`=~` = RHS is a **substring** match on LHS; case-sensitive, no regex
  in v1 — avoids ReDoS and keeps the evaluator total),
- `RHS` = number or quoted/bare string literal.
Plus the sugar `steps.<id>.ok` / `.failed` (exitCode == 0 / != 0). Default `when` when omitted:
"run unless a prior non-`continueOnError` step failed." **No boolean AND/OR in v1** (YAGNI; chain
gates across steps instead) — flagged as the deliberate simplification.

---

## 7. UI

### 7.1 Sidebar "Workflows" section (permanent, under Workspaces)

- New collapsible section header `WORKFLOWS (n)` beneath `WorkspaceList` in `Sidebar.tsx`, sibling to
  the `TERMINALS` section.
- Each row: workflow name + status dot. A **running** workflow shows a **pulsing** indicator
  (reuse the existing `animate-pulse` dot pattern already used for `swarmActive`, `Sidebar.tsx:130`).
- Click a row → open the workflow's **Run/Design view** in the main area (new view mode) and, if
  running, scroll its live progress into view.
- Footer action `+ New Workflow` (mirrors `+ Add Terminal`).
- **Retire** the toolbar `fa-cubes` "Workflows" button (`Sidebar.tsx:102-106`) and remove the
  `WorkflowTemplates` modal wiring (`showWorkflows` state + render at `:178`). Swarm and Git toolbar
  icons stay.

### 7.2 Design surface (Azure-Logic-Apps style)

Component `WorkflowDesigner` (new `src/renderer/src/components/Workflow/`): a vertical flow of a
**trigger card** (dropdown: Manual active; Schedule/On git push/On file change greyed = roadmap) then
**action cards**, one per step, color-coded by type. Between every pair of cards (and at head/tail) an
inline **"+"** opens a step-type picker **at the clicked gap** and inserts the chosen step there —
exactly the corrected behavior from the approved mockup (insert at the gap, never a shared bottom
menu). Each card expands to an inline editor for that step's fields (command text/script path +
shell; agent + prompt; tool + args; control action + config; plus `when` gate and `continueOnError`).
Save writes the YAML file.

### 7.3 Run surface

Component `WorkflowRunner`: a **progress timeline** (one node per step: pending/running/
succeeded/failed/skipped, with exit codes and durations) beside the **live real panes** — Command and
Agent steps render their actual Termpolis terminal so the user watches work happen (test fails → AI
fixes → re-run green → commit → notify, as in the mockup). Top bar: **Run**, **Cancel**, run status.

### 7.4 Legacy launcher presets

The four `BUILT_IN_WORKFLOWS` presets (e.g. "Claude Code + Shell") are re-expressed as optional
**built-in starter workflows** (each a tiny Command-step workflow that opens the panes), so no
capability is lost when the old modal is retired. (Confirm keep-vs-drop at the review gate — low
stakes.)

---

## 8. Main ↔ Renderer Boundary (IPC)

New channels (registered in `src/main/index.ts`, typed in the preload bridge `window.termpolis`):

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `workflow:list` | R→M | list workflow files in a workspace |
| `workflow:read` | R→M | read+validate one YAML → `Workflow` |
| `workflow:save` | R→M | serialize+write a `Workflow` YAML |
| `workflow:delete` | R→M | delete a workflow file |
| `workflow:run` | R→M | start a run; returns `runId` |
| `workflow:cancel` | R→M | cancel a run |
| `workflow:run-event` | M→R | streamed run/step events (start/output/status/finish) |

Renderer store (`terminalStore.ts`) gains `workflows: Workflow[]`, `activeRuns: Record<runId,
WorkflowRun>`, and actions to load/refresh/mutate — replacing the legacy `userWorkflows`
launcher state.

---

## 9. Security

- Command steps run **real shells** — this is arbitrary local code **by design** (it's a
  user-authored automation tool). The trust boundary is identical to the user opening a terminal and
  typing the command. v1 runs are **manual** (explicit user click), so no new autorun surface is
  introduced.
- Reuse the existing **workspace-trust** gate (`workspace:is-trusted`/`workspace:trust`,
  `index.ts:2117`) before a first run in a workspace.
- The existing **Commit/Push Secret Shield** and pre-commit hooks still fire on any `git commit`/
  `push` a Command step performs — unchanged.
- Roadmap triggers (schedule/git-hook) will require an explicit "allow this workflow to auto-run"
  opt-in per workflow; called out now so the data model (`trigger.config`) leaves room, but not
  built.

---

## 10. Test Strategy — "100%, every step type & feature works"

This is a **hard requirement**. The architecture is deliberately shaped for it: the engine is split
into a **pure** expression/validation core (trivially unit-tested to 100%) and per-type executors
tested against a **fake substrate** (a stub `TerminalRunner`/`AgentRunner`/`ToolInvoker` injected
into the engine), plus component tests for the UI and one e2e that drives the real app.

### 10.1 Unit — pure core (no I/O), target 100% of these files

- `workflowExpr.ts`: interpolation of every ref field (`output`/`exitCode`/`status`), unknown-id →
  empty + warning, both `${}` and `{{}}` syntaxes; every operator (`== != < <= > >= =~`), `.ok`/
  `.failed` sugar, numeric vs string comparison, malformed expression → safe false, default-`when`
  semantics. Table-driven.
- `workflowStore.ts`: YAML round-trip (`serialize(parse(x)) == x` for canonical forms), malformed
  YAML → typed error (never throws uncaught), schema validation accept/reject for every required
  field, unknown step type rejected, id/slug uniqueness + generation.

### 10.2 Unit — executors with a fake substrate (one suite per step type)

- **Command:** success (exit 0 → `succeeded`, output captured), failure (exit≠0 → `failed`, output
  captured), `continueOnError` proceeds, `timeoutMs` kills → `failed` with timeout error, `source:
  'file'` resolves + runs the script path, per-step `shell`/`cwd` honored, 32 KB tail-cap applied,
  `${steps.*}` interpolated into the command before run.
- **Agent:** completes when the fake detector reports `idle` held ≥ `idleMs`; `timeoutMs` cap →
  `failed`; `doneMarker` overrides idle; prompt interpolation; `waiting_for_input`/`errored`/
  `blocked` detector states map to the right terminal status.
- **Skill:** invokes the injected tool handler with interpolated args, captures structured result,
  tool-error → `failed` (or continue), timeout.
- **Control:** `wait` uses injected timer (no real sleep); `branch` jumps on true / falls through on
  false; `loop` runs preceding step exactly `maxIterations` times, stops early when `until` holds,
  retry-on-fail counts correctly; `notify` emits the interpolated message once.

### 10.3 Unit — engine orchestration (fake substrate)

- Gate `when:false` → step `skipped`, downstream refs to it resolve empty.
- Data flow: `steps.a.output` reaches step b's command/prompt/args.
- Failure stops the run (no `continueOnError`); `continueOnError` proceeds.
- `cancelRun` mid-flight → running step killed, remainder `cancelled`, `run:finished` emitted.
- Event stream ordering: `run:started → (step:started → step:status* → step:finished)+ →
  run:finished`.
- The full YAML example (§4) executes the intended path for both branches (test passes vs fails).

### 10.4 Component (vitest + testing-library/jsdom)

- Sidebar: `WORKFLOWS (n)` section renders saved workflows; a running one shows the pulsing dot; the
  legacy `fa-cubes` toolbar button is **absent** (regression assert).
- `WorkflowDesigner`: trigger card lists Manual active + roadmap greyed; clicking a specific "+"
  opens the picker **at that gap** and inserting a type adds a card there (the exact bug the user
  caught); each step type's editor renders its fields; Save calls `workflow:save`.
- `WorkflowRunner`: renders the progress timeline from a `WorkflowRun`, reflects streamed step-status
  updates, shows Cancel while running.

### 10.5 E2E (Playwright) — real app, added as **named** specs in `.github/workflows/test.yml`

New `e2e/workflow-orchestrator.spec.ts` (ubuntu `xvfb`) + a macOS-safe variant if the pane render
differs: launch the app → create a workflow with a **Command** step (`exit 0`), a **Control** branch,
and a headless step → Run → assert the timeline goes green and the Run view shows the live pane.
Keep the agent step out of the automated e2e path (real CLIs aren't in CI) — cover Agent-step done
detection in the fake-substrate unit tier instead. **Per the known gotcha, the new spec name(s) must
be added as explicit steps in `test.yml`** (`e2e-smoke` + `e2e-smoke-macos`), not left to a whole-dir
run — and any legacy `WorkflowTemplates` e2e assertions that click the retired icon must be updated
(grep `e2e/`).

### 10.6 Coverage & feature matrix

- Meet CI floors (lines ≥ 90, stmts/fn ≥ 89, branches ≥ 84); target the new `workflow/` files ≥ 90
  lines. Local gate = `npm run test:coverage` (vitest only).
- The spec ships with a **feature × proving-test matrix** (every step type, every field —
  `when`, `continueOnError`, `timeoutMs`, `source:file`, `visible`, `doneMarker`, each control
  action, each operator, data-flow, cancel) each mapped to the specific test above, so "all features
  work" is demonstrable, not asserted.

---

## 11. File Inventory

**New**
- `src/main/workflow/workflowEngine.ts`, `workflowExpr.ts`, `workflowStore.ts`, `workflowSteps.ts`
- `src/renderer/src/components/Workflow/WorkflowSidebarSection.tsx`, `WorkflowDesigner.tsx`,
  `WorkflowRunner.tsx`, `stepCards/*`
- `tests/electron/workflow*.test.ts` (expr, store, each executor, engine)
- `src/renderer/src/components/Workflow/*.test.tsx` (component)
- `e2e/workflow-orchestrator.spec.ts`
- `.termpolis/workflows/` (created on first save; starter templates seeded)

**Edited**
- `src/renderer/src/types/index.ts` (add `Workflow` + step/run types)
- `src/renderer/src/components/Sidebar/Sidebar.tsx` (add section; remove toolbar icon + modal)
- `src/renderer/src/store/terminalStore.ts` (add `workflows`/`activeRuns`; retire `userWorkflows`)
- `src/main/index.ts` (register `workflow:*` IPC), preload bridge, `mcpServer.ts` handler reuse
- `.github/workflows/test.yml` (add the new e2e spec name(s))
- `package.json` (add `yaml`, pending the §12 decision)
- Retire/repoint `WorkflowTemplates.tsx` (fold presets into starter templates)

**Removed / superseded**
- Legacy `WorkflowTemplates` modal usage + `fa-cubes` toolbar button

---

## 12. Open Decisions (spec-review gate)

1. **Serialization dep:** add pure-JS **`yaml`** (recommended, keeps hand-editable/comment goal) vs
   zero-dep **JSON**. — *Needs David's call given his dependency-minimalism.*
2. **Legacy launcher presets:** re-express as starter workflows (recommended) vs drop entirely.
3. **Default agent-done idle window** (`idleMs` = 8 s) and Command **`visible` default** (true) —
   sensible defaults, confirm.
4. **Run-history JSONL** in v1 (recommended, additive) vs defer.

---

## 13. Rollout

Single feature branch of work committed **directly to `main`** (project convention: no PRs). Ship
behind the normal release (version bump + `vX.Y.Z` tag → `release.yml`) once the full vitest suite +
the new e2e specs are green and coverage floors hold. TDD throughout (failing test first per the
100% requirement).
