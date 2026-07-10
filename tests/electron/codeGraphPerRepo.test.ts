import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initCodeGraph,
  buildCodeGraph,
  codeSymbols,
  codeCallers,
  codeExplore,
  codeGraphStats,
  resolveToken,
  activeProjectKey,
  graphKeyForRoot,
  ALL_REPOS,
  _resetCodeGraphForTests,
} from '../../src/main/codeGraph'
import { projectKeyOf } from '../../src/main/projectKey'

let dir: string
const keyA = projectKeyOf('/repos/alpha')!
const keyB = projectKeyOf('/repos/beta')!

const aSrc = 'export function alpha() { return shared() }\nexport function shared() { return 1 }'
const bSrc = 'export function beta() { return shared() }\nexport function shared() { return 2 }'

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-perrepo-'))
  _resetCodeGraphForTests()
})
afterEach(() => {
  _resetCodeGraphForTests()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

async function buildRepo(key: string, file: string, src: string): Promise<void> {
  await buildCodeGraph({ listFiles: async () => [file], readFile: async () => src }, key)
}

describe('per-repo code graph (C1)', () => {
  it('keeps two repos isolated — indexing B does not clobber A', async () => {
    await buildRepo(keyA, '/repos/alpha/a.ts', aSrc)
    await buildRepo(keyB, '/repos/beta/b.ts', bSrc)

    // A still has alpha even though B was indexed after it (no clobber).
    expect(codeSymbols('alpha', 50, keyA).map((s) => s.name)).toEqual(['alpha'])
    expect(codeSymbols('beta', 50, keyA)).toEqual([]) // A never had beta
    expect(codeSymbols('beta', 50, keyB).map((s) => s.name)).toEqual(['beta'])
    expect(codeSymbols('alpha', 50, keyB)).toEqual([]) // B never had alpha
  })

  it('scopes queries: active default, explicit key, and union', async () => {
    await buildRepo(keyA, '/repos/alpha/a.ts', aSrc)
    await buildRepo(keyB, '/repos/beta/b.ts', bSrc) // B built last → active

    expect(codeSymbols('beta').map((s) => s.name)).toEqual(['beta']) // active = B
    expect(codeSymbols('alpha', 50, keyA).map((s) => s.name)).toEqual(['alpha']) // explicit A
    const union = codeSymbols('', 100, ALL_REPOS).map((s) => s.name).sort()
    expect(union).toContain('alpha')
    expect(union).toContain('beta') // union spans both repos
  })

  it('does NOT wipe a non-empty repo graph when discovery returns empty (wipe-bug guard)', async () => {
    await buildRepo(keyA, '/repos/alpha/a.ts', aSrc)
    expect(codeGraphStats(keyA).symbols).toBe(2)

    // A transient non-git failure lists no files — must NOT clear the prior graph.
    const stats = await buildCodeGraph({ listFiles: async () => [], readFile: async () => '' }, keyA)
    expect(stats.symbols).toBe(2) // preserved
    expect(codeSymbols('alpha', 50, keyA).map((s) => s.name)).toEqual(['alpha'])
  })

  it('persists and reloads per-repo graphs independently', async () => {
    initCodeGraph(dir)
    await buildRepo(keyA, '/repos/alpha/a.ts', aSrc)
    await buildRepo(keyB, '/repos/beta/b.ts', bSrc)

    _resetCodeGraphForTests()
    initCodeGraph(dir) // reload from disk

    expect(codeGraphStats(keyA).symbols).toBe(2)
    expect(codeGraphStats(keyB).symbols).toBe(2)
    expect(codeCallers('shared', keyA).map((s) => s.name)).toEqual(['alpha']) // A's edges
    expect(codeCallers('shared', keyB).map((s) => s.name)).toEqual(['beta']) // B's edges — not clobbered
  })

  it('skips corrupt / non-matching files on init', () => {
    // A corrupt graph file and an unrelated file in the dir must not throw or pollute state.
    fs.writeFileSync(path.join(dir, 'code-graph-aaaaaaaaaaaaaaaa.json'), '{ not json')
    fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}')
    initCodeGraph(dir)
    expect(codeGraphStats(ALL_REPOS).symbols).toBe(0) // corrupt skipped, no crash
  })

  it('initCodeGraph tolerates a missing directory', () => {
    initCodeGraph(path.join(dir, 'does-not-exist'))
    expect(codeGraphStats().symbols).toBe(0)
  })
})

describe('code graph query surface (C1/C2 bridge)', () => {
  beforeEach(async () => {
    await buildRepo(keyA, '/repos/alpha/exportThing.ts', aSrc)
    await buildRepo(keyB, '/repos/beta/b.ts', bSrc)
  })

  it('graphKeyForRoot matches projectKeyOf and activeProjectKey tracks the last build', () => {
    expect(graphKeyForRoot('/repos/alpha')).toBe(keyA)
    expect(graphKeyForRoot('bare-name')).toBe('') // no path separator → default graph
    expect(activeProjectKey()).toBe(keyB) // B built last
  })

  it('codeGraphStats unions across all repos with ALL_REPOS', () => {
    const all = codeGraphStats(ALL_REPOS)
    expect(all.symbols).toBe(4) // 2 in A + 2 in B
    expect(codeGraphStats(keyA).symbols).toBe(2)
  })

  it('codeExplore finds a symbol in a non-active repo via explicit key', () => {
    const res = codeExplore('alpha', () => aSrc, keyA) // alpha lives in A (not active)
    expect(res?.symbol.name).toBe('alpha')
    expect(res?.callees.map((s) => s.name)).toContain('shared')
    expect(codeExplore('alpha', () => aSrc, keyB)).toBeNull() // not in B
  })

  it('resolveToken resolves a filename to files and a symbol name to symbols', () => {
    expect(resolveToken('exportThing.ts', keyA).files).toEqual(['/repos/alpha/exportThing.ts'])
    expect(resolveToken('alpha', keyA).symbols.map((s) => s.name)).toEqual(['alpha'])
    expect(resolveToken('', keyA)).toEqual({ symbols: [], files: [] })
    // union across repos: 'shared' exists in both
    expect(resolveToken('shared', ALL_REPOS).symbols).toHaveLength(2)
  })
})
