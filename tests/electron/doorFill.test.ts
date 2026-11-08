// doorFill.ts: a read an agent makes asks the store for `limit` rows, and the door drops what the agent may not have AFTER
// the store has cut to that limit. fillVisible asks again, deeper, while that left the read short.

import { describe, it, expect, vi } from 'vitest'
import { fillVisible, type FillBounds } from '../../src/main/doorFill'

type Row = { id: string; hidden?: boolean }

const BOUNDS: FillBounds = { fallback: 10, ceiling: 100 }

/** A store that answers like the real one: the best rows first, cut to the limit it is given. It throws when asked far more
 *  often than any ladder of doublings needs, so a loop that never ends fails the test instead of hanging the run. */
function store(all: Row[]) {
  let calls = 0
  return vi.fn(async (limit?: number) => {
    if (++calls > 12) throw new Error('asked far too many times')
    return all.slice(0, Math.min(Math.max(Number(limit ?? BOUNDS.fallback), 1), BOUNDS.ceiling))
  })
}
const shown = (rows: Row[]): Row[] => rows.filter((r) => !r.hidden)
const ids = (rows: Row[]): string[] => rows.map((r) => r.id)
const many = (n: number, prefix: string, extra: Partial<Row> = {}): Row[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, ...extra }))

describe('fillVisible', () => {
  it('reads once, with the limit as the caller gave it, when nothing is hidden', async () => {
    const read = store(many(20, 'r'))
    const out = await fillVisible(5, read, shown, BOUNDS)
    expect(ids(out)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(5)
  })

  it('asks deeper while what is shown falls short, and gives back the limit asked for', async () => {
    const read = store([...many(12, 'n', { hidden: true }), ...many(30, 'c')])
    const out = await fillVisible(3, read, shown, BOUNDS)
    expect(ids(out)).toEqual(['c1', 'c2', 'c3'])
    expect(read.mock.calls.map((c) => c[0])).toEqual([3, 6, 12, 24]) // doubles until enough is visible
  })

  it('keeps the store\'s order, and the rows it can show either side of a hidden one', async () => {
    const read = store([{ id: 'a' }, { id: 'h1', hidden: true }, { id: 'b' }, { id: 'h2', hidden: true }, { id: 'c' }, { id: 'd' }])
    expect(ids(await fillVisible(3, read, shown, BOUNDS))).toEqual(['a', 'b', 'c'])
  })

  it('returns the rows it has when the store has nothing more to give', async () => {
    const read = store([...many(4, 'n', { hidden: true }), ...many(2, 'c')])
    const out = await fillVisible(5, read, shown, BOUNDS)
    expect(ids(out)).toEqual(['c1', 'c2'])
    expect(read.mock.calls.map((c) => c[0])).toEqual([5, 10]) // 10 asked, 6 came back: that is all there is
  })

  it('does not ask again when the store answered with fewer rows than it was asked for', async () => {
    const read = store(many(2, 'n', { hidden: true }))
    expect(await fillVisible(5, read, shown, BOUNDS)).toEqual([])
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('never asks for more than the store will give in one read', async () => {
    const read = store(many(300, 'n', { hidden: true }))
    expect(await fillVisible(30, read, shown, BOUNDS)).toEqual([])
    expect(read.mock.calls.map((c) => c[0])).toEqual([30, 60, 100]) // the third is the ceiling; there is no fourth
  })

  it('has nowhere deeper to go when the caller asked for more than the store gives and all of it is hidden', async () => {
    const read = store([...many(100, 'n', { hidden: true }), ...many(5, 'c')])
    expect(await fillVisible(500, read, shown, BOUNDS)).toEqual([])
    expect(read.mock.calls.map((c) => c[0])).toEqual([500]) // the caller's own limit; the store cut it to the ceiling
  })

  it('counts a read without a limit as the default one', async () => {
    const read = store([...many(15, 'n', { hidden: true }), ...many(30, 'c')])
    const out = await fillVisible(undefined, read, shown, BOUNDS)
    expect(out).toHaveLength(10)
    expect(read.mock.calls.map((c) => c[0])).toEqual([undefined, 20, 40])
  })

  // The target is what the store would have cut to. One hidden row first, so a read of exactly that many is always one short.
  it.each([
    ['a number written as text', '3', 3],
    ['a fraction', 2.5, 2],
    ['zero', 0, 1],
    ['a negative number', -4, 1],
  ])('reads %s as the store does', async (_name, limit, target) => {
    const read = store([{ id: 'h', hidden: true }, ...many(300, 'c')])
    expect(await fillVisible(limit as number, read, shown, BOUNDS)).toHaveLength(target)
  })

  it('does not go deeper for an infinite limit: the store has already given all it gives in one read', async () => {
    const read = store([{ id: 'h', hidden: true }, ...many(300, 'c')])
    expect(await fillVisible(Infinity, read, shown, BOUNDS)).toHaveLength(99)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reads a limit it cannot make sense of once, as it was, and does not go deeper', async () => {
    for (const bad of ['abc', {}, NaN]) {
      const read = vi.fn(async () => many(40, 'n', { hidden: true }))
      expect(await fillVisible(bad as number, read, shown, BOUNDS)).toEqual([])
      expect(read).toHaveBeenCalledTimes(1)
    }
  })

  it('treats null like no limit', async () => {
    const read = store(many(3, 'c'))
    expect(await fillVisible(null as unknown as number, read, shown, BOUNDS)).toHaveLength(3)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not cut a first read that came back longer than the limit, which the real store never does', async () => {
    const read = vi.fn(async () => many(8, 'c'))
    expect(await fillVisible(3, read, shown, BOUNDS)).toHaveLength(8)
  })

  // A store that answers with something that is not a list (a graph object, nothing at all) is the door's to deal with: the
  // door's rule sees it as it came, and it is read once.
  it.each([
    ['an object', { nodes: [], edges: [] }],
    ['nothing', undefined],
    ['null', null],
    ['text', 'no rows'],
  ])('leaves %s as the door made of it', async (_name, answer) => {
    const read = vi.fn(async () => answer as unknown as Row[])
    const seen = vi.fn((rows: Row[]) => rows)
    expect(await fillVisible(5, read, seen, BOUNDS)).toBe(answer)
    expect(seen).toHaveBeenCalledWith(answer)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('takes a read that answers at once', async () => {
    const read = vi.fn((limit?: number) => many(Math.min(Number(limit), 50), 'c'))
    expect(await fillVisible(4, read, shown, BOUNDS)).toHaveLength(4)
  })

  it('lets a failing read fail the way it did before: nothing is caught here', async () => {
    const read = vi.fn(async (): Promise<Row[]> => { throw new Error('memory host exited') })
    await expect(fillVisible(5, read, shown, BOUNDS)).rejects.toThrow('memory host exited')
  })

  it('lets a failing deeper read fail the same way', async () => {
    let calls = 0
    const read = vi.fn(async (limit?: number): Promise<Row[]> => {
      if (++calls > 1) throw new Error('memory host exited')
      return many(Number(limit), 'n', { hidden: true })
    })
    await expect(fillVisible(5, read, shown, BOUNDS)).rejects.toThrow('memory host exited')
  })
})
