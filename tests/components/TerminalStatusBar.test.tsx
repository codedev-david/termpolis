import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { TerminalStatusBar } from '../../src/renderer/src/components/StatusBar/TerminalStatusBar'

// Mock the pollingService module to avoid real subscriptions
vi.mock('../../src/renderer/src/lib/pollingService', () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))

beforeAll(() => {
  ;(window as any).termpolis = {
    ...(window as any).termpolis,
    getTerminalStatus: vi.fn().mockResolvedValue({ success: true, data: { gitBranch: '' } }),
  }
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TerminalStatusBar', () => {
  it('renders shell type', () => {
    render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/home/user" />)
    expect(screen.getByText('Bash')).toBeInTheDocument()
  })

  it('renders cwd', () => {
    render(<TerminalStatusBar terminalId="t1" shellType="powershell" cwd="/home/dev/project" />)
    expect(screen.getByText('/home/dev/project')).toBeInTheDocument()
  })

  it('renders git branch when provided via parsedBranch prop', () => {
    render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/repo" parsedBranch="feature/xyz" />)
    expect(screen.getByText('feature/xyz')).toBeInTheDocument()
  })

  it('shows REC badge when isRecording is true', () => {
    render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/repo" isRecording={true} />)
    expect(screen.getByText('REC')).toBeInTheDocument()
  })

  it('does not show REC badge when isRecording is false', () => {
    render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/repo" isRecording={false} />)
    expect(screen.queryByText('REC')).not.toBeInTheDocument()
  })

  it('renders agent name and icon when agent provided', () => {
    const agent = {
      name: 'Claude Code',
      color: '#c15f3c',
      icon: 'fa-brands fa-claude',
      command: 'claude',
    } as any
    render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/repo" agent={agent} />)
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
  })

  it('does not render the context gauge', () => {
    const agent = { name: 'Claude', color: '#c15f3c', icon: 'fa-brands fa-claude', command: 'claude' } as any
    render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/repo" agent={agent} />)
    expect(screen.queryByTestId('context-gauge')).not.toBeInTheDocument()
  })

  it('renders cost info when agent + costInfo.estimatedCost > 0', async () => {
    const agent = { name: 'Claude', color: '#c15f3c', icon: 'fa-brands fa-claude', command: 'claude' } as any
    const costInfo = { estimatedCost: 0.25, tokensIn: 12345 } as any
    render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/repo" agent={agent} costInfo={costInfo} />)
    // Use regex + findByText: on Windows CI the exact-string getByText('$0.25')
    // timed out at 5s (6612ms). The adjacent test at line ~131 already uses the
    // regex pattern successfully. React splits `$` + `{toFixed}` into sibling
    // text nodes, so normalized text content equality against '$0.25' is fragile.
    expect(await screen.findByText(/\$0\.25/)).toBeInTheDocument()
  })

  it('hides cost info when estimatedCost is 0', () => {
    const agent = { name: 'Claude', color: '#c15f3c', icon: 'fa-brands fa-claude', command: 'claude' } as any
    const costInfo = { estimatedCost: 0, tokensIn: 0 } as any
    render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/repo" agent={agent} costInfo={costInfo} />)
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument()
  })

  it('renders each shell label correctly', () => {
    const shells: Array<[string, string]> = [
      ['bash', 'Bash'],
      ['zsh', 'Zsh'],
      ['cmd', 'CMD'],
      ['powershell', 'PowerShell'],
      ['gitbash', 'Git Bash'],
    ]
    for (const [type, label] of shells) {
      const { unmount } = render(<TerminalStatusBar terminalId="t1" shellType={type as any} cwd="/repo" />)
      expect(screen.getByText(label)).toBeInTheDocument()
      unmount()
    }
  })

  it('falls back to shellType string when label missing', () => {
    render(<TerminalStatusBar terminalId="t1" shellType={'unknown' as any} cwd="/repo" />)
    expect(screen.getByText('unknown')).toBeInTheDocument()
  })

  it('uses IPC branch when parsedBranch not provided', async () => {
    const mock = (window as any).termpolis.getTerminalStatus as ReturnType<typeof vi.fn>
    mock.mockResolvedValueOnce({ success: true, data: { gitBranch: 'main' } })
    render(<TerminalStatusBar terminalId="t-ipc" shellType="bash" cwd="/repo" />)
    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument()
    })
  })

  it('prefers parsedBranch over IPC branch', async () => {
    const mock = (window as any).termpolis.getTerminalStatus as ReturnType<typeof vi.fn>
    mock.mockResolvedValueOnce({ success: true, data: { gitBranch: 'ipc-branch' } })
    render(
      <TerminalStatusBar
        terminalId="t-pref"
        shellType="bash"
        cwd="/repo"
        parsedBranch="parsed-branch"
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('parsed-branch')).toBeInTheDocument()
      expect(screen.queryByText('ipc-branch')).not.toBeInTheDocument()
    })
  })

  it('displays token count when tokensIn > 0', () => {
    const agent = { name: 'Claude', color: '#c15f3c', icon: 'fa-brands fa-claude', command: 'claude' } as any
    const costInfo = { estimatedCost: 0.5, tokensIn: 1500 } as any
    render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/repo" agent={agent} costInfo={costInfo} />)
    expect(screen.getByText(/tokens/)).toBeInTheDocument()
  })

  it('gracefully handles getTerminalStatus rejection', async () => {
    const mock = (window as any).termpolis.getTerminalStatus as ReturnType<typeof vi.fn>
    mock.mockRejectedValueOnce(new Error('IPC error'))
    render(<TerminalStatusBar terminalId="t-err" shellType="bash" cwd="/repo" />)
    // Should still render shell, cwd without crashing
    expect(screen.getByText('Bash')).toBeInTheDocument()
  })
})
