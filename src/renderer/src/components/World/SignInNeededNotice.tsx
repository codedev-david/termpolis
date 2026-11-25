// Lumopolis: a remembered repository that needs a sign-in before it can update. The saved copy is
// still showing; this notice offers Sign in (when git has a login helper for the host), Use a token,
// or Dismiss. It sits in the same top-of-world slot as WorldView's other notice. A repository the host no
// longer finds (R4) says main's words instead, and its sign-in choices are links: the address comes first.
// WP4b: the same slot says a background update that failed (main's words, with Try again) and that a repository opened
// with a token updates only with one (Update with a token); while a try runs, Stop takes Dismiss's place (F-R6), and the
// notice says what the try is doing (fix round 1, M5).
import { useLayoutEffect, useRef } from 'react'
import { holdFocus } from '../../hooks/useFocusTrap'
import { SIGNING_IN_MESSAGE } from './CloneDialog'
import type { RepoTry } from './useOpenWorld'
import { btnCls, linkCls, signInLabel } from './worldTargets'

export interface SignInNeededNoticeProps {
  host: string
  helper: boolean
  /** main's words, shown when notFound. */
  message: string
  notFound: boolean
  busy: boolean
  /** Which try is running while busy: the notice says what it is doing. A token try says nothing here, as its dialog is
   *  up over the notice. */
  trying?: RepoTry
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
/** Said while Try again runs (WP4b fix round 1, M5). */
export const UPDATING_MESSAGE = 'Updating this repository…'
const SAVED_COPY = " You're seeing the saved copy."
/** main's words less a closing "Try again.", for a notice whose Try again button says it (fix round 1, M4). Words that
 *  say when or how to try again ("Try again in a moment.", "then try again.") stay. */
const lessTryAgain = (message: string): string => message.replace(/ Try again\.$/, '')

export function SignInNeededNotice({ host, helper, message, notFound, busy, trying, error, onSignIn, onUseToken, onDismiss, reason, stopping = false, onStop, onTryAgain, inert = false }: SignInNeededNoticeProps): JSX.Element {
  const choiceCls = notFound ? linkCls : btnCls
  // React 18 does not pass `inert` through as an attribute, so it is set on the element.
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    ;(box.current as HTMLDivElement).inert = inert
  }, [inert])
  // The choice pressed turns grey when its try starts: the focus goes to Stop, so a keyboard user can stop what they
  // started, and back to the first choice when the try ends (Stop goes with it, so it is keyed apart from Dismiss).
  // Focus the person put elsewhere stays.
  // Stop greys while the stop is under way (Stopping…): the notice itself (tabIndex -1) holds the focus Stop had, so it
  // never falls to the page, and the first choice gets it back when the try ends (fix round 1, M5).
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
      if (at === document.body || at === b) (b.querySelector('button:not(:disabled)') as HTMLButtonElement).focus()
    }
  }, [busy])
  useLayoutEffect(() => {
    const b = box.current as HTMLDivElement
    if (!stopping) return
    holdFocus(b)
    if (document.activeElement === b) heldFocus.current = true
  }, [stopping])
  const said = reason === 'token' ? TOKEN_ONLY_MESSAGE : reason === 'failed' ? `${lessTryAgain(message)}${SAVED_COPY}` : notFound ? `${message}${SAVED_COPY}` : SIGN_IN_MESSAGE
  const doing = !busy ? null : trying === 'machine' ? SIGNING_IN_MESSAGE : trying === 'again' ? UPDATING_MESSAGE : null
  return (
    <div
      ref={box}
      role="status"
      tabIndex={-1}
      data-testid="world-sign-in-needed"
      className="text-xs px-3 py-2 rounded border border-[#3c3c3c] flex flex-col gap-2 focus:outline-none"
      style={{ background: '#252526', maxWidth: 420 }}
    >
      <span>{said}</span>
      {doing !== null && <span data-testid="world-sign-in-progress" className="text-[#9da5b4]">{doing}</span>}
      {error !== null && <span role="alert" className="text-[#f14c4c]">{reason === 'failed' ? lessTryAgain(error) : error}</span>}
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
