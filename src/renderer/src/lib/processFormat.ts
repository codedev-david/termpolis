/**
 * Wording and number formatting for Settings ▸ Processes. Kept out of the component so the
 * kill-result sentence is tested on its own and the component file exports only a component.
 */
import type { StuckKillResultView, StuckProcessView } from '../types'

/** Identifies one process across scans: a pid alone can be handed to a new process. */
export function processKey(p: Pick<StuckProcessView, 'pid' | 'created'>): string {
  return `${p.pid}:${p.created}`
}

/** 45s, 12m, 3h 20m, 2d 4h. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  let v = n
  let u = 0
  while (v >= 1024 && u < BYTE_UNITS.length - 1) {
    v /= 1024
    u++
  }
  return `${u === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${BYTE_UNITS[u]}`
}

/** CPU time actually used, which is what separates a hung process from a runaway one. */
export function formatCpu(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s'
  if (sec < 1) return '<1s'
  if (sec < 60) return `${Math.floor(sec)}s`
  return formatAge(sec * 1000)
}

/** Each distinct reason once, in the order first seen, without a full stop of its own. */
function distinctReasons(reasons: string[]): string {
  const seen = new Set<string>()
  for (const r of reasons) seen.add(r.replace(/[\s.]+$/, '').trim() || 'no reason given')
  return [...seen].join('; ')
}

export function describeKillResult(r: StuckKillResultView): string {
  const n = r.killed.length
  const parts = [n > 0 ? `Killed ${n} ${n === 1 ? 'process' : 'processes'}.` : 'Nothing was killed.']
  if (r.failed.length > 0) parts.push(`${r.failed.length} could not be killed: ${distinctReasons(r.failed.map((f) => f.error))}.`)
  const s = r.skipped.length
  if (s > 0) parts.push(`${s} ${s === 1 ? 'was' : 'were'} skipped: ${distinctReasons(r.skipped.map((k) => k.reason))}.`)
  return parts.join(' ')
}

/** Green when all of it was ended, amber when some of it was not, red when a failure stopped all of it. */
export function killResultTone(r: StuckKillResultView): 'ok' | 'warn' | 'bad' {
  if (r.failed.length > 0 && r.killed.length === 0) return 'bad'
  if (r.failed.length > 0 || r.skipped.length > 0 || r.killed.length === 0) return 'warn'
  return 'ok'
}

export const AGENT_LABEL: Record<NonNullable<StuckProcessView['agent']>, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
}

export const REASON_HINT: Record<StuckProcessView['reasons'][number], string> = {
  headless: 'Running with no window: a script, hook, scheduled job or swarm worker started it.',
  orphaned: 'The program that started it has exited, so nothing will ever stop it.',
  suspended: 'Frozen: every thread is suspended, so it will never finish on its own.',
  'long-running': 'Git has been running for more than 30 minutes.',
}

/** A chip's tooltip. On macOS and Linux "suspended" is a stopped job, which is not frozen for good. */
export function reasonHint(r: StuckProcessView['reasons'][number], platform: string): string {
  if (r === 'suspended' && platform !== 'win32') return 'Stopped (e.g. Ctrl+Z): it will not run again until something resumes it.'
  return REASON_HINT[r]
}

export function ownerLabel(p: Pick<StuckProcessView, 'owner' | 'parentName'>): string {
  if (p.owner === 'termpolis') return 'started from Termpolis'
  if (p.owner === 'orphaned') return 'parent exited'
  return `under ${p.parentName ?? 'another program'}`
}
