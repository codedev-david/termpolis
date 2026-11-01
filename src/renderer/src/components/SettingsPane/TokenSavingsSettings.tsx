import { useEffect, useState, type ReactNode } from 'react'
import type { ProxyTotalsView, UnifiedTotalsView, HeadroomSettingsView, DepthAdviceView, ProxyStatusView } from '../../types'
import { ElisionHealthCard } from './ElisionHealthCard'

/** Mirrors CCR_MAX_BYTES in src/main/headroom/ccrStore.ts — the pane names the real limit. */
const CCR_CAP_MB = 200

type Mode = 'conservative' | 'balanced' | 'aggressive' | 'max'
type Settings = HeadroomSettingsView
interface Totals { netSaved: number; events: number; byTool: Record<string, number> }
interface Receipt { session: Totals; cumulative: Totals }
interface ProxyReceipt { session: ProxyTotalsView; cumulative: ProxyTotalsView }
interface UnifiedReceipt { session: UnifiedTotalsView; cumulative: UnifiedTotalsView; depth?: DepthAdviceView | null }

const fmt = (n: number): string => n.toLocaleString('en-US')

// Thinking-budget ceilings offered in the UI. 0 = off (the default). Anthropic's own floor is
// 1024, so nothing lower is worth listing — the wire clamp raises anything under it anyway.
const THINKING_CAPS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Off — use the full budget Claude asks for' },
  { value: 16000, label: '16,000 tokens' },
  { value: 8000, label: '8,000 tokens' },
  { value: 4000, label: '4,000 tokens' },
  { value: 2000, label: '2,000 tokens' },
]

// The windows offered for the opt-in context cap (R3), each with the research's modeled saving: a share of
// the bill, replayed from one person's October history with a compaction at that window and 15,000 to
// 80,000 tokens lost to each one. 500,000 lies between the two nearest modeled windows (400,000 and
// 600,000), so its figure is estimated. Off first, then the largest window down.
//
// Mirrors CONTEXT_CAP_CHOICES in src/main/headroom/shapingEnv.ts. The renderer cannot import from main, so
// the pane lists them itself; tests/renderer/contextCapSettings.test.tsx keeps the two lists one list.
const CONTEXT_CAPS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Off — Claude Code decides (default)' },
  { value: 500000, label: '500,000 tokens — modeled saving about 5 to 7%' },
  { value: 400000, label: '400,000 tokens — modeled saving about 10 to 13%' },
  { value: 300000, label: '300,000 tokens — modeled saving about 16 to 21%' },
  { value: 200000, label: '200,000 tokens — modeled saving about 20 to 29%' },
]

/** The choices, with a window set outside Settings (a hand-edited file) shown as itself and in its place,
 *  never as one of the windows it is not. */
function contextCapChoices(current: number): Array<{ value: number; label: string }> {
  if (CONTEXT_CAPS.some((c) => c.value === current)) return CONTEXT_CAPS
  const extra = { value: current, label: `${fmt(current)} tokens — set outside Settings` }
  const at = CONTEXT_CAPS.findIndex((c) => c.value > 0 && c.value < current)
  return at === -1 ? [...CONTEXT_CAPS, extra] : [...CONTEXT_CAPS.slice(0, at), extra, ...CONTEXT_CAPS.slice(at)]
}

// Honest "share of your TOTAL input" — textSavedTokens over the full ingested
// prompt volume (uncached + cache-read + cache-create), pre-compression. This is
// far smaller than savedPct (which is only the shrink of the tool-output slice),
// because the system prompt, tools schema, conversation history and cached
// context dominate a request. Returns null when no usage was captured yet, so we
// never render a bogus 100%.
const shareOfTotalInput = (t?: ProxyTotalsView): number | null => {
  if (!t) return null
  const ingestedPost = (t.inputTokens || 0) + (t.cacheReadTokens || 0) + (t.cacheCreationTokens || 0)
  if (ingestedPost <= 0) return null
  const saved = (t.textSavedTokens || 0) + (t.toolUseSavedTokens || 0)
  const original = ingestedPost + saved
  return original > 0 ? Math.round((saved / original) * 100) : 0
}

/**
 * The third — and only spendable — denominator: saved tokens as a share of what the whole
 * conversation WOULD have cost, at Anthropic's published multipliers (cache read 0.1×,
 * cache write 1.25×, fresh input 1×, output 5×).
 *
 * This is always the smallest of the three, and deliberately so. Headroom removes tokens from
 * the input side, and the overwhelming majority of input arrives as cache reads billed at a
 * tenth of rate — so a token removed is worth far less than a token generated. Compressing a
 * cheap slice hard is still the right move (it is the slice we can reach), but quoting the
 * 50%-of-tool-output figure as though it were a 50% bill reduction would be false, and this
 * number exists so the receipt can't be read that way.
 *
 * Removed tokens are valued at the OBSERVED blended prefix rate rather than any single weight,
 * because we cannot know which side of the cache each one would have landed on.
 *
 * The arithmetic itself now lives in the main process, next to the counters that feed it
 * (src/main/headroom/effectiveUnits.ts). It used to be re-derived here, and the two copies had
 * already drifted: the renderer blended removed tokens across all three input buckets, the spec
 * across the two prefix buckets. Neither test could see the other, so neither failed.
 */
const effectiveCostShare = (t?: UnifiedTotalsView): number | null =>
  t?.bill && t.bill.total > 0 ? Math.round(t.bill.totalBillSavedPct) : null

// Output's share of what a request actually costs, at Anthropic's published multipliers
// (cache read 0.1x input, cache write 1.25x, output 5x). Surfaced because it is the one slice
// inbound compression cannot touch — and on real lifetime numbers it is the largest one left.
const outputCostShare = (t?: UnifiedTotalsView): number | null =>
  t?.bill && t.bill.total > 0 ? Math.round(t.bill.outputPct) : null

const MODE_LABEL: Record<Mode, string> = { conservative: 'Conservative', balanced: 'Balanced', aggressive: 'Aggressive', max: 'Maximum' }

/** Mirrors LATE_FLOOR_CHARS in src/main/headroom/elisionPolicy.ts — the pane names the real size. */
const LATE_FLOOR = '40,000'
type FirstSight = HeadroomSettingsView['firstSightElision']
const FIRST_SIGHT_LABEL: Record<FirstSight, string> = { late: 'Late', legacy: 'Legacy' }

/**
 * Which first-sight policy is running, and which will after the next start. The proxy freezes its
 * policy at launch (changing it under a live session would rewrite every cached prefix), so a change
 * made here is not what runs until Termpolis restarts, and the pane says so rather than implying it.
 */
function FirstSightStatus({ selected, status }: { selected: FirstSight; status: ProxyStatusView | null }) {
  const running = status?.effectiveFirstSight
  if (!status || !running) return null
  const pending = running !== selected
  // The policy is frozen into the proxy at launch, but while the proxy is off, stepping aside for the
  // user's own route or down, there is nothing for it to act on, and "Running" would not be true.
  const live = status.enabled && !status.bypassVar && status.running && status.healthy
  return (
    <div data-testid="hr-first-sight-status" data-pending={pending ? 'true' : 'false'} data-live={live ? 'true' : 'false'} style={{ fontSize: 13, opacity: 0.85, margin: '4px 0 4px' }}>
      {live ? <>Running: <b>{FIRST_SIGHT_LABEL[running]}</b>.</> : <>Not in effect right now: the proxy is off, stepping aside or not running.</>}
      {pending && <> {FIRST_SIGHT_LABEL[selected]} applies the next time Termpolis starts.</>}
    </div>
  )
}

/** One line on what the proxy is actually doing — the switch alone can't say it stepped aside. */
function ProxyStatusLine({ status }: { status: ProxyStatusView | null }) {
  if (!status) return null
  let text: ReactNode
  if (!status.enabled) text = 'Off — new Claude Code sessions go straight to Anthropic.'
  else if (status.bypassVar) {
    text = <>Stepping aside — <code>{status.bypassVar}</code> is set (in Termpolis&rsquo;s environment or Claude Code&rsquo;s settings.json), so Claude Code keeps the route you configured and nothing is compressed.</>
  } else if (!status.running || !status.healthy) text = 'Not running right now — Claude Code sessions launch direct until it recovers.'
  else {
    const raised = status.effectiveMode !== status.selectedMode
    // Which results the tier applies to depends on the first-sight policy the proxy froze at launch.
    const policy = status.effectiveFirstSight === 'late'
      ? <> Tool results are left whole until {LATE_FLOOR} characters (Late).</>
      : status.effectiveFirstSight === 'legacy'
        ? <> Tool results are shortened from the size of the tier (Legacy).</>
        : null
    text = <>Running at the <b>{MODE_LABEL[status.effectiveMode] ?? status.effectiveMode}</b> tier{raised ? <> (raised from {MODE_LABEL[status.selectedMode] ?? status.selectedMode} by the savings floor)</> : null}.{policy}</>
  }
  return <div data-testid="hr-proxy-status" style={{ fontSize: 13, opacity: 0.8, margin: '0 0 8px' }}>{text}</div>
}

export function TokenSavingsSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [proxy, setProxy] = useState<ProxyReceipt | null>(null)
  const [unified, setUnified] = useState<UnifiedReceipt | null>(null)
  const [status, setStatus] = useState<ProxyStatusView | null>(null)

  const refresh = async (): Promise<void> => {
    const s = await window.termpolis.tokenSavingsGetSettings()
    if (s.success) setSettings(s.data)
    const r = await window.termpolis.tokenSavingsGetReceipt()
    if (r.success) setReceipt(r.data)
    const p = await window.termpolis.tokenSavingsGetProxyReceipt()
    if (p.success) setProxy(p.data)
    const u = await window.termpolis.tokenSavingsGetUnifiedReceipt()
    if (u.success) setUnified(u.data)
    const st = await window.termpolis.tokenSavingsGetProxyStatus?.()
    if (st?.success) setStatus(st.data)
  }
  useEffect(() => { void refresh() }, [])

  const update = async (p: Partial<Settings>): Promise<void> => {
    const res = await window.termpolis.tokenSavingsSetSettings(p)
    if (res.success) setSettings(res.data)
    const st = await window.termpolis.tokenSavingsGetProxyStatus?.()
    if (st?.success) setStatus(st.data)
  }

  const cacheHealthy = (proxy?.cumulative.cacheReadTokens ?? 0) >= (proxy?.cumulative.cacheCreationTokens ?? 0)
  const outShare = outputCostShare(unified?.cumulative)
  // The headline: billed units avoided, NET of the turns that only fetched elided text.
  const bill = unified?.cumulative.bill
  const turnUnits = unified?.cumulative.retrievalTurnUnits ?? 0
  const turns = unified?.cumulative.retrievalTurns ?? 0
  // 0 = Off. A main process that predates the setting sends none, which is Off as well.
  const contextCap = typeof settings?.contextCap === 'number' && Number.isFinite(settings.contextCap) && settings.contextCap > 0 ? settings.contextCap : 0

  return (
    <div className="settings-section">
      <h3>Token Savings <span style={{ fontWeight: 400, opacity: 0.7 }}>(Headroom)</span></h3>

      {/* ONE number, both layers. Before v1.34.0 the wire proxy and the MCP tool compressor each
          kept a separate ledger, every retrieve_full was charged to the tool ledger regardless of
          which layer issued the token, and the receipt could read deeply negative while the proxy
          beside it had genuinely saved hundreds of millions. This block is the merged total. */}
      <div className="hr-unified-receipt" style={{ border: '1px solid #8884', borderRadius: 8, padding: 14, marginBottom: 18 }}>
        <h4 style={{ margin: '0 0 6px' }}>Billed units avoided <span style={{ fontWeight: 400, opacity: 0.65 }}>— everything Headroom does, counted once, net of the turns that fetched elided text</span></h4>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: 34, fontWeight: 700 }} data-testid="hr-bill-avoided">{fmt(Math.round(bill?.avoided ?? 0))}</div>
            <div style={{ opacity: 0.7 }}>billed units avoided · all-time</div>
            <div style={{ opacity: 0.7, fontSize: 13 }} data-testid="hr-bill-parts">
              <span data-testid="hr-bill-gross">{fmt(Math.round(bill?.grossAvoided ?? 0))}</span> kept off the bill
              {' '}− <span data-testid="hr-bill-turn-units">{fmt(Math.round(turnUnits))}</span> spent on{' '}
              <span data-testid="hr-bill-turns">{fmt(turns)}</span> {turns === 1 ? 'turn' : 'turns'} that only fetched elided text
            </div>
          </div>
          <div>
            <div style={{ fontSize: 34, fontWeight: 700 }} data-testid="hr-bill-pct">{bill?.totalBillSavedPct ?? 0}%</div>
            <div style={{ opacity: 0.7 }}>of what the conversation would have cost</div>
            <div style={{ opacity: 0.7, fontSize: 13 }} data-testid="hr-unified-session">
              this session: {fmt(Math.round(unified?.session.bill?.avoided ?? 0))} units
            </div>
          </div>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }} data-testid="hr-bill-note">
          One unit is what a fresh input token costs at Anthropic&rsquo;s rates: cache reads count 0.1, cache writes 1.25, output 5.
          A turn that only fetches elided text re-reads the whole cached prefix, so it is charged here, not just the text it brings back.
        </div>
        {(bill?.avoided ?? 0) < 0 && (
          <div style={{ marginTop: 8, fontSize: 13, color: '#f87171' }} data-testid="hr-bill-negative">
            Negative: the turns that fetched elided text cost more than eliding them saved. It is shown as it is, not rounded up to zero;
            the Elision health card below shows which kinds of result are being asked back.
          </div>
        )}
        <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }} data-testid="hr-unified-tokens">
          In tokens: <b data-testid="hr-unified-net">{fmt(unified?.cumulative.netSavedTokens ?? 0)}</b> net ={' '}
          <span data-testid="hr-unified-gross">{fmt(unified?.cumulative.grossSavedTokens ?? 0)}</span> removed from the wire
          {' '}− <span data-testid="hr-unified-giveback">{fmt(unified?.cumulative.givebackTokens ?? 0)}</span> given back by{' '}
          {fmt(unified?.cumulative.retrieves ?? 0)} <code>retrieve_full</code> calls, <b data-testid="hr-unified-pct">{unified?.cumulative.savedPct ?? 0}%</b> of the text Headroom is allowed to touch.
        </div>

        {/* THREE denominators, not one.
            The same saving is a different percentage depending on what you divide by, and each
            of the three is the honest answer to a different question. Publishing only the first
            — the flattering one — is how a compression feature ends up quoted as a bill cut it
            never delivered, so all three are stated here, largest to smallest, side by side. */}
        <div style={{ marginTop: 12, fontSize: 13, opacity: 0.85 }} data-testid="hr-denominators">
          <div style={{ fontWeight: 600, opacity: 0.8, marginBottom: 4 }}>The same saving, measured three ways:</div>
          <div><b data-testid="hr-denom-wire">{unified?.cumulative.savedPct ?? 0}%</b> of the text Headroom is allowed to touch (tool results + the agent&rsquo;s own tool inputs) — how well compression works.</div>
          <div><b data-testid="hr-denom-input">{shareOfTotalInput(proxy?.cumulative) ?? 0}%</b> of every input token you sent — the rest is system prompt, tool schemas and conversation history.</div>
          <div><b data-testid="hr-denom-cost">{effectiveCostShare(unified?.cumulative) ?? 0}%</b> of what the conversation actually cost, at Anthropic&rsquo;s rates — the smallest figure, and the only spendable one.</div>
        </div>

        {/* Floor evidence. A lifetime average of 50% is compatible with half of all requests
            sitting under it; only the worst single request can settle whether a floor holds.
            Counted over the requests that ran the old behaviour only: the Late policy removes less
            tool text on purpose and is not held to a floor, so its requests are not in these numbers. */}
        {(unified?.cumulative.floorEligibleRequests ?? 0) > 0 && (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }} data-testid="hr-floor-evidence">
            Floor check, Legacy and holdout requests only (Late is not held to a floor): worst single request kept <b data-testid="hr-floor-worst">{unified?.cumulative.worstSavedPct ?? 0}%</b>
            {' '}· <span data-testid="hr-floor-below">{fmt(unified?.cumulative.belowFloorRequests ?? 0)}</span> of{' '}
            {fmt(unified?.cumulative.floorEligibleRequests ?? 0)} substantial requests came in under 50%.
          </div>
        )}

        {/* What Headroom does NOT reach, stated on the same receipt as what it does. The system
            prompt and tool schemas sit in front of every request, are re-sent every turn, and are
            what a cache WRITE is billed 1.25x for. Only the Termpolis slice is ours to shrink. */}
        {(unified?.cumulative.toolsTokensPerRequest ?? 0) > 0 && (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }} data-testid="hr-prefix-head">
            Untouched prefix: about {fmt(unified?.cumulative.sysTokensPerRequest ?? 0)} tokens of system prompt and{' '}
            {fmt(unified?.cumulative.toolsTokensPerRequest ?? 0)} tokens of tool schemas ride in front of every request
            ({fmt(unified?.cumulative.toolCount ?? 0)} tools, <span data-testid="hr-prefix-tp">{fmt(unified?.cumulative.tpToolsTokensPerRequest ?? 0)}</span> tokens of them Termpolis&rsquo;s own).
            Compression never touches this; it is what cache writes are billed for.
          </div>
        )}

        {unified?.depth && (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }} data-testid="hr-session-depth">
            Session depth: this conversation is {fmt(unified.depth.messages)} messages deep and costs about{' '}
            <b data-testid="hr-depth-now">{fmt(unified.depth.unitsPerTurnNow)}</b> effective units per turn.
            Your own shallow sessions average <b data-testid="hr-depth-fresh">{fmt(unified.depth.unitsPerTurnFresh)}</b>,
            so starting fresh here would save roughly {fmt(unified.depth.savingPerTurn)} per turn
            (<span data-testid="hr-depth-pct">{unified.depth.savingPct}</span>%).
            That figure already includes the cost of writing a new prefix. It assumes the work
            splits — the memory brain is what makes it split — and it is a correlation across your
            own sessions, not a controlled comparison.
          </div>
        )}

        {/* Steering, measured. Two means side by side — observational, so it is never called a saving. */}
        {(unified?.cumulative.steeredRequests ?? 0) > 0 && (unified?.cumulative.unsteeredRequests ?? 0) > 0 && (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }} data-testid="hr-steering-observed">
            Output steering: steered requests averaged <b data-testid="hr-steer-on">{fmt(unified?.cumulative.steeredAvgOutput ?? 0)}</b> output tokens
            across {fmt(unified?.cumulative.steeredRequests ?? 0)}; unsteered averaged{' '}
            <b data-testid="hr-steer-off">{fmt(unified?.cumulative.unsteeredAvgOutput ?? 0)}</b> across {fmt(unified?.cumulative.unsteeredRequests ?? 0)}.
            Observed, not a controlled comparison — different sessions ask different questions.
          </div>
        )}

        {/* The falsifier. Every elision promises the original can be brought back; a miss is that
            promise broken. It is never rolled into a percentage — one is worth seeing.
            It fires only on evidence the store itself recorded: content it held and then dropped.
            Shape is not evidence — tokens are content hashes, so a one-character typo of a live
            token is indistinguishable from a real one, and reading shape as proof is what put
            "should never happen" in front of four calls that had destroyed nothing. */}
        {(unified?.cumulative.retrieveMisses ?? 0) > 0 && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#f87171' }} data-testid="hr-retrieve-misses">
            <b>{fmt(unified?.cumulative.retrieveMisses ?? 0)}</b> retrieve_full {(unified?.cumulative.retrieveMisses ?? 0) === 1 ? 'call' : 'calls'} asked for content this
            app had cached and then dropped, all time ({fmt(unified?.session.retrieveMisses ?? 0)} this session). Compressed content really was lost.
            Report this; it should never happen.
          </div>
        )}

        {/* The same broken promise, caught one step earlier: the store destroyed a record with no
            durable copy behind it, whether or not anyone has asked for it back yet. Reported from
            the session column on purpose — it counts since launch, and labelling a since-launch
            number "all time" is the exact lie the two retrieve columns above exist to undo. */}
        {(unified?.session.unbackedEvictions ?? 0) > 0 && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#f87171' }} data-testid="hr-unbacked-evictions">
            <b>{fmt(unified?.session.unbackedEvictions ?? 0)}</b> cached {(unified?.session.unbackedEvictions ?? 0) === 1 ? 'original was' : 'originals were'} dropped this
            session with no copy on disk behind them — those elisions can no longer be reversed. Report this; it should never happen.
          </div>
        )}

        {/* Content that really is gone, reported WITHOUT "report this". The 200 MB cap is supposed
            to age old originals out; saying "it should never happen" about the cache doing its job
            is the same false alarm as the shape test, just with a different trigger. */}
        {(unified?.cumulative.retrieveExpired ?? 0) > 0 && (
          <div style={{ marginTop: 10, fontSize: 13, opacity: 0.7 }} data-testid="hr-retrieve-expired">
            {fmt(unified?.cumulative.retrieveExpired ?? 0)} <code>retrieve_full</code>{' '}
            {(unified?.cumulative.retrieveExpired ?? 0) === 1 ? 'call asked' : 'calls asked'} for content the cache had already aged out
            to stay under its {CCR_CAP_MB} MB limit. Gone, but working as designed — nothing to report.
          </div>
        )}

        {((unified?.cumulative.retrieveUnknownTokens ?? 0) + (unified?.cumulative.retrieveBadTokens ?? 0)) > 0 && (
          <div style={{ marginTop: 10, fontSize: 13, opacity: 0.7 }} data-testid="hr-retrieve-bad-tokens">
            {fmt((unified?.cumulative.retrieveUnknownTokens ?? 0) + (unified?.cumulative.retrieveBadTokens ?? 0))} <code>retrieve_full</code>{' '}
            {((unified?.cumulative.retrieveUnknownTokens ?? 0) + (unified?.cumulative.retrieveBadTokens ?? 0)) === 1 ? 'call used a handle' : 'calls used a handle'} this app has no
            record of issuing — a mistyped or invented token, not lost content. Nothing to report.
          </div>
        )}

        {outShare != null && (
          <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }} data-testid="hr-output-share">
            What Headroom can’t reach: about {outShare}% of your effective spend is OUTPUT tokens (billed 5× input).
            Inbound compression never touches those — the thinking-budget cap and steering below are the controls that do.
          </div>
        )}
      </div>

      <ElisionHealthCard />

      <div className="hr-proxy-receipt" style={{ border: '1px solid #8884', borderRadius: 8, padding: 14, marginBottom: 18 }}>
        <h4 style={{ margin: '0 0 6px' }}>Claude Code compression proxy</h4>
        <label style={{ display: 'block', margin: '8px 0' }}>
          <input
            data-testid="hr-toggle-proxy"
            type="checkbox"
            aria-label="Route Claude Code through the compression proxy"
            checked={settings?.wireProxy !== false}
            disabled={!settings}
            onChange={() => { void update({ wireProxy: settings?.wireProxy === false }) }}
          />
          {' '}Route new Claude Code sessions through the local compression proxy{' '}
          <span style={{ opacity: 0.6 }}>— off means Claude talks to Anthropic directly; a session that is already running keeps its route until it ends</span>
        </label>
        <ProxyStatusLine status={status} />
        <p style={{ opacity: 0.8, marginTop: 0 }}>
          When on, each Claude Code session Termpolis launches sends its API requests to a small proxy on 127.0.0.1, which
          shortens the largest tool results (from {LATE_FLOOR} characters under Late, the default; from the size of the tier under
          Legacy: large Read/Bash output, search dumps, MCP results) and pasted images, then forwards the
          request to api.anthropic.com and nowhere else. Repeat results collapse to a reference and near-identical ones (a
          re-read edited file) are sent as a patch, so the model sees a shorter version; <code>retrieve_full</code> brings
          any compressed block back in full. Whatever the agent writes to disk or runs — file bodies, commands, both sides of
          every edit — is always forwarded byte-for-byte, and your memory/brain is never touched. The prompt cache stays
          intact, except for the one deliberate rebuild that aging out old history (below) pays. If Termpolis sees your own
          <code>ANTHROPIC_BASE_URL</code>, an HTTP(S) proxy or a Bedrock/Vertex/Foundry switch in its environment, it steps
          aside and leaves your route alone.
        </p>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: 30, fontWeight: 700 }} data-testid="hr-proxy-session-pct">{proxy?.session.savedPct ?? 0}%</div>
            <div style={{ opacity: 0.7 }}>of compressible wire text · this session</div>
            <div style={{ opacity: 0.7, fontSize: 13 }}><span data-testid="hr-proxy-session-saved">{fmt(proxy?.session.textSavedTokens ?? 0)}</span> tokens removed · {fmt(proxy?.session.requests ?? 0)} requests</div>
          </div>
          <div>
            <div style={{ fontSize: 30, fontWeight: 700 }} data-testid="hr-proxy-cumulative-pct">{proxy?.cumulative.savedPct ?? 0}%</div>
            <div style={{ opacity: 0.7 }}>of compressible wire text · all-time</div>
            <div style={{ opacity: 0.7, fontSize: 13 }}><span data-testid="hr-proxy-cumulative-saved">{fmt(proxy?.cumulative.textSavedTokens ?? 0)}</span> tokens removed</div>
          </div>
          {(proxy?.cumulative.images ?? 0) > 0 && (
            <div>
              <div style={{ fontSize: 30, fontWeight: 700 }}>{fmt(proxy?.cumulative.images ?? 0)}</div>
              <div style={{ opacity: 0.7 }}>images compressed</div>
              <div style={{ opacity: 0.7, fontSize: 13 }} data-testid="hr-image-bytes">{fmt(Math.round((proxy?.cumulative.imageSavedBytes ?? 0) / 1024))} KB of upload saved</div>
            </div>
          )}
        </div>

        {/* The two wire surfaces, kept apart. tool_result is content arriving once. tool_use — the
            agent's own tool calls — has not been rewritten since v1.49: an Agent prompt or a Bash
            command has to reach the model exactly as it was written. So its row only reports what
            earlier versions removed, and stays hidden for anyone who never ran one. */}
        {((proxy?.cumulative.textOrigTokens ?? 0) + (proxy?.cumulative.toolUseOrigTokens ?? 0)) > 0 && (
          <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }} data-testid="hr-surface-split">
            <div>
              Tool results (what came back): <b data-testid="hr-surface-tr">{fmt(proxy?.cumulative.textSavedTokens ?? 0)}</b> of{' '}
              {fmt(proxy?.cumulative.textOrigTokens ?? 0)} tokens removed
            </div>
            {(proxy?.cumulative.toolUseOrigTokens ?? 0) > 0 && (
            <div>
              Tool inputs, before v1.49 (no longer compressed): <b data-testid="hr-surface-tu">{fmt(proxy?.cumulative.toolUseSavedTokens ?? 0)}</b> of{' '}
              {fmt(proxy?.cumulative.toolUseOrigTokens ?? 0)} tokens removed
            </div>
            )}
          </div>
        )}

        {(() => {
          const s = shareOfTotalInput(proxy?.session)
          const c = shareOfTotalInput(proxy?.cumulative)
          if (s == null && c == null) return null
          return (
            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }} data-testid="hr-proxy-share-total">
              That’s ≈{s ?? 0}% of all input tokens you sent this session{c != null ? ` · ≈${c}% all-time` : ''}. Compression reaches tool output and tool inputs — about 86% of message bytes, measured on real transcripts. What it never touches: the system prompt, the tool schemas, your own words, and the model’s own replies. Repeated context is billed at ~10% through the prompt cache, so a token removed here is removed from every later re-read of it too.
            </div>
          )
        })()}
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.6 }} data-testid="hr-proxy-cache-health">
          Prompt-cache health: {fmt(proxy?.cumulative.cacheReadTokens ?? 0)} cached-read vs {fmt(proxy?.cumulative.cacheCreationTokens ?? 0)} cache-create tokens{cacheHealthy ? ' — healthy ✓' : ''}
        </div>
      </div>

      {settings && (
        <>
          <h4 style={{ margin: '0 0 6px' }}>Termpolis tool-output compression</h4>
          <label style={{ display: 'block', margin: '8px 0' }}>
            <input data-testid="hr-toggle-enabled" type="checkbox" checked={settings.enabled} onChange={() => update({ enabled: !settings.enabled })} />
            {' '}Compress Termpolis MCP tool outputs (code_search, file trees, …)
          </label>
          <label style={{ display: 'block', margin: '8px 0' }}>
            Aggressiveness:{' '}
            {/* Explicit dark bg + light text: an unstyled native select inherited the theme's light-grey
                text but kept the OS-default light control/option background → unreadable. Matches the
                Default Shell / Voice selects so the closed control AND the open option list stay legible. */}
            <select
              data-testid="hr-mode"
              value={settings.mode}
              onChange={(e) => update({ mode: e.target.value as Mode })}
              disabled={!settings.enabled}
              className="bg-[#2d2d2d] text-[#d4d4d4] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-hidden disabled:opacity-50"
            >
              <option value="conservative" className="bg-[#2d2d2d] text-[#d4d4d4]">Conservative</option>
              <option value="balanced" className="bg-[#2d2d2d] text-[#d4d4d4]">Balanced</option>
              <option value="aggressive" className="bg-[#2d2d2d] text-[#d4d4d4]">Aggressive</option>
              <option value="max" className="bg-[#2d2d2d] text-[#d4d4d4]">Maximum</option>
            </select>
          </label>
          <div data-testid="hr-first-sight" style={{ margin: '12px 0' }}>
            <label style={{ display: 'block', margin: '8px 0 4px' }}>
              Shorten tool results:{' '}
              <select
                data-testid="hr-first-sight-select"
                value={settings.firstSightElision ?? 'late'}
                onChange={(e) => update({ firstSightElision: e.target.value as FirstSight })}
                className="bg-[#2d2d2d] text-[#d4d4d4] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-hidden"
              >
                <option value="late" className="bg-[#2d2d2d] text-[#d4d4d4]">Late — only from {LATE_FLOOR} characters (recommended)</option>
                <option value="legacy" className="bg-[#2d2d2d] text-[#d4d4d4]">Legacy — from the size of the tier, as in v1.54</option>
              </select>
            </label>
            <FirstSightStatus selected={settings.firstSightElision ?? 'late'} status={status} />
            <div data-testid="hr-first-sight-note" style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
              Since late August the model has asked for about two thirds of the results Termpolis shortens, and each ask is a whole extra
              turn that reads the entire cached prefix again. Late leaves a result whole until it reaches {LATE_FLOOR} characters. The
              research behind this release modelled that at about 11.7% of the bill saved, from one person’s history; that is a
              modelled figure, not a promise for your work, and the Elision health card below compares Late with Legacy on yours. It
              changes only which results are shortened: repeats are still collapsed, old history still ages out in a long
              conversation, and anything shortened can still be brought back with <code>retrieve_full</code>. Termpolis cannot measure
              the effect on the quality of answers on your work; under Late the model is shown more of every result, never less.
              About one conversation in ten always runs Legacy so the two can be compared. A change takes effect the next time
              Termpolis starts, because one proxy serves every Claude session of a run and a change in the middle would rewrite each
              session’s prompt cache.
            </div>
          </div>
          <label style={{ display: 'block', margin: '8px 0' }}>
            <input data-testid="hr-toggle-floor" type="checkbox" checked={settings.floorControl} onChange={() => update({ floorControl: !settings.floorControl })} />
            {' '}Under Legacy, hold a 50% savings floor — raise the tier automatically if the ledger shows it slipping{' '}
            <span style={{ opacity: 0.6 }}>— only used when Legacy is what runs: Late removes less tool text on purpose, so it leaves the tier as selected. Only ever compresses harder than the setting above, never softer, and is decided at launch and frozen for the session (re-tiering mid-conversation would break the prompt cache)</span>
          </label>
          <label style={{ display: 'block', margin: '8px 0' }}>
            <input data-testid="hr-toggle-decay" type="checkbox" checked={settings.prefixDecay} onChange={() => update({ prefixDecay: !settings.prefixDecay })} />
            {' '}Age out old history in very long conversations <span style={{ opacity: 0.6 }}>— on by default. Everything else here is free; this one pays a one-off prompt-cache rebuild to buy a smaller prefix on every later turn. It waits for 128 messages before the first cut, about 3x the ~44-turn break-even, and aged blocks stay recoverable with <code>retrieve_full</code>.</span>
          </label>

          <h4 style={{ margin: '18px 0 6px' }}>Output tokens <span style={{ fontWeight: 400, opacity: 0.65 }}>— what Claude writes back (billed 5× input)</span></h4>
          <label style={{ display: 'block', margin: '8px 0' }}>
            <input data-testid="hr-toggle-steering" type="checkbox" checked={settings.steering} onChange={() => update({ steering: !settings.steering })} />
            {' '}Output-token steering (terser agent replies) <span style={{ opacity: 0.6 }}>— estimated</span>
          </label>
          <label style={{ display: 'block', margin: '8px 0' }}>
            <input data-testid="hr-toggle-adaptive" type="checkbox" checked={settings.adaptiveSteering} disabled={!settings.steering} onChange={() => update({ adaptiveSteering: !settings.adaptiveSteering })} />
            {' '}Adapt steering strength to measured output volume <span style={{ opacity: 0.6 }}>— decided at launch, frozen for the session (changing it mid-conversation would break the prompt cache)</span>
          </label>
          <label style={{ display: 'block', margin: '8px 0' }}>
            Extended-thinking budget cap:{' '}
            <select
              data-testid="hr-thinking-cap"
              value={String(settings.thinkingCap)}
              onChange={(e) => update({ thinkingCap: Number(e.target.value) })}
              className="bg-[#2d2d2d] text-[#d4d4d4] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-hidden"
            >
              {THINKING_CAPS.map((c) => (
                <option key={c.value} value={String(c.value)} className="bg-[#2d2d2d] text-[#d4d4d4]">{c.label}</option>
              ))}
            </select>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
              Thinking tokens are billed as output. This only ever LOWERS the budget Claude asks for, never raises it —
              and unlike everything else here it trades reasoning depth, not inline context, so it is off by default.
            </div>
          </label>
          {/* Claude Code's own compaction window, not a compression setting: it needs neither the proxy nor the
              tool-output compression above, so nothing here is disabled by them. Off until chosen, because it
              changes what the model keeps of a long conversation and Termpolis cannot see what that does to answers. */}
          <div data-testid="hr-context-cap" style={{ margin: '12px 0' }}>
            <h4 style={{ margin: '18px 0 6px' }}>Long conversations <span style={{ fontWeight: 400, opacity: 0.65 }}>— when Claude Code summarises one (opt-in)</span></h4>
            <label style={{ display: 'block', margin: '8px 0 4px' }}>
              Compact long Claude Code conversations at:{' '}
              <select
                data-testid="hr-context-cap-select"
                aria-label="Context window for Claude Code compaction"
                value={String(contextCap)}
                onChange={(e) => update({ contextCap: Number(e.target.value) })}
                className="bg-[#2d2d2d] text-[#d4d4d4] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-hidden"
              >
                {contextCapChoices(contextCap).map((c) => (
                  <option key={c.value} value={String(c.value)} className="bg-[#2d2d2d] text-[#d4d4d4]">{c.label}</option>
                ))}
              </select>
            </label>
            <div data-testid="hr-context-cap-status" style={{ fontSize: 13, opacity: 0.85, margin: '4px 0 4px' }}>
              {contextCap === 0
                ? <>Off: Claude Code decides when to compact a conversation, as it always has.</>
                : <>On at <b>{fmt(contextCap)} tokens</b>: new Claude Code terminals compact a long conversation once it nears this size. Terminals that are already open are unchanged.</>}
            </div>
            <div data-testid="hr-context-cap-note" style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
              <p style={{ margin: '0 0 6px' }}>
                Claude Code compacts a long conversation into a summary when it nears the model’s context window, and every request until then
                re-reads the whole history. A smaller window makes it compact sooner, so later requests carry less. The cost is that the model
                keeps less of a long conversation word for word and works from the summary instead. Termpolis cannot measure what that does to
                the quality of answers on your work, so this is off until you choose it.
              </p>
              <p style={{ margin: '0 0 6px' }}>
                The saving beside each window is modeled, not measured: a replay of one person’s October Claude Code history, with a compaction at
                that window and 15,000 to 80,000 tokens lost to each one, as a share of the bill. It is not a promise for your work. Anthropic does
                not say how close to the window a conversation compacts, so the real saving may differ. It is zero on a model whose own window is
                already this size or smaller, because Claude Code never uses a window larger than the model’s. The 500,000 figure is estimated
                between two modeled windows. Context meters, in Claude Code’s status line and in Termpolis, keep measuring against the model’s
                full window, so they do not show how near the smaller one is.
              </p>
              <p style={{ margin: 0 }}>
                It applies to new Claude Code terminals only; a terminal that is already open keeps what it started with. It works with or without
                the compression proxy. Termpolis sets Claude Code’s own <code>CLAUDE_CODE_AUTO_COMPACT_WINDOW</code> variable, and never overrides a
                window you set yourself: in your environment, in the env block of your Claude Code <code>settings.json</code>, or with{' '}
                <code>/autocompact</code>. It cannot see a <code>--autocompact</code> flag typed on a command line, and Claude Code lets this variable
                win over that flag, so to use the flag turn this Off first. To tell, it reads the env and window keys of your Claude Code settings
                files (your own, and the project’s in the folder a terminal opens in) when a terminal opens, and nothing else in them.
              </p>
            </div>
          </div>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 8 }}>
            Tool-output savings — session <span data-testid="hr-session-saved">{fmt(receipt?.session.netSaved ?? 0)}</span> · all-time <span data-testid="hr-cumulative-saved">{fmt(receipt?.cumulative.netSaved ?? 0)}</span> tokens
          </div>
        </>
      )}
    </div>
  )
}
