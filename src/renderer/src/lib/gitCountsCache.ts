// One git status poll per REPO, not per terminal.
//
// Every terminal carries a git dot, and each dot used to own its own 5s subscription
// keyed by terminal id. Ten terminals open on one repo therefore spawned ten identical
// `git status` processes every five seconds — and on Windows each spawn costs ~100-300ms
// of pure process-creation tax on the thread that also pumps every PTY. The repo does
// not have ten different answers, so nine of those ten were waste that scaled with how
// many terminals you had open rather than with how many repos you were working in.
//
// Deliberately NOT a TTL cache. A cache would buy the same reduction by handing out
// staler answers, which is the wrong trade for a liveness indicator. Instead the WATCHERS
// share one poller: the repo is still asked exactly every POLL_MS, and every dot on it
// receives that same fresh answer. Spawns drop from N-per-repo to one; staleness is
// unchanged.

import { subscribe, unsubscribe } from './pollingService'
import { watchRepoChanges } from './gitWatch'
import type { GitChangeCounts } from '../types'

/**
 * The SAFETY NET, not the mechanism.
 *
 * v1.47.1: main watches the repo (see src/main/gitWatcher.ts) and pushes an invalidation the instant
 * anything changes, so the dot is now FASTER than the old 5 s poll for every change it sees. This
 * timer only covers what a watcher cannot — a network share, a platform without recursive watch, an
 * inotify budget already spent — and at 5 s it was spawning a git process per repo, forever, to
 * discover nothing had happened.
 */
export const COUNTS_POLL_MS = 15000

type Watcher = (counts: GitChangeCounts | null) => void

interface RepoWatch {
  watchers: Set<Watcher>
  /** Last answer, so a terminal joining a watched repo doesn't stare at the inert glyph. */
  last: GitChangeCounts | null
  /** Whether `last` is an answer at all, as opposed to "nothing has come back yet". */
  answered: boolean
  /** In flight — a second caller in the same tick joins it instead of spawning again. */
  inFlight: Promise<void> | null
  /** Tears down the repo watch when the last dot on this repo goes away. */
  unwatch?: () => void
}

const repos = new Map<string, RepoWatch>()

/** Drop all shared pollers. Exported for test isolation only. */
export function resetCountsRegistry(): void {
  for (const [cwd, watch] of repos) {
    unsubscribe(pollId(cwd))
    watch.unwatch?.()
  }
  repos.clear()
}

function pollId(cwd: string): string {
  return `git-counts-${cwd}`
}

function refresh(cwd: string, watch: RepoWatch): Promise<void> {
  if (watch.inFlight) return watch.inFlight

  const get = window.termpolis?.gitChangeCounts
  // Checked synchronously: starting a promise we cannot use would land a callback
  // after teardown in any host that has no bridge (tests, the pre-preload first paint).
  if (typeof get !== 'function') return Promise.resolve()

  const run = get(cwd)
    .then(res => {
      watch.last = res?.success ? res.data ?? null : null
    })
    .catch(() => {
      watch.last = null
    })
    .then(() => {
      watch.answered = true
      watch.inFlight = null
      // Snapshot: a watcher is free to unsubscribe from inside its own callback.
      for (const w of [...watch.watchers]) {
        if (watch.watchers.has(w)) {
          try { w(watch.last) } catch { /* one bad watcher must not starve the rest */ }
        }
      }
    })

  watch.inFlight = run
  return run
}

/**
 * Watch `cwd`'s git counts. Returns an unsubscribe function.
 *
 * The first watcher of a repo starts the shared poll and triggers an immediate fetch;
 * later watchers get the answer already on hand and then ride the same poll.
 */
export function subscribeCounts(cwd: string, onCounts: Watcher): () => void {
  if (!cwd) return () => {}

  let watch = repos.get(cwd)
  if (!watch) {
    watch = { watchers: new Set(), last: null, answered: false, inFlight: null }
    repos.set(cwd, watch)
    watch.watchers.add(onCounts)
    subscribe(pollId(cwd), () => {
      const live = repos.get(cwd)
      if (live) void refresh(cwd, live)
    }, COUNTS_POLL_MS)
    // Same callback, pushed instead of polled. refresh() is already single-flighted, so a burst of
    // filesystem events collapses into one git process exactly as a burst of ticks would.
    watch.unwatch = watchRepoChanges(cwd, () => {
      const live = repos.get(cwd)
      if (live) void refresh(cwd, live)
    })
    void refresh(cwd, watch)
  } else {
    watch.watchers.add(onCounts)
    // Only once there IS an answer — otherwise a late joiner would be told "not a repo"
    // on the strength of a poll that hasn't come back yet.
    if (watch.answered) {
      try { onCounts(watch.last) } catch { /* as above */ }
    }
  }

  return () => {
    const live = repos.get(cwd)
    if (!live) return
    live.watchers.delete(onCounts)
    if (live.watchers.size === 0) {
      repos.delete(cwd)
      unsubscribe(pollId(cwd))
      live.unwatch?.()
    }
  }
}
