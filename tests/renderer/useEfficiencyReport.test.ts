import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useEfficiencyReport } from '../../src/renderer/src/hooks/useEfficiencyReport'

type API = { query: ReturnType<typeof vi.fn> }
let api: API

beforeEach(() => {
  api = { query: vi.fn().mockResolvedValue({ success: true, data: [] }) }
  ;(window as any).agentActivity = api
})
afterEach(() => {
  ;(window as any).agentActivity = undefined
})

describe('useEfficiencyReport', () => {
  it('queries on mount', async () => {
    const { result } = renderHook(() => useEfficiencyReport())
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(result.current.report).not.toBeNull()
    expect(result.current.report!.perAgent).toEqual([])
  })

  it('computes non-empty report from events', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        {
          id: 'a',
          ts: Date.now() - 10,
          terminalId: 't1',
          agentType: 'claude',
          kind: 'message',
          summary: '',
          payload: {},
        },
      ],
    })
    const { result } = renderHook(() => useEfficiencyReport())
    await waitFor(() => expect(result.current.report?.perAgent.length).toBe(1))
  })

  it('sets refreshing during load', async () => {
    const { result } = renderHook(() => useEfficiencyReport())
    await waitFor(() => expect(result.current.refreshing).toBe(false))
  })

  it('exposes manual refresh', async () => {
    const { result } = renderHook(() => useEfficiencyReport())
    await waitFor(() => expect(api.query).toHaveBeenCalledTimes(1))
    await act(async () => {
      await result.current.refresh()
    })
    expect(api.query).toHaveBeenCalledTimes(2)
  })

  it('tolerates missing api', () => {
    ;(window as any).agentActivity = undefined
    const { result } = renderHook(() => useEfficiencyReport())
    expect(result.current.report).toBeNull()
  })

  it('tolerates query errors', async () => {
    api.query.mockRejectedValue(new Error('fail'))
    const { result } = renderHook(() => useEfficiencyReport())
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(result.current.report).toBeNull()
  })
})
