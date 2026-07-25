import YAML from 'yaml'
import { join } from 'path'
import type { Workflow, WorkflowStep, WorkflowRun, WorkflowScope } from '../../renderer/src/types'

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

// ---------------------------------------------------------------------------
// Scope: a workflow is either a project's own or a global one offered in every
// project. The two are ordinary directories with identical layout — the only
// difference is where they live, so everything below takes a plain `dir`.
// ---------------------------------------------------------------------------

/** Global store root. `userDataDir` is `app.getPath('userData')` in production. */
export function globalWorkflowsDir(userDataDir: string): string {
  return join(userDataDir, 'workflows')
}

export function globalRunsDir(userDataDir: string): string {
  return join(userDataDir, 'workflows', 'runs')
}

/** Resolve the store a scope refers to. A global run still executes in the
 *  project the user is standing in — only the definition is shared. */
export function dirForScope(scope: WorkflowScope, cwd: string, userDataDir: string): string {
  return scope === 'global' ? globalWorkflowsDir(userDataDir) : workflowsDir(cwd)
}

export function runsDirForScope(scope: WorkflowScope, cwd: string, userDataDir: string): string {
  return scope === 'global' ? globalRunsDir(userDataDir) : runsDir(cwd)
}

export function appendRunHistory(dir: string, run: WorkflowRun, fs: FsLike): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(join(dir, `${run.workflowId}.jsonl`), JSON.stringify(run) + '\n')
}

const STEP_TYPES = new Set(['command', 'agent', 'skill', 'control'])
// Kept in lockstep with WorkflowTriggerType in renderer/src/types. A workflow
// carrying an unknown trigger type is rejected at save AND at load, so a
// hand-edited or downgraded file can never arm something the supervisor
// doesn't understand.
const TRIGGER_TYPES = new Set(['manual', 'schedule', 'gitCommit', 'gitPush', 'fileWatch'])

// Per-type structural checks: enums must be valid. Free-text fields (command/prompt/tool)
// may be blank at save time (a draft) — the executors handle empties at run time.
function validateStep(s: any): string[] {
  const e: string[] = []
  if (s.type === 'command' && s.source !== 'inline' && s.source !== 'file') e.push(`command ${s.id}: source must be 'inline' or 'file'`)
  if (s.type === 'agent' && !['claude', 'codex', 'gemini'].includes(s.agent)) e.push(`agent ${s.id}: agent must be claude|codex|gemini`)
  if (s.type === 'control' && !['wait', 'branch', 'loop', 'notify'].includes(s.action)) e.push(`control ${s.id}: action must be wait|branch|loop|notify`)
  return e
}

// An input name is substituted into command lines and prompts as `${inputs.x}`,
// so it must be a plain identifier — anything looser and a hand-edited file
// could smuggle regex/expression syntax into the interpolation.
export const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function validateInputs(inputs: unknown): string[] {
  if (inputs === undefined) return []
  if (!Array.isArray(inputs)) return ['inputs must be an array']
  const errors: string[] = []
  const seen = new Set<string>()
  for (const raw of inputs) {
    const i = raw as any
    if (!i || typeof i !== 'object' || Array.isArray(i)) { errors.push('input must be an object'); continue }
    if (typeof i.name !== 'string' || !INPUT_NAME.test(i.name)) {
      errors.push(`input name must match ${INPUT_NAME.source}: ${JSON.stringify(i.name)}`)
      continue
    }
    if (seen.has(i.name)) errors.push(`duplicate input: ${i.name}`)
    seen.add(i.name)
    for (const k of ['label', 'description', 'default'] as const) {
      if (i[k] !== undefined && typeof i[k] !== 'string') errors.push(`input ${i.name}: ${k} must be a string`)
    }
    if (i.required !== undefined && typeof i.required !== 'boolean') errors.push(`input ${i.name}: required must be a boolean`)
  }
  return errors
}

export function validateWorkflow(obj: unknown): { ok: boolean; errors: string[]; workflow?: Workflow } {
  const errors: string[] = []
  const o = obj as any
  if (!o || typeof o !== 'object') return { ok: false, errors: ['not an object'] }
  if (typeof o.id !== 'string' || !o.id.trim()) errors.push('missing id')
  else if (!isSafeId(o.id)) errors.push('id may contain only letters, digits, hyphen, underscore (no path separators)')
  if (typeof o.name !== 'string' || !o.name.trim()) errors.push('missing name')
  if (!o.trigger || typeof o.trigger.type !== 'string') errors.push('missing trigger.type')
  else if (!TRIGGER_TYPES.has(o.trigger.type)) errors.push(`trigger.type must be one of ${[...TRIGGER_TYPES].join('|')}`)
  else if (o.trigger.config !== undefined && (typeof o.trigger.config !== 'object' || o.trigger.config === null || Array.isArray(o.trigger.config))) {
    errors.push('trigger.config must be a string map')
  }
  if (o.category !== undefined && typeof o.category !== 'string') errors.push('category must be a string')
  errors.push(...validateInputs(o.inputs))
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
  // `scope` is derived from the directory the file lives in, so persisting it
  // would let a stale value contradict reality after a move.
  const { scope: _scope, ...rest } = wf
  return YAML.stringify(rest)
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

/** Every valid workflow in a project, fully parsed. The trigger supervisor needs
 *  the whole document (it arms off `trigger`), where the sidebar only needs the
 *  id/name summary `listWorkflows` returns. */
export function listWorkflowsFull(dir: string, fs: FsLike, scope?: WorkflowScope): Workflow[] {
  if (!fs.existsSync(dir)) return []
  const out: Workflow[] = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.yml')) continue
    const id = f.replace(/\.yml$/, '')
    if (!isSafeId(id)) continue // ignore stray/hostile file names, never let fileFor throw here
    const r = parseWorkflow(fs.readFileSync(fileFor(dir, id), 'utf8'))
    if (r.ok && r.workflow) out.push(scope ? { ...r.workflow, scope } : r.workflow)
  }
  return out
}

export type WorkflowSummary = { id: string; name: string; category?: string; scope?: WorkflowScope }

export function listWorkflows(dir: string, fs: FsLike, scope?: WorkflowScope): WorkflowSummary[] {
  return listWorkflowsFull(dir, fs, scope).map(w => ({ id: w.id, name: w.name, category: w.category, scope: w.scope }))
}

export function readWorkflow(dir: string, id: string, fs: FsLike, scope?: WorkflowScope): { ok: boolean; errors: string[]; workflow?: Workflow } {
  if (!isSafeId(id)) return { ok: false, errors: [`unsafe workflow id: ${JSON.stringify(id)}`] }
  const p = fileFor(dir, id)
  if (!fs.existsSync(p)) return { ok: false, errors: [`not found: ${id}`] }
  const r = parseWorkflow(fs.readFileSync(p, 'utf8'))
  return r.ok && r.workflow && scope ? { ...r, workflow: { ...r.workflow, scope } } : r
}

export function deleteWorkflow(dir: string, id: string, fs: FsLike): void {
  const p = fileFor(dir, id)
  if (fs.existsSync(p)) fs.rmSync(p, { force: true })
}
