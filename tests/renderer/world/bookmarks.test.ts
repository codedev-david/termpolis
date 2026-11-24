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
    expect(loadBookmarks('p1', ['old'])).toEqual([])
    expect(saveBookmark('p1', mk('a'))).toEqual([mk('a')])
    expect(removeBookmark('p1', 'a')).toEqual([])
  })

  // WP5 fix I5: a world whose key changed keeps the views saved under its older keys.
  it('a project with no list of its own copies the lists of its older keys, in order, a name once, and leaves them in place', () => {
    const OLD_A = 'termpolis.world.bookmarks.oldA'
    const OLD_B = 'termpolis.world.bookmarks.oldB'
    localStorage.setItem(OLD_A, JSON.stringify([mk('one'), mk('two')]))
    localStorage.setItem(OLD_B, JSON.stringify([mk('two', { selection: [] }), mk('three'), ...Array.from({ length: 25 }, (_, i) => mk(`x${i}`))]))
    const list = loadBookmarks('p1', ['p1', 'oldA', 'oldB'])
    expect(list).toHaveLength(MAX_BOOKMARKS)
    expect(list.slice(0, 3)).toEqual([mk('one'), mk('two'), mk('three')])
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual(list)
    expect(JSON.parse(localStorage.getItem(OLD_A) as string)).toEqual([mk('one'), mk('two')])
    expect(localStorage.getItem(OLD_B)).not.toBeNull()
    // Once the project has its own list (even an emptied one), the older lists are not read again.
    removeBookmark('p1', 'one')
    expect(loadBookmarks('p1', ['oldA']).map((b) => b.name)).not.toContain('one')
    localStorage.setItem(KEY, '[]')
    expect(loadBookmarks('p1', ['oldA'])).toEqual([])
  })

  it('copies nothing, and writes nothing, when the older keys hold no views', () => {
    expect(loadBookmarks('p1', ['oldA', 'p1'])).toEqual([])
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(loadBookmarks('p1', [])).toEqual([])
  })
})
