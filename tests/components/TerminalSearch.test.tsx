import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TerminalSearch, type TerminalSearchOptions } from '../../src/renderer/src/components/TerminalSearch/TerminalSearch'

const DEFAULTS: TerminalSearchOptions = { caseSensitive: false, wholeWord: false, regex: false }

function setup(overrides: Partial<React.ComponentProps<typeof TerminalSearch>> = {}) {
  const props = {
    onSearch: vi.fn(),
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    onClose: vi.fn(),
    resultIndex: -1,
    resultCount: 0,
    ...overrides,
  }
  const utils = render(<TerminalSearch {...props} />)
  const input = screen.getByTestId('terminal-search-input') as HTMLInputElement
  return { ...utils, ...props, input }
}

describe('TerminalSearch — in-terminal find bar', () => {
  beforeEach(() => vi.clearAllMocks())

  it('auto-focuses the input on mount so the user can type immediately', () => {
    const { input } = setup()
    expect(document.activeElement).toBe(input)
  })

  it('does not search on an empty query', () => {
    const { onSearch, onNext, onPrevious } = setup()
    fireEvent.keyDown(screen.getByTestId('terminal-search-input'), { key: 'Enter' })
    expect(onSearch).not.toHaveBeenCalled()
    expect(onNext).not.toHaveBeenCalled()
    expect(onPrevious).not.toHaveBeenCalled()
  })

  it('runs an incremental search with the term + default options as the user types', () => {
    const { input, onSearch } = setup()
    fireEvent.change(input, { target: { value: 'error' } })
    expect(onSearch).toHaveBeenLastCalledWith('error', DEFAULTS)
  })

  it('re-runs the search with updated options when a toggle is flipped', () => {
    const { input, onSearch } = setup()
    fireEvent.change(input, { target: { value: 'Error' } })
    fireEvent.click(screen.getByTestId('terminal-search-case'))
    expect(onSearch).toHaveBeenLastCalledWith('Error', { ...DEFAULTS, caseSensitive: true })
  })

  it('Enter advances to the next match; Shift+Enter goes to the previous', () => {
    const { input, onNext, onPrevious } = setup()
    fireEvent.change(input, { target: { value: 'foo' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNext).toHaveBeenLastCalledWith('foo', DEFAULTS)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onPrevious).toHaveBeenLastCalledWith('foo', DEFAULTS)
  })

  it('the ▲/▼ buttons go to the previous / next match with the current term + options', () => {
    const { input, onNext, onPrevious } = setup()
    fireEvent.change(input, { target: { value: 'bar' } })
    fireEvent.click(screen.getByTestId('terminal-search-regex'))
    fireEvent.click(screen.getByTestId('terminal-search-next'))
    expect(onNext).toHaveBeenLastCalledWith('bar', { ...DEFAULTS, regex: true })
    fireEvent.click(screen.getByTestId('terminal-search-prev'))
    expect(onPrevious).toHaveBeenLastCalledWith('bar', { ...DEFAULTS, regex: true })
  })

  it('Escape and the × button both close the bar', () => {
    const { input, onClose } = setup()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('terminal-search-close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('reflects each option toggle via aria-pressed', () => {
    setup()
    const caseBtn = screen.getByTestId('terminal-search-case')
    expect(caseBtn).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(caseBtn)
    expect(caseBtn).toHaveAttribute('aria-pressed', 'true')
    const wordBtn = screen.getByTestId('terminal-search-word')
    fireEvent.click(wordBtn)
    expect(wordBtn).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows the active match position and total count (1-based)', () => {
    setup({ resultIndex: 1, resultCount: 5 })
    // Count only renders once there is a query.
    fireEvent.change(screen.getByTestId('terminal-search-input'), { target: { value: 'x' } })
    expect(screen.getByTestId('terminal-search-count')).toHaveTextContent('2/5')
  })

  it('shows "No results" when a non-empty query matches nothing', () => {
    setup({ resultIndex: -1, resultCount: 0 })
    fireEvent.change(screen.getByTestId('terminal-search-input'), { target: { value: 'zzz' } })
    expect(screen.getByTestId('terminal-search-count')).toHaveTextContent('No results')
  })

  it('shows no count label before anything is typed', () => {
    setup({ resultIndex: 3, resultCount: 9 })
    expect(screen.getByTestId('terminal-search-count')).toHaveTextContent('')
  })
})
