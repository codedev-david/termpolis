import { useCallback, useEffect, useState } from 'react'
import {
  AUTO_MODEL,
  DEFAULT_MODEL_PROVIDERS,
  getAgentModelDefaults,
  setAgentModelDefault,
} from '../../lib/agentModelDefaults'
import { modelOptionsFor, type ModelCatalog, type ModelProvider } from '../../lib/modelCatalog'
import { getRouterMode, setRouterMode, ROUTER_MODES, type RouterMode } from '../../lib/messageRoute'

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
  const [routing, setRouting] = useState<RouterMode>(() => getRouterMode())

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
        const auto = provider === 'claude'
        const listed = options.some((o) => o.alias === saved) || (auto && saved === AUTO_MODEL)
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
                {auto && <option value={AUTO_MODEL}>Auto (best for the task)</option>}
                {saved && !listed && <option value={saved}>{saved} (not in the current list)</option>}
                {options.map((m) => (
                  <option key={m.alias} value={m.alias}>
                    {m.label}{m.note ? ` · ${m.note}` : m.savingsPct > 0 ? ` · ${m.savingsPct}% cheaper` : ''}
                  </option>
                ))}
              </select>
            </label>
            {auto && saved === AUTO_MODEL && (
              <span className="text-xs text-[#9ca3af] leading-relaxed pl-[8.75rem]" data-testid="settings-default-model-claude-auto-hint">
                Each new Claude terminal starts on the model and effort that fit what you type in
                &ldquo;What&rsquo;s the task?&rdquo;: Haiku for a quick lookup, Sonnet for building, Opus for design
                and hard bugs, Opus Plan when there is no task yet. Its subagents run on Sonnet. With
                per-message routing on (below), each message you send then runs on the model it needs.
              </span>
            )}
            {options.length === 0 && NO_LIST_HINT[provider] && (
              <span className="text-xs text-[#9ca3af] leading-relaxed pl-[8.75rem]" data-testid={`settings-default-model-${provider}-hint`}>
                {NO_LIST_HINT[provider]}
              </span>
            )}
          </div>
        )
      })}
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-3 text-sm">
          <span className="w-32 shrink-0">Model per message</span>
          <select
            data-testid="settings-message-routing"
            value={routing}
            onChange={(e) => setRouting(setRouterMode(e.target.value as RouterMode))}
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-hidden min-w-[16rem]"
          >
            {ROUTER_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <span className="text-xs text-[#9ca3af] leading-relaxed pl-[8.75rem]" data-testid="settings-message-routing-hint">
          Each message you send to Claude runs on the model it needs: Haiku for a quick question, Sonnet
          for building, Opus for design and hard bugs. A small model on this computer decides in a few
          milliseconds; nothing is sent anywhere to decide. It moves down only when that saves money
          after re-reading the conversation, and a &ldquo;yes, go ahead&rdquo; stays on the model doing the work.
          The pane header shows each pick; tell it what a message should have been and it learns.
          Picking a model in a pane&rsquo;s Model menu turns this off for that pane. Applies to Claude
          terminals Termpolis opens with token compression on. In Codex terminals opened from the sidebar
          it picks each message&rsquo;s reasoning effort instead, and keeps the model.
        </span>
      </div>
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
