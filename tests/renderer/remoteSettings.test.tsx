// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RemoteSettings } from '../../src/renderer/src/components/SettingsPane/RemoteSettings'
import type { RemoteEvent, RemoteStatusView } from '../../src/renderer/src/types'

const ok = <T,>(data: T) => ({ success: true as const, data })
const fail = (error: string) => ({ success: false as const, error })

const device = (over: Record<string, unknown> = {}) => ({
  id: 'dev-1',
  label: 'Pixel',
  publicKey: 'b'.repeat(64),
  capabilities: { read: true, createTerminal: false, writeToTerminal: false, closeTerminal: false },
  pairedAt: Date.now() - 86_400_000,
  lastSeenAt: Date.now() - 5_000,
  attached: false,
  ...over,
})

const statusView = (over: Record<string, unknown> = {}): RemoteStatusView =>
  ({
    enabled: false,
    running: false,
    disabled: false,
    relayUrl: 'wss://relay.termpolis.com/ws',
    publicKey: 'a'.repeat(64),
    pairing: null,
    devices: [],
    ...over,
  }) as RemoteStatusView

const offer = { qrPayload: JSON.stringify({ v: 2, pk: 'a'.repeat(64) }), expiresAt: Date.now() + 120_000 }

let api: Record<string, ReturnType<typeof vi.fn>>
let pushStatus: (s: RemoteStatusView) => void
let pushEvent: (e: RemoteEvent) => void
const offStatus = vi.fn()
const offEvent = vi.fn()

beforeEach(() => {
  offStatus.mockClear()
  offEvent.mockClear()
  api = {
    status: vi.fn().mockResolvedValue(ok(statusView())),
    setEnabled: vi.fn().mockResolvedValue(ok(statusView({ enabled: true, running: true }))),
    setRelayUrl: vi.fn().mockResolvedValue(ok(statusView())),
    beginPairing: vi.fn().mockResolvedValue(ok(statusView({ pairing: offer }))),
    cancelPairing: vi.fn().mockResolvedValue(ok(statusView())),
    revokeDevice: vi.fn().mockResolvedValue(ok(statusView())),
    setCapabilities: vi.fn().mockResolvedValue(ok(statusView({ devices: [device()] }))),
    verificationPhrase: vi.fn().mockResolvedValue(ok({ deviceId: 'dev-1', phrase: 'anchor basil cobra delta' })),
    onStatus: vi.fn((cb: (s: RemoteStatusView) => void) => {
      pushStatus = cb
      return offStatus
    }),
    onEvent: vi.fn((cb: (e: RemoteEvent) => void) => {
      pushEvent = cb
      return offEvent
    }),
  }
  ;(window as unknown as { remote: unknown }).remote = api
})

afterEach(() => cleanup())

/** Render and wait out the initial `remote:status` round trip. */
async function mount(): Promise<void> {
  render(<RemoteSettings />)
  await waitFor(() => expect(screen.getByTestId('remote-enable')).toBeTruthy())
}

describe('RemoteSettings', () => {
  it('says so when remote never started in this session', async () => {
    api.status.mockResolvedValue(fail('Remote access is not running in this session'))
    render(<RemoteSettings />)
    const note = await screen.findByTestId('remote-unavailable')
    expect(note.textContent).toContain('not running in this session')
  })

  it('renders the switch, the relay address, the key and the empty device note', async () => {
    await mount()
    expect((screen.getByTestId('remote-enable') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('remote-relay-url') as HTMLInputElement).value).toBe(
      'wss://relay.termpolis.com/ws',
    )
    expect(screen.getByTestId('remote-public-key').textContent).toBe('a'.repeat(64))
    expect(screen.getByTestId('remote-no-devices')).toBeTruthy()
    // Nothing to say about a connection while the feature is off.
    expect(screen.getByTestId('remote-running').textContent).toBe('')
  })

  it('turns remote on and adopts the status that comes back', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('remote-enable'))
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(true))
    await waitFor(() =>
      expect(screen.getByTestId('remote-running').textContent).toContain('connected to the relay'),
    )
  })

  it('turns remote off again', async () => {
    api.status.mockResolvedValue(ok(statusView({ enabled: true, running: false })))
    await mount()
    expect(screen.getByTestId('remote-running').textContent).toContain('not connected')
    api.setEnabled.mockResolvedValue(ok(statusView({ enabled: false })))
    fireEvent.click(screen.getByTestId('remote-enable'))
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(false))
  })

  it('saves a relay address and then follows the saved value again', async () => {
    api.status.mockResolvedValue(ok(statusView()))
    await mount()
    const field = screen.getByTestId('remote-relay-url') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'wss://relay.example/ws' } })
    expect(field.value).toBe('wss://relay.example/ws')
    api.setRelayUrl.mockResolvedValue(ok(statusView({ relayUrl: 'wss://relay.example/ws' })))
    fireEvent.click(screen.getByTestId('remote-relay-save'))
    await waitFor(() => expect(api.setRelayUrl).toHaveBeenCalledWith('wss://relay.example/ws'))
    await waitFor(() =>
      expect((screen.getByTestId('remote-relay-url') as HTMLInputElement).value).toBe(
        'wss://relay.example/ws',
      ),
    )
  })

  it('keeps the draft on screen when the address is refused', async () => {
    await mount()
    fireEvent.change(screen.getByTestId('remote-relay-url'), { target: { value: 'http://nope' } })
    api.setRelayUrl.mockResolvedValue(fail('Relay URL must be a ws:// or wss:// address'))
    fireEvent.click(screen.getByTestId('remote-relay-save'))
    const banner = await screen.findByTestId('remote-error')
    expect(banner.textContent).toContain('ws:// or wss://')
    // Reverting the field would hide what the user actually typed.
    expect((screen.getByTestId('remote-relay-url') as HTMLInputElement).value).toBe('http://nope')
  })
})

describe('RemoteSettings pairing', () => {
  it('opens the modal with the offer the bridge just minted', async () => {
    await mount()
    fireEvent.change(screen.getByTestId('remote-pair-label'), { target: { value: 'Work phone' } })
    fireEvent.click(screen.getByTestId('remote-pair-button'))
    await waitFor(() => expect(api.beginPairing).toHaveBeenCalledWith('Work phone'))
    expect(await screen.findByTestId('pairing-qr')).toBeTruthy()
  })

  it('shows the safety words once a phone completes the handshake', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('remote-pair-button'))
    await waitFor(() => expect(api.beginPairing).toHaveBeenCalled())
    act(() => pushEvent({ kind: 'paired', deviceId: 'dev-1', label: 'Pixel' }))
    const phrase = await screen.findByTestId('pairing-phrase')
    expect(phrase.textContent).toBe('anchor basil cobra delta')
    expect(api.verificationPhrase).toHaveBeenCalledWith('dev-1')
  })

  it('does not withdraw a code that has already been spent', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('remote-pair-button'))
    await waitFor(() => expect(api.beginPairing).toHaveBeenCalled())
    act(() => pushEvent({ kind: 'paired', deviceId: 'dev-1', label: 'Pixel' }))
    await screen.findByTestId('pairing-phrase')
    fireEvent.click(screen.getByTestId('pairing-dismiss'))
    await waitFor(() => expect(screen.queryByTestId('pairing-modal')).toBeNull())
    expect(api.cancelPairing).not.toHaveBeenCalled()
  })

  it('withdraws an offer nobody used', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('remote-pair-button'))
    await screen.findByTestId('pairing-qr')
    fireEvent.click(screen.getByTestId('pairing-dismiss'))
    await waitFor(() => expect(api.cancelPairing).toHaveBeenCalled())
  })

  it('leaves the modal shut when a paired event arrives with no name', async () => {
    api.verificationPhrase.mockResolvedValue(fail('That device is not paired with this desktop'))
    await mount()
    fireEvent.click(screen.getByTestId('remote-pair-button'))
    await screen.findByTestId('pairing-qr')
    act(() => pushEvent({ kind: 'paired', deviceId: 'dev-1' }))
    // The phrase lookup lost a race with a revoke: show the code, not a lie.
    await waitFor(() => expect(api.verificationPhrase).toHaveBeenCalledWith('dev-1'))
    expect(screen.queryByTestId('pairing-phrase')).toBeNull()
  })
})

describe('RemoteSettings devices', () => {
  it('sends all four flags when one is flipped', async () => {
    api.status.mockResolvedValue(ok(statusView({ devices: [device()] })))
    await mount()
    fireEvent.click(screen.getByTestId('remote-cap-dev-1-writeToTerminal'))
    await waitFor(() =>
      expect(api.setCapabilities).toHaveBeenCalledWith('dev-1', {
        read: true,
        createTerminal: false,
        writeToTerminal: true,
        closeTerminal: false,
      }),
    )
  })

  it('warns that typing bypasses the command checks', async () => {
    api.status.mockResolvedValue(ok(statusView({ devices: [device()] })))
    await mount()
    expect(screen.getByText(/bypasses the command checks/)).toBeTruthy()
  })

  it('takes two clicks to revoke', async () => {
    api.status.mockResolvedValue(ok(statusView({ devices: [device()] })))
    await mount()
    fireEvent.click(screen.getByTestId('remote-revoke-dev-1'))
    expect(api.revokeDevice).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('remote-revoke-confirm-dev-1'))
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith('dev-1'))
  })

  it('shows a device safety phrase on demand', async () => {
    api.status.mockResolvedValue(ok(statusView({ devices: [device()] })))
    await mount()
    fireEvent.click(screen.getByTestId('remote-show-phrase-dev-1'))
    const phrase = await screen.findByTestId('remote-phrase-dev-1')
    expect(phrase.textContent).toBe('anchor basil cobra delta')
  })

  it('surfaces a failed phrase lookup', async () => {
    api.status.mockResolvedValue(ok(statusView({ devices: [device()] })))
    api.verificationPhrase.mockResolvedValue(fail('That device is not paired with this desktop'))
    await mount()
    fireEvent.click(screen.getByTestId('remote-show-phrase-dev-1'))
    expect((await screen.findByTestId('remote-error')).textContent).toContain('not paired')
  })

  it('words how long ago each device was seen', async () => {
    const now = Date.now()
    api.status.mockResolvedValue(
      ok(
        statusView({
          devices: [
            device({ id: 'a', attached: true }),
            device({ id: 'b', lastSeenAt: 0 }),
            device({ id: 'c', lastSeenAt: now - 5_000 }),
            device({ id: 'd', lastSeenAt: now - 300_000 }),
            device({ id: 'e', lastSeenAt: now - 3 * 3_600_000 }),
            device({ id: 'f', lastSeenAt: now - 4 * 86_400_000 }),
          ],
        }),
      ),
    )
    await mount()
    expect(screen.getByTestId('remote-seen-a').textContent).toBe('connected')
    expect(screen.getByTestId('remote-seen-b').textContent).toBe('last seen never')
    expect(screen.getByTestId('remote-seen-c').textContent).toBe('last seen just now')
    expect(screen.getByTestId('remote-seen-d').textContent).toBe('last seen 5m ago')
    expect(screen.getByTestId('remote-seen-e').textContent).toBe('last seen 3h ago')
    expect(screen.getByTestId('remote-seen-f').textContent).toBe('last seen 4d ago')
  })
})

describe('RemoteSettings live updates', () => {
  it('explains the crash-loop stop', async () => {
    api.status.mockResolvedValue(ok(statusView({ enabled: true, disabled: true })))
    await mount()
    expect(screen.getByTestId('remote-disabled-banner').textContent).toContain(
      'stopped itself after repeated crashes',
    )
  })

  it('surfaces an error the bridge reported', async () => {
    await mount()
    act(() => pushEvent({ kind: 'error', message: 'relay refused the connection' }))
    expect(screen.getByTestId('remote-error').textContent).toContain('relay refused the connection')
  })

  it('ignores an error event with no message', async () => {
    await mount()
    act(() => pushEvent({ kind: 'error' }))
    expect(screen.queryByTestId('remote-error')).toBeNull()
  })

  it('redraws from a pushed status', async () => {
    await mount()
    act(() => pushStatus(statusView({ enabled: true, running: true, devices: [device()] })))
    expect((screen.getByTestId('remote-enable') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('remote-device-dev-1')).toBeTruthy()
    expect(screen.queryByTestId('remote-no-devices')).toBeNull()
  })

  it('unsubscribes on unmount', async () => {
    render(<RemoteSettings />)
    await waitFor(() => expect(screen.getByTestId('remote-enable')).toBeTruthy())
    cleanup()
    expect(offStatus).toHaveBeenCalledTimes(1)
    expect(offEvent).toHaveBeenCalledTimes(1)
  })

  it('drops a status that lands after unmount', async () => {
    let settle: (v: unknown) => void = () => {}
    api.status.mockReturnValue(new Promise((r) => { settle = r }))
    render(<RemoteSettings />)
    cleanup()
    await act(async () => {
      settle(ok(statusView({ enabled: true })))
      await Promise.resolve()
    })
    // Nothing to assert on screen -- the point is that React logs no update
    // on an unmounted component, which the `live` flag is there to prevent.
    expect(offStatus).toHaveBeenCalledTimes(1)
  })
})

describe('RemoteSettings clock and defaults', () => {
  it('re-saves the address already on screen when nothing was typed', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('remote-relay-save'))
    // Not the empty string: an untouched field still shows a real address, and
    // sending "" would ask the host to clear the relay the user is using.
    await waitFor(() =>
      expect(api.setRelayUrl).toHaveBeenCalledWith('wss://relay.termpolis.com/ws'),
    )
  })

  it('refreshes the last-seen column once a minute', async () => {
    vi.useFakeTimers()
    try {
      const base = Date.now()
      api.status.mockResolvedValue(
        ok(statusView({ devices: [device({ id: 'a', lastSeenAt: base - 5_000 })] })),
      )
      render(<RemoteSettings />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByTestId('remote-seen-a').textContent).toBe('last seen just now')
      act(() => {
        vi.advanceTimersByTime(120_000)
      })
      expect(screen.getByTestId('remote-seen-a').textContent).toBe('last seen 2m ago')
    } finally {
      vi.useRealTimers()
    }
  })
})
