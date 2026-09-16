import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Profiler } from 'react'
import { render, screen, act } from '@testing-library/react'
import { WorkspaceList } from './WorkspaceList'
import { useTerminalStore } from '../../store/terminalStore'

const seedTerminals = (terminals: unknown[]): void => {
  useTerminalStore.setState({
    terminals: terminals as never,
    workspaces: [],
    activeTerminalId: (terminals[0] as { id?: string })?.id ?? null,
    swarmNotification: null,
  })
}

beforeEach(() => {
  seedTerminals([{ id: 't1', name: 'one', cwd: '/a', shellType: 'bash' }])
  ;(window as any).termpolis = { killTerminal: vi.fn(), createTerminal: vi.fn() }
})

/** Counts commits of the WorkspaceList subtree — a store write it does not care about must not add one. */
const renderCounted = (): { current: number } => {
  const commits = { current: 0 }
  render(
    <Profiler id="workspace-list" onRender={() => { commits.current++ }}>
      <WorkspaceList />
    </Profiler>,
  )
  return commits
}

// jest-dom's matchers are loaded at runtime but not type-augmented in tsconfig.web.json,
// so assert against the DOM property directly.
const saveButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /Save Workspace/ }) as HTMLButtonElement

describe('WorkspaceList store subscription', () => {
  it('does not re-render on the cwd churn of a live shell', () => {
    const commits = renderCounted()
    const before = commits.current

    act(() => { useTerminalStore.getState().updateTerminal('t1', { cwd: '/somewhere-else' }) })

    expect(commits.current).toBe(before)
  })

  it('does not re-render on an unrelated store write', () => {
    const commits = renderCounted()
    const before = commits.current

    act(() => { useTerminalStore.getState().setSwarmNotification({ message: 'hi', type: 'success' }) })

    expect(commits.current).toBe(before)
  })

  it('still re-renders when a workspace it renders is added', () => {
    const commits = renderCounted()
    const before = commits.current

    act(() => { useTerminalStore.getState().addWorkspace('Frontend') })

    expect(commits.current).toBeGreaterThan(before)
    expect(screen.queryByText('Frontend')).not.toBeNull()
  })

  it('still gates Save Workspace on whether any terminal is open', () => {
    renderCounted()
    expect(saveButton().disabled).toBe(false)
  })

  it('disables Save Workspace when no terminal is open', () => {
    seedTerminals([])
    renderCounted()
    expect(saveButton().disabled).toBe(true)
  })

  it('re-renders when a terminal is opened or closed, so the gate tracks it', () => {
    seedTerminals([])
    const commits = renderCounted()
    const before = commits.current

    act(() => {
      useTerminalStore.getState().addTerminal({ id: 't9', name: 'nine', shellType: 'bash', cwd: '/a' } as never)
    })

    expect(commits.current).toBeGreaterThan(before)
    expect(saveButton().disabled).toBe(false)
  })
})
