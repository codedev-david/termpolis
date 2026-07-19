import { useEffect, useState } from 'react'

type Mode = 'conservative' | 'balanced' | 'aggressive'
interface Settings { enabled: boolean; mode: Mode; steering: boolean }
interface Totals { netSaved: number; events: number; byTool: Record<string, number> }
interface Receipt { session: Totals; cumulative: Totals }

const fmt = (n: number): string => n.toLocaleString('en-US')

export function TokenSavingsSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)

  const refresh = async (): Promise<void> => {
    const s = await window.termpolis.tokenSavingsGetSettings()
    if (s.success) setSettings(s.data)
    const r = await window.termpolis.tokenSavingsGetReceipt()
    if (r.success) setReceipt(r.data)
  }
  useEffect(() => { void refresh() }, [])

  const update = async (p: Partial<Settings>): Promise<void> => {
    const res = await window.termpolis.tokenSavingsSetSettings(p)
    if (res.success) setSettings(res.data)
  }

  if (!settings) return <div>Loading…</div>

  return (
    <div className="settings-section">
      <h3>Token Savings <span style={{ fontWeight: 400, opacity: 0.7 }}>(Headroom)</span></h3>
      <p style={{ opacity: 0.8 }}>
        Compresses Termpolis&apos;s own tool outputs (code search, file trees, command output) before the
        agent reads them. Fully reversible — the agent calls <code>retrieve_full</code> if it needs the
        complete result. Your memory/brain is never touched.
      </p>

      <label style={{ display: 'block', margin: '8px 0' }}>
        <input data-testid="hr-toggle-enabled" type="checkbox" checked={settings.enabled} onChange={() => update({ enabled: !settings.enabled })} />
        {' '}Compress tool outputs
      </label>

      <label style={{ display: 'block', margin: '8px 0' }}>
        Aggressiveness:{' '}
        <select data-testid="hr-mode" value={settings.mode} onChange={e => update({ mode: e.target.value as Mode })} disabled={!settings.enabled}>
          <option value="conservative">Conservative</option>
          <option value="balanced">Balanced</option>
          <option value="aggressive">Aggressive</option>
        </select>
      </label>

      <label style={{ display: 'block', margin: '8px 0' }}>
        <input data-testid="hr-toggle-steering" type="checkbox" checked={settings.steering} onChange={() => update({ steering: !settings.steering })} />
        {' '}Output-token steering (terser agent replies) <span style={{ opacity: 0.6 }}>— estimated</span>
      </label>

      <div className="hr-receipt" style={{ marginTop: 16 }}>
        <h4>Measured savings <span style={{ fontWeight: 400, opacity: 0.7 }}>(tokens removed, net of expansions)</span></h4>
        <div><strong>This session:</strong> <span data-testid="hr-session-saved">{fmt(receipt?.session.netSaved ?? 0)}</span> tokens across {receipt?.session.events ?? 0} tool results</div>
        <div><strong>All time:</strong> <span data-testid="hr-cumulative-saved">{fmt(receipt?.cumulative.netSaved ?? 0)}</span> tokens</div>
        {receipt && Object.keys(receipt.session.byTool).length > 0 && (
          <ul>
            {Object.entries(receipt.session.byTool).sort((a, b) => b[1] - a[1]).map(([tool, n]) => (
              <li key={tool}>{tool}: {fmt(n)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
