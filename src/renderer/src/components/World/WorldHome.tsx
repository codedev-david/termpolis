// The Lumopolis home: shown when no world is open. Four ways in (this project, a folder, a git
// repository, a new design) and the recent worlds below them. A world whose folder or design is gone
// shows "missing" and can only be removed (its files, if any, are left alone).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, MutableRefObject } from 'react'
import type { WorldEntry, WorldSource } from '../../../../shared/world/types'
import { CloneDialog } from './CloneDialog'
import { DesignStart } from './DesignStart'
import { missingNote, targetOf, UI_FAILED, whereOf } from './worldTargets'
import type { OpenTarget } from './worldTargets'
import { useUiZoom } from './worldPane'
import { stepFocus } from '../../hooks/useFocusTrap'

export { targetOf }
export type { OpenTarget }

export interface WorldHomeProps {
  entries: WorldEntry[]
  /** The active terminal's folder; empty when there is none (Map this project is then off). */
  projectCwd: string
  onOpen: (target: OpenTarget) => void
  /** The recent worlds changed (one added or removed): the pane reloads the list. */
  onChanged: () => void
  /** Tests pin the clock. */
  now?: number
  /** The pane's Esc, offered to the home first (WorldView): true when an open dialog took it. Set on every render. */
  escRef?: MutableRefObject<(() => boolean) | null>
  /** The last list main was asked for could not be read (useOpenWorld). */
  listError?: boolean
  /** useOpenWorld's ticket: an action that finishes after the pane moved to another world opens nothing (F-R4). */
  ticket?: () => () => boolean
  /** A dialog opened (true) or closed (false): the pane makes its toolbar inert meanwhile (F-R13). */
  onDialog?: (open: boolean) => void
  /** Set when the person pressed Choose another folder on a folder with nothing to map (WP4b F-R9): the home opens the
   *  folder picker as it mounts, once (it clears the mark), so what is picked, refused or cancelled is the home's own. */
  pickFolder?: MutableRefObject<boolean>
}

export const LIST_FAILED = "Lumopolis couldn't load your recent worlds."
const always = (): (() => boolean) => () => true

const ICONS: Record<WorldSource['kind'], { icon: string; label: string }> = {
  project: { icon: 'fa-diagram-project', label: 'Project' },
  folder: { icon: 'fa-folder', label: 'Folder' },
  git: { icon: 'fa-code-branch', label: 'Git repository' },
  design: { icon: 'fa-pen-ruler', label: 'Design' },
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function agoText(at: number, now: number): string {
  const s = Math.max(0, now - at) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return `${d} ${d === 1 ? 'day' : 'days'} ago`
}

/** The choices' grid: as many 15rem columns as fit (two at most in the home's 48rem), one when the pane is narrower. */
const CHOICE_GRID: CSSProperties = { gridTemplateColumns: 'repeat(auto-fit, minmax(min(15rem, 100%), 1fr))' }
const choiceCls = 'flex flex-col items-start gap-1 rounded-lg border border-[#3c3c3c] bg-[#1b2236] hover:bg-[#222b44] hover:border-[#4fc1ff]/60 px-4 py-3 text-left disabled:opacity-50 disabled:hover:bg-[#1b2236] disabled:hover:border-[#3c3c3c]'

export function WorldHome({ entries, projectCwd, onOpen, onChanged, now, escRef, listError = false, ticket = always, onDialog, pickFolder }: WorldHomeProps): JSX.Element {
  const zoom = useUiZoom()
  const [dialog, setDialog] = useState<'clone' | 'design' | null>(null)
  /** What the clone dialog starts with: a missing repository's address and branch, from its Clone again. */
  const [cloneFill, setCloneFill] = useState<{ url: string; branch: string }>({ url: '', branch: '' })
  const [error, setError] = useState<string | null>(null)
  // An open dialog dims the home behind it (a scrim over the cards), which is held at its top while the
  // dialog is up, so the dialog, placed near the top, is always in view and the scrim covers every card.
  const homeRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (dialog !== null) (homeRef.current as HTMLDivElement).scrollTop = 0
  }, [dialog])
  // While a dialog is up the home behind it is inert (Tab, clicks and a screen reader stay in the dialog) and the
  // pane makes its toolbar so too. Closed, the focus goes back to the choice that opened it (F-R13).
  const contentRef = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const onDialogRef = useRef(onDialog)
  onDialogRef.current = onDialog
  const open = dialog !== null
  useLayoutEffect(() => {
    if (!open) return
    const content = contentRef.current as HTMLDivElement
    const from = trigger.current
    content.inert = true
    onDialogRef.current?.(true)
    return () => {
      content.inert = false
      onDialogRef.current?.(false)
      if (from !== null && from.isConnected) from.focus()
    }
  }, [open])
  /** Tab and Shift+Tab go round the dialog on top: the trap moves the focus itself, so an inert dialog under it (the
   *  clone dialog under the token dialog) is never stepped into and the focus never leaves for the app around. */
  const trapTab = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return
    e.preventDefault()
    stepFocus(e.currentTarget, e.shiftKey)
  }
  // An action that opens a world when it is done opens it only while the pane is still where the person started it: a
  // world picked meanwhile (the switcher, a terminal) stays (F-R4). The ticket is taken when the person commits (R3):
  // Clone or Design it pressed, a folder chosen. Opening a dialog or the picker and backing out leaves an earlier open.
  const dialogTicket = useRef<() => boolean>(always())
  const committed = (): void => { dialogTicket.current = ticket() }
  // A world that finishes while the person is choosing (a dialog or the folder picker is up) waits for that choice, so
  // nothing pulls them out of it: a commit lapses it, and backing out opens it then, if nothing else moved the pane.
  const choosing = useRef(false)
  const waiting = useRef<{ still: () => boolean; target: OpenTarget } | null>(null)
  const openWhenFree = (still: () => boolean, target: OpenTarget): void => {
    if (!still()) return
    if (choosing.current) waiting.current = { still, target }
    else onOpen(target)
  }
  const free = (): void => {
    choosing.current = false
    const w = waiting.current
    waiting.current = null
    if (w !== null && w.still()) onOpen(w.target)
  }
  const openDialog = (which: 'clone' | 'design', fill = { url: '', branch: '' }): void => {
    setError(null)
    choosing.current = true
    setCloneFill(fill)
    setDialog(which)
  }
  const closeDialog = (): void => { setDialog(null); free() }
  const at = now ?? Date.now()
  // An open dialog takes the pane's Esc, wherever the focus is in the pane, and does its Cancel with it: the pane
  // stays open. The dialog sets what that is (dialogEsc) as it renders.
  const dialogEsc = useRef<(() => void) | null>(null)
  if (escRef) {
    escRef.current = () => {
      if (dialog === null) return false
      ;(dialogEsc.current as () => void)()
      return true
    }
  }

  /** Runs one home action: a failure shows main's friendly reason, a throw a fixed one. */
  const run = (fn: () => Promise<string | null>): void => {
    setError(null)
    fn().then((message) => { if (message !== null) setError(message) }, () => setError(UI_FAILED))
  }

  const mapProject = (): void => run(async () => {
    const still = ticket()
    const api = window.termpolis
    const found = await api.gitFindRoot(projectCwd)
    const root = found.success && found.data ? found.data : projectCwd
    const res = await api.worldMapProject(root)
    if (!res.success) return res.error
    onChanged()
    openWhenFree(still, { kind: 'root', root, follow: true })
    return null
  })

  // The folder picked is the person's newest choice, so it opens; a cancelled picker leaves an earlier open current (R3).
  const openFolder = (): void => run(async () => {
    choosing.current = true
    const res = await window.termpolis.worldOpenFolder().catch((e: unknown) => { free(); throw e })
    if (res.success && res.data !== null) ticket()
    free()
    if (!res.success) return res.error
    if (res.data === null) return null
    onChanged()
    onOpen(targetOf(res.data))
    return null
  })

  useEffect(() => {
    if (!pickFolder?.current) return
    pickFolder.current = false
    openFolder()
    // Once, as the home mounts: the mark is what asks, not a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const remove = (key: string): void => run(async () => {
    const res = await window.termpolis.worldRemoveSource(key)
    if (!res.success) return res.error
    onChanged()
    return null
  })

  const choices: { label: string; hint: string; icon: string; onClick: () => void; disabled?: boolean }[] = [
    { label: 'Map this project', hint: projectCwd ? 'The project open in the active terminal' : 'Open a terminal in a project first', icon: 'fa-diagram-project', onClick: mapProject, disabled: !projectCwd },
    { label: 'Open a folder…', hint: 'Any folder on this computer', icon: 'fa-folder-open', onClick: openFolder },
    { label: 'Open a git repository…', hint: 'Cloned into Termpolis, read-only', icon: 'fa-code-branch', onClick: () => openDialog('clone') },
    { label: 'Design something new', hint: 'Describe an app and see it planned', icon: 'fa-pen-ruler', onClick: () => openDialog('design') },
  ]

  return (
    <div ref={homeRef} data-testid="world-home" className={dialog === null ? 'overflow-auto' : 'overflow-hidden'} style={{ position: 'absolute', inset: 0 }}>
      <div ref={contentRef} data-testid="world-home-content" className="mx-auto max-w-3xl px-6 py-10 flex flex-col gap-6" style={zoom}>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-3xl font-semibold text-white inline-flex flex-wrap justify-center items-center gap-x-3">
            <i className="fa-solid fa-earth-americas text-[#4fc1ff]" aria-hidden="true" />
            Lumopolis
          </h1>
          <p className="text-sm text-[#9ca3af]">Where AI Worlds Become Human Understanding.</p>
        </div>
        {/* Two columns where the pane has room for them, one in a narrow pane: the pane's width, not the window's. */}
        <div className="grid gap-3" style={CHOICE_GRID}>
          {choices.map((c) => (
            <button key={c.label} type="button" className={choiceCls} onClick={(e) => { trigger.current = e.currentTarget; c.onClick() }} disabled={c.disabled}>
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-white">
                <i className={`fa-solid ${c.icon} text-[#4fc1ff]`} aria-hidden="true" />
                {c.label}
              </span>
              <span className="text-xs text-[#9ca3af]">{c.hint}</span>
            </button>
          ))}
        </div>
        {error !== null && <p role="alert" className="text-xs text-[#f14c4c] text-center">{error}</p>}
        <section className="flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wide text-[#9ca3af]">Recent worlds</h2>
          {listError && (
            <div data-testid="world-list-error" className="flex flex-wrap items-center gap-2 text-xs text-[#f0b429]">
              <span>{LIST_FAILED}</span>
              <button type="button" className="text-xs px-2 py-0.5 rounded border border-[#3c3c3c] text-[#d4d4d4] hover:bg-[#37373d]" onClick={onChanged}>Try again</button>
            </div>
          )}
          {entries.length === 0 ? (
            !listError && <p className="text-xs text-[#6b7280]">No worlds yet. Pick one of the choices above to make your first.</p>
          ) : (
            <ul aria-label="Recent worlds" className="flex flex-col gap-1">
              {entries.map((e) => {
                const kind = ICONS[e.source.kind]
                const where = whereOf(e)
                const repo = e.source.kind === 'git' ? e.source : null
                const body = (
                  <>
                    <i className={`fa-solid ${kind.icon} w-4 text-[#9ca3af]`} title={kind.label} aria-hidden="true" />
                    {/* The name, and where it is under it: two worlds can share a name (F-R12). */}
                    <span className="flex-1 min-w-0 flex flex-col">
                      <span className="truncate text-sm text-[#d4d4d4]">{e.title}</span>
                      {where !== '' && <span data-testid="world-where" title={where} className="truncate text-xs text-[#6b7280]">{where}</span>}
                    </span>
                    <span className="text-xs text-[#6b7280]">{agoText(e.lastOpened, at)}</span>
                  </>
                )
                return (
                  <li key={e.key} data-testid={`world-recent-${e.key}`}>
                    {e.missing ? (
                      <div className="flex flex-col gap-1 rounded px-3 py-2 border border-[#3c3c3c]">
                        <div className="flex items-center gap-3 opacity-80">
                          {body}
                          <span className="text-[11px] uppercase rounded px-1.5 py-0.5 bg-[#5a1d1d] text-[#f48771]">missing</span>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <span data-testid="world-missing-note" className="flex-1 min-w-0 text-xs text-[#9ca3af]">{missingNote(e.source)}</span>
                          {repo !== null && (
                            <button type="button" aria-label={`Clone ${e.title} again`} className="text-xs px-2 py-0.5 rounded border border-[#3c3c3c] hover:bg-[#37373d]" onClick={(ev) => { trigger.current = ev.currentTarget; openDialog('clone', { url: repo.url, branch: repo.ref ?? '' }) }}>Clone again</button>
                          )}
                          <button type="button" aria-label={`Remove ${e.title}`} className="text-xs px-2 py-0.5 rounded border border-[#3c3c3c] hover:bg-[#37373d]" onClick={() => remove(e.key)}>Remove</button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Open ${e.title}`}
                        className="w-full flex items-center gap-3 rounded px-3 py-2 border border-transparent hover:border-[#3c3c3c] hover:bg-[#1b2236] text-left"
                        onClick={() => onOpen(targetOf(e))}
                      >{body}</button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
      {/* Not positioned: the scrim and the dialogs place themselves in the home, as before. */}
      <div onKeyDown={trapTab}>
        {dialog !== null && <div data-testid="world-home-scrim" aria-hidden="true" className="absolute inset-0 z-10 bg-black/50" />}
        {dialog === 'clone' && (
          <CloneDialog
            initialUrl={cloneFill.url}
            initialBranch={cloneFill.branch}
            escRef={dialogEsc}
            onClose={closeDialog}
            onStart={committed}
            onKept={onChanged}
            onCloned={(entry) => { closeDialog(); onChanged(); if (dialogTicket.current()) onOpen(targetOf(entry)) }}
          />
        )}
        {dialog === 'design' && (
          <DesignStart
            escRef={dialogEsc}
            onClose={closeDialog}
            onStart={committed}
            onDrafted={(key) => { closeDialog(); onChanged(); if (dialogTicket.current()) onOpen({ kind: 'design', key }) }}
          />
        )}
      </div>
    </div>
  )
}
