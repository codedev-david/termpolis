import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Unlike the other launch tests, this file keeps delays REAL (driven by fake timers) — the whole
// point here is when things happen, which a testDelay stub of 0 collapses away.
vi.mock('../../src/renderer/src/lib/testAgents', () => ({
  resolveAgentCommand: (cmd: string) => cmd,
  testDelay: (ms: number) => ms,
}))
vi.mock('../../src/renderer/src/lib/terminalDefaults', () => ({
  getTerminalDefaults: () => ({ fontSize: 14, theme: 'dark', fontFamily: 'monospace' }),
  agentTerminalName: (profileName: string) => profileName,
}))
vi.mock('../../src/renderer/src/hooks/useAutoPrimer', () => ({ isAutoPrimerEnabled: () => true }))
vi.mock('../../src/renderer/src/hooks/useAutoCodeIndex', () => ({ autoIndexRepo: () => Promise.resolve() }))

import { DEFAULT_AI_PROFILES, launchAgentProfile } from '../../src/renderer/src/lib/aiProfiles'
import { LEGACY_COMMAND_AT_MS, SHELL_QUIET_MS } from '../../src/renderer/src/lib/launchSequence'
import type { ShellInfo } from '../../src/renderer/src/types'

const shells: ShellInfo[] = [{ type: 'bash', label: 'Bash', executable: '/bin/bash' }]
const claude = DEFAULT_AI_PROFILES[0]
const codex = DEFAULT_AI_PROFILES[1]
const gemini = DEFAULT_AI_PROFILES[2]

let addTerminal: ReturnType<typeof vi.fn>
let setLaunchingAgent: ReturnType<typeof vi.fn>
let ptyListeners: Array<(id: string, data: string) => void>
const deps = () => ({ availableShells: shells, addTerminal, setLaunchingAgent })

/** Every string typed into the terminal so far, in order. */
const typed = (): string[] => (window as never as { termpolis: { writeToTerminal: { mock: { calls: unknown[][] } } } })
  .termpolis.writeToTerminal.mock.calls.map((c) => String(c[1]))
const api = (): Record<string, ReturnType<typeof vi.fn>> =>
  (window as never as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis
/** The terminal id the launch actually created, so we can emit output as that PTY. */
const createdId = (): string => String(api().createTerminal.mock.calls[0][0])
const emit = (id: string, data: string): void => ptyListeners.forEach((l) => l(id, data))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  addTerminal = vi.fn()
  setLaunchingAgent = vi.fn()
  ptyListeners = []
  ;(window as never as { termpolis: unknown }).termpolis = {
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/test/project' }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
    memoryPreparePrimerFile: vi.fn().mockResolvedValue({ success: true, data: { file: null, count: 0 } }),
    memoryPrepareCodexContext: vi.fn().mockResolvedValue({ success: true, data: { file: 'AGENTS.md' } }),
    onTerminalData: vi.fn((cb: (id: string, data: string) => void) => {
      ptyListeners.push(cb)
      return () => { ptyListeners = ptyListeners.filter((l) => l !== cb) }
    }),
  }
})
afterEach(() => vi.useRealTimers())

/**
 * Start a launch and let the pre-shell async work (pick + create) settle, WITHOUT waiting for the
 * launch itself. The handle is wrapped in an object on purpose: returning the promise bare from an
 * async function makes the caller's `await` adopt it, which would block until the launch finished —
 * with the fake clock frozen, that is a deadlock.
 */
async function startLaunch(profile = claude): Promise<{ done: Promise<void> }> {
  const done = launchAgentProfile(profile, deps())
  await vi.advanceTimersByTimeAsync(0)
  return { done }
}

describe('launchAgentProfile — types the command when the shell is ready, not on a fixed sleep', () => {
  it('types the command shortly after the shell goes quiet, long before the old 4.5s', async () => {
    const { done: p } = await startLaunch()
    emit(createdId(), 'user@host MINGW64 ~/project\n$ ')
    await vi.advanceTimersByTimeAsync(200) // quiet window elapses
    expect(typed().some((s) => s.startsWith('claude'))).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('does not type the command while the shell is still initialising', async () => {
    const { done: p } = await startLaunch()
    emit(createdId(), 'partial init output')
    await vi.advanceTimersByTimeAsync(50) // inside the quiet window
    expect(typed().some((s) => s.startsWith('claude'))).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('still types the command when the shell never says anything (ceiling holds)', async () => {
    const { done: p } = await startLaunch()
    await vi.advanceTimersByTimeAsync(LEGACY_COMMAND_AT_MS)
    expect(typed().some((s) => s.startsWith('claude'))).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('no longer sends a bare newline to flush shell init — the command is the first thing typed', async () => {
    const { done: p } = await startLaunch()
    emit(createdId(), '$ ')
    await vi.advanceTimersByTimeAsync(200)
    expect(typed()[0]).toMatch(/^claude/)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })
})

describe('launchAgentProfile — the memory primer overlaps the shell wait', () => {
  it('starts the recall immediately instead of blocking the shell wait behind it', async () => {
    await startLaunch()
    // Called already, while we are still waiting on the shell — not afterwards.
    expect(api().memoryPreparePrimerFile).toHaveBeenCalled()
    expect(typed().some((s) => s.startsWith('claude'))).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('still waits for a slow recall before typing, so the flag is never dropped', async () => {
    let release!: (v: unknown) => void
    api().memoryPreparePrimerFile = vi.fn(() => new Promise((r) => { release = r }))
    const p = launchAgentProfile(claude, deps())
    await vi.advanceTimersByTimeAsync(0)
    emit(createdId(), '$ ')
    await vi.advanceTimersByTimeAsync(1000) // shell ready long ago; recall still outstanding
    expect(typed().some((s) => s.startsWith('claude'))).toBe(false)
    release({ success: true, data: { file: 'C:/p/primer.md', count: 3 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(typed().find((s) => s.startsWith('claude'))).toContain('--append-system-prompt-file')
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })
})

describe('launchAgentProfile — downstream timers are re-based onto the command', () => {
  it('sends the Claude trust Enter the same 4.5s after the command as it always did', async () => {
    const { done: p } = await startLaunch()
    emit(createdId(), '$ ')
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_MS) // command is typed exactly now
    const afterCommand = typed().length
    await vi.advanceTimersByTimeAsync(9000 - LEGACY_COMMAND_AT_MS - 1)
    expect(typed().slice(afterCommand)).toEqual([]) // not yet
    await vi.advanceTimersByTimeAsync(1)
    expect(typed().slice(afterCommand)).toEqual(['\r'])
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('sends the Codex "1" confirmation on the same re-based schedule', async () => {
    const { done: p } = await startLaunch(codex)
    emit(createdId(), '$ ')
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_MS) // command is typed exactly now
    const afterCommand = typed().length
    await vi.advanceTimersByTimeAsync(9000 - LEGACY_COMMAND_AT_MS)
    expect(typed().slice(afterCommand)).toEqual(['1\r'])
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('never sends a trust confirmation for Gemini', async () => {
    const { done: p } = await startLaunch(gemini)
    emit(createdId(), '$ ')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(typed().filter((s) => s === '\r' || s === '1\r')).toEqual([])
    await p
  })

  it('dismisses the launch spinner relative to the command as well', async () => {
    const { done: p } = await startLaunch()
    emit(createdId(), '$ ')
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_MS) // command is typed exactly now
    setLaunchingAgent.mockClear()
    await vi.advanceTimersByTimeAsync(8000 - LEGACY_COMMAND_AT_MS - 1)
    expect(setLaunchingAgent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(setLaunchingAgent).toHaveBeenCalledWith(null)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('launches even with no PTY output stream to subscribe to (fail-open)', async () => {
    api().onTerminalData = vi.fn(() => { throw new Error('no bridge') })
    const { done: p } = await startLaunch()
    await vi.advanceTimersByTimeAsync(LEGACY_COMMAND_AT_MS)
    expect(typed().some((s) => s.startsWith('claude'))).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })
})

describe('launchAgentProfile — timers outlive the window they were scheduled from', () => {
  it('drops a queued write instead of throwing when the bridge is gone', async () => {
    // The trust confirmation fires seconds after launch. Under jsdom teardown — and in the real app
    // if the window closes first — `window.termpolis` can be gone by then, and an unguarded write
    // would raise an unhandled exception out of a bare timer callback.
    const { done: p } = await startLaunch()
    emit(createdId(), '$ ')
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_MS)
    const writeToTerminal = api().writeToTerminal
    const before = writeToTerminal.mock.calls.length
    ;(window as never as { termpolis: unknown }).termpolis = {} // bridge torn down mid-flight
    await expect(vi.advanceTimersByTimeAsync(20_000)).resolves.not.toThrow()
    expect(writeToTerminal.mock.calls.length).toBe(before) // the trust Enter was dropped, not thrown
    await p
  })
})
