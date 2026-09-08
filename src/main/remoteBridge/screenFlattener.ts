// Flattens cursor-addressed terminal output into plain scrollback for the phone.
//
// The phone's renderer (mobile/src/ansi/render.ts) is deliberately not an
// emulator: it keeps colour and drops every sequence that moves a cursor,
// because a phone view is a scrollback and not a grid. That is the right model
// for line-oriented programs -- `ls`, `git log`, a compiler -- which is what it
// was built and measured against.
//
// It is the wrong model for a TUI agent, and Claude Code is a TUI agent. Its
// status line redraws in place about ten times a second by writing `\r`,
// erase-line, then the frame. On a real terminal one line is overwritten and
// only the newest frame exists. Strip the cursor control and every frame
// survives as its own line, which is why a paired phone showed a screen of
//
//     Compacting conversation...Compacting conversation...Compacting con...
//
// The same mechanism eats prose. Ink, the library Claude Code renders with,
// repaints differentially: it moves the cursor over cells that already hold the
// right glyph instead of rewriting them. Drop those moves and the skipped cells
// are simply absent, so "that cleared on its own" arrives as "tclearedo".
//
// Both are the same defect: an append-only view of a stream that assumes a grid.
// The fix is to keep the grid somewhere, and the honest place is here rather
// than on the phone -- this process already holds the bytes, the emulator is the
// same one the desktop renders with, and doing it once server-side means the
// phone shows what the desktop shows instead of an approximation of it.
//
// What leaves here is text plus SGR colour: no cursor motion, no erases. That is
// precisely the input the phone's renderer was designed for, so its
// "deliberately not an emulator" stance becomes correct rather than lossy.
//
//
// The grid is split in two, and that split is what makes this cheap and exact.
//
//   settled  Lines that have scrolled above the viewport. A terminal cannot
//            write there any more, so they are final: appended once, never
//            looked at again, and never re-sent. Only their total length is
//            kept, because nothing here ever needs to read them back.
//   live     The viewport. Rewritten in place by every redraw, so it is
//            re-rendered on each feed and diffed against its previous form.
//
// Every edit is therefore bounded by one screenful plus whatever newly scrolled
// out, no matter how long the session has run. An earlier draft diffed against
// the whole accumulated stream instead; it grew slower all day, and it went
// silently wrong the moment the emulator's scrollback overflowed, because the
// buffer stopped being a superset of what the phone had been sent.

import { Terminal } from '@xterm/headless'
import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/headless'
import type { TerminalSize } from './protocol'

/** Lines the emulator may hold before we rebuild it from its viewport.
 *
 *  Bounds steady-state memory per watched terminal. Nothing above the viewport
 *  is ever read again -- it has already been settled and sent -- so keeping it
 *  buys nothing. */
const RECYCLE_AT_LINES = 4000

/** Emulator scrollback, which is pure headroom above `RECYCLE_AT_LINES`.
 *
 *  Only the gap between the two is ever used, and it exists so that a single
 *  enormous write cannot push lines off the top before we have settled them.
 *  16,000 spare rows is roughly two megabytes of unbroken output in one read. */
const SCROLLBACK_LINES = 20_000

/** Newlines per write segment.
 *
 *  A batch is fed in pieces so lines are settled as they scroll rather than all
 *  at the end, which is what keeps the headroom above from being consumed. Cuts
 *  land immediately after a newline, which is never inside an escape sequence. */
const SEGMENT_LINES = 1000

/** Emulator geometry when main has not told us the real one.
 *
 *  A fallback and nothing more: main sends the terminal's real size down with
 *  every slice, and guessing is the bug this default used to BE. A TUI addresses
 *  cells by number, so a redraw meant for a 150-column grid replayed into a
 *  120-column one does not merely wrap differently -- `move to column 130` lands
 *  somewhere else entirely, which is how "that cleared on its own" arrived on the
 *  phone as "tclearedo". Height is no safer: a viewport shorter than the real one
 *  scrolls rows out early, and a row that scrolls out here has been SETTLED --
 *  sent as permanent -- while the real terminal is still painting over it. That
 *  is the duplicated spinner, one frame frozen above the live one. */
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

const RESET = '\x1b[0m'
/** DECSC/DECRC. Used to mark a spot mid-replay and come back to it once
 *  the emulator has laid the rest of the text out for itself. */
const SAVE_CURSOR = '\x1b7'
const RESTORE_CURSOR = '\x1b8'

/** One flattened update, in terms of the stream the phone has already applied.
 *
 *  `replaceFrom` is an offset into that stream: the phone truncates to it and
 *  appends `text`. Output that only grows produces an offset equal to what the
 *  phone already holds, so the ordinary case costs nothing extra; a redraw
 *  produces one that points back into the live region. */
export interface FlatEdit {
  /** Truncate the phone's copy to this many chars before appending. */
  replaceFrom: number
  /** Text to append after truncating. Plain text and SGR only. */
  text: string
}

interface Screen {
  term: Terminal
  /** The geometry this emulator is currently running at, which is main's answer
   *  for the real terminal and not a guess of ours. */
  cols: number
  rows: number
  /** Total length of everything settled so far. The offset the live region
   *  starts at, which is what every `replaceFrom` is measured against. */
  settledLen: number
  /** Buffer row up to which the current buffer has been settled (exclusive). */
  settledCount: number
  /** Where `settledCount` stood in the normal buffer, kept across an excursion
   *  into the alternate screen so the normal buffer is not settled twice. */
  normalSettledCount: number
  /** Whether the emulator is currently on the alternate screen. */
  inAlt: boolean
  /** The live region exactly as the phone last received it. */
  live: string
}

/** A reported geometry, or undefined when it is not one we can draw on.
 *
 *  A pane still being laid out reports zero, and xterm silently clamps a zero
 *  width to a two-column grid rather than refusing it -- which shreds the output
 *  into a two-character-wide column instead of failing loudly. The last known
 *  geometry is a better answer than either, so an implausible size is dropped
 *  here, once, before anything can be built at it. */
function usable(size: TerminalSize | undefined): TerminalSize | undefined {
  if (size === undefined) return undefined
  return size.cols >= 1 && size.rows >= 1 ? size : undefined
}

/** How many leading chars two strings share. */
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1
  return i
}

/** The SGR run for one cell, or '' when the cell carries no styling.
 *
 *  Each run opens with a reset so it is self-contained: the phone can start
 *  reading at any point in the stream -- which it does, because its own cap
 *  trims the head -- without inheriting an attribute it never saw set. */
function sgrOf(cell: IBufferCell): string {
  const parts: number[] = []
  if (cell.isBold() !== 0) parts.push(1)
  if (cell.isDim() !== 0) parts.push(2)
  if (cell.isItalic() !== 0) parts.push(3)
  if (cell.isUnderline() !== 0) parts.push(4)
  if (cell.isInverse() !== 0) parts.push(7)
  if (!cell.isFgDefault()) {
    const c = cell.getFgColor()
    if (cell.isFgPalette()) parts.push(38, 5, c)
    else parts.push(38, 2, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff)
  }
  if (!cell.isBgDefault()) {
    const c = cell.getBgColor()
    if (cell.isBgPalette()) parts.push(48, 5, c)
    else parts.push(48, 2, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff)
  }
  return parts.length === 0 ? '' : `\x1b[0;${parts.join(';')}m`
}

/** One buffer row as text with colour.
 *
 *  `trimTrailing` drops the unwritten remainder of the row. A grid row is always
 *  the full width, so without this every line would arrive padded to 120 columns
 *  -- but a cell with a background set is painted rather than empty, so only
 *  blank cells in the default background count as unwritten.
 *
 *  `from`/`to` cut the row down to a span of it. Only a rebuild needs that, to
 *  split the cursor's own row at the cursor. */
function encodeLine(
  line: IBufferLine,
  cell: IBufferCell,
  trimTrailing: boolean,
  from = 0,
  to = line.length,
): string {
  let end = to
  if (trimTrailing) {
    while (end > from) {
      line.getCell(end - 1, cell)
      const chars = cell.getChars()
      if ((chars !== '' && chars !== ' ') || !cell.isBgDefault()) break
      end -= 1
    }
  }

  let out = ''
  let open = ''
  for (let x = from; x < end; x += 1) {
    line.getCell(x, cell)
    // Width 0 is the second half of a double-width glyph: the character was
    // already emitted with its first cell, and emitting it again would double it.
    if (cell.getWidth() === 0) continue
    const sgr = sgrOf(cell)
    if (sgr !== open) {
      out += sgr === '' ? RESET : sgr
      open = sgr
    }
    const chars = cell.getChars()
    out += chars === '' ? ' ' : chars
  }
  // Close the run so a styled line cannot colour whatever follows it.
  if (open !== '') out += RESET
  return out
}

export class ScreenFlattener {
  private readonly screens = new Map<string, Screen>()

  constructor(
    private readonly cols: number = DEFAULT_COLS,
    private readonly rows: number = DEFAULT_ROWS,
  ) {}

  /** Feed raw terminal bytes, get back what changed in flattened form.
   *
   *  Returns null when nothing observable changed, which is the common case for
   *  a redraw that repaints the same frame -- the spinner between ticks, say. */
  async feed(terminalId: string, raw: string, size?: TerminalSize): Promise<FlatEdit | null> {
    if (raw === '') return null
    const wanted = usable(size)
    const screen = this.screenFor(terminalId, wanted)
    // Before the bytes, never after: these bytes were drawn for this geometry,
    // and applying the resize afterwards would emulate them against the old one.
    if (wanted !== undefined) this.applySize(screen, wanted)

    const base = screen.settledLen
    const before = screen.live
    let settled = ''

    for (const segment of segments(raw)) {
      await write(screen.term, segment)
      settled += this.settle(screen)
      if (screen.term.buffer.active.length >= RECYCLE_AT_LINES) {
        this.rebuild(screen, screen.cols, screen.rows)
      }
    }

    const live = this.renderLive(screen)
    screen.settledLen = base + settled.length
    screen.live = live

    // The phone holds `settled-so-far + before`; it should hold that same
    // settled prefix, plus what just settled, plus the new live region. So the
    // only thing that can have changed starts at `base`.
    const after = settled + live
    const shared = commonPrefix(before, after)
    if (shared === before.length && shared === after.length) return null
    return { replaceFrom: base + shared, text: after.slice(shared) }
  }

  /** Drop a terminal's emulator. Called when nobody is watching it any more:
   *  an emulator kept for an unwatched terminal is a grid nobody reads. */
  forget(terminalId: string): void {
    const screen = this.screens.get(terminalId)
    if (screen === undefined) return
    screen.term.dispose()
    this.screens.delete(terminalId)
  }

  forgetAll(): void {
    for (const id of [...this.screens.keys()]) this.forget(id)
  }

  private screenFor(terminalId: string, size?: TerminalSize): Screen {
    const existing = this.screens.get(terminalId)
    if (existing !== undefined) return existing
    // Born at the real size when it is known, so the very first frame is
    // emulated against the right grid rather than rebuilt a moment later.
    const cols = size?.cols ?? this.cols
    const rows = size?.rows ?? this.rows
    const screen: Screen = {
      term: this.newTerminal(cols, rows),
      cols,
      rows,
      settledLen: 0,
      settledCount: 0,
      normalSettledCount: 0,
      inAlt: false,
      live: '',
    }
    this.screens.set(terminalId, screen)
    return screen
  }

  private newTerminal(cols: number, rows: number): Terminal {
    return new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      // The phone never types into this emulator and never reads a reply from
      // it; it exists only to be looked at. Leaving conversion off keeps what we
      // render byte-for-byte what the desktop rendered.
      convertEol: false,
      allowProposedApi: true,
    })
  }

  /** Move rows that have scrolled above the viewport out of the live region.
   *
   *  Returns the text they contribute, which is appended once and never
   *  reconsidered -- a terminal cannot address a row it has scrolled past. */
  private settle(screen: Screen): string {
    const buf = screen.term.buffer.active

    // The alternate screen is a scratch grid: it has no scrollback, it is
    // discarded wholesale on exit, and nothing in it is ever final. Settling out
    // of it would append a `less` session to the phone's history and then, on
    // exit, replay the normal buffer's history behind it.
    const alt = buf.type === 'alternate'
    if (alt !== screen.inAlt) {
      screen.inAlt = alt
      screen.settledCount = alt ? 0 : screen.normalSettledCount
    }
    if (alt) return ''

    // Clearing the scrollback (`ESC[3J`, or a reset) shortens the buffer under
    // us. Rows we already settled are gone, and the rows that remain are the
    // ones we were treating as live, so the live region simply starts again at
    // the top. Nothing is re-settled and nothing already sent is disturbed.
    const top = buf.baseY
    if (top < screen.settledCount) screen.settledCount = top

    // Every row above the viewport settles, wrapped continuations included. An
    // earlier draft held a wrapping line back so the phone could re-wrap it to
    // its own width; the phone no longer re-wraps anything, because matching the
    // desktop's grid IS the requirement now, and a row held back here is a row
    // the desktop has already scrolled past.
    let out = ''
    for (const line of this.encodeRows(buf, screen.settledCount, top)) out += `${line}\n`
    screen.settledCount = top
    screen.normalSettledCount = top
    return out
  }

  /** The viewport as text: everything a terminal may still rewrite. */
  private renderLive(screen: Screen): string {
    const buf = screen.term.buffer.active
    const rows = this.encodeRows(buf, screen.settledCount, buf.length)
    // A grid is always a full rectangle, so a viewport holding two lines of
    // output also holds twenty-eight blank rows. Sending those would put
    // twenty-eight empty lines on the phone after every command.
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
    return rows.join('\n')
  }

  /** The rows in `[from, to)`, one string each, blank-padding trimmed.
   *
   *  One string per grid row, never rejoined: everything bound for the phone
   *  keeps the rows as the desktop drew them. Rejoining used to let the phone
   *  re-wrap to its own width, which is reasonable for `ls` output and wrong for
   *  a TUI -- a box ruled across 120 columns came apart into three ragged phone
   *  rows, and three ragged rows per border is exactly the mess a desktop
   *  screenshot of the same moment does not have. */
  private encodeRows(buf: IBuffer, from: number, to: number): string[] {
    const cell = buf.getNullCell()
    const out: string[] = []
    for (let y = from; y < to; y += 1) {
      const line = buf.getLine(y)
      /* v8 ignore next -- y is bounded by buf.length, so the undefined arm is
         unreachable; it exists because getLine is typed for out-of-range reads */
      if (line === undefined) continue
      out.push(encodeLine(line, cell, true))
    }
    return out
  }

  /** Adopt the terminal's real geometry, rebuilding if it actually changed.
   *
   *  `xterm`'s own `resize` reflows the buffer, which would silently rewrite rows
   *  the phone has already been sent as settled -- permanent text, by definition.
   *  Rebuilding from the viewport instead touches only the live region, and the
   *  live region is re-diffed on this same feed anyway. */
  private applySize(screen: Screen, size: TerminalSize): void {
    if (size.cols === screen.cols && size.rows === screen.rows) return
    this.rebuild(screen, size.cols, size.rows)
  }

  /** Rebuild the emulator from its own viewport, dropping the scrollback.
   *
   *  Everything above the viewport has already been settled and sent, so the
   *  emulator is holding it for nobody. Replaying the viewport into a fresh
   *  terminal keeps the grid a redraw is about to address -- including where the
   *  cursor sits, which is what a differential repaint moves relative to. */
  private rebuild(screen: Screen, cols: number, rows: number): void {
    const buf = screen.term.buffer.active
    const cell = buf.getNullCell()
    const cursorRow = buf.baseY + buf.cursorY
    const parts: string[] = []
    for (let y = buf.baseY; y < buf.length; y += 1) {
      const line = buf.getLine(y)
      /* v8 ignore next -- y is bounded by buf.length, so the undefined arm is
         unreachable; it exists because getLine is typed for out-of-range reads */
      if (line === undefined) continue
      const next = y + 1 < buf.length ? buf.getLine(y + 1) : undefined
      // Rejoined, unlike anything sent to the phone: a wrap is a break the OLD
      // width imposed, and replaying it would freeze that break into a grid that
      // may no longer have it.
      const continues = next !== undefined && next.isWrapped
      if (y === cursorRow) {
        // Split at the cursor's own cell and mark the spot, so the emulator is
        // the one that works out where the cursor lands at the new width -- the
        // old row and column name a cell the reflow has moved. Nothing is
        // trimmed to the left of the mark: those blank cells are what put the
        // cursor where it is.
        parts.push(encodeLine(line, cell, false, 0, buf.cursorX), SAVE_CURSOR)
        parts.push(encodeLine(line, cell, !continues, buf.cursorX))
      } else {
        parts.push(encodeLine(line, cell, !continues))
      }
      // Carriage return as well as newline: a row filled to the last column
      // leaves the cursor pending a wrap, and a bare newline would carry that
      // column down with it. Never after the last row -- that would scroll the
      // grid, and the replay is meant to reproduce it, not extend it.
      if (!continues && y + 1 < buf.length) parts.push('\r\n')
    }

    screen.term.dispose()
    screen.term = this.newTerminal(cols, rows)
    screen.cols = cols
    screen.rows = rows
    screen.term.write(`${parts.join('')}${RESTORE_CURSOR}`)
    screen.settledCount = 0
    screen.normalSettledCount = 0
    screen.inAlt = false
  }
}

/** Write and wait for the parser to finish, so the grid is settled before it is
 *  read. Terminal bytes only mean anything in order. */
function write(term: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    term.write(data, resolve)
  })
}

/** Split a batch after every `SEGMENT_LINES` newlines.
 *
 *  Purely so the caller can settle as it goes: a single read carrying a hundred
 *  thousand lines would otherwise push rows off the top of the emulator before
 *  anything had a chance to record them. */
function* segments(raw: string): Generator<string> {
  let start = 0
  let lines = 0
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) !== 10) continue
    lines += 1
    if (lines < SEGMENT_LINES) continue
    yield raw.slice(start, i + 1)
    start = i + 1
    lines = 0
  }
  if (start < raw.length) yield raw.slice(start)
}
