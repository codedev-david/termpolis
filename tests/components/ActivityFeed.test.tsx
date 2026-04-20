import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ActivityFeed } from '../../src/renderer/src/components/ActivityFeed/ActivityFeed'
import type { AgentActivityEvent } from '../../src/renderer/src/types'

type AgentActivityAPI = {
  query: ReturnType<typeof vi.fn>
  stats: ReturnType<typeof vi.fn>
  attachWatcher: ReturnType<typeof vi.fn>
  detachWatcher: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
}

let api: AgentActivityAPI
let pushEvent: ((e: AgentActivityEvent) => void) | null = null

function mkEvent(over: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: over.id ?? `e${Math.random()}`,
    ts: over.ts ?? Date.now(),
    terminalId: over.terminalId ?? 't1',
    agentType: over.agentType ?? 'claude',
    kind: over.kind ?? 'message',
    summary: over.summary ?? 'sample',
    payload: over.payload ?? {},
  }
}

beforeEach(() => {
  pushEvent = null
  api = {
    query: vi.fn().mockResolvedValue({ success: true, data: [] }),
    stats: vi.fn().mockResolvedValue({ success: true, data: { ringSize: 0, dropped: 0 } }),
    attachWatcher: vi.fn(),
    detachWatcher: vi.fn(),
    onEvent: vi.fn((cb) => {
      pushEvent = cb
      return () => { pushEvent = null }
    }),
  }
  ;(window as any).agentActivity = api
})

describe('ActivityFeed', () => {
  it('renders empty state when no events', async () => {
    render(<ActivityFeed />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(screen.getByText(/no agent activity yet/i)).toBeInTheDocument()
  })

  it('seeds from query result', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [mkEvent({ id: 'a', summary: 'first' })],
    })
    render(<ActivityFeed />)
    await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument())
  })

  it('adds events pushed via onEvent', async () => {
    render(<ActivityFeed />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    pushEvent?.(mkEvent({ id: 'x', summary: 'live event' }))
    await waitFor(() => expect(screen.getByText('live event')).toBeInTheDocument())
  })

  it('search filters events', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        mkEvent({ id: 'a', summary: 'apple' }),
        mkEvent({ id: 'b', summary: 'banana' }),
      ],
    })
    render(<ActivityFeed />)
    await waitFor(() => expect(screen.getByText('apple')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText(/search activity/i), {
      target: { value: 'banana' },
    })
    await waitFor(() => {
      expect(screen.queryByText('apple')).not.toBeInTheDocument()
      expect(screen.getByText('banana')).toBeInTheDocument()
    })
  })

  it('kind filter narrows list', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        mkEvent({ id: 'a', kind: 'message', summary: 'msg' }),
        mkEvent({ id: 'b', kind: 'error', summary: 'boom' }),
      ],
    })
    render(<ActivityFeed />)
    await waitFor(() => expect(screen.getByText('msg')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText(/filter by kind/i), { target: { value: 'error' } })
    await waitFor(() => {
      expect(screen.queryByText('msg')).not.toBeInTheDocument()
      expect(screen.getByText('boom')).toBeInTheDocument()
    })
  })

  it('agent filter narrows list', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        mkEvent({ id: 'a', agentType: 'claude', summary: 'c1' }),
        mkEvent({ id: 'b', agentType: 'codex', summary: 'c2' }),
      ],
    })
    render(<ActivityFeed />)
    await waitFor(() => expect(screen.getByText('c1')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText(/filter by agent/i), { target: { value: 'codex' } })
    await waitFor(() => {
      expect(screen.queryByText('c1')).not.toBeInTheDocument()
      expect(screen.getByText('c2')).toBeInTheDocument()
    })
  })

  it('terminalId scoping hides other terminals', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        mkEvent({ id: 'a', terminalId: 't1', summary: 'mine' }),
        mkEvent({ id: 'b', terminalId: 't2', summary: 'theirs' }),
      ],
    })
    render(<ActivityFeed terminalId="t1" />)
    await waitFor(() => expect(screen.getByText('mine')).toBeInTheDocument())
    expect(screen.queryByText('theirs')).not.toBeInTheDocument()
  })

  it('invokes onClose when close button clicked', async () => {
    const onClose = vi.fn()
    render(<ActivityFeed onClose={onClose} />)
    fireEvent.click(screen.getByLabelText(/close activity feed/i))
    expect(onClose).toHaveBeenCalled()
  })

  it('tolerates failed query', async () => {
    api.query.mockRejectedValueOnce(new Error('nope'))
    render(<ActivityFeed />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(screen.getByText(/no agent activity yet/i)).toBeInTheDocument()
  })

  it('tolerates missing agentActivity api', () => {
    ;(window as any).agentActivity = undefined
    expect(() => render(<ActivityFeed />)).not.toThrow()
  })
})
