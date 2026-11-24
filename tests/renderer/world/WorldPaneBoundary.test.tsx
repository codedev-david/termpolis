import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorldPaneBoundary } from '../../../src/renderer/src/components/World/WorldPaneBoundary'

const props = { root: '', width: 420, overlay: null }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorldPaneBoundary', () => {
  it('contains a render error, focuses its heading, and leaves its sibling usable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('private render error')
    const BrokenView = (): never => { throw error }
    const onClose = vi.fn()
    const onTerminalClick = vi.fn()
    render(
      <>
        <button onClick={onTerminalClick}>Terminal</button>
        <WorldPaneBoundary {...props} onClose={onClose} load={async () => ({ default: BrokenView })} />
      </>,
    )

    const alert = await screen.findByRole('alert')
    expect(alert.parentElement).toHaveStyle({ width: '420px' })
    expect(alert).toHaveTextContent('Something stopped Lumopolis from loading. Your terminals are fine.')
    expect(alert).not.toHaveTextContent(error.message)
    expect(within(alert).getByRole('heading', { name: "Lumopolis couldn't open" })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    expect(onTerminalClick).toHaveBeenCalledOnce()
    fireEvent.click(within(alert).getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls the loader again after rejection and renders the view when it succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce({ default: () => <div>World map</div> })
    render(<WorldPaneBoundary {...props} onClose={vi.fn()} load={load} />)

    const alert = await screen.findByRole('alert')
    expect(load).toHaveBeenCalledOnce()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('World map')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('calls close while the view is still loading', async () => {
    const onClose = vi.fn()
    await act(async () => {
      render(<WorldPaneBoundary {...props} overlay={{ left: 240 }} onClose={onClose} load={() => new Promise(() => {})} />)
    })
    expect(screen.getByRole('status')).toHaveTextContent('Opening Lumopolis…')
    expect(screen.getByTestId('world-view-opening')).toHaveStyle({ position: 'absolute', left: '240px' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
