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
