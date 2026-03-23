import React from 'react'
import { render, screen } from '@testing-library/react'
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
})
