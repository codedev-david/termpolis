// typingQuiet.ts
//
// "Nothing starts within 500 ms of a keystroke." Background work (conversation ingest, the indexer's passes)
// shares one thread with the keyboard. It cannot be moved off that thread in this release, so it is told to
// stand aside: noteTyping() stores the time of the last keystroke (the whole of its cost on the typing path:
// one assignment, no timer, no promise), and background work calls whenTypingQuiet() before it starts and
// between its slices.
//
// The wait is capped (2 s by default): a line that never goes quiet must not starve the work for good, so
// after the cap the work goes ahead, one short slice at a time.
//
// It only ever delays; it never decides what the work does, never reads what was typed, and fails open:
// with no clock reading or a throwing sleep the work simply goes ahead.

/** Quiet period required before background work may start. */
export const QUIET_MS = 500
/** Longest a piece of work waits for quiet before it goes ahead anyway. */
export const QUIET_MAX_WAIT_MS = 2_000

let lastTyping = Number.NEGATIVE_INFINITY
const stats = { waits: 0, waitedMs: 0, capped: 0 }

/** Called from the terminal-write handler. O(1), allocation-free. */
export function noteTyping(at: number = Date.now()): void {
  lastTyping = at
}

/** Milliseconds since the last keystroke; Infinity when there has been none. */
export function msSinceTyping(now: number = Date.now()): number {
  return now - lastTyping
}

export interface QuietOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  quietMs?: number
  maxWaitMs?: number
}

const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref()
  })

/**
 * Resolves once nobody has typed for the quiet period, or once the cap has passed. Returns at once, with no
 * timer, when the user is already quiet.
 */
export async function whenTypingQuiet(opts: QuietOptions = {}): Promise<{ waitedMs: number; capped: boolean }> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? realSleep
  const quietMs = opts.quietMs ?? QUIET_MS
  const maxWaitMs = opts.maxWaitMs ?? QUIET_MAX_WAIT_MS

  const gapNow = (): number => Math.max(0, msSinceTyping(now()))
  if (gapNow() >= quietMs) return { waitedMs: 0, capped: false }

  const start = now()
  let capped = false
  for (;;) {
    const waited = now() - start
    if (waited >= maxWaitMs) {
      capped = true
      break
    }
    const gap = gapNow()
    if (gap >= quietMs) break
    // Sleep until the quiet period would be over if no one types again, but never past the cap.
    await sleep(Math.min(quietMs - gap, maxWaitMs - waited))
  }
  const waitedMs = now() - start
  stats.waits++
  stats.waitedMs += waitedMs
  if (capped) stats.capped++
  return { waitedMs, capped }
}

/** How often background work waited for the user, for how long, and how often it gave up waiting. */
export function typingGateStats(): { waits: number; waitedMs: number; capped: number } {
  return { ...stats }
}

/** Test seam: forget the last keystroke and the counters. */
export function resetTypingQuiet(): void {
  lastTyping = Number.NEGATIVE_INFINITY
  stats.waits = 0
  stats.waitedMs = 0
  stats.capped = 0
}
