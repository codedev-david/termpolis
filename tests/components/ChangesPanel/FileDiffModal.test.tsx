import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  FileDiffModal,
  buildLines,
  hunkCoverage,
  coverageColor,
  wrapAsBracketedPaste,
  buildHunkPrompt,
  MAX_DIFF_CHARS,
  MAX_DIFF_LINES,
  UNDO_WINDOW_MS,
  COVERAGE_GOOD,
  COVERAGE_LOW,
} from '../../../src/renderer/src/components/ChangesPanel/FileDiffModal'
import { parseUnifiedDiff } from '../../../src/renderer/src/lib/diffParser'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,5 @@ function f() {',
  ' keep',
  '-gone',
  '+added one',
  '+added two',
  ' tail',
  '',
].join('\n')

const onClose = vi.fn()
beforeEach(() => vi.clearAllMocks())

describe('buildLines', () => {
  it('numbers old and new sides independently from the @@ header', () => {
    const lines = buildLines(parseUnifiedDiff(DIFF))
    expect(lines.map(l => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ['hunk', null, null, '@@ -10,4 +10,5 @@ function f() {'],
      ['ctx', 10, 10, 'keep'],
      ['del', 11, null, 'gone'],
      ['add', null, 11, 'added one'],
      ['add', null, 12, 'added two'],
      ['ctx', 12, 13, 'tail'],
    ])
  })

  it('says so for a binary file instead of rendering bytes', () => {
    const lines = buildLines(parseUnifiedDiff(
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
    ))
    expect(lines).toEqual([
      { kind: 'meta', text: 'Binary file — no textual diff', oldNo: null, newNo: null, hunkId: null },
    ])
  })

  it('says so for a pure rename, which is real but has no lines', () => {
    const lines = buildLines(parseUnifiedDiff(
      'diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n',
    ))
    expect(lines).toEqual([
      { kind: 'meta', text: 'No textual changes', oldNo: null, newNo: null, hunkId: null },
    ])
  })

  it('keeps a "no newline at end of file" marker as meta, not as content', () => {
    const lines = buildLines(parseUnifiedDiff(
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n',
    ))
    expect(lines[lines.length - 1]).toEqual({
      kind: 'meta', text: '\\ No newline at end of file', oldNo: null, newNo: null, hunkId: 'a.ts::0',
    })
  })

  it('starts counting at 0 when the hunk header is unparseable', () => {
    const lines = buildLines([
      { file: 'a.ts', status: 'M', preamble: '', added: 0, removed: 0, binary: false,
        hunks: [{ id: 'h', file: 'a.ts', header: '@@ malformed @@', body: '@@ malformed @@\n ctx', patch: '', added: 0, removed: 0, startLine: 0 }] },
    ] as any)
    expect(lines[1]).toEqual({ kind: 'ctx', text: 'ctx', oldNo: 0, newNo: 0, hunkId: 'h' })
  })

  it('handles a single-line @@ header with no counts', () => {
    const lines = buildLines(parseUnifiedDiff(
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -5 +7 @@\n-x\n+y\n',
    ))
    expect(lines[1]).toMatchObject({ kind: 'del', oldNo: 5 })
    expect(lines[2]).toMatchObject({ kind: 'add', newNo: 7 })
  })

  it('renders every file when a diff carries more than one', () => {
    const two = DIFF + 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-b\n+B\n'
    expect(buildLines(parseUnifiedDiff(two)).filter(l => l.kind === 'hunk')).toHaveLength(2)
  })
})

describe('FileDiffModal', () => {
  it('shows the file path and the +/- totals', () => {
    render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
  })

  it('renders the changed lines', () => {
    render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    expect(screen.getByText('added one')).toBeInTheDocument()
    expect(screen.getByText('gone')).toBeInTheDocument()
  })

  it('shows a loading state and hides the counts while it loads', () => {
    render(<FileDiffModal file="src/a.ts" diff="" loading onClose={onClose} />)
    expect(screen.getByText('Loading diff…')).toBeInTheDocument()
    expect(screen.queryByText('+0')).not.toBeInTheDocument()
  })

  it('shows the error instead of an empty diff', () => {
    render(<FileDiffModal file="src/a.ts" diff="" error="git exploded" onClose={onClose} />)
    expect(screen.getByTestId('file-diff-error')).toHaveTextContent('git exploded')
  })

  it('distinguishes "no changes" from an error', () => {
    render(<FileDiffModal file="src/a.ts" diff="" onClose={onClose} />)
    expect(screen.getByTestId('file-diff-empty')).toBeInTheDocument()
  })

  it('truncates a diff with too many lines', () => {
    const many = 'diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1,1 +1,9999 @@\n'
      + Array.from({ length: MAX_DIFF_LINES + 50 }, (_, i) => `+line ${i}`).join('\n') + '\n'
    render(<FileDiffModal file="b" diff={many} onClose={onClose} />)
    expect(screen.getByTestId('file-diff-truncated')).toBeInTheDocument()
  })

  it('truncates on BYTES before parsing, so a huge file is never fully walked', () => {
    const huge = 'diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1,1 +1,2 @@\n+'
      + 'x'.repeat(MAX_DIFF_CHARS + 10) + '\n'
    render(<FileDiffModal file="b" diff={huge} onClose={onClose} />)
    expect(screen.getByTestId('file-diff-truncated')).toBeInTheDocument()
  })

  it('does not claim truncation for a diff that fits', () => {
    render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    expect(screen.queryByTestId('file-diff-truncated')).not.toBeInTheDocument()
  })

  it('closes on Escape', () => {
    render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys', () => {
    render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stops listening for Escape after unmount', () => {
    const { unmount } = render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes when the backdrop is clicked', () => {
    render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('file-diff-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open when the dialog itself is clicked', () => {
    render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('file-diff-modal'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes from the close button', () => {
    render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close diff'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('copies the raw diff', () => {
    const writeText = vi.fn()
    Object.assign(navigator, { clipboard: { writeText } })
    render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    fireEvent.click(screen.getByTitle('Copy diff'))
    expect(writeText).toHaveBeenCalledWith(DIFF)
  })

  it('treats a denied clipboard as a non-event, not a failure', () => {
    Object.assign(navigator, {
      clipboard: { writeText: () => { throw new Error('denied') } },
    })
    render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    expect(() => fireEvent.click(screen.getByTitle('Copy diff'))).not.toThrow()
  })

  it('survives having no clipboard API at all', () => {
    Object.assign(navigator, { clipboard: undefined })
    render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    expect(() => fireEvent.click(screen.getByTitle('Copy diff'))).not.toThrow()
  })

  it('is announced as a dialog naming the file', () => {
    render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} />)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Diff for src/a.ts')
  })
})

// DIFF's single hunk, whose id is `${file}::${index}`. Its added lines land at new-file
// line numbers 11 and 12, which is what the coverage fixtures below key off.
const HUNK_ID = 'src/a.ts::0'

const mountModal = (props: Partial<React.ComponentProps<typeof FileDiffModal>> = {}) =>
  render(<FileDiffModal file="src/a.ts" diff={DIFF} onClose={onClose} {...props} />)

describe('hunkCoverage', () => {
  it('reports nothing when the repo has no coverage data at all', () => {
    expect(hunkCoverage(null, [11, 12])).toBeNull()
    expect(hunkCoverage(undefined, [11, 12])).toBeNull()
  })

  it('reports nothing when a hunk adds no EXECUTABLE lines', () => {
    // A comment-only or blank-line change. Saying 0% here would brand a docs change
    // as untested; "no data" is the honest answer.
    expect(hunkCoverage({ 1: 5 }, [11, 12])).toBeNull()
  })

  it('distinguishes a genuine 0% from no data', () => {
    expect(hunkCoverage({ 11: 0, 12: 0 }, [11, 12])).toEqual({ covered: 0, total: 2, pct: 0 })
  })

  it('counts only the lines lcov actually recorded', () => {
    // 12 is not executable, so it is neither covered nor counted against the total.
    expect(hunkCoverage({ 11: 1, 13: 0 }, [11, 12, 13])).toEqual({ covered: 1, total: 2, pct: 50 })
  })

  it('reports a fully covered hunk', () => {
    expect(hunkCoverage({ 11: 2, 12: 9 }, [11, 12])).toEqual({ covered: 2, total: 2, pct: 100 })
  })

  it('rounds to a whole percent', () => {
    expect(hunkCoverage({ 1: 1, 2: 0, 3: 0 }, [1, 2, 3])?.pct).toBe(33)
  })

  it('reports nothing for a hunk that adds no lines at all', () => {
    expect(hunkCoverage({ 11: 1 }, [])).toBeNull()
  })
})

describe('coverageColor', () => {
  it('is green at and above the good threshold', () => {
    expect(coverageColor(100)).toBe('#98c379')
    expect(coverageColor(COVERAGE_GOOD)).toBe('#98c379')
  })

  it('is amber between the two thresholds', () => {
    expect(coverageColor(COVERAGE_GOOD - 1)).toBe('#e5c07b')
    expect(coverageColor(COVERAGE_LOW)).toBe('#e5c07b')
  })

  it('is red below the low threshold', () => {
    expect(coverageColor(COVERAGE_LOW - 1)).toBe('#e06c75')
    expect(coverageColor(0)).toBe('#e06c75')
  })
})

describe('wrapAsBracketedPaste', () => {
  it('brackets the text so the PTY takes it as ONE paste', () => {
    expect(wrapAsBracketedPaste('hi')).toBe('\x1b[200~hi\x1b[201~')
  })

  it('turns every newline into a carriage return', () => {
    // Without this each \n reads as Enter and the agent answers only the first line.
    expect(wrapAsBracketedPaste('a\nb\nc')).toBe('\x1b[200~a\rb\rc\x1b[201~')
  })

  it('collapses CRLF to a single carriage return', () => {
    expect(wrapAsBracketedPaste('a\r\nb')).toBe('\x1b[200~a\rb\x1b[201~')
  })

  it('handles empty text', () => {
    expect(wrapAsBracketedPaste('')).toBe('\x1b[200~\x1b[201~')
  })
})

describe('buildHunkPrompt', () => {
  const hunk = parseUnifiedDiff(DIFF)[0].hunks[0]

  it('names the file and asks for an explanation', () => {
    expect(buildHunkPrompt('explain', 'src/a.ts', hunk))
      .toContain('Explain this change to src/a.ts')
  })

  it('opens a conversation instead, for discuss', () => {
    const p = buildHunkPrompt('discuss', 'src/a.ts', hunk)
    expect(p).toContain("Let's talk about this change to src/a.ts")
    expect(p).not.toContain('Explain this change')
  })

  it('fences the hunk as a diff so the agent sees what CHANGED, not just the result', () => {
    const p = buildHunkPrompt('explain', 'src/a.ts', hunk)
    expect(p).toContain('```diff')
    expect(p).toContain('-gone')
    expect(p).toContain('+added one')
  })
})

describe('FileDiffModal — the coverage badge', () => {
  it('shows nothing when the repo has no coverage artifact', () => {
    mountModal()
    expect(screen.queryByTestId(`hunk-coverage-${HUNK_ID}`)).not.toBeInTheDocument()
  })

  it('shows what share of the added executable lines is tested', () => {
    mountModal({ coverage: { lines: { 11: 1, 12: 0 }, stale: false } })
    expect(screen.getByTestId(`hunk-coverage-${HUNK_ID}`)).toHaveTextContent('50% tested')
  })

  it('colours the badge by how good the number is', () => {
    mountModal({ coverage: { lines: { 11: 1, 12: 1 }, stale: false } })
    expect(screen.getByTestId(`hunk-coverage-${HUNK_ID}`)).toHaveStyle({ color: '#98c379' })
  })

  it('shows a dash rather than a stale number', () => {
    // A stale percentage is worse than none: it looks authoritative and is wrong.
    const badge = (() => {
      mountModal({ coverage: { lines: { 11: 1, 12: 1 }, stale: true } })
      return screen.getByTestId(`hunk-coverage-${HUNK_ID}`)
    })()
    expect(badge).toHaveTextContent('— tested')
    expect(badge).not.toHaveTextContent('100%')
    expect(badge.getAttribute('title')).toContain('re-run the tests')
  })

  it('explains the ratio in the tooltip when the data is fresh', () => {
    mountModal({ coverage: { lines: { 11: 1, 12: 0 }, stale: false } })
    expect(screen.getByTestId(`hunk-coverage-${HUNK_ID}`))
      .toHaveAttribute('title', '1 of 2 added executable lines are covered by tests')
  })

  it('shows nothing when none of the added lines are executable', () => {
    mountModal({ coverage: { lines: { 999: 1 }, stale: false } })
    expect(screen.queryByTestId(`hunk-coverage-${HUNK_ID}`)).not.toBeInTheDocument()
  })
})

describe('FileDiffModal — opening the hunk menu', () => {
  it('opens from the ⋯ button, which is what makes it discoverable', () => {
    mountModal()
    fireEvent.click(screen.getByTestId(`hunk-menu-button-${HUNK_ID}`))
    expect(screen.getByTestId('hunk-menu')).toBeInTheDocument()
  })

  it('opens from a right-click on the hunk header', () => {
    mountModal()
    fireEvent.contextMenu(screen.getByTestId(`diff-hunk-header-${HUNK_ID}`))
    expect(screen.getByTestId('hunk-menu')).toBeInTheDocument()
  })

  it('opens from a right-click on any body line of the hunk', () => {
    mountModal()
    fireEvent.contextMenu(screen.getByText('added one'))
    expect(screen.getByTestId('hunk-menu')).toBeInTheDocument()
  })

  it('does not open on a file-level line that belongs to no hunk', () => {
    mountModal({ diff: 'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n' })
    fireEvent.contextMenu(screen.getByText('Binary file — no textual diff'))
    expect(screen.queryByTestId('hunk-menu')).not.toBeInTheDocument()
  })

  it('does not close the modal just because the menu opened', () => {
    mountModal()
    fireEvent.contextMenu(screen.getByTestId(`diff-hunk-header-${HUNK_ID}`))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not close the modal when a menu item is clicked', () => {
    // The menu portals to document.body but is a REACT child of the backdrop, so its
    // clicks bubble through the React tree to the backdrop's onClose unless stopped.
    // A disabled item isolates the bubbling from the deliberate close-after-send.
    mountModal({ terminalId: null })
    fireEvent.click(screen.getByTestId(`hunk-menu-button-${HUNK_ID}`))
    fireEvent.click(screen.getByTestId('hunk-menu-explain'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('file-diff-modal')).toBeInTheDocument()
  })
})

describe('FileDiffModal — Explain and Discuss', () => {
  const writeToTerminal = vi.fn()

  beforeEach(() => { (window as any).termpolis = { writeToTerminal } })
  afterEach(() => { delete (window as any).termpolis })

  const openMenu = (props: Partial<React.ComponentProps<typeof FileDiffModal>> = {}) => {
    mountModal({ terminalId: 't1', ...props })
    fireEvent.click(screen.getByTestId(`hunk-menu-button-${HUNK_ID}`))
  }

  it('sends Explain as a complete question', () => {
    openMenu()
    fireEvent.click(screen.getByTestId('hunk-menu-explain'))
    expect(writeToTerminal).toHaveBeenCalledTimes(2)
    expect(writeToTerminal.mock.calls[0][0]).toBe('t1')
    expect(writeToTerminal.mock.calls[0][1]).toContain('Explain this change to src/a.ts')
    expect(writeToTerminal.mock.calls[0][1]).toMatch(/^\x1b\[200~/)
    // The trailing Enter is what makes it a question rather than a draft.
    expect(writeToTerminal.mock.calls[1][1]).toBe('\r')
  })

  it('stages Discuss WITHOUT sending it, so you type your own question', () => {
    openMenu()
    fireEvent.click(screen.getByTestId('hunk-menu-discuss'))
    expect(writeToTerminal).toHaveBeenCalledTimes(1)
    expect(writeToTerminal.mock.calls[0][1]).toContain("Let's talk about this change")
  })

  it('closes the modal after sending, putting you back at the agent', () => {
    openMenu()
    fireEvent.click(screen.getByTestId('hunk-menu-explain'))
    expect(onClose).toHaveBeenCalled()
  })

  it('disables both when no terminal is attached', () => {
    mountModal({ terminalId: null })
    fireEvent.click(screen.getByTestId(`hunk-menu-button-${HUNK_ID}`))
    expect(screen.getByTestId('hunk-menu-explain')).toBeDisabled()
    expect(screen.getByTestId('hunk-menu-discuss')).toBeDisabled()
    expect(screen.getByTestId('hunk-menu-explain'))
      .toHaveAttribute('title', 'No terminal is attached to this panel')
  })

  it('says what Discuss will do, since "no Enter" is not obvious', () => {
    openMenu()
    expect(screen.getByTestId('hunk-menu-discuss'))
      .toHaveAttribute('title', 'Pastes the hunk into the terminal without sending it')
  })

  it('does nothing when the bridge has no writeToTerminal', () => {
    delete (window as any).termpolis
    openMenu()
    expect(() => fireEvent.click(screen.getByTestId('hunk-menu-explain'))).not.toThrow()
  })
})

describe('FileDiffModal — Revert', () => {
  const onApplyHunk = vi.fn()

  // Block body, NOT a concise arrow. mockResolvedValue returns the mock itself for
  // chaining, and Vitest treats a function returned from beforeEach as that test's
  // teardown — so it would CALL onApplyHunk after every test. That is invisible while
  // the mock resolves, but the rejection tests below would have their teardown call
  // reject with nothing awaiting it, failing a test whose assertions had already passed.
  beforeEach(() => { onApplyHunk.mockResolvedValue({ ok: true }) })

  const openMenu = (props: Partial<React.ComponentProps<typeof FileDiffModal>> = {}) => {
    mountModal({ mode: 'unstaged', onApplyHunk, ...props })
    fireEvent.click(screen.getByTestId(`hunk-menu-button-${HUNK_ID}`))
  }

  it('reverse-applies exactly that hunk', async () => {
    openMenu()
    fireEvent.click(screen.getByTestId('hunk-menu-revert'))
    await waitFor(() => expect(onApplyHunk).toHaveBeenCalledTimes(1))
    const [hunk, reverse] = onApplyHunk.mock.calls[0]
    expect(reverse).toBe(true)
    expect(hunk.id).toBe(HUNK_ID)
    // A self-contained patch: the file preamble plus this hunk only.
    expect(hunk.patch).toContain('+++ b/src/a.ts')
    expect(hunk.patch).toContain('+added one')
  })

  it('offers an Undo once the revert lands', async () => {
    openMenu()
    fireEvent.click(screen.getByTestId('hunk-menu-revert'))
    expect(await screen.findByTestId('file-diff-undo')).toBeInTheDocument()
    expect(screen.getByTestId('file-diff-action-bar')).toHaveTextContent('Hunk reverted.')
  })

  it('re-applies the same patch FORWARD to undo', async () => {
    openMenu()
    fireEvent.click(screen.getByTestId('hunk-menu-revert'))
    fireEvent.click(await screen.findByTestId('file-diff-undo'))
    await waitFor(() => expect(onApplyHunk).toHaveBeenCalledTimes(2))
    expect(onApplyHunk.mock.calls[1][1]).toBe(false)
  })

  it('drops the Undo once it has been used', async () => {
    openMenu()
    fireEvent.click(screen.getByTestId('hunk-menu-revert'))
    fireEvent.click(await screen.findByTestId('file-diff-undo'))
    await waitFor(() => expect(screen.queryByTestId('file-diff-undo')).not.toBeInTheDocument())
  })

  it('lets the Undo offer expire rather than leaving it up forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      openMenu()
      fireEvent.click(screen.getByTestId('hunk-menu-revert'))
      await waitFor(() => expect(screen.getByTestId('file-diff-undo')).toBeInTheDocument())
      await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS + 100) })
      expect(screen.queryByTestId('file-diff-undo')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows why git refused rather than silently doing nothing', async () => {
    onApplyHunk.mockResolvedValue({ ok: false, error: 'error: patch does not apply' })
    openMenu()
    fireEvent.click(screen.getByTestId('hunk-menu-revert'))
    expect(await screen.findByTestId('file-diff-action-error'))
      .toHaveTextContent('error: patch does not apply')
  })

  it('names the failure even when the caller gives no reason', async () => {
    onApplyHunk.mockResolvedValue({ ok: false })
    openMenu()
    fireEvent.click(screen.getByTestId('hunk-menu-revert'))
    expect(await screen.findByTestId('file-diff-action-error'))
      .toHaveTextContent('Could not revert that hunk')
  })

  it('survives the apply throwing', async () => {
    onApplyHunk.mockRejectedValue(new Error('bridge died'))
    openMenu()
    fireEvent.click(screen.getByTestId('hunk-menu-revert'))
    expect(await screen.findByTestId('file-diff-action-error')).toHaveTextContent('bridge died')
  })

  it('names a thrown failure that carries no message', async () => {
    onApplyHunk.mockRejectedValue({})
    openMenu()
    fireEvent.click(screen.getByTestId('hunk-menu-revert'))
    expect(await screen.findByTestId('file-diff-action-error'))
      .toHaveTextContent('Could not apply that change')
  })

  it('refuses a STAGED hunk, whose patch is index-vs-HEAD', () => {
    // Reverse-applying it against the worktree would discard edits made since staging.
    openMenu({ mode: 'staged' })
    const revert = screen.getByTestId('hunk-menu-revert')
    expect(revert).toBeDisabled()
    expect(revert.getAttribute('title')).toContain('discard newer edits')
    fireEvent.click(revert)
    expect(onApplyHunk).not.toHaveBeenCalled()
  })

  it('refuses an UNTRACKED file, which git has no copy of', () => {
    // Reversing a diff synthesised against /dev/null DELETES the file, and nothing
    // in git can bring it back. This is the one action here that is truly final.
    openMenu({ mode: 'untracked' })
    const revert = screen.getByTestId('hunk-menu-revert')
    expect(revert).toBeDisabled()
    expect(revert.getAttribute('title')).toContain('no copy to restore')
    fireEvent.click(revert)
    expect(onApplyHunk).not.toHaveBeenCalled()
  })

  it('refuses a COMMITTED hunk, which history already owns', () => {
    // The Unpushed section opens real commits in this modal. Reverse-applying one of
    // their hunks would edit the worktree while leaving the commit in place, so the
    // repo would disagree with itself — `git revert` is the operation that exists for
    // this, and it is not one a hunk menu should perform behind someone's back.
    openMenu({ mode: 'commit' })
    const revert = screen.getByTestId('hunk-menu-revert')
    expect(revert).toBeDisabled()
    expect(revert.getAttribute('title')).toContain('git revert')
    fireEvent.click(revert)
    expect(onApplyHunk).not.toHaveBeenCalled()
  })

  it('is unavailable when the panel passed no apply function', () => {
    mountModal({ mode: 'unstaged', onApplyHunk: undefined })
    fireEvent.click(screen.getByTestId(`hunk-menu-button-${HUNK_ID}`))
    expect(screen.getByTestId('hunk-menu-revert')).toBeDisabled()
    expect(screen.getByTestId('hunk-menu-revert'))
      .toHaveAttribute('title', 'Reverting is unavailable here')
  })

  it('explains what Revert does when it IS available', () => {
    openMenu()
    expect(screen.getByTestId('hunk-menu-revert'))
      .toHaveAttribute('title', 'Reverse-applies just this hunk')
  })
})
