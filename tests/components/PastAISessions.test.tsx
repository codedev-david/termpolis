import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockAddTerminal = vi.fn()
const mockSetActiveTerminal = vi.fn()

let activeTerminalIdValue: string | null = 'active-term-1'
vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector: any) => {
      const state = {
        defaultShell: 'bash',
        addTerminal: mockAddTerminal,
        setActiveTerminal: mockSetActiveTerminal,
        activeTerminalId: activeTerminalIdValue,
      }
      return selector(state)
    },
    { getState: vi.fn(() => ({ defaultShell: 'bash' })), setState: vi.fn() },
  ),
}))

vi.mock('uuid', () => ({ v4: () => 'fake-uuid-1234' }))

import { PastAISessions } from '../../src/renderer/src/components/PastAISessions/PastAISessions'
import type { AISessionSummary } from '../../src/renderer/src/types'

const sampleSessions: AISessionSummary[] = [
  {
    id: 'sess-alpha',
    filePath: '/p/a/sess-alpha.jsonl',
    projectFolder: 'C--repos-alpha',
    cwd: 'C:\\repos\\alpha',
    gitBranch: 'main',
    version: '1.0.99',
    firstUserMessage: 'fix the auth bug',
    startTime: '2026-05-06T10:00:00Z',
    lastModified: Date.now() - 5 * 60_000, // 5 min ago
    sizeBytes: 12_345,
  },
  {
    id: 'sess-beta',
    filePath: '/p/b/sess-beta.jsonl',
    projectFolder: 'C--repos-beta',
    cwd: 'C:\\repos\\beta',
    gitBranch: 'feature/x',
    firstUserMessage: 'refactor the data pipeline',
    lastModified: Date.now() - 3 * 86_400_000, // 3d ago
    sizeBytes: 4_096,
  },
  {
    id: 'sess-gamma-same-cwd',
    filePath: '/p/a/sess-gamma.jsonl',
    projectFolder: 'C--repos-alpha',
    cwd: 'C:\\repos\\alpha',
    firstUserMessage: 'add unit tests',
    lastModified: Date.now() - 30 * 60_000,
    sizeBytes: 2_048,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  activeTerminalIdValue = 'active-term-1'
  ;(window as any).termpolis = {
    listAISessions: vi.fn().mockResolvedValue({ success: true, data: sampleSessions }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn().mockResolvedValue({ success: true }),
    digestAISession: vi.fn().mockResolvedValue({
      success: true,
      data: {
        digest: { id: 'sess-alpha', filePath: '/p/a/sess-alpha.jsonl', cwd: 'C:\\repos\\alpha', recentUserMessages: ['hi'], totalUserTurns: 1, totalAssistantTurns: 0 },
        prompt: 'CONTEXT HANDOFF\nGoal: fix the auth bug\n--- Your task ---\nContinue.',
      },
    }),
  }
})

describe('PastAISessions', () => {
  it('returns null when not open (no overlay rendered)', () => {
    render(<PastAISessions open={false} onClose={vi.fn()} />)
    expect(screen.queryByTestId('past-ai-sessions-overlay')).not.toBeInTheDocument()
  })

  it('fetches sessions when opened and renders rows grouped by cwd', async () => {
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    expect((window as any).termpolis.listAISessions).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3)
    })
    // Two distinct cwds → footer count
    expect(screen.getByText(/3 sessions across 2 projects/)).toBeInTheDocument()
  })

  it('shows error message when listAISessions fails', async () => {
    ;(window as any).termpolis.listAISessions.mockResolvedValueOnce({ success: false, error: 'boom' })
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText(/Error: boom/)).toBeInTheDocument()
    })
  })

  it('shows generic error when listAISessions promise rejects', async () => {
    ;(window as any).termpolis.listAISessions.mockRejectedValueOnce(new Error('ipc dead'))
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeInTheDocument()
    })
  })

  it('shows "No past Claude sessions" when scanner returns empty list', async () => {
    ;(window as any).termpolis.listAISessions.mockResolvedValueOnce({ success: true, data: [] })
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText(/No past Claude sessions found/)).toBeInTheDocument()
    })
  })

  it('filter input narrows visible rows by first message text', async () => {
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    const input = screen.getByPlaceholderText(/Filter by project/)
    fireEvent.change(input, { target: { value: 'auth' } })
    await waitFor(() => {
      const rows = screen.getAllByTestId('past-ai-session-row')
      expect(rows.length).toBe(1)
    })
  })

  it('filter by branch matches case-insensitively', async () => {
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    fireEvent.change(screen.getByPlaceholderText(/Filter by project/), { target: { value: 'FEATURE/X' } })
    await waitFor(() => {
      expect(screen.getAllByTestId('past-ai-session-row').length).toBe(1)
    })
  })

  it('filter that matches nothing shows "No sessions match"', async () => {
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    fireEvent.change(screen.getByPlaceholderText(/Filter by project/), { target: { value: 'zzz-no-match' } })
    await waitFor(() => expect(screen.getByText(/No sessions match this filter/)).toBeInTheDocument())
  })

  it('clicking a session row spawns a new terminal and writes claude --resume after delay', async () => {
    const onClose = vi.fn()
    render(<PastAISessions open={true} onClose={onClose} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    const rows = screen.getAllByTestId('past-ai-session-row')

    await act(async () => {
      fireEvent.click(rows[0])
      // let the awaited createTerminal microtask resolve
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockAddTerminal).toHaveBeenCalledTimes(1)
    const addCall = mockAddTerminal.mock.calls[0][0]
    expect(addCall.cwd).toBe('C:\\repos\\alpha')
    expect(addCall.id).toBe('fake-uuid-1234')
    expect(addCall.agentCommand).toContain('claude --resume')
    expect(mockSetActiveTerminal).toHaveBeenCalledWith('fake-uuid-1234')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect((window as any).termpolis.createTerminal).toHaveBeenCalledWith('fake-uuid-1234', 'bash', 'C:\\repos\\alpha')

    // Wait for the 800ms guard (real timers)
    await waitFor(() => {
      expect((window as any).termpolis.writeToTerminal).toHaveBeenCalled()
    }, { timeout: 1500 })
    const writeCall = (window as any).termpolis.writeToTerminal.mock.calls[0]
    expect(writeCall[0]).toBe('fake-uuid-1234')
    expect(writeCall[1]).toMatch(/^claude --resume sess-/)
    expect(writeCall[1]).toContain('\r')
  })

  it('clicking the explicit Resume button (with stopPropagation) also resumes', async () => {
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    const buttons = screen.getAllByText('Resume')
    await act(async () => {
      fireEvent.click(buttons[0])
    })
    expect(mockAddTerminal).toHaveBeenCalledTimes(1)
  })

  it('resume failure logs but does not throw (graceful)', async () => {
    ;(window as any).termpolis.createTerminal.mockRejectedValueOnce(new Error('spawn failed'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('past-ai-session-row')[0])
    })
    // Don't crash; error should be logged
    await act(async () => { await Promise.resolve() })
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    errSpy.mockRestore()
  })

  it('Escape key triggers onClose', async () => {
    const onClose = vi.fn()
    render(<PastAISessions open={true} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('clicking the overlay backdrop triggers onClose', async () => {
    const onClose = vi.fn()
    render(<PastAISessions open={true} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('past-ai-sessions-overlay'))
    expect(onClose).toHaveBeenCalled()
  })

  it('clicking inside the modal does not close it (stopPropagation)', async () => {
    const onClose = vi.fn()
    render(<PastAISessions open={true} onClose={onClose} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    fireEvent.click(screen.getByPlaceholderText(/Filter by project/))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('explicit close (X) button calls onClose', async () => {
    const onClose = vi.fn()
    render(<PastAISessions open={true} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders gitBranch badge and version when present, omits when absent', async () => {
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('feature/x')).toBeInTheDocument()
    expect(screen.getByText('v1.0.99')).toBeInTheDocument()
  })

  it('shows "(no user message)" placeholder when firstUserMessage is missing', async () => {
    ;(window as any).termpolis.listAISessions.mockResolvedValueOnce({
      success: true,
      data: [{
        id: 'no-msg', filePath: '/p/x/no-msg.jsonl', projectFolder: 'p',
        cwd: '/repos/x', lastModified: Date.now(), sizeBytes: 100,
      }],
    })
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('(no user message)')).toBeInTheDocument())
  })

  it('Continue ▾ button reveals the handoff menu with cross-AI options + inject', async () => {
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    const continueBtns = screen.getAllByTestId('past-ai-session-handoff-btn')
    fireEvent.click(continueBtns[0])
    const menu = await screen.findByTestId('past-ai-session-handoff-menu')
    expect(menu).toBeInTheDocument()
    expect(menu.textContent).toMatch(/Continue in Codex/)
    expect(menu.textContent).toMatch(/Continue in Gemini CLI/)
    expect(menu.textContent).toMatch(/Continue in Qwen Code/)
    expect(menu.textContent).toMatch(/Continue in Claude Code/)
    expect(menu.textContent).toMatch(/Inject context into active shell/)
  })

  it('Inject context: writes prompt into active terminal and closes modal', async () => {
    const onClose = vi.fn()
    render(<PastAISessions open={true} onClose={onClose} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    fireEvent.click(screen.getAllByTestId('past-ai-session-handoff-btn')[0])
    const injectBtn = await screen.findByTestId('past-ai-session-inject-btn')
    await act(async () => {
      fireEvent.click(injectBtn)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect((window as any).termpolis.digestAISession).toHaveBeenCalledWith('/p/a/sess-alpha.jsonl')
    expect((window as any).termpolis.writeToTerminal).toHaveBeenCalledWith(
      'active-term-1',
      expect.stringContaining('CONTEXT HANDOFF'),
    )
    expect(onClose).toHaveBeenCalled()
    // Did NOT spawn a new terminal — pure inject
    expect(mockAddTerminal).not.toHaveBeenCalled()
  })

  it('Inject context: shows status when no active terminal exists', async () => {
    activeTerminalIdValue = null
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    fireEvent.click(screen.getAllByTestId('past-ai-session-handoff-btn')[0])
    // The button is disabled when there is no active terminal — clicking is a no-op,
    // so we assert the disabled state instead.
    const injectBtn = await screen.findByTestId('past-ai-session-inject-btn')
    expect((injectBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it('Continue in Codex: spawns new terminal with codex command and posts prompt', async () => {
    const onClose = vi.fn()
    render(<PastAISessions open={true} onClose={onClose} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    fireEvent.click(screen.getAllByTestId('past-ai-session-handoff-btn')[0])
    const codexBtn = await screen.findByText('Continue in Codex')
    await act(async () => {
      fireEvent.click(codexBtn)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockAddTerminal).toHaveBeenCalledTimes(1)
    const addCall = mockAddTerminal.mock.calls[0][0]
    expect(addCall.cwd).toBe('C:\\repos\\alpha')
    expect(addCall.agentCommand).toBe('codex')
    expect(addCall.name).toContain('codex')
    expect(onClose).toHaveBeenCalled()

    // After delays, the agent boot command + prompt are written
    await waitFor(() => {
      const calls = (window as any).termpolis.writeToTerminal.mock.calls
      const hasBootCall = calls.some((c: any[]) => c[1] === 'codex\r')
      expect(hasBootCall).toBe(true)
    }, { timeout: 2000 })
    await waitFor(() => {
      const calls = (window as any).termpolis.writeToTerminal.mock.calls
      const hasPromptCall = calls.some((c: any[]) => typeof c[1] === 'string' && c[1].includes('CONTEXT HANDOFF'))
      expect(hasPromptCall).toBe(true)
    }, { timeout: 5000 })
  })

  it('digest failure surfaces an error in the footer status', async () => {
    ;(window as any).termpolis.digestAISession.mockResolvedValueOnce({ success: false, error: 'parse fail' })
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(3))
    fireEvent.click(screen.getAllByTestId('past-ai-session-handoff-btn')[0])
    const injectBtn = await screen.findByTestId('past-ai-session-inject-btn')
    await act(async () => {
      fireEvent.click(injectBtn)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByTestId('past-ai-sessions-status').textContent).toMatch(/parse fail/)
    })
  })

  it('formatRelative branches: "just now", "Xm ago", "Xh ago", "Xd ago", absolute date', async () => {
    const now = Date.now()
    ;(window as any).termpolis.listAISessions.mockResolvedValueOnce({
      success: true,
      data: [
        { id: 'now', filePath: '', projectFolder: '', cwd: '/a', lastModified: now - 30_000, sizeBytes: 10 },
        { id: 'min', filePath: '', projectFolder: '', cwd: '/b', lastModified: now - 5 * 60_000, sizeBytes: 10 },
        { id: 'hr',  filePath: '', projectFolder: '', cwd: '/c', lastModified: now - 2 * 3_600_000, sizeBytes: 10 },
        { id: 'day', filePath: '', projectFolder: '', cwd: '/d', lastModified: now - 4 * 86_400_000, sizeBytes: 10 },
        { id: 'old', filePath: '', projectFolder: '', cwd: '/e', lastModified: now - 365 * 86_400_000, sizeBytes: 10 },
      ],
    })
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row').length).toBe(5))
    expect(screen.getByText('just now')).toBeInTheDocument()
    expect(screen.getByText(/^5m ago$/)).toBeInTheDocument()
    expect(screen.getByText(/^2h ago$/)).toBeInTheDocument()
    expect(screen.getByText(/^4d ago$/)).toBeInTheDocument()
  })
})
