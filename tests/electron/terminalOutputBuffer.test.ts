import { describe, it, expect } from 'vitest'
import {
  appendOutput,
  readOutput,
  readOutputFrom,
  readOutputTail,
  MAX_TERMINAL_BUFFER_CHARS,
  type OutputBuffers,
  type OutputWindow,
} from '../../src/main/terminalOutputBuffer'

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
