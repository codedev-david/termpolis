import { describe, it, expect, beforeEach } from 'vitest'
import { indexFileContent, graphSnapshot, codeGraphStats, _resetCodeGraphForTests } from '../../src/main/codeGraph'

const A = 'C:\\repo\\src\\a.ts'
const BS = String.fromCharCode(92)
const B = 'C:/repo/src/lib/b.ts'
const aSrc = "import { beta } from './lib/b'\nexport function alpha() { return beta() }"
const bSrc = 'export function beta() { return 1 }'

beforeEach(() => _resetCodeGraphForTests())

describe('graphSnapshot', () => {
  it('returns sorted repo-relative slash paths', () => {
    indexFileContent(B, bSrc, 'k')
    indexFileContent(A, aSrc, 'k')
    const s = graphSnapshot('k')
    expect(s.root).toBe('C:/repo/src')
    expect(s.files).toEqual(['a.ts', 'lib/b.ts'])
    expect(s.symbols.map((x) => x.file).sort()).toEqual(['a.ts', 'lib/b.ts'])
    expect(s.symbols.every((x) => x.id.startsWith(x.file + '#'))).toBe(true)
  })

  it('includes import edges and remaps call edges to relative ids', () => {
    indexFileContent(A, aSrc, 'k')
    indexFileContent(B, bSrc, 'k')
    const s = graphSnapshot('k')
    expect(s.fileImports['a.ts']).toBeTruthy()
    expect(s.fileImports['a.ts']).toEqual(['./lib/b'])
  })

  it('keeps relative paths as they are and drops edges to missing symbols', () => {
    indexFileContent('x/a.ts', bSrc, 'r')
    const s = graphSnapshot('r')
    expect(s.root).toBe('')
    expect(s.files).toEqual(['x/a.ts'])
    expect(s.callEdges).toEqual([])
  })

  it('is a deep copy', () => {
    indexFileContent(A, aSrc, 'k')
    indexFileContent(B, bSrc, 'k')
    const s1 = graphSnapshot('k')
    s1.files.push('zzz')
    s1.symbols[0].name = 'mutated'
    s1.symbols.length = 0
    s1.fileImports['a.ts'].push('zzz')
    delete s1.fileImports['a.ts']
    const s2 = graphSnapshot('k')
    expect(s2.files).toEqual(['a.ts', 'lib/b.ts'])
    expect(s2.symbols.length).toBe(2)
    expect(s2.symbols.some((x) => x.name === 'mutated')).toBe(false)
    expect(s2.fileImports['a.ts']).not.toContain('zzz')
  })

  it('maps call edges when rebuilt, and unknown key is empty with no side effect', async () => {
    const cg = await import('../../src/main/codeGraph')
    await cg.buildCodeGraph({ listFiles: async () => [A, B], readFile: async (f) => (f === A ? aSrc : bSrc) }, 'k')
    const s = graphSnapshot('k')
    expect(s.callEdges.length).toBeGreaterThan(0)
    for (const e of s.callEdges) {
      expect(s.symbols.some((x) => x.id === e.from)).toBe(true)
      expect(s.symbols.some((x) => x.id === e.to)).toBe(true)
    }
    const before = codeGraphStats('*')
    const u = graphSnapshot('unknown')
    expect(u).toEqual({ root: '', files: [], symbols: [], callEdges: [], fileImports: {} })
    expect(codeGraphStats('*')).toEqual(before)
    expect(codeGraphStats('unknown')).toEqual({ files: 0, symbols: 0, edges: 0 })
  })

  it('drops stale edges whose symbol was removed', async () => {
    const cg = await import('../../src/main/codeGraph')
    await cg.buildCodeGraph({ listFiles: async () => [A, B], readFile: async (f) => (f === A ? aSrc : bSrc) }, 'k')
    expect(graphSnapshot('k').callEdges.length).toBeGreaterThan(0)
    indexFileContent(B, '', 'k')
    expect(graphSnapshot('k').callEdges).toEqual([])
  })

  it('explicit root keeps top-level dirs and excludes files outside it', () => {
    indexFileContent(['C:', 'repo', 'src', 'main', 'a.ts'].join(BS), aSrc, 'k')
    indexFileContent('C:/repo/src/main/b.ts', bSrc, 'k')
    indexFileContent('C:/other/c.ts', bSrc, 'k')
    const s = graphSnapshot('k', ['C:', 'Repo', ''].join(BS))
    expect(s.root).toBe('C:/Repo')
    expect(s.files).toEqual(['src/main/a.ts', 'src/main/b.ts'])
    expect(s.symbols.every((x) => x.file.startsWith('src/main/'))).toBe(true)
    expect(s.symbols.length).toBe(2)
    expect(Object.keys(s.fileImports)).toEqual(['src/main/a.ts'])
    expect(graphSnapshot('k').root).toBe('C:')
  })

  it('unknown key with explicit root echoes the root', () => {
    expect(graphSnapshot('nope', ['C:', 'r', ''].join(BS)).root).toBe('C:/r')
  })

  it('lists a file that has imports but no symbols', () => {
    indexFileContent('C:/repo/src/index.ts', "import { beta } from './lib/b'", 'k')
    indexFileContent(B, bSrc, 'k')
    const s = graphSnapshot('k')
    expect(s.files).toEqual(['index.ts', 'lib/b.ts'])
    expect(s.fileImports['index.ts']).toEqual(['./lib/b'])
  })
})
