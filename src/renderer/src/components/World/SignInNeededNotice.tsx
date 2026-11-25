// Lumopolis: a remembered repository that needs a sign-in before it can update. The saved copy is
// still showing; this notice offers Sign in (when git has a login helper for the host), Use a token,
// or Dismiss. It sits in the same top-of-world slot as WorldView's other notice. A repository the host no
// longer finds (R4) says main's words instead, and its sign-in choices are links: the address comes first.
// WP4b: the same slot says a background update that failed (main's words, with Try again) and that a repository opened
// with a token updates only with one (Update with a token); while a try runs, Stop takes Dismiss's place (F-R6).
import { useLayoutEffect, useRef } from 'react'
import { btnCls, linkCls, signInLabel } from './worldTargets'

export interface SignInNeededNoticeProps {
  host: string
  helper: boolean
  /** main's words, shown when notFound. */
  message: string
  notFound: boolean
  busy: boolean
  /** Why the last Sign in or token try failed. */
  error: string | null
  onSignIn(): void
  onUseToken(): void
  onDismiss(): void
  /** Why the notice is up, when it is not a sign-in (useOpenWorld's RepoUpdate.reason). */
  reason?: 'failed' | 'token'
  /** The person pressed Stop and the try has not answered yet. */
  stopping?: boolean
  onStop?(): void
  onTryAgain?(): void
  /** The token dialog opened from this notice is up: the notice takes no focus and says nothing, so a failed try is
   *  announced once, in the dialog (WP-SRC N1). */
  inert?: boolean
}

export const TOKEN_ONLY_MESSAGE = "Lumopolis updates this repository only with a token you give it. You're seeing the saved copy."
const SIGN_IN_MESSAGE = "This repository needs you to sign in before Lumopolis can update it. You're seeing the saved copy."

export function SignInNeededNotice({ host, helper, message, notFound, busy, error, onSignIn, onUseToken, onDismiss, reason, stopping = false, onStop, onTryAgain, inert = false }: SignInNeededNoticeProps): JSX.Element {
  const choiceCls = notFound ? linkCls : btnCls
  // React 18 does not pass `inert` through as an attribute, so it is set on the element.
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    ;(box.current as HTMLDivElement).inert = inert
  }, [inert])
  // The choice pressed turns grey when its try starts: the focus goes to Stop, so a keyboard user can stop what they
  // started, and back to the first choice when the try ends (Stop goes with it, so it is keyed apart from Dismiss).
  // Focus the person put elsewhere stays.
  const stopBtn = useRef<HTMLButtonElement>(null)
  const heldFocus = useRef(false)
  useLayoutEffect(() => {
    const b = box.current as HTMLDivElement
    const at = document.activeElement
    if (busy) {
      if (at instanceof HTMLButtonElement && at.disabled && b.contains(at)) {
        heldFocus.current = true
        ;(stopBtn.current as HTMLButtonElement).focus()
      }
    } else if (heldFocus.current) {
      heldFocus.current = false
      if (at === document.body) (b.querySelector('button:not(:disabled)') as HTMLButtonElement).focus()
    }
  }, [busy])
  const said = reason === 'token' ? TOKEN_ONLY_MESSAGE : reason === 'failed' || notFound ? `${message} You're seeing the saved copy.` : SIGN_IN_MESSAGE
  return (
    <div
      ref={box}
      role="status"
      data-testid="world-sign-in-needed"
      className="text-xs px-3 py-2 rounded border border-[#3c3c3c] flex flex-col gap-2"
      style={{ background: '#252526', maxWidth: 420 }}
    >
      <span>{said}</span>
      {error !== null && <span role="alert" className="text-[#f14c4c]">{error}</span>}
      <div className="flex flex-wrap justify-end gap-2">
        {reason === 'failed' ? (
          <button type="button" className={btnCls} disabled={busy} onClick={onTryAgain}>Try again</button>
        ) : (
          <>
            {helper && <button type="button" className={choiceCls} disabled={busy} onClick={onSignIn}>{signInLabel(host)}</button>}
            <button type="button" className={choiceCls} disabled={busy} onClick={onUseToken}>{reason === 'token' ? 'Update with a token' : 'Use a token'}</button>
          </>
        )}
        {busy ? (
          <button key="stop" ref={stopBtn} type="button" className={btnCls} disabled={stopping} onClick={onStop}>{stopping ? 'Stopping…' : 'Stop'}</button>
        ) : (
          <button key="dismiss" type="button" className={btnCls} onClick={onDismiss}>Dismiss</button>
        )}
      </div>
    </div>
  )
}
