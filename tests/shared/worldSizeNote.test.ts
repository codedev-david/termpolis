// "Why it is this big": the note both Lumopolis cards show on a big building (shared/world/cardFacts.ts), from
// the facts the grouping recorded and nothing else.
import { describe, expect, it } from 'vitest'
import { BIG_MIN_FILES, FLOOR_CAP, sizeNote } from '../../src/shared/world/cardFacts'
import type { Building, BuildingGrowth, WorldDoc } from '../../src/shared/world/types'
import { validateWorld } from '../../src/shared/world/validate'
import { building, minimal } from '../renderer/world/helpers'

const files = (n: number, at = 'src/main'): string[] => Array.from({ length: n }, (_, i) => `${at}/f${String(i).padStart(3, '0')}.ts`)
const grew = (over: Partial<BuildingGrowth> = {}): BuildingGrowth =>
  ({ start: 'family', seed: 'terminal', folder: 'src/main', merged: 0, mergedFiles: 0, folded: 0, cap: 60, ...over })

/** A world of `others` buildings of `size` files each (four of five by default) plus `big`. */
function world(big: Building, others = 4, size = 5): WorldDoc {
  const doc = minimal()
  doc.buildings = Array.from({ length: others }, (_, i) => building(`s${i}`, { members: files(size, `s${i}`) }))
  doc.buildings.push(big)
  return doc
}

describe('sizeNote', () => {
  it('states every recorded reason, the "other" floor and the floors view, one fact a sentence', () => {
    const floors = [...files(11).map((f) => ({ name: f, tech: [], members: [f] })), { name: 'other', tech: [], members: files(212).slice(11) }]
    expect(floors).toHaveLength(FLOOR_CAP)
    const big = building('big', { members: files(212), floors, growth: grew({ merged: 5, mergedFiles: 2, folded: 14 }) })
    expect(sizeNote(world(big), big, 'open3d')).toBe(
      '212 files. It started as the src/main folder\'s name family "terminal". 5 name families and 2 single files were merged in because of dense ' +
      'imports. 14 other groups were folded in because Lumopolis shows at most 60 buildings per project. Its "other" floor holds 201 files. ' +
      'Double-click it to see its floors.'
    )
  })

  it('never calls the folded groups smaller: the cap picks by weight, not by file count', () => {
    const b = building('big', { members: files(3), growth: grew({ folded: 1, cap: 9 }) })
    const note = sizeNote(world(b), b)
    expect(note).toBe('3 files. It started as the src/main folder\'s name family "terminal". 1 other group was folded in because Lumopolis shows at most 9 buildings per project.')
    expect(note).not.toContain('smaller')
  })

  it('names merges for what they were: name families and single files, each in the singular where it is one', () => {
    const note = (g: Partial<BuildingGrowth>): string => {
      const b = building('big', { members: files(40), growth: grew(g) })
      return sizeNote(world(b), b)
    }
    const start = '40 files. It started as the src/main folder\'s name family "terminal".'
    expect(note({ merged: 1 })).toBe(`${start} 1 name family was merged in because of dense imports.`)
    expect(note({ mergedFiles: 1 })).toBe(`${start} 1 single file was merged in because of dense imports.`)
    expect(note({ mergedFiles: 3 })).toBe(`${start} 3 single files were merged in because of dense imports.`)
    expect(note({ merged: 2, mergedFiles: 1 })).toBe(`${start} 2 name families and 1 single file were merged in because of dense imports.`)
    expect(note({})).not.toContain('dense')
  })

  it("a process building gives its real reason: the files reached only from it, and its folder's other files", () => {
    const note = (g: Partial<BuildingGrowth>): string => {
      const b = building('big', { members: files(300), growth: grew({ start: 'process', seed: 'tool', folder: undefined, ...g }) })
      return sizeNote(world(b), b)
    }
    expect(note({ reached: 260, inFolder: 4, folder: 'src/tool' })).toBe(
      '300 files. It started as the entry of the "tool" process. 260 files imported only from inside it joined it. ' +
      '4 other files of the src/tool folder joined it because its process is named for that folder.'
    )
    expect(note({ reached: 1, inFolder: 1, folder: '' })).toBe(
      '300 files. It started as the entry of the "tool" process. 1 file imported only from inside it joined it. ' +
      '1 other file of the top-level folder joined it because its process is named for that folder.'
    )
    expect(note({ reached: 0, inFolder: 0 })).toBe('300 files. It started as the entry of the "tool" process.')
    expect(note({ inFolder: 2 })).toContain('2 other files of the top-level folder')
  })

  it('shows at 20 files and twice the median of the other buildings, or on any the cap folded into', () => {
    const at = (n: number, others = 4, size = 5): string => {
      const b = building('big', { members: files(n), growth: grew() })
      return sizeNote(world(b, others, size), b)
    }
    expect(BIG_MIN_FILES).toBe(20)
    // Exactly 20 files, well over twice the median, shows; 19 does not.
    expect(at(20)).toBe('20 files. It started as the src/main folder\'s name family "terminal".')
    expect(at(19)).toBe('')
    // Exactly twice the median of the others (12) shows; one file fewer does not.
    expect(at(24, 4, 12)).toContain('24 files.')
    expect(at(23, 4, 12)).toBe('')
    // The median of an even count is the mean of the middle two: 5, 5, 5, 30 has a median of 5.
    const doc = world(building('big', { members: files(20), growth: grew() }), 3)
    doc.buildings.push(building('more', { members: files(30, 'm') }))
    expect(sizeNote(doc, doc.buildings[3])).toContain('20 files.')
  })

  it('works for a project of one or two buildings', () => {
    const lone = (n: number): string => {
      const b = building('big', { members: files(n), growth: grew() })
      return sizeNote(world(b, 0), b)
    }
    // One building: no other to compare with, so 20 files is enough.
    expect(lone(20)).toContain('20 files.')
    expect(lone(19)).toBe('')
    // Two buildings: 500 files beside 3.
    const big = building('big', { members: files(500), growth: grew() })
    const doc = world(big, 1, 3)
    expect(sizeNote(doc, big)).toContain('500 files.')
    expect(sizeNote(doc, { ...doc.buildings[0], growth: grew() })).toBe('')
  })

  it('names each start the grouping records', () => {
    const note = (g: Partial<BuildingGrowth>): string => {
      const b = building('big', { members: files(40), growth: grew(g) })
      return sizeNote(world(b), b)
    }
    expect(note({ start: 'process', seed: 'main', folder: undefined })).toBe('40 files. It started as the entry of the "main" process.')
    expect(note({ start: 'service', seed: 'src/main/swarmManager.ts' })).toBe('40 files. It started as the channel service src/main/swarmManager.ts.')
    expect(note({ start: 'folder', seed: 'src/main/world/detectors' })).toBe('40 files. It started as the src/main/world/detectors folder.')
    expect(note({ start: 'folder', seed: '' })).toBe('40 files. It started as the top-level folder.')
    expect(note({ folder: '' })).toBe('40 files. It started as the top-level folder\'s name family "terminal".')
    expect(note({ folder: undefined })).toBe('40 files. It started as the top-level folder\'s name family "terminal".')
    expect(note({ start: 'file', seed: 'src/main/a.ts' })).toBe('40 files. It started as the single file src/main/a.ts.')
  })

  it('says how to see the floors only where that works: double-click in 3D, the list for an agent, nothing in 2D', () => {
    const two = building('big', { members: files(40), growth: grew(), floors: [{ name: 'a', tech: [], members: [] }, { name: 'other', tech: [], members: [] }] })
    const start = '40 files. It started as the src/main folder\'s name family "terminal".'
    expect(sizeNote(world(two), two, 'open3d')).toBe(`${start} Double-click it to see its floors.`)
    expect(sizeNote(world(two), two, 'listed')).toBe(`${start} Its floors are listed under What's inside.`)
    expect(sizeNote(world(two), two)).toBe(start)
    // One floor has nothing to open.
    const one = building('big', { members: files(40), growth: grew(), floors: [{ name: 'a', tech: [], members: [] }] })
    expect(sizeNote(world(one), one, 'open3d')).toBe(start)
  })

  it('says nothing without growth, and a floor list short of the cap names no "other" floor', () => {
    const old = building('big', { members: files(212) })
    expect(sizeNote(world(old), old)).toBe('')
    const capped = building('big', { members: files(40), growth: grew(), floors: Array.from({ length: FLOOR_CAP }, (_, i) => ({ name: `f${i}`, tech: [], members: [] })) })
    expect(sizeNote(world(capped), capped)).not.toContain('other')
  })

  it('a stored world without growth still loads', () => {
    const r = validateWorld(minimal())
    expect(r.ok).toBe(true)
    expect(r.ok && r.doc.buildings.every((b) => b.growth === undefined)).toBe(true)
  })
})
