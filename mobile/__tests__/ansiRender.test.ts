import { renderAnsi, type Segment } from '../src/ansi/render'

const ESC = '\u001b'

function texts(segments: Segment[]): string[] {
  return segments.map((s) => s.text)
}

function plain(segments: Segment[]): string {
  return segments.map((s) => s.text).join('')
}

describe('text with no escapes', () => {
  it('comes back as one segment', () => {
    expect(renderAnsi('hello world')).toEqual([{ text: 'hello world' }])
  })

  it('returns nothing for an empty string', () => {
    expect(renderAnsi('')).toEqual([])
  })

  it('normalises CRLF and bare CR', () => {
    // A PTY writes CRLF and agents rewrite a status line with a bare CR. Left
    // alone, both render as a stray glyph in a Text node.
    expect(plain(renderAnsi('a\r\nb\rc'))).toBe('a\nb\nc')
  })
})

describe('colour', () => {
  it('sets a standard foreground and resets it', () => {
    const out = renderAnsi(`before ${ESC}[31mred${ESC}[0m after`)
    expect(texts(out)).toEqual(['before ', 'red', ' after'])
    expect(out[1]?.fg).toBe('#cd3131')
    expect(out[2]?.fg).toBeUndefined()
  })

  it('reads the bright variants', () => {
    expect(renderAnsi(`${ESC}[91mx`)[0]?.fg).toBe('#f14c4c')
  })

  it('reads a background', () => {
    const out = renderAnsi(`${ESC}[42mx`)
    expect(out[0]?.bg).toBe('#0dbc79')
    expect(out[0]?.fg).toBeUndefined()
  })

  it('reads 256-colour', () => {
    expect(renderAnsi(`${ESC}[38;5;208mx`)[0]?.fg).toBe('#ff8700')
  })

  it('reads the greyscale ramp of 256-colour', () => {
    expect(renderAnsi(`${ESC}[38;5;244mx`)[0]?.fg).toBe('#808080')
  })

  it('reads the first sixteen of 256-colour as the palette', () => {
    expect(renderAnsi(`${ESC}[38;5;1mx`)[0]?.fg).toBe('#cd3131')
  })

  it('reads truecolour', () => {
    expect(renderAnsi(`${ESC}[38;2;10;20;30mx`)[0]?.fg).toBe('#0a141e')
  })

  it('reads a truecolour background', () => {
    expect(renderAnsi(`${ESC}[48;2;255;0;128mx`)[0]?.bg).toBe('#ff0080')
  })

  it('clears just the foreground on 39 and just the background on 49', () => {
    const out = renderAnsi(`${ESC}[31;42ma${ESC}[39mb${ESC}[49mc`)
    expect(out[1]?.fg).toBeUndefined()
    expect(out[1]?.bg).toBe('#0dbc79')
    expect(out[2]?.bg).toBeUndefined()
  })

  it('ignores a colour index that is out of range', () => {
    expect(renderAnsi(`${ESC}[38;5;999mx`)[0]?.fg).toBeUndefined()
  })

  it('ignores a truecolour triple that is short', () => {
    expect(renderAnsi(`${ESC}[38;2;10mx`)[0]?.fg).toBeUndefined()
  })
})

describe('attributes', () => {
  it('accumulates and resets together', () => {
    const out = renderAnsi(`${ESC}[1m${ESC}[4m${ESC}[3mx${ESC}[0my`)
    expect(out[0]).toEqual({ text: 'x', bold: true, underline: true, italic: true })
    expect(out[1]).toEqual({ text: 'y' })
  })

  it('reads dim', () => {
    expect(renderAnsi(`${ESC}[2mx`)[0]?.dim).toBe(true)
  })

  it('turns one attribute off without disturbing the others', () => {
    const out = renderAnsi(`${ESC}[1;4mx${ESC}[24my`)
    expect(out[1]).toEqual({ text: 'y', bold: true })
  })

  it('reads 22 as clearing both bold and dim, which is what it means', () => {
    const out = renderAnsi(`${ESC}[1;2mx${ESC}[22my`)
    expect(out[1]).toEqual({ text: 'y' })
  })

  it('treats a bare ESC[m as a full reset', () => {
    const out = renderAnsi(`${ESC}[1;31mx${ESC}[my`)
    expect(out[1]).toEqual({ text: 'y' })
  })

  it('runs an unknown SGR parameter off rather than aborting the sequence', () => {
    const out = renderAnsi(`${ESC}[1;53;31mx`)
    expect(out[0]).toEqual({ text: 'x', bold: true, fg: '#cd3131' })
  })

  it('emits no segment for a state change with no text after it', () => {
    expect(renderAnsi(`${ESC}[31m`)).toEqual([])
  })

  it('does not split a run that changes to the same state', () => {
    expect(renderAnsi(`${ESC}[31ma${ESC}[31mb`)).toEqual([{ text: 'ab', fg: '#cd3131' }])
  })
})

describe('sequences that are stripped rather than obeyed', () => {
  // A phone view is a scrollback, not a grid. A half-implemented cursor move
  // corrupts text in a way that dropping the sequence never does.
  const stripped: [string, string][] = [
    ['cursor up', `a${ESC}[2Ab`],
    ['cursor home', `a${ESC}[Hb`],
    ['cursor position', `a${ESC}[12;40Hb`],
    ['erase in display', `a${ESC}[2Jb`],
    ['erase in line', `a${ESC}[Kb`],
    ['scroll region', `a${ESC}[1;24rb`],
    ['save cursor', `a${ESC}[sb`],
    ['show cursor', `a${ESC}[?25hb`],
    ['bracketed paste on', `a${ESC}[?2004hb`],
    ['alt screen', `a${ESC}[?1049lb`],
    ['device status report', `a${ESC}[6nb`],
    ['charset select', `a${ESC}(Bb`],
    ['reverse index', `a${ESC}Mb`],
    ['keypad mode', `a${ESC}=b`],
  ]

  it.each(stripped)('drops %s', (_name, input) => {
    expect(plain(renderAnsi(input))).toBe('ab')
  })

  it('drops an OSC title terminated by BEL', () => {
    expect(plain(renderAnsi(`a${ESC}]0;my title\u0007b`))).toBe('ab')
  })

  it('drops an OSC terminated by ST', () => {
    expect(plain(renderAnsi(`a${ESC}]8;;https://example.com${ESC}\\b`))).toBe('ab')
  })

  it('drops an unterminated OSC rather than dumping its payload as text', () => {
    // An OSC 8 hyperlink cut mid-frame would otherwise paint a URL into the
    // scrollback that was never meant to be read.
    expect(plain(renderAnsi(`a${ESC}]0;never closed`))).toBe('a')
  })

  it('drops a lone ESC at the end of input', () => {
    expect(plain(renderAnsi(`a${ESC}`))).toBe('a')
  })

  it('drops an unterminated CSI at the end of input', () => {
    // Split across two relay frames, the tail arrives next. Emitting "[3" now
    // would leave it in the scrollback forever.
    expect(plain(renderAnsi(`a${ESC}[3`))).toBe('a')
  })

  it('drops a lone ESC followed by ordinary text', () => {
    expect(plain(renderAnsi(`a${ESC}zb`))).toBe('ab')
  })

  it('keeps a backspace out of the text', () => {
    expect(plain(renderAnsi('a\bb'))).toBe('ab')
  })

  it('keeps tabs and newlines, which the view needs', () => {
    expect(plain(renderAnsi('a\tb\nc'))).toBe('a\tb\nc')
  })
})

describe('size', () => {
  it('handles a megabyte without going quadratic', () => {
    const input = `${ESC}[31mx${ESC}[0my`.repeat(50_000)
    const started = Date.now()
    const out = renderAnsi(input)
    expect(out.length).toBe(100_000)
    expect(Date.now() - started).toBeLessThan(4000)
  })
})

describe('a truncated extended-colour sequence', () => {
  it('clears the background rather than leaving the old one behind', () => {
    // `48;5` with no index left is what a chunk boundary looks like when the
    // scrollback is split mid-sequence. There is no colour to apply, and
    // keeping the previous background would paint the rest of the screen with
    // a colour the terminal had already moved on from.
    const segments = renderAnsi(`${ESC}[41mred bg${ESC}[48;5mafter`)
    expect(texts(segments)).toEqual(['red bg', 'after'])
    expect(segments[0]?.bg).toBeDefined()
    expect(segments[1]?.bg).toBeUndefined()
  })

  it('clears the foreground the same way', () => {
    const segments = renderAnsi(`${ESC}[31mred fg${ESC}[38;2mafter`)
    expect(texts(segments)).toEqual(['red fg', 'after'])
    expect(segments[0]?.fg).toBeDefined()
    expect(segments[1]?.fg).toBeUndefined()
  })
})

describe('the corners of the SGR table', () => {
  it('turns italic back off', () => {
    // 3 on, 23 off. Without the pair, one italicised word italicises the rest of
    // the session -- the desktop only ever sends the reset it expects to work.
    const segs = renderAnsi(`${ESC}[3mslanted${ESC}[23mupright`)
    expect(segs).toEqual([
      { text: 'slanted', italic: true },
      { text: 'upright' },
    ])
  })

  it('paints the eight bright background colours', () => {
    // 100-107. Agents use bright backgrounds for diff highlights, and a missing
    // arm here would silently drop the highlight rather than fail loudly.
    const segs = renderAnsi(`${ESC}[100ma${ESC}[107mb`)
    expect(segs).toEqual([
      { text: 'a', bg: '#666666' },
      { text: 'b', bg: '#ffffff' },
    ])
  })

  it('ignores a truecolour whose components are out of range', () => {
    // A byte over 255 is a bug or a forgery upstream. Clamping it would invent a
    // colour the desktop never sent; dropping it leaves the text readable.
    const segs = renderAnsi(`${ESC}[38;2;300;0;0mstill readable`)
    expect(segs).toEqual([{ text: 'still readable' }])
  })

  it('reads an omitted parameter as a zero', () => {
    // `ESC[;31m` is legal: the empty slot means 0, which is the full reset. The
    // 31 that follows must still apply, so this is not the same as ESC[0m.
    expect(renderAnsi(`${ESC}[;31mred`)).toEqual([{ text: 'red', fg: '#cd3131' }])
  })

  it('drops a charset selector that runs off the end of the input', () => {
    // Output arrives in chunks and a two-byte `ESC (` can be the last thing in
    // one of them. Consuming three bytes there would step past the end and, on
    // the next pass, emit the stray byte as text.
    expect(renderAnsi(`done${ESC}(`)).toEqual([{ text: 'done' }])
  })
})
