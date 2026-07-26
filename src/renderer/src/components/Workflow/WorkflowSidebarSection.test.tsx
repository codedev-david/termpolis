import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowSidebarSection, groupWorkflows } from './WorkflowSidebarSection'
import { useTerminalStore } from '../../store/terminalStore'
import type { WorkflowListItem } from '../../types'

const seed = (workflows: WorkflowListItem[], activeRuns: Record<string, unknown> = {}): void => {
  useTerminalStore.setState({ activeRuns: activeRuns as never })
  useTerminalStore.getState().setWorkflows(workflows)
}

beforeEach(() => {
  seed([])
})

describe('groupWorkflows', () => {
  it('puts uncategorised rows first, then categories A-Z', () => {
    const groups = groupWorkflows([
      { id: '1', name: 'Zed', category: 'Release' },
      { id: '2', name: 'Loose' },
      { id: '3', name: 'Ana', category: 'Build' },
    ])
    expect(groups.map(g => g.category)).toEqual(['', 'Build', 'Release'])
  })

  it('sorts names A-Z inside each category', () => {
    const groups = groupWorkflows([
      { id: '1', name: 'Zed', category: 'Build' },
      { id: '2', name: 'Ana', category: 'Build' },
      { id: '3', name: 'Mid', category: 'Build' },
    ])
    expect(groups[0].items.map(i => i.name)).toEqual(['Ana', 'Mid', 'Zed'])
  })

  it('treats a whitespace-only category as no category', () => {
    const groups = groupWorkflows([{ id: '1', name: 'A', category: '   ' }])
    expect(groups).toEqual([{ category: '', items: [{ id: '1', name: 'A', category: '   ' }] }])
  })

  it('returns nothing for an empty list', () => {
    expect(groupWorkflows([])).toEqual([])
  })
})

describe('WorkflowSidebarSection — "What are workflows?" explainer', () => {
  it('is closed until the info button is clicked', () => {
    seed([])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.queryByText(/save a sequence of steps/i)).toBeNull()
    expect(screen.getByTestId('workflow-info').getAttribute('title')).toBe('What are workflows?')
  })

  it('explains steps, triggers and availability when opened', () => {
    seed([])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByTestId('workflow-info'))
    expect(screen.getByText(/save a sequence of steps/i)).toBeTruthy()
    expect(screen.getByText('Steps')).toBeTruthy()
    expect(screen.getByText('Triggers')).toBeTruthy()
    expect(screen.getByText('Availability')).toBeTruthy()
  })

  it('opening the explainer does not start a workflow', () => {
    const onCreate = vi.fn()
    seed([])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={onCreate} />)
    fireEvent.click(screen.getByTestId('workflow-info'))
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('closes on "Got it"', () => {
    seed([])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByTestId('workflow-info'))
    fireEvent.click(screen.getByText('Got it'))
    expect(screen.queryByText(/save a sequence of steps/i)).toBeNull()
  })

  it('closes on the × button', () => {
    seed([])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByTestId('workflow-info'))
    fireEvent.click(screen.getByText('×'))
    expect(screen.queryByText(/save a sequence of steps/i)).toBeNull()
  })
})

describe('WorkflowSidebarSection', () => {
  it('shows the workflow count in the header', () => {
    seed([
      { id: '1', name: 'A', scope: 'project' },
      { id: '2', name: 'B', scope: 'global' },
    ])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByText('(2)')).toBeTruthy()
  })

  it('the + button starts a workflow directly — no template menu', () => {
    const onCreate = vi.fn()
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={onCreate} />)
    fireEvent.click(screen.getByTitle('Start Workflow'))
    expect(onCreate).toHaveBeenCalledTimes(1)
    // The retired starter templates must not come back as a menu.
    expect(screen.queryByText('Blank workflow')).toBeNull()
    expect(screen.queryByText('Claude Code + Shell')).toBeNull()
    expect(screen.queryByText('Full Stack Dev')).toBeNull()
    expect(screen.queryByText('Code Review')).toBeNull()
  })

  it('puts info LAST and + before it, so info lines up with the Workspaces info above', () => {
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    const info = screen.getByTestId('workflow-info')
    const controls = Array.from(info.parentElement?.children ?? [])
    expect(controls).toHaveLength(2)
    expect(controls[0].getAttribute('title')).toBe('Start Workflow')
    expect(controls[1]).toBe(info)
  })

  it('lists global and project workflows under separate scope groups', () => {
    seed([
      { id: 'g', name: 'Everywhere', scope: 'global' },
      { id: 'p', name: 'Just here', scope: 'project' },
    ])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByText('Global')).toBeTruthy()
    expect(screen.getByText('This project')).toBeTruthy()
    expect(screen.getByText('Everywhere')).toBeTruthy()
    expect(screen.getByText('Just here')).toBeTruthy()
  })

  it('hides a scope group entirely when it has no workflows', () => {
    seed([{ id: 'g', name: 'Everywhere', scope: 'global' }])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByText('Global')).toBeTruthy()
    expect(screen.queryByText('This project')).toBeNull()
  })

  it('treats a workflow with no scope as a project workflow', () => {
    seed([{ id: 'x', name: 'Legacy' }])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByText('This project')).toBeTruthy()
    expect(screen.queryByText('Global')).toBeNull()
  })

  it('renders a category as a collapsible folder that hides its rows', () => {
    seed([{ id: 'a', name: 'Nightly', category: 'Release', scope: 'project' }])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByText('Nightly')).toBeTruthy()
    fireEvent.click(screen.getByText('Release'))
    expect(screen.queryByText('Nightly')).toBeNull()
    fireEvent.click(screen.getByText('Release'))
    expect(screen.getByText('Nightly')).toBeTruthy()
  })

  it('collapsing a scope group hides only that scope', () => {
    seed([
      { id: 'g', name: 'Everywhere', scope: 'global' },
      { id: 'p', name: 'Just here', scope: 'project' },
    ])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByText('Global'))
    expect(screen.queryByText('Everywhere')).toBeNull()
    expect(screen.getByText('Just here')).toBeTruthy()
  })

  it('opens a row with its own id and scope so main reads the right store', () => {
    const onOpen = vi.fn()
    seed([
      { id: 'g', name: 'Everywhere', scope: 'global' },
      { id: 'p', name: 'Just here', scope: 'project' },
    ])
    render(<WorkflowSidebarSection onOpen={onOpen} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByText('Everywhere'))
    expect(onOpen).toHaveBeenCalledWith('g', 'global')
    fireEvent.click(screen.getByText('Just here'))
    expect(onOpen).toHaveBeenCalledWith('p', 'project')
  })

  it('collapsing the whole section hides every scope group', () => {
    seed([{ id: 'p', name: 'Just here', scope: 'project' }])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByText('Workflows'))
    expect(screen.queryByText('Just here')).toBeNull()
    expect(screen.queryByText('This project')).toBeNull()
  })

  it('pulses a dot on the workflow that is currently running', () => {
    seed(
      [
        { id: 'p', name: 'Running one', scope: 'project' },
        { id: 'q', name: 'Idle one', scope: 'project' },
      ],
      { r1: { runId: 'r1', workflowId: 'p', status: 'running', steps: [], startedAt: 1 } },
    )
    const { container } = render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(1)
    expect(screen.getByTitle('Running one').querySelector('.animate-pulse')).toBeTruthy()
  })

  it('a global and a project workflow that share an id are distinct rows', () => {
    seed([
      { id: 'same', name: 'Global copy', scope: 'global' },
      { id: 'same', name: 'Project copy', scope: 'project' },
    ])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByText('Global copy')).toBeTruthy()
    expect(screen.getByText('Project copy')).toBeTruthy()
  })

  it('titles a categorised row with its folder so a truncated name stays findable', () => {
    seed([{ id: 'a', name: 'Nightly', category: 'Release', scope: 'project' }])
    render(<WorkflowSidebarSection onOpen={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByTitle('Release — Nightly')).toBeTruthy()
  })
})
