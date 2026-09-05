// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RemoteIndicator } from '../../src/renderer/src/components/TitleBar/RemoteIndicator'
import { consumePendingSettingsTab } from '../../src/renderer/src/lib/settingsNav'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import type { RemoteStatusView } from '../../src/renderer/src/types'

const ok = <T,>(data: T) => ({ success: true as const, data })

const device = (over: Record<string, unknown> = {}) => ({
  id: 'dev-1',
  label: 'Pixel',
  publicKey: 'b'.repeat(64),
  capabilities: { read: true, createTerminal: false, writeToTerminal: false, closeTerminal: false },
  pairedAt: 0,
  lastSeenAt: 0,
  attached: false,
  ...over,
})

const statusView = (devices: unknown[] = []): RemoteStatusView =>
  ({
    enabled: true,
    running: true,
    disabled: false,
    relayUrl: 'wss://relay.termpolis.com/ws',
    publicKey: 'a'.repeat(64),
    pairing: null,
    devices,
  }) as RemoteStatusView

let api: Record<string, ReturnType<typeof vi.fn>>
let pushStatus: (s: RemoteStatusView) => void
const off = vi.fn()

beforeEach(() => {
  off.mockClear()
  consumePendingSettingsTab()
  useTerminalStore.setState({ showSettings: false })
  api = {
    status: vi.fn().mockResolvedValue(ok(statusView())),
    onStatus: vi.fn((cb: (s: RemoteStatusView) => void) => {
      pushStatus = cb
      return off
    }),
  }
  ;(window as unknown as { remote: unknown }).remote = api
})

afterEach(() => cleanup())

describe('RemoteIndicator', () => {
  it('stays out of the way while nothing is attached', async () => {
    render(<RemoteIndicator />)
    await waitFor(() => expect(api.status).toHaveBeenCalled())
    expect(screen.queryByTestId('remote-indicator')).toBeNull()
  })

  it('counts a single attached phone', async () => {
    api.status.mockResolvedValue(ok(statusView([device({ attached: true }), device({ id: 'b' })])))
    render(<RemoteIndicator />)
    const badge = await screen.findByTestId('remote-indicator')
    expect(screen.getByTestId('remote-indicator-count').textContent).toBe('1')
    expect(badge.getAttribute('aria-label')).toBe('1 phone connected')
  })

  it('pluralises for more than one', async () => {
    api.status.mockResolvedValue(
      ok(statusView([device({ attached: true }), device({ id: 'b', attached: true })])),
    )
    render(<RemoteIndicator />)
    const badge = await screen.findByTestId('remote-indicator')
    expect(badge.getAttribute('aria-label')).toBe('2 phones connected')
  })

  it('opens Settings on the Remote tab', async () => {
    api.status.mockResolvedValue(ok(statusView([device({ attached: true })])))
    render(<RemoteIndicator />)
    fireEvent.click(await screen.findByTestId('remote-indicator'))
    expect(useTerminalStore.getState().showSettings).toBe(true)
    expect(consumePendingSettingsTab()).toBe('remote')
  })

  it('appears and disappears as phones come and go', async () => {
    render(<RemoteIndicator />)
    await waitFor(() => expect(api.onStatus).toHaveBeenCalled())
    act(() => pushStatus(statusView([device({ attached: true })])))
    expect(screen.getByTestId('remote-indicator')).toBeTruthy()
    act(() => pushStatus(statusView([device()])))
    expect(screen.queryByTestId('remote-indicator')).toBeNull()
  })

  it('unsubscribes on unmount', async () => {
    render(<RemoteIndicator />)
    await waitFor(() => expect(api.onStatus).toHaveBeenCalled())
    cleanup()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when this window has no remote bridge', () => {
    delete (window as unknown as { remote?: unknown }).remote
    render(<RemoteIndicator />)
    expect(screen.queryByTestId('remote-indicator')).toBeNull()
    expect(api.status).not.toHaveBeenCalled()
  })

  it('ignores a status the host could not answer', async () => {
    api.status.mockResolvedValue({ success: false, error: 'Remote access is not running' })
    render(<RemoteIndicator />)
    await waitFor(() => expect(api.status).toHaveBeenCalled())
    expect(screen.queryByTestId('remote-indicator')).toBeNull()
  })

  it('drops a status that lands after unmount', async () => {
    let settle: (v: unknown) => void = () => {}
    api.status.mockReturnValue(new Promise((r) => { settle = r }))
    render(<RemoteIndicator />)
    cleanup()
    await act(async () => {
      settle(ok(statusView([device({ attached: true })])))
      await Promise.resolve()
    })
    expect(screen.queryByTestId('remote-indicator')).toBeNull()
  })
})
