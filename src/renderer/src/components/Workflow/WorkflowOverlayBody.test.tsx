import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkflowOverlayBody } from './WorkflowOverlayBody'
import { useTerminalStore } from '../../store/terminalStore'

const deploy = {
  id: 'wf1',
  name: 'Deploy',
  version: 1 as const,
  trigger: { type: 'manual' as const },
  steps: [{ id: 'a', type: 'command', name: 'Build', source: 'inline', command: 'echo hi' }],
}

beforeEach(() => {
  useTerminalStore.setState({ activeRuns: {}, workflows: [] })
  ;(window as any).termpolis = {
    readWorkflow: vi.fn().mockResolvedValue({ success: true, data: deploy }),
    saveWorkflow: vi.fn().mockResolvedValue({ success: true }),
    runWorkflow: vi.fn().mockResolvedValue({ success: true, data: { runId: 'r' } }),
    cancelWorkflow: vi.fn().mockResolvedValue({ success: true }),
    onWorkflowRunEvent: vi.fn(() => vi.fn()),
  }
})

describe('WorkflowOverlayBody', () => {
  it('new mode renders the Designer on a blank workflow and never reads from disk', () => {
    render(<WorkflowOverlayBody view={{ mode: 'new' }} cwd="/p" onSaved={vi.fn()} />)
    expect(screen.getByLabelText('Workflow name')).toBeTruthy()
    expect((window as any).termpolis.readWorkflow).not.toHaveBeenCalled()
  })

  it('edit mode loads the workflow by id and shows its name in the Designer', async () => {
    render(<WorkflowOverlayBody view={{ mode: 'edit', id: 'wf1' }} cwd="/p" onSaved={vi.fn()} />)
    expect((window as any).termpolis.readWorkflow).toHaveBeenCalledWith('/p', 'wf1')
    await waitFor(() =>
      expect((screen.getByLabelText('Workflow name') as HTMLInputElement).value).toBe('Deploy'),
    )
  })

  it('switching to the Run tab mounts the Runner timeline', async () => {
    render(<WorkflowOverlayBody view={{ mode: 'edit', id: 'wf1' }} cwd="/p" onSaved={vi.fn()} />)
    await waitFor(() => screen.getByLabelText('Workflow name'))
    expect(screen.queryByTestId('step-node-a')).toBeNull()
    fireEvent.click(screen.getByLabelText('Run tab'))
    expect(screen.getByTestId('step-node-a')).toBeTruthy()
  })

  it('shows a hint (and does not read from disk) when there is no project directory', () => {
    render(<WorkflowOverlayBody view={{ mode: 'edit', id: 'wf1' }} cwd={null} onSaved={vi.fn()} />)
    expect(screen.getByText(/open a terminal/i)).toBeTruthy()
    expect((window as any).termpolis.readWorkflow).not.toHaveBeenCalled()
  })

  it('surfaces a load error when the workflow cannot be read', async () => {
    ;(window as any).termpolis.readWorkflow = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'Workflow not found' })
    render(<WorkflowOverlayBody view={{ mode: 'edit', id: 'missing' }} cwd="/p" onSaved={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Workflow not found')).toBeTruthy())
  })

  it('derives the runId from activeRuns by workflowId so the Runner reflects a running run', async () => {
    useTerminalStore.setState({
      activeRuns: {
        r9: { runId: 'r9', workflowId: 'wf1', status: 'running', steps: [], startedAt: 1 },
      } as any,
    })
    render(<WorkflowOverlayBody view={{ mode: 'edit', id: 'wf1' }} cwd="/p" onSaved={vi.fn()} />)
    await waitFor(() => screen.getByLabelText('Workflow name'))
    fireEvent.click(screen.getByLabelText('Run tab'))
    // The Runner only renders Cancel when its bound run is 'running'.
    expect(screen.getByText('Cancel')).toBeTruthy()
  })

  it('binds the LATEST run when several runs exist for the same workflow (sort by startedAt desc)', async () => {
    // Two runs for wf1: an older finished one and a newer running one. The sort
    // comparator must pick the newer (higher startedAt); the Runner then shows
    // Cancel because its bound run is 'running'. With a stale older run winning,
    // Cancel would be absent.
    useTerminalStore.setState({
      activeRuns: {
        rOld: { runId: 'rOld', workflowId: 'wf1', status: 'succeeded', steps: [], startedAt: 1 },
        rNew: { runId: 'rNew', workflowId: 'wf1', status: 'running', steps: [], startedAt: 99 },
      } as any,
    })
    render(<WorkflowOverlayBody view={{ mode: 'edit', id: 'wf1' }} cwd="/p" onSaved={vi.fn()} />)
    await waitFor(() => screen.getByLabelText('Workflow name'))
    fireEvent.click(screen.getByLabelText('Run tab'))
    expect(screen.getByText('Cancel')).toBeTruthy()
  })

  it('propagates Designer Save through onSaved', async () => {
    const onSaved = vi.fn()
    render(<WorkflowOverlayBody view={{ mode: 'edit', id: 'wf1' }} cwd="/p" onSaved={onSaved} />)
    await waitFor(() => screen.getByLabelText('Workflow name'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it('preserves unsaved Designer edits when toggling to the Run tab and back', async () => {
    render(<WorkflowOverlayBody view={{ mode: 'edit', id: 'wf1' }} cwd="/p" onSaved={vi.fn()} />)
    await waitFor(() => screen.getByLabelText('Workflow name'))
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByLabelText('Run tab'))
    fireEvent.click(screen.getByLabelText('Design tab'))
    expect((screen.getByLabelText('Workflow name') as HTMLInputElement).value).toBe('Renamed')
  })

  it('re-reads the saved workflow from disk after Save so the Run timeline reflects it', async () => {
    // Mount returns a 1-step workflow; the post-save re-read returns a 2-step
    // version. This proves the Save handler refreshes this component's `wf`
    // from disk, so the Runner (which renders one node per step) shows the
    // freshly saved steps rather than the pre-save timeline.
    const oneStep = {
      ...deploy,
      steps: [{ id: 'a', type: 'command', name: 'Build', source: 'inline', command: 'echo hi' }],
    }
    const twoStep = {
      ...deploy,
      steps: [
        ...oneStep.steps,
        { id: 'b', type: 'control', name: 'Notify', action: 'notify', config: { message: 'done' } },
      ],
    }
    ;(window as any).termpolis.readWorkflow = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: oneStep }) // initial mount load
      .mockResolvedValue({ success: true, data: twoStep }) // every read after Save
    render(<WorkflowOverlayBody view={{ mode: 'edit', id: 'wf1' }} cwd="/p" onSaved={vi.fn()} />)
    await waitFor(() => screen.getByLabelText('Workflow name'))
    // Run tab before saving shows only the single mounted step.
    fireEvent.click(screen.getByLabelText('Run tab'))
    expect(screen.getByTestId('step-node-a')).toBeTruthy()
    expect(screen.queryByTestId('step-node-b')).toBeNull()
    // Save (from the Designer) triggers the disk re-read → wf gains step b.
    fireEvent.click(screen.getByLabelText('Design tab'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect((window as any).termpolis.readWorkflow).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByLabelText('Run tab'))
    await waitFor(() => expect(screen.getByTestId('step-node-b')).toBeTruthy())
    expect(screen.getByTestId('step-node-a')).toBeTruthy()
  })
})
