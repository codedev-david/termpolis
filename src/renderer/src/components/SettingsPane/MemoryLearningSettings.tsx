import { useEffect, useRef, useState } from 'react'
import type { MemoryMetrics } from '../../types'
import {
  dashboardReceipts,
  compositionRows,
  reliabilityTiles,
  teachingRows,
  competenceRows,
  isBrainEmpty,
  compactNumber,
  pct,
  type SliStatus,
} from '../../lib/memoryDashboard'

const STATUS_COLOR: Record<SliStatus, string> = {
  good: '#7ee2a3',
  warn: '#e2c08d',
  bad: '#f48771',
  idle: '#9ca3af',
}

const TYPE_COLOR: Record<string, string> = {
  episodic: '#64748b',
  semantic: '#22D3EE',
  procedural: '#e2c08d',
  entity: '#7aa2f7',
  summary: '#f472b6',
  untyped: '#555555',
}
const colorFor = (key: string): string => TYPE_COLOR[key] || '#22D3EE'

function Bar({ label, count, frac, color }: { label: string; count: number; frac: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-xs my-1">
      <span className="w-28 shrink-0 text-[#9ca3af] truncate" title={label}>{label}</span>
      <span className="flex-1 h-2 rounded-full bg-[#1e1e1e] overflow-hidden">
        <span className="block h-full rounded-full" style={{ width: `${Math.round(frac * 100)}%`, background: color }} />
      </span>
      <span className="w-12 shrink-0 text-right tabular-nums text-[#e0e0e0]">{compactNumber(count)}</span>
    </div>
  )
}

function Panel({ title, hint, testId, children }: { title: string; hint?: string; testId?: string; children: React.ReactNode }) {
  return (
    <div className="p-3 border border-[#3c3c3c] rounded bg-[#252526] flex flex-col gap-1" data-testid={testId}>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-sm font-medium text-[#e0e0e0]">{title}</span>
        {hint && <span className="text-[10px] text-[#6b7280] font-mono">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

export function MemoryLearningSettings() {
  const [m, setM] = useState<MemoryMetrics | null>(null)
  const [err, setErr] = useState<string>('')
  const mounted = useRef(true)

  const load = async () => {
    try {
      const res = await window.termpolis.memoryMetrics()
      if (!mounted.current) return
      if (res?.success && res.data) { setM(res.data); setErr('') }
      else setErr(res?.error || 'Could not read memory metrics')
    } catch (e) {
      if (mounted.current) setErr((e as Error).message || 'Could not read memory metrics')
    }
  }

  useEffect(() => {
    mounted.current = true
    void load()
    const t = setInterval(() => { void load() }, 5000)
    return () => { mounted.current = false; clearInterval(t) }
  }, [])

  return (
    <div className="flex flex-col gap-4" data-testid="memory-learning-settings">
      <div className="flex items-start gap-3">
        <i className="fa-solid fa-brain text-[#22D3EE] text-lg mt-0.5" />
        <div className="flex flex-col gap-0.5 flex-1">
          <span className="text-sm font-medium text-[#e0e0e0]">Proof it&rsquo;s working</span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            Live, from your local brain. Every number here is computed on this machine, offline, from
            the append-only memory store &mdash; no word-taking required. Updates every few seconds.
          </span>
        </div>
        <button
          onClick={() => void load()}
          data-testid="ml-refresh"
          className="text-xs px-2 py-1 rounded bg-[#2d2d2d] hover:bg-[#3c3c3c] border border-[#3c3c3c] shrink-0"
        >Refresh</button>
      </div>

      {err && <div data-testid="ml-error" className="text-xs text-[#f48771] p-3 border border-[#f48771]/40 rounded bg-[#f48771]/10">{err}</div>}
      {!m && !err && <div data-testid="ml-loading" className="text-xs text-[#9ca3af] p-3">Reading your brain&hellip;</div>}

      {m && isBrainEmpty(m) && (
        <div data-testid="ml-empty" className="text-xs text-[#9ca3af] p-4 border border-[#3c3c3c] rounded bg-[#252526] leading-relaxed">
          Your brain is empty right now &mdash; it fills as you work. Launch an agent, let it run, and this
          dashboard will show what it stored, what it learned, and how its memories connect. Nothing is
          pre-seeded; every number here will be yours.
        </div>
      )}

      {m && !isBrainEmpty(m) && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="ml-receipts">
            {dashboardReceipts(m).map((r) => (
              <div key={r.label} className="p-3 border border-[#3c3c3c] rounded bg-[#252526] flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-[#6b7280] font-mono">{r.label}</span>
                <span className="text-2xl font-mono font-bold text-[#22D3EE] tabular-nums">{r.value}</span>
                <span className="text-[10px] text-[#9ca3af]">{r.sub}</span>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Panel title="What's stored" hint="by cognitive type" testId="ml-bytype">
              {compositionRows(m.store.byType).map((row) => (
                <Bar key={row.key} label={row.key} count={row.count} frac={row.pct} color={colorFor(row.key)} />
              ))}
            </Panel>
            <Panel title="By source" hint="which agent authored it" testId="ml-bysource">
              {compositionRows(m.store.bySource).map((row) => (
                <Bar key={row.key} label={row.key} count={row.count} frac={row.pct} color="#22D3EE" />
              ))}
            </Panel>
          </div>

          <Panel title="Connections" hint={`${compactNumber(m.graph.nodes)} nodes · ${compactNumber(m.graph.edges)} edges`} testId="ml-connections">
            {compositionRows(m.graph.byRelation).length === 0
              ? <span className="text-xs text-[#9ca3af]">No typed connections yet &mdash; they form as the brain reflects and links memories.</span>
              : compositionRows(m.graph.byRelation).map((row) => (
                <Bar key={row.key} label={row.key} count={row.count} frac={row.pct} color="#7aa2f7" />
              ))}
          </Panel>

          <Panel title="Reliability" hint="service-level indicators" testId="ml-reliability">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {reliabilityTiles(m).map((t) => (
                <div key={t.label} className="flex flex-col gap-0.5 p-2 rounded bg-[#1e1e1e]">
                  <span className="text-[10px] text-[#9ca3af]">{t.label}</span>
                  <span className="text-sm font-mono font-bold tabular-nums" style={{ color: STATUS_COLOR[t.status] }}>{t.value}</span>
                </div>
              ))}
            </div>
          </Panel>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Panel title="Self-competence by domain" hint="Wilson lower bound" testId="ml-competence">
              {competenceRows(m).length === 0
                ? <span className="text-xs text-[#9ca3af]">No track record yet &mdash; competence is earned from task outcomes.</span>
                : competenceRows(m).map((c) => (
                  <Bar key={c.domain} label={`${c.domain} (${c.attempts})`} count={Math.round(c.confidence * 100)} frac={c.confidence} color={STATUS_COLOR[c.status]} />
                ))}
            </Panel>

            <Panel title="Cross-agent learning" hint="who taught whom" testId="ml-cross">
              {teachingRows(m.ledger.teachingMatrix).filter((r) => r.cross).length === 0 ? (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-[#9ca3af]">
                    No cross-agent reuse recorded yet. It appears here once a lesson one agent learned is
                    recalled and marked helpful by another.
                  </span>
                  <span className="text-[10px] text-[#6b7280] font-mono mt-1">
                    corroboration signal: {m.ledger.crossAgentRecalls} cross-agent recalls
                  </span>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {teachingRows(m.ledger.teachingMatrix).filter((r) => r.cross).slice(0, 6).map((r) => (
                    <div key={`${r.author}->${r.reader}`} className="flex items-center gap-2 text-xs">
                      <span className="text-[#e0e0e0]">{r.author}</span>
                      <i className="fa-solid fa-arrow-right text-[9px] text-[#22D3EE]" />
                      <span className="text-[#e0e0e0]">{r.reader}</span>
                      <span className="ml-auto tabular-nums text-[#9ca3af]">{r.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Receipts" hint="what the memory saved you" testId="ml-receipt-economics">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="flex flex-col p-2 rounded bg-[#1e1e1e]"><span className="text-[#9ca3af] text-[10px]">Recalls served</span><span className="font-mono font-bold text-[#e0e0e0] tabular-nums">{compactNumber(m.ledger.recalls)}</span></div>
              <div className="flex flex-col p-2 rounded bg-[#1e1e1e]"><span className="text-[#9ca3af] text-[10px]">Solutions reused</span><span className="font-mono font-bold text-[#e0e0e0] tabular-nums">{compactNumber(m.ledger.reusedSolutions)}</span></div>
              <div className="flex flex-col p-2 rounded bg-[#1e1e1e]"><span className="text-[#9ca3af] text-[10px]">Tokens saved (est.)</span><span className="font-mono font-bold text-[#7ee2a3] tabular-nums">{compactNumber(m.ledger.tokensSavedEstimate)}</span></div>
              <div className="flex flex-col p-2 rounded bg-[#1e1e1e]"><span className="text-[#9ca3af] text-[10px]">Helpful rate</span><span className="font-mono font-bold text-[#e0e0e0] tabular-nums">{m.ledger.feedbackCount > 0 ? pct(m.ledger.feedbackHelpfulRate) : '—'}</span></div>
            </div>
          </Panel>

          <div className="text-[10px] text-[#6b7280] font-mono flex items-center gap-2">
            <i className="fa-solid fa-lock text-[#7ee2a3]" />
            computed locally · offline · nothing on this screen leaves your machine
          </div>
        </>
      )}
    </div>
  )
}
