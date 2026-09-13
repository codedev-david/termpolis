import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  FileDiffModal,
  buildLines,
  MAX_DIFF_CHARS,
  MAX_DIFF_LINES,
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
      { kind: 'meta', text: 'Binary file — no textual diff', oldNo: null, newNo: null },
    ])
  })

  it('says so for a pure rename, which is real but has no lines', () => {
    const lines = buildLines(parseUnifiedDiff(
      'diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n',
    ))
    expect(lines).toEqual([
      { kind: 'meta', text: 'No textual changes', oldNo: null, newNo: null },
    ])
  })

  it('keeps a "no newline at end of file" marker as meta, not as content', () => {
    const lines = buildLines(parseUnifiedDiff(
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n',
    ))
    expect(lines[lines.length - 1]).toEqual({
      kind: 'meta', text: '\\ No newline at end of file', oldNo: null, newNo: null,
    })
  })

  it('starts counting at 0 when the hunk header is unparseable', () => {
    const lines = buildLines([
      { file: 'a.ts', status: 'M', preamble: '', added: 0, removed: 0, binary: false,
        hunks: [{ id: 'h', file: 'a.ts', header: '@@ malformed @@', body: '@@ malformed @@\n ctx', patch: '', added: 0, removed: 0, startLine: 0 }] },
    ] as any)
    expect(lines[1]).toEqual({ kind: 'ctx', text: 'ctx', oldNo: 0, newNo: 0 })
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
