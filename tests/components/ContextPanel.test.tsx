import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'

beforeAll(() => {
  ;(window as any).termpolis = {
    completionPathEntries: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getGitInfo: vi.fn().mockResolvedValue({ success: true, data: { status: '', recentCommits: '' } }),
  }
})

vi.mock('../../src/renderer/src/lib/pollingService', () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))

import { ContextPanel } from '../../src/renderer/src/components/ContextPanel/ContextPanel'

describe('ContextPanel', () => {
  it('renders the side panel with Context header', () => {
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    expect(screen.getByText('Context')).toBeInTheDocument()
  })

  it('shows File Tree and Git Status sections', () => {
    render(<ContextPanel cwd="/home/user/project" onClose={vi.fn()} />)
    expect(screen.getByText('File Tree')).toBeInTheDocument()
    expect(screen.getByText('Git Status')).toBeInTheDocument()
    expect(screen.getByText('Recent Commits')).toBeInTheDocument()
  })
})
