import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { RedundancyPanel } from '../../src/renderer/src/components/RedundancyPanel/RedundancyPanel'
import type { AgentActivityEvent } from '../../src/renderer/src/types'

type API = {
  query: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
}

let api: API

const mkEvent = (over: Partial<AgentActivityEvent>): AgentActivityEvent => ({
  id: over.id ?? 'e1',
  ts: over.ts ?? Date.now(),
  terminalId: over.terminalId ?? 't1',
  agentType: over.agentType ?? 'claude',
  kind: over.kind ?? 'tool_call',
  summary: '',
  payload: over.payload ?? {},
})

beforeEach(() => {
  api = {
    query: vi.fn().mockResolvedValue({ success: true, data: [] }),
    onEvent: vi.fn(() => () => {}),
  }
  ;(window as any).agentActivity = api
})

describe('RedundancyPanel', () => {
  it('renders empty-state when no findings', async () => {
    render(<RedundancyPanel onClose={() => {}} />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(screen.getByText(/No duplicate work detected/i)).toBeInTheDocument()
  })

  it('renders findings from query', async () => {
    const now = Date.now()
    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        mkEvent({
          id: 'a',
          ts: now - 100,
          terminalId: 't1',
          agentType: 'claude',
          payload: { tool: 'Edit', input: { file_path: '/x.ts' } },
        }),
        mkEvent({
          id: 'b',
          ts: now - 50,
          terminalId: 't2',
          agentType: 'codex',
          payload: { tool: 'Write', input: { file_path: '/x.ts' } },
        }),
      ],
    })
    render(<RedundancyPanel onClose={() => {}} />)
    await waitFor(() =>
      expect(screen.getByTestId('redundancy-item')).toBeInTheDocument(),
    )
    expect(screen.getByText(/2 terminals edited \/x\.ts/i)).toBeInTheDocument()
  })

  it('invokes onClose', async () => {
    const onClose = vi.fn()
    render(<RedundancyPanel onClose={onClose} />)
    fireEvent.click(screen.getByLabelText(/close redundancy panel/i))
    expect(onClose).toHaveBeenCalled()
  })

  it('manually refreshes', async () => {
    render(<RedundancyPanel onClose={() => {}} />)
    await waitFor(() => expect(api.query).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByLabelText(/refresh redundancy findings/i))
    await waitFor(() => expect(api.query).toHaveBeenCalledTimes(2))
  })

  it('tolerates missing agentActivity api', () => {
    ;(window as any).agentActivity = undefined
    expect(() => render(<RedundancyPanel onClose={() => {}} />)).not.toThrow()
  })
})
