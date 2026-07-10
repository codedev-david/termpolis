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
