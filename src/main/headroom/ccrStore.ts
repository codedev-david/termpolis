// In-memory, session-scoped reversible cache. No disk I/O (hot-path perf).
// Bounded by entry count; oldest-inserted evicted first (Map preserves order).
export const CCR_MAX_ENTRIES = 64

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

export function ccrRetrieve(token: string): unknown | undefined {
  return store.get(token)
}

export function resetCcr(): void {
  store.clear()
  counter = 0
}
