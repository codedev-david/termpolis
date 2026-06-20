const MAX_FLUSH_SIZE = 65536 // 64KB per frame — prevents memory spikes from extreme output

// Writes at or below this size, when the throttle is otherwise idle, are flushed
// synchronously instead of waiting for the next animation frame. This is the
// keystroke-echo path: the PTY echoes each typed character straight back, and
// deferring it by a frame is felt as input lag — worst on the first keystroke in
// a freshly-opened terminal, when an animation frame can be starved for hundreds
// of ms by mount work. A bare 1-byte echo is the simplest case, but PowerShell's
// PSReadLine repaints the whole input line (often with a prediction suggestion)
// on every keystroke — a few KB, not one byte — so the limit is generous enough
// to keep those on the instant path too. Genuinely large chunks, and any write
// that arrives while a burst is already in flight, still coalesce through rAF so
// a flood can't spike memory or thrash the renderer.
const SMALL_WRITE_BYPASS = 8192

export function createOutputThrottle(writeFn: (data: string) => void) {
  let buffer = ''
  let scheduled = false

  function flush() {
    if (buffer.length <= MAX_FLUSH_SIZE) {
      writeFn(buffer)
      buffer = ''
      scheduled = false
    } else {
      // Write up to 64KB, defer the rest to next frame
      writeFn(buffer.slice(0, MAX_FLUSH_SIZE))
      buffer = buffer.slice(MAX_FLUSH_SIZE)
      requestAnimationFrame(flush)
    }
  }

  return (data: string) => {
    // Fast path: a small write while fully idle (nothing buffered, no frame
    // pending) is almost always a typed character being echoed back — write it
    // now so it appears instantly. The `!scheduled && buffer.length === 0` guard
    // preserves ordering: once a burst is in flight, small writes fall through
    // to the buffer and flush in order behind it.
    if (!scheduled && buffer.length === 0 && data.length <= SMALL_WRITE_BYPASS) {
      writeFn(data)
      return
    }
    buffer += data
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(flush)
    }
  }
}
