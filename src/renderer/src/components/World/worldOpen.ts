// How anything outside the Lumopolis pane opens it, and how App keeps the pane's open state.
//
// Every opener dispatches one window event, `termpolis:openWorld`. Without a folder (the sidebar, the
// palette's Open Lumopolis, Ctrl+Shift+R) the pane follows the active terminal's folder. With one (a
// terminal's globe, the `lumopolis` shell command, a folder in the file tree) the pane opens that
// folder's project and stays on it; the active terminal never changes. Small and engine-free: App and
// the sidebar import it into the main chunk.
import { useCallback, useEffect, useState } from 'react'
import type { WorldRequest } from './useOpenWorld'

export const OPEN_WORLD_EVENT = 'termpolis:openWorld'
/** Dispatched when the pane opens, so the sidebar's New badge and first-run hint go at once. */
export const WORLD_OPENED_EVENT = 'termpolis:worldOpened'
/** Dispatched when Settings ▸ Lumopolis ▸ Show frame rate flips (detail: the new value), so an open map shows or hides its readout. */
export const FRAME_RATE_EVENT = 'termpolis:worldFrameRate'

/** Dispatched for LumopolisNotice (App): one short line about a `lumopolis` request, with an Open button when it names a folder. */
export const LUMOPOLIS_NOTICE_EVENT = 'termpolis:lumopolisNotice'
/** Dispatched when a terminal prints the zsh ready mark live (detail: its id), so the sidebar can ask main again about a
 *  terminal it was told cannot take `lumopolis` (#29, holdb-review M3). */
export const LUMOPOLIS_READY_EVENT = 'termpolis:lumopolisReady'

export interface LumopolisNotice {
  message: string
  /** The folder the notice's Open button maps; none: the notice only tells. */
  folder?: string
}

/** Shows a notice: main's refusal of a `lumopolis` request, or a request from a terminal that is not the active one. */
export function showLumopolisNotice(notice: LumopolisNotice): void {
  window.dispatchEvent(new CustomEvent(LUMOPOLIS_NOTICE_EVENT, { detail: notice }))
}

/** Opens the pane: on `folder`'s project when one is given, else following the active terminal. */
export function openLumopolis(folder?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_WORLD_EVENT, folder ? { detail: { folder } } : undefined))
}

/** A folder's own name for a label: its last part (`C:\repo\app` → app); a drive or root names itself. */
export function folderName(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, '')
  if (trimmed === '') return folder // `/`
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\` // `C:\`
  return trimmed.split(/[\\/]/).pop() as string
}

/** `name` inside `folder`, with the separator `folder` already uses (`C:\repo` + app → `C:\repo\app`). */
export function childFolder(folder: string, name: string): string {
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/'
  return `${folder.replace(/[\\/]+$/, '')}${sep}${name}`
}

/** The folder an open event asks for, or undefined. */
export function folderOfEvent(e: Event): string | undefined {
  const detail = (e as CustomEvent<unknown>).detail
  const folder = detail && typeof detail === 'object' ? (detail as { folder?: unknown }).folder : undefined
  return typeof folder === 'string' && folder.trim() !== '' ? folder : undefined
}

export interface WorldPane {
  show: boolean
  /** The folder last asked for while the pane is open; undefined: it follows the active terminal. */
  request: WorldRequest | undefined
  close(): void
  toggle(): void
  /** Opens the pane following the active terminal (a pane already open stays on what it shows). */
  open(): void
}

/** App's pane state, listening for `termpolis:openWorld`. Closing forgets the request: the next plain open follows the terminal again. */
export function useWorldPane(): WorldPane {
  const [show, setShow] = useState(false)
  const [request, setRequest] = useState<WorldRequest | undefined>(undefined)
  const close = useCallback(() => { setShow(false); setRequest(undefined) }, [])
  const open = useCallback(() => setShow(true), [])
  const toggle = useCallback(() => setShow((v) => !v), [])
  // A closed pane forgets its request, however it closed (kept out of the setShow updater, which must stay pure).
  useEffect(() => { if (!show) setRequest(undefined) }, [show])
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const folder = folderOfEvent(e)
      if (folder) setRequest((r) => ({ folder, seq: (r ? r.seq : 0) + 1 }))
      setShow(true)
    }
    window.addEventListener(OPEN_WORLD_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_WORLD_EVENT, onOpen)
  }, [])
  return { show, request, close, toggle, open }
}
