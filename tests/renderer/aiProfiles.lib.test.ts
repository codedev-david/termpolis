import { describe, it, expect, vi, beforeEach } from 'vitest'

// Deterministic launch helpers: no real delays, command passthrough.
vi.mock('../../src/renderer/src/lib/testAgents', () => ({
  resolveAgentCommand: (cmd: string) => cmd,
  testDelay: (_ms: number) => 0,
}))
vi.mock('../../src/renderer/src/lib/terminalDefaults', () => ({
  getTerminalDefaults: () => ({ fontSize: 14, theme: 'dark', fontFamily: 'monospace' }),
  agentTerminalName: (profileName: string) => profileName,
}))
// The "load memory at launch" setting, flipped per test (the real one reads localStorage).
const primerSetting = vi.hoisted(() => ({ enabled: true }))
vi.mock('../../src/renderer/src/hooks/useAutoPrimer', () => ({
  isAutoPrimerEnabled: () => primerSetting.enabled,
}))

import { DEFAULT_AI_PROFILES, agentLaunchConfig, resolveShellType, launchAgentProfile } from '../../src/renderer/src/lib/aiProfiles'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { CODEX_INSTRUCTION_MAX_CHARS } from '../../src/shared/agentIntegration'
import type { AIProfile, ShellInfo } from '../../src/renderer/src/types'

const shells: ShellInfo[] = [
  { type: 'bash', label: 'Bash', executable: '/bin/bash' },
  { type: 'gitbash', label: 'Git Bash', executable: 'C:\\Program Files\\Git\\bin\\bash.exe' },
  { type: 'powershell', label: 'PowerShell', executable: 'powershell.exe' },
]

let addTerminal: ReturnType<typeof vi.fn>
let setLaunchingAgent: ReturnType<typeof vi.fn>

function deps() {
  return { availableShells: shells, addTerminal, setLaunchingAgent }
}

/** What main hands back for a Codex launch (CodexLaunchContext), merged over "nothing to add". */
function codexContext(data: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue({ success: true, data: { developerInstructions: null, approvals: 0, ...data } })
}

/** Every string typed into the terminal so far, in order. */
const typed = (): string[] => (window as any).termpolis.writeToTerminal.mock.calls.map((c: unknown[]) => String(c[1]))

/** Let the launch's post-command timers run (testDelay is 0 here, so they are all due now). */
const flushLaunchTimers = () => new Promise((r) => setTimeout(r, 25))

beforeEach(() => {
  vi.clearAllMocks()
  primerSetting.enabled = true
  addTerminal = vi.fn()
  setLaunchingAgent = vi.fn()
  ;(window as any).termpolis = {
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/test/project' }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
    memoryPreparePrimerFile: vi.fn().mockResolvedValue({ success: true, data: { file: null, count: 0 } }),
    memoryPrepareCodexContext: codexContext(),
  }
  useTerminalStore.getState().setMemoryNotice(null)
})

describe('agentLaunchConfig: what the Welcome screen and shortcuts launch', () => {
  it('launches each built-in agent with its sidebar name and command, Gemini as agy', () => {
    expect(agentLaunchConfig('claude')).toEqual({ name: 'Claude Code', command: 'claude', color: '#D97706' })
    expect(agentLaunchConfig('codex')).toEqual({ name: 'OpenAI Codex', command: 'codex', color: '#10B981' })
    expect(agentLaunchConfig('gemini')).toEqual({ name: 'Gemini / Antigravity CLI', command: 'agy', color: '#4285F4' })
  })

  it('knows nothing else', () => {
    expect(agentLaunchConfig('qwen')).toBeNull()
    expect(agentLaunchConfig('')).toBeNull()
  })
})

describe('DEFAULT_AI_PROFILES', () => {
  it('exposes the three built-in agents in Claude/Codex/Gemini order', () => {
    expect(DEFAULT_AI_PROFILES.map(p => p.id)).toEqual(['claude', 'codex', 'gemini'])
    expect(DEFAULT_AI_PROFILES).toHaveLength(3)
  })
})

describe('resolveShellType', () => {
  it('returns the exact shell when available', () => {
    expect(resolveShellType('powershell', shells)).toBe('powershell')
  })

  it('maps "bash" to gitbash when gitbash is available (Windows convenience)', () => {
    const orig = navigator.platform
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    try {
      expect(resolveShellType('bash', shells)).toBe('gitbash')
    } finally {
      Object.defineProperty(navigator, 'platform', { value: orig, configurable: true })
    }
  })

  it('on Windows without Git Bash installed, still resolves plain bash', () => {
    const orig = navigator.platform
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    try {
      const noGitBash = shells.filter(sh => sh.type !== 'gitbash')
      expect(resolveShellType('bash', noGitBash)).toBe('bash')
    } finally {
      Object.defineProperty(navigator, 'platform', { value: orig, configurable: true })
    }
  })

  it('falls back to the first available shell when the requested one is missing', () => {
    expect(resolveShellType('zsh', shells)).toBe('bash')
  })

  it('falls through to whatever IS available when a bash profile finds no bash at all', () => {
    // A bash-shelled agent on a machine offering only PowerShell: neither the gitbash nor the plain
    // bash preference can be honoured, so the generic fallback has to take over.
    expect(resolveShellType('bash', [{ type: 'powershell', label: 'PowerShell', executable: 'powershell.exe' }])).toBe('powershell')
  })

  it('falls back to bash when no shells are available', () => {
    expect(resolveShellType('zsh', [])).toBe('bash')
  })
})

describe('launchAgentProfile', () => {
  const claude = DEFAULT_AI_PROFILES[0]
  const codex = DEFAULT_AI_PROFILES[1]

  it('picks a directory, creates a terminal, and registers it', async () => {
    await launchAgentProfile(claude, deps())
    expect((window as any).termpolis.pickDirectory).toHaveBeenCalled()
    expect((window as any).termpolis.createTerminal).toHaveBeenCalled()
    expect(setLaunchingAgent).toHaveBeenCalledWith('Claude Code')
    expect(addTerminal).toHaveBeenCalledWith(expect.objectContaining({ agentCommand: 'claude' }))
  })

  it('deterministically indexes the picked repo for EVERY agent, not just Claude', async () => {
    const api = (window as any).termpolis
    api.gitFindRoot = vi.fn().mockResolvedValue({ success: true, data: '/test/project' })
    api.memoryIngestCode = vi.fn().mockResolvedValue({ success: true, data: { codeGraph: { symbols: 7 } } })
    const { _resetAutoIndexedRoots } = await import('../../src/renderer/src/hooks/useAutoCodeIndex')
    _resetAutoIndexedRoots()
    await launchAgentProfile(DEFAULT_AI_PROFILES[1], deps()) // Codex — a non-Claude agent
    await vi.waitFor(() => expect(api.memoryIngestCode).toHaveBeenCalledWith('/test/project'))
  })

  it('does nothing when the directory picker is cancelled', async () => {
    ;(window as any).termpolis.pickDirectory = vi.fn().mockResolvedValue({ success: true, data: null })
    await launchAgentProfile(claude, deps())
    expect((window as any).termpolis.createTerminal).not.toHaveBeenCalled()
    expect(addTerminal).not.toHaveBeenCalled()
  })

  it('alerts and resets the spinner when terminal creation fails', async () => {
    ;(window as any).termpolis.createTerminal = vi.fn().mockResolvedValue({ success: false, error: 'spawn failed' })
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    await launchAgentProfile(claude, deps())
    expect(alertSpy).toHaveBeenCalledWith('Failed to open terminal: spawn failed')
    expect(setLaunchingAgent).toHaveBeenCalledWith(null)
    expect(addTerminal).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })

  it('gives Codex its memory instruction on the command line, and never a system-prompt flag', async () => {
    ;(window as any).termpolis.memoryPrepareCodexContext = codexContext({ developerInstructions: 'Recall project memory first.' })
    await launchAgentProfile(codex, deps())
    expect((window as any).termpolis.memoryPrepareCodexContext).toHaveBeenCalledWith('/test/project')
    expect(typed()).toEqual(['\r', `codex -c "developer_instructions='Recall project memory first.'"\r`])
    // Codex has no --append-system-prompt-file; passing one would abort the launch outright.
    expect(typed().join(' ')).not.toContain('append-system-prompt')
  })

  it('never asks main for Codex context, or adds a Codex flag, when launching Claude', async () => {
    await launchAgentProfile(claude, deps())
    expect((window as any).termpolis.memoryPrepareCodexContext).not.toHaveBeenCalled()
    expect(typed()).toEqual(['\r', 'claude\r'])
  })

  it('skips the recall entirely when loading memory at launch is switched off', async () => {
    primerSetting.enabled = false
    ;(window as any).termpolis.memoryPreparePrimerFile = vi.fn().mockResolvedValue({
      success: true, data: { file: 'C:/p/primer.md', count: 3 },
    })
    await launchAgentProfile(claude, deps())
    expect((window as any).termpolis.memoryPreparePrimerFile).not.toHaveBeenCalled()
    expect(addTerminal).toHaveBeenCalledWith(expect.objectContaining({ launchPrimed: false }))
    expect(typed()).toEqual(['\r', 'claude\r'])
  })

  it('seeds the Claude launch with --append-system-prompt-file when memory exists', async () => {
    ;(window as any).termpolis.memoryPreparePrimerFile = vi.fn().mockResolvedValue({
      success: true, data: { file: 'C:\\Users\\me\\primers\\p.txt', count: 7 },
    })
    await launchAgentProfile(claude, deps())
    expect(addTerminal).toHaveBeenCalledWith(expect.objectContaining({ launchPrimed: true }))
    // The silent Claude priming now surfaces a visible confirmation with the count.
    expect(useTerminalStore.getState().memoryNotice).toContain('Loaded 7 memories for')
    await vi.waitFor(() => {
      const calls = (window as any).termpolis.writeToTerminal.mock.calls
      expect(calls.some((c: any[]) =>
        typeof c[1] === 'string' &&
        c[1].includes('--append-system-prompt-file') &&
        c[1].includes('primers/p.txt'),
      )).toBe(true)
    }, { timeout: 3000 })
  }, 10000)

  it('launches bare (launchPrimed false) when there is no relevant memory', async () => {
    await launchAgentProfile(claude, deps())
    expect(addTerminal).toHaveBeenCalledWith(expect.objectContaining({ launchPrimed: false }))
    expect(useTerminalStore.getState().memoryNotice).toBeNull()
  })

  it('surfaces a visible warning when memory recall fails (#1 observability)', async () => {
    ;(window as any).termpolis.memoryPreparePrimerFile = vi.fn().mockResolvedValue({ success: false, error: 'brain down' })
    await launchAgentProfile(claude, deps())
    expect(addTerminal).toHaveBeenCalledWith(expect.objectContaining({ launchPrimed: false }))
    expect(useTerminalStore.getState().memoryNotice).toContain('Memory recall unavailable')
  })

  it('surfaces the warning when the recall call throws (#1)', async () => {
    ;(window as any).termpolis.memoryPreparePrimerFile = vi.fn().mockRejectedValue(new Error('ipc boom'))
    await launchAgentProfile(claude, deps())
    expect(useTerminalStore.getState().memoryNotice).toContain('Memory recall unavailable')
  })
})

describe('launchAgentProfile — memory notice wording', () => {
  const claude = DEFAULT_AI_PROFILES[0]

  it('says "1 memory", not "1 memories", when exactly one was recalled', async () => {
    ;(window as any).termpolis.memoryPreparePrimerFile = vi.fn().mockResolvedValue({
      success: true, data: { file: 'C:/p/primer.md', count: 1 },
    })
    await launchAgentProfile(claude, deps())
    expect(useTerminalStore.getState().memoryNotice).toContain('Loaded 1 memory for')
  })

  it('falls back to "this project" when the chosen folder has no nameable leaf', async () => {
    ;(window as any).termpolis.pickDirectory = vi.fn().mockResolvedValue({ success: true, data: '/' })
    ;(window as any).termpolis.memoryPreparePrimerFile = vi.fn().mockResolvedValue({
      success: true, data: { file: 'C:/p/primer.md', count: 2 },
    })
    await launchAgentProfile(claude, deps())
    expect(useTerminalStore.getState().memoryNotice).toContain('"this project"')
    // ...and the recall query drops the project clause rather than interpolating an empty name.
    const query = (window as any).termpolis.memoryPreparePrimerFile.mock.calls[0][0]
    expect(query).toBe('recent work, key decisions, and conventions')
  })
})

// Codex has no system-prompt file flag. It used to get its memory instruction by main writing a
// note into <project>/AGENTS.md, and a blind `1⏎` typed 9 s later to accept its folder-trust
// prompt. Now the instruction rides on the command line for this one session, nothing is written
// into the project, and the trust prompt is left to the user.
describe('launchAgentProfile — Codex gets its instruction for this session only', () => {
  const codex = DEFAULT_AI_PROFILES[1]
  const INSTRUCTION = 'Before you start, call memory_search (Termpolis MCP) for this project; save decisions with memory_write.'

  it('types the instruction as a -c developer_instructions override on the codex command', async () => {
    ;(window as any).termpolis.memoryPrepareCodexContext = codexContext({ developerInstructions: INSTRUCTION, approvals: 14 })
    await launchAgentProfile(codex, deps())
    expect(typed()).toEqual(['\r', `codex -c "developer_instructions='${INSTRUCTION}'"\r`])
  })

  it('launches Codex bare rather than type an instruction a shell could act on', async () => {
    const unsafe = [
      "Don't skip recall", // ' ends both the TOML literal and the shell quote
      'Recall $(whoami) first', // command substitution
      'Recall `id` first', // backticks
      'Recall "first"', // ends the outer double quote
      'Recall %USERPROFILE% first', // cmd.exe expansion
      'Recall first\nrm -rf ~', // a second command line
      'Recall ‘first’', // PowerShell treats typographic quotes as quotes
      'x'.repeat(CODEX_INSTRUCTION_MAX_CHARS + 1),
    ]
    for (const text of unsafe) {
      ;(window as any).termpolis.writeToTerminal.mockClear()
      ;(window as any).termpolis.memoryPrepareCodexContext = codexContext({ developerInstructions: text })
      await launchAgentProfile(codex, deps())
      expect(typed(), JSON.stringify(text.slice(0, 40))).toEqual(['\r', 'codex\r'])
    }
  })

  it('launches Codex bare when main has nothing for it, fails, or throws', async () => {
    const replies = [
      () => codexContext(), // nothing to add
      () => codexContext({ developerInstructions: '' }),
      () => vi.fn().mockResolvedValue({ success: false, error: 'brain down' }),
      () => vi.fn().mockResolvedValue({ success: true, data: null }),
      () => vi.fn().mockResolvedValue(undefined),
      () => vi.fn().mockRejectedValue(new Error('ipc boom')),
    ]
    for (const reply of replies) {
      ;(window as any).termpolis.writeToTerminal.mockClear()
      addTerminal.mockClear()
      ;(window as any).termpolis.memoryPrepareCodexContext = reply()
      await launchAgentProfile(codex, deps())
      expect(typed()).toEqual(['\r', 'codex\r'])
      expect(addTerminal).toHaveBeenCalledTimes(1)
    }
    expect(useTerminalStore.getState().memoryNotice).toBeNull()
  })

  it('leaves the instruction off when loading memory at launch is switched off', async () => {
    primerSetting.enabled = false
    ;(window as any).termpolis.memoryPrepareCodexContext = codexContext({ developerInstructions: INSTRUCTION })
    await launchAgentProfile(codex, deps())
    expect(typed()).toEqual(['\r', 'codex\r'])
  })

  it('still cleans up AGENTS.md, and says so, with memory at launch switched off', async () => {
    primerSetting.enabled = false
    ;(window as any).termpolis.memoryPrepareCodexContext = codexContext({ agentsMdCleaned: 'block-removed' })
    await launchAgentProfile(codex, deps())
    expect((window as any).termpolis.memoryPrepareCodexContext).toHaveBeenCalledWith('/test/project')
    expect(useTerminalStore.getState().memoryNotice).toBe(
      '🧹 Removed the memory note older Termpolis versions wrote into AGENTS.md in "project"',
    )
  })

  it('says it deleted AGENTS.md when the file held only the old memory note', async () => {
    ;(window as any).termpolis.memoryPrepareCodexContext = codexContext({
      developerInstructions: INSTRUCTION, agentsMdCleaned: 'file-deleted',
    })
    await launchAgentProfile(codex, deps())
    expect(useTerminalStore.getState().memoryNotice).toBe(
      '🧹 Deleted AGENTS.md in "project": it held only the memory note older Termpolis versions wrote',
    )
    // The cleanup does not cost the session its instruction.
    expect(typed()[1]).toBe(`codex -c "developer_instructions='${INSTRUCTION}'"\r`)
  })

  it('says nothing about AGENTS.md when there was nothing to clean up', async () => {
    ;(window as any).termpolis.memoryPrepareCodexContext = codexContext({ developerInstructions: INSTRUCTION })
    await launchAgentProfile(codex, deps())
    expect(useTerminalStore.getState().memoryNotice).toBeNull()
  })

  it('treats a custom profile whose command runs codex as Codex', async () => {
    ;(window as any).termpolis.memoryPrepareCodexContext = codexContext({ developerInstructions: INSTRUCTION })
    const custom: AIProfile = {
      id: 'custom-codex', name: 'Codex (fast)', icon: 'fa-solid fa-bolt', command: 'Codex --model o4-mini', shell: 'bash', color: '#000000',
    }
    await launchAgentProfile(custom, deps())
    expect((window as any).termpolis.memoryPrepareCodexContext).toHaveBeenCalledWith('/test/project')
    expect(typed()[1]).toBe(`Codex --model o4-mini -c "developer_instructions='${INSTRUCTION}'"\r`)
  })

  it('never writes AGENTS.md: main gets only the folder, and nothing sent or typed names the file', async () => {
    const bridge = (window as any).termpolis
    bridge.memoryPrepareCodexContext = codexContext({ developerInstructions: INSTRUCTION, agentsMdCleaned: 'block-removed' })
    const touched = new Set<string>()
    ;(window as any).termpolis = new Proxy(bridge, {
      get: (target, key) => { touched.add(String(key)); return target[key as string] },
    })
    await launchAgentProfile(codex, deps())
    await flushLaunchTimers()
    expect(bridge.memoryPrepareCodexContext.mock.calls).toEqual([['/test/project']])
    const sent = Object.values(bridge).filter((v) => vi.isMockFunction(v)).flatMap((fn: any) => fn.mock.calls)
    expect(JSON.stringify(sent)).not.toMatch(/agents\.md/i)
    // Keystrokes are the only thing the launch writes through the bridge.
    expect([...touched].filter((k) => k !== 'writeToTerminal' && /write|save|append/i.test(k))).toEqual([])
  })

  it('never types "1" at the Codex folder-trust prompt, or anything else after the command', async () => {
    await launchAgentProfile(codex, deps())
    await flushLaunchTimers()
    // Every post-command timer is due at once here (testDelay is 0). The spinner dismissal has
    // fired, so the old "1" confirmation would have been typed by now too.
    expect(setLaunchingAgent).toHaveBeenLastCalledWith(null)
    expect(typed()).toEqual(['\r', 'codex\r'])
    expect(typed()).not.toContain('1\r')
  })
})
