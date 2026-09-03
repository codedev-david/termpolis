import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useAutoPrimer,
  useCompactionReprimer,
  isAutoPrimerEnabled,
  setAutoPrimerEnabled,
  injectAutoPrimer,
  buildPrimerPointer,
  reprimeAfterCompaction,
  primeOnLaunch,
  PRIMER_GATE_POLL_MS,
  PRIMER_GATE_MAX_WAIT_MS,
  type PrimerGate,
} from '../../src/renderer/src/hooks/useAutoPrimer'
import { setAutoReprimeOnCompactionEnabled } from '../../src/renderer/src/lib/compactionReprime'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

const KEY = 'termpolis.memory.autoPrimerOnLaunch'
const agent = { name: 'Claude Code' } as any

/** A gate that is already open: an agent Termpolis PROVED is running, on an idle input line. */
const openGate = (): PrimerGate => ({ launchedAgent: () => agent, draft: () => '' })
/** A mutable gate, so a test can open it mid-flight the way a real launch/Enter does. */
function liveGate(init: { launched?: any; draft?: string } = {}) {
  const state = { launched: init.launched ?? null, draft: init.draft ?? '' }
  return {
    state,
    gate: { launchedAgent: () => state.launched, draft: () => state.draft } as PrimerGate,
  }
}

function mockApi(overrides: Record<string, unknown> = {}) {
  ;(window as any).termpolis = {
    memoryBuildPrimer: vi.fn(async () => ({ success: true, data: 'RECALLED CONTEXT' })),
    writeToTerminal: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  mockApi()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('isAutoPrimerEnabled / setAutoPrimerEnabled', () => {
  it('defaults ON when unset', () => {
    expect(isAutoPrimerEnabled()).toBe(true)
  })
  it('is OFF only when explicitly set to "0"', () => {
    setAutoPrimerEnabled(false)
    expect(localStorage.getItem(KEY)).toBe('0')
    expect(isAutoPrimerEnabled()).toBe(false)
    setAutoPrimerEnabled(true)
    expect(localStorage.getItem(KEY)).toBe('1')
    expect(isAutoPrimerEnabled()).toBe(true)
  })
})

describe('injectAutoPrimer', () => {
  it('checks relevance with a project-scoped query and pastes only a pointer (no content dump)', async () => {
    const ok = await injectAutoPrimer('term-1', '/home/me/myproject')
    expect(ok).toBe(true)
    const api = (window as any).termpolis
    expect(api.memoryBuildPrimer).toHaveBeenCalledWith(expect.stringContaining('myproject'), undefined, '/home/me/myproject')
    const [tid, payload] = api.writeToTerminal.mock.calls[0]
    expect(tid).toBe('term-1')
    expect(payload).toContain('\x1b[200~') // bracketed-paste start
    expect(payload).toContain('\x1b[201~') // bracketed-paste end
    // The digest content is NOT pasted — the agent loads it via MCP behind the scenes.
    expect(payload).not.toContain('RECALLED CONTEXT')
    expect(payload).toContain('memory_primer')
    expect(payload).toContain('"/home/me/myproject"')
  })

  it('pastes a background-only contract: no acting on memory, minimal ack, single paste-safe line', async () => {
    await injectAutoPrimer('term-1', 'C:\\code\\acme')
    const [, payload] = (window as any).termpolis.writeToTerminal.mock.calls[0]
    const pointer = payload.slice('\x1b[200~'.length, -'\x1b[201~'.length)
    expect(pointer).not.toContain('\n') // single line — no wall of text in the terminal
    expect(pointer).not.toContain('`')
    expect(pointer).toContain('do NOT act on it')
    expect(pointer).toContain('Memory loaded.')
    expect(pointer).toContain('wait')
    // Mid-task nudge: consult stored solutions before churning through retries.
    expect(pointer).toContain('memory_search')
    expect(pointer).toContain('before re-deriving')
  })

  it('points the agent at the tool with no cwd argument when there is no cwd', async () => {
    await injectAutoPrimer('t', '')
    const [, payload] = (window as any).termpolis.writeToTerminal.mock.calls[0]
    expect(payload).toContain('with no arguments')
    expect(payload).toContain('memory_primer')
  })

  it('strips trailing slashes to derive the project name and passes the cwd through', async () => {
    await injectAutoPrimer('t', 'C:\\code\\acme\\')
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledWith(expect.stringContaining('acme'), undefined, 'C:\\code\\acme\\')
  })

  it('uses a generic query and no cwd when there is none', async () => {
    await injectAutoPrimer('t', '')
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledWith(
      expect.not.stringContaining('context for'),
      undefined,
      undefined,
    )
  })

  it('injects nothing when there is no relevant memory', async () => {
    mockApi({ memoryBuildPrimer: vi.fn(async () => ({ success: true, data: null })) })
    const ok = await injectAutoPrimer('t', '/x/proj')
    expect(ok).toBe(false)
    expect((window as any).termpolis.writeToTerminal).not.toHaveBeenCalled()
  })

  it('returns false when the primer build is unsuccessful', async () => {
    mockApi({ memoryBuildPrimer: vi.fn(async () => ({ success: false })) })
    expect(await injectAutoPrimer('t', '/x')).toBe(false)
  })

  it('returns false when the bridge API is unavailable', async () => {
    ;(window as any).termpolis = undefined
    expect(await injectAutoPrimer('t', '/x')).toBe(false)
  })

  it('swallows errors and never throws into the agent terminal', async () => {
    mockApi({ memoryBuildPrimer: vi.fn(async () => { throw new Error('boom') }) })
    expect(await injectAutoPrimer('t', '/x')).toBe(false)
  })
})

describe('useAutoPrimer', () => {
  it('injects once, after the delay, when an agent is detected and the setting is ON', async () => {
    vi.useFakeTimers()
    const { rerender } = renderHook(({ a }) => useAutoPrimer('term-1', a, '/home/me/proj', openGate()), {
      initialProps: { a: null as any },
    })
    // No agent yet → nothing scheduled.
    await vi.advanceTimersByTimeAsync(2000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()

    // Agent detected → primer fires once after the delay.
    rerender({ a: agent })
    await vi.advanceTimersByTimeAsync(1500)
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledTimes(1)

    // Re-render with the same agent → still only once (prime-once guard).
    rerender({ a: agent })
    await vi.advanceTimersByTimeAsync(1500)
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the setting is OFF', async () => {
    setAutoPrimerEnabled(false)
    vi.useFakeTimers()
    renderHook(() => useAutoPrimer('term-1', agent, '/p', openGate()))
    await vi.advanceTimersByTimeAsync(3000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
  })

  it('does nothing when no agent is detected', async () => {
    vi.useFakeTimers()
    renderHook(() => useAutoPrimer('term-1', null, '/p', openGate()))
    await vi.advanceTimersByTimeAsync(3000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
  })

  it('cancels the pending injection if the terminal unmounts first', async () => {
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useAutoPrimer('term-1', agent, '/p', openGate()))
    unmount()
    await vi.advanceTimersByTimeAsync(3000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
  })

  it('cancels a GATED injection on unmount too (the loop unwinds, it does not fire later)', async () => {
    vi.useFakeTimers()
    const { state, gate } = liveGate() // closed: nothing launched yet
    const { unmount } = renderHook(() => useAutoPrimer('term-1', agent, '/p', gate))
    await vi.advanceTimersByTimeAsync(3000) // polling, gate still shut
    unmount()
    state.launched = agent // gate opens after unmount — must be ignored
    await vi.advanceTimersByTimeAsync(10_000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
  })

  it('skips the typed pointer when the terminal was already seeded at launch', async () => {
    // Claude launches with --append-system-prompt-file → store marks launchPrimed,
    // so the on-detection typed pointer must NOT also fire (no double-prime).
    vi.useFakeTimers()
    useTerminalStore.setState({ terminals: [{ id: 'term-primed', launchPrimed: true } as any] })
    renderHook(() => useAutoPrimer('term-primed', agent, '/home/me/proj', openGate()))
    await vi.advanceTimersByTimeAsync(2000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
    useTerminalStore.setState({ terminals: [] })
  })

  // --- The PowerShell regression (2026-09-03) --------------------------------------------------
  // A plain PowerShell terminal. The user typed `claude` and had NOT pressed Enter. PSReadLine
  // repaints the whole input line on every keystroke, so the echoed word reached the output
  // scraper, detectAgent matched /claude/i, and 1.5 s later the pointer was appended at the
  // cursor. What the user saw at their prompt was one un-runnable command line:
  //   PS C:\Users\DavidEngelhart> claudeTermpolis memory: call the termpolis MCP tool ...
  it('does NOT paste while the user is still typing the launch command', async () => {
    vi.useFakeTimers()
    // Detection has fired off the echo, but nothing was submitted and `claude` is still a draft.
    const { state, gate } = liveGate({ launched: null, draft: 'claude' })
    renderHook(() => useAutoPrimer('term-ps', agent, 'C:\\Users\\DavidEngelhart', gate))
    await vi.advanceTimersByTimeAsync(30_000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
    expect((window as any).termpolis.writeToTerminal).not.toHaveBeenCalled()

    // Enter: the draft clears and the submitted command identifies the agent → now it may paste.
    state.draft = ''
    state.launched = agent
    await vi.advanceTimersByTimeAsync(PRIMER_GATE_POLL_MS + 1500)
    expect((window as any).termpolis.writeToTerminal).toHaveBeenCalledTimes(1)
  })

  it('never pastes when the agent name only ever APPEARED in output (grep hit, MOTD, a filename)', async () => {
    vi.useFakeTimers()
    // `cat claude-notes.md` — the scraper matched, but no agent was ever launched.
    const { gate } = liveGate({ launched: null, draft: '' })
    renderHook(() => useAutoPrimer('term-cat', agent, '/p', gate))
    await vi.advanceTimersByTimeAsync(PRIMER_GATE_MAX_WAIT_MS + 5000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
  })

  it('falls back to the recorded agentCommand when the pane supplies no gate', async () => {
    vi.useFakeTimers()
    useTerminalStore.setState({ terminals: [{ id: 'term-launched', agentCommand: 'codex' } as any] })
    renderHook(() => useAutoPrimer('term-launched', agent, '/home/me/proj'))
    await vi.advanceTimersByTimeAsync(1500)
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledTimes(1)
    useTerminalStore.setState({ terminals: [] })
  })

  it('stays shut with no gate and no recorded agentCommand (a hand-typed launch is invisible here)', async () => {
    vi.useFakeTimers()
    useTerminalStore.setState({ terminals: [{ id: 'term-plain' } as any] })
    renderHook(() => useAutoPrimer('term-plain', agent, '/home/me/proj'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
    useTerminalStore.setState({ terminals: [] })
  })
})

describe('primeOnLaunch (the launch gate)', () => {
  const noSleep = () => Promise.resolve()

  it('injects immediately when the gate is already open', async () => {
    const inject = vi.fn(async () => true)
    expect(await primeOnLaunch('t', '/p', openGate(), { inject, sleep: noSleep })).toBe(true)
    expect(inject).toHaveBeenCalledWith('t', '/p')
  })

  it('waits for the launch command to be submitted, then for the delay', async () => {
    const inject = vi.fn(async () => true)
    const { state, gate } = liveGate()
    let ticks = 0
    const sleep = async () => {
      if (++ticks === 3) state.launched = agent
    }
    expect(await primeOnLaunch('t', '/p', gate, { inject, sleep })).toBe(true)
    expect(ticks).toBe(4) // 3 polls to open the gate + the boot delay
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('gives up rather than pasting when the gate never opens', async () => {
    const inject = vi.fn(async () => true)
    const { gate } = liveGate()
    expect(await primeOnLaunch('t', '/p', gate, { inject, sleep: noSleep, pollMs: 1000, maxWaitMs: 3000 })).toBe(false)
    expect(inject).not.toHaveBeenCalled()
  })

  it('re-checks the gate AFTER the boot delay — a draft typed while the CLI boots blocks the paste', async () => {
    const inject = vi.fn(async () => true)
    const { state, gate } = liveGate({ launched: agent, draft: '' })
    // Gate is open, so the only sleep is the boot delay; the user starts typing during it.
    const sleep = async () => { state.draft = 'explain this' }
    expect(await primeOnLaunch('t', '/p', gate, { inject, sleep })).toBe(false)
    expect(inject).not.toHaveBeenCalled()
  })

  it('bails out when stopped mid-poll (terminal closed)', async () => {
    const inject = vi.fn(async () => true)
    const { gate } = liveGate()
    let stop = false
    const sleep = async () => { stop = true }
    expect(await primeOnLaunch('t', '/p', gate, { inject, sleep, stopped: () => stop })).toBe(false)
    expect(inject).not.toHaveBeenCalled()
  })

  it('bails out when stopped during the boot delay', async () => {
    const inject = vi.fn(async () => true)
    let stop = false
    const sleep = async () => { stop = true }
    expect(await primeOnLaunch('t', '/p', openGate(), { inject, sleep, stopped: () => stop })).toBe(false)
    expect(inject).not.toHaveBeenCalled()
  })

  it('uses real defaults for poll/delay when none are supplied', async () => {
    vi.useFakeTimers()
    const inject = vi.fn(async () => true)
    const { state, gate } = liveGate()
    const p = primeOnLaunch('t', '/p', gate, { inject })
    await vi.advanceTimersByTimeAsync(PRIMER_GATE_POLL_MS * 2)
    expect(inject).not.toHaveBeenCalled()
    state.launched = agent
    await vi.advanceTimersByTimeAsync(PRIMER_GATE_POLL_MS + 1500)
    expect(await p).toBe(true)
    expect(inject).toHaveBeenCalledTimes(1)
  })
})

describe('useCompactionReprimer', () => {
  it('re-primes after a compaction marker settles in the output stream', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCompactionReprimer('term-1', agent, '/home/me/proj'))
    result.current('✻ Compacting conversation… (2m 30s)')
    // Still building/ticking — not yet.
    await vi.advanceTimersByTimeAsync(2000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
    // Output settles → re-prime fires once.
    await vi.advanceTimersByTimeAsync(2000)
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledTimes(1)
  })

  it('reads the LATEST cwd through a ref (stable callback never goes stale)', async () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ cwd }) => useCompactionReprimer('t', agent, cwd), {
      initialProps: { cwd: '/old/proj' },
    })
    const firstCallback = result.current
    rerender({ cwd: 'C:\\code\\acme' })
    expect(result.current).toBe(firstCallback) // identity stable across cwd changes
    result.current('Compacting conversation…')
    await vi.advanceTimersByTimeAsync(4000)
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledWith(
      expect.stringContaining('acme'),
      undefined,
      'C:\\code\\acme',
    )
  })

  it('does not re-prime when no agent is present', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCompactionReprimer('t', null, '/p'))
    result.current('Compacting conversation…')
    await vi.advanceTimersByTimeAsync(5000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
  })

  it('does not re-prime when the setting is OFF', async () => {
    setAutoReprimeOnCompactionEnabled(false)
    vi.useFakeTimers()
    const { result } = renderHook(() => useCompactionReprimer('t', agent, '/p'))
    result.current('Compacting conversation…')
    await vi.advanceTimersByTimeAsync(5000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
  })

  it('cancels a pending re-prime when the terminal unmounts', async () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useCompactionReprimer('t', agent, '/p'))
    result.current('Compacting conversation…')
    unmount()
    await vi.advanceTimersByTimeAsync(5000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
  })
})

describe('primer self-record clause (buildPrimerPointer/injectAutoPrimer param — kept wired for future non-transcript agents)', () => {
  it('buildPrimerPointer is a single paste-safe line with NO self-record clause by default', () => {
    const p = buildPrimerPointer('/home/me/proj')
    expect(p).not.toContain('\n')
    expect(p).not.toContain('`')
    expect(p).toContain('memory_primer')
    expect(p).not.toContain('memory_write')
  })

  it('buildPrimerPointer appends a single-line memory_write self-record instruction when asked', () => {
    const p = buildPrimerPointer('/home/me/proj', true)
    expect(p).not.toContain('\n') // still one paste-safe line
    expect(p).not.toContain('`')
    expect(p).toContain('memory_write')
    expect(p).toContain('not auto-recorded')
  })

  it('injectAutoPrimer pastes the self-record clause when selfRecord is set', async () => {
    await injectAutoPrimer('t', '/x/proj', true)
    const [, payload] = (window as any).termpolis.writeToTerminal.mock.calls[0]
    expect(payload).toContain('memory_write')
  })

  it('injectAutoPrimer omits the self-record clause by default (disk-transcript agents)', async () => {
    await injectAutoPrimer('t', '/x/proj')
    const [, payload] = (window as any).termpolis.writeToTerminal.mock.calls[0]
    expect(payload).not.toContain('memory_write')
  })

  it('useAutoPrimer does NOT add the clause for a disk-transcript agent (Claude)', async () => {
    vi.useFakeTimers()
    renderHook(() => useAutoPrimer('term-claude', { name: 'Claude Code' } as any, '/home/me/proj', openGate()))
    await vi.advanceTimersByTimeAsync(1500)
    const calls = (window as any).termpolis.writeToTerminal.mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).not.toContain('memory_write')
  })
})

describe('memories-loaded banner (Codex / Gemini typed-pointer path)', () => {
  beforeEach(() => {
    useTerminalStore.setState({ memoryNotice: null, terminals: [] })
  })

  // A primer digest is a set of "- [source] snippet" recall lines (renderLine),
  // the same lines the Claude banner counts. Build one with n hits.
  const digest = (n: number) =>
    Array.from({ length: n }, (_, i) => `- [codex] recalled item ${i}`).join('\n')

  it('injectAutoPrimer with notify sets a "🧠 Loaded N memories" banner counting the digest hits', async () => {
    mockApi({ memoryBuildPrimer: vi.fn(async () => ({ success: true, data: digest(3) })) })
    await injectAutoPrimer('t', '/home/me/myproject', false, true)
    expect(useTerminalStore.getState().memoryNotice).toBe('🧠 Loaded 3 memories for "myproject"')
  })

  it('uses the singular "memory" when exactly one hit is recalled', async () => {
    mockApi({ memoryBuildPrimer: vi.fn(async () => ({ success: true, data: digest(1) })) })
    await injectAutoPrimer('t', '/home/me/solo', false, true)
    expect(useTerminalStore.getState().memoryNotice).toBe('🧠 Loaded 1 memory for "solo"')
  })

  it('counts only the "- [" recall lines, ignoring header/augmentation lines', async () => {
    const mixed = 'Project memory (may apply):\n- [claude] a\n- [code] b\nCompetence: 0.8 in x\n- [codex] c'
    mockApi({ memoryBuildPrimer: vi.fn(async () => ({ success: true, data: mixed })) })
    await injectAutoPrimer('t', '/home/me/proj', false, true)
    expect(useTerminalStore.getState().memoryNotice).toBe('🧠 Loaded 3 memories for "proj"')
  })

  it('falls back to "this project" when there is no cwd', async () => {
    mockApi({ memoryBuildPrimer: vi.fn(async () => ({ success: true, data: digest(2) })) })
    await injectAutoPrimer('t', '', false, true)
    expect(useTerminalStore.getState().memoryNotice).toBe('🧠 Loaded 2 memories for "this project"')
  })

  it('does NOT set the banner when notify is not requested (compaction re-prime stays silent)', async () => {
    mockApi({ memoryBuildPrimer: vi.fn(async () => ({ success: true, data: digest(3) })) })
    await injectAutoPrimer('t', '/home/me/myproject') // notify defaults false
    expect(useTerminalStore.getState().memoryNotice).toBeNull()
  })

  it('does NOT set the banner when there is no relevant memory (nothing loaded)', async () => {
    mockApi({ memoryBuildPrimer: vi.fn(async () => ({ success: true, data: null })) })
    await injectAutoPrimer('t', '/home/me/myproject', false, true)
    expect(useTerminalStore.getState().memoryNotice).toBeNull()
  })

  it('useAutoPrimer shows the banner on launch for a detected Codex agent', async () => {
    mockApi({ memoryBuildPrimer: vi.fn(async () => ({ success: true, data: digest(4) })) })
    vi.useFakeTimers()
    renderHook(() => useAutoPrimer('term-codex', { name: 'OpenAI Codex' } as any, '/home/me/proj', openGate()))
    await vi.advanceTimersByTimeAsync(1500)
    expect(useTerminalStore.getState().memoryNotice).toBe('🧠 Loaded 4 memories for "proj"')
  })

  it('useCompactionReprimer re-primes WITHOUT showing the banner (silent recovery)', async () => {
    mockApi({ memoryBuildPrimer: vi.fn(async () => ({ success: true, data: digest(3) })) })
    vi.useFakeTimers()
    const { result } = renderHook(() => useCompactionReprimer('t', { name: 'OpenAI Codex' } as any, '/home/me/proj'))
    result.current('✻ Compacting conversation… (2m 30s)')
    await vi.advanceTimersByTimeAsync(4000)
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledTimes(1)
    expect(useTerminalStore.getState().memoryNotice).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// reprimeAfterCompaction — the "do it behind the scenes, and never on top of a draft" contract.
//
// This exists because of a real complaint: the primer text kept appearing IN Claude's prompt box
// mid-session. It was the compaction re-primer pasting into the input. Two things were wrong:
// Claude never needed the paste (its system-prompt seed survives compaction and tells it to
// re-prime itself), and a paste can land on top of whatever the user is mid-way through typing,
// because writeToTerminal appends at the cursor and the line buffer belongs to the agent's TUI.
// ---------------------------------------------------------------------------------------------
describe('reprimeAfterCompaction', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    isLaunchPrimed: () => false,
    pending: vi.fn(async () => false),
    inject: vi.fn(async () => true),
    sleep: vi.fn(async () => {}),
    pollMs: 10,
    maxWaitMs: 100,
    ...over,
  })

  it('NEVER writes to a launch-primed (Claude) terminal — it re-primes itself', async () => {
    // The whole point. Claude is seeded via --append-system-prompt-file; a system prompt is
    // re-sent every request, so compaction cannot remove it. Pasting is redundant noise, and it
    // is the text the user actually sees appear out of nowhere.
    const d = deps({ isLaunchPrimed: () => true })
    const injected = await reprimeAfterCompaction('t1', '/repo', d)
    expect(injected).toBe(false)
    expect(d.inject).not.toHaveBeenCalled()
    expect(d.pending).not.toHaveBeenCalled() // doesn't even need to look
  })

  it('pastes for a non-launch-primed agent when the input line is idle', async () => {
    // Codex/Gemini have no system-prompt file to append to, so the paste is the only channel.
    const d = deps()
    const injected = await reprimeAfterCompaction('t1', '/repo', d)
    expect(injected).toBe(true)
    expect(d.inject).toHaveBeenCalledWith('t1', '/repo')
  })

  it('WAITS while the user has an un-submitted draft, then pastes into the empty line', async () => {
    // Staging resets on Enter, so "pending" goes false the moment they submit.
    let calls = 0
    const d = deps({ pending: vi.fn(async () => ++calls <= 3) })
    const injected = await reprimeAfterCompaction('t1', '/repo', d)
    expect(injected).toBe(true)
    expect(d.sleep).toHaveBeenCalledTimes(3) // waited out the draft
    expect(d.inject).toHaveBeenCalledTimes(1)
  })

  it('reads the real aiSecurity.inputPending bridge when no override is given', async () => {
    // Covers the default path: the injected `pending` in the other tests bypasses it.
    ;(window as any).aiSecurity = { inputPending: vi.fn(async () => ({ success: true, data: false })) }
    const inject = vi.fn(async () => true)
    const ok = await reprimeAfterCompaction('t1', '/repo', { isLaunchPrimed: () => false, inject, sleep: async () => {}, pollMs: 1, maxWaitMs: 10 })
    expect((window as any).aiSecurity.inputPending).toHaveBeenCalledWith('t1')
    expect(ok).toBe(true)
    delete (window as any).aiSecurity
  })

  it('treats a missing aiSecurity bridge as "not pending" rather than blocking recall', async () => {
    delete (window as any).aiSecurity
    const inject = vi.fn(async () => true)
    const ok = await reprimeAfterCompaction('t1', '/repo', { isLaunchPrimed: () => false, inject, sleep: async () => {}, pollMs: 1, maxWaitMs: 10 })
    expect(ok).toBe(true)
  })

  it('gives up rather than clobber a draft the user never submits', async () => {
    // Losing a re-prime is a nuisance. Concatenating our text onto their half-typed prompt is a
    // bug — so when in doubt, do nothing.
    const d = deps({ pending: vi.fn(async () => true) }) // never idle
    const injected = await reprimeAfterCompaction('t1', '/repo', d)
    expect(injected).toBe(false)
    expect(d.inject).not.toHaveBeenCalled()
  })

  it('does not block the re-prime when the pending bridge is unavailable', async () => {
    // A missing/broken IPC must not silently disable memory recovery.
    const d = deps({ pending: vi.fn(async () => false) })
    const injected = await reprimeAfterCompaction('t1', '/repo', d)
    expect(injected).toBe(true)
  })
})

describe('the compaction re-primer is wired to reprimeAfterCompaction, not a raw paste', () => {
  it('a compaction in a launch-primed terminal types NOTHING into the terminal', async () => {
    vi.useFakeTimers()
    mockApi()
    useTerminalStore.setState({
      terminals: [{ id: 't1', launchPrimed: true } as any],
    })
    const { result } = renderHook(() => useCompactionReprimer('t1', agent, '/repo'))
    result.current('Compacting conversation...')
    await vi.advanceTimersByTimeAsync(5000)
    // The regression, pinned: this used to paste the primer pointer into Claude's input box.
    expect((window as any).termpolis.writeToTerminal).not.toHaveBeenCalled()
  })
})
