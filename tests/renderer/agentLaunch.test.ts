import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  launchAgents,
  agentTargets,
  SHELL_SETTLE_MS,
  COMMAND_DELAY_MS,
  DISMISS_MS,
  SLOW_DISMISS_MS,
} from '../../src/renderer/src/lib/agentLaunch'

describe('agentLaunch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('agentTargets', () => {
    it('keeps only terminals carrying an agent command', () => {
      const kept = agentTargets([
        { id: 'a', agentCommand: 'claude' },
        { id: 'b' },
        { id: 'c', agentCommand: '' },
        { id: 'd', agentCommand: 'codex' },
      ])
      expect(kept.map(t => t.id)).toEqual(['a', 'd'])
    })
  })

  describe('launchAgents', () => {
    it('flushes the shell, then types the command', () => {
      const write = vi.fn()
      launchAgents([{ id: 't1', agentCommand: 'claude' }], { write })

      // Nothing is typed while the shell is still initialising.
      vi.advanceTimersByTime(SHELL_SETTLE_MS - 1)
      expect(write).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(write).toHaveBeenCalledExactlyOnceWith('t1', '\r')

      vi.advanceTimersByTime(COMMAND_DELAY_MS)
      expect(write).toHaveBeenLastCalledWith('t1', 'claude\r')
    })

    // Claude Code 2.1.x opens its workspace-trust dialog focused on "No, exit"
    // (`cancelFirst: true, focus: "cancel"`), so the blind Enter that used to be
    // sent here QUIT the session — the launch looked cut off. Trust is seeded in
    // Claude's own config instead; nothing is typed at the dialog.
    it('types NOTHING at Claude after the command — a blind Enter would quit it', () => {
      const write = vi.fn()
      launchAgents([{ id: 't1', agentCommand: 'claude' }], { write, trustClaudeWorkspace: vi.fn() })

      vi.advanceTimersByTime(SLOW_DISMISS_MS)
      expect(write.mock.calls).toEqual([['t1', '\r'], ['t1', 'claude\r']])
    })

    it('pre-approves each Claude folder in Claude Code\'s own config', () => {
      const write = vi.fn()
      const trustClaudeWorkspace = vi.fn().mockResolvedValue(undefined)
      launchAgents(
        [
          { id: 't1', agentCommand: 'claude', cwd: 'C:/repo' },
          { id: 't2', agentCommand: 'codex', cwd: 'C:/other' },
          { id: 't3', agentCommand: 'claude' }, // no cwd known — nothing to seed
        ],
        { write, trustClaudeWorkspace },
      )

      expect(trustClaudeWorkspace).toHaveBeenCalledExactlyOnceWith('C:/repo')
    })

    it('defaults to the preload bridge for both the write and the trust seed', () => {
      const writeToTerminal = vi.fn()
      const claudeTrustWorkspace = vi.fn().mockResolvedValue({ success: true })
      ;(window as never as { termpolis: unknown }).termpolis = { writeToTerminal, claudeTrustWorkspace }

      launchAgents([{ id: 't1', agentCommand: 'claude', cwd: 'C:/repo' }])

      expect(claudeTrustWorkspace).toHaveBeenCalledWith('C:/repo')
      vi.advanceTimersByTime(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(writeToTerminal).toHaveBeenLastCalledWith('t1', 'claude\r')
    })

    it('still launches when the trust seed rejects', () => {
      const write = vi.fn()
      const trustClaudeWorkspace = vi.fn().mockRejectedValue(new Error('config locked'))
      launchAgents([{ id: 't1', agentCommand: 'claude', cwd: 'C:/repo' }], { write, trustClaudeWorkspace })

      vi.advanceTimersByTime(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(write).toHaveBeenLastCalledWith('t1', 'claude\r')
    })

    // Codex used to get a blind `1⏎` ten seconds in. That accepted its folder-trust prompt
    // whether or not the user wanted the folder trusted, and it became a chat message when no
    // prompt showed. A trust prompt is the user's to answer (or App.tsx's poller's, once they
    // connected the agents), so nothing follows the command.
    it('types NOTHING at Codex after the command — its trust prompt is the user\'s', () => {
      const write = vi.fn()
      launchAgents([{ id: 't1', agentCommand: 'codex' }], { write })

      vi.advanceTimersByTime(60_000)
      expect(write.mock.calls).toEqual([['t1', '\r'], ['t1', 'codex\r']])
      expect(write).not.toHaveBeenCalledWith('t1', '1\r')
    })

    it('sends no trust reply for an agent that does not prompt', () => {
      const write = vi.fn()
      launchAgents([{ id: 't1', agentCommand: 'gemini' }], { write })

      vi.advanceTimersByTime(SLOW_DISMISS_MS)
      // Only the flush newline and the command itself — no trust answer.
      expect(write.mock.calls).toEqual([['t1', '\r'], ['t1', 'gemini\r']])
    })

    it('launches every agent terminal and skips the plain shells', () => {
      const write = vi.fn()
      launchAgents(
        [
          { id: 'shell', agentCommand: undefined },
          { id: 'a1', agentCommand: 'claude' },
          { id: 'a2', agentCommand: 'codex' },
        ],
        { write },
      )

      vi.advanceTimersByTime(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(write).toHaveBeenCalledWith('a1', 'claude\r')
      expect(write).toHaveBeenCalledWith('a2', 'codex\r')
      expect(write).not.toHaveBeenCalledWith('shell', expect.anything())
    })

    it('settles after the normal dismiss delay', () => {
      const onSettled = vi.fn()
      launchAgents([{ id: 't1', agentCommand: 'claude' }], { write: vi.fn(), onSettled })

      vi.advanceTimersByTime(DISMISS_MS - 1)
      expect(onSettled).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(onSettled).toHaveBeenCalledOnce()
    })

    it('waits longer to settle when a slow agent is in the batch', () => {
      const onSettled = vi.fn()
      launchAgents(
        [{ id: 't1', agentCommand: 'claude' }, { id: 't2', agentCommand: 'gemini' }],
        { write: vi.fn(), onSettled },
      )

      vi.advanceTimersByTime(DISMISS_MS)
      expect(onSettled).not.toHaveBeenCalled()

      vi.advanceTimersByTime(SLOW_DISMISS_MS - DISMISS_MS)
      expect(onSettled).toHaveBeenCalledOnce()
    })

    it('settles immediately and writes nothing when no target has an agent', () => {
      const write = vi.fn()
      const onSettled = vi.fn()
      launchAgents([{ id: 't1' }, { id: 't2' }], { write, onSettled })

      expect(onSettled).toHaveBeenCalledOnce()
      vi.advanceTimersByTime(SLOW_DISMISS_MS)
      expect(write).not.toHaveBeenCalled()
    })

    it('tolerates an empty target list', () => {
      expect(() => launchAgents([], {})).not.toThrow()
    })

    describe('on an account (a restored workspace, the Welcome screen, the palette)', () => {
      const bridge = () => ({
        launchAccount: vi.fn(async (_agent: string, id: string | null) => ({ success: true, data: { accountId: id ?? 'acc_pref' } })),
        launchLine: vi.fn(async (req: { command: string; accountId: string | null }) => ({
          success: true, data: { line: `unset X && ${req.command}`, accountId: req.accountId, explicit: true, ...(req.command === 'claude' ? { sessionId: 's-1' } : {}) },
        })),
      })

      it("names each target's account, trusts its folder there, and types main's line on it", async () => {
        const write = vi.fn()
        const trustClaudeWorkspace = vi.fn().mockResolvedValue(undefined)
        const onLaunched = vi.fn()
        const accounts = bridge()
        launchAgents(
          [
            { id: 't1', agentCommand: 'claude', cwd: 'C:/repo', shellType: 'gitbash', agentAccountId: 'acc_b' },
            { id: 't2', agentCommand: 'codex', shellType: 'powershell' },
          ],
          { write, trustClaudeWorkspace, accounts: accounts as never, onLaunched },
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(accounts.launchAccount.mock.calls).toEqual([['claude', 'acc_b'], ['codex', null]])
        expect(trustClaudeWorkspace).toHaveBeenCalledExactlyOnceWith('C:/repo', 'acc_b')
        await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
        expect(accounts.launchLine.mock.calls).toEqual([
          [{ terminalId: 't1', agent: 'claude', shellType: 'gitbash', command: 'claude', accountId: 'acc_b' }],
          [{ terminalId: 't2', agent: 'codex', shellType: 'powershell', command: 'codex', accountId: 'acc_pref' }],
        ])
        expect(write).toHaveBeenCalledWith('t1', 'unset X && claude\r')
        expect(write).toHaveBeenCalledWith('t2', 'unset X && codex\r')
        expect(onLaunched).toHaveBeenCalledWith('t1', { agentAccountId: 'acc_b', agentSessionId: 's-1' })
        expect(onLaunched).toHaveBeenCalledWith('t2', { agentAccountId: 'acc_pref' })
      })

      it("records the account on the store's terminal by default, and types nothing for a refused line", async () => {
        const { useTerminalStore } = await import('../../src/renderer/src/store/terminalStore')
        useTerminalStore.setState({ terminals: [{ id: 'r1', name: 'a', color: '', shellType: 'bash', cwd: '/', fontSize: 1, theme: '', fontFamily: '', agentCommand: 'claude' }] })
        useTerminalStore.getState().setMemoryNotice(null)
        const write = vi.fn()
        const accounts = bridge()
        launchAgents([{ id: 'r1', agentCommand: 'claude', shellType: 'bash' }], { write, accounts: accounts as never })
        await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
        expect(useTerminalStore.getState().terminals[0]).toEqual(expect.objectContaining({ agentAccountId: 'acc_pref', agentSessionId: 's-1' }))

        accounts.launchLine.mockResolvedValueOnce({ success: false, error: 'no' } as never)
        write.mockClear()
        launchAgents([{ id: 'r1', agentCommand: 'codex' }], { write, accounts: accounts as never })
        await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
        expect(write.mock.calls).toEqual([['r1', '\r']])
        expect(accounts.launchLine).toHaveBeenLastCalledWith(expect.objectContaining({ shellType: '' }))
        expect(useTerminalStore.getState().memoryNotice).toBe("⚠️ Termpolis didn't start Codex: no")
      })

      it('records nothing for an agent with no accounts, whose line is the bare command', async () => {
        const write = vi.fn()
        const onLaunched = vi.fn()
        const accounts = {
          launchAccount: vi.fn(async () => ({ success: true, data: { accountId: null } })),
          launchLine: vi.fn(async () => ({ success: true, data: { line: 'agy', accountId: null, explicit: false } })),
        }
        launchAgents([{ id: 't1', agentCommand: 'agy' }], { write, accounts: accounts as never, onLaunched })
        await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
        expect(write).toHaveBeenLastCalledWith('t1', 'agy\r')
        expect(onLaunched).not.toHaveBeenCalled()
      })

      it('trusts through the preload bridge with the account when none is injected', async () => {
        const claudeTrustWorkspace = vi.fn().mockResolvedValue({ success: true })
        ;(window as any).termpolis = { writeToTerminal: vi.fn(), claudeTrustWorkspace }
        launchAgents([{ id: 't1', agentCommand: 'claude', cwd: 'C:/repo' }], { accounts: bridge() as never })
        await vi.advanceTimersByTimeAsync(0)
        expect(claudeTrustWorkspace).toHaveBeenCalledWith('C:/repo', 'acc_pref')
      })
    })

    it('falls back to the preload bridge when no writer is injected', () => {
      const writeToTerminal = vi.fn()
      ;(window as any).termpolis = { writeToTerminal }

      launchAgents([{ id: 't1', agentCommand: 'claude' }])
      vi.advanceTimersByTime(SHELL_SETTLE_MS + COMMAND_DELAY_MS)

      expect(writeToTerminal).toHaveBeenCalledWith('t1', 'claude\r')
    })
  })
})
