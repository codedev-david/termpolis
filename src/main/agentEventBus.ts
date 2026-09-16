import * as fs from 'fs'
import * as path from 'path'

/**
 * Agent Event Bus — in-process aggregation of all AI agent activity.
 *
 * Three data sources feed events in:
 * - Provider transcript watchers (Claude Code, Codex, Gemini)
 * - MCP audit log (tool calls routed through Termpolis's MCP server)
 * - Terminal buffer heuristics (fallback, via agentStatusDetector)
 *
 * Security:
 * - Bounded in-memory ring buffer (MAX_RING) to cap memory
 * - JSONL persistence with rotation (no unbounded disk growth)
 * - Rate-limited publish (drops events past PUBLISH_RATE_LIMIT to prevent DoS)
 * - Subscriber callbacks wrapped in try/catch so a bad subscriber can't kill the bus
 * - No shell or external command execution
 * - Event payloads are size-capped (MAX_PAYLOAD_BYTES) before persistence
 */

export type AgentType = 'claude' | 'codex' | 'gemini' | 'unknown'

export type AgentEventKind =
  | 'message'        // user or assistant message
  | 'tool_call'      // agent invoked a tool
  | 'tool_result'    // tool returned a result
  | 'token_update'   // cumulative token usage changed
  | 'compaction'     // context compaction occurred
  | 'error'          // agent hit an error
  | 'status_change'  // status detector emitted new state
  | 'mcp_audit'      // event from MCP audit log

export interface AgentEvent {
  id: string
  ts: number
  terminalId: string
  agentType: AgentType
  kind: AgentEventKind
  /** Optional task / session correlation */
  taskId?: string
  /** Short human-readable summary (safe to render) */
  summary: string
  /** Structured payload — kind-specific, size-capped */
  payload: Record<string, unknown>
}

export interface EventFilter {
  terminalId?: string
  agentType?: AgentType
  kind?: AgentEventKind | AgentEventKind[]
  since?: number
  until?: number
  limit?: number
  search?: string
}

type Subscriber = (event: AgentEvent) => void

// ---- Bounds ----
const MAX_RING = 10_000
const MAX_LOG_SIZE = 5 * 1024 * 1024 // 5MB before rotation
const MAX_PAYLOAD_BYTES = 64 * 1024  // 64KB per event — prevents runaway memory
const PUBLISH_RATE_LIMIT = 500       // max events per second (burst) — DoS guard
const RATE_WINDOW_MS = 1000

// ---- State ----
const ring: AgentEvent[] = []
const subscribers = new Set<Subscriber>()
let logPath: string | null = null
let seq = 0
let rateCount = 0
let rateWindowStart = 0
let droppedCount = 0
// Bytes in the log, counted in process. rotateIfNeeded used to statSync the file on EVERY publish
// just to ask "how big are you?" — a syscall per event, on the thread that pumps the PTY, to learn
// something we already know: we did every write. memoryAudit.ts:59-67 already does it this way
// ("one statSync total, not per append"). One stat at init, then arithmetic.
let logBytes = 0
// A held append fd. publish() used fs.appendFileSync, which is open() + write() + close() on EVERY
// event — measured here at 447 us per line, so at PUBLISH_RATE_LIMIT (500/s) roughly 224 ms of dead
// main thread per second, on the thread that pumps every PTY. Holding the fd open costs 3.3 us per
// line, a 135x cut, and keeps the write SYNCHRONOUS.
//
// Synchronous is the requirement, not an accident. A WriteStream is marginally faster still (1.0 us)
// but buffers: measured here, 2,000 stream writes left the log file not merely stale but NONEXISTENT.
// rotateIfNeeded renames this very file, so a buffered writer would rename away bytes that were
// still in memory, and every reader that looks immediately after a publish would miss them.
let logFd: number | null = null

function openLog(target: string): void {
  try { logFd = fs.openSync(target, 'a') } catch { logFd = null }
}

function closeLog(): void {
  if (logFd === null) return
  try { fs.closeSync(logFd) } catch {}
  logFd = null
}

export function initEventBus(userDataPath: string): void {
  // Validate path is a real absolute directory — refuse traversal attempts
  if (!userDataPath || typeof userDataPath !== 'string') {
    throw new Error('initEventBus: userDataPath required')
  }
  if (!path.isAbsolute(userDataPath)) {
    throw new Error('initEventBus: userDataPath must be absolute')
  }
  closeLog() // a re-init must not leak the previous handle
  const resolved = path.resolve(userDataPath)
  logPath = path.join(resolved, 'agent-events.jsonl')
  // Ensure the file exists so callers can observe it immediately
  try {
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, '')
      logBytes = 0
    } else {
      logBytes = fs.statSync(logPath).size // the ONLY stat of this file — publish() does arithmetic
    }
    openLog(logPath)
  } catch {
    logPath = null
    logBytes = 0
  }
}

/** Rotate once the log passes MAX_LOG_SIZE. Takes the size as an argument rather than asking the
 *  filesystem: the caller just wrote every byte in it. */
function rotateIfNeeded(): void {
  if (!logPath || logBytes < MAX_LOG_SIZE) return
  try {
    const backup = logPath + '.old'
    // Close BEFORE renaming. An open fd follows the INODE, so every write after the rename would
    // land in the .old file while the live log stayed empty forever — the rotation that exists to
    // bound growth would instead guarantee it. On Windows the rename fails outright while a handle
    // is open. Reopened on the fresh live file in the finally below.
    closeLog()
    try { fs.unlinkSync(backup) } catch {}
    fs.renameSync(logPath, backup)
    fs.writeFileSync(logPath, '')
    logBytes = 0
  } catch {
    // Rotation failed (file locked, disk full). Re-sync from the filesystem rather than let the
    // counter drift forever — a wrong counter means we either never rotate or rotate every event.
    try { logBytes = fs.statSync(logPath).size } catch { logBytes = 0 }
  } finally {
    openLog(logPath) // reopen whether or not rotation worked — never leave the bus handle-less
  }
}

function truncatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = JSON.stringify(payload)
    if (json.length <= MAX_PAYLOAD_BYTES) return payload
    return { _truncated: true, _originalSize: json.length, summary: json.slice(0, MAX_PAYLOAD_BYTES - 200) }
  } catch {
    return { _truncated: true, _reason: 'unserializable' }
  }
}

function checkRate(now: number): boolean {
  if (now - rateWindowStart >= RATE_WINDOW_MS) {
    rateWindowStart = now
    rateCount = 0
  }
  if (rateCount >= PUBLISH_RATE_LIMIT) {
    droppedCount++
    return false
  }
  rateCount++
  return true
}

export function getDroppedCount(): number {
  return droppedCount
}

export function publish(event: Omit<AgentEvent, 'id' | 'ts'> & { ts?: number }): AgentEvent | null {
  const now = Date.now()
  if (!checkRate(now)) return null

  const full: AgentEvent = {
    id: `${now}-${++seq}`,
    ts: event.ts ?? now,
    terminalId: String(event.terminalId || '').slice(0, 200),
    agentType: event.agentType,
    kind: event.kind,
    taskId: event.taskId ? String(event.taskId).slice(0, 200) : undefined,
    summary: String(event.summary || '').slice(0, 500),
    payload: truncatePayload(event.payload || {}),
  }

  // Push to ring
  ring.push(full)
  if (ring.length > MAX_RING) {
    ring.splice(0, ring.length - MAX_RING)
  }

  // Persist synchronously through the held fd — crash-safe, and the bytes are on disk before this
  // returns, which rotateIfNeeded (it renames this file) and any immediate reader both depend on.
  if (logFd !== null) {
    try {
      const line = JSON.stringify(full) + '\n'
      fs.writeSync(logFd, line)
      logBytes += Buffer.byteLength(line, 'utf8') // byteLength, not .length: JSON can hold non-ASCII
      rotateIfNeeded()
    } catch {}
  }

  // Notify subscribers — never let one subscriber break another
  for (const sub of subscribers) {
    try { sub(full) } catch {}
  }

  return full
}

export function subscribe(cb: Subscriber): () => void {
  subscribers.add(cb)
  return () => { subscribers.delete(cb) }
}

export function query(filter: EventFilter = {}): AgentEvent[] {
  const { terminalId, agentType, kind, since, until, limit, search } = filter
  const kinds = Array.isArray(kind) ? kind : kind ? [kind] : null
  const needle = search ? search.toLowerCase() : null

  const results: AgentEvent[] = []
  // Iterate newest-first for limit semantics
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i]
    if (terminalId && e.terminalId !== terminalId) continue
    if (agentType && e.agentType !== agentType) continue
    if (kinds && !kinds.includes(e.kind)) continue
    if (since != null && e.ts < since) continue
    if (until != null && e.ts > until) continue
    if (needle && !e.summary.toLowerCase().includes(needle)) continue
    results.push(e)
    if (limit != null && results.length >= limit) break
  }
  // Return chronological order
  return results.reverse()
}

export function getRingSize(): number {
  return ring.length
}

export function clearRing(): void {
  ring.length = 0
  subscribers.clear()
  droppedCount = 0
  rateCount = 0
}

/** Release the log handle. Writes are synchronous, so there is nothing buffered to flush — this
 *  closes the fd. The bus stops persisting until initEventBus runs again. */
export function shutdownEventBus(): void {
  closeLog()
}

/** Test-only: reset all internal state */
export function _resetForTests(): void {
  closeLog()
  ring.length = 0
  subscribers.clear()
  logPath = null
  seq = 0
  rateCount = 0
  rateWindowStart = 0
  droppedCount = 0
  logBytes = 0
}
