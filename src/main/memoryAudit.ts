// memoryAudit.ts — WP-E: an ON-BY-DEFAULT, local, inspectable, secret-redacted audit trail of what
// the memory/learning system actually DID: what it stored (write), what it recalled (recall), what
// it learned (learn: feedback/reflect/consolidate/decay/link), and what it injected into an agent's
// context (inject). This answers "show me exactly what my memory did" — the thing a keyword-notes
// memory (Claude Desktop / Codex / Antigravity) cannot.
//
// Distinct from the AI Security audit (aiSecurity.ts), which is DEFAULT-OFF and about cloud egress.
// This is:
//   - DEFAULT ON (it's the brain auditing itself), with a privacy opt-out (setMemoryAuditEnabled).
//   - LOCAL-ONLY — the file never leaves the machine (same trust boundary as the memory store).
//   - SECRET-SAFE — every free-text preview is run through the secret scanner, so a stored or queried
//     secret is masked before it is written.
//   - BOUNDED — the log is capped and rotated (one previous generation kept), so it can't grow
//     without limit.
//   - BEST-EFFORT — auditing never throws into the caller; a failed append must not break a memory op.
import { appendFileSync, existsSync, readFileSync, statSync, renameSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { scanText } from './aiSecurity'

export type MemoryAuditEvent =
  | { event: 'write'; id: string; kind: string; agentId?: string; preview: string }
  | { event: 'recall'; agentId?: string; query: string; results: number; topIds: string[] }
  | { event: 'learn'; kind: 'feedback' | 'reflect' | 'consolidate' | 'decay' | 'link'; detail: string }
  | { event: 'inject'; target: string; memoryIds: string[]; approxTokens: number }

export type MemoryAuditRecord = { ts: number } & MemoryAuditEvent

const FILE = 'memory-audit.jsonl'
const PREV = 'memory-audit.prev.jsonl'
const MAX_BYTES = 2_000_000 // ~2 MB live file, then rotate (one previous generation kept)
let maxBytes = MAX_BYTES
const PREVIEW_MAX = 160
const SCAN_MAX = 4096 // cap the bytes we redaction-scan per field so a huge memory can't stall a write

let dir: string | null = null
let enabled = true // WP-E: default ON
let liveBytes = -1 // in-process size of the live file; -1 = stat lazily on first append (O(1) per write)

export function initMemoryAudit(d: string): void {
  // Point at the memory data dir (which the app/store already creates). We deliberately do NOT
  // create it here — the audit is best-effort, and creating it would mask a genuine store-init
  // failure (e.g. a missing parent dir). If the dir is absent, appendFileSync simply no-ops.
  dir = d
  liveBytes = -1
}
export function setMemoryAuditEnabled(v: boolean): void { enabled = v !== false }
export function memoryAuditEnabled(): boolean { return enabled }

function auditPath(): string | null { return dir ? join(dir, FILE) : null }

/** Redact secrets from and clip a free-text field, so no secret is ever written to the audit. */
export function redactPreview(s: string, max = PREVIEW_MAX): string {
  const input = typeof s === 'string' ? s : ''
  const redacted = scanText(input.slice(0, SCAN_MAX)).redacted
  return redacted.length > max ? redacted.slice(0, max) + '…' : redacted
}

/** Append one audit event. No-op when disabled or uninitialized. Never throws into the caller.
 *  Rotation is driven by an in-process byte counter (one statSync total, not per append), so the
 *  hot write/ingest path pays O(1) per event. */
export function auditMemory(ev: MemoryAuditEvent, now: number = Date.now()): void {
  if (!enabled) return
  const p = auditPath()
  if (!p) return
  const line = JSON.stringify({ ts: now, ...ev }) + '\n'
  try {
    if (liveBytes < 0) { try { liveBytes = existsSync(p) ? statSync(p).size : 0 } catch { liveBytes = 0 } }
    if (liveBytes + line.length >= maxBytes) {
      const prev = join(dirname(p), PREV)
      if (existsSync(prev)) { try { unlinkSync(prev) } catch { /* ignore */ } }
      if (existsSync(p)) renameSync(p, prev) // keep one previous generation
      liveBytes = 0
    }
    appendFileSync(p, line)
    liveBytes += line.length
  } catch { /* best-effort — auditing must never break a memory operation */ }
}

/** The most recent `limit` audit records, newest first. */
export function readMemoryAudit(limit = 100): MemoryAuditRecord[] {
  const p = auditPath()
  if (!p || !existsSync(p)) return []
  try {
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim())
    const out: MemoryAuditRecord[] = []
    for (const l of lines.slice(-Math.max(1, limit))) {
      try { out.push(JSON.parse(l) as MemoryAuditRecord) } catch { /* skip corrupt line */ }
    }
    return out.reverse()
  } catch { return [] }
}

/** Count of audited events by type over the recent window — a cheap "what has my memory been doing?" */
export function memoryAuditSummary(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of readMemoryAudit(20_000)) counts[e.event] = (counts[e.event] ?? 0) + 1
  return counts
}

/** @internal test-only */
export function _resetMemoryAuditForTests(): void { dir = null; enabled = true; maxBytes = MAX_BYTES; liveBytes = -1 }
/** @internal test-only — lower the rotation cap so rotation can be exercised cheaply. */
export function _setMaxBytesForTests(n: number): void { maxBytes = n }
