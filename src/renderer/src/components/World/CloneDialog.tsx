// Lumopolis: open a git repository. The URL is checked as it is typed (the same rules main enforces:
// https://, ssh:// or git@ only, nothing that reads as an option), with an optional branch. While
// main clones (shallow, into Termpolis's data folder) an indeterminate bar runs; Cancel stops it.
import { useRef, useState } from 'react'
import type { WorldEntry } from '../../../../shared/world/types'
import { BAD_REF_MESSAGE, validateGitUrl, validGitRef } from '../../../../shared/world/gitUrl'
import { btnCls, dialogCls, fieldCls, primaryCls } from './worldTargets'

export interface CloneDialogProps {
  onCloned: (entry: WorldEntry) => void
  onClose: () => void
}

export const CLONE_UNREACHABLE = "Lumopolis couldn't clone that repository. Try again."

export function CloneDialog({ onCloned, onClose }: CloneDialogProps): JSX.Element {
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [cloning, setCloning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Bumped by every clone and every cancel: only the latest clone's result counts. */
  const gen = useRef(0)

  const trimmed = url.trim()
  const ref = branch.trim() === '' ? undefined : branch.trim()
  const checked = validateGitUrl(trimmed)
  let reason: string | null = null
  if (trimmed !== '' && !checked.ok) reason = checked.reason
  else if (ref !== undefined && !validGitRef(ref)) reason = BAD_REF_MESSAGE
  const canClone = trimmed !== '' && reason === null && !cloning

  const clone = (): void => {
    if (!canClone) return
    const mine = ++gen.current
    setCloning(true)
    setError(null)
    const done = (message: string | null, entry?: WorldEntry): void => {
      if (gen.current !== mine) return
      setCloning(false)
      if (entry) onCloned(entry)
      else setError(message)
    }
    // A repository that needs a sign-in shows main's words for now; the sign-in choices come with the dialog's next step.
    window.termpolis.worldClone(trimmed, ref).then(
      (res) => (!res.success ? done(res.error) : 'needsLogin' in res.data ? done(res.data.needsLogin.message) : done(null, res.data)),
      () => done(CLONE_UNREACHABLE),
    )
  }

  const cancel = (): void => {
    if (!cloning) { onClose(); return }
    gen.current++
    setCloning(false)
    window.termpolis.worldCloneCancel(trimmed, ref).catch(() => undefined)
  }

  return (
    <div role="dialog" aria-label="Open a git repository" data-testid="world-clone" className={dialogCls}>
      <h2 className="text-base font-semibold text-white">Open a git repository</h2>
      <label className="flex flex-col gap-1 text-xs text-[#9ca3af]">
        Repository URL
        <input
          value={url}
          disabled={cloning}
          placeholder="https://github.com/owner/repo.git"
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
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
          onChange={(e) => setBranch(e.target.value)}
          className={fieldCls}
        />
      </label>
      {reason !== null && <p data-testid="world-clone-reason" className="text-xs text-[#f0b429]">{reason}</p>}
      {cloning && (
        <div role="progressbar" aria-label="Cloning" className="h-1.5 w-full overflow-hidden rounded bg-[#1e1e1e]">
          <div className="h-full w-1/3 animate-pulse rounded bg-[#0078d4]" />
        </div>
      )}
      {error !== null && <p role="alert" className="text-xs text-[#f14c4c]">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={btnCls} onClick={cancel}>Cancel</button>
        <button type="button" className={primaryCls} disabled={!canClone} onClick={clone}>Clone</button>
      </div>
    </div>
  )
}
