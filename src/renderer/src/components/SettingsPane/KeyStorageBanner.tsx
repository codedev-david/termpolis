import { useState } from 'react'
import type { KeyStorageView } from '../../types'

const KEYS = 'the keys that identify this computer to your phones and linked computers'

/** Why the keys are locked, in words: what would bring them back, before the way past it. */
const LOCK_COPY: Record<NonNullable<KeyStorageView['keyLockReason']>, string> = {
  'no-keychain': `Your keyring is locked or not running, so Termpolis can't read ${KEYS}. Unlock it and restart Termpolis.`,
  'unwrap-failed': `This computer's keychain won't open ${KEYS}. That can happen after a password reset, or when Termpolis's data folder came from another computer or user account. If the original account comes back, restart Termpolis.`,
  unreadable: `Termpolis can't read the files that hold ${KEYS}. Check that they can be read, then restart Termpolis.`,
}

const RED = 'text-xs text-[#f28b82] border border-[#5a2d2d] bg-[#2a1919] rounded px-3 py-2 mb-3 flex flex-col gap-2'
const AMBER = 'text-xs text-[#e5c07b] border border-[#5a4a2d] bg-[#2a2419] rounded px-3 py-2 mb-3 flex flex-col gap-2'
const BUTTON = 'px-3 py-1 text-xs rounded bg-[#3c3c3c] hover:bg-[#4a4a4a] text-[#e0e0e0] disabled:opacity-50'

interface Props {
  view: KeyStorageView
  /** Prefixes every testid: one banner per pane. */
  pane: 'remote' | 'linked'
  onEncrypt(): Promise<void>
  onStartOver(): Promise<void>
}

/**
 * The keys' warning, the same under Settings ▸ Remote and ▸ Linked machines: both features stand on
 * this computer's one identity, and whichever pane is open says so.
 *
 * Locked, the way past is Start over -- the user's decision, never the app's, and a two-step one,
 * because it costs every pairing. Saved in the clear with no keychain, there is only the warning.
 * In the clear WITH a keychain, Encrypt keys now: asked for rather than done on the side, because
 * sealed keys open only where the keychain does.
 */
export function KeyStorageBanner({ view, pane, onEncrypt, onStartOver }: Props): JSX.Element | null {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  if (view.keyStorage === 'locked') {
    return (
      <div data-testid={`${pane}-keys-warning`} data-keys="locked" className={RED}>
        <span>
          {view.keyLockReason ? LOCK_COPY[view.keyLockReason] : `Termpolis can't open ${KEYS}.`} Nothing was
          changed: no new keys were made, and every pairing is kept.
        </span>
        {confirming ? (
          <>
            <span className="text-[#e0e0e0]">
              Start over makes a new identity for this computer. Every phone and every linked computer paired
              with the old one has to pair again, and a linked computer keeps listing this one until it is
              unlinked there. The old key files are renamed aside, not deleted.
            </span>
            <div className="flex gap-2">
              <button
                data-testid={`${pane}-keys-start-over-confirm`}
                disabled={busy}
                onClick={() => void run(onStartOver)}
                className="px-3 py-1 text-xs rounded bg-[#a33] hover:bg-[#c44] text-white disabled:opacity-50"
              >
                Start over
              </button>
              <button
                data-testid={`${pane}-keys-start-over-cancel`}
                disabled={busy}
                onClick={() => setConfirming(false)}
                className={BUTTON}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <button
            data-testid={`${pane}-keys-start-over`}
            onClick={() => setConfirming(true)}
            className={`self-start ${BUTTON}`}
          >
            Start over…
          </button>
        )}
      </div>
    )
  }

  if (view.keyStorage === 'plaintext') {
    return (
      <div data-testid={`${pane}-keys-warning`} data-keys="plaintext" className={AMBER}>
        <span>
          No keyring: {KEYS} are saved unencrypted in Termpolis&apos;s data folder. Anyone who can read your
          files can pose as this computer to them. Install and unlock a keyring (GNOME Keyring or KWallet),
          then restart Termpolis.
        </span>
        {view.keyBackend && (
          <span data-testid={`${pane}-keys-backend`} className="text-[#6b7280]">
            Key store Electron reports: {view.keyBackend}
          </span>
        )}
      </div>
    )
  }

  if (!view.keysUnencrypted) return null

  return (
    <div data-testid={`${pane}-keys-warning`} data-keys="unencrypted" className={AMBER}>
      <span>
        Some of {KEYS} were saved before a keychain was available, so they are still unencrypted. Encrypted,
        they open only while the keychain does: a Termpolis started without it finds them locked.
      </span>
      <button
        data-testid={`${pane}-keys-encrypt`}
        disabled={busy}
        onClick={() => void run(onEncrypt)}
        className={`self-start ${BUTTON}`}
      >
        Encrypt keys now
      </button>
    </div>
  )
}
