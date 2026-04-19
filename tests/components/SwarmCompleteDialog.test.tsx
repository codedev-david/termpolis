import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SwarmCompleteDialog } from '../../src/renderer/src/components/SwarmDashboard/SwarmCompleteDialog'

function make(overrides: Record<string, any> = {}) {
  return {
    message: '3 tasks completed successfully',
    tasks: [] as Array<{ id: string; title: string; status: string; result?: string }>,
    onViewDashboard: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
}

describe('SwarmCompleteDialog', () => {
  it('renders "Swarm Complete" heading', () => {
    render(<SwarmCompleteDialog {...make()} />)
    expect(screen.getByText('Swarm Complete')).toBeInTheDocument()
  })

  it('shows the summary message', () => {
    render(<SwarmCompleteDialog {...make({ message: 'All work is done' })} />)
    expect(screen.getByText('All work is done')).toBeInTheDocument()
  })

  it('strips "SWARM COMPLETE:" prefix from message', () => {
    render(<SwarmCompleteDialog {...make({ message: 'SWARM COMPLETE: 2 tasks done' })} />)
    expect(screen.getByText('2 tasks done')).toBeInTheDocument()
    expect(screen.queryByText(/SWARM COMPLETE:/)).not.toBeInTheDocument()
  })

  it('strips prefix case-insensitively', () => {
    render(<SwarmCompleteDialog {...make({ message: 'swarm complete: built the app' })} />)
    expect(screen.getByText('built the app')).toBeInTheDocument()
  })

  it('shows "finished its work" subtitle when no tasks provided', () => {
    render(<SwarmCompleteDialog {...make({ tasks: [] })} />)
    expect(screen.getByText(/finished its work/)).toBeInTheDocument()
  })

  it('shows completed task count when tasks are present', () => {
    const tasks = [
      { id: '1', title: 'Build feature', status: 'completed', result: 'Done' },
      { id: '2', title: 'Write tests', status: 'completed' },
    ]
    render(<SwarmCompleteDialog {...make({ tasks })} />)
    expect(screen.getByText(/2 tasks completed/)).toBeInTheDocument()
  })

  it('shows failed task count separately', () => {
    const tasks = [
      { id: '1', title: 'Build', status: 'completed' },
      { id: '2', title: 'Deploy', status: 'failed', result: 'timeout' },
    ]
    render(<SwarmCompleteDialog {...make({ tasks })} />)
    expect(screen.getByText(/1 task completed/)).toBeInTheDocument()
    expect(screen.getByText(/1 failed/)).toBeInTheDocument()
  })

  it('renders each completed task title', () => {
    const tasks = [
      { id: '1', title: 'Write the README', status: 'completed', result: 'Done' },
      { id: '2', title: 'Add unit tests', status: 'completed' },
    ]
    render(<SwarmCompleteDialog {...make({ tasks })} />)
    expect(screen.getByText('Write the README')).toBeInTheDocument()
    expect(screen.getByText('Add unit tests')).toBeInTheDocument()
  })

  it('renders task result text when provided', () => {
    const tasks = [{ id: '1', title: 'T', status: 'completed', result: 'Created 3 files' }]
    render(<SwarmCompleteDialog {...make({ tasks })} />)
    expect(screen.getByText('Created 3 files')).toBeInTheDocument()
  })

  it('renders failed tasks', () => {
    const tasks = [{ id: '1', title: 'Deploy', status: 'failed', result: 'timed out' }]
    render(<SwarmCompleteDialog {...make({ tasks })} />)
    expect(screen.getByText('Deploy')).toBeInTheDocument()
    expect(screen.getByText('timed out')).toBeInTheDocument()
  })

  it('calls onDismiss when backdrop is clicked', () => {
    const props = make()
    render(<SwarmCompleteDialog {...props} />)
    const backdrop = document.querySelector('.fixed.inset-0')!
    fireEvent.click(backdrop)
    expect(props.onDismiss).toHaveBeenCalled()
  })

  it('does NOT call onDismiss when clicking inside the card', () => {
    const props = make()
    render(<SwarmCompleteDialog {...props} />)
    fireEvent.click(screen.getByText('Swarm Complete'))
    expect(props.onDismiss).not.toHaveBeenCalled()
  })

  it('calls onDismiss when Dismiss button is clicked', () => {
    const props = make()
    render(<SwarmCompleteDialog {...props} />)
    fireEvent.click(screen.getByText('Dismiss'))
    expect(props.onDismiss).toHaveBeenCalled()
  })

  it('calls onViewDashboard when View Dashboard button is clicked', () => {
    const props = make()
    render(<SwarmCompleteDialog {...props} />)
    fireEvent.click(screen.getByText('View Dashboard'))
    expect(props.onViewDashboard).toHaveBeenCalled()
  })

  it('shows singular "task" for exactly 1 completed task', () => {
    const tasks = [{ id: '1', title: 'T', status: 'completed' }]
    render(<SwarmCompleteDialog {...make({ tasks })} />)
    expect(screen.getByText(/1 task completed/)).toBeInTheDocument()
    expect(screen.queryByText(/1 tasks/)).not.toBeInTheDocument()
  })

  describe('project location', () => {
    it('renders project location when projectCwd provided', () => {
      render(<SwarmCompleteDialog {...make({ projectCwd: 'C:/Users/dev/my-app' })} />)
      expect(screen.getByText('Project location')).toBeInTheDocument()
      expect(screen.getByText('C:/Users/dev/my-app')).toBeInTheDocument()
    })

    it('does not render project location when projectCwd is null', () => {
      render(<SwarmCompleteDialog {...make({ projectCwd: null })} />)
      expect(screen.queryByText('Project location')).not.toBeInTheDocument()
    })

    it('does not render project location when projectCwd is undefined', () => {
      render(<SwarmCompleteDialog {...make()} />)
      expect(screen.queryByText('Project location')).not.toBeInTheDocument()
    })

    it('calls openPath IPC when Open button is clicked', () => {
      const openPath = vi.fn()
      ;(window as any).termpolis = { openPath }
      render(<SwarmCompleteDialog {...make({ projectCwd: '/home/dev/project' })} />)
      fireEvent.click(screen.getByTitle('Open folder'))
      expect(openPath).toHaveBeenCalledWith('/home/dev/project')
    })

    it('does not crash if openPath IPC is missing', () => {
      ;(window as any).termpolis = {}
      render(<SwarmCompleteDialog {...make({ projectCwd: '/tmp/x' })} />)
      expect(() => fireEvent.click(screen.getByTitle('Open folder'))).not.toThrow()
    })
  })
})
