// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { launchAgentProfile } from '../../src/renderer/src/lib/aiProfiles'
import type { AIProfile, TerminalSession } from '../../src/renderer/src/types'
import { AUTO_MODEL, setAgentModelDefault } from '../../src/renderer/src/lib/agentModelDefaults'
import { unavailableModels } from '../../src/renderer/src/lib/autoModel'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

const CATALOG = {
  claude: { provider: 'claude', models: [{ id: 'opus', label: 'Opus' }], source: 'builtin', fetchedAt: 0 },
  codex: { provider: 'codex', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }, { id: 'gpt-5.5', label: 'GPT-5.5' }], source: 'cli', fetchedAt: 1 },
  gemini: { provider: 'gemini', models: [{ id: 'gemini-3.8-flash-high', label: 'Flash' }], source: 'cli', fetchedAt: 1 },
}

describe('launchAgentProfile — single-agent model selection', () => {
  let writes: string[]
  beforeEach(() => {
    vi.useFakeTimers()
    writes = []
    ;(window as unknown as { termpolis: unknown }).termpolis = {
      pickDirectory: vi.fn(async () => ({ success: true, data: '/proj' })),
      createTerminal: vi.fn(async () => ({ success: true })),
      memoryPreparePrimerFile: vi.fn(async () => ({ success: false })),
      writeToTerminal: vi.fn((_id: string, data: string) => { writes.push(data) }),
      getModelCatalog: vi.fn(async () => ({ success: true, data: CATALOG })),
    }
    localStorage.clear()
    useTerminalStore.getState().setMemoryNotice(null)
  })
  afterEach(() => { vi.useRealTimers() })

  const deps = () => ({ availableShells: [{ type: 'bash' }] as never, addTerminal: vi.fn(), setLaunchingAgent: vi.fn() })

  /**
   * Start the launch, then drive the clock, THEN await it. The launch now waits for the shell to
   * look ready (or for the ceiling), so awaiting it before the fake clock moves would deadlock:
   * the promise is waiting on a timer that only `runAllTimersAsync` can fire.
   */
  const launched = async (p: AIProfile): Promise<void> => {
    const done = launchAgentProfile(p, deps())
    await vi.runAllTimersAsync()
    await done
  }
  const profile = (over: Partial<AIProfile> = {}): AIProfile =>
    ({ id: 'claude', name: 'Claude', icon: '', command: 'claude', shell: 'bash', color: '#000', ...over })

  it('appends --model <alias> to a Claude launch when the profile pins a model', async () => {
    await launched(profile({ model: 'sonnet' }))
    expect(writes.some(d => d.includes('--model sonnet'))).toBe(true)
  })

  it('does not append --model when no model is pinned', async () => {
    await launched(profile())
    expect(writes.some(d => d.includes('--model'))).toBe(false)
  })

  it('ignores an invalid / injecting model alias (no --model emitted)', async () => {
    await launched(profile({ model: 'evil; rm -rf /' }))
    expect(writes.some(d => d.includes('--model'))).toBe(false)
  })

  describe('default models (Settings › General › Default Models)', () => {
    const launchLine = (): string => writes.filter(d => d.endsWith('\r')).at(-1) ?? ''
    const codex = (over: Partial<AIProfile> = {}): AIProfile => profile({ id: 'codex', name: 'OpenAI Codex', command: 'codex', ...over })
    const agy = (over: Partial<AIProfile> = {}): AIProfile => profile({ id: 'gemini', name: 'Gemini / Antigravity CLI', command: 'agy', ...over })

    it('starts a Claude terminal on the saved Claude default', async () => {
      setAgentModelDefault('claude', 'haiku')
      await launched(profile())
      expect(launchLine()).toBe('claude --model haiku\r')
    })

    it("lets the profile's own pinned model win over the General default", async () => {
      setAgentModelDefault('claude', 'haiku')
      await launched(profile({ model: 'opus' }))
      expect(launchLine()).toBe('claude --model opus\r')
      expect(launchLine()).not.toContain('haiku')
    })

    it("lets the pin win for a Claude command spelled with a path, as it does for a plain one", async () => {
      setAgentModelDefault('claude', 'haiku')
      await launched(profile({ id: 'my-claude', name: 'Claude (tools)', command: 'C:\\tools\\claude.exe', model: 'opus' }))
      expect(launchLine()).toBe('C:\\tools\\claude.exe --model opus\r')
      expect(launchLine()).not.toContain('haiku')
    })

    it("falls back to the default for a path-spelled Claude command with no pin", async () => {
      setAgentModelDefault('claude', 'haiku')
      await launched(profile({ id: 'my-claude', name: 'Claude (tools)', command: 'C:\\tools\\claude.exe' }))
      expect(launchLine()).toBe('C:\\tools\\claude.exe --model haiku\r')
    })

    it("starts Codex on the Codex default, checked against Codex's own list", async () => {
      setAgentModelDefault('codex', 'gpt-5.5')
      await launched(codex())
      expect(launchLine()).toBe('codex --model gpt-5.5\r')
    })

    it('starts the Antigravity CLI on its default', async () => {
      setAgentModelDefault('gemini', 'gemini-3.8-flash-high')
      await launched(agy())
      expect(launchLine()).toBe('agy --model gemini-3.8-flash-high\r')
    })

    it('applies to a custom profile too, by what its command runs', async () => {
      setAgentModelDefault('codex', 'gpt-5.5')
      await launched(profile({ id: 'my-codex', name: 'Codex (yolo)', command: 'codex --yolo' }))
      expect(launchLine()).toBe('codex --yolo --model gpt-5.5\r')
    })

    it("never carries one agent's default to another", async () => {
      setAgentModelDefault('codex', 'gpt-5.5')
      await launched(profile())
      await launched(agy())
      expect(writes.some(d => d.includes('--model'))).toBe(false)
    })

    it('adds nothing when no default is saved', async () => {
      await launched(codex())
      expect(launchLine()).toBe('codex\r')
      expect((window as any).termpolis.getModelCatalog).not.toHaveBeenCalled()
    })

    it('leaves a profile whose command already picks a model or resumes a session alone', async () => {
      setAgentModelDefault('claude', 'haiku')
      await launched(profile({ command: 'claude --model opus' }))
      expect(launchLine()).toBe('claude --model opus\r')
      await launched(profile({ command: 'claude --continue' }))
      expect(launchLine()).toBe('claude --continue\r')
    })

    it('drops a default the agent no longer lists, starts it on its own default, and says so', async () => {
      setAgentModelDefault('codex', 'gpt-5.3-codex')
      await launched(codex())
      expect(launchLine()).toBe('codex\r')
      expect(useTerminalStore.getState().memoryNotice).toMatch(/Codex no longer offers your default model "gpt-5\.3-codex"/)
    })

    it('still applies a Codex default when its list has not been discovered yet', async () => {
      setAgentModelDefault('codex', 'gpt-5.5')
      ;(window as any).termpolis.getModelCatalog = vi.fn(async () => { throw new Error('ipc down') })
      await launched(codex())
      expect(launchLine()).toBe('codex --model gpt-5.5\r')
    })

    it('puts the model flag after the primer arguments', async () => {
      setAgentModelDefault('claude', 'sonnet')
      ;(window as any).termpolis.memoryPreparePrimerFile = vi.fn(async () => ({ success: true, data: { file: 'C:\\tmp\\primer.txt', count: 3 } }))
      await launched(profile())
      expect(launchLine()).toBe('claude --append-system-prompt-file "C:/tmp/primer.txt" --model sonnet\r')
    })
  })

  describe('Auto (best for the task)', () => {
    const launchLine = (): string => writes.filter(d => d.endsWith('\r')).at(-1) ?? ''
    const create = (): ReturnType<typeof vi.fn> => (window as unknown as { termpolis: { createTerminal: ReturnType<typeof vi.fn> } }).termpolis.createTerminal
    // Backed by the real store: the pane is added first, and what Auto picked joins it later.
    const routedOf = (add: ReturnType<typeof vi.fn>) => useTerminalStore.getState().terminals.find((t) => t.id === add.mock.calls[0][0].id)?.routed
    const launchedWith = async (p: AIProfile, task?: string, add = vi.fn((t: TerminalSession) => useTerminalStore.getState().addTerminal(t))): Promise<ReturnType<typeof vi.fn>> => {
      const done = launchAgentProfile(p, { ...deps(), addTerminal: add, ...(task !== undefined ? { task } : {}) })
      await vi.runAllTimersAsync()
      await done
      return add
    }
    beforeEach(() => setAgentModelDefault('claude', AUTO_MODEL))

    it('Auto + task routes and passes the task as the first prompt', async () => {
      const add = await launchedWith(profile(), 'find where X is defined')
      expect(launchLine()).toBe('claude --model haiku --effort low "find where X is defined"\r')
      expect(routedOf(add)).toMatchObject({ model: 'haiku', effort: 'low', rule: 'lookup' })
      expect(create().mock.calls[0]).toEqual(['x', 'bash', '/proj', undefined, true, undefined, 'claude', true].map((v, i) => (i === 0 ? expect.any(String) : v)))
    })

    it('Auto with no task plans first', async () => {
      await launchedWith(profile())
      expect(launchLine()).toBe('claude --model opusplan --effort high\r')
    })

    it("user's own --model wins over Auto", async () => {
      const add = await launchedWith(profile({ command: 'claude --model opus' }), 'find X')
      expect(launchLine()).toBe('claude --model opus\r')
      expect(routedOf(add)).toBeUndefined()
      await launchedWith(profile({ model: 'sonnet' }), 'find X')
      expect(launchLine()).toBe('claude --model sonnet\r')
    })

    it('subagent env is set only with Auto', async () => {
      await launchedWith(profile(), 'find X')
      expect(create().mock.calls[0]).toHaveLength(8)
      setAgentModelDefault('claude', 'haiku')
      await launchedWith(profile(), 'find X')
      expect(create().mock.calls[1]).toHaveLength(7)
      expect(launchLine()).toBe('claude --model haiku\r')
    })

    it('unavailable model falls back to the profile default once and is remembered per account', async () => {
      // Claude Code prints its complaint a moment after the line is typed, inside the watch window.
      const subs: Array<(id: string, d: string) => void> = []
      const tp = (window as unknown as { termpolis: Record<string, unknown> }).termpolis
      tp.onTerminalData = vi.fn((cb: (id: string, d: string) => void) => { subs.push(cb); return () => {} })
      tp.writeToTerminal = vi.fn((id: string, data: string) => {
        writes.push(data)
        if (data.startsWith('claude')) setTimeout(() => { for (const cb of [...subs]) cb(id, "There's an issue with the selected model (haiku). It may not exist or you may not have access to it.") }, 50)
      })
      await launchedWith(profile(), 'find where X is defined')
      expect(useTerminalStore.getState().memoryNotice).toContain("Haiku isn't available")
      expect(unavailableModels(undefined)).toEqual(['haiku'])
      await launchedWith(profile(), 'find where X is defined')
      expect(launchLine()).toBe('claude --effort low "find where X is defined"\r')
      expect(useTerminalStore.getState().memoryNotice).toContain('Auto picked Haiku')
    })
  })
})
