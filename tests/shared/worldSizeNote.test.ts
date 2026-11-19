// "Why it is this big": the note both Lumopolis cards show on a big building (shared/world/cardFacts.ts), from
// the facts the grouping recorded and nothing else.
import { describe, expect, it } from 'vitest'
import { BIG_MIN_FILES, FLOOR_CAP, sizeNote } from '../../src/shared/world/cardFacts'
import type { Building, BuildingGrowth, WorldDoc } from '../../src/shared/world/types'
import { validateWorld } from '../../src/shared/world/validate'
import { building, minimal } from '../renderer/world/helpers'

const files = (n: number, at = 'src/main'): string[] => Array.from({ length: n }, (_, i) => `${at}/f${String(i).padStart(3, '0')}.ts`)
const grew = (over: Partial<BuildingGrowth> = {}): BuildingGrowth => ({ start: 'family', seed: 'terminal', folder: 'src/main', merged: 0, folded: 0, cap: 60, ...over })

/** A world of four 5-file buildings (the median is 5) plus `big`. */
function world(big: Building): WorldDoc {
  const doc = minimal()
  doc.buildings = ['s1', 's2', 's3', 's4'].map((id) => building(id, { members: files(5, id) }))
  doc.buildings.push(big)
  return doc
}

describe('sizeNote', () => {
  it('states every recorded reason, the "other" floor and the floors view, in one exact sentence run', () => {
    const floors = [...files(11).map((f) => ({ name: f, tech: [], members: [f] })), { name: 'other', tech: [], members: files(212).slice(11) }]
    expect(floors).toHaveLength(FLOOR_CAP)
    const big = building('big', { members: files(212), floors, growth: grew({ merged: 5, folded: 14 }) })
    expect(sizeNote(world(big), big)).toBe(
      '212 files. It started as the src/main folder\'s name family "terminal", 5 dense clusters merged into it, and 14 smaller groups were ' +
      'folded in because Lumopolis shows at most 60 buildings per project. Its "other" floor holds 201 files. Double-click to see its floors.'
    )
  })

  it('shows on a building of at least 20 files and twice the median, or on any the cap folded into', () => {
    const at = (n: number, g = grew()): string => {
      const b = building('big', { members: files(n), growth: g })
      return sizeNote(world(b), b)
    }
    expect(BIG_MIN_FILES).toBe(20)
    expect(at(20)).toBe('20 files. It started as the src/main folder\'s name family "terminal".')
    // Under 20 files, or under twice the median, says nothing.
    expect(at(19)).toBe('')
    const doc = world(building('big', { members: files(20), growth: grew() }))
    for (const b of doc.buildings.slice(0, 4)) b.members = files(11, b.id)
    expect(sizeNote(doc, doc.buildings[4])).toBe('')
    // The median of an even count is the mean of the middle two: 5, 5, 5, 5, 20, 30 has a median of 5.
    doc.buildings.push(building('more', { members: files(30, 'm') }))
    for (const b of doc.buildings.slice(0, 4)) b.members = files(5, b.id)
    expect(sizeNote(doc, doc.buildings[4])).toContain('20 files.')
    // A single folded group shows the note on a small building.
    expect(at(3, grew({ folded: 1, cap: 9 }))).toBe(
      '3 files. It started as the src/main folder\'s name family "terminal", and 1 smaller group was folded in because Lumopolis shows at most 9 buildings per project.'
    )
  })

  it('names each start the grouping records, in the singular where it is one', () => {
    const note = (g: BuildingGrowth): string => {
      const b = building('big', { members: files(40), growth: g })
      return sizeNote(world(b), b)
    }
    expect(note(grew({ start: 'process', seed: 'main', folder: undefined }))).toBe('40 files. It started as the entry of the "main" process.')
    expect(note(grew({ start: 'service', seed: 'src/main/swarmManager.ts' }))).toBe('40 files. It started as the channel service src/main/swarmManager.ts.')
    expect(note(grew({ start: 'folder', seed: 'src/main/world/detectors' }))).toBe('40 files. It started as the src/main/world/detectors folder.')
    expect(note(grew({ start: 'folder', seed: '' }))).toBe('40 files. It started as the top-level folder.')
    expect(note(grew({ folder: '' }))).toBe('40 files. It started as the top-level folder\'s name family "terminal".')
    expect(note(grew({ folder: undefined }))).toBe('40 files. It started as the top-level folder\'s name family "terminal".')
    expect(note(grew({ start: 'file', seed: 'src/main/a.ts', merged: 1 }))).toBe('40 files. It started as the single file src/main/a.ts, and 1 dense cluster merged into it.')
  })

  it('says nothing without growth, and a floor list short of the cap or of one floor adds no floor sentence', () => {
    const old = building('big', { members: files(212) })
    expect(sizeNote(world(old), old)).toBe('')
    const two = building('big', { members: files(40), growth: grew(), floors: [{ name: 'a', tech: [], members: [] }, { name: 'other', tech: [], members: [] }] })
    expect(sizeNote(world(two), two)).toBe('40 files. It started as the src/main folder\'s name family "terminal". Double-click to see its floors.')
    const capped = building('big', { members: files(40), growth: grew(), floors: Array.from({ length: FLOOR_CAP }, (_, i) => ({ name: `f${i}`, tech: [], members: [] })) })
    expect(sizeNote(world(capped), capped)).not.toContain('other')
  })

  it('a stored world without growth still loads', () => {
    const r = validateWorld(minimal())
    expect(r.ok).toBe(true)
    expect(r.ok && r.doc.buildings.every((b) => b.growth === undefined)).toBe(true)
  })
})
