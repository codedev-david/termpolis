import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowSidebarSection } from './WorkflowSidebarSection'
import { useTerminalStore } from '../../store/terminalStore'

beforeEach(() => {
  useTerminalStore.setState({ activeRuns: {} })
  useTerminalStore.getState().setWorkflows([])
})

describe('WorkflowSidebarSection', () => {
  it('lists workflows and pulses a running one', () => {
    useTerminalStore.getState().setWorkflows([{ id: 'a', name: 'Deploy' }, { id: 'b', name: 'ETL' }])
    useTerminalStore.getState().applyRunEvent({ type: 'run:started', runId: 'r', workflowId: 'a', at: 1 } as any)
    render(<WorkflowSidebarSection onOpen={() => {}} onCreate={() => {}} />)
    expect(screen.getByText('Deploy')).toBeTruthy()
    expect(screen.getByText('ETL')).toBeTruthy()
    expect(document.querySelector('.animate-pulse')).toBeTruthy()
  })

  it('shows no pulse when no run is active for a workflow', () => {
    useTerminalStore.getState().setWorkflows([{ id: 'a', name: 'Deploy' }])
    render(<WorkflowSidebarSection onOpen={() => {}} onCreate={() => {}} />)
    expect(document.querySelector('.animate-pulse')).toBeNull()
  })

  it('shows no pulse when the only run for a workflow has already finished', () => {
    useTerminalStore.getState().setWorkflows([{ id: 'a', name: 'Deploy' }])
    useTerminalStore.getState().applyRunEvent({ type: 'run:started', runId: 'r', workflowId: 'a', at: 1 } as any)
    useTerminalStore.getState().applyRunEvent({ type: 'run:finished', runId: 'r', status: 'succeeded', at: 2 } as any)
    render(<WorkflowSidebarSection onOpen={() => {}} onCreate={() => {}} />)
    expect(document.querySelector('.animate-pulse')).toBeNull()
  })

  it('renders the workflow count in the header', () => {
    useTerminalStore.getState().setWorkflows([{ id: 'a', name: 'Deploy' }, { id: 'b', name: 'ETL' }])
    render(<WorkflowSidebarSection onOpen={() => {}} onCreate={() => {}} />)
    expect(screen.getByText('(2)')).toBeTruthy()
  })

  it('fires onCreate when the New Workflow button is clicked', () => {
    const onCreate = vi.fn()
    render(<WorkflowSidebarSection onOpen={() => {}} onCreate={onCreate} />)
    fireEvent.click(screen.getByTitle('New Workflow'))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('fires onOpen with the workflow id when a row is clicked', () => {
    useTerminalStore.getState().setWorkflows([{ id: 'wf1', name: 'Deploy' }])
    const onOpen = vi.fn()
    render(<WorkflowSidebarSection onOpen={onOpen} onCreate={() => {}} />)
    fireEvent.click(screen.getByText('Deploy'))
    expect(onOpen).toHaveBeenCalledWith('wf1')
  })

  it('collapses and expands the workflow list', () => {
    useTerminalStore.getState().setWorkflows([{ id: 'a', name: 'Deploy' }])
    render(<WorkflowSidebarSection onOpen={() => {}} onCreate={() => {}} />)
    expect(screen.getByText('Deploy')).toBeTruthy()
    fireEvent.click(screen.getByText('Workflows'))
    expect(screen.queryByText('Deploy')).toBeNull()
    fireEvent.click(screen.getByText('Workflows'))
    expect(screen.getByText('Deploy')).toBeTruthy()
  })
})
