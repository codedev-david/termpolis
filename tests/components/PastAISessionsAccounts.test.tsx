// Past AI Sessions on an account (§6.3): a resume, a resume in the active shell and a handoff each
// start their agent on the agent's preferred account, as main names it and builds the line; a
// refused line types nothing. A shared projects/ folder makes every account's sessions resumable.
import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('uuid', () => ({ v4: () => 'new-term' }))

import { PastAISessions } from '../../src/renderer/src/components/PastAISessions/PastAISessions'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import type { AISessionSummary, TerminalSession } from '../../src/renderer/src/types'

const session: AISessionSummary = {
  id: '3f2a9c1e-5b7d-4e8f-a012-3456789abcde',
  filePath: '/p/a/s.jsonl',
  projectFolder: 'C--repos-alpha',
  cwd: 'C:\\repos\\alpha',
  firstUserMessage: 'fix the auth bug',
  lastModified: Date.now(),
  sizeBytes: 1024,
}

const plainShell: TerminalSession = { id: 'shell-1', name: 'pwsh', color: '', shellType: 'powershell', cwd: 'C:\\work', fontSize: 12, theme: '', fontFamily: '' }

let accounts: { launchAccount: ReturnType<typeof vi.fn>; launchLine: ReturnType<typeof vi.fn> }
const api = (): Record<string, ReturnType<typeof vi.fn>> => (window as never as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis

beforeEach(() => {
  useTerminalStore.setState({ terminals: [plainShell], activeTerminalId: 'shell-1', defaultShell: 'gitbash' })
  useTerminalStore.getState().setMemoryNotice(null)
  ;(window as never as { termpolis: unknown }).termpolis = {
    listAISessions: vi.fn().mockResolvedValue({ success: true, data: [session] }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
    claudeTrustWorkspace: vi.fn().mockResolvedValue({ success: true }),
    digestAISession: vi.fn().mockResolvedValue({ success: true, data: { prompt: 'CONTEXT HANDOFF' } }),
  }
  accounts = {
    launchAccount: vi.fn(async () => ({ success: true, data: { accountId: 'acc_p' } })),
    launchLine: vi.fn(async (req: { command: string }) => ({ success: true, data: { line: `unset CLAUDE_CONFIG_DIR && ${req.command}`, accountId: 'acc_p', explicit: true, sessionId: session.id } })),
  }
  ;(window as never as { accounts: unknown }).accounts = accounts
})

afterEach(() => { delete (window as { accounts?: unknown }).accounts })

async function open(): Promise<void> {
  render(<PastAISessions open={true} onClose={vi.fn()} />)
  await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row')).toHaveLength(1))
}

describe('Past AI Sessions on an account', () => {
  it('resumes on the preferred account: its proxy, trust and line, recorded on the terminal', async () => {
    await open()
    await act(async () => { fireEvent.click(screen.getByTestId('past-ai-session-row')) })
    await waitFor(() => expect(api().writeToTerminal).toHaveBeenCalled(), { timeout: 1500 })
    expect(accounts.launchAccount).toHaveBeenCalledWith('claude', null)
    expect(api().createTerminal).toHaveBeenCalledWith('new-term', 'gitbash', session.cwd, undefined, true, 'acc_p', 'claude')
    expect(api().claudeTrustWorkspace).toHaveBeenCalledWith(session.cwd, 'acc_p')
    expect(api().writeToTerminal).toHaveBeenCalledWith('new-term', `unset CLAUDE_CONFIG_DIR && claude --resume ${session.id}\r`)
    expect(useTerminalStore.getState().terminals.find((t) => t.id === 'new-term')).toEqual(expect.objectContaining({ agentAccountId: 'acc_p', agentSessionId: session.id }))
  })

  it('types nothing, and says why, when main refuses the resume\'s line', async () => {
    accounts.launchLine.mockResolvedValueOnce({ success: false, error: 'no shell' })
    await open()
    await act(async () => { fireEvent.click(screen.getByTestId('past-ai-session-row')) })
    await waitFor(() => expect(useTerminalStore.getState().memoryNotice).toBe('⚠️ Termpolis didn\'t start Claude Code: no shell'))
    await new Promise((r) => setTimeout(r, 900))
    expect(api().writeToTerminal).not.toHaveBeenCalled()
  })

  it('resumes in the active plain shell on the account, in that shell\'s syntax', async () => {
    await open()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    await act(async () => { fireEvent.click(await screen.findByTestId('past-ai-session-resume-here-btn')) })
    await waitFor(() => expect(api().writeToTerminal).toHaveBeenCalled())
    expect(api().claudeTrustWorkspace).toHaveBeenCalledWith('C:\\work', 'acc_p')
    expect(accounts.launchLine).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'shell-1', shellType: 'powershell', command: `claude --resume ${session.id}` }))
    expect(api().writeToTerminal).toHaveBeenCalledWith('shell-1', `unset CLAUDE_CONFIG_DIR && claude --resume ${session.id}\r`)
  })

  it('says why in the panel, typing nothing, when the active shell\'s line is refused', async () => {
    accounts.launchLine.mockResolvedValueOnce({ success: false, error: 'cmd would expand a % or ! in the line' })
    await open()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    await act(async () => { fireEvent.click(await screen.findByTestId('past-ai-session-resume-here-btn')) })
    expect(await screen.findByText(/Termpolis didn't start Claude Code: cmd would expand/)).toBeInTheDocument()
    expect(api().writeToTerminal).not.toHaveBeenCalled()
  })

  it('takes the store\'s default shell when the active terminal is gone from the list', async () => {
    useTerminalStore.setState({ terminals: [], activeTerminalId: 'gone' })
    await open()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    await act(async () => { fireEvent.click(await screen.findByTestId('past-ai-session-resume-here-btn')) })
    await waitFor(() => expect(accounts.launchLine).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'gone', shellType: 'gitbash' })))
    expect(api().claudeTrustWorkspace).not.toHaveBeenCalled()
  })

  // A handoff pastes its prompt 2.5 s after the line: waiting for it here keeps that timer from writing into a later test's mock (UI4-6).
  const pasted = (): Promise<void> => waitFor(() => expect(api().writeToTerminal).toHaveBeenCalledWith('new-term', expect.stringContaining('CONTEXT HANDOFF')), { timeout: 4000 })

  it('hands off to another agent on its preferred account', async () => {
    await open()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    await act(async () => { fireEvent.click(await screen.findByText('Continue in Codex')) })
    await waitFor(() => expect(api().writeToTerminal).toHaveBeenCalled(), { timeout: 1500 })
    expect(accounts.launchAccount).toHaveBeenCalledWith('codex', null)
    expect(api().createTerminal).toHaveBeenCalledWith('new-term', 'gitbash', session.cwd, undefined, false, 'acc_p', 'codex')
    expect(api().writeToTerminal).toHaveBeenCalledWith('new-term', 'unset CLAUDE_CONFIG_DIR && codex\r')
    // Not Claude: no folder trust is seeded.
    expect(api().claudeTrustWorkspace).not.toHaveBeenCalled()
    await pasted()
  })

  it('types nothing for a handoff whose line is refused', async () => {
    accounts.launchLine.mockResolvedValueOnce({ success: false, error: 'no' })
    await open()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    await act(async () => { fireEvent.click(await screen.findByText('Continue in Codex')) })
    await waitFor(() => expect(useTerminalStore.getState().memoryNotice).toBe('⚠️ Termpolis didn\'t start Codex: no'))
    await new Promise((r) => setTimeout(r, 900))
    expect(api().writeToTerminal).not.toHaveBeenCalled()
  })

  it('hands off to Claude Code with its folder trusted on the account, and records an account with no session', async () => {
    accounts.launchLine.mockResolvedValueOnce({ success: true, data: { line: 'unset CLAUDE_CONFIG_DIR && claude', accountId: 'acc_p', explicit: true } })
    await open()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    await act(async () => { fireEvent.click(await screen.findByText('Continue in Claude Code')) })
    await waitFor(() => expect(api().writeToTerminal).toHaveBeenCalled(), { timeout: 1500 })
    expect(api().claudeTrustWorkspace).toHaveBeenCalledWith(session.cwd, 'acc_p')
    const t = useTerminalStore.getState().terminals.find((x) => x.id === 'new-term')
    expect(t?.agentAccountId).toBe('acc_p')
    expect(t).not.toHaveProperty('agentSessionId')
    await pasted()
  })

  it('logs a handoff whose terminal fails to open', async () => {
    api().createTerminal.mockRejectedValueOnce(new Error('spawn failed'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await open()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    await act(async () => { fireEvent.click(await screen.findByText('Continue in Codex')) })
    await waitFor(() => expect(err).toHaveBeenCalledWith('[PastAISessions] handoff failed', expect.any(Error)))
    err.mockRestore()
  })

  it('opens and closes a row\'s handoff menu from its button', async () => {
    await open()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    expect(await screen.findByTestId('past-ai-session-resume-here-btn')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    expect(screen.queryByTestId('past-ai-session-resume-here-btn')).not.toBeInTheDocument()
  })

  // The menu disables these buttons when the active terminal can't take them; their handlers refuse
  // as well, for a click that lands as the store changes. Pressed through React's own props here,
  // since a disabled button gets no click from the DOM.
  const press = async (el: HTMLElement): Promise<void> => {
    const props = Object.keys(el).find((k) => k.startsWith('__reactProps'))!
    await act(async () => { (el as never as Record<string, { onClick: () => void }>)[props].onClick() })
  }

  it('says so, typing nothing, when there is no active terminal or it is the wrong kind', async () => {
    useTerminalStore.setState({ activeTerminalId: null })
    await open()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    const here = await screen.findByTestId('past-ai-session-resume-here-btn')
    expect(here).toBeDisabled()
    await press(here)
    expect(await screen.findByText('No active terminal. Open one first.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    await press(await screen.findByTestId('past-ai-session-inject-btn'))
    expect(await screen.findByText('No active terminal to inject into. Open one first.')).toBeInTheDocument()
    // The active terminal is a plain shell: nothing to inject into.
    act(() => { useTerminalStore.setState({ activeTerminalId: 'shell-1' }) })
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    await press(await screen.findByTestId('past-ai-session-inject-btn'))
    expect(await screen.findByText('Active shell is not an AI agent — open a Claude/Codex/Gemini tab first.')).toBeInTheDocument()
    expect(api().writeToTerminal).not.toHaveBeenCalled()
  })

  it('refuses to resume in an active shell that already runs an agent', async () => {
    useTerminalStore.setState({ terminals: [{ ...plainShell, agentCommand: 'claude' }] })
    await open()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    const here = await screen.findByTestId('past-ai-session-resume-here-btn')
    expect(here).toBeDisabled()
    await press(here)
    expect(await screen.findByText('Active shell is already an AI agent — use Resume (new tab) or Inject instead.')).toBeInTheDocument()
    expect(api().writeToTerminal).not.toHaveBeenCalled()
  })

  it('says it failed when listing or digesting returns no error text, and ignores keys other than Esc', async () => {
    api().listAISessions.mockResolvedValueOnce({ success: false })
    const onClose = vi.fn()
    const { unmount } = render(<PastAISessions open={true} onClose={onClose} />)
    expect(await screen.findByText(/Failed to list sessions/)).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
    unmount()
    api().digestAISession.mockResolvedValueOnce({ success: false })
    await open()
    fireEvent.click(screen.getByTestId('past-ai-session-handoff-btn'))
    await act(async () => { fireEvent.click(await screen.findByText('Continue in Codex')) })
    expect(await screen.findByText('Could not digest session: unknown')).toBeInTheDocument()
  })

  it('names a session in a root folder by its folder', async () => {
    api().listAISessions.mockResolvedValueOnce({ success: true, data: [{ ...session, cwd: '/' }] })
    render(<PastAISessions open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('past-ai-session-row')).toHaveLength(1))
    expect(screen.getAllByText('/').length).toBeGreaterThan(0)
  })

  it('makes today\'s calls for an agent with no accounts', async () => {
    accounts.launchAccount.mockResolvedValue({ success: true, data: { accountId: null } })
    accounts.launchLine.mockResolvedValue({ success: true, data: { line: `claude --resume ${session.id}`, accountId: null, explicit: false } })
    await open()
    await act(async () => { fireEvent.click(screen.getByTestId('past-ai-session-row')) })
    await waitFor(() => expect(api().writeToTerminal).toHaveBeenCalled(), { timeout: 1500 })
    // No account; the agent Termpolis watches there, which main marks only once it has two (R6).
    expect(api().createTerminal.mock.calls[0]).toEqual(['new-term', 'gitbash', session.cwd, undefined, true, undefined, 'claude'])
    expect(api().claudeTrustWorkspace.mock.calls).toEqual([[session.cwd]])
    expect(useTerminalStore.getState().terminals.find((t) => t.id === 'new-term')).not.toHaveProperty('agentAccountId')
  })
})
