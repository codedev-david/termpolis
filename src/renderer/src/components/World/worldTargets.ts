// What the Lumopolis pane can open, shared by the home, the switcher and the pane itself.
import type { WorldEntry } from '../../../../shared/world/types'

/**
 * A world to open: a folder (a project, a chosen folder or a clone) or a design. `follow`: the world
 * is the active terminal's project, so the pane keeps following that terminal's folder. `key`: the
 * recent world being reopened, marked opened now when the pane opens it.
 */
export type OpenTarget = { kind: 'root'; root: string; follow?: boolean; key?: string } | { kind: 'design'; key: string }

/** Shown when a call could not even reach main: never the raw error. */
export const UI_FAILED = "Lumopolis couldn't do that. Try again."

/** Where a recent world opens: a design by its key, every other world by its folder. */
export function targetOf(entry: WorldEntry): OpenTarget {
  const s = entry.source
  return s.kind === 'design' ? { kind: 'design', key: entry.key } : { kind: 'root', root: s.root, key: entry.key }
}

/** Where a recent world is, for the line under its name (F-R12: names are folder names, so two `api` folders, or two
 *  branches of one repository, look alike): a folder's parent folder, a repository's address and branch, nothing
 *  for a design. */
export function whereOf(entry: WorldEntry): string {
  const s = entry.source
  if (s.kind === 'design') return ''
  if (s.kind === 'git') return s.ref ? `${s.url} · ${s.ref}` : s.url
  const root = s.root.replace(/[\\/]+$/, '')
  const cut = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'))
  if (cut < 0) return ''
  const parent = root.slice(0, cut)
  // The top of a drive or the file system keeps its separator: "C:/", "/".
  return parent === '' || parent.endsWith(':') ? root.slice(0, cut + 1) : parent
}

// The height bound keeps Cancel and the main button on screen in a short pane: the pane less the top-24 offset
// (96px) and a 12px margin below. Past that the dialog scrolls inside itself.
export const dialogCls = 'absolute left-1/2 top-24 -translate-x-1/2 z-10 w-[32rem] max-w-[calc(100%-24px)] max-h-[calc(100%-108px)] overflow-y-auto rounded-lg border border-[#3c3c3c] bg-[#252526] shadow-2xl p-4 flex flex-col gap-3 text-sm text-[#d4d4d4]'
// A dialog's buttons never break their label over two lines ("Design it" did in a 768 px window): a row
// too narrow for them wraps whole buttons instead (flex-wrap on each dialog's button row).
export const btnCls = 'text-xs whitespace-nowrap min-w-[4.5rem] px-3 py-1.5 rounded border border-[#3c3c3c] hover:bg-[#37373d] disabled:opacity-50 disabled:hover:bg-transparent'
export const primaryCls = 'text-xs whitespace-nowrap min-w-[4.5rem] px-3 py-1.5 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white disabled:opacity-50 disabled:hover:bg-[#0078d4]'
// A secondary choice: a text link beside the dialog's buttons, for a step that may not be the remedy (F-R8: sign in
// when the host only said it could not find the repository).
export const linkCls = 'text-xs whitespace-nowrap px-1 py-1.5 text-[#4fc1ff] underline hover:text-white disabled:opacity-50 disabled:hover:text-[#4fc1ff]'
export const fieldCls = 'w-full rounded border border-[#3c3c3c] bg-[#1e1e1e] px-2 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#0078d4] disabled:opacity-60'

/** The label of the "sign in with this computer's login" button. */
export function signInLabel(host: string): string {
  return host === 'github.com' ? 'Sign in to GitHub' : 'Sign in'
}
