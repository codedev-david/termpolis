// graphSnapshot carries what the repository's listing could not show (codeIngest repoListingNotes), so a world mapped
// from main's code graph says it as a walked one does.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const notes = vi.hoisted(() => ({ value: null as null | { nestedCapped: boolean; unreadable: string[]; nested: string[] } }))
vi.mock('../../src/main/codeIngest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/codeIngest')>()),
  repoListingNotes: vi.fn(() => notes.value)
}))

import { indexFileContent, graphSnapshot, _resetCodeGraphForTests } from '../../src/main/codeGraph'
import { repoListingNotes } from '../../src/main/codeIngest'
import { MAP_FILE_CAP } from '../../src/main/repoFileList'

beforeEach(() => {
  _resetCodeGraphForTests()
  notes.value = null
  indexFileContent('C:/repo/src/a.ts', 'export const a = 1', 'k')
  indexFileContent('C:/repo/src/b.ts', 'export const b = 1', 'k')
})

describe('graphSnapshot: the listing notes', () => {
  it('adds nothing when the listing had nothing to say, or when no root is given', () => {
    expect(graphSnapshot('k', 'C:/repo', { structureOnly: true })).not.toHaveProperty('filesCapped')
    notes.value = { nestedCapped: false, unreadable: [], nested: ['sdk'] }
    const s = graphSnapshot('k', 'C:/repo')
    expect(s).not.toHaveProperty('filesCapped')
    expect(s).not.toHaveProperty('nestedCapped')
    expect(s).not.toHaveProperty('unreadable')
    notes.value = { nestedCapped: true, unreadable: ['x\uFFFD.ts'], nested: [] }
    expect(graphSnapshot('k')).not.toHaveProperty('nestedCapped')
    expect(vi.mocked(repoListingNotes)).toHaveBeenCalledWith('C:/repo')
  })

  it('nested repositories cut at the cap record the cap they shared (the repository itself is never cut); unreadable names pass through, in both shapes', () => {
    notes.value = { nestedCapped: true, unreadable: ['x\uFFFD.ts'], nested: ['big'] }
    for (const opts of [{ structureOnly: true }, {}]) {
      const s = graphSnapshot('k', 'C:/repo/', opts)
      expect(s.files).toEqual(['src/a.ts', 'src/b.ts'])
      expect(s.nestedCapped).toBe(MAP_FILE_CAP)
      expect(s).not.toHaveProperty('filesCapped')
      expect(s.unreadable).toEqual(['x\uFFFD.ts'])
    }
  })
})
