// Which world the Lumopolis pane shows: the active terminal's project, a world the user chose (a
// folder, a clone or a design), or the home. The pane follows the active terminal's folder (`root`)
// until the user picks something else; while it follows, no folder means the home. "Map this
// project" follows the terminal again. A request (a terminal's globe, the `lumopolis` command, a folder in
// the file tree) opens that folder's project and stays on it. The recent worlds are reloaded whenever the
// world changes.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorldEntry } from '../../../../shared/world/types'
import type { OpenTarget } from './worldTargets'

/** `project`: the folder came from a request, so it opens as its project (the git root) like a followed
 *  folder does, but the pane stays on it. */
export type OpenWorld = { kind: 'home' } | { kind: 'root'; root: string; follow: boolean; project?: true } | { kind: 'design'; key: string }

/** A folder someone asked the pane to show; `seq` grows with every ask, so the same folder asked twice is two asks. */
export interface WorldRequest { folder: string; seq: number }

export interface UseOpenWorld {
  world: OpenWorld
  open(target: OpenTarget): void
  goHome(): void
  /** Recent worlds, newest first (empty until main answers). */
  entries: WorldEntry[]
  refresh(): void
}

const fromRoot = (root: string): OpenWorld => (root ? { kind: 'root', root, follow: true } : { kind: 'home' })
const fromRequest = (r: WorldRequest): OpenWorld => ({ kind: 'root', root: r.folder, follow: false, project: true })

/** A string that changes exactly when the open world does. */
export const worldId = (w: OpenWorld): string =>
  w.kind === 'home' ? 'home' : w.kind === 'design' ? `design ${w.key}` : `root ${w.follow ? 1 : w.project ? 2 : 0} ${w.root}`

export function useOpenWorld(root: string, request?: WorldRequest): UseOpenWorld {
  const [world, setWorld] = useState<OpenWorld>(() => (request ? fromRequest(request) : fromRoot(root)))
  const [entries, setEntries] = useState<WorldEntry[]>([])
  const following = useRef(!request)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  // A cd in the active terminal (or another terminal made active) moves a following pane along.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (following.current) setWorld(fromRoot(root))
  }, [root])

  // A request while the pane is open: that folder's project, kept (a cd no longer moves the pane).
  const seq = request ? request.seq : 0
  const asked = useRef(seq)
  const latest = useRef(request)
  latest.current = request
  useEffect(() => {
    const r = latest.current
    if (seq === asked.current || !r) return
    asked.current = seq
    following.current = false
    setWorld(fromRequest(r))
  }, [seq])

  const refresh = useCallback((): void => {
    window.termpolis.worldSourcesList().then(
      (res) => { if (live.current && res.success) setEntries(res.data) },
      () => undefined,
    )
  }, [])

  // A registered world being opened (from the home, the switcher or a dialog) is marked opened now, and
  // the list reloads once main has saved that, so "last opened" and the newest-first order stay true.
  const open = useCallback((t: OpenTarget): void => {
    following.current = t.kind === 'root' && t.follow === true
    setWorld(t.kind === 'root' ? { kind: 'root', root: t.root, follow: following.current } : { kind: 'design', key: t.key })
    if (t.key) window.termpolis.worldTouchSource(t.key).then(refresh, () => undefined)
  }, [refresh])

  const goHome = useCallback((): void => {
    following.current = false
    setWorld({ kind: 'home' })
  }, [])

  const id = worldId(world)
  useEffect(() => { refresh() }, [id, refresh])

  return { world, open, goHome, entries, refresh }
}
