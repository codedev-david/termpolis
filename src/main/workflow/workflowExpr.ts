import type { StepResult } from '../../renderer/src/types'

type Results = Record<string, StepResult>

/** Everything a workflow can reference besides its own step results, so one
 *  saved workflow can behave differently per project and per run.
 *  Optional and threaded through as a trailing argument, so a caller that only
 *  has step results (most tests, the control-step evaluator) is unchanged. */
export interface ExprScope {
  /** `${inputs.<name>}` — values collected before the run. */
  inputs?: Record<string, string>
  /** `${project.cwd|name|branch}` — where this run is happening. */
  project?: { cwd?: string; name?: string; branch?: string }
}

const PROJECT_FIELDS = new Set(['cwd', 'name', 'branch'])

function resolveRef(ref: string, results: Results, scope?: ExprScope): string | undefined {
  const t = ref.trim()
  const m = t.match(/^steps\.([\w-]+)\.(output|exitCode|status)$/)
  if (m) {
    const r = results[m[1]]
    if (!r) return ''
    const v = (r as any)[m[2]]
    return v === undefined || v === null ? '' : String(v)
  }
  const i = t.match(/^inputs\.([A-Za-z_][A-Za-z0-9_]*)$/)
  // An unset input resolves to '' rather than staying literal — a workflow that
  // interpolates a missing value must not paste `${inputs.x}` into a command line.
  if (i) { const v = scope?.inputs?.[i[1]]; return v === undefined || v === null ? '' : String(v) }
  const p = t.match(/^project\.(\w+)$/)
  if (p && PROJECT_FIELDS.has(p[1])) {
    const v = (scope?.project as any)?.[p[1]]
    return v === undefined || v === null ? '' : String(v)
  }
  return undefined
}

// Only these three namespaces are substituted. Anything else (`${HOME}`, a shell
// `${var}`) is left verbatim for the shell to handle.
const REF = /(?:\$\{|\{\{)\s*(steps\.[\w-]+\.\w+|inputs\.\w+|project\.\w+)\s*(?:\}\}|\})/g

export function interpolate(text: string, results: Results, scope?: ExprScope): string {
  return text.replace(REF, (_all, ref) => {
    // A token in a known namespace but with an unknown field collapses to ''
    // rather than leaking the raw `${...}` into a command line.
    const v = resolveRef(ref, results, scope)
    return v === undefined ? '' : v
  })
}

// Operators longest-first so >= is not read as >.
const OPS = ['>=', '<=', '==', '!=', '=~', '>', '<'] as const

function operand(token: string, results: Results, scope?: ExprScope): { num?: number; str: string } {
  const t = token.trim()
  const ref = resolveRef(t, results, scope)
  const raw = ref !== undefined ? ref : t.replace(/^['"]|['"]$/g, '')
  const num = raw !== '' && !isNaN(Number(raw)) ? Number(raw) : undefined
  return { num, str: raw }
}

export function evalCondition(expr: string, results: Results, scope?: ExprScope): boolean {
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
    const lhs = operand(e.slice(0, i), results, scope)
    const rhs = operand(e.slice(i + op.length + 2), results, scope)
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
