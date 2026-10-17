// A terminal's screen rebuilt from its raw output, as text.
//
// Swarm workers are TUIs (Claude Code, Codex, agy), and on Windows their output reaches Termpolis
// through ConPTY, which sends a screen's CHANGES: a cursor move to each cell that changed and the
// new glyphs there, `ESC[1C` over a cell that stayed the same, an erase where text went away. Read
// as a stream, that text is wrong twice over (GitHub #36). Words lose their spaces, so
// "bypass ESC[1C permissions" reads as "bypasspermissions". And what was erased is still there:
// Codex's "esc to interrupt" stays in the stream after the turn that drew it has ended, and Claude
// Code's spinner leaves one glyph per frame. Replaying the output into a grid of cells gives what
// the screen shows now, which is the question every reader of a worker's terminal is asking.
//
// Deliberately small: the sequences ConPTY and these TUIs send (cursor moves, erases, inserts and
// deletes, scrolling and scroll regions, the alternate screen, the window title), and nothing else.
// No colours, no modes beyond autowrap. Synchronous and dependency-free, so the renderer's swarm
// bridge and the main process's MCP server can both use it. @xterm/headless is exact, but it parses
// asynchronously and is CommonJS, which the ESM bundles can't import by name (electron.vite.config.ts);
// the tests check this model against it on real captures.

export interface ScreenSize {
  cols: number
  rows: number
}

/** A terminal Termpolis never showed: swarm workers run hidden, at the size they were spawned at
 *  (terminalManager.ts). */
export const DEFAULT_SCREEN: ScreenSize = { cols: 80, rows: 24 }

/** How many rows scrolled off the top are kept for takeScrolledOff, at most. */
const SCROLLED_OFF_MAX = 1000

const GROUND = 0
const ESCAPE = 1
/** ESC followed by an intermediate byte, e.g. `ESC ( B`: a charset, ignored to its final byte. */
const ESCAPE_INTERMEDIATE = 2
const CSI = 3
const OSC = 4
/** DCS, SOS, PM, APC: skipped to their string terminator. */
const STRING = 5

// Cell widths as xterm.js's default (Unicode 6) tables give them, so a replay lays a row out the
// way Termpolis's own terminals do. Ranges are [first, last] code points.
const ZERO_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x2064], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff], [0xe0100, 0xe01ef],
]
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3040, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false
    if (cp <= hi) return true
  }
  return false
}

function cellWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x300) return 1
  if (inRanges(cp, ZERO_WIDTH)) return 0
  return inRanges(cp, WIDE) ? 2 : 1
}

/** A wide glyph's second cell. */
const CONTINUATION = ''

interface Cursor {
  x: number
  y: number
}

/** The main screen or the alternate one. Each keeps its own scroll region and saved cursor, as
 *  xterm's do; the cursor itself is shared, carried across a switch. */
interface ScreenBuffer {
  grid: string[][]
  top: number
  bottom: number
  saved: Cursor
}

export class TerminalScreen {
  readonly cols: number
  readonly rows: number
  /** The last window title the output set (OSC 0 or 2). Claude Code and Codex put a spinner in it
   *  while they work. */
  title = ''

  private main: ScreenBuffer
  private alt: ScreenBuffer
  private inAlt = false
  private x = 0
  private y = 0
  /** At the last column after printing there: the next glyph goes to the next row first. */
  private wrapPending = false
  private autowrap = true
  private scrolledOff: string[] = []

  private state = GROUND
  private seq = ''

  constructor(size: ScreenSize = DEFAULT_SCREEN) {
    this.cols = Math.max(1, Math.floor(size.cols))
    this.rows = Math.max(1, Math.floor(size.rows))
    this.main = this.newBuffer()
    this.alt = this.newBuffer()
  }

  /** Feeds output in; it may stop anywhere, mid-sequence included. */
  write(data: string): void {
    for (const ch of data) {
      const cp = ch.codePointAt(0)!
      switch (this.state) {
        case GROUND:
          this.ground(ch, cp)
          break
        case ESCAPE:
          this.escape(ch, cp)
          break
        case ESCAPE_INTERMEDIATE:
          if (cp >= 0x30 && cp <= 0x7e) this.state = GROUND
          else if (cp === 0x1b) this.state = ESCAPE
          break
        case CSI:
          if (cp >= 0x40 && cp <= 0x7e) {
            this.state = GROUND
            this.csi(this.seq, ch)
          } else if (cp === 0x1b) this.state = ESCAPE
          else if (cp === 0x18 || cp === 0x1a) this.state = GROUND
          // A C0 control inside a sequence is carried out, and the sequence goes on.
          else if (cp < 0x20) this.ground(ch, cp)
          else this.seq += ch
          break
        case OSC:
          if (cp === 0x07) this.endOsc()
          else if (cp === 0x1b) {
            // ESC \ ends it; any other ESC abandons it for a new sequence. Either way ESCAPE reads on.
            this.endOsc()
            this.state = ESCAPE
          } else this.seq += ch
          break
        default: // STRING
          if (cp === 0x1b) this.state = ESCAPE
          else if (cp === 0x18 || cp === 0x1a) this.state = GROUND
      }
    }
  }

  /** The visible rows, top to bottom, trailing spaces trimmed. */
  lines(): string[] {
    return this.grid().map(rowText)
  }

  /** Rows that scrolled off the top of the main screen since the last call, oldest first. Final:
   *  nothing can be drawn over them any more. */
  takeScrolledOff(): string[] {
    const off = this.scrolledOff
    this.scrolledOff = []
    return off
  }

  private get buf(): ScreenBuffer {
    return this.inAlt ? this.alt : this.main
  }

  private grid(): string[][] {
    return this.buf.grid
  }

  private newBuffer(): ScreenBuffer {
    return { grid: this.blankGrid(), top: 0, bottom: this.rows - 1, saved: { x: 0, y: 0 } }
  }

  private blankRow(): string[] {
    return new Array<string>(this.cols).fill(' ')
  }

  private blankGrid(): string[][] {
    return Array.from({ length: this.rows }, () => this.blankRow())
  }

  private ground(ch: string, cp: number): void {
    if (cp >= 0x20 && cp !== 0x7f && (cp < 0x80 || cp > 0x9f)) {
      this.print(ch, cp)
      return
    }
    switch (cp) {
      case 0x1b:
        this.state = ESCAPE
        break
      case 0x0d:
        this.x = 0
        this.wrapPending = false
        break
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.lineFeed()
        break
      case 0x08:
        this.x = Math.max(0, this.x - 1)
        this.wrapPending = false
        break
      case 0x09:
        this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8)
        this.wrapPending = false
        break
      // BEL, the other C0 controls, DEL and the C1 controls do nothing on screen.
    }
  }

  private escape(ch: string, cp: number): void {
    this.state = GROUND
    switch (ch) {
      case '[':
        this.state = CSI
        this.seq = ''
        break
      case ']':
        this.state = OSC
        this.seq = ''
        break
      case 'P':
      case 'X':
      case '^':
      case '_':
        this.state = STRING
        break
      case '7':
        this.buf.saved = { x: this.x, y: this.y }
        break
      case '8':
        this.moveTo(this.buf.saved.x, this.buf.saved.y)
        break
      case 'D':
        this.lineFeed()
        break
      case 'E':
        this.x = 0
        this.lineFeed()
        break
      case 'M':
        this.wrapPending = false
        if (this.y === this.buf.top) this.scrollDown(1)
        else this.y = Math.max(0, this.y - 1)
        break
      case 'c':
        this.reset()
        break
      default:
        if (cp >= 0x20 && cp <= 0x2f) this.state = ESCAPE_INTERMEDIATE
        else if (cp === 0x1b) this.state = ESCAPE
      // `\` (string terminator), `=`, `>` and the rest change nothing on screen.
    }
  }

  private endOsc(): void {
    this.state = GROUND
    const sep = this.seq.indexOf(';')
    const id = sep < 0 ? this.seq : this.seq.slice(0, sep)
    if (id === '0' || id === '2') this.title = sep < 0 ? '' : this.seq.slice(sep + 1)
  }

  private print(ch: string, cp: number): void {
    const width = cellWidth(cp)
    const grid = this.grid()
    // A combining mark joins the glyph before it; at the start of a row it takes a cell of its own.
    const joins = width === 0 && (this.wrapPending || this.x > 0)
    if (joins) {
      grid[this.y][this.wrapPending ? this.x : this.x - 1] += ch
      return
    }
    if (this.wrapPending || (width === 2 && this.x === this.cols - 1)) {
      if (this.autowrap) {
        this.x = 0
        this.lineFeed()
      }
      this.wrapPending = false
    }
    const row = grid[this.y]
    this.clearWideAt(row, this.x)
    row[this.x] = ch
    if (width === 2 && this.x + 1 < this.cols) {
      this.clearWideAt(row, this.x + 1)
      row[this.x + 1] = CONTINUATION
    }
    this.x += Math.max(1, width)
    if (this.x >= this.cols) {
      this.x = this.cols - 1
      this.wrapPending = true
    }
  }

  /** Writing over half of a wide glyph blanks its other half. */
  private clearWideAt(row: string[], x: number): void {
    if (row[x] === CONTINUATION && x > 0) row[x - 1] = ' '
    if (x + 1 < this.cols && row[x + 1] === CONTINUATION) row[x + 1] = ' '
  }

  private lineFeed(): void {
    this.wrapPending = false
    if (this.y === this.buf.bottom) this.scrollUp(1)
    else if (this.y < this.rows - 1) this.y++
  }

  private scrollUp(n: number): void {
    const grid = this.grid()
    for (let i = 0; i < n; i++) {
      const [gone] = grid.splice(this.buf.top, 1)
      if (this.buf.top === 0 && !this.inAlt) {
        this.scrolledOff.push(rowText(gone))
        if (this.scrolledOff.length > SCROLLED_OFF_MAX) this.scrolledOff.shift()
      }
      grid.splice(this.buf.bottom, 0, this.blankRow())
    }
  }

  private scrollDown(n: number): void {
    const grid = this.grid()
    for (let i = 0; i < n; i++) {
      grid.splice(this.buf.bottom, 1)
      grid.splice(this.buf.top, 0, this.blankRow())
    }
  }

  private moveTo(x: number, y: number): void {
    this.x = Math.min(Math.max(0, x), this.cols - 1)
    this.y = Math.min(Math.max(0, y), this.rows - 1)
    this.wrapPending = false
  }

  private reset(): void {
    this.main = this.newBuffer()
    this.alt = this.newBuffer()
    this.inAlt = false
    this.autowrap = true
    this.title = ''
    this.moveTo(0, 0)
  }

  private csi(body: string, final: string): void {
    const prefix = body[0] === '?' || body[0] === '>' || body[0] === '<' || body[0] === '=' ? body[0] : ''
    const rest = prefix ? body.slice(1) : body
    // Intermediate bytes (` q`, `!p`, `$p`...) make it a sequence this model has no use for.
    if (/[ -/]/.test(rest)) return
    const params = rest === '' ? [] : rest.split(';').map((p) => {
      const n = parseInt(p, 10)
      return Number.isFinite(n) ? n : 0
    })
    if (prefix === '?') {
      if (final === 'h' || final === 'l') this.privateModes(params, final === 'h')
      return
    }
    if (prefix) return // kitty keyboard, modifyOtherKeys, device attributes
    const n = Math.max(1, params[0] || 0)
    const grid = this.grid()
    switch (final) {
      case 'A':
        this.moveTo(this.x, this.y >= this.buf.top ? Math.max(this.buf.top, this.y - n) : this.y - n)
        break
      case 'B':
      case 'e':
        this.moveTo(this.x, this.y <= this.buf.bottom ? Math.min(this.buf.bottom, this.y + n) : this.y + n)
        break
      case 'C':
      case 'a':
        this.moveTo(this.x + n, this.y)
        break
      case 'D':
        this.moveTo(this.x - n, this.y)
        break
      case 'E':
        this.moveTo(0, Math.min(this.buf.bottom, this.y + n))
        break
      case 'F':
        this.moveTo(0, Math.max(this.buf.top, this.y - n))
        break
      case 'G':
      case '`':
        this.moveTo(n - 1, this.y)
        break
      case 'H':
      case 'f':
        this.moveTo(Math.max(1, params[1] || 0) - 1, n - 1)
        break
      case 'd':
        this.moveTo(this.x, n - 1)
        break
      case 'I':
        for (let i = 0; i < n; i++) this.moveTo((Math.floor(this.x / 8) + 1) * 8, this.y)
        break
      case 'Z':
        for (let i = 0; i < n; i++) this.moveTo((Math.ceil(this.x / 8) - 1) * 8, this.y)
        break
      case 'J':
        this.eraseInDisplay(params[0] || 0)
        break
      case 'K':
        this.eraseInLine(grid[this.y], params[0] || 0)
        break
      case 'X':
        for (let x = this.x; x < Math.min(this.cols, this.x + n); x++) grid[this.y][x] = ' '
        break
      case '@': {
        const row = grid[this.y]
        row.splice(this.x, 0, ...new Array<string>(Math.min(n, this.cols - this.x)).fill(' '))
        row.length = this.cols
        break
      }
      case 'P': {
        const row = grid[this.y]
        row.splice(this.x, Math.min(n, this.cols - this.x))
        while (row.length < this.cols) row.push(' ')
        break
      }
      case 'L':
        this.insertLines(n)
        break
      case 'M':
        this.deleteLines(n)
        break
      case 'S':
        this.scrollUp(Math.min(n, this.buf.bottom - this.buf.top + 1))
        break
      case 'T':
        // Extra parameters (xterm's old mouse highlight tracking) are ignored, as xterm.js does.
        this.scrollDown(Math.min(n, this.buf.bottom - this.buf.top + 1))
        break
      case 'r': {
        const top = Math.max(1, params[0] || 1) - 1
        const bottom = Math.min(this.rows, params[1] || this.rows) - 1
        // A region with no rows in it is ignored altogether, the cursor homing included.
        if (top < bottom) {
          this.buf.top = top
          this.buf.bottom = bottom
          this.moveTo(0, 0)
        }
        break
      }
      // Parameters are ignored, as xterm.js does (it has no left and right margins).
      case 's':
        this.buf.saved = { x: this.x, y: this.y }
        break
      case 'u':
        this.moveTo(this.buf.saved.x, this.buf.saved.y)
        break
      // SGR (m) and the reports and window operations change nothing on screen.
    }
  }

  private privateModes(params: number[], on: boolean): void {
    for (const mode of params) {
      if (mode === 7) this.autowrap = on
      else if (mode === 47 || mode === 1047 || mode === 1049) {
        // As xterm: 1049 saves the cursor in the buffer it leaves and restores it from the main
        // one, whether or not the switch happens; entering the alternate screen clears it.
        if (on) {
          if (mode === 1049) this.buf.saved = { x: this.x, y: this.y }
          if (!this.inAlt) {
            this.alt.grid = this.blankGrid()
            this.inAlt = true
          }
        } else {
          this.inAlt = false
          if (mode === 1049) this.moveTo(this.buf.saved.x, this.buf.saved.y)
        }
      }
    }
  }

  private eraseInLine(row: string[], mode: number): void {
    const [from, to] = mode === 0 ? [this.x, this.cols] : mode === 1 ? [0, this.x + 1] : [0, this.cols]
    for (let x = from; x < to; x++) row[x] = ' '
  }

  private eraseInDisplay(mode: number): void {
    const grid = this.grid()
    if (mode === 0) {
      this.eraseInLine(grid[this.y], 0)
      for (let y = this.y + 1; y < this.rows; y++) grid[y] = this.blankRow()
    } else if (mode === 1) {
      this.eraseInLine(grid[this.y], 1)
      for (let y = 0; y < this.y; y++) grid[y] = this.blankRow()
    } else if (mode === 2) {
      for (let y = 0; y < this.rows; y++) grid[y] = this.blankRow()
    }
    // 3 clears the scrollback, which this model doesn't keep; the screen stays as it is.
  }

  private insertLines(n: number): void {
    if (this.y < this.buf.top || this.y > this.buf.bottom) return
    const grid = this.grid()
    for (let i = 0; i < Math.min(n, this.buf.bottom - this.y + 1); i++) {
      grid.splice(this.buf.bottom, 1)
      grid.splice(this.y, 0, this.blankRow())
    }
    this.x = 0
  }

  private deleteLines(n: number): void {
    if (this.y < this.buf.top || this.y > this.buf.bottom) return
    const grid = this.grid()
    for (let i = 0; i < Math.min(n, this.buf.bottom - this.y + 1); i++) {
      grid.splice(this.y, 1)
      grid.splice(this.buf.bottom, 0, this.blankRow())
    }
    this.x = 0
  }
}

function rowText(row: string[]): string {
  return row.join('').trimEnd()
}

/** The size to replay a stream at: big enough for every cell its cursor moves address, and never
 *  smaller than a hidden terminal (DEFAULT_SCREEN). A worker that was never shown is that size
 *  exactly; one the user resized shows a larger extent the first time its bottom row is drawn. */
export function screenSizeOf(raw: string): ScreenSize {
  let { cols, rows } = DEFAULT_SCREEN
  const cup = /\x1b\[(\d+)(?:;(\d+))?[Hf]/g
  let m: RegExpExecArray | null
  while ((m = cup.exec(raw)) !== null) {
    rows = Math.max(rows, Math.min(500, Number(m[1])))
    if (m[2]) cols = Math.max(cols, Math.min(1000, Number(m[2])))
  }
  return { cols, rows }
}

/** Raw output replayed into a fresh screen. The output may begin anywhere, as Termpolis's rolling
 *  buffer does once it is full: absolute cursor moves put every row a TUI redraws back in place. */
export function screenOf(raw: string, size: ScreenSize = screenSizeOf(raw)): TerminalScreen {
  const screen = new TerminalScreen(size)
  screen.write(raw)
  return screen
}
