import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowRunner } from './WorkflowRunner'
import { useTerminalStore } from '../../store/terminalStore'

const wf = (steps: any[]) => ({
  id: 'x',
  name: 'X',
  version: 1 as const,
  trigger: { type: 'manual' as const },
  steps,
})
const twoStep = () =>
  wf([
    { id: 'a', type: 'command', name: 'Build', source: 'inline', command: '' },
    { id: 'b', type: 'command', name: 'Test', source: 'inline', command: '' },
  ])

const ev = (e: any) => useTerminalStore.getState().applyRunEvent(e)

let unsub: ReturnType<typeof vi.fn>
beforeEach(() => {
  useTerminalStore.setState({ activeRuns: {}, workflows: [] })
  unsub = vi.fn()
  ;(window as any).termpolis = {
    runWorkflow: vi.fn().mockResolvedValue({ success: true, data: { runId: 'r' } }),
    cancelWorkflow: vi.fn().mockResolvedValue({ success: true }),
    onWorkflowRunEvent: vi.fn(() => unsub),
  }
})

describe('WorkflowRunner', () => {
  it('renders a timeline node per step and reflects statuses from the store', () => {
    ev({ type: 'run:started', runId: 'r', workflowId: 'x', at: 1 })
    ev({ type: 'step:finished', runId: 'r', stepId: 'a', result: { stepId: 'a', status: 'succeeded', output: '', exitCode: 0 } })
    render(<WorkflowRunner workflow={twoStep()} runId="r" cwd="/r" />)
    expect(screen.getByText('Build')).toBeTruthy()
    expect(screen.getByText('Test')).toBeTruthy()
    expect(screen.getByTestId('step-node-a').className).toMatch(/succeed|green/i)
  })

  it('falls back to pending for steps with no result yet', () => {
    ev({ type: 'run:started', runId: 'r', workflowId: 'x', at: 1 })
    render(<WorkflowRunner workflow={twoStep()} runId="r" cwd="/r" />)
    expect(screen.getByTestId('step-node-b').className).toMatch(/pending/i)
  })

  it('shows exit code and duration when present', () => {
    ev({ type: 'run:started', runId: 'r', workflowId: 'x', at: 1 })
    ev({ type: 'step:finished', runId: 'r', stepId: 'a', result: { stepId: 'a', status: 'failed', output: '', exitCode: 2, startedAt: 100, endedAt: 350 } })
    render(<WorkflowRunner workflow={twoStep()} runId="r" cwd="/r" />)
    expect(screen.getByText(/exit 2/i)).toBeTruthy()
    expect(screen.getByText(/250\s*ms/i)).toBeTruthy()
  })

  it('streams live output into the step pane', () => {
    ev({ type: 'run:started', runId: 'r', workflowId: 'x', at: 1 })
    ev({ type: 'step:started', runId: 'r', stepId: 'a', at: 2 })
    ev({ type: 'step:output', runId: 'r', stepId: 'a', chunk: 'compiling-now' })
    render(<WorkflowRunner workflow={twoStep()} runId="r" cwd="/r" />)
    expect(screen.getByText(/compiling-now/)).toBeTruthy()
  })

  it('Run starts the workflow via IPC when idle', () => {
    render(<WorkflowRunner workflow={twoStep()} runId={null} cwd="/r" />)
    fireEvent.click(screen.getByText('Run'))
    expect((window as any).termpolis.runWorkflow).toHaveBeenCalledWith('/r', 'x')
  })

  it('shows Cancel while running and cancels via IPC', () => {
    ev({ type: 'run:started', runId: 'r', workflowId: 'x', at: 1 })
    render(<WorkflowRunner workflow={twoStep()} runId="r" cwd="/r" />)
    fireEvent.click(screen.getByText('Cancel'))
    expect((window as any).termpolis.cancelWorkflow).toHaveBeenCalledWith('r')
  })

  it('Run button invokes runWorkflow with the cwd and workflow id', () => {
    render(<WorkflowRunner workflow={twoStep()} runId={null} cwd="/proj" />)
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    expect((window as any).termpolis.runWorkflow).toHaveBeenCalledWith('/proj', 'x')
  })

  it('Run button is disabled while a run is in progress', () => {
    ev({ type: 'run:started', runId: 'r', workflowId: 'x', at: 1 })
    render(<WorkflowRunner workflow={twoStep()} runId="r" cwd="/proj" />)
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    // disabled → onRun never fires
    expect((window as any).termpolis.runWorkflow).not.toHaveBeenCalled()
  })

  it('does not show Cancel when there is no active run', () => {
    render(<WorkflowRunner workflow={twoStep()} runId={null} cwd="/r" />)
    expect(screen.queryByText('Cancel')).toBeNull()
  })

  it('subscribes to run events on mount and unsubscribes on unmount', () => {
    const { unmount } = render(<WorkflowRunner workflow={twoStep()} runId="r" cwd="/r" />)
    expect((window as any).termpolis.onWorkflowRunEvent).toHaveBeenCalledTimes(1)
    unmount()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it('pipes each streamed run event into the store via applyRunEvent', () => {
    // The mount subscription hands the main process a callback; prove that callback
    // actually routes events into the store reducer (not merely that we subscribed).
    let cb: (e: any) => void = () => {}
    ;(window as any).termpolis.onWorkflowRunEvent = vi.fn((fn: any) => { cb = fn; return unsub })
    render(<WorkflowRunner workflow={twoStep()} runId="r" cwd="/r" />)
    cb({ type: 'run:started', runId: 'r', workflowId: 'x', at: 1 })
    cb({ type: 'step:finished', runId: 'r', stepId: 'a', result: { stepId: 'a', status: 'succeeded', output: '', exitCode: 0 } })
    expect(
      useTerminalStore.getState().activeRuns['r']?.steps.find(s => s.stepId === 'a')?.status,
    ).toBe('succeeded')
  })
})
