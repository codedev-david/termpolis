import { useCallback, useEffect, useState } from 'react'
import type {
  AgentIntegrationChange,
  AgentIntegrationSetRequest,
  AgentIntegrationSetResult,
  AgentIntegrationStatus,
} from '../../../../shared/agentIntegration'
import { noteAgentAnswerSaved } from '../AgentIntegration/AgentReviewModal'
import { AgentWritesList, PRIMER_HOOK_LABEL, homeFromStatus, tildify } from '../AgentIntegration/AgentWritesList'

// Settings ▸ Agent Integration: what Termpolis has written into the Claude Code, Codex and
// Gemini / Antigravity CLI configs, and the switch that connects or disconnects them. Main applies each change
// at once and reports every file it touched; that report stays up until the next action.

const CONNECT_LABEL = 'Connect Termpolis to Claude Code, Codex and Gemini / Antigravity CLI'

const ACTION_LABELS: Record<AgentIntegrationChange['action'], string> = {
  add: 'Added',
  update: 'Updated',
  remove: 'Removed',
  unchanged: 'Unchanged',
  skipped: 'Skipped',
}

const ACTION_STYLES: Record<AgentIntegrationChange['action'], string> = {
  add: 'text-[#7ee2a3]',
  update: 'text-[#22D3EE]',
  remove: 'text-[#e5c07b]',
  unchanged: 'text-[#9ca3af]',
  skipped: 'text-[#e06c75]',
}

const BUTTON = 'text-xs px-2 py-1 rounded bg-[#2d2d2d] text-[#d4d4d4] hover:bg-[#3a3a3a] disabled:opacity-50'

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function Switch({ on, label, testId, disabled, onClick }: {
  on: boolean
  label: string
  testId: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={on}
      data-testid={testId}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 disabled:opacity-50 ${
        on ? 'bg-[#0078d4]' : 'bg-[#555]'
      }`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
        on ? 'translate-x-4.5' : 'translate-x-0.5'
      }`} />
    </button>
  )
}

export function AgentIntegrationSettings() {
  const [status, setStatus] = useState<AgentIntegrationStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // What the last action did, shown until the next one starts.
  const [changes, setChanges] = useState<AgentIntegrationChange[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await window.termpolis.agentIntegrationStatus()
      if (res.success) {
        setStatus(res.data)
        setLoadError(null)
      } else {
        setLoadError(res.error)
      }
    } catch (e) {
      setLoadError(errorText(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // One action at a time: the buttons are disabled until it settles.
  const act = async (action: () => Promise<AgentIntegrationChange[]>) => {
    setBusy(true)
    setChanges(null)
    setError(null)
    try {
      setChanges(await action())
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  const apply = (req: AgentIntegrationSetRequest) => act(async () => {
    const res = await window.termpolis.agentIntegrationSet(req)
    if (!res.success) throw new Error(res.error)
    const data: AgentIntegrationSetResult = res.data
    setStatus(data.status)
    // A choice main could not save: a connect changes nothing, and a disconnect still happens
    // but, unrecorded, may be undone when Termpolis next starts. Either way the agent review
    // asks again at next launch.
    noteAgentAnswerSaved(!data.saveError)
    if (data.saveError && req.connect) throw new Error(`Couldn't save your choice, so nothing was changed: ${data.saveError}`)
    if (data.saveError) setError(`Couldn't save your choice, so Termpolis may connect the agents again at its next start: ${data.saveError}`)
    return data.changes
  })

  const removeHomeTrust = (codexConfig: string) => act(async () => {
    const res = await window.termpolis.agentRemoveCodexHomeTrust()
    await load()
    if (!res.success) throw new Error(res.error)
    if (res.data.error) throw new Error(res.data.error)
    const removed: AgentIntegrationChange = { agent: 'codex', file: codexConfig, action: 'remove', what: 'Trust for your home folder' }
    return res.data.changed ? [removed] : []
  })

  if (!status) {
    return (
      <div className="settings-section" data-testid="agent-integration-settings">
        <h2 className="text-sm font-semibold text-[#e0e0e0] mb-2">Agent Integration</h2>
        {loadError === null ? (
          <p className="text-xs text-[#9ca3af]" data-testid="agent-integration-loading">Reading agent configs…</p>
        ) : (
          <p className="text-xs text-[#e06c75]" data-testid="agent-integration-load-error">
            Couldn&apos;t read what is connected: {loadError}{' '}
            <button onClick={() => { void load() }} className="underline text-[#22D3EE] hover:text-[#67e8f9]">
              Try again
            </button>
          </p>
        )}
      </div>
    )
  }

  const home = homeFromStatus(status)
  const unreviewed = status.consent === null && status.legacyDetected
  const summary = unreviewed
    ? 'Connected by an earlier version — not yet reviewed'
    : status.connected ? 'Connected' : 'Not connected'

  return (
    <div className="settings-section flex flex-col gap-3" data-testid="agent-integration-settings">
      <div>
        <h2 className="text-sm font-semibold text-[#e0e0e0] mb-1">Agent Integration</h2>
        <p className="text-xs text-[#9ca3af]" data-testid="agent-integration-status">{summary}</p>
      </div>

      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <Switch
          on={status.connected}
          label={CONNECT_LABEL}
          testId="agent-integration-toggle"
          disabled={busy}
          onClick={() => { void apply(status.connected ? { connect: false } : { connect: true, primerHook: status.primerHook }) }}
        />
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{CONNECT_LABEL}</span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            Gives each of them installed on this machine Termpolis&apos;s memory and code search, by
            writing what is listed below.
          </span>
        </div>
      </div>

      <label className={`flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526] ${status.connected ? 'cursor-pointer' : 'opacity-50'}`}>
        <input
          type="checkbox"
          checked={status.primerHook}
          disabled={!status.connected || busy}
          onChange={e => { void apply({ connect: true, primerHook: e.target.checked }) }}
          className="mt-0.5 w-4 h-4 accent-[#22D3EE]"
          data-testid="agent-integration-primer-hook"
        />
        <span className="text-sm">{PRIMER_HOOK_LABEL}</span>
      </label>

      {status.connected && (
        <div className="flex items-center gap-3">
          <button onClick={() => { void apply({ connect: false }) }} disabled={busy} className={BUTTON} data-testid="agent-integration-disconnect">
            Disconnect
          </button>
          <span className="text-xs text-[#9ca3af]">Removes everything Termpolis wrote into their configs. Folders trusted before v1.49 stay trusted.</span>
        </div>
      )}

      {changes !== null && (
        <div className="flex flex-col gap-1 p-3 border border-[#3c3c3c] rounded bg-[#1e1e1e]" data-testid="agent-integration-changes">
          {changes.length === 0 ? (
            <span className="text-xs text-[#9ca3af]">Nothing needed to change.</span>
          ) : changes.map((c, i) => (
            <div key={i} className="text-[11px] flex flex-wrap gap-x-2" data-testid="agent-integration-change">
              <span className={ACTION_STYLES[c.action]}>{ACTION_LABELS[c.action]}</span>
              <span className="text-[#d4d4d4]">{c.what}</span>
              <code className="text-[#9ca3af] break-all">{tildify(c.file, home)}</code>
              {c.error && <span className="text-[#e06c75] w-full">{c.error}</span>}
            </div>
          ))}
        </div>
      )}
      {error !== null && (
        <p className="text-xs text-[#e06c75]" role="alert" data-testid="agent-integration-error">{error}</p>
      )}

      {status.codexHomeTrusted && (
        <div className="flex items-start gap-3 p-3 border border-[#e5c07b]/50 rounded bg-[#252526]" data-testid="agent-integration-codex-home">
          <i className="fa-solid fa-triangle-exclamation text-[#e5c07b] mt-0.5"></i>
          <span className="text-xs text-[#d4d4d4] leading-relaxed flex-1">
            Codex trusts your home folder, which older Termpolis versions could have caused.
          </span>
          <button
            onClick={() => { void removeHomeTrust(status.agents.codex.configPath) }}
            disabled={busy}
            className={BUTTON}
            data-testid="agent-integration-remove-home-trust"
          >
            Remove
          </button>
        </div>
      )}

      <AgentWritesList status={status} />

      <div className="flex flex-col gap-1">
        <details className="text-xs" data-testid="agent-integration-tools">
          <summary className="cursor-pointer text-[#d4d4d4]">
            {status.autoAllowedTools.length} Termpolis tools Claude Code runs without asking, when connected
          </summary>
          <ul className="mt-1 pl-5 list-disc text-[11px] text-[#bbb] columns-2">
            {status.autoAllowedTools.map(t => <li key={t}><code>{t}</code></li>)}
          </ul>
        </details>
        <span className="text-xs text-[#9ca3af]">Tools that run commands or type into terminals always ask.</span>
      </div>

      <div className="flex flex-col gap-1" data-testid="agent-integration-trusted">
        <span className="text-sm font-medium">Folders Termpolis marked trusted</span>
        {status.trustedFolders.length === 0 ? (
          <span className="text-xs text-[#9ca3af]">None.</span>
        ) : (
          <ul className="text-[11px] text-[#bbb] pl-5 list-disc space-y-0.5">
            {status.trustedFolders.map(f => <li key={f}><code className="break-all">{tildify(f, home)}</code></li>)}
          </ul>
        )}
        <span className="text-xs text-[#9ca3af]">Disconnect reverts these.</span>
      </div>

      <p className="text-xs text-[#6b7280]">
        Uninstalling? <code>Termpolis --disconnect-agents</code> removes the same things from the command line.
      </p>
    </div>
  )
}
