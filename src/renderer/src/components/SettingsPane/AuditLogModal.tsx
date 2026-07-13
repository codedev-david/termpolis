// The AI Security audit log, in full.
//
// What this panel is FOR: telling you what to rotate. Outbound redaction is gone — Termpolis
// forwards every byte you type to the agent untouched and scans a shadow copy on submit/paste, so
// by the time a `prompt_secret_sent` row exists the value is already at the provider. There is no
// "we caught it in time" story to tell. The honest, useful thing is the NAME: `DB_PASSWORD went to
// Claude three times` is something you can act on in the next sixty seconds.
//
// Two rules this component must never break:
//   1. Never render a secret VALUE. There isn't one to render — main captures the name and the
//      rule id and nothing else — and it must stay that way, or the audit log becomes a second
//      place the secret leaked to.
//   2. Never show prompt watching as a boolean. It cannot be turned off. A chip that reads
//      "Prompt scanning: on" implies a state where it reads OFF, and that state no longer exists.
//
// summarizeAudit() owns the verdict logic and is unit-tested; this component only renders it.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { summarizeAudit, type AuditCoverage, type AuditEntry, type AuditVerdict } from '../../lib/auditSummary'

interface AuditApi {
  recentAudit: (limit?: number) => Promise<{ success: boolean; data?: AuditEntry[] }>
  clearAudit: () => Promise<{ success: boolean }>
}

interface Props {
  onClose: () => void
  coverage: AuditCoverage
  auditPath: string
}

const VERDICT_STYLE: Record<AuditVerdict, { box: string; icon: string }> = {
  caught: { box: 'bg-[#3a0d0d] border-[#6e1f1f] text-[#FFB4B4]', icon: 'fa-triangle-exclamation' },
  clean: { box: 'bg-[#0d3a1a] border-[#1f6e3a] text-[#7ee2a3]', icon: 'fa-circle-check' },
  'audit-off': { box: 'bg-[#3a0d0d] border-[#6e1f1f] text-[#FFB4B4]', icon: 'fa-ban' },
  'no-data': { box: 'bg-[#252526] border-[#3c3c3c] text-[#9ca3af]', icon: 'fa-circle-info' },
}

/** Security FINDINGS, as opposed to routine bookkeeping. `code_chunk_sent` is deliberately absent:
 *  pasting a source file into an agent is the workflow this product exists to support, and putting
 *  it in here would bury the rows that actually matter. An env dump is a different story. */
const NOTABLE = new Set([
  'prompt_secret_sent', 'redaction_hit', 'env_dump_sent',
  'commit_blocked', 'push_blocked', 'import_blocked', 'egress_violation', 'sensitive_file_read',
])

const EVENT_LABEL: Record<string, string> = {
  prompt_secret_sent: 'SECRET SENT to a model',
  // Legacy. Written by a version whose "redaction" never actually removed anything from the
  // prompt, so the old label ("Secret redacted from a prompt") was a claim we cannot stand behind.
  redaction_hit: 'Secret in a prompt (legacy record)',
  code_chunk_sent: 'Code chunk sent to a model',
  env_dump_sent: 'Env dump sent to a model',
  commit_blocked: 'Commit blocked (secret)',
  push_blocked: 'Push blocked (secret)',
  import_blocked: 'Unsafe import refused',
  egress_violation: 'Egress to an unexpected host',
  sensitive_file_read: 'Sensitive file read',
  memory_scrub: 'Secret scrubbed from a memory',
  import_scan: 'Import scanned',
  commit_scan: 'Commit scanned',
  manual_scan: 'Manual scan',
  terminal_open: 'Terminal opened',
  terminal_close: 'Terminal closed',
}

export function AuditLogModal({ onClose, coverage, auditPath }: Props): JSX.Element {
  const api = (typeof window !== 'undefined' ? window.aiSecurity : undefined) as AuditApi | undefined
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [onlyNotable, setOnlyNotable] = useState(false)
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    if (!api) { setLoading(false); return }
    setLoading(true)
    try {
      const res = await api.recentAudit(2000)
      if (res.success && res.data) setEntries(res.data)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  const summary = useMemo(() => summarizeAudit(entries, coverage), [entries, coverage])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return entries.filter((x) => {
      if (onlyNotable && !NOTABLE.has(x.event)) return false
      if (!needle) return true
      return `${x.event} ${x.agent} ${x.notes || ''}`.toLowerCase().includes(needle)
    })
  }, [entries, onlyNotable, q])

  const clear = async (): Promise<void> => {
    if (!api) return
    await api.clearAudit()
    await load()
  }

  const v = VERDICT_STYLE[summary.verdict]

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fadeIn"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      data-testid="audit-log-modal"
    >
      <div className="bg-[#252526] rounded-lg shadow-xl border border-[#3c3c3c] w-[820px] max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#3c3c3c]">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <i className="fa-solid fa-clipboard-list text-[#22D3EE]"></i>
            AI Security audit log
          </h2>
          <button onClick={onClose} aria-label="Close" data-testid="audit-close" className="text-[#9ca3af] hover:text-[#e0e0e0]">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div className="px-6 py-4 flex flex-col gap-3 overflow-y-auto">
          {/* The verdict — honest about what watching can and cannot do, not just about counts. */}
          <div className={`p-3 rounded border ${v.box}`} data-testid="audit-verdict">
            <div className="text-sm font-semibold flex items-center gap-2">
              <i className={`fa-solid ${v.icon}`}></i>
              {summary.headline}
            </div>
            <div className="text-xs mt-1 leading-relaxed opacity-90">{summary.detail}</div>
          </div>

          {/* THE ACTIONABLE PART. Names only — never a value; main never captured one. */}
          {summary.secretNames.length > 0 && (
            <div
              data-testid="audit-secret-names"
              className="p-3 rounded border border-[#6e1f1f] bg-[#2a1212] flex flex-col gap-2"
            >
              <div className="text-xs font-semibold text-[#FFB4B4] flex items-center gap-2">
                <i className="fa-solid fa-key"></i>
                Rotate these — they were sent to a model
              </div>
              <div className="flex flex-wrap gap-1.5" data-testid="audit-secret-name-list">
                {summary.secretNames.map((name) => (
                  <code
                    key={name}
                    className="text-[11px] font-mono px-2 py-0.5 rounded border border-[#6e1f1f] bg-[#1e1e1e] text-[#FFB4B4]"
                  >
                    {name}
                  </code>
                ))}
              </div>
              <div className="text-[10px] text-[#9ca3af] leading-relaxed">
                Termpolis records the identifier and the rule that matched it — <strong>never the value</strong>. The prompt
                already reached the provider, so rotation is the remedy; there is nothing to un-send.
              </div>
            </div>
          )}

          {/* Prompt watching gets a STATEMENT, not a chip. A chip implies it could read "OFF". */}
          <div
            data-testid="audit-watch-always-on"
            className="flex items-start gap-2 p-2 rounded border border-[#1f6e3a] bg-[#0d2418] text-[11px] text-[#cfead8]"
          >
            <i className="fa-solid fa-eye text-[#7ee2a3] mt-0.5"></i>
            <span className="leading-relaxed">
              <strong className="text-[#7ee2a3]">Prompt watching is always on and cannot be turned off.</strong>{' '}
              Every submit and every paste into an AI terminal is scanned on a copy. Your text is forwarded to the agent
              <strong> unmodified</strong> — never withheld, never rewritten. A hit is <em>recorded</em>, not blocked.
            </span>
          </div>

          {/* The gates that ARE settings. Without this, the counts below are unreadable. */}
          <div className="flex flex-wrap gap-1.5 text-[10px]" data-testid="audit-coverage">
            {([
              ['Commit Shield', coverage.commitShield],
              ['Egress Guard', coverage.egressGuard],
              ['Memory scrub', coverage.memoryScrub],
              ['Recording', coverage.auditEnabled],
            ] as [string, boolean][]).map(([label, on]) => (
              <span
                key={label}
                className={`px-2 py-0.5 rounded border font-mono ${on ? 'bg-[#0d3a1a] text-[#7ee2a3] border-[#1f6e3a]' : 'bg-[#3a0d0d] text-[#FFB4B4] border-[#6e1f1f]'}`}
              >
                {label}: {on ? 'on' : 'OFF'}
              </span>
            ))}
          </div>

          {/* Counts, split by escape route. Code chunks and env dumps are kept OUT of the secret
              count on purpose — "you pasted a big file" is not "you leaked a key". */}
          <div className="grid grid-cols-4 gap-2 text-xs" data-testid="audit-counts">
            {([
              ['Secrets to a model', summary.secretsToModels, '#FFB4B4'],
              ['Secrets at git', summary.secretsBlockedAtGit, '#FFB74D'],
              ['Code chunks sent', summary.codeChunksSent, '#9ca3af'],
              ['Env dumps sent', summary.envDumpsSent, '#FFB74D'],
              ['Imports refused', summary.unsafeImportsBlocked, '#FFB74D'],
              ['Egress flags', summary.egressViolations, '#FFB74D'],
              ['Sensitive reads', summary.sensitiveReads, '#9ca3af'],
              ['Memories scrubbed', summary.memoriesScrubbed, '#7ee2a3'],
            ] as [string, number, string][]).map(([label, n, color]) => (
              <div key={label} className="flex flex-col p-2 rounded bg-[#1e1e1e]">
                <span className="text-[10px] text-[#9ca3af]">{label}</span>
                <span className="font-mono font-bold tabular-nums" style={{ color: n > 0 ? color : '#6b7280' }}>{n}</span>
              </div>
            ))}
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by event, agent, or note…"
              data-testid="audit-filter"
              className="flex-1 text-xs px-2 py-1.5 rounded bg-[#1e1e1e] border border-[#3c3c3c] outline-none focus:border-[#22D3EE]"
            />
            <label className="text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
              <input type="checkbox" checked={onlyNotable} onChange={() => setOnlyNotable((x) => !x)} data-testid="audit-only-notable" />
              Only security findings
            </label>
          </div>

          {/* The log */}
          {loading ? (
            <div className="text-xs text-[#9ca3af] p-4 text-center">Loading audit log…</div>
          ) : shown.length === 0 ? (
            <div className="text-xs text-[#9ca3af] p-4 text-center" data-testid="audit-empty">
              {entries.length === 0 ? 'The log is empty.' : 'Nothing matches that filter.'}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5 max-h-[38vh] overflow-y-auto" data-testid="audit-rows">
              {shown.map((x, i) => (
                <div
                  key={`${x.ts}-${i}`}
                  className={`grid grid-cols-[130px_70px_1fr_40px] gap-2 items-baseline text-[11px] font-mono p-1.5 rounded ${NOTABLE.has(x.event) ? 'bg-[#2a1e1e]' : 'bg-[#1e1e1e]'}`}
                >
                  <span className="text-[#6b7280]">{new Date(x.ts).toLocaleString()}</span>
                  <span className="text-[#9ca3af] truncate">{x.agent}</span>
                  <span className={NOTABLE.has(x.event) ? 'text-[#FFB74D]' : 'text-[#c9d1d9]'}>
                    {EVENT_LABEL[x.event] || x.event}
                    {x.notes && <span className="text-[#6b7280]"> &mdash; {x.notes}</span>}
                  </span>
                  <span className="text-right tabular-nums text-[#9ca3af]">{x.hitCount ?? ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-3 border-t border-[#3c3c3c] text-[10px] text-[#6b7280]">
          <span className="font-mono truncate" title={auditPath}>{auditPath}</span>
          <div className="flex items-center gap-3">
            <span>{shown.length} of {entries.length} events</span>
            <button onClick={clear} data-testid="audit-clear" className="text-[#FFB4B4] hover:underline">
              Clear log
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
