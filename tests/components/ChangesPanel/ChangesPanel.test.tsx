import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../src/renderer/src/lib/pollingService', () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))

import { subscribe, unsubscribe } from '../../../src/renderer/src/lib/pollingService'
import {
  ChangesPanel, statusColor, statusLabel, splitPath,
} from '../../../src/renderer/src/components/ChangesPanel/ChangesPanel'

const entry = (file: string, status: string, patch: Record<string, any> = {}) => ({
  file, status, added: 0, removed: 0, binary: false, ...patch,
})

const result = (patch: Record<string, any> = {}) => ({
  branch: 'main', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], ...patch,
})

const gitFindRoot = vi.fn()
const gitChanges = vi.fn()
const gitChangeDiff = vi.fn()
const onClose = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as any).termpolis = { gitFindRoot, gitChanges, gitChangeDiff }
  gitFindRoot.mockResolvedValue({ success: true, data: '/repo' })
  gitChanges.mockResolvedValue({ success: true, data: result() })
  gitChangeDiff.mockResolvedValue({ success: true, data: 'diff --git a/a b/a\n' })
})

afterEach(() => { delete (window as any).termpolis })

const mount = (cwd = '/repo/src') => render(<ChangesPanel cwd={cwd} onClose={onClose} />)

describe('ChangesPanel — finding the repo', () => {
  it('resolves the repo root from the terminal cwd, which is usually a subdirectory', async () => {
    mount('/repo/src/components')
    await waitFor(() => expect(gitChanges).toHaveBeenCalledWith('/repo'))
    expect(gitFindRoot).toHaveBeenCalledWith('/repo/src/components')
  })

  it('says so when the terminal is not in a repository', async () => {
    gitFindRoot.mockResolvedValue({ success: true, data: null })
    mount()
    expect(await screen.findByTestId('changes-no-repo')).toBeInTheDocument()
    expect(gitChanges).not.toHaveBeenCalled()
  })

  it('treats a failed root lookup as "not a repository", not as an error', async () => {
    gitFindRoot.mockResolvedValue({ success: false, error: 'not a git repo' })
    mount()
    expect(await screen.findByTestId('changes-no-repo')).toBeInTheDocument()
  })

  it('survives the root lookup rejecting', async () => {
    gitFindRoot.mockRejectedValue(new Error('spawn failed'))
    mount()
    expect(await screen.findByTestId('changes-no-repo')).toBeInTheDocument()
  })

  it('never probes for a root with no cwd', async () => {
    mount('')
    expect(await screen.findByTestId('changes-no-repo')).toBeInTheDocument()
    expect(gitFindRoot).not.toHaveBeenCalled()
  })

  it('shows a transient looking-for-repo state first', () => {
    mount()
    expect(screen.getByText('Looking for a repository…')).toBeInTheDocument()
  })
})

describe('ChangesPanel — states', () => {
  it('says the tree is clean rather than showing empty sections', async () => {
    mount()
    expect(await screen.findByTestId('changes-clean')).toBeInTheDocument()
  })

  it('surfaces the git error text', async () => {
    gitChanges.mockResolvedValue({ success: false, error: 'fatal: bad object' })
    mount()
    expect(await screen.findByTestId('changes-error')).toHaveTextContent('fatal: bad object')
  })

  it('falls back to a readable message when the failure carries no text', async () => {
    gitChanges.mockResolvedValue({ success: false })
    mount()
    expect(await screen.findByTestId('changes-error')).toHaveTextContent('Could not read git status')
  })

  it('surfaces a thrown error too', async () => {
    gitChanges.mockRejectedValue(new Error('bridge died'))
    mount()
    expect(await screen.findByTestId('changes-error')).toHaveTextContent('bridge died')
  })
})

describe('ChangesPanel — the file list', () => {
  const populated = result({
    staged: [entry('src/a.ts', 'M', { added: 3, removed: 1 })],
    unstaged: [entry('src/b.ts', 'M', { added: 10, removed: 0 }), entry('gone.ts', 'D')],
    untracked: [entry('new.ts', '??')],
  })

  beforeEach(() => gitChanges.mockResolvedValue({ success: true, data: populated }))

  it('groups files under Staged, Changes and Untracked', async () => {
    mount()
    await screen.findByTestId('changes-section-staged')
    expect(screen.getByTestId('changes-section-unstaged')).toHaveTextContent('Changes')
    expect(screen.getByTestId('changes-section-untracked')).toHaveTextContent('Untracked')
  })

  it('counts every file across sections in the header', async () => {
    mount()
    expect(await screen.findByText('Changes (4)')).toBeInTheDocument()
  })

  it('shows git\'s own shorthand, including the two-character ??', async () => {
    mount()
    expect(await screen.findByTestId('change-row-new.ts')).toHaveTextContent('??')
    expect(screen.getByTestId('change-row-gone.ts')).toHaveTextContent('D')
  })

  it('shows +/- counts only where there are any', async () => {
    mount()
    expect(await screen.findByTestId('change-row-src/b.ts')).toHaveTextContent('+10')
    expect(screen.getByTestId('change-row-gone.ts')).not.toHaveTextContent('+')
  })

  it('marks a binary file instead of showing a line delta', async () => {
    gitChanges.mockResolvedValue({
      success: true,
      data: result({ unstaged: [entry('logo.png', 'M', { binary: true })] }),
    })
    mount()
    expect(await screen.findByTestId('change-row-logo.png')).toHaveTextContent('bin')
  })

  it('names both sides of a rename in the row tooltip', async () => {
    gitChanges.mockResolvedValue({
      success: true,
      data: result({ staged: [entry('new/path.ts', 'R', { oldFile: 'old/path.ts' })] }),
    })
    mount()
    expect(await screen.findByTestId('change-row-new/path.ts'))
      .toHaveAttribute('title', 'Renamed — old/path.ts → new/path.ts')
  })

  it('collapses and re-expands a section', async () => {
    mount()
    fireEvent.click(await screen.findByTestId('changes-section-staged'))
    expect(screen.queryByTestId('change-row-src/a.ts')).not.toBeInTheDocument()
    // Other sections are unaffected — collapse is per-section, not global.
    expect(screen.getByTestId('change-row-src/b.ts')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('changes-section-staged'))
    expect(screen.getByTestId('change-row-src/a.ts')).toBeInTheDocument()
  })

  it('lists a file staged AND modified in both sections without a key collision', async () => {
    gitChanges.mockResolvedValue({
      success: true,
      data: result({ staged: [entry('both.ts', 'M')], unstaged: [entry('both.ts', 'M')] }),
    })
    mount()
    await waitFor(() => expect(screen.getAllByTestId('change-row-both.ts')).toHaveLength(2))
  })
})

describe('ChangesPanel — branch line', () => {
  it('shows the branch name', async () => {
    gitChanges.mockResolvedValue({ success: true, data: result({ branch: 'feature/x' }) })
    mount()
    expect(await screen.findByText('feature/x')).toBeInTheDocument()
  })

  it('shows commits waiting to be pushed', async () => {
    gitChanges.mockResolvedValue({ success: true, data: result({ ahead: 3 }) })
    mount()
    expect(await screen.findByTitle('3 commit(s) to push')).toHaveTextContent('↑3')
  })

  it('shows commits waiting to be pulled', async () => {
    gitChanges.mockResolvedValue({ success: true, data: result({ behind: 2 }) })
    mount()
    expect(await screen.findByTitle('2 commit(s) to pull')).toHaveTextContent('↓2')
  })

  it('shows neither arrow when in sync', async () => {
    mount()
    await screen.findByTestId('changes-clean')
    expect(screen.queryByText(/^↑/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^↓/)).not.toBeInTheDocument()
  })

  it('shows an em dash for a repo with no branch yet', async () => {
    gitChanges.mockResolvedValue({ success: true, data: result({ branch: '' }) })
    mount()
    expect(await screen.findByText('—')).toBeInTheDocument()
  })
})

describe('ChangesPanel — opening a diff', () => {
  beforeEach(() => gitChanges.mockResolvedValue({
    success: true,
    data: result({
      staged: [entry('s.ts', 'M')],
      unstaged: [entry('u.ts', 'M')],
      untracked: [entry('n.ts', '??')],
    }),
  }))

  it.each([
    ['s.ts', 'staged'],
    ['u.ts', 'unstaged'],
    ['n.ts', 'untracked'],
  ])('requests %s with mode %s', async (file, mode) => {
    mount()
    fireEvent.click(await screen.findByTestId(`change-row-${file}`))
    await waitFor(() => expect(gitChangeDiff).toHaveBeenCalledWith('/repo', file, mode))
    await screen.findByTestId('file-diff-modal')
  })

  it('opens the modal on the repo root, not the terminal cwd', async () => {
    mount('/repo/src/deep')
    fireEvent.click(await screen.findByTestId('change-row-u.ts'))
    await waitFor(() => expect(gitChangeDiff).toHaveBeenCalledWith('/repo', 'u.ts', 'unstaged'))
    expect(await screen.findByTestId('file-diff-modal')).toBeInTheDocument()
  })

  it('shows the diff error inside the modal', async () => {
    gitChangeDiff.mockResolvedValue({ success: false, error: 'fatal: path not found' })
    mount()
    fireEvent.click(await screen.findByTestId('change-row-u.ts'))
    expect(await screen.findByTestId('file-diff-error')).toHaveTextContent('fatal: path not found')
  })

  it('shows a thrown diff failure inside the modal', async () => {
    gitChangeDiff.mockRejectedValue(new Error('bridge died'))
    mount()
    fireEvent.click(await screen.findByTestId('change-row-u.ts'))
    expect(await screen.findByTestId('file-diff-error')).toHaveTextContent('bridge died')
  })

  it('closes the modal without closing the rail', async () => {
    mount()
    fireEvent.click(await screen.findByTestId('change-row-u.ts'))
    fireEvent.click(await screen.findByTestId('file-diff-backdrop'))
    await waitFor(() => expect(screen.queryByTestId('file-diff-modal')).not.toBeInTheDocument())
    expect(screen.getByTestId('changes-panel')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('ChangesPanel — lifecycle', () => {
  it('polls on a 3s cycle keyed to the repo root', async () => {
    mount()
    await waitFor(() => expect(subscribe).toHaveBeenCalled())
    expect((subscribe as any).mock.calls[0][0]).toBe('changes-panel-/repo')
    expect((subscribe as any).mock.calls[0][2]).toBe(3000)
  })

  it('refreshes when the poll fires', async () => {
    mount()
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(1))
    await act(async () => { await (subscribe as any).mock.calls[0][1]() })
    expect(gitChanges).toHaveBeenCalledTimes(2)
  })

  it('clears a stale error once git succeeds again', async () => {
    gitChanges.mockResolvedValueOnce({ success: false, error: 'index.lock exists' })
    mount()
    await screen.findByTestId('changes-error')
    await act(async () => { await (subscribe as any).mock.calls[0][1]() })
    expect(screen.queryByTestId('changes-error')).not.toBeInTheDocument()
  })

  it('never subscribes outside a repo', async () => {
    gitFindRoot.mockResolvedValue({ success: true, data: null })
    mount()
    await screen.findByTestId('changes-no-repo')
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', async () => {
    const { unmount } = mount()
    await waitFor(() => expect(subscribe).toHaveBeenCalled())
    unmount()
    expect(unsubscribe).toHaveBeenCalledWith('changes-panel-/repo')
  })

  it('closes from the header button', async () => {
    mount()
    fireEvent.click(screen.getByLabelText('Close changes panel'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// Every one of these is a `??` fallback arm. They exist so a failure the bridge did not
// describe still reads as a sentence instead of the word "undefined", and the only way to
// know they work is to send a failure that carries no text.
describe('ChangesPanel — fallbacks that must never render "undefined"', () => {
  it('names the failure when git rejects with no message', async () => {
    gitChanges.mockRejectedValue({})
    mount()
    expect(await screen.findByTestId('changes-error')).toHaveTextContent('Could not read git status')
  })

  it('shows an empty diff, not a crash, when the handler succeeds with no data', async () => {
    gitChanges.mockResolvedValue({ success: true, data: result({ unstaged: [entry('u.ts', 'M')] }) })
    gitChangeDiff.mockResolvedValue({ success: true })
    mount()
    fireEvent.click(await screen.findByTestId('change-row-u.ts'))
    expect(await screen.findByTestId('file-diff-empty')).toBeInTheDocument()
  })

  it('names the failure when the diff fails with no error text', async () => {
    gitChanges.mockResolvedValue({ success: true, data: result({ unstaged: [entry('u.ts', 'M')] }) })
    gitChangeDiff.mockResolvedValue({ success: false })
    mount()
    fireEvent.click(await screen.findByTestId('change-row-u.ts'))
    expect(await screen.findByTestId('file-diff-error')).toHaveTextContent('Could not load diff')
  })

  it('names the failure when the diff rejects with no message', async () => {
    gitChanges.mockResolvedValue({ success: true, data: result({ unstaged: [entry('u.ts', 'M')] }) })
    gitChangeDiff.mockRejectedValue({})
    mount()
    fireEvent.click(await screen.findByTestId('change-row-u.ts'))
    expect(await screen.findByTestId('file-diff-error')).toHaveTextContent('Could not load diff')
  })

  it('drops a root lookup that lands after unmount instead of setting state on a dead tree', async () => {
    // Closing the rail while git is still spawning is ordinary, not exotic: the lookup
    // outlives the component every time someone hits Ctrl+Shift+J twice.
    let settle: (v: unknown) => void = () => {}
    gitFindRoot.mockReturnValue(new Promise(r => { settle = r }))
    const { unmount } = mount()
    unmount()
    await act(async () => { settle({ success: true, data: '/repo' }) })
    expect(gitChanges).not.toHaveBeenCalled()
  })
})

describe('statusLabel / statusColor', () => {
  it.each([
    ['M', 'Modified'], ['A', 'Added'], ['D', 'Deleted'], ['R', 'Renamed'],
    ['C', 'Copied'], ['T', 'Type changed'], ['U', 'Conflicted'], ['??', 'Untracked'],
  ])('spells out %s as %s', (code, label) => {
    expect(statusLabel(code)).toBe(label)
  })

  it('falls back to the raw code it does not know', () => {
    expect(statusLabel('X')).toBe('X')
    expect(statusColor('X')).toBe('#abb2bf')
  })

  it('gives a conflict its own colour, distinct from a deletion', () => {
    expect(statusColor('U')).not.toBe(statusColor('D'))
  })
})

describe('splitPath', () => {
  it('separates directory from basename', () => {
    expect(splitPath('src/components/Foo.tsx')).toEqual({ dir: 'src/components/', base: 'Foo.tsx' })
  })

  it('handles a bare filename', () => {
    expect(splitPath('README.md')).toEqual({ dir: '', base: 'README.md' })
  })

  it('handles Windows separators, which git can emit on this platform', () => {
    expect(splitPath('src\\a.ts')).toEqual({ dir: 'src\\', base: 'a.ts' })
  })
})
