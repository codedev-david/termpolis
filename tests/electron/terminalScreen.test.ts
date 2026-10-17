import { describe, it, expect } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { TerminalScreen, screenOf, screenSizeOf, DEFAULT_SCREEN } from '../../src/shared/terminalScreen'
import fixtures from '../fixtures/agentScreens.json'

const E = '\x1b'

/** The rows @xterm/headless shows after the same output: the emulator the app itself renders with. */
async function xtermRows(raw: string, cols = 80, rows = 24): Promise<string[]> {
  const term = new HeadlessTerminal({ cols, rows, allowProposedApi: true, scrollback: 0 })
  await new Promise<void>((resolve) => term.write(raw, resolve))
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < rows; i++) out.push((buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '').trimEnd())
  term.dispose()
  return out
}

const screens: Array<[string, string]> = []
for (const agent of ['claude', 'codex', 'agy'] as const) {
  for (const [moment, raw] of Object.entries(fixtures[agent] as Record<string, string>)) screens.push([`${agent} ${moment}`, raw])
}

describe('TerminalScreen against @xterm/headless', () => {
  // Real ConPTY output of Claude Code, Codex and agy (tests/fixtures/agentScreens.json): from the
  // start of a session, and windows that begin mid-stream, as a full output buffer does.
  it.each(screens)('draws the real %s screen as xterm does', async (_name, raw) => {
    expect(screenOf(raw, DEFAULT_SCREEN).lines()).toEqual(await xtermRows(raw))
  })

  it.each([
    ['wide glyphs, and one that no longer fits the row', `ab界c\r\n${'x'.repeat(79)}界d`],
    ['a combining mark and writing over half of a wide glyph', `é 漢字${E}[1;5Hz${E}[2;1H漢${E}[2;2Hy`],
    ['autowrap at the last column, and with it off', `${'w'.repeat(80)}next${E}[3;1H${E}[?7l${'n'.repeat(85)}`],
    ['a scroll region with line feeds, IND and RI', `${E}[5;10r${E}[10;1Hone\n\ntwo${E}D${E}[5;1H${E}Mthree${E}[r`],
    ['inserted, deleted and erased cells and lines', `abcdefgh${E}[1;3H${E}[2@${E}[1;6H${E}[3P${E}[2;1Hrow2${E}[2;1H${E}[L${E}[4;1Hrow4${E}[3;1H${E}[M${E}[1;2H${E}[3X`],
    ['erase in line and display, each way', `l1 one\r\nl2 two\r\nl3 three${E}[2;4H${E}[1K${E}[1;3H${E}[K${E}[3;5H${E}[1J${E}[3;7H${E}[0J`],
    ['scrolling up and down by CSI S and T', `top\r\nmid\r\nlow${E}[2S${E}[1T${E}[24;1Hbottom`],
    ['relative moves, CHA, VPA, CNL, CPL, HPA, HPR, VPR and tabs', `${E}[5;5Hx${E}[2Ay${E}[3Bz${E}[4Cw${E}[2Dv${E}[10Gu${E}[7dt${E}[2Es${E}[Fr${E}[20\`q${E}[2ap${E}[2eo\tn${E}[2Im${E}[Zl`],
    ['the alternate screen and back', `main text${E}[?1049halt text${E}[2;1Hmore${E}[?1049l after`],
    ['saved and restored cursors, both spellings', `${E}[3;3H${E}7${E}[10;10Ha${E}8b${E}[5;5H${E}[sc${E}[12;12H${E}[ud`],
    ['a full reset, OSC, DCS and charset sequences, and cancelled CSIs', `gone${E}cfresh${E}]0;title${E}\\${E}P1;2|data${E}\\${E}(B${E}[2${E}[3;1Hx${E}[2\x18y${E}[1;1\x1az`],
    ['private, DEC and intermediate sequences it ignores', `${E}[?25l${E}[>4;2m${E}[<1u${E}[?u${E}[0 q${E}[?2026hshown${E}[?2026l${E}[!p${E}[c${E}[6n end`],
    ['a scroll down with extra parameters', `ab${E}[5;5Tcd`],
    ['backspace, NEL, and RI below the top row', `abc\x08\x08X${E}Enext${E}[5;1H${E}Mup`],
    ['a sequence abandoned for another, and a string cancelled', `${E}(${E}[2;2Ha${E}${E}[3;3Hb${E}Pdata\x18c${E}]0;t\x07`],
    ['a combining mark after the last column, and code points past every range', `${'x'.repeat(80)}́${E}[3;1H\u{e0061}\u{2fa1d}ok`],
    ['an empty parameter, and erasing a whole line', `${E}[;5Hq${E}[2;1Habc${E}[2Kd`],
    ['moving up or down from outside the scroll region', `${E}[5;10r${E}[2;1H${E}[Aa${E}[20;1H${E}[Bb${E}[22;3H${E}[3eZ`],
    ['inserting and deleting lines outside the scroll region', `${E}[3;5r${E}[1;1Hrow1${E}[L${E}[M${E}[10;1Hrow10${E}[2L${E}[2M${E}[4;1Hin${E}[L${E}[r`],
    ['C0 controls inside a CSI, which run', `ab${E}[\r1Cc${E}[2\n;3Hz${E}[5\x07;5Hv`],
    ['a saved cursor with parameters, and charsets with intermediates', `${E}[3;3H${E}[1s${E}[9;9H${E}[1uq${E}( Bx${E}%Gy`],
    ['a combining mark at the start of a row', `ab\ŕc`],
    ['a line feed at the bottom row, under the scroll region', `${E}[1;5r${E}[24;1Hx\ny${E}[r`],
    ['47 and 1049, switching or not, and their saved cursors', `main${E}[?47h${E}[5;5Halt${E}[?47lZ${E}[?1049l${E}[?1049h${E}[?1049hq${E}[?1049lr`],
    ['a scroll region and a saved cursor on each screen', `${E}[3;6r${E}[2;2H${E}7${E}[?1049h${E}[8;8H${E}7${E}[1;4r${E}[4;1H\n\nalt${E}8A${E}[?1049l${E}8B\n${E}[6;1H\n\nm`],
    ['erasing the scrollback only', `abc${E}[3Jd`],
    ['cursor moves far past every edge', `${E}[999;999Hz${E}[0;0Ha${E}[99Ab${E}[99Bc${E}[99Dd${E}[2;99rx${E}[5;3ry`],
  ])('matches xterm on %s', async (_name, raw) => {
    expect(screenOf(raw, DEFAULT_SCREEN).lines()).toEqual(await xtermRows(raw))
  })
})

describe('TerminalScreen', () => {
  it('reads a ConPTY repaint as the screen shows it, not as the stream spells it', () => {
    // Claude Code's footer, as ConPTY sends it: cursor-forwards for the spaces, then an erase.
    const raw = `${E}[21;3H⏵⏵${E}[1Cbypass${E}[1Cpermissions${E}[1Con${E}[1C·${E}[1Cesc${E}[1Cto${E}[1Cinterrupt${E}[21;49H${E}[K`
    expect(screenOf(raw).lines()[20]).toBe('  ⏵⏵ bypass permissions on · esc to interrupt'.slice(0, 48).trimEnd())
  })

  it('keeps the parser state across writes that split a sequence', () => {
    const screen = new TerminalScreen()
    for (const piece of [`${E}`, '[2', ';', '5H', 'ab', `${E}]0;sp`, 'lit', '\x07', `${E}[1`, 'C', 'c']) screen.write(piece)
    expect(screen.lines()[1]).toBe('    ab c')
    expect(screen.title).toBe('split')
  })

  it('keeps the last window title, from OSC 0 or 2, and ignores the icon name', () => {
    const screen = screenOf(`${E}]0;✳ Claude Code\x07${E}]1;icon\x07${E}]2;◐ Claude Code${E}\\`)
    expect(screen.title).toBe('◐ Claude Code')
    expect(screenOf(`${E}]0\x07`).title).toBe('')
  })

  it('hands over the rows that scroll off the top of the main screen, once, and none from the alternate one', () => {
    const screen = new TerminalScreen({ cols: 20, rows: 3 })
    screen.write('one\r\ntwo\r\nthree\r\nfour\r\nfive')
    expect(screen.takeScrolledOff()).toEqual(['one', 'two'])
    expect(screen.takeScrolledOff()).toEqual([])
    screen.write(`${E}[?1049h\r\na\r\nb\r\nc\r\nd${E}[?1049l`)
    expect(screen.takeScrolledOff()).toEqual([])
    // A scroll region that doesn't start at the top scrolls nothing off the screen.
    screen.write(`${E}[2;3r${E}[3;1H\r\nx\r\ny`)
    expect(screen.takeScrolledOff()).toEqual([])
  })

  it('keeps at most the last thousand rows that scrolled off', () => {
    const screen = new TerminalScreen({ cols: 10, rows: 2 })
    screen.write(Array.from({ length: 1205 }, (_, i) => `r${i}`).join('\r\n'))
    const off = screen.takeScrolledOff()
    expect(off).toHaveLength(1000)
    // r1203 and r1204 are still on the screen.
    expect(off[off.length - 1]).toBe('r1202')
  })

  it('clamps a nonsense size to one cell', () => {
    const screen = new TerminalScreen({ cols: 0, rows: -3 })
    screen.write('xyz')
    expect(screen.lines()).toEqual(['z'])
  })
})

describe('screenSizeOf', () => {
  it('is a hidden terminal\'s 80x24 when the stream never addresses past it', () => {
    expect(screenSizeOf(`${E}[24;80Hx${E}[3Hy`)).toEqual({ cols: 80, rows: 24 })
    expect(screenSizeOf('plain output')).toEqual(DEFAULT_SCREEN)
  })

  it('grows to the furthest cell a resized terminal\'s repaint addresses', () => {
    expect(screenSizeOf(`${E}[30;1H${E}[12;121f`)).toEqual({ cols: 121, rows: 30 })
  })

  it('caps an absurd position', () => {
    expect(screenSizeOf(`${E}[99999;99999H`)).toEqual({ cols: 1000, rows: 500 })
  })
})
