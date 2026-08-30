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
  /** Every char ever appended for this terminal, including what has been evicted.
   *  This is what makes an offset MEAN something: the window slides, so a position
   *  inside it is not stable, but a position in the total stream is. */
  total: number
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
    win = { chunks: [], bytes: 0, total: 0 }
    buffers.set(id, win)
  }
  win.chunks.push(data)
  win.bytes += data.length
  win.total += data.length
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

export interface OutputSlice {
  output: string
  /** Absolute offset to pass on the NEXT poll. Always the end of the stream, so a
   *  caller that echoes it back can never drift. */
  nextOffset: number
  /** Chars that were evicted before this caller got to them. Non-zero means the
   *  terminal outran the poller and this much output is gone for good. */
  missed: number
}

/** Read forward from an ABSOLUTE offset in the terminal's output stream.
 *
 *  WHY ABSOLUTE, AND WHY THIS EXISTS AT ALL: the swarm bridge polls a non-MCP agent's
 *  terminal by keeping a running offset and asking for everything after it. That offset
 *  counts total output, but the buffer is a sliding 32 KB window — so the two agreed
 *  only until the first eviction. Past 32 KB of output the caller's offset ran off the
 *  end of the window, `slice` returned the empty string, and it did so FOREVER: the
 *  bridge went permanently blind and every swarm signal after that point was silently
 *  dropped. It failed silently, stayed broken, and looked like an agent that had simply
 *  stopped talking.
 *
 *  Offsets are therefore positions in the whole stream, not in the window. An offset
 *  older than the window is clamped forward to the oldest surviving char and the gap is
 *  reported in `missed` rather than hidden — a poller that fell behind should know it
 *  lost output, not silently resume mid-sentence. */
export function readOutputFrom(buffers: OutputBuffers, id: string, fromOffset = 0): OutputSlice {
  const win = buffers.get(id)
  if (!win) return { output: '', nextOffset: 0, missed: 0 }
  const total = win.total
  const dropped = total - win.bytes
  // Clamp into [dropped, total]: below is evicted, above is a caller ahead of reality
  // (a restarted terminal reusing an id), and both must resolve to a valid slice.
  const requested = Math.max(0, Number.isFinite(fromOffset) ? Math.floor(fromOffset) : 0)
  const start = Math.min(Math.max(requested, dropped), total)
  return {
    output: readOutput(buffers, id).slice(start - dropped),
    nextOffset: total,
    missed: Math.max(0, dropped - requested),
  }
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
