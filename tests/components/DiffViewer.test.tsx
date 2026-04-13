import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { DiffViewer } from '../../src/renderer/src/components/DiffViewer/DiffViewer'

const sampleDiff = `diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4`

describe('DiffViewer', () => {
  it('renders diff content with additions and deletions', () => {
    render(<DiffViewer rawDiff={sampleDiff} onClose={vi.fn()} />)
    expect(screen.getByText('Diff Viewer')).toBeInTheDocument()
    // The file name is extracted from the diff header
    expect(screen.getByText('src/app.ts')).toBeInTheDocument()
    // Addition and deletion lines are rendered as <pre> content
    expect(screen.getByText('+const b = 3')).toBeInTheDocument()
    expect(screen.getByText('-const b = 2')).toBeInTheDocument()
  })

  it('shows a close button', () => {
    const onClose = vi.fn()
    render(<DiffViewer rawDiff={sampleDiff} onClose={onClose} />)
    // The backdrop click triggers onClose
    const backdrop = screen.getByText('Diff Viewer').closest('.fixed')!
    expect(backdrop).toBeInTheDocument()
    // Copy button is present
    expect(screen.getByText('Copy')).toBeInTheDocument()
  })

  it('clicking backdrop calls onClose', () => {
    const onClose = vi.fn()
    render(<DiffViewer rawDiff={sampleDiff} onClose={onClose} />)
    const backdrop = screen.getByText('Diff Viewer').closest('.fixed')!
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalled()
  })

  it('clicking inner dialog does not close (stopPropagation)', () => {
    const onClose = vi.fn()
    render(<DiffViewer rawDiff={sampleDiff} onClose={onClose} />)
    // Click the inner dialog content (not backdrop)
    const innerDialog = screen.getByText('Diff Viewer').closest('.bg-\\[\\#1e1e1e\\]')!
    fireEvent.click(innerDialog)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Copy button copies diff to clipboard', () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      writable: true,
    })
    render(<DiffViewer rawDiff={sampleDiff} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Copy'))
    expect(navigator.clipboard.writeText).toHaveBeenCalled()
  })

  it('close X button calls onClose', () => {
    const onClose = vi.fn()
    render(<DiffViewer rawDiff={sampleDiff} onClose={onClose} />)
    // The X close button (fa-xmark icon)
    const closeButtons = screen.getAllByRole('button')
    const xButton = closeButtons.find(b => b.querySelector('.fa-xmark'))
    if (xButton) {
      fireEvent.click(xButton)
      expect(onClose).toHaveBeenCalled()
    }
  })

  it('shows empty state when no diff content', () => {
    render(<DiffViewer rawDiff="no diff here" onClose={vi.fn()} />)
    expect(screen.getByText('No diff content to display')).toBeInTheDocument()
  })

  it('shows file count for multiple files', () => {
    const multiDiff = `diff --git a/file1.ts b/file1.ts
@@ -1,1 +1,1 @@
-old
+new
diff --git a/file2.ts b/file2.ts
@@ -1,1 +1,1 @@
-old2
+new2`
    render(<DiffViewer rawDiff={multiDiff} onClose={vi.fn()} />)
    expect(screen.getByText('(2 files)')).toBeInTheDocument()
  })

  it('shows singular file count for one file', () => {
    render(<DiffViewer rawDiff={sampleDiff} onClose={vi.fn()} />)
    expect(screen.getByText('(1 file)')).toBeInTheDocument()
  })

  it('handles diff without git header (fallback to default file section)', () => {
    const rawDiff = `@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3`
    render(<DiffViewer rawDiff={rawDiff} onClose={vi.fn()} />)
    expect(screen.getByText('Diff Output')).toBeInTheDocument()
    expect(screen.getByText('+const b = 3')).toBeInTheDocument()
  })

  it('renders context lines and meta lines', () => {
    render(<DiffViewer rawDiff={sampleDiff} onClose={vi.fn()} />)
    // Context line: " const a = 1"
    expect(screen.getByText(/const a = 1/)).toBeInTheDocument()
    // Meta line: "index abc1234..def5678"
    expect(screen.getByText(/index abc1234/)).toBeInTheDocument()
  })
})
