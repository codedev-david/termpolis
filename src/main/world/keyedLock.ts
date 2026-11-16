// A per-key async lock: work queued under one key runs one at a time, in the order it was queued;
// different keys run independently. A rejected job releases the lock like a resolved one, and its
// rejection reaches only its own caller (the chain itself never holds a rejected promise).
export type KeyedLock = <T>(key: string, job: () => Promise<T>) => Promise<T>

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<void>>()
  return <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(job)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return result
  }
}
