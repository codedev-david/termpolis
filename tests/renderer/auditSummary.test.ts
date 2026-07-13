// The audit log's headline verdict.
//
// THE INVARIANT THIS FILE EXISTS TO PROTECT — and how it CHANGED.
//
// It used to be "never say clean while the prompt scanner is off": outbound redaction defaulted to
// OFF, processOutboundChunk returned before it ever called scanText in that state, and so a zero
// meant "we never looked", not "you are clean". Redaction is gone — it withheld keystrokes to
// rewrite them and could never beat a TUI agent's own line buffer. What replaced it is WATCH, and
// watch CANNOT be switched off. The 'not-watching' verdict is therefore unreachable, and a test
// asserting on it would only pin dead code in place. It is gone from here too.
//
// What survives is the same idea, aimed at the one flag that still exists: RECORDING can be off.
// A zero with no log is "no record was kept", never "clean". That is `audit-off`, and it is first.
//
// And the trap the old code did NOT have. `code_chunk_sent` and `env_dump_sent` used to be written
// as `redaction_hit` — the same event name as a real secret. Counting the event blindly tells
// someone who pasted a source file that they leaked four credentials. A secret is a thing you
// rotate; a big paste is not. They must never be summed together.

import { describe, it, expect } from 'vitest'
import { summarizeAudit, type AuditCoverage, type AuditEntry } from '../../src/renderer/src/lib/auditSummary'

const WATCHING: AuditCoverage = {
  auditEnabled: true,
  commitShield: true,
  egressGuard: true,
  memoryScrub: true,
}

const e = (event: string, over: Partial<AuditEntry> = {}): AuditEntry =>
  ({ ts: '2026-07-12T10:00:00.000Z', agent: 'claude', event, ...over }) as AuditEntry

describe('summarizeAudit — a secret that reached a model', () => {
  it('counts prompt_secret_sent, summing SECRETS rather than events', () => {
    const s = summarizeAudit(
      [e('prompt_secret_sent', { hitCount: 3 }), e('prompt_secret_sent', { hitCount: 2 })],
      WATCHING,
    )
    expect(s.secretsToModels).toBe(5) // 5 secrets across 2 prompts — not "2"
    expect(s.verdict).toBe('caught')
    expect(s.headline).toContain('5')
  })

  it('counts a prompt_secret_sent with no hitCount as at least one secret', () => {
    expect(summarizeAudit([e('prompt_secret_sent')], WATCHING).secretsToModels).toBe(1)
  })

  it('NEVER claims the secret was stopped — watching records, it does not block', () => {
    // The old copy said the secret was "caught before reaching a model" and "the provider never
    // received the value". Both were false. Rendering them now would be a lie that costs a rotation.
    const s = summarizeAudit([e('prompt_secret_sent', { hitCount: 1, notes: 'DB_PASSWORD (env_secret)' })], WATCHING)
    const text = `${s.headline} ${s.detail}`
    expect(text).toMatch(/sent to a model/i)
    expect(text).toMatch(/rotate/i)
    expect(text).not.toMatch(/redact/i)
    expect(text).not.toMatch(/never received/i)
    expect(text).not.toMatch(/caught before reaching/i)
  })

  it('surfaces the NAMES that leaked — the part you can actually act on', () => {
    const s = summarizeAudit(
      [e('prompt_secret_sent', { hitCount: 2, notes: 'DB_PASSWORD (env_secret), apiKey (json_secret)' })],
      WATCHING,
    )
    expect(s.secretNames).toEqual(['DB_PASSWORD', 'apiKey'])
    expect(s.detail).toContain('DB_PASSWORD')
  })

  it('de-duplicates a name seen across several prompts, keeping first-seen order', () => {
    const s = summarizeAudit(
      [
        e('prompt_secret_sent', { hitCount: 1, notes: 'DB_PASSWORD (env_secret)' }),
        e('prompt_secret_sent', { hitCount: 1, notes: 'apiKey (json_secret)' }),
        e('prompt_secret_sent', { hitCount: 1, notes: 'DB_PASSWORD (env_secret)' }),
      ],
      WATCHING,
    )
    expect(s.secretNames).toEqual(['DB_PASSWORD', 'apiKey'])
    expect(s.secretsToModels).toBe(3) // three separate disclosures of two distinct identifiers
  })

  it('yields no name for a rule that has none — an AWS key IS its own identifier', () => {
    // Main logs a bare rule id when the rule has no nameGroup. "aws_access_key" is not something
    // you can look up in your .env, so reporting it as a NAME would be worse than saying nothing.
    const s = summarizeAudit([e('prompt_secret_sent', { hitCount: 1, notes: 'aws_access_key' })], WATCHING)
    expect(s.secretsToModels).toBe(1)
    expect(s.secretNames).toEqual([])
    expect(s.verdict).toBe('caught')
  })

  it('picks the names out of a mixed note without inventing one for the unnamed rule', () => {
    const s = summarizeAudit(
      [e('prompt_secret_sent', { hitCount: 2, notes: 'DB_PASSWORD (env_secret), aws_access_key' })],
      WATCHING,
    )
    expect(s.secretNames).toEqual(['DB_PASSWORD'])
  })
})

describe('summarizeAudit — a big paste is not a leak', () => {
  it('does NOT count code_chunk_sent as a secret', () => {
    const s = summarizeAudit(
      [e('code_chunk_sent', { byteCount: 40960, notes: 'code-chunk:indentation,punctuation' })],
      WATCHING,
    )
    expect(s.secretsToModels).toBe(0)
    expect(s.secretNames).toEqual([])
    expect(s.codeChunksSent).toBe(1)
    expect(s.verdict).toBe('clean') // pasting source into an agent is the workflow, not a breach
  })

  it('does NOT count env_dump_sent as a secret, but does surface it', () => {
    const s = summarizeAudit([e('env_dump_sent', { notes: 'env-dump:7:DB_HOST,DB_USER' })], WATCHING)
    expect(s.secretsToModels).toBe(0)
    expect(s.envDumpsSent).toBe(1)
  })

  it('excludes LEGACY redaction_hit rows that were really code chunks or env dumps', () => {
    // Before the split, all three were logged as `redaction_hit`. Counting them would report
    // "4 secrets sent" at a user who pasted a file and a .env — and send them hunting for keys
    // that were never there.
    const s = summarizeAudit(
      [
        e('redaction_hit', { hitCount: 3, notes: 'code-chunk:indentation,punctuation,keywords' }),
        e('redaction_hit', { hitCount: 1, notes: 'env-dump:7:DB_HOST,DB_USER,DB_PASSWORD' }),
      ],
      WATCHING,
    )
    expect(s.secretsToModels).toBe(0)
    expect(s.secretNames).toEqual([]) // DB_PASSWORD in an env-dump note is a var name, not a hit
    expect(s.verdict).toBe('clean')
  })

  it('keeps a real secret in the same log as a code chunk, and counts only the secret', () => {
    const s = summarizeAudit(
      [
        e('prompt_secret_sent', { hitCount: 1, notes: 'DB_PASSWORD (env_secret)' }),
        e('code_chunk_sent', { notes: 'code-chunk:indentation,keywords' }),
      ],
      WATCHING,
    )
    expect(s.secretsToModels).toBe(1)
    expect(s.codeChunksSent).toBe(1)
    expect(s.secretNames).toEqual(['DB_PASSWORD'])
  })
})

describe('summarizeAudit — legacy logs still speak', () => {
  it('counts a legacy redaction_hit as a secret that went out', () => {
    const s = summarizeAudit([e('redaction_hit', { hitCount: 2, notes: 'aws_access_key' })], WATCHING)
    expect(s.secretsToModels).toBe(2)
    expect(s.verdict).toBe('caught')
  })

  it('counts a legacy redaction_hit with no hitCount as at least one secret', () => {
    expect(summarizeAudit([e('redaction_hit')], WATCHING).secretsToModels).toBe(1)
  })
})

describe('summarizeAudit — recording is the only thing that can be switched off', () => {
  it('says nothing is recorded at all when the audit log is off', () => {
    const s = summarizeAudit([], { ...WATCHING, auditEnabled: false })
    expect(s.verdict).toBe('audit-off')
    expect(s.verdict).not.toBe('clean')
    expect(`${s.headline} ${s.detail}`.toLowerCase()).toMatch(/no record|not being recorded/)
  })

  it('refuses to read a zero as clean when nothing was written down', () => {
    const s = summarizeAudit([e('terminal_open')], { ...WATCHING, auditEnabled: false })
    expect(s.verdict).toBe('audit-off')
    expect(`${s.headline} ${s.detail}`).not.toMatch(/No secret has reached a model/i)
  })

  it('still exposes a historical leak while recording is off — the count is never hidden', () => {
    // The log FILE survives the toggle. If it holds a real disclosure, the names must still reach
    // the UI even though the banner is (correctly) about the missing record.
    const s = summarizeAudit(
      [e('prompt_secret_sent', { hitCount: 1, notes: 'DB_PASSWORD (env_secret)' })],
      { ...WATCHING, auditEnabled: false },
    )
    expect(s.verdict).toBe('audit-off')
    expect(s.secretsToModels).toBe(1)
    expect(s.secretNames).toEqual(['DB_PASSWORD'])
  })

  it('only ever returns one of the four surviving verdicts', () => {
    // 'not-watching' is unreachable now: watching cannot be turned off, so it was deleted.
    for (const cov of [WATCHING, { ...WATCHING, auditEnabled: false }]) {
      for (const rows of [[], [e('terminal_open')], [e('prompt_secret_sent')]]) {
        expect(['caught', 'clean', 'audit-off', 'no-data']).toContain(summarizeAudit(rows, cov).verdict)
      }
    }
  })
})

describe('summarizeAudit — the honest good news', () => {
  it('reads CLEAN when the log is recording and nothing was found', () => {
    const s = summarizeAudit([e('terminal_open'), e('commit_scan')], WATCHING)
    expect(s.verdict).toBe('clean')
    expect(s.secretsToModels).toBe(0)
    expect(s.secretNames).toEqual([])
    // and it earns the word: it says watching is always on, rather than pointing at a toggle
    expect(s.detail.toLowerCase()).toContain('always on')
  })

  it('distinguishes an empty log from a clean one', () => {
    expect(summarizeAudit([], WATCHING).verdict).toBe('no-data')
  })
})

describe('summarizeAudit — the other escape routes', () => {
  it('separates the git boundary from the prompt path', () => {
    const s = summarizeAudit(
      [
        e('commit_blocked', { hitCount: 1 }),
        e('push_blocked', { hitCount: 2 }),
        e('prompt_secret_sent', { hitCount: 1 }),
      ],
      WATCHING,
    )
    expect(s.secretsToModels).toBe(1)     // prompt path — recorded, already gone
    expect(s.secretsBlockedAtGit).toBe(3) // git boundary — actually stopped
  })

  it('counts the other gates', () => {
    const s = summarizeAudit(
      [
        e('import_blocked'),
        e('egress_violation', { hitCount: 2 }),
        e('sensitive_file_read'),
        e('memory_scrub', { hitCount: 4 }),
      ],
      WATCHING,
    )
    expect(s.unsafeImportsBlocked).toBe(1)
    expect(s.egressViolations).toBe(2)
    expect(s.sensitiveReads).toBe(1)
    expect(s.memoriesScrubbed).toBe(4)
  })

  it('reports the window it can actually speak for', () => {
    const s = summarizeAudit(
      [e('terminal_open', { ts: '2026-07-12T12:00:00.000Z' }), e('terminal_open', { ts: '2026-07-10T09:00:00.000Z' })],
      WATCHING,
    )
    // getRecentAudit returns newest-first; the window starts at the OLDEST entry we hold.
    expect(s.watchingSince).toBe('2026-07-10T09:00:00.000Z')
    expect(s.totalEvents).toBe(2)
  })

  it('tallies every event type for the breakdown', () => {
    const s = summarizeAudit([e('terminal_open'), e('terminal_open'), e('manual_scan')], WATCHING)
    expect(s.byEvent.terminal_open).toBe(2)
    expect(s.byEvent.manual_scan).toBe(1)
  })

  it('survives junk entries without throwing', () => {
    const s = summarizeAudit(
      [e('prompt_secret_sent', { hitCount: -1 }), {} as AuditEntry, e('weird_future_event')],
      WATCHING,
    )
    expect(s.secretsToModels).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(s.totalEvents)).toBe(true)
  })

  it('survives a secret row with no notes at all', () => {
    const s = summarizeAudit([e('prompt_secret_sent', { hitCount: 1 })], WATCHING)
    expect(s.secretsToModels).toBe(1)
    expect(s.secretNames).toEqual([])
    expect(s.detail).toContain('every credential listed below') // no names to name
  })
})
