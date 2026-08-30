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
vi.mock('../../src/renderer/src/hooks/useAutoPrimer', () => ({
  isAutoPrimerEnabled: () => true,
}))

import { DEFAULT_AI_PROFILES, resolveShellType, launchAgentProfile } from '../../src/renderer/src/lib/aiProfiles'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import type { ShellInfo } from '../../src/renderer/src/types'

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

beforeEach(() => {
  vi.clearAllMocks()
  addTerminal = vi.fn()
  setLaunchingAgent = vi.fn()
  ;(window as any).termpolis = {
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/test/project' }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
    memoryPreparePrimerFile: vi.fn().mockResolvedValue({ success: true, data: { file: null, count: 0 } }),
    memoryPrepareCodexContext: vi.fn().mockResolvedValue({ success: true, data: { file: 'AGENTS.md', changed: true, approvals: 13 } }),
  }
  useTerminalStore.getState().setMemoryNotice(null)
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

  it('gives Codex the same context via AGENTS.md, and never a system-prompt flag', async () => {
    await launchAgentProfile(codex, deps())
    const api = (window as any).termpolis
    expect(api.memoryPrepareCodexContext).toHaveBeenCalledWith('/test/project')
    // Codex has no --append-system-prompt-file; passing one would abort the launch outright.
    expect(api.writeToTerminal.mock.calls.flat().join(' ')).not.toContain('append-system-prompt')
  })

  it('does not touch AGENTS.md when launching Claude', async () => {
    await launchAgentProfile(claude, deps())
    expect((window as any).termpolis.memoryPrepareCodexContext).not.toHaveBeenCalled()
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
