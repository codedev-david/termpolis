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
//            write there any more, so they are final: appended once and never
//            re-sent to a phone that already has them. Their total length is
//            kept, plus a bounded tail of the text itself (`TAIL_CHARS`) for
//            the one reader that has to look back: a phone that opens the
//            terminal after it was already being watched, and so was never
//            sent any of it (see `snapshot`).
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
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { TerminalSize } from './protocol'

/** Environment switch for everything that makes the phone's emulator match the desktop pane after a resize and in
 *  cell widths: Unicode 11, and the resize rules of xterm 5.5.0. Any value but empty, `0` or `false` puts the
 *  flattener back to exactly what it was before those changes. The bridge is forked with main's environment, so
 *  setting it where Termpolis starts reaches it. Parsed like TERMPOLIS_DISABLE_RESIZE_FLUSH and
 *  TERMPOLIS_DISABLE_SHELL_INTEGRATION. */
export const PARITY_DISABLE_FLAG = 'TERMPOLIS_DISABLE_FLATTENER_PARITY'

export function flattenerParityDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[PARITY_DISABLE_FLAG]
  return !!v && v !== '0' && v.toLowerCase() !== 'false'
}

export interface FlattenerOptions {
  /** Match the desktop pane (see PARITY_DISABLE_FLAG). Defaults to on unless the environment switches it off;
   *  `false` is the flattener as it was, which the tests keep as their control. */
  parity?: boolean
}

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

/** How much settled text each screen keeps for a phone that opens it late.
 *
 *  The same figure as main's rolling window (terminalOutputBuffer.ts), so the
 *  second phone to open a terminal gets about the history the first one did --
 *  the first gets whatever that window flattens to. A bound rather than all of
 *  it: this is per watched terminal, for as long as it is watched, and a
 *  session runs all day. */
const TAIL_CHARS = 32_768

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
  /** The last `TAIL_CHARS` or fewer of the settled text, starting on a row.
   *  It ends exactly at `settledLen`. */
  tail: string
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

/** A screen's settled tail once `settled` has been appended to it.
 *
 *  Cut on a row, never inside one. A row cut part-way would start the late
 *  phone's copy mid-line -- and mid-colour, since the reset that makes each run
 *  self-contained sits at the front of the run. Settled text is whole rows each
 *  ending in a newline, so a newline always exists to cut after; a single row
 *  longer than the whole budget leaves the tail empty, which costs that phone
 *  some history and nothing else. */
function keepTail(tail: string, settled: string): string {
  const joined = tail + settled
  if (joined.length <= TAIL_CHARS) return joined
  return joined.slice(joined.indexOf('\n', joined.length - TAIL_CHARS - 1) + 1)
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

/** Where the written part of `line[from, to)` ends. A grid row is always the
 *  full width, so what follows the last written cell is the unwritten
 *  remainder of the row -- but a cell with a background set is painted rather
 *  than empty, so only blank cells in the default background count as unwritten. */
function trimEnd(line: IBufferLine, cell: IBufferCell, from: number, to: number): number {
  let end = to
  while (end > from) {
    line.getCell(end - 1, cell)
    const chars = cell.getChars()
    if ((chars !== '' && chars !== ' ') || !cell.isBgDefault()) break
    end -= 1
  }
  return end
}

/** One buffer row as text with colour.
 *
 *  `trimTrailing` drops the unwritten remainder of the row (see `trimEnd`):
 *  without it every line would arrive padded to 120 columns.
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
  const end = trimTrailing ? trimEnd(line, cell, from, to) : to

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

/** Whether buffer row `y` continues the row above it. Only asked of rows inside the buffer. */
function wraps(buf: IBuffer, y: number): boolean {
  return (buf.getLine(y) as IBufferLine).isWrapped
}

/** Whether row `y` ends in the blank cell xterm leaves where a double-width glyph did not fit on the row and
 *  wrapped to the next one. Rejoining wrapped rows must leave that cell out, as xterm's own reflow does
 *  (`getWrappedLineTrimmedLength`): replayed as text it became a space in the middle of the line, which pushed
 *  everything after it one cell along. Only asked of a row that the next row continues. */
function endsInWidePad(buf: IBuffer, y: number, cell: IBufferCell): boolean {
  const line = buf.getLine(y) as IBufferLine
  line.getCell(line.length - 1, cell)
  const blank = cell.getChars() === '' && cell.getWidth() === 1
  ;(buf.getLine(y + 1) as IBufferLine).getCell(0, cell)
  return blank && cell.getWidth() === 2
}

/** What a rebuild replays into the new grid, and how. */
interface Replay {
  /** The last buffer row replayed, inclusive. Rows below it are not replayed. */
  last: number
  /** The wrapped line the cursor is on, as buffer rows, inclusive. It is replayed row by row and cut at the new
   *  width instead of being rejoined, which is what xterm does with it. Empty when `heldTo < heldFrom`. */
  heldFrom: number
  heldTo: number
  /** The cursor's column in the new grid. */
  cursorX: number
  /** Blank rows to replay after the last one. */
  pad: number
}

/** Everything replayed, wrapped rows rejoined, the cursor's column as it was: the flattener before it matched the
 *  pane, kept for TERMPOLIS_DISABLE_FLATTENER_PARITY and as the tests' control. */
function legacyReplay(buf: IBuffer): Replay {
  return { last: buf.length - 1, heldFrom: 0, heldTo: -1, cursorX: buf.cursorX, pad: 0 }
}

/** How many cells of `line` are written. `trimEnd` leaves out the empty second half of a double-width glyph at the
 *  end of a row, which is right for text and one cell short for counting. */
function writtenCells(line: IBufferLine, cell: IBufferCell): number {
  const end = trimEnd(line, cell, 0, line.length)
  if (end === 0) return 0
  line.getCell(end - 1, cell)
  return cell.getWidth() === 2 ? end + 1 : end
}

/** How many rows replaying `[from, last]` fills at `cols` columns.
 *
 *  Rejoined lines wrap at the new width, so one that held three rows may now need two or four; the cursor's own
 *  line is replayed as the rows it is. Counted in cells, which is exact except where a double-width glyph does not
 *  fit at the end of a row and moves to the next: the cell it leaves behind is wasted and the count does not know,
 *  so it can come out one row short for that line. */
function rowsNeeded(
  buf: IBuffer,
  cell: IBufferCell,
  from: number,
  last: number,
  heldFrom: number,
  heldTo: number,
  cols: number,
): number {
  let needed = 0
  let y = from
  while (y <= last) {
    if (y >= heldFrom && y <= heldTo) {
      needed += 1
      y += 1
      continue
    }
    let end = y
    while (end < last && wraps(buf, end + 1)) end += 1
    const tail = buf.getLine(end) as IBufferLine
    const cells = (end - y) * tail.length + writtenCells(tail, cell)
    needed += Math.max(1, Math.ceil(cells / cols))
    y = end + 1
  }
  return needed
}

/** What to replay so the rebuilt grid is what xterm 5.5.0's own resize leaves the desktop pane with (reproduced
 *  against the real emulator in tests/electron/screenFlattenerParity.test.ts; the rules are Buffer.resize,
 *  _reflowSmaller and _reflowLarger in xterm's src/common/buffer/Buffer.ts).
 *
 *  1. A shorter screen loses the rows UNDER the cursor first, content or not, and only what still does not fit
 *     scrolls the top into history. Replaying all of them scrolled real content into the phone's permanent text:
 *     the whole screen twice, once settled and once more when the repaint that follows a resize drew it.
 *  2. The wrapped line the cursor is on is not reflowed ("the program will handle fixing up wrapped lines with the
 *     cursor"): it keeps its rows, cut at the new width, and the cursor's column is clamped into it.
 *  3. While nothing has scrolled into history, a rewrap that needs more rows pops them off the BOTTOM -- below
 *     the cursor's row, whatever they hold -- instead of scrolling the top away. Once there is history it
 *     scrolls, as it does here without help, because that is how xterm behaves then too.
 *  4. With history, a rewrap scrolls the top even when the screen has just grown and has blank room at the
 *     bottom: xterm adds the new rows first and does not let the rewrap use them (see `pad`).
 *
 *  What it does not follow, because the phone's settled rows are permanent by design: rows xterm pulls back out
 *  of its scrollback when a widened screen un-wraps them, and history it reflows. Nor does it follow a
 *  double-width glyph left sticking out of a held line that is cut.
 *
 *  Nor does it model xterm's cursor bookkeeping when a narrowing rewraps rows BELOW a cursor parked above content
 *  (a TUI with its input box above its status rows). xterm reflows from the bottom up and moves its cursor row
 *  down for every row it adds, wherever that row is, so by the time it reaches the cursor's own line the cursor
 *  has been carried onto another one: THAT line is left unreflowed (cut at the new width) and the cursor ends up
 *  below its content. A TUI that then redraws relative to the cursor lands a row or more off, on the pane and
 *  differently on the phone. Measured against a real pane: a six-row frame like that, 120 to 80 columns, with no
 *  repaint after the resize: the phone shows a row more than the pane (12 against 11) and nine of the twelve
 *  bottom rows are out of step with it (moving the cursor alone, tried, got that to six, not to none). With
 *  ConPTY's repaint the live region matched in every case measured; what is left is one stale row in the
 *  phone's history. Doing it properly means running xterm's whole bottom-up pass here, which is its own change.
 *
 *  Measured against the real emulator with the fuzz in the tests, and by hand against this machine's real
 *  ConPTY capture. */
function parityReplay(
  buf: IBuffer,
  cell: IBufferCell,
  from: TerminalSize,
  to: TerminalSize,
  scrolled: boolean,
): Replay {
  const top = buf.baseY
  const cursorRow = top + buf.cursorY

  let last = buf.length - 1
  if (to.rows < from.rows) last = Math.max(cursorRow, top + to.rows - 1)

  let heldFrom = 0
  let heldTo = -1
  let cursorX = buf.cursorX
  // Only a change of width reflows anything. Rows alone leave every wrapped line as it is, and so does a rebuild at
  // the same size, where rejoining keeps the wrap marks and the cursor's pending wrap is part of the state.
  if (to.cols !== from.cols) {
    heldFrom = cursorRow
    while (heldFrom > top && wraps(buf, heldFrom)) heldFrom -= 1
    heldTo = cursorRow
    while (heldTo < last && wraps(buf, heldTo + 1)) heldTo += 1
    cursorX = Math.min(cursorX, to.cols - 1)
  }

  if (!scrolled) {
    const overflow = rowsNeeded(buf, cell, top, last, heldFrom, heldTo, to.cols) - to.rows
    last -= Math.max(0, Math.min(overflow, last - cursorRow))
  }

  // 4. With history, a rewrap scrolls the top away even when the screen has just grown and has blank room at the
  //    bottom: xterm adds the new rows first and does not let the rewrap use them. The room is given back by
  //    replaying the rows the screen grew by as blank rows, which the rewrap then pushes the top out over.
  const pad = scrolled && to.rows > from.rows ? to.rows - from.rows : 0

  return { last, heldFrom, heldTo, cursorX, pad }
}

export class ScreenFlattener {
  private readonly screens = new Map<string, Screen>()
  /** Whether this flattener matches the desktop pane (see PARITY_DISABLE_FLAG). */
  private readonly parity: boolean

  constructor(
    private readonly cols: number = DEFAULT_COLS,
    private readonly rows: number = DEFAULT_ROWS,
    options: FlattenerOptions = {},
  ) {
    this.parity = options.parity ?? !flattenerParityDisabled()
  }

  /** Feed raw terminal bytes, get back what changed in flattened form.
   *
   *  Returns null when nothing observable changed, which is the common case for
   *  a redraw that repaints the same frame -- the spinner between ticks, say. */
  async feed(terminalId: string, raw: string, size?: TerminalSize): Promise<FlatEdit | null> {
    const wanted = usable(size)
    // Made even for no bytes at all. An opening read of a terminal that has
    // printed nothing is still a screen -- an empty one -- and `snapshot` has to
    // be able to say so: "no screen" there left the next phone to open it
    // showing whatever it had held for that terminal before.
    const screen = this.screenFor(terminalId, wanted)
    if (raw === '') return null
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
    screen.tail = keepTail(screen.tail, settled)
    screen.live = live

    // The phone holds `settled-so-far + before`; it should hold that same
    // settled prefix, plus what just settled, plus the new live region. So the
    // only thing that can have changed starts at `base`.
    const after = settled + live
    const shared = commonPrefix(before, after)
    if (shared === before.length && shared === after.length) return null
    return { replaceFrom: base + shared, text: after.slice(shared) }
  }

  /** The screen as it stands, for a phone that has none of it.
   *
   *  The kept settled tail plus the viewport, anchored where the tail starts in
   *  the stream. A phone that applies it holds the end of exactly what a phone
   *  watching from the start holds, in the same numbering, so every edit `feed`
   *  returns afterwards applies to both alike. That is what lets a second phone
   *  join a terminal without the first being sent anything at all.
   *
   *  It reads only what `feed` commits, and `feed` commits synchronously once
   *  its bytes are through the emulator, so a snapshot taken while a feed is
   *  still in flight is the screen from before it -- which is precisely the
   *  screen that feed's own edit is measured against.
   *
   *  Null when there is no emulator for this terminal: nothing at all has been
   *  fed for it since it was last forgotten, not even an empty read. That is
   *  "no screen yet", which is not the same answer as an empty screen. */
  snapshot(terminalId: string): FlatEdit | null {
    const screen = this.screens.get(terminalId)
    if (screen === undefined) return null
    return { replaceFrom: screen.settledLen - screen.tail.length, text: screen.tail + screen.live }
  }

  /** The viewport alone, as one edit: the part of a screen a rewrite may replace.
   *
   *  Everything above it is settled -- permanent, sent once, never again -- so a copy that is only wrong in the
   *  viewport is put right by this and by nothing larger. It starts where the settled text ends, which is also
   *  where `snapshot`'s text passes from the kept tail to the viewport: the two are in one numbering, and either
   *  applies to the same copy. Reads only what `feed` has committed, like `snapshot`.
   *
   *  Null when there is no emulator for this terminal. */
  liveRegion(terminalId: string): FlatEdit | null {
    const screen = this.screens.get(terminalId)
    if (screen === undefined) return null
    return { replaceFrom: screen.settledLen, text: screen.live }
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
      tail: '',
      settledCount: 0,
      normalSettledCount: 0,
      inAlt: false,
      live: '',
    }
    this.screens.set(terminalId, screen)
    return screen
  }

  private newTerminal(cols: number, rows: number): Terminal {
    const term = new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      // The phone never types into this emulator and never reads a reply from
      // it; it exists only to be looked at. Leaving conversion off keeps what we
      // render byte-for-byte what the desktop rendered.
      convertEol: false,
      allowProposedApi: true,
    })
    if (this.parity) loadUnicode11(term)
    return term
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
   *  cursor sits, which is what a differential repaint moves relative to.
   *
   *  The replay is not blind. What the phone must end up with is what the pane
   *  ends up with when xterm resizes it, so `parityReplay` decides which rows are
   *  replayed and which line is left unreflowed. A replay that just played back
   *  every row, blank ones under the cursor included, scrolled real content out
   *  of a smaller grid into the settled text -- which is permanent, and then the
   *  repaint ConPTY sends after every resize drew it a second time. */
  private rebuild(screen: Screen, cols: number, rows: number): void {
    const buf = screen.term.buffer.active
    const cell = buf.getNullCell()
    const cursorRow = buf.baseY + buf.cursorY
    const { last, heldFrom, heldTo, cursorX, pad } = this.parity
      ? parityReplay(buf, cell, { cols: screen.cols, rows: screen.rows }, { cols, rows }, screen.settledLen > 0)
      : legacyReplay(buf)
    const parts: string[] = []
    for (let y = buf.baseY; y <= last; y += 1) {
      const line = buf.getLine(y)
      /* v8 ignore next -- y is bounded by buf.length, so the undefined arm is
         unreachable; it exists because getLine is typed for out-of-range reads */
      if (line === undefined) continue
      // The cursor's own wrapped line is replayed as the rows it is (see
      // parityReplay), and cut where the new grid ends.
      const held = y >= heldFrom && y <= heldTo
      let to = line.length
      if (held) to = Math.min(to, cols)
      // Rejoined, unlike anything sent to the phone: a wrap is a break the OLD
      // width imposed, and replaying it would freeze that break into a grid that
      // may no longer have it. A held row is joined too when the cut leaves it
      // filling the new width: that is not a reflow, it keeps the wrap mark xterm
      // keeps on those rows, so the NEXT resize -- a window being dragged is a run
      // of them -- reflows the line like any other once the cursor has left it. A
      // held row narrower than the grid (a widening) stays a row of its own.
      const continues = y < last && wraps(buf, y + 1) && (!held || to === cols)
      // A row that is joined to the next one leaves out the pad cell a double-width
      // glyph left behind at its end.
      if (!held && this.parity && continues && endsInWidePad(buf, y, cell)) to -= 1
      if (y === cursorRow) {
        // Split at the cursor's own cell and mark the spot, so the emulator is
        // the one that works out where the cursor lands at the new width -- the
        // old row and column name a cell the reflow has moved. Nothing is
        // trimmed to the left of the mark: those blank cells are what put the
        // cursor where it is.
        parts.push(encodeLine(line, cell, false, 0, cursorX), SAVE_CURSOR)
        parts.push(encodeLine(line, cell, !continues, cursorX, to))
      } else {
        parts.push(encodeLine(line, cell, !continues, 0, to))
      }
      // Carriage return as well as newline: a row filled to the last column
      // leaves the cursor pending a wrap, and a bare newline would carry that
      // column down with it. Never after the last row -- that would scroll the
      // grid, and the replay is meant to reproduce it, not extend it.
      if (!continues && y < last) parts.push('\r\n')
    }

    screen.term.dispose()
    screen.term = this.newTerminal(cols, rows)
    screen.cols = cols
    screen.rows = rows
    screen.term.write(`${parts.join('')}${'\r\n'.repeat(pad)}${RESTORE_CURSOR}`)
    screen.settledCount = 0
    screen.normalSettledCount = 0
    screen.inAlt = false
  }
}

/** Count cell widths the way the desktop pane does (TerminalPane.tsx loads the
 *  same addon and selects the same version). The default table is Unicode 6,
 *  which is one cell narrower for most emoji and dingbats; a TUI that addresses
 *  the cell AFTER one then lands a cell off on the phone -- "passed" arrived as
 *  "ppassed". Fails open: an emulator that cannot take the table keeps the
 *  default one, which is slightly wrong about a few glyphs and alive, where the
 *  alternative was a bridge that died on a width table. */
function loadUnicode11(term: Terminal): void {
  try {
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
  } catch {
    // Deliberately nothing: see above.
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
