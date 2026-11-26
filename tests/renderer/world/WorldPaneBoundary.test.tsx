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

    const alert = await screen.findByTestId('world-pane-failed')
    expect(alert.parentElement).toHaveStyle({ width: '420px' })
    expect(alert).toHaveTextContent('Something stopped Lumopolis from loading. Your terminals are fine.')
    expect(alert).not.toHaveTextContent(error.message)
    const heading = within(alert).getByRole('heading', { name: "Lumopolis couldn't open" })
    expect(heading).toHaveFocus()
    // Read once (A11Y M2): the focused heading with its line as its description, and no alert that says it again.
    expect(heading).toHaveAccessibleDescription('Something stopped Lumopolis from loading. Your terminals are fine.')
    expect(screen.queryByRole('alert')).toBeNull()
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

    const alert = await screen.findByTestId('world-pane-failed')
    expect(load).toHaveBeenCalledOnce()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('World map')).toBeVisible()
    expect(screen.queryByTestId('world-pane-failed')).toBeNull()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('Try again gives the focus to the Close of the opening, never to nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockReturnValueOnce(new Promise(() => {}))
    render(
      <>
        <button>Terminal</button>
        <WorldPaneBoundary {...props} onClose={vi.fn()} load={load} />
      </>,
    )
    const failed = await screen.findByTestId('world-pane-failed')
    const again = within(failed).getByRole('button', { name: 'Try again' })
    again.focus()
    fireEvent.click(again)
    expect(await screen.findByText('Opening Lumopolis…')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('an opening after a failure the focus had left takes no focus', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = vi.fn().mockRejectedValueOnce(new Error('down')).mockReturnValue(new Promise(() => {}))
    const { rerender } = render(<><button>Terminal</button><WorldPaneBoundary {...props} onClose={vi.fn()} load={load} /></>)
    await screen.findByTestId('world-pane-failed')
    screen.getByRole('button', { name: 'Terminal' }).focus()
    rerender(<><button>Terminal</button><WorldPaneBoundary {...props} root="/next" onClose={vi.fn()} load={load} /></>)
    expect(await screen.findByText('Opening Lumopolis…')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Terminal' })).toHaveFocus()
  })

  it('tries again by itself when the request or the terminal changes while it shows the error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce({ default: () => <div>World map</div> })
    const { rerender } = render(<WorldPaneBoundary {...props} onClose={vi.fn()} load={load} />)
    await screen.findByTestId('world-pane-failed')
    rerender(<WorldPaneBoundary {...props} request={{ folder: '/other', seq: 1 }} onClose={vi.fn()} load={load} />)
    expect(await screen.findByText('World map')).toBeVisible()
    expect(screen.queryByTestId('world-pane-failed')).toBeNull()

    const broken = vi.fn().mockRejectedValue(new Error('down'))
    const second = render(<WorldPaneBoundary {...props} onClose={vi.fn()} load={broken} />)
    await screen.findAllByTestId('world-pane-failed')
    second.rerender(<WorldPaneBoundary {...props} root="/next" onClose={vi.fn()} load={broken} />)
    await act(async () => {})
    expect(broken).toHaveBeenCalledTimes(2)
    second.rerender(<WorldPaneBoundary {...props} root="/next" width={300} onClose={vi.fn()} load={broken} />)
    await act(async () => {})
    expect(broken).toHaveBeenCalledTimes(2)
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
