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
  /** The terminal modes that output already gone from the window left set — see
   *  replayPreamble. Created by the first evicted (or cleared) text that holds an ESC:
   *  a window that never lost an escape sequence has none, and keeps its old shape. */
  evicted?: ModeTracker
}

export type OutputBuffers = Map<string, OutputWindow>

/** Append one PTY chunk, evicting the oldest output past `cap`. Returns where the
 *  stream now ends — the chunk's END offset, which the sender tags it with so a pane
 *  replaying this window can tell a chunk its replay already holds from a new one.
 *
 *  Eviction drops WHOLE chunks first, which costs nothing but a shift. At most one
 *  partial slice is ever needed — of the single chunk that straddles the cap — so the
 *  per-append cost is bounded by the size of one chunk instead of the size of the
 *  whole window. Evicted text is read once more on its way out, for the modes it set
 *  (noteEvicted); text without an ESC in it costs a single indexOf. */
export function appendOutput(
  buffers: OutputBuffers,
  id: string,
  data: string,
  cap: number = MAX_TERMINAL_BUFFER_CHARS,
): number {
  let win = buffers.get(id)
  if (data === '') return win?.total ?? 0
  if (!win) {
    win = { chunks: [], bytes: 0, total: 0 }
    buffers.set(id, win)
  }
  win.chunks.push(data)
  win.bytes += data.length
  win.total += data.length
  if (win.bytes <= cap) return win.total

  // Whole-chunk eviction: stop as soon as dropping the head would take us under.
  while (win.chunks.length > 1 && win.bytes - win.chunks[0].length >= cap) {
    const dropped = win.chunks.shift()!
    win.bytes -= dropped.length
    noteEvicted(win, dropped, dropped.length)
  }
  // The head now straddles the cap (or is a single oversized chunk). One slice.
  if (win.bytes > cap) {
    const overshoot = win.bytes - cap
    noteEvicted(win, win.chunks[0], overshoot)
    win.chunks[0] = win.chunks[0].slice(overshoot)
    win.bytes -= overshoot
  }
  return win.total
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

/** Drop everything retained for a terminal, keeping its stream position.
 *
 *  This is what a user-requested "clear" needs on THIS side of the wire. Wiping
 *  xterm alone is not enough and is worse than doing nothing: TerminalPane replays
 *  this window into a fresh xterm on every mount, so a tab switch or a split
 *  re-layout would resurrect the whole transcript the user just cleared.
 *
 *  `total` deliberately survives. It is the basis of every absolute offset — the
 *  swarm bridge, the MCP readers and the phone's output pump all hold one — and
 *  resetting it to 0 would make each of them see the stream jump BACKWARDS, which
 *  reads as "a restarted terminal reusing an id" and re-delivers output that was
 *  already consumed. Keeping it means `dropped` becomes the whole stream, so
 *  readOutputFrom clamps every existing offset forward to the (now empty) end and
 *  each poller simply resumes with whatever the terminal prints next.
 *
 *  The dropped text is folded into the evicted modes first, exactly as eviction does:
 *  a clear wipes what was DRAWN, not the fact that the agent is still fullscreen with
 *  the mouse on, and the next remount has to come back in that state. */
export function clearOutput(buffers: OutputBuffers, id: string): void {
  const win = buffers.get(id)
  if (!win) return
  for (const chunk of win.chunks) noteEvicted(win, chunk, chunk.length)
  win.chunks = []
  win.bytes = 0
}

// ---------------------------------------------------------------------------
// The terminal modes of evicted output
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS: TerminalPane rebuilds a terminal from this window on every mount —
// a Settings round-trip, a tabs/split toggle, a split, a terminal added or closed in
// split view. A fresh xterm only knows what the 32 KB tail tells it, and the modes an
// agent sets ONCE at startup are long gone from a busy session's tail. Claude Code's
// fullscreen UI sends `?1049h` and its mouse DECSETs at startup and again only on a
// real resize, so a same-size remount left the pane on the wrong buffer with the wheel
// routed to an empty local scrollback — issue #35, "can't scroll to see the agent's
// full response" — and pastes stopped being bracketed too.
//
// So the window also remembers the mode state its evicted text left behind, and hands
// it to the replay as a preamble: a fresh xterm that parses preamble + window lands in
// the state the live one is in, and the window then renders as it did live.
//
// The tracker is a small VT parser (ground / escape / CSI / string) that follows xterm.js's
// own state machine, 8-bit C1 controls included — the replay is parsed by xterm, so where
// the two disagree the preamble is wrong. It is fed every evicted char exactly once and
// carries its state across evictions, so a sequence split across two PTY chunks, or cut by
// the eviction itself, is still read whole. It only RECORDS the modes below; everything
// else it merely steps over. Cost: ~3.6 ms per MB of escape-dense agent output, once, as
// it leaves the window; plain text is a single regex scan.

/** DEC private modes (`CSI ? Pm h` / `l`) a replay restores. The bar for a place here:
 *  an app sets it once and leaves it set, and a fresh xterm without it either draws the
 *  window differently or routes input differently afterwards.
 *
 *  - 1          DECCKM: application cursor keys — what xterm sends for the arrows, and
 *               for the wheel-as-arrows it falls back to on the alternate screen.
 *  - 7          DECAWM: autowrap. Gemini CLI turns it off on the alternate screen.
 *  - 25         DECTCEM: cursor visibility. Agents hide it; a replay without this
 *               leaves a stray block cursor on their frame.
 *  - 47, 1047, 1049   the alternate screen: the window's frames must land on it.
 *  - 9, 1000-1003     mouse tracking. TerminalPane swallows 1000-1003 into its wheel-
 *               forwarding latch, which only a DECSET can set (9 and 1001 are kept so
 *               the latch and xterm's own tracker both come back exactly as they were).
 *  - 1005, 1006, 1015, 1016   the mouse encodings that go with them.
 *  - 1004       focus reporting. ConPTY itself asks for it at the start of every session.
 *  - 2004       bracketed paste. term.paste() only brackets while it is on — lose it and
 *               a long paste reaches an agent as the separate "[Pasted text #N]" reads
 *               v1.51.3 fixed.
 *
 *  Deliberately left out: 2026 synchronized output (a frame-scoped toggle, not a mode an
 *  app leaves on — an evicted `h` replayed alone would hold rendering in a terminal that
 *  implements it), 9001 win32-input-mode (ConPTY's own request; xterm.js does not
 *  implement it), and frame-local or cosmetic modes (origin 6, blink 12, save-cursor
 *  1048). DECKPAM / DECKPNM and DECNKM (66) all set the same keypad flag, so they are
 *  one entry: KEYPAD. */
const REPLAYED_MODES: ReadonlySet<number> = new Set([
  1, 7, 25, 47, 1047, 1049, 9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004,
])
/** DECNKM: the DECSET spelling of DECKPAM/DECKPNM. */
const DECNKM = 66
// Two live effects that "latest setting per mode" cannot carry, because a LATER setting of the
// same mode overwrites the entry that held them. Each is recorded as an extra reset that has
// exactly that one effect, so a replay repeats it in its place:
//
//  - Leaving the alternate screen clears TerminalPane's wheel latch (a crashed mouse app never
//    resets its tracking, and the pager opened next must scroll, not get wheel reports). Read as
//    the screen setting alone, `?1000h ?1049l ?1049h` replays as `?1000h ?1049h`: latch back on.
//    Recorded as `?1001l` — a tracker reset, so it clears the latch, for highlight tracking,
//    which xterm.js does not implement, so it changes nothing else.
//  - A reset of 1000/1002/1003 ends xterm's ONE mouse protocol, X10 (9) included — but the
//    swallowed `?1000h` that may follow never sets it, so `?9h ?1000l ?1000h` replayed as
//    `?9h ?1000h` brought X10 back. Recorded as `?9l` — it ends xterm's protocol, and 9 is not
//    a mode TerminalPane swallows or latches on, so it changes nothing else.
//
// Both replay the same way whether TerminalPane swallows the trackers or (Settings > "let apps
// control the mouse") hands them to xterm: neither touches anything the other mode reads.
const ALT_SCREEN_MODES: ReadonlySet<number> = new Set([47, 1047, 1049])
/** The trackers whose reset xterm.js applies to its protocol (resetModePrivate 9/1000/1002/1003). */
const PROTOCOL_TRACKERS: ReadonlySet<number> = new Set([1000, 1002, 1003])
const HIGHLIGHT_TRACKING = 1001
const X10_TRACKING = 9
/** The application-keypad flag, however it was set. Replayed as `ESC =` / `ESC >`. */
const KEYPAD = 'keypad'
type ModeKey = number | typeof KEYPAD
/** What xterm's soft reset (DECSTR, `CSI ! p`) puts back to its defaults. The screen
 *  buffer and the mouse are not part of a soft reset, so they stay. */
const SOFT_RESET_MODES: readonly ModeKey[] = [1, 7, 25, 1004, 2004, KEYPAD]

/** How far into the window replayPreamble will look to finish a sequence the eviction
 *  cut in half. A CSI ends within a few chars; this bounds a string (an OSC title, a
 *  DCS payload) that runs on — past it, the replay prints the rest as it always did. */
export const REPLAY_SKIP_LIMIT = 4096

// Parser states, after the DEC/VT500 state machine (collapsed to what tracking needs).
const GROUND = 0
const ESCAPE = 1
const ESCAPE_INTERMEDIATE = 2
const CSI = 3
/** OSC: ends at BEL or ST (`ESC \`). */
const OSC_STRING = 4
/** DCS, SOS, PM, APC: end at ST only. */
const CONTROL_STRING = 5

// What the CSI in progress can still turn out to be.
const CSI_NEW = 0
/** `CSI ? Pm` — a DEC private mode set/reset, if it ends in h or l. */
const CSI_PRIVATE = 1
/** `CSI !` — DECSTR, if it ends in p. */
const CSI_BANG = 2
/** Anything else: step over it to its final byte. */
const CSI_OTHER = 3
/** xterm.js keeps at most 32 params, so a longer list cannot set more modes than that. */
const MAX_PARAMS = 32
/** Clamp for a runaway parameter: far past every mode number, so it can never name one. */
const PARAM_CEILING = 0xffff

const ESC = 0x1b
const BEL = 0x07
const CAN = 0x18
const SUB = 0x1a
const DEL = 0x7f

interface ModeTracker {
  /** Each replayed mode's LATEST setting, in the order those settings were made (an
   *  update moves the key to the end). Replaying in that order reproduces every state
   *  where the last change wins — one mouse protocol, one encoding, one screen, and
   *  TerminalPane's latch (with the two extra resets recorded beside ALT_SCREEN_MODES). */
  modes: Map<ModeKey, boolean>
  state: number
  csiKind: number
  /** Completed params of the private CSI in progress (-1 = an empty param). */
  params: number[]
  /** The param being read, or -1 before its first digit. */
  param: number
  /** Inside a `:` sub-parameter, which never changes which mode the param names. */
  sub: boolean
}

function newTracker(): ModeTracker {
  return { modes: new Map(), state: GROUND, csiKind: CSI_NEW, params: [], param: -1, sub: false }
}

function cloneTracker(t: ModeTracker): ModeTracker {
  return { ...t, modes: new Map(t.modes), params: t.params.slice() }
}

/** Where a sequence can begin in plain text: ESC, or one of the 8-bit C1 introducers xterm
 *  also honours (DCS, SOS, CSI, OSC, PM, APC). Every other C1 control is executed in place. */
const SEQUENCE_START = /[\x1b\x90\x98\x9b\x9d\x9e\x9f]/g

/** Fold text[0, end) — text that is leaving the window — into the window's tracker. */
function noteEvicted(win: OutputWindow, text: string, end: number): void {
  if (!win.evicted) {
    // A tracker that has never seen a sequence start is in ground state with no modes, and
    // text without one leaves it there — so it only needs to exist once one turns up.
    SEQUENCE_START.lastIndex = 0
    const start = SEQUENCE_START.exec(text)
    if (start === null || start.index >= end) return
    win.evicted = newTracker()
  }
  scan(win.evicted, text, end, false)
}

/** Run text[0, end) through the tracker. With `stopAtGround`, stop the moment the
 *  sequence in progress has ended and return the index just past it, or -1 if it does
 *  not end by `end`; otherwise consume it all and return `end`. */
function scan(t: ModeTracker, text: string, end: number, stopAtGround: boolean): number {
  let i = 0
  while (i < end) {
    if (t.state === GROUND) {
      if (stopAtGround) return i
      // Plain text is the bulk of any output, and nothing in it but a sequence start matters.
      SEQUENCE_START.lastIndex = i
      const start = SEQUENCE_START.exec(text)
      if (start === null || start.index >= end) return end
      i = start.index + 1
      const c = text.charCodeAt(start.index)
      if (c === ESC) t.state = ESCAPE
      else c1Control(t, c)
      continue
    }
    const c = text.charCodeAt(i++)
    if (c >= 0x80 && c <= 0x9f) c1Control(t, c) // xterm applies these the same in every state
    else if (t.state === ESCAPE) escapeChar(t, c)
    else if (t.state === CSI) csiChar(t, c)
    else if (t.state === ESCAPE_INTERMEDIATE) {
      if (c === ESC) t.state = ESCAPE
      else if (c === CAN || c === SUB || c > 0x2f) t.state = GROUND // final byte, or cancelled
      // more intermediates, and C0 controls (executed), carry on
    } else {
      // A string payload is data; only its terminator, a cancel, or an ESC (which starts
      // ST or abandons the string for a new sequence) can end it. BEL only ends an OSC.
      if (c === ESC) t.state = ESCAPE
      else if (c === CAN || c === SUB || (c === BEL && t.state === OSC_STRING)) t.state = GROUND
    }
  }
  if (!stopAtGround) return end
  return t.state === GROUND ? i : -1
}

/** An 8-bit C1 control, which xterm.js handles alike in every parser state: the introducers
 *  open their sequence (a fresh one, abandoning any in progress), ST ends a string, and the
 *  rest are executed — which also ends any sequence in progress. */
function c1Control(t: ModeTracker, c: number): void {
  if (c === 0x9b) {
    t.state = CSI
    t.csiKind = CSI_NEW
  } else if (c === 0x9d) t.state = OSC_STRING
  else if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) t.state = CONTROL_STRING
  else t.state = GROUND
}

function escapeChar(t: ModeTracker, c: number): void {
  if (c === 0x5b) {
    t.state = CSI // ESC [
    t.csiKind = CSI_NEW
  } else if (c === 0x5d) t.state = OSC_STRING // ESC ]
  else if (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) t.state = CONTROL_STRING // DCS SOS PM APC
  else if (c >= 0x20 && c <= 0x2f) t.state = ESCAPE_INTERMEDIATE // e.g. ESC ( B, a charset
  else if (c === CAN || c === SUB) t.state = GROUND
  else if (c < 0x20 || c === DEL) {
    // C0 controls are executed and DEL ignored without leaving the escape; ESC ESC lands
    // here too, and the second ESC simply starts the sequence over.
  } else {
    t.state = GROUND
    if (c === 0x63) t.modes.clear() // RIS: a full reset, so nothing before it survives
    else if (c === 0x3d) setMode(t, KEYPAD, true) // DECKPAM
    else if (c === 0x3e) setMode(t, KEYPAD, false) // DECKPNM
  }
}

function csiChar(t: ModeTracker, c: number): void {
  if (c >= 0x40 && c <= 0x7e) {
    t.state = GROUND // the final byte: the sequence is complete
    finishCsi(t, c)
  } else if (c >= 0x20 && c <= 0x3f) csiByte(t, c) // a parameter or intermediate byte
  else if (c === ESC) t.state = ESCAPE // abandons this CSI and starts a new sequence
  else if (c === CAN || c === SUB || c > DEL) t.state = GROUND // cancelled, or a non-ASCII char ends it unrecognized
  // C0 controls inside a CSI are executed and DEL is ignored; the CSI carries on
}

function csiByte(t: ModeTracker, c: number): void {
  if (t.csiKind === CSI_NEW) {
    if (c === 0x3f) {
      t.csiKind = CSI_PRIVATE // `?`
      t.params = []
      t.param = -1
      t.sub = false
    } else t.csiKind = c === 0x21 ? CSI_BANG : CSI_OTHER // `!`, or anything else
    return
  }
  if (t.csiKind !== CSI_PRIVATE) {
    t.csiKind = CSI_OTHER // `CSI !` followed by more bytes is not DECSTR
    return
  }
  if (c >= 0x30 && c <= 0x39) {
    if (!t.sub) t.param = Math.min((t.param < 0 ? 0 : t.param) * 10 + (c - 0x30), PARAM_CEILING)
  } else if (c === 0x3b) {
    pushParam(t) // `;`
    t.sub = false
  } else if (c === 0x3a) t.sub = true // `:` — only the leading value names the mode
  else t.csiKind = CSI_OTHER // a second private marker or an intermediate: not a plain DECSET
}

function pushParam(t: ModeTracker): void {
  if (t.params.length < MAX_PARAMS) t.params.push(t.param)
  t.param = -1
}

function finishCsi(t: ModeTracker, final: number): void {
  if (t.csiKind === CSI_PRIVATE && (final === 0x68 || final === 0x6c)) {
    pushParam(t)
    const on = final === 0x68 // h sets, l resets
    for (const mode of t.params) {
      if (mode === DECNKM) setMode(t, KEYPAD, on)
      else if (REPLAYED_MODES.has(mode)) setMode(t, mode, on)
      if (!on && ALT_SCREEN_MODES.has(mode)) setMode(t, HIGHLIGHT_TRACKING, false) // the latch it cleared
      if (!on && PROTOCOL_TRACKERS.has(mode)) setMode(t, X10_TRACKING, false) // the protocol it ended
    }
  } else if (t.csiKind === CSI_BANG && final === 0x70) {
    for (const mode of SOFT_RESET_MODES) t.modes.delete(mode) // DECSTR
  }
}

function setMode(t: ModeTracker, mode: ModeKey, on: boolean): void {
  t.modes.delete(mode) // re-insert, so the order is the order of the LATEST settings
  t.modes.set(mode, on)
}

function renderModes(modes: Map<ModeKey, boolean>): string {
  let out = ''
  for (const [mode, on] of modes) {
    out += mode === KEYPAD ? (on ? '\x1b=' : '\x1b>') : `\x1b[?${mode}${on ? 'h' : 'l'}`
  }
  return out
}

export interface ReplayPreamble {
  /** Escape sequences that put a FRESH terminal into the mode state the evicted output
   *  left it in. Parse it before the window. */
  preamble: string
  /** How many chars at the start of the window finish an escape sequence the eviction
   *  cut in half. Their effect is already in the preamble; replay `output.slice(skip)`,
   *  or they print as junk text where the window begins. */
  skip: number
}

/** What a terminal rebuilt from this window must be told BEFORE the window, for the
 *  window to render the way it did live. Only a read that starts at the oldest retained
 *  char is a replay — anything later is a poller reading on from its own offset, and gets
 *  null, as does a terminal with no window at all. */
export function replayPreamble(buffers: OutputBuffers, id: string, fromOffset = 0): ReplayPreamble | null {
  const win = buffers.get(id)
  if (!win) return null
  const requested = Math.max(0, Number.isFinite(fromOffset) ? Math.floor(fromOffset) : 0)
  if (requested > win.total - win.bytes) return null
  const t = win.evicted
  if (!t) return { preamble: '', skip: 0 }
  if (t.state === GROUND) return { preamble: renderModes(t.modes), skip: 0 }
  // The evicted text ended mid-sequence, so the window opens on the rest of it. Finish
  // it on a COPY — reading the window must never move the real tracker, which completes
  // it for good only when those chars are evicted — and skip what finished it.
  const probe = cloneTracker(t)
  const head = readOutput(buffers, id)
  const end = scan(probe, head, Math.min(head.length, REPLAY_SKIP_LIMIT), true)
  return end < 0 ? { preamble: renderModes(t.modes), skip: 0 } : { preamble: renderModes(probe.modes), skip: end }
}
