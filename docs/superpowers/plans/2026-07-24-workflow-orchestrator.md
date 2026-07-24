# Workflow Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Termpolis's static workflow launcher into a local, deterministic **Workflow Orchestrator** — an ordered pipeline of typed steps (command/agent/skill/control) with gates + data flow, authored in a Logic-Apps-style designer and watched in a live Run view.

**Architecture:** A **pure core** (expression eval + YAML validate/serialize) and per-type **executors** run against injectable substrate interfaces (`TerminalRunner`/`AgentRunner`/`ToolInvoker`/`Timer`), so every step type and feature is unit-tested with fakes. A main-process **engine** walks steps sequentially, evaluating gates and streaming run events over IPC. Real substrate adapters wrap the confirmed primitives: `spawnTerminal` PTYs (+ a new exit-code callback), `detectAgentStatus` idle detection, and in-process `executeTool` MCP handlers. The renderer adds a sidebar Workflows section, a designer, and a runner.

**Tech Stack:** TypeScript (strict), Electron main/preload/renderer, node-pty (via `terminalManager`), Zustand store, React + Tailwind, `yaml` (new pure-JS dep), Vitest 4.1 (jsdom), Playwright 1.58.

## Global Constraints

Every task's requirements implicitly include these. Values copied verbatim from the codebase/spec:

- **Coverage floors (Windows CI, `vitest.config.ts`):** lines **97**, functions **96**, branches **93**, statements **96**. Hard floors — NEVER lower a gate; backfill tests on the offending file. New `src/main/workflow/**` and `src/renderer/src/components/Workflow/**` are inside coverage `include`.
- **Gates before "done":** `npm run test:coverage` (vitest, local gate), `npm run typecheck` (node+web), `npm run lint` (eslint ts,tsx — a stray NBSP fails CI). All three must pass.
- **E2E:** CI runs e2e as **per-named-spec steps** in `.github/workflows/test.yml` (`e2e-smoke` on ubuntu `xvfb` + `e2e-smoke-macos`), NOT a whole-dir run. Any NEW e2e spec MUST be added there by filename, and removing/altering a feature invalidates existing e2e assertions → grep `e2e/`.
- **Git:** commit + push **directly to `main`** (no branches/PRs). Release = version bump + push `vX.Y.Z` tag (triggers `release.yml`). Commit after every green step.
- **Agent roster:** `claude` | `codex` | `gemini` only (Qwen removed in v1.30.3).
- **Determinism:** no LLM and no randomness in control flow. Timestamps come from an injected `now()` (main passes `Date.now`; tests pass a counter) — never call `Date.now()`/`Math.random()` inside the engine/executors.
- **Substrate ownership:** PTYs live in the main process; the renderer only talks to the engine via `workflow:*` IPC.
- **Vitest env:** `jsdom`, `globals: true`, `setupFiles: ['./tests/setup.ts']`. Import pure modules directly; inject fakes rather than `vi.mock` where the design allows.

---

## File Structure

**New (main):**
- `src/main/workflow/contracts.ts` — substrate interfaces + `RunEvent`/`EngineDeps` types (no logic; excluded-ish, but keep tiny).
- `src/main/workflow/workflowExpr.ts` — pure interpolation + condition eval.
- `src/main/workflow/workflowStore.ts` — YAML (de)serialize + validate + fs CRUD (fs injected).
- `src/main/workflow/executors.ts` — `executeCommandStep`/`executeAgentStep`/`executeSkillStep`/`executeControlStep`.
- `src/main/workflow/workflowEngine.ts` — sequential runner + gates + events + cancel.
- `src/main/workflow/adapters.ts` — real `TerminalRunner`/`AgentRunner`/`ToolInvoker`/`Timer`.

**New (renderer):**
- `src/renderer/src/components/Workflow/WorkflowSidebarSection.tsx`
- `src/renderer/src/components/Workflow/WorkflowDesigner.tsx`
- `src/renderer/src/components/Workflow/WorkflowRunner.tsx`
- `src/renderer/src/components/Workflow/stepEditors.tsx`

**New (tests):** `tests/electron/workflowExpr.test.ts`, `workflowStore.test.ts`, `workflowExecutors.test.ts`, `workflowEngine.test.ts`, `workflowAdapters.test.ts`, `workflowIpc.test.ts`; `src/renderer/src/components/Workflow/*.test.tsx`; `src/renderer/src/store/workflowStore.test.ts`; `e2e/workflow-orchestrator.spec.ts`.

**Modified:** `src/renderer/src/types/index.ts`, `src/main/terminalManager.ts` (add `onExit`), `src/main/index.ts` (IPC + MCP handler reuse), `src/preload/index.ts`, `src/renderer/src/store/terminalStore.ts`, `src/renderer/src/components/Sidebar/Sidebar.tsx`, `.github/workflows/test.yml`, `package.json`.

**Retired:** `src/renderer/src/components/WorkflowTemplates/WorkflowTemplates.tsx` usage (folded into starter templates), `fa-cubes` toolbar button.

---

## Task 1: Types + `yaml` dependency

**Files:**
- Modify: `src/renderer/src/types/index.ts` (append workflow types; extend `TermpolisAPI`)
- Modify: `package.json` (add `yaml`)

**Interfaces — Produces** (consumed by every later task; exact names/types):

```ts
export type WorkflowStepType = 'command' | 'agent' | 'skill' | 'control'
export type WorkflowTriggerType = 'manual' | 'schedule' | 'gitPush' | 'fileWatch'
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
export type RunStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface WorkflowTrigger { type: WorkflowTriggerType; config?: Record<string, string> }

export interface CommandStep {
  id: string; type: 'command'; name: string; when?: string
  source: 'inline' | 'file'; command?: string; scriptPath?: string
  shell?: ShellType; cwd?: string; timeoutMs?: number; visible?: boolean; continueOnError?: boolean
}
export interface AgentStep {
  id: string; type: 'agent'; name: string; when?: string
  agent: 'claude' | 'codex' | 'gemini'; prompt: string; cwd?: string
  idleMs?: number; timeoutMs?: number; doneMarker?: string; continueOnError?: boolean
}
export interface SkillStep {
  id: string; type: 'skill'; name: string; when?: string
  tool: string; args?: Record<string, unknown>; timeoutMs?: number; continueOnError?: boolean
}
export interface ControlStep {
  id: string; type: 'control'; name: string; when?: string
  action: 'wait' | 'branch' | 'loop' | 'notify'; config: Record<string, string | number>
}
export type WorkflowStep = CommandStep | AgentStep | SkillStep | ControlStep

export interface Workflow {
  id: string; name: string; description?: string; version: 1
  trigger: WorkflowTrigger; steps: WorkflowStep[]
}

export interface StepResult {
  stepId: string; status: StepStatus; exitCode?: number; output: string
  startedAt?: number; endedAt?: number; iteration?: number; error?: string
}
export interface WorkflowRun {
  runId: string; workflowId: string; status: RunStatus
  steps: StepResult[]; startedAt: number; endedAt?: number
}
```

Also define the streamed run-event union (single source of truth — `contracts.ts` in Task 4 re-exports it for main-side code, the renderer store in Task 11 imports it from here):

```ts
export type WorkflowRunEvent =
  | { type: 'run:started'; runId: string; workflowId: string; at: number }
  | { type: 'step:started'; runId: string; stepId: string; at: number }
  | { type: 'step:output'; runId: string; stepId: string; chunk: string }
  | { type: 'step:status'; runId: string; stepId: string; status: StepStatus }
  | { type: 'step:finished'; runId: string; stepId: string; result: StepResult }
  | { type: 'run:finished'; runId: string; status: RunStatus; at: number }
```

And add to the existing `TermpolisAPI` interface (the existing response wrapper is `IpcResponse<T>`, already imported in this file — reuse it, NOT `Result`):

```ts
  listWorkflows: (cwd: string) => Promise<IpcResponse<{ id: string; name: string }[]>>
  readWorkflow: (cwd: string, id: string) => Promise<IpcResponse<Workflow>>
  saveWorkflow: (cwd: string, workflow: Workflow) => Promise<IpcResponse<void>>
  deleteWorkflow: (cwd: string, id: string) => Promise<IpcResponse<void>>
  runWorkflow: (cwd: string, id: string) => Promise<IpcResponse<{ runId: string }>>
  cancelWorkflow: (runId: string) => Promise<IpcResponse<void>>
  onWorkflowRunEvent: (cb: (event: WorkflowRunEvent) => void) => () => void
```

- [ ] **Step 1: Add the types.** Append all of the above to `src/renderer/src/types/index.ts`. Leave the legacy `WorkflowTemplate`/`WorkflowTerminal`/`WorkflowLayout` types in place for now (retired in Task 11).

- [ ] **Step 2: Add the dep.** In `package.json` dependencies add `"yaml": "2.5.1"`. Run:

```bash
npm install
```
Expected: `yaml` added to `node_modules`, lockfile updated.

- [ ] **Step 3: Verify it compiles.**

Run: `npm run typecheck`
Expected: PASS (no type errors; `WorkflowRunEvent` is defined in this file).

- [ ] **Step 4: Commit.**

```bash
git add src/renderer/src/types/index.ts package.json package-lock.json
git commit -m "feat(workflow): add orchestrator types + yaml dependency"
```

---

## Task 2: Pure expression core (`workflowExpr.ts`)

**Files:**
- Create: `src/main/workflow/workflowExpr.ts`
- Test: `tests/electron/workflowExpr.test.ts`

**Interfaces:**
- Consumes: `StepResult` (Task 1).
- Produces:
  - `interpolate(text: string, results: Record<string, StepResult>): string`
  - `evalCondition(expr: string, results: Record<string, StepResult>): boolean`

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, it, expect } from 'vitest'
import { interpolate, evalCondition } from '../../src/main/workflow/workflowExpr'
import type { StepResult } from '../../src/renderer/src/types'

const R = (over: Partial<StepResult> & { stepId: string }): StepResult =>
  ({ status: 'succeeded', output: '', ...over })
const results = {
  build: R({ stepId: 'build', output: 'ok done', exitCode: 0, status: 'succeeded' }),
  test:  R({ stepId: 'test',  output: 'FAIL x', exitCode: 1, status: 'failed' }),
}

describe('interpolate', () => {
  it('replaces ${steps.id.output/exitCode/status}', () => {
    expect(interpolate('out=${steps.build.output}', results)).toBe('out=ok done')
    expect(interpolate('code=${steps.test.exitCode}', results)).toBe('code=1')
    expect(interpolate('st=${steps.test.status}', results)).toBe('st=failed')
  })
  it('accepts the {{ }} syntax too', () => {
    expect(interpolate('x={{ steps.build.output }}', results)).toBe('x=ok done')
  })
  it('unknown id or field -> empty string', () => {
    expect(interpolate('a=${steps.nope.output}b', results)).toBe('a=b')
  })
  it('leaves non-refs untouched', () => {
    expect(interpolate('plain $VAR text', results)).toBe('plain $VAR text')
  })
  it('inserts output containing $-replacement patterns literally (no String.replace $& footgun)', () => {
    const withDollar = { x: R({ stepId: 'x', output: 'a $& $1 $` b' }) }
    expect(interpolate('v=${steps.x.output}', withDollar)).toBe('v=a $& $1 $` b')
  })
  it('renders a missing exitCode as empty, not the string "undefined"', () => {
    const noCode = { x: R({ stepId: 'x', output: 'hi' }) } // exitCode omitted (e.g. agent step)
    expect(interpolate('c=${steps.x.exitCode}.', noCode)).toBe('c=.')
  })
})

describe('evalCondition', () => {
  it('numeric comparisons on exitCode', () => {
    expect(evalCondition('steps.test.exitCode != 0', results)).toBe(true)
    expect(evalCondition('steps.build.exitCode == 0', results)).toBe(true)
    expect(evalCondition('steps.build.exitCode >= 1', results)).toBe(false)
  })
  it('.ok / .failed sugar', () => {
    expect(evalCondition('steps.build.ok', results)).toBe(true)
    expect(evalCondition('steps.test.failed', results)).toBe(true)
    expect(evalCondition('steps.build.failed', results)).toBe(false)
  })
  it('string equality + substring =~', () => {
    expect(evalCondition("steps.test.status == 'failed'", results)).toBe(true)
    expect(evalCondition('steps.test.output =~ FAIL', results)).toBe(true)
    expect(evalCondition('steps.build.output =~ nope', results)).toBe(false)
  })
  it('supports all comparison operators, matched longest-first', () => {
    expect(evalCondition('steps.build.exitCode <= 0', results)).toBe(true)   // <= not < then =
    expect(evalCondition('steps.build.exitCode < 1', results)).toBe(true)
    expect(evalCondition('steps.test.exitCode > 0', results)).toBe(true)
    expect(evalCondition('steps.test.exitCode >= 1', results)).toBe(true)    // >= not > then =
    expect(evalCondition('steps.build.exitCode < 0', results)).toBe(false)
  })
  it('requires spaces around the operator (no-space string is not a comparison -> false)', () => {
    expect(evalCondition('steps.test.exitCode!=0', results)).toBe(false)
  })
  it('malformed expression -> false (never throws)', () => {
    expect(evalCondition('this is not valid', results)).toBe(false)
    expect(evalCondition('', results)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run tests/electron/workflowExpr.test.ts`
Expected: FAIL — `interpolate`/`evalCondition` not exported.

- [ ] **Step 3: Implement `workflowExpr.ts`.**

```ts
import type { StepResult } from '../../renderer/src/types'

type Results = Record<string, StepResult>

function resolveRef(ref: string, results: Results): string | undefined {
  const m = ref.trim().match(/^steps\.([\w-]+)\.(output|exitCode|status)$/)
  if (!m) return undefined
  const r = results[m[1]]
  if (!r) return ''
  const v = (r as any)[m[2]]
  return v === undefined || v === null ? '' : String(v)
}

export function interpolate(text: string, results: Results): string {
  return text.replace(/(?:\$\{|\{\{)\s*(steps\.[\w-]+\.\w+)\s*(?:\}\}|\})/g, (_all, ref) => {
    const v = resolveRef(ref, results)
    return v === undefined ? '' : v
  })
}

// Operators longest-first so >= is not read as >.
const OPS = ['>=', '<=', '==', '!=', '=~', '>', '<'] as const

function operand(token: string, results: Results): { num?: number; str: string } {
  const t = token.trim()
  const ref = resolveRef(t, results)
  const raw = ref !== undefined ? ref : t.replace(/^['"]|['"]$/g, '')
  const num = raw !== '' && !isNaN(Number(raw)) ? Number(raw) : undefined
  return { num, str: raw }
}

export function evalCondition(expr: string, results: Results): boolean {
  const e = (expr || '').trim()
  if (!e) return false
  // Sugar: steps.X.ok / steps.X.failed
  const sugar = e.match(/^steps\.([\w-]+)\.(ok|failed)$/)
  if (sugar) {
    const r = results[sugar[1]]
    if (!r) return false
    const isZero = r.exitCode === 0
    return sugar[2] === 'ok' ? isZero : !isZero
  }
  for (const op of OPS) {
    const i = e.indexOf(` ${op} `)
    if (i === -1) continue
    const lhs = operand(e.slice(0, i), results)
    const rhs = operand(e.slice(i + op.length + 2), results)
    switch (op) {
      case '==': return lhs.str === rhs.str
      case '!=': return lhs.str !== rhs.str
      case '=~': return lhs.str.includes(rhs.str)
      case '>':  return lhs.num !== undefined && rhs.num !== undefined && lhs.num > rhs.num
      case '<':  return lhs.num !== undefined && rhs.num !== undefined && lhs.num < rhs.num
      case '>=': return lhs.num !== undefined && rhs.num !== undefined && lhs.num >= rhs.num
      case '<=': return lhs.num !== undefined && rhs.num !== undefined && lhs.num <= rhs.num
    }
  }
  return false
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run tests/electron/workflowExpr.test.ts`
Expected: PASS (all cases). If the `=~` case with an unquoted bare RHS containing a space fails, note the grammar requires bare RHS be single-token; tests use single tokens.

- [ ] **Step 5: Commit.**

```bash
git add src/main/workflow/workflowExpr.ts tests/electron/workflowExpr.test.ts
git commit -m "feat(workflow): pure expression interpolation + condition eval"
```

---

## Task 3: YAML store + validation (`workflowStore.ts`)

**Files:**
- Create: `src/main/workflow/workflowStore.ts`
- Test: `tests/electron/workflowStore.test.ts`

**Interfaces:**
- Consumes: `Workflow`, `WorkflowStep` (Task 1); `yaml`.
- Produces:
  - `validateWorkflow(obj: unknown): { ok: boolean; errors: string[]; workflow?: Workflow }`
  - `serializeWorkflow(wf: Workflow): string`
  - `parseWorkflow(text: string): { ok: boolean; errors: string[]; workflow?: Workflow }`
  - `type FsLike = { readdirSync(d): string[]; readFileSync(p, enc): string; writeFileSync(p, data): void; appendFileSync(p, data): void; existsSync(p): boolean; mkdirSync(p, o?): void; rmSync(p, o?): void }`
  - `listWorkflows(dir: string, fs: FsLike): { id: string; name: string }[]`
  - `readWorkflow(dir: string, id: string, fs: FsLike): { ok; errors; workflow? }`
  - `writeWorkflow(dir: string, wf: Workflow, fs: FsLike): void`
  - `deleteWorkflow(dir: string, id: string, fs: FsLike): void`
  - `workflowsDir(cwd: string): string` → `join(cwd, '.termpolis', 'workflows')`
  - `runsDir(cwd: string): string` → `join(cwd, '.termpolis', 'workflows', 'runs')`
  - `appendRunHistory(dir: string, run: WorkflowRun, fs: FsLike): void` (append-only JSONL; honors the resolved decision to keep run history in v1)

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, it, expect } from 'vitest'
import {
  validateWorkflow, serializeWorkflow, parseWorkflow,
  listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow, workflowsDir,
  runsDir, appendRunHistory,
} from '../../src/main/workflow/workflowStore'
import type { Workflow } from '../../src/renderer/src/types'

const WF: Workflow = {
  id: 'demo', name: 'Demo', version: 1, trigger: { type: 'manual' },
  steps: [
    { id: 'a', type: 'command', name: 'echo', source: 'inline', command: 'echo hi' },
    { id: 'b', type: 'control', name: 'note', action: 'notify', config: { message: 'done' }, when: 'steps.a.ok' },
  ],
}

describe('validateWorkflow', () => {
  it('accepts a well-formed workflow', () => {
    expect(validateWorkflow(WF).ok).toBe(true)
  })
  it('rejects missing id/steps and unknown step type', () => {
    expect(validateWorkflow({ name: 'x' }).ok).toBe(false)
    expect(validateWorkflow({ ...WF, steps: [{ id: 'z', type: 'nope', name: 'z' }] }).ok).toBe(false)
  })
  it('rejects duplicate step ids', () => {
    const dup = { ...WF, steps: [WF.steps[0], { ...WF.steps[0] }] }
    expect(validateWorkflow(dup).ok).toBe(false)
  })
  it('rejects a workflow id with path-traversal / separators', () => {
    for (const bad of ['../evil', 'a/b', '..\\evil', '.hidden', 'a.b', 'has space']) {
      expect(validateWorkflow({ ...WF, id: bad }).ok).toBe(false)
    }
    expect(validateWorkflow({ ...WF, id: 'good-id_1' }).ok).toBe(true)
  })
  it('rejects invalid per-type enums (command.source / agent.agent / control.action)', () => {
    expect(validateWorkflow({ ...WF, steps: [{ id: 'a', type: 'command', name: 'a', source: 'weird' }] }).ok).toBe(false)
    expect(validateWorkflow({ ...WF, steps: [{ id: 'a', type: 'agent', name: 'a', agent: 'qwen', prompt: 'x' }] }).ok).toBe(false)
    expect(validateWorkflow({ ...WF, steps: [{ id: 'a', type: 'control', name: 'a', action: 'explode', config: {} }] }).ok).toBe(false)
  })
})

describe('serialize/parse round-trip', () => {
  it('parse(serialize(wf)) deep-equals wf', () => {
    const round = parseWorkflow(serializeWorkflow(WF))
    expect(round.ok).toBe(true)
    expect(round.workflow).toEqual(WF)
  })
  it('malformed YAML -> ok:false, no throw', () => {
    const r = parseWorkflow('id: : : nope\n  - broken')
    expect(r.ok).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
  })
})

describe('fs CRUD (injected fake fs)', () => {
  function makeFs() {
    const files = new Map<string, string>()
    return {
      files,
      fs: {
        existsSync: (p: string) => files.has(p) || p.endsWith('workflows'),
        mkdirSync: () => {},
        readdirSync: (_d: string) => [...files.keys()].map(k => k.split(/[\\/]/).pop()!),
        readFileSync: (p: string) => files.get(p)!,
        writeFileSync: (p: string, d: string) => { files.set(p, d) },
        appendFileSync: (p: string, d: string) => { files.set(p, (files.get(p) || '') + d) },
        rmSync: (p: string) => { files.delete(p) },
      } as any,
    }
  }
  it('write then list then read then delete', () => {
    const { fs, files } = makeFs()
    const dir = workflowsDir('/repo')
    writeWorkflow(dir, WF, fs)
    expect([...files.keys()][0]).toContain('demo.yml')
    expect(listWorkflows(dir, fs)).toEqual([{ id: 'demo', name: 'Demo' }])
    expect(readWorkflow(dir, 'demo', fs).workflow).toEqual(WF)
    deleteWorkflow(dir, 'demo', fs)
    expect(files.size).toBe(0)
  })
  it('writeWorkflow refuses to persist an invalid workflow (main never trusts the renderer)', () => {
    const { fs, files } = makeFs()
    expect(() => writeWorkflow(workflowsDir('/repo'), { id: 'x' } as any, fs)).toThrow(/invalid workflow/)
    expect(files.size).toBe(0)
  })
  it('read/delete refuse a path-traversal id (no escape from the workflows dir)', () => {
    const { fs, files } = makeFs()
    const dir = workflowsDir('/repo')
    files.set('/repo/secret.yml', 'id: secret') // a file OUTSIDE the workflows dir
    expect(readWorkflow(dir, '../../secret', fs).ok).toBe(false)
    expect(() => deleteWorkflow(dir, '../../secret', fs)).toThrow(/unsafe/)
    expect(files.has('/repo/secret.yml')).toBe(true) // untouched
  })
  it('appendRunHistory appends one JSONL line per run', () => {
    const { fs, files } = makeFs()
    const dir = runsDir('/repo')
    const run = { runId: 'r1', workflowId: 'demo', status: 'succeeded', steps: [], startedAt: 1, endedAt: 2 } as any
    appendRunHistory(dir, run, fs)
    appendRunHistory(dir, run, fs)
    const key = [...files.keys()].find(k => k.endsWith('demo.jsonl'))!
    expect(files.get(key)!.trim().split('\n').length).toBe(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run tests/electron/workflowStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `workflowStore.ts`.**

```ts
import YAML from 'yaml'
import { join } from 'path'
import type { Workflow, WorkflowStep, WorkflowRun } from '../../renderer/src/types'

export type FsLike = {
  existsSync(p: string): boolean
  mkdirSync(p: string, o?: unknown): void
  readdirSync(d: string): string[]
  readFileSync(p: string, enc?: unknown): string
  writeFileSync(p: string, data: string): void
  appendFileSync(p: string, data: string): void
  rmSync(p: string, o?: unknown): void
}

export function workflowsDir(cwd: string): string {
  return join(cwd, '.termpolis', 'workflows')
}

export function runsDir(cwd: string): string {
  return join(cwd, '.termpolis', 'workflows', 'runs')
}

export function appendRunHistory(dir: string, run: WorkflowRun, fs: FsLike): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(join(dir, `${run.workflowId}.jsonl`), JSON.stringify(run) + '\n')
}

const STEP_TYPES = new Set(['command', 'agent', 'skill', 'control'])

// Per-type structural checks: enums must be valid. Free-text fields (command/prompt/tool)
// may be blank at save time (a draft) — the executors handle empties at run time.
function validateStep(s: any): string[] {
  const e: string[] = []
  if (s.type === 'command' && s.source !== 'inline' && s.source !== 'file') e.push(`command ${s.id}: source must be 'inline' or 'file'`)
  if (s.type === 'agent' && !['claude', 'codex', 'gemini'].includes(s.agent)) e.push(`agent ${s.id}: agent must be claude|codex|gemini`)
  if (s.type === 'control' && !['wait', 'branch', 'loop', 'notify'].includes(s.action)) e.push(`control ${s.id}: action must be wait|branch|loop|notify`)
  return e
}

export function validateWorkflow(obj: unknown): { ok: boolean; errors: string[]; workflow?: Workflow } {
  const errors: string[] = []
  const o = obj as any
  if (!o || typeof o !== 'object') return { ok: false, errors: ['not an object'] }
  if (typeof o.id !== 'string' || !o.id.trim()) errors.push('missing id')
  else if (!isSafeId(o.id)) errors.push('id may contain only letters, digits, hyphen, underscore (no path separators)')
  if (typeof o.name !== 'string' || !o.name.trim()) errors.push('missing name')
  if (!o.trigger || typeof o.trigger.type !== 'string') errors.push('missing trigger.type')
  if (!Array.isArray(o.steps)) errors.push('steps must be an array')
  const seen = new Set<string>()
  if (Array.isArray(o.steps)) {
    for (const s of o.steps as WorkflowStep[]) {
      if (!s || typeof s.id !== 'string') { errors.push('step missing id'); continue }
      if (seen.has(s.id)) errors.push(`duplicate step id: ${s.id}`)
      seen.add(s.id)
      if (!STEP_TYPES.has((s as any).type)) errors.push(`unknown step type: ${(s as any).type}`)
      else errors.push(...validateStep(s as any))
      if (typeof (s as any).name !== 'string') errors.push(`step ${s.id} missing name`)
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], workflow: { version: 1, ...o } as Workflow }
}

export function serializeWorkflow(wf: Workflow): string {
  return YAML.stringify(wf)
}

export function parseWorkflow(text: string): { ok: boolean; errors: string[]; workflow?: Workflow } {
  let obj: unknown
  try { obj = YAML.parse(text) } catch (e: any) { return { ok: false, errors: [`YAML: ${e.message}`] } }
  return validateWorkflow(obj)
}

// Workflow ids become file names (`<id>.yml`), so an id is untrusted path input.
// Allow only a strict slug — blocks `..`, `/`, `\`, drive letters, and dotfiles.
export function isSafeId(id: string): boolean {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id)
}
function fileFor(dir: string, id: string): string {
  if (!isSafeId(id)) throw new Error(`unsafe workflow id: ${JSON.stringify(id)}`)
  return join(dir, `${id}.yml`)
}

export function writeWorkflow(dir: string, wf: Workflow, fs: FsLike): void {
  // The main process never trusts a renderer-supplied workflow (spec §9): validate before persisting.
  const v = validateWorkflow(wf)
  if (!v.ok) throw new Error(`invalid workflow: ${v.errors.join('; ')}`)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(fileFor(dir, wf.id), serializeWorkflow(wf))
}

export function listWorkflows(dir: string, fs: FsLike): { id: string; name: string }[] {
  if (!fs.existsSync(dir)) return []
  const out: { id: string; name: string }[] = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.yml')) continue
    const id = f.replace(/\.yml$/, '')
    if (!isSafeId(id)) continue // ignore stray/hostile file names, never let fileFor throw here
    const r = parseWorkflow(fs.readFileSync(fileFor(dir, id), 'utf8'))
    if (r.ok && r.workflow) out.push({ id: r.workflow.id, name: r.workflow.name })
  }
  return out
}

export function readWorkflow(dir: string, id: string, fs: FsLike): { ok: boolean; errors: string[]; workflow?: Workflow } {
  if (!isSafeId(id)) return { ok: false, errors: [`unsafe workflow id: ${JSON.stringify(id)}`] }
  const p = fileFor(dir, id)
  if (!fs.existsSync(p)) return { ok: false, errors: [`not found: ${id}`] }
  return parseWorkflow(fs.readFileSync(p, 'utf8'))
}

export function deleteWorkflow(dir: string, id: string, fs: FsLike): void {
  const p = fileFor(dir, id)
  if (fs.existsSync(p)) fs.rmSync(p, { force: true })
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run tests/electron/workflowStore.test.ts`
Expected: PASS. (The fake `readdirSync` returns `demo.yml`; `readWorkflow` re-reads via `readFileSync`.)

- [ ] **Step 5: Commit.**

```bash
git add src/main/workflow/workflowStore.ts tests/electron/workflowStore.test.ts
git commit -m "feat(workflow): YAML serialize/validate + fs CRUD (injected fs)"
```

---

## Task 4: Substrate contracts + Control executor

**Files:**
- Create: `src/main/workflow/contracts.ts`
- Create: `src/main/workflow/executors.ts` (control action only for now)
- Test: `tests/electron/workflowExecutors.test.ts`

**Interfaces — Produces (contracts consumed by Tasks 5-8):**

```ts
// contracts.ts — WorkflowRunEvent lives in renderer/src/types (single source); re-export for main-side ergonomics.
import type { WorkflowRunEvent } from '../../renderer/src/types'
export type { WorkflowRunEvent }

export interface CommandRunSpec { stepId: string; command: string; shell: string; cwd: string; timeoutMs: number; visible: boolean }
export interface CommandRunResult { exitCode: number; output: string; timedOut?: boolean }
export interface TerminalRunner { run(spec: CommandRunSpec, onChunk?: (s: string) => void): Promise<CommandRunResult>; cancel(stepId: string): void }

export interface AgentRunSpec { stepId: string; agent: 'claude' | 'codex' | 'gemini'; prompt: string; cwd: string; idleMs: number; timeoutMs: number; doneMarker?: string }
export interface AgentRunResult { output: string; ok: boolean; error?: string }
export interface AgentRunner { run(spec: AgentRunSpec, onChunk?: (s: string) => void): Promise<AgentRunResult>; cancel(stepId: string): void }

export interface ToolInvoker { invoke(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ output: string; ok: boolean; error?: string }> }
export interface Timer { sleep(ms: number): Promise<void> }

export interface EngineDeps {
  terminal: TerminalRunner; agent: AgentRunner; tools: ToolInvoker; timer: Timer
  now: () => number; newRunId: () => string; emit: (e: WorkflowRunEvent) => void
}
```

Control executor signature: `executeControlStep(step: ControlStep, results: Record<string,StepResult>, timer: Timer, emit: (e)=>void): Promise<{ status: StepStatus; output: string; goto?: string; loop?: { maxIterations: number; until?: string } }>`.

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, it, expect, vi } from 'vitest'
import { executeControlStep } from '../../src/main/workflow/executors'
import type { ControlStep, StepResult } from '../../src/renderer/src/types'

const timer = { sleep: vi.fn(async () => {}) }
const results: Record<string, StepResult> = {
  t: { stepId: 't', status: 'failed', exitCode: 1, output: 'boom' },
}

describe('control: wait', () => {
  it('sleeps for config.waitMs and succeeds', async () => {
    const step: ControlStep = { id: 'w', type: 'control', name: 'wait', action: 'wait', config: { waitMs: 500 } }
    const r = await executeControlStep(step, results, timer, () => {})
    expect(timer.sleep).toHaveBeenCalledWith(500)
    expect(r.status).toBe('succeeded')
  })
})

describe('control: branch', () => {
  it('returns goto when condition true', async () => {
    const step: ControlStep = { id: 'b', type: 'control', name: 'br', action: 'branch', config: { condition: 'steps.t.failed', goto: 'fix' } }
    const r = await executeControlStep(step, results, timer, () => {})
    expect(r.goto).toBe('fix')
  })
  it('no goto when condition false', async () => {
    const step: ControlStep = { id: 'b', type: 'control', name: 'br', action: 'branch', config: { condition: 'steps.t.ok', goto: 'fix' } }
    const r = await executeControlStep(step, results, timer, () => {})
    expect(r.goto).toBeUndefined()
  })
})

describe('control: loop + notify', () => {
  it('loop returns loop directive', async () => {
    const step: ControlStep = { id: 'l', type: 'control', name: 'lp', action: 'loop', config: { maxIterations: 3, until: 'steps.t.ok' } }
    const r = await executeControlStep(step, results, timer, () => {})
    expect(r.loop).toEqual({ maxIterations: 3, until: 'steps.t.ok' })
  })
  it('clamps a huge maxIterations to the hard ceiling (no runaway loop)', async () => {
    const step: ControlStep = { id: 'l', type: 'control', name: 'lp', action: 'loop', config: { maxIterations: 1_000_000_000 } }
    const r = await executeControlStep(step, results, timer, () => {})
    expect(r.loop!.maxIterations).toBe(1000)
  })
  it('coerces a missing/zero maxIterations to a safe minimum of 1', async () => {
    const step: ControlStep = { id: 'l', type: 'control', name: 'lp', action: 'loop', config: {} }
    const r = await executeControlStep(step, results, timer, () => {})
    expect(r.loop!.maxIterations).toBe(1)
  })
  it('notify emits the interpolated message once', async () => {
    const emit = vi.fn()
    const step: ControlStep = { id: 'n', type: 'control', name: 'nt', action: 'notify', config: { message: 'code=${steps.t.exitCode}' } }
    const r = await executeControlStep(step, results, timer, emit)
    expect(r.status).toBe('succeeded')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ chunk: 'code=1' }))
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run tests/electron/workflowExecutors.test.ts`
Expected: FAIL — `executeControlStep` not exported.

- [ ] **Step 3: Implement `contracts.ts` + control in `executors.ts`.**

Create `contracts.ts` verbatim from the Interfaces block above. Then `executors.ts`:

```ts
import type { ControlStep, StepResult, StepStatus } from '../../renderer/src/types'
import type { Timer } from './contracts'
import { interpolate, evalCondition } from './workflowExpr'

type Emit = (e: { chunk: string }) => void
type Results = Record<string, StepResult>

// Hard ceiling on a single control-loop's iterations. A huge or absent
// `maxIterations` is clamped into [1, MAX_LOOP_ITERATIONS] so a loop can never hang the engine.
export const MAX_LOOP_ITERATIONS = 1000

export async function executeControlStep(
  step: ControlStep, results: Results, timer: Timer, emit: Emit,
): Promise<{ status: StepStatus; output: string; goto?: string; loop?: { maxIterations: number; until?: string } }> {
  const c = step.config
  switch (step.action) {
    case 'wait': {
      await timer.sleep(Number(c.waitMs) || 0)
      return { status: 'succeeded', output: '' }
    }
    case 'branch': {
      const hit = evalCondition(String(c.condition ?? ''), results)
      return { status: 'succeeded', output: hit ? 'branch taken' : 'branch skipped', goto: hit ? String(c.goto) : undefined }
    }
    case 'loop': {
      const requested = Number(c.maxIterations) || 1
      const maxIterations = Math.min(Math.max(1, requested), MAX_LOOP_ITERATIONS)
      return { status: 'succeeded', output: '', loop: { maxIterations, until: c.until ? String(c.until) : undefined } }
    }
    case 'notify': {
      const msg = interpolate(String(c.message ?? ''), results)
      emit({ chunk: msg })
      return { status: 'succeeded', output: msg }
    }
    default:
      return { status: 'failed', output: `unknown control action` }
  }
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run tests/electron/workflowExecutors.test.ts`
Expected: PASS (4 describes green).

- [ ] **Step 5: Commit.**

```bash
git add src/main/workflow/contracts.ts src/main/workflow/executors.ts tests/electron/workflowExecutors.test.ts
git commit -m "feat(workflow): substrate contracts + control-step executor"
```

---

## Task 5: Command executor

**Files:**
- Modify: `src/main/workflow/executors.ts` (add `executeCommandStep`)
- Test: `tests/electron/workflowExecutors.test.ts` (append `describe('command')`)

**Interfaces:**
- Consumes: `TerminalRunner` (Task 4), `interpolate` (Task 2).
- Produces: `executeCommandStep(step: CommandStep, results, terminal: TerminalRunner, onChunk?): Promise<StepResult>` — status `succeeded` when exitCode===0 else `failed`; captures output (32 KB tail cap); resolves `source:'file'` to a shell invocation; interpolates `command`.

- [ ] **Step 1: Write the failing tests (append).**

```ts
import { executeCommandStep } from '../../src/main/workflow/executors'
import type { CommandStep } from '../../src/renderer/src/types'

function fakeTerminal(result: { exitCode: number; output: string; timedOut?: boolean }, spy?: (s: any) => void) {
  return { run: vi.fn(async (spec: any) => { spy?.(spec); return result }), cancel: vi.fn() }
}
const base: CommandStep = { id: 'c', type: 'command', name: 'run', source: 'inline', command: 'echo hi' }

describe('command executor', () => {
  it('exit 0 -> succeeded with output', async () => {
    const term = fakeTerminal({ exitCode: 0, output: 'hi' })
    const r = await executeCommandStep(base, {}, term as any)
    expect(r.status).toBe('succeeded'); expect(r.exitCode).toBe(0); expect(r.output).toBe('hi')
  })
  it('exit != 0 -> failed', async () => {
    const term = fakeTerminal({ exitCode: 2, output: 'err' })
    const r = await executeCommandStep(base, {}, term as any)
    expect(r.status).toBe('failed'); expect(r.exitCode).toBe(2)
  })
  it('timedOut -> failed with error', async () => {
    const term = fakeTerminal({ exitCode: 124, output: '', timedOut: true })
    const r = await executeCommandStep({ ...base, timeoutMs: 10 }, {}, term as any)
    expect(r.status).toBe('failed'); expect(r.error).toMatch(/timed out/i)
  })
  it('interpolates ${steps.*} into the command before running', async () => {
    let seen: any; const term = fakeTerminal({ exitCode: 0, output: '' }, s => (seen = s))
    await executeCommandStep({ ...base, command: 'deploy ${steps.build.output}' }, { build: { stepId: 'build', status: 'succeeded', output: 'v9', exitCode: 0 } }, term as any)
    expect(seen.command).toBe('deploy v9')
  })
  it('source:file runs the script via the shell (bash script.sh)', async () => {
    let seen: any; const term = fakeTerminal({ exitCode: 0, output: '' }, s => (seen = s))
    await executeCommandStep({ id: 'c', type: 'command', name: 'f', source: 'file', scriptPath: 'scripts/x.sh', shell: 'bash' }, {}, term as any)
    expect(seen.command).toContain('scripts/x.sh')
    expect(seen.shell).toBe('bash')
  })
  it('source:file infers python for .py', async () => {
    let seen: any; const term = fakeTerminal({ exitCode: 0, output: '' }, s => (seen = s))
    await executeCommandStep({ id: 'c', type: 'command', name: 'f', source: 'file', scriptPath: 'etl.py' }, {}, term as any)
    expect(seen.command).toBe('python etl.py')
  })
  it('caps captured output at 32KB (tail)', async () => {
    const big = 'x'.repeat(40_000)
    const term = fakeTerminal({ exitCode: 0, output: big })
    const r = await executeCommandStep(base, {}, term as any)
    expect(r.output.length).toBe(32_768)
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run tests/electron/workflowExecutors.test.ts -t "command executor"`
Expected: FAIL — `executeCommandStep` not exported.

- [ ] **Step 3: Implement (append to `executors.ts`).**

```ts
import type { CommandStep } from '../../renderer/src/types'
import type { TerminalRunner } from './contracts'

const CAP = 32_768
const tail = (s: string) => (s.length > CAP ? s.slice(-CAP) : s)

function fileCommand(scriptPath: string, shell?: string): string {
  if (shell === 'python' || /\.py$/.test(scriptPath)) return `python ${scriptPath}`
  if (/\.(mjs|cjs|js)$/.test(scriptPath)) return `node ${scriptPath}`
  if (/\.ps1$/.test(scriptPath)) return `pwsh -File ${scriptPath}`
  return `${shell || 'bash'} ${scriptPath}`
}

export async function executeCommandStep(
  step: CommandStep, results: Results, terminal: TerminalRunner, onChunk?: (s: string) => void,
): Promise<StepResult> {
  const shell = step.shell || 'bash'
  const command = step.source === 'file'
    ? fileCommand(step.scriptPath || '', step.shell)
    : interpolate(step.command || '', results)
  const res = await terminal.run(
    { stepId: step.id, command, shell, cwd: step.cwd || '', timeoutMs: step.timeoutMs ?? 600_000, visible: step.visible ?? true },
    onChunk,
  )
  return {
    stepId: step.id,
    status: res.exitCode === 0 ? 'succeeded' : 'failed',
    exitCode: res.exitCode,
    output: tail(res.output),
    error: res.timedOut ? `command timed out after ${step.timeoutMs ?? 600_000}ms` : undefined,
  }
}
```

(Add the `CommandStep`/`TerminalRunner` imports to the existing import block; do not duplicate `Results`.)

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run tests/electron/workflowExecutors.test.ts -t "command executor"`
Expected: PASS (7 cases).

- [ ] **Step 5: Commit.**

```bash
git add src/main/workflow/executors.ts tests/electron/workflowExecutors.test.ts
git commit -m "feat(workflow): command-step executor (inline+file, timeout, tail-cap, interpolation)"
```

---

## Task 6: Agent executor

**Files:**
- Modify: `src/main/workflow/executors.ts` (add `executeAgentStep`)
- Test: `tests/electron/workflowExecutors.test.ts` (append `describe('agent')`)

**Interfaces:**
- Consumes: `AgentRunner` (Task 4). The `AgentRunner` adapter (Task 9) owns idle/timeout/doneMarker detection via `detectAgentStatus`; the executor interpolates the prompt, calls `run`, and maps `ok`.
- Produces: `executeAgentStep(step: AgentStep, results, agent: AgentRunner, onChunk?): Promise<StepResult>`.

- [ ] **Step 1: Write the failing tests (append).**

```ts
import { executeAgentStep } from '../../src/main/workflow/executors'
import type { AgentStep } from '../../src/renderer/src/types'

const A: AgentStep = { id: 'g', type: 'agent', name: 'ask', agent: 'claude', prompt: 'fix ${steps.test.output}' }

describe('agent executor', () => {
  it('ok:true -> succeeded, prompt interpolated', async () => {
    let seen: any
    const agent = { run: vi.fn(async (s: any) => { seen = s; return { output: 'patched', ok: true } }), cancel: vi.fn() }
    const r = await executeAgentStep(A, { test: { stepId: 'test', status: 'failed', exitCode: 1, output: 'boom' } }, agent as any)
    expect(seen.prompt).toBe('fix boom')
    expect(r.status).toBe('succeeded'); expect(r.output).toBe('patched')
  })
  it('ok:false -> failed with error', async () => {
    const agent = { run: vi.fn(async () => ({ output: '', ok: false, error: 'timeout after 900000ms' })), cancel: vi.fn() }
    const r = await executeAgentStep(A, {}, agent as any)
    expect(r.status).toBe('failed'); expect(r.error).toMatch(/timeout/)
  })
  it('passes idleMs/timeoutMs/doneMarker through to the runner', async () => {
    let seen: any
    const agent = { run: vi.fn(async (s: any) => { seen = s; return { output: '', ok: true } }), cancel: vi.fn() }
    await executeAgentStep({ ...A, idleMs: 3000, timeoutMs: 60000, doneMarker: '<<DONE>>' }, {}, agent as any)
    expect(seen).toMatchObject({ idleMs: 3000, timeoutMs: 60000, doneMarker: '<<DONE>>', agent: 'claude' })
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run tests/electron/workflowExecutors.test.ts -t "agent executor"`
Expected: FAIL.

- [ ] **Step 3: Implement (append).**

```ts
import type { AgentStep } from '../../renderer/src/types'
import type { AgentRunner } from './contracts'

export async function executeAgentStep(
  step: AgentStep, results: Results, agent: AgentRunner, onChunk?: (s: string) => void,
): Promise<StepResult> {
  const res = await agent.run({
    stepId: step.id, agent: step.agent, prompt: interpolate(step.prompt, results),
    cwd: step.cwd || '', idleMs: step.idleMs ?? 8_000, timeoutMs: step.timeoutMs ?? 900_000,
    doneMarker: step.doneMarker,
  }, onChunk)
  return { stepId: step.id, status: res.ok ? 'succeeded' : 'failed', output: tail(res.output), error: res.error }
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run tests/electron/workflowExecutors.test.ts -t "agent executor"`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/main/workflow/executors.ts tests/electron/workflowExecutors.test.ts
git commit -m "feat(workflow): agent-step executor (prompt interpolation, idle/timeout/marker passthrough)"
```

---

## Task 7: Skill executor

**Files:**
- Modify: `src/main/workflow/executors.ts` (add `executeSkillStep`)
- Test: `tests/electron/workflowExecutors.test.ts` (append `describe('skill')`)

**Interfaces:**
- Consumes: `ToolInvoker` (Task 4).
- Produces: `executeSkillStep(step: SkillStep, results, tools: ToolInvoker): Promise<StepResult>` — interpolates string-valued args, invokes, maps `ok`.

- [ ] **Step 1: Write the failing tests (append).**

```ts
import { executeSkillStep } from '../../src/main/workflow/executors'
import type { SkillStep } from '../../src/renderer/src/types'

describe('skill executor', () => {
  it('invokes the tool with interpolated string args and captures output', async () => {
    let seen: any
    const tools = { invoke: vi.fn(async (tool: string, args: any) => { seen = { tool, args }; return { output: '3 hits', ok: true } }) }
    const step: SkillStep = { id: 's', type: 'skill', name: 'search', tool: 'memory_search', args: { query: 'about ${steps.a.output}', limit: 5 } }
    const r = await executeSkillStep(step, { a: { stepId: 'a', status: 'succeeded', output: 'X', exitCode: 0 } }, tools as any)
    expect(seen.tool).toBe('memory_search')
    expect(seen.args).toEqual({ query: 'about X', limit: 5 })
    expect(r.status).toBe('succeeded'); expect(r.output).toBe('3 hits')
  })
  it('tool error -> failed', async () => {
    const tools = { invoke: vi.fn(async () => ({ output: '', ok: false, error: 'no such tool' })) }
    const step: SkillStep = { id: 's', type: 'skill', name: 'x', tool: 'nope' }
    const r = await executeSkillStep(step, {}, tools as any)
    expect(r.status).toBe('failed'); expect(r.error).toBe('no such tool')
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run tests/electron/workflowExecutors.test.ts -t "skill executor"` → FAIL.

- [ ] **Step 3: Implement (append).**

```ts
import type { SkillStep } from '../../renderer/src/types'
import type { ToolInvoker } from './contracts'

export async function executeSkillStep(step: SkillStep, results: Results, tools: ToolInvoker): Promise<StepResult> {
  const args: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(step.args || {})) {
    args[k] = typeof v === 'string' ? interpolate(v, results) : v
  }
  const res = await tools.invoke(step.tool, args, step.timeoutMs ?? 120_000)
  return { stepId: step.id, status: res.ok ? 'succeeded' : 'failed', output: tail(res.output), error: res.error }
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run tests/electron/workflowExecutors.test.ts -t "skill executor"` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/main/workflow/executors.ts tests/electron/workflowExecutors.test.ts
git commit -m "feat(workflow): skill-step executor (interpolated args via ToolInvoker)"
```

---

## Task 8: The engine (`workflowEngine.ts`)

**Files:**
- Create: `src/main/workflow/workflowEngine.ts`
- Test: `tests/electron/workflowEngine.test.ts`

**Interfaces:**
- Consumes: all executors (Tasks 4-7), `evalCondition` (Task 2), `EngineDeps`/`WorkflowRunEvent` (Task 4).
- Produces: `runWorkflow(wf: Workflow, deps: EngineDeps): Promise<WorkflowRun>` and `cancelRun(runId: string, deps: EngineDeps): void`. Semantics: iterate steps by index; a step runs unless (a) it has a `when` that evals false, or (b) it has no `when` and a prior **hard** failure occurred (`failed` without `continueOnError`) → `skipped`. On `failed` without `continueOnError`, stop (mark rest pending→skipped) and finish `failed`. `branch.goto` jumps the index to the target step id. `loop` re-runs the immediately-preceding step up to `maxIterations` until `until` holds. Emits the full event sequence; `cancelRun` sets a cancel flag + calls `terminal.cancel`/`agent.cancel`.

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, it, expect, vi } from 'vitest'
import { runWorkflow, cancelRun } from '../../src/main/workflow/workflowEngine'
import type { Workflow } from '../../src/renderer/src/types'
import type { EngineDeps, WorkflowRunEvent } from '../../src/main/workflow/contracts'

function deps(over: Partial<EngineDeps> = {}): { d: EngineDeps; events: WorkflowRunEvent[] } {
  const events: WorkflowRunEvent[] = []
  let t = 1000
  const d: EngineDeps = {
    terminal: { run: vi.fn(async (s) => ({ exitCode: 0, output: `ran:${s.command}` })), cancel: vi.fn() },
    agent: { run: vi.fn(async () => ({ output: 'agent', ok: true })), cancel: vi.fn() },
    tools: { invoke: vi.fn(async () => ({ output: 'tool', ok: true })) },
    timer: { sleep: vi.fn(async () => {}) },
    now: () => t++, newRunId: () => 'run-1', emit: (e) => events.push(e),
    ...over,
  }
  return { d, events }
}
const wf = (steps: any[]): Workflow => ({ id: 'wf', name: 'wf', version: 1, trigger: { type: 'manual' }, steps })

describe('engine', () => {
  it('runs steps in order and finishes succeeded', async () => {
    const { d, events } = deps()
    const run = await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'echo a' },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'echo b' },
    ]), d)
    expect(run.status).toBe('succeeded')
    expect(run.steps.map(s => s.status)).toEqual(['succeeded', 'succeeded'])
    expect(events[0].type).toBe('run:started')
    expect(events.at(-1)).toMatchObject({ type: 'run:finished', status: 'succeeded' })
  })

  it('gate when:false skips the step', async () => {
    const { d } = deps()
    const run = await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'echo a' },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'echo b', when: 'steps.a.failed' },
    ]), d)
    expect(run.steps[1].status).toBe('skipped')
  })

  it('data flows from step a into step b command', async () => {
    const runSpy = vi.fn(async (s: any) => ({ exitCode: 0, output: s.command === 'echo a' ? 'A-OUT' : s.command }))
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'echo a' },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'use ${steps.a.output}' },
    ]), d)
    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({ command: 'use A-OUT' }), expect.anything())
  })

  it('hard failure stops the run; later no-when steps are skipped', async () => {
    const runSpy = vi.fn(async (s: any) => ({ exitCode: s.command === 'boom' ? 1 : 0, output: '' }))
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    const run = await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'boom' },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'echo b' },
    ]), d)
    expect(run.status).toBe('failed')
    expect(run.steps[1].status).toBe('skipped')
  })

  it('continueOnError lets the run proceed', async () => {
    const runSpy = vi.fn(async (s: any) => ({ exitCode: s.command === 'boom' ? 1 : 0, output: '' }))
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    const run = await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'boom', continueOnError: true },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'echo b' },
    ]), d)
    expect(run.steps[0].status).toBe('failed')
    expect(run.steps[1].status).toBe('succeeded')
    expect(run.status).toBe('succeeded')
  })

  it('branch goto jumps forward to the target step', async () => {
    const order: string[] = []
    const runSpy = vi.fn(async (s: any) => { order.push(s.command); return { exitCode: 0, output: '' } })
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'A' },
      { id: 'j', type: 'control', name: 'j', action: 'branch', config: { condition: 'steps.a.ok', goto: 'c' } },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'B' },
      { id: 'c', type: 'command', name: 'c', source: 'inline', command: 'C' },
    ]), d)
    expect(order).toEqual(['A', 'C']) // B skipped by the jump
  })

  it('loop re-runs the preceding step until `until` holds (max cap)', async () => {
    let n = 0
    const runSpy = vi.fn(async () => ({ exitCode: 0, output: String(++n) }))
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'tick' },
      { id: 'l', type: 'control', name: 'l', action: 'loop', config: { maxIterations: 5, until: 'steps.a.output == 3' } },
    ]), d)
    expect(n).toBe(3) // ran once, then looped until output==3
  })

  it('aborts a runaway backward branch goto at the execution cap (does not hang)', async () => {
    const runSpy = vi.fn(async () => ({ exitCode: 0, output: '' }))
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    const r = await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'A' },
      // condition is always true -> without a budget this jumps back to 'a' forever
      { id: 'j', type: 'control', name: 'j', action: 'branch', config: { condition: 'steps.a.ok', goto: 'a' } },
    ]), d)
    expect(r.status).toBe('failed')
    expect(runSpy.mock.calls.length).toBeLessThanOrEqual(1000)
    expect(r.steps.some(s => s.stepId === '__runaway__')).toBe(true)
  })

  it('a branch goto to an unknown step id falls through to the next step (no crash/hang)', async () => {
    const order: string[] = []
    const runSpy = vi.fn(async (s: any) => { order.push(s.command); return { exitCode: 0, output: '' } })
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    const r = await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'A' },
      { id: 'j', type: 'control', name: 'j', action: 'branch', config: { condition: 'steps.a.ok', goto: 'ghost' } },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'B' },
    ]), d)
    expect(order).toEqual(['A', 'B']) // unknown goto ignored -> linear fall-through
    expect(r.status).toBe('succeeded')
  })

  it('cancel mid-run stops remaining steps and finishes cancelled', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const { d } = deps({ terminal: { run: vi.fn(async () => { await gate; return { exitCode: 0, output: '' } }), cancel: vi.fn() } })
    const p = runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'slow' },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'next' },
    ]), d)
    cancelRun('run-1', d)   // deps.newRunId() returns 'run-1'; step 'a' is parked on the gate
    release()
    const run = await p
    expect(run.status).toBe('cancelled')
    expect(run.steps.find(s => s.stepId === 'b')!.status).toBe('cancelled')
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run tests/electron/workflowEngine.test.ts` → FAIL.

- [ ] **Step 3: Implement `workflowEngine.ts`.**

```ts
import type { Workflow, WorkflowStep, WorkflowRun, StepResult, RunStatus } from '../../renderer/src/types'
import type { EngineDeps } from './contracts'
import { evalCondition } from './workflowExpr'
import { executeCommandStep, executeAgentStep, executeSkillStep, executeControlStep } from './executors'

const cancelled = new Set<string>()
const runningStep = new Map<string, string>()   // runId -> in-flight stepId

export function cancelRun(runId: string, deps: EngineDeps): void {
  cancelled.add(runId)
  const stepId = runningStep.get(runId)
  if (stepId) { deps.terminal.cancel(stepId); deps.agent.cancel(stepId) }
}

export async function runWorkflow(wf: Workflow, deps: EngineDeps): Promise<WorkflowRun> {
  const runId = deps.newRunId()
  const results: Record<string, StepResult> = {}
  const run: WorkflowRun = { runId, workflowId: wf.id, status: 'running', steps: [], startedAt: deps.now() }
  deps.emit({ type: 'run:started', runId, workflowId: wf.id, at: run.startedAt })
  const idIndex = new Map(wf.steps.map((s, i) => [s.id, i]))
  // Run-wide execution budget. Bounds runaway backward `goto` loops in the main loop
  // AND (threaded into runLoop below) nested control loops, so no workflow can hang the engine.
  const MAX_STEP_EXECUTIONS = 1000
  let executed = 0
  const overBudget = () => ++executed > MAX_STEP_EXECUTIONS
  let hardFailed = false
  let i = 0

  const record = (r: StepResult) => { results[r.stepId] = r; run.steps.push(r); deps.emit({ type: 'step:finished', runId, stepId: r.stepId, result: r }) }

  while (i < wf.steps.length) {
    if (overBudget()) { record({ stepId: '__runaway__', status: 'failed', output: `aborted after ${MAX_STEP_EXECUTIONS} step executions (possible infinite loop)` }); hardFailed = true; break }
    if (cancelled.has(runId)) { record({ stepId: wf.steps[i].id, status: 'cancelled', output: '' }); i++; continue }
    const step = wf.steps[i]
    const gated = step.when !== undefined ? !evalCondition(step.when, results) : hardFailed
    if (gated) { record({ stepId: step.id, status: 'skipped', output: '' }); i++; continue }

    deps.emit({ type: 'step:started', runId, stepId: step.id, at: deps.now() })
    deps.emit({ type: 'step:status', runId, stepId: step.id, status: 'running' })
    runningStep.set(runId, step.id)
    const onChunk = (chunk: string) => deps.emit({ type: 'step:output', runId, stepId: step.id, chunk })

    let result: StepResult
    let jumpTo: string | undefined
    if (step.type === 'command') result = await executeCommandStep(step, results, deps.terminal, onChunk)
    else if (step.type === 'agent') result = await executeAgentStep(step, results, deps.agent, onChunk)
    else if (step.type === 'skill') result = await executeSkillStep(step, results, deps.tools)
    else {
      const c = await executeControlStep(step, results, deps.timer, (e) => deps.emit({ type: 'step:output', runId, stepId: step.id, chunk: e.chunk || '' }))
      result = { stepId: step.id, status: c.status, output: c.output }
      jumpTo = c.goto
      if (c.loop) { record(result); i = await runLoop(wf, i, c.loop, results, deps, runId, overBudget); continue }
    }
    result.startedAt = result.startedAt ?? run.startedAt
    result.endedAt = deps.now()
    record(result)

    if (result.status === 'failed' && !(step as any).continueOnError) { hardFailed = true }
    if (jumpTo && idIndex.has(jumpTo)) { i = idIndex.get(jumpTo)!; continue }
    i++
  }

  run.status = (cancelled.has(runId) ? 'cancelled' : hardFailed ? 'failed' : 'succeeded') as RunStatus
  run.endedAt = deps.now()
  cancelled.delete(runId); runningStep.delete(runId)
  deps.emit({ type: 'run:finished', runId, status: run.status, at: run.endedAt })
  return run
}

async function runLoop(
  wf: Workflow, loopIdx: number, loop: { maxIterations: number; until?: string },
  results: Record<string, StepResult>, deps: EngineDeps, runId: string, overBudget: () => boolean,
): Promise<number> {
  const prev = wf.steps[loopIdx - 1] as WorkflowStep | undefined
  if (!prev) return loopIdx + 1
  for (let n = 1; n < loop.maxIterations; n++) {
    if (loop.until && evalCondition(loop.until, results)) break
    if (overBudget()) break // share the run-wide budget so a nested loop can't hang either
    const r = await runOne(prev, results, deps, runId, n)
    results[prev.id] = r
    run_push(deps, runId, r)
    if (loop.until && evalCondition(loop.until, results)) break
  }
  return loopIdx + 1
}

function run_push(deps: EngineDeps, runId: string, r: StepResult) {
  deps.emit({ type: 'step:finished', runId, stepId: r.stepId, result: r })
}

async function runOne(step: WorkflowStep, results: Record<string, StepResult>, deps: EngineDeps, runId: string, iteration: number): Promise<StepResult> {
  const onChunk = (chunk: string) => deps.emit({ type: 'step:output', runId, stepId: step.id, chunk })
  let r: StepResult
  if (step.type === 'command') r = await executeCommandStep(step, results, deps.terminal, onChunk)
  else if (step.type === 'agent') r = await executeAgentStep(step, results, deps.agent, onChunk)
  else if (step.type === 'skill') r = await executeSkillStep(step, results, deps.tools)
  else { const c = await executeControlStep(step, results, deps.timer, () => {}); r = { stepId: step.id, status: c.status, output: c.output } }
  r.iteration = iteration
  return r
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run tests/electron/workflowEngine.test.ts`
Expected: PASS (7 cases). If the loop test counts wrong, confirm `runLoop` starts at `n=1` (the pre-loop run already produced output `1`).

- [ ] **Step 5: Commit.**

```bash
git add src/main/workflow/workflowEngine.ts tests/electron/workflowEngine.test.ts
git commit -m "feat(workflow): sequential engine — gates, data flow, branch/loop, cancel, events"
```

---

## Task 9: Real substrate adapters + `spawnTerminal` onExit

**Files:**
- Modify: `src/main/terminalManager.ts` (add `onExit?: (code: number) => void` param to `spawnTerminal`)
- Create: `src/main/workflow/adapters.ts`
- Test: `tests/electron/workflowAdapters.test.ts`

**Interfaces:**
- Consumes: `spawnTerminal`/`writeToTerminal`/`killTerminal` (terminalManager), `detectAgentStatus` (agentStatusDetector), `executeTool`+`McpToolHandlers` (mcpServer).
- Produces: `makeTerminalRunner(sp): TerminalRunner`, `makeAgentRunner(sp, detect): AgentRunner`, `makeToolInvoker(handlers): ToolInvoker`, `realTimer: Timer`. All take their substrate as parameters so tests inject fakes.

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeTerminalRunner, makeAgentRunner, makeToolInvoker, realTimer } from '../../src/main/workflow/adapters'

describe('terminal runner adapter', () => {
  it('spawns, feeds output to onChunk, resolves with the exit code', async () => {
    // fake spawnTerminal: capture callbacks, then drive them
    let onData: (s: string) => void = () => {}
    let onExit: (code: number) => void = () => {}
    const spawn = vi.fn((_id, _exe, _cwd, d, _p, _e, ex) => { onData = d; onExit = ex })
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn() })
    const chunks: string[] = []
    const p = runner.run({ stepId: 's', command: 'echo hi', shell: 'bash', cwd: '/x', timeoutMs: 1000, visible: false }, c => chunks.push(c))
    onData('hi\n'); onExit(0)
    const res = await p
    expect(res.exitCode).toBe(0)
    expect(chunks.join('')).toContain('hi')
  })
  it('timeout kills the pty and resolves timedOut', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const spawn = vi.fn((_id, _exe, _cwd, _d, _p, _e, _ex) => {})
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: kill })
    const p = runner.run({ stepId: 's', command: 'sleep 999', shell: 'bash', cwd: '/x', timeoutMs: 50, visible: false })
    await vi.advanceTimersByTimeAsync(60)
    const res = await p
    expect(res.timedOut).toBe(true); expect(kill).toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('tool invoker adapter', () => {
  it('delegates to executeTool and returns ok/output', async () => {
    const handlers: any = {}
    const runner = makeToolInvoker(handlers, async (name) => ({ output: `${name}!` }))
    const r = await runner.invoke('memory_search', { query: 'x' }, 1000)
    expect(r.ok).toBe(true); expect(r.output).toContain('memory_search!')
  })
  it('executeTool throwing -> ok:false', async () => {
    const runner = makeToolInvoker({} as any, async () => { throw new Error('bad tool') })
    const r = await runner.invoke('nope', {}, 1000)
    expect(r.ok).toBe(false); expect(r.error).toBe('bad tool')
  })
})

describe('realTimer', () => {
  it('sleeps ~ the requested ms', async () => {
    vi.useFakeTimers(); const p = realTimer.sleep(100); await vi.advanceTimersByTimeAsync(100); await p; vi.useRealTimers()
  })
})

describe('agent runner adapter', () => {
  const sp = (spawn: any, kill = vi.fn()) => ({ spawnTerminal: spawn, writeToTerminal: vi.fn(), killTerminal: kill })
  const spec = { stepId: 'g', agent: 'claude' as const, prompt: 'hi', cwd: '/x', idleMs: 1000, timeoutMs: 100000 }

  it('resolves ok once detect holds idle for idleMs', async () => {
    vi.useFakeTimers()
    const runner = makeAgentRunner(sp(vi.fn()) as any, () => ({ status: 'idle', summary: '' }), () => 'claude')
    const p = runner.run(spec)
    await vi.advanceTimersByTimeAsync(2000) // polls @500ms: idle latched, then held >= idleMs
    expect((await p).ok).toBe(true)
    vi.useRealTimers()
  })
  it('doneMarker in output short-circuits to ok', async () => {
    let onData: (s: string) => void = () => {}
    const spawn = vi.fn((_i: string, _e: string, _c: string, d: (s: string) => void) => { onData = d })
    const runner = makeAgentRunner(sp(spawn) as any, () => ({ status: 'working', summary: '' }), () => 'claude')
    const p = runner.run({ ...spec, idleMs: 9e9, doneMarker: '<<DONE>>' })
    onData('... <<DONE>> ...')
    expect((await p).ok).toBe(true)
  })
  it('errored status -> ok:false', async () => {
    vi.useFakeTimers()
    const runner = makeAgentRunner(sp(vi.fn()) as any, () => ({ status: 'errored', summary: '' }), () => 'claude')
    const p = runner.run(spec)
    await vi.advanceTimersByTimeAsync(600)
    const r = await p
    expect(r.ok).toBe(false); expect(r.error).toMatch(/errored/)
    vi.useRealTimers()
  })
  it('timeout kills the pane and fails', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const runner = makeAgentRunner(sp(vi.fn(), kill) as any, () => ({ status: 'working', summary: '' }), () => 'claude')
    const p = runner.run({ ...spec, timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(60)
    const r = await p
    expect(r.ok).toBe(false); expect(kill).toHaveBeenCalled(); expect(r.error).toMatch(/timed out/)
    vi.useRealTimers()
  })
  it('cancel -> ok:false', async () => {
    const runner = makeAgentRunner(sp(vi.fn()) as any, () => ({ status: 'working', summary: '' }), () => 'claude')
    const p = runner.run(spec)
    runner.cancel('g')
    const r = await p
    expect(r.ok).toBe(false); expect(r.error).toMatch(/cancel/)
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run tests/electron/workflowAdapters.test.ts` → FAIL.

- [ ] **Step 3a: Add `onExit` to `spawnTerminal`.** In `src/main/terminalManager.ts`, change the signature + the exit wiring:

```ts
export function spawnTerminal(
  id: string,
  executable: string,
  cwd: string,
  onData: (data: string) => void,
  extraPaths?: string[],
  extraEnv?: Record<string, string>,
  onExit?: (exitCode: number) => void,   // NEW
): void {
```
and replace line ~136:
```ts
  proc.onExit((e: { exitCode: number }) => { try { onExit?.(e.exitCode) } finally { processes.delete(id) } })
```

- [ ] **Step 3b: Implement `adapters.ts`.**

```ts
import type { TerminalRunner, AgentRunner, ToolInvoker, Timer, CommandRunSpec, CommandRunResult } from './contracts'
import type { McpToolHandlers } from '../mcpServer'

type SpawnDeps = {
  spawnTerminal: (id: string, exe: string, cwd: string, onData: (s: string) => void, extraPaths?: string[], extraEnv?: Record<string, string>, onExit?: (code: number) => void) => void
  writeToTerminal: (id: string, data: string) => void
  killTerminal: (id: string) => void
}

const CAP = 32_768

export function makeTerminalRunner(sp: SpawnDeps): TerminalRunner {
  const live = new Map<string, () => void>()
  return {
    run(spec: CommandRunSpec, onChunk?): Promise<CommandRunResult> {
      return new Promise((resolve) => {
        let buf = ''
        let done = false
        const finish = (r: CommandRunResult) => { if (done) return; done = true; clearTimeout(timer); live.delete(spec.stepId); resolve(r) }
        const timer = setTimeout(() => { try { sp.killTerminal(spec.stepId) } catch {} finish({ exitCode: 124, output: buf, timedOut: true }) }, spec.timeoutMs)
        live.set(spec.stepId, () => { try { sp.killTerminal(spec.stepId) } catch {} finish({ exitCode: 130, output: buf }) })
        sp.spawnTerminal(spec.stepId, spec.shell, spec.cwd,
          (d) => { buf = (buf + d).slice(-CAP); onChunk?.(d) },
          undefined, undefined,
          (code) => finish({ exitCode: code, output: buf }))
        // Non-interactive: write the command + newline, then signal EOF via `exit`.
        sp.writeToTerminal(spec.stepId, `${spec.command}\n`)
        if (!spec.visible) sp.writeToTerminal(spec.stepId, `exit $?\n`)
      })
    },
    cancel(stepId) { live.get(stepId)?.() },
  }
}

export function makeToolInvoker(handlers: McpToolHandlers, exec: (name: string, args: any, h: McpToolHandlers) => Promise<any>): ToolInvoker {
  return {
    async invoke(tool, args, _timeoutMs) {
      try {
        const res = await exec(tool, args, handlers)
        return { output: typeof res === 'string' ? res : JSON.stringify(res), ok: true }
      } catch (e: any) {
        return { output: '', ok: false, error: e.message }
      }
    },
  }
}

export const realTimer: Timer = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }

// Agent adapter: drive a pane, poll detectAgentStatus for `idle` held >= idleMs (or doneMarker), cap at timeoutMs.
export function makeAgentRunner(
  sp: SpawnDeps,
  detect: (output: string, agentName?: string, prev?: string) => { status: string; summary: string },
  launch: (agent: 'claude' | 'codex' | 'gemini') => string,
): AgentRunner {
  const live = new Map<string, () => void>()
  return {
    run(spec, onChunk): Promise<{ output: string; ok: boolean; error?: string }> {
      return new Promise((resolve) => {
        let buf = ''; let done = false; let idleSince = 0
        const finish = (r: { output: string; ok: boolean; error?: string }) => { if (done) return; done = true; clearInterval(poll); clearTimeout(hard); live.delete(spec.stepId); resolve(r) }
        const hard = setTimeout(() => { try { sp.killTerminal(spec.stepId) } catch {}; finish({ output: buf, ok: false, error: `agent timed out after ${spec.timeoutMs}ms` }) }, spec.timeoutMs)
        live.set(spec.stepId, () => finish({ output: buf, ok: false, error: 'cancelled' }))
        sp.spawnTerminal(spec.stepId, launch(spec.agent), spec.cwd,
          (d) => {
            buf = (buf + d).slice(-CAP); onChunk?.(d)
            if (spec.doneMarker && buf.includes(spec.doneMarker)) return finish({ output: buf, ok: true })
          })
        sp.writeToTerminal(spec.stepId, `${spec.prompt}\n`)
        const poll = setInterval(() => {
          const st = detect(buf, spec.agent).status
          if (st === 'errored' || st === 'blocked') return finish({ output: buf, ok: false, error: `agent ${st}` })
          const now = Date.now()
          if (st === 'idle' || st === 'completed' || st === 'waiting_for_input') {
            if (!idleSince) idleSince = now
            else if (now - idleSince >= spec.idleMs) return finish({ output: buf, ok: true })
          } else { idleSince = 0 }
        }, 500)
      })
    },
    cancel(stepId) { live.get(stepId)?.() },
  }
}
```

(Agent-runner internals use real timers/`Date.now` — that's fine; it lives in the adapter, outside the deterministic engine. Its five branches — idle-hold done, `doneMarker` done, errored/blocked, timeout+kill, cancel — are covered by the `agent runner adapter` describe above using `vi.useFakeTimers` + scripted `detect`.)

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run tests/electron/workflowAdapters.test.ts` → PASS. Then `npm run typecheck` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/main/terminalManager.ts src/main/workflow/adapters.ts tests/electron/workflowAdapters.test.ts
git commit -m "feat(workflow): real substrate adapters + spawnTerminal exit-code callback"
```

---

## Task 10: IPC wiring + preload

**Files:**
- Modify: `src/main/index.ts` (register `workflow:*` handlers; build `EngineDeps` from adapters + existing MCP handlers)
- Modify: `src/preload/index.ts` (add the 6 methods + the run-event subscription)
- Test: `tests/electron/workflowIpc.test.ts` (unit-test a small `registerWorkflowIpc(deps)` factory rather than the whole app)

**Interfaces:**
- Consumes: `runWorkflow`/`cancelRun` (Task 8), `workflowStore` CRUD (Task 3), adapters (Task 9), existing `mcpHandlers` (index.ts:2487), `ok`/`err` wrappers, `BrowserWindow.webContents.send`.
- Produces: `registerWorkflowIpc(ipcMain, getWindow, engineDeps, fs)` in a new small module `src/main/workflow/ipc.ts` so it's unit-testable; `index.ts` just calls it. Renderer bridge methods per Task 1's `TermpolisAPI` additions; events delivered on channel `workflow:run-event`.

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, it, expect, vi } from 'vitest'
import { registerWorkflowIpc } from '../../src/main/workflow/ipc'

function harness({ trusted = true }: { trusted?: boolean } = {}) {
  const handlers = new Map<string, Function>()
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn) }
  const sent: any[] = []
  const win = { webContents: { send: (ch: string, e: any) => sent.push({ ch, e }) } }
  const files = new Map<string, string>()
  const fs = {
    existsSync: (p: string) => files.has(p) || p.endsWith('workflows') || p.endsWith('runs'),
    mkdirSync: () => {}, readdirSync: () => [...files.keys()].map(k => k.split(/[\\/]/).pop()!),
    readFileSync: (p: string) => files.get(p)!, writeFileSync: (p: string, d: string) => files.set(p, d),
    appendFileSync: (p: string, d: string) => files.set(p, (files.get(p) || '') + d),
    rmSync: (p: string) => files.delete(p),
  }
  const engine = { runWorkflow: vi.fn(async (wf: any, deps: any) => { deps.emit({ type: 'run:finished', runId: 'r', status: 'succeeded', at: 1 }); return { runId: 'r', status: 'succeeded', workflowId: wf.id, steps: [], startedAt: 0 } }), cancelRun: vi.fn() }
  registerWorkflowIpc(ipcMain as any, () => win as any, {
    fs: fs as any, engine,
    isTrusted: () => trusted,
    newRunId: () => 'r',
    makeDeps: (emit) => ({ emit }) as any,
  })
  return { call: (ch: string, arg: any) => handlers.get(ch)!(null, arg), sent, files }
}

describe('workflow IPC', () => {
  it('save then list then read', async () => {
    const h = harness()
    const wf = { id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] }
    expect((await h.call('workflow:save', { cwd: '/r', workflow: wf })).success).toBe(true)
    expect((await h.call('workflow:list', { cwd: '/r' })).data).toEqual([{ id: 'x', name: 'X' }])
    expect((await h.call('workflow:read', { cwd: '/r', id: 'x' })).data.id).toBe('x')
  })
  it('run returns the runId and forwards emitted events to the window', async () => {
    const h = harness()
    const wf = { id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] }
    await h.call('workflow:save', { cwd: '/r', workflow: wf })
    const res = await h.call('workflow:run', { cwd: '/r', id: 'x' })
    expect(res.data.runId).toBe('r')
    expect(h.sent.some(m => m.ch === 'workflow:run-event' && m.e.type === 'run:finished')).toBe(true)
  })
  it('run on an untrusted workspace is refused', async () => {
    const h = harness({ trusted: false })
    const wf = { id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] }
    await h.call('workflow:save', { cwd: '/r', workflow: wf })
    const res = await h.call('workflow:run', { cwd: '/r', id: 'x' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/trust/i)
  })
  it('a finished run is appended to history', async () => {
    const h = harness()
    const wf = { id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] }
    await h.call('workflow:save', { cwd: '/r', workflow: wf })
    await h.call('workflow:run', { cwd: '/r', id: 'x' })
    await new Promise((r) => setTimeout(r, 0)) // let the engine promise + history append settle
    expect([...h.files.keys()].some((k) => k.endsWith('x.jsonl'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run tests/electron/workflowIpc.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/main/workflow/ipc.ts`** (thin, testable), then call it from `index.ts`.

```ts
import type { Workflow } from '../../renderer/src/types'
import type { EngineDeps, WorkflowRunEvent } from './contracts'
import type { FsLike } from './workflowStore'
import { listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow, workflowsDir, runsDir, appendRunHistory } from './workflowStore'

type Engine = { runWorkflow: (wf: Workflow, d: EngineDeps) => Promise<any>; cancelRun: (id: string, d: EngineDeps) => void }
type Wiring = {
  fs: FsLike
  engine: Engine
  isTrusted: (cwd: string) => boolean
  newRunId: () => string
  makeDeps: (emit: (e: WorkflowRunEvent) => void, runId: string) => EngineDeps
}
const ok = (data?: any) => ({ success: true, data })
const err = (e: string) => ({ success: false, error: e })

export function registerWorkflowIpc(ipcMain: { handle: (ch: string, fn: (ev: any, arg: any) => any) => void }, getWindow: () => any, w: Wiring) {
  const depsByRun = new Map<string, EngineDeps>()
  ipcMain.handle('workflow:list', async (_e, { cwd }) => { try { return ok(listWorkflows(workflowsDir(cwd), w.fs)) } catch (e: any) { return err(e.message) } })
  ipcMain.handle('workflow:read', async (_e, { cwd, id }) => { const r = readWorkflow(workflowsDir(cwd), id, w.fs); return r.ok ? ok(r.workflow) : err(r.errors.join('; ')) })
  ipcMain.handle('workflow:save', async (_e, { cwd, workflow }) => { try { writeWorkflow(workflowsDir(cwd), workflow, w.fs); return ok() } catch (e: any) { return err(e.message) } })
  ipcMain.handle('workflow:delete', async (_e, { cwd, id }) => { try { deleteWorkflow(workflowsDir(cwd), id, w.fs); return ok() } catch (e: any) { return err(e.message) } })
  ipcMain.handle('workflow:run', async (_e, { cwd, id }) => {
    if (!w.isTrusted(cwd)) return err('workspace not trusted — trust it before running workflows')
    const r = readWorkflow(workflowsDir(cwd), id, w.fs); if (!r.ok || !r.workflow) return err(r.errors.join('; '))
    const runId = w.newRunId()
    const emit = (ev: WorkflowRunEvent) => getWindow()?.webContents.send('workflow:run-event', ev)
    const deps = w.makeDeps(emit, runId)
    depsByRun.set(runId, deps)
    Promise.resolve(w.engine.runWorkflow(r.workflow, deps))
      .then((run) => { try { appendRunHistory(runsDir(cwd), run, w.fs) } catch { /* history is best-effort */ } })
      .catch(() => { /* engine already emitted a terminal event */ })
      .finally(() => depsByRun.delete(runId))
    return ok({ runId })
  })
  ipcMain.handle('workflow:cancel', async (_e, { runId }) => { const d = depsByRun.get(runId); if (d) w.engine.cancelRun(runId, d); return ok() })
}
```

Then in `src/main/index.ts` (inside `app.whenReady()`, after `mcpHandlers` is built ~line 2487, all wrapped in try/catch per the app-boot rule): import `fs`, `randomUUID`, the adapters, engine, and `registerWorkflowIpc`; pass `isTrusted: (cwd) => isWorkspaceTrusted(cwd)` (the existing trust store behind `workspace:is-trusted`, index.ts:2117 — spec §9), `newRunId: () => randomUUID()`, and `makeDeps: (emit, runId) => ({ terminal, agent, tools, timer: realTimer, now: Date.now, newRunId: () => runId, emit })` where `terminal`/`agent`/`tools` are the adapters bound to `spawnTerminal`/`writeToTerminal`/`killTerminal`, `detectAgentStatus`, and `executeTool(name,args,mcpHandlers)`. Binding `deps.newRunId` to the closed-over `runId` guarantees the engine's `run:*` events carry the **same** id the handler returned to the renderer.

- [ ] **Step 4: Add preload methods.** In `src/preload/index.ts` add to `api`:

```ts
  listWorkflows: (cwd) => ipcRenderer.invoke('workflow:list', { cwd }),
  readWorkflow: (cwd, id) => ipcRenderer.invoke('workflow:read', { cwd, id }),
  saveWorkflow: (cwd, workflow) => ipcRenderer.invoke('workflow:save', { cwd, workflow }),
  deleteWorkflow: (cwd, id) => ipcRenderer.invoke('workflow:delete', { cwd, id }),
  runWorkflow: (cwd, id) => ipcRenderer.invoke('workflow:run', { cwd, id }),
  cancelWorkflow: (runId) => ipcRenderer.invoke('workflow:cancel', { runId }),
  onWorkflowRunEvent: (cb) => { const h = (_: any, e: any) => cb(e); ipcRenderer.on('workflow:run-event', h); return () => ipcRenderer.removeListener('workflow:run-event', h) },
```

- [ ] **Step 5: Run + verify + commit.**

Run: `npx vitest run tests/electron/workflowIpc.test.ts` → PASS. Then `npm run typecheck` → PASS.

```bash
git add src/main/workflow/ipc.ts src/main/index.ts src/preload/index.ts tests/electron/workflowIpc.test.ts
git commit -m "feat(workflow): IPC surface (list/read/save/delete/run/cancel) + preload bridge"
```

---

## Task 11: Renderer store (retire `userWorkflows`, add runs)

**Files:**
- Modify: `src/renderer/src/store/terminalStore.ts`
- Test: `src/renderer/src/store/workflowStore.test.ts`

**Interfaces:**
- Produces store state `workflows: { id; name }[]`, `activeRuns: Record<string, WorkflowRun>`, and actions `setWorkflows`, `applyRunEvent(e: WorkflowRunEvent)`. `applyRunEvent` maintains a `WorkflowRun` per `runId` and handles all six event types via a shared `upsert` helper: `run:started` creates the run (status running); `step:started`/`step:status` upsert the `StepResult` status (creating a running placeholder if unseen); `step:output` appends `chunk` to the step's live `output` buffer; `step:finished` overwrites the step with the authoritative `StepResult`; `run:finished` sets terminal status. Events for an unknown `runId` (arriving before `run:started` or after the run left `activeRuns`) are ignored, not fatal. Remove `userWorkflows` + its 4 actions.

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useTerminalStore } from './terminalStore'
import type { WorkflowRunEvent } from '../types'

const s = () => useTerminalStore.getState()
describe('workflow run reducer', () => {
  beforeEach(() => s().setWorkflows([]))
  it('run:started creates a running run; step:finished records; run:finished closes', () => {
    const ev = (e: WorkflowRunEvent) => s().applyRunEvent(e)
    ev({ type: 'run:started', runId: 'r1', workflowId: 'wf', at: 1 })
    expect(s().activeRuns['r1'].status).toBe('running')
    ev({ type: 'step:finished', runId: 'r1', stepId: 'a', result: { stepId: 'a', status: 'succeeded', output: 'x' } })
    expect(s().activeRuns['r1'].steps[0].status).toBe('succeeded')
    ev({ type: 'run:finished', runId: 'r1', status: 'succeeded', at: 9 })
    expect(s().activeRuns['r1'].status).toBe('succeeded')
  })
  it('started→status→output→finished: records startedAt, marks running, accumulates chunks, finish overwrites with authoritative output', () => {
    const ev = (e: WorkflowRunEvent) => s().applyRunEvent(e)
    ev({ type: 'run:started', runId: 'r2', workflowId: 'wf', at: 1 })
    ev({ type: 'step:started', runId: 'r2', stepId: 'a', at: 5 })
    ev({ type: 'step:status', runId: 'r2', stepId: 'a', status: 'running' })
    expect(s().activeRuns['r2'].steps[0]).toMatchObject({ stepId: 'a', status: 'running', output: '', startedAt: 5 })
    ev({ type: 'step:output', runId: 'r2', stepId: 'a', chunk: 'hel' })
    ev({ type: 'step:output', runId: 'r2', stepId: 'a', chunk: 'lo' })
    expect(s().activeRuns['r2'].steps[0].output).toBe('hello')
    expect(s().activeRuns['r2'].steps).toHaveLength(1) // same step upserted, not duplicated
    ev({ type: 'step:finished', runId: 'r2', stepId: 'a', result: { stepId: 'a', status: 'succeeded', output: 'hello', exitCode: 0, startedAt: 5, endedAt: 12 } })
    expect(s().activeRuns['r2'].steps[0]).toMatchObject({ status: 'succeeded', exitCode: 0, output: 'hello', endedAt: 12 })
  })
  it('step:output before any status creates the step (running) and starts its output buffer', () => {
    const ev = (e: WorkflowRunEvent) => s().applyRunEvent(e)
    ev({ type: 'run:started', runId: 'r3', workflowId: 'wf', at: 1 })
    ev({ type: 'step:output', runId: 'r3', stepId: 'z', chunk: 'first' })
    expect(s().activeRuns['r3'].steps[0]).toMatchObject({ stepId: 'z', status: 'running', output: 'first' })
  })
  it('ignores events for an unknown/finished run without crashing', () => {
    s().applyRunEvent({ type: 'step:output', runId: 'ghost', stepId: 'a', chunk: 'x' } as WorkflowRunEvent)
    expect(s().activeRuns['ghost']).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run → FAIL** (`applyRunEvent` undefined). Run: `npx vitest run src/renderer/src/store/workflowStore.test.ts`.

- [ ] **Step 3: Implement.** In `terminalStore.ts`: replace `userWorkflows` field + its 4 actions with:

```ts
  workflows: [] as { id: string; name: string }[],
  activeRuns: {} as Record<string, import('../types').WorkflowRun>,
  setWorkflows: (workflows: { id: string; name: string }[]) => set({ workflows }),
  applyRunEvent: (e: import('../types').WorkflowRunEvent) => set(st => {
    const runs = { ...st.activeRuns }
    if (e.type === 'run:started') runs[e.runId] = { runId: e.runId, workflowId: e.workflowId, status: 'running', steps: [], startedAt: e.at }
    const run = runs[e.runId]; if (!run) return { activeRuns: runs } // event for an unknown/finished run -> ignore
    const upsert = (stepId: string, patch: Partial<import('../types').StepResult>) => {
      const steps = [...run.steps]
      const i = steps.findIndex(x => x.stepId === stepId)
      if (i >= 0) steps[i] = { ...steps[i], ...patch }
      else steps.push({ stepId, status: 'running', output: '', ...patch })
      runs[e.runId] = { ...run, steps }
    }
    if (e.type === 'step:started') upsert(e.stepId, { status: 'running', startedAt: e.at }) // records startedAt so the UI can show a live elapsed timer
    if (e.type === 'step:status') upsert(e.stepId, { status: e.status })
    if (e.type === 'step:output') upsert(e.stepId, { output: (run.steps.find(x => x.stepId === e.stepId)?.output ?? '') + e.chunk })
    if (e.type === 'step:finished') upsert(e.result.stepId, e.result) // final result.output is authoritative (full 32 KB tail)
    if (e.type === 'run:finished') runs[e.runId] = { ...run, status: e.status, endedAt: e.at }
    return { activeRuns: runs }
  }),
```

Remove the `WorkflowTemplate` import if now unused elsewhere. Grep for `userWorkflows` and delete remaining references.

- [ ] **Step 4: Run → PASS**, then `npm run typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add src/renderer/src/store/terminalStore.ts src/renderer/src/store/workflowStore.test.ts
git commit -m "feat(workflow): renderer run-state reducer; retire userWorkflows"
```

---

## Task 12: Sidebar Workflows section + retire toolbar icon

**Files:**
- Create: `src/renderer/src/components/Workflow/WorkflowSidebarSection.tsx`
- Modify: `src/renderer/src/components/Sidebar/Sidebar.tsx`
- Test: `src/renderer/src/components/Workflow/WorkflowSidebarSection.test.tsx`

**Interfaces:**
- Consumes: store `workflows`, `activeRuns` (Task 11).
- Produces: `<WorkflowSidebarSection onOpen={(id)=>void} onCreate={()=>void} />` — a collapsible `WORKFLOWS (n)` list; a row whose id has an `activeRuns` entry with status `running` shows a pulsing dot (`animate-pulse`).

- [ ] **Step 1: Write the failing test.**

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WorkflowSidebarSection } from './WorkflowSidebarSection'
import { useTerminalStore } from '../../store/terminalStore'

describe('WorkflowSidebarSection', () => {
  it('lists workflows and pulses a running one', () => {
    useTerminalStore.getState().setWorkflows([{ id: 'a', name: 'Deploy' }, { id: 'b', name: 'ETL' }])
    useTerminalStore.getState().applyRunEvent({ type: 'run:started', runId: 'r', workflowId: 'a', at: 1 } as any)
    render(<WorkflowSidebarSection onOpen={() => {}} onCreate={() => {}} />)
    expect(screen.getByText('Deploy')).toBeTruthy()
    expect(document.querySelector('.animate-pulse')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/renderer/src/components/Workflow/WorkflowSidebarSection.test.tsx`.

- [ ] **Step 3: Implement the component** (mirror the `TERMINALS` section markup in `Sidebar.tsx:143-149`), reading `workflows` + deriving `running` from `Object.values(activeRuns).some(r => r.workflowId === id && r.status === 'running')`, rendering the pulsing dot exactly like `Sidebar.tsx:130`. Then wire into `Sidebar.tsx`: import + render `<WorkflowSidebarSection .../>` under `<WorkspaceList/>`; **remove** the `fa-cubes` button (`:102-106`), the `showWorkflows` state (`:34`), and the `{showWorkflows && <WorkflowTemplates .../>}` render (`:178`); drop the now-unused `WorkflowTemplates` import.

- [ ] **Step 4: Add the retired-icon regression test** to the same spec:

```tsx
import { Sidebar } from '../Sidebar/Sidebar'
it('the legacy fa-cubes workflow toolbar button is gone', () => {
  render(<Sidebar />)
  expect(document.querySelector('.fa-cubes')).toBeNull()
})
```
Run both → PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/renderer/src/components/Workflow/WorkflowSidebarSection.tsx src/renderer/src/components/Workflow/WorkflowSidebarSection.test.tsx src/renderer/src/components/Sidebar/Sidebar.tsx
git commit -m "feat(workflow): sidebar Workflows section; retire fa-cubes toolbar button"
```

---

## Task 13: Workflow Designer (Logic-Apps cards + inline "+")

**Files:**
- Create: `src/renderer/src/components/Workflow/WorkflowDesigner.tsx`, `src/renderer/src/components/Workflow/stepEditors.tsx`
- Test: `src/renderer/src/components/Workflow/WorkflowDesigner.test.tsx`

**Interfaces:**
- Consumes: `Workflow`/step types; `window.termpolis.saveWorkflow`.
- Produces: `<WorkflowDesigner workflow={Workflow} cwd={string} onSaved={()=>void} />`. A trigger card (Manual active; Schedule/gitPush/fileWatch disabled), one action card per step, and an inline **"+"** at every gap that opens a type picker **at that gap** and inserts the chosen step there (never a shared bottom menu — this is the corrected mockup behavior). `insertStep(steps, index, type)` is a pure exported helper so insertion position is unit-tested directly.

- [ ] **Step 1: Write the failing tests.**

```tsx
import { describe, it, expect } from 'vitest'
import { insertStep } from './WorkflowDesigner'

describe('insertStep', () => {
  it('inserts a new step of the chosen type at the given gap index', () => {
    const steps = [
      { id: 'a', type: 'command', name: 'A', source: 'inline', command: '' },
      { id: 'b', type: 'command', name: 'B', source: 'inline', command: '' },
    ] as any
    const out = insertStep(steps, 1, 'agent')  // gap between A and B
    expect(out.map((s: any) => s.type)).toEqual(['command', 'agent', 'command'])
    expect(out[1].id).not.toBe('a')
  })
  it('appends at the tail gap', () => {
    const out = insertStep([{ id: 'a', type: 'command', name: 'A', source: 'inline', command: '' }] as any, 1, 'control')
    expect(out[1].type).toBe('control')
  })
})
```

Plus a render/interaction test:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowDesigner } from './WorkflowDesigner'
it('clicking the gap "+" inserts a card at that position', () => {
  const wf = { id: 'x', name: 'X', version: 1 as const, trigger: { type: 'manual' as const }, steps: [
    { id: 'a', type: 'command' as const, name: 'A', source: 'inline' as const, command: '' },
  ] }
  render(<WorkflowDesigner workflow={wf} cwd="/r" onSaved={() => {}} />)
  fireEvent.click(screen.getAllByTitle('Insert a step')[0]) // the head gap
  fireEvent.click(screen.getByText('Command'))
  expect(screen.getAllByTestId('step-card').length).toBe(2)
})
```

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/renderer/src/components/Workflow/WorkflowDesigner.test.tsx`.

- [ ] **Step 3: Implement.** `insertStep(steps, index, type)` returns a new array with a freshly-id'd default step (`crypto.randomUUID()` in the renderer is allowed) of `type` spliced at `index`. `WorkflowDesigner` renders the trigger card, then for each gap index `0..steps.length` an inline "+" (title `"Insert a step"`) that toggles a picker (`Command`/`Agent`/`Skill`/`Control`) rendered **at that gap**; choosing inserts via `insertStep` and closes the picker. Each card (`data-testid="step-card"`) renders `stepEditors.tsx` for its type. A Save button calls `window.termpolis.saveWorkflow(cwd, current)` then `onSaved()`. Match the approved mockup's card visuals (type color rail, expand/collapse head).

The pure helpers (exported from `WorkflowDesigner.tsx` so they're unit-tested without rendering) — `defaultStep` returns a **valid** minimal step of each type, so an inserted card passes `validateWorkflow` unchanged:

```ts
import type { WorkflowStep, WorkflowStepType } from '../../types'

export function defaultStep(type: WorkflowStepType): WorkflowStep {
  const id = crypto.randomUUID()
  switch (type) {
    case 'command': return { id, type, name: 'Run command', source: 'inline', command: '', shell: 'bash', visible: false }
    case 'agent':   return { id, type, name: 'Ask agent', agent: 'claude', prompt: '' }
    case 'skill':   return { id, type, name: 'Run skill', tool: '', args: {} }
    case 'control': return { id, type, name: 'Wait', action: 'wait', config: { ms: 1000 } }
  }
}

export function insertStep(steps: WorkflowStep[], index: number, type: WorkflowStepType): WorkflowStep[] {
  const next = steps.slice()
  next.splice(index, 0, defaultStep(type))
  return next
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit.**

```bash
git add src/renderer/src/components/Workflow/WorkflowDesigner.tsx src/renderer/src/components/Workflow/stepEditors.tsx src/renderer/src/components/Workflow/WorkflowDesigner.test.tsx
git commit -m "feat(workflow): Logic-Apps designer with gap-anchored inline step insertion"
```

---

## Task 14: Workflow Runner (progress + live panes)

**Files:**
- Create: `src/renderer/src/components/Workflow/WorkflowRunner.tsx`
- Test: `src/renderer/src/components/Workflow/WorkflowRunner.test.tsx`

**Interfaces:**
- Consumes: `Workflow`, store `activeRuns`, `window.termpolis.runWorkflow`/`cancelWorkflow`/`onWorkflowRunEvent`.
- Produces: `<WorkflowRunner workflow={Workflow} runId={string | null} cwd={string} />` — a progress timeline (one node per step, colored by `StepStatus`, showing exit code + duration) and a Run/Cancel bar. Live Command/Agent panes are the existing terminal component keyed by `stepId` (rendered when a step is `running` and `visible`).

- [ ] **Step 1: Write the failing test.**

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WorkflowRunner } from './WorkflowRunner'
import { useTerminalStore } from '../../store/terminalStore'

describe('WorkflowRunner', () => {
  it('renders a timeline node per step and reflects statuses from the store', () => {
    const wf = { id: 'x', name: 'X', version: 1 as const, trigger: { type: 'manual' as const }, steps: [
      { id: 'a', type: 'command' as const, name: 'Build', source: 'inline' as const, command: '' },
      { id: 'b', type: 'command' as const, name: 'Test', source: 'inline' as const, command: '' },
    ] }
    useTerminalStore.getState().applyRunEvent({ type: 'run:started', runId: 'r', workflowId: 'x', at: 1 } as any)
    useTerminalStore.getState().applyRunEvent({ type: 'step:finished', runId: 'r', stepId: 'a', result: { stepId: 'a', status: 'succeeded', output: '', exitCode: 0 } } as any)
    render(<WorkflowRunner workflow={wf} runId="r" cwd="/r" />)
    expect(screen.getByText('Build')).toBeTruthy()
    expect(screen.getByText('Test')).toBeTruthy()
    expect(screen.getByTestId('step-node-a').className).toMatch(/succeed|green/i)
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Read the live run from `activeRuns[runId]`; for each `workflow.steps[i]` render a node (`data-testid={`step-node-${id}`}`) whose class encodes the matching `StepResult.status` (fallback `pending`), with exit code + `endedAt-startedAt` ms when present. Run button calls `window.termpolis.runWorkflow(cwd, workflow.id)`; Cancel calls `cancelWorkflow(runId)`. Subscribe once via `onWorkflowRunEvent(applyRunEvent)` in a `useEffect` (unsubscribe on unmount).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit.**

```bash
git add src/renderer/src/components/Workflow/WorkflowRunner.tsx src/renderer/src/components/Workflow/WorkflowRunner.test.tsx
git commit -m "feat(workflow): live Run view — progress timeline + cancel + event subscription"
```

---

## Task 15: E2E + wire into CI

**Files:**
- Create: `e2e/workflow-orchestrator.spec.ts`
- Modify: `.github/workflows/test.yml` (add the spec by name to `e2e-smoke` and `e2e-smoke-macos`)
- Audit: grep `e2e/` for stale assertions that click the retired `fa-cubes`/`WorkflowTemplates` and update them.

**Interfaces:**
- Consumes: the running app (Playwright + Electron), the same launch harness the existing smoke specs use (copy their `_electron.launch` boilerplate).

- [ ] **Step 1: Write the failing e2e.** Model it on an existing `e2e/*smoke*.spec.ts`. Flow: launch → open the Workflows sidebar section → New Workflow → add a **Command** step (`command: exit 0`, `visible:false`), a **Control** notify step → Save → Run → assert the timeline for both steps reaches `succeeded` (poll the `step-node-*` classes) and the run bar shows completion. Keep agent CLIs out of CI (cover agent-done in unit fakes).

- [ ] **Step 2: Run locally headless to verify it fails then passes as you implement UI wiring.** Run: `npx playwright test e2e/workflow-orchestrator.spec.ts`.

- [ ] **Step 3: Wire CI.** In `.github/workflows/test.yml`, in BOTH `e2e-smoke` (ubuntu, `xvfb-run`) and `e2e-smoke-macos`, add a step:

```yaml
      - name: E2E — workflow orchestrator
        run: xvfb-run -a npx playwright test e2e/workflow-orchestrator.spec.ts
```
(macOS variant without `xvfb-run`, matching the sibling steps.)

- [ ] **Step 4: Audit legacy e2e.** Grep and fix:

```bash
grep -rn "fa-cubes\|WorkflowTemplates\|Workflows\"" e2e/ || true
```
Update any spec that clicked the retired icon so the suite stays green.

- [ ] **Step 5: Commit.**

```bash
git add e2e/workflow-orchestrator.spec.ts .github/workflows/test.yml
git commit -m "test(workflow): e2e author→run→green + wire named specs into CI"
```

---

## Task 16: Starter templates, full-suite gate, release

**Files:**
- Modify: `src/renderer/src/components/Workflow/WorkflowSidebarSection.tsx` (seed built-in starter workflows on first open if none exist)
- Modify: `package.json` (version bump)

- [ ] **Step 1: Seed starter workflows.** Re-express the legacy `BUILT_IN_WORKFLOWS` presets as starter `Workflow` objects (each a Command step that opens the pane), offered as "New from template" in the sidebar `+` menu. Add a unit test asserting a starter template validates via `validateWorkflow`.

- [ ] **Step 2: Full local gate.**

Run: `npm run test:coverage`
Expected: PASS with coverage ≥ floors (lines 97 / functions 96 / branches 93 / statements 96). If any new file drags a metric under, add the missing-branch test named in §10 of the spec — never lower the gate.

Run: `npm run typecheck && npm run lint`
Expected: both PASS (watch for stray NBSP).

- [ ] **Step 3: Commit + bump version.** Edit `package.json` `version` to the next minor (e.g. `1.31.0`).

```bash
git add package.json src/renderer/src/components/Workflow/WorkflowSidebarSection.tsx
git commit -m "feat(workflow): starter templates + v1.31.0"
```

- [ ] **Step 4: Push + tag (triggers release).**

```bash
git push origin main
git tag v1.31.0 && git push origin v1.31.0
```
Expected: `release.yml` builds/signs/publishes; `test.yml` runs the full vitest suite + the new named e2e specs green.

- [ ] **Step 5: Verify CI.** Confirm the release + test workflows go green (`gh run watch` LIES — verify with `gh run list --json conclusion`). Backfill any coverage hole surfaced only by the full suite (per the "only the full suite catches it" rule).

---

## Feature × Proving-Test Matrix

Every step type and feature maps to a test (satisfies the "100% tested, all features work" requirement):

| Feature | Proving test |
|---------|--------------|
| Command: exit 0 / exit≠0 | Task 5 "exit 0 -> succeeded", "exit != 0 -> failed" |
| Command: `timeoutMs` | Task 5 "timedOut -> failed"; Task 9 "timeout kills the pty" |
| Command: `source:file` (bash/python/node/ps1) | Task 5 "source:file runs the script", "infers python" |
| Command: `${steps.*}` interpolation | Task 5 "interpolates ... into the command" |
| Expr: interpolation `$`-replacement-safe + missing field → empty | Task 2 "inserts output containing $-replacement patterns literally", "renders a missing exitCode as empty" |
| Expr: all 7 operators, longest-first + spaces-required | Task 2 "supports all comparison operators ...", "requires spaces around the operator" |
| Command: 32 KB tail cap | Task 5 "caps captured output at 32KB" |
| Command: `visible` | Task 9 adapter (`exit $?` only when headless) |
| Agent: idle-done / timeout / `doneMarker` | Task 6 passthrough + Task 9 adapter poll test |
| Agent: prompt interpolation | Task 6 "ok:true -> succeeded, prompt interpolated" |
| Agent: status mapping (errored/blocked) | Task 9 adapter test |
| Skill: invoke + arg interpolation / error | Task 7 both cases |
| Control: wait / branch / loop / notify | Task 4 four describes |
| Gate `when` skip | Task 8 "gate when:false skips" |
| `continueOnError` | Task 8 "continueOnError lets the run proceed" |
| Data flow across steps | Task 8 "data flows from step a into step b" |
| Branch `goto` jump | Task 8 "branch goto jumps forward" |
| Branch `goto` → unknown step falls through safely | Task 8 "a branch goto to an unknown step id ..." |
| Loop until/max | Task 8 "loop re-runs ... until" |
| Loop `maxIterations` clamped to ceiling | Task 4 "clamps a huge maxIterations", "coerces a missing/zero maxIterations" |
| Runaway backward `goto` aborts at run budget (no hang) | Task 8 "aborts a runaway backward branch goto" |
| Hard-failure stop | Task 8 "hard failure stops the run" |
| Cancel mid-run | Task 8 cancel path + Task 14 Cancel button |
| Event stream ordering | Task 8 "runs steps in order and finishes" (asserts first/last events) |
| YAML round-trip / malformed | Task 3 round-trip + malformed |
| Validation (missing/dup/unknown) | Task 3 validate cases |
| Validation: per-type enums (source/agent/action) | Task 3 "rejects invalid per-type enums" |
| Security: path-traversal id rejected (validate + read + delete) | Task 3 "rejects a workflow id with path-traversal", "read/delete refuse a path-traversal id" |
| Security: `writeWorkflow` validates before persisting (untrusted renderer) | Task 3 "writeWorkflow refuses to persist an invalid workflow" |
| IPC list/read/save/delete/run | Task 10 IPC harness |
| IPC run returns the same `runId` events carry | Task 10 "run returns the runId ..." |
| Trust gate blocks run on untrusted workspace (spec §9) | Task 10 "run on an untrusted workspace is refused" |
| Run history appended to `runs/<id>.jsonl` | Task 3 `appendRunHistory` + Task 10 "a finished run is appended to history" |
| Run-state reducer: run lifecycle (started/finished) | Task 11 "run:started creates ... run:finished closes" |
| Run-state reducer: live output streaming (`step:output` accumulates) | Task 11 "started→status→output→finished ..." |
| Run-state reducer: running status + `startedAt` (`step:started`/`step:status`) | Task 11 "started→status→output→finished ...", "step:output before any status ..." |
| Run-state reducer: event for unknown run ignored (no crash) | Task 11 "ignores events for an unknown/finished run" |
| Sidebar list + pulsing active | Task 12 render test |
| Retired toolbar icon | Task 12 regression test |
| Designer gap-anchored insert | Task 13 `insertStep` + click test |
| Runner timeline + statuses | Task 14 render test |
| End-to-end author→run→green | Task 15 e2e |

---

## Notes for the Implementer

- The engine and all executors are **pure of wall-clock/random** — never import `Date.now` there; use `deps.now`/`deps.timer`. Only `adapters.ts` touches real timers (and is tested with `vi.useFakeTimers`).
- Keep `src/main/workflow/*` files single-responsibility; if `executors.ts` grows unwieldy, split per type — but the shared `tail`/`Results`/`interpolate` imports must not duplicate.
- The 32 KB cap mirrors the existing `terminalOutputBuffers` cap (`index.ts:411`) — keep them equal.
- **Two independent infinite-loop guards, both mandatory** (a workflow is user-authored and can express cycles): (1) `MAX_LOOP_ITERATIONS` (1000) clamps any single control-loop in `executeControlStep`; (2) `MAX_STEP_EXECUTIONS` (1000), a run-wide counter in `runWorkflow`, bounds backward branch `goto`s and is threaded into `runLoop` so nested loops share it. Neither is optional — a backward `goto` with an always-true condition, or a huge `maxIterations` with an `until` that never holds, must terminate as `failed`, never hang. If you tune the constants, keep both and keep their tests.
- Coverage `include` covers these files; the pure core should hit ~100%, executors/engine near-100% via fakes, components via testing-library. Platform-gated `win32` arms are the only expected holes.
- Everything commits directly to `main`. No PRs.
```
