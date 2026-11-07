import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setAgentModelDefault } from '../../src/renderer/src/lib/agentModelDefaults'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
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

    it('waits longer to settle for the Antigravity CLI (agy) too: Gemini is agy now', () => {
      const onSettled = vi.fn()
      launchAgents([{ id: 't1', agentCommand: 'agy' }], { write: vi.fn(), onSettled })

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

  describe('default models (Settings › General › Default Models)', () => {
    const CATALOG = {
      claude: { provider: 'claude', models: [], source: 'builtin', fetchedAt: 0 },
      codex: { provider: 'codex', models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], source: 'cli', fetchedAt: 1 },
      gemini: { provider: 'gemini', models: [{ id: 'gemini-3.8-flash-high', label: 'Flash' }], source: 'cli', fetchedAt: 1 },
    }
    beforeEach(() => {
      localStorage.clear()
      ;(window as any).termpolis = { getModelCatalog: vi.fn(async () => ({ success: true, data: CATALOG })) }
      useTerminalStore.getState().setMemoryNotice(null)
    })
    const typed = (write: ReturnType<typeof vi.fn>): string[] => write.mock.calls.map(c => c[1] as string).filter(d => d !== '\r')

    it('starts each agent on its own saved default', async () => {
      setAgentModelDefault('claude', 'haiku')
      setAgentModelDefault('codex', 'gpt-5.5')
      setAgentModelDefault('gemini', 'gemini-3.8-flash-high')
      const write = vi.fn()
      launchAgents([{ id: 'a', agentCommand: 'claude' }, { id: 'b', agentCommand: 'codex' }, { id: 'c', agentCommand: 'agy' }], { write })
      await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(typed(write)).toEqual(['claude --model haiku\r', 'codex --model gpt-5.5\r', 'agy --model gemini-3.8-flash-high\r'])
    })

    it('adds nothing when no default is saved, and makes no catalog call', async () => {
      const write = vi.fn()
      launchAgents([{ id: 'a', agentCommand: 'codex' }], { write })
      await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(typed(write)).toEqual(['codex\r'])
      expect((window as any).termpolis.getModelCatalog).not.toHaveBeenCalled()
    })

    it('leaves a restored command that already names its model, or resumes a session, alone', async () => {
      setAgentModelDefault('claude', 'haiku')
      const write = vi.fn()
      launchAgents([{ id: 'a', agentCommand: 'claude --model opus' }, { id: 'b', agentCommand: 'claude --resume abc' }], { write })
      await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(typed(write)).toEqual(['claude --model opus\r', 'claude --resume abc\r'])
    })

    it('does not type a model flag after a plain shell', async () => {
      setAgentModelDefault('claude', 'haiku')
      const write = vi.fn()
      launchAgents([{ id: 'shell' }, { id: 'a', agentCommand: 'claude' }], { write })
      await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(write).not.toHaveBeenCalledWith('shell', expect.anything())
    })

    it('drops a default the agent no longer lists and says so through the injected notifier', async () => {
      setAgentModelDefault('codex', 'gpt-5.3-codex')
      const write = vi.fn()
      const notify = vi.fn()
      launchAgents([{ id: 'a', agentCommand: 'codex' }], { write, notify })
      await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(typed(write)).toEqual(['codex\r'])
      expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/Codex no longer offers your default model "gpt-5\.3-codex"/))
    })

    it("says so in the app's notice bar when no notifier is injected", async () => {
      setAgentModelDefault('gemini', 'gemini-9')
      launchAgents([{ id: 'a', agentCommand: 'agy' }], { write: vi.fn() })
      await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(useTerminalStore.getState().memoryNotice).toMatch(/Antigravity CLI no longer offers your default model "gemini-9"/)
    })
  })

  // MODELS-R2-2: the same defaults on the account-aware path (Welcome, the palette, workspace restore, "New terminal on
  // <account>"). Main builds the line the shell is typed, around the command the renderer hands it, so the default has to be
  // IN that command: nothing else carries it onto an account launch.
  describe('default models on an account launch (MODELS-R2-2)', () => {
    const CATALOG = {
      claude: { provider: 'claude', models: [], source: 'builtin', fetchedAt: 0 },
      codex: { provider: 'codex', models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], source: 'cli', fetchedAt: 1 },
      gemini: { provider: 'gemini', models: [{ id: 'gemini-3.8-flash-high', label: 'Flash' }], source: 'cli', fetchedAt: 1 },
    }
    const bridge = () => ({
      launchAccount: vi.fn(async (_agent: string, id: string | null) => ({ success: true, data: { accountId: id ?? 'acc_pref' } })),
      launchLine: vi.fn(async (req: { command: string; accountId: string | null }) => ({
        success: true, data: { line: `unset X && ${req.command}`, accountId: req.accountId, explicit: true },
      })),
    })
    const typedLines = (write: ReturnType<typeof vi.fn>): string[] => write.mock.calls.map((c) => c[1] as string).filter((d) => d !== '\r')
    beforeEach(() => {
      localStorage.clear()
      ;(window as any).termpolis = { getModelCatalog: vi.fn(async () => ({ success: true, data: CATALOG })) }
      useTerminalStore.getState().setMemoryNotice(null)
    })

    it('hands main the command with the saved default, and types the line main built from it', async () => {
      setAgentModelDefault('claude', 'haiku')
      setAgentModelDefault('codex', 'gpt-5.5')
      setAgentModelDefault('gemini', 'gemini-3.8-flash-high')
      const write = vi.fn()
      const accounts = bridge()
      launchAgents([
        { id: 'a', agentCommand: 'claude', shellType: 'bash', agentAccountId: 'acc_b' },
        { id: 'b', agentCommand: 'codex', shellType: 'bash' },
        { id: 'c', agentCommand: 'agy', shellType: 'bash' },
      ], { write, accounts: accounts as never })
      await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(accounts.launchLine.mock.calls.map((c) => c[0].command)).toEqual(['claude --model haiku', 'codex --model gpt-5.5', 'agy --model gemini-3.8-flash-high'])
      expect(typedLines(write)).toEqual(['unset X && claude --model haiku\r', 'unset X && codex --model gpt-5.5\r', 'unset X && agy --model gemini-3.8-flash-high\r'])
    })

    it('leaves a command that already names its model, or resumes a session, as it is', async () => {
      setAgentModelDefault('claude', 'haiku')
      const write = vi.fn()
      const accounts = bridge()
      launchAgents([
        { id: 'a', agentCommand: 'claude --model opus', shellType: 'bash', agentAccountId: 'acc_b' },
        { id: 'b', agentCommand: 'claude --resume abc', shellType: 'bash', agentAccountId: 'acc_b' },
      ], { write, accounts: accounts as never })
      await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(accounts.launchLine.mock.calls.map((c) => c[0].command)).toEqual(['claude --model opus', 'claude --resume abc'])
    })

    it('drops a saved default the agent no longer lists, and says so, on an account launch too', async () => {
      setAgentModelDefault('gemini', 'gemini-9')
      const write = vi.fn()
      const accounts = bridge()
      launchAgents([{ id: 'c', agentCommand: 'agy', shellType: 'bash' }], { write, accounts: accounts as never })
      await vi.advanceTimersByTimeAsync(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(accounts.launchLine.mock.calls.map((c) => c[0].command)).toEqual(['agy'])
      expect(useTerminalStore.getState().memoryNotice).toMatch(/Antigravity CLI no longer offers your default model "gemini-9"/)
    })
  })
})
