// The one short line about a `lumopolis` request that did not simply open the pane: main's refusal, or a request
// from a terminal that is not the active one (with an Open button). It hides itself, and a new notice replaces it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { LumopolisNotice, NOTICE_MS } from '../../../src/renderer/src/components/World/LumopolisNotice'
import { LUMOPOLIS_NOTICE_EVENT, OPEN_WORLD_EVENT, showLumopolisNotice } from '../../../src/renderer/src/components/World/worldOpen'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('LumopolisNotice', () => {
  it('shows nothing until a notice comes, then its line, and hides it after a while', () => {
    render(<LumopolisNotice />)
    expect(screen.queryByTestId('lumopolis-notice')).toBeNull()
    act(() => showLumopolisNotice({ message: 'lumopolis: no such folder: x' }))
    const n = screen.getByTestId('lumopolis-notice')
    expect(n).toHaveTextContent('lumopolis: no such folder: x')
    expect(n).toHaveAttribute('role', 'status')
    expect(screen.queryByTestId('lumopolis-notice-open')).toBeNull() // nothing to open: it only tells
    act(() => { vi.advanceTimersByTime(NOTICE_MS - 1) })
    expect(screen.getByTestId('lumopolis-notice')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByTestId('lumopolis-notice')).toBeNull()
  })

  it('offers Open for a folder, which opens Lumopolis on it and hides the notice', () => {
    render(<LumopolisNotice />)
    act(() => showLumopolisNotice({ message: 'Another terminal asked to map app in Lumopolis.', folder: '/repo/app' }))
    const onOpen = vi.fn()
    window.addEventListener(OPEN_WORLD_EVENT, onOpen)
    fireEvent.click(screen.getByTestId('lumopolis-notice-open'))
    window.removeEventListener(OPEN_WORLD_EVENT, onOpen)
    expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toEqual({ folder: '/repo/app' })
    expect(screen.queryByTestId('lumopolis-notice')).toBeNull()
  })

  it('can be dismissed, and a new notice replaces the old one with a fresh timer', () => {
    render(<LumopolisNotice />)
    act(() => showLumopolisNotice({ message: 'first' }))
    act(() => { vi.advanceTimersByTime(NOTICE_MS - 10) })
    act(() => showLumopolisNotice({ message: 'second' }))
    act(() => { vi.advanceTimersByTime(20) })
    expect(screen.getByTestId('lumopolis-notice')).toHaveTextContent('second')
    fireEvent.click(screen.getByTestId('lumopolis-notice-dismiss'))
    expect(screen.queryByTestId('lumopolis-notice')).toBeNull()
  })

  it('ignores an event without a message, and stops listening when unmounted', () => {
    const { unmount } = render(<LumopolisNotice />)
    act(() => { window.dispatchEvent(new CustomEvent(LUMOPOLIS_NOTICE_EVENT, { detail: { message: '' } })) })
    act(() => { window.dispatchEvent(new CustomEvent(LUMOPOLIS_NOTICE_EVENT)) })
    expect(screen.queryByTestId('lumopolis-notice')).toBeNull()
    const remove = vi.spyOn(window, 'removeEventListener')
    unmount()
    expect(remove).toHaveBeenCalledWith(LUMOPOLIS_NOTICE_EVENT, expect.any(Function))
    remove.mockRestore()
  })
})
