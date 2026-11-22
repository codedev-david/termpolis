// Lumopolis: open a git repository. The URL is checked as it is typed (the same rules main enforces:
// https://, ssh:// or git@ only, nothing that reads as an option), with an optional branch. While
// main clones (shallow, into Termpolis's data folder) an indeterminate bar runs; Cancel stops it.
import { useRef, useState, type MutableRefObject } from 'react'
import type { WorldEntry } from '../../../../shared/world/types'
import type { NeedsLogin, RepoAccess } from '../../../../shared/world/repoAccess'
import { BAD_REF_MESSAGE, validateGitUrl, validGitRef } from '../../../../shared/world/gitUrl'
import { btnCls, dialogCls, fieldCls, primaryCls, signInLabel } from './worldTargets'
import { RepoAccessDialog } from './RepoAccessDialog'
import { useUiZoom } from './worldPane'

export interface CloneDialogProps {
  onCloned: (entry: WorldEntry) => void
  onClose: () => void
  /** The pane hands this dialog its Esc (WorldHome): set on every render to what Esc does now. */
  escRef?: MutableRefObject<(() => void) | null>
}

export const CLONE_UNREACHABLE = "Lumopolis couldn't clone that repository. Try again."

export function CloneDialog({ onCloned, onClose, escRef }: CloneDialogProps): JSX.Element {
  const zoom = useUiZoom()
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [cloning, setCloning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Set when the repository needs a sign-in: the choices to make one. */
  const [login, setLogin] = useState<NeedsLogin | null>(null)
  const [tokenOpen, setTokenOpen] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  /** Bumped by every clone and every cancel: only the latest clone's result counts. */
  const gen = useRef(0)

  const trimmed = url.trim()
  const ref = branch.trim() === '' ? undefined : branch.trim()
  const checked = validateGitUrl(trimmed)
  let reason: string | null = null
  if (trimmed !== '' && !checked.ok) reason = checked.reason
  else if (ref !== undefined && !validGitRef(ref)) reason = BAD_REF_MESSAGE
  const canClone = trimmed !== '' && reason === null && !cloning

  /** A changed address or branch is a different repository: the sign-in choices no longer apply. */
  const edited = (): void => { setLogin(null); setTokenOpen(false) }

  const clone = (access?: RepoAccess): void => {
    if (!canClone) return
    const mine = ++gen.current
    setCloning(true)
    setError(null)
    setTokenError(null)
    setSigningIn(access?.mode === 'machine')
    // The words go to the token dialog when the try came from it, else to the alert under the fields.
    const viaToken = access?.mode === 'token'
    const done = (message: string | null, entry?: WorldEntry, needs?: NeedsLogin): void => {
      if (gen.current !== mine) return
      setCloning(false)
      setSigningIn(false)
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

  const cancel = (): void => {
    if (!cloning) { onClose(); return }
    gen.current++
    setCloning(false)
    setSigningIn(false)
    window.termpolis.worldCloneCancel(trimmed, ref).catch(() => undefined)
  }
  const closeToken = (): void => { setTokenOpen(false); setTokenError(null) }
  // Esc is the Cancel of the dialog on top: the token dialog's when it is up, else this one's (which stops a clone
  // under way before it closes anything).
  if (escRef) escRef.current = tokenOpen && login !== null ? closeToken : cancel

  return (
    <>
    <div role="dialog" aria-label="Open a git repository" data-testid="world-clone" className={dialogCls} style={zoom}>
      <h2 className="text-base font-semibold text-white">Open a git repository</h2>
      <label className="flex flex-col gap-1 text-xs text-[#9ca3af]">
        Repository URL
        <input
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
          className={fieldCls}
        />
      </label>
      {reason !== null && <p data-testid="world-clone-reason" className="text-xs text-[#f0b429]">{reason}</p>}
      {cloning && (
        <div role="progressbar" aria-label="Cloning" className="h-1.5 w-full overflow-hidden rounded bg-[#1e1e1e]">
          <div className="h-full w-1/3 animate-pulse rounded bg-[#0078d4]" />
        </div>
      )}
      {signingIn && <p className="text-xs text-[#9ca3af]">Finish signing in in the window that opened…</p>}
      {error !== null && <p role="alert" className="text-xs text-[#f14c4c]">{error}</p>}
      {login !== null && (
        <div className="flex gap-2">
          {login.helper && (
            <button type="button" data-testid="world-clone-sign-in" className={btnCls} disabled={cloning} onClick={() => clone({ mode: 'machine' })}>
              {signInLabel(login.host)}
            </button>
          )}
          <button type="button" data-testid="world-clone-use-token" className={btnCls} disabled={cloning} onClick={() => setTokenOpen(true)}>Use a token</button>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btnCls} onClick={cancel}>Cancel</button>
        <button type="button" className={primaryCls} disabled={!canClone} onClick={() => clone()}>Clone</button>
      </div>
    </div>
    {tokenOpen && login !== null && (
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
