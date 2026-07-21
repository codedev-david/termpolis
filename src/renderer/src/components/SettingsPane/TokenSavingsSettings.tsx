import { useEffect, useState } from 'react'
import type { ProxyTotalsView } from '../../types'

type Mode = 'conservative' | 'balanced' | 'aggressive'
interface Settings { enabled: boolean; mode: Mode; steering: boolean }
interface Totals { netSaved: number; events: number; byTool: Record<string, number> }
interface Receipt { session: Totals; cumulative: Totals }
interface ProxyReceipt { session: ProxyTotalsView; cumulative: ProxyTotalsView }

const fmt = (n: number): string => n.toLocaleString('en-US')

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
  const original = ingestedPost + (t.textSavedTokens || 0)
  return original > 0 ? Math.round((t.textSavedTokens / original) * 100) : 0
}

export function TokenSavingsSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [proxy, setProxy] = useState<ProxyReceipt | null>(null)

  const refresh = async (): Promise<void> => {
    const s = await window.termpolis.tokenSavingsGetSettings()
    if (s.success) setSettings(s.data)
    const r = await window.termpolis.tokenSavingsGetReceipt()
    if (r.success) setReceipt(r.data)
    const p = await window.termpolis.tokenSavingsGetProxyReceipt()
    if (p.success) setProxy(p.data)
  }
  useEffect(() => { void refresh() }, [])

  const update = async (p: Partial<Settings>): Promise<void> => {
    const res = await window.termpolis.tokenSavingsSetSettings(p)
    if (res.success) setSettings(res.data)
  }

  const cacheHealthy = (proxy?.cumulative.cacheReadTokens ?? 0) >= (proxy?.cumulative.cacheCreationTokens ?? 0)

  return (
    <div className="settings-section">
      <h3>Token Savings <span style={{ fontWeight: 400, opacity: 0.7 }}>(Headroom)</span></h3>

      <div className="hr-proxy-receipt" style={{ border: '1px solid #8884', borderRadius: 8, padding: 14, marginBottom: 18 }}>
        <h4 style={{ margin: '0 0 6px' }}>Claude Code compression <span style={{ fontWeight: 400, opacity: 0.65 }}>— always on</span></h4>
        <p style={{ opacity: 0.8, marginTop: 0 }}>
          Every Claude Code session runs through a local, off-thread compression proxy that shrinks the tool-result
          text (large Read/Bash output, search dumps, MCP results) and pasted images it sends to Anthropic — trimming
          the input-token volume of those blocks while keeping the prompt cache intact. Fully reversible via
          <code>retrieve_full</code>; your memory/brain is never touched.
        </p>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: 30, fontWeight: 700 }} data-testid="hr-proxy-session-pct">{proxy?.session.savedPct ?? 0}%</div>
            <div style={{ opacity: 0.7 }}>of tool output · this session</div>
            <div style={{ opacity: 0.7, fontSize: 13 }}><span data-testid="hr-proxy-session-saved">{fmt(proxy?.session.textSavedTokens ?? 0)}</span> tokens removed · {fmt(proxy?.session.requests ?? 0)} requests</div>
          </div>
          <div>
            <div style={{ fontSize: 30, fontWeight: 700 }} data-testid="hr-proxy-cumulative-pct">{proxy?.cumulative.savedPct ?? 0}%</div>
            <div style={{ opacity: 0.7 }}>of tool output · all-time</div>
            <div style={{ opacity: 0.7, fontSize: 13 }}><span data-testid="hr-proxy-cumulative-saved">{fmt(proxy?.cumulative.textSavedTokens ?? 0)}</span> tokens removed</div>
          </div>
          {(proxy?.cumulative.images ?? 0) > 0 && (
            <div>
              <div style={{ fontSize: 30, fontWeight: 700 }}>{fmt(proxy?.cumulative.images ?? 0)}</div>
              <div style={{ opacity: 0.7 }}>images compressed</div>
            </div>
          )}
        </div>
        {(() => {
          const s = shareOfTotalInput(proxy?.session)
          const c = shareOfTotalInput(proxy?.cumulative)
          if (s == null && c == null) return null
          return (
            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }} data-testid="hr-proxy-share-total">
              That’s ≈{s ?? 0}% of all input tokens you sent this session{c != null ? ` · ≈${c}% all-time` : ''}. The rest — system prompt, tools, conversation history and cached context — is left untouched, and repeated context is already billed at ~10% through the prompt cache.
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
            </select>
          </label>
          <label style={{ display: 'block', margin: '8px 0' }}>
            <input data-testid="hr-toggle-steering" type="checkbox" checked={settings.steering} onChange={() => update({ steering: !settings.steering })} />
            {' '}Output-token steering (terser agent replies) <span style={{ opacity: 0.6 }}>— estimated</span>
          </label>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 8 }}>
            Tool-output savings — session <span data-testid="hr-session-saved">{fmt(receipt?.session.netSaved ?? 0)}</span> · all-time <span data-testid="hr-cumulative-saved">{fmt(receipt?.cumulative.netSaved ?? 0)}</span> tokens
          </div>
        </>
      )}
    </div>
  )
}
