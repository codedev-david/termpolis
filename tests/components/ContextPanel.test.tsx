import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let mockFiles: any[] = []
let mockGitInfo: any = null

beforeEach(() => {
  mockFiles = []
  mockGitInfo = null
  ;(window as any).termpolis = {
    completionPathEntries: vi.fn().mockImplementation(() =>
      Promise.resolve({ success: true, data: mockFiles })
    ),
    getGitInfo: vi.fn().mockImplementation(() =>
      Promise.resolve(
        mockGitInfo
          ? { success: true, data: mockGitInfo }
          : { success: false, data: null }
      )
    ),
  }
})

vi.mock('../../src/renderer/src/lib/pollingService', () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))

import { subscribe, unsubscribe } from '../../src/renderer/src/lib/pollingService'
import { ContextPanel } from '../../src/renderer/src/components/ContextPanel/ContextPanel'

describe('ContextPanel', () => {
  // -- Basic rendering --

  it('renders the side panel with Context header', () => {
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    expect(screen.getByText('Context')).toBeInTheDocument()
  })

  it('shows File Tree, Git Status, and Recent Commits sections', () => {
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    expect(screen.getByText('File Tree')).toBeInTheDocument()
    expect(screen.getByText('Git Status')).toBeInTheDocument()
    expect(screen.getByText('Recent Commits')).toBeInTheDocument()
  })

  it('displays the cwd in the footer', () => {
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    expect(screen.getByText('/home/user/project')).toBeInTheDocument()
  })

  // -- Close button --

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(<ContextPanel cwd="/home/user/project" onClose={onClose} />)
    const closeBtn = screen.getByTitle('Close panel (Ctrl+Shift+E)')
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // -- File tree --

  it('renders file tree entries when files are returned', async () => {
    mockFiles = [
      { name: 'src', isDir: true },
      { name: 'README.md', isDir: false },
      { name: 'package.json', isDir: false },
    ]
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('src/')).toBeInTheDocument()
    })
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByText('package.json')).toBeInTheDocument()
  })

  it('shows directories before files (sorted)', async () => {
    mockFiles = [
      { name: 'zebra.txt', isDir: false },
      { name: 'alpha', isDir: true },
      { name: 'beta.ts', isDir: false },
    ]
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('alpha/')).toBeInTheDocument()
    })
    // Directory comes before files
    const allText = screen.getByText('alpha/').closest('div')!.parentElement!
    const items = allText.querySelectorAll('.truncate')
    const texts = Array.from(items).map(el => el.textContent)
    expect(texts.indexOf('alpha/')).toBeLessThan(texts.indexOf('beta.ts'))
    expect(texts.indexOf('alpha/')).toBeLessThan(texts.indexOf('zebra.txt'))
  })

  it('shows file count in File Tree section header', async () => {
    mockFiles = [
      { name: 'src', isDir: true },
      { name: 'README.md', isDir: false },
    ]
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument()
    })
  })

  it('shows "No files" when directory is empty', async () => {
    mockFiles = []
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('No files')).toBeInTheDocument()
    })
  })

  // -- Git status --

  it('shows "Not a git repo" when git info is null', async () => {
    mockGitInfo = null
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Not a git repo')).toBeInTheDocument()
    })
  })

  it('shows "Clean working tree" when git status is empty string', async () => {
    mockGitInfo = { status: '', recentCommits: '' }
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Clean working tree')).toBeInTheDocument()
    })
  })

  it('renders git status lines when present', async () => {
    mockGitInfo = {
      status: 'M src/index.ts\n?? newfile.txt',
      recentCommits: '',
    }
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('M src/index.ts')).toBeInTheDocument()
    })
    expect(screen.getByText('?? newfile.txt')).toBeInTheDocument()
  })

  it('shows status line count badge', async () => {
    mockGitInfo = {
      status: 'M  a.ts\nA  b.ts\nD  c.ts',
      recentCommits: '',
    }
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument()
    })
  })

  // -- Recent commits --

  it('shows "No commits" when there are none', async () => {
    mockGitInfo = { status: '', recentCommits: '' }
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('No commits')).toBeInTheDocument()
    })
  })

  it('renders recent commit lines with hash and message', async () => {
    mockGitInfo = {
      status: '',
      recentCommits: 'abc1234 fix: broken tests\ndef5678 feat: add feature',
    }
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('abc1234')).toBeInTheDocument()
    })
    expect(screen.getByText('fix: broken tests')).toBeInTheDocument()
    expect(screen.getByText('def5678')).toBeInTheDocument()
    expect(screen.getByText('feat: add feature')).toBeInTheDocument()
  })

  // -- Section collapsing --

  it('collapses file tree section when header is clicked', async () => {
    mockFiles = [{ name: 'README.md', isDir: false }]
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('File Tree'))
    expect(screen.queryByText('README.md')).not.toBeInTheDocument()
  })

  it('expands file tree section when header is clicked again', async () => {
    mockFiles = [{ name: 'README.md', isDir: false }]
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('File Tree'))
    expect(screen.queryByText('README.md')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('File Tree'))
    expect(screen.getByText('README.md')).toBeInTheDocument()
  })

  it('collapses git status section independently', async () => {
    mockGitInfo = { status: 'M foo.ts', recentCommits: '' }
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('M foo.ts')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Git Status'))
    expect(screen.queryByText('M foo.ts')).not.toBeInTheDocument()
  })

  // -- Polling --

  it('subscribes to polling on mount and unsubscribes on unmount', () => {
    const { unmount } = render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    expect(subscribe).toHaveBeenCalledWith(
      expect.stringContaining('context-panel-'),
      expect.any(Function),
      5000
    )
    unmount()
    expect(unsubscribe).toHaveBeenCalledWith(expect.stringContaining('context-panel-'))
  })

  it('calls completionPathEntries and getGitInfo on mount', async () => {
    render(<ContextPanel cwd="/test/path" onClose={vi.fn()} />)
    await waitFor(() => {
      expect((window as any).termpolis.completionPathEntries).toHaveBeenCalledWith('/test/path')
    })
    await waitFor(() => {
      expect((window as any).termpolis.getGitInfo).toHaveBeenCalledWith('/test/path')
    })
  })
})
