import { useCallback, useEffect, useState } from 'react'
import type {
  McpGatewayPolicyView,
  McpInventoryView,
  McpServerSpecView,
  McpSourceId,
  McpGatewayTestView,
} from '../../types'

/**
 * MCP servers — the human-facing half of the gateway.
 *
 * Two halves, and the split is deliberate. The GATEWAY is Termpolis's own list and is
 * editable. The INVENTORY is a read-only union of what the agent CLIs have configured:
 * each CLI knows only its own file, so this is the only place the union is visible, and
 * those files are hand-edited, so this release does not write to them.
 *
 * Writes are NOT optimistic. Every mutation renders the list main sent back, so a refused
 * write leaves the panel showing what is actually on disk rather than what the user hoped.
 *
 * Health is probe-on-demand. `liveTransports()` in the runtime memoises stdio transports
 * as live child processes, so anything automatic here would spawn every configured server
 * merely because Settings was opened. Rows say `configured` until the user clicks Test.
 */

/** The three agent CLIs, in the order the drift column reads left to right. `globalMcp`
 *  is a second Claude surface and `gateway` is our own, so neither is a drift column. */
const AGENT_COLUMNS: { id: McpSourceId; short: string }[] = [
  { id: 'claude', short: 'Claude' },
  { id: 'codex', short: 'Codex' },
  { id: 'gemini', short: 'Gemini' },
]

const DECISIONS: McpGatewayPolicyView['defaultDecision'][] = ['ask', 'allow', 'deny']

const DECISION_HINT: Record<McpGatewayPolicyView['defaultDecision'], string> = {
  ask: 'Prompt before a tool call that no rule covers.',
  allow: 'Run any upstream tool without asking. Only sensible with servers you control.',
  deny: 'Refuse anything no rule explicitly allows.',
}

const STATUS_STYLE: Record<string, string> = {
  ok: 'text-[#98c379]',
  missing: 'text-[#9ca3af]',
  corrupt: 'text-[#e06c75]',
}

export function McpServersSettings(): JSX.Element {
  const [inventory, setInventory] = useState<McpInventoryView | null>(null)
  const [servers, setServers] = useState<McpServerSpecView[] | null>(null)
  const [policy, setPolicy] = useState<McpGatewayPolicyView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tested, setTested] = useState<Record<string, McpGatewayTestView>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [draftId, setDraftId] = useState('')
  const [draftCommand, setDraftCommand] = useState('')
  const [draftArgs, setDraftArgs] = useState('')

  const api = typeof window === 'undefined' ? undefined : window.termpolis
  const unavailable = !api?.mcpInventory

  const load = useCallback(async (): Promise<void> => {
    if (!api?.mcpInventory) return
    setBusy(true)
    const [inv, list, pol] = await Promise.all([api.mcpInventory(), api.mcpGatewayServers(), api.mcpGatewayPolicy()])
    // Each read reports independently: a broken foreign config must not blank the
    // gateway controls, which are the half the user can actually act on.
    if (inv.success) setInventory(inv.data)
    if (list.success) setServers(list.data)
    if (pol.success) setPolicy(pol.data)
    const failed = [inv, list, pol].find((r) => !r.success)
    setError(failed && !failed.success ? failed.error : null)
    setBusy(false)
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const addServer = async (): Promise<void> => {
    if (!api) return
    setBusy(true)
    // Args are split on whitespace: the field is for `-y @scope/pkg`, not a shell
    // command line, and pretending to handle quoting would be a lie about what is
    // passed to spawn().
    const args = draftArgs.trim() ? draftArgs.trim().split(/\s+/) : undefined
    const res = await api.mcpGatewayAddServer({ id: draftId.trim(), command: draftCommand.trim(), args })
    if (res.success) {
      setServers(res.data)
      setError(null)
      setDraftId('')
      setDraftCommand('')
      setDraftArgs('')
      // The new server changes the gateway row of the inventory too.
      void load()
    } else {
      setError(res.error)
    }
    setBusy(false)
  }

  const removeServer = async (id: string): Promise<void> => {
    if (!api) return
    setBusy(true)
    const res = await api.mcpGatewayRemoveServer(id)
    if (res.success) {
      setServers(res.data)
      setError(null)
      setTested((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      void load()
    } else {
      setError(res.error)
    }
    setBusy(false)
  }

  const testServer = async (id: string): Promise<void> => {
    if (!api) return
    setTesting(id)
    const res = await api.mcpGatewayTest(id)
    if (res.success) setTested((prev) => ({ ...prev, [id]: res.data }))
    else setError(res.error)
    setTesting(null)
  }

  const savePolicy = async (patch: Partial<McpGatewayPolicyView>): Promise<void> => {
    if (!api || !policy) return
    setBusy(true)
    const res = await api.mcpGatewaySetPolicy({ ...policy, ...patch })
    if (res.success) {
      setPolicy(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
    setBusy(false)
  }

  if (unavailable) {
    return (
      <div className="settings-section" data-testid="mcp-settings">
        <h2 className="text-sm font-semibold text-[#e0e0e0] mb-2">MCP Servers</h2>
        <p className="text-xs text-[#e5c07b]" data-testid="mcp-unavailable">
          MCP management is not available in this build.
        </p>
      </div>
    )
  }

  if (!inventory && !servers && !policy) {
    return (
      <div className="settings-section" data-testid="mcp-settings">
        <h2 className="text-sm font-semibold text-[#e0e0e0] mb-2">MCP Servers</h2>
        <p className="text-xs text-[#9ca3af]" data-testid="mcp-loading">
          Loading…
        </p>
      </div>
    )
  }

  return (
    <div className="settings-section" data-testid="mcp-settings">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-[#e0e0e0]">MCP Servers</h2>
        <button
          type="button"
          data-testid="mcp-refresh"
          onClick={() => void load()}
          disabled={busy}
          className="text-xs px-2 py-1 rounded bg-[#2d2d2d] text-[#d4d4d4] hover:bg-[#3a3a3a] disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
      <p className="text-xs text-[#9ca3af] mb-4">
        Tools your agents reach through Termpolis, and what every agent on this machine has configured
        for itself. Credentials are never sent to this screen.
      </p>

      {error && (
        <p className="text-xs text-[#e06c75] mb-3" data-testid="mcp-error">
          {error}
        </p>
      )}

      {policy && (
        <div className="mb-6" data-testid="mcp-policy">
          <h3 className="text-xs font-semibold text-[#e0e0e0] mb-2">Gateway policy</h3>
          <label className="flex items-center gap-2 text-xs text-[#d4d4d4] mb-2">
            <input
              type="checkbox"
              data-testid="mcp-policy-enabled"
              checked={policy.enabled}
              disabled={busy}
              onChange={(e) => void savePolicy({ enabled: e.target.checked })}
            />
            Route agent tool calls through the gateway
          </label>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-[#9ca3af]">When no rule matches:</span>
            {DECISIONS.map((d) => (
              <button
                key={d}
                type="button"
                data-testid={`mcp-policy-${d}`}
                disabled={busy}
                onClick={() => void savePolicy({ defaultDecision: d })}
                className={`text-xs px-2 py-1 rounded disabled:opacity-50 ${
                  policy.defaultDecision === d
                    ? 'bg-[#0e639c] text-white'
                    : 'bg-[#2d2d2d] text-[#d4d4d4] hover:bg-[#3a3a3a]'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <p className="text-xs text-[#9ca3af]">{DECISION_HINT[policy.defaultDecision]}</p>
          {policy.rules.length > 0 && (
            <p className="text-xs text-[#9ca3af] mt-1" data-testid="mcp-policy-rules">
              {policy.rules.length} tool rule{policy.rules.length === 1 ? '' : 's'} remembered.
            </p>
          )}
        </div>
      )}

      {servers && (
        <div className="mb-6" data-testid="mcp-gateway">
          <h3 className="text-xs font-semibold text-[#e0e0e0] mb-2">Through Termpolis</h3>
          {servers.length === 0 && (
            <p className="text-xs text-[#9ca3af] mb-2" data-testid="mcp-gateway-empty">
              No upstream servers yet. Add one and every agent connected to Termpolis can reach its tools.
            </p>
          )}
          {servers.map((s) => {
            const result = tested[s.id]
            return (
              <div key={s.id} className="flex items-center gap-2 py-1 text-xs" data-testid={`mcp-server-${s.id}`}>
                <span className="text-[#d4d4d4] font-medium">{s.id}</span>
                <span className="text-[#6b7280] truncate flex-1">
                  {s.url ?? [s.command, ...(s.args ?? [])].join(' ')}
                </span>
                <span
                  data-testid={`mcp-server-status-${s.id}`}
                  className={result ? (result.ok ? 'text-[#98c379]' : 'text-[#e06c75]') : 'text-[#9ca3af]'}
                >
                  {testing === s.id
                    ? 'testing…'
                    : result
                      ? result.ok
                        ? `${result.tools} tools`
                        : (result.error ?? 'failed')
                      : 'configured'}
                </span>
                <button
                  type="button"
                  data-testid={`mcp-test-${s.id}`}
                  disabled={testing !== null}
                  onClick={() => void testServer(s.id)}
                  className="px-2 py-1 rounded bg-[#2d2d2d] text-[#d4d4d4] hover:bg-[#3a3a3a] disabled:opacity-50"
                >
                  Test
                </button>
                <button
                  type="button"
                  data-testid={`mcp-remove-${s.id}`}
                  disabled={busy}
                  onClick={() => void removeServer(s.id)}
                  className="px-2 py-1 rounded bg-[#2d2d2d] text-[#e06c75] hover:bg-[#3a3a3a] disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            )
          })}

          <div className="flex items-center gap-2 mt-3">
            <input
              data-testid="mcp-add-id"
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              placeholder="name"
              className="text-xs px-2 py-1 rounded bg-[#1e1e1e] border border-[#3a3a3a] text-[#d4d4d4] w-24"
            />
            <input
              data-testid="mcp-add-command"
              value={draftCommand}
              onChange={(e) => setDraftCommand(e.target.value)}
              placeholder="command"
              className="text-xs px-2 py-1 rounded bg-[#1e1e1e] border border-[#3a3a3a] text-[#d4d4d4] w-28"
            />
            <input
              data-testid="mcp-add-args"
              value={draftArgs}
              onChange={(e) => setDraftArgs(e.target.value)}
              placeholder="args"
              className="text-xs px-2 py-1 rounded bg-[#1e1e1e] border border-[#3a3a3a] text-[#d4d4d4] flex-1"
            />
            <button
              type="button"
              data-testid="mcp-add"
              disabled={busy}
              onClick={() => void addServer()}
              className="text-xs px-2 py-1 rounded bg-[#0e639c] text-white hover:bg-[#1177bb] disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      )}

      {inventory && (
        <div data-testid="mcp-inventory">
          <h3 className="text-xs font-semibold text-[#e0e0e0] mb-2">Configured across your agents</h3>
          <div className="overflow-x-auto">
            <table className="text-xs w-full">
              <thead>
                <tr className="text-[#9ca3af] text-left">
                  <th className="font-normal pb-1 pr-3">Server</th>
                  {AGENT_COLUMNS.map((c) => (
                    <th key={c.id} className="font-normal pb-1 pr-3">
                      {c.short}
                    </th>
                  ))}
                  <th className="font-normal pb-1">Where</th>
                </tr>
              </thead>
              <tbody>
                {inventory.servers.map((s) => (
                  <tr key={s.name} data-testid={`mcp-inv-${s.name}`} className="text-[#d4d4d4]">
                    <td className="pr-3 py-0.5">
                      {s.name}
                      {s.drift && (
                        <span className="text-[#e5c07b] ml-1" data-testid={`mcp-drift-${s.name}`} title="Configured in some agents but not all">
                          ⚠
                        </span>
                      )}
                    </td>
                    {AGENT_COLUMNS.map((c) => (
                      <td key={c.id} className="pr-3 py-0.5">
                        {s.sources[c.id] ? <span className="text-[#98c379]">✓</span> : <span className="text-[#4b5563]">–</span>}
                      </td>
                    ))}
                    <td className="py-0.5 text-[#6b7280] truncate">{s.url ?? s.command ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {inventory.servers.length === 0 && (
            <p className="text-xs text-[#9ca3af]" data-testid="mcp-inventory-empty">
              No MCP servers found in any agent config.
            </p>
          )}

          <div className="mt-3">
            {inventory.sources.map((src) => (
              <div key={src.id} className="text-xs flex items-center gap-2 py-0.5" data-testid={`mcp-source-${src.id}`}>
                <span className={STATUS_STYLE[src.status] ?? 'text-[#9ca3af]'}>{src.status}</span>
                <span className="text-[#9ca3af]">{src.label}</span>
                <span className="text-[#4b5563] truncate flex-1">{src.path}</span>
                {src.error && <span className="text-[#e06c75] truncate">{src.error}</span>}
              </div>
            ))}
          </div>
          <p className="text-xs text-[#6b7280] mt-2">
            These files belong to the agents themselves, so Termpolis reads them but does not change them.
          </p>
        </div>
      )}
    </div>
  )
}
