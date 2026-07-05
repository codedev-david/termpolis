import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initCodeGraph,
  indexFileContent,
  reindexFile,
  rebuildEdges,
  buildCodeGraph,
  persistCodeGraph,
  codeSymbols,
  codeCallers,
  codeCallees,
  codeImpact,
  codeExplore,
  codeGraphStats,
  _resetCodeGraphForTests,
} from '../../src/main/codeGraph'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-'))
  _resetCodeGraphForTests()
})
afterEach(() => {
  _resetCodeGraphForTests()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

const A = 'src/a.ts'
const B = 'src/b.ts'
const aSrc = 'export function alpha() {\n  return beta() + 1\n}\nexport function gamma() {\n  return alpha()\n}'
const bSrc = 'export function beta() {\n  return 2\n}'

describe('codeGraph store', () => {
  it('indexes symbols and resolves cross-file caller/callee edges', () => {
    indexFileContent(A, aSrc)
    indexFileContent(B, bSrc)
    rebuildEdges()
    const stats = codeGraphStats()
    expect(stats.files).toBe(2)
    expect(stats.symbols).toBe(3) // alpha, gamma, beta
    // alpha → beta (cross-file), gamma → alpha (same-file)
    expect(codeCallees('alpha').map((s) => s.name)).toContain('beta')
    expect(codeCallers('beta').map((s) => s.name)).toContain('alpha')
    expect(codeCallers('alpha').map((s) => s.name)).toContain('gamma')
  })

  it('computes transitive blast radius (impact)', () => {
    indexFileContent(A, aSrc)
    indexFileContent(B, bSrc)
    rebuildEdges()
    // changing beta impacts alpha (direct) and gamma (via alpha)
    const impacted = codeImpact('beta').map((s) => s.name).sort()
    expect(impacted).toEqual(['alpha', 'gamma'])
  })

  it('prefers a same-file target when a name is ambiguous', () => {
    indexFileContent('x.ts', 'function foo() { return bar() }\nfunction bar() { return 1 }')
    indexFileContent('y.ts', 'function bar() { return 2 }')
    rebuildEdges()
    const callees = codeCallees('foo')
    expect(callees).toHaveLength(1)
    expect(callees[0].file).toBe('x.ts') // same-file bar, not y.ts's
  })

  it('codeExplore returns source (injected reader) + callers + callees', () => {
    indexFileContent(A, aSrc)
    indexFileContent(B, bSrc)
    rebuildEdges()
    const res = codeExplore('alpha', (f) => (f === A ? aSrc : bSrc))!
    expect(res.symbol.name).toBe('alpha')
    expect(res.source).toContain('return beta()')
    expect(res.callees.map((s) => s.name)).toContain('beta')
    expect(res.callers.map((s) => s.name)).toContain('gamma')
  })

  it('codeExplore falls back to substring match and returns null when nothing matches', () => {
    indexFileContent(A, aSrc)
    rebuildEdges()
    expect(codeExplore('alph', () => aSrc)?.symbol.name).toBe('alpha') // substring
    expect(codeExplore('nonexistent', () => aSrc)).toBeNull()
    expect(codeExplore('   ', () => aSrc)).toBeNull()
  })

  it('codeSymbols searches by name substring', () => {
    indexFileContent(A, aSrc)
    indexFileContent(B, bSrc)
    rebuildEdges()
    expect(codeSymbols('a').map((s) => s.name).sort()).toEqual(['alpha', 'beta', 'gamma'])
    expect(codeSymbols('gam').map((s) => s.name)).toEqual(['gamma'])
    expect(codeSymbols().length).toBe(3) // no query → all
  })

  it('re-indexing a changed file prunes its old symbols', () => {
    indexFileContent(A, aSrc)
    rebuildEdges()
    expect(codeSymbols('gamma')).toHaveLength(1)
    reindexFile(A, 'export function alpha() { return 0 }') // gamma removed
    expect(codeSymbols('gamma')).toHaveLength(0)
    expect(codeSymbols('alpha')).toHaveLength(1)
  })

  it('buildCodeGraph skips secret files and unsupported languages', async () => {
    const files = ['/repo/a.ts', '/repo/.env', '/repo/README.md']
    const contents: Record<string, string> = {
      '/repo/a.ts': aSrc,
      '/repo/.env': 'SECRET_KEY=abcdefghijklmnop',
      '/repo/README.md': '# docs',
    }
    const stats = await buildCodeGraph({
      listFiles: async () => files,
      readFile: async (f) => contents[f],
    })
    expect(stats.symbols).toBe(2) // only a.ts's alpha + gamma
    expect(codeSymbols().every((s) => s.file === '/repo/a.ts')).toBe(true)
  })

  it('buildCodeGraph returns stats on a listFiles failure without throwing', async () => {
    const stats = await buildCodeGraph({ listFiles: async () => { throw new Error('no git') }, readFile: async () => '' })
    expect(stats).toEqual({ files: 0, symbols: 0, edges: 0 })
  })

  it('persists and reloads the graph (edges rebuilt from disk)', () => {
    initCodeGraph(dir)
    indexFileContent(A, aSrc)
    indexFileContent(B, bSrc)
    rebuildEdges()
    persistCodeGraph()
    expect(fs.existsSync(path.join(dir, 'code-graph.json'))).toBe(true)

    _resetCodeGraphForTests()
    initCodeGraph(dir) // reload
    expect(codeGraphStats().symbols).toBe(3)
    expect(codeCallers('beta').map((s) => s.name)).toContain('alpha') // edges rebuilt on load
  })
})
