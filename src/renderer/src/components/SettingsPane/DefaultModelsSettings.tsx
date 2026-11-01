import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_MODEL_PROVIDERS,
  getAgentModelDefaults,
  setAgentModelDefault,
} from '../../lib/agentModelDefaults'
import { modelOptionsFor, type ModelCatalog, type ModelProvider } from '../../lib/modelCatalog'

// Settings › General › Default Models. The model each AI agent starts on when Termpolis opens a NEW
// terminal for it (sidebar, shortcuts, Welcome screen, palette, restored workspaces, handoffs).
// The agent's own list is the authority for what can be picked — read from the CLI, never typed
// in by hand — so a model the installed agent would refuse can't be chosen. See
// lib/agentModelDefaults.ts for how a saved choice is applied at launch.

const AGENT_LABEL: Record<ModelProvider, string> = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
  gemini: 'Antigravity CLI',
}

/** What each agent says when it has published no list yet (never run, or not asked). */
const NO_LIST_HINT: Record<ModelProvider, string> = {
  claude: '',
  codex: 'No models found yet. Codex publishes its model list after it has run once; start it, then press Refresh lists.',
  gemini: 'No models found yet. Press Refresh lists to ask the Antigravity CLI for its models.',
}

const OWN_DEFAULT = "Agent's own default"

export function DefaultModelsSettings() {
  const [defaults, setDefaults] = useState(() => getAgentModelDefaults())
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  // The same two reads the terminal header's picker makes: the list as it stands, then whatever
  // the launch-time discovery pushes once it lands.
  useEffect(() => {
    let alive = true
    let off: (() => void) | undefined
    try {
      window.termpolis.getModelCatalog?.()
        ?.then((res) => { if (alive && res?.success && res.data) setCatalog(res.data) })
        ?.catch(() => { /* leave null — Claude's list is built in; the others show their hint */ })
      off = window.termpolis.onModelCatalogUpdated?.((c) => { if (alive) setCatalog(c) })
    } catch { /* API unavailable (e.g. in tests) */ }
    return () => { alive = false; off?.() }
  }, [])

  const refresh = useCallback(async () => {
    setBusy(true)
    setStatus('Asking each agent for its models…')
    try {
      const res = await window.termpolis.refreshModelCatalog()
      if (res?.success && res.data) {
        setCatalog(res.data)
        setStatus('Model lists updated.')
      } else {
        setStatus('Could not read the model lists.')
      }
    } catch {
      setStatus('Could not read the model lists.')
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <div className="flex flex-col gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]" data-testid="settings-default-models">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">Default Models</span>
        <span className="text-xs text-[#9ca3af] leading-relaxed">
          The model each AI agent starts on when Termpolis opens a new terminal for it.
          &ldquo;{OWN_DEFAULT}&rdquo; leaves the choice to the agent. A terminal that is already running
          keeps its model &mdash; use the Model menu in its header to change that one. A session you
          resume keeps the model it was on.
        </span>
      </div>
      {DEFAULT_MODEL_PROVIDERS.map((provider) => {
        const options = modelOptionsFor(provider, catalog)
        const saved = defaults[provider] ?? ''
        const listed = options.some((o) => o.alias === saved)
        return (
          <div key={provider} className="flex flex-col gap-1">
            <label className="flex items-center gap-3 text-sm">
              <span className="w-32 shrink-0">{AGENT_LABEL[provider]}</span>
              <select
                data-testid={`settings-default-model-${provider}`}
                value={saved}
                onChange={(e) => setDefaults(setAgentModelDefault(provider, e.target.value))}
                className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-hidden min-w-[16rem]"
              >
                <option value="">{OWN_DEFAULT}</option>
                {saved && !listed && <option value={saved}>{saved} (not in the current list)</option>}
                {options.map((m) => (
                  <option key={m.alias} value={m.alias}>
                    {m.label}{m.note ? ` · ${m.note}` : m.savingsPct > 0 ? ` · ${m.savingsPct}% cheaper` : ''}
                  </option>
                ))}
              </select>
            </label>
            {options.length === 0 && NO_LIST_HINT[provider] && (
              <span className="text-xs text-[#9ca3af] leading-relaxed pl-[8.75rem]" data-testid={`settings-default-model-${provider}-hint`}>
                {NO_LIST_HINT[provider]}
              </span>
            )}
          </div>
        )
      })}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => { void refresh() }}
          disabled={busy}
          data-testid="settings-default-models-refresh"
          className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-1 text-sm hover:bg-[#3c3c3c] disabled:opacity-60"
        >
          Refresh lists
        </button>
        <span className="text-xs text-[#9ca3af]" role="status" data-testid="settings-default-models-status">{status}</span>
      </div>
    </div>
  )
}
