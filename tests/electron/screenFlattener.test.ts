// The bugs these pin came off a real phone: a paired device showed a screen of
// "Compacting conversation..." repeated sixty times, and prose arrived with its
// spaces and some of its letters missing. Both are the same defect -- the phone
// treated a cursor-addressed redraw as append-only scrollback -- so both are
// tested against the byte sequences that actually produce them.
//
// Almost every test accumulates through `apply`, because the thing worth
// asserting is what a person ends up looking at, not the shape of the message
// that got it there.

import { describe, it, expect } from 'vitest'

import { ScreenFlattener, type FlatEdit } from '../../src/main/remoteBridge/screenFlattener'

/** How Claude Code draws one frame of its status line: return to column zero,
 *  erase what is there, write the frame. Ten times a second, in place. */
function frame(text: string): string {
  return `\r\x1b[2K${text}`
}

/** Apply an edit the way the phone does. */
function apply(view: string, edit: FlatEdit | null): string {
  if (edit === null) return view
  return view.slice(0, edit.replaceFrom) + edit.text
}

/** `n` numbered lines, each terminated. Written as one batch because xterm
 *  resolves a write callback off a timer, so a test that awaits per line spends
 *  its whole budget in the scheduler rather than in the code under test. */
function lines(prefix: string, n: number, suffix = '', from = 0): string {
  let out = ''
  for (let i = from; i < from + n; i += 1) {
    out += suffix === '' ? `${prefix} ${i}\r\n` : `${prefix} ${i} ${suffix}\r\n`
  }
  return out
}

/** Strip colour, for the assertions that are about layout rather than style. */
function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/** A view accumulated the way the phone accumulates one. */
class Phone {
  view = ''
  constructor(private readonly flat: ScreenFlattener) {}
  async feed(raw: string, terminalId = 't1'): Promise<FlatEdit | null> {
    const edit = await this.flat.feed(terminalId, raw)
    this.view = apply(this.view, edit)
    return edit
  }
  get text(): string {
    return plain(this.view)
  }
}

describe('flattening a redrawn status line', () => {
  it('keeps one line where the raw stream has sixty frames', async () => {
    const phone = new Phone(new ScreenFlattener(80, 24))
    for (let i = 1; i <= 60; i += 1) await phone.feed(frame(`Compacting conversation... (${i}s)`))

    // The reported symptom, stated as an assertion: the phrase appears once.
    expect(phone.text.split('Compacting conversation').length - 1).toBe(1)
    expect(phone.text).toBe('Compacting conversation... (60s)')
  })

  it('leaves finished lines alone while the line below them redraws', async () => {
    const phone = new Phone(new ScreenFlattener(80, 24))
    await phone.feed('ok, running the tests\r\n')
    await phone.feed(frame('Thinking... (1s)'))
    await phone.feed(frame('Thinking... (2s)'))

    expect(phone.text).toBe('ok, running the tests\nThinking... (2s)')
  })

  it('reports no edit when a frame repaints the same thing', async () => {
    const flat = new ScreenFlattener(80, 24)
    await flat.feed('t1', frame('Thinking...'))
    // A spinner that has not changed is not news, and sending it would spend a
    // relay frame to tell the phone nothing.
    expect(await flat.feed('t1', frame('Thinking...'))).toBeNull()
  })

  it('sends only the part of the frame that moved', async () => {
    const flat = new ScreenFlattener(80, 24)
    await flat.feed('t1', frame('Thinking... (9s)'))
    const edit = await flat.feed('t1', frame('Thinking... (10s)'))
    // The whole point of the diff: a ticking counter costs a few bytes a second
    // over the relay, not a screenful.
    expect(plain(edit?.text ?? '')).toBe('10s)')
  })
})

describe('flattening a differential repaint', () => {
  it('keeps the spaces a cursor move stands in for', async () => {
    const phone = new Phone(new ScreenFlattener(80, 24))
    // Ink positions with cursor-forward instead of painting runs of spaces.
    // Dropping those moves is what turned "that cleared on its own" into
    // "thatclearedonitsown" on the phone.
    await phone.feed('that\x1b[1Ccleared\x1b[1Con\x1b[1Cits\x1b[1Cown')
    expect(phone.text).toBe('that cleared on its own')
  })

  it('keeps letters a repaint skips over because they are already right', async () => {
    const phone = new Phone(new ScreenFlattener(80, 24))
    await phone.feed('propagation')
    // A differential repaint rewrites only what changed and steps over the rest.
    // Here it returns to column 0 and re-paints just the first four cells; the
    // remaining letters survive because the grid still holds them.
    await phone.feed('\rprop')
    expect(phone.text).toBe('propagation')
  })

  it('follows a repaint that moves back up a line', async () => {
    const phone = new Phone(new ScreenFlattener(80, 24))
    await phone.feed('first draft\r\nsecond line\r\n')
    // Cursor up two, column one, overwrite: the sequence Ink uses to correct a
    // line it has already drawn. An append-only view shows both versions.
    await phone.feed('\x1b[2A\x1b[G\x1b[2Kfinal draft')
    expect(phone.text).toBe('final draft\nsecond line')
  })
})

describe('what the phone is told to do with an edit', () => {
  it('appends without rewriting when output only grows', async () => {
    const flat = new ScreenFlattener(80, 24)
    await flat.feed('t1', 'first line\r\n')
    const edit = await flat.feed('t1', 'second line\r\n')
    // Append-only output must stay append-only, or every ordinary command would
    // pay the cost of the mechanism that exists for redraws. The line break
    // rides along in the appended text: the first line is not terminated until
    // something follows it, because until then it is still the line the cursor
    // is on and still open to being rewritten.
    expect(edit?.replaceFrom).toBe('first line'.length)
    expect(plain(edit?.text ?? '')).toBe('\nsecond line')
    expect(plain(apply('first line', edit))).toBe('first line\nsecond line')
  })

  it('does not pad the phone with the emulator blank rows', async () => {
    const flat = new ScreenFlattener(80, 24)
    const edit = await flat.feed('t1', 'hello\r\n')
    // The grid is always a full rectangle. Sending its blank remainder would put
    // twenty-three empty lines on the phone after every command.
    expect(plain(edit?.text ?? '')).toBe('hello')
  })

  it('keeps a blank line that has something under it', async () => {
    const phone = new Phone(new ScreenFlattener(80, 24))
    // Only the trailing blank rows are the grid's padding. A blank line between
    // two paragraphs is content, and dropping it would reflow the output.
    await phone.feed('one\r\n\r\nthree\r\n')
    expect(phone.text).toBe('one\n\nthree')
  })

  it('keeps terminals apart', async () => {
    const flat = new ScreenFlattener(80, 24)
    const a = await flat.feed('t1', 'in one')
    const b = await flat.feed('t2', 'in two')
    expect(plain(a?.text ?? '')).toBe('in one')
    // A second terminal starts its own stream at zero rather than continuing
    // the first one's offsets.
    expect(b?.replaceFrom).toBe(0)
    expect(plain(b?.text ?? '')).toBe('in two')
  })

  it('starts a forgotten terminal over from zero', async () => {
    const flat = new ScreenFlattener(80, 24)
    await flat.feed('t1', 'output that is quite long')
    flat.forget('t1')
    const edit = await flat.feed('t1', 'fresh')
    expect(edit?.replaceFrom).toBe(0)
    expect(plain(edit?.text ?? '')).toBe('fresh')
  })

  it('drops every emulator at once when the bridge goes away', async () => {
    const flat = new ScreenFlattener(80, 24)
    await flat.feed('t1', 'one')
    await flat.feed('t2', 'two')
    flat.forgetAll()
    expect((await flat.feed('t1', 'again'))?.replaceFrom).toBe(0)
    expect((await flat.feed('t2', 'again'))?.replaceFrom).toBe(0)
  })

  it('shrugs at being told to forget a terminal it never had', () => {
    const flat = new ScreenFlattener(80, 24)
    expect(() => flat.forget('never-existed')).not.toThrow()
  })

  it('says nothing about an empty write', async () => {
    const flat = new ScreenFlattener(80, 24)
    // A zero-length read happens whenever the pump wakes with nothing to carry.
    expect(await flat.feed('t1', '')).toBeNull()
  })
})

describe('colour survives the flattening', () => {
  it('keeps the sixteen-colour palette the phone already renders', async () => {
    const flat = new ScreenFlattener(80, 24)
    const edit = await flat.feed('t1', '\x1b[31;41mred\x1b[0m plain')
    // Palette entries leave as 38;5;n / 48;5;n, which is the one indexed form
    // the phone's renderer understands. Losing colour here would trade the
    // reported bug for a duller one.
    expect(edit?.text).toContain('\x1b[0;38;5;1;48;5;1m')
    expect(edit?.text).toContain('red')
    expect(edit?.text).toContain('plain')
    expect(plain(edit?.text ?? '')).toBe('red plain')
  })

  it('keeps true colour and the text attributes', async () => {
    const flat = new ScreenFlattener(80, 24)
    const edit = await flat.feed(
      't1',
      '\x1b[1;2;3;4;7;38;2;10;20;30;48;2;40;50;60mstyled\x1b[0m',
    )
    expect(edit?.text).toContain('\x1b[0;1;2;3;4;7;38;2;10;20;30;48;2;40;50;60m')
    expect(plain(edit?.text ?? '')).toBe('styled')
  })

  it('closes a colour run so it cannot bleed into the next line', async () => {
    const flat = new ScreenFlattener(80, 24)
    const edit = await flat.feed('t1', '\x1b[32mgreen')
    expect(edit?.text.endsWith('\x1b[0m')).toBe(true)
  })

  it('keeps a painted background that runs to the end of the line', async () => {
    const flat = new ScreenFlattener(20, 6)
    const edit = await flat.feed('t1', '\x1b[44mbar\x1b[K\x1b[0m\r\ntext')
    // Trailing cells are usually the grid's blank padding and get trimmed, but
    // a cell with a background set is painted -- trimming it would cut a
    // status bar off at its last letter.
    expect(plain(edit?.text ?? '')).toBe('bar                 \ntext')
  })

  it('emits a double-width glyph once, not once per cell', async () => {
    const flat = new ScreenFlattener(20, 6)
    const edit = await flat.feed('t1', '你好 ok')
    expect(plain(edit?.text ?? '')).toBe('你好 ok')
  })
})

describe('lines longer than the emulator is wide', () => {
  it('hands the phone one logical line, not one line per wrap', async () => {
    const flat = new ScreenFlattener(20, 6)
    const long = 'abcdefghijklmnopqrstuvwxyz0123456789'
    const edit = await flat.feed('t1', long)
    // The phone is far narrower than the emulator and wraps to its own width.
    // A hard break at the emulator's column 20 would show up as a ragged edge
    // in the middle of the text.
    expect(plain(edit?.text ?? '')).toBe(long)
  })

  it('does not settle half of a wrapped line as it scrolls', async () => {
    const phone = new Phone(new ScreenFlattener(20, 4))
    const long = 'wrapped-line-that-keeps-going-past-the-edge'
    await phone.feed(`${long}\r\n`)
    for (let i = 0; i < 6; i += 1) await phone.feed(`filler ${i}\r\n`)
    // Once the wrapped line has scrolled out of the viewport it is settled and
    // can never be corrected, so it has to be settled whole.
    expect(phone.text).toContain(long)
    expect(phone.text.startsWith(`${long}\nfiller 0`)).toBe(true)
  })
})

describe('once output has scrolled past the viewport', () => {
  /** Enough lines to push the earliest ones well above the viewport. */
  async function scrollPastViewport(phone: Phone, count = 200): Promise<void> {
    await phone.feed(lines('line', count, 'of output here'))
  }

  it('still appends in the right place', async () => {
    const phone = new Phone(new ScreenFlattener(80, 24))
    await scrollPastViewport(phone)
    await phone.feed('the newest line\r\n')
    expect(phone.text.endsWith('the newest line')).toBe(true)
    expect(phone.text).toContain('line 0 of output here')
    expect(phone.text).toContain('line 199 of output here')
  })

  it('still collapses a redraw in the right place', async () => {
    const phone = new Phone(new ScreenFlattener(80, 24))
    await scrollPastViewport(phone)
    for (let i = 1; i <= 30; i += 1) await phone.feed(frame(`Compacting conversation... (${i}s)`))
    expect(phone.text.split('Compacting conversation').length - 1).toBe(1)
    expect(phone.text.endsWith('Compacting conversation... (30s)')).toBe(true)
    expect(phone.text).toContain('line 0 of output here')
  })

  it('never re-sends a line that has scrolled out of reach', async () => {
    const flat = new ScreenFlattener(80, 24)
    await flat.feed('t1', lines('line', 200, 'of output here'))
    const edit = await flat.feed('t1', 'one more\r\n')
    // Settled history is sent once. An edit that reached back into it would put
    // the whole session on the wire every time a line scrolled.
    expect(plain(edit?.text ?? '')).toBe('\none more')
  })

  it('survives being rebuilt underneath a long-running terminal', async () => {
    // Small geometry keeps the test quick; the emulator recycles on line count,
    // which is independent of width.
    const phone = new Phone(new ScreenFlattener(40, 8))
    for (let batch = 0; batch < 21; batch += 1) await phone.feed(lines('line', 200, '', batch * 200))
    // Rebuilding replays the viewport into a fresh emulator, so a redraw that
    // lands after it still has the grid it is drawing on.
    await phone.feed(frame('Thinking... (1s)'))
    await phone.feed(frame('Thinking... (2s)'))
    expect(phone.text.endsWith('line 4199\nThinking... (2s)')).toBe(true)
    expect(phone.text).toContain('line 0\n')
    expect(phone.text.split('Thinking').length - 1).toBe(1)
  }, 60_000)

  it('settles as it goes through a batch far larger than one screen', async () => {
    // One write carrying more lines than a segment, which is the path that
    // splits the batch so nothing scrolls away unrecorded.
    const phone = new Phone(new ScreenFlattener(40, 8))
    await phone.feed(lines('bulk', 2500))
    expect(phone.text.startsWith('bulk 0\nbulk 1\n')).toBe(true)
    expect(phone.text.endsWith('bulk 2499')).toBe(true)
  }, 60_000)

  it('handles a batch that ends exactly on a segment boundary', async () => {
    const phone = new Phone(new ScreenFlattener(40, 8))
    // Exactly one segment's worth of newlines and not one character more, so
    // the loop yields the last piece and there is no remainder behind it.
    await phone.feed(lines('edge', 1000))
    expect(phone.text.endsWith('edge 999')).toBe(true)
  }, 60_000)
})

describe('when the terminal throws its own history away', () => {
  it('keeps the phone history the desktop just dropped', async () => {
    const phone = new Phone(new ScreenFlattener(80, 24))
    await phone.feed(lines('line', 60))
    // `clear` erases the screen and the scrollback. The phone's copy is the
    // user's, not the desktop's: erasing what they scrolled back to read
    // because the desktop erased its own would be the more annoying bug.
    await phone.feed('\x1b[3J\x1b[2J\x1b[Hfresh start')
    expect(phone.text).toContain('line 0')
    expect(phone.text.endsWith('fresh start')).toBe(true)
    // What was ON the screen does go, because that is what clearing a screen
    // does and the phone is meant to show what the desktop shows. Only the
    // lines that had already scrolled above it are the phone's to keep.
    expect(phone.text).not.toContain('line 59')
    // And the history must not be replayed as new output on the way past.
    expect(phone.text.split('line 0\n').length - 1).toBe(1)
  })
})

describe('a full-screen program taking over', () => {
  it('replaces the screen while it runs and restores what was under it', async () => {
    const phone = new Phone(new ScreenFlattener(40, 6))
    await phone.feed('$ git log\r\n')
    // Enter the alternate screen, draw, leave it. Nothing drawn there is ever
    // final: it is a scratch grid that is discarded wholesale on exit.
    await phone.feed('\x1b[?1049h\x1b[2J\x1b[Hcommit abcdef\r\n(END)')
    expect(phone.text).toContain('commit abcdef')

    await phone.feed('\x1b[?1049l')
    // Back on the normal screen the pager's output is gone, and -- the part
    // that used to double -- the history under it is not re-appended.
    expect(phone.text).not.toContain('commit abcdef')
    expect(phone.text.split('$ git log').length - 1).toBe(1)
  })

  it('does not append the pager screen to the history behind it', async () => {
    const phone = new Phone(new ScreenFlattener(40, 6))
    await phone.feed(lines('before', 30))
    await phone.feed('\x1b[?1049h\x1b[2J\x1b[Hpager view')
    // Scrolling inside the alternate screen settles nothing, however long it
    // runs, because none of it survives the program exiting.
    await phone.feed(lines('pager row', 30))
    await phone.feed('\x1b[?1049l')
    expect(phone.text).not.toContain('pager row 29')
    expect(phone.text).toContain('before 29')
    expect(phone.text.split('before 0\n').length - 1).toBe(1)
  })
})
