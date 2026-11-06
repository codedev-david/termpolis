import { describe, it, expect } from 'vitest'
import { ScreenFlattener } from '../../src/main/remoteBridge/screenFlattener'

// The part of a screen a rewrite may touch: the viewport. Rows that scrolled above it are settled -- permanent,
// and never re-sent to a phone that already has them -- so a rewrite of the screen starts where they end.
describe('the live region of a terminal', () => {
  const SIZE = { cols: 30, rows: 6 }
  const lines = (n: number, from = 0): string =>
    Array.from({ length: n }, (_, i) => `line ${from + i}\r\n`).join('')

  it('is nothing for a terminal that has no emulator', () => {
    expect(new ScreenFlattener().liveRegion('t1')).toBeNull()
  })

  it('is an empty screen at 0 for an emulator that has drawn nothing', async () => {
    const f = new ScreenFlattener()
    await f.feed('t1', '', SIZE)
    expect(f.liveRegion('t1')).toEqual({ replaceFrom: 0, text: '' })
  })

  it('is the whole screen when nothing has scrolled out of the viewport', async () => {
    const f = new ScreenFlattener()
    await f.feed('t1', 'a prompt\r\n> ', SIZE)
    expect(f.liveRegion('t1')).toEqual(f.snapshot('t1'))
    expect(f.liveRegion('t1')!.replaceFrom).toBe(0)
  })

  it('starts where the settled text ends, and is what a snapshot ends with', async () => {
    const f = new ScreenFlattener()
    await f.feed('t1', lines(40), SIZE)
    const live = f.liveRegion('t1')!
    const screen = f.snapshot('t1')!
    // Rows scrolled out above the viewport: the live region starts after all of them.
    expect(live.replaceFrom).toBeGreaterThan(0)
    expect(screen.text.endsWith(live.text)).toBe(true)
    expect(screen.replaceFrom + (screen.text.length - live.text.length)).toBe(live.replaceFrom)
    // And it is the viewport, not the history: a screenful of rows, not forty.
    expect(live.text.split('\n').length).toBeLessThanOrEqual(SIZE.rows)
    expect(live.text).toContain('line 39')
    expect(live.text).not.toContain('line 0\n')
  })

  it('is what the next edit is measured against, so no edit reaches back into the settled text', async () => {
    const f = new ScreenFlattener()
    await f.feed('t1', lines(40), SIZE)
    const before = f.liveRegion('t1')!
    const edit = (await f.feed('t1', 'more output', SIZE))!
    expect(edit.replaceFrom).toBeGreaterThanOrEqual(before.replaceFrom)
    const after = f.liveRegion('t1')!
    expect(after.replaceFrom).toBeGreaterThanOrEqual(before.replaceFrom)
    expect(after.text).toContain('more output')
  })

  it('moves on as rows settle: the settled length is where it starts', async () => {
    const f = new ScreenFlattener()
    await f.feed('t1', lines(10), SIZE)
    const early = f.liveRegion('t1')!
    await f.feed('t1', lines(10, 10), SIZE)
    const late = f.liveRegion('t1')!
    expect(late.replaceFrom).toBeGreaterThan(early.replaceFrom)
  })

  it('goes with the emulator', async () => {
    const f = new ScreenFlattener()
    await f.feed('t1', 'hello', SIZE)
    f.forget('t1')
    expect(f.liveRegion('t1')).toBeNull()
  })
})
