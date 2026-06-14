import { useEffect, useRef } from 'react'

// Auto-index everything: keep the shared memory brain current with no clicks.
// Past AI conversations are already ingested by the main-process background
// indexer; the gap this fills is REPO CODE, which otherwise only happens when
// the user clicks "Index this repo's code" in the Memory panel. When enabled
// (the default), opening a terminal in a Git repo auto-indexes that repo's code
// once per session — reusing the existing memory:ingest-code IPC, which is
// content-hash deduped (unchanged code is never re-embedded) and yields between
// embeds so it never freezes the UI. Opt-out in Settings.

const SETTING_KEY = 'termpolis.memory.autoIndexEverything'

/** Auto-index-everything is ON by default; users opt out in Settings. */
export function isAutoIndexEnabled(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) !== '0'
  } catch {
    return true
  }
}

export function setAutoIndexEnabled(on: boolean): void {
  try {
    localStorage.setItem(SETTING_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

// Repo roots already auto-indexed this session. Module-level (not per-hook) so
// opening the same repo in several terminals — or cd-ing around within it —
// indexes the repo only once. Reset hook is exported for tests.
const indexedRoots = new Set<string>()
export function _resetAutoIndexedRoots(): void {
  indexedRoots.clear()
}

// Resolve the Git root for a cwd and, if auto-index is on and that repo hasn't
// been indexed yet this session, kick off a code index via the existing IPC.
// Best-effort and silent: a no-op if disabled, if the cwd isn't in a Git repo,
// or if the bridge API is unavailable. Returns whether it started an index.
export async function autoIndexRepo(cwd: string): Promise<boolean> {
  try {
    if (!cwd) return false
    if (!isAutoIndexEnabled()) return false
    const api = window.termpolis
    if (!api?.gitFindRoot || !api?.memoryIngestCode) return false
    const res = await api.gitFindRoot(cwd)
    const root = res?.success ? res.data : null
    if (!root) return false // not a Git repo — don't cache the miss, may cd in later
    if (indexedRoots.has(root)) return false
    // Mark before awaiting the ingest so concurrent panes don't double-fire.
    indexedRoots.add(root)
    void api.memoryIngestCode(root)
    return true
  } catch {
    return false
  }
}

// Fire autoIndexRepo whenever a terminal's resolved cwd changes. One TerminalPane
// mounts this per terminal; the module-level Set dedupes across panes and cwd
// changes so each repo is indexed once per session. The per-mount ref avoids
// re-resolving the same cwd on unrelated re-renders.
export function useAutoCodeIndex(cwd: string): void {
  const lastCwdRef = useRef<string>('')
  useEffect(() => {
    if (!cwd || cwd === lastCwdRef.current) return
    lastCwdRef.current = cwd
    void autoIndexRepo(cwd)
  }, [cwd])
}

// Periodic re-sweep: every REPO_RESWEEP_INTERVAL_MS, re-index the code of all
// currently-open repos so edits made mid-session are picked up WITHOUT reopening
// the repo. Re-running the code index is cheap — it's content-hash deduped, so
// only files whose content actually changed are re-embedded. This is distinct
// from the on-open path above: the once-per-session guard does NOT apply here —
// a re-sweep is a deliberate refresh.
export const REPO_RESWEEP_INTERVAL_MS = 15 * 60_000 // 15 min

// Resolve the distinct Git roots of the given cwds and re-index each. Best-effort
// and gated by the setting; returns how many roots it kicked off an index for.
export async function resweepOpenRepos(getCwds: () => string[]): Promise<number> {
  try {
    if (!isAutoIndexEnabled()) return 0
    const api = window.termpolis
    if (!api?.gitFindRoot || !api?.memoryIngestCode) return 0
    const cwds = Array.from(new Set(getCwds().filter(Boolean)))
    const roots = new Set<string>()
    for (const cwd of cwds) {
      try {
        const res = await api.gitFindRoot(cwd)
        const root = res?.success ? res.data : null
        if (root) roots.add(root)
      } catch {
        /* skip this cwd, keep sweeping the rest */
      }
    }
    for (const root of roots) {
      try {
        void api.memoryIngestCode(root)
      } catch {
        /* skip this root */
      }
    }
    return roots.size
  } catch {
    return 0
  }
}

// Start the periodic re-sweep. Call once (from the app root); returns a disposer
// that stops the timer. `getCwds` is read at each tick, so the sweep always
// targets the repos that are open *then*.
export function startRepoResweep(
  getCwds: () => string[],
  intervalMs: number = REPO_RESWEEP_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void resweepOpenRepos(getCwds)
  }, intervalMs)
  return () => clearInterval(timer)
}
