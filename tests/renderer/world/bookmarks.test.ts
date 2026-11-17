import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadBookmarks, MAX_BOOKMARKS, removeBookmark, saveBookmark, type Bookmark } from '../../../src/renderer/src/world/engine/bookmarks'

const KEY = 'termpolis.world.bookmarks.p1'
const mk = (name: string, over: Partial<Bookmark> = {}): Bookmark => ({ name, camera: { pos: [1, 2, 3], target: [4, 5, 6] }, selection: ['b1'], ...over })

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('bookmarks', () => {
  it('saveBookmark keeps 20, newest first, and replaces a same-named entry', () => {
    expect(loadBookmarks('p1')).toEqual([])
    for (let i = 0; i < 25; i++) saveBookmark('p1', mk(`v${i}`))
    const list = loadBookmarks('p1')
    expect(MAX_BOOKMARKS).toBe(20)
    expect(list).toHaveLength(20)
    expect(list[0].name).toBe('v24')
    expect(list[19].name).toBe('v5')
    const again = saveBookmark('p1', mk('v10', { selection: [] }))
    expect(again).toHaveLength(20)
    expect(again[0]).toEqual(mk('v10', { selection: [] }))
    expect(again.filter((b) => b.name === 'v10')).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual(again)
    expect(loadBookmarks('other')).toEqual([])
  })

  it('removeBookmark drops one by name', () => {
    saveBookmark('p1', mk('a'))
    saveBookmark('p1', mk('b'))
    expect(removeBookmark('p1', 'a').map((b) => b.name)).toEqual(['b'])
    expect(removeBookmark('p1', 'nope').map((b) => b.name)).toEqual(['b'])
  })

  it('loadBookmarks ignores corrupt JSON, a non-array and entries with bad numbers', () => {
    localStorage.setItem(KEY, '{not json')
    expect(loadBookmarks('p1')).toEqual([])
    localStorage.setItem(KEY, '{"a":1}')
    expect(loadBookmarks('p1')).toEqual([])
    const good = mk('good')
    localStorage.setItem(KEY, JSON.stringify([
      good, null, 7, 'x', {},
      mk(''), { ...good, name: 5 },
      { ...good, camera: null }, { ...good, camera: 'c' },
      { ...good, camera: { pos: [1, 2], target: [4, 5, 6] } },
      { ...good, camera: { pos: 'abc', target: [4, 5, 6] } },
      { ...good, camera: { pos: [1, 2, 3], target: [4, 'x', 6] } },
      { ...good, camera: { pos: [1, 2, 3], target: [4, null, 6] } },
      { ...good, selection: 'b1' }, { ...good, selection: [1] }, { name: 'nocam', selection: [] },
    ]))
    expect(loadBookmarks('p1')).toEqual([good])
    localStorage.setItem(KEY, JSON.stringify(Array.from({ length: 30 }, (_, i) => mk(`n${i}`))))
    expect(loadBookmarks('p1')).toHaveLength(20)
  })

  it('never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(loadBookmarks('p1')).toEqual([])
    expect(saveBookmark('p1', mk('a'))).toEqual([mk('a')])
    expect(removeBookmark('p1', 'a')).toEqual([])
  })
})
