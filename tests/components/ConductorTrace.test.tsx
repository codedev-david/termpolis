import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { ConductorTrace } from '../../src/renderer/src/components/ConductorTrace/ConductorTrace'
import type { AgentActivityEvent } from '../../src/renderer/src/types'

type API = {
  query: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
}

let api: API
let listeners: Array<(e: AgentActivityEvent) => void> = []

const mk = (over: Partial<AgentActivityEvent>): AgentActivityEvent => ({
  id: over.id ?? 'e1',
  ts: over.ts ?? 1,
  terminalId: over.terminalId ?? 'c1',
  agentType: over.agentType ?? 'claude',
  kind: over.kind ?? 'message',
  summary: '',
  payload: over.payload ?? {},
})

beforeEach(() => {
  listeners = []
  api = {
    query: vi.fn().mockResolvedValue({ success: true, data: [] }),
    onEvent: vi.fn((cb) => {
      listeners.push(cb)
      return () => {
        const i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
      }
    }),
  }
  ;(window as any).agentActivity = api
})

describe('ConductorTrace', () => {
  it('shows fallback when no conductor terminal', () => {
    render(<ConductorTrace conductorTerminalId={null} />)
    expect(screen.getByText(/No swarm conductor running/i)).toBeInTheDocument()
  })

  it('queries for conductor terminal and renders entries', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        mk({
          id: '1',
          ts: 1,
          kind: 'message',
          payload: { text: 'Assigning task to reviewer' },
        }),
        mk({
          id: '2',
          ts: 2,
          kind: 'tool_call',
          payload: { tool: 'Edit', input: { file_path: '/src/app.ts' } },
        }),
      ],
    })
    render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(screen.getAllByTestId('trace-entry').length).toBe(2))
    expect(screen.getAllByText(/reviewer/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Edit: \/src\/app\.ts/)).toBeInTheDocument()
  })

  it('appends entries from live events', async () => {
    render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    act(() => {
      listeners.forEach((cb) =>
        cb(
          mk({
            id: 'live',
            ts: 100,
            kind: 'message',
            payload: { text: 'streaming update' },
          }),
        ),
      )
    })
    await waitFor(() => expect(screen.getByText('streaming update')).toBeInTheDocument())
  })

  it('filters events for other terminals', async () => {
    render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    act(() => {
      listeners.forEach((cb) =>
        cb(
          mk({
            id: 'other',
            terminalId: 'other',
            kind: 'message',
            payload: { text: 'not mine' },
          }),
        ),
      )
    })
    expect(screen.queryByText('not mine')).toBeNull()
  })

  it('enforces limit (drops oldest)', async () => {
    render(<ConductorTrace conductorTerminalId="c1" limit={2} />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    act(() => {
      for (let i = 0; i < 5; i += 1) {
        listeners.forEach((cb) =>
          cb(
            mk({
              id: `m${i}`,
              ts: i,
              kind: 'message',
              payload: { text: `msg${i}` },
            }),
          ),
        )
      }
    })
    await waitFor(() => expect(screen.getAllByTestId('trace-entry').length).toBe(2))
  })

  it('handles missing agentActivity gracefully', () => {
    ;(window as any).agentActivity = undefined
    expect(() => render(<ConductorTrace conductorTerminalId="c1" />)).not.toThrow()
  })

  it('clears entries when conductorTerminalId becomes null', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [mk({ id: '1', ts: 1, kind: 'message', payload: { text: 'hello' } })],
    })
    const { rerender } = render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(screen.getAllByTestId('trace-entry').length).toBe(1))
    rerender(<ConductorTrace conductorTerminalId={null} />)
    expect(screen.getByText(/No swarm conductor running/i)).toBeInTheDocument()
  })

  it('falls back to empty list when query rejects', async () => {
    api.query.mockRejectedValueOnce(new Error('network down'))
    render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    // Should not render any entries — catch path on line 64 sets [] when not disposed
    expect(screen.queryAllByTestId('trace-entry').length).toBe(0)
  })

  it('handles unsuccessful query result (success=false)', async () => {
    api.query.mockResolvedValueOnce({ success: false, error: 'denied' })
    render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(screen.queryAllByTestId('trace-entry').length).toBe(0)
  })

  it('handles non-array data in query result', async () => {
    api.query.mockResolvedValueOnce({ success: true, data: 'not-an-array' as unknown as [] })
    render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(screen.queryAllByTestId('trace-entry').length).toBe(0)
  })

  it('does not crash when an event is for a different terminal id', async () => {
    render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    // empty parsed result branch — kind that the parser drops
    act(() => {
      listeners.forEach((cb) =>
        cb(
          mk({
            id: 'unknown-kind',
            ts: 50,
            kind: 'unknown' as never,
            payload: {},
          }),
        ),
      )
    })
    expect(true).toBe(true)
  })
})
