// GitPanel — branch/error-path coverage.
//
// Companion to GitPanel.test.tsx (happy paths). This file drives the arms that
// only fire when git says NO: a repo that isn't a repo, a status read that
// throws, a stage/unstage/commit/pull/push that fails (with AND without an
// error string from git), and — the one that actually matters — the Commit
// Shield refusing to let a staged secret reach history.
//
// Contract being pinned for the shield: the main process (src/main/commitScan.ts
// `blockMessage`) returns { success: false, error: 'Blocked commit: N secret(s)
// detected (<RULE LABELS>). ...' }. The panel must render that reason so the user
// knows WHY, and must never render the secret's value — `hit.sample` carries the
// secret and never leaves main. This file asserts both halves at the UI boundary.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import React from 'react'
import { subscribe, unsubscribe } from '../../src/renderer/src/lib/pollingService'

let mockActiveTerminalId: string | null = 't1'
const mockTerminals = [
  { id: 't1', name: 'Terminal 1', cwd: '/test/project', shellType: 'bash', color: '#fff', hidden: false },
]

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = { terminals: mockTerminals, activeTerminalId: mockActiveTerminalId }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({ terminals: mockTerminals, activeTerminalId: mockActiveTerminalId })),
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
const mockGitFindRoot = vi.fn()
const mockPickDirectory = vi.fn()

const DEFAULT_STATUS = {
  branch: 'main',
  staged: [{ file: 'src/index.ts', status: 'M' }],
  unstaged: [{ file: 'README.md', status: 'M' }, { file: 'newfile.ts', status: '?' }],
}

/** A status read that never comes back. Used to freeze the panel right after an
 *  operation fails, because `refresh()` calls setError(null) on success and would
 *  otherwise wipe the banner we are trying to assert on (see the BUG test below). */
const neverResolves = () => new Promise<never>(() => {})

/** Flush pending promise callbacks + React renders. */
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

/** Shaped like an AWS key so the rule name is realistic, but low-entropy on purpose
 *  so it can never be mistaken for (or flagged as) a real credential. This value must
 *  NEVER appear in the panel — only the rule LABEL may be shown. */
const FAKE_SECRET = 'AKIA' + 'A'.repeat(16)
const SHIELD_COMMIT_BLOCK =
  'Blocked commit: 1 secret detected (AWS Access Key ID). Remove them, or turn off Commit Shield in Settings → AI Security.'
const SHIELD_PUSH_BLOCK =
  'Blocked push: 2 secrets detected (AWS Access Key ID, OpenAI API Key). Remove them, or turn off Commit Shield in Settings → AI Security.'

beforeAll(() => {
  ;(window as any).termpolis = {
    gitFindRoot: mockGitFindRoot,
    pickDirectory: mockPickDirectory,
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
  mockGitStatusParsed.mockResolvedValue({ success: true, data: DEFAULT_STATUS })
  mockGitStage.mockResolvedValue({ success: true })
  mockGitUnstage.mockResolvedValue({ success: true })
  mockGitCommit.mockResolvedValue({ success: true })
  mockGitPull.mockResolvedValue({ success: true, data: 'Already up to date.' })
  mockGitPush.mockResolvedValue({ success: true, data: '' })
  mockGitFileDiff.mockResolvedValue({ success: true, data: '+added line\n-removed line' })
  mockGitFindRoot.mockResolvedValue({ success: true, data: '/test/project' })
  mockPickDirectory.mockResolvedValue({ success: true, data: '/test/project' })
})

import { GitPanel } from '../../src/renderer/src/components/GitPanel/GitPanel'

/** Mount, wait for the tree to load, and freeze the NEXT status read so that an
 *  error set by the operation under test survives long enough to be asserted on. */
async function renderWithFrozenRefresh(status: any = DEFAULT_STATUS) {
  mockGitStatusParsed
    .mockResolvedValueOnce({ success: true, data: status })
    .mockImplementation(neverResolves)
  render(<GitPanel onClose={vi.fn()} />)
  await waitFor(() => expect(screen.getByText(status.branch)).toBeInTheDocument())
}

const lastPollCallback = () => {
  const calls = (subscribe as any).mock.calls
  return calls[calls.length - 1][1] as () => Promise<void>
}

describe('GitPanel — Commit Shield (staged secret must block the commit)', () => {
  it('surfaces the shield block reason and names the RULE that fired', async () => {
    mockGitCommit.mockResolvedValue({ success: false, error: SHIELD_COMMIT_BLOCK })
    await renderWithFrozenRefresh()

    fireEvent.change(screen.getByPlaceholderText('Commit message...'), { target: { value: 'feat: add auth' } })
    fireEvent.click(screen.getByText('Commit'))

    await waitFor(() => expect(screen.getByText(SHIELD_COMMIT_BLOCK)).toBeInTheDocument())
    // The rule LABEL is what the user needs to act on.
    expect(screen.getByText(/AWS Access Key ID/)).toBeInTheDocument()
    expect(mockGitCommit).toHaveBeenCalledWith('/test/project', 'feat: add auth')
  })

  it('never renders the secret VALUE — only the rule label', async () => {
    mockGitCommit.mockResolvedValue({ success: false, error: SHIELD_COMMIT_BLOCK })
    await renderWithFrozenRefresh()

    fireEvent.change(screen.getByPlaceholderText('Commit message...'), { target: { value: 'wip' } })
    fireEvent.click(screen.getByText('Commit'))
    await waitFor(() => expect(screen.getByText(SHIELD_COMMIT_BLOCK)).toBeInTheDocument())

    expect(document.body.textContent).toContain('AWS Access Key ID')
    expect(document.body.textContent).not.toContain(FAKE_SECRET)
    expect(document.body.innerHTML).not.toContain(FAKE_SECRET)
  })

  it('keeps the typed commit message when the shield blocks, so the user can retry', async () => {
    mockGitCommit.mockResolvedValue({ success: false, error: SHIELD_COMMIT_BLOCK })
    await renderWithFrozenRefresh()

    const input = screen.getByPlaceholderText('Commit message...') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'feat: add auth' } })
    fireEvent.click(screen.getByText('Commit'))
    await waitFor(() => expect(screen.getByText(SHIELD_COMMIT_BLOCK)).toBeInTheDocument())

    // A blocked commit must not eat the message — only a SUCCESSFUL commit clears it.
    expect((screen.getByPlaceholderText('Commit message...') as HTMLInputElement).value).toBe('feat: add auth')
  })

  it('surfaces a blocked PUSH and lists every rule that fired, without the values', async () => {
    mockGitPush.mockResolvedValue({ success: false, error: SHIELD_PUSH_BLOCK })
    await renderWithFrozenRefresh()

    fireEvent.click(screen.getByText('Push'))

    await waitFor(() => expect(screen.getByText(SHIELD_PUSH_BLOCK)).toBeInTheDocument())
    expect(screen.getByText(/AWS Access Key ID, OpenAI API Key/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(FAKE_SECRET)
  })

  it('lets the user dismiss the shield banner', async () => {
    mockGitCommit.mockResolvedValue({ success: false, error: SHIELD_COMMIT_BLOCK })
    await renderWithFrozenRefresh()

    fireEvent.change(screen.getByPlaceholderText('Commit message...'), { target: { value: 'wip' } })
    fireEvent.click(screen.getByText('Commit'))
    const banner = await screen.findByText(SHIELD_COMMIT_BLOCK)

    const dismiss = banner.parentElement!.querySelector('button')!
    fireEvent.click(dismiss)

    expect(screen.queryByText(SHIELD_COMMIT_BLOCK)).not.toBeInTheDocument()
  })

  // BUG (reported, not fixed — src/ is off-limits here): handleCommit/handleStage/
  // handleUnstage/handlePull/handlePush all do `setError(...)` and then immediately
  // `await refresh()`, and refresh() does `setError(null)` on success. So the block
  // reason is painted for one frame and then wiped by the refresh that always follows.
  // This test pins the CURRENT behaviour; when the source is fixed it must be updated
  // to expect the banner to persist.
  it('KNOWN BUG: the block reason is wiped by the refresh that runs right after', async () => {
    mockGitCommit.mockResolvedValue({ success: false, error: SHIELD_COMMIT_BLOCK })
    mockGitStatusParsed.mockResolvedValue({ success: true, data: DEFAULT_STATUS })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Commit message...')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('Commit message...'), { target: { value: 'wip' } })
    fireEvent.click(screen.getByText('Commit'))
    await settle()
    await settle()

    // The commit really was refused...
    expect(mockGitCommit).toHaveBeenCalledWith('/test/project', 'wip')
    expect((screen.getByPlaceholderText('Commit message...') as HTMLInputElement).value).toBe('wip')
    // ...but the reason is no longer on screen once refresh() lands.
    expect(screen.queryByText(SHIELD_COMMIT_BLOCK)).not.toBeInTheDocument()
  })
})

describe('GitPanel — commit gate', () => {
  it('rejects an empty commit message: button disabled, Enter does not commit', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Commit message...')).toBeInTheDocument())
    const input = screen.getByPlaceholderText('Commit message...')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockGitCommit).not.toHaveBeenCalled()
    expect(screen.getByText('Commit').closest('button')).toBeDisabled()
  })

  it('rejects a whitespace-only commit message', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Commit message...')).toBeInTheDocument())
    const input = screen.getByPlaceholderText('Commit message...')

    fireEvent.change(input, { target: { value: '   \t  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByText('Commit'))
    await settle()

    expect(mockGitCommit).not.toHaveBeenCalled()
    expect(screen.getByText('Commit').closest('button')).toBeDisabled()
  })

  it('ignores non-Enter keys in the commit box', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Commit message...')).toBeInTheDocument())
    const input = screen.getByPlaceholderText('Commit message...')

    fireEvent.change(input, { target: { value: 'chore: tidy' } })
    fireEvent.keyDown(input, { key: 'a' })
    await settle()

    expect(mockGitCommit).not.toHaveBeenCalled()
  })

  it('clears the message and re-reads status after a successful commit', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Commit message...')).toBeInTheDocument())
    const before = mockGitStatusParsed.mock.calls.length

    fireEvent.change(screen.getByPlaceholderText('Commit message...'), { target: { value: '  fix: trim me  ' } })
    fireEvent.click(screen.getByText('Commit'))
    await settle()

    expect(mockGitCommit).toHaveBeenCalledWith('/test/project', 'fix: trim me')
    expect((screen.getByPlaceholderText('Commit message...') as HTMLInputElement).value).toBe('')
    expect(mockGitStatusParsed.mock.calls.length).toBeGreaterThan(before)
  })

  it('falls back to "Commit failed" when git returns no error text', async () => {
    mockGitCommit.mockResolvedValue({ success: false })
    await renderWithFrozenRefresh()

    fireEvent.change(screen.getByPlaceholderText('Commit message...'), { target: { value: 'wip' } })
    fireEvent.click(screen.getByText('Commit'))

    await waitFor(() => expect(screen.getByText('Commit failed')).toBeInTheDocument())
  })

  it('hides the commit bar when nothing is staged', async () => {
    mockGitStatusParsed.mockResolvedValue({
      success: true,
      data: { branch: 'main', staged: [], unstaged: [{ file: 'README.md', status: 'M' }] },
    })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    expect(screen.queryByPlaceholderText('Commit message...')).not.toBeInTheDocument()
    expect(screen.getByText('No staged changes')).toBeInTheDocument()
    expect(screen.queryByText('Unstage All')).not.toBeInTheDocument()
  })
})

describe('GitPanel — clean tree', () => {
  it('offers nothing to commit and no stage/unstage actions on a clean tree', async () => {
    mockGitStatusParsed.mockResolvedValue({
      success: true,
      data: { branch: 'main', staged: [], unstaged: [] },
    })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/Working tree clean/)).toBeInTheDocument())

    expect(screen.queryByPlaceholderText('Commit message...')).not.toBeInTheDocument()
    expect(screen.queryByText('Stage All')).not.toBeInTheDocument()
    expect(screen.queryByText('Unstage All')).not.toBeInTheDocument()
    // The branch pill still renders — the repo is fine, there is just nothing to do.
    expect(screen.getByText('main')).toBeInTheDocument()
  })
})

describe('GitPanel — staging', () => {
  it('Unstage All unstages every staged file in one call', async () => {
    mockGitStatusParsed.mockResolvedValue({
      success: true,
      data: {
        branch: 'main',
        staged: [{ file: 'a.ts', status: 'M' }, { file: 'b.ts', status: 'A' }],
        unstaged: [{ file: 'c.ts', status: 'M' }],
      },
    })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Unstage All')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Unstage All'))

    await waitFor(() => expect(mockGitUnstage).toHaveBeenCalledWith('/test/project', ['a.ts', 'b.ts']))
  })

  it('shows git\'s reason when staging a single file fails', async () => {
    mockGitStage.mockResolvedValue({ success: false, error: "fatal: pathspec 'README.md' did not match any files" })
    await renderWithFrozenRefresh()

    fireEvent.click(screen.getAllByTitle('Stage')[0])

    await waitFor(() =>
      expect(screen.getByText("fatal: pathspec 'README.md' did not match any files")).toBeInTheDocument())
    expect(mockGitStage).toHaveBeenCalledWith('/test/project', ['README.md'])
  })

  it('falls back to "Stage failed" when git returns no error text', async () => {
    mockGitStage.mockResolvedValue({ success: false })
    await renderWithFrozenRefresh()

    fireEvent.click(screen.getByText('Stage All'))

    await waitFor(() => expect(screen.getByText('Stage failed')).toBeInTheDocument())
    expect(mockGitStage).toHaveBeenCalledWith('/test/project', ['README.md', 'newfile.ts'])
  })

  it('shows git\'s reason when unstaging fails', async () => {
    mockGitUnstage.mockResolvedValue({ success: false, error: 'error: unable to write new index file' })
    await renderWithFrozenRefresh()

    fireEvent.click(screen.getAllByTitle('Unstage')[0])

    await waitFor(() => expect(screen.getByText('error: unable to write new index file')).toBeInTheDocument())
    expect(mockGitUnstage).toHaveBeenCalledWith('/test/project', ['src/index.ts'])
  })

  it('falls back to "Unstage failed" when git returns no error text', async () => {
    mockGitUnstage.mockResolvedValue({ success: false })
    await renderWithFrozenRefresh()

    fireEvent.click(screen.getByText('Unstage All'))

    await waitFor(() => expect(screen.getByText('Unstage failed')).toBeInTheDocument())
  })

  it('disables Pull and Push while an operation is in flight', async () => {
    await renderWithFrozenRefresh() // the refresh after Stage never lands -> loading stays true
    expect(screen.getByText('Pull').closest('button')).not.toBeDisabled()

    fireEvent.click(screen.getByText('Stage All'))

    await waitFor(() => expect(screen.getByText('Pull').closest('button')).toBeDisabled())
    expect(screen.getByText('Push').closest('button')).toBeDisabled()
  })
})

describe('GitPanel — pull/push failures', () => {
  it('falls back to "Pull failed" when git returns no error text', async () => {
    mockGitPull.mockResolvedValue({ success: false })
    await renderWithFrozenRefresh()

    fireEvent.click(screen.getByText('Pull'))

    await waitFor(() => expect(screen.getByText('Pull failed')).toBeInTheDocument())
  })

  it('surfaces "no configured push destination" when there is no remote', async () => {
    mockGitPush.mockResolvedValue({
      success: false,
      error: 'fatal: No configured push destination.',
    })
    await renderWithFrozenRefresh()

    fireEvent.click(screen.getByText('Push'))

    await waitFor(() => expect(screen.getByText('fatal: No configured push destination.')).toBeInTheDocument())
    expect(mockGitPush).toHaveBeenCalledWith('/test/project')
  })

  it('falls back to "Push failed" when git returns no error text', async () => {
    mockGitPush.mockResolvedValue({ success: false })
    await renderWithFrozenRefresh()

    fireEvent.click(screen.getByText('Push'))

    await waitFor(() => expect(screen.getByText('Push failed')).toBeInTheDocument())
  })
})

describe('GitPanel — status read failures', () => {
  it('drops the file tree (and does not crash) when a later status read throws', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    mockGitStatusParsed.mockRejectedValue(new Error('EPIPE: git died'))
    await act(async () => { await lastPollCallback()() })

    expect(screen.queryByText('README.md')).not.toBeInTheDocument()
    expect(screen.queryByText('main')).not.toBeInTheDocument()
    expect(screen.getByText('Loading git status...')).toBeInTheDocument()
  })

  it('drops the file tree when git status reports failure, with or without a message', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    mockGitStatusParsed.mockResolvedValue({ success: false, error: 'fatal: not a git repository' })
    await act(async () => { await lastPollCallback()() })
    expect(screen.getByText('Loading git status...')).toBeInTheDocument()
    // BUG (reported): the error banner is gated on `gitStatus`, which this path just
    // nulled — so the reason git gave is never shown to the user.
    expect(screen.queryByText('fatal: not a git repository')).not.toBeInTheDocument()

    // Same outcome when git returns no message at all (the `?? 'Failed to read git status'` arm).
    mockGitStatusParsed.mockResolvedValue({ success: false })
    await act(async () => { await lastPollCallback()() })
    expect(screen.getByText('Loading git status...')).toBeInTheDocument()
  })

  it('drops the file tree when git status succeeds but returns no data', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    mockGitStatusParsed.mockResolvedValue({ success: true, data: null })
    await act(async () => { await lastPollCallback()() })

    expect(screen.queryByText('README.md')).not.toBeInTheDocument()
    expect(screen.getByText('Loading git status...')).toBeInTheDocument()
  })
})

describe('GitPanel — polling and branch switching', () => {
  it('polls git status every 3s under the "git-panel" id and unsubscribes on unmount', async () => {
    const { unmount } = render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(subscribe).toHaveBeenCalledWith('git-panel', expect.any(Function), 3000))

    unmount()

    expect(unsubscribe).toHaveBeenCalledWith('git-panel')
  })

  it('reflects a branch switch made outside the panel on the next poll', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument())

    mockGitStatusParsed.mockResolvedValue({
      success: true,
      data: { branch: 'feature/login', staged: [], unstaged: [{ file: 'auth.ts', status: 'M' }] },
    })
    await act(async () => { await lastPollCallback()() })

    expect(screen.getByText('feature/login')).toBeInTheDocument()
    expect(screen.queryByText('main')).not.toBeInTheDocument()
    expect(screen.getByText('auth.ts')).toBeInTheDocument()
    expect(screen.queryByText('src/index.ts')).not.toBeInTheDocument()
  })

  it('Refresh re-reads status on demand', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument())
    const before = mockGitStatusParsed.mock.calls.length

    mockGitStatusParsed.mockResolvedValue({
      success: true,
      data: { branch: 'release/1.26', staged: [{ file: 'package.json', status: 'M' }], unstaged: [] },
    })
    fireEvent.click(screen.getByTitle('Refresh'))
    await settle()

    expect(mockGitStatusParsed.mock.calls.length).toBe(before + 1)
    expect(screen.getByText('release/1.26')).toBeInTheDocument()
    expect(screen.getByText('No unstaged changes')).toBeInTheDocument()
  })
})

describe('GitPanel — repository selection', () => {
  it('opens the picker with no default path when no terminal has a cwd', async () => {
    mockActiveTerminalId = null
    mockPickDirectory.mockResolvedValue({ success: true, data: '/picked/repo' })
    mockGitFindRoot.mockResolvedValue({ success: true, data: '/picked/repo' })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Open Folder')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Open Folder'))

    await waitFor(() => expect(mockPickDirectory).toHaveBeenCalledWith(undefined))
    await waitFor(() => expect(mockGitStatusParsed).toHaveBeenCalledWith('/picked/repo'))
  })

  it('recovers after picking a non-repo: the error clears once a real repo is picked', async () => {
    mockGitFindRoot.mockResolvedValueOnce({ success: true, data: null }) // auto-detect: no repo
    mockPickDirectory.mockResolvedValueOnce({ success: true, data: '/not-a-repo' })
    mockGitFindRoot.mockResolvedValueOnce({ success: true, data: null }) // pick #1: still no repo
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Open Folder')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Open Folder'))
    await waitFor(() => expect(screen.getByText('Selected folder is not a git repository')).toBeInTheDocument())

    mockPickDirectory.mockResolvedValueOnce({ success: true, data: '/real/repo' })
    mockGitFindRoot.mockResolvedValueOnce({ success: true, data: '/real/repo' }) // pick #2: a repo
    fireEvent.click(screen.getByText('Open Folder'))

    await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument())
    expect(screen.queryByText('Selected folder is not a git repository')).not.toBeInTheDocument()
    expect(mockGitStatusParsed).toHaveBeenCalledWith('/real/repo')
  })

  it('ignores a picker that returns success with no path', async () => {
    mockGitFindRoot.mockResolvedValue({ success: true, data: null })
    mockPickDirectory.mockResolvedValue({ success: true, data: null })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Open Folder')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Open Folder'))
    await settle()

    expect(screen.getByText('Select a Git Repository')).toBeInTheDocument()
    expect(screen.queryByText('Selected folder is not a git repository')).not.toBeInTheDocument()
  })

  it('shows the repo path with forward slashes and switches repo when it is clicked', async () => {
    mockGitFindRoot.mockResolvedValueOnce({ success: true, data: 'C:\\test\\project' })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('C:/test/project')).toBeInTheDocument())

    mockPickDirectory.mockResolvedValueOnce({ success: true, data: 'D:\\other\\repo' })
    mockGitFindRoot.mockResolvedValueOnce({ success: true, data: 'D:\\other\\repo' })
    fireEvent.click(screen.getByText('C:/test/project'))

    await waitFor(() => expect(mockPickDirectory).toHaveBeenCalledWith('/test/project'))
    await waitFor(() => expect(screen.getByText('D:/other/repo')).toBeInTheDocument())
    expect(mockGitStatusParsed).toHaveBeenCalledWith('D:\\other\\repo')
  })
})

describe('GitPanel — file rows', () => {
  it('labels and colours each known git status, and falls back for unknown ones', async () => {
    mockGitStatusParsed.mockResolvedValue({
      success: true,
      data: {
        branch: 'main',
        staged: [
          { file: 'added.ts', status: 'A' },
          { file: 'deleted.ts', status: 'D' },
          { file: 'renamed.ts', status: 'R' },
          { file: 'copied.ts', status: 'C' },
          { file: 'weird.ts', status: 'X' },
        ],
        unstaged: [{ file: 'untracked.ts', status: '?' }],
      },
    })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('added.ts')).toBeInTheDocument())

    expect(screen.getByTitle('Added')).toHaveClass('text-green-400')
    expect(screen.getByTitle('Deleted')).toHaveClass('text-red-400')
    expect(screen.getByTitle('Renamed')).toHaveClass('text-blue-400')
    expect(screen.getByTitle('Copied')).toHaveClass('text-blue-400')
    expect(screen.getByTitle('Untracked')).toHaveClass('text-gray-400')
    // Unknown status: the raw letter becomes its own tooltip and the colour falls back.
    const unknown = screen.getByTitle('X')
    expect(unknown).toHaveTextContent('X')
    expect(unknown).toHaveClass('text-gray-400')
  })

  it('collapses and re-expands the unstaged section independently of the staged one', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())
    const header = screen.getByText(/^Changes$/).closest('button')!

    fireEvent.click(header)

    expect(screen.queryByText('README.md')).not.toBeInTheDocument()
    expect(screen.queryByText('newfile.ts')).not.toBeInTheDocument()
    expect(screen.getByText('src/index.ts')).toBeInTheDocument() // staged is untouched
    expect(header.querySelector('.fa-chevron-right')).toBeTruthy()

    fireEvent.click(header)

    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(header.querySelector('.fa-chevron-down')).toBeTruthy()
  })

  it('shows "No staged changes" under a collapsed-open staged section when nothing is staged', async () => {
    mockGitStatusParsed.mockResolvedValue({
      success: true,
      data: { branch: 'main', staged: [], unstaged: [{ file: 'README.md', status: 'M' }] },
    })
    render(<GitPanel onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('No staged changes')).toBeInTheDocument())
    expect(screen.getByText('(0)')).toBeInTheDocument()
    expect(screen.getByText('Stage All')).toBeInTheDocument()
  })
})

describe('GitPanel — diff viewer', () => {
  it('colour-codes the diff and hides the file list while open', async () => {
    mockGitFileDiff.mockResolvedValue({
      success: true,
      data: [
        'diff --git a/README.md b/README.md',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1,3 +1,4 @@',
        ' context line',
        '+added line',
        '-removed line',
      ].join('\n'),
    })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByText('+added line')).toBeInTheDocument())

    expect(screen.getByText('+added line')).toHaveClass('text-green-400', 'bg-green-500/10')
    expect(screen.getByText('-removed line')).toHaveClass('text-red-400', 'bg-red-500/10')
    expect(screen.getByText('@@ -1,3 +1,4 @@')).toHaveClass('text-blue-400')
    // File headers look like +/- lines but must NOT be coloured as additions/deletions.
    expect(screen.getByText('+++ b/README.md').className).toBe('')
    expect(screen.getByText('--- a/README.md').className).toBe('')
    expect(screen.getByText('diff --git a/README.md b/README.md').className).toBe('')

    // The diff takes over the body: no file list, no commit bar.
    expect(screen.queryByText(/Staged Changes/)).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Commit message...')).not.toBeInTheDocument()
    expect(mockGitFileDiff).toHaveBeenCalledWith('/test/project', 'README.md')
  })

  it('says "No diff available" when git cannot produce a diff', async () => {
    mockGitFileDiff.mockResolvedValue({ success: false, error: 'boom' })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('newfile.ts')).toBeInTheDocument())

    fireEvent.click(screen.getByText('newfile.ts'))

    await waitFor(() => expect(screen.getByText('No diff available')).toBeInTheDocument())
  })

  it('says "No diff available" when the diff comes back empty', async () => {
    mockGitFileDiff.mockResolvedValue({ success: true, data: '' })
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('newfile.ts')).toBeInTheDocument())

    fireEvent.click(screen.getByText('newfile.ts'))

    await waitFor(() => expect(screen.getByText('No diff available')).toBeInTheDocument())
  })

  it('Back restores the file list and the commit bar', async () => {
    render(<GitPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByText('Back')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Back'))

    expect(screen.getByText(/Staged Changes/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Commit message...')).toBeInTheDocument()
  })
})

describe('GitPanel — dismissal', () => {
  it('closes on a backdrop click but not on a click inside the panel', async () => {
    const onClose = vi.fn()
    const { container } = render(<GitPanel onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('Git')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Git')) // inside the card -> stopPropagation
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(container.firstChild as HTMLElement) // the backdrop itself
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores keys other than Escape', async () => {
    const onClose = vi.fn()
    render(<GitPanel onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('Git')).toBeInTheDocument())

    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'g' })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('stops listening for Escape once unmounted', async () => {
    const onClose = vi.fn()
    const { unmount } = render(<GitPanel onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('Git')).toBeInTheDocument())

    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })
})
