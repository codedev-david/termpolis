// Renderer side of "watch the repo instead of asking it every three seconds".
//
// Main owns the fs handles (see src/main/gitWatcher.ts) and pushes one event per repo ROOT. Panels
// subscribe by the cwd they happen to be sitting in, which is usually a subdirectory of that root —
// so the match here is by path prefix, not equality, or a terminal in `repo/src` would never hear
// about a change in `repo`.
//
// Everything is ref-counted in both directions: one `gitWatch` per distinct cwd no matter how many
// panels ask, and the matching `gitUnwatch` only when the last one leaves. A leaked watch is a file
// handle main holds forever.

type Listener = () => void

interface CwdWatch {
  listeners: Set<Listener>
  /** The repo root main resolved for this cwd — null until the round trip lands, or for good if the
   *  cwd is not in a repo at all. */
  root: string | null
}

const watches = new Map<string, CwdWatch>()
let unsubscribeBridge: (() => void) | null = null

/** The preload bridge, or undefined. Not `window.termpolis?.x` at each site: parts of the renderer
 *  are unit-tested in a plain node environment where `window` is not merely empty but UNDECLARED,
 *  and a bare reference there is a ReferenceError rather than undefined. */
function bridge(): Window['termpolis'] | undefined {
  return typeof window === 'undefined' ? undefined : window.termpolis
}

/** Windows spells the same directory `C:\a\b` and `C:/a/b`, and git hands back forward slashes even
 *  there. Compare on one spelling or every prefix test fails on Windows. */
function normalize(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return slashed.toLowerCase()
}

function isUnder(cwd: string, root: string): boolean {
  const c = normalize(cwd)
  const r = normalize(root)
  return c === r || c.startsWith(r + '/')
}

function ensureBridge(): void {
  if (unsubscribeBridge) return
  const on = bridge()?.onGitTreeChanged
  if (typeof on !== 'function') return
  unsubscribeBridge = on(({ root }) => {
    if (!root) return
    for (const [cwd, watch] of [...watches]) {
      if (!isUnder(cwd, root)) continue
      // Snapshot: a listener may unsubscribe from inside its own callback.
      for (const fn of [...watch.listeners]) {
        if (watch.listeners.has(fn)) {
          try { fn() } catch { /* one bad listener must not starve the rest */ }
        }
      }
    }
  })
}

/**
 * Call `onChange` whenever anything in `cwd`'s repository changes on disk. Returns an unsubscribe.
 *
 * Safe to call with a cwd that is not a repo, in a host with no bridge (tests, first paint before
 * preload), or twice for the same directory — all three are no-ops rather than errors.
 */
export function watchRepoChanges(cwd: string, onChange: Listener): () => void {
  if (!cwd) return () => {}
  ensureBridge()

  let watch = watches.get(cwd)
  if (!watch) {
    watch = { listeners: new Set(), root: null }
    watches.set(cwd, watch)
    const start = bridge()?.gitWatch
    if (typeof start === 'function') {
      void start(cwd)
        .then((res) => {
          const live = watches.get(cwd)
          // Gone already — the panel unmounted mid-flight. Undo the watch main just opened, or it
          // stays open for the life of the app.
          if (!live) { void bridge()?.gitUnwatch?.(cwd) ; return }
          live.root = res?.success ? res.data ?? null : null
        })
        .catch(() => { /* no watcher; the slow poll still covers this repo */ })
    }
  }
  watch.listeners.add(onChange)

  return () => {
    const live = watches.get(cwd)
    if (!live) return
    live.listeners.delete(onChange)
    if (live.listeners.size > 0) return
    watches.delete(cwd)
    void bridge()?.gitUnwatch?.(cwd)
    if (watches.size === 0 && unsubscribeBridge) {
      unsubscribeBridge()
      unsubscribeBridge = null
    }
  }
}

/** Drop every watch. Exported for test isolation only. */
export function resetGitWatches(): void {
  for (const cwd of watches.keys()) void bridge()?.gitUnwatch?.(cwd)
  watches.clear()
  if (unsubscribeBridge) {
    unsubscribeBridge()
    unsubscribeBridge = null
  }
}
