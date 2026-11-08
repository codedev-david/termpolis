// doorFill.ts
//
// The doors an agent reads memory through hand it only what it may have: a saved note while notes may not travel to
// another project, a lesson the substance gate holds back. The store cuts a read to its limit FIRST, best rows first, and
// the door drops those rows after, so a read whose best rows were all of that kind came back short, or empty, with rows
// the agent may have sitting just behind them. A note is stored at importance 0.9 and matches the topic it was written
// about, so an ordinary search on that topic did exactly this.
//
// fillVisible asks the store again, deeper, for as long as that is the case. The first read is the caller's own, exactly
// as before, so a read with nothing to hide costs what it always did; only a read that came back short asks again, and
// each ask doubles the one before it up to the most the store gives in one read. The store is not told what to leave out:
// that stays the door's rule (visibleNotes in index.ts), so a change to the store cannot widen what an agent is handed.
//
// A store that drops rows of its own AFTER it cuts (a memory a later one supersedes, a weak path in a graph walk) can answer
// with fewer rows than it was asked for while more sit behind. Such a read counts as everything there is, which is what
// every read did before this module.
//
// PURE: no electron, no fs, no store. It never catches: a read that fails fails the door the way it always did.

export interface FillBounds {
  /** What the store reads when the caller names no limit. */
  fallback: number
  /** The most a deeper read asks for (the store's own clamp where it has one). A first read at or past it has nowhere deeper to go. */
  ceiling: number
}

/**
 * `read` made again, for more rows, until `limit` of them survive `visible` or there is nowhere deeper to look.
 *
 * `limit` goes to the first read as it came: it is a model's JSON, so at run time it may be text, a fraction or nothing. It
 * is read the way the store reads it to get the number of rows the caller is owed. Rows come back in the store's order, and
 * never above that number once a deeper read was needed. A limit that is not a number is read once and left as the door made
 * of it: the store gives such a read nothing, and there is nothing to fill to.
 */
export async function fillVisible<T>(
  limit: number | undefined,
  read: (limit: number | undefined) => Promise<T[]> | T[],
  visible: (rows: T[]) => T[],
  bounds: FillBounds,
): Promise<T[]> {
  let rows = await read(limit)
  if (!Array.isArray(rows)) return visible(rows)
  let kept = visible(rows)
  // NaN (a limit that is not a number) stays NaN, and every comparison with it below is false: that read is never repeated.
  const target = Math.max(Math.floor(Number(limit ?? bounds.fallback)), 1)
  let size = target
  let deeper = false
  // A page the store filled, that the door then cut short, may have more behind it. A page it could not fill is all there is.
  while (kept.length < target && rows.length >= size && size < bounds.ceiling) {
    size = Math.min(size * 2, bounds.ceiling)
    rows = await read(size)
    kept = visible(rows)
    deeper = true
  }
  return deeper && kept.length > target ? kept.slice(0, target) : kept
}
