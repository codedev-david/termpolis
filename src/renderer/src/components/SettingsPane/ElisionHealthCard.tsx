import { useCallback, useEffect, useState } from 'react'
import type { ArmComparisonView, ArmSummaryView, ElisionClassView, ElisionHealthView } from '../../types'

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
  // The share is of the requests that could ask for text back when the ledger has counted those, and of
  // every response it read when it has not (a ledger from before it counted them).
  const share = t.shareBasis === 'could-ask' ? `${t.sharePct}% of the ${fmt(t.askable)} responses to requests that could ask` : `${t.sharePct}% of responses`
  return (
    <div data-testid="hr-elision-turns" style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
      Retrieval turns: <b>{fmt(t.count)}</b> {t.count === 1 ? 'turn' : 'turns'} that only fetched elided text
      {t.sharePct !== null && <> ({share})</>} cost <b>{fmt(Math.round(t.units))} billed units</b>,
      about {fmt(t.unitsPerTurn)} each ({t.costBasis}).
      {t.hops > 0 && <> {fmt(t.hops)} of them {t.hops === 1 ? 'was' : 'were'} preceded by a turn that only loaded the tool (Claude Code keeps it deferred behind ToolSearch); that turn is in the cost.</>}
      {' '}Each re-reads the whole cached prefix, which is why one costs far more than the text it brings back.
      {t.shareBasis === 'could-ask' && t.unaskable > 0 && <> {fmt(t.unaskable)} {t.unaskable === 1 ? 'response' : 'responses'} came from requests with no way to ask, and {t.unaskable === 1 ? 'is' : 'are'} left out of the rate.</>}
    </div>
  )
}

/** Mirrors MIN_ARM_GROUPS in src/main/headroom/armCompare.ts — the card names the real floor. */
const MIN_ARM_GROUPS = 5
const RED = '#f87171'
const num1 = (n: number | null): string => (n === null ? '—' : fmt(n))
const groupsText = (n: number): string => `${n} ${n === 1 ? 'group' : 'groups'}`

function ArmVerdictLine({ a }: { a: ArmComparisonView }) {
  const delta = a.costDeltaPct ?? 0
  const margin = a.costMarginPct ?? 0
  let text: string
  let color = 'inherit'
  if (a.verdict === 'not-enough-data') {
    const onlyLegacy = a.late.requests === 0 && a.holdout.requests === 0 && a.legacy.requests > 0
    text = onlyLegacy
      ? `This run is on the Legacy setting, so every request ran the old behaviour and there is nothing to compare (${fmt(a.legacy.requests)} requests so far).`
      : `Not enough data yet to compare. It needs at least ${fmt(a.minRequests)} requests in each arm, from at least ${MIN_ARM_GROUPS} different groups of conversations. So far: late ${fmt(a.late.requests)} requests in ${groupsText(a.late.groups)}, the holdout ${fmt(a.holdout.requests)} in ${groupsText(a.holdout.groups)}.`
  } else if (a.verdict === 'late-cheaper') {
    color = '#4ade80'
    text = `Late is cheaper. It used about ${Math.abs(delta)}% fewer billed units per unit of work than the holdout (give or take ${margin} points).`
  } else if (a.verdict === 'late-costlier') {
    color = RED
    text = `Late is costing more. It used about ${delta}% more billed units per unit of work than the holdout (give or take ${margin} points), which is more than chance explains. You can switch to Legacy above; it applies the next time Termpolis starts.`
  } else {
    const gap = delta === 0 ? 'running level with the holdout' : `running ${Math.abs(delta)}% ${delta < 0 ? 'cheaper than' : 'dearer than'} the holdout`
    text = `No clear difference yet. Late is ${gap}, give or take ${margin} points, so this could be chance. A gap this small takes more conversations to settle.`
  }
  return (
    <div data-testid="hr-arms-verdict" data-verdict={a.verdict} style={{ marginTop: 6, fontSize: 14, fontWeight: 600, color }}>
      {text}
    </div>
  )
}

function ArmTurnsLine({ a }: { a: ArmComparisonView }) {
  const shares = `${a.late.sharePct === null ? '—' : `${a.late.sharePct}%`} of late’s requests against ${a.holdout.sharePct === null ? '—' : `${a.holdout.sharePct}%`} of the holdout’s`
  let text: string
  let color = 'inherit'
  if (a.turnVerdict === 'fewer') text = `Retrieval turns: ${shares} — clearly fewer round trips.`
  else if (a.turnVerdict === 'more') { color = RED; text = `Retrieval turns: ${shares} — MORE round trips under late, the opposite of what it is for.` }
  else if (a.turnVerdict === 'no-clear-difference') text = `Retrieval turns: ${shares} — no clear difference yet.`
  else text = 'Retrieval turns: not enough data yet.'
  return (
    <div data-testid="hr-arms-turns" data-verdict={a.turnVerdict ?? 'none'} style={{ marginTop: 6, fontSize: 13, color: color === 'inherit' ? undefined : color, opacity: color === 'inherit' ? 0.85 : 1 }}>
      {text}
    </div>
  )
}

function ArmRow({ id, label, s, note }: { id: string; label: string; s: ArmSummaryView; note?: string }) {
  return (
    <tr data-testid={id}>
      <td style={{ padding: '3px 8px 3px 0' }}>{label}{note && <span style={{ opacity: 0.6 }}> ({note})</span>}</td>
      <td style={{ padding: '3px 8px', textAlign: 'right' }}>{fmt(s.requests)}</td>
      <td style={{ padding: '3px 8px', textAlign: 'right' }}>{fmt(s.turns)}{s.sharePct !== null && <> ({s.sharePct}%)</>}</td>
      <td style={{ padding: '3px 8px', textAlign: 'right' }} data-testid="hr-arm-per-request">{num1(s.unitsPerRequest)}</td>
      <td style={{ padding: '3px 0 3px 8px', textAlign: 'right' }} data-testid="hr-arm-per-working">{num1(s.unitsPerWorking)}</td>
    </tr>
  )
}

/**
 * Late against the holdout. About one conversation in ten keeps running the old behaviour whichever
 * setting is on, so the saving the research modelled from one history can be checked on this
 * person's own work, and so can the thing that matters more: that it did not cost anything. This is
 * the card's answer, with the margin stated and a plain "not enough data yet" until there is some.
 */
function Arms({ a }: { a: ArmComparisonView }) {
  return (
    <div data-testid="hr-arms" style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid #8883' }}>
      <div style={{ fontWeight: 600 }}>Late compared with the holdout <span style={{ fontWeight: 400, opacity: 0.65 }}>— the same work, run both ways</span></div>
      <ArmVerdictLine a={a} />
      <ArmTurnsLine a={a} />
      <table data-testid="hr-arms-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
        <thead>
          <tr style={{ textAlign: 'left', opacity: 0.7 }}>
            <th style={{ padding: '3px 8px 3px 0', fontWeight: 600 }}>Arm</th>
            <th style={{ padding: '3px 8px', fontWeight: 600, textAlign: 'right' }}>Requests</th>
            <th style={{ padding: '3px 8px', fontWeight: 600, textAlign: 'right' }} title="Turns that only fetched elided text, and their share of the requests">Retrieval turns</th>
            <th style={{ padding: '3px 8px', fontWeight: 600, textAlign: 'right' }} title="Billed units per request, retrieval turns counted as requests">Units per request</th>
            <th style={{ padding: '3px 0 3px 8px', fontWeight: 600, textAlign: 'right' }} title="Billed units per request that was not a retrieval turn, the retrieval turns counted as cost">Units per working request</th>
          </tr>
        </thead>
        <tbody>
          <ArmRow id="hr-arm-late" label="Late" s={a.late} />
          <ArmRow id="hr-arm-holdout" label="Holdout" note="old behaviour" s={a.holdout} />
          {a.legacy.requests > 0 && <ArmRow id="hr-arm-legacy" label="Legacy setting" note="not compared" s={a.legacy} />}
        </tbody>
      </table>
      <div data-testid="hr-arms-note" style={{ marginTop: 8, fontSize: 12, opacity: 0.65 }}>
        A working request is one that was not a turn spent only on fetching elided text. A retrieval turn costs less than an average request,
        so cost per request would make late look dearer even while it lowers the bill; cost per working request counts those turns as cost
        without counting them as work, and is the figure the verdict uses. The margin is measured between groups of conversations, not between
        requests, because the requests of one conversation cost alike; nothing is claimed before there are at least {fmt(a.minRequests)} requests
        and {MIN_ARM_GROUPS} groups on each side. This compares cost and round trips. It cannot see the quality of an answer; under late the
        model is shown the whole of a result where the holdout is shown a window of it.
      </div>
      <div data-testid="hr-arms-holdout-note" style={{ marginTop: 4, fontSize: 12, opacity: 0.65 }}>
        The holdout is about one conversation in ten, chosen by a hash of the conversation’s first message and kept for its whole length.
        It runs the old behaviour whichever setting is on.
      </div>
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
          <Arms a={view.arms} />
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
