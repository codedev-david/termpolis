// Which world the Lumopolis pane shows: the active terminal's project, a world the user chose (a
// folder, a clone or a design), or the home. The pane follows the active terminal's folder (`root`)
// until the user picks something else; while it follows, no folder means the home. "Map this
// project" follows the terminal again. A request (a terminal's globe, the `lumopolis` command, a folder in
// the file tree) opens that folder's project and stays on it. The recent worlds are reloaded whenever the
// world changes.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorldEntry } from '../../../../shared/world/types'
import { UPDATE_STOPPED_MESSAGE, type CloneNeedsLogin, type RepoAccess } from '../../../../shared/world/repoAccess'
import type { OpenTarget } from './worldTargets'

/** `project`: the folder came from a request, so it opens as its project (the git root) like a followed
 *  folder does, but the pane stays on it. */
export type OpenWorld = { kind: 'home' } | { kind: 'root'; root: string; follow: boolean; project?: true } | { kind: 'design'; key: string }

/** A folder someone asked the pane to show; `seq` grows with every ask, so the same folder asked twice is two asks. */
export interface WorldRequest { folder: string; seq: number }

/** A remembered repository that needs a sign-in before it can update; the saved copy keeps showing. */
/** notFound (R4): the host no longer finds the repository, so the notice says main's words and the sign-in choices are links. */
/** reason (WP4b F-R7): 'failed', the background update failed for another reason (main's words in `message`, with Try
 *  again); 'token', the repository was opened with a token, so it updates only when the person gives one. */
/** The interactive retry running: this computer's login, a token, or Try again with neither. */
export type RepoTry = 'machine' | 'token' | 'again'
export type RepoUpdate = { key: string; host: string; helper: boolean; message: string; notFound: boolean; reason?: 'failed' | 'token' } | null

export const REPO_UPDATE_UNREACHABLE = "Lumopolis couldn't update that repository. Try again."

export interface UseOpenWorld {
  world: OpenWorld
  open(target: OpenTarget): void
  goHome(): void
  /** Recent worlds, newest first (empty until main answers). */
  entries: WorldEntry[]
  /** The last list main was asked for could not be read: the home says so, with Try again, instead of "No worlds yet". */
  listError: boolean
  refresh(): void
  /** Taken when an action starts that will open a world once it is done (the home's Map this project, a clone): it
   *  says false once the pane has moved to another world meanwhile, a newer action has started, or the pane closed, so
   *  the older action no longer opens one. */
  ticket(): () => boolean
  /** Set when the background update of the opened repository needs a sign-in. */
  repoUpdate: RepoUpdate
  /** An interactive retry (Sign in, Use a token, Try again) is running. */
  repoBusy: boolean
  /** Which retry is running, so the notice can say what it is doing (WP4b fix round 1, M5); null when none is. */
  repoTry: RepoTry | null
  /** The person asked that retry to stop, and its answer has not come yet. */
  repoStopping: boolean
  /** What the last interactive retry came back with, for the token dialog. */
  repoError: string | null
  /** Grows each time an update brought new files down, so the view recompiles. */
  repoChanged: number
  /** Retry the update with this computer's login (the person may see a window). */
  signIn(): void
  /** Retry the update with a token; it goes straight into the call and is kept nowhere. */
  useToken(value: string): void
  /** Run a failed update again, the way the background one ran. */
  tryAgain(): void
  /** Stop the retry that is running (WP4b F-R6): its answer then says it stopped, unless it had already updated. */
  stopRepoUpdate(): void
  dismissRepoUpdate(): void
  clearRepoError(): void
}

const needsOf = ({ needsLogin: n }: CloneNeedsLogin): { host: string; helper: boolean; message: string; notFound: boolean } =>
  ({ host: n.host, helper: n.helper, message: n.message, notFound: n.notFound === true })

/** The host of a git address (https://, ssh:// or git@host:path), for the token dialog's words; '' when there is none. */
const repoHost = (url: string): string => {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/]+)/i.exec(url)
  if (scheme) return scheme[1]
  const scp = /^[^@/:]+@([^:/]+):/.exec(url)
  return scp ? scp[1] : ''
}

const fromRoot = (root: string): OpenWorld => (root ? { kind: 'root', root, follow: true } : { kind: 'home' })
const fromRequest = (r: WorldRequest): OpenWorld => ({ kind: 'root', root: r.folder, follow: false, project: true })

/** A string that changes exactly when the open world does. */
export const worldId = (w: OpenWorld): string =>
  w.kind === 'home' ? 'home' : w.kind === 'design' ? `design ${w.key}` : `root ${w.follow ? 1 : w.project ? 2 : 0} ${w.root}`

export function useOpenWorld(root: string, request?: WorldRequest): UseOpenWorld {
  const [world, setWorld] = useState<OpenWorld>(() => (request ? fromRequest(request) : fromRoot(root)))
  const [entries, setEntries] = useState<WorldEntry[]>([])
  const [listError, setListError] = useState(false)
  /** Grows with every list asked for: only the newest answer is shown (two can land out of order). */
  const listSeq = useRef(0)
  /** Grows with every move to another world (open, home, a request, a followed cd) and with every ticket taken: what a
   *  ticket checks. */
  const moves = useRef(0)
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
    if (following.current) { moves.current++; setWorld(fromRoot(root)) }
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
    moves.current++
    setWorld(fromRequest(r))
  }, [seq])

  const [repoUpdate, setRepoUpdate] = useState<RepoUpdate>(null)
  const [repoTry, setRepoTry] = useState<RepoTry | null>(null)
  const repoBusy = repoTry !== null
  const [repoStopping, setRepoStopping] = useState(false)
  const [repoError, setRepoError] = useState<string | null>(null)
  const [repoChanged, setRepoChanged] = useState(0)
  /** The registered world the person is on; an answer for another one is dropped. */
  const openKey = useRef<string | null>(null)
  /** The retry running now (its repository's key and whether the person stopped it), if any. */
  const retrying = useRef<{ key: string; stopped: boolean } | null>(null)
  /** The id of the world the pane is on that `openKey` belongs to; any other world drops the repo state. */
  const ownedId = useRef(worldId(world))
  const clearRepo = (key: string | null, id: string): void => {
    // A try for the world being left stops: its answer would be dropped, and a sign-in window would be left for a
    // world nobody is on (WP4b F-R6).
    const run = retrying.current
    if (run !== null) {
      retrying.current = null
      setRepoTry(null)
      setRepoStopping(false)
      if (!run.stopped) window.termpolis.worldUpdateCancel(run.key).catch(() => undefined)
    }
    openKey.current = key
    ownedId.current = id
    setRepoUpdate(null)
    setRepoError(null)
  }

  const refresh = useCallback((): void => {
    const mine = ++listSeq.current
    const newest = (): boolean => live.current && listSeq.current === mine
    // A list that could not be read keeps the one shown, and says so (main logs why).
    window.termpolis.worldSourcesList().then(
      (res) => {
        if (!newest()) return
        if (res.success) setEntries(res.data)
        setListError(!res.success)
      },
      () => { if (newest()) setListError(true) },
    )
  }, [])

  // Taking a ticket is starting an action: every older action still on its way lapses, so only the person's newest
  // choice can move the pane (F-R4).
  const ticket = useCallback((): (() => boolean) => {
    const at = ++moves.current
    return () => live.current && moves.current === at
  }, [])

  // A registered world being opened (from the home, the switcher or a dialog) is marked opened now, and
  // the list reloads once main has saved that, so "last opened" and the newest-first order stay true.
  const open = useCallback((t: OpenTarget): void => {
    following.current = t.kind === 'root' && t.follow === true
    moves.current++
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
        if (!e || e.source.kind !== 'git') return
        const host = repoHost(e.source.url)
        // A repository opened with this computer's login updates once, quietly; one opened with a token only when the
        // person gives one, so the notice offers that (WP4b F-R7).
        if (e.source.login !== 'token') updateInBackground(e.key, host)
        else if (live.current && openKey.current === e.key) setRepoUpdate({ key: e.key, host, helper: false, message: '', notFound: false, reason: 'token' })
      })
    }
  }, [refresh])

  // A failed update is said, with main's words and Try again (WP4b F-R7); one the person stopped elsewhere is not.
  const updateInBackground = (key: string, host: string): void => {
    const here = (): boolean => live.current && openKey.current === key
    const failed = (message: string): void => setRepoUpdate({ key, host, helper: false, message, notFound: false, reason: 'failed' })
    window.termpolis.worldUpdateSource(key).then((res) => {
      if (!here()) return
      if (!res.success) { if (res.error !== UPDATE_STOPPED_MESSAGE) failed(res.error); return }
      if ('needsLogin' in res.data) setRepoUpdate({ key, ...needsOf(res.data) })
      else if ('changed' in res.data && res.data.changed) setRepoChanged((n) => n + 1)
    }, () => { if (here()) failed(REPO_UPDATE_UNREACHABLE) })
  }

  /** An interactive retry for the repository the notice is about; no access runs it the background way (Try again). */
  const retry = (access?: RepoAccess): void => {
    if (!repoUpdate || retrying.current) return
    const shown = repoUpdate
    const key = shown.key
    const run = { key, stopped: false }
    retrying.current = run
    setRepoTry(access ? access.mode : 'again')
    setRepoError(null)
    // Only this try's own answer counts: one left behind by a world change (clearRepo) touches nothing.
    const finish = (): boolean => {
      if (retrying.current !== run) return false
      retrying.current = null
      if (!live.current) return false
      setRepoTry(null)
      setRepoStopping(false)
      return true
    }
    // A stopped try says it stopped, whatever main answered; one that had already updated is kept.
    const failed = (message: string): void => setRepoError(run.stopped ? UPDATE_STOPPED_MESSAGE : message)
    const call = access ? window.termpolis.worldUpdateSource(key, access) : window.termpolis.worldUpdateSource(key)
    call.then((res) => {
      if (!finish()) return
      if (!res.success) failed(res.error)
      else if ('needsLogin' in res.data) {
        const needs = needsOf(res.data)
        if (shown.reason === 'failed') {
          // Try again met a sign-in: the notice becomes the sign-in notice.
          setRepoUpdate({ key, ...needs })
          if (run.stopped) failed('')
        } else {
          // The notice keeps saying why it is there; what this try met goes under it (R4).
          setRepoUpdate({ ...needs, key, message: shown.message, notFound: shown.notFound, ...(shown.reason ? { reason: shown.reason } : {}) })
          failed(res.data.needsLogin.message)
        }
      }
      else {
        setRepoUpdate(null)
        if ('changed' in res.data && res.data.changed) setRepoChanged((n) => n + 1)
      }
    }, () => { if (finish()) failed(REPO_UPDATE_UNREACHABLE) })
  }
  const signIn = (): void => retry({ mode: 'machine' })
  const useToken = (value: string): void => retry({ mode: 'token', value })
  const tryAgain = (): void => { if (repoUpdate?.reason === 'failed') retry() }
  const stopRepoUpdate = (): void => {
    const run = retrying.current
    if (run === null || run.stopped) return
    run.stopped = true
    setRepoStopping(true)
    window.termpolis.worldUpdateCancel(run.key).catch(() => undefined)
  }
  const dismissRepoUpdate = (): void => setRepoUpdate(null)
  const clearRepoError = (): void => setRepoError(null)

  const goHome = useCallback((): void => {
    following.current = false
    moves.current++
    clearRepo(null, worldId({ kind: 'home' }))
    setWorld({ kind: 'home' })
  }, [])

  const id = worldId(world)
  // A world that came from somewhere else (a request, a cd) is not the one a pending update or notice belongs to.
  useEffect(() => { if (id !== ownedId.current) clearRepo(null, id) }, [id])
  useEffect(() => { refresh() }, [id, refresh])

  return { world, open, goHome, entries, listError, refresh, ticket, repoUpdate, repoBusy, repoTry, repoStopping, repoError, repoChanged, signIn, useToken, tryAgain, stopRepoUpdate, dismissRepoUpdate, clearRepoError }
}
