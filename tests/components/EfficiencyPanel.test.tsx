import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { EfficiencyPanel } from '../../src/renderer/src/components/EfficiencyPanel/EfficiencyPanel'
import type { AgentActivityEvent } from '../../src/renderer/src/types'

type API = { query: ReturnType<typeof vi.fn> }
let api: API

const mk = (over: Partial<AgentActivityEvent>): AgentActivityEvent => ({
  id: over.id ?? 'e1',
  ts: over.ts ?? Date.now() - 100,
  terminalId: over.terminalId ?? 't1',
  agentType: over.agentType ?? 'claude',
  kind: over.kind ?? 'message',
  summary: '',
  payload: over.payload ?? {},
})

beforeEach(() => {
  api = { query: vi.fn().mockResolvedValue({ success: true, data: [] }) }
  ;(window as any).agentActivity = api
})

describe('EfficiencyPanel', () => {
  it('renders empty-state with no events', async () => {
    render(<EfficiencyPanel onClose={() => {}} />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(screen.getByText(/No agent activity/i)).toBeInTheDocument()
  })

  it('renders agent rows from query', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        mk({ agentType: 'claude', kind: 'message' }),
        mk({ agentType: 'claude', kind: 'tool_call', payload: { tool: 'Edit', input: { file_path: '/x' } } }),
        mk({ agentType: 'claude', kind: 'tool_result', payload: {} }),
        mk({ agentType: 'codex', kind: 'message' }),
      ],
    })
    render(<EfficiencyPanel onClose={() => {}} />)
    await waitFor(() => expect(screen.getAllByTestId('efficiency-row').length).toBe(2))
    const rows = screen.getAllByTestId('efficiency-row')
    expect(within(rows[0]).getByText(/claude|codex/)).toBeInTheDocument()
    expect(within(rows[1]).getByText(/claude|codex/)).toBeInTheDocument()
  })

  it('invokes onClose', () => {
    const onClose = vi.fn()
    render(<EfficiencyPanel onClose={onClose} />)
    fireEvent.click(screen.getByLabelText(/close efficiency panel/i))
    expect(onClose).toHaveBeenCalled()
  })

  it('refreshes on demand', async () => {
    render(<EfficiencyPanel onClose={() => {}} />)
    await waitFor(() => expect(api.query).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByLabelText(/refresh efficiency report/i))
    await waitFor(() => expect(api.query).toHaveBeenCalledTimes(2))
  })

  it('tolerates missing api', () => {
    ;(window as any).agentActivity = undefined
    expect(() => render(<EfficiencyPanel onClose={() => {}} />)).not.toThrow()
  })
})
