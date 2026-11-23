// askPrimer.ts — the memory primer a Lumopolis Ask starts with (WPA, Lumopolis 2.0).
//
// The digest comes from the primer cache (primerCache.ts): at once when one is held, built under the ask's own cancel signal
// when not. When none comes back, this says why, so the answer can say it was made without the project memory:
//   - the memory process is down (memoryClient mode 'unavailable'), or a build that failed: 'down';
//   - the store is locked (its own key cannot open it): 'locked';
//   - otherwise there were simply no notes for this project, which is no note at all.
// A cancelled ask asks nothing further and is owed no reason. PURE: every read is injected.
import { memoryUnavailable } from './world/askRunner'
import type { PrimerCache } from './primerCache'

export interface AskPrimerDeps {
  cache: Pick<PrimerCache, 'get'>
  /** The primer size setting (memorySettings.getPrimerLimit). */
  limit(): number
  /** True when the memory process is down for good (memoryClient mode 'unavailable'). */
  hostDown(): boolean
  /** True when the store's own key cannot open it. Never rejects (index.ts memoryIsLocked answers false on a failure). */
  isLocked(): Promise<boolean>
}

export function createAskPrimer(deps: AskPrimerDeps): (cwd: string, signal?: AbortSignal) => Promise<string | null> {
  return async (cwd, signal) => {
    let text: string | null
    try {
      text = await deps.cache.get(cwd, deps.limit(), signal ? { signal } : {})
    } catch {
      if (signal?.aborted) return null
      throw memoryUnavailable('down')
    }
    if (text !== null || signal?.aborted) return text
    if (deps.hostDown()) throw memoryUnavailable('down')
    if (await deps.isLocked()) throw memoryUnavailable('locked')
    return null
  }
}
