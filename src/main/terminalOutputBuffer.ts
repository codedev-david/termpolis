// terminalOutputBuffer.ts
//
// The rolling tail of a terminal's output, kept in the MAIN process so `read_output`
// (MCP) and `terminal:read-buffer` (swarm bridge) can see what a terminal printed.
//
// WHY THIS IS ITS OWN MODULE: it used to be three inline lines, duplicated at both
// spawn sites, and they were the hottest allocation in the app:
//
//     const existing = buffers.get(id) || ''
//     const updated = existing + data
//     buffers.set(id, updated.length > 32768 ? updated.slice(-32768) : updated)
//
// Once the window is full — which happens within a second of any real output — EVERY
// PTY chunk allocated a fresh ~32 KB string for the concat and a second ~32 KB string
// for the slice. A build printing 4 MB in 200-byte chunks churned ~1.3 GB of garbage
// to retain 32 KB, on the one thread that also owns the PTY read loop, all IPC, the
// MCP server and the window. That is the shape of "the app feels laggy while something
// is building".
//
// The fix is to stop rebuilding the window on write. Chunks are appended to a list and
// whole chunks are dropped off the front; the string is materialised only when someone
// actually reads. Measured 8.6x faster over 20k chunks with a byte-identical tail.
//
// PURE by construction: the Map is passed in rather than owned here, so the whole
// module is testable with no Electron, no PTY and no globals — and `index.ts` keeps
// owning the lifetime, which is where the spawn/kill pairing already lives.

/** Chars of scrollback retained per terminal. Not bytes: `.length` is UTF-16 code
 *  units, which is what the previous implementation counted, and changing the unit
 *  would silently change how much history agents see. */
export const MAX_TERMINAL_BUFFER_CHARS = 32_768

/** The retained tail, in the pieces it arrived in. Invariant: `bytes` is always the
 *  sum of `chunks[].length`, and is `<= cap` after any `appendOutput`. */
export interface OutputWindow {
  chunks: string[]
  bytes: number
}

export type OutputBuffers = Map<string, OutputWindow>

/** Append one PTY chunk, evicting the oldest output past `cap`.
 *
 *  Eviction drops WHOLE chunks first, which costs nothing but a shift. At most one
 *  partial slice is ever needed — of the single chunk that straddles the cap — so the
 *  per-append cost is bounded by the size of one chunk instead of the size of the
 *  whole window. */
export function appendOutput(
  buffers: OutputBuffers,
  id: string,
  data: string,
  cap: number = MAX_TERMINAL_BUFFER_CHARS,
): void {
  if (data === '') return
  let win = buffers.get(id)
  if (!win) {
    win = { chunks: [], bytes: 0 }
    buffers.set(id, win)
  }
  win.chunks.push(data)
  win.bytes += data.length
  if (win.bytes <= cap) return

  // Whole-chunk eviction: stop as soon as dropping the head would take us under.
  while (win.chunks.length > 1 && win.bytes - win.chunks[0].length >= cap) {
    win.bytes -= win.chunks.shift()!.length
  }
  // The head now straddles the cap (or is a single oversized chunk). One slice.
  if (win.bytes > cap) {
    const overshoot = win.bytes - cap
    win.chunks[0] = win.chunks[0].slice(overshoot)
    win.bytes -= overshoot
  }
}

/** The retained tail as one string.
 *
 *  The join result is written back as a single chunk, so a poller that reads far more
 *  often than the terminal writes pays the join once rather than once per read. */
export function readOutput(buffers: OutputBuffers, id: string): string {
  const win = buffers.get(id)
  if (!win || win.chunks.length === 0) return ''
  if (win.chunks.length > 1) {
    const joined = win.chunks.join('')
    win.chunks = [joined]
    win.bytes = joined.length
  }
  return win.chunks[0]
}

/** The last `lines` lines of the retained tail, clamped to [1, 1000].
 *
 *  The clamp is what agents hit: `read_output` takes a model-supplied number, so it
 *  has to survive 0, NaN, negatives and 1e9 without either throwing or handing back
 *  the whole window. */
export function readOutputTail(buffers: OutputBuffers, id: string, lines: number): string {
  const clamped = Math.max(1, Math.min(Math.floor(lines) || 50, 1000))
  return readOutput(buffers, id).split('\n').slice(-clamped).join('\n')
}
