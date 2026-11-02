// memoryAudit.ts — WP-E: an ON-BY-DEFAULT, local, inspectable, secret-redacted audit trail of what
// the memory/learning system actually DID: what it stored (write), what it recalled (recall), what
// it learned (learn: feedback/reflect/consolidate/decay/link), and what it injected into an agent's
// context (inject). This answers "show me exactly what my memory did" — the thing a keyword-notes
// memory (Claude Desktop / Codex / Antigravity) cannot.
//
// Distinct from the AI Security audit (aiSecurity.ts), which is DEFAULT-OFF and about cloud egress.
// This is:
//   - DEFAULT ON (it's the brain auditing itself). setMemoryAuditEnabled is an internal switch with no setting in the app: the
//     user's way to clear it is Settings > Memory & Learning > Activity record (clearMemoryAudit; PRIVACY.md, Your Choices).
//   - LOCAL-ONLY — the file never leaves the machine (same trust boundary as the memory store).
//   - SECRET-SAFE — every free-text preview is run through the secret scanner, so a stored or queried
//     secret is masked before it is written.
//   - BOUNDED — the log is capped and rotated (one previous generation kept), so it can't grow
//     without limit.
//   - BEST-EFFORT — auditing never throws into the caller; a failed append must not break a memory op.
//
// TWO PROCESSES write this audit. The store lives in a utility process (memoryHost.ts) that records what it
// stores and learns; the events about what agents recalled, were injected and were credited are raised in the
// MAIN process, which has its own copy of this module. Each keeps a file of its own, so neither rotates a file
// the other is appending to, and a read merges them. The main process's copy was never initialised until
// 1.55.0, which is why memory_audit used to show only the host's writes.
//
// WHAT MAY BE PERSISTED is counts, ids, kinds and the agent, plus the redacted preview of a STORED memory (the
// host has always kept that; swarmMemory leaves it empty for a held-back lesson and an imported note). The text of
// a QUERY is never persisted: a recall's query is the beginning of whatever an agent, or with the prompt-time
// recall hook the user, just typed. The memory_audit tool hands agents the events WITHOUT the previews.
import { appendFileSync, existsSync, readFileSync, statSync, renameSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { forEachBufferLine } from './fileLines' // byte-safe JSONL reader (never a >512 MiB string; see fileLines.ts)
import { scanText } from './aiSecurity'

export type MemoryAuditEvent =
  | { event: 'write'; id: string; kind: string; agentId?: string; preview: string }
  // `query` is accepted from callers that have one but is never written (see persistable below).
  | { event: 'recall'; agentId?: string; query: string; results: number; topIds: string[] }
  | { event: 'learn'; kind: 'feedback' | 'reflect' | 'consolidate' | 'decay' | 'link'; detail: string }
  | { event: 'inject'; target: string; memoryIds: string[]; approxTokens: number }

export type MemoryAuditRecord = { ts: number } & MemoryAuditEvent

/** Which process this copy of the module runs in: the memory host (the default) or the main process. */
export type MemoryAuditRole = 'host' | 'main'

const FILES: Record<MemoryAuditRole, { live: string; prev: string }> = {
  host: { live: 'memory-audit.jsonl', prev: 'memory-audit.prev.jsonl' },
  main: { live: 'memory-audit-main.jsonl', prev: 'memory-audit-main.prev.jsonl' },
}
/** Every file the record is kept in, in the app-data folder: each process's live file and its earlier copy. */
export const AUDIT_FILES: readonly string[] = [FILES.host.live, FILES.host.prev, FILES.main.live, FILES.main.prev]
/** The size a live audit file may reach before it rotates (one previous generation is kept): PRIVACY.md says "about 2 MB". */
export const MAX_BYTES = 2_000_000
let maxBytes = MAX_BYTES
const PREVIEW_MAX = 160
const SCAN_MAX = 4096 // cap the bytes we redaction-scan per field so a huge memory can't stall a write

let dir: string | null = null
let role: MemoryAuditRole = 'host'
let enabled = true // WP-E: default ON
let liveBytes = -1 // in-process size of the live file; -1 = stat lazily on first append (O(1) per write)

export function initMemoryAudit(d: string, as: MemoryAuditRole = 'host'): void {
  // Point at the memory data dir (which the app/store already creates). We deliberately do NOT
  // create it here — the audit is best-effort, and creating it would mask a genuine store-init
  // failure (e.g. a missing parent dir). If the dir is absent, appendFileSync simply no-ops.
  dir = d
  role = as
  liveBytes = -1
}
export function setMemoryAuditEnabled(v: boolean): void { enabled = v !== false }
export function memoryAuditEnabled(): boolean { return enabled }

function auditPath(): string | null { return dir ? join(dir, FILES[role].live) : null }

/** How much the record holds in the app-data folder `d`: how many of its files exist and their size together. It reads no
 *  line, only the size of each file, and counts nothing that is not a file. Never throws. */
export function memoryAuditSize(d: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  for (const name of AUDIT_FILES) {
    try {
      const s = statSync(join(d, name))
      if (s.isFile()) { files++; bytes += s.size }
    } catch { /* not there: nothing recorded */ }
  }
  return { files, bytes }
}

/** Forget the record: remove every file it is kept in, in the app-data folder `d`, and nothing else. A file that is not there
 *  is already forgotten. The other process may append at the same moment; its next line starts a new file. The process that
 *  clears sizes its own live file again at its next line; the other process's count of its file can only be too high, which makes
 *  it rotate early, and rotating a file that is not there loses nothing. `failed` counts the files that are there and could not
 *  be removed (one an antivirus scan holds open, say). */
export function clearMemoryAudit(d: string): { removed: number; failed: number } {
  let removed = 0
  let failed = 0
  for (const name of AUDIT_FILES) {
    try {
      unlinkSync(join(d, name))
      removed++
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') failed++
    }
  }
  liveBytes = -1 // the file this process was counting may be gone: its next line sizes whatever is there
  return { removed, failed }
}

/** What goes to disk for an event: the event itself, minus the one field that is the beginning of someone's
 *  words. A recall keeps who asked, how many it found and which ids; the query stays with the caller. */
function persistable(ev: MemoryAuditEvent): Omit<MemoryAuditEvent, 'query'> {
  if (ev.event !== 'recall') return ev
  const { query: _query, ...rest } = ev
  return rest
}

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
  const line = JSON.stringify({ ts: now, ...persistable(ev) }) + '\n'
  try {
    if (liveBytes < 0) { try { liveBytes = existsSync(p) ? statSync(p).size : 0 } catch { liveBytes = 0 } }
    if (liveBytes + line.length >= maxBytes) {
      const prev = join(dirname(p), FILES[role].prev)
      if (existsSync(prev)) { try { unlinkSync(prev) } catch { /* ignore */ } }
      if (existsSync(p)) renameSync(p, prev) // keep one previous generation
      liveBytes = 0
    }
    appendFileSync(p, line)
    liveBytes += line.length
  } catch { /* best-effort — auditing must never break a memory operation */ }
}

/** The newest `limit` records of one process's live file, newest first. */
function readOne(p: string, limit: number): MemoryAuditRecord[] {
  if (!existsSync(p)) return []
  try {
    // Stream from bytes — the audit log is append-only and can grow; never decode the whole file as
    // one 'utf8' string (fatals V8 uncatchably past ~512 MiB; see fileLines.ts).
    const lines: string[] = []
    forEachBufferLine(readFileSync(p), (l) => { if (l.trim()) lines.push(l) })
    const out: MemoryAuditRecord[] = []
    for (const l of lines.slice(-limit)) {
      try { out.push(JSON.parse(l) as MemoryAuditRecord) } catch { /* skip corrupt line */ }
    }
    return out.reverse()
  } catch { return [] }
}

/** The most recent `limit` audit records, newest first, from the host's file and the main process's together. */
export function readMemoryAudit(limit = 100): MemoryAuditRecord[] {
  if (!dir) return []
  const n = Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 100)
  const host = readOne(join(dir, FILES.host.live), n)
  const main = readOne(join(dir, FILES.main.live), n)
  if (main.length === 0) return host
  if (host.length === 0) return main
  // Each list is already newest-first; the sort is stable, so equal timestamps keep their file order.
  return [...host, ...main].sort((a, b) => b.ts - a.ts).slice(0, n)
}

/** Count of audited events by type over the recent window — a cheap "what has my memory been doing?" */
export function memoryAuditSummary(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of readMemoryAudit(20_000)) counts[e.event] = (counts[e.event] ?? 0) + 1
  return counts
}

/** @internal test-only */
export function _resetMemoryAuditForTests(): void { dir = null; role = 'host'; enabled = true; maxBytes = MAX_BYTES; liveBytes = -1 }
/** @internal test-only — lower the rotation cap so rotation can be exercised cheaply. */
export function _setMaxBytesForTests(n: number): void { maxBytes = n }
