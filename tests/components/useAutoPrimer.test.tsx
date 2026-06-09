import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useAutoPrimer,
  useCompactionReprimer,
  isAutoPrimerEnabled,
  setAutoPrimerEnabled,
  injectAutoPrimer,
} from '../../src/renderer/src/hooks/useAutoPrimer'
import { setAutoReprimeOnCompactionEnabled } from '../../src/renderer/src/lib/compactionReprime'

const KEY = 'termpolis.memory.autoPrimerOnLaunch'
const agent = { name: 'Claude Code' } as any

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
  it('builds a project-scoped query and pastes the primer as a bracketed paste', async () => {
    const ok = await injectAutoPrimer('term-1', '/home/me/myproject')
    expect(ok).toBe(true)
    const api = (window as any).termpolis
    expect(api.memoryBuildPrimer).toHaveBeenCalledWith(expect.stringContaining('myproject'))
    const [tid, payload] = api.writeToTerminal.mock.calls[0]
    expect(tid).toBe('term-1')
    expect(payload).toContain('\x1b[200~') // bracketed-paste start
    expect(payload).toContain('RECALLED CONTEXT')
    expect(payload).toContain('\x1b[201~') // bracketed-paste end
  })

  it('strips trailing slashes to derive the project name', async () => {
    await injectAutoPrimer('t', 'C:\\code\\acme\\')
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledWith(expect.stringContaining('acme'))
  })

  it('uses a generic query when there is no cwd', async () => {
    await injectAutoPrimer('t', '')
    expect((window as any).termpolis.memoryBuildPrimer).toHaveBeenCalledWith(
      expect.not.stringContaining('context for'),
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
    const { rerender } = renderHook(({ a }) => useAutoPrimer('term-1', a, '/home/me/proj'), {
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
    renderHook(() => useAutoPrimer('term-1', agent, '/p'))
    await vi.advanceTimersByTimeAsync(3000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
  })

  it('does nothing when no agent is detected', async () => {
    vi.useFakeTimers()
    renderHook(() => useAutoPrimer('term-1', null, '/p'))
    await vi.advanceTimersByTimeAsync(3000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
  })

  it('cancels the pending injection if the terminal unmounts first', async () => {
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useAutoPrimer('term-1', agent, '/p'))
    unmount()
    await vi.advanceTimersByTimeAsync(3000)
    expect((window as any).termpolis.memoryBuildPrimer).not.toHaveBeenCalled()
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
