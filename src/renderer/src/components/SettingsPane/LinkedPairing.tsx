import { useEffect, useState } from 'react'
import type { LinkedGrants } from '../../types'
import { copyText } from '../../lib/clipboard'
import {
  formatCountdown,
  secondsLeft,
  type GrantKey,
  type PendingConfirmation,
} from '../../lib/linkedMachines'
import { LinkedGrantToggles } from './LinkedGrantToggles'

const PRIMARY = 'px-3 py-1 text-xs rounded bg-[#0078d4] hover:bg-[#106ebe] text-white disabled:opacity-50'
const SECONDARY = 'px-3 py-1 text-xs rounded bg-[#3c3c3c] hover:bg-[#4a4a4a] text-[#e0e0e0]'

/** Main's clipboard first: `navigator.clipboard` is refused from a button
 *  click in Electron (see lib/clipboard.ts). The browser API is only the
 *  fallback for a renderer without main's channel. */
async function copyWithFallback(text: string): Promise<boolean> {
  if (await copyText(text)) return true
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** The live code, its Copy button and its countdown. Keyed by the code, so a
 *  fresh code never inherits "Copied" or a copy failure from the last one. */
function LiveCode({
  code,
  remaining,
  onCancel,
}: {
  code: string
  remaining: number
  onCancel(): void
}): JSX.Element {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (copy !== 'copied') return
    const id = setTimeout(() => setCopy('idle'), 1500)
    return () => clearTimeout(id)
  }, [copy])

  const copyCode = async (): Promise<void> => {
    setCopy((await copyWithFallback(code)) ? 'copied' : 'failed')
  }

  return (
    <div className="flex flex-col gap-2 mt-2">
      <div
        data-testid="linked-code"
        className="font-mono text-[11px] break-all text-[#e0e0e0] bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 select-all"
      >
        {code}
      </div>
      <div className="flex items-center gap-2">
        <button data-testid="linked-copy" onClick={() => void copyCode()} className={PRIMARY}>
          <i aria-hidden="true" className={`fa-solid ${copy === 'copied' ? 'fa-check' : 'fa-copy'} mr-1`}></i>
          {copy === 'copied' ? 'Copied' : 'Copy'}
        </button>
        <span data-testid="linked-countdown" className="text-xs text-[#9ca3af]">
          Expires in {formatCountdown(remaining)}
        </span>
        <button data-testid="linked-cancel-code" onClick={onCancel} className={SECONDARY}>
          Cancel
        </button>
      </div>
      {copy === 'failed' && (
        <p data-testid="linked-copy-failed" className="text-xs text-[#e5c07b]">
          Could not copy. Select the code and copy it by hand.
        </p>
      )}
    </div>
  )
}

export interface LinkedCodeOfferProps {
  code: { code: string; expiresAt: number } | null
  now: number
  /** A code was asked for and the bridge has not produced it yet. Only the
   *  caller can tell "not yet" from "never asked": both are a null code. */
  awaiting: boolean
  grants: LinkedGrants
  atLimit: boolean
  onToggleGrant(key: GrantKey): void
  onCreate(): void
  onCancel(): void
}

/** Host side: choose what the new computer may do here, then make a code. */
export function LinkedCodeOffer({
  code,
  now,
  awaiting,
  grants,
  atLimit,
  onToggleGrant,
  onCreate,
  onCancel,
}: LinkedCodeOfferProps): JSX.Element {
  const remaining = code ? secondsLeft(code.expiresAt, now) : 0
  // Narrowed rather than a boolean flag, so the live branch reads the code
  // without a non-null assertion.
  const live = code && remaining > 0 ? code : null

  return (
    <div className="mb-4" data-testid="linked-link-section">
      <div className="text-xs text-[#9ca3af] mb-1">Link a computer</div>
      <p className="text-xs text-[#6b7280] mb-2">
        Create a one-time code here and enter it on the other computer, under Settings ▸ Linked
        machines there. It works once, for 5 minutes.
      </p>
      <div className="text-xs text-[#6b7280] mb-1">What the new computer may do here:</div>
      {/* Locked while a code is out: its grants were sent with it, so changing
          the boxes now would change nothing and only look as if it had. */}
      <LinkedGrantToggles
        grants={grants}
        onToggle={onToggleGrant}
        testIdPrefix="linked-grant-new"
        disabled={live !== null || awaiting}
      />
      {live ? (
        <LiveCode key={live.code} code={live.code} remaining={remaining} onCancel={onCancel} />
      ) : awaiting ? (
        <div className="flex items-center gap-2 mt-2">
          <span data-testid="linked-code-waiting" className="text-xs text-[#9ca3af]">
            Asking for a code…
          </span>
          <button data-testid="linked-cancel-code" onClick={onCancel} className={SECONDARY}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 mt-2">
          <button data-testid="linked-create-code" onClick={onCreate} disabled={atLimit} className={PRIMARY}>
            Create code
          </button>
          {code && (
            <span data-testid="linked-code-expired" className="text-xs text-[#e5c07b]">
              That code has expired. Create a new one.
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export interface LinkedJoinFormProps {
  code: string
  grants: LinkedGrants
  joining: boolean
  atLimit: boolean
  onCodeChange(text: string): void
  onToggleGrant(key: GrantKey): void
  onJoin(): void
  onCancel(): void
}

/** Joiner side: paste the other computer's code and choose what it may do here. */
export function LinkedJoinForm({
  code,
  grants,
  joining,
  atLimit,
  onCodeChange,
  onToggleGrant,
  onJoin,
  onCancel,
}: LinkedJoinFormProps): JSX.Element {
  return (
    <div className="mb-4" data-testid="linked-join-section">
      <div className="text-xs text-[#9ca3af] mb-1">Enter a code from another computer</div>
      <textarea
        data-testid="linked-join-input"
        aria-label="Code from another computer"
        value={code}
        onChange={(e) => onCodeChange(e.target.value)}
        disabled={joining}
        rows={3}
        spellCheck={false}
        placeholder="termpolis-link:…"
        className="w-full font-mono text-[11px] bg-[#2d2d2d] text-[#d4d4d4] border border-[#3c3c3c] rounded px-2 py-1 focus:outline-none disabled:opacity-60"
      />
      <div className="text-xs text-[#6b7280] mt-2 mb-1">What that computer may do here:</div>
      <LinkedGrantToggles
        grants={grants}
        onToggle={onToggleGrant}
        testIdPrefix="linked-join-grant"
        disabled={joining}
      />
      {joining ? (
        <div className="flex items-center gap-2 mt-2">
          <span data-testid="linked-joining" className="text-xs text-[#9ca3af]">
            <i aria-hidden="true" className="fa-solid fa-spinner fa-spin mr-1"></i>
            Contacting the other computer…
          </span>
          <button data-testid="linked-cancel-join" onClick={onCancel} className={SECONDARY}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          data-testid="linked-join-button"
          onClick={onJoin}
          disabled={atLimit || code.trim() === ''}
          className={`mt-2 ${PRIMARY}`}
        >
          Link
        </button>
      )}
    </div>
  )
}

export interface LinkedPendingCardProps {
  item: PendingConfirmation
  onConfirm(ref: string, name: string): void
  onCancel(ref: string): void
}

/** The safety-word check. A link serves nothing until this side confirms it,
 *  which is stronger than phone pairing on purpose: nobody may be watching a
 *  desktop when its code is redeemed (spec §3.1). */
export function LinkedPendingCard({ item, onConfirm, onCancel }: LinkedPendingCardProps): JSX.Element {
  const [name, setName] = useState(item.suggestedName)

  return (
    <div
      data-testid={`linked-pending-${item.ref}`}
      className="border border-[#5a4a2d] bg-[#2a2419] rounded px-3 py-3 mb-4 flex flex-col gap-2"
    >
      <div className="text-sm text-[#e5c07b]">Confirm the link with {item.suggestedName}</div>
      {item.phrase ? (
        <>
          <p className="text-xs text-[#9ca3af]">
            Check that the other computer shows the same 8 words, in the same order. If they match,
            nobody is sitting in the middle of the connection. If they do not, cancel.
          </p>
          <div
            data-testid="linked-phrase"
            className="font-mono text-lg leading-relaxed text-[#e0e0e0] bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 select-all"
          >
            {item.phrase}
          </div>
          <label className="flex items-center gap-2 text-xs text-[#9ca3af]">
            Name it
            <input
              type="text"
              data-testid="linked-name-input"
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 bg-[#2d2d2d] text-[#d4d4d4] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none"
            />
          </label>
        </>
      ) : (
        // Words nobody can compare would make "They match" a click, not a check.
        <p data-testid="linked-phrase-missing" className="text-xs text-[#f28b82]">
          The safety words for this link are missing, so it cannot be checked. Cancel it and link again.
        </p>
      )}
      <div className="flex gap-2">
        {item.phrase && (
          <button
            data-testid="linked-confirm"
            onClick={() => onConfirm(item.ref, name.trim() || item.suggestedName)}
            className={PRIMARY}
          >
            They match — link
          </button>
        )}
        <button data-testid="linked-cancel-pending" onClick={() => onCancel(item.ref)} className={SECONDARY}>
          Cancel
        </button>
      </div>
    </div>
  )
}
