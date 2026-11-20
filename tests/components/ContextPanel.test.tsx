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

// Map in Lumopolis, on the folders of the file tree: a hover button and a right-click menu.
describe('ContextPanel Map in Lumopolis', () => {
  const opened = (): { calls: unknown[]; stop: () => void } => {
    const calls: unknown[] = []
    const on = (e: Event): void => { calls.push((e as CustomEvent).detail) }
    window.addEventListener('termpolis:openWorld', on)
    return { calls, stop: () => window.removeEventListener('termpolis:openWorld', on) }
  }

  it('a folder\'s globe maps that folder; a file has none', async () => {
    mockFiles = [{ name: 'src', isDir: true }, { name: 'README.md', isDir: false }]
    render(<ContextPanel cwd="C:\repo" onClose={vi.fn()} />)
    const globe = await screen.findByTestId('context-map-world-src')
    expect(globe).toHaveAttribute('title', 'Map src in Lumopolis')
    expect(screen.queryByTestId('context-map-world-README.md')).toBeNull()
    const o = opened()
    fireEvent.click(globe)
    o.stop()
    expect(o.calls).toEqual([{ folder: 'C:\\repo\\src' }])
  })

  it('right-clicking a folder offers Map in Lumopolis, which maps it and closes the menu', async () => {
    mockFiles = [{ name: 'lib', isDir: true }, { name: 'a.txt', isDir: false }]
    render(<ContextPanel cwd="/home/me/app/" onClose={vi.fn()} />)
    await screen.findByText('lib/')
    fireEvent.contextMenu(screen.getByText('a.txt'))
    expect(screen.queryByTestId('context-folder-menu')).toBeNull()
    fireEvent.contextMenu(screen.getByText('lib/'), { clientX: 30, clientY: 40 })
    const menu = screen.getByRole('menu', { name: 'lib folder' })
    expect(menu).toHaveStyle({ left: '30px', top: '40px' })
    fireEvent.mouseDown(menu) // a press inside the menu keeps it
    const item = screen.getByRole('menuitem', { name: 'Map in Lumopolis' })
    expect(document.activeElement).toBe(item)
    const o = opened()
    fireEvent.click(item)
    o.stop()
    expect(o.calls).toEqual([{ folder: '/home/me/app/lib' }])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('the menu goes on a click elsewhere, Esc, a scroll or the window losing focus', async () => {
    mockFiles = [{ name: 'lib', isDir: true }]
    render(<ContextPanel cwd="/r" onClose={vi.fn()} />)
    const row = await screen.findByText('lib/')
    const close = async (act: () => void): Promise<void> => {
      fireEvent.contextMenu(row)
      expect(screen.getByRole('menu')).toBeInTheDocument()
      act()
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    }
    await close(() => fireEvent.mouseDown(document.body))
    fireEvent.contextMenu(row)
    fireEvent.keyDown(window, { key: 'a' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await close(() => fireEvent.scroll(document.body))
    await close(() => fireEvent.blur(window))
  })
})

describe('ContextPanel edges', () => {
  it('a git lookup that throws reads as no repository', async () => {
    ;(window as any).termpolis.getGitInfo = vi.fn().mockRejectedValue(new Error('ipc'))
    render(<ContextPanel cwd="/r" onClose={vi.fn()} />)
    expect(await screen.findByText('Not a git repo')).toBeInTheDocument()
  })

  it('colours untracked, renamed and unknown status lines, and folds the commits away', async () => {
    mockGitInfo = { status: '?? n.txt\nR a -> b\nU  c', recentCommits: 'abc1234 one\nnospace' }
    render(<ContextPanel cwd="/r" onClose={vi.fn()} />)
    expect(await screen.findByText('?? n.txt')).toHaveStyle({ color: '#61afef' })
    expect(screen.getByText('R a -> b')).toHaveStyle({ color: '#c678dd' })
    expect(screen.getByText('U c')).toHaveStyle({ color: '#abb2bf' })
    expect(await screen.findByText('abc1234')).toBeInTheDocument()
    expect(screen.getByText('nospace')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Recent Commits'))
    expect(screen.queryByText('abc1234')).toBeNull()
  })

  it('lists nothing without a folder, or when the listing fails or throws', async () => {
    render(<ContextPanel cwd="" onClose={vi.fn()} />)
    expect((window as any).termpolis.completionPathEntries).not.toHaveBeenCalled()
    ;(window as any).termpolis.completionPathEntries = vi.fn().mockResolvedValue({ success: false })
    render(<ContextPanel cwd="/a" onClose={vi.fn()} />)
    ;(window as any).termpolis.completionPathEntries = vi.fn().mockRejectedValue(new Error('ipc'))
    render(<ContextPanel cwd="/b" onClose={vi.fn()} />)
    await waitFor(() => expect((window as any).termpolis.completionPathEntries).toHaveBeenCalled())
    expect(screen.getAllByText('No files').length).toBeGreaterThan(0)
  })
})
