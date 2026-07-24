import { useCallback, useEffect, useMemo, useState } from 'react'
import { copyText, readClipboardText } from '../../lib/clipboard'
import { summarizeAudit, type AuditEntry } from '../../lib/auditSummary'
import { AuditLogModal } from './AuditLogModal'

interface AgentDataFact {
  agentId: string
  agentName: string
  trainingOptOut: 'default-off' | 'opt-out-required' | 'unknown'
  retentionDays: number | 'configurable' | 'unknown'
  privacyDocUrl: string
  consoleUrl: string
  notes: string
}

interface ScanResult {
  hitCount: number
  /** `name` is the identifier that matched (`DB_PASSWORD`, `apiKey`) — what you actually rotate.
   *  It is absent for rules that have no name to give (an AWS key IS its own identifier). */
  hits: { rule: string; label: string; sample: string; name?: string }[]
  redacted: string
}

interface GeminiAccountStatus {
  mode: 'paid-vertex' | 'paid-code-assist' | 'paid-api-key' | 'free-oauth' | 'unknown'
  safeForTraining: boolean
  evidence: string[]
  recommendation: string
}

/** A repo the Commit Shield git hooks have been installed into. `foreign` = a hook exists
 *  there that isn't ours (someone's husky/lint-staged) — we chain to it rather than clobber it. */
interface ShieldRepo {
  repo: string
  status: Record<string, 'installed' | 'absent' | 'foreign'> | null
}

// NOTE: there is no `setRedaction` here any more, and no `redactionEnabled` in the settings.
// Outbound redaction was deleted: it withheld keystrokes to rewrite them (and then never wrote
// them back — typing "hello<CR>" delivered only "\r"), and against a TUI agent it could never have
// worked, because the text is already in the agent's own line buffer by the time you press Enter.
// What replaced it is WATCH, which is not a setting: it is always on and forwards every byte
// untouched. Nothing in this bridge can turn it off, which is exactly the point.
interface AiSecurityAPI {
  getStatus: () => Promise<{ success: boolean; data?: { settings: { auditEnabled: boolean; strictGeminiPaidOnly?: boolean; commitShield?: boolean; egressGuard?: boolean; memoryScrub?: boolean }; facts: AgentDataFact[]; auditPath: string; geminiAccount?: GeminiAccountStatus; ruleCount?: number } }>
  setAudit: (value: boolean) => Promise<{ success: boolean; data?: { auditEnabled: boolean } }>
  setStrictGemini?: (value: boolean) => Promise<{ success: boolean; data?: { strictGeminiPaidOnly: boolean } }>
  setCommitShield?: (value: boolean) => Promise<{ success: boolean }>
  gitHooksList?: () => Promise<{ success: boolean; data?: ShieldRepo[] }>
  gitHooksInstall?: (cwd?: string) => Promise<{ success: boolean; error?: string; data?: { canceled?: boolean; repo?: string } }>
  gitHooksUninstall?: (cwd: string) => Promise<{ success: boolean }>
  setEgressGuard?: (value: boolean) => Promise<{ success: boolean }>
  setMemoryScrub?: (value: boolean) => Promise<{ success: boolean }>
  scan: (text: string) => Promise<{ success: boolean; data?: ScanResult }>
  recentAudit: (limit?: number) => Promise<{ success: boolean; data?: AuditEntry[] }>
  clearAudit: () => Promise<{ success: boolean }>
  /** True when the user has an un-submitted draft in this terminal's input line. Anything that
   *  writes to a terminal unprompted must check this first — a write appends at the cursor, and
   *  the line buffer belongs to the agent's TUI, so an unprompted write lands on their draft. */
  inputPending?: (id: string) => Promise<{ success: boolean; data?: boolean }>
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

/** How many rows the inline "Recent entries" table renders. We FETCH far more than this (see
 *  refreshAudit) so the secrets-sent count is stable, but rendering 500 rows into a settings pane
 *  nobody scrolls is just wasted paint — the audit modal is the full view. */
const RECENT_ROWS = 50

export function SecuritySettings() {
  const api = (typeof window !== 'undefined' ? window.aiSecurity : undefined)
  const [auditEnabled, setAuditEnabled] = useState(false)
  const [strictGemini, setStrictGemini] = useState(false)
  // Default-ON gates (see aiSecurity.ts): an absent key means "never configured",
  // so the secure default holds and existing installs get the protection on upgrade.
  const [commitShield, setCommitShield] = useState(true)
  const [egressGuard, setEgressGuard] = useState(true)
  const [memoryScrub, setMemoryScrub] = useState(true)
  const [showAudit, setShowAudit] = useState(false)
  const [shieldRepos, setShieldRepos] = useState<ShieldRepo[]>([])
  const [hookBusy, setHookBusy] = useState(false)
  const [hookMsg, setHookMsg] = useState('')
  const [facts, setFacts] = useState<AgentDataFact[]>([])
  const [auditPath, setAuditPath] = useState('')
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [scanInput, setScanInput] = useState('')
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [geminiAccount, setGeminiAccount] = useState<GeminiAccountStatus | null>(null)
  // Live from the rule table in main — never a literal. See aiSecurity:get-status.
  const [ruleCount, setRuleCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!api) { setLoading(false); return }
    api.getStatus().then(res => {
      if (res.success && res.data) {
        setAuditEnabled(res.data.settings.auditEnabled)
        setStrictGemini(res.data.settings.strictGeminiPaidOnly === true)
        setCommitShield(res.data.settings.commitShield !== false)
        setEgressGuard(res.data.settings.egressGuard !== false)
        setMemoryScrub(res.data.settings.memoryScrub !== false)
        setFacts(res.data.facts)
        setAuditPath(res.data.auditPath)
        if (res.data.geminiAccount) setGeminiAccount(res.data.geminiAccount)
        if (typeof res.data.ruleCount === 'number') setRuleCount(res.data.ruleCount)
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  // 500, not 50: the "Secrets sent to a model" number below is read as a fact about this machine,
  // so it must not silently fall to zero the moment 50 routine terminal_open rows push a real hit
  // out of the window. The table still renders only the newest 50 — see RECENT_ROWS.
  const refreshAudit = async () => {
    if (!api) return
    const res = await api.recentAudit(500)
    if (res.success && res.data) setAuditEntries(res.data)
  }

  useEffect(() => { if (auditEnabled) refreshAudit() }, [auditEnabled])

  // The same summariser the audit modal uses, so the panel and the modal can never disagree about
  // whether a secret went out. With the log off there is nothing to summarise — and `audit-off`
  // is precisely the verdict that refuses to call that state "clean".
  const promptWatch = useMemo(
    () => summarizeAudit(auditEntries, { auditEnabled, commitShield, egressGuard, memoryScrub }),
    [auditEntries, auditEnabled, commitShield, egressGuard, memoryScrub],
  )

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

  const refreshHooks = useCallback(async () => {
    if (!api?.gitHooksList) return
    const res = await api.gitHooksList()
    if (res.success && res.data) setShieldRepos(res.data)
  }, [api])

  useEffect(() => { void refreshHooks() }, [refreshHooks])

  const protectRepo = async () => {
    if (!api?.gitHooksInstall) return
    setHookBusy(true)
    setHookMsg('')
    try {
      const res = await api.gitHooksInstall()
      if (!res.success) { setHookMsg(res.error || 'Could not install the hooks'); return }
      if (res.data?.canceled) return
      setHookMsg(`Protected ${res.data?.repo || 'repository'} — git commit and git push are now scanned, from any terminal.`)
      await refreshHooks()
    } finally {
      setHookBusy(false)
    }
  }

  const unprotectRepo = async (repo: string) => {
    if (!api?.gitHooksUninstall) return
    await api.gitHooksUninstall(repo)
    setHookMsg('')
    await refreshHooks()
  }

  const toggleCommitShield = async () => {
    if (!api?.setCommitShield) return
    const next = !commitShield
    setCommitShield(next)
    await api.setCommitShield(next)
  }

  const toggleEgressGuard = async () => {
    if (!api?.setEgressGuard) return
    const next = !egressGuard
    setEgressGuard(next)
    await api.setEgressGuard(next)
  }

  const toggleMemoryScrub = async () => {
    if (!api?.setMemoryScrub) return
    const next = !memoryScrub
    setMemoryScrub(next)
    await api.setMemoryScrub(next)
  }

  const runScan = async () => {
    if (!api || !scanInput) return
    const res = await api.scan(scanInput)
    if (res.success && res.data) setScanResult(res.data)
  }

  const scanClipboard = async () => {
    if (!api) return
    try {
      const text = await readClipboardText()
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

      {/* Prompt watching — NOT a toggle. There is deliberately no switch here: the old "outbound
          redaction" toggle promised to strip secrets out of a prompt before it reached the agent,
          which is a promise no terminal can keep (by the time you press Enter, a TUI agent already
          holds your line). It is replaced by a watcher that touches nothing and tells the truth. */}
      <div
        data-testid="security-prompt-watch"
        className="flex flex-col gap-2 p-3 border border-[#1f6e3a] bg-[#0d2418] rounded"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-[#7ee2a3] flex items-center gap-2">
            <i className="fa-solid fa-eye"></i>
            Prompt watching &mdash; always on
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded border bg-[#0d3a1a] text-[#7ee2a3] border-[#1f6e3a] whitespace-nowrap">
            Cannot be turned off
          </span>
        </div>
        <span className="text-xs text-[#cfead8] leading-relaxed">
          Every prompt you submit to an AI agent &mdash; and every paste &mdash; is scanned for well-shaped secrets against the
          same {ruleCount ?? 97}-rule engine used at the git boundary. <strong>Your text is never modified, delayed, or withheld:</strong> every
          byte reaches the agent exactly as you typed it, and the scan runs on a copy. This is a <strong>recorder, not a filter</strong>.
          A hit means the value has already gone to the provider, so Termpolis tells you <em>which identifier</em> leaked
          instead of pretending it can un-send it &mdash; rotate what it names.
        </span>

        <div className="flex items-center gap-2 pt-2 border-t border-[#1f6e3a]">
          <span className="text-xs font-medium text-[#d4d4d4]">Secrets sent to a model</span>
          <span
            data-testid="security-secrets-sent-count"
            className={`text-[10px] px-2 py-0.5 rounded border font-mono ${
              !auditEnabled
                ? 'bg-[#2d2d2d] text-[#9ca3af] border-[#3c3c3c]'
                : promptWatch.secretsToModels > 0
                  ? 'bg-[#3a0d0d] text-[#FFB4B4] border-[#6e1f1f]'
                  : 'bg-[#0d3a1a] text-[#7ee2a3] border-[#1f6e3a]'
            }`}
          >
            {auditEnabled
              ? `${promptWatch.secretsToModels} sent`
              : 'audit log off — not recorded'}
          </span>
        </div>

        {auditEnabled && promptWatch.secretNames.length > 0 && (
          <div className="flex flex-col gap-1.5" data-testid="security-secret-names">
            <span className="text-[11px] font-medium text-[#FFB4B4]">
              Rotate these &mdash; they were sent to a model:
            </span>
            <div className="flex flex-wrap gap-1.5">
              {promptWatch.secretNames.map(name => (
                <code
                  key={name}
                  className="text-[10px] font-mono px-2 py-0.5 rounded border border-[#6e1f1f] bg-[#1e1e1e] text-[#FFB4B4]"
                >
                  {name}
                </code>
              ))}
            </div>
            <span className="text-[10px] text-[#9ca3af] leading-relaxed">
              Names and matching rules only &mdash; Termpolis never captures or stores the value. Open the audit log for
              the agent, the timestamp, and the count for each one.
            </span>
          </div>
        )}
      </div>

      {/* Commit/Push Secret Shield — the git-boundary gate */}
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <button
          onClick={toggleCommitShield}
          aria-label="Toggle commit and push secret shield"
          data-testid="security-commit-shield-toggle"
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${commitShield ? 'bg-[#0d9488]' : 'bg-[#555]'}`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${commitShield ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
        </button>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium flex items-center gap-2">
            <i className="fa-solid fa-shield-halved text-[#2dd4bf]"></i>
            Commit Shield &mdash; block commits &amp; pushes that carry a secret
          </span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            Runs the same {ruleCount ?? 97}-rule engine on what <code>git commit</code> will capture (the staged diff) and what <code>git push</code> will send (every unpushed patch), and <strong>blocks the operation</strong> when a secret is found. This closes the gap the outbound scanner structurally cannot see &mdash; it never watches git.
            <br />
            On its own, this toggle only covers the git operations <strong>Termpolis itself runs</strong> (the Git panel, Swarm Review). To cover <code>git commit</code> typed into a terminal &mdash; or run from VS Code, or any other tool &mdash; install the hooks below.
          </span>
        </div>
      </div>

      {/* Git hooks — what makes the shield cover the way people ACTUALLY commit */}
      <div className="flex flex-col gap-2 p-3 border border-[#3c3c3c] rounded bg-[#252526]" data-testid="security-git-hooks">
        <div className="flex items-center gap-2">
          <i className="fa-solid fa-code-branch text-[#2dd4bf]"></i>
          <span className="text-sm font-medium">Protect a repository&rsquo;s git hooks</span>
        </div>
        <span className="text-xs text-[#9ca3af] leading-relaxed">
          Installs a <code>pre-commit</code> and <code>pre-push</code> hook that scan the diff before git accepts it, so a secret is
          caught <strong>however you commit</strong> &mdash; terminal, IDE, or script. The hook runs a standalone scanner, so it keeps
          working <strong>even with Termpolis closed</strong>. It <strong>fails open</strong>: if the scanner or Node is missing, git is
          never blocked. An existing hook (husky, lint-staged) is <strong>chained, never overwritten</strong>.
          Note that <code>--no-verify</code> bypasses any git hook &mdash; this is a strong net, not a cage.
        </span>

        <button
          onClick={protectRepo}
          disabled={hookBusy}
          data-testid="security-protect-repo"
          className="self-start text-xs px-3 py-1.5 rounded bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 disabled:cursor-not-allowed font-medium"
        >
          {hookBusy ? 'Installing…' : 'Protect a repository…'}
        </button>

        {hookMsg && <span className="text-xs text-[#7ee2a3]" data-testid="security-hook-msg">{hookMsg}</span>}

        {shieldRepos.length > 0 && (
          <div className="flex flex-col gap-1 mt-1" data-testid="security-hook-list">
            {shieldRepos.map((r) => {
              const armed = r.status?.['pre-commit'] === 'installed'
              return (
                <div key={r.repo} className="flex items-center gap-2 text-xs p-2 rounded bg-[#1e1e1e]">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${armed ? 'bg-[#0d3a1a] text-[#7ee2a3] border-[#1f6e3a]' : 'bg-[#3a2a0d] text-[#FFB74D] border-[#6e4d1f]'}`}>
                    {armed ? 'armed' : 'not installed'}
                  </span>
                  <span className="font-mono text-[11px] truncate" title={r.repo}>{r.repo}</span>
                  <button onClick={() => unprotectRepo(r.repo)} className="ml-auto text-[10px] text-[#FFB4B4] hover:underline">
                    Remove
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Egress Guard — allowlist enforcement on agent network traffic */}
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <button
          onClick={toggleEgressGuard}
          aria-label="Toggle egress guard"
          data-testid="security-egress-guard-toggle"
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${egressGuard ? 'bg-[#0d9488]' : 'bg-[#555]'}`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${egressGuard ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
        </button>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium flex items-center gap-2">
            <i className="fa-solid fa-tower-broadcast text-[#2dd4bf]"></i>
            Egress Guard &mdash; flag agent traffic to unexpected hosts
          </span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            The egress log already <em>recorded</em> where each agent connects. This turns that record into a policy: any host outside the known AI-provider allowlist is raised as a violation &mdash; which is the signal that actually matters for exfiltration.
          </span>
        </div>
      </div>

      {/* Memory scrub — secrets never reach the brain on disk */}
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <button
          onClick={toggleMemoryScrub}
          aria-label="Toggle memory secret scrub"
          data-testid="security-memory-scrub-toggle"
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${memoryScrub ? 'bg-[#0d9488]' : 'bg-[#555]'}`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${memoryScrub ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
        </button>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium flex items-center gap-2">
            <i className="fa-solid fa-brain text-[#2dd4bf]"></i>
            Memory scrub &mdash; redact secrets before they are stored
          </span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            Secrets are stripped out of a memory <strong>before</strong> it is hashed, embedded, or written to the brain &mdash; so a key sitting in a transcript or an indexed file never lands on disk, and can never be recalled back into an agent&apos;s context later.
          </span>
        </div>
      </div>

      {/* Background watchers (sensitive-file + per-agent egress) */}
      <div
        data-testid="security-watchers"
        className="flex flex-col gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]"
      >
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <i className="fa-solid fa-eye text-[#22D3EE]"></i>
          Background watchers (always on)
        </h3>
        <p className="text-xs text-[#9ca3af] leading-relaxed">
          Two passive watchers run alongside every AI-agent terminal. They never block the agent — they record what was read or transmitted so you have a forensic trail and can tighten ignore-files for next session.
        </p>

        <button
          onClick={() => setShowAudit(true)}
          data-testid="security-open-audit"
          className="self-start text-xs px-3 py-1.5 rounded bg-[#0d9488] hover:bg-[#0f766e] font-medium flex items-center gap-1.5"
        >
          <i className="fa-solid fa-clipboard-list"></i>
          Open the audit log
        </button>

        {showAudit && (
          <AuditLogModal
            onClose={() => setShowAudit(false)}
            auditPath={auditPath}
            coverage={{
              // Prompt watching is absent on purpose — it is not a setting, so there is nothing to
              // report. `auditEnabled` is now the only flag that can make a zero meaningless:
              // watching still runs, but nothing is written down.
              auditEnabled,
              commitShield,
              egressGuard,
              memoryScrub,
            }}
          />
        )}

        {/* Sensitive-file watcher */}
        <div className="flex flex-col gap-1.5 pt-2 border-t border-[#3c3c3c]">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[#d4d4d4] flex items-center gap-1.5">
              <i className="fa-solid fa-file-shield text-[#FFB74D] text-[11px]"></i>
              Sensitive-file read watcher
            </span>
            <span
              data-testid="security-sensitive-file-count"
              className={`text-[10px] px-2 py-0.5 rounded border ${
                auditEntries.filter(e => e.event === 'sensitive_file_read').length > 0
                  ? 'bg-[#3a2a0d] text-[#FFB74D] border-[#6e4d1f]'
                  : 'bg-[#0d3a1a] text-[#7ee2a3] border-[#1f6e3a]'
              }`}
            >
              {auditEntries.filter(e => e.event === 'sensitive_file_read').length} recent matches
            </span>
          </div>
          <p className="text-[11px] text-[#9ca3af] leading-relaxed">
            Watches the agent's tool-call stream for reads of <code>.env*</code>, PEM keys, <code>~/.aws/credentials</code>, <code>~/.ssh/*</code>, and other high-risk files (~17 conservative rules). Each match is recorded in the audit log and a banner pops up in the terminal. Add the path to <code>.claudeignore</code> (or the equivalent) before the next session.
          </p>
          {auditEntries.filter(e => e.event === 'sensitive_file_read').slice(0, 5).map((e, i) => (
            <div
              key={'sf-' + i}
              className="text-[10px] font-mono text-[#FFB4B4] bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 break-all"
            >
              {new Date(e.ts).toLocaleTimeString()} · {e.agent} · {e.notes}
            </div>
          ))}
        </div>

        {/* Egress audit */}
        <div className="flex flex-col gap-1.5 pt-2 border-t border-[#3c3c3c]">
          <span className="text-xs font-medium text-[#d4d4d4] flex items-center gap-1.5">
            <i className="fa-solid fa-network-wired text-[#22D3EE] text-[11px]"></i>
            Per-agent egress audit
          </span>
          <p className="text-[11px] text-[#9ca3af] leading-relaxed">
            Polls each agent's open TCP connections once a minute (via <code>netstat</code>/<code>ss</code>/<code>lsof</code>) and records the unique <code>host:port</code> pairs. OS-level ground truth — independent of what the agent's own logs say. Visible alongside the entries below when the audit log is enabled.
          </p>
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
              Append-only JSONL recording every AI-agent terminal session: timestamp, agent, byte count, and the name of any
              secret that went out. Stays on this machine. Watching does not stop when this is off &mdash; only the <em>record</em> does,
              which is why a zero above reads as &ldquo;not recorded&rdquo; rather than &ldquo;clean&rdquo; while this is switched off.
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
                    {auditEntries.slice(0, RECENT_ROWS).map((e, i) => (
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
                <li key={i}>
                  <strong>{h.label}</strong>
                  {h.name && <> &mdash; <code className="text-[#FFB74D]">{h.name}</code></>}
                  : <code className="text-[#d4d4d4]">{h.sample}</code>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#9ca3af]">Redacted preview:</span>
              <button
                onClick={() => void copyText(scanResult.redacted)}
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
          Termpolis does not control, audit, or guarantee the data-handling practices of any third-party AI provider (Anthropic, OpenAI, Google, Ollama, or any future provider).
        </p>
        <p>
          The secret scanner uses regular expressions tuned for well-shaped secrets. <strong>It is not a comprehensive DLP solution.</strong>
          Custom or unusual secret formats (for example, internal corporate tokens) will not be detected.
          <strong> Prompt watching detects; it does not prevent.</strong> A prompt is forwarded to the agent unmodified and a secret found in it has, by definition, already been transmitted &mdash; the audit entry tells you what to rotate, it does not undo the disclosure.
          The audit log records what Termpolis observes locally; it does not capture content that bypasses Termpolis (for example, an agent run from a separate native terminal window).
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
