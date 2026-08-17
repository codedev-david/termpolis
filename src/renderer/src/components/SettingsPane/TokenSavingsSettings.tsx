import { useEffect, useState } from 'react'
import type { ProxyTotalsView, UnifiedTotalsView, HeadroomSettingsView, DepthAdviceView } from '../../types'

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

export function TokenSavingsSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [proxy, setProxy] = useState<ProxyReceipt | null>(null)
  const [unified, setUnified] = useState<UnifiedReceipt | null>(null)

  const refresh = async (): Promise<void> => {
    const s = await window.termpolis.tokenSavingsGetSettings()
    if (s.success) setSettings(s.data)
    const r = await window.termpolis.tokenSavingsGetReceipt()
    if (r.success) setReceipt(r.data)
    const p = await window.termpolis.tokenSavingsGetProxyReceipt()
    if (p.success) setProxy(p.data)
    const u = await window.termpolis.tokenSavingsGetUnifiedReceipt()
    if (u.success) setUnified(u.data)
  }
  useEffect(() => { void refresh() }, [])

  const update = async (p: Partial<Settings>): Promise<void> => {
    const res = await window.termpolis.tokenSavingsSetSettings(p)
    if (res.success) setSettings(res.data)
  }

  const cacheHealthy = (proxy?.cumulative.cacheReadTokens ?? 0) >= (proxy?.cumulative.cacheCreationTokens ?? 0)
  const outShare = outputCostShare(unified?.cumulative)

  return (
    <div className="settings-section">
      <h3>Token Savings <span style={{ fontWeight: 400, opacity: 0.7 }}>(Headroom)</span></h3>

      {/* ONE number, both layers. Before v1.34.0 the wire proxy and the MCP tool compressor each
          kept a separate ledger, every retrieve_full was charged to the tool ledger regardless of
          which layer issued the token, and the receipt could read deeply negative while the proxy
          beside it had genuinely saved hundreds of millions. This block is the merged total. */}
      <div className="hr-unified-receipt" style={{ border: '1px solid #8884', borderRadius: 8, padding: 14, marginBottom: 18 }}>
        <h4 style={{ margin: '0 0 6px' }}>Net tokens saved <span style={{ fontWeight: 400, opacity: 0.65 }}>— everything Headroom does, counted once</span></h4>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: 34, fontWeight: 700 }} data-testid="hr-unified-net">{fmt(unified?.cumulative.netSavedTokens ?? 0)}</div>
            <div style={{ opacity: 0.7 }}>tokens saved · all-time</div>
            <div style={{ opacity: 0.7, fontSize: 13 }}>
              <span data-testid="hr-unified-gross">{fmt(unified?.cumulative.grossSavedTokens ?? 0)}</span> removed
              {' '}− <span data-testid="hr-unified-giveback">{fmt(unified?.cumulative.givebackTokens ?? 0)}</span> given back by{' '}
              {fmt(unified?.cumulative.retrieves ?? 0)} <code>retrieve_full</code> calls
            </div>
          </div>
          <div>
            <div style={{ fontSize: 34, fontWeight: 700 }} data-testid="hr-unified-pct">{unified?.cumulative.savedPct ?? 0}%</div>
            <div style={{ opacity: 0.7 }}>of compressible volume</div>
            <div style={{ opacity: 0.7, fontSize: 13 }} data-testid="hr-unified-session">
              this session: {fmt(unified?.session.netSavedTokens ?? 0)} tokens
            </div>
          </div>
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
            sitting under it; only the worst single request can settle whether a floor holds. */}
        {(unified?.cumulative.floorEligibleRequests ?? 0) > 0 && (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }} data-testid="hr-floor-evidence">
            Floor check: worst single request kept <b data-testid="hr-floor-worst">{unified?.cumulative.worstSavedPct ?? 0}%</b>
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
            promise broken. It is never rolled into a percentage — one is worth seeing. */}
        {(unified?.cumulative.retrieveMisses ?? 0) > 0 && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#f87171' }} data-testid="hr-retrieve-misses">
            <b>{fmt(unified?.cumulative.retrieveMisses ?? 0)}</b> retrieve_full {(unified?.cumulative.retrieveMisses ?? 0) === 1 ? 'call' : 'calls'} found nothing —
            compressed content could not be restored. Report this; it should never happen.
          </div>
        )}

        {outShare != null && (
          <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }} data-testid="hr-output-share">
            What Headroom can’t reach: about {outShare}% of your effective spend is OUTPUT tokens (billed 5× input).
            Inbound compression never touches those — the thinking-budget cap and steering below are the controls that do.
          </div>
        )}
      </div>

      <div className="hr-proxy-receipt" style={{ border: '1px solid #8884', borderRadius: 8, padding: 14, marginBottom: 18 }}>
        <h4 style={{ margin: '0 0 6px' }}>Claude Code compression <span style={{ fontWeight: 400, opacity: 0.65 }}>— always on</span></h4>
        <p style={{ opacity: 0.8, marginTop: 0 }}>
          Every Claude Code session runs through a local, off-thread compression proxy that shrinks the tool-result
          text (large Read/Bash output, search dumps, MCP results), the agent&rsquo;s own tool <i>inputs</i> (file bodies it
          wrote, both sides of every edit) and pasted images it sends to Anthropic — trimming the input-token volume of
          those blocks while keeping the prompt cache intact. Repeat results collapse to a
          reference, near-identical ones (re-read an edited file) are sent as a patch. Fully reversible via
          <code>retrieve_full</code>; your memory/brain is never touched.
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

        {/* The two wire surfaces, kept apart. They behave nothing alike: tool_result is content
            arriving once, while tool_use is the agent's OWN output sitting in the cached prefix
            and re-read on every subsequent turn — so a token removed there is a token not paid
            for again and again. Blending them into one figure would hide which half is working. */}
        {((proxy?.cumulative.textOrigTokens ?? 0) + (proxy?.cumulative.toolUseOrigTokens ?? 0)) > 0 && (
          <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }} data-testid="hr-surface-split">
            <div>
              Tool results (what came back): <b data-testid="hr-surface-tr">{fmt(proxy?.cumulative.textSavedTokens ?? 0)}</b> of{' '}
              {fmt(proxy?.cumulative.textOrigTokens ?? 0)} tokens removed
            </div>
            <div>
              Tool inputs (what the agent wrote, re-read every turn): <b data-testid="hr-surface-tu">{fmt(proxy?.cumulative.toolUseSavedTokens ?? 0)}</b> of{' '}
              {fmt(proxy?.cumulative.toolUseOrigTokens ?? 0)} tokens removed
            </div>
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
              className="bg-[#2d2d2d] text-[#d4d4d4] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none disabled:opacity-50"
            >
              <option value="conservative" className="bg-[#2d2d2d] text-[#d4d4d4]">Conservative</option>
              <option value="balanced" className="bg-[#2d2d2d] text-[#d4d4d4]">Balanced</option>
              <option value="aggressive" className="bg-[#2d2d2d] text-[#d4d4d4]">Aggressive</option>
              <option value="max" className="bg-[#2d2d2d] text-[#d4d4d4]">Maximum</option>
            </select>
          </label>
          <label style={{ display: 'block', margin: '8px 0' }}>
            <input data-testid="hr-toggle-floor" type="checkbox" checked={settings.floorControl} onChange={() => update({ floorControl: !settings.floorControl })} />
            {' '}Hold a 50% savings floor — raise the tier automatically if the ledger shows it slipping{' '}
            <span style={{ opacity: 0.6 }}>— only ever compresses harder than the setting above, never softer, and is decided at launch and frozen for the session (re-tiering mid-conversation would break the prompt cache)</span>
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
              className="bg-[#2d2d2d] text-[#d4d4d4] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none"
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
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 8 }}>
            Tool-output savings — session <span data-testid="hr-session-saved">{fmt(receipt?.session.netSaved ?? 0)}</span> · all-time <span data-testid="hr-cumulative-saved">{fmt(receipt?.cumulative.netSaved ?? 0)}</span> tokens
          </div>
        </>
      )}
    </div>
  )
}
