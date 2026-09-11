// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { McpServersSettings } from '../../src/renderer/src/components/SettingsPane/McpServersSettings'
import type { McpInventoryView, McpGatewayPolicyView, McpServerSpecView, McpSourceId } from '../../src/renderer/src/types'

const ok = <T,>(data: T) => ({ success: true as const, data })
const fail = (error: string) => ({ success: false as const, error })

const NO_SOURCES: Record<McpSourceId, boolean> = {
  claude: false,
  globalMcp: false,
  codex: false,
  gemini: false,
  gateway: false,
}

const policy = (over: Partial<McpGatewayPolicyView> = {}): McpGatewayPolicyView => ({
  enabled: true,
  defaultDecision: 'ask',
  strict: false,
  rules: [],
  ...over,
})

const inventory = (over: Partial<McpInventoryView> = {}): McpInventoryView => ({
  sources: [
    { id: 'claude', label: 'Claude Code', path: '/home/me/.claude/settings.json', status: 'ok' },
    { id: 'codex', label: 'Codex', path: '/home/me/.codex/config.toml', status: 'missing' },
    { id: 'gemini', label: 'Gemini', path: '/home/me/.gemini/settings.json', status: 'ok' },
  ],
  servers: [
    { name: 'github', transport: 'stdio', command: 'npx', sources: { ...NO_SOURCES, claude: true }, drift: true },
    {
      name: 'shared',
      transport: 'stdio',
      command: 'npx',
      sources: { ...NO_SOURCES, claude: true, codex: true, gemini: true },
      drift: false,
    },
  ],
  ...over,
})

function mockApi(over: Record<string, unknown> = {}) {
  const api = {
    mcpInventory: vi.fn().mockResolvedValue(ok(inventory())),
    mcpGatewayServers: vi.fn().mockResolvedValue(ok([] as McpServerSpecView[])),
    mcpGatewayPolicy: vi.fn().mockResolvedValue(ok(policy())),
    mcpGatewayAddServer: vi.fn(),
    mcpGatewayRemoveServer: vi.fn(),
    mcpGatewaySetPolicy: vi.fn(),
    mcpGatewayTest: vi.fn(),
    ...over,
  }
  ;(window as any).termpolis = api
  return api
}

describe('McpServersSettings', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })
  afterEach(() => {
    cleanup()
    delete (window as any).termpolis
    vi.restoreAllMocks()
  })

  it('says so when the bridge does not expose MCP management', () => {
    ;(window as any).termpolis = {}
    render(<McpServersSettings />)
    expect(screen.getByTestId('mcp-unavailable')).toBeTruthy()
  })

  it('renders the gateway, the policy and the cross-agent matrix', async () => {
    mockApi({ mcpGatewayServers: vi.fn().mockResolvedValue(ok([{ id: 'local', command: 'npx', args: ['srv'] }])) })
    render(<McpServersSettings />)

    await screen.findByTestId('mcp-gateway')
    expect(screen.getByTestId('mcp-server-local')).toBeTruthy()
    // Probe-on-demand: nothing is connected until the user asks.
    expect(screen.getByTestId('mcp-server-status-local').textContent).toBe('configured')
    expect(screen.getByTestId('mcp-inv-github')).toBeTruthy()
    expect(screen.getByTestId('mcp-drift-github')).toBeTruthy()
    // A server every agent has is not drift.
    expect(screen.queryByTestId('mcp-drift-shared')).toBeNull()
    expect(screen.getByTestId('mcp-source-codex').textContent).toContain('missing')
  })

  it('does NOT probe any upstream server on mount', async () => {
    const api = mockApi({ mcpGatewayServers: vi.fn().mockResolvedValue(ok([{ id: 'local', command: 'npx' }])) })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-server-local')
    expect(api.mcpGatewayTest).not.toHaveBeenCalled()
  })

  it('reports a failing read without blanking the half that loaded', async () => {
    mockApi({
      mcpInventory: vi.fn().mockResolvedValue(fail('no home directory')),
      mcpGatewayServers: vi.fn().mockResolvedValue(ok([{ id: 'local', command: 'npx' }])),
    })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-error')
    expect(screen.getByTestId('mcp-error').textContent).toContain('no home directory')
    // The gateway still renders — it is the half the user can act on.
    expect(screen.getByTestId('mcp-server-local')).toBeTruthy()
    expect(screen.queryByTestId('mcp-inventory')).toBeNull()
  })

  it('shows the loading state until the first reads land, then stops showing it', async () => {
    let release: (v: unknown) => void = () => {}
    const gate = new Promise((res) => {
      release = res
    })
    mockApi({ mcpInventory: vi.fn().mockReturnValue(gate.then(() => ok(inventory()))) })
    render(<McpServersSettings />)
    expect(screen.getByTestId('mcp-loading')).toBeTruthy()
    release(null)
    await screen.findByTestId('mcp-gateway')
    expect(screen.queryByTestId('mcp-loading')).toBeNull()
  })

  it('adds a server and renders what main returned, not what was typed', async () => {
    const api = mockApi({
      // Main answers with a DIFFERENT list than the draft implies — the panel must show
      // the persisted truth, not an optimistic echo of the form.
      mcpGatewayAddServer: vi.fn().mockResolvedValue(ok([{ id: 'canonical', command: 'npx', args: ['srv'] }])),
    })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-gateway')

    fireEvent.change(screen.getByTestId('mcp-add-id'), { target: { value: 'typed' } })
    fireEvent.change(screen.getByTestId('mcp-add-command'), { target: { value: 'npx' } })
    fireEvent.change(screen.getByTestId('mcp-add-args'), { target: { value: '  -y  srv  ' } })
    fireEvent.click(screen.getByTestId('mcp-add'))

    await screen.findByTestId('mcp-server-canonical')
    expect(screen.queryByTestId('mcp-server-typed')).toBeNull()
    // Args split on whitespace, empties dropped.
    expect(api.mcpGatewayAddServer).toHaveBeenCalledWith({ id: 'typed', command: 'npx', args: ['-y', 'srv'] })
    // The form clears only on success.
    expect((screen.getByTestId('mcp-add-id') as HTMLInputElement).value).toBe('')
  })

  it('sends no args field when the args box is empty', async () => {
    const api = mockApi({ mcpGatewayAddServer: vi.fn().mockResolvedValue(ok([])) })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-gateway')
    fireEvent.change(screen.getByTestId('mcp-add-id'), { target: { value: 'a' } })
    fireEvent.change(screen.getByTestId('mcp-add-command'), { target: { value: 'npx' } })
    fireEvent.click(screen.getByTestId('mcp-add'))
    await waitFor(() => expect(api.mcpGatewayAddServer).toHaveBeenCalled())
    expect(api.mcpGatewayAddServer).toHaveBeenCalledWith({ id: 'a', command: 'npx', args: undefined })
  })

  it('keeps the typed draft when the add is refused', async () => {
    mockApi({ mcpGatewayAddServer: vi.fn().mockResolvedValue(fail('Server id is required')) })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-gateway')

    fireEvent.change(screen.getByTestId('mcp-add-command'), { target: { value: 'npx' } })
    fireEvent.click(screen.getByTestId('mcp-add'))

    await screen.findByTestId('mcp-error')
    expect(screen.getByTestId('mcp-error').textContent).toContain('Server id is required')
    expect((screen.getByTestId('mcp-add-command') as HTMLInputElement).value).toBe('npx')
  })

  it('removes a server and renders the returned list', async () => {
    const api = mockApi({
      mcpGatewayServers: vi.fn().mockResolvedValue(ok([{ id: 'local', command: 'npx' }])),
      mcpGatewayRemoveServer: vi.fn().mockResolvedValue(ok([])),
    })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-server-local')
    fireEvent.click(screen.getByTestId('mcp-remove-local'))
    await screen.findByTestId('mcp-gateway-empty')
    expect(api.mcpGatewayRemoveServer).toHaveBeenCalledWith('local')
  })

  it('leaves the row in place when the remove is refused', async () => {
    mockApi({
      mcpGatewayServers: vi.fn().mockResolvedValue(ok([{ id: 'local', command: 'npx' }])),
      mcpGatewayRemoveServer: vi.fn().mockResolvedValue(fail('EACCES')),
    })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-server-local')
    fireEvent.click(screen.getByTestId('mcp-remove-local'))
    await screen.findByTestId('mcp-error')
    expect(screen.getByTestId('mcp-server-local')).toBeTruthy()
  })

  it('tests a server only when asked, and shows the tool count', async () => {
    const api = mockApi({
      mcpGatewayServers: vi.fn().mockResolvedValue(ok([{ id: 'local', command: 'npx' }])),
      mcpGatewayTest: vi.fn().mockResolvedValue(ok({ ok: true, tools: 7 })),
    })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-server-local')
    fireEvent.click(screen.getByTestId('mcp-test-local'))
    await waitFor(() => expect(screen.getByTestId('mcp-server-status-local').textContent).toBe('7 tools'))
    expect(api.mcpGatewayTest).toHaveBeenCalledWith('local')
  })

  it('shows the reason a probe failed', async () => {
    mockApi({
      mcpGatewayServers: vi.fn().mockResolvedValue(ok([{ id: 'local', command: 'npx' }])),
      mcpGatewayTest: vi.fn().mockResolvedValue(ok({ ok: false, error: 'ENOENT npx' })),
    })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-server-local')
    fireEvent.click(screen.getByTestId('mcp-test-local'))
    await waitFor(() => expect(screen.getByTestId('mcp-server-status-local').textContent).toBe('ENOENT npx'))
  })

  it('surfaces a refused probe as a panel error', async () => {
    mockApi({
      mcpGatewayServers: vi.fn().mockResolvedValue(ok([{ id: 'local', command: 'npx' }])),
      mcpGatewayTest: vi.fn().mockResolvedValue(fail('Server id is required')),
    })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-server-local')
    fireEvent.click(screen.getByTestId('mcp-test-local'))
    await screen.findByTestId('mcp-error')
    expect(screen.getByTestId('mcp-server-status-local').textContent).toBe('configured')
  })

  it('persists a policy change and renders the sanitized answer', async () => {
    const api = mockApi({
      mcpGatewaySetPolicy: vi.fn().mockResolvedValue(ok(policy({ defaultDecision: 'ask' }))),
    })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-policy')
    fireEvent.click(screen.getByTestId('mcp-policy-allow'))
    await waitFor(() => expect(api.mcpGatewaySetPolicy).toHaveBeenCalled())
    expect(api.mcpGatewaySetPolicy).toHaveBeenCalledWith({ enabled: true, defaultDecision: 'allow', strict: false, rules: [] })
    // Main refused to store `allow` and said so; the panel shows what is stored.
    expect(screen.getByTestId('mcp-policy-ask').className).toContain('#0e639c')
  })

  it('toggles the gateway on and off', async () => {
    const api = mockApi({ mcpGatewaySetPolicy: vi.fn().mockResolvedValue(ok(policy({ enabled: false }))) })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-policy')
    fireEvent.click(screen.getByTestId('mcp-policy-enabled'))
    await waitFor(() => expect(api.mcpGatewaySetPolicy).toHaveBeenCalled())
    expect((screen.getByTestId('mcp-policy-enabled') as HTMLInputElement).checked).toBe(false)
  })

  it('reports a refused policy write', async () => {
    mockApi({ mcpGatewaySetPolicy: vi.fn().mockResolvedValue(fail('disk full')) })
    render(<McpServersSettings />)
    await screen.findByTestId('mcp-policy')
    fireEvent.click(screen.getByTestId('mcp-policy-deny'))
    await screen.findByTestId('mcp-error')
    expect(screen.getByTestId('mcp-error').textContent).toContain('disk full')
  })

  it('counts remembered rules', async () => {
    mockApi({
      mcpGatewayPolicy: vi.fn().mockResolvedValue(ok(policy({ rules: [{ server: 'a', tool: 'b', decision: 'allow' }] }))),
    })
    render(<McpServersSettings />)
    const rules = await screen.findByTestId('mcp-policy-rules')
    expect(rules.textContent).toContain('1 tool rule remembered')
  })

  it('re-reads on Refresh and never on a timer', async () => {
    vi.useFakeTimers()
    const api = mockApi()
    render(<McpServersSettings />)
    await vi.waitFor(() => expect(screen.queryByTestId('mcp-gateway')).toBeTruthy())
    expect(api.mcpInventory).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(120_000)
    expect(api.mcpInventory).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('mcp-refresh'))
    await vi.waitFor(() => expect(api.mcpInventory).toHaveBeenCalledTimes(2))
    vi.useRealTimers()
  })

  it('says when no server is configured anywhere', async () => {
    mockApi({ mcpInventory: vi.fn().mockResolvedValue(ok(inventory({ servers: [] }))) })
    render(<McpServersSettings />)
    expect(await screen.findByTestId('mcp-inventory-empty')).toBeTruthy()
  })

  it('shows a corrupt source with its parse error', async () => {
    mockApi({
      mcpInventory: vi.fn().mockResolvedValue(
        ok(
          inventory({
            sources: [
              { id: 'gemini', label: 'Gemini', path: '/home/me/.gemini/settings.json', status: 'corrupt', error: 'Unexpected token }' },
            ],
          }),
        ),
      ),
    })
    render(<McpServersSettings />)
    const row = await screen.findByTestId('mcp-source-gemini')
    expect(row.textContent).toContain('corrupt')
    expect(row.textContent).toContain('Unexpected token }')
  })

  it('renders an http server by its url', async () => {
    mockApi({ mcpGatewayServers: vi.fn().mockResolvedValue(ok([{ id: 'remote', url: 'https://x.test/mcp' }])) })
    render(<McpServersSettings />)
    const row = await screen.findByTestId('mcp-server-remote')
    expect(row.textContent).toContain('https://x.test/mcp')
  })
})
