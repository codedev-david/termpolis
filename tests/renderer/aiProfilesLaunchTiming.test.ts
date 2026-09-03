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
import {
  LEGACY_COMMAND_AT_MS, SHELL_QUIET_MS, SHELL_READY_CEILING_MS, PROMPT_ECHO_CEILING_MS,
} from '../../src/renderer/src/lib/launchSequence'
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
/** Did the launch command itself get typed? (The sacrificial newline does not count.) */
const commandTyped = (): boolean => typed().some((s) => s.startsWith('claude') || s.startsWith('codex') || s.startsWith('agy'))

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
    claudeTrustWorkspace: vi.fn().mockResolvedValue({ success: true, data: { changed: true, keys: [] } }),
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

/**
 * Play the shell's side of the whole handshake, ending at the instant the command is typed: the
 * prompt appears and goes quiet, the sacrificial newline goes out, the shell echoes a fresh prompt
 * back, and that goes quiet too.
 */
async function shellSpeaksAndEchoes(): Promise<void> {
  const id = createdId()
  emit(id, 'user@host MINGW64 ~/project\n$ ')
  await vi.advanceTimersByTimeAsync(SHELL_QUIET_MS)
  emit(id, '\r\n$ ') // the shell consumed the newline and reprinted its prompt
  await vi.advanceTimersByTimeAsync(SHELL_QUIET_MS)
}

describe('launchAgentProfile — types the command when the shell is ready, not on a fixed sleep', () => {
  it('types the command shortly after the shell goes quiet, long before the old 4.5s', async () => {
    const started = Date.now()
    const { done: p } = await startLaunch()
    await shellSpeaksAndEchoes()
    expect(commandTyped()).toBe(true)
    // The handshake costs two quiet windows, not the 4.5 s blind sleep it replaced.
    expect(Date.now() - started).toBeLessThan(LEGACY_COMMAND_AT_MS)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('does not type the command while the shell is still initialising', async () => {
    const { done: p } = await startLaunch()
    emit(createdId(), 'partial init output')
    await vi.advanceTimersByTimeAsync(50) // inside the quiet window
    expect(typed()).toEqual([]) // not even the sacrificial newline yet
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('still types the command when the shell never says anything (both ceilings hold)', async () => {
    const { done: p } = await startLaunch()
    await vi.advanceTimersByTimeAsync(SHELL_READY_CEILING_MS + PROMPT_ECHO_CEILING_MS)
    expect(commandTyped()).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })
})

// v1.38.0 dropped the sacrificial newline that had always preceded the command, on the reasoning
// that a quiet shell is a ready shell. Quiet only proves the shell stopped SPEAKING; the first byte
// typed can still be dropped before it starts READING (Git Bash under ConPTY reliably eats it), and
// with the command typed first, that byte is the `c` of `claude` — `bash: laude: command not found`.
describe('launchAgentProfile — the first byte typed is expendable', () => {
  it('types a bare newline BEFORE the command, so a swallowed first byte is never the command', async () => {
    const { done: p } = await startLaunch()
    emit(createdId(), '$ ')
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_MS)
    expect(typed()[0]).toBe('\r') // whatever gets eaten, it is this
    expect(commandTyped()).toBe(false) // and not yet the command
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('waits for the shell to ECHO that newline before typing the command', async () => {
    const { done: p } = await startLaunch()
    emit(createdId(), '$ ')
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_MS)
    // The newline is out; nothing has come back yet, so the command must not follow it.
    await vi.advanceTimersByTimeAsync(PROMPT_ECHO_CEILING_MS - 1)
    expect(commandTyped()).toBe(false)
    emit(createdId(), '\r\n$ ') // proof the shell is reading input, not discarding it
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_MS)
    expect(commandTyped()).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('types the command anyway when the newline itself was the swallowed byte (ceiling holds)', async () => {
    const { done: p } = await startLaunch()
    emit(createdId(), '$ ')
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_MS)
    expect(commandTyped()).toBe(false)
    await vi.advanceTimersByTimeAsync(PROMPT_ECHO_CEILING_MS) // no echo ever comes
    expect(commandTyped()).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('sends the command whole — the launch flag is not clipped off the front', async () => {
    api().memoryPreparePrimerFile = vi.fn().mockResolvedValue({
      success: true, data: { file: 'C:/p/primer.md', count: 3 },
    })
    const p = launchAgentProfile(claude, deps())
    await vi.advanceTimersByTimeAsync(0)
    await shellSpeaksAndEchoes()
    expect(typed().find((s) => s.includes('--append-system-prompt-file')))
      .toBe('claude --append-system-prompt-file "C:/p/primer.md"\r')
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })
})

describe('launchAgentProfile — the memory primer overlaps the shell wait', () => {
  it('starts the recall immediately instead of blocking the shell wait behind it', async () => {
    await startLaunch()
    // Called already, while we are still waiting on the shell — not afterwards.
    expect(api().memoryPreparePrimerFile).toHaveBeenCalled()
    expect(commandTyped()).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('still waits for a slow recall before typing, so the flag is never dropped', async () => {
    let release!: (v: unknown) => void
    api().memoryPreparePrimerFile = vi.fn(() => new Promise((r) => { release = r }))
    const p = launchAgentProfile(claude, deps())
    await vi.advanceTimersByTimeAsync(0)
    emit(createdId(), '$ ')
    await vi.advanceTimersByTimeAsync(1000) // shell ready long ago; recall still outstanding
    expect(typed()).toEqual([]) // the newline waits on the recall too — nothing is typed yet
    release({ success: true, data: { file: 'C:/p/primer.md', count: 3 } })
    await vi.advanceTimersByTimeAsync(0)
    emit(createdId(), '\r\n$ ')
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_MS)
    expect(typed().find((s) => s.startsWith('claude'))).toContain('--append-system-prompt-file')
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })
})

describe('launchAgentProfile — downstream timers are re-based onto the command', () => {
  // The Claude trust Enter USED to fire here, 4.5s after the command. It is gone:
  // Claude Code 2.1.x opens that dialog focused on "No, exit", so the blind Enter
  // quit the session and the launch looked cut off. The folder is pre-approved in
  // Claude's own config before the command is typed instead.
  it('never types a blind Enter at Claude — that Enter used to answer "No, exit"', async () => {
    const { done: p } = await startLaunch()
    await shellSpeaksAndEchoes() // command is typed exactly now
    const afterCommand = typed().length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(typed().slice(afterCommand)).toEqual([])
    await p
  })

  it('seeds Claude trust for the picked folder BEFORE typing the command', async () => {
    const { done: p } = await startLaunch()
    // Seeded during the shell wait, so it is on disk by the time Claude reads it.
    expect(api().claudeTrustWorkspace).toHaveBeenCalledWith('/test/project')
    expect(commandTyped()).toBe(false)
    await shellSpeaksAndEchoes()
    expect(commandTyped()).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('launches anyway when the trust seed fails', async () => {
    api().claudeTrustWorkspace = vi.fn(() => Promise.reject(new Error('config locked')))
    const p = launchAgentProfile(claude, deps())
    await vi.advanceTimersByTimeAsync(0)
    await shellSpeaksAndEchoes()
    expect(commandTyped()).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('sends the Codex "1" confirmation on the same re-based schedule', async () => {
    const { done: p } = await startLaunch(codex)
    await shellSpeaksAndEchoes() // command is typed exactly now
    const afterCommand = typed().length
    await vi.advanceTimersByTimeAsync(9000 - LEGACY_COMMAND_AT_MS)
    expect(typed().slice(afterCommand)).toEqual(['1\r'])
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })

  it('never sends a trust confirmation for Gemini', async () => {
    const { done: p } = await startLaunch(gemini)
    await shellSpeaksAndEchoes()
    const afterCommand = typed().length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(typed().slice(afterCommand)).toEqual([])
    await p
  })

  it('dismisses the launch spinner relative to the command as well', async () => {
    const { done: p } = await startLaunch()
    await shellSpeaksAndEchoes() // command is typed exactly now
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
    await vi.advanceTimersByTimeAsync(SHELL_READY_CEILING_MS + PROMPT_ECHO_CEILING_MS)
    expect(commandTyped()).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
  })
})

describe('launchAgentProfile — timers outlive the window they were scheduled from', () => {
  it('drops a queued write instead of throwing when the bridge is gone', async () => {
    // The trust confirmation fires seconds after launch. Under jsdom teardown — and in the real app
    // if the window closes first — `window.termpolis` can be gone by then, and an unguarded write
    // would raise an unhandled exception out of a bare timer callback.
    const { done: p } = await startLaunch(codex)
    await shellSpeaksAndEchoes()
    const writeToTerminal = api().writeToTerminal
    const before = writeToTerminal.mock.calls.length
    ;(window as never as { termpolis: unknown }).termpolis = {} // bridge torn down mid-flight
    await expect(vi.advanceTimersByTimeAsync(20_000)).resolves.not.toThrow()
    expect(writeToTerminal.mock.calls.length).toBe(before) // the "1" confirmation was dropped, not thrown
    await p
  })
})
