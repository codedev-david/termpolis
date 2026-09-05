import { useEffect, useState } from 'react'
import type {
  RemoteCapabilities,
  RemoteDeviceView,
  RemoteEvent,
  RemoteStatusView,
} from '../../types'
import { PairingModal, type PairedResult } from './PairingModal'

interface CapabilityRow {
  key: keyof RemoteCapabilities
  label: string
  hint: string
  /** Rendered in amber with a warning. Reserved for the one capability that
   *  hands a phone a raw keyboard. */
  danger?: boolean
}

/** Ordered least to most powerful, so the switch a user grants without thinking
 *  is the harmless one and the dangerous one is the last thing they read. */
const CAPABILITIES: CapabilityRow[] = [
  { key: 'read', label: 'Read terminal output', hint: 'See what is on screen and the scrollback behind it.' },
  { key: 'createTerminal', label: 'Start terminals', hint: 'Open a new shell or AI terminal on this desktop.' },
  {
    key: 'writeToTerminal',
    label: 'Type into terminals',
    hint: 'Sends keystrokes straight to a running shell. This bypasses the command checks the AI terminals run behind, so anything the phone types runs as you.',
    danger: true,
  },
  { key: 'closeTerminal', label: 'Close terminals', hint: 'End a running terminal.' },
]

function relativeTime(ts: number, now: number): string {
  if (!ts) return 'never'
  const secs = Math.max(0, Math.round((now - ts) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

type StatusResult = { success: true; data: RemoteStatusView } | { success: false; error: string }

/**
 * The Remote pane: the on/off switch, the relay address, pairing, and one row
 * per paired phone.
 *
 * Everything shown here comes from `remote:status`, which the main process
 * rebuilds field by field -- so nothing in this component can render a room id
 * or a secret key, because it is never handed one.
 */
export function RemoteSettings(): JSX.Element {
  const [status, setStatus] = useState<RemoteStatusView | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // null means "follow the saved value"; a string means the user is mid-edit.
  const [relayDraft, setRelayDraft] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [paired, setPaired] = useState<PairedResult | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)
  const [phrases, setPhrases] = useState<Record<string, string>>({})
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let live = true
    void window.remote.status().then((res) => {
      if (!live) return
      if (res.success) setStatus(res.data)
      else setUnavailable(res.error)
    })
    const offStatus = window.remote.onStatus((next) => {
      setStatus(next)
      setUnavailable(null)
    })
    const offEvent = window.remote.onEvent((event: RemoteEvent) => {
      if (event.kind === 'error' && event.message) setError(event.message)
      if (event.kind === 'paired' && event.deviceId) {
        const deviceId = event.deviceId
        const name = event.label ?? 'This phone'
        void window.remote.verificationPhrase(deviceId).then((res) => {
          // Cannot fail for a device that just paired -- the phrase is a pure
          // function of two public keys -- but a race with a revoke could, and a
          // modal claiming success with no words to compare is worse than none.
          if (res.success) setPaired({ label: name, phrase: res.data.phrase })
        })
      }
    })
    // Only drives the "last seen" column. One tick a minute, because the
    // rounding above cannot show anything finer than that anyway.
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      live = false
      offStatus()
      offEvent()
      clearInterval(tick)
    }
  }, [])

  const apply = (res: StatusResult): void => {
    if (res.success) {
      setStatus(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
  }

  const toggleEnabled = async (enabled: boolean): Promise<void> => {
    apply(await window.remote.setEnabled(enabled))
  }

  // The address is passed in rather than read from state: the button only
  // exists once `status` is loaded, so the caller can resolve "what the field
  // currently shows" without a fallback that stands for nothing.
  const saveRelay = async (value: string): Promise<void> => {
    const res = await window.remote.setRelayUrl(value)
    if (res.success) setRelayDraft(null)
    apply(res)
  }

  const startPairing = async (): Promise<void> => {
    setPaired(null)
    setModalOpen(true)
    apply(await window.remote.beginPairing(label))
  }

  const closeModal = async (): Promise<void> => {
    setModalOpen(false)
    // Only if the offer went unused: cancelling after a successful pair would
    // ask the bridge to withdraw a code it has already spent.
    if (!paired) apply(await window.remote.cancelPairing())
    setPaired(null)
  }

  const toggleCapability = async (device: RemoteDeviceView, key: keyof RemoteCapabilities): Promise<void> => {
    // The whole object every time. The IPC handler validates all four flags and
    // rejects a partial payload outright, so a diff would simply be refused.
    const next: RemoteCapabilities = { ...device.capabilities, [key]: !device.capabilities[key] }
    apply(await window.remote.setCapabilities(device.id, next))
  }

  const revoke = async (deviceId: string): Promise<void> => {
    setConfirmRevoke(null)
    apply(await window.remote.revokeDevice(deviceId))
  }

  const showPhrase = async (deviceId: string): Promise<void> => {
    const res = await window.remote.verificationPhrase(deviceId)
    if (res.success) setPhrases((prev) => ({ ...prev, [deviceId]: res.data.phrase }))
    else setError(res.error)
  }

  if (unavailable) {
    return (
      <div className="settings-section" data-testid="remote-settings">
        <h2 className="text-sm font-semibold text-[#e0e0e0] mb-2">Remote</h2>
        <p className="text-xs text-[#e5c07b]" data-testid="remote-unavailable">
          {unavailable}
        </p>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="settings-section" data-testid="remote-settings">
        <h2 className="text-sm font-semibold text-[#e0e0e0] mb-2">Remote</h2>
        <p className="text-xs text-[#9ca3af]">Loading…</p>
      </div>
    )
  }

  return (
    <div className="settings-section" data-testid="remote-settings">
      <h2 className="text-sm font-semibold text-[#e0e0e0] mb-1">Remote</h2>
      <p className="text-xs text-[#9ca3af] mb-4">
        Reach the terminals in this window from your phone. The relay only ever carries sealed
        bytes — your keys, your memory and your model account stay on this machine.
      </p>

      {status.disabled && (
        <div
          data-testid="remote-disabled-banner"
          className="text-xs text-[#e5c07b] border border-[#5a4a2d] bg-[#2a2419] rounded px-3 py-2 mb-3"
        >
          Remote access stopped itself after repeated crashes. Switch it off and on again to retry.
        </div>
      )}

      {error && (
        <div
          data-testid="remote-error"
          className="text-xs text-[#f28b82] border border-[#5a2d2d] bg-[#2a1919] rounded px-3 py-2 mb-3"
        >
          {error}
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-[#d4d4d4] mb-4">
        <input
          type="checkbox"
          data-testid="remote-enable"
          checked={status.enabled}
          onChange={(e) => void toggleEnabled(e.target.checked)}
        />
        <span>Allow phones to connect</span>
        <span className="text-xs text-[#9ca3af]" data-testid="remote-running">
          {status.enabled ? (status.running ? '(connected to the relay)' : '(not connected)') : ''}
        </span>
      </label>

      <div className="mb-4">
        <div className="text-xs text-[#9ca3af] mb-1">Relay address</div>
        <div className="flex gap-2">
          <input
            type="text"
            data-testid="remote-relay-url"
            value={relayDraft ?? status.relayUrl}
            onChange={(e) => setRelayDraft(e.target.value)}
            placeholder="wss://relay.termpolis.com/ws"
            className="flex-1 bg-[#2d2d2d] text-[#d4d4d4] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none"
          />
          <button
            data-testid="remote-relay-save"
            onClick={() => void saveRelay(relayDraft ?? status.relayUrl)}
            className="px-3 py-1 text-xs rounded bg-[#3c3c3c] hover:bg-[#4a4a4a] text-[#e0e0e0]"
          >
            Save
          </button>
        </div>
      </div>

      <div className="mb-4">
        <div className="text-xs text-[#9ca3af] mb-1">Pair a device</div>
        <div className="flex gap-2">
          <input
            type="text"
            data-testid="remote-pair-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Phone"
            className="flex-1 bg-[#2d2d2d] text-[#d4d4d4] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none"
          />
          <button
            data-testid="remote-pair-button"
            onClick={() => void startPairing()}
            className="px-3 py-1 text-xs rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
          >
            Pair a device
          </button>
        </div>
      </div>

      <div className="text-xs text-[#9ca3af] mb-2">Paired devices</div>
      {status.devices.length === 0 ? (
        <p className="text-xs text-[#6b7280] mb-4" data-testid="remote-no-devices">
          No phones are paired with this desktop.
        </p>
      ) : (
        <div className="flex flex-col gap-3 mb-4">
          {status.devices.map((device) => (
            <div
              key={device.id}
              data-testid={`remote-device-${device.id}`}
              className="border border-[#3c3c3c] rounded px-3 py-2 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`inline-block w-2 h-2 rounded-full ${device.attached ? 'bg-[#7ee2a3]' : 'bg-[#4a4a4a]'}`}
                  />
                  <span className="text-sm text-[#e0e0e0]">{device.label}</span>
                  <span className="text-xs text-[#6b7280]" data-testid={`remote-seen-${device.id}`}>
                    {device.attached ? 'connected' : `last seen ${relativeTime(device.lastSeenAt, now)}`}
                  </span>
                </div>
                {confirmRevoke === device.id ? (
                  <button
                    data-testid={`remote-revoke-confirm-${device.id}`}
                    onClick={() => void revoke(device.id)}
                    className="px-2 py-1 text-xs rounded bg-[#a33] hover:bg-[#c44] text-white"
                  >
                    Really revoke?
                  </button>
                ) : (
                  <button
                    data-testid={`remote-revoke-${device.id}`}
                    onClick={() => setConfirmRevoke(device.id)}
                    className="px-2 py-1 text-xs rounded bg-[#3c3c3c] hover:bg-[#4a4a4a] text-[#e0e0e0]"
                  >
                    Revoke
                  </button>
                )}
              </div>

              <div className="flex flex-col gap-1">
                {CAPABILITIES.map((cap) => (
                  <label key={cap.key} className="flex items-start gap-2 text-xs text-[#d4d4d4]">
                    <input
                      type="checkbox"
                      data-testid={`remote-cap-${device.id}-${cap.key}`}
                      checked={device.capabilities[cap.key]}
                      onChange={() => void toggleCapability(device, cap.key)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className={cap.danger ? 'text-[#e5c07b]' : ''}>{cap.label}</span>
                      <span className="block text-[#6b7280]">{cap.hint}</span>
                    </span>
                  </label>
                ))}
              </div>

              {phrases[device.id] ? (
                <div
                  data-testid={`remote-phrase-${device.id}`}
                  className="font-mono text-xs text-[#e0e0e0] bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 select-all"
                >
                  {phrases[device.id]}
                </div>
              ) : (
                <button
                  data-testid={`remote-show-phrase-${device.id}`}
                  onClick={() => void showPhrase(device.id)}
                  className="self-start text-xs text-[#4aa8d8] hover:text-[#6cc] underline"
                >
                  Show safety words
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-[#9ca3af] mb-1">This desktop&apos;s public key</div>
      <div
        data-testid="remote-public-key"
        className="font-mono text-[10px] break-all text-[#6b7280] bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 select-all"
      >
        {status.publicKey}
      </div>

      {modalOpen && (
        <PairingModal pairing={status.pairing} paired={paired} onClose={() => void closeModal()} />
      )}
    </div>
  )
}
