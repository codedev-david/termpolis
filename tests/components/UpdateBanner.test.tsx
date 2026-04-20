import React from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { UpdateBanner } from '../../src/renderer/src/components/UpdateBanner/UpdateBanner'

type UpdaterStatus =
  | { status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'; version?: string; error?: string }

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
})
