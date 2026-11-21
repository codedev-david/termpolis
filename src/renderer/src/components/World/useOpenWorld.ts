// Which world the Lumopolis pane shows: the active terminal's project, a world the user chose (a
// folder, a clone or a design), or the home. The pane follows the active terminal's folder (`root`)
// until the user picks something else; while it follows, no folder means the home. "Map this
// project" follows the terminal again. A request (a terminal's globe, the `lumopolis` command, a folder in
// the file tree) opens that folder's project and stays on it. The recent worlds are reloaded whenever the
// world changes.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorldEntry } from '../../../../shared/world/types'
import type { CloneNeedsLogin, RepoAccess } from '../../../../shared/world/repoAccess'
import type { OpenTarget } from './worldTargets'

/** `project`: the folder came from a request, so it opens as its project (the git root) like a followed
 *  folder does, but the pane stays on it. */
export type OpenWorld = { kind: 'home' } | { kind: 'root'; root: string; follow: boolean; project?: true } | { kind: 'design'; key: string }

/** A folder someone asked the pane to show; `seq` grows with every ask, so the same folder asked twice is two asks. */
export interface WorldRequest { folder: string; seq: number }

/** A remembered repository that needs a sign-in before it can update; the saved copy keeps showing. */
export type RepoUpdate = { key: string; host: string; helper: boolean; message: string } | null

export const REPO_UPDATE_UNREACHABLE = "Lumopolis couldn't update that repository. Try again."

export interface UseOpenWorld {
  world: OpenWorld
  open(target: OpenTarget): void
  goHome(): void
  /** Recent worlds, newest first (empty until main answers). */
  entries: WorldEntry[]
  refresh(): void
  /** Set when the background update of the opened repository needs a sign-in. */
  repoUpdate: RepoUpdate
  /** An interactive retry (Sign in, Use a token) is running. */
  repoBusy: boolean
  /** What the last interactive retry came back with, for the token dialog. */
  repoError: string | null
  /** Grows each time an update brought new files down, so the view recompiles. */
  repoChanged: number
  /** Retry the update with this computer's login (the person may see a window). */
  signIn(): void
  /** Retry the update with a token; it goes straight into the call and is kept nowhere. */
  useToken(value: string): void
  dismissRepoUpdate(): void
  clearRepoError(): void
}

const needsOf = (d: CloneNeedsLogin): { host: string; helper: boolean; message: string } => d.needsLogin

const fromRoot = (root: string): OpenWorld => (root ? { kind: 'root', root, follow: true } : { kind: 'home' })
const fromRequest = (r: WorldRequest): OpenWorld => ({ kind: 'root', root: r.folder, follow: false, project: true })

/** A string that changes exactly when the open world does. */
export const worldId = (w: OpenWorld): string =>
  w.kind === 'home' ? 'home' : w.kind === 'design' ? `design ${w.key}` : `root ${w.follow ? 1 : w.project ? 2 : 0} ${w.root}`

export function useOpenWorld(root: string, request?: WorldRequest): UseOpenWorld {
  const [world, setWorld] = useState<OpenWorld>(() => (request ? fromRequest(request) : fromRoot(root)))
  const [entries, setEntries] = useState<WorldEntry[]>([])
  /** The list as last shown, for `open`, which outlives a render. */
  const shownEntries = useRef(entries)
  shownEntries.current = entries
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

  const [repoUpdate, setRepoUpdate] = useState<RepoUpdate>(null)
  const [repoBusy, setRepoBusy] = useState(false)
  const [repoError, setRepoError] = useState<string | null>(null)
  const [repoChanged, setRepoChanged] = useState(0)
  /** The registered world the person is on; an answer for another one is dropped. */
  const openKey = useRef<string | null>(null)
  const retrying = useRef(false)
  /** The id of the world the pane is on that `openKey` belongs to; any other world drops the repo state. */
  const ownedId = useRef(worldId(world))
  const clearRepo = (key: string | null, id: string): void => {
    openKey.current = key
    ownedId.current = id
    setRepoUpdate(null)
    setRepoError(null)
  }

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
    const next: OpenWorld = t.kind === 'root' ? { kind: 'root', root: t.root, follow: following.current } : { kind: 'design', key: t.key }
    setWorld(next)
    clearRepo(t.key ?? null, worldId(next))
    if (t.key) {
      const key = t.key
      // A touch main could not save (the registry file held open, a full disk; main logs why) only loses "last
      // opened": the update still runs, from the entry the pane shows, so a lapsed login still shows "Sign in needed".
      const shown = (): WorldEntry | null => shownEntries.current.find((x) => x.key === key) ?? null
      window.termpolis.worldTouchSource(key).then((res) => {
        refresh()
        return res.success ? res.data : shown()
      }, shown).then((e) => {
        // A repository opened with this computer's login updates once, quietly; one opened with a token only when asked.
        if (e && e.source.kind === 'git' && e.source.login !== 'token') updateInBackground(e.key)
      })
    }
  }, [refresh])

  const updateInBackground = (key: string): void => {
    window.termpolis.worldUpdateSource(key).then((res) => {
      if (!live.current || openKey.current !== key || !res.success) return
      if ('needsLogin' in res.data) setRepoUpdate({ key, ...needsOf(res.data) })
      else if ('changed' in res.data && res.data.changed) setRepoChanged((n) => n + 1)
    }, () => undefined)
  }

  /** An interactive retry for the repository the notice is about. */
  const retry = (access: RepoAccess): void => {
    if (!repoUpdate || retrying.current) return
    const key = repoUpdate.key
    retrying.current = true
    setRepoBusy(true)
    setRepoError(null)
    const finish = (): boolean => {
      retrying.current = false
      if (!live.current) return false
      setRepoBusy(false)
      return openKey.current === key
    }
    window.termpolis.worldUpdateSource(key, access).then((res) => {
      if (!finish()) return
      if (!res.success) setRepoError(res.error)
      else if ('needsLogin' in res.data) { setRepoUpdate({ key, ...needsOf(res.data) }); setRepoError(res.data.needsLogin.message) }
      else {
        setRepoUpdate(null)
        if ('changed' in res.data && res.data.changed) setRepoChanged((n) => n + 1)
      }
    }, () => { if (finish()) setRepoError(REPO_UPDATE_UNREACHABLE) })
  }
  const signIn = (): void => retry({ mode: 'machine' })
  const useToken = (value: string): void => retry({ mode: 'token', value })
  const dismissRepoUpdate = (): void => setRepoUpdate(null)
  const clearRepoError = (): void => setRepoError(null)

  const goHome = useCallback((): void => {
    following.current = false
    clearRepo(null, worldId({ kind: 'home' }))
    setWorld({ kind: 'home' })
  }, [])

  const id = worldId(world)
  // A world that came from somewhere else (a request, a cd) is not the one a pending update or notice belongs to.
  useEffect(() => { if (id !== ownedId.current) clearRepo(null, id) }, [id])
  useEffect(() => { refresh() }, [id, refresh])

  return { world, open, goHome, entries, refresh, repoUpdate, repoBusy, repoError, repoChanged, signIn, useToken, dismissRepoUpdate, clearRepoError }
}
