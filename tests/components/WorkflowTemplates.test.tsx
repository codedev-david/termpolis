import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'

beforeAll(() => {
  ;(window as any).termpolis = {
    killTerminal: vi.fn().mockResolvedValue({ success: true }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
  }
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        terminals: [],
        viewMode: 'tabs',
        removeTerminal: vi.fn(),
        addTerminal: vi.fn(),
        setPaneTree: vi.fn(),
        setActiveTerminal: vi.fn(),
        toggleViewMode: vi.fn(),
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({ viewMode: 'tabs' })),
      setState: vi.fn(),
    },
  ),
}))

vi.mock('../../src/renderer/src/lib/homedir', () => ({
  getHomedir: vi.fn().mockResolvedValue('/home/test'),
}))

import { WorkflowTemplates } from '../../src/renderer/src/components/WorkflowTemplates/WorkflowTemplates'

describe('WorkflowTemplates', () => {
  it('renders workflow template list with heading', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Workflow Templates')).toBeInTheDocument()
  })

  it('shows template names and descriptions', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Claude Code + Shell')).toBeInTheDocument()
    expect(screen.getByText('Claude Code on the left, shell on the right')).toBeInTheDocument()
    expect(screen.getByText('Full Stack Dev')).toBeInTheDocument()
    expect(screen.getByText('AI agent + frontend + backend + tests')).toBeInTheDocument()
    expect(screen.getByText('Code Review')).toBeInTheDocument()
    expect(screen.getByText('AI reviewer + git log + diff viewer')).toBeInTheDocument()
  })
})
