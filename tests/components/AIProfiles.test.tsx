import React from 'react'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing component
vi.mock('../../src/renderer/src/lib/testAgents', () => ({
  resolveAgentCommand: (cmd: string) => cmd,
  testDelay: (ms: number) => 0,
}))

vi.mock('../../src/renderer/src/lib/homedir', () => ({
  getHomedir: vi.fn().mockResolvedValue('/home/user'),
}))

vi.mock('../../src/renderer/src/lib/terminalDefaults', () => ({
  getTerminalDefaults: () => ({ fontSize: 14, theme: 'dark', fontFamily: 'monospace' }),
  agentTerminalName: (profileName: string) => profileName,
}))

vi.mock('../../src/renderer/src/components/InstallHint/InstallHint', () => ({
  InstallHint: ({ agentId, agentName, onClose }: any) => (
    <div data-testid="install-hint">
      <span data-testid="install-hint-agent">{agentName}</span>
      <span data-testid="install-hint-id">{agentId}</span>
      <button onClick={onClose}>Close Hint</button>
    </div>
  ),
}))

const mockAddTerminal = vi.fn()
const mockSetLaunchingAgent = vi.fn()
const mockAddAIProfile = vi.fn()
const mockRemoveAIProfile = vi.fn()
const mockSetMemoryNotice = vi.fn()
let mockAiProfiles: any[] = []
let mockAccountsView: any = null

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        aiProfiles: mockAiProfiles,
        addAIProfile: mockAddAIProfile,
        removeAIProfile: mockRemoveAIProfile,
        addTerminal: mockAddTerminal,
        setLaunchingAgent: mockSetLaunchingAgent,
        setMemoryNotice: mockSetMemoryNotice,
        accountsView: mockAccountsView,
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        aiProfiles: mockAiProfiles,
        addAIProfile: mockAddAIProfile,
        removeAIProfile: mockRemoveAIProfile,
        addTerminal: mockAddTerminal,
        setLaunchingAgent: mockSetLaunchingAgent,
        setMemoryNotice: mockSetMemoryNotice,
      })),
      setState: vi.fn(),
    },
  ),
}))

let mockInstalledAgents: Record<string, boolean> = {}

beforeEach(() => {
  vi.clearAllMocks()
  mockAiProfiles = []
  mockAccountsView = null
  delete (window as any).accounts
  mockInstalledAgents = { claude: true, codex: true, gemini: false }
  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockImplementation(() =>
      Promise.resolve({ success: true, data: mockInstalledAgents })
    ),
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/test/project' }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
    memoryPreparePrimerFile: vi.fn().mockResolvedValue({ success: true, data: { file: null, count: 0 } }),
    memoryPrepareCodexContext: vi.fn().mockResolvedValue({ success: true, data: { developerInstructions: null, approvals: 0 } }),
  }
})

import { AIProfiles } from '../../src/renderer/src/components/Sidebar/AIProfiles'

const defaultShells = [
  { type: 'bash' as const, label: 'Bash', executable: '/bin/bash' },
  { type: 'gitbash' as const, label: 'Git Bash', executable: 'C:\\Program Files\\Git\\bin\\bash.exe' },
]

describe('AIProfiles', () => {
  describe('Launch on ▸ an account (right-click)', () => {
    const acc = (id: string, agent: string, label: string, color?: string) => ({ id, agent, label, ...(color ? { color } : {}) })
    beforeEach(() => {
      mockAccountsView = { accounts: [acc('acc_a', 'claude', 'personal'), acc('acc_b', 'claude', 'codedev', '#123456'), acc('acc_c', 'codex', 'solo'), acc('g1', 'agy', 'home'), acc('g2', 'agy', 'work')] }
      ;(window as any).accounts = {
        launchAccount: vi.fn(async (_agent: string, id: string | null) => ({ success: true, data: { accountId: id } })),
        launchLine: vi.fn(async (req: any) => ({ success: true, data: { line: req.command, accountId: req.accountId, explicit: true } })),
      }
    })

    it("lists the agent's accounts and launches on the one picked", async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => expect((window as any).termpolis.detectAgents).toHaveBeenCalled())
      const row = screen.getByText('Claude Code').closest('.group') as HTMLElement
      fireEvent.contextMenu(row)
      const items = screen.getAllByTestId('launch-on-account')
      expect(items.map((b) => b.textContent)).toEqual(['personal', 'codedev'])
      fireEvent.click(items[1])
      await waitFor(() => expect((window as any).accounts.launchAccount).toHaveBeenCalledWith('claude', 'acc_b'))
      expect(screen.queryByTestId('launch-on-menu')).toBeNull()
    })

    it('opens no menu for an agent with one account, and a second right-click closes it', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      const codex = screen.getByText('OpenAI Codex').closest('.group') as HTMLElement
      fireEvent.contextMenu(codex)
      expect(screen.queryByTestId('launch-on-menu')).toBeNull()
      const claude = screen.getByText('Claude Code').closest('.group') as HTMLElement
      fireEvent.contextMenu(claude)
      expect(screen.getByTestId('launch-on-menu')).toBeInTheDocument()
      fireEvent.contextMenu(claude)
      expect(screen.queryByTestId('launch-on-menu')).toBeNull()
    })

    it("shows how to install an agent that isn't installed instead of launching it", async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => expect((window as any).termpolis.detectAgents).toHaveBeenCalled())
      await waitFor(() => expect(screen.getByTitle('Gemini / Antigravity CLI not installed — click for setup instructions')).toBeInTheDocument())
      fireEvent.contextMenu(screen.getByText('Gemini / Antigravity CLI').closest('.group') as HTMLElement)
      fireEvent.click(screen.getAllByTestId('launch-on-account')[0])
      expect(screen.getByTestId('install-hint-id')).toHaveTextContent('gemini')
      expect((window as any).accounts.launchAccount).not.toHaveBeenCalled()
    })

    it('marks an account that is out of usage in the list, with when it is back, and no other', async () => {
      const soon = Date.now() + 3 * 3_600_000
      mockAccountsView = { accounts: [{ ...acc('acc_a', 'claude', 'personal'), limit: { seenAt: 1, resetsAt: soon, text: 'x', scope: 'account' } }, acc('acc_b', 'claude', 'codedev'), { ...acc('acc_d', 'claude', 'noted'), limit: { seenAt: 1, resetsAt: null, text: 'x', scope: 'account' } }, { ...acc('acc_e', 'claude', 'model'), limit: { seenAt: 1, resetsAt: soon, text: 'x', scope: 'model' } }], preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h' }
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.contextMenu(screen.getByText('Claude Code').closest('.group') as HTMLElement)
      const items = screen.getAllByTestId('launch-on-account')
      expect(items.map((b) => b.textContent)).toEqual([expect.stringMatching(/^personalout of usage until /), 'codedev', 'notedout of usage', 'model'])
      expect(screen.getAllByTestId('launch-on-limited')).toHaveLength(2)
    })

    it('is reachable without a mouse: a button on the profile opens the same list, with menu semantics and arrow keys', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => expect((window as any).termpolis.detectAgents).toHaveBeenCalled())
      const claude = screen.getByText('Claude Code').closest('.group') as HTMLElement
      const opener = within(claude).getByTestId('launch-on-open')
      expect(opener).toHaveAccessibleName('Launch Claude Code on an account')
      expect(opener).toHaveAttribute('aria-haspopup', 'menu')
      expect(opener).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(opener)
      expect(opener).toHaveAttribute('aria-expanded', 'true')
      const menu = screen.getByTestId('launch-on-menu')
      expect(menu).toHaveAttribute('role', 'menu')
      const items = screen.getAllByTestId('launch-on-account')
      expect(items.map((b) => b.getAttribute('role'))).toEqual(['menuitem', 'menuitem'])
      // The first account takes the focus; the arrows go round; Esc closes it and gives the focus back.
      expect(document.activeElement).toBe(items[0])
      fireEvent.keyDown(menu, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(items[1])
      fireEvent.keyDown(menu, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(items[0])
      fireEvent.keyDown(menu, { key: 'ArrowUp' })
      expect(document.activeElement).toBe(items[1])
      fireEvent.keyDown(menu, { key: 'Home' })
      expect(document.activeElement).toBe(items[0])
      fireEvent.keyDown(menu, { key: 'End' })
      expect(document.activeElement).toBe(items[1])
      fireEvent.keyDown(menu, { key: 'x' })
      expect(document.activeElement).toBe(items[1])
      fireEvent.keyDown(menu, { key: 'Escape' })
      expect(screen.queryByTestId('launch-on-menu')).toBeNull()
      expect(document.activeElement).toBe(opener)
      // Pressing it again opens, and again closes.
      fireEvent.click(opener)
      expect(screen.getByTestId('launch-on-menu')).toBeInTheDocument()
      fireEvent.click(opener)
      expect(screen.queryByTestId('launch-on-menu')).toBeNull()
    })

    it('has the button only for an agent with more than one account (D13), and none before the accounts are read', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      const codex = screen.getByText('OpenAI Codex').closest('.group') as HTMLElement
      expect(within(codex).queryByTestId('launch-on-open')).toBeNull()
      cleanup()
      mockAccountsView = null
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.queryByTestId('launch-on-open')).toBeNull()
    })

    it('launches on the account picked with Enter from the keyboard', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => expect((window as any).termpolis.detectAgents).toHaveBeenCalled())
      fireEvent.click(within(screen.getByText('Claude Code').closest('.group') as HTMLElement).getByTestId('launch-on-open'))
      const items = screen.getAllByTestId('launch-on-account')
      fireEvent.keyDown(screen.getByTestId('launch-on-menu'), { key: 'ArrowDown' })
      // A button takes Enter as a click.
      fireEvent.click(document.activeElement as HTMLElement)
      await waitFor(() => expect((window as any).accounts.launchAccount).toHaveBeenCalledWith('claude', items[1] ? 'acc_b' : ''))
    })

    it('opens no menu before the accounts are read', () => {
      mockAccountsView = null
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.contextMenu(screen.getByText('Claude Code').closest('.group') as HTMLElement)
      expect(screen.queryByTestId('launch-on-menu')).toBeNull()
    })
  })

  describe('rendering', () => {
    it('renders all three default AI agent profiles', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByText('Claude Code')).toBeInTheDocument()
      expect(screen.getByText('OpenAI Codex')).toBeInTheDocument()
      expect(screen.getByText('Gemini / Antigravity CLI')).toBeInTheDocument()
    })

    it('renders custom profiles alongside defaults', async () => {
      mockAiProfiles = [
        { id: 'custom1', name: 'My Custom Agent', icon: 'fa-solid fa-star', command: 'my-agent', shell: 'bash', color: '#FF0000' },
      ]
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByText('Claude Code')).toBeInTheDocument()
      expect(screen.getByText('My Custom Agent')).toBeInTheDocument()
    })

    it('shows AI Agents section header', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByText('AI Agents')).toBeInTheDocument()
    })

    it('shows + button to add custom profile', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByTitle('Add custom AI profile')).toBeInTheDocument()
    })
  })

  describe('installed/not-installed indicators', () => {
    it('shows green check icon for installed agents after detection', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        const checks = document.querySelectorAll('.fa-circle-check')
        expect(checks.length).toBe(2) // claude and codex
      })
    })

    it('shows red X icon for not-installed agents after detection', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        const xMarks = document.querySelectorAll('.fa-circle-xmark')
        expect(xMarks.length).toBe(1) // gemini
      })
    })

    it('shows all green checks when all agents installed', async () => {
      mockInstalledAgents = { claude: true, codex: true, gemini: true }
      ;(window as any).termpolis.detectAgents = vi.fn().mockResolvedValue({
        success: true,
        data: mockInstalledAgents,
      })
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        const checks = document.querySelectorAll('.fa-circle-check')
        expect(checks.length).toBe(3)
      })
      expect(document.querySelectorAll('.fa-circle-xmark').length).toBe(0)
    })

    it('does not show indicators while still detecting', async () => {
      // detectAgents never resolves during initial render check
      ;(window as any).termpolis.detectAgents = vi.fn().mockReturnValue(new Promise(() => {}))
      render(<AIProfiles availableShells={defaultShells} />)
      // No indicators shown while detecting
      expect(document.querySelectorAll('.fa-circle-check').length).toBe(0)
      expect(document.querySelectorAll('.fa-circle-xmark').length).toBe(0)
    })
  })

  describe('install hint interactions', () => {
    it('opens install hint when not-installed red X icon is clicked', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-xmark').length).toBeGreaterThan(0)
      })
      const xButton = document.querySelector('.fa-circle-xmark')!.closest('button')!
      fireEvent.click(xButton)
      expect(screen.getByTestId('install-hint')).toBeInTheDocument()
    })

    it('opens install hint when clicking an uninstalled agent name', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-xmark').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Gemini / Antigravity CLI'))
      expect(screen.getByTestId('install-hint')).toBeInTheDocument()
      expect(screen.getByTestId('install-hint-agent')).toHaveTextContent('Gemini / Antigravity CLI')
    })

    it('closes install hint when close button is clicked', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-xmark').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Gemini / Antigravity CLI'))
      expect(screen.getByTestId('install-hint')).toBeInTheDocument()
      fireEvent.click(screen.getByText('Close Hint'))
      expect(screen.queryByTestId('install-hint')).not.toBeInTheDocument()
    })
  })

  describe('launching agents', () => {
    it('clicking an installed agent calls pickDirectory and createTerminal', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Claude Code'))
      await waitFor(() => {
        expect((window as any).termpolis.pickDirectory).toHaveBeenCalled()
      })
      await waitFor(() => {
        expect((window as any).termpolis.createTerminal).toHaveBeenCalled()
      })
      expect(mockSetLaunchingAgent).toHaveBeenCalledWith('Claude Code')
      expect(mockAddTerminal).toHaveBeenCalled()
    })

    it('does not launch if pickDirectory is cancelled', async () => {
      ;(window as any).termpolis.pickDirectory = vi.fn().mockResolvedValue({ success: true, data: null })
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Claude Code'))
      await waitFor(() => {
        expect((window as any).termpolis.pickDirectory).toHaveBeenCalled()
      })
      expect((window as any).termpolis.createTerminal).not.toHaveBeenCalled()
      expect(mockAddTerminal).not.toHaveBeenCalled()
    })

    it('does not launch if pickDirectory fails', async () => {
      ;(window as any).termpolis.pickDirectory = vi.fn().mockResolvedValue({ success: false })
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Claude Code'))
      await waitFor(() => {
        expect((window as any).termpolis.pickDirectory).toHaveBeenCalled()
      })
      expect((window as any).termpolis.createTerminal).not.toHaveBeenCalled()
    })

    it('shows alert when createTerminal fails', async () => {
      ;(window as any).termpolis.createTerminal = vi.fn().mockResolvedValue({ success: false, error: 'spawn failed' })
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Claude Code'))
      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith('Failed to open terminal: spawn failed')
      })
      expect(mockSetLaunchingAgent).toHaveBeenCalledWith(null)
      alertSpy.mockRestore()
    })

    it('calls addTerminal with agentCommand on successful launch', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Claude Code'))
      await waitFor(() => {
        expect(mockAddTerminal).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Claude Code',
            agentCommand: 'claude',
          }),
        )
      })
    })

    it('Claude launch seeds memory via --append-system-prompt-file when memory exists', async () => {
      ;(window as any).termpolis.memoryPreparePrimerFile = vi.fn().mockResolvedValue({
        success: true, data: { file: 'C:\\Users\\me\\AppData\\primers\\primer-x.txt', count: 5 },
      })
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Claude Code'))
      await waitFor(() => {
        expect(mockAddTerminal).toHaveBeenCalledWith(expect.objectContaining({ launchPrimed: true }))
      })
      // The launch command carries the system-prompt file (forward-slashed path),
      // so the primer never gets typed visibly into the terminal.
      await waitFor(() => {
        const calls = (window as any).termpolis.writeToTerminal.mock.calls
        const seeded = calls.some((c: any[]) =>
          typeof c[1] === 'string' &&
          c[1].includes('--append-system-prompt-file') &&
          c[1].includes('primers/primer-x.txt'),
        )
        expect(seeded).toBe(true)
      }, { timeout: 3000 })
    }, 10000)

    it('Claude launch stays bare when there is no relevant memory', async () => {
      ;(window as any).termpolis.memoryPreparePrimerFile = vi.fn().mockResolvedValue({ success: true, data: { file: null, count: 0 } })
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Claude Code'))
      await waitFor(() => {
        const calls = (window as any).termpolis.writeToTerminal.mock.calls
        expect(calls.some((c: any[]) => c[1] === 'claude\r')).toBe(true)
      }, { timeout: 3000 })
      expect(mockAddTerminal).toHaveBeenCalledWith(expect.objectContaining({ launchPrimed: false }))
    }, 10000)
  })

  describe('collapse/expand', () => {
    it('collapses agent list when header is clicked', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByText('Claude Code')).toBeInTheDocument()
      fireEvent.click(screen.getByText('AI Agents'))
      expect(screen.queryByText('Claude Code')).not.toBeInTheDocument()
    })

    it('re-expands agent list when header is clicked again', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.click(screen.getByText('AI Agents'))
      expect(screen.queryByText('Claude Code')).not.toBeInTheDocument()
      fireEvent.click(screen.getByText('AI Agents'))
      expect(screen.getByText('Claude Code')).toBeInTheDocument()
    })
  })

  describe('add custom profile modal', () => {
    it('opens add profile modal when + button is clicked', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.click(screen.getByTitle('Add custom AI profile'))
      expect(screen.getByText('Add AI Profile')).toBeInTheDocument()
    })

    it('closes add profile modal on cancel', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.click(screen.getByTitle('Add custom AI profile'))
      expect(screen.getByText('Add AI Profile')).toBeInTheDocument()
      fireEvent.click(screen.getByText('Cancel'))
      expect(screen.queryByText('Add AI Profile')).not.toBeInTheDocument()
    })

    it('adds custom profile via the modal form', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.click(screen.getByTitle('Add custom AI profile'))
      fireEvent.change(screen.getByPlaceholderText(/name/i), { target: { value: 'My Agent' } })
      fireEvent.change(screen.getByPlaceholderText(/command/i), { target: { value: 'my-agent --flag' } })
      fireEvent.click(screen.getByText('Add'))
      expect(mockAddAIProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Agent',
          command: 'my-agent --flag',
          shell: 'bash',
        }),
      )
    })

    it('does not submit empty name/command', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.click(screen.getByTitle('Add custom AI profile'))
      // Submit without filling in
      fireEvent.click(screen.getByText('Add'))
      expect(mockAddAIProfile).not.toHaveBeenCalled()
    })
  })

  describe('shell dropdown offers only installed shells', () => {
    const optionsOf = (el: HTMLElement) =>
      [...el.querySelectorAll('option')].map(o => o.textContent)

    const openModal = (shells: typeof defaultShells) => {
      render(<AIProfiles availableShells={shells} />)
      fireEvent.click(screen.getByTitle('Add custom AI profile'))
      return screen.getByTestId('profile-shell-select') as HTMLSelectElement
    }

    it('lists exactly the detected shells, not a hardcoded five', () => {
      const sel = openModal(defaultShells)
      expect(optionsOf(sel)).toEqual(['Bash', 'Git Bash'])
    })

    it('omits shells this machine does not have', () => {
      // The reported defect: PowerShell/CMD/Zsh were always offered regardless of
      // what was installed, so a profile could name a shell that never existed here.
      const sel = openModal(defaultShells)
      const labels = optionsOf(sel)
      expect(labels).not.toContain('PowerShell')
      expect(labels).not.toContain('CMD')
      expect(labels).not.toContain('Zsh')
    })

    it('offers the Windows set when that is what was detected', () => {
      const sel = openModal([
        { type: 'powershell' as const, label: 'PowerShell', executable: 'pwsh.exe' },
        { type: 'cmd' as const, label: 'Command Prompt', executable: 'cmd.exe' },
      ])
      expect(optionsOf(sel)).toEqual(['PowerShell', 'Command Prompt'])
      expect(optionsOf(sel)).not.toContain('Bash')
    })

    it('saves against a detected shell rather than the old hardcoded bash', () => {
      const sel = openModal([
        { type: 'powershell' as const, label: 'PowerShell', executable: 'pwsh.exe' },
        { type: 'cmd' as const, label: 'Command Prompt', executable: 'cmd.exe' },
      ])
      expect(sel.value).toBe('powershell')
      fireEvent.change(screen.getByPlaceholderText(/name/i), { target: { value: 'Win Agent' } })
      fireEvent.change(screen.getByPlaceholderText(/command/i), { target: { value: 'my-agent' } })
      fireEvent.click(screen.getByText('Add'))
      expect(mockAddAIProfile).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Win Agent', shell: 'powershell' }),
      )
    })

    it('honours an explicit pick from the detected list', () => {
      const sel = openModal([
        { type: 'powershell' as const, label: 'PowerShell', executable: 'pwsh.exe' },
        { type: 'cmd' as const, label: 'Command Prompt', executable: 'cmd.exe' },
      ])
      fireEvent.change(sel, { target: { value: 'cmd' } })
      fireEvent.change(screen.getByPlaceholderText(/name/i), { target: { value: 'Cmd Agent' } })
      fireEvent.change(screen.getByPlaceholderText(/command/i), { target: { value: 'my-agent' } })
      fireEvent.click(screen.getByText('Add'))
      expect(mockAddAIProfile).toHaveBeenCalledWith(expect.objectContaining({ shell: 'cmd' }))
    })

    it('shows a placeholder while shell detection is still pending', () => {
      // Shells arrive over async IPC; an empty list must not render a blank control.
      const sel = openModal([])
      expect(optionsOf(sel)).toEqual(['Detecting shells…'])
    })
  })

  describe('additional branch coverage', () => {
    it('handles detectAgents rejection gracefully', async () => {
      ;(window as any).termpolis.detectAgents = vi.fn().mockRejectedValue(new Error('boom'))
      render(<AIProfiles availableShells={defaultShells} />)
      // Should still render without crashing
      await waitFor(() => {
        expect(screen.getByText('Claude Code')).toBeInTheDocument()
      })
    })

    it('never answers Codex\'s folder-trust prompt with a blind "1\\r" after launch (codex branch)', async () => {
      mockInstalledAgents = { claude: true, codex: true, gemini: true }
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBe(3)
      }, { timeout: 3000 })
      fireEvent.click(screen.getByText('OpenAI Codex'))
      const typed = (): string[] => (window as any).termpolis.writeToTerminal.mock.calls.map((c: any[]) => c[1])
      await waitFor(() => expect(typed()).toContain('codex\r'), { timeout: 3000 })
      // testDelay is 0 here, so every post-command timer is due at once. The spinner dismissal has
      // fired, so the "1" that used to follow the command would have been typed by now too.
      await waitFor(() => expect(mockSetLaunchingAgent).toHaveBeenLastCalledWith(null), { timeout: 3000 })
      expect(typed()).toEqual(['\r', 'codex\r'])
      expect(typed()).not.toContain('1\r')
    }, 10000)

    it('launches Codex with its memory instruction on the command line and reports the AGENTS.md cleanup', async () => {
      ;(window as any).termpolis.memoryPrepareCodexContext = vi.fn().mockResolvedValue({
        success: true,
        data: { developerInstructions: 'Recall project memory first.', approvals: 0, agentsMdCleaned: 'file-deleted' },
      })
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('OpenAI Codex'))
      await waitFor(() => {
        const calls = (window as any).termpolis.writeToTerminal.mock.calls.map((c: any[]) => c[1])
        expect(calls).toContain(`codex -c "developer_instructions='Recall project memory first.'"\r`)
      }, { timeout: 3000 })
      expect((window as any).termpolis.memoryPrepareCodexContext).toHaveBeenCalledWith('/test/project')
      expect(mockSetMemoryNotice).toHaveBeenCalledWith(
        '🧹 Deleted AGENTS.md in "project": it held only the memory note older Termpolis versions wrote',
      )
    }, 10000)
  })

  describe('remove custom profile', () => {
    it('shows remove button on custom profiles', () => {
      mockAiProfiles = [
        { id: 'custom1', name: 'My Custom', icon: 'fa-solid fa-star', command: 'custom', shell: 'bash', color: '#FF0000' },
      ]
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByTitle('Remove profile')).toBeInTheDocument()
    })

    it('calls removeAIProfile when remove button is clicked', () => {
      mockAiProfiles = [
        { id: 'custom1', name: 'My Custom', icon: 'fa-solid fa-star', command: 'custom', shell: 'bash', color: '#FF0000' },
      ]
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.click(screen.getByTitle('Remove profile'))
      expect(mockRemoveAIProfile).toHaveBeenCalledWith('custom1')
    })

    it('does not show remove button on default profiles', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.queryByTitle('Remove profile')).not.toBeInTheDocument()
    })
  })
})

describe('AIProfiles — model pick, colour pick and logo/detection branches', () => {
  const openModal = () => {
    render(<AIProfiles availableShells={defaultShells} />)
    fireEvent.click(screen.getByTitle('Add custom AI profile'))
  }

  const fillNameAndCommand = (name: string, command: string) => {
    fireEvent.change(screen.getByPlaceholderText(/name/i), { target: { value: name } })
    fireEvent.change(screen.getByPlaceholderText(/command/i), { target: { value: command } })
  }

  it('saves the picked Claude model alias onto the profile', () => {
    openModal()
    const select = screen.getByTestId('profile-model-select') as HTMLSelectElement
    // The first non-empty option is a real alias from CLAUDE_MODEL_OPTIONS; read
    // it off the DOM so the test tracks the picker instead of a hardcoded name.
    const alias = [...select.querySelectorAll('option')].map(o => o.value).find(Boolean)!
    expect(alias).toBeTruthy()

    fireEvent.change(select, { target: { value: alias } })
    fillNameAndCommand('Tuned Agent', 'claude')
    fireEvent.click(screen.getByText('Add'))

    expect(mockAddAIProfile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Tuned Agent', model: alias }),
    )
  })

  it('omits the model key entirely when the default model is kept', () => {
    openModal()
    fillNameAndCommand('Plain Agent', 'my-agent')
    fireEvent.click(screen.getByText('Add'))

    // Not merely undefined: the conditional spread must leave the key off, or a
    // blank --model would be appended at launch.
    const saved = mockAddAIProfile.mock.calls[0][0]
    expect(saved.name).toBe('Plain Agent')
    expect(saved).not.toHaveProperty('model')
  })

  it('saves the colour chosen in the picker', () => {
    openModal()
    const colorInput = document.querySelector('input[type="color"]') as HTMLInputElement
    expect(colorInput.value).toBe('#22d3ee')

    fireEvent.change(colorInput, { target: { value: '#ff00ff' } })
    fillNameAndCommand('Pink Agent', 'my-agent')
    fireEvent.click(screen.getByText('Add'))

    expect(mockAddAIProfile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pink Agent', color: '#ff00ff' }),
    )
  })

  it('renders a profile logo image in place of the icon glyph when one is set', () => {
    mockAiProfiles = [
      {
        id: 'logo1',
        name: 'Logo Agent',
        icon: 'fa-solid fa-star',
        iconImage: 'data:image/png;base64,AAAA',
        command: 'logo-agent',
        shell: 'bash',
        color: '#FF0000',
      },
    ]
    render(<AIProfiles availableShells={defaultShells} />)

    const img = screen.getByAltText('Logo Agent')
    expect(img.tagName).toBe('IMG')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    // The glyph arm is the alternative, not an addition.
    expect(document.querySelector('.fa-star')).toBeNull()
  })

  it('treats every agent as present when the detection probe itself fails', async () => {
    ;(window as any).termpolis.detectAgents = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'probe failed' })
    render(<AIProfiles availableShells={defaultShells} />)

    // Detection finished (so indicators render) but reported nothing, so no agent
    // is flagged missing — a failed probe must not accuse an installed agent.
    await waitFor(() => {
      expect(document.querySelectorAll('.fa-circle-check').length).toBe(3)
    })
    expect(document.querySelectorAll('.fa-circle-xmark').length).toBe(0)
  })
})
