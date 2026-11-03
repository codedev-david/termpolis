// The screen kept beside the window for a terminal an agent runs in (F-R2-2): Claude Code paints its input box
// once, so the last 32 KB of its output no longer draw one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appendOutput, liveScreen, readOutput, readOutputFrom, replayPreamble, reportedFamilies, resizeScreen, unwatchScreen, watchScreen, MAX_TERMINAL_BUFFER_CHARS,
  SCREEN_CHUNK_MAX, SCREEN_BYTES_PER_SECOND, _setScreenClockForTest,
  type OutputBuffers,
} from '../../src/main/terminalOutputBuffer'
import { screenOfReplay } from '../../src/shared/terminalScreen'

const E = '\x1b'
const SIZE = { cols: 40, rows: 6 }
const BOX = `${E}[2J${E}[H${E}[4;1H${'─'.repeat(40)}${E}[5;1H> ${E}[6;1H${'─'.repeat(40)}`
const spin = (n: number): string => `${E}[1;1H* working ${n}${E}[K`

describe('the screen kept beside the window', () => {
  it('has none for a terminal nobody asked it for, and costs that terminal nothing', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', BOX)
    expect(liveScreen(buffers, 't')).toBeNull()
    expect(liveScreen(buffers, 'missing')).toBeNull()
    expect(buffers.get('t')!.screen).toBeUndefined()
  })

  it('draws what the window holds when it starts, and every chunk after that', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', BOX)
    expect(watchScreen(buffers, 't', SIZE)).toBe(true)
    expect(liveScreen(buffers, 't')!.lines[3]).toBe('─'.repeat(40))
    appendOutput(buffers, 't', `${E}[1;1Hhello`)
    expect(liveScreen(buffers, 't')!.lines[0]).toBe('hello')
  })

  it('keeps the box through more output than the window holds, which the window itself loses', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', BOX)
    watchScreen(buffers, 't', SIZE)
    for (let n = 0; n < 3000; n++) appendOutput(buffers, 't', spin(n))
    expect(buffers.get('t')!.total).toBeGreaterThan(MAX_TERMINAL_BUFFER_CHARS)
    expect(readOutput(buffers, 't')).not.toContain('─')
    expect(liveScreen(buffers, 't')!.lines[3]).toBe('─'.repeat(40))
    expect(liveScreen(buffers, 't')!.lines[4]).toBe('>')
  })

  it('is the same screen a replay of everything draws, as long as the window still holds everything', () => {
    const buffers: OutputBuffers = new Map()
    const chunks = [BOX, spin(1), `${E}[5;3Hls\r\n`, spin(2), `${E}[2;1Hdone${E}[K`, '\r\nplain text\r\nmore\r\n']
    for (const c of chunks.slice(0, 2)) appendOutput(buffers, 't', c)
    watchScreen(buffers, 't', SIZE)
    for (const c of chunks.slice(2)) appendOutput(buffers, 't', c)
    const replay = screenOfReplay({ output: chunks.join(''), ...SIZE })
    expect(liveScreen(buffers, 't')).toEqual({ lines: replay.lines(), title: replay.title })
  })

  it('draws the window title the output set', () => {
    const buffers: OutputBuffers = new Map()
    watchScreen(buffers, 't', SIZE)
    appendOutput(buffers, 't', `${E}]0;✳ Claude Code\x07`)
    expect(liveScreen(buffers, 't')!.title).toBe('✳ Claude Code')
  })

  it('does not pile up the rows that scroll off its top', () => {
    const buffers: OutputBuffers = new Map()
    watchScreen(buffers, 't', SIZE)
    appendOutput(buffers, 't', Array.from({ length: 50 }, (_, i) => `row ${i}\r\n`).join(''))
    expect(buffers.get('t')!.screen!.takeScrolledOff()).toEqual([])
  })

  it('starts on a terminal that has printed nothing yet, and draws its first chunk', () => {
    const buffers: OutputBuffers = new Map()
    expect(watchScreen(buffers, 'new', SIZE)).toBe(true)
    expect(readOutputFrom(buffers, 'new', 0)).toEqual({ output: '', nextOffset: 0, missed: 0 })
    appendOutput(buffers, 'new', 'first words')
    expect(liveScreen(buffers, 'new')!.lines[0]).toBe('first words')
    expect(readOutputFrom(buffers, 'new', 0)).toMatchObject({ output: 'first words', nextOffset: 11 })
  })

  it('is not started for a terminal of no known size (it is gone), and leaves no window behind', () => {
    const buffers: OutputBuffers = new Map()
    expect(watchScreen(buffers, 'gone', null)).toBe(false)
    expect(buffers.has('gone')).toBe(false)
  })

  it('is kept as it is when asked again for the same size, and drawn again from the window for another', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', BOX)
    watchScreen(buffers, 't', SIZE)
    const first = buffers.get('t')!.screen
    watchScreen(buffers, 't', { ...SIZE })
    expect(buffers.get('t')!.screen).toBe(first)
    watchScreen(buffers, 't', { cols: 30, rows: 8 })
    expect(buffers.get('t')!.screen).not.toBe(first)
    expect(liveScreen(buffers, 't')!.lines).toHaveLength(8)
  })

  it('is drawn again at the new size when the terminal is resized, and only if one is kept', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', BOX)
    resizeScreen(buffers, 't', { cols: 30, rows: 8 })
    expect(buffers.get('t')!.screen).toBeUndefined()
    watchScreen(buffers, 't', SIZE)
    resizeScreen(buffers, 't', null)
    expect(liveScreen(buffers, 't')!.lines).toHaveLength(6)
    resizeScreen(buffers, 'missing', { cols: 30, rows: 8 })
    resizeScreen(buffers, 't', { cols: 30, rows: 8 })
    expect(liveScreen(buffers, 't')!.lines).toHaveLength(8)
    appendOutput(buffers, 't', `${E}[2J${E}[H${E}[8;1H${'─'.repeat(30)}`)
    expect(liveScreen(buffers, 't')!.lines[7]).toBe('─'.repeat(30))
  })

  // F-R3-2: the same-size check compares both axes; one dropped would leave a screen of the wrong height (or width) after a resize on one axis.
  it.each([
    ['taller', { cols: 40, rows: 9 }],
    ['shorter', { cols: 40, rows: 4 }],
    ['wider', { cols: 55, rows: 6 }],
    ['narrower', { cols: 25, rows: 6 }],
    ['both', { cols: 55, rows: 9 }],
  ])('is drawn again at the new size when the pane is resized %s, on one axis or both', (_what, size) => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', BOX)
    watchScreen(buffers, 't', SIZE)
    const before = buffers.get('t')!.screen
    resizeScreen(buffers, 't', size)
    const after = buffers.get('t')!.screen!
    expect(after).not.toBe(before)
    expect([after.cols, after.rows]).toEqual([size.cols, size.rows])
    expect(liveScreen(buffers, 't')!.lines).toHaveLength(size.rows)
    // The same size again is the screen already kept, not another.
    resizeScreen(buffers, 't', size)
    expect(buffers.get('t')!.screen).toBe(after)
  })

  it('draws the title the output set, from a screen kept from the start and from one kept anew', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', `${E}]0;✳ Claude Code${BOX}`)
    watchScreen(buffers, 't', SIZE)
    expect(liveScreen(buffers, 't')!.title).toBe('✳ Claude Code')
    appendOutput(buffers, 't', `${E}]0;⠐ working`)
    expect(liveScreen(buffers, 't')!.title).toBe('⠐ working')
    resizeScreen(buffers, 't', { cols: 30, rows: 8 })
    expect(liveScreen(buffers, 't')!.title).toBe('⠐ working')
  })

  it('starts in the mode the evicted output left: an agent that entered the alternate screen long ago', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', `${E}[?1049h${E}[H`)
    appendOutput(buffers, 't', 'x'.repeat(MAX_TERMINAL_BUFFER_CHARS + 10))
    expect(replayPreamble(buffers, 't')!.preamble).toContain('1049h')
    watchScreen(buffers, 't', SIZE)
    appendOutput(buffers, 't', `${E}[2J${E}[Hon the alt screen`)
    expect(liveScreen(buffers, 't')!.lines[0]).toBe('on the alt screen')
    // The filler the window held was drawn on the alternate screen, as the agent had it: leaving that shows
    // the main screen as it was, empty (a screen drawn without the preamble would show the filler on it).
    appendOutput(buffers, 't', `${E}[?1049l`)
    expect(liveScreen(buffers, 't')!.lines.join('')).toBe('')
  })

  it('starts after the rest of an escape sequence the eviction cut into, which is not text on the screen', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', `AB${E}[?1049h`, 10)
    appendOutput(buffers, 't', 'CDEFG', 10)
    // The window opens on `1049hCDEFG`: the head of the mode switch was evicted, and its tail is five chars.
    expect(readOutput(buffers, 't')).toBe('1049hCDEFG')
    watchScreen(buffers, 't', SIZE)
    expect(liveScreen(buffers, 't')!.lines[0]).toBe('CDEFG')
  })

  it('drops a screen that cannot draw a chunk, and the window carries on', () => {
    const buffers: OutputBuffers = new Map()
    watchScreen(buffers, 't', SIZE)
    buffers.get('t')!.screen!.write = () => { throw new Error('boom') }
    expect(() => appendOutput(buffers, 't', 'abc')).not.toThrow()
    expect(buffers.get('t')!.screen).toBeUndefined()
    expect(liveScreen(buffers, 't')).toBeNull()
    expect(readOutput(buffers, 't')).toBe('abc')
    // ...and a later start draws it again from the window.
    watchScreen(buffers, 't', SIZE)
    expect(liveScreen(buffers, 't')!.lines[0]).toBe('abc')
  })

  it('goes with the window when the terminal is closed', () => {
    const buffers: OutputBuffers = new Map()
    watchScreen(buffers, 't', SIZE)
    buffers.delete('t')
    expect(liveScreen(buffers, 't')).toBeNull()
  })
})

// SW2-10: which shells have reported a prompt in a terminal, kept from the output the window has since lost. The switch's
// nested-shell guard needs to know that THIS terminal's own shell reported; in the 32 KB window that is true only until an
// agent has printed a minute's work, so after any real session the guard never fired.
describe('the prompt reports a terminal has ever printed (SW2-10)', () => {
  const POSIX = `${E}]7;file://host/c/repo${String.fromCharCode(7)}`
  const WINDOWS = `${E}]9;9;C:\\repo${String.fromCharCode(7)}`

  it('knows nothing of a terminal that printed none, or that nobody asked about', () => {
    const buffers: OutputBuffers = new Map()
    expect(reportedFamilies(buffers, 'missing')).toEqual({ posix: false, windows: false })
    appendOutput(buffers, 't', 'plain text, and an escape that is no report: \x1b[1mbold\x1b[0m and \x1b]0;a title\x07')
    expect(reportedFamilies(buffers, 't')).toEqual({ posix: false, windows: false })
    expect(buffers.get('t')!.reported).toBeUndefined()
  })

  it('notes each family the first time it reports, and keeps it after the report left the window', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', `${POSIX}me@host:~$ `)
    expect(reportedFamilies(buffers, 't')).toEqual({ posix: true, windows: false })
    // A minute of work: the report is long gone from the window.
    for (let i = 0; i < 60; i++) appendOutput(buffers, 't', 'x'.repeat(1000))
    expect(readOutput(buffers, 't')).not.toContain(POSIX)
    expect(reportedFamilies(buffers, 't')).toEqual({ posix: true, windows: false })
    appendOutput(buffers, 't', `${WINDOWS}PS C:\\repo> `)
    expect(reportedFamilies(buffers, 't')).toEqual({ posix: true, windows: true })
    // Both known: later output is not looked at again, and nothing it holds changes them.
    appendOutput(buffers, 't', 'more output with no report in it')
    expect(reportedFamilies(buffers, 't')).toEqual({ posix: true, windows: true })
  })

  it('reads a report inside a larger chunk, and the other family alone', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 'a', `some output\r\n${WINDOWS}PS> more`)
    expect(reportedFamilies(buffers, 'a')).toEqual({ posix: false, windows: true })
    appendOutput(buffers, 'b', `${E}]9;1;a progress report is no prompt${String.fromCharCode(7)}`)
    expect(reportedFamilies(buffers, 'b')).toEqual({ posix: false, windows: false })
  })
})

// SAFETY-R3-8: since F-R2-2 main keeps a live screen for every terminal an agent line was typed in, and drew every output chunk onto it on the
// PTY data handler's thread for the terminal's whole life, for users who added no account too. Measured: 8 MB through appendOutput costs 0 to
// 27 ms without a screen and 640 to 766 ms with one (80 to 96 ms a MB), so a `cat` of 100 MB in such a terminal stalled main for 8 to 10 s,
// and every terminal's typing with it. The screen is dropped (the reads replay the window again, as before F-R2-2) when a flood arrives, and it
// is not drawn for a terminal whose agent has gone: both come back at the next recorded start.
describe('what the kept screen costs a flood of output (SAFETY-R3-8)', () => {
  const FLOOD = 'x'.repeat(1000)
  let clock = 1_000_000
  beforeEach(() => { clock = 1_000_000; _setScreenClockForTest(() => clock) })
  afterEach(() => { _setScreenClockForTest(null) })

  function kept(): OutputBuffers {
    const b: OutputBuffers = new Map()
    appendOutput(b, 't1', `${E}[2J${E}[H${BOX}`)
    expect(watchScreen(b, 't1', SIZE)).toBe(true)
    return b
  }

  it('draws a big chunk onto no screen: the screen goes, the window keeps every byte, and the next start brings the screen back', () => {
    const b = kept()
    const big = 'y'.repeat(SCREEN_CHUNK_MAX + 1)
    appendOutput(b, 't1', big, 10_000_000)
    expect(liveScreen(b, 't1')).toBeNull()
    expect(readOutput(b, 't1').endsWith('y')).toBe(true)
    expect(watchScreen(b, 't1', SIZE)).toBe(true)
    expect(liveScreen(b, 't1')).not.toBeNull()
  })

  it('counts a screen kept anew from nothing: the flood\'s second is not held against the next start', () => {
    const b = kept()
    const chunks = Math.floor(SCREEN_BYTES_PER_SECOND / FLOOD.length) + 2
    for (let i = 0; i < chunks; i++) appendOutput(b, 't1', FLOOD)
    expect(liveScreen(b, 't1')).toBeNull()
    expect(watchScreen(b, 't1', SIZE)).toBe(true)
    // Same second, a few chunks: well under the budget of the new screen.
    for (let i = 0; i < 10; i++) appendOutput(b, 't1', FLOOD)
    expect(liveScreen(b, 't1')).not.toBeNull()
  })

  it('draws a chunk of exactly the most', () => {
    const b = kept()
    appendOutput(b, 't1', 'y'.repeat(SCREEN_CHUNK_MAX), 10_000_000)
    expect(liveScreen(b, 't1')).not.toBeNull()
  })

  it('drops the screen once more than a second\'s budget of small chunks came within one second, and not before', () => {
    const b = kept()
    const chunks = Math.floor(SCREEN_BYTES_PER_SECOND / FLOOD.length)
    for (let i = 0; i < chunks; i++) appendOutput(b, 't1', FLOOD)
    expect(liveScreen(b, 't1')).not.toBeNull()
    appendOutput(b, 't1', FLOOD)
    expect(liveScreen(b, 't1')).toBeNull()
    // The window took all of it, and a start asks for the screen again.
    expect(reportedFamilies(b, 't1')).toEqual({ posix: false, windows: false })
    expect(watchScreen(b, 't1', SIZE)).toBe(true)
    expect(liveScreen(b, 't1')).not.toBeNull()
  })

  it('counts each second on its own: the same bytes spread over several seconds draw all along', () => {
    const b = kept()
    const perSecond = Math.floor(SCREEN_BYTES_PER_SECOND / FLOOD.length)
    for (let second = 0; second < 5; second++) {
      for (let i = 0; i < perSecond; i++) appendOutput(b, 't1', FLOOD)
      clock += 1000
    }
    expect(liveScreen(b, 't1')).not.toBeNull()
  })

  it('keeps drawing an agent\'s steady redraws, which are far under the budget', () => {
    const b = kept()
    for (let i = 0; i < 3000; i++) {
      appendOutput(b, 't1', spin(i))
      clock += 20
    }
    expect(liveScreen(b, 't1')?.lines.join('\n')).toContain('working 2999')
  })

  it('costs a flood nothing once dropped: the screen is not written', () => {
    const b = kept()
    appendOutput(b, 't1', 'y'.repeat(SCREEN_CHUNK_MAX + 1), 10_000_000)
    const t0 = process.cpuUsage()
    for (let i = 0; i < 200; i++) appendOutput(b, 't1', 'z'.repeat(40_000), 10_000_000)
    const used = process.cpuUsage(t0)
    // 8 MB through a kept screen cost 640 ms or more of CPU on the laptop it was measured on; with none it costs a few tens.
    expect((used.user + used.system) / 1000).toBeLessThan(400)
  })
})

describe('unwatching a terminal\'s screen once its agent is gone (SAFETY-R3-8)', () => {
  it('drops the screen, and keeps the window; watching it again draws what the window holds', () => {
    const b: OutputBuffers = new Map()
    appendOutput(b, 't1', `${E}[2J${E}[H${BOX}`)
    watchScreen(b, 't1', SIZE)
    expect(liveScreen(b, 't1')).not.toBeNull()
    unwatchScreen(b, 't1')
    expect(liveScreen(b, 't1')).toBeNull()
    appendOutput(b, 't1', 'more')
    expect(readOutput(b, 't1').endsWith('more')).toBe(true)
    expect(liveScreen(b, 't1')).toBeNull()
    watchScreen(b, 't1', SIZE)
    expect(liveScreen(b, 't1')?.lines.join('\n')).toContain('─')
  })

  it('is nothing for a terminal that has no screen or no window', () => {
    const b: OutputBuffers = new Map()
    expect(() => unwatchScreen(b, 'nobody')).not.toThrow()
    appendOutput(b, 't2', 'text')
    expect(() => unwatchScreen(b, 't2')).not.toThrow()
    expect(liveScreen(b, 't2')).toBeNull()
  })

  it('is not undone by a resize: a terminal with no screen kept has none to rebuild', () => {
    const b: OutputBuffers = new Map()
    appendOutput(b, 't1', `${E}[2J${E}[H${BOX}`)
    watchScreen(b, 't1', SIZE)
    unwatchScreen(b, 't1')
    resizeScreen(b, 't1', { cols: 50, rows: 8 })
    expect(liveScreen(b, 't1')).toBeNull()
  })
})
