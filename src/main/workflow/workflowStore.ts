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
