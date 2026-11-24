// The sidebar's "out of usage" label clears by itself when the limit's window ends, with the real
// store and the real watcher (1.63.1, fix round 1): the label is on screen, time passes the end, and
// it is gone with nobody touching the sidebar.
import React from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/renderer/src/lib/testAgents', () => ({
  resolveAgentCommand: (cmd: string) => cmd,
  testDelay: () => 0,
}))
vi.mock('../../src/renderer/src/lib/homedir', () => ({ getHomedir: vi.fn().mockResolvedValue('/home/user') }))
vi.mock('../../src/renderer/src/lib/terminalDefaults', () => ({
  getTerminalDefaults: () => ({ fontSize: 14, theme: 'dark', fontFamily: 'monospace' }),
  agentTerminalName: (profileName: string) => profileName,
}))

import { AIProfiles } from '../../src/renderer/src/components/Sidebar/AIProfiles'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { watchAccounts } from '../../src/renderer/src/lib/accountsState'
import type { AccountsView } from '../../src/shared/agentAccounts'

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0)
const H = 3_600_000
const shells = [{ type: 'bash' as const, label: 'Bash', executable: '/bin/bash' }]
const acc = (id: string, label: string) => ({ id, agent: 'claude', label })
const view = (limited: boolean): AccountsView => ({
  accounts: [
    acc('acc_a', 'personal'),
    { ...acc('acc_d', 'spare'), ...(limited ? { limitedOutside: NOW, limitedOutsideEnds: NOW + H } : {}) },
  ],
  preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
  advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h',
} as unknown as AccountsView)

let stop: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockResolvedValue({ success: true, data: { claude: true } }),
    memoryPreparePrimerFile: vi.fn().mockResolvedValue({ success: true, data: { file: null, count: 0 } }),
  }
})

afterEach(() => {
  stop?.()
  stop = null
  cleanup()
  vi.useRealTimers()
  delete (window as any).accounts
  useTerminalStore.setState({ accountsView: null })
})

describe('sidebar "out of usage" label while the window ends', () => {
  it('is on screen, and gone once the end has passed, with no other change', async () => {
    const api = { list: vi.fn(async () => ({ success: true as const, data: view(true) })), onTerminalAccount: vi.fn(() => () => undefined) }
    ;(window as any).accounts = api
    stop = watchAccounts(api as never)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    render(<AIProfiles availableShells={shells} />)
    fireEvent.contextMenu(screen.getByText('Claude Code').closest('.group') as HTMLElement)
    const labels = () => screen.getAllByTestId('launch-on-account').map((b) => b.textContent)
    expect(labels()).toEqual(['personal', 'spareout of usage'])

    // Main drops the ended marker too, so its next read has none.
    api.list.mockResolvedValue({ success: true as const, data: view(false) })
    await act(async () => { await vi.advanceTimersByTimeAsync(H - 1000) })
    expect(labels()).toEqual(['personal', 'spareout of usage'])
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(labels()).toEqual(['personal', 'spare'])
    expect(screen.queryByTestId('launch-on-limited')).toBeNull()
  })
})
