// v1.23 C6 — rock-solid memory: consolidation ARCHIVES (recoverable) instead of permanently
// deleting, deep recall reaches the archive, and cross-repo recall is relevance-scoped (opt-in).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryArchive,
  searchArchive,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-archive-'))
  _resetForTests()
  initSwarmMemory(tmpDir)
  _setEmbeddingsAvailable(false)
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('archive tier (C6) — recoverable, never silently lost', () => {
  it('moves an entry out of the hot window but keeps it recoverable via deep search, across reload', async () => {
    const w = await memoryWrite({ agentId: 'a', kind: 'note', content: 'the widget frobnicator caches aggressively' })
    memoryArchive(w.id)

    // Gone from hot recall...
    const hot = await memorySearch({ query: 'widget frobnicator caches' })
    expect(hot.some((h) => h.id === w.id)).toBe(false)
    // ...but recoverable from the archive.
    const deep = searchArchive('frobnicator caches')
    expect(deep.some((e) => e.id === w.id)).toBe(true)

    // Survives reload: still not in the hot window, still in the archive.
    _resetForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmpDir)
    expect((await memorySearch({ query: 'widget frobnicator caches' })).some((h) => h.id === w.id)).toBe(false)
    expect(searchArchive('frobnicator').some((e) => e.id === w.id)).toBe(true)
  })

  it('does NOT tombstone the content hash — the same information may return later', async () => {
    const content = 'a distinctive reusable lesson about zephyr pipelines'
    const w = await memoryWrite({ agentId: 'a', kind: 'note', content })
    memoryArchive(w.id)
    // Re-writing the same content is NOT blocked (unlike memoryDelete) — it re-enters the hot window.
    const again = await memoryWrite({ agentId: 'a', kind: 'note', content })
    expect(again.id).not.toBe(w.id)
    expect((await memorySearch({ query: 'zephyr pipelines lesson' })).some((h) => h.id === again.id)).toBe(true)
  })

  it('searchArchive returns [] for an empty query and when nothing matches', async () => {
    const w = await memoryWrite({ agentId: 'a', kind: 'note', content: 'archived content here' })
    memoryArchive(w.id)
    expect(searchArchive('')).toEqual([])
    expect(searchArchive('completelyunrelatedxyz')).toEqual([])
  })

  it('searchArchive returns [] when no archive file exists yet, and memoryArchive no-ops on unknown/empty ids', async () => {
    expect(searchArchive('nothing archived yet')).toEqual([]) // archive file absent → []
    memoryArchive('mem-does-not-exist') // unknown id → no-op, no throw
    memoryArchive('') // empty id → no-op
    const w = await memoryWrite({ agentId: 'a', kind: 'note', content: 'still fully searchable' })
    expect((await memorySearch({ query: 'fully searchable' })).some((h) => h.id === w.id)).toBe(true)
  })
})

describe('relevance-scoped cross-repo recall (C6) — one unified brain, opt-in', () => {
  it('crossProject includes other repos but ranks same-project above an equal cross-repo hit', async () => {
    // Distinct content (identical content would content-dedup into one entry), both matching the query.
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'auth here uses the bearer token flow for sessions', project: '/repos/here' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'auth in the other service uses a bearer token header', project: '/repos/other' })

    const scoped = await memorySearch({ query: 'auth bearer token flow', project: '/repos/here' })
    expect(scoped).toHaveLength(1) // default: hard-scoped, other repo excluded

    const cross = await memorySearch({ query: 'auth bearer token flow', project: '/repos/here', crossProject: true })
    expect(cross.length).toBe(2) // unified: both repos surface
    expect(cross[0].project).toContain('here') // same-project ranked first (penalty on the other)
  })
})
