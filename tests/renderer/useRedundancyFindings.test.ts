import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useRedundancyFindings } from '../../src/renderer/src/hooks/useRedundancyFindings'
import type { AgentActivityEvent } from '../../src/renderer/src/types'

type API = {
  query: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
}

let api: API
const listeners: Array<(ev: AgentActivityEvent) => void> = []

beforeEach(() => {
  listeners.length = 0
  api = {
    query: vi.fn().mockResolvedValue({ success: true, data: [] }),
    onEvent: vi.fn((cb: (ev: AgentActivityEvent) => void) => {
      listeners.push(cb)
      return () => {
        const idx = listeners.indexOf(cb)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    }),
  }
  ;(window as any).agentActivity = api
})

afterEach(() => {
  ;(window as any).agentActivity = undefined
})

function mkEvent(over: Partial<AgentActivityEvent>): AgentActivityEvent {
  return {
    id: over.id ?? 'e1',
    ts: over.ts ?? Date.now(),
    terminalId: over.terminalId ?? 't1',
    agentType: over.agentType ?? 'claude',
    kind: over.kind ?? 'tool_call',
    summary: '',
    payload: over.payload ?? {},
  }
}

describe('useRedundancyFindings', () => {
  it('starts empty and queries on mount', async () => {
    const { result } = renderHook(() => useRedundancyFindings())
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(result.current.findings).toEqual([])
  })

  it('produces findings when events overlap', async () => {
    const now = Date.now()
    api.query.mockResolvedValue({
      success: true,
      data: [
        mkEvent({
          id: 'a',
          ts: now - 100,
          terminalId: 't1',
          payload: { tool: 'Edit', input: { file_path: '/x.ts' } },
        }),
        mkEvent({
          id: 'b',
          ts: now - 50,
          terminalId: 't2',
          payload: { tool: 'Write', input: { file_path: '/x.ts' } },
        }),
      ],
    })
    const { result } = renderHook(() => useRedundancyFindings())
    await waitFor(() => expect(result.current.findings.length).toBe(1))
    expect(result.current.findings[0].resource).toBe('/x.ts')
  })

  it('refreshes on incoming tool_call events', async () => {
    const { result } = renderHook(() => useRedundancyFindings())
    await waitFor(() => expect(api.query).toHaveBeenCalledTimes(1))

    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        mkEvent({
          id: '1',
          terminalId: 't1',
          payload: { tool: 'Bash', input: { command: 'npm test' } },
        }),
        mkEvent({
          id: '2',
          terminalId: 't2',
          payload: { tool: 'Bash', input: { command: 'npm test' } },
        }),
      ],
    })
    act(() => {
      listeners.forEach((cb) =>
        cb(mkEvent({ id: 'x', payload: { tool: 'Bash', input: { command: 'ls' } } })),
      )
    })
    await waitFor(() => expect(api.query).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.findings.length).toBe(1))
    expect(result.current.findings[0].kind).toBe('command')
  })

  it('ignores non-tool_call events from live stream', async () => {
    renderHook(() => useRedundancyFindings())
    await waitFor(() => expect(api.query).toHaveBeenCalledTimes(1))
    act(() => {
      listeners.forEach((cb) => cb(mkEvent({ id: 'msg', kind: 'message' })))
    })
    expect(api.query).toHaveBeenCalledTimes(1)
  })

  it('polls on an interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderHook(() => useRedundancyFindings({ pollMs: 1_000 }))
      await waitFor(() => expect(api.query).toHaveBeenCalledTimes(1))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(api.query).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tolerates api.query failures', async () => {
    api.query.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useRedundancyFindings())
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(result.current.findings).toEqual([])
  })

  it('tolerates missing agentActivity api', () => {
    ;(window as any).agentActivity = undefined
    const { result } = renderHook(() => useRedundancyFindings())
    expect(result.current.findings).toEqual([])
  })

  it('exposes refresh() to trigger manual reload', async () => {
    const { result } = renderHook(() => useRedundancyFindings())
    await waitFor(() => expect(api.query).toHaveBeenCalledTimes(1))
    await act(async () => {
      await result.current.refresh()
    })
    expect(api.query).toHaveBeenCalledTimes(2)
  })
})
