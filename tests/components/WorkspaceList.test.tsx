import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAddWorkspace = vi.fn()
const mockRemoveWorkspace = vi.fn()
const mockRenameWorkspace = vi.fn()
const mockUpdateWorkspace = vi.fn()

let mockStoreState: Record<string, any> = {}

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = mockStoreState
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => mockStoreState),
      setState: vi.fn(),
    },
  ),
}))

vi.mock('../../src/renderer/src/lib/homedir', () => ({
  getHomedir: vi.fn().mockResolvedValue('/home/user'),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockStoreState = {
    workspaces: [],
    terminals: [
      { id: 't1', name: 'Terminal 1', color: '#fff', shellType: 'bash', cwd: '/home/user', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
    ],
    addWorkspace: mockAddWorkspace,
    removeWorkspace: mockRemoveWorkspace,
    renameWorkspace: mockRenameWorkspace,
    updateWorkspace: mockUpdateWorkspace,
  }
  ;(window as any).termpolis = {
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    killTerminal: vi.fn().mockResolvedValue({ success: true }),
  }
})

import { WorkspaceList } from '../../src/renderer/src/components/Sidebar/WorkspaceList'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

describe('WorkspaceList', () => {
  describe('rendering', () => {
    it('renders Workspaces section header', () => {
      render(<WorkspaceList />)
      expect(screen.getByText('Workspaces')).toBeInTheDocument()
    })

    it('renders workspace names', () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [
          { id: 'w1', name: 'Frontend', terminals: [] },
          { id: 'w2', name: 'Backend', terminals: [] },
        ],
      }
      render(<WorkspaceList />)
      expect(screen.getByText('Frontend')).toBeInTheDocument()
      expect(screen.getByText('Backend')).toBeInTheDocument()
    })

    it('shows Save Workspace button when terminals exist', () => {
      render(<WorkspaceList />)
      expect(screen.getByText('+ Save Workspace')).toBeInTheDocument()
    })

    it('disables Save Workspace button when no terminals exist', () => {
      mockStoreState = { ...mockStoreState, terminals: [] }
      render(<WorkspaceList />)
      const btn = screen.getByText('+ Save Workspace')
      expect(btn).toBeDisabled()
    })

    it('shows info button for workspace help', () => {
      render(<WorkspaceList />)
      expect(screen.getByTitle('What are workspaces?')).toBeInTheDocument()
    })
  })

  describe('create new workspace', () => {
    it('shows input field when Save Workspace is clicked', () => {
      render(<WorkspaceList />)
      fireEvent.click(screen.getByText('+ Save Workspace'))
      expect(screen.getByPlaceholderText(/workspace name/i)).toBeInTheDocument()
    })

    it('calls addWorkspace when Save button is clicked', () => {
      render(<WorkspaceList />)
      fireEvent.click(screen.getByText('+ Save Workspace'))
      const input = screen.getByPlaceholderText(/workspace name/i)
      fireEvent.change(input, { target: { value: 'My Workspace' } })
      fireEvent.click(screen.getByText('Save'))
      expect(mockAddWorkspace).toHaveBeenCalledWith('My Workspace')
    })

    it('calls addWorkspace when Enter key is pressed', () => {
      render(<WorkspaceList />)
      fireEvent.click(screen.getByText('+ Save Workspace'))
      const input = screen.getByPlaceholderText(/workspace name/i)
      fireEvent.change(input, { target: { value: 'Enter WS' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(mockAddWorkspace).toHaveBeenCalledWith('Enter WS')
    })

    it('uses default name when input is empty', () => {
      render(<WorkspaceList />)
      fireEvent.click(screen.getByText('+ Save Workspace'))
      fireEvent.click(screen.getByText('Save'))
      expect(mockAddWorkspace).toHaveBeenCalledWith('Workspace')
    })

    it('cancels saving when Cancel button is clicked', () => {
      render(<WorkspaceList />)
      fireEvent.click(screen.getByText('+ Save Workspace'))
      expect(screen.getByPlaceholderText(/workspace name/i)).toBeInTheDocument()
      fireEvent.click(screen.getByText('Cancel'))
      expect(screen.queryByPlaceholderText(/workspace name/i)).not.toBeInTheDocument()
      expect(mockAddWorkspace).not.toHaveBeenCalled()
    })

    it('cancels saving when Escape key is pressed', () => {
      render(<WorkspaceList />)
      fireEvent.click(screen.getByText('+ Save Workspace'))
      const input = screen.getByPlaceholderText(/workspace name/i)
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.queryByPlaceholderText(/workspace name/i)).not.toBeInTheDocument()
    })
  })

  describe('delete workspace', () => {
    it('calls removeWorkspace when delete button is clicked', () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [{ id: 'w1', name: 'To Delete', terminals: [] }],
      }
      render(<WorkspaceList />)
      fireEvent.click(screen.getByLabelText('Delete To Delete'))
      expect(mockRemoveWorkspace).toHaveBeenCalledWith('w1')
    })

    it('does not activate workspace when delete is clicked', () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [{ id: 'w1', name: 'WS1', terminals: [] }],
      }
      render(<WorkspaceList />)
      fireEvent.click(screen.getByLabelText('Delete WS1'))
      // killTerminal should NOT be called (that would indicate activation)
      expect((window as any).termpolis.killTerminal).not.toHaveBeenCalled()
    })
  })

  describe('load workspace (activate)', () => {
    it('kills existing terminals and creates workspace terminals on click', async () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [
          {
            id: 'w1',
            name: 'My WS',
            terminals: [
              { name: 'WS Term 1', color: '#ff0', shellType: 'bash', cwd: '/project', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
              { name: 'WS Term 2', color: '#0ff', shellType: 'powershell', cwd: '/other', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
            ],
          },
        ],
      }
      // getState returns current terminals to be killed
      ;(useTerminalStore.getState as any).mockReturnValue({
        terminals: [{ id: 't1', name: 'Old', color: '#fff', shellType: 'bash', cwd: '/' }],
      })
      render(<WorkspaceList />)
      fireEvent.click(screen.getByText('My WS'))
      await waitFor(() => {
        // Should kill the existing terminal
        expect((window as any).termpolis.killTerminal).toHaveBeenCalledWith('t1')
      })
      await waitFor(() => {
        // Should create 2 new terminals
        expect((window as any).termpolis.createTerminal).toHaveBeenCalledTimes(2)
      })
      // Should set new state
      expect(useTerminalStore.setState).toHaveBeenCalled()
    })

    it('uses home directory when workspace terminal has no cwd', async () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [
          {
            id: 'w1',
            name: 'No CWD WS',
            terminals: [
              { name: 'T', color: '#fff', shellType: 'bash', cwd: '', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
            ],
          },
        ],
      }
      ;(useTerminalStore.getState as any).mockReturnValue({ terminals: [] })
      render(<WorkspaceList />)
      fireEvent.click(screen.getByText('No CWD WS'))
      await waitFor(() => {
        expect((window as any).termpolis.createTerminal).toHaveBeenCalledWith(
          expect.any(String),
          'bash',
          '/home/user', // falls back to homedir
        )
      })
    })
  })

  describe('update workspace', () => {
    it('calls updateWorkspace when update button is clicked', () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [{ id: 'w1', name: 'Updatable', terminals: [] }],
      }
      render(<WorkspaceList />)
      fireEvent.click(screen.getByLabelText('Update Updatable'))
      expect(mockUpdateWorkspace).toHaveBeenCalledWith('w1')
    })

    it('does not activate workspace when update is clicked', () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [{ id: 'w1', name: 'WS1', terminals: [] }],
      }
      render(<WorkspaceList />)
      fireEvent.click(screen.getByLabelText('Update WS1'))
      expect((window as any).termpolis.killTerminal).not.toHaveBeenCalled()
    })
  })

  describe('rename workspace', () => {
    it('shows rename input when rename button is clicked', () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [{ id: 'w1', name: 'Old Name', terminals: [] }],
      }
      render(<WorkspaceList />)
      fireEvent.click(screen.getByLabelText('Rename Old Name'))
      const input = screen.getByDisplayValue('Old Name')
      expect(input).toBeInTheDocument()
    })

    it('commits rename on Enter key', () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [{ id: 'w1', name: 'Old Name', terminals: [] }],
      }
      render(<WorkspaceList />)
      fireEvent.click(screen.getByLabelText('Rename Old Name'))
      const input = screen.getByDisplayValue('Old Name')
      fireEvent.change(input, { target: { value: 'New Name' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(mockRenameWorkspace).toHaveBeenCalledWith('w1', 'New Name')
    })

    it('commits rename on blur', () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [{ id: 'w1', name: 'Old Name', terminals: [] }],
      }
      render(<WorkspaceList />)
      fireEvent.click(screen.getByLabelText('Rename Old Name'))
      const input = screen.getByDisplayValue('Old Name')
      fireEvent.change(input, { target: { value: 'Blurred Name' } })
      fireEvent.blur(input)
      expect(mockRenameWorkspace).toHaveBeenCalledWith('w1', 'Blurred Name')
    })

    it('cancels rename on Escape key', () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [{ id: 'w1', name: 'Old Name', terminals: [] }],
      }
      render(<WorkspaceList />)
      fireEvent.click(screen.getByLabelText('Rename Old Name'))
      const input = screen.getByDisplayValue('Old Name')
      fireEvent.keyDown(input, { key: 'Escape' })
      // Should not rename
      expect(mockRenameWorkspace).not.toHaveBeenCalled()
    })
  })

  describe('collapse/expand', () => {
    it('collapses workspace list when header is clicked', () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [{ id: 'w1', name: 'Visible WS', terminals: [] }],
      }
      render(<WorkspaceList />)
      expect(screen.getByText('Visible WS')).toBeInTheDocument()
      fireEvent.click(screen.getByText('Workspaces'))
      expect(screen.queryByText('Visible WS')).not.toBeInTheDocument()
      expect(screen.queryByText('+ Save Workspace')).not.toBeInTheDocument()
    })

    it('re-expands when header is clicked again', () => {
      mockStoreState = {
        ...mockStoreState,
        workspaces: [{ id: 'w1', name: 'WS', terminals: [] }],
      }
      render(<WorkspaceList />)
      fireEvent.click(screen.getByText('Workspaces'))
      expect(screen.queryByText('WS')).not.toBeInTheDocument()
      fireEvent.click(screen.getByText('Workspaces'))
      expect(screen.getByText('WS')).toBeInTheDocument()
    })
  })

  describe('info modal', () => {
    it('opens workspace info modal when info button is clicked', () => {
      render(<WorkspaceList />)
      fireEvent.click(screen.getByTitle('What are workspaces?'))
      expect(screen.getByText(/save and restore groups of terminals/)).toBeInTheDocument()
    })

    it('closes info modal when Got it button is clicked', () => {
      render(<WorkspaceList />)
      fireEvent.click(screen.getByTitle('What are workspaces?'))
      expect(screen.getByText(/save and restore groups of terminals/)).toBeInTheDocument()
      fireEvent.click(screen.getByText('Got it'))
      expect(screen.queryByText(/save and restore groups of terminals/)).not.toBeInTheDocument()
    })

    it('closes info modal when X button is clicked', () => {
      render(<WorkspaceList />)
      fireEvent.click(screen.getByTitle('What are workspaces?'))
      expect(screen.getByText(/save and restore groups of terminals/)).toBeInTheDocument()
      // The close button renders as the times character
      const closeBtn = screen.getByText('\u00d7')
      fireEvent.click(closeBtn)
      expect(screen.queryByText(/save and restore groups of terminals/)).not.toBeInTheDocument()
    })
  })
})
