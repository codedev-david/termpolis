// Next-rung: embeddingsReady no longer over-reports "healthy" before the first embed —
// a tri-state status + an off-thread warm probe.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  warmProbeEmbeddings,
  embeddingsStatus,
  getSyncStatus,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-emb-'))
  _resetForTests()
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('embeddings status tri-state', () => {
  it('reports unprobed before any embed (not a misleading "healthy")', () => {
    initSwarmMemory(dir)
    _setEmbeddingsAvailable(null)
    expect(embeddingsStatus()).toBe('unprobed')
    expect(getSyncStatus().embeddings).toBe('unprobed')
  })

  it('reports ready / unavailable once the state is known', () => {
    initSwarmMemory(dir)
    _setEmbeddingsAvailable(true)
    expect(embeddingsStatus()).toBe('ready')
    _setEmbeddingsAvailable(false)
    expect(embeddingsStatus()).toBe('unavailable')
  })
})

describe('warmProbeEmbeddings', () => {
  it('latches ready when the embedder works', async () => {
    initSwarmMemory(dir)
    _setEmbeddingsAvailable(null)
    _setEmbedFnForTests(async () => new Array(384).fill(0.01))
    expect(await warmProbeEmbeddings()).toBe(true)
    expect(embeddingsStatus()).toBe('ready')
  })

  it('is a no-op once already probed (does not re-embed)', async () => {
    initSwarmMemory(dir)
    _setEmbeddingsAvailable(false)
    const embed = vi.fn(async () => new Array(384).fill(0.01))
    _setEmbedFnForTests(embed)
    expect(await warmProbeEmbeddings()).toBe(false) // stays unavailable
    expect(embeddingsStatus()).toBe('unavailable')
    expect(embed).not.toHaveBeenCalled() // short-circuits before embedding
  })

  it('does not false-latch unavailable on a transient probe failure', async () => {
    initSwarmMemory(dir)
    _setEmbeddingsAvailable(null)
    _setEmbedFnForTests(async () => null) // transient: no vector this time
    expect(await warmProbeEmbeddings()).toBe(false)
    expect(embeddingsStatus()).toBe('unprobed') // NOT latched to 'unavailable'
  })
})
