import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ContextGauge } from '../../src/renderer/src/components/ContextGauge/ContextGauge'
import type { AgentActivityEvent } from '../../src/renderer/src/types'

type AgentActivityAPI = {
  query: ReturnType<typeof vi.fn>
  stats: ReturnType<typeof vi.fn>
  attachWatcher: ReturnType<typeof vi.fn>
  detachWatcher: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
}

let api: AgentActivityAPI

function mkEvent(over: Partial<AgentActivityEvent>): AgentActivityEvent {
  return {
    id: over.id ?? 'e1',
    ts: over.ts ?? 1,
    terminalId: over.terminalId ?? 't1',
    agentType: over.agentType ?? 'claude',
    kind: over.kind ?? 'message',
    summary: over.summary ?? '',
    payload: over.payload ?? {},
  }
}

beforeEach(() => {
  api = {
    query: vi.fn().mockResolvedValue({ success: true, data: [] }),
    stats: vi.fn(),
    attachWatcher: vi.fn(),
    detachWatcher: vi.fn(),
    onEvent: vi.fn(() => () => {}),
  }
  ;(window as any).agentActivity = api
})

describe('ContextGauge', () => {
  it('renders 0% when no events', async () => {
    render(<ContextGauge terminalId="t1" model="claude" />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(screen.getByTestId('context-gauge')).toHaveTextContent('0%')
  })

  it('reflects token_update events for its terminal', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        mkEvent({
          id: 'a',
          kind: 'token_update',
          terminalId: 't1',
          payload: { inputTokens: 50_000, outputTokens: 50_000 },
        }),
      ],
    })
    render(<ContextGauge terminalId="t1" model="claude-opus-4-7" />)
    await waitFor(() => expect(screen.getByTestId('context-gauge')).toHaveTextContent(/50%/))
  })

  it('scopes to terminalId', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        mkEvent({
          id: 'other',
          kind: 'token_update',
          terminalId: 't2',
          payload: { inputTokens: 199_000 },
        }),
      ],
    })
    render(<ContextGauge terminalId="t1" model="claude-opus-4-7" />)
    await waitFor(() => expect(screen.getByTestId('context-gauge')).toHaveTextContent('0%'))
  })

  it('calls onClick when pressed', () => {
    const onClick = vi.fn()
    render(<ContextGauge terminalId="t1" onClick={onClick} />)
    fireEvent.click(screen.getByTestId('context-gauge'))
    expect(onClick).toHaveBeenCalled()
  })

  it('marks heuristic source with ~', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [mkEvent({ kind: 'message', payload: { length: 400_000 } })],
    })
    render(<ContextGauge terminalId="t1" model="gpt-4" />)
    await waitFor(() => expect(screen.getByTestId('context-gauge')).toHaveTextContent('~'))
  })
})
