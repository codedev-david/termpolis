import React from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { UpdateBanner } from '../../src/renderer/src/components/UpdateBanner/UpdateBanner'

type UpdaterStatus = {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  error?: string
  reason?: 'read-only-location' | 'disk-full'
}

const READ_ONLY_HINT = "Termpolis is running from a read-only disk, so it can't update itself."
const DISK_FULL_HINT = 'Not enough free disk space to download the update.'

let listeners: Array<(s: UpdaterStatus) => void>
let getStatusMock: ReturnType<typeof vi.fn>
let quitAndInstallMock: ReturnType<typeof vi.fn>

function installUpdaterBridge(initial: UpdaterStatus = { status: 'idle' }) {
  listeners = []
  getStatusMock = vi.fn().mockResolvedValue(initial)
  quitAndInstallMock = vi.fn().mockResolvedValue(undefined)
  ;(window as any).updater = {
    getStatus: getStatusMock,
    quitAndInstall: quitAndInstallMock,
    onState: (cb: (s: UpdaterStatus) => void) => {
      listeners.push(cb)
      return () => {
        listeners = listeners.filter(l => l !== cb)
      }
    },
  }
}

function emit(next: UpdaterStatus) {
  for (const l of listeners) l(next)
}

beforeEach(() => {
  installUpdaterBridge()
})

afterEach(() => {
  delete (window as any).updater
})

describe('UpdateBanner', () => {
  it('renders nothing when status is idle', async () => {
    const { container } = render(<UpdateBanner />)
    await waitFor(() => expect(getStatusMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for non-terminal states (downloading)', async () => {
    installUpdaterBridge({ status: 'downloading' })
    const { container } = render(<UpdateBanner />)
    await waitFor(() => expect(getStatusMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('renders the banner when update is downloaded and ready', async () => {
    installUpdaterBridge({ status: 'downloaded', version: '1.12.0' })
    render(<UpdateBanner />)
    await screen.findByText(/ready — restart to install/i)
    expect(screen.getByText(/v1\.12\.0/)).toBeInTheDocument()
  })

  it('shows Restart now button when downloaded', async () => {
    installUpdaterBridge({ status: 'downloaded', version: '1.12.0' })
    render(<UpdateBanner />)
    await screen.findByRole('button', { name: 'Restart now' })
  })

  it('calls quitAndInstall when Restart now is clicked', async () => {
    installUpdaterBridge({ status: 'downloaded', version: '1.12.0' })
    render(<UpdateBanner />)
    const btn = await screen.findByRole('button', { name: 'Restart now' })
    fireEvent.click(btn)
    await waitFor(() => expect(quitAndInstallMock).toHaveBeenCalledTimes(1))
  })

  it('hides when the dismiss button is clicked', async () => {
    installUpdaterBridge({ status: 'downloaded', version: '1.12.0' })
    const { container } = render(<UpdateBanner />)
    const dismiss = await screen.findByLabelText('Dismiss update banner')
    fireEvent.click(dismiss)
    expect(container.firstChild).toBeNull()
  })

  it('reappears on a new downloaded event even after dismissing', async () => {
    installUpdaterBridge({ status: 'downloaded', version: '1.12.0' })
    render(<UpdateBanner />)
    await screen.findByText(/ready — restart to install/i)

    fireEvent.click(screen.getByLabelText('Dismiss update banner'))
    expect(screen.queryByText(/ready — restart to install/i)).not.toBeInTheDocument()

    act(() => {
      emit({ status: 'downloaded', version: '1.13.0' })
    })
    await screen.findByText(/v1\.13\.0/)
  })

  it('updates the banner when a state event arrives after mount', async () => {
    installUpdaterBridge({ status: 'idle' })
    const { container } = render(<UpdateBanner />)
    await waitFor(() => expect(getStatusMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()

    act(() => {
      emit({ status: 'downloaded', version: '2.0.0' })
    })
    await screen.findByText(/v2\.0\.0/)
  })

  it('renders without a version string when version is missing', async () => {
    installUpdaterBridge({ status: 'downloaded' })
    render(<UpdateBanner />)
    const msg = await screen.findByText(/Termpolis.*is ready/i)
    expect(msg.textContent).not.toMatch(/v\d/)
  })

  it('does nothing on mount when window.updater bridge is absent', () => {
    delete (window as any).updater
    const { container } = render(<UpdateBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('no-ops Restart now when the bridge disappears before the click', async () => {
    installUpdaterBridge({ status: 'downloaded', version: '1.12.0' })
    render(<UpdateBanner />)
    const btn = await screen.findByRole('button', { name: 'Restart now' })
    delete (window as any).updater
    fireEvent.click(btn)
    expect(quitAndInstallMock).not.toHaveBeenCalled()
  })

  it('unsubscribes the state listener on unmount', async () => {
    installUpdaterBridge({ status: 'idle' })
    const { unmount } = render(<UpdateBanner />)
    await waitFor(() => expect(listeners.length).toBe(1))
    unmount()
    expect(listeners.length).toBe(0)
  })

  it('keeps a dismissed banner hidden when the same version is announced again', async () => {
    installUpdaterBridge({ status: 'downloaded', version: '1.12.0' })
    const { container } = render(<UpdateBanner />)
    fireEvent.click(await screen.findByLabelText('Dismiss update banner'))

    // A later check — or one that failed — ends with the same download announced again.
    act(() => {
      emit({ status: 'checking' })
      emit({ status: 'downloaded', version: '1.12.0' })
    })
    expect(container.firstChild).toBeNull()
  })

  it('keeps a dismissed version-less banner hidden when it is announced again', async () => {
    installUpdaterBridge({ status: 'downloaded' })
    const { container } = render(<UpdateBanner />)
    fireEvent.click(await screen.findByLabelText('Dismiss update banner'))
    act(() => {
      emit({ status: 'downloaded' })
    })
    expect(container.firstChild).toBeNull()
  })

  it('shows the read-only location hint, with an info icon and no Restart button', async () => {
    installUpdaterBridge({ status: 'error', error: READ_ONLY_HINT, reason: 'read-only-location' })
    render(<UpdateBanner />)
    const hint = await screen.findByRole('status')
    expect(hint).toHaveTextContent(READ_ONLY_HINT)
    expect(hint.querySelector('i.fa-circle-info')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Restart now' })).not.toBeInTheDocument()
  })

  it('shows the disk-full hint with a disk icon', async () => {
    installUpdaterBridge({ status: 'error', error: DISK_FULL_HINT, reason: 'disk-full' })
    render(<UpdateBanner />)
    const hint = await screen.findByRole('status')
    expect(hint).toHaveTextContent(DISK_FULL_HINT)
    expect(hint.querySelector('i.fa-hard-drive')).not.toBeNull()
  })

  it('replaces a ready banner with the disk-full hint when unpacking the update fails', async () => {
    installUpdaterBridge({ status: 'downloaded', version: '1.12.0' })
    render(<UpdateBanner />)
    await screen.findByRole('button', { name: 'Restart now' })
    act(() => {
      emit({ status: 'error', error: DISK_FULL_HINT, reason: 'disk-full' })
    })
    expect(await screen.findByRole('status')).toHaveTextContent(DISK_FULL_HINT)
    expect(screen.queryByRole('button', { name: 'Restart now' })).not.toBeInTheDocument()
  })

  // A hint is news of the attempt that hit it: whatever main says next replaces it.
  it.each<[string, UpdaterStatus]>([
    ['a later check starts', { status: 'checking' }],
    ['a check finds the update', { status: 'available', version: '1.13.0' }],
    ['the download resumes', { status: 'downloading', version: '1.13.0' }],
    ['a check finds nothing newer', { status: 'not-available', version: '1.12.0' }],
    ['a check gets no answer, with nothing settled before it', { status: 'idle' }],
  ])('takes a hint down as soon as %s', async (_when, next) => {
    installUpdaterBridge({ status: 'error', error: DISK_FULL_HINT, reason: 'disk-full' })
    const { container } = render(<UpdateBanner />)
    expect(await screen.findByRole('status')).toHaveTextContent(DISK_FULL_HINT)
    act(() => {
      emit(next)
    })
    expect(container.firstChild).toBeNull()
  })

  it('swaps a hint for the ready banner once the update arrives after all', async () => {
    installUpdaterBridge({ status: 'error', error: DISK_FULL_HINT, reason: 'disk-full' })
    render(<UpdateBanner />)
    await screen.findByRole('status')
    act(() => {
      emit({ status: 'downloaded', version: '1.13.0' })
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Restart now' })).toBeInTheDocument()
    expect(screen.getByText(/v1\.13\.0/)).toBeInTheDocument()
  })

  it('shows a hint again, undismissed, when the next attempt runs into the same thing', async () => {
    installUpdaterBridge({ status: 'error', error: DISK_FULL_HINT, reason: 'disk-full' })
    const { container } = render(<UpdateBanner />)
    await screen.findByRole('status')
    act(() => {
      emit({ status: 'checking' })
    })
    expect(container.firstChild).toBeNull()
    act(() => {
      emit({ status: 'error', error: DISK_FULL_HINT, reason: 'disk-full' })
    })
    expect(await screen.findByRole('status')).toHaveTextContent(DISK_FULL_HINT)
  })

  it('keeps nothing of its own across a reload or restart: it shows what main says now', async () => {
    installUpdaterBridge({ status: 'error', error: DISK_FULL_HINT, reason: 'disk-full' })
    const first = render(<UpdateBanner />)
    await screen.findByRole('status')
    first.unmount()

    // In between, main went back to rest: a later check, or a fresh launch.
    getStatusMock.mockResolvedValueOnce({ status: 'idle' })
    const second = render(<UpdateBanner />)
    await waitFor(() => expect(getStatusMock).toHaveBeenCalledTimes(2))
    expect(second.container.firstChild).toBeNull()
  })

  it('keeps a dismissed hint hidden when announced again, but not a different one', async () => {
    installUpdaterBridge({ status: 'error', error: DISK_FULL_HINT, reason: 'disk-full' })
    const { container } = render(<UpdateBanner />)
    fireEvent.click(await screen.findByLabelText('Dismiss update hint'))
    expect(container.firstChild).toBeNull()

    act(() => {
      emit({ status: 'checking' })
      emit({ status: 'error', error: DISK_FULL_HINT, reason: 'disk-full' })
    })
    expect(container.firstChild).toBeNull()

    act(() => {
      emit({ status: 'error', error: READ_ONLY_HINT, reason: 'read-only-location' })
    })
    expect(await screen.findByRole('status')).toHaveTextContent(READ_ONLY_HINT)
  })

  it('never shows an error that is not a hint', async () => {
    installUpdaterBridge({ status: 'error', error: 'Cannot download "https://example.invalid": 404 Not Found' })
    const { container } = render(<UpdateBanner />)
    await waitFor(() => expect(getStatusMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('shows nothing for a hint without its message', async () => {
    installUpdaterBridge({ status: 'error', reason: 'disk-full' })
    const { container } = render(<UpdateBanner />)
    await waitFor(() => expect(getStatusMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('stays idle when the initial status comes back empty or fails', async () => {
    installUpdaterBridge()
    getStatusMock.mockResolvedValueOnce(undefined)
    const first = render(<UpdateBanner />)
    await waitFor(() => expect(getStatusMock).toHaveBeenCalledTimes(1))
    expect(first.container.firstChild).toBeNull()
    first.unmount()

    getStatusMock.mockRejectedValueOnce(new Error('ipc gone'))
    const second = render(<UpdateBanner />)
    await waitFor(() => expect(getStatusMock).toHaveBeenCalledTimes(2))
    expect(second.container.firstChild).toBeNull()
  })

  it('unmounts cleanly when the bridge hands back no unsubscribe', async () => {
    installUpdaterBridge()
    ;(window as any).updater.onState = () => undefined
    const { unmount } = render(<UpdateBanner />)
    await waitFor(() => expect(getStatusMock).toHaveBeenCalled())
    expect(() => unmount()).not.toThrow()
  })
})
