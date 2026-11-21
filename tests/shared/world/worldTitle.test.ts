// The name a person sees for a world: the World pane's toolbar shows it, and main titles an export and a document
// with it, so the two can never differ.
import { describe, expect, it } from 'vitest'
import { designTitle, worldTitle } from '../../../src/shared/world/worldTitle'
import type { WorldEntry } from '../../../src/shared/world/types'

const entries: WorldEntry[] = [
  { key: 'design:7f3a', source: { kind: 'design', id: '7f3a', title: 'Shop design' }, title: 'Shop design', lastOpened: 3 },
  { key: 'kg', source: { kind: 'git', url: 'https://example.com/acme/shop.git', root: 'C:\\ud\\world\\repos\\9f2c', ref: 'main' }, title: 'shop', lastOpened: 2 },
  { key: 'kf', source: { kind: 'folder', root: 'C:\\code\\notes' }, title: 'Renamed notes', lastOpened: 1 },
]

describe('worldTitle', () => {
  it('names a design by its title in the recent worlds, and "Design" when it is not there', () => {
    expect(worldTitle(entries, { root: null, designKey: 'design:7f3a' })).toBe('Shop design')
    expect(worldTitle([], { root: null, designKey: 'design:7f3a' })).toBe('Design')
    expect(designTitle(entries, 'design:7f3a')).toBe('Shop design')
    expect(designTitle(entries, 'design:gone')).toBe('Design')
  })

  it('names a cloned repository by its title, since its folder is named by a hash', () => {
    expect(worldTitle(entries, { root: 'C:\\ud\\world\\repos\\9f2c', designKey: null })).toBe('shop')
  })

  it("names any other folder by its last name, never the registry title or the world's key", () => {
    expect(worldTitle(entries, { root: 'C:\\code\\notes', designKey: null })).toBe('notes')
    expect(worldTitle(entries, { root: '/home/ann/repos/shop/', designKey: null })).toBe('shop')
    expect(worldTitle([], { root: 'C:/x/y\\', designKey: null })).toBe('y')
  })

  it('is empty with neither a folder nor a design (the home)', () => {
    expect(worldTitle(entries, { root: null, designKey: null })).toBe('')
  })
})
