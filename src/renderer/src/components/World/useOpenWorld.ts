// Which world the Lumopolis pane shows: the active terminal's project, a world the user chose (a
// folder, a clone or a design), or the home. The pane follows the active terminal's folder (`root`)
// until the user picks something else; while it follows, no folder means the home. "Map this
// project" follows the terminal again. The recent worlds are reloaded whenever the world changes.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorldEntry } from '../../../../shared/world/types'
import type { OpenTarget } from './worldTargets'

export type OpenWorld = { kind: 'home' } | { kind: 'root'; root: string; follow: boolean } | { kind: 'design'; key: string }

export interface UseOpenWorld {
  world: OpenWorld
  open(target: OpenTarget): void
  goHome(): void
  /** Recent worlds, newest first (empty until main answers). */
  entries: WorldEntry[]
  refresh(): void
}

const fromRoot = (root: string): OpenWorld => (root ? { kind: 'root', root, follow: true } : { kind: 'home' })

/** A string that changes exactly when the open world does. */
export const worldId = (w: OpenWorld): string =>
  w.kind === 'home' ? 'home' : w.kind === 'design' ? `design ${w.key}` : `root ${w.follow ? 1 : 0} ${w.root}`

export function useOpenWorld(root: string): UseOpenWorld {
  const [world, setWorld] = useState<OpenWorld>(() => fromRoot(root))
  const [entries, setEntries] = useState<WorldEntry[]>([])
  const following = useRef(true)
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
