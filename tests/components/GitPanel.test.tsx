import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'

let mockActiveTerminalId: string | null = 't1'
const mockTerminals = [
  { id: 't1', name: 'Terminal 1', cwd: '/test/project', shellType: 'bash', color: '#fff', hidden: false },
]

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        terminals: mockTerminals,
        activeTerminalId: mockActiveTerminalId,
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        terminals: mockTerminals,
        activeTerminalId: mockActiveTerminalId,
      })),
      setState: vi.fn(),
    },
  ),
}))

vi.mock('../../src/renderer/src/lib/pollingService', () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))

const mockGitStatusParsed = vi.fn()
const mockGitStage = vi.fn()
const mockGitUnstage = vi.fn()
const mockGitCommit = vi.fn()
const mockGitPull = vi.fn()
const mockGitPush = vi.fn()
const mockGitFileDiff = vi.fn()

beforeAll(() => {
  ;(window as any).termpolis = {
    gitStatusParsed: mockGitStatusParsed,
    gitStage: mockGitStage,
    gitUnstage: mockGitUnstage,
    gitCommit: mockGitCommit,
    gitPull: mockGitPull,
    gitPush: mockGitPush,
    gitFileDiff: mockGitFileDiff,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mockActiveTerminalId = 't1'
  mockGitStatusParsed.mockResolvedValue({
    success: true,
    data: {
      branch: 'main',
      staged: [{ file: 'src/index.ts', status: 'M' }],
      unstaged: [{ file: 'README.md', status: 'M' }, { file: 'newfile.ts', status: '?' }],
    },
  })
  mockGitStage.mockResolvedValue({ success: true })
  mockGitUnstage.mockResolvedValue({ success: true })
  mockGitCommit.mockResolvedValue({ success: true })
  mockGitPull.mockResolvedValue({ success: true, data: 'Already up to date.' })
  mockGitPush.mockResolvedValue({ success: true, data: '' })
  mockGitFileDiff.mockResolvedValue({ success: true, data: '+added line\n-removed line' })
})

import { GitPanel } from '../../src/renderer/src/components/GitPanel/GitPanel'

describe('GitPanel', () => {
  it('renders git header with branch name', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument())
    expect(screen.getByText('Git')).toBeInTheDocument()
  })

  it('shows staged and unstaged file sections', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('src/index.ts')).toBeInTheDocument())
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByText('newfile.ts')).toBeInTheDocument()
  })

  it('shows staged count and unstaged count', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('(1)')).toBeInTheDocument()) // staged
    expect(screen.getByText('(2)')).toBeInTheDocument() // unstaged
  })

  it('calls gitStage when + button is clicked on unstaged file', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())
    const stageButtons = screen.getAllByTitle('Stage')
    fireEvent.click(stageButtons[0])
    await waitFor(() => expect(mockGitStage).toHaveBeenCalledWith('/test/project', ['README.md']))
  })

  it('calls gitUnstage when − button is clicked on staged file', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('src/index.ts')).toBeInTheDocument())
    const unstageButtons = screen.getAllByTitle('Unstage')
    fireEvent.click(unstageButtons[0])
    await waitFor(() => expect(mockGitUnstage).toHaveBeenCalledWith('/test/project', ['src/index.ts']))
  })

  it('commits with message when Commit button is clicked', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Commit message...')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Commit message...'), { target: { value: 'fix: bug' } })
    fireEvent.click(screen.getByText('Commit'))
    await waitFor(() => expect(mockGitCommit).toHaveBeenCalledWith('/test/project', 'fix: bug'))
  })

  it('commits on Enter key in message input', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Commit message...')).toBeInTheDocument())
    const input = screen.getByPlaceholderText('Commit message...')
    fireEvent.change(input, { target: { value: 'feat: new' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(mockGitCommit).toHaveBeenCalledWith('/test/project', 'feat: new'))
  })

  it('disables Commit button when message is empty', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Commit')).toBeInTheDocument())
    expect(screen.getByText('Commit').closest('button')).toBeDisabled()
  })

  it('calls gitPull when Pull button is clicked', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Pull')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Pull'))
    await waitFor(() => expect(mockGitPull).toHaveBeenCalledWith('/test/project'))
  })

  it('calls gitPush when Push button is clicked', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Push')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Push'))
    await waitFor(() => expect(mockGitPush).toHaveBeenCalledWith('/test/project'))
  })

  it('shows diff when file name is clicked', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(mockGitFileDiff).toHaveBeenCalledWith('/test/project', 'README.md'))
    expect(screen.getByText('Back')).toBeInTheDocument()
  })

  it('closes diff view when Back is clicked', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByText('Back')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Back'))
    expect(screen.queryByText('Back')).not.toBeInTheDocument()
  })

  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn()
    render(<GitPanel onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('Git')).toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when X button is clicked', async () => {
    const onClose = vi.fn()
    render(<GitPanel onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('Git')).toBeInTheDocument())
    // X button is the last button in the header
    const buttons = screen.getAllByRole('button')
    const closeBtn = buttons.find(b => b.querySelector('.fa-xmark'))
    fireEvent.click(closeBtn!)
    expect(onClose).toHaveBeenCalled()
  })

  it('shows clean working tree message when no changes', async () => {
    mockGitStatusParsed.mockResolvedValue({
      success: true,
      data: { branch: 'main', staged: [], unstaged: [] },
    })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/nothing to commit/)).toBeInTheDocument())
  })

  it('shows error when not a git repository', async () => {
    mockGitStatusParsed.mockResolvedValue({ success: false, error: 'Not a git repository' })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByText('Not a git repository').length).toBeGreaterThan(0))
  })

  it('shows error banner on failed commit', async () => {
    mockGitCommit.mockResolvedValue({ success: false, error: 'nothing to commit' })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Commit message...')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Commit message...'), { target: { value: 'test' } })
    fireEvent.click(screen.getByText('Commit'))
    await waitFor(() => expect(screen.getByText('nothing to commit')).toBeInTheDocument())
  })

  it('shows message when no terminal selected', () => {
    mockActiveTerminalId = null
    render(<GitPanel onClose={vi.fn()} />)
    expect(screen.getByText(/No terminal selected/)).toBeInTheDocument()
  })

  it('has Stage All and Unstage All buttons', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Stage All')).toBeInTheDocument())
    expect(screen.getByText('Unstage All')).toBeInTheDocument()
  })

  it('Stage All stages all unstaged files', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Stage All')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Stage All'))
    await waitFor(() => expect(mockGitStage).toHaveBeenCalledWith('/test/project', ['README.md', 'newfile.ts']))
  })

  it('has Refresh button', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTitle('Refresh')).toBeInTheDocument())
  })

  it('collapses staged section when clicked', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('src/index.ts')).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Staged Changes/))
    expect(screen.queryByText('src/index.ts')).not.toBeInTheDocument()
  })
})
