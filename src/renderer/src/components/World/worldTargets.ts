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

export const dialogCls = 'absolute left-1/2 top-24 -translate-x-1/2 z-10 w-[32rem] max-w-[calc(100%-24px)] rounded-lg border border-[#3c3c3c] bg-[#252526] shadow-2xl p-4 flex flex-col gap-3 text-sm text-[#d4d4d4]'
export const btnCls = 'text-xs px-3 py-1.5 rounded border border-[#3c3c3c] hover:bg-[#37373d] disabled:opacity-50 disabled:hover:bg-transparent'
export const primaryCls = 'text-xs px-3 py-1.5 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white disabled:opacity-50 disabled:hover:bg-[#0078d4]'
export const fieldCls = 'w-full rounded border border-[#3c3c3c] bg-[#1e1e1e] px-2 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#0078d4] disabled:opacity-60'
