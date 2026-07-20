import { useEffect, useState } from 'react'
import type { ProxyTotalsView } from '../../types'

type Mode = 'conservative' | 'balanced' | 'aggressive'
interface Settings { enabled: boolean; mode: Mode; steering: boolean }
interface Totals { netSaved: number; events: number; byTool: Record<string, number> }
interface Receipt { session: Totals; cumulative: Totals }
interface ProxyReceipt { session: ProxyTotalsView; cumulative: ProxyTotalsView }

const fmt = (n: number): string => n.toLocaleString('en-US')

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
          Every Claude Code session runs through a local, off-thread compression proxy that shrinks the Read/Bash tool
          output and pasted images it sends to Anthropic — lowering your token burn rate while keeping the prompt cache
          intact. Fully reversible via <code>retrieve_full</code>; your memory/brain is never touched.
        </p>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: 30, fontWeight: 700 }} data-testid="hr-proxy-session-pct">{proxy?.session.savedPct ?? 0}%</div>
            <div style={{ opacity: 0.7 }}>saved this session</div>
            <div style={{ opacity: 0.7, fontSize: 13 }}><span data-testid="hr-proxy-session-saved">{fmt(proxy?.session.textSavedTokens ?? 0)}</span> tokens · {fmt(proxy?.session.requests ?? 0)} requests</div>
          </div>
          <div>
            <div style={{ fontSize: 30, fontWeight: 700 }} data-testid="hr-proxy-cumulative-pct">{proxy?.cumulative.savedPct ?? 0}%</div>
            <div style={{ opacity: 0.7 }}>saved all-time</div>
            <div style={{ opacity: 0.7, fontSize: 13 }}><span data-testid="hr-proxy-cumulative-saved">{fmt(proxy?.cumulative.textSavedTokens ?? 0)}</span> tokens</div>
          </div>
          {(proxy?.cumulative.images ?? 0) > 0 && (
            <div>
              <div style={{ fontSize: 30, fontWeight: 700 }}>{fmt(proxy?.cumulative.images ?? 0)}</div>
              <div style={{ opacity: 0.7 }}>images compressed</div>
            </div>
          )}
        </div>
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
            <select data-testid="hr-mode" value={settings.mode} onChange={(e) => update({ mode: e.target.value as Mode })} disabled={!settings.enabled}>
              <option value="conservative">Conservative</option>
              <option value="balanced">Balanced</option>
              <option value="aggressive">Aggressive</option>
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
