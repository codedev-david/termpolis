// One spawn per question per repo, however many panels are asking.
//
// The read side of git in this app is a chorus, not a soloist. On a single repo with three
// terminals open, one tick used to be:
//
//   git:changes        status --porcelain -b -z, diff --numstat -z, diff --cached --numstat -z
//   git:change-counts  status --porcelain -b -z          <- the SAME command as above
//   git:status-parsed  rev-parse --abbrev-ref HEAD, status --porcelain   x3 terminals
//   terminal:git-info  status --short, log --oneline -5
//   terminal:status    rev-parse --abbrev-ref HEAD       x3 terminals
//
// Sixteen processes to answer maybe five distinct questions, and `status --porcelain -b -z` alone
// was asked twice by two panels that wanted the identical bytes. v1.47.1 moved spawning off the main
// thread (procHost.ts), which is what fixed the typing lag — but a spawn that no longer blocks
// anyone is still a spawn, and on Windows it is still ~50 ms of Defender-taxed process creation.
//
// So: identical (cwd, argv) inside the TTL window shares one result, and concurrent callers share
// one in-flight promise. This is a cache with a deliberately SHORT life, because the thing it caches
// is a liveness indicator. It is correct only because it is paired with invalidation:
//
//   - gitWatcher drops a repo's entries the moment anything under it changes on disk, so an edit in
//     an editor shows up at watcher speed, not at TTL speed;
//   - every git command that WRITES calls invalidateGitCache() itself, so staging a file and then
//     reading the status can never return the pre-stage answer. Read-your-writes is not optional
//     here: the rail repaints from that read immediately after the write.
//
// Failures are never cached. A transient failure that stuck around for the whole window would paint
// "not a repo" onto a repo.

import { safeGitAsync, type GitOptions } from './gitCommand'

/** Long enough to collapse the burst of panels that all wake on the same tick, short enough that
 *  nothing anyone can perceive rides on it. */
export const GIT_CACHE_TTL_MS = 1500

interface Entry {
  at: number
  value: Promise<string>
}

const entries = new Map<string, Entry>()
let clock: () => number = () => Date.now()

/** Test seam. Real callers never touch this. */
export function _setGitCacheClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now())
}

export function _gitCacheSizeForTests(): number {
  return entries.size
}

function keyFor(cwd: string, args: string[]): string {
  // NUL separator: it is the one byte that cannot appear in a path or a git argument, so no pair of
  // different (cwd, argv) can collide by concatenation.
  return `${cwd}\u0000${args.join('\u0000')}`
}

/**
 * Run a read-only git command, sharing the answer with anything that asked the same thing recently.
 *
 * Only ever pass READ commands. A write would be deduplicated — two `git commit` calls in the same
 * window would run once — which is exactly wrong.
 */
export function cachedGit(args: string[], opts: GitOptions, ttlMs: number = GIT_CACHE_TTL_MS): Promise<string> {
  const key = keyFor(opts.cwd, args)
  const now = clock()
  const hit = entries.get(key)
  if (hit && now - hit.at < ttlMs) return hit.value

  const value = safeGitAsync(args, opts)
  entries.set(key, { at: now, value })
  // Drop failures rather than serve them for the rest of the window. Note the catch is attached to a
  // COPY of the promise chain — `value` itself stays rejected for the callers who hold it.
  value.catch(() => {
    if (entries.get(key)?.value === value) entries.delete(key)
  })
  return value
}

/**
 * Forget what we know about a repo.
 *
 * `cwd` matches by PREFIX, because a repo's panels ask from different directories — a terminal
 * sitting in `repo/src` and the rail sitting at `repo` are two keys for one repository, and a change
 * anywhere in it invalidates both. Called with no argument, forgets everything (used at teardown).
 */
export function invalidateGitCache(cwd?: string): void {
  if (!cwd) {
    entries.clear()
    return
  }
  const prefix = normalize(cwd)
  for (const key of [...entries.keys()]) {
    const keyCwd = normalize(key.slice(0, key.indexOf('\u0000')))
    if (keyCwd === prefix || keyCwd.startsWith(prefix + '/') || prefix.startsWith(keyCwd + '/')) {
      entries.delete(key)
    }
  }
}

/** Windows hands us `C:\a\b` from one caller and `C:/a/b` from another for the same directory, and a
 *  drive letter in either case. Compare on one spelling or half the invalidations silently miss. */
function normalize(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}
