import { useEffect, useRef, useState } from 'react'
import { VectorRamPanel } from './VectorRamPanel'
import { StallHistoryPanel } from './StallHistoryPanel'
import type { MemoryMetrics, GraphSample } from '../../types'
import {
  dashboardReceipts,
  codeGraphReceipt,
  compositionRows,
  reliabilityTiles,
  teachingRows,
  competenceRows,
  portabilityRows,
  svgLine,
  isBrainEmpty,
  compactNumber,
  pct,
  typeColor,
  sourceLabel,
  OP_COLOR,
  type SliStatus,
} from '../../lib/memoryDashboard'
import { ConnectionsGraph } from './ConnectionsGraph'

const STATUS_COLOR: Record<SliStatus, string> = { good: '#7ee2a3', warn: '#e2c08d', bad: '#f48771', idle: '#9ca3af' }

/** A small "ⓘ" affordance that reveals an explanatory tooltip on hover/focus and toggles
 *  on click (touch-friendly). `align="right"` anchors it to the right edge for right-hand
 *  panels so the tooltip never runs off-screen. */
function InfoTip({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label="What this means"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        className="ml-1.5 w-[15px] h-[15px] inline-flex items-center justify-center rounded-full border border-[#3c3c3c] bg-[#2d2d2d] text-[#9ca3af] text-[9px] font-mono leading-none hover:text-[#22D3EE] hover:border-[#22D3EE]"
      >i</button>
      {open && (
        <span
          role="tooltip"
          className={`absolute z-50 top-[calc(100%+8px)] ${align === 'right' ? 'right-0' : 'left-0'} w-64 max-w-[74vw] rounded-lg border border-[#3c3c3c] bg-[#1e1e1e] p-2.5 text-[11px] font-sans font-normal normal-case leading-relaxed tracking-normal text-[#9ca3af] shadow-xl`}
        >{children}</span>
      )}
    </span>
  )
}

function Panel({ title, hint, testId, info, infoAlign, children }: { title: string; hint?: string; testId?: string; info?: React.ReactNode; infoAlign?: 'left' | 'right'; children: React.ReactNode }) {
  return (
    <div className="p-3 border border-[#3c3c3c] rounded bg-[#252526] flex flex-col gap-1 min-w-0" data-testid={testId}>
      <div className="flex items-baseline justify-between mb-1 gap-2">
        <span className="text-sm font-medium text-[#e0e0e0] inline-flex items-center">{title}{info && <InfoTip align={infoAlign}>{info}</InfoTip>}</span>
        {hint && <span className="text-[10px] text-[#6b7280] font-mono shrink-0">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function Bar({ label, count, frac, color }: { label: string; count: number; frac: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-xs my-1">
      <span className="w-28 shrink-0 text-[#9ca3af] truncate" title={label}>{label}</span>
      <span className="flex-1 h-2 rounded-full bg-[#1e1e1e] overflow-hidden">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(2, Math.round(frac * 100))}%`, background: color }} />
      </span>
      <span className="w-12 shrink-0 text-right tabular-nums text-[#e0e0e0]">{compactNumber(count)}</span>
    </div>
  )
}

function Spark({ values, color }: { values: number[]; color: string }) {
  if (!values || values.length < 2) return null
  const { line, area } = svgLine(values, 64, 22, 2)
  return (
    <svg width={64} height={22} className="shrink-0" aria-hidden="true">
      <path d={area} fill={color} opacity={0.14} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.4} />
    </svg>
  )
}

export function MemoryLearningSettings() {
  const [m, setM] = useState<MemoryMetrics | null>(null)
  const [graph, setGraph] = useState<GraphSample | null>(null)
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

  const loadGraph = async () => {
    try {
      const res = await window.termpolis.memoryGraphSample(160)
      if (mounted.current && res?.success && res.data) setGraph(res.data)
    } catch { /* graph is best-effort; the rest of the dashboard still renders */ }
  }

  useEffect(() => {
    mounted.current = true
    void load()
    void loadGraph()
    const t = setInterval(() => { void load() }, 5000) // metrics poll; graph is fetched on mount/refresh only
    return () => { mounted.current = false; clearInterval(t) }
  }, [])

  const refresh = () => { void load(); void loadGraph() }

  return (
    <div className="flex flex-col gap-4" data-testid="memory-learning-settings">
      {/* Vector RAM + main-thread health. Lives at the TOP because it is the one panel here that
          can tell you to change something — and the one that can honestly tell you not to. */}
      <VectorRamPanel />
      <StallHistoryPanel />

      <div className="flex items-start gap-3">
        <i className="fa-solid fa-brain text-[#22D3EE] text-lg mt-0.5" />
        <div className="flex flex-col gap-0.5 flex-1">
          <span className="text-sm font-medium text-[#e0e0e0]">Proof it&rsquo;s working</span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            Live, from your local brain. Every number here is computed on this machine, offline, from
            the append-only memory store &mdash; no word-taking required. Updates every few seconds.
          </span>
        </div>
        <button onClick={refresh} data-testid="ml-refresh" className="text-xs px-2 py-1 rounded bg-[#2d2d2d] hover:bg-[#3c3c3c] border border-[#3c3c3c] shrink-0">Refresh</button>
      </div>

      {err && <div data-testid="ml-error" className="text-xs text-[#f48771] p-3 border border-[#f48771]/40 rounded bg-[#f48771]/10">{err}</div>}
      {!m && !err && <div data-testid="ml-loading" className="text-xs text-[#9ca3af] p-3">Reading your brain&hellip;</div>}

      {m && isBrainEmpty(m) && (
        <div data-testid="ml-empty" className="text-xs text-[#9ca3af] p-4 border border-[#3c3c3c] rounded bg-[#252526] leading-relaxed">
          Your brain is empty right now &mdash; it fills as you work. Launch an agent, let it run, and this
          dashboard will show what it stored, what it learned, and how its memories connect.
        </div>
      )}

      {m && !isBrainEmpty(m) && (
        <>
          {/* Headline receipt strip with real growth sparklines. The "Code connections" tile
              only appears once a repo is indexed: structural code edges (caller->callee) live
              in a SEPARATE store from the semantic memory graph, so they get their own number
              rather than being conflated with "Connections mapped". */}
          <div className={`grid grid-cols-2 ${codeGraphReceipt(m) ? 'md:grid-cols-5' : 'md:grid-cols-4'} gap-3`} data-testid="ml-receipts">
            {[...dashboardReceipts(m), ...(codeGraphReceipt(m) ? [codeGraphReceipt(m)!] : [])].map((r) => (
              <div key={r.label} className="p-3 border border-[#3c3c3c] rounded bg-[#252526] flex flex-col gap-0.5 relative overflow-hidden">
                <span className="text-[10px] uppercase tracking-wide text-[#6b7280] font-mono">{r.label}</span>
                <div className="flex items-end justify-between gap-1">
                  <span className="text-2xl font-mono font-bold text-[#22D3EE] tabular-nums leading-none">{r.value}</span>
                  {r.spark && <Spark values={r.spark} color="#22D3EE" />}
                </div>
                <span className="text-[10px] text-[#9ca3af]">{r.sub}</span>
              </div>
            ))}
          </div>

          {/* CENTERPIECE — live knowledge graph */}
          <Panel
            title="Connections — live knowledge graph"
            hint="force-directed · typed edges"
            testId="ml-connections"
            info={<><b className="text-[#e0e0e0]">Each node is a memory</b>, colored by cognitive type; each link is a typed edge the brain actually walks during recall (e.g. <span className="font-mono">bug → solved-by → fix → supersedes</span>). This shows the most-connected slice of the full graph — hover a node for its label, click to trace its connections.</>}
          >
            {graph
              ? <ConnectionsGraph nodes={graph.nodes} edges={graph.edges} totalNodes={graph.totalNodes} totalEdges={graph.totalEdges} />
              : <span className="text-xs text-[#9ca3af]" data-testid="ml-graph-loading">Building the graph&hellip;</span>}
            <div className="text-[10px] text-[#6b7280] font-mono mt-2 border-t border-[#3c3c3c]/60 pt-2">
              Nodes are memories, links are the typed edges recall walks (bug → fix → what superseded it). Colored by cognitive type.
            </div>
          </Panel>

          {/* composition */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Panel
              title="What's stored"
              hint="by cognitive type"
              testId="ml-bytype"
              info={<><b className="text-[#e0e0e0]">Five memory types.</b>{' '}
                <b style={{ color: typeColor('episodic') }}>episodic</b> — raw ingested transcript/code (what happened).{' '}
                <b style={{ color: typeColor('semantic') }}>semantic</b> — distilled facts &amp; decisions.{' '}
                <b style={{ color: typeColor('procedural') }}>procedural</b> — how-to recipes (an error→fix).{' '}
                <b style={{ color: typeColor('entity') }}>entity</b> — a canonical artifact: a file, function, or error.{' '}
                <b style={{ color: typeColor('summary') }}>summary</b> — a rollup of many memories from the offline &ldquo;sleep&rdquo; pass.</>}
            >
              {compositionRows(m.store.byType).map((row) => (
                <Bar key={row.key} label={row.key} count={row.count} frac={row.pct} color={typeColor(row.key)} />
              ))}
            </Panel>
            <Panel
              title="By source"
              hint="which agent authored it"
              testId="ml-bysource"
              infoAlign="right"
              info={<>Which agent or session <b className="text-[#e0e0e0]">authored</b> each memory. Named agents (Claude, Codex…) and <span className="font-mono">Code index</span> (the repo indexer) show by name; raw live-session ids are shortened to <span className="font-mono">session …</span>.</>}
            >
              {compositionRows(m.store.bySource).slice(0, 8).map((row) => (
                <Bar key={row.key} label={sourceLabel(row.key)} count={row.count} frac={row.pct} color="#3987e5" />
              ))}
            </Panel>
          </div>

          {/* learning over time — cumulative store growth */}
          <Panel title="Learning over time" hint="cumulative memories · last 12 weeks" testId="ml-timeline">
            <GrowthChart timeline={m.store.timeline} lessons={m.store.lessons} />
          </Panel>

          {/* competence + reliability */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Panel
              title="Self-competence by domain"
              hint="Wilson lower bound"
              testId="ml-competence"
              info={<><b className="text-[#e0e0e0]">How reliable the brain has been</b> in each domain, learned from past task outcomes. Scored with a <b>Wilson lower bound</b> — deliberately conservative, so it under-claims until there&rsquo;s real evidence (~0.90+ = proven; below ~0.75 = caution). This is the <span className="font-mono">memory_selfcheck</span> signal, visualized.</>}
            >
              {competenceRows(m).length === 0
                ? <span className="text-xs text-[#9ca3af]">No track record yet &mdash; competence is earned from task outcomes.</span>
                : competenceRows(m).map((c) => (
                  <Bar key={c.domain} label={`${c.domain} (${c.attempts})`} count={Math.round(c.confidence * 100)} frac={c.confidence} color={STATUS_COLOR[c.status]} />
                ))}
            </Panel>
            <Panel
              title="Reliability"
              hint="service-level indicators"
              testId="ml-reliability"
              infoAlign="right"
              info={<><b className="text-[#e0e0e0]">Recall fired</b> — % of recalls that returned ≥1 hit (recall isn&rsquo;t silently failing). <b>Embedding model</b> — whether the local semantic model is up <i>right now</i>; if it drops, keyword search still runs. The grey line beneath is <i>history</i> — how many of your recent recalls ran semantic — and is never graded, so an outage you already fixed can&rsquo;t keep the tile red forever. <b>Write durability</b> — % of writes confirmed persisted (append-only). <b>Recall latency</b> — typical (median) time to return a recall, so a first-search cold model-load doesn&rsquo;t skew it.</>}
            >
              <div className="grid grid-cols-2 gap-2">
                {reliabilityTiles(m).map((t) => {
                  const isPct = t.value.endsWith('%')
                  const frac = isPct ? parseInt(t.value, 10) / 100 : 0
                  return (
                    <div key={t.label} className="flex flex-col gap-1 p-2 rounded bg-[#1e1e1e]">
                      <span className="text-[10px] text-[#9ca3af]">{t.label}</span>
                      <span className="text-sm font-mono font-bold tabular-nums" style={{ color: STATUS_COLOR[t.status] }}>{t.value}</span>
                      {isPct && (
                        <span className="h-1 rounded-full bg-[#2d2d2d] overflow-hidden">
                          <span className="block h-full rounded-full" style={{ width: `${Math.round(frac * 100)}%`, background: STATUS_COLOR[t.status] }} />
                        </span>
                      )}
                      {/* History, not status: deliberately grey and un-graded, so a past outage can
                          inform without masquerading as a live alarm. */}
                      {t.sub && <span className="text-[10px] text-[#6b7280] font-mono">{t.sub}</span>}
                    </div>
                  )
                })}
              </div>
            </Panel>
          </div>

          {/* model portability + cross-agent learning */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Panel title="Model portability" hint="one brain · every model" testId="ml-portability">
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono tabular-nums">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-[#6b7280]">
                      <th className="text-left font-semibold py-1">Source</th>
                      <th className="text-right font-semibold py-1">Authored</th>
                      <th className="text-right font-semibold py-1">Taught others</th>
                    </tr>
                  </thead>
                  <tbody>
                    {portabilityRows(m.store.bySource, m.ledger.teachingMatrix).map((r) => (
                      <tr key={r.model} className="border-t border-[#3c3c3c]/50">
                        <td className="text-left py-1 text-[#e0e0e0]">{r.label}</td>
                        <td className="text-right py-1 text-[#e0e0e0]">{compactNumber(r.wrote)}</td>
                        <td className="text-right py-1" style={{ color: r.cross > 0 ? '#7ee2a3' : '#6b7280' }}>{r.cross > 0 ? compactNumber(r.cross) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-[10px] text-[#6b7280] font-mono mt-2">Every model writes to the same brain; "taught others" is a lesson reused by a different agent.</div>
            </Panel>

            <Panel
              title="Cross-agent learning"
              hint="who taught whom"
              testId="ml-cross"
              infoAlign="right"
              info={<><b className="text-[#e0e0e0]">One brain, every agent.</b> This counts lessons one agent authored that a <b>different</b> agent later recalled and marked helpful — real teaching between models over the shared store. It stays empty until that cross-agent reuse actually happens (it&rsquo;s not simulated).</>}
            >
              {teachingRows(m.ledger.teachingMatrix).filter((r) => r.cross).length === 0 ? (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-[#9ca3af]">No cross-agent reuse recorded yet. It appears here once a lesson one agent learned is recalled and marked helpful by another.</span>
                  <span className="text-[10px] text-[#6b7280] font-mono mt-1">corroboration signal: {m.ledger.crossAgentRecalls} cross-agent recalls</span>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {teachingRows(m.ledger.teachingMatrix).filter((r) => r.cross).slice(0, 8).map((r) => (
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

          {/* receipts (economics) */}
          <Panel title="Receipts" hint="what the memory saved you" testId="ml-receipt-economics">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="flex flex-col p-2 rounded bg-[#1e1e1e]"><span className="text-[#9ca3af] text-[10px]">Recalls served</span><span className="font-mono font-bold text-[#e0e0e0] tabular-nums">{compactNumber(m.ledger.recalls)}</span></div>
              <div className="flex flex-col p-2 rounded bg-[#1e1e1e]"><span className="text-[#9ca3af] text-[10px]">Solutions reused</span><span className="font-mono font-bold text-[#e0e0e0] tabular-nums">{compactNumber(m.ledger.reusedSolutions)}</span></div>
              <div className="flex flex-col p-2 rounded bg-[#1e1e1e]"><span className="text-[#9ca3af] text-[10px]">Tokens saved (est.)</span><span className="font-mono font-bold text-[#7ee2a3] tabular-nums">{compactNumber(m.ledger.tokensSavedEstimate)}</span></div>
              <div className="flex flex-col p-2 rounded bg-[#1e1e1e]"><span className="text-[#9ca3af] text-[10px]">Helpful rate</span><span className="font-mono font-bold text-[#e0e0e0] tabular-nums">{m.ledger.feedbackCount > 0 ? pct(m.ledger.feedbackHelpfulRate) : '—'}</span></div>
            </div>
          </Panel>

          {/* live event ticker */}
          <Panel title="Recent memory operations" hint="every write / index / reflect is traceable" testId="ml-ticker">
            {m.recentActivity.length === 0
              ? <span className="text-xs text-[#9ca3af]">No operations yet.</span>
              : (
                <div className="flex flex-col gap-0.5 font-mono text-[11px] max-h-64 overflow-hidden">
                  {m.recentActivity.map((e, i) => (
                    <div key={i} className={`flex gap-2 items-baseline px-2 py-1 rounded ${i % 2 ? '' : 'bg-[#1e1e1e]'}`}>
                      <span className="text-[#6b7280] shrink-0">{formatClock(e.ts)}</span>
                      <span className="shrink-0 w-14" style={{ color: OP_COLOR[e.op] || '#9ca3af' }}>{e.op}</span>
                      <span className="text-[#9ca3af] truncate" title={e.detail}>{e.detail}</span>
                    </div>
                  ))}
                </div>
              )}
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

function formatClock(ts: number): string {
  try {
    const d = new Date(ts)
    const p = (x: number): string => (x < 10 ? '0' : '') + x
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  } catch { return '' }
}

/** Cumulative store-growth area chart (memories) with the lessons trend overlaid on its
 *  own scale — honest: lessons are a small distilled fraction of raw memory. */
function GrowthChart({ timeline, lessons }: { timeline: Array<{ t: number; total: number; lessons: number }>; lessons: number }) {
  if (!timeline || timeline.length < 2) {
    return <span className="text-xs text-[#9ca3af]">Not enough history yet — the growth curve fills in over the coming weeks.</span>
  }
  const W = 560, H = 150, pad = 6
  const totals = timeline.map((t) => t.total)
  const lessonsSeries = timeline.map((t) => t.lessons)
  const totalPath = svgLine(totals, W, H, pad)
  const lessonPath = svgLine(lessonsSeries, W, H, pad) // own scale, drawn as a secondary trend
  return (
    <div className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none" style={{ display: 'block', height: 150 }} data-testid="ml-growth-svg">
        <path d={totalPath.area} fill="#22D3EE" opacity={0.12} />
        <path d={totalPath.line} fill="none" stroke="#22D3EE" strokeWidth={2} />
        <path d={lessonPath.line} fill="none" stroke="#e2c08d" strokeWidth={1.6} strokeDasharray="3 3" />
      </svg>
      <div className="flex gap-4 text-[11px] font-mono text-[#9ca3af]">
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-[#22D3EE]" />cumulative memories</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-[#e2c08d]" />lessons distilled ({compactNumber(lessons)}, own scale)</span>
      </div>
    </div>
  )
}
