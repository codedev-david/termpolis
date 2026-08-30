// mcpGateway/audit.ts
//
// The forensic record of every upstream MCP call the gateway saw.
//
// WHY SEPARATE FROM THE EXISTING AUDIT LOG: `aiSecurity`'s log answers "what left
// this machine in a prompt". This one answers "what did an agent ask an external
// server to do, with what arguments, and what came back" — a different subject with
// a different retention story, and one that a user may want to ship to a SIEM without
// also shipping their prompts.
//
// INVARIANT — the log never stores a secret. When `scanArgs` flags an argument the
// entry keeps the JSON PATH and the RULE NAME, never the value. An audit log that
// records the credential it caught leaking is a second copy of the leak.

export interface GatewayAuditEntry {
  ts: number
  server: string
  tool: string
  decision: 'allow' | 'deny' | 'ask'
  /** Verbatim from PolicyVerdict.reason — why the decision went that way. */
  reason: string
  /** JSON paths + rule names only. Never values. */
  argFindings: { path: string; rule: string }[]
  /** Injection-scan verdict on the RESULT; null when the call never ran. */
  resultLevel: 'green' | 'yellow' | 'red' | null
  resultTruncated: boolean
  durationMs: number
  ok: boolean
  error?: string
}

/** Bounded in-memory ring. The on-disk JSONL is the durable record; this is what the
 *  settings panel reads, and it must never be able to grow without limit because a
 *  runaway agent calling one tool in a loop is exactly the case the log is for. */
const MAX_ENTRIES = 2000
let entries: GatewayAuditEntry[] = []
let sink: ((entry: GatewayAuditEntry) => void) | null = null

/** Wire the durable JSONL writer (main startup). Kept as a seam so every test of the
 *  gateway runs without touching a filesystem. */
export function setGatewayAuditSink(fn: ((entry: GatewayAuditEntry) => void) | null): void {
  sink = fn
}

export function recordGatewayCall(entry: GatewayAuditEntry): void {
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
  try {
    sink?.(entry)
  } catch {
    /* a failed audit write must never fail the call it is describing */
  }
}

export function recentGatewayCalls(limit = 200): GatewayAuditEntry[] {
  // NaN-safe: `typeof NaN === 'number'` passed the old clamp in aiSecurity and returned
  // the entire log (fixed in v1.25.6). Same guard here so the same bug cannot recur.
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_ENTRIES) : 200
  return entries.slice(-n)
}

export function clearGatewayAudit(): void {
  entries = []
}

export interface GatewayStats {
  total: number
  allowed: number
  denied: number
  withArgSecrets: number
  redResults: number
  byServer: Record<string, number>
}

/** The numbers the settings panel shows. Computed rather than counted incrementally
 *  so the panel can never drift from the log it claims to summarise. */
export function gatewayStats(): GatewayStats {
  const stats: GatewayStats = { total: 0, allowed: 0, denied: 0, withArgSecrets: 0, redResults: 0, byServer: {} }
  for (const entry of entries) {
    stats.total++
    if (entry.decision === 'allow') stats.allowed++
    if (entry.decision === 'deny') stats.denied++
    if (entry.argFindings.length > 0) stats.withArgSecrets++
    if (entry.resultLevel === 'red') stats.redResults++
    stats.byServer[entry.server] = (stats.byServer[entry.server] ?? 0) + 1
  }
  return stats
}
