// Lumopolis: open a git repository. The URL is checked as it is typed (the same rules main enforces:
// https://, ssh:// or git@ only, nothing that reads as an option), with an optional branch. While
// main clones (shallow, into Termpolis's data folder) an indeterminate bar runs; Cancel stops it.
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import type { WorldEntry } from '../../../../shared/world/types'
import { CLONE_STOPPED_MESSAGE, type NeedsLogin, type RepoAccess } from '../../../../shared/world/repoAccess'
import { BAD_REF_MESSAGE, validateGitUrl, validGitRef } from '../../../../shared/world/gitUrl'
import { btnCls, dialogCls, fieldCls, linkCls, primaryCls, signInLabel } from './worldTargets'
import { RepoAccessDialog } from './RepoAccessDialog'
import { holdFocus } from '../../hooks/useFocusTrap'
import { useUiZoom } from './worldPane'

export interface CloneDialogProps {
  onCloned: (entry: WorldEntry) => void
  onClose: () => void
  /** Each Clone (or sign-in or token try) the person makes: the pane takes its ticket then (R3). */
  onStart?: () => void
  /** The pane hands this dialog its Esc (WorldHome): set on every render to what Esc does now. */
  escRef?: MutableRefObject<(() => void) | null>
  /** What the fields start with: a missing repository's Clone again fills them in (WP4b F-R7). */
  initialUrl?: string
  initialBranch?: string
  /** A clone the person stopped had already finished: it is saved, so the home's list is refreshed (WP4b F-R5). */
  onKept?: (entry: WorldEntry) => void
}

export const CLONE_UNREACHABLE = "Lumopolis couldn't clone that repository. Try again."
/** A machine sign-in may need no window at all (a helper with a saved login), so the words do not say one opened. */
export const SIGNING_IN_MESSAGE = "Signing in with this computer's login… If a sign-in window opens, finish there."
/** Shown from Cancel until the stopped clone answers (WP4b F-R5): nothing can start another clone meanwhile. */
export const STOPPING_MESSAGE = 'Stopping the clone…'
/** The token dialog was closed while its token was tried, and that try is over. */
export const TOKEN_STOPPED_MESSAGE = 'Lumopolis stopped trying that token.'
/** A stopped clone that had finished before the stop reached it: kept, not opened. */
export const CLONE_KEPT_MESSAGE = 'The clone finished before Lumopolis could stop it, so the repository is in your recent worlds.'

type StoppedBy = 'clone' | 'token'

export function CloneDialog({ onCloned, onClose, onStart, escRef, onKept, initialUrl = '', initialBranch = '' }: CloneDialogProps): JSX.Element {
  const zoom = useUiZoom()
  const [url, setUrl] = useState(initialUrl)
  const [branch, setBranch] = useState(initialBranch)
  const [cloning, setCloning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Set when the repository needs a sign-in: the choices to make one. */
  const [login, setLogin] = useState<NeedsLogin | null>(null)
  const [tokenOpen, setTokenOpen] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  /** Set from a Cancel (or the token dialog's Cancel) until the stopped clone answers; mirrored in a ref for its answer. */
  const [stopping, setStopping] = useState<StoppedBy | null>(null)
  const stoppedBy = useRef<StoppedBy | null>(null)
  /** A clone that finished before the person's stop reached it. */
  const [kept, setKept] = useState(false)
  /** The clone running now, if any: the dialog closing under it stops it (WP4b F-R5). */
  const running = useRef<{ url: string; ref?: string } | null>(null)

  const trimmed = url.trim()
  const ref = branch.trim() === '' ? undefined : branch.trim()
  const checked = validateGitUrl(trimmed)
  let reason: string | null = null
  if (trimmed !== '' && !checked.ok) reason = checked.reason
  else if (ref !== undefined && !validGitRef(ref)) reason = BAD_REF_MESSAGE
  const canClone = trimmed !== '' && reason === null && !cloning

  /** A changed address or branch is a different repository: the sign-in choices no longer apply. */
  const edited = (): void => { setLogin(null); setTokenOpen(false) }

  // One clone at a time: Clone and the fields are grey while one runs, and stay grey while a stopped one answers.
  const clone = (access?: RepoAccess): void => {
    if (!canClone) return
    onStart?.()
    running.current = ref === undefined ? { url: trimmed } : { url: trimmed, ref }
    setCloning(true)
    setError(null)
    setTokenError(null)
    setKept(false)
    setSigningIn(access?.mode === 'machine')
    // The words go to the token dialog when the try came from it, else to the alert under the fields.
    const viaToken = access?.mode === 'token'
    const done = (message: string | null, entry?: WorldEntry, needs?: NeedsLogin): void => {
      running.current = null
      setCloning(false)
      setSigningIn(false)
      const by = stoppedBy.current
      if (by !== null) {
        // The person stopped it: however main answered, the words say it stopped; one that had finished is kept.
        stoppedBy.current = null
        setStopping(null)
        if (entry) {
          setKept(true)
          onKept?.(entry)
        } else {
          setError(by === 'token' ? TOKEN_STOPPED_MESSAGE : CLONE_STOPPED_MESSAGE)
        }
        return
      }
      if (entry) { onCloned(entry); return }
      if (needs) setLogin(needs)
      if (viaToken) setTokenError(message)
      else setError(message)
    }
    const asked = access ? window.termpolis.worldClone(trimmed, ref, access) : window.termpolis.worldClone(trimmed, ref)
    asked.then(
      (res) => {
        if (!res.success) done(res.error)
        else if ('needsLogin' in res.data) done(res.data.needsLogin.message, undefined, res.data.needsLogin)
        else done(null, res.data)
      },
      () => done(CLONE_UNREACHABLE),
    )
  }

  const submitToken = (value: string): void => clone({ mode: 'token', value })

  /** Stops the clone under way. The dialog stays grey until its answer comes (a clone started meanwhile would join the
   *  run being stopped), and that answer then says it stopped (WP4b F-R5). */
  const stop = (by: StoppedBy): void => {
    stoppedBy.current = by
    setStopping(by)
    setSigningIn(false)
    window.termpolis.worldCloneCancel(trimmed, ref).catch(() => undefined)
  }
  // A second Cancel while the stop is under way closes the dialog: the stop was already asked for.
  const cancel = (): void => {
    if (!cloning || stoppedBy.current !== null) { onClose(); return }
    stop('clone')
  }
  // Closed under a clone that runs (Esc or a second Cancel during the stop are already stopping it): that clone stops.
  useEffect(() => () => {
    const run = running.current
    if (run === null || stoppedBy.current !== null) return
    // Its answer then counts as stopped too: never opened from a dialog that is gone, only kept if it had finished.
    stoppedBy.current = 'clone'
    window.termpolis.worldCloneCancel(run.url, run.ref).catch(() => undefined)
  }, [])
  const choiceCls = login !== null && login.notFound === true ? linkCls : btnCls
  // Closing the token dialog while its token is tried stops that try too: its answer would have nowhere to show (F-R5).
  const closeToken = (): void => {
    if (cloning) stop('token')
    setTokenOpen(false)
    setTokenError(null)
  }
  // Esc is the Cancel of the dialog on top: the token dialog's when it is up, else this one's (which stops a clone
  // under way before it closes anything).
  const tokenShown = tokenOpen && login !== null
  if (escRef) escRef.current = tokenShown ? closeToken : cancel
  // Under the token dialog this one is inert, so Tab stays in that dialog; closed, the focus comes back to the button
  // that opened it, or to this dialog while that button is grey (F-R13).
  const dialogRef = useRef<HTMLDivElement>(null)
  const useTokenRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (!tokenShown) return
    const d = dialogRef.current as HTMLDivElement
    // Use a token is drawn whenever login is set, so it is there whenever the token dialog is. On unmount React runs
    // this before it takes the nodes away, and the home then gives the focus back to its own choice.
    const back = useTokenRef.current as HTMLButtonElement
    d.inert = true
    return () => {
      d.inert = false
      if (back.disabled) d.focus()
      else back.focus()
    }
  }, [tokenShown])
  // A clone that starts greys the control pressed for it (Clone, Sign in, a field with Enter): the dialog keeps the
  // focus, so Tab and Esc still work in it while it runs (F-R13).
  useLayoutEffect(() => {
    if (cloning) holdFocus(dialogRef.current as HTMLDivElement)
  }, [cloning])

  return (
    <>
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-label="Open a git repository" data-testid="world-clone" className={`${dialogCls} focus:outline-none`} style={zoom}>
      <h2 className="text-base font-semibold text-white">Open a git repository</h2>
      <label className="flex flex-col gap-1 text-xs text-[#9ca3af]">
        Repository URL
        <input
          autoFocus
          value={url}
          disabled={cloning}
          placeholder="https://github.com/owner/repo.git"
          spellCheck={false}
          onChange={(e) => { setUrl(e.target.value); edited() }}
          onKeyDown={(e) => { if (e.key === 'Enter') clone() }}
          className={fieldCls}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[#9ca3af]">
        Branch (optional)
        <input
          value={branch}
          disabled={cloning}
          placeholder="main"
          spellCheck={false}
          onChange={(e) => { setBranch(e.target.value); edited() }}
          onKeyDown={(e) => { if (e.key === 'Enter') clone() }}
          className={fieldCls}
        />
      </label>
      {reason !== null && <p data-testid="world-clone-reason" className="text-xs text-[#f0b429]">{reason}</p>}
      {cloning && (
        <div role="progressbar" aria-label="Cloning" className="h-1.5 w-full overflow-hidden rounded bg-[#1e1e1e]">
          <div className="h-full w-1/3 motion-safe:animate-pulse rounded bg-[#0078d4]" />
        </div>
      )}
      {signingIn && <p className="text-xs text-[#9ca3af]">{SIGNING_IN_MESSAGE}</p>}
      {stopping !== null && <p role="status" className="text-xs text-[#9ca3af]">{STOPPING_MESSAGE}</p>}
      {kept && <p role="status" className="text-xs text-[#9ca3af]">{CLONE_KEPT_MESSAGE}</p>}
      {error !== null && <p role="alert" className="text-xs text-[#f14c4c]">{error}</p>}
      {login !== null && (
        // When the host only said it could not find the repository, the address is the likelier fault: the
        // sign-in choices are offered as links, beneath the hint to check it (F-R8).
        <div className="flex gap-2">
          {login.helper && (
            <button type="button" data-testid="world-clone-sign-in" className={choiceCls} disabled={cloning} onClick={() => clone({ mode: 'machine' })}>
              {signInLabel(login.host)}
            </button>
          )}
          <button ref={useTokenRef} type="button" data-testid="world-clone-use-token" className={choiceCls} disabled={cloning} onClick={() => setTokenOpen(true)}>Use a token</button>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btnCls} onClick={cancel}>Cancel</button>
        <button type="button" className={primaryCls} disabled={!canClone} onClick={() => clone()}>Clone</button>
      </div>
    </div>
    {tokenShown && (
      <RepoAccessDialog
        host={login.host}
        busy={cloning}
        error={tokenError}
        onSubmit={submitToken}
        onCancel={closeToken}
      />
    )}
    </>
  )
}
