// The audit log's headline verdict — "did a secret actually reach a model?"
//
// WHY THIS IS NOT TRIVIAL, AND WHY THE OLD VERSION OF THIS FILE WAS WRONG.
//
// This file used to carry a fifth verdict, 'not-watching': zero hits, but the prompt scanner was
// switched off, so zero meant "we never looked" rather than "you are clean". That was the right
// call for the old design — outbound REDACTION defaulted to OFF, and processOutboundChunk
// returned 'pass' before it ever called scanText, so a zero was silence, not safety.
//
// Redaction is gone. It withheld keystrokes to rewrite them (and then never wrote them back), and
// it could never have beaten a TUI agent's own line buffer anyway. What replaced it is WATCH, and
// watch CANNOT BE TURNED OFF: every submit and every paste in an AI terminal is scanned on a
// shadow copy while the bytes go through untouched, and a hit is recorded as `prompt_secret_sent`.
// The state 'not-watching' existed to describe is therefore unreachable — and a scary verdict that
// can never fire is just noise in a file people read for reassurance. It is deleted.
//
// The mirror-image trap survives, though: RECORDING can still be switched off. If nothing is
// recorded, zero once again means "we kept no record", not "nothing happened". That is `audit-off`,
// and it stays FIRST in the precedence order.
//
// Second invariant: a secret and a big paste are NOT the same event. Legacy `redaction_hit` rows
// conflated them — code chunks and env dumps were logged under that same event name — so counting
// the event blindly would tell someone who pasted a source file that they leaked four credentials.
// Those rows are excluded by their notes prefix. See isSecretToModel().

/** One line of the JSONL audit log. Mirrors `AuditEntry` in src/main/aiSecurity.ts, but keeps
 *  `event` a plain string on purpose: an OLD log holding a since-retired event name (`redaction_hit`)
 *  must still parse rather than blow up the panel that exists to explain it. */
export interface AuditEntry {
  ts: string
  agent: string
  event: string
  terminalId?: string
  byteCount?: number
  hitCount?: number
  notes?: string
}

export type AuditVerdict =
  | 'caught'    // a secret WAS sent to a model — recorded, not prevented
  | 'clean'     // nothing found, and watching is always on, so this one means what it says
  | 'audit-off' // nothing is being recorded at all — zero here proves nothing
  | 'no-data'   // watching, recording, but nothing has happened yet

/** What the OTHER gates are set to. Prompt watching is deliberately absent: it is not a setting.
 *  It is always on, so there is no `outboundScanning` flag left to lie about. */
export interface AuditCoverage {
  auditEnabled: boolean
  commitShield: boolean
  egressGuard: boolean
  memoryScrub: boolean
}

export interface AuditSummary {
  verdict: AuditVerdict
  headline: string
  detail: string
  /** Secrets that reached a cloud model in a prompt. The question users actually ask. */
  secretsToModels: number
  /** The distinct NAMES that leaked (`DB_PASSWORD`, `apiKey`) — this is the actionable part:
   *  it says what to rotate. Never a value; the value is not captured anywhere upstream. */
  secretNames: string[]
  /** Secrets stopped at the git boundary — a different escape route entirely, and the one place
   *  Termpolis genuinely BLOCKS rather than records. */
  secretsBlockedAtGit: number
  /** Big code pastes and .env dumps. NOT secrets — tracked separately precisely so they cannot
   *  inflate the number above, which is the one people act on. */
  codeChunksSent: number
  envDumpsSent: number
  unsafeImportsBlocked: number
  egressViolations: number
  sensitiveReads: number
  memoriesScrubbed: number
  totalEvents: number
  /** The oldest entry we hold — the log can only speak for the window since then. */
  watchingSince: string | null
  byEvent: Record<string, number>
}

/** Sum `hitCount` across the rows a predicate selects. A hit-bearing row with no count still means
 *  >= 1 thing happened — reporting 0 for it would undercount a real catch. Negatives are junk. */
function sumHits(entries: AuditEntry[], pick: (x: AuditEntry) => boolean): number {
  let n = 0
  for (const x of entries) {
    if (!pick(x)) continue
    const c = typeof x.hitCount === 'number' && x.hitCount > 0 ? x.hitCount : 1
    n += c
  }
  return n
}

const isEvent = (...events: string[]) => (x: AuditEntry): boolean => events.includes(x.event)

function countOf(entries: AuditEntry[], event: string): number {
  return entries.filter((x) => x.event === event).length
}

/** Legacy-only guard. Before `prompt_secret_sent` / `code_chunk_sent` / `env_dump_sent` existed,
 *  all three were written as `redaction_hit` — so an old log's `redaction_hit` may well be
 *  "you pasted 40 KB of TypeScript", which is not a secret and must never land in a count the
 *  user reads as "credentials I have to rotate". The prefixes are how those rows tagged
 *  themselves. New logs never take this path. */
const LEGACY_NON_SECRET = /^\s*(?:code-chunk:|env-dump:)/

function isSecretToModel(x: AuditEntry): boolean {
  if (x.event === 'prompt_secret_sent') return true
  if (x.event !== 'redaction_hit') return false
  return !LEGACY_NON_SECRET.test(typeof x.notes === 'string' ? x.notes : '')
}

/** The audit note is `NAME (rule_id), NAME2 (rule_id)` — names and rule ids ONLY. The VALUE is
 *  never captured upstream, so there is nothing in here to leak by rendering it.
 *
 *  A rule with no `nameGroup` (an AWS key has no identifier — it IS the identifier) is logged as a
 *  bare rule id with no parentheses, and correctly contributes no name: "aws_access_key" is not a
 *  thing you can look up in your .env, so pretending it is a name would be worse than saying nothing. */
const NAMED_HIT = /([^\s,()]+)\s*\(([A-Za-z0-9_]+)\)/g

function secretNamesFrom(rows: AuditEntry[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of rows) {
    const notes = typeof x.notes === 'string' ? x.notes : ''
    if (!notes) continue
    NAMED_HIT.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = NAMED_HIT.exec(notes)) !== null) {
      const name = m[1]
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

export function summarizeAudit(entries: AuditEntry[], cov: AuditCoverage): AuditSummary {
  const rows = (entries || []).filter((x): x is AuditEntry => !!x && typeof x.event === 'string')

  const byEvent: Record<string, number> = {}
  for (const x of rows) byEvent[x.event] = (byEvent[x.event] || 0) + 1

  // One pass, so the count and the names can never disagree about which rows were secrets.
  const secretRows = rows.filter(isSecretToModel)
  const secretsToModels = sumHits(secretRows, () => true)
  const secretNames = secretNamesFrom(secretRows)

  const secretsBlockedAtGit = sumHits(rows, isEvent('commit_blocked', 'push_blocked'))
  const egressViolations = sumHits(rows, isEvent('egress_violation'))
  const memoriesScrubbed = sumHits(rows, isEvent('memory_scrub'))
  const unsafeImportsBlocked = countOf(rows, 'import_blocked')
  const sensitiveReads = countOf(rows, 'sensitive_file_read')
  const codeChunksSent = countOf(rows, 'code_chunk_sent')
  const envDumpsSent = countOf(rows, 'env_dump_sent')

  // getRecentAudit hands us newest-first; the window starts at the OLDEST row we hold.
  const stamps = rows.map((x) => x.ts).filter((t): t is string => typeof t === 'string' && !!t).sort()
  const watchingSince = stamps.length ? stamps[0] : null

  const base = {
    secretsToModels,
    secretNames,
    secretsBlockedAtGit,
    codeChunksSent,
    envDumpsSent,
    unsafeImportsBlocked,
    egressViolations,
    sensitiveReads,
    memoriesScrubbed,
    totalEvents: rows.length,
    watchingSince,
    byEvent,
  }

  // --- the verdict, in strict precedence order ---------------------------------------

  // FIRST, always. Watching cannot be switched off, but recording can — and with no record, a
  // zero is an absence of evidence, not evidence of absence. Never let this state read as clean.
  if (!cov.auditEnabled) {
    return {
      ...base,
      verdict: 'audit-off',
      headline: 'Nothing is being recorded',
      detail:
        'Prompt watching is still on — it cannot be turned off — but the audit log is switched off, so Termpolis is ' +
        'keeping no record of what it sees. A zero here means "no record was kept", not "nothing happened". ' +
        'Turn the log on above to start building one.',
    }
  }

  // A secret reached a model. Say exactly that — it was RECORDED, not prevented. The old copy here
  // claimed the value had been redacted and "the provider never received it", which was false the
  // moment redaction was deleted, and false in practice long before that.
  if (secretsToModels > 0) {
    const s = secretsToModels === 1 ? 'secret' : 'secrets'
    const rotate = secretNames.length ? secretNames.join(', ') : 'every credential listed below'
    return {
      ...base,
      verdict: 'caught',
      headline: `${secretsToModels} ${s} sent to a model`,
      detail:
        `Termpolis recorded ${secretsToModels} ${s} in text that went to an AI agent. Watching never blocks and never ` +
        'rewrites what you type, so the value has already left this machine — this is a record, not a save. ' +
        `Rotate ${rotate} now. Only the name and the rule that matched are stored; the value itself was never captured.`,
    }
  }

  if (rows.length === 0) {
    return {
      ...base,
      verdict: 'no-data',
      headline: 'Nothing recorded yet',
      detail: 'Prompt watching is always on and the log is recording — there is simply nothing in it so far.',
    }
  }

  return {
    ...base,
    verdict: 'clean',
    headline: 'No secret has reached a model',
    detail:
      'Prompt watching is always on — every submit and every paste into an AI terminal is scanned — and it has not ' +
      'found a secret in anything sent to an agent. This covers the window the log holds, not the lifetime of the machine.',
  }
}
