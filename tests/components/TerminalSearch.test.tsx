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

describe('TerminalSearch — event isolation from the terminal underneath', () => {
  const props = (): React.ComponentProps<typeof TerminalSearch> => ({
    onSearch: vi.fn(),
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    onClose: vi.fn(),
    resultIndex: -1,
    resultCount: 0,
  })

  it('swallows mousedown/contextmenu raised inside the bar so the terminal never sees them', () => {
    // The find bar floats ON TOP of the terminal pane, whose own mousedown handler
    // refocuses xterm and whose contextmenu handler opens the terminal menu. Either
    // one firing would steal focus out of the search box mid-typing.
    const paneMouseDown = vi.fn()
    const paneContextMenu = vi.fn()
    render(
      <div data-testid="pane" onMouseDown={paneMouseDown} onContextMenu={paneContextMenu}>
        <span data-testid="pane-body">terminal body</span>
        <TerminalSearch {...props()} />
      </div>
    )

    // Control: the pane really is listening — events raised outside the bar reach it.
    fireEvent.mouseDown(screen.getByTestId('pane-body'))
    fireEvent.contextMenu(screen.getByTestId('pane-body'))
    expect(paneMouseDown).toHaveBeenCalledTimes(1)
    expect(paneContextMenu).toHaveBeenCalledTimes(1)

    // ...but the identical events inside the bar (chrome and input alike) are stopped.
    fireEvent.mouseDown(screen.getByTestId('terminal-search'))
    fireEvent.contextMenu(screen.getByTestId('terminal-search'))
    fireEvent.mouseDown(screen.getByTestId('terminal-search-input'))
    fireEvent.contextMenu(screen.getByTestId('terminal-search-input'))
    expect(paneMouseDown).toHaveBeenCalledTimes(1)
    expect(paneContextMenu).toHaveBeenCalledTimes(1)
  })
})

describe('TerminalSearch — empty-query and unhandled-key no-ops', () => {
  const props = (): React.ComponentProps<typeof TerminalSearch> => ({
    onSearch: vi.fn(),
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    onClose: vi.fn(),
    resultIndex: -1,
    resultCount: 0,
  })

  it('the ▲ button and Shift+Enter are no-ops while the query is empty', () => {
    const p = props()
    render(<TerminalSearch {...p} />)
    fireEvent.click(screen.getByTestId('terminal-search-prev'))
    fireEvent.keyDown(screen.getByTestId('terminal-search-input'), { key: 'Enter', shiftKey: true })
    expect(p.onPrevious).not.toHaveBeenCalled()
    expect(p.onNext).not.toHaveBeenCalled()
    expect(p.onSearch).not.toHaveBeenCalled()
  })

  it('clearing the query back to empty stops re-running the search', () => {
    // Searching for '' would make SearchAddon re-highlight everything, so the
    // effect has to bail on an empty term rather than forward it.
    const p = props()
    render(<TerminalSearch {...p} />)
    const input = screen.getByTestId('terminal-search-input')
    fireEvent.change(input, { target: { value: 'abc' } })
    expect(p.onSearch).toHaveBeenCalledTimes(1)
    fireEvent.change(input, { target: { value: '' } })
    expect(p.onSearch).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('terminal-search-count')).toHaveTextContent('')
  })

  it('toggling an option with an empty query does not fire a search either', () => {
    const p = props()
    render(<TerminalSearch {...p} />)
    fireEvent.click(screen.getByTestId('terminal-search-word'))
    expect(screen.getByTestId('terminal-search-word')).toHaveAttribute('aria-pressed', 'true')
    expect(p.onSearch).not.toHaveBeenCalled()
  })

  it('leaves keys other than Enter/Escape to the input instead of swallowing them', () => {
    const p = props()
    render(<TerminalSearch {...p} />)
    const input = screen.getByTestId('terminal-search-input')
    fireEvent.change(input, { target: { value: 'foo' } })

    // fireEvent returns false when a handler called preventDefault — ordinary typing
    // must stay un-prevented or the user could not type into the box at all.
    expect(fireEvent.keyDown(input, { key: 'a' })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'ArrowLeft' })).toBe(true)
    expect(p.onNext).not.toHaveBeenCalled()
    expect(p.onPrevious).not.toHaveBeenCalled()
    expect(p.onClose).not.toHaveBeenCalled()

    // ...while Enter and Escape are claimed by the bar.
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false)
    expect(p.onNext).toHaveBeenCalledTimes(1)
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })
})
