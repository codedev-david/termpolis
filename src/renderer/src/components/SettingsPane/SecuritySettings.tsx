import { useEffect, useState } from 'react'

interface AgentDataFact {
  agentId: string
  agentName: string
  trainingOptOut: 'default-off' | 'opt-out-required' | 'unknown'
  retentionDays: number | 'configurable' | 'unknown'
  privacyDocUrl: string
  consoleUrl: string
  notes: string
}

interface AuditEntry {
  ts: string
  agent: string
  event: string
  terminalId?: string
  byteCount?: number
  hitCount?: number
  notes?: string
}

interface ScanResult {
  hitCount: number
  hits: { rule: string; label: string; sample: string }[]
  redacted: string
}

interface GeminiAccountStatus {
  mode: 'paid-vertex' | 'paid-code-assist' | 'paid-api-key' | 'free-oauth' | 'unknown'
  safeForTraining: boolean
  evidence: string[]
  recommendation: string
}

interface AiSecurityAPI {
  getStatus: () => Promise<{ success: boolean; data?: { settings: { redactionEnabled: boolean; auditEnabled: boolean; strictGeminiPaidOnly?: boolean }; facts: AgentDataFact[]; auditPath: string; geminiAccount?: GeminiAccountStatus } }>
  setRedaction: (value: boolean) => Promise<{ success: boolean; data?: { redactionEnabled: boolean; auditEnabled: boolean } }>
  setAudit: (value: boolean) => Promise<{ success: boolean; data?: { redactionEnabled: boolean; auditEnabled: boolean } }>
  setStrictGemini?: (value: boolean) => Promise<{ success: boolean; data?: { strictGeminiPaidOnly: boolean } }>
  scan: (text: string) => Promise<{ success: boolean; data?: ScanResult }>
  recentAudit: (limit?: number) => Promise<{ success: boolean; data?: AuditEntry[] }>
  clearAudit: () => Promise<{ success: boolean }>
}

declare global {
  interface Window {
    aiSecurity?: AiSecurityAPI
  }
}

function badgeFor(fact: AgentDataFact): { color: string; label: string } {
  if (fact.trainingOptOut === 'default-off') return { color: 'bg-[#0d3a1a] text-[#7ee2a3] border-[#1f6e3a]', label: 'No training (default)' }
  if (fact.trainingOptOut === 'opt-out-required') return { color: 'bg-[#3a2a0d] text-[#FFB74D] border-[#6e4d1f]', label: 'Opt-out required' }
  return { color: 'bg-[#2d2d2d] text-[#9ca3af] border-[#3c3c3c]', label: 'Unknown' }
}

function retentionLabel(r: AgentDataFact['retentionDays']): string {
  if (r === 'configurable') return 'Configurable'
  if (r === 'unknown') return 'Unknown'
  return r + '-day retention'
}

export function SecuritySettings() {
  const api = (typeof window !== 'undefined' ? window.aiSecurity : undefined)
  const [redactionEnabled, setRedactionEnabled] = useState(false)
  const [auditEnabled, setAuditEnabled] = useState(false)
  const [strictGemini, setStrictGemini] = useState(false)
  const [facts, setFacts] = useState<AgentDataFact[]>([])
  const [auditPath, setAuditPath] = useState('')
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [scanInput, setScanInput] = useState('')
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [geminiAccount, setGeminiAccount] = useState<GeminiAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!api) { setLoading(false); return }
    api.getStatus().then(res => {
      if (res.success && res.data) {
        setRedactionEnabled(res.data.settings.redactionEnabled)
        setAuditEnabled(res.data.settings.auditEnabled)
        setStrictGemini(res.data.settings.strictGeminiPaidOnly === true)
        setFacts(res.data.facts)
        setAuditPath(res.data.auditPath)
        if (res.data.geminiAccount) setGeminiAccount(res.data.geminiAccount)
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const refreshAudit = async () => {
    if (!api) return
    const res = await api.recentAudit(50)
    if (res.success && res.data) setAuditEntries(res.data)
  }

  useEffect(() => { if (auditEnabled) refreshAudit() }, [auditEnabled])

  const toggleRedaction = async () => {
    if (!api) return
    const next = !redactionEnabled
    setRedactionEnabled(next)
    await api.setRedaction(next)
  }

  const toggleAudit = async () => {
    if (!api) return
    const next = !auditEnabled
    setAuditEnabled(next)
    await api.setAudit(next)
    if (next) await refreshAudit()
  }

  const toggleStrictGemini = async () => {
    if (!api || !api.setStrictGemini) return
    const next = !strictGemini
    setStrictGemini(next)
    await api.setStrictGemini(next)
  }

  const runScan = async () => {
    if (!api || !scanInput) return
    const res = await api.scan(scanInput)
    if (res.success && res.data) setScanResult(res.data)
  }

  const scanClipboard = async () => {
    if (!api) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        setScanInput(text)
        const res = await api.scan(text)
        if (res.success && res.data) setScanResult(res.data)
      }
    } catch {}
  }

  const wipeAudit = async () => {
    if (!api) return
    if (!confirm('Permanently delete the local audit log?')) return
    await api.clearAudit()
    await refreshAudit()
  }

  if (loading) {
    return <div className="text-xs text-[#9ca3af]">Loading security status…</div>
  }

  return (
    <div className="flex flex-col gap-6" data-testid="security-settings">
      {/* Headline pitch */}
      <div className="flex flex-col gap-2 p-4 border border-[#1f6e3a] bg-[#0d2418] rounded">
        <div className="flex items-center gap-2">
          <i className="fa-solid fa-shield-halved text-[#7ee2a3]"></i>
          <h2 className="text-sm font-semibold text-[#7ee2a3]">AI-Assisted Development with Source-Code Safety</h2>
        </div>
        <ul className="text-xs text-[#cfead8] leading-relaxed list-disc pl-5">
          <li><strong>Native terminal — no browser/IDE extensions.</strong> Termpolis itself ships nothing to any backend — there is no Termpolis cloud and no Termpolis telemetry by default. (AI agents you launch obviously still communicate with their own providers under those providers' privacy terms — see the per-agent training-disposition facts above.)</li>
          <li><strong>You control which agents see your code.</strong> Each agent below is launched as its own terminal. If you don't run it, it never reads anything.</li>
          <li><strong>Auditable outbound traffic.</strong> Enable the audit log to record every AI-agent terminal session locally — agent, timestamp, byte count.</li>
          <li><strong>Verifiable training-disposition facts.</strong> Per-provider, sourced from the live ToS pages.</li>
        </ul>
      </div>

      {/* Strict Gemini paid-tier-only enforcement */}
      <div className="flex items-start gap-3 p-3 border border-[#5a3a3a] bg-[#2a1212] rounded">
        <button
          onClick={toggleStrictGemini}
          aria-label="Toggle Strict Mode for Gemini paid-tier only"
          data-testid="security-strict-gemini-toggle"
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${strictGemini ? 'bg-[#dc2626]' : 'bg-[#555]'}`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${strictGemini ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
        </button>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-[#FFB4B4] flex items-center gap-2">
            <i className="fa-solid fa-lock"></i>
            Strict Mode — block Gemini CLI on free OAuth tier
          </span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            When ON, Termpolis intercepts any <code>gemini</code> command typed in any terminal and refuses to forward it unless one of the paid-tier env vars is detected
            (<code>GEMINI_API_KEY</code>, <code>GOOGLE_GENAI_USE_GCA=true</code>, or <code>GOOGLE_APPLICATION_CREDENTIALS</code> + <code>GOOGLE_CLOUD_PROJECT</code>).
            The blocked launch is recorded in the audit log. <strong>Caveat:</strong> a Google Workspace account with a Code Assist license can be safe even without env vars; in that case set <code>GOOGLE_GENAI_USE_GCA=true</code> to whitelist it. The lock detects env-var evidence only.
          </span>
        </div>
      </div>

      {/* Gemini account-mode detection */}
      {geminiAccount && (
        <div
          data-testid="gemini-account-status"
          className={`flex flex-col gap-2 p-3 border rounded ${
            geminiAccount.safeForTraining
              ? 'border-[#1f6e3a] bg-[#0d2418]'
              : 'border-[#6e4d1f] bg-[#3a2a0d]'
          }`}
        >
          <div className="flex items-center gap-2">
            <i
              className={`fa-solid ${
                geminiAccount.safeForTraining ? 'fa-circle-check text-[#7ee2a3]' : 'fa-triangle-exclamation text-[#FFB74D]'
              }`}
            ></i>
            <h3 className="text-sm font-semibold">
              Gemini account mode:{' '}
              <span className={geminiAccount.safeForTraining ? 'text-[#7ee2a3]' : 'text-[#FFB74D]'}>
                {geminiAccount.mode === 'paid-vertex' && 'Vertex AI (paid)'}
                {geminiAccount.mode === 'paid-code-assist' && 'Code Assist (paid)'}
                {geminiAccount.mode === 'paid-api-key' && 'Paid AI Studio API key'}
                {geminiAccount.mode === 'free-oauth' && 'Free personal OAuth — UNSAFE for proprietary code'}
                {geminiAccount.mode === 'unknown' && 'Unknown'}
              </span>
            </h3>
          </div>
          <p className="text-xs text-[#cfead8] leading-relaxed">{geminiAccount.recommendation}</p>
          {geminiAccount.evidence.length > 0 && (
            <ul className="text-[11px] text-[#9ca3af] list-disc pl-5">
              {geminiAccount.evidence.map((e, i) => (
                <li key={i}>
                  <code>{e}</code>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-[#9ca3af] leading-relaxed border-t border-[#3c3c3c] pt-2">
            <strong>How to switch to a safe mode:</strong> set one of these environment variables before launching Termpolis (or your shell):
            <code className="ml-1 text-[#22D3EE]">GEMINI_API_KEY=&lt;paid-key&gt;</code>,{' '}
            <code className="text-[#22D3EE]">GOOGLE_GENAI_USE_GCA=true</code>, or{' '}
            <code className="text-[#22D3EE]">GOOGLE_APPLICATION_CREDENTIALS=&lt;path&gt;</code> + <code className="text-[#22D3EE]">GOOGLE_CLOUD_PROJECT=&lt;id&gt;</code>.
            Termpolis cannot block the Gemini CLI from launching, but every launch is recorded in the audit log when enabled.
          </p>
        </div>
      )}

      {/* Per-agent facts */}
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <i className="fa-solid fa-list-check text-[#22D3EE]"></i>
          Per-Agent Data Handling — Real Facts
        </h3>
        <p className="text-xs text-[#9ca3af] leading-relaxed">
          What each AI provider does with the prompts your agents send. Pulled from the linked ToS / privacy doc — open the link to verify.
        </p>
        <div className="flex flex-col gap-2" data-testid="security-agent-facts">
          {facts.map(f => {
            const b = badgeFor(f)
            return (
              <div key={f.agentId} className="border border-[#3c3c3c] bg-[#252526] rounded p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{f.agentName}</span>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded border ${b.color}`}>{b.label}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded border border-[#3c3c3c] text-[#9ca3af]">{retentionLabel(f.retentionDays)}</span>
                  </div>
                </div>
                <p className="text-xs text-[#bbb] leading-relaxed">{f.notes}</p>
                <div className="flex items-center gap-3 text-[11px]">
                  <a
                    href={f.privacyDocUrl}
                    onClick={e => { e.preventDefault(); window.open(f.privacyDocUrl, '_blank') }}
                    className="text-[#22D3EE] hover:underline"
                  >Privacy / ToS source</a>
                  <span className="text-[#555]">·</span>
                  <a
                    href={f.consoleUrl}
                    onClick={e => { e.preventDefault(); window.open(f.consoleUrl, '_blank') }}
                    className="text-[#22D3EE] hover:underline"
                  >Provider data console</a>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Redaction toggle */}
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <button
          onClick={toggleRedaction}
          aria-label="Toggle outbound prompt redaction"
          data-testid="security-redaction-toggle"
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${redactionEnabled ? 'bg-[#0078d4]' : 'bg-[#555]'}`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${redactionEnabled ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
        </button>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Outbound prompt redaction (preview)</span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            Scans copied / pasted text for AWS keys, GitHub PATs, OpenAI / Anthropic / Google keys, JWTs, and .env-style assignments. Use the scanner below before pasting into an AI agent.
          </span>
        </div>
      </div>

      {/* Audit log toggle */}
      <div className="flex flex-col gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <div className="flex items-start gap-3">
          <button
            onClick={toggleAudit}
            aria-label="Toggle cloud-bound audit log"
            data-testid="security-audit-toggle"
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${auditEnabled ? 'bg-[#0078d4]' : 'bg-[#555]'}`}
          >
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${auditEnabled ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
          </button>
          <div className="flex flex-col gap-0.5 flex-1">
            <span className="text-sm font-medium">Cloud-bound audit log</span>
            <span className="text-xs text-[#9ca3af] leading-relaxed">
              Append-only JSONL recording every AI-agent terminal session: timestamp, agent, byte count, redaction hit count. Stays on this machine.
            </span>
            {auditPath && (
              <code className="text-[10px] text-[#777] mt-1 break-all">{auditPath}</code>
            )}
          </div>
        </div>
        {auditEnabled && (
          <div className="flex flex-col gap-2 mt-2 border-t border-[#3c3c3c] pt-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#d4d4d4]">Recent entries</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={refreshAudit}
                  className="text-[10px] px-2 py-0.5 rounded bg-[#2d2d2d] hover:bg-[#3c3c3c] border border-[#3c3c3c]"
                >Refresh</button>
                <button
                  onClick={wipeAudit}
                  className="text-[10px] px-2 py-0.5 rounded bg-[#3a1f1f] hover:bg-[#5a2d2d] border border-[#5a3a3a] text-[#FFB4B4]"
                >Clear log</button>
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto border border-[#3c3c3c] rounded">
              {auditEntries.length === 0 ? (
                <div className="text-[11px] text-[#777] p-2">No entries yet. Launch an AI agent to start recording.</div>
              ) : (
                <table className="w-full text-[10px] font-mono">
                  <tbody>
                    {auditEntries.map((e, i) => (
                      <tr key={i} className="border-b border-[#2d2d2d] last:border-b-0">
                        <td className="px-2 py-1 text-[#777] whitespace-nowrap">{new Date(e.ts).toLocaleString()}</td>
                        <td className="px-2 py-1 text-[#22D3EE]">{e.agent}</td>
                        <td className="px-2 py-1 text-[#d4d4d4]">{e.event}</td>
                        <td className="px-2 py-1 text-[#9ca3af]">{e.byteCount != null ? e.byteCount + ' B' : ''}{e.hitCount != null ? ' / ' + e.hitCount + ' hits' : ''}{e.notes ? ' ' + e.notes : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Scanner */}
      <div className="flex flex-col gap-2 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <i className="fa-solid fa-magnifying-glass-arrow-right text-[#FFB74D]"></i>
          Manual pre-paste secret scan
        </h3>
        <p className="text-xs text-[#9ca3af] leading-relaxed">
          AI terminals are auto-scanned on every Enter and every paste. Use this box for one-off checks of clipboard text before pasting elsewhere — Termpolis will flag well-shaped secrets and show a redacted preview.
        </p>
        <textarea
          value={scanInput}
          onChange={e => setScanInput(e.target.value)}
          rows={4}
          placeholder="Paste the prompt or output you're considering sending to an AI agent…"
          className="bg-[#1e1e1e] border border-[#3c3c3c] rounded p-2 text-xs text-[#d4d4d4] font-mono focus:outline-none focus:border-[#0078d4]"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={runScan}
            data-testid="security-scan-btn"
            className="text-xs px-3 py-1 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
          >Scan</button>
          <button
            onClick={scanClipboard}
            className="text-xs px-3 py-1 rounded bg-[#2d2d2d] hover:bg-[#3c3c3c] border border-[#3c3c3c]"
          >Scan clipboard</button>
          {scanResult && (
            <span className={`text-xs ${scanResult.hitCount > 0 ? 'text-[#FFB4B4]' : 'text-[#7ee2a3]'}`}>
              {scanResult.hitCount > 0
                ? `${scanResult.hitCount} secret${scanResult.hitCount === 1 ? '' : 's'} detected`
                : 'No secrets detected'}
            </span>
          )}
        </div>
        {scanResult && scanResult.hitCount > 0 && (
          <div className="flex flex-col gap-2 mt-1">
            <ul className="text-xs text-[#FFB4B4] list-disc pl-5">
              {scanResult.hits.map((h, i) => (
                <li key={i}><strong>{h.label}</strong>: <code className="text-[#d4d4d4]">{h.sample}</code></li>
              ))}
            </ul>
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#9ca3af]">Redacted preview:</span>
              <button
                onClick={() => navigator.clipboard.writeText(scanResult.redacted)}
                className="text-[10px] px-2 py-0.5 rounded bg-[#2d2d2d] hover:bg-[#3c3c3c] border border-[#3c3c3c]"
              >Copy redacted</button>
            </div>
            <pre className="bg-[#1e1e1e] border border-[#3c3c3c] rounded p-2 text-[10px] text-[#d4d4d4] font-mono whitespace-pre-wrap max-h-32 overflow-y-auto">{scanResult.redacted}</pre>
          </div>
        )}
      </div>

      {/* Termpolis self-disclosures */}
      <div className="flex flex-col gap-2 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <i className="fa-solid fa-circle-check text-[#7ee2a3]"></i>
          What Termpolis itself does (and doesn't)
        </h3>
        <ul className="text-xs text-[#cfead8] list-disc pl-5 leading-relaxed">
          <li><strong>Zero accounts.</strong> No login. No telemetry by default.</li>
          <li><strong>Zero cloud storage.</strong> Sessions, history, pins, audit log — all local.</li>
          <li><strong>MCP server: 127.0.0.1 only.</strong> Bound to loopback; rejects remote connections.</li>
          <li><strong>Apache 2.0, auditable.</strong> Source on GitHub: codedev-david/termpolis.</li>
          <li><strong>No browser or IDE extension.</strong> No third-party plugin store as a leak vector.</li>
        </ul>
      </div>

      {/* Legal disclaimer */}
      <div
        data-testid="security-legal-disclaimer"
        className="flex flex-col gap-2 p-3 border border-[#5a3a3a] bg-[#1f1212] rounded text-[11px] text-[#cba] leading-relaxed"
      >
        <h3 className="text-xs font-semibold text-[#FFB4B4] flex items-center gap-2">
          <i className="fa-solid fa-scale-balanced"></i>
          Legal disclaimer — read before deploying in a regulated environment
        </h3>
        <p>
          Termpolis is provided <strong>"AS IS" without warranty of any kind</strong>, express or implied (see the Apache 2.0 LICENSE shipped with this build).
          The training-disposition facts shown above are summaries of public provider terms as of the build date; they may change without notice.
          Termpolis does not control, audit, or guarantee the data-handling practices of any third-party AI provider (Anthropic, OpenAI, Google, Alibaba/DashScope, Ollama, or any future provider).
        </p>
        <p>
          The redaction scanner uses regular expressions tuned for low false-positive rates on well-shaped secrets. <strong>It is not a comprehensive DLP solution.</strong>
          Custom or unusual secret formats (for example, internal corporate tokens) will not be detected. The audit log records what Termpolis observes locally; it does not capture content that bypasses Termpolis (for example, an agent run from a separate native terminal window).
        </p>
        <p>
          <strong>To the maximum extent permitted by law, the authors and contributors of Termpolis disclaim all liability</strong> for any data leak, breach, regulatory violation, contractual breach, or business loss arising from your use of any AI agent launched through this application — including but not limited to use of free-tier accounts that send prompts to provider training pipelines, use of corporate code under personal AI accounts, or misconfiguration of provider-side data controls.
          You are solely responsible for: (a) selecting an appropriate provider tier for your data classification, (b) configuring provider-side opt-outs and retention controls, (c) verifying compliance with your organisation's policies, and (d) reviewing the live ToS pages linked above before transmitting confidential data.
        </p>
        <p className="text-[#9ca3af]">
          Build: Termpolis is licensed under the Apache License 2.0. Source: <code>github.com/codedev-david/termpolis</code>. By using this software you accept the terms of that license.
        </p>
      </div>
    </div>
  )
}
