import { describe, it, expect } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import {
  appendOutput,
  readOutput,
  readOutputFrom,
  readOutputTail,
  clearOutput,
  replayPreamble,
  MAX_TERMINAL_BUFFER_CHARS,
  REPLAY_SKIP_LIMIT,
  type OutputBuffers,
  type OutputWindow,
} from '../../src/main/terminalOutputBuffer'
import { requestsMouseTracking, disablesMouseTracking, exitsAltScreen } from '../../src/renderer/src/lib/mouseMode'

/** The implementation this module replaced, kept verbatim as the oracle. The refactor's
 *  entire claim is "same tail, far less allocation", so the tail is asserted against the
 *  original code rather than against hand-written expectations. */
function legacyAppend(prev: string, data: string, cap: number): string {
  const updated = prev + data
  return updated.length > cap ? updated.slice(-cap) : updated
}

const invariant = (buffers: OutputBuffers, id: string): void => {
  const win = buffers.get(id)
  if (!win) return
  expect(win.bytes).toBe(win.chunks.reduce((n, c) => n + c.length, 0))
  expect(win.bytes).toBeLessThanOrEqual(MAX_TERMINAL_BUFFER_CHARS)
}

describe('terminalOutputBuffer', () => {
  it('retains everything while under the cap', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'hello ')
    appendOutput(buffers, 't', 'world')
    expect(readOutput(buffers, 't')).toBe('hello world')
    invariant(buffers, 't')
  })

  it('returns empty for a terminal that never produced output', () => {
    expect(readOutput(new Map(), 'missing')).toBe('')
  })

  it('ignores an empty chunk instead of creating a window for it', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', '')
    expect(buffers.has('t')).toBe(false)
    expect(readOutput(buffers, 't')).toBe('')
  })

  it('returns empty for a window a caller seeded with no chunks', () => {
    // The Map is caller-owned by design, so the empty-window guard is reachable.
    const buffers: OutputBuffers = new Map([
      ['t', { chunks: [], bytes: 0, total: 0 } as OutputWindow],
    ])
    expect(readOutput(buffers, 't')).toBe('')
  })

  it('drops whole chunks off the front once the cap is passed', () => {
    const buffers: OutputBuffers = new Map()
    for (const c of ['aaaa', 'bbbb', 'cccc']) appendOutput(buffers, 't', c, 8)
    expect(readOutput(buffers, 't')).toBe('bbbbcccc')
    invariant(buffers, 't')
  })

  it('slices only the chunk that straddles the cap, and only that one', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'abcdef', 8)
    appendOutput(buffers, 't', 'ghij', 8)
    // 10 chars for an 8 cap: 'ab' comes off the head, nothing else is touched.
    expect(buffers.get('t')!.chunks).toEqual(['cdef', 'ghij'])
    expect(readOutput(buffers, 't')).toBe('cdefghij')
    invariant(buffers, 't')
  })

  it('trims a single chunk that alone exceeds the cap', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'abcdefghijkl', 5)
    expect(readOutput(buffers, 't')).toBe('hijkl')
    expect(buffers.get('t')!.chunks).toHaveLength(1)
  })

  it('collapses to one chunk on read so repeated reads are free', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'aa')
    appendOutput(buffers, 't', 'bb')
    expect(buffers.get('t')!.chunks).toHaveLength(2)
    expect(readOutput(buffers, 't')).toBe('aabb')
    expect(buffers.get('t')!.chunks).toEqual(['aabb'])
    expect(readOutput(buffers, 't')).toBe('aabb')
    invariant(buffers, 't')
  })

  it('keeps terminals independent', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 'a', 'first')
    appendOutput(buffers, 'b', 'second')
    expect(readOutput(buffers, 'a')).toBe('first')
    expect(readOutput(buffers, 'b')).toBe('second')
  })

  it('produces a byte-identical tail to the implementation it replaced', () => {
    // Deterministic pseudo-random chunk sizes: the interesting cases are the ones where a
    // chunk lands exactly on, just under and just over the cap boundary.
    let seed = 12345
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (const cap of [1, 7, 64, 1000]) {
      const buffers: OutputBuffers = new Map()
      let legacy = ''
      for (let i = 0; i < 400; i++) {
        const chunk = String.fromCharCode(97 + (i % 26)).repeat(next(cap * 2) + 1)
        appendOutput(buffers, 't', chunk, cap)
        legacy = legacyAppend(legacy, chunk, cap)
        expect(readOutput(buffers, 't')).toBe(legacy)
      }
    }
  })

  it('holds the real cap at exactly 32768 chars', () => {
    const buffers: OutputBuffers = new Map()
    for (let i = 0; i < 500; i++) appendOutput(buffers, 't', 'x'.repeat(200))
    expect(readOutput(buffers, 't')).toHaveLength(MAX_TERMINAL_BUFFER_CHARS)
    expect(MAX_TERMINAL_BUFFER_CHARS).toBe(32768)
    invariant(buffers, 't')
  })
})

describe('readOutputTail', () => {
  const seed = (): OutputBuffers => {
    const buffers: OutputBuffers = new Map()
    for (let i = 1; i <= 10; i++) appendOutput(buffers, 't', `line${i}\n`)
    return buffers
  }

  it('returns the last N lines', () => {
    expect(readOutputTail(seed(), 't', 3)).toBe('line9\nline10\n')
  })

  it('clamps a request for more lines than exist', () => {
    expect(readOutputTail(seed(), 't', 999)).toBe(readOutput(seed(), 't'))
  })

  it.each([
    ['zero', 0, 50],
    ['NaN', Number.NaN, 50],
    ['fractional', 3.9, 3],
  ])('coerces a %s line count to %i', (_label, given, effective) => {
    const buffers = seed()
    const expected = readOutput(seed(), 't').split('\n').slice(-effective).join('\n')
    expect(readOutputTail(buffers, 't', given)).toBe(expected)
  })

  it('clamps a negative line count up to one line, never to the whole window', () => {
    expect(readOutputTail(seed(), 't', -5)).toBe('')
  })

  it('caps a huge line count at 1000 lines', () => {
    const buffers: OutputBuffers = new Map()
    for (let i = 0; i < 2000; i++) appendOutput(buffers, 't', 'y\n', 10_000_000)
    expect(readOutputTail(buffers, 't', 1e9).split('\n')).toHaveLength(1000)
  })

  it('returns empty for an unknown terminal', () => {
    expect(readOutputTail(new Map(), 'nope', 10)).toBe('')
  })
})
describe('readOutputFrom — absolute stream offsets', () => {
  it('returns everything from offset 0 and reports where the stream now ends', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'hello ')
    appendOutput(buffers, 't', 'world')
    expect(readOutputFrom(buffers, 't', 0)).toEqual({
      output: 'hello world',
      nextOffset: 11,
      missed: 0,
    })
  })

  it('returns only what is new since the caller last read', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'aaa')
    const first = readOutputFrom(buffers, 't', 0)
    appendOutput(buffers, 't', 'bbb')
    expect(readOutputFrom(buffers, 't', first.nextOffset)).toEqual({
      output: 'bbb',
      nextOffset: 6,
      missed: 0,
    })
  })

  it('returns nothing when nothing has been appended since the last read', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'aaa')
    const first = readOutputFrom(buffers, 't', 0)
    expect(readOutputFrom(buffers, 't', first.nextOffset).output).toBe('')
  })

  it('keeps a polling caller whole across many evictions — the actual bug', () => {
    // The old code added `length` to its own offset and sliced the WINDOW with it, so once
    // 32 KB had gone by the offset was past the window's end and every later read returned
    // ''. Here the poller is always ahead of the cap and must still see every char.
    const buffers: OutputBuffers = new Map()
    const cap = 16
    let offset = 0
    let seen = ''
    for (let i = 0; i < 200; i++) {
      appendOutput(buffers, 't', `${i % 10}`.repeat(3), cap)
      const slice = readOutputFrom(buffers, 't', offset)
      expect(slice.missed).toBe(0)
      seen += slice.output
      offset = slice.nextOffset
    }
    let expected = ''
    for (let i = 0; i < 200; i++) expected += `${i % 10}`.repeat(3)
    expect(seen).toBe(expected)
  })

  it('reports how much was evicted when the caller falls behind, and resumes from the oldest surviving char', () => {
    const buffers: OutputBuffers = new Map()
    for (const c of ['aaaa', 'bbbb', 'cccc']) appendOutput(buffers, 't', c, 8)
    // 12 chars produced, 8 retained: a caller still at 0 lost the first 4.
    expect(readOutputFrom(buffers, 't', 0)).toEqual({
      output: 'bbbbcccc',
      nextOffset: 12,
      missed: 4,
    })
  })

  it('clamps an offset that is ahead of the stream instead of returning garbage', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'abc')
    expect(readOutputFrom(buffers, 't', 999)).toEqual({ output: '', nextOffset: 3, missed: 0 })
  })

  it.each([
    ['a negative offset', -50],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('survives %s', (_label, given) => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'abc')
    const slice = readOutputFrom(buffers, 't', given)
    expect(slice.nextOffset).toBe(3)
    expect(slice.output.length).toBeLessThanOrEqual(3)
  })

  it('truncates a fractional offset rather than slicing at a fraction', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'abcdef')
    expect(readOutputFrom(buffers, 't', 2.9).output).toBe('cdef')
  })

  it('defaults to reading the whole stream when no offset is given', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'abc')
    expect(readOutputFrom(buffers, 't').output).toBe('abc')
  })

  it('returns an empty slice for a terminal that never produced output', () => {
    expect(readOutputFrom(new Map(), 'missing', 5)).toEqual({
      output: '',
      nextOffset: 0,
      missed: 0,
    })
  })

  it('counts total independently per terminal', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 'a', 'aaaaa')
    appendOutput(buffers, 'b', 'bb')
    expect(readOutputFrom(buffers, 'a').nextOffset).toBe(5)
    expect(readOutputFrom(buffers, 'b').nextOffset).toBe(2)
  })

  it('keeps counting total after eviction, so offsets never rewind', () => {
    const buffers: OutputBuffers = new Map()
    for (let i = 0; i < 50; i++) appendOutput(buffers, 't', 'xxxx', 8)
    const win = buffers.get('t')!
    expect(win.total).toBe(200)
    expect(win.bytes).toBe(8)
  })

  it.each([
    ['a negative offset', -50],
    ['a non-numeric offset', Number.NaN],
  ])('treats %s as the start of the stream', (_label, given) => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'abcdefghij', 4)
    const slice = readOutputFrom(buffers, 't', given)
    expect(slice.output).toBe('ghij')
    // 6 chars were evicted — not 56, which is what an unclamped negative offset would claim.
    expect(slice.missed).toBe(6)
    expect(slice.nextOffset).toBe(10)
  })
})

describe('clearOutput — dropping the window without rewinding the stream', () => {
  /** 11 + 12 = 23 chars of stream, in two chunks, so the clear has something real to drop. */
  const seeded = (): OutputBuffers => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', 'first line\n')
    appendOutput(buffers, 't', 'second line\n')
    return buffers
  }

  it('empties the retained window', () => {
    const buffers = seeded()
    clearOutput(buffers, 't')
    expect(readOutput(buffers, 't')).toBe('')
    expect(buffers.get('t')!.bytes).toBe(0)
    expect(buffers.get('t')!.chunks).toEqual([])
    invariant(buffers, 't')
  })

  it('leaves total alone, because every live offset is a position in it', () => {
    // The swarm bridge, the MCP readers and the phone's output pump each hold an ABSOLUTE
    // offset. Zeroing total here would make all three see the stream jump backwards, which
    // reads to them as a restarted terminal reusing an id — and they re-emit old output.
    const buffers = seeded()
    expect(buffers.get('t')!.total).toBe(23)
    clearOutput(buffers, 't')
    expect(buffers.get('t')!.total).toBe(23)
  })

  it('clamps a pre-clear offset forward instead of replaying the cleared transcript', () => {
    const buffers = seeded()
    expect(readOutputFrom(buffers, 't', 0).output).toBe('first line\nsecond line\n')
    clearOutput(buffers, 't')
    // Because total survives, `dropped` is now the WHOLE stream, so an offset from before
    // the clear resolves to the (empty) end rather than to the start of a shrunken window.
    expect(readOutputFrom(buffers, 't', 0)).toEqual({
      output: '',
      nextOffset: 23,
      missed: 23,
    })
  })

  it('does not rewind a caught-up poller: its offset is still the end of the stream', () => {
    const buffers = seeded()
    const caughtUp = readOutputFrom(buffers, 't', 0).nextOffset
    clearOutput(buffers, 't')
    const after = readOutputFrom(buffers, 't', caughtUp)
    // Nothing was lost from this caller's point of view — it had already consumed all 23
    // chars — so the clear must not manufacture a `missed` gap for it either.
    expect(after).toEqual({ output: '', nextOffset: caughtUp, missed: 0 })
  })

  it('resumes cleanly: a poller holding its post-clear offset sees only the new output', () => {
    const buffers = seeded()
    clearOutput(buffers, 't')
    // The offset handed back by the first poll after the clear — the one the caller echoes.
    const resumeAt = readOutputFrom(buffers, 't', 0).nextOffset
    appendOutput(buffers, 't', 'after the clear\n')
    expect(readOutputFrom(buffers, 't', resumeAt)).toEqual({
      output: 'after the clear\n',
      nextOffset: 39,
      missed: 0,
    })
    invariant(buffers, 't')
  })

  it('tells a stale poller it lost the cleared chars rather than resuming silently', () => {
    // A caller that was mid-window when the user hit clear must not get the cleared
    // transcript back, but it should still learn that a gap happened.
    const buffers = seeded()
    clearOutput(buffers, 't')
    appendOutput(buffers, 't', 'fresh')
    const slice = readOutputFrom(buffers, 't', 5)
    expect(slice.output).toBe('fresh')
    expect(slice.missed).toBe(18) // the 23 cleared chars, less the 5 this caller had read
    expect(slice.nextOffset).toBe(28)
  })

  it('keeps appending — and evicting — normally after a clear', () => {
    const buffers: OutputBuffers = new Map()
    for (const c of ['aaaa', 'bbbb', 'cccc']) appendOutput(buffers, 't', c, 8)
    clearOutput(buffers, 't')
    for (const c of ['dddd', 'eeee', 'ffff']) appendOutput(buffers, 't', c, 8)
    const win = buffers.get('t')!
    expect(readOutput(buffers, 't')).toBe('eeeeffff')
    expect(win.bytes).toBe(8)
    expect(win.total).toBe(24)
    invariant(buffers, 't')
    // 16 unreachable chars: the 12 the clear dropped plus the 4 the cap then evicted. The
    // clear leaves the window in exactly the state normal eviction would have produced.
    expect(readOutputFrom(buffers, 't', 0)).toEqual({
      output: 'eeeeffff',
      nextOffset: 24,
      missed: 16,
    })
  })

  it('is a no-op for a terminal that has no window, and does not create one', () => {
    // The clear path fires for whatever pane is focused, including one that has not
    // printed anything yet; creating a window here would leak an entry per clear.
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 'other', 'x')
    clearOutput(buffers, 'never-spoke')
    expect(buffers.size).toBe(1)
    expect(buffers.has('never-spoke')).toBe(false)
    expect(readOutput(buffers, 'other')).toBe('x')
  })

  it('is a no-op on an empty map', () => {
    const buffers: OutputBuffers = new Map()
    clearOutput(buffers, 't')
    expect(buffers.size).toBe(0)
  })

  it('is idempotent — repeat clears change nothing, total included', () => {
    const buffers = seeded()
    clearOutput(buffers, 't')
    clearOutput(buffers, 't')
    clearOutput(buffers, 't')
    expect(buffers.get('t')).toEqual({ chunks: [], bytes: 0, total: 23 })
    expect(readOutputFrom(buffers, 't', 0).nextOffset).toBe(23)
    invariant(buffers, 't')
  })

  it('clears only the terminal it was asked to clear', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 'a', 'keep me')
    appendOutput(buffers, 'b', 'wipe me')
    clearOutput(buffers, 'b')
    expect(readOutput(buffers, 'a')).toBe('keep me')
    expect(readOutput(buffers, 'b')).toBe('')
    expect(buffers.get('a')!.total).toBe(7)
    expect(buffers.size).toBe(2)
  })

  it('leaves readOutputTail with nothing to return', () => {
    const buffers: OutputBuffers = new Map()
    for (let i = 1; i <= 10; i++) appendOutput(buffers, 't', `line${i}\n`)
    expect(readOutputTail(buffers, 't', 3)).toBe('line9\nline10\n')
    clearOutput(buffers, 't')
    expect(readOutputTail(buffers, 't', 3)).toBe('')
    expect(readOutputTail(buffers, 't', 1000)).toBe('')
  })

  it('gives readOutputTail the post-clear lines and none of the old scrollback', () => {
    // TerminalPane replays this window into a fresh xterm on every mount, so anything the
    // clear left behind would reappear on the next tab switch or split re-layout.
    const buffers: OutputBuffers = new Map()
    for (let i = 1; i <= 10; i++) appendOutput(buffers, 't', `line${i}\n`)
    clearOutput(buffers, 't')
    appendOutput(buffers, 't', 'fresh1\nfresh2\n')
    expect(readOutputTail(buffers, 't', 50)).toBe('fresh1\nfresh2\n')
    invariant(buffers, 't')
  })
})

describe('appendOutput — the stream position it returns', () => {
  it('returns where the stream ends after the chunk, so the sender can tag the chunk with it', () => {
    const buffers: OutputBuffers = new Map()
    expect(appendOutput(buffers, 't', 'abc')).toBe(3)
    expect(appendOutput(buffers, 't', 'de', 4)).toBe(5) // eviction does not rewind it
    expect(readOutputFrom(buffers, 't', 0).nextOffset).toBe(5)
  })

  it('returns the unchanged position for an empty chunk, and 0 for a terminal that never spoke', () => {
    const buffers: OutputBuffers = new Map()
    expect(appendOutput(buffers, 'silent', '')).toBe(0)
    appendOutput(buffers, 't', 'abc')
    expect(appendOutput(buffers, 't', '')).toBe(3)
  })
})

// ===========================================================================
// replayPreamble — the terminal modes that evicted output left behind.
//
// TerminalPane rebuilds a terminal from this window on every mount. An agent sets the alternate
// screen, mouse tracking and bracketed paste ONCE, so a long session's 32 KB tail no longer holds
// them, and the rebuilt pane landed on the wrong buffer with the wheel dead (issue #35).
// ===========================================================================
const E = '\x1b'
/** What Claude Code 2.1.296's fullscreen renderer sends at startup: alt screen, focus, bracketed
 *  paste, then the "full" mouse modes (?1000h ?1002h ?1003h ?1006h), cursor hidden, clear. */
const AGENT_STARTUP = `${E}[?1049h${E}[?1004h${E}[?2004h${E}[?1000h${E}[?1002h${E}[?1003h${E}[?1006h${E}[?25l${E}[2J${E}[H`
const AGENT_EXIT = `${E}[?1006l${E}[?1003l${E}[?1002l${E}[?1000l${E}[?2004l${E}[?1004l${E}[?1049l${E}[?25h`

/** Buffer `stream` into a fresh window in fixed-size chunks (so chunk edges fall mid-sequence). */
const buffered = (stream: string, cap: number, chunk = stream.length): OutputBuffers => {
  const buffers: OutputBuffers = new Map()
  for (let i = 0; i < stream.length; i += chunk) appendOutput(buffers, 't', stream.slice(i, i + chunk), cap)
  return buffers
}

describe('replayPreamble — modes the evicted output left set', () => {
  it('is null for a terminal with no window', () => {
    expect(replayPreamble(new Map(), 'nope')).toBeNull()
  })

  it('is empty while nothing has been evicted — the window still carries its own modes', () => {
    const buffers = buffered(`${E}[?1049h${E}[?2004hhello`, 1000)
    expect(replayPreamble(buffers, 't')).toEqual({ preamble: '', skip: 0 })
  })

  it("restores an agent's startup modes, in order, once they have been evicted", () => {
    const buffers = buffered(AGENT_STARTUP + 'F'.repeat(64), 64, AGENT_STARTUP.length)
    expect(readOutput(buffers, 't')).toBe('F'.repeat(64)) // the startup is gone from the window
    expect(replayPreamble(buffers, 't')).toEqual({
      preamble: `${E}[?1049h${E}[?1004h${E}[?2004h${E}[?1000h${E}[?1002h${E}[?1003h${E}[?1006h${E}[?25l`,
      skip: 0,
    })
  })

  it('keeps resets too, so an exit that was itself evicted is replayed as an exit', () => {
    const buffers = buffered(AGENT_STARTUP + AGENT_EXIT + 'x'.repeat(16), 16, 8)
    // Each mode's LATEST setting, in the order those settings were made — plus the `?9l` each
    // tracker reset left on xterm's protocol and the `?1001l` the alt-screen exit left on the
    // latch (see the next test). On a fresh terminal every one of these resets is a no-op.
    expect(replayPreamble(buffers, 't')!.preamble).toBe(
      `${E}[?1006l${E}[?1003l${E}[?1002l${E}[?1000l${E}[?9l${E}[?2004l${E}[?1004l${E}[?1049l${E}[?1001l${E}[?25h`,
    )
  })

  it('records what an alt-screen exit and a tracker reset did, as settings a replay can repeat', () => {
    // An alt-screen exit clears TerminalPane's wheel latch but not xterm's mouse protocol, and a
    // 1000/1002/1003 reset clears xterm's protocol (X10's too) — effects "latest setting per mode"
    // loses once a later setting of the same mode lands. Each is recorded as a reset that has
    // exactly that one effect: `?1001l` clears the latch and xterm ignores it (xterm.js has no
    // highlight tracking); `?9l` clears xterm's protocol and the latch ignores it (X10 is not a
    // mode TerminalPane swallows).
    const crashed = buffered(`${E}[?1049h${E}[?1000h${E}[?1006h${E}[?1049l${E}[?1049h` + 'x'.repeat(8), 8)
    expect(replayPreamble(crashed, 't')!.preamble).toBe(`${E}[?1000h${E}[?1006h${E}[?1001l${E}[?1049h`)
    // Re-enabled after the exit, the tracker is replayed after the latch clear, so it wins again.
    const again = buffered(`${E}[?1000h${E}[?1049l${E}[?1000h` + 'x'.repeat(8), 8)
    expect(replayPreamble(again, 't')!.preamble).toBe(`${E}[?1049l${E}[?1001l${E}[?1000h`)
    // X10 ended by a tracker reset stays ended, even after the tracker is swallowed back on.
    const x10 = buffered(`${E}[?9h${E}[?1000l${E}[?1000h` + 'x'.repeat(8), 8)
    expect(replayPreamble(x10, 't')!.preamble).toBe(`${E}[?9l${E}[?1000h`)
  })

  it('replays settings in the order they were last made, so the last one still wins', () => {
    // xterm keeps ONE mouse encoding: 1006 -> 1016 -> 1006 must end on 1006, not 1016.
    const buffers = buffered(`${E}[?1006h${E}[?1016h${E}[?1006h` + 'x'.repeat(8), 8)
    expect(replayPreamble(buffers, 't')!.preamble).toBe(`${E}[?1016h${E}[?1006h`)
  })

  it('reads every mode of a combined DECSET, and skips modes it does not replay', () => {
    const buffers = buffered(`${E}[?1049;12;2004h` + 'x'.repeat(8), 8)
    expect(replayPreamble(buffers, 't')!.preamble).toBe(`${E}[?1049h${E}[?2004h`)
  })

  it('never replays synchronized output — it is frame-scoped, not a mode an app leaves on', () => {
    const buffers = buffered(`${E}[?2026h${E}[?1049h${E}[?2026l${E}[?2026h` + 'x'.repeat(8), 8)
    expect(replayPreamble(buffers, 't')!.preamble).toBe(`${E}[?1049h`)
  })

  it('tracks the keypad mode from DECKPAM/DECKPNM and DECNKM (?66) as one setting', () => {
    expect(replayPreamble(buffered(`${E}=` + 'x'.repeat(8), 8), 't')!.preamble).toBe(`${E}=`)
    expect(replayPreamble(buffered(`${E}=${E}>` + 'x'.repeat(8), 8), 't')!.preamble).toBe(`${E}>`)
    expect(replayPreamble(buffered(`${E}=${E}[?66l` + 'x'.repeat(8), 8), 't')!.preamble).toBe(`${E}>`)
    expect(replayPreamble(buffered(`${E}[?66h` + 'x'.repeat(8), 8), 't')!.preamble).toBe(`${E}=`)
  })

  it('treats RIS (ESC c) as a full reset of everything before it', () => {
    const buffers = buffered(`${E}[?1049h${E}[?2004h${E}c${E}[?1h` + 'x'.repeat(8), 8)
    expect(replayPreamble(buffers, 't')!.preamble).toBe(`${E}[?1h`)
  })

  it('treats DECSTR (CSI ! p) as the soft reset xterm does: keypad/cursor/paste modes go, the screen and mouse stay', () => {
    const before = `${E}[?1049h${E}[?1000h${E}[?2004h${E}[?1h${E}[?7l${E}[?25l${E}[?1004h${E}=`
    const buffers = buffered(before + `${E}[!p` + 'x'.repeat(8), 8)
    expect(replayPreamble(buffers, 't')!.preamble).toBe(`${E}[?1049h${E}[?1000h`)
  })

  it('does not mistake other CSI sequences for mode changes', () => {
    // DECRQM (`$p`) is a mode QUERY, ANSI SM (`4h`) is not a private mode, `?h` names no mode,
    // `?1049m` has the wrong final byte, and SGR/cursor moves change nothing replayable.
    const noise = `${E}[?1049$p${E}[4h${E}[?h${E}[?1049m${E}[38;2;1;2;3m${E}[12;1H${E}[?;h`
    expect(replayPreamble(buffered(noise + 'x'.repeat(8), 8), 't')!.preamble).toBe('')
  })

  it('ignores an implausibly long CSI body, and parses the sequence after it normally', () => {
    const overlong = `${E}[?${'1'.repeat(200)}h`
    const buffers = buffered(overlong + `${E}[?2004h` + 'x'.repeat(8), 8, 50)
    expect(replayPreamble(buffers, 't')!.preamble).toBe(`${E}[?2004h`)
  })

  it('reads no more parameters than xterm does (32), so it cannot set a mode xterm never set', async () => {
    // A 33rd parameter is dropped by xterm's parser — check the real thing, then the tracker.
    const longList = `${E}[?${'12;'.repeat(32)}2004h`
    const xterm = new HeadlessTerminal({ cols: 40, rows: 5, allowProposedApi: true })
    await new Promise<void>((resolve) => xterm.write(longList, resolve))
    expect(xterm.modes.bracketedPasteMode).toBe(false)
    expect(replayPreamble(buffered(longList + 'x'.repeat(8), 8), 't')!.preamble).toBe('')
  })

  it('recovers the way xterm does when a sequence is interrupted', () => {
    const cases: Array<[string, string]> = [
      [`${E}[?10${E}[?2004h`, `${E}[?2004h`], // ESC abandons the CSI and starts a new one
      [`${E}[?1049\x18${E}[?1h`, `${E}[?1h`], // CAN cancels it
      [`${E}[?1049\x1a`, ''], // and so does SUB
      [`${E}[?10\r49h`, `${E}[?1049h`], // a C0 control inside is executed; the CSI carries on
      [`${E}[?10\x7f49h`, `${E}[?1049h`], // DEL inside is ignored
      [`${E}[?10\u00e949h`, ''], // a non-ASCII char ends it unrecognized
      [`${E}${E}[?1049h`, `${E}[?1049h`], // ESC ESC: the second one starts the sequence
      [`${E}\x18${E}[?1h`, `${E}[?1h`], // ESC then CAN: back to ground
      [`${E}\x1a${E}[?1h`, `${E}[?1h`], // ...or SUB
      [`${E}\r=`, `${E}=`], // a C0 between ESC and its final is executed, ESC = still lands
      [`${E}\x7f=`, `${E}=`], // DEL there is ignored
      [`${E}(0${E}[?1h`, `${E}[?1h`], // a charset designation is its own 3-byte sequence
      [`${E}( ${E}[?1h`, `${E}[?1h`], // ...even with several intermediates
      [`${E}(${E}[?1h`, `${E}[?1h`], // ESC inside one starts a new sequence
      [`${E}(\x18${E}[?1h`, `${E}[?1h`], // CAN cancels it
      [`${E}(\x1a${E}[?1h`, `${E}[?1h`], // ...and so does SUB
      [`${E}(\r0${E}[?1h`, `${E}[?1h`], // a C0 inside it is executed
      [`${E}7${E}[?1h`, `${E}[?1h`], // DECSC and other 2-byte escapes change nothing
      [`${E}[?1000:1h`, `${E}[?1000h`], // a sub-parameter: the leading value still names the mode
      [`${E}[?1000:1;2004h`, `${E}[?1000h${E}[?2004h`], // ...and the next parameter starts fresh
      [`${E}[?<1049h`, ''], // a second private marker: not a plain DECSET
      [`${E}[!!p${E}[?1h`, `${E}[?1h`], // `!!p` is not DECSTR
    ]
    for (const [stream, preamble] of cases) {
      expect(replayPreamble(buffered(stream + 'x'.repeat(8), 8), 't')!.preamble, JSON.stringify(stream)).toBe(preamble)
    }
  })

  it('looks straight through OSC and DCS payloads, whatever they contain', () => {
    // A title with `=` and `c` in it, a BEL-terminated title, a DCS with a fake DECSET inside
    // its payload (no ESC, so it is data), CAN aborting a string, and an ESC aborting a title.
    const strings =
      `${E}]0;a=b c${E}\\` +
      `${E}]2;title\x07` +
      `${E}Pq[?1049h${E}\\` +
      `${E}]0;dropped\x18` +
      `${E}]0;dropped\x1a` +
      `${E}Pq[?1049h\x18` +
      `${E}_app\x1a` +
      `${E}^pm\x07still the string${E}\\` + // BEL does not end a PM/APC/DCS string, only an OSC
      `${E}]0;cut short${E}[?2004h`
    expect(replayPreamble(buffered(strings + 'x'.repeat(8), 8), 't')!.preamble).toBe(`${E}[?2004h`)
  })
})

describe('replayPreamble — sequences cut by a chunk edge or by the eviction itself', () => {
  it('sees a DECSET that arrived split across two PTY chunks', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', `${E}[?10`, 8)
    appendOutput(buffers, 't', '49h', 8)
    appendOutput(buffers, 't', 'ZZZZZZZZ', 8)
    expect(readOutput(buffers, 't')).toBe('ZZZZZZZZ')
    expect(replayPreamble(buffers, 't')).toEqual({ preamble: `${E}[?1049h`, skip: 0 })
  })

  it('finishes a DECSET the eviction cut in half, and tells the replay how much of the window to skip', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', `AB${E}[?1049h`, 10)
    appendOutput(buffers, 't', 'CDEFG', 10)
    // 15 chars for a cap of 10: `AB\x1b[?` was evicted, the window opens on the rest of it.
    expect(readOutput(buffers, 't')).toBe('1049hCDEFG')
    expect(replayPreamble(buffers, 't')).toEqual({ preamble: `${E}[?1049h`, skip: 5 })
  })

  it('skips the rest of an OSC title the eviction cut into', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', `X${E}]0;my title\x07`, 10)
    expect(readOutput(buffers, 't')).toBe(';my title\x07')
    expect(replayPreamble(buffers, 't')).toEqual({ preamble: '', skip: 10 })
  })

  it('skips the rest of a DCS string that ends with ST', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', `${E}Pqpayload${E}\\after`, 12)
    expect(readOutput(buffers, 't')).toBe(`yload${E}\\after`)
    expect(replayPreamble(buffers, 't')).toEqual({ preamble: '', skip: 7 })
  })

  it('finishes a sequence whose ESC was the last evicted char', () => {
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', `abc${E}`, 7)
    appendOutput(buffers, 't', 'cdefghi', 7) // `abc\x1b` evicted; the window opens on `c` = RIS
    expect(readOutput(buffers, 't')).toBe('cdefghi')
    expect(replayPreamble(buffers, 't')).toEqual({ preamble: '', skip: 1 })
  })

  it('gives up on a skip it cannot finish inside the window or the probe limit', () => {
    // The whole window is the inside of one unterminated title: skipping it would replay nothing.
    const open = buffered(`${E}]0;` + 'x'.repeat(40), 16)
    expect(replayPreamble(open, 't')).toEqual({ preamble: '', skip: 0 })
    // A title that does end, but further in than the probe looks.
    const far = buffered(`${E}]0;` + 'y'.repeat(REPLAY_SKIP_LIMIT + 10) + '\x07tail', REPLAY_SKIP_LIMIT + 8, 1)
    expect(replayPreamble(far, 't')).toEqual({ preamble: '', skip: 0 })
  })

  it('completes a half-evicted sequence on a copy, so reading the window never changes it', () => {
    // The probe works on a copy: the real tracker only learns `?2004h` when the rest is evicted.
    // A probe that advanced the real tracker would answer skip 0 on the second read, and the
    // replay would print `2004h` as text.
    const buffers: OutputBuffers = new Map()
    appendOutput(buffers, 't', `AB${E}[?2004h`, 10)
    appendOutput(buffers, 't', 'CDEFG', 10)
    expect(replayPreamble(buffers, 't')).toEqual({ preamble: `${E}[?2004h`, skip: 5 })
    expect(replayPreamble(buffers, 't')).toEqual({ preamble: `${E}[?2004h`, skip: 5 })
    appendOutput(buffers, 't', 'HIJKLMNOPQ', 10) // now the rest is evicted for real
    expect(replayPreamble(buffers, 't')).toEqual({ preamble: `${E}[?2004h`, skip: 0 })
  })
})

describe('replayPreamble — reads, clears and the shape of the window', () => {
  it('only describes a read that starts at the start of the window', () => {
    const buffers = buffered(AGENT_STARTUP + 'x'.repeat(40), 32)
    expect(replayPreamble(buffers, 't', 0)).not.toBeNull()
    expect(replayPreamble(buffers, 't')).not.toBeNull() // default offset: from the start
    expect(replayPreamble(buffers, 't', Number.NaN)).not.toBeNull() // garbage reads as the start, as in readOutputFrom
    // A poller reading forward from its own offset is not replaying anything.
    expect(replayPreamble(buffers, 't', readOutputFrom(buffers, 't').nextOffset - 4)).toBeNull()
  })

  it('folds a cleared window into the replayed modes, so a clear does not forget the agent is still fullscreen', () => {
    const buffers = buffered(AGENT_STARTUP + 'frame', 1000)
    clearOutput(buffers, 't')
    expect(readOutput(buffers, 't')).toBe('')
    expect(replayPreamble(buffers, 't')!.preamble).toContain(`${E}[?1049h`)
    expect(replayPreamble(buffers, 't')!.preamble).toContain(`${E}[?2004h`)
  })

  it('finishes, after a clear, a sequence the clear cut in half', () => {
    const buffers = buffered(`${E}[?10`, 1000)
    clearOutput(buffers, 't')
    appendOutput(buffers, 't', '49hframe')
    expect(replayPreamble(buffers, 't')).toEqual({ preamble: `${E}[?1049h`, skip: 3 })
  })

  it('adds nothing to a window whose evicted output never held an escape sequence', () => {
    const buffers = buffered('plain text '.repeat(10), 16)
    expect(replayPreamble(buffers, 't')).toEqual({ preamble: '', skip: 0 })
    // ...and a cleared plain window keeps exactly the shape it had before this feature.
    const plain: OutputBuffers = new Map()
    appendOutput(plain, 't', 'first line\n')
    clearOutput(plain, 't')
    expect(plain.get('t')).toEqual({ chunks: [], bytes: 0, total: 11 })
  })
})

// ===========================================================================
// The whole point, end to end with a REAL parser: a fresh xterm that parses
// `preamble + window.slice(skip)` lands in the state the live terminal is in.
// ===========================================================================
describe('replayPreamble — a fresh xterm replaying the window matches the live one', () => {
  /** TerminalPane's wheel-forwarding latch, wired exactly as TerminalPane wires it: set by a
   *  mouse-tracking DECSET (which it swallows), cleared by a tracking reset or an alt-screen exit. */
  const withLatch = (term: HeadlessTerminal, appMouseControl = false): { wheelToApp: boolean } => {
    const latch = { wheelToApp: false }
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      // Settings > "let apps control the mouse": TerminalPane lets every DECSET through to
      // xterm untouched, so the trackers drive xterm's own mouse protocol and no latch is set.
      if (appMouseControl) return false
      if (!requestsMouseTracking(params)) return false
      latch.wheelToApp = true
      return true
    })
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (disablesMouseTracking(params) || exitsAltScreen(params)) latch.wheelToApp = false
      return false
    })
    return latch
  }
  const fresh = (): HeadlessTerminal =>
    new HeadlessTerminal({ cols: 120, rows: 30, scrollback: 1000, allowProposedApi: true })
  const parse = (term: HeadlessTerminal, data: string): Promise<void> =>
    new Promise((resolve) => term.write(data, resolve))
  const viewport = (term: HeadlessTerminal): string[] => {
    const b = term.buffer.active
    const rows: string[] = []
    for (let y = b.baseY; y < b.baseY + term.rows; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '')
    return rows
  }
  /** One full-screen agent frame: 26 transcript rows by absolute position, then the input row. */
  const frame = (n: number): string => {
    let f = `${E}[?2026h`
    for (let r = 1; r <= 26; r++) {
      f += `${E}[${r};1H${E}[38;2;220;220;220mresponse ${String(n * 2 + r).padStart(5, '0')} ${'lorem ipsum '.repeat(4)}${E}[0m${E}[K`
    }
    return f + `${E}[29;1H> ${E}[K${E}[?2026l`
  }
  const frames = (count: number): string => Array.from({ length: count }, (_, n) => frame(n)).join('')

  const compare = async (stream: string, chunk: number) => {
    const live = fresh()
    const liveLatch = withLatch(live)
    await parse(live, stream)

    const buffers = buffered(stream, MAX_TERMINAL_BUFFER_CHARS, chunk)
    const { preamble, skip } = replayPreamble(buffers, 't')!
    const replayed = fresh()
    const replayedLatch = withLatch(replayed)
    await parse(replayed, preamble + readOutput(buffers, 't').slice(skip))
    return { live, liveLatch, replayed, replayedLatch, preamble, skip }
  }

  it('an agent still running fullscreen: alt screen, wheel latch, bracketed paste and focus all come back', async () => {
    // 997-char chunks put chunk edges, and the eviction edge, in the middle of sequences.
    const r = await compare(AGENT_STARTUP + frames(120), 997)
    expect(r.preamble).toContain(`${E}[?1049h`)
    expect(r.replayed.buffer.active.type).toBe('alternate')
    expect(r.replayedLatch.wheelToApp).toBe(true)
    expect(r.replayed.modes.bracketedPasteMode).toBe(true) // term.paste() still brackets
    expect(r.replayed.modes.sendFocusMode).toBe(true)
    // ...and the state matches the live terminal's exactly, screen included.
    expect(r.replayed.buffer.active.type).toBe(r.live.buffer.active.type)
    expect(r.replayedLatch.wheelToApp).toBe(r.liveLatch.wheelToApp)
    expect(r.replayed.modes).toEqual(r.live.modes)
    expect(viewport(r.replayed)).toEqual(viewport(r.live))
  })

  it('an agent that exited inside the window: back on the normal screen, wheel to scrollback', async () => {
    const r = await compare(AGENT_STARTUP + frames(120) + AGENT_EXIT + 'PS C:\\proj> ', 997)
    expect(r.live.buffer.active.type).toBe('normal')
    expect(r.replayed.buffer.active.type).toBe('normal')
    expect(r.replayedLatch.wheelToApp).toBe(false)
    expect(r.replayed.modes.bracketedPasteMode).toBe(false)
    expect(r.replayed.modes).toEqual(r.live.modes)
    expect(viewport(r.replayed)).toEqual(viewport(r.live))
  })

  it("a mouse app that crashed out of the alt screen does not hand the next alt-screen app its wheel", async () => {
    // No tracking reset on the way out. TerminalPane clears its wheel latch on the alt-screen
    // EXIT instead, so the pager opened next scrolls normally rather than receiving SGR wheel
    // reports it cannot parse — and a replay must not undo that by replaying the stale `?1000h`.
    const crashed =
      `${E}[?1049h${E}[?1000h${E}[?1006h` + frames(40) + `${E}[?1049l` + 'PS C:\\proj> less build.log\r\n' +
      `${E}[?1049h` + 'log line\r\n'.repeat(4000)
    const r = await compare(crashed, 1000)
    expect(r.liveLatch.wheelToApp).toBe(false)
    expect(r.replayedLatch.wheelToApp).toBe(false)
    expect(r.replayed.buffer.active.type).toBe('alternate')
    expect(r.replayed.modes).toEqual(r.live.modes)
  })

  it('agrees with the real parser on every tricky stream once it is fully evicted', async () => {
    // Differential check: run each stream through xterm itself, then evict it completely and
    // rebuild from the preamble alone. The tracked state must come out identical.
    const C1 = { CSI: '\u009b', OSC: '\u009d', DCS: '\u0090', PM: '\u009e', ST: '\u009c', NEL: '\u0085' }
    const streams = [
      AGENT_STARTUP,
      AGENT_STARTUP + AGENT_EXIT,
      `${E}[?1;2004h${E}=${E}[?1004h${E}[?7l`,
      `${E}[?1049h${E}[?2004h${E}[!p`, // soft reset keeps the screen, drops the paste mode
      `${E}[?1049h${E}[?2004h${E}c${E}[?1h`, // full reset drops everything before it
      `${E}[?9h${E}[?1006h${E}[?1016h`, // X10 mouse reaches xterm; encodings: the last one wins
      `${E}[?1000h${E}[?1049h${E}[?1049l${E}[?1049h`, // the latch is cleared by the exit in between
      `${E}[?1049h${E}[?1002h${E}[?1002l`,
      `${C1.CSI}?1049h${C1.CSI}?2004h`, // 8-bit CSI is a CSI to xterm
      `${C1.OSC}0;title${C1.ST}${C1.CSI}?1h`, // 8-bit OSC, ended by 8-bit ST
      `${E}]0;title${C1.CSI}?2004h`, // an 8-bit CSI inside an OSC starts the CSI
      `${C1.DCS}q payload ${E}[?1049h is data ${C1.ST}${E}[?1h`, // ...but an ESC inside a DCS ends it
      `${C1.PM}private${C1.ST}${E}[?2004h`,
      `${E}[?10${C1.NEL}49h${E}[?1h`, // a C1 control aborts the CSI it lands in
      `${E}${C1.CSI}?2004h`, // ...and one right after ESC is still itself
      `${E}(${C1.CSI}?1h`, // ...as it is inside an escape's intermediates
      `${E}[?10\u00e949h${E}[?2004h`, // a non-ASCII char aborts a CSI too
      `${E}]0;caf\u00e9 title\x07${E}[?2004h`, // ...but is plain data inside a title
      // xterm keeps ONE mouse protocol, which `?9h` (X10, never swallowed) sets and a reset of
      // 9/1000/1002/1003 clears \u2014 but a swallowed `?1000h` never touches. And TerminalPane's
      // latch is cleared by any tracker reset AND by an alt-screen exit, which xterm's protocol
      // ignores. These interleavings are where "latest setting per mode" is not enough:
      `${E}[?9h${E}[?1049h${E}[?1000h${E}[?1000l${E}[?1049l`, // the tracker reset ended X10 too
      `${E}[?9h${E}[?1000l${E}[?1000h`, // ...and a later, swallowed re-enable does not bring it back
      `${E}[?1000h${E}[?1006h${E}[?1049h${E}[?1049l`, // an alt exit leaves xterm's own tracking on
      `${E}[?1002h${E}[?9h${E}[?1049l`,
      `${E}[?1001h${E}[?1049h${E}[?1049l${E}[?1003h${E}[?1003l`,
    ]
    for (const appMouseControl of [false, true]) {
      for (const stream of streams) await expectReplayMatches(stream, appMouseControl)
    }
  })

  it('agrees with the real parser on random interleavings of the mouse and alt-screen modes', async () => {
    // A seeded sweep of the modes that share state: one xterm protocol across 9/1000/1002/1003,
    // one encoding across 1006/1016, one screen across 47/1047/1049, and TerminalPane's latch
    // across all the trackers and every alt-screen exit \u2014 in both of TerminalPane's mouse modes.
    // (A DECSET bundling a tracker with OTHER modes is left out: TerminalPane swallows the whole
    // bundle live, so the other modes in it never reach xterm at all \u2014 its own quirk to fix.)
    let seed = 20261012
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const singles = [9, 1000, 1001, 1002, 1003, 1006, 1016, 47, 1047, 1049]
    const trackers = [1000, 1001, 1002, 1003]
    const event = (): string => {
      const set = random(2) === 0 ? 'h' : 'l'
      if (random(6) === 0) return `${E}[?${trackers[random(4)]};${trackers[random(4)]}${set}` // trackers only
      return `${E}[?${singles[random(singles.length)]}${set}`
    }
    for (let i = 0; i < 150; i++) {
      const stream = Array.from({ length: 1 + random(12) }, event).join('')
      await expectReplayMatches(stream, false)
      await expectReplayMatches(stream, true)
    }
  })

  /** Run `stream` through a live xterm, then evict it completely (one char per chunk, so every
   *  edge is a chunk edge) and rebuild a fresh xterm from the preamble alone: the tracked state
   *  and TerminalPane's latch must come out identical. */
  async function expectReplayMatches(stream: string, appMouseControl: boolean): Promise<void> {
    const live = fresh()
    const liveLatch = withLatch(live, appMouseControl)
    await parse(live, stream)
    const buffers = buffered(stream + 'x'.repeat(16), 16, 1)
    const { preamble, skip } = replayPreamble(buffers, 't')!
    const replayed = fresh()
    const replayedLatch = withLatch(replayed, appMouseControl)
    await parse(replayed, preamble + readOutput(buffers, 't').slice(skip))
    const tracked = (t: HeadlessTerminal) => {
      const m = t.modes
      return {
        buffer: t.buffer.active.type,
        cursorKeys: m.applicationCursorKeysMode,
        keypad: m.applicationKeypadMode,
        paste: m.bracketedPasteMode,
        mouse: m.mouseTrackingMode,
        focus: m.sendFocusMode,
        wrap: m.wraparoundMode,
      }
    }
    const label = `${JSON.stringify(stream)} (app mouse control ${appMouseControl ? 'on' : 'off'}) -> ${JSON.stringify(preamble)}`
    expect(tracked(replayed), label).toEqual(tracked(live))
    expect(replayedLatch.wheelToApp, label).toBe(liveLatch.wheelToApp)
    live.dispose()
    replayed.dispose()
  }

  it('an agent whose exit was evicted too: the preamble itself puts the screen back to normal', async () => {
    const shell = Array.from({ length: 1500 }, (_, i) => `PS C:\\proj> echo ${i}\r\n${i}\r\n`).join('')
    const r = await compare(AGENT_STARTUP + frames(40) + AGENT_EXIT + shell, 1000)
    expect(r.preamble).toContain(`${E}[?1049l`)
    expect(r.replayed.buffer.active.type).toBe('normal')
    expect(r.replayedLatch.wheelToApp).toBe(false)
    expect(r.replayed.modes).toEqual(r.live.modes)
    expect(viewport(r.replayed)).toEqual(viewport(r.live))
  })
})
