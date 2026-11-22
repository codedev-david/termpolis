// graphSnapshot carries what the repository's listing could not show (codeIngest repoListingNotes), so a world mapped
// from main's code graph says it as a walked one does.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const notes = vi.hoisted(() => ({ value: null as null | { capped: boolean; unreadable: string[] } }))
vi.mock('../../src/main/codeIngest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/codeIngest')>()),
  repoListingNotes: vi.fn(() => notes.value)
}))

import { indexFileContent, graphSnapshot, _resetCodeGraphForTests } from '../../src/main/codeGraph'
import { repoListingNotes } from '../../src/main/codeIngest'

beforeEach(() => {
  _resetCodeGraphForTests()
  notes.value = null
  indexFileContent('C:/repo/src/a.ts', 'export const a = 1', 'k')
  indexFileContent('C:/repo/src/b.ts', 'export const b = 1', 'k')
})

describe('graphSnapshot: the listing notes', () => {
  it('adds nothing when the listing had nothing to say, or when no root is given', () => {
    expect(graphSnapshot('k', 'C:/repo', { structureOnly: true })).not.toHaveProperty('filesCapped')
    notes.value = { capped: false, unreadable: [] }
    const s = graphSnapshot('k', 'C:/repo')
    expect(s).not.toHaveProperty('filesCapped')
    expect(s).not.toHaveProperty('unreadable')
    notes.value = { capped: true, unreadable: ['x\uFFFD.ts'] }
    expect(graphSnapshot('k')).not.toHaveProperty('filesCapped')
    expect(vi.mocked(repoListingNotes)).toHaveBeenCalledWith('C:/repo')
  })

  it('a capped listing records the files mapped; unreadable names pass through, in both shapes', () => {
    notes.value = { capped: true, unreadable: ['x\uFFFD.ts'] }
    for (const opts of [{ structureOnly: true }, {}]) {
      const s = graphSnapshot('k', 'C:/repo/', opts)
      expect(s.files).toEqual(['src/a.ts', 'src/b.ts'])
      expect(s.filesCapped).toBe(2)
      expect(s.unreadable).toEqual(['x\uFFFD.ts'])
    }
  })
})
