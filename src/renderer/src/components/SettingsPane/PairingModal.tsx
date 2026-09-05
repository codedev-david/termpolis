import { useEffect, useMemo, useState } from 'react'
import { buildQrPath } from '../../lib/qrPath'
import type { RemotePairingView } from '../../types'

export interface PairedResult {
  label: string
  phrase: string
}

export interface PairingModalProps {
  /** The live offer, or null once it has been spent or cancelled. */
  pairing: RemotePairingView | null
  /** Set the moment a phone completes the handshake. Takes precedence over the
   *  offer: the code is single-use, so there is nothing left to scan. */
  paired: PairedResult | null
  onClose(): void
}

/** Modules of white margin around the code. Four is the spec minimum, and
 *  scanners genuinely fail without it. */
const QUIET = 4

function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * The pairing dialog: a code to scan, then the safety words to compare.
 *
 * Three states and no fourth. A spent or expired offer shows why rather than a
 * QR that would simply be refused, and the safety phrase sits under the code
 * with the instruction to read it against the phone -- a safety number nobody
 * compares is decoration.
 */
export function PairingModal({ pairing, paired, onClose }: PairingModalProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Only while a live offer is on screen: nothing else here is time-dependent,
    // and a modal parked on the safety phrase should not tick for as long as the
    // user leaves it open.
    if (!pairing || paired) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [pairing, paired])

  const qr = useMemo(() => (pairing ? buildQrPath(pairing.qrPayload) : null), [pairing])

  const remaining = pairing ? secondsLeft(pairing.expiresAt, now) : 0
  // Narrowed rather than a boolean flag, so the branches below can read the
  // payload without a non-null assertion or a fallback that cannot happen.
  const live = pairing && remaining > 0 ? pairing : null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fadeIn"
      data-testid="pairing-modal"
    >
      <div className="bg-[#252526] rounded-lg shadow-xl border border-[#3c3c3c] w-[420px] max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#3c3c3c]">
          <h2 className="text-sm font-semibold flex items-center gap-2 text-[#e0e0e0]">Pair a phone</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            data-testid="pairing-close"
            className="text-[#9ca3af] hover:text-white text-lg px-1"
          >
            ×
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          {paired ? (
            <div className="flex flex-col gap-3" data-testid="pairing-paired">
              <p className="text-sm text-[#7ee2a3]">
                {paired.label} is paired.
              </p>
              <p className="text-xs text-[#9ca3af]">
                Compare these words with the ones on your phone. If they match, nobody is sitting in the
                middle of the connection. If they do not, revoke the device and pair again.
              </p>
              <div
                data-testid="pairing-phrase"
                className="font-mono text-sm text-[#e0e0e0] bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 select-all"
              >
                {paired.phrase}
              </div>
            </div>
          ) : live && qr ? (
            <div className="flex flex-col items-center gap-3">
              <p className="text-xs text-[#9ca3af] self-start">
                Open Termpolis Remote on your phone and scan this code. It works once, and only while the
                countdown is running.
              </p>
              <svg
                data-testid="pairing-qr"
                role="img"
                aria-label="Pairing QR code"
                width={264}
                height={264}
                viewBox={`${-QUIET} ${-QUIET} ${qr.size + QUIET * 2} ${qr.size + QUIET * 2}`}
                shapeRendering="crispEdges"
                className="rounded bg-white p-0"
              >
                <rect
                  x={-QUIET}
                  y={-QUIET}
                  width={qr.size + QUIET * 2}
                  height={qr.size + QUIET * 2}
                  fill="#ffffff"
                />
                <path d={qr.d} fill="#000000" />
              </svg>
              <div data-testid="pairing-countdown" className="text-xs text-[#9ca3af]">
                Expires in {formatCountdown(remaining)}
              </div>
            </div>
          ) : live ? (
            <div className="flex flex-col gap-2" data-testid="pairing-qr-fallback">
              <p className="text-xs text-[#e5c07b]">
                This code is too long to draw. Type it into the phone by hand instead.
              </p>
              <textarea
                readOnly
                value={live.qrPayload}
                className="font-mono text-[10px] h-24 bg-[#1e1e1e] text-[#d4d4d4] border border-[#3c3c3c] rounded p-2"
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2" data-testid="pairing-expired">
              <p className="text-sm text-[#e5c07b]">This pairing code has expired.</p>
              <p className="text-xs text-[#9ca3af]">
                Close this and choose Pair a device again to get a fresh one.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end px-4 py-3 border-t border-[#3c3c3c]">
          <button
            onClick={onClose}
            data-testid="pairing-dismiss"
            className="px-4 py-1.5 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
          >
            {paired ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}
