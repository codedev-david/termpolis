// appLog.ts (shared)
//
// The pure half of the app's own log -- the "behind the scenes" output a user can
// open with a hotkey instead of hunting for a devtools console they cannot reach in
// a packaged build.
//
// Lives in src/shared because BOTH sides produce entries: main prints the
// interesting things (terminal spawns, MCP wiring, updater state, IPC failures) and
// the renderer prints the rest, and they have to agree on the shape and on the
// redaction before either writes a byte. Keeping the formatting and the ring buffer
// pure also means the whole thing is testable with no Electron, no fs and no
// globals -- the same reason terminalOutputBuffer.ts is shaped this way.

export type AppLogLevel = 'debug' | 'info' | 'log' | 'warn' | 'error'
export type AppLogSource = 'main' | 'renderer'

export interface AppLogEntry {
  /** Epoch ms. Stamped by the producer, never derived here, so the module stays pure. */
  t: number
  level: AppLogLevel
  source: AppLogSource
  msg: string
}

/** Lines held in memory for the viewer. 2,000 covers a session's worth of interesting
 *  output at a few hundred KB; the file on disk keeps more. */
export const MAX_APP_LOG_ENTRIES = 2_000

/** Longest single line retained. One `console.log` of a large object should not be
 *  able to push 2,000 useful lines out of the ring, and no viewer is readable past
 *  this anyway. */
export const MAX_APP_LOG_LINE_CHARS = 4_000

const LEVELS: readonly AppLogLevel[] = ['debug', 'info', 'log', 'warn', 'error']

/** Coerce anything that arrived over IPC to a real level. Unknown values become
 *  'log' rather than throwing: a malformed log line must never be able to take down
 *  the thing it was logging about. */
export function normalizeLevel(value: unknown): AppLogLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
    ? (value as AppLogLevel)
    : 'log'
}

/**
 * Patterns that must never reach the log file.
 *
 * This log is written to disk in the user's profile and is meant to be READ, copied
 * into a bug report and pasted into an issue -- which makes it exactly the artefact a
 * secret should not be sitting in. The app already refuses to log relay frames and
 * agent credentials at the call sites; this is the backstop for the call site nobody
 * thought about, and for third-party code printing into the same console.
 *
 * Deliberately shape-based rather than name-based: `sk-ant-...`, a bearer token or a
 * long hex blob is recognisable without knowing which variable it came from.
 */
const REDACTIONS: readonly { re: RegExp; with: string }[] = [
  // Provider API keys: sk-…, sk-ant-…, gsk_… and friends.
  { re: /\b(sk|gsk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, with: '<redacted-key>' },
  // GitHub tokens.
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, with: '<redacted-token>' },
  // Authorization headers and any key=value that names itself a secret.
  { re: /\b(bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, with: '$1 <redacted-token>' },
  { re: /\b(api[-_]?key|secret|password|passwd|token|authorization)("?\s*[:=]\s*"?)([^\s",}]{8,})/gi, with: '$1$2<redacted>' },
  // A bare 64+ char hex run is a key, a session id or a room id -- none of them belong here.
  { re: /\b[0-9a-f]{64,}\b/gi, with: '<redacted-hex>' },
]

/** Strip anything that looks like a credential. Cheap, total, and applied to every
 *  line before it is stored -- redacting on write rather than on read means a leaked
 *  secret never exists in the file at all. */
export function redactSecrets(text: string): string {
  let out = text
  for (const r of REDACTIONS) out = out.replace(r.re, r.with)
  return out
}

/** Render one console argument. Errors keep their stack (the reason anyone opens this
 *  viewer), objects are JSON where possible, and a circular or exotic value degrades
 *  to String() instead of throwing inside the logger. */
function renderArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`
  if (arg === null) return 'null'
  if (arg === undefined) return 'undefined'
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg)
    } catch {
      return safeString(arg)
    }
  }
  return safeString(arg)
}

/** String() itself can throw -- an object whose toString is a getter that throws, or a
 *  Symbol. Nothing in this module is allowed to throw at its caller (see the header of
 *  src/main/appLog.ts), so the last resort has a last resort. */
function safeString(arg: unknown): string {
  try {
    return String(arg)
  } catch {
    return '<unprintable>'
  }
}

/** Join console arguments the way a console would, then redact and clamp. */
export function formatLogArgs(args: readonly unknown[]): string {
  const joined = args.map(renderArg).join(' ')
  const redacted = redactSecrets(joined)
  return redacted.length > MAX_APP_LOG_LINE_CHARS
    ? `${redacted.slice(0, MAX_APP_LOG_LINE_CHARS)}… (${redacted.length - MAX_APP_LOG_LINE_CHARS} more chars)`
    : redacted
}

/** Append to the ring, evicting the oldest entries past `cap`. Mutates in place so a
 *  caller can hold the array; a cap of 0 or less is treated as 1, because a ring that
 *  drops everything is a bug that would silently disable the feature. */
export function pushLogEntry(ring: AppLogEntry[], entry: AppLogEntry, cap = MAX_APP_LOG_ENTRIES): void {
  const limit = Math.max(1, Math.floor(cap) || 1)
  ring.push(entry)
  if (ring.length > limit) ring.splice(0, ring.length - limit)
}

/** Pad to two digits without pulling in a date library. */
function two(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** `HH:MM:SS.mmm` in local time -- what a user comparing the log against something
 *  they just did on screen needs. The date is in the file name, not on every line. */
export function formatLogTime(t: number): string {
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return '--:--:--.---'
  const ms = d.getMilliseconds()
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${ms < 10 ? '00' : ms < 100 ? '0' : ''}${ms}`
}

/** One line, as written to the file and as copied out of the viewer. */
export function formatLogLine(e: AppLogEntry): string {
  return `${formatLogTime(e.t)} [${e.level.toUpperCase()}] [${e.source}] ${e.msg}`
}
