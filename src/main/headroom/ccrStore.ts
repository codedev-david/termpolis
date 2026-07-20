// In-memory, session-scoped reversible cache. No disk I/O (hot-path perf).
// Bounded by entry count; oldest-inserted evicted first (Map preserves order).
export const CCR_MAX_ENTRIES = 192

const store = new Map<string, unknown>()
let counter = 0

export function ccrStash(value: unknown): string {
  const token = `hr_${(++counter).toString(36)}`
  store.set(token, value)
  while (store.size > CCR_MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
  return token
}

/** Stash under a caller-provided (deterministic) token — used by the proxy so its
 *  content-hash retrieve tokens resolve here for the retrieve_full MCP tool. */
export function ccrPut(token: string, value: unknown): void {
  if (store.has(token)) store.delete(token) // re-insert at end → LRU: a re-sent (still in-context) original stays fresh
  store.set(token, value)
  while (store.size > CCR_MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

export function ccrRetrieve(token: string): unknown | undefined {
  return store.get(token)
}

export function resetCcr(): void {
  store.clear()
  counter = 0
}
