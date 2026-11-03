/**
 * Chars sitting in xterm's own write buffer, ahead of whatever is written next. xterm keeps the count
 * in a private field: no public API says how far behind the parser is. Anything that does not look
 * like the real thing reads as null, never as 0: unknown is not an empty queue. The test suite parses
 * a write with the installed xterm and reads this back, so an upgrade that moves it fails loudly.
 *
 * Two readers: the echo trace (how much output sits ahead of a typed key) and the resize barrier
 * (is there anything queued that was drawn for the old size). They live here, in a module of their
 * own, so a test that replaces the echo trace with a fake does not take the barrier's reader with it.
 */
export function readXtermPending(term: unknown): number | null {
  try {
    const n = (term as { _core?: { _writeBuffer?: { _pendingData?: unknown } } } | null | undefined)?._core?._writeBuffer?._pendingData
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}
