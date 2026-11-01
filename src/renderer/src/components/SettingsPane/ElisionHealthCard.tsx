import { useCallback, useEffect, useState } from 'react'
import type { ElisionClassView, ElisionHealthView } from '../../types'

const fmt = (n: number): string => n.toLocaleString('en-US')
const pctText = (n: number | null): string => (n === null ? '—' : `${Math.round(n)}%`)

/** Rows shown before "Show all": the busiest classes carry the picture, the long tail is noise. */
const TOP_ROWS = 8
/** Mirrors MIN_SAMPLES in src/main/headroom/elisionHealth.ts — the card names the real floor. */
const MIN_SAMPLES = 30
/** Mirrors UNITS_PER_KEPT_TOKEN, ASSUMED_TURN_UNITS and MIN_TURNS_MEASURED in the same file. */
const UNITS_PER_KEPT_TOKEN = 11

const KIND_LABEL: Record<ElisionClassView['kind'], string> = {
  compact: 'Compacted at first sight',
  dedup: 'Repeat collapsed',
  diff: 'Sent as a patch',
  decay: 'Aged out of a long conversation',
}
const TOOL_LABEL: Record<ElisionClassView['tool'], string> = {
  Read: 'Read', Bash: 'Bash', Grep: 'Grep', Glob: 'Glob', PowerShell: 'PowerShell', WebFetch: 'WebFetch', WebSearch: 'WebSearch',
  mcp: 'MCP tools', other: 'Other tools',
}
const BAND_LABEL: Record<ElisionClassView['band'], string> = {
  '<1.6k': 'under 1.6k chars', '1.6-4k': '1.6-4k chars', '4-10k': '4-10k chars', '10-40k': '10-40k chars', '40k+': '40k+ chars',
}
const VERDICT_COLOR: Record<ElisionClassView['verdict'], string> = { pays: '#4ade80', costs: '#f87171', unknown: 'inherit' }

/** What the verdict rests on, in words: the recent window of this run, or everything so far. */
function basisText(v: ElisionHealthView['firstSight']): string {
  return v.basis === 'recent' ? `the last ${fmt(v.elided)} results of this run` : `all ${fmt(v.elided)} results so far`
}

function Verdict({ v }: { v: ElisionHealthView['firstSight'] }) {
  let text: string
  if (v.verdict === 'unknown') {
    text = `Not enough results yet to say. Each kind of result needs at least ${MIN_SAMPLES} first-sight compactions before its rate means anything.`
  } else {
    const units = `${fmt(Math.abs(v.netUnits))} billed units`
    const rate = `the model asked for ${pctText(v.ratePct)} of them back, and compacting ${v.verdict === 'costs' ? 'pays only below' : 'pays up to'} ${pctText(v.breakEvenPct)}`
    text = `Eliding results at first sight is ${v.verdict === 'costs' ? 'costing' : 'saving'} you about ${units} over ${basisText(v)}: ${rate}.`
  }
  return (
    <div data-testid="hr-elision-verdict" data-verdict={v.verdict} style={{ marginTop: 6, fontSize: 14, fontWeight: 600, color: VERDICT_COLOR[v.verdict] }}>
      {text}
    </div>
  )
}

function Turns({ t }: { t: ElisionHealthView['turns'] }) {
  if (t.count === 0) {
    return <div data-testid="hr-elision-turns" style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>No turns that only fetched elided text yet.</div>
  }
  return (
    <div data-testid="hr-elision-turns" style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
      Retrieval turns: <b>{fmt(t.count)}</b> {t.count === 1 ? 'turn' : 'turns'} that only fetched elided text
      {t.sharePct !== null && <> ({t.sharePct}% of responses)</>} cost <b>{fmt(Math.round(t.units))} billed units</b>,
      about {fmt(t.unitsPerTurn)} each ({t.costBasis}). Each re-reads the whole cached prefix, which is why one costs far more than the text it brings back.
    </div>
  )
}

function Row({ c }: { c: ElisionClassView }) {
  const judged = c.kind === 'compact'
  return (
    <tr data-testid={`hr-elision-row-${c.key}`}>
      <td style={{ padding: '3px 8px 3px 0' }}>{KIND_LABEL[c.kind]}</td>
      <td style={{ padding: '3px 8px' }}>{TOOL_LABEL[c.tool]}</td>
      <td style={{ padding: '3px 8px' }}>{BAND_LABEL[c.band]}</td>
      <td style={{ padding: '3px 8px', textAlign: 'right' }} data-testid="hr-elision-elided">{fmt(c.elided)}</td>
      <td style={{ padding: '3px 8px', textAlign: 'right' }} data-testid="hr-elision-rate">{pctText(c.ratePct)}</td>
      <td style={{ padding: '3px 8px', textAlign: 'right' }} data-testid="hr-elision-recent">
        {c.recentRatePct === null ? '—' : <>{pctText(c.recentRatePct)} <span style={{ opacity: 0.6 }}>of {fmt(c.recentElided)}</span></>}
      </td>
      <td style={{ padding: '3px 8px', textAlign: 'right' }} data-testid="hr-elision-breakeven">{judged ? pctText(c.breakEvenPct) : '—'}</td>
      <td style={{ padding: '3px 0 3px 8px', color: judged ? VERDICT_COLOR[c.verdict] : 'inherit' }} data-testid="hr-elision-verdict-cell">
        {judged ? (c.verdict === 'pays' ? 'Pays' : c.verdict === 'costs' ? 'Costs' : 'Too few') : '—'}
      </td>
    </tr>
  )
}

/**
 * Elision health: how often the model asks for elided text back, by kind of result, and whether
 * eliding it at first sight pays at that rate. The rate moved from 13% to 66% in one week of
 * August and nothing in the app showed it. This does, with the retrieval turns that fetched the
 * text priced in, and says plainly when the answer is that eliding is costing money.
 */
export function ElisionHealthCard() {
  const [view, setView] = useState<ElisionHealthView | null>(null)
  const [failed, setFailed] = useState(false)
  const [all, setAll] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await window.termpolis.tokenSavingsGetElisionHealth?.()
      if (r?.success) { setView(r.data); setFailed(false) } else setFailed(true)
    } catch { setFailed(true) }
  }, [])
  useEffect(() => { void load() }, [load])

  const shown = view ? (all ? view.classes : view.classes.slice(0, TOP_ROWS)) : []

  return (
    <div data-testid="hr-elision-health" style={{ border: '1px solid #8884', borderRadius: 8, padding: 14, marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h4 style={{ margin: '0 0 6px' }}>Elision health <span style={{ fontWeight: 400, opacity: 0.65 }}>— how often the model asks for elided text back</span></h4>
        <button data-testid="hr-elision-refresh" type="button" onClick={() => { void load() }}
          className="bg-[#2d2d2d] text-[#d4d4d4] border border-[#3c3c3c] rounded px-2 py-1 text-xs">Refresh</button>
      </div>

      {!view && (
        <div data-testid={failed ? 'hr-elision-unavailable' : 'hr-elision-loading'} style={{ fontSize: 13, opacity: 0.7 }}>
          {failed ? 'Elision health is unavailable right now.' : 'Reading the ledger…'}
        </div>
      )}

      {view && (
        <>
          <Verdict v={view.firstSight} />
          {view.regime === 'rising' && (
            <div data-testid="hr-elision-regime" style={{ marginTop: 6, fontSize: 13, color: '#f87171' }}>
              Lately the model has been asking for elided text back more often than it did over the whole history.
            </div>
          )}
          {view.regime === 'falling' && (
            <div data-testid="hr-elision-regime" style={{ marginTop: 6, fontSize: 13, opacity: 0.85 }}>
              Lately the model has been asking for elided text back less often than it did over the whole history.
            </div>
          )}

          {view.classes.length === 0 ? (
            <div data-testid="hr-elision-empty" style={{ marginTop: 10, fontSize: 13, opacity: 0.7 }}>
              Nothing has been elided yet, so there is nothing to measure. This fills in as Claude Code sessions run through the proxy.
            </div>
          ) : (
            <>
              <table data-testid="hr-elision-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 10 }}>
                <thead>
                  <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                    <th style={{ padding: '3px 8px 3px 0', fontWeight: 600 }}>What was done</th>
                    <th style={{ padding: '3px 8px', fontWeight: 600 }}>Tool</th>
                    <th style={{ padding: '3px 8px', fontWeight: 600 }}>Size</th>
                    <th style={{ padding: '3px 8px', fontWeight: 600, textAlign: 'right' }} title="Results of this kind elided, all time">Elided</th>
                    <th style={{ padding: '3px 8px', fontWeight: 600, textAlign: 'right' }} title="Share of them the model later asked for back, all time">Asked back</th>
                    <th style={{ padding: '3px 8px', fontWeight: 600, textAlign: 'right' }} title={`The same over the last ${fmt(view.windowSize)} elisions of this run`}>Recent</th>
                    <th style={{ padding: '3px 8px', fontWeight: 600, textAlign: 'right' }} title="The asked-back rate above which eliding this kind at first sight loses money">Break-even</th>
                    <th style={{ padding: '3px 0 3px 8px', fontWeight: 600 }}>Verdict</th>
                  </tr>
                </thead>
                <tbody>{shown.map((c) => <Row key={c.key} c={c} />)}</tbody>
              </table>
              {view.classes.length > TOP_ROWS && (
                <button data-testid="hr-elision-more" type="button" onClick={() => setAll(!all)}
                  className="bg-[#2d2d2d] text-[#d4d4d4] border border-[#3c3c3c] rounded px-2 py-1 text-xs" style={{ marginTop: 8 }}>
                  {all ? 'Show fewer' : `Show all ${view.classes.length}`}
                </button>
              )}
            </>
          )}

          <Turns t={view.turns} />
          {view.legacyRedeemed > 0 && (
            <div data-testid="hr-elision-legacy" style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
              {fmt(view.legacyRedeemed)} {view.legacyRedeemed === 1 ? 'retrieval was' : 'retrievals were'} of text elided before this version counted by kind, or in an earlier launch of the app, so no row above includes {view.legacyRedeemed === 1 ? 'it' : 'them'}.
            </div>
          )}
          <div data-testid="hr-elision-estimate" style={{ marginTop: 8, fontSize: 12, opacity: 0.65 }}>
            The counts and rates are measured; the break-even and the verdict are an estimate. It values a token that stays in the
            conversation at {UNITS_PER_KEPT_TOKEN} billed units (its cache write plus a tenth of a unit for every response that re-reads it),
            counts four characters to a token, and charges a retrieval turn what the ledger has measured, or the research&rsquo;s 16,800 units until it has seen 20.
          </div>
        </>
      )}
    </div>
  )
}
