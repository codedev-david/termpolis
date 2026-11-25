// Lumopolis: paste a token to open a private repository. The token lives only in this dialog's field:
// it is trimmed and checked here, handed to `onSubmit` once, and the field is emptied on submit, on
// cancel and when the dialog goes away. Nothing outside the dialog keeps it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { normalizeToken } from '../../../../shared/world/repoAccess'
import { btnCls, dialogCls, fieldCls, primaryCls } from './worldTargets'
import { useUiZoom } from './worldPane'
import { holdFocus, stepFocus } from '../../hooks/useFocusTrap'

export const TOKEN_PAGE_URL = 'https://github.com/settings/personal-access-tokens/new'

export interface RepoAccessDialogProps {
  host: string
  busy: boolean
  /** What the last try came back with (a refused token, say); the dialog stays open for another paste. */
  error: string | null
  onSubmit(value: string): void
  onCancel(): void
}

export function RepoAccessDialog({ host, busy, error, onSubmit, onCancel }: RepoAccessDialogProps): JSX.Element {
  const zoom = useUiZoom()
  const [value, setValue] = useState('')
  const [refused, setRefused] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  // Use this token greys while the token is tried: the dialog keeps the focus, so Tab and Esc still work in it.
  useLayoutEffect(() => {
    if (busy) holdFocus(dialog.current as HTMLDivElement)
  }, [busy])

  // The field is emptied when the dialog goes away, whatever closed it.
  useEffect(() => {
    const el = field.current as HTMLInputElement
    return () => { el.value = '' }
  }, [])

  const submit = (): void => {
    if (busy) return
    const checked = normalizeToken(value)
    if (!checked.ok) { setRefused(checked.error); return }
    setRefused(null)
    setValue('')
    onSubmit(checked.value)
  }

  const cancel = (): void => {
    setValue('')
    onCancel()
  }

  // Tab and Shift+Tab go round this dialog's own controls wherever it is opened, the home or the world view's notice
  // (WP-SRC N2), and stop here, so a trap around it never steps again. The trap moves the focus itself (stepFocus), as
  // the home's does: no unmount focus move, which useFocusTrap would make to the terminal.
  const trapTab = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return
    e.preventDefault()
    e.stopPropagation()
    stepFocus(e.currentTarget, e.shiftKey)
  }

  const shown = refused ?? error
  return (
    <div ref={dialog} tabIndex={-1} role="dialog" aria-label="Use a token" data-testid="world-repo-access" className={`${dialogCls} focus:outline-none`} style={zoom} onKeyDown={trapTab}>
      <h2 className="text-base font-semibold text-white">Use a token</h2>
      <p className="text-xs text-[#9ca3af]">
        A token is a key you make on {host === 'github.com' ? 'GitHub' : host} that lets Lumopolis read this one repository. Lumopolis uses it once and doesn't keep it.
      </p>
      {host === 'github.com' && (
        <button type="button" className={`${btnCls} self-start`} onClick={() => { void window.termpolis.openExternal(TOKEN_PAGE_URL) }}>
          Make a token on GitHub
        </button>
      )}
      <label className="flex flex-col gap-1 text-xs text-[#9ca3af]">
        Token
        <input
          ref={field}
          autoFocus
          type="password"
          autoComplete="off"
          spellCheck={false}
          data-testid="world-repo-access-input"
          value={value}
          onChange={(e) => { setValue(e.target.value); setRefused(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          className={fieldCls}
        />
      </label>
      {shown !== null && <p role="alert" className="text-xs text-[#f14c4c]">{shown}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btnCls} onClick={cancel}>Cancel</button>
        <button type="button" className={primaryCls} disabled={busy} onClick={submit}>Use this token</button>
      </div>
    </div>
  )
}
