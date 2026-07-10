// v1.23 C2 — the memory<->code bridge: memories carry structured codeRefs, and symbolHistory
// maps a code symbol/file back to the memories anchored to it (persisted, projectKey-scoped).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  symbolHistory,
  backfillCodeRefs,
  weaveCandidates,
  weaveNeighbours,
  projectKeyOf,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-bridge-'))
  _resetForTests()
  initSwarmMemory(tmpDir)
  _setEmbeddingsAvailable(false)
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('memory<->code bridge (C2)', () => {
  it('persists codeRefs and round-trips them across reload; symbolHistory finds by symbol id', async () => {
    await memoryWrite({
      agentId: 'mneme',
      kind: 'fact',
      content: 'guard the null path in the loader',
      codeRefs: [{ file: 'src/loader.ts', symbol: 'load', symbolId: 'src/loader.ts#load@1', projectKey: 'k1' }],
    })
    expect(symbolHistory('load', 'k1')).toHaveLength(1)

    // Relaunch simulation — reload from disk.
    _resetForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmpDir)
    const byId = symbolHistory('src/loader.ts#load@1', 'k1')
    expect(byId).toHaveLength(1)
    expect(byId[0].content).toContain('guard the null path')
  })

  it('matches a symbol/file by id, name, full path, or bare filename — and scopes by projectKey', async () => {
    await memoryWrite({
      agentId: 'mneme',
      kind: 'fact',
      content: 'the reflow lives here',
      codeRefs: [{ file: 'a/b/exportTerminal.ts', symbol: 'reflowForMessage', symbolId: 'a/b/exportTerminal.ts#reflowForMessage@200', projectKey: 'k1' }],
    })
    expect(symbolHistory('reflowForMessage')).toHaveLength(1) // by name
    expect(symbolHistory('a/b/exportTerminal.ts')).toHaveLength(1) // full path
    expect(symbolHistory('exportTerminal.ts')).toHaveLength(1) // bare basename
    expect(symbolHistory('reflowForMessage', 'k2')).toHaveLength(0) // wrong repo scope
    expect(symbolHistory('')).toEqual([]) // empty query
  })

  it('ignores memories that carry no codeRefs', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'a plain note with no code anchor' })
    expect(symbolHistory('anything')).toEqual([])
  })
})

// v1.23 C4 — the store seams the background weave miner reads.
describe('weave seams (C4)', () => {
  it('backfillCodeRefs stamps anchors durably (survives reload), and no-ops when anchored/missing', async () => {
    const w = await memoryWrite({ agentId: 'mneme', kind: 'fact', memoryType: 'entity', content: 'loader.ts' })
    backfillCodeRefs(w.id, [{ file: 'src/loader.ts', symbol: 'load', symbolId: 'src/loader.ts#load@1', projectKey: 'k1' }])
    expect(symbolHistory('load', 'k1').map((e) => e.id)).toContain(w.id)

    backfillCodeRefs(w.id, [{ file: 'other.ts' }]) // already anchored → ignored
    expect(symbolHistory('other.ts')).toHaveLength(0)
    backfillCodeRefs('mem-nope', [{ file: 'x.ts' }]) // missing id → no throw, no effect

    // Reload — the codeRefsPatch control line re-applies the anchor.
    _resetForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmpDir)
    expect(symbolHistory('src/loader.ts#load@1', 'k1')).toHaveLength(1)
  })

  it('weaveCandidates excludes raw messages, exposes entity names, and flags anchored', async () => {
    await memoryWrite({ agentId: 'a', kind: 'message', content: 'raw chatter' })
    const ent = await memoryWrite({ agentId: 'mneme', kind: 'fact', memoryType: 'entity', content: 'foo.ts', project: '/repos/x' })
    backfillCodeRefs(ent.id, [{ file: 'src/foo.ts', projectKey: projectKeyOf('/repos/x') }])

    const cands = weaveCandidates(50)
    expect(cands.some((c) => c.kind === 'message')).toBe(false) // chatter excluded
    const e = cands.find((c) => c.id === ent.id)!
    expect(e.entities).toEqual(['foo.ts']) // entity node exposes its name
    expect(e.hasCodeRefs).toBe(true) // anchored flag set
    expect(e.projectKey).toBe(projectKeyOf('/repos/x'))
  })

  it('weaveNeighbours returns [] when the memory has no packed vector', async () => {
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'no vector without an embedder' })
    expect(weaveNeighbours(w.id)).toEqual([])
    expect(weaveNeighbours('mem-missing')).toEqual([])
  })
})
