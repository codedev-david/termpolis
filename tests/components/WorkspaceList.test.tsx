import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkspaceList } from '../../src/renderer/src/components/Sidebar/WorkspaceList'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

vi.mock('../../src/renderer/src/store/terminalStore')
vi.mock('../../src/renderer/src/lib/homedir', () => ({
  getHomedir: vi.fn().mockResolvedValue('/home/user'),
}))

describe('WorkspaceList', () => {
  it('renders workspace names', () => {
    vi.mocked(useTerminalStore).mockReturnValue({
      workspaces: [{ id: 'w1', name: 'Frontend', terminals: [] }],
      addWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      terminals: [{ id: 't1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/' }],
    } as any)
    render(<WorkspaceList />)
    expect(screen.getByText('Frontend')).toBeInTheDocument()
  })

  it('calls addWorkspace when save is confirmed', async () => {
    const addWorkspace = vi.fn()
    vi.mocked(useTerminalStore).mockReturnValue({
      workspaces: [],
      addWorkspace,
      removeWorkspace: vi.fn(),
      terminals: [{ id: 't1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/' }],
    } as any)
    render(<WorkspaceList />)
    fireEvent.click(screen.getByText('+ Save Workspace'))
    const input = screen.getByPlaceholderText(/workspace name/i)
    fireEvent.change(input, { target: { value: 'My WS' } })
    fireEvent.click(screen.getByText('Save'))
    expect(addWorkspace).toHaveBeenCalledWith('My WS')
  })
})
