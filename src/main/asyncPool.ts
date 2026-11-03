// A small bound for work that is done on the thread pool: at most `limit` of `fn` run at once, the results come back
// in the order of the items. File listings (a transcript folder with thousands of sessions, every folder on PATH) are
// walked with it, so one request cannot queue thousands of file calls in front of everything else the app asks the
// thread pool for.

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, worker))
  return out
}
