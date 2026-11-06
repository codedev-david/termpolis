// The phone is a copy of the desktop pane. Every test here feeds the SAME bytes to two emulators: one built the
// way the pane builds its own (the ConPTY backend and Unicode 11, TerminalPane.tsx and terminalOptions.ts) and the
// ScreenFlattener the bridge runs, and then compares what the two show, as counters: rows, duplicate rows, rows
// that differ. Nothing here is a wall-clock ratio.
//
// Each case runs twice. With the flattener as it ships it must agree with the pane. With `{ parity: false }`, which
// is the flattener as it was before this change (and what TERMPOLIS_DISABLE_FLATTENER_PARITY switches back to),
// the cases that were wrong must still be wrong by the recorded amount: that is the negative control, and it is
// what shows these tests can see the defect at all.
//
// What the defects were (challenge-phone.md and phone.md of the perf155 analysis, reproduced on the real bundle):
//   * the flattener's emulator counted cell widths with Unicode 6 and the pane with Unicode 11, so a repaint that
//     addresses a cell after a wide glyph landed one cell off: "passed" arrived as "ppassed";
//   * a height shrink replayed the blank rows under the cursor into the smaller grid, which scrolled real content
//     into the phone's permanent history: the whole screen twice;
//   * the flattener reflowed the wrapped line that holds the cursor, which xterm 5.5.0 leaves alone.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'

import {
  PARITY_DISABLE_FLAG,
  ScreenFlattener,
  flattenerParityDisabled,
  type FlatEdit,
} from '../../src/main/remoteBridge/screenFlattener'
import type { TerminalSize } from '../../src/main/remoteBridge/protocol'

// xterm's write queue runs on a timer, so every awaited write costs a scheduler round trip, and a sweep of
// scenarios would spend its whole budget there on a loaded machine. Parsing is unchanged; only WHEN the parser runs
// is. write() becomes synchronous and still reports completion on a microtask, which is all the flattener and this
// test wait for. The ORDER of bytes is untouched.
Terminal.prototype.write = function (this: unknown, data: string | Uint8Array, callback?: () => void): void {
  const warn = console.warn
  console.warn = () => undefined
  try {
    ;(this as { _core: { writeSync(d: string | Uint8Array): void } })._core.writeSync(data)
  } finally {
    console.warn = warn
  }
  if (callback) queueMicrotask(callback)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const ID = 't1'
const ESC = '\x1b'

// ---------------------------------------------------------------------------------------------------------------
// The two sides
// ---------------------------------------------------------------------------------------------------------------

/** The desktop pane's emulator: ConPTY backend on a Windows build that reflows, Unicode 11. */
function pane(size: TerminalSize): Terminal {
  const term = new Terminal({
    cols: size.cols,
    rows: size.rows,
    scrollback: 10_000,
    allowProposedApi: true,
    windowsPty: { backend: 'conpty', buildNumber: 26200 },
  })
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  return term
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => term.write(data, resolve))
}

function apply(view: string, edit: FlatEdit | null): string {
  return edit === null ? view : view.slice(0, edit.replaceFrom) + edit.text
}

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function trimBlankTail(rows: string[]): string[] {
  const out = [...rows]
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

/** Every row the pane holds, history and screen, without trailing blanks. */
function paneRows(term: Terminal): string[] {
  const buf = term.buffer.active
  const rows: string[] = []
  for (let y = 0; y < buf.length; y += 1) rows.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  return trimBlankTail(rows)
}

/** The rows of the pane's screen alone (what ConPTY believes the screen holds). */
function screenRows(term: Terminal): string[] {
  const buf = term.buffer.active
  const rows: string[] = []
  for (let y = buf.baseY; y < buf.length; y += 1) rows.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  return rows
}

function phoneRows(view: string): string[] {
  return trimBlankTail(plain(view).split('\n').map((row) => row.replace(/\s+$/, '')))
}

/** Non-blank rows that repeat a row seen earlier: a screen shown twice is this, however it got there. */
function duplicateRows(rows: string[]): number {
  const seen = new Set<string>()
  let n = 0
  for (const row of rows) {
    if (row === '') continue
    if (seen.has(row)) n += 1
    seen.add(row)
  }
  return n
}

/** The emulator the flattener keeps for a terminal. A test reaches in for exactly one thing: its width table. */
function emulatorOf(flat: ScreenFlattener): Terminal {
  const screens = (flat as unknown as { screens: Map<string, { term: Terminal }> }).screens
  const screen = screens.get(ID)
  if (screen === undefined) throw new Error('the flattener has no emulator for the terminal yet')
  return screen.term
}

interface Counters {
  desktopRows: number
  phoneRows: number
  desktopDuplicates: number
  phoneDuplicates: number
  /** Rows that differ, compared from the top over the longer of the two. */
  differing: number
}

/** One pane and the phone copy of it, fed the same bytes. */
class Pair {
  readonly desk: Terminal
  private view = ''
  private size: TerminalSize
  private before: { rows: string[]; cursor: { x: number; y: number } } | null = null

  constructor(
    readonly flat: ScreenFlattener,
    size: TerminalSize,
  ) {
    this.desk = pane(size)
    this.size = size
  }

  /** The same bytes to both; the phone is told the size main reports for the terminal at that moment. */
  async feed(raw: string): Promise<void> {
    await write(this.desk, raw)
    this.view = apply(this.view, await this.flat.feed(ID, raw, this.size))
  }

  /** The pane resizes at once. The bridge hears of it with the next bytes, as it does from main. */
  resize(size: TerminalSize): void {
    const buf = this.desk.buffer.active
    this.before = { rows: screenRows(this.desk), cursor: { x: buf.cursorX, y: buf.cursorY } }
    this.desk.resize(size.cols, size.rows)
    this.size = size
  }

  /**
   * What ConPTY writes after a resize. Shape taken from this machine's real ConPTY (Windows 10.0.26200, node-pty
   * 1.1.0): hide the cursor, home, EVERY row of the screen each ended with erase-to-end-of-line and joined by CRLF,
   * then the cursor's cell and show it.
   *
   *   'screen'   the rows are what the pane holds after ITS reflow. A tidy ConPTY.
   *   'old-rows' the rows are the ones the screen held BEFORE the resize, not wrapped again: in the real capture
   *              ConPTY painted 110-character rows into a screen narrowed to 90 columns, and the pane wrapped them.
   *   'none'     no repaint: a shell, or a Linux or macOS pty, where nothing redraws the screen after a resize.
   */
  async repaint(kind: 'screen' | 'old-rows' | 'none' = 'screen'): Promise<void> {
    if (kind === 'none') return
    const rows = kind === 'old-rows' && this.before !== null ? this.before.rows : screenRows(this.desk)
    const cursor = kind === 'old-rows' && this.before !== null ? this.before.cursor : {
      x: this.desk.buffer.active.cursorX,
      y: this.desk.buffer.active.cursorY,
    }
    const height = this.size.rows
    let out = `${ESC}[?25l${ESC}[H`
    for (let y = 0; y < height; y += 1) out += `${rows[y] ?? ''}${ESC}[K${y + 1 < height ? '\r\n' : ''}`
    out += `${ESC}[${Math.min(cursor.y, height - 1) + 1};${Math.min(cursor.x, this.size.cols - 1) + 1}H${ESC}[?25h`
    await this.feed(out)
  }

  counters(): Counters {
    const desktop = paneRows(this.desk)
    const phone = phoneRows(this.view)
    let differing = 0
    for (let i = 0; i < Math.max(desktop.length, phone.length); i += 1) if (desktop[i] !== phone[i]) differing += 1
    return {
      desktopRows: desktop.length,
      phoneRows: phone.length,
      desktopDuplicates: duplicateRows(desktop),
      phoneDuplicates: duplicateRows(phone),
      differing,
    }
  }

  desktop(): string[] {
    return paneRows(this.desk)
  }

  phone(): string[] {
    return phoneRows(this.view)
  }
}

/** The phone shows what the pane shows: the same rows, no screen the pane does not have twice. */
function expectSameScreen(pair: Pair): void {
  const c = pair.counters()
  expect({ rows: c.phoneRows, duplicates: c.phoneDuplicates, differing: c.differing }).toEqual({
    rows: c.desktopRows,
    duplicates: c.desktopDuplicates,
    differing: 0,
  })
}

const WITH_PARITY = undefined
const TODAY = { parity: false } as const

// ---------------------------------------------------------------------------------------------------------------
// Cell widths
// ---------------------------------------------------------------------------------------------------------------

describe('cell widths: the phone counts them the way the pane does', () => {
  const SIZE: TerminalSize = { cols: 60, rows: 12 }
  // The TUI addresses the cell after "✅ build status: " using Unicode 11 widths (the emoji is two cells).
  const STREAM = `${ESC}[2J${ESC}[1;1Hheader${ESC}[5;1H✅ build status: pending   ${ESC}[5;18Hpassed `

  async function drawn(options: { parity: boolean } | undefined): Promise<{ pair: Pair; flat: ScreenFlattener }> {
    const flat = new ScreenFlattener(120, 30, options)
    const pair = new Pair(flat, SIZE)
    await pair.feed(STREAM)
    return { pair, flat }
  }

  it('lays a repaint down where the pane does: "passed", not "ppassed"', async () => {
    const { pair, flat } = await drawn(WITH_PARITY)
    expectSameScreen(pair)
    expect(pair.phone()).toContain('✅ build status: passed')
    expect(pair.phone().join('\n')).not.toContain('ppassed')
    expect(emulatorOf(flat).unicode.activeVersion).toBe('11')
  })

  it('control: the flattener as it was shows "ppassed" and counts in Unicode 6', async () => {
    const { pair, flat } = await drawn(TODAY)
    expect(pair.phone()).toContain('✅ build status: ppassed')
    expect(pair.counters().differing).toBeGreaterThan(0)
    expect(emulatorOf(flat).unicode.activeVersion).toBe('6')
  })

  // Glyphs by class. A cursor-addressed write after one lands a cell off exactly when the two tables disagree.
  const GLYPHS: Array<[string, string]> = [
    ['white heavy check mark emoji U+2705', '✅'],
    ['high voltage U+26A1', '⚡'],
    ['white medium star U+2B50', '⭐'],
    ['watch U+231A', '⌚'],
    ['umbrella with rain U+2614', '☔'],
    ['hot beverage U+2615', '☕'],
    ['aries U+2648', '♈'],
    ['anchor U+2693', '⚓'],
    ['alarm clock U+23F0', '⏰'],
    ['sparkles U+2728', '✨'],
    ['cross mark U+274C', '❌'],
    ['black question mark ornament U+2753', '❓'],
    ['heavy plus sign U+2795', '➕'],
    ['rocket U+1F680', '\u{1F680}'],
    ['grinning face U+1F600', '\u{1F600}'],
    ['fire U+1F525', '\u{1F525}'],
    ['package U+1F4E6', '\u{1F4E6}'],
    ['large green circle U+1F7E2', '\u{1F7E2}'],
    ['flag, two regional indicators', '\u{1F1FA}\u{1F1F8}'],
    ['thumbs up with a skin tone', '\u{1F44D}\u{1F3FD}'],
    ['e and a combining acute accent', 'é'],
    ['CJK U+4F60', '你'],
    ['Hangul U+D55C', '한'],
    ['halfwidth katakana U+FF71', 'ｱ'],
    ['arrow U+2192', '→'],
    ['braille spinner U+280B', '⠋'],
    ['check mark U+2713', '✓'],
    ['box drawing U+2500', '─'],
  ]

  async function glyphsThatDiffer(options: { parity: boolean } | undefined): Promise<string[]> {
    const differ: string[] = []
    for (const [name, glyph] of GLYPHS) {
      const pair = new Pair(new ScreenFlattener(120, 30, options), { cols: 20, rows: 3 })
      await pair.feed(`${ESC}[2J${ESC}[H${glyph}${ESC}[1;5HY`)
      if (pair.counters().differing > 0) differ.push(name)
    }
    return differ
  }

  it('agrees with the pane on the width of every glyph probed', async () => {
    expect(await glyphsThatDiffer(WITH_PARITY)).toEqual([])
  })

  it('control: the flattener as it was disagreed on most of them', async () => {
    const differ = await glyphsThatDiffer(TODAY)
    expect(differ.length).toBeGreaterThanOrEqual(GLYPHS.length / 2)
    // The ones both tables always agreed on stay agreed on, so the probe is not simply failing everything.
    expect(differ).not.toContain('CJK U+4F60')
    expect(differ).not.toContain('box drawing U+2500')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// A height or width change, then ConPTY's repaint, then the next keystrokes
// ---------------------------------------------------------------------------------------------------------------

interface ResizeCase {
  name: string
  from: TerminalSize
  to: TerminalSize
  pre: string
  repaint?: 'screen' | 'old-rows' | 'none'
  /** What the phone showed on the base (parity off), measured, against the pane's rows. null: it already agreed. */
  today: { rows: number; duplicates: number; paneRows: number; paneDuplicates: number } | null
}

/** `n` short numbered lines: enough of them put real history above the screen. */
function numbered(n: number): string {
  return Array.from({ length: n }, (_, i) => `row ${i}`).join('\r\n') + '\r\n'
}

const SCREEN = 'line A\r\nline B\r\nline C\r\n$ '
/** 35 characters: one row at 40 columns, two at 30. */
const WRAPPING = `${'A'.repeat(35)}\r\nline B\r\nline C\r\n$ `

/** A screen of long lines like the one in the real capture: 106 characters and a label per row. */
function longLines(n: number): string {
  let out = 'Microsoft Windows [Version 10.0]\r\n(c) Corporation.\r\n\r\nC:\\work>type lines.txt\r\n'
  for (let i = 0; i < n; i += 1) out += `L${String(i).padStart(2, '0')} ${'abcdefghij'.repeat(11).slice(0, 106)}\r\n`
  return `${out}\r\nC:\\work>`
}

const RESIZE_CASES: ResizeCase[] = [
  {
    name: 'rows 10 to 6, blank rows under the cursor',
    from: { cols: 40, rows: 10 },
    to: { cols: 40, rows: 6 },
    pre: SCREEN,
    today: { rows: 8, duplicates: 3, paneRows: 4, paneDuplicates: 0 },
  },
  {
    name: 'rows 30 to 24, blank rows under the cursor',
    from: { cols: 40, rows: 30 },
    to: { cols: 40, rows: 24 },
    pre: SCREEN,
    today: { rows: 10, duplicates: 3, paneRows: 4, paneDuplicates: 0 },
  },
  {
    name: 'columns and rows together, 40x10 to 30x6',
    from: { cols: 40, rows: 10 },
    to: { cols: 30, rows: 6 },
    pre: SCREEN,
    today: { rows: 8, duplicates: 3, paneRows: 4, paneDuplicates: 0 },
  },
  {
    name: 'columns only, nothing wraps (40 to 30)',
    from: { cols: 40, rows: 10 },
    to: { cols: 30, rows: 10 },
    pre: SCREEN,
    today: null,
  },
  {
    name: 'columns only, one line now wraps (40 to 30)',
    from: { cols: 40, rows: 10 },
    to: { cols: 30, rows: 10 },
    pre: WRAPPING,
    today: { rows: 6, duplicates: 1, paneRows: 5, paneDuplicates: 0 },
  },
  {
    name: 'columns and rows, one line now wraps (40x10 to 30x6)',
    from: { cols: 40, rows: 10 },
    to: { cols: 30, rows: 6 },
    pre: WRAPPING,
    today: { rows: 10, duplicates: 4, paneRows: 5, paneDuplicates: 0 },
  },
  {
    name: 'rows grow (6 to 10)',
    from: { cols: 40, rows: 6 },
    to: { cols: 40, rows: 10 },
    pre: SCREEN,
    today: null,
  },
  {
    name: 'columns grow (30 to 40)',
    from: { cols: 30, rows: 10 },
    to: { cols: 40, rows: 10 },
    pre: SCREEN,
    today: null,
  },
  {
    name: 'with history: rows 10 to 6, the top scrolls into it',
    from: { cols: 40, rows: 10 },
    to: { cols: 40, rows: 6 },
    pre: numbered(12) + SCREEN,
    today: null,
  },
  {
    // The case the "rows under the cursor go first" rule is for once something has scrolled (with nothing scrolled the
    // bottom-pop rule gives the same answer): twelve lines scroll a ten-row screen, then the cursor moves up four rows
    // and erases below it, as a TUI does when its frame gets shorter. Four blank rows now sit under the cursor.
    name: 'with history and blank rows under the cursor, rows 10 to 6 (a frame that shrank)',
    from: { cols: 40, rows: 10 },
    to: { cols: 40, rows: 6 },
    pre: `${numbered(12)}tail${ESC}[4A${ESC}[J`,
    today: { rows: 13, duplicates: 4, paneRows: 9, paneDuplicates: 0 },
  },
  {
    name: 'with history: columns narrowed so a line wraps, the top scrolls into it',
    from: { cols: 40, rows: 10 },
    to: { cols: 30, rows: 10 },
    pre: numbered(12) + WRAPPING,
    today: null,
  },
  {
    // xterm adds the new rows first and does not let the rewrap use them: the top still scrolls into history.
    name: 'with history: rows grow while a line wraps (30x6 to 24x9)',
    from: { cols: 30, rows: 6 },
    to: { cols: 24, rows: 9 },
    pre: `${numbered(10)}${'w'.repeat(28)}\r\n$ `,
    today: { rows: 12, duplicates: 0, paneRows: 13, paneDuplicates: 0 },
  },
  {
    // A double-width glyph in the last two cells: counted as two, the row needs one more row at 18 columns, and the
    // blank row under the prompt is what makes room. Counted as one, nothing is dropped and the top scrolls away.
    name: 'a double-width glyph ends a row that now wraps (20x6 to 18x6)',
    from: { cols: 20, rows: 6 },
    to: { cols: 18, rows: 6 },
    pre: `${'a'.repeat(17)}你\r\nb\r\nc\r\nd\r\n$ `,
    today: { rows: 7, duplicates: 1, paneRows: 6, paneDuplicates: 0 },
  },
  {
    // The blank cell xterm leaves where a double-width glyph did not fit at the margin is not a space.
    name: 'a double-width glyph that wrapped at the margin, joined again by a wider screen (10 to 20)',
    from: { cols: 10, rows: 5 },
    to: { cols: 20, rows: 5 },
    pre: 'abcdefghi你你你xyz\r\n$ ',
    repaint: 'none',
    today: { rows: 2, duplicates: 0, paneRows: 2, paneDuplicates: 0 },
  },
  {
    // Nothing is under the cursor, so nothing may be popped to make room for the row the rewrap adds: xterm scrolls
    // the top into history instead (its cursor is on the last row).
    name: 'an exactly full screen, the cursor on its last row, a line now wraps (40x4 to 30x4)',
    from: { cols: 40, rows: 4 },
    to: { cols: 30, rows: 4 },
    pre: `${'A'.repeat(35)}\r\nline B\r\nline C\r\n$ `,
    today: null,
  },
  {
    name: 'an exactly full screen where one line now needs a third row (40x4 to 30x4)',
    from: { cols: 40, rows: 4 },
    to: { cols: 30, rows: 4 },
    pre: `${'A'.repeat(70)}\r\nline B\r\n$ `,
    today: null,
  },
  {
    name: 'a screen of long lines narrowed, ConPTY painting its old wide rows (120x30 to 90x30)',
    from: { cols: 120, rows: 30 },
    to: { cols: 90, rows: 30 },
    pre: longLines(22),
    repaint: 'old-rows',
    today: { rows: 72, duplicates: 42, paneRows: 70, paneDuplicates: 40 },
  },
  {
    name: 'a shorter screen of long lines narrowed, old wide rows (120x30 to 90x30)',
    from: { cols: 120, rows: 30 },
    to: { cols: 90, rows: 30 },
    pre: longLines(12),
    repaint: 'old-rows',
    today: { rows: 42, duplicates: 22, paneRows: 30, paneDuplicates: 11 },
  },
  {
    name: 'a screen of long lines made shorter (120x30 to 120x20)',
    from: { cols: 120, rows: 30 },
    to: { cols: 120, rows: 20 },
    pre: longLines(6),
    repaint: 'old-rows',
    today: { rows: 22, duplicates: 9, paneRows: 12, paneDuplicates: 0 },
  },
]

async function runResize(c: ResizeCase, options: { parity: boolean } | undefined): Promise<Pair> {
  const pair = new Pair(new ScreenFlattener(120, 30, options), c.from)
  await pair.feed(c.pre)
  pair.resize(c.to)
  await pair.repaint(c.repaint)
  await pair.feed('NEXT')
  return pair
}

describe('after a resize the phone shows the rows the pane shows', () => {
  for (const c of RESIZE_CASES) {
    it(`${c.name}: the same rows, and no screen twice that the pane has once`, async () => {
      expectSameScreen(await runResize(c, WITH_PARITY))
    })
  }
})

describe('control: the flattener as it was', () => {
  for (const c of RESIZE_CASES) {
    it(`${c.name}: ${c.today === null ? 'already agreed' : 'replayed what scrolled real content away'}`, async () => {
      const pair = await runResize(c, TODAY)
      if (c.today === null) {
        expectSameScreen(pair)
        return
      }
      const counters = pair.counters()
      expect({
        rows: counters.phoneRows,
        duplicates: counters.phoneDuplicates,
        paneRows: counters.desktopRows,
        paneDuplicates: counters.desktopDuplicates,
      }).toEqual(c.today)
      expect(counters.differing).toBeGreaterThan(0)
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------
// The wrapped line the cursor is on
// ---------------------------------------------------------------------------------------------------------------

describe('the wrapped line the cursor is on', () => {
  // xterm 5.5.0 skips a wrapped line that holds the cursor when it reflows ("If these lines contain the cursor
  // don't touch them, the program will handle fixing up wrapped lines with the cursor": Buffer._reflowLarger and
  // _reflowSmaller). 72 characters at 40 columns: two rows, the cursor on the second.
  const LONG = `${'x'.repeat(30)}${'y'.repeat(30)}${'z'.repeat(12)}`
  const SIZE: TerminalSize = { cols: 40, rows: 8 }

  async function run(
    options: { parity: boolean } | undefined,
    to: TerminalSize,
    pre: string,
    repaint = false,
  ): Promise<Pair> {
    const pair = new Pair(new ScreenFlattener(120, 30, options), SIZE)
    await pair.feed(pre)
    pair.resize(to)
    if (repaint) await pair.repaint()
    await pair.feed('!')
    return pair
  }

  it('is left as two rows when the grid widens, as the pane leaves it', async () => {
    const pair = await run(WITH_PARITY, { cols: 80, rows: 8 }, LONG)
    expectSameScreen(pair)
    expect(pair.desktop()).toHaveLength(2)
  })

  it('is cut at the new width when the grid narrows, as the pane cuts it', async () => {
    const pair = await run(WITH_PARITY, { cols: 30, rows: 8 }, LONG)
    expectSameScreen(pair)
    expect(pair.desktop()).toHaveLength(2)
    expect(pair.desktop()[0]).toBe('x'.repeat(30))
  })

  it('control: the flattener as it was merged it when widened and re-wrapped it when narrowed', async () => {
    const wider = await run(TODAY, { cols: 80, rows: 8 }, LONG)
    expect(wider.counters()).toMatchObject({ desktopRows: 2, phoneRows: 1 })
    const narrower = await run(TODAY, { cols: 30, rows: 8 }, LONG)
    expect(narrower.counters()).toMatchObject({ desktopRows: 2, phoneRows: 3 })
  })

  it('still reflows a wrapped line the cursor is NOT on, as the pane does', async () => {
    // The guard on the other side: holding only the cursor's own line, not every wrapped line.
    const text = `${LONG}\r\nprompt$ `
    expectSameScreen(await run(WITH_PARITY, { cols: 80, rows: 8 }, text))
    expectSameScreen(await run(WITH_PARITY, { cols: 30, rows: 8 }, text))
    // Both versions always agreed on this one.
    expectSameScreen(await run(TODAY, { cols: 80, rows: 8 }, text))
    expectSameScreen(await run(TODAY, { cols: 30, rows: 8 }, text))
  })

  // The cursor parked on the FIRST row of a wrapped line (a cursor-up after the line was written). xterm keeps the
  // whole line, because the cursor is in it, and cuts each of its rows at the new width: 78 characters at 40 columns
  // are rows of 40 and 38, and at 30 columns they show as 30 and 30.
  const PARKED_ON_FIRST_ROW = `${'x'.repeat(40)}${'y'.repeat(38)}${ESC}[1A`

  it('keeps every row of the line when the cursor is on its first row, cutting each at the new width', async () => {
    const pair = await run(WITH_PARITY, { cols: 30, rows: 8 }, PARKED_ON_FIRST_ROW)
    expectSameScreen(pair)
    expect(pair.desktop()).toEqual([`${'x'.repeat(29)}!`, 'y'.repeat(30)])
  })

  it('control: the flattener as it was re-wrapped the later row, showing a row the pane does not', async () => {
    const pair = await run(TODAY, { cols: 30, rows: 8 }, PARKED_ON_FIRST_ROW)
    expect(pair.counters()).toMatchObject({ desktopRows: 2, phoneRows: 3 })
  })

  // A line the cursor was on is held through one resize, and keeps the wrap mark xterm keeps on its rows, so the NEXT
  // resize reflows it like any other once the cursor has left it. A window being dragged is a run of resizes, so the
  // second one is the ordinary case: 78 characters at 40 columns, narrowed to 30 with the cursor on the line, the
  // cursor then moves off it, and the screen is resized again.
  async function heldThenReleased(options: { parity: boolean } | undefined, then: TerminalSize): Promise<Pair> {
    const pair = new Pair(new ScreenFlattener(120, 30, options), SIZE)
    await pair.feed(PARKED_ON_FIRST_ROW)
    pair.resize({ cols: 30, rows: 8 })
    await pair.feed('!')
    await pair.feed(`${ESC}[3B`)
    pair.resize(then)
    await pair.feed('Z')
    return pair
  }

  it('reflows a line that was held through one resize at the next one, once the cursor has left it', async () => {
    // Widened to 80 the two held rows join into one row of 60 characters; narrowed to 20 they wrap three ways.
    const wider = await heldThenReleased(WITH_PARITY, { cols: 80, rows: 8 })
    expectSameScreen(wider)
    expect(wider.desktop()).toHaveLength(3)
    const narrower = await heldThenReleased(WITH_PARITY, { cols: 20, rows: 8 })
    expectSameScreen(narrower)
    expect(narrower.desktop()).toHaveLength(5)
  })

  it('control: the flattener as it was showed a row more than the pane after the second resize', async () => {
    expect((await heldThenReleased(TODAY, { cols: 80, rows: 8 })).counters()).toMatchObject({ desktopRows: 3, phoneRows: 4 })
    expect((await heldThenReleased(TODAY, { cols: 20, rows: 8 })).counters()).toMatchObject({ desktopRows: 5, phoneRows: 6 })
  })

  it('holds the cursor line while the height shrinks under it, then ConPTY repaints', async () => {
    // Content under 8 rows with the cursor on the last wrapped line of it; the height drops to 5. The rows under the
    // cursor go first, as xterm does it, and the repaint that follows must not show anything twice.
    const pre = `${LONG}\r\nrow\r\nrow\r\n${'q'.repeat(50)}`
    expectSameScreen(await run(WITH_PARITY, { cols: 40, rows: 5 }, pre, true))
    // Same shrink with a narrower width as well.
    expectSameScreen(await run(WITH_PARITY, { cols: 30, rows: 5 }, pre, true))
  })

  it('control: the flattener as it was showed rows twice there', async () => {
    const pre = `${LONG}\r\nrow\r\nrow\r\n${'q'.repeat(50)}`
    const pair = await run(TODAY, { cols: 40, rows: 5 }, pre, true)
    expect(pair.counters().phoneDuplicates).toBeGreaterThan(pair.counters().desktopDuplicates)
  })

  // 34 characters in 10 columns: the line began above the screen, so its first row is already history.
  async function startedAboveTheScreen(options: { parity: boolean } | undefined): Promise<Pair> {
    const pair = new Pair(new ScreenFlattener(120, 30, options), { cols: 10, rows: 3 })
    await pair.feed('a'.repeat(34))
    pair.resize({ cols: 8, rows: 3 })
    await pair.feed('!')
    return pair
  }

  it('holds only the rows of the line that are on the screen when it began in history', async () => {
    const pair = await startedAboveTheScreen(WITH_PARITY)
    // The first row is settled history: permanent by design, and it keeps the width it was sent at. The screen is
    // what has to match the pane, and it does: the same rows, cut at the new width, the cursor at the end.
    expect(pair.phone().slice(-3)).toEqual(screenRows(pair.desk))
    expect(screenRows(pair.desk)).toEqual(['aaaaaaaa', 'aaaaaaaa', 'aaaa!'])
  })

  it('control: the flattener as it was re-wrapped the line the cursor is on there', async () => {
    const pair = await startedAboveTheScreen(TODAY)
    const rows = pair.phone()
    expect(rows.slice(-3)).not.toEqual(screenRows(pair.desk))
    expect(rows[rows.length - 1]).toBe('aaaaaaa!')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// What a width change leaves behind
// ---------------------------------------------------------------------------------------------------------------

describe('the stale rows a width change leaves above a redrawn TUI', () => {
  // Ink erases "what it believes it drew" with relative moves, then draws again. A width change leaves rows of the
  // old frame above the new one, because the pane wrapped them first. Both ends must be left with the same ones.
  function eraseLines(n: number): string {
    let s = ''
    for (let i = 0; i < n; i += 1) s += `${ESC}[2K${i < n - 1 ? `${ESC}[1A` : ''}`
    return n > 0 ? `${s}${ESC}[G` : s
  }
  const history = (n: number): string =>
    Array.from({ length: n }, (_, i) => `h${String(i).padStart(3, '0')} ${'x'.repeat(10 + ((i * 7) % 30))}`).join('\r\n') + '\r\n'

  function frame(cols: number, tick: number, draft: boolean): string[] {
    const bar = '─'.repeat(cols)
    if (draft) return [`* Thinking (${tick}s)`, bar, `> ${'d'.repeat(cols + 10)}`]
    return [`* Thinking (${tick}s)`, bar, '> draft message', bar, `  ? for shortcuts${' '.repeat(Math.max(1, cols - 25))}ctx ${String(tick % 100).padStart(2, '0')}%`]
  }

  async function staleRows(
    options: { parity: boolean } | undefined,
    widths: { before: number; after: number },
    draft: boolean,
  ): Promise<{ desktop: number; phone: number }> {
    const rows = 30
    // Ink: the cursor rests on the line under the frame, except while a draft is being typed (it stays at its end).
    const tail = draft ? '' : '\r\n'
    let drawn = 0
    const ink = (cols: number, tick: number): string => {
      const lines = frame(cols, tick, draft)
      const out = eraseLines(drawn) + lines.join('\r\n') + tail
      drawn = lines.length + (draft ? 0 : 1)
      return out
    }
    const pair = new Pair(new ScreenFlattener(120, 30, options), { cols: widths.before, rows })
    await pair.feed(history(40))
    for (let tick = 0; tick < 3; tick += 1) await pair.feed(ink(widths.before, tick))
    if (widths.after !== widths.before) {
      pair.resize({ cols: widths.after, rows })
      // The TUI reacts to the resize and repaints for the new width.
      await pair.feed(ink(widths.after, 3))
    } else {
      await pair.feed(ink(widths.before, 3))
    }
    // An emulator that was this wide all along and drew the same final frame: no stale rows at all.
    const ideal = pane({ cols: widths.after, rows })
    await write(ideal, history(40) + frame(widths.after, 3, draft).join('\r\n') + tail)
    const idealRows = paneRows(ideal).length
    return { desktop: pair.desktop().length - idealRows, phone: pair.phone().length - idealRows }
  }

  it('leaves the same stale rows on the phone as on the pane after a width shrink', async () => {
    const stale = await staleRows(WITH_PARITY, { before: 120, after: 80 }, false)
    // The model does reproduce the garble (rows of the old frame above the new one), so equality is not vacuous...
    expect(stale.desktop).toBeGreaterThan(0)
    expect(stale.phone).toBe(stale.desktop)
  })

  it('control: with no resize there is nothing stale on either side', async () => {
    expect(await staleRows(WITH_PARITY, { before: 120, after: 120 }, false)).toEqual({ desktop: 0, phone: 0 })
  })

  it('leaves the same stale rows when the line the cursor is on is a wrapped draft and the grid widens', async () => {
    const stale = await staleRows(WITH_PARITY, { before: 120, after: 150 }, true)
    expect(stale.desktop).toBeGreaterThan(0)
    expect(stale.phone).toBe(stale.desktop)
  })

  it('control: the flattener as it was left fewer stale rows than the pane there', async () => {
    const stale = await staleRows(TODAY, { before: 120, after: 150 }, true)
    expect(stale.phone).toBeLessThan(stale.desktop)
  })

  it('leaves the same stale rows when the shrink happens with a wrapped draft too', async () => {
    const stale = await staleRows(WITH_PARITY, { before: 120, after: 80 }, true)
    expect(stale.phone).toBe(stale.desktop)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Fuzz: the same claim over many shapes, with the repaint ConPTY sends
// ---------------------------------------------------------------------------------------------------------------

describe('a sweep over screens, cursors and sizes', () => {
  /** A small deterministic generator, so a failing case can be named by its index. */
  function rng(seed: number): () => number {
    let a = seed | 0
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))
  const word = (r: () => number, n: number): string => {
    const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let s = ''
    for (let i = 0; i < n; i += 1) s += abc[Math.floor(r() * abc.length)]
    return s
  }

  interface Shape {
    from: TerminalSize
    to: TerminalSize
    pre: string
  }

  /** Screens with nothing scrolled yet (the only case where blank rows under the cursor can be dropped), a
   *  cursor on the last row or parked above content, and a resize that changes rows, columns, both, or neither. */
  function shape(index: number): Shape {
    const r = rng(1000 + index * 7919)
    const cols = int(r, 24, 50)
    const rows = int(r, 8, 14)
    const lines: string[] = []
    const count = int(r, 1, rows - 3)
    for (let i = 0; i < count; i += 1) lines.push(word(r, r() < 0.5 ? int(r, 1, 12) : int(r, 1, cols + 20)))
    let pre = `${lines.join('\r\n')}\r\n$ ${word(r, r() < 0.5 ? 0 : int(r, 1, cols + 15))}`
    if (r() < 0.3) pre += `${ESC}[${int(r, 1, 2)}A`
    const toCols = ((): number => {
      const k = r()
      if (k < 0.3) return cols
      if (k < 0.55) return cols + int(r, 3, 15)
      return Math.max(20, cols - int(r, 1, 15))
    })()
    const toRows = Math.max(3, rows + [0, -1, -4, -6, 3, 0, -2][int(r, 0, 6)])
    return { from: { cols, rows }, to: { cols: toCols, rows: toRows }, pre }
  }

  const SHAPES = 120

  async function disagreements(options: { parity: boolean } | undefined, kind: 'screen' | 'old-rows'): Promise<number[]> {
    const bad: number[] = []
    for (let i = 0; i < SHAPES; i += 1) {
      const s = shape(i)
      const pair = new Pair(new ScreenFlattener(120, 30, options), s.from)
      await pair.feed(s.pre)
      // Nothing may have scrolled: with scrollback the desktop pulls rows back, which the phone, whose settled rows
      // are permanent, cannot follow (a different and deliberate difference, pinned elsewhere).
      if (pair.desk.buffer.active.baseY > 0) continue
      pair.resize(s.to)
      await pair.repaint(kind)
      await pair.feed('NEXT')
      if (pair.counters().differing > 0) bad.push(i)
    }
    return bad
  }

  it('agrees with the pane on every shape, when ConPTY repaints the pane’s own screen', async () => {
    expect(await disagreements(WITH_PARITY, 'screen')).toEqual([])
  })

  it('agrees with the pane when ConPTY repaints its old rows, wider than the new screen', async () => {
    expect(await disagreements(WITH_PARITY, 'old-rows')).toEqual([])
  })

  it('control: the flattener as it was disagreed on many of them', async () => {
    expect((await disagreements(TODAY, 'screen')).length).toBeGreaterThanOrEqual(SHAPES / 4)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The switch, and failing open
// ---------------------------------------------------------------------------------------------------------------

describe('the kill switch', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['1', true],
    ['true', true],
    ['yes', true],
  ])('reads %j as disabled=%s', (value, disabled) => {
    expect(flattenerParityDisabled({ [PARITY_DISABLE_FLAG]: value })).toBe(disabled)
  })

  it('reads the real environment when none is passed', () => {
    vi.stubEnv(PARITY_DISABLE_FLAG, '1')
    expect(flattenerParityDisabled()).toBe(true)
    vi.stubEnv(PARITY_DISABLE_FLAG, '0')
    expect(flattenerParityDisabled()).toBe(false)
  })

  async function ppassed(flat: ScreenFlattener): Promise<boolean> {
    const pair = new Pair(flat, { cols: 60, rows: 12 })
    await pair.feed(`${ESC}[2J${ESC}[1;1Hheader${ESC}[5;1H✅ build status: pending   ${ESC}[5;18Hpassed `)
    return pair.phone().join('\n').includes('ppassed')
  }

  it('puts a flattener built with no options back to what it was when the variable is set', async () => {
    vi.stubEnv(PARITY_DISABLE_FLAG, '1')
    expect(await ppassed(new ScreenFlattener(120, 30))).toBe(true)
  })

  it('leaves it on when the variable is not set', async () => {
    expect(await ppassed(new ScreenFlattener(120, 30))).toBe(false)
  })

  it('lets the option win over the variable, both ways', async () => {
    vi.stubEnv(PARITY_DISABLE_FLAG, '1')
    expect(await ppassed(new ScreenFlattener(120, 30, { parity: true }))).toBe(false)
    vi.stubEnv(PARITY_DISABLE_FLAG, '')
    expect(await ppassed(new ScreenFlattener(120, 30, { parity: false }))).toBe(true)
  })

  it('falls open to the old widths when the emulator will not take the addon', async () => {
    const flat = new ScreenFlattener(120, 30)
    const pair = new Pair(flat, { cols: 60, rows: 12 })
    const load = vi.spyOn(Terminal.prototype, 'loadAddon').mockImplementationOnce(() => {
      throw new Error('no width table')
    })
    await pair.feed(`${ESC}[2J${ESC}[1;1Hheader${ESC}[5;1H✅ build status: pending   ${ESC}[5;18Hpassed `)
    // It tried (once, for the one emulator), and the screen is drawn with the old widths instead of the bridge
    // dying on a width table.
    expect(load).toHaveBeenCalledTimes(1)
    expect(pair.phone().join('\n')).toContain('ppassed')
    expect(emulatorOf(flat).unicode.activeVersion).toBe('6')
  })
})
