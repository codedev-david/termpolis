import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'

beforeAll(() => {
  ;(window as any).termpolis = {
    writeToTerminal: vi.fn(),
  }
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: (selector?: any) => {
    const state = {
      activeTerminalId: 'test-id',
      promptTemplates: [],
      addPromptTemplate: vi.fn(),
      removePromptTemplate: vi.fn(),
    }
    return selector ? selector(state) : state
  },
}))

import { PromptTemplates } from '../../src/renderer/src/components/PromptTemplates/PromptTemplates'

describe('PromptTemplates', () => {
  it('renders overlay with Prompt Templates heading', () => {
    render(<PromptTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Prompt Templates')).toBeInTheDocument()
  })

  it('shows default templates', () => {
    render(<PromptTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Fix Tests')).toBeInTheDocument()
    expect(screen.getByText('Code Review')).toBeInTheDocument()
    expect(screen.getByText('Explain Code')).toBeInTheDocument()
    expect(screen.getByText('Refactor')).toBeInTheDocument()
    expect(screen.getByText('Write Tests')).toBeInTheDocument()
    expect(screen.getByText('Add Docs')).toBeInTheDocument()
  })
})
