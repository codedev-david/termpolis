import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AgentIntegrationChange, AgentIntegrationStatus } from '../../src/shared/agentIntegration'
import { AgentIntegrationSettings } from '../../src/renderer/src/components/SettingsPane/AgentIntegrationSettings'

const HOME = '/home/me'

function status(over: Partial<AgentIntegrationStatus> = {}): AgentIntegrationStatus {
  return {
    consent: 'granted',
    legacyDetected: false,
    connected: true,
    primerHook: true,
    agents: {
      claude: { installed: true, configPath: `${HOME}/.claude/settings.json`, registered: true },
      codex: { installed: true, configPath: `${HOME}/.codex/config.toml`, registered: true },
      gemini: { installed: false, configPath: `${HOME}/.gemini/settings.json`, registered: false },
    },
    autoAllowedTools: ['memory_search', 'code_search'],
    trustedFolders: [],
    codexHomeTrusted: false,
    ...over,
  }
}

function bridge(initial: AgentIntegrationStatus | null = status(), over: Record<string, unknown> = {}) {
  const api = {
    agentIntegrationStatus: vi.fn(async () => ({ success: true, data: initial })),
    agentIntegrationSet: vi.fn(async (req: { connect: boolean; primerHook?: boolean }) => ({
      success: true,
      data: {
        status: status(req.connect
          ? { primerHook: req.primerHook ?? true }
          : { consent: 'declined', connected: false }),
        changes: [] as AgentIntegrationChange[],
      },
    })),
    agentRemoveCodexHomeTrust: vi.fn(async () => ({ success: true, data: { changed: true } })),
    ...over,
  }
  ;(window as any).termpolis = api
  return api
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

async function renderLoaded() {
  render(<AgentIntegrationSettings />)
  return screen.findByTestId('agent-integration-status')
}

const toggle = () => screen.getByTestId('agent-integration-toggle') as HTMLButtonElement
const hookBox = () => screen.getByTestId('agent-integration-primer-hook') as HTMLInputElement

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as any).termpolis
})

describe('AgentIntegrationSettings: reading the status', () => {
  it('says it is reading until main answers', async () => {
    const pending = deferred<unknown>()
    bridge(null, { agentIntegrationStatus: vi.fn(() => pending.promise) })
    render(<AgentIntegrationSettings />)
    expect(screen.getByTestId('agent-integration-loading')).toHaveTextContent('Reading agent configs…')
    expect(screen.getByRole('heading', { name: 'Agent Integration' })).toBeInTheDocument()
    pending.resolve({ success: true, data: status() })
    expect(await screen.findByTestId('agent-integration-status')).toHaveTextContent('Connected')
    expect(screen.queryByTestId('agent-integration-loading')).toBeNull()
  })

  it('shows why the status could not be read, and tries again on request', async () => {
    const api = bridge(null, {
      agentIntegrationStatus: vi.fn()
        .mockResolvedValueOnce({ success: false, error: 'config unreadable' })
        .mockResolvedValueOnce({ success: true, data: status() }),
    })
    render(<AgentIntegrationSettings />)
    const err = await screen.findByTestId('agent-integration-load-error')
    expect(err).toHaveTextContent("Couldn't read what is connected: config unreadable")
    fireEvent.click(within(err).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('agent-integration-status')).toHaveTextContent('Connected')
    expect(api.agentIntegrationStatus).toHaveBeenCalledTimes(2)
  })

  it('shows a thrown error, whatever was thrown', async () => {
    bridge(null, { agentIntegrationStatus: vi.fn(async () => { throw new Error('ipc gone') }) })
    const { unmount } = render(<AgentIntegrationSettings />)
    expect(await screen.findByTestId('agent-integration-load-error')).toHaveTextContent('ipc gone')
    unmount()
    bridge(null, { agentIntegrationStatus: vi.fn(() => Promise.reject('plain string')) })
    render(<AgentIntegrationSettings />)
    expect(await screen.findByTestId('agent-integration-load-error')).toHaveTextContent('plain string')
  })
})

describe('AgentIntegrationSettings: status line', () => {
  it('says Connected when consent is granted', async () => {
    bridge(status())
    expect((await renderLoaded()).textContent).toBe('Connected')
  })

  it('says Not connected when declined, or never asked and never written', async () => {
    bridge(status({ consent: 'declined', connected: false }))
    const { unmount } = render(<AgentIntegrationSettings />)
    expect((await screen.findByTestId('agent-integration-status')).textContent).toBe('Not connected')
    unmount()
    bridge(status({ consent: null, connected: false }))
    expect((await renderLoaded()).textContent).toBe('Not connected')
  })

  it('flags a connection an earlier version made that has not been reviewed', async () => {
    bridge(status({ consent: null, legacyDetected: true, connected: true }))
    expect((await renderLoaded()).textContent).toBe('Connected by an earlier version — not yet reviewed')
  })
})

describe('AgentIntegrationSettings: connecting and disconnecting', () => {
  it('disconnects from the switch and shows what changed', async () => {
    const api = bridge()
    api.agentIntegrationSet.mockImplementationOnce(async () => ({
      success: true,
      data: {
        status: status({ consent: 'declined', connected: false }),
        changes: [
          { agent: 'claude', file: `${HOME}/.claude/settings.json`, action: 'remove', what: 'MCP server `termpolis`' },
          { agent: 'codex', file: '/etc/codex.toml', action: 'skipped', what: 'MCP server `termpolis`', error: 'file is read-only' },
        ] as AgentIntegrationChange[],
      },
    }))
    await renderLoaded()
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(toggle()).toHaveAccessibleName('Connect Termpolis to Claude Code, Codex and Gemini CLI')
    fireEvent.click(toggle())
    await waitFor(() => expect(screen.getByTestId('agent-integration-status').textContent).toBe('Not connected'))
    expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: false })
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    const rows = screen.getAllByTestId('agent-integration-change')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Removed')
    expect(rows[0].textContent).toContain('MCP server `termpolis`')
    expect(rows[0].textContent).toContain('~/.claude/settings.json')
    expect(rows[1].textContent).toContain('Skipped')
    expect(rows[1].textContent).toContain('/etc/codex.toml')
    expect(rows[1].textContent).toContain('file is read-only')
    // Nothing left to disconnect, and the hook needs a connection.
    expect(screen.queryByTestId('agent-integration-disconnect')).toBeNull()
    expect(hookBox()).toBeDisabled()
    expect(hookBox().closest('label')!.className).toContain('opacity-50')
  })

  it('connects from the switch, keeping the recorded hook choice', async () => {
    const api = bridge(status({ consent: 'declined', connected: false, primerHook: false }))
    await renderLoaded()
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle())
    await waitFor(() => expect(screen.getByTestId('agent-integration-status').textContent).toBe('Connected'))
    expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: true, primerHook: false })
    expect(screen.getByTestId('agent-integration-changes')).toHaveTextContent('Nothing needed to change.')
    expect(screen.getByTestId('agent-integration-disconnect')).toBeInTheDocument()
  })

  it('turns the hook on and off while connected', async () => {
    const api = bridge(status({ primerHook: true }))
    await renderLoaded()
    expect(hookBox()).toBeEnabled()
    expect(hookBox().checked).toBe(true)
    expect(hookBox().closest('label')!.className).toContain('cursor-pointer')
    fireEvent.click(hookBox())
    await waitFor(() => expect(hookBox().checked).toBe(false))
    expect(api.agentIntegrationSet).toHaveBeenLastCalledWith({ connect: true, primerHook: false })
    fireEvent.click(hookBox())
    await waitFor(() => expect(hookBox().checked).toBe(true))
    expect(api.agentIntegrationSet).toHaveBeenLastCalledWith({ connect: true, primerHook: true })
  })

  it('disconnects from the button, which says what it undoes', async () => {
    const api = bridge()
    await renderLoaded()
    const button = screen.getByTestId('agent-integration-disconnect')
    expect(button.parentElement).toHaveTextContent('Removes everything Termpolis wrote into their configs. Folders trusted before v1.49 stay trusted.')
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByTestId('agent-integration-status').textContent).toBe('Not connected'))
    expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: false })
  })

  it('locks every control while an action runs, and clears the last report', async () => {
    const pending = deferred<unknown>()
    const api = bridge()
    await renderLoaded()
    fireEvent.click(hookBox())
    await screen.findByTestId('agent-integration-changes')
    api.agentIntegrationSet.mockImplementationOnce(() => pending.promise as never)
    fireEvent.click(screen.getByTestId('agent-integration-disconnect'))
    await waitFor(() => expect(toggle()).toBeDisabled())
    expect(hookBox()).toBeDisabled()
    expect(screen.getByTestId('agent-integration-disconnect')).toBeDisabled()
    expect(screen.queryByTestId('agent-integration-changes')).toBeNull()
    pending.resolve({ success: true, data: { status: status({ consent: 'declined', connected: false }), changes: [] } })
    await waitFor(() => expect(toggle()).toBeEnabled())
    expect(screen.getByTestId('agent-integration-changes')).toBeInTheDocument()
  })

  it('shows an action main refused, and a thrown one, until the next action', async () => {
    const api = bridge()
    api.agentIntegrationSet.mockImplementationOnce(async () => ({ success: false, error: 'settings.json is locked' }) as never)
    await renderLoaded()
    fireEvent.click(toggle())
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.json is locked')
    expect(screen.queryByTestId('agent-integration-changes')).toBeNull()
    // Still connected: nothing changed.
    expect(screen.getByTestId('agent-integration-status').textContent).toBe('Connected')
    api.agentIntegrationSet.mockImplementationOnce(() => Promise.reject('plain string'))
    fireEvent.click(toggle())
    await waitFor(() => expect(screen.getByTestId('agent-integration-error')).toHaveTextContent('plain string'))
    fireEvent.click(toggle())
    await waitFor(() => expect(screen.queryByTestId('agent-integration-error')).toBeNull())
  })
})

describe('AgentIntegrationSettings: Codex trust for the home folder', () => {
  it('is only mentioned when Codex trusts home', async () => {
    bridge(status({ codexHomeTrusted: false }))
    await renderLoaded()
    expect(screen.queryByTestId('agent-integration-codex-home')).toBeNull()
  })

  it('removes it, re-reads the status and reports the change', async () => {
    const api = bridge(status({ codexHomeTrusted: true }))
    api.agentIntegrationStatus
      .mockResolvedValueOnce({ success: true, data: status({ codexHomeTrusted: true }) })
      .mockResolvedValueOnce({ success: true, data: status({ codexHomeTrusted: false }) })
    await renderLoaded()
    expect(screen.getByTestId('agent-integration-codex-home')).toHaveTextContent('Codex trusts your home folder')
    fireEvent.click(screen.getByTestId('agent-integration-remove-home-trust'))
    await waitFor(() => expect(screen.queryByTestId('agent-integration-codex-home')).toBeNull())
    expect(api.agentRemoveCodexHomeTrust).toHaveBeenCalledTimes(1)
    expect(api.agentIntegrationStatus).toHaveBeenCalledTimes(2)
    const row = await screen.findByTestId('agent-integration-change')
    expect(row.textContent).toContain('Removed')
    expect(row.textContent).toContain('Trust for your home folder')
    expect(row.textContent).toContain('~/.codex/config.toml')
  })

  it('says so when there was nothing to remove', async () => {
    bridge(status({ codexHomeTrusted: true }), {
      agentRemoveCodexHomeTrust: vi.fn(async () => ({ success: true, data: { changed: false } })),
    })
    await renderLoaded()
    fireEvent.click(screen.getByTestId('agent-integration-remove-home-trust'))
    expect(await screen.findByTestId('agent-integration-changes')).toHaveTextContent('Nothing needed to change.')
  })

  it('shows why it could not be removed', async () => {
    bridge(status({ codexHomeTrusted: true }), {
      agentRemoveCodexHomeTrust: vi.fn(async () => ({ success: true, data: { changed: false, error: 'config.toml is not valid TOML' } })),
    })
    const { unmount } = render(<AgentIntegrationSettings />)
    fireEvent.click(await screen.findByTestId('agent-integration-remove-home-trust'))
    expect(await screen.findByTestId('agent-integration-error')).toHaveTextContent('config.toml is not valid TOML')
    unmount()
    bridge(status({ codexHomeTrusted: true }), {
      agentRemoveCodexHomeTrust: vi.fn(async () => ({ success: false, error: 'ipc refused' })),
    })
    render(<AgentIntegrationSettings />)
    fireEvent.click(await screen.findByTestId('agent-integration-remove-home-trust'))
    expect(await screen.findByTestId('agent-integration-error')).toHaveTextContent('ipc refused')
  })
})

describe('AgentIntegrationSettings: what is written', () => {
  it('lists the writes with what is installed, and where', async () => {
    bridge()
    await renderLoaded()
    expect(screen.getByTestId('agent-writes-list')).toBeInTheDocument()
    expect(screen.getByTestId('agent-writes-gemini-installed')).toHaveTextContent('Not installed')
    expect(screen.getByTestId('agent-writes-codex-path').textContent).toBe('~/.codex/config.toml')
  })

  it('lists the tools Claude Code runs without asking, and says the rest ask', async () => {
    bridge(status({ autoAllowedTools: ['memory_search', 'code_search', 'get_file_tree'] }))
    await renderLoaded()
    const tools = screen.getByTestId('agent-integration-tools')
    expect(tools.querySelector('summary')!.textContent).toBe('3 Termpolis tools Claude Code runs without asking, when connected')
    // Inside a closed <details>, so read the DOM rather than the accessibility tree.
    expect([...tools.querySelectorAll('li')].map(li => li.textContent)).toEqual(['memory_search', 'code_search', 'get_file_tree'])
    expect(tools.parentElement).toHaveTextContent('Tools that run commands or type into terminals always ask.')
  })

  it('lists the folders Termpolis marked trusted', async () => {
    bridge(status({ trustedFolders: [`${HOME}/repos/app`, '/srv/work'] }))
    await renderLoaded()
    const trusted = screen.getByTestId('agent-integration-trusted')
    expect(within(trusted).getAllByRole('listitem').map(li => li.textContent)).toEqual(['~/repos/app', '/srv/work'])
    expect(trusted).toHaveTextContent('Disconnect reverts these.')
    expect(trusted).not.toHaveTextContent('None.')
  })

  it('says None when no folder is trusted', async () => {
    bridge(status({ trustedFolders: [] }))
    await renderLoaded()
    const trusted = screen.getByTestId('agent-integration-trusted')
    expect(trusted).toHaveTextContent('None.')
    expect(within(trusted).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('points at the command-line way to undo it', async () => {
    bridge()
    await renderLoaded()
    expect(screen.getByTestId('agent-integration-settings')).toHaveTextContent(
      'Uninstalling? Termpolis --disconnect-agents removes the same things from the command line.',
    )
  })
})
