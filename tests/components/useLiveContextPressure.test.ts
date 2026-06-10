import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useLiveContextPressure } from '../../src/renderer/src/hooks/useLiveContextPressure'

let ts = 1000
const tok = (
  used: number,
  { terminalId = 't1', agentType = 'claude', taskId = 's1' } = {},
): any => ({
  kind: 'token_update', terminalId, agentType, taskId, ts: ts++,
  payload: { inputTokens: used, outputTokens: 0 },
})
const msg = (length: number, { terminalId = 't1', agentType = 'claude' } = {}): any => ({
  kind: 'message', terminalId, agentType, ts: ts++, payload: { length },
})

// Mock the agent-activity bridge, filtering by terminalId + kind exactly like the
// real ring-buffer query, so cross-terminal scoping is exercised faithfully.
function mockActivity(initial: any[] = []) {
  const cbs: Array<(e: any) => void> = []
  const current = [...initial]
  const query = vi.fn(async (filter: any = {}) => ({
    success: true,
    data: current.filter(
      (e) =>
        (!filter.terminalId || e.terminalId === filter.terminalId) &&
        (!filter.kind || (Array.isArray(filter.kind) ? filter.kind.includes(e.kind) : filter.kind === e.kind)),
    ),
  }))
  const onEvent = vi.fn((cb: (e: any) => void) => {
    cbs.push(cb)
    return () => { const i = cbs.indexOf(cb); if (i >= 0) cbs.splice(i, 1) }
  })
  ;(window as any).agentActivity = { query, onEvent }
  return { query, onEvent, emit: (e: any) => { current.push(e); cbs.forEach((cb) => cb(e)) } }
}

afterEach(() => {
  ;(window as any).agentActivity = undefined
  vi.restoreAllMocks()
})

describe('useLiveContextPressure', () => {
  it('returns null without a terminalId', () => {
    mockActivity([])
    const { result } = renderHook(() => useLiveContextPressure(null))
    expect(result.current).toBeNull()
  })

  it('returns null when the activity bridge is unavailable', () => {
    ;(window as any).agentActivity = undefined
    const { result } = renderHook(() => useLiveContextPressure('t1'))
    expect(result.current).toBeNull()
  })

  it('computes transcript-based pressure, sizing the window from the agent type', async () => {
    mockActivity([tok(100_000)])
    const { result } = renderHook(() => useLiveContextPressure('t1'))
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current!.source).toBe('transcript')
    expect(result.current!.used).toBe(100_000)
    expect(result.current!.total).toBe(200_000) // Claude window
    expect(result.current!.model).toMatch(/claude/i)
  })

  it('falls back to a heuristic when only message events exist', async () => {
    mockActivity([msg(4000), msg(4000)])
    const { result } = renderHook(() => useLiveContextPressure('t1'))
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current!.source).toBe('heuristic')
    expect(result.current!.used).toBeGreaterThan(0)
  })

  it('recomputes on a relevant pushed event for that terminal', async () => {
    const bus = mockActivity([tok(50_000)])
    const { result } = renderHook(() => useLiveContextPressure('t1'))
    await waitFor(() => expect(result.current?.used).toBe(50_000))
    act(() => bus.emit(tok(150_000)))
    await waitFor(() => expect(result.current?.used).toBe(150_000))
  })

  it('ignores events for other terminals and irrelevant kinds', async () => {
    const bus = mockActivity([tok(50_000)])
    const { result } = renderHook(() => useLiveContextPressure('t1'))
    await waitFor(() => expect(result.current?.used).toBe(50_000))
    const before = bus.query.mock.calls.length
    act(() => bus.emit(tok(900_000, { terminalId: 't2' }))) // other terminal
    act(() => bus.emit({ kind: 'cost_update', terminalId: 't1', agentType: 'claude', ts: ts++, payload: {} })) // wrong kind
    expect(bus.query.mock.calls.length).toBe(before) // no recompute
    act(() => bus.emit(tok(60_000)))
    expect(bus.query.mock.calls.length).toBe(before + 1) // relevant → recompute
  })

  it('sizes the window per agent type (Gemini)', async () => {
    mockActivity([tok(50_000, { agentType: 'gemini' })])
    const { result } = renderHook(() => useLiveContextPressure('t1'))
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current!.model).toMatch(/gemini/i)
  })

  it('unsubscribes on unmount (no recompute afterward)', async () => {
    const bus = mockActivity([tok(10_000)])
    const { result, unmount } = renderHook(() => useLiveContextPressure('t1'))
    await waitFor(() => expect(result.current).not.toBeNull())
    const before = bus.query.mock.calls.length
    unmount()
    act(() => bus.emit(tok(99_000)))
    expect(bus.query.mock.calls.length).toBe(before)
  })

  it('clears pressure when terminalId becomes null', async () => {
    mockActivity([tok(50_000)])
    const { result, rerender } = renderHook(({ id }) => useLiveContextPressure(id), {
      initialProps: { id: 't1' as string | null },
    })
    await waitFor(() => expect(result.current).not.toBeNull())
    rerender({ id: null })
    expect(result.current).toBeNull()
  })
})
