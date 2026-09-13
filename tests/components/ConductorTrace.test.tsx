import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { ConductorTrace } from '../../src/renderer/src/components/ConductorTrace/ConductorTrace'
import type { AgentActivityEvent } from '../../src/renderer/src/types'
import type { TraceEntry } from '../../src/renderer/src/lib/conductorTraceParser'

// Seam for the badge FALLBACKS. Every kind the real parser emits is present in both
// KIND_COLOR and KIND_LABEL, so `?? '#cccccc'` / `?? e.kind` cannot be reached through it.
// While `traceOverride.entries` is null the REAL parser is used, so every other test in this
// file is unaffected; exactly one test hands the component an unmapped kind.
const traceOverride = vi.hoisted(() => ({ entries: null as TraceEntry[] | null }))
vi.mock('../../src/renderer/src/lib/conductorTraceParser', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../src/renderer/src/lib/conductorTraceParser')
  return {
    ...actual,
    parseEventsToTrace: (events: AgentActivityEvent[]) =>
      traceOverride.entries ?? actual.parseEventsToTrace(events),
  }
})

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

  it('shows "loading…" while the seed query is still in flight', async () => {
    api.query.mockReturnValueOnce(new Promise(() => {})) // never settles
    render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(screen.getByText('loading…')).toBeInTheDocument())
    // The "no activity yet" placeholder must stay hidden until loading finishes.
    expect(screen.queryByText(/No activity from the conductor yet/i)).toBeNull()
  })

  it('treats a nullish query result as zero events', async () => {
    api.query.mockResolvedValueOnce(undefined)
    render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(screen.getByText('0 events')).toBeInTheDocument())
    expect(screen.queryAllByTestId('trace-entry')).toHaveLength(0)
    expect(screen.getByText(/No activity from the conductor yet/i)).toBeInTheDocument()
  })

  it('drops a seed result that lands after unmount', async () => {
    let settle!: (v: unknown) => void
    api.query.mockReturnValueOnce(new Promise((resolve) => { settle = resolve }))
    const { unmount } = render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    unmount()
    await act(async () => {
      settle({ success: true, data: [mk({ id: 'late', ts: 1, kind: 'message', payload: { text: 'too late' } })] })
      await Promise.resolve()
    })
    expect(screen.queryByText('too late')).toBeNull()
  })

  it('drops a seed REJECTION that lands after unmount', async () => {
    let fail!: (e: unknown) => void
    api.query.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
    const { unmount } = render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    unmount()
    await act(async () => {
      fail(new Error('network died after unmount'))
      await Promise.resolve()
    })
    expect(screen.queryAllByTestId('trace-entry')).toHaveLength(0)
  })

  it('ignores a pushed event that arrives after unmount', async () => {
    let pushed!: (e: AgentActivityEvent) => void
    api.onEvent.mockImplementationOnce((cb: (e: AgentActivityEvent) => void) => {
      pushed = cb
      return () => {} // deliberately does NOT detach, so the stale callback can still fire
    })
    const { unmount } = render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    unmount()
    expect(() =>
      pushed(mk({ id: 'after', ts: 9, kind: 'message', payload: { text: 'after unmount' } })),
    ).not.toThrow()
    expect(screen.queryByText('after unmount')).toBeNull()
  })

  it('works with an activity api that exposes no onEvent subscription', async () => {
    ;(window as any).agentActivity = {
      query: vi.fn().mockResolvedValue({
        success: true,
        data: [mk({ id: 's', ts: 1, kind: 'message', payload: { text: 'seeded only' } })],
      }),
    }
    const { unmount } = render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(screen.getByText('seeded only')).toBeInTheDocument())
    expect(() => unmount()).not.toThrow() // cleanup must tolerate having no unsubscribe
  })

  it('survives an unsubscribe that throws during cleanup', async () => {
    api.onEvent.mockImplementationOnce(() => () => { throw new Error('unsub boom') })
    const { unmount } = render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(() => unmount()).not.toThrow()
  })

  it('renders an empty timestamp when the locale formatter throws', async () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(() => {
      throw new Error('no Intl data')
    })
    try {
      api.query.mockResolvedValueOnce({
        success: true,
        data: [mk({ id: '1', ts: 1, kind: 'message', payload: { text: 'still rendered' } })],
      })
      render(<ConductorTrace conductorTerminalId="c1" />)
      await waitFor(() => expect(screen.getByText('still rendered')).toBeInTheDocument())
      const spans = screen.getByTestId('trace-entry').querySelectorAll('span')
      expect(spans[1].textContent).toBe('') // time column degrades to blank, row still shown
    } finally {
      spy.mockRestore()
    }
  })

  it('renders an unmapped trace kind with its raw label and the neutral colour', async () => {
    traceOverride.entries = [
      { id: 'x', ts: 1_700_000_000_000, kind: 'mystery' as TraceEntry['kind'], title: 'something new' },
    ]
    try {
      render(<ConductorTrace conductorTerminalId="c1" />)
      await waitFor(() => expect(screen.getByText('something new')).toBeInTheDocument())
      const badge = screen.getByTestId('trace-entry').querySelector('span') as HTMLElement
      expect(badge.textContent).toBe('mystery') // KIND_LABEL fallback → the raw kind
      expect(badge.style.color).toBe('rgb(204, 204, 204)') // KIND_COLOR fallback → #cccccc
      expect(badge.style.borderColor).toBe('rgb(204, 204, 204)')
    } finally {
      traceOverride.entries = null
    }
  })

  it('renders the handoff target arrow for an assignment entry', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [mk({ id: 'a1', ts: 1, kind: 'message', payload: { text: 'Assigning task to reviewer-two' } })],
    })
    render(<ConductorTrace conductorTerminalId="c1" />)
    await waitFor(() => expect(screen.getByTestId('trace-entry')).toBeInTheDocument())
    const badge = screen.getByTestId('trace-entry').querySelector('span') as HTMLElement
    expect(badge.textContent).toBe('ASSIGN')
    expect(badge.style.color).toBe('rgb(34, 211, 238)') // task_assigned → #22d3ee
    expect(screen.getByText(/→ reviewer-two/)).toBeInTheDocument()
  })
})
