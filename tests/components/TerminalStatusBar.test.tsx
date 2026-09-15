import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { TerminalStatusBar } from '../../src/renderer/src/components/StatusBar/TerminalStatusBar'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { __setHomedirForTests } from '../../src/renderer/src/lib/platform'

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
  // Left set, a forced home would silently change how every later path normalizes.
  __setHomedirForTests(null)
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

  // Cost/token tracking was a misleading single-regex scrape of scrollback (it
  // showed a coincidental "<n> tokens" hit, not real usage), so the badge no
  // longer renders it — the bottom-bar ctx% pill is the real signal.
  it('does not render any scraped cost/token text', () => {
    const agent = { name: 'Claude Code', color: '#D97706', icon: 'fa-solid fa-robot' } as any
    render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/repo" agent={agent} />)
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument()
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

  it('gracefully handles getTerminalStatus rejection', async () => {
    const mock = (window as any).termpolis.getTerminalStatus as ReturnType<typeof vi.fn>
    mock.mockRejectedValueOnce(new Error('IPC error'))
    render(<TerminalStatusBar terminalId="t-err" shellType="bash" cwd="/repo" />)
    // Should still render shell, cwd without crashing
    expect(screen.getByText('Bash')).toBeInTheDocument()
  })
})

/**
 * The live-cwd write-back.
 *
 * main already resolves the shell's real directory from its pid on every one of these
 * polls. Nothing consumed it, so on zsh/fish — the shells we inject no OSC 7 into — a
 * `cd` never reached the git mark. These tests exist to keep that value wired.
 */
describe('TerminalStatusBar — publishing the live cwd', () => {
  const statusMock = () => (window as any).termpolis.getTerminalStatus as ReturnType<typeof vi.fn>

  /**
   * Pin the platform these assertions run under.
   *
   * normalizeShellPath is platform-sensitive BY DESIGN: "/moved/repo" is a real directory
   * on POSIX and nothing at all on Windows, where a rooted path matching none of the
   * MSYS/Cygwin/WSL dialects has no derivable equivalent. Under vitest `process` exists,
   * so the normalizer sees whichever machine the suite happens to run on — which made the
   * first version of these tests assert POSIX behaviour on the Windows CI box. Pinning it
   * keeps them meaningful on a developer's Mac and on CI alike, and lets both dialects be
   * covered on one machine.
   */
  const withPlatform = (platform: NodeJS.Platform, run: () => Promise<void>): Promise<void> => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    return run().finally(() => Object.defineProperty(process, 'platform', original))
  }

  const seed = (cwd: string) => {
    useTerminalStore.setState({
      terminals: [{ id: 't1', name: 'one', shellType: 'bash', cwd } as any],
    })
  }

  it('writes the probed directory into the store so the git mark follows a cd', () =>
    withPlatform('linux', async () => {
      seed('/start')
      statusMock().mockResolvedValueOnce({ success: true, data: { gitBranch: '', cwd: '/moved/repo' } })
      render(<TerminalStatusBar terminalId="t1" shellType="zsh" cwd="/start" />)
      await waitFor(() => {
        expect(useTerminalStore.getState().terminals[0].cwd).toBe('/moved/repo')
      })
    }))

  it('normalizes a Windows-dialect probe result before storing it', () =>
    withPlatform('win32', async () => {
      // Belt and braces: the probe answers null on Windows today, so this is really
      // guarding the normalizer's contract — whatever a future probe reports there gets
      // stored in the one form `git -C` can open, not in a shell's own dialect.
      seed('C:\\start')
      statusMock().mockResolvedValueOnce({ success: true, data: { gitBranch: '', cwd: 'C:/moved/repo' } })
      render(<TerminalStatusBar terminalId="t1" shellType="powershell" cwd="C:\\start" />)
      await waitFor(() => {
        expect(useTerminalStore.getState().terminals[0].cwd).toBe('C:\\moved\\repo')
      })
    }))

  it('leaves the store alone when the directory has not actually changed', () =>
    withPlatform('linux', async () => {
      // Windows takes this path on every poll: the pid probe returns null there and main
      // echoes back the cwd we passed in. A write per poll would replace the terminals
      // array and re-render every sidebar row 12 times a minute for nothing.
      seed('/start')
      const spy = vi.spyOn(useTerminalStore.getState(), 'updateTerminal')
      statusMock().mockResolvedValueOnce({ success: true, data: { gitBranch: '', cwd: '/start' } })
      render(<TerminalStatusBar terminalId="t1" shellType="powershell" cwd="/start" />)
      await waitFor(() => expect(statusMock()).toHaveBeenCalled())
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }))

  it('ignores a trailing-separator-only difference', () =>
    withPlatform('linux', async () => {
      seed('/start')
      const spy = vi.spyOn(useTerminalStore.getState(), 'updateTerminal')
      statusMock().mockResolvedValueOnce({ success: true, data: { gitBranch: '', cwd: '/start/' } })
      render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/start" />)
      await waitFor(() => expect(statusMock()).toHaveBeenCalled())
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }))

  it('ignores an unusable probe result rather than storing it', () =>
    withPlatform('linux', async () => {
      // A relative fragment is not a directory we can run git in. Storing it would point
      // the mark at the wrong repo, which is worse than pointing it at none.
      seed('/start')
      statusMock().mockResolvedValueOnce({ success: true, data: { gitBranch: '', cwd: 'not/absolute' } })
      render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/start" />)
      await waitFor(() => expect(statusMock()).toHaveBeenCalled())
      expect(useTerminalStore.getState().terminals[0].cwd).toBe('/start')
    }))

  it('survives a payload with no cwd at all', () =>
    withPlatform('linux', async () => {
      seed('/start')
      statusMock().mockResolvedValueOnce({ success: true, data: { gitBranch: 'main' } })
      render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/start" />)
      await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument())
      expect(useTerminalStore.getState().terminals[0].cwd).toBe('/start')
    }))

  // The regression this pins is not in the normalizer — cwdPath already expanded `~` when handed
  // a homedir — but in the CALL SITE failing to hand it one. The renderer has no `process`, so
  // every consumer omitted the option, the tilde reached the store verbatim, `git -C '~/repos/x'`
  // could not chdir, and the terminal tab's git mark sat dim and inert inside a repository full
  // of uncommitted changes. Asserting an absolute result is what proves the target was supplied.
  it('expands a tilde from the probe, so git can chdir to what it stores', () =>
    withPlatform('linux', async () => {
      __setHomedirForTests('/home/dev')
      seed('/start')
      statusMock().mockResolvedValueOnce({ success: true, data: { gitBranch: '', cwd: '~/repos/x' } })
      render(<TerminalStatusBar terminalId="t1" shellType="bash" cwd="/start" />)
      await waitFor(() => {
        expect(useTerminalStore.getState().terminals[0].cwd).toBe('/home/dev/repos/x')
      })
    }))
})
