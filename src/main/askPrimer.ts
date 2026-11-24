// askPrimer.ts — the memory primer a Lumopolis Ask starts with (WPA, Lumopolis 2.0).
//
// The digest comes from the primer cache (primerCache.ts): at once when one is held, built when not; the ask's cancel stops
// its wait, and the build's reads when no one else waits on them. When none comes back, this says why, so the answer can say it was made without the project memory:
//   - a memory call that ran out of time (memoryClient's coded timeout): 'timeout' (WPA fix I2);
//   - the store is locked (its own key cannot open it): 'locked';
//   - the memory process is down (memoryClient mode 'unavailable'), restarting, unreachable, or a build that failed any other
//     way: 'down';
//   - otherwise the memory answered and no saved notes matched: 'empty' (WPA2 M8), so the answer says it comes from the code
//     alone. A digest of nothing but white space is no digest (headlessExec trims the primer and drops an empty one).
// A cancelled ask asks nothing further and is owed no reason. PURE: every read is injected.
import { memoryUnavailable } from './world/askRunner'
import { probe } from './probeLog'
import { isMemoryTimeout } from './hostLane'
import type { PrimerBuild, PrimerCache } from './primerCache'

export interface AskPrimerDeps {
  cache: Pick<PrimerCache, 'get'>
  /** The primer size setting (memorySettings.getPrimerLimit). */
  limit(): number
  /** True when the memory process is down for good (memoryClient mode 'unavailable'). */
  hostDown(): boolean
  /** True when the store's own key cannot open it. Never rejects (index.ts memoryIsLocked answers false on a failure). */
  isLocked(): Promise<boolean>
  /** The long form of the folder (projectKey expandShortPath: an 8.3 short name spelled out), before it keys the cache and
   *  scopes the reads. Never rejects. Default: the folder as given. */
  expand?(root: string): Promise<string>
}

/** Why a failed primer build left the memory out (see the header). */
async function reasonOf(err: unknown, isLocked: () => Promise<boolean>): Promise<Error> {
  if (err && typeof err === 'object' && typeof (err as { noMemory?: unknown }).noMemory === 'string') return err as Error
  if (isMemoryTimeout(err)) return memoryUnavailable('timeout')
  if (await isLocked()) return memoryUnavailable('locked')
  return memoryUnavailable('down')
}

export function createAskPrimer(deps: AskPrimerDeps): (cwd: string, signal?: AbortSignal) => Promise<string | null> {
  return async (cwd, signal) => {
    const pa = Date.now()
    const root = deps.expand ? await deps.expand(cwd) : cwd
    probe(`primer expand ms=${Date.now() - pa}`)
    if (signal?.aborted) return null
    let text: string | null
    try {
      const pb = Date.now()
      text = await deps.cache.get(root, deps.limit(), signal ? { signal } : {})
      probe(`primer cache.get ms=${Date.now() - pb} text=${text === null ? 'null' : text.length}`)
    } catch (err) {
      probe(`primer cache.get threw ${err instanceof Error ? err.message.slice(0, 80) : ''}`)
      if (signal?.aborted) return null
      throw await reasonOf(err, deps.isLocked)
    }
    if (signal?.aborted) return null
    if (text !== null && text.trim() !== '') return text
    if (deps.hostDown()) throw memoryUnavailable('down')
    if (await deps.isLocked()) throw memoryUnavailable('locked')
    if (signal?.aborted) return null
    throw memoryUnavailable('empty')
  }
}

/**
 * A primer build that never hands back a digest read from a locked store: whether the store is locked is asked beside the
 * build (no time added), and a locked one rejects with memoryUnavailable('locked'), so the cache stores nothing and drops what
 * it held (primerCache fly), and the ask says the memory is locked. A build with no digest is passed through as it is.
 */
export function lockAwareBuild(build: PrimerBuild, isLocked: () => Promise<boolean>): PrimerBuild {
  return async (root, limit, signal, lane) => {
    const l0 = Date.now()
    const locked = isLocked().catch(() => false).finally(() => probe(`primer build isLocked ms=${Date.now() - l0}`))
    const text = await build(root, limit, signal, lane).finally(() => probe(`primer build ${lane ?? '-'} ms=${Date.now() - l0}`))
    if (text !== null && await locked) throw memoryUnavailable('locked')
    return text
  }
}

/** Warms the cached Ask primer of a folder, under its long name (the key the ask will look up). Never rejects. */
export function createAskPrimerWarm(deps: {
  cache: Pick<PrimerCache, 'warm'>
  limit(): number
  expand?(root: string): Promise<string>
}): (root: string, opts?: { force?: boolean }) => Promise<void> {
  return async (root, opts = {}) => {
    try {
      const long = deps.expand ? await deps.expand(root) : root
      await deps.cache.warm(long, deps.limit(), opts)
    } catch { /* a warm-up is best effort: the next ask builds */ }
  }
}

/**
 * Wraps a memory write so the folders it stored notes for are remembered (WPA fix M9: the Claude-notes pass warms the projects
 * it wrote to). `take()` hands them over once, each folder once, in the order first written.
 */
export function trackWrittenProjects<I extends { project?: unknown }, R>(write: (input: I) => Promise<R>): {
  write: (input: I) => Promise<R>
  take(): string[]
} {
  let written = new Set<string>()
  return {
    write: async (input) => {
      const r = await write(input)
      if (r && typeof input?.project === 'string' && input.project) written.add(input.project)
      return r
    },
    take: () => { const out = [...written]; written = new Set(); return out },
  }
}
