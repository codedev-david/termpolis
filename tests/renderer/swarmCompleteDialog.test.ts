import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSwarmCompleteDialog } from '../../src/renderer/src/lib/swarmCompleteDialog'

// Before 1.60.0, closing the swarm-complete dialog cleared the completion summary, and with it the
// dashboard's Review tab. Now closing only hides the dialog for that summary.
describe('useSwarmCompleteDialog', () => {
  const first = { message: 'SWARM COMPLETE: one' }
  const second = { message: 'SWARM COMPLETE: two' }

  it('is closed with no summary', () => {
    const { result } = renderHook(() => useSwarmCompleteDialog(null))
    expect(result.current.open).toBe(false)
  })

  it('opens for a summary and stays hidden for it once closed, without needing the summary cleared', () => {
    const { result, rerender } = renderHook(({ s }) => useSwarmCompleteDialog(s), { initialProps: { s: first as object | null } })
    expect(result.current.open).toBe(true)
    act(() => result.current.hide())
    expect(result.current.open).toBe(false)
    rerender({ s: first })
    expect(result.current.open).toBe(false)
  })

  it('opens again for the next completion', () => {
    const { result, rerender } = renderHook(({ s }) => useSwarmCompleteDialog(s), { initialProps: { s: first as object | null } })
    act(() => result.current.hide())
    rerender({ s: null })            // the next swarm starts: the summary is cleared
    expect(result.current.open).toBe(false)
    rerender({ s: second })          // and finishes
    expect(result.current.open).toBe(true)
  })
})
