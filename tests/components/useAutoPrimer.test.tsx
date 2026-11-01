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
  selfRecordsLessons,
  promptShowing,
  shellAloneNow,
  ALONE_ASKS,
  ALONE_RECHECK_MS,
  PRIMER_GATE_POLL_MS,
  PRIMER_GATE_MAX_WAIT_MS,
  PRIMER_SUBMIT_SETTLE_MS,
  type PrimerGate,
} from '../../src/renderer/src/hooks/useAutoPrimer'
import { setAutoReprimeOnCompactionEnabled } from '../../src/renderer/src/lib/compactionReprime'
import { psQuote } from '../../src/shared/shellQuote'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

const KEY = 'termpolis.memory.autoPrimerOnLaunch'
const agent = { name: 'Claude Code' } as any
const IDLE_SCREEN = '>_ OpenAI Codex\r\n\r\n› \r\n  ? for shortcuts'
/** Codex's folder-trust prompt, as it sits on screen right after launch. */
const TRUST_SCREEN =
  'Do you trust the contents of this directory?\r\n\r\n' +
  '› 1. Yes, continue\r\n  2. No, quit\r\n\r\n  Press enter to continue'

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
    // An agent's idle composer: nothing on screen waiting for an answer.
    readTerminalBuffer: vi.fn(async () => ({ success: true, data: { output: IDLE_SCREEN } })),
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
    // The folder is named in single quotes: between double quotes a shell would expand it.
    expect(payload).toContain("'/home/me/myproject'")
    expect(payload).not.toContain('"/home/me/myproject"')
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
    expect(inject).toHaveBeenCalledWith('t', '/p', false)
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
    expect(useTerminalStore.getState().memoryNotice).toBeNull() // the pointer is pasted, not yet submitted
    await vi.advanceTimersByTimeAsync(PRIMER_SUBMIT_SETTLE_MS)  // the Enter goes in, and then the banner
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

// The Codex-on-Linux report: "this paragraph keeps getting repeated in the input area".
// Two independent causes, one symptom — the pointer was pasted but never submitted, so it
// sat in the composer; and the "prime once" guard was a per-mount ref, so every pane
// remount pasted another copy on top of the one already sitting there.
describe('the launch pointer is submitted, once', () => {
  beforeEach(() => {
    localStorage.clear()
    ;(window as any).termpolis = {
      memoryBuildPrimer: vi.fn(async () => ({ success: true, data: 'MEMORY DIGEST' })),
      writeToTerminal: vi.fn(),
      readTerminalBuffer: vi.fn(async () => ({ success: true, data: { output: IDLE_SCREEN } })),
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    useTerminalStore.setState({ terminals: [] })
  })

  it('presses Enter as a SEPARATE write, after a settling pause', async () => {
    // Fused into the pasted string, `\r` is just more paste content: a TUI that
    // detects paste bursts (Codex does) deliberately does not submit on it. Two
    // writes with a gap between them are two reads at the pty, which is what a
    // person pressing Return looks like. Asserting the call count is what pins
    // that down — collapsing it back to one write is the bug returning.
    const slept: number[] = []
    const ok = await injectAutoPrimer('t1', '/home/me/proj', false, false, async (ms) => { slept.push(ms) })
    expect(ok).toBe(true)
    const w = (window as any).termpolis.writeToTerminal
    expect(w).toHaveBeenCalledTimes(2)
    expect(w.mock.calls[0][1]).toContain('\x1b[201~') // the bracketed paste, whole
    expect(w.mock.calls[0][1]).not.toContain('\r')
    expect(w.mock.calls[1][1]).toBe('\r')
    expect(slept).toEqual([PRIMER_SUBMIT_SETTLE_MS])
  })

  it('waits long enough that the paste burst has closed', async () => {
    expect(PRIMER_SUBMIT_SETTLE_MS).toBeGreaterThanOrEqual(100)
  })

  it('does not press Enter when there was nothing worth pasting', async () => {
    ;(window as any).termpolis.memoryBuildPrimer = vi.fn(async () => ({ success: false }))
    expect(await injectAutoPrimer('t1', '/p', false, false, async () => {})).toBe(false)
    expect((window as any).termpolis.writeToTerminal).not.toHaveBeenCalled()
  })

  it('pastes only once across a pane remount', async () => {
    // A TerminalPane is remounted by anything that rebuilds the layout: toggling
    // split view, hiding a terminal, switching workspaces. The guard has to live
    // on the terminal, because the component does not survive any of those.
    vi.useFakeTimers()
    useTerminalStore.setState({ terminals: [{ id: 'term-remount', agentCommand: 'codex' } as any] })
    const first = renderHook(() => useAutoPrimer('term-remount', agent, '/home/me/proj', openGate()))
    await vi.advanceTimersByTimeAsync(2000)
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledTimes(1)
    expect(useTerminalStore.getState().terminals[0].primerPointed).toBe(true)

    first.unmount()
    renderHook(() => useAutoPrimer('term-remount', agent, '/home/me/proj', openGate()))
    await vi.advanceTimersByTimeAsync(20_000)
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledTimes(1)
  })

  it('marks a launch-seeded terminal as pointed so remounts stay quiet too', async () => {
    vi.useFakeTimers()
    useTerminalStore.setState({ terminals: [{ id: 'term-seeded', launchPrimed: true } as any] })
    renderHook(() => useAutoPrimer('term-seeded', agent, '/home/me/proj', openGate()))
    await vi.advanceTimersByTimeAsync(2000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().terminals[0].primerPointed).toBe(true)
  })

  it('still primes a terminal the store has no record of', async () => {
    // Belt and braces: no record means nothing to mark, and the per-mount ref is
    // all that is left. It must not turn into "never prime".
    vi.useFakeTimers()
    useTerminalStore.setState({ terminals: [] })
    renderHook(() => useAutoPrimer('term-ghost', agent, '/home/me/proj', openGate()))
    await vi.advanceTimersByTimeAsync(2000)
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledTimes(1)
  })
})

// The pointer goes in with an Enter, and an Enter on a trust or approval prompt answers it.
// A paste 1.5 s into a Codex launch used to accept its folder-trust prompt that way, so
// every path that types the pointer looks at the screen first.
describe('the pointer never answers a prompt', () => {
  const screen = (output: string) => vi.fn(async () => ({ success: true, data: { output } }))

  describe('promptShowing', () => {
    it('is false for an idle composer', async () => {
      expect(await promptShowing('t1')).toBe(false)
    })

    it('is true while a trust prompt is on screen', async () => {
      mockApi({ readTerminalBuffer: screen(TRUST_SCREEN) })
      expect(await promptShowing('t1')).toBe(true)
    })

    it('reads a buffer with no output as an empty screen', async () => {
      mockApi({ readTerminalBuffer: vi.fn(async () => ({ success: true, data: {} })) })
      expect(await promptShowing('t1')).toBe(false)
    })

    it('counts a screen it cannot read as a prompt', async () => {
      // A false alarm only holds a paste back; a wrong all-clear types into a prompt.
      mockApi({ readTerminalBuffer: undefined })
      expect(await promptShowing('t1')).toBe(true)
      mockApi({ readTerminalBuffer: vi.fn(async () => ({ success: false })) })
      expect(await promptShowing('t1')).toBe(true)
      mockApi({ readTerminalBuffer: vi.fn(async () => ({ success: true, data: null })) })
      expect(await promptShowing('t1')).toBe(true)
      mockApi({ readTerminalBuffer: vi.fn(async () => { throw new Error('gone') }) })
      expect(await promptShowing('t1')).toBe(true)
      ;(window as any).termpolis = undefined
      expect(await promptShowing('t1')).toBe(true)
    })
  })

  describe('injectAutoPrimer', () => {
    it('types nothing while a prompt is showing', async () => {
      mockApi({ readTerminalBuffer: screen(TRUST_SCREEN) })
      useTerminalStore.setState({ memoryNotice: null })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, true, async () => {})).toBe(false)
      expect((window as any).termpolis.writeToTerminal).not.toHaveBeenCalled()
      expect(useTerminalStore.getState().memoryNotice).toBeNull()
    })

    it('holds the Enter back when a prompt comes up after the paste', async () => {
      const read = vi.fn()
        .mockResolvedValueOnce({ success: true, data: { output: IDLE_SCREEN } })
        .mockResolvedValue({ success: true, data: { output: TRUST_SCREEN } })
      mockApi({ readTerminalBuffer: read })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, async () => {})).toBe(false)
      const w = (window as any).termpolis.writeToTerminal
      expect(w).toHaveBeenCalledTimes(1) // the paste went in; the Enter did not
      expect(w.mock.calls[0][1]).not.toContain('\r')
      expect(read).toHaveBeenCalledTimes(2)
    })
  })

  describe('primeOnLaunch', () => {
    /** A prompt that is still up for the first `polls` looks, then answered. */
    const answeredAfter = (polls: number) => {
      let left = polls
      return async () => left-- > 0
    }

    it('waits the prompt out, then primes', async () => {
      const inject = vi.fn(async () => true)
      const slept: number[] = []
      const ok = await primeOnLaunch('t1', '/p', openGate(), {
        inject, awaiting: answeredAfter(2), sleep: async (ms) => { slept.push(ms) }, pollMs: 10, delayMs: 5,
      })
      expect(ok).toBe(true)
      expect(inject).toHaveBeenCalledTimes(1)
      expect(slept).toEqual([5, 10, 10])
    })

    it('gives up if the prompt is still there when the wait runs out', async () => {
      const inject = vi.fn(async () => true)
      const ok = await primeOnLaunch('t1', '/p', openGate(), {
        inject, awaiting: async () => true, sleep: async () => {}, pollMs: 10, maxWaitMs: 30, delayMs: 0,
      })
      expect(ok).toBe(false)
      expect(inject).not.toHaveBeenCalled()
    })

    it('shares one wait budget between the launch gate and the prompt', async () => {
      // Two polls waiting for the launch plus two on a prompt need 40 ms; 30 are allowed.
      let closedPolls = 2
      const gate: PrimerGate = { launchedAgent: () => (closedPolls > 0 ? null : agent), draft: () => '' }
      const inject = vi.fn(async () => true)
      const ok = await primeOnLaunch('t1', '/p', gate, {
        inject, awaiting: answeredAfter(2), sleep: async () => { closedPolls-- }, pollMs: 10, maxWaitMs: 30, delayMs: 0,
      })
      expect(ok).toBe(false)
      expect(inject).not.toHaveBeenCalled()
    })

    it('stops waiting when the terminal goes away', async () => {
      const inject = vi.fn(async () => true)
      let polls = 0
      const ok = await primeOnLaunch('t1', '/p', openGate(), {
        inject, awaiting: async () => true, sleep: async () => { polls++ }, stopped: () => polls > 1, pollMs: 10, delayMs: 0,
      })
      expect(ok).toBe(false)
      expect(inject).not.toHaveBeenCalled()
    })

    it('does not paste over a draft typed while it waited', async () => {
      let typed = false
      const gate: PrimerGate = { launchedAgent: () => agent, draft: () => (typed ? 'fix the' : '') }
      const inject = vi.fn(async () => true)
      const ok = await primeOnLaunch('t1', '/p', gate, {
        inject,
        awaiting: async () => { const up = !typed; typed = true; return up },
        sleep: async () => {}, pollMs: 10, delayMs: 0,
      })
      expect(ok).toBe(false)
      expect(inject).not.toHaveBeenCalled()
    })

    it('reads the screen when no check is passed in', async () => {
      mockApi({ readTerminalBuffer: screen(TRUST_SCREEN) })
      const inject = vi.fn(async () => true)
      const ok = await primeOnLaunch('t1', '/p', openGate(), {
        inject, sleep: async () => {}, pollMs: 10, maxWaitMs: 20, delayMs: 0,
      })
      expect(ok).toBe(false)
      expect(inject).not.toHaveBeenCalled()
      expect((window as any).termpolis.readTerminalBuffer).toHaveBeenCalledWith('t1')
    })
  })

  describe('reprimeAfterCompaction', () => {
    it('waits for the prompt to be answered before re-priming', async () => {
      let left = 2
      const slept: number[] = []
      const inject = vi.fn(async () => true)
      const ok = await reprimeAfterCompaction('t1', '/p', {
        isLaunchPrimed: () => false,
        pending: async () => false,
        awaiting: async () => left-- > 0,
        inject, sleep: async (ms) => { slept.push(ms) }, pollMs: 10,
      })
      expect(ok).toBe(true)
      expect(inject).toHaveBeenCalledTimes(1)
      expect(slept).toEqual([10, 10])
    })

    it('skips the re-prime when the prompt outlasts the wait', async () => {
      const inject = vi.fn(async () => true)
      const ok = await reprimeAfterCompaction('t1', '/p', {
        isLaunchPrimed: () => false,
        pending: async () => false,
        awaiting: async () => true,
        inject, sleep: async () => {}, pollMs: 10, maxWaitMs: 30,
      })
      expect(ok).toBe(false)
      expect(inject).not.toHaveBeenCalled()
    })

    it('reads the screen when no check is passed in', async () => {
      mockApi({ readTerminalBuffer: screen(TRUST_SCREEN) })
      const inject = vi.fn(async () => true)
      const ok = await reprimeAfterCompaction('t1', '/p', {
        isLaunchPrimed: () => false, pending: async () => false, inject, sleep: async () => {}, pollMs: 10, maxWaitMs: 20,
      })
      expect(ok).toBe(false)
      expect(inject).not.toHaveBeenCalled()
    })
  })
})

describe('when a bridge call fails', () => {
  it('treats unreadable storage as the default, enabled', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    try {
      expect(isAutoPrimerEnabled()).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('re-primes when the draft check itself throws', async () => {
    const before = (window as any).aiSecurity
    ;(window as any).aiSecurity = { inputPending: vi.fn(async () => { throw new Error('bridge gone') }) }
    try {
      const inject = vi.fn(async () => true)
      const ok = await reprimeAfterCompaction('t1', '/p', { isLaunchPrimed: () => false, awaiting: async () => false, inject })
      expect(ok).toBe(true)
      expect(inject).toHaveBeenCalledTimes(1)
    } finally {
      ;(window as any).aiSecurity = before
    }
  })
})

describe('selfRecordsLessons: which agents record their own lessons', () => {
  it('asks only agy (Gemini through the Antigravity CLI), whose sessions are not read from disk', () => {
    expect(selfRecordsLessons('agy')).toBe(true)
    expect(selfRecordsLessons('  agy --model gemini-3')).toBe(true)
    // The older Gemini CLI shares the display name, but its transcripts ARE ingested.
    expect(selfRecordsLessons('gemini')).toBe(false)
    expect(selfRecordsLessons('claude')).toBe(false)
    expect(selfRecordsLessons('codex')).toBe(false)
    expect(selfRecordsLessons(null)).toBe(false)
    expect(selfRecordsLessons(undefined)).toBe(false)
  })

  it('primeOnLaunch asks for self-recorded lessons only when the launch command was agy', async () => {
    const noSleep = async (): Promise<void> => {}
    const gateFor = (command: string | undefined) => ({
      launchedAgent: () => ({ name: 'Gemini CLI', icon: '', color: '' }),
      draft: () => '',
      launchCommand: () => command,
    })
    for (const [command, expected] of [['agy', true], ['gemini', false], ['codex', false], [undefined, false]] as const) {
      const inject = vi.fn(async () => true)
      expect(await primeOnLaunch('t', '/p', gateFor(command), { inject, sleep: noSleep, awaiting: async () => false })).toBe(true)
      expect(inject).toHaveBeenCalledWith('t', '/p', expected)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The pointer goes in with an Enter, and at a SHELL's prompt that Enter runs it as a command. An
// agent that died while it started leaves exactly that prompt behind (a missing binary, a failed
// sign-in, a crash on boot), and the screen cannot always tell it from an agent at its input:
// Claude Code and Antigravity leave their last frame on screen when they exit. So the OS is asked,
// before the paste and again before the Enter, whether anything but the shell runs in the terminal
// (terminalShellAlone, shellAlone.ts: the same question the model switcher asks).
// ---------------------------------------------------------------------------------------------
describe('the pointer is never typed at a shell prompt', () => {
  /** A terminalShellAlone that answers each call in turn and then repeats its last answer; an Error is thrown. */
  const asking = (...answers: unknown[]) => {
    let at = 0
    return vi.fn(async (_id: string) => {
      const next = answers[Math.min(at++, answers.length - 1)]
      if (next instanceof Error) throw next
      return next
    })
  }
  const alone = (data: unknown) => ({ success: true, data })
  const quick = async (): Promise<void> => {}
  const writes = (): string[] => (window as any).termpolis.writeToTerminal.mock.calls.map((c: unknown[]) => c[1] as string)

  beforeEach(() => {
    useTerminalStore.setState({ memoryNotice: null, terminals: [] })
  })

  describe('shellAloneNow', () => {
    it('is true only when the OS says nothing runs in the terminal but its shell', async () => {
      mockApi({ terminalShellAlone: asking(alone(true)) })
      expect(await shellAloneNow('t1')).toBe(true)
      expect((window as any).termpolis.terminalShellAlone).toHaveBeenCalledWith('t1')
    })

    it.each([
      ['something else runs', alone(false)],
      ['the OS cannot tell', alone(null)],
      ['the call failed', { success: false, error: 'Invalid terminal id' }],
      ['the call answers nothing', undefined],
      ['a data that is not a boolean', alone('true')],
      ['a count', alone(1)],
      ['a success that is not a boolean', { success: 'yes', data: true }],
    ])('is false when %s', async (_why, answer) => {
      mockApi({ terminalShellAlone: asking(answer) })
      expect(await shellAloneNow('t1')).toBe(false)
    })

    it('is false when the call throws or rejects', async () => {
      mockApi({ terminalShellAlone: asking(new Error('ipc gone')) })
      expect(await shellAloneNow('t1')).toBe(false)
      mockApi({ terminalShellAlone: vi.fn(() => { throw new Error('thrown at once') }) })
      expect(await shellAloneNow('t1')).toBe(false)
    })

    it('is false on a bridge without the call (an older preload) and with no bridge at all', async () => {
      mockApi() // the default test bridge has no terminalShellAlone
      expect(await shellAloneNow('t1')).toBe(false)
      ;(window as any).termpolis = undefined
      expect(await shellAloneNow('t1')).toBe(false)
    })
  })

  describe('injectAutoPrimer', () => {
    it('asks the OS about this terminal before the paste and again before the Enter', async () => {
      const log: string[] = []
      mockApi({
        terminalShellAlone: vi.fn(async (id: string) => { log.push(`ask ${id}`); return alone(false) }),
        writeToTerminal: vi.fn((_id: string, data: string) => { log.push(data === '\r' ? 'enter' : 'paste') }),
      })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick)).toBe(true)
      expect(log).toEqual(['ask t1', 'paste', 'ask t1', 'enter'])
    })

    it('types nothing, and says nothing, when only the shell runs in the terminal', async () => {
      const terminalShellAlone = asking(alone(true))
      mockApi({ terminalShellAlone })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, true, quick)).toBe(false)
      expect(writes()).toEqual([]) // no paste and no Enter
      expect(terminalShellAlone).toHaveBeenCalledTimes(ALONE_ASKS) // it is asked until it has been sure
      // A launch prime that never happened must not announce "Loaded N memories".
      expect(useTerminalStore.getState().memoryNotice).toBeNull()
      // The recall check ran first: it is what says there is anything to point at.
      expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledTimes(1)
    })

    it('leaves the Enter out when the agent exits between the paste and the Enter', async () => {
      const terminalShellAlone = asking(alone(false), alone(true))
      mockApi({ terminalShellAlone })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick)).toBe(false)
      const sent = writes()
      expect(sent).toHaveLength(1) // the paste went in; the Enter did not
      expect(sent[0]).toContain('memory_primer')
      expect(sent).not.toContain('\r')
      expect(terminalShellAlone).toHaveBeenCalledTimes(2)
    })

    it('asks the OS only after it has a pointer to type (no memory, no question)', async () => {
      const terminalShellAlone = asking(alone(true))
      mockApi({ terminalShellAlone, memoryBuildPrimer: vi.fn(async () => ({ success: true, data: null })) })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick)).toBe(false)
      expect(terminalShellAlone).not.toHaveBeenCalled()
    })

    it('asks the OS first and looks at the screen last, before the paste and before the Enter', async () => {
      // The OS takes a second or two on Windows. The screen look is what keeps the Enter from
      // answering a prompt, so a prompt that comes up while the OS answers must still be seen.
      const log: string[] = []
      mockApi({
        terminalShellAlone: vi.fn(async () => { log.push('os'); return alone(false) }),
        readTerminalBuffer: vi.fn(async () => { log.push('screen'); return { success: true, data: { output: IDLE_SCREEN } } }),
        writeToTerminal: vi.fn((_id: string, data: string) => { log.push(data === '\r' ? 'enter' : 'paste') }),
      })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick)).toBe(true)
      expect(log).toEqual(['os', 'screen', 'paste', 'os', 'screen', 'enter'])
    })

    it('types nothing when a prompt is on screen, however the OS answers', async () => {
      const terminalShellAlone = asking(alone(false))
      mockApi({ terminalShellAlone, readTerminalBuffer: vi.fn(async () => ({ success: true, data: { output: TRUST_SCREEN } })) })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick)).toBe(false)
      expect(terminalShellAlone).toHaveBeenCalledTimes(1)
      expect(writes()).toEqual([])
    })

    it('holds the Enter back when a prompt comes up while the OS is answering', async () => {
      const terminalShellAlone = asking(alone(false))
      const read = vi.fn()
        .mockResolvedValueOnce({ success: true, data: { output: IDLE_SCREEN } })
        .mockResolvedValue({ success: true, data: { output: TRUST_SCREEN } })
      mockApi({ terminalShellAlone, readTerminalBuffer: read })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick)).toBe(false)
      expect(terminalShellAlone).toHaveBeenCalledTimes(2)
      expect(read).toHaveBeenCalledTimes(2)
      expect(writes()).toHaveLength(1) // the paste went in; the Enter did not
    })

    it('does not look at the screen once the OS says only the shell runs', async () => {
      const read = vi.fn(async () => ({ success: true, data: { output: IDLE_SCREEN } }))
      mockApi({ terminalShellAlone: asking(alone(true)), readTerminalBuffer: read })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick)).toBe(false)
      expect(read).not.toHaveBeenCalled()
    })

    // On Windows an agent's process is not on the console the moment the launch command echoes, and
    // that early answer is the one for an agent that has gone: the prime was dropped for good (it is
    // never retried). So before the paste "only the shell runs" has to be said again, a little
    // later, and a dead agent is still a dead one.
    describe('an agent that is still starting', () => {
      it('is asked about again before it is taken for one that has gone', async () => {
        const terminalShellAlone = asking(alone(true))
        const read = vi.fn(async () => ({ success: true, data: { output: IDLE_SCREEN } }))
        mockApi({ terminalShellAlone, readTerminalBuffer: read })
        const sleep = vi.fn(async (_ms: number) => {})
        expect(await injectAutoPrimer('t1', '/home/me/proj', false, true, sleep)).toBe(false)
        expect(terminalShellAlone).toHaveBeenCalledTimes(ALONE_ASKS)
        expect(sleep.mock.calls).toEqual(Array.from({ length: ALONE_ASKS - 1 }, () => [ALONE_RECHECK_MS]))
        expect(read).not.toHaveBeenCalled()
        expect(writes()).toEqual([])
        expect(useTerminalStore.getState().memoryNotice).toBeNull()
      })

      it('is primed when the second answer finds it', async () => {
        const terminalShellAlone = asking(alone(true), alone(false))
        mockApi({ terminalShellAlone })
        const sleep = vi.fn(async (_ms: number) => {})
        expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, sleep)).toBe(true)
        expect(writes()).toHaveLength(2)
        expect(terminalShellAlone).toHaveBeenCalledTimes(3) // two before the paste, one before the Enter
        expect(sleep.mock.calls).toEqual([[ALONE_RECHECK_MS], [PRIMER_SUBMIT_SETTLE_MS]])
      })

      it('is primed when the last answer finds it', async () => {
        mockApi({ terminalShellAlone: asking(alone(true), alone(true), alone(false)) })
        expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick)).toBe(true)
        expect(writes()).toHaveLength(2)
      })

      it('is typed at as before when a later answer cannot tell', async () => {
        const terminalShellAlone = asking(alone(true), alone(null))
        mockApi({ terminalShellAlone })
        expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick)).toBe(true)
        expect(writes()).toHaveLength(2)
        expect(terminalShellAlone).toHaveBeenCalledTimes(3)
      })

      it('is asked about once, not again, before the Enter', async () => {
        const terminalShellAlone = asking(alone(false), alone(true))
        mockApi({ terminalShellAlone })
        const sleep = vi.fn(async (_ms: number) => {})
        expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, sleep)).toBe(false)
        expect(terminalShellAlone).toHaveBeenCalledTimes(2)
        expect(sleep.mock.calls).toEqual([[PRIMER_SUBMIT_SETTLE_MS]]) // no second chance for an agent that was there
        expect(writes()).toHaveLength(1)
      })

      it('still waits out a prompt and a draft once it has been found', async () => {
        mockApi({ terminalShellAlone: asking(alone(true), alone(false)), readTerminalBuffer: vi.fn(async () => ({ success: true, data: { output: TRUST_SCREEN } })) })
        expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick)).toBe(false)
        mockApi({ terminalShellAlone: asking(alone(true), alone(false)) })
        expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick, () => false)).toBe(false)
        expect(writes()).toEqual([])
      })
    })

    // Anything short of a definite "only the shell runs" is today's behaviour: the pointer is typed.
    it.each([
      ['the OS cannot tell', alone(null)],
      ['the call failed', { success: false, error: 'Invalid terminal id' }],
      ['the call answers nothing', undefined],
      ['the call rejects', new Error('ipc gone')],
    ])('types the pointer and presses Enter as before when %s', async (_why, answer) => {
      const terminalShellAlone = asking(answer)
      mockApi({ terminalShellAlone })
      useTerminalStore.setState({ memoryNotice: null })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, true, quick)).toBe(true)
      const sent = writes()
      expect(sent).toHaveLength(2)
      expect(sent[0]).toContain('memory_primer')
      expect(sent[1]).toBe('\r')
      expect(terminalShellAlone).toHaveBeenCalledTimes(2)
      expect(useTerminalStore.getState().memoryNotice).toBe('🧠 Loaded 0 memories for "proj"')
    })

    it('types the pointer as before on a bridge that has no terminalShellAlone', async () => {
      mockApi()
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick)).toBe(true)
      expect(writes()).toHaveLength(2)
    })

    it('announces the load once the Enter is in, not before', async () => {
      const log: string[] = []
      mockApi({
        terminalShellAlone: vi.fn(async () => { log.push(`ask, banner ${useTerminalStore.getState().memoryNotice}`); return alone(false) }),
        writeToTerminal: vi.fn((_id: string, data: string) => { log.push(`${data === '\r' ? 'enter' : 'paste'}, banner ${useTerminalStore.getState().memoryNotice}`) }),
      })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, true, quick)).toBe(true)
      expect(log).toEqual(['ask, banner null', 'paste, banner null', 'ask, banner null', 'enter, banner null'])
      expect(useTerminalStore.getState().memoryNotice).toBe('🧠 Loaded 0 memories for "proj"')
    })

    // A banner for a recall that did not happen: the pasted line is left unsent, so nothing was loaded.
    it.each([
      ['the agent exits after the paste', { terminalShellAlone: asking(alone(false), alone(true)) }, undefined],
      [
        'a prompt comes up after the paste',
        {
          terminalShellAlone: asking(alone(false)),
          readTerminalBuffer: vi.fn()
            .mockResolvedValueOnce({ success: true, data: { output: IDLE_SCREEN } })
            .mockResolvedValue({ success: true, data: { output: TRUST_SCREEN } }),
        },
        undefined,
      ],
      ['the user starts typing after the paste', {}, vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)],
    ])('does not announce the load when %s', async (_why, api, idle) => {
      mockApi(api)
      useTerminalStore.setState({ memoryNotice: null })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, true, quick, idle)).toBe(false)
      expect(writes()).toHaveLength(1) // the paste went in; the Enter did not
      expect(useTerminalStore.getState().memoryNotice).toBeNull()
    })

    it('does not announce the load when the Enter cannot be written', async () => {
      mockApi({
        writeToTerminal: vi.fn((_id: string, data: string) => { if (data === '\r') throw new Error('terminal closed') }),
      })
      useTerminalStore.setState({ memoryNotice: null })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, true, quick)).toBe(false)
      expect(useTerminalStore.getState().memoryNotice).toBeNull()
    })
  })

  describe('on every path that types the pointer', () => {
    it('the launch prime types nothing at the prompt of an agent that exited', async () => {
      vi.useFakeTimers() // the OS is asked again a little later before it is believed
      const terminalShellAlone = asking(alone(true))
      mockApi({ terminalShellAlone })
      const done = primeOnLaunch('t1', '/home/me/proj', openGate(), { sleep: quick, awaiting: async () => false, delayMs: 0 })
      await vi.advanceTimersByTimeAsync(ALONE_RECHECK_MS * ALONE_ASKS)
      expect(await done).toBe(false)
      expect(terminalShellAlone).toHaveBeenCalledTimes(ALONE_ASKS)
      expect(writes()).toEqual([])
      expect(useTerminalStore.getState().memoryNotice).toBeNull()
    })

    it('the launch prime types the pointer as before while the agent runs', async () => {
      mockApi({ terminalShellAlone: asking(alone(false)) })
      const ok = await primeOnLaunch('t1', '/home/me/proj', openGate(), { sleep: quick, awaiting: async () => false, delayMs: 0 })
      expect(ok).toBe(true)
      expect(writes()).toHaveLength(2)
    })

    it('the compaction re-prime types nothing at the prompt of an agent that exited', async () => {
      vi.useFakeTimers()
      const terminalShellAlone = asking(alone(true))
      mockApi({ terminalShellAlone })
      const done = reprimeAfterCompaction('t1', '/home/me/proj', {
        isLaunchPrimed: () => false, pending: async () => false, awaiting: async () => false, sleep: quick,
      })
      await vi.advanceTimersByTimeAsync(ALONE_RECHECK_MS * ALONE_ASKS)
      expect(await done).toBe(false)
      expect(terminalShellAlone).toHaveBeenCalledTimes(ALONE_ASKS)
      expect(writes()).toEqual([])
    })

    it('the compaction re-prime types the pointer as before while the agent runs', async () => {
      mockApi({ terminalShellAlone: asking(alone(false)) })
      const ok = await reprimeAfterCompaction('t1', '/home/me/proj', {
        isLaunchPrimed: () => false, pending: async () => false, awaiting: async () => false, sleep: quick,
      })
      expect(ok).toBe(true)
      expect(writes()).toHaveLength(2)
    })

    it('useAutoPrimer: an agent that died while it started gets nothing typed', async () => {
      vi.useFakeTimers()
      const terminalShellAlone = asking(alone(true))
      mockApi({ terminalShellAlone })
      renderHook(() => useAutoPrimer('term-dead', agent, '/home/me/proj', openGate()))
      await vi.advanceTimersByTimeAsync(10_000) // the boot delay, then the OS asked until it is sure
      expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledTimes(1)
      expect(terminalShellAlone).toHaveBeenCalledTimes(ALONE_ASKS)
      expect(writes()).toEqual([])
      expect(useTerminalStore.getState().memoryNotice).toBeNull()
    })

    it('useAutoPrimer: an agent that takes its time to start is primed once it shows', async () => {
      vi.useFakeTimers()
      mockApi({ terminalShellAlone: asking(alone(true), alone(false)) })
      renderHook(() => useAutoPrimer('term-slow', agent, '/home/me/proj', openGate()))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(writes()).toHaveLength(2)
      expect(writes()[1]).toBe('\r')
    })

    it('useAutoPrimer: a change of folder after the prime does not type a second pointer', async () => {
      vi.useFakeTimers()
      mockApi({ terminalShellAlone: asking(alone(false)) })
      const { rerender } = renderHook(({ cwd }) => useAutoPrimer('term-cd', agent, cwd, openGate()), {
        initialProps: { cwd: '/home/me/a' },
      })
      await vi.advanceTimersByTimeAsync(5000)
      expect(writes()).toHaveLength(2) // the pointer and its Enter
      rerender({ cwd: '/home/me/b' })
      await vi.advanceTimersByTimeAsync(5000)
      expect(writes()).toHaveLength(2) // still the one
    })

    it('useAutoPrimer: types the pointer once the OS says the agent runs', async () => {
      vi.useFakeTimers()
      mockApi({ terminalShellAlone: asking(alone(false)) })
      renderHook(() => useAutoPrimer('term-live', agent, '/home/me/proj', openGate()))
      await vi.advanceTimersByTimeAsync(5000)
      expect(writes()).toHaveLength(2)
      expect(writes()[1]).toBe('\r')
    })

    it('useCompactionReprimer: an agent that exited gets no re-prime typed', async () => {
      vi.useFakeTimers()
      const terminalShellAlone = asking(alone(true))
      mockApi({ terminalShellAlone })
      const { result } = renderHook(() => useCompactionReprimer('term-dead', agent, '/home/me/proj'))
      result.current('✻ Compacting conversation… (2m 30s)')
      await vi.advanceTimersByTimeAsync(12_000) // the quiet window, then the OS asked until it is sure
      expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledTimes(1)
      expect(terminalShellAlone).toHaveBeenCalledTimes(ALONE_ASKS)
      expect(writes()).toEqual([])
    })

    it('useCompactionReprimer: re-primes as before while the agent runs', async () => {
      vi.useFakeTimers()
      mockApi({ terminalShellAlone: asking(alone(false)) })
      const { result } = renderHook(() => useCompactionReprimer('term-live', agent, '/home/me/proj'))
      result.current('✻ Compacting conversation… (2m 30s)')
      await vi.advanceTimersByTimeAsync(6000)
      expect(writes()).toHaveLength(2)
    })
  })
})

// ---------------------------------------------------------------------------------------------
// The OS question takes a second or two on Windows, and the person at the keyboard does not wait
// for it. writeToTerminal appends at the cursor, so the draft is looked at LAST, after the OS and
// the screen, right before the paste and again right before the Enter: a line that was empty when
// the prime began is not necessarily empty when the OS has answered. A paste that lands after the
// draft, or an Enter that submits it together with the pointer, corrupts the person's prompt.
// ---------------------------------------------------------------------------------------------
describe('the pointer is never typed over what the user is typing', () => {
  const alone = (data: unknown) => ({ success: true, data })
  const quick = async (): Promise<void> => {}

  /**
   * One terminal as the three places that can see its input know it: the agent's composer, main's
   * input staging (an AI-flagged terminal stages the primer's OWN paste too, until the next submit)
   * and the pane's draft (the user's keystrokes, never what the primer wrote). `onAsk` runs inside
   * the nth OS question: the moment the person starts typing.
   */
  interface Term {
    asks: number
    draft: string
    staging: string
    composer: string
    writes: string[]
    submitted: string[]
    type(text: string): void
  }
  function terminal(onAsk: (n: number, t: Term) => void = () => {}): Term {
    const t: Term = {
      asks: 0,
      draft: '',
      staging: '',
      composer: '',
      writes: [],
      submitted: [],
      type(text) { t.draft += text; t.staging += text; t.composer += text },
    }
    mockApi({
      terminalShellAlone: vi.fn(async () => { onAsk(++t.asks, t); return alone(false) }),
      writeToTerminal: vi.fn((_id: string, data: string) => {
        t.writes.push(data === '\r' ? 'ENTER' : 'PASTE')
        t.staging = /[\r\n]/.test(data) ? '' : t.staging + data
        if (data === '\r') { t.submitted.push(t.composer); t.composer = ''; return }
        t.composer += data.replace('\x1b[200~', '').replace('\x1b[201~', '')
      }),
    })
    ;(window as any).aiSecurity = { inputPending: vi.fn(async () => ({ success: true, data: t.staging.length > 0 })) }
    return t
  }

  beforeEach(() => {
    useTerminalStore.setState({ memoryNotice: null, terminals: [] })
  })
  afterEach(() => {
    delete (window as any).aiSecurity
  })

  describe('injectAutoPrimer', () => {
    it('asks whether the line is still idle LAST, after the OS and the screen, before the paste and before the Enter', async () => {
      const log: string[] = []
      mockApi({
        terminalShellAlone: vi.fn(async () => { log.push('os'); return alone(false) }),
        readTerminalBuffer: vi.fn(async () => { log.push('screen'); return { success: true, data: { output: IDLE_SCREEN } } }),
        writeToTerminal: vi.fn((_id: string, data: string) => { log.push(data === '\r' ? 'enter' : 'paste') }),
      })
      const idle = vi.fn(async () => { log.push('idle'); return true })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick, idle)).toBe(true)
      expect(log).toEqual(['os', 'screen', 'idle', 'paste', 'os', 'screen', 'idle', 'enter'])
    })

    it('types nothing when the line is no longer idle once the OS has answered', async () => {
      mockApi()
      const idle = vi.fn(async () => false)
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, true, quick, idle)).toBe(false)
      expect((window as any).termpolis.writeToTerminal).not.toHaveBeenCalled()
      expect(idle).toHaveBeenCalledTimes(1)
      expect(useTerminalStore.getState().memoryNotice).toBeNull()
    })

    it('leaves the Enter out when the line stops being idle after the paste', async () => {
      mockApi()
      const idle = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick, idle)).toBe(false)
      const sent = (window as any).termpolis.writeToTerminal.mock.calls.map((c: unknown[]) => c[1] as string)
      expect(sent).toHaveLength(1) // the paste went in; the Enter did not
      expect(sent[0]).toContain('memory_primer')
      expect(idle).toHaveBeenCalledTimes(2)
    })

    it('takes a plain boolean as well as a promise', async () => {
      mockApi()
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick, () => true)).toBe(true)
      mockApi()
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick, () => false)).toBe(false)
      expect((window as any).termpolis.writeToTerminal).not.toHaveBeenCalled()
    })

    it('does not ask once the OS or the screen has already said no', async () => {
      const idle = vi.fn(async () => true)
      mockApi({ terminalShellAlone: vi.fn(async () => alone(true)) })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick, idle)).toBe(false)
      mockApi({ readTerminalBuffer: vi.fn(async () => ({ success: true, data: { output: TRUST_SCREEN } })) })
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick, idle)).toBe(false)
      expect(idle).not.toHaveBeenCalled()
    })

    it('treats a look that throws as a line that is not idle, before the paste and before the Enter', async () => {
      mockApi()
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick, () => { throw new Error('gate gone') })).toBe(false)
      expect((window as any).termpolis.writeToTerminal).not.toHaveBeenCalled()
      mockApi()
      const idle = vi.fn().mockResolvedValueOnce(true).mockRejectedValue(new Error('gate gone'))
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick, idle)).toBe(false)
      expect((window as any).termpolis.writeToTerminal).toHaveBeenCalledTimes(1)
    })

    it('types as before when no look is passed', async () => {
      mockApi()
      expect(await injectAutoPrimer('t1', '/home/me/proj', false, false, quick)).toBe(true)
      expect((window as any).termpolis.writeToTerminal).toHaveBeenCalledTimes(2)
    })
  })

  describe('the launch prime', () => {
    /** Starts the hook the way TerminalPane does, with a gate whose draft is the terminal's. */
    const launch = async (t: Term, afterMount: (view: { unmount: () => void }) => void = () => {}) => {
      vi.useFakeTimers()
      const gate: PrimerGate = { launchedAgent: () => agent, draft: () => t.draft }
      const view = renderHook(() => useAutoPrimer('t-launch', agent, '/home/me/proj', gate))
      afterMount(view)
      await vi.advanceTimersByTimeAsync(8000)
      return view
    }

    it('types nothing when the user starts typing while the OS answers the first question', async () => {
      const t = terminal((n, x) => { if (n === 1) x.type('fix the') })
      await launch(t)
      expect(t.writes).toEqual([])
      expect(t.composer).toBe('fix the')
      expect(useTerminalStore.getState().memoryNotice).toBeNull()
    })

    it('presses no Enter when the user starts typing while the OS answers the second question', async () => {
      const t = terminal((n, x) => { if (n === 2) x.type('fix the') })
      await launch(t)
      expect(t.writes).toEqual(['PASTE'])
      expect(t.submitted).toEqual([]) // the draft was not submitted, with the pointer or on its own
      expect(useTerminalStore.getState().memoryNotice).toBeNull() // and no recall is announced for it
    })

    it('types nothing when the pane goes away while the OS answers', async () => {
      // Once the pane is gone, its gate reads a draft that nothing feeds any more (the pane that
      // replaces it has a buffer of its own), so the draft can no longer be looked at: it waits.
      let leave = (): void => {}
      const t = terminal((n) => { if (n === 1) leave() })
      await launch(t, (view) => { leave = view.unmount })
      expect(t.writes).toEqual([])
    })

    it('control: nobody typing, the pointer is pasted and submitted', async () => {
      const t = terminal()
      await launch(t)
      expect(t.writes).toEqual(['PASTE', 'ENTER'])
      expect(t.submitted).toHaveLength(1)
      expect(t.submitted[0]).toContain('memory_primer')
    })
  })

  describe('the compaction re-prime', () => {
    const reprime = async (t: Term, draft: () => string = () => t.draft) => {
      vi.useFakeTimers()
      const view = renderHook(() => useCompactionReprimer('t-comp', agent, '/home/me/proj', draft))
      view.result.current('✻ Compacting conversation… (2m 30s)')
      await vi.advanceTimersByTimeAsync(9000)
      return view
    }

    it('types nothing when the user starts typing while the OS answers the first question', async () => {
      const t = terminal((n, x) => { if (n === 1) x.type('fix the') })
      await reprime(t)
      expect(t.writes).toEqual([])
      expect(t.composer).toBe('fix the')
    })

    it('presses no Enter when the user starts typing while the OS answers the second question', async () => {
      const t = terminal((n, x) => { if (n === 2) x.type('fix the') })
      await reprime(t)
      expect(t.writes).toEqual(['PASTE'])
      expect(t.submitted).toEqual([])
    })

    it('control: on an AI-flagged terminal the primer\'s own staged paste does not hold its Enter back', async () => {
      // main stages the primer's own paste until the next submit, so aiSecurity.inputPending is
      // true after it. The look before the Enter is the pane's draft (the user's keystrokes), not that.
      const t = terminal()
      await reprime(t)
      expect(t.writes).toEqual(['PASTE', 'ENTER'])
      expect(t.submitted).toHaveLength(1)
      expect(t.submitted[0]).toContain('memory_primer')
    })

    it('reads the draft of the LATEST render through a ref', async () => {
      const t = terminal()
      vi.useFakeTimers()
      let draft: () => string = () => ''
      const view = renderHook(() => useCompactionReprimer('t-comp', agent, '/home/me/proj', draft))
      draft = () => 'typed since' // a later render hands in a new accessor
      view.rerender()
      view.result.current('✻ Compacting conversation… (2m 30s)')
      await vi.advanceTimersByTimeAsync(9000)
      expect(t.writes).toEqual([])
    })

    it('has no draft to look at for a caller that passes none, and types as it did', async () => {
      // TerminalPane always passes one. Without it only the check made before the OS is asked is left.
      const t = terminal()
      vi.useFakeTimers()
      const { result } = renderHook(() => useCompactionReprimer('t-comp', agent, '/home/me/proj'))
      result.current('✻ Compacting conversation… (2m 30s)')
      await vi.advanceTimersByTimeAsync(9000)
      expect(t.writes).toEqual(['PASTE', 'ENTER'])
    })
  })

  describe('reprimeAfterCompaction', () => {
    const opts = (t: Term) => ({ isLaunchPrimed: () => false, pending: async () => false, awaiting: async () => false, sleep: quick, draft: () => t.draft })

    it('looks at the draft after the OS has answered, before the paste', async () => {
      const t = terminal((n, x) => { if (n === 1) x.type('fix the') })
      expect(await reprimeAfterCompaction('t1', '/home/me/proj', opts(t))).toBe(false)
      expect(t.writes).toEqual([])
    })

    it('looks at the draft again before the Enter', async () => {
      const t = terminal((n, x) => { if (n === 2) x.type('fix the') })
      expect(await reprimeAfterCompaction('t1', '/home/me/proj', opts(t))).toBe(false)
      expect(t.writes).toEqual(['PASTE'])
    })

    it('types as before while the draft stays empty', async () => {
      const t = terminal()
      expect(await reprimeAfterCompaction('t1', '/home/me/proj', opts(t))).toBe(true)
      expect(t.writes).toEqual(['PASTE', 'ENTER'])
    })
  })
})

// ---------------------------------------------------------------------------------------------
// The pointer is one line of text, and it can still land at a SHELL's prompt: the OS answers null
// for shells it can't read, and an agent can die between the last question and the Enter. A
// folder's name is data somebody else chose (a cloned repository's directory). Between double
// quotes a name can close the quotes itself and comment out the rest of the pointer (x"; cmd; #),
// which ran in Git Bash and Windows PowerShell, and in cmd.exe with & and rem. A $(...) or a
// backtick is expanded between double quotes as well; on a one-line paste it did not run because of
// the pointer's own words after the folder (bash waits for more, PowerShell rejects the line), not
// because of the quoting. zsh and fish were not available to run: what is said of them comes from
// their documented quoting rules. So the folder is named only when every character of it is inert
// in every shell, and then as a single-quoted literal (shellQuote.ts); otherwise the pointer writes
// no folder and the agent passes its own working directory.
// ---------------------------------------------------------------------------------------------
describe('the pointer names the folder safely', () => {
  /** Termpolis does not know the terminal's folder: the tool is called as it is. */
  const NO_FOLDER = buildPrimerPointer('')
  /** It knows one that cannot be written into a command line: the agent is told to use its own. */
  const UNNAMED_TARGET = 'with cwd set to your current working directory'
  const UNNAMED = buildPrimerPointer('/tmp/$(touch pwned)')

  /** Names that are ordinary on somebody's machine, and so must still reach the agent. */
  const ORDINARY: Array<[string, string]> = [
    ['a POSIX path', '/home/me/myproject'],
    ['a Windows path', 'C:\\code\\acme'],
    ['spaces and parentheses', 'C:\\Program Files (x86)\\Acme Tools'],
    ['tildes, as in iCloud Drive', '/Users/me/Library/Mobile Documents/com~apple~CloudDocs/proj'],
    ['square brackets, as in a dynamic route', '/srv/app/[id]'],
    ['a hash, as in C#', '/home/me/C#/app'],
    ['an npm scope, a plus, an equals sign and a comma', '/home/me/@scope/pkg+x=1,2'],
    ['curly braces', '/home/me/{template}'],
    ['accented letters', '/home/zoë/projets/café'],
    ['a letter and a combining mark, as macOS stores é', '/home/me/proje\u0301t'],
    ['other scripts', '/home/用户/项目'],
    ['a UNC share', '\\\\server\\share\\proj'],
    ['dots, dashes and digits', 'D:/work/app-2.0_final'],
    ['the root', '/'],
    ['a relative folder', '.'],
  ]

  /** Names a shell would read as code, or that break out of the literal or the paste. */
  const HOSTILE: Array<[string, string]> = [
    ['a command substitution', '/tmp/$(touch pwned)'],
    ['backticks', '/tmp/`touch pwned`'],
    ['a parameter expansion', '/tmp/${IFS}touch pwned'],
    ['a PowerShell variable', 'C:\\Users\\$env:USERNAME\\proj'],
    ['a statement separator', '/tmp/a; touch pwned; #'],
    ['an and-list', '/tmp/a && touch pwned'],
    ['a pipe', '/tmp/a | tee pwned'],
    ['an output redirect', '/tmp/a > pwned'],
    ['an input redirect', '/tmp/a < pwned'],
    ['a lone dollar sign', '/tmp/$HOME'],
    ['a lone double quote', '/tmp/say"hi'],
    ['a lone semicolon', '/tmp/a;b'],
    ['an ampersand, which cmd.exe chains on', 'C:\\Users\\Tom & Jerry\\proj'],
    ['a percent sign, which cmd.exe expands', 'C:\\x\\%USERPROFILE%\\y'],
    ['a caret, cmd.exe\'s escape', 'C:\\x^&y'],
    ['an exclamation mark, which a shell expands from its history', '/tmp/wow!'],
    ['an apostrophe', '/home/o\'brien/proj'],
    ['an apostrophe that closes the literal', '/tmp/a\'; touch pwned; \''],
    ['a double quote', '/tmp/a"; touch pwned; "'],
    ['a typographic single quote, which PowerShell reads as a quote', '/tmp/\u2018x\u2019; touch pwned'],
    ['a typographic double quote, which PowerShell reads as a quote', '/tmp/\u201cx\u201d; touch pwned'],
    ['a newline', '/tmp/a\ntouch pwned'],
    ['a carriage return', '/tmp/a\rtouch pwned'],
    ['a tab', '/tmp/a\tb'],
    ['a NUL', '/tmp/a\0b'],
    ['the escape that ends a bracketed paste early', '/tmp/\x1b[201~\rtouch pwned\r'],
    ['a line separator', '/tmp/a\u2028touch pwned'],
    ['a bidirectional override', '/tmp/\u202eevil'],
    ['a non-breaking space', '/tmp/a\u00a0b'],
    ['a glob', '/tmp/*'],
    ['a question mark, as in an extended-length prefix', '\\\\?\\C:\\x'],
    ['an emoji', '/home/me/📁 projects'],
    ['a trailing backslash, which fish reads as an escaped closing quote', 'C:\\code\\acme\\'],
  ]

  describe('an ordinary name', () => {
    it.each(ORDINARY)('is named in single quotes: %s', (_what, cwd) => {
      const pointer = buildPrimerPointer(cwd)
      expect(pointer).toContain(`with cwd set to '${cwd}' and read it as background only`)
      // The raw folder is never between double quotes, where a shell expands what is inside.
      expect(pointer).not.toContain(`"${cwd}"`)
    })

    it('is quoted the way shellQuote.ts quotes a PowerShell literal', () => {
      for (const [, cwd] of ORDINARY) expect(buildPrimerPointer(cwd)).toContain(`with cwd set to ${psQuote(cwd)} and`)
    })

    it('puts nothing of the folder anywhere but inside its quotes', () => {
      const slot = '@@FOLDER@@'
      const template = buildPrimerPointer('/x').replace("'/x'", slot)
      expect(template).toContain(slot)
      for (const [, cwd] of ORDINARY) expect(buildPrimerPointer(cwd).replace(`'${cwd}'`, slot)).toBe(template)
    })
  })

  describe('a name no shell could take for plain text', () => {
    it.each(HOSTILE)('is left out: %s', (_what, cwd) => {
      const pointer = buildPrimerPointer(cwd)
      // Exactly the pointer for any other such name: nothing of the name is written anywhere.
      expect(pointer).toBe(UNNAMED)
      expect(pointer).not.toContain('touch pwned')
    })

    it('has the agent pass its own working directory, which keeps the recall scoped to the project', () => {
      // memory_primer scopes by the cwd it is given (the full path, then its last segment). The agent
      // knows its folder, and what it passes is a tool argument, which no shell reads.
      expect(UNNAMED).toContain(`memory_primer ${UNNAMED_TARGET} and read it as background only`)
      expect(UNNAMED).not.toContain('with no arguments')
      expect(UNNAMED).not.toBe(NO_FOLDER)
    })

    it('keeps a project scoped when only a parent folder has a name no shell could take', () => {
      for (const cwd of ["C:\\Users\\Sean O'Brien\\proj", 'C:\\Users\\me\\R&D\\proj', '\\\\wsl$\\Ubuntu\\home\\me\\proj', '/home/me/résumé–2020/proj']) {
        expect(buildPrimerPointer(cwd)).toBe(UNNAMED)
      }
    })

    it('still says "with no arguments" when there is no folder to name at all', () => {
      expect(NO_FOLDER).toContain('memory_primer with no arguments and read it')
      expect(NO_FOLDER).not.toContain('your current working directory')
    })

    it('keeps the pointer one line of paste-safe text whatever the folder is called', () => {
      for (const [, cwd] of [...ORDINARY, ...HOSTILE]) {
        const pointer = buildPrimerPointer(cwd, true)
        expect(pointer).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/)
        expect(pointer).not.toContain('`')
        expect(pointer).toContain('memory_write') // the self-record clause is still appended
      }
    })
  })

  describe('the first word of the pointer', () => {
    // At a cmd.exe prompt the first word of a line is looked up as a program in the CURRENT folder
    // first, so a repository that carries a Termpolis.bat or Termpolis.cmd would run it when the
    // pointer is typed there. A colon cannot be in the name of a file git checks out on Windows.
    // primerPointerShell.test.ts types it into the real cmd.exe to prove it.
    it.each([
      ['no folder', ''],
      ['an ordinary folder', '/home/me/proj'],
      ['a folder that cannot be named', '/tmp/$(touch pwned)'],
    ])('is not the name of a file a folder could hold: %s', (_what, cwd) => {
      expect(buildPrimerPointer(cwd).split(' ')[0]).toBe('Termpolis:')
      expect(buildPrimerPointer(cwd, true).split(' ')[0]).toBe('Termpolis:')
    })

    it('still opens by telling the agent which tool to call', () => {
      expect(buildPrimerPointer('/home/me/proj').startsWith('Termpolis: memory — call the termpolis MCP tool memory_primer with cwd set to ')).toBe(true)
    })
  })

  describe('which characters a folder name may carry', () => {
    it('accepts exactly these ASCII characters, and not one control character', () => {
      // "Named" is decided by what the pointer says, not by looking for the raw text: psQuote doubles
      // an apostrophe, so a search for the unquoted name would never see one that had been let in.
      const named = (cwd: string): boolean => !buildPrimerPointer(cwd).includes(UNNAMED_TARGET)
      let accepted = ''
      for (let code = 0; code < 0x80; code++) {
        const ch = String.fromCharCode(code)
        if (named(`/a${ch}b`)) accepted += ch
      }
      expect(accepted).toBe(' #()+,-./0123456789:=@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]_abcdefghijklmnopqrstuvwxyz{}~')
      // What it names is the folder itself, in single quotes.
      for (const ch of accepted) expect(buildPrimerPointer(`/a${ch}b`)).toContain(`with cwd set to ${psQuote(`/a${ch}b`)} and`)
    })

    it('accepts combining marks and letters of other scripts, and nothing from the private or format ranges', () => {
      const cp = (code: number): string => String.fromCodePoint(code)
      const withMark = `/home/proje${cp(0x301)}t`
      expect(buildPrimerPointer(withMark)).toContain(`with cwd set to '${withMark}' and`)
      expect(buildPrimerPointer('/home/用户')).toContain("with cwd set to '/home/用户' and")
      // A zero-width joiner or non-joiner, a private-use character, a byte-order mark, a bidirectional isolate.
      for (const code of [0x200d, 0x200c, 0xe000, 0xfeff, 0x2066]) expect(buildPrimerPointer(`/a${cp(code)}b`)).toBe(UNNAMED)
    })

    it('refuses the C1 controls and the no-break space too', () => {
      for (let code = 0x80; code <= 0xa0; code++) {
        const cwd = `/a${String.fromCharCode(code)}b`
        expect(buildPrimerPointer(cwd)).toBe(UNNAMED)
      }
    })

    it('does not name a folder that ends in a backslash, but names the same one without it', () => {
      expect(buildPrimerPointer('C:\\code\\acme\\')).toBe(UNNAMED)
      expect(buildPrimerPointer('C:\\code\\acme')).toContain("with cwd set to 'C:\\code\\acme' and")
    })
  })

  describe('injectAutoPrimer', () => {
    it('pastes a pointer without the name of a hostile folder, and still recalls for the real one', async () => {
      const cwd = '/tmp/$(touch pwned)'
      expect(await injectAutoPrimer('t1', cwd, false, false, async () => {})).toBe(true)
      const api = (window as any).termpolis
      // The recall check is not a shell: it keeps the real folder, so the digest is as relevant as ever.
      expect(api.memoryBuildPrimer).toHaveBeenCalledWith(expect.stringContaining('$(touch pwned)'), undefined, cwd)
      const [, paste] = api.writeToTerminal.mock.calls[0]
      expect(paste).toBe('\x1b[200~' + UNNAMED + '\x1b[201~')
      expect(paste).not.toContain('$(')
    })

    it('cannot be talked out of its bracketed paste by an escape in the folder name', async () => {
      await injectAutoPrimer('t1', '/tmp/\x1b[201~\rtouch pwned\r', false, false, async () => {})
      const [, paste] = (window as any).termpolis.writeToTerminal.mock.calls[0]
      expect(paste.split('\x1b[201~')).toHaveLength(2) // the one end marker, and it is the last thing in it
      expect(paste.endsWith('\x1b[201~')).toBe(true)
      expect(paste).not.toContain('\r')
    })

    it('names an ordinary folder in single quotes in what it pastes', async () => {
      await injectAutoPrimer('t1', '/home/me/myproject', false, false, async () => {})
      const [, paste] = (window as any).termpolis.writeToTerminal.mock.calls[0]
      expect(paste).toContain("with cwd set to '/home/me/myproject' and read it")
    })

    it('asks for the generic recall, and names the root, when the folder has no name of its own', async () => {
      await injectAutoPrimer('t1', '/', false, false, async () => {})
      const api = (window as any).termpolis
      expect(api.memoryBuildPrimer).toHaveBeenCalledWith(expect.not.stringContaining('context for'), undefined, '/')
      expect(api.writeToTerminal.mock.calls[0][1]).toContain("with cwd set to '/' and read it")
    })
  })
})
