// F14 / F15 / F17 / F25 — memory_write must not silently lie: no silent tail-truncation,
// no dropped scoping metadata on a dedup hit, no double-insert under concurrency, and no
// false-dedup of whitespace-significant content.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryCount,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-write-'))
  _resetForTests()
  initSwarmMemory(tmpDir)
  _setEmbeddingsAvailable(false)
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('F14: oversize content is flagged, not silently truncated', () => {
  it('returns truncated:true + originalChars and caps the stored content', async () => {
    const big = 'A'.repeat(20 * 1024) + ' RULING: do NOT adopt gRPC'
    const w = await memoryWrite({ agentId: 'a', kind: 'decision', content: big })
    expect(w.truncated).toBe(true)
    expect(w.originalChars).toBe(big.length)
    expect(w.content.length).toBeLessThanOrEqual(16 * 1024)
  })

  it('hashes the ORIGINAL content so a re-write dedups instead of proliferating fragments', async () => {
    const big = 'B'.repeat(20 * 1024) + ' distinct tail'
    const w1 = await memoryWrite({ agentId: 'a', kind: 'note', content: big })
    const w2 = await memoryWrite({ agentId: 'a', kind: 'note', content: big })
    expect(w2.id).toBe(w1.id)
    expect(memoryCount()).toBe(1)
  })
})

describe('F15: a dedup hit backfills missing scoping metadata', () => {
  it('adopts project/tags the second call supplied', async () => {
    const w1 = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'Use pnpm, not npm, in this repo' })
    const w2 = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'Use pnpm, not npm, in this repo', project: 'C:/repos/foo', tags: ['tooling'] })
    expect(w2.id).toBe(w1.id) // dedup hit
    // The project-scoped recall the agent believes it filed now actually works.
    const hits = await memorySearch({ query: 'pnpm npm package manager', project: 'C:/repos/foo' })
    expect(hits.some((h) => h.id === w1.id)).toBe(true)
  })
})

describe('F17: concurrent identical writes insert only one entry', () => {
  it('dedups two same-content writes racing across the embed await', async () => {
    const content = 'we chose Postgres over Mongo because of X'
    const [a, b] = await Promise.all([
      memoryWrite({ agentId: 'a', kind: 'decision', content }),
      memoryWrite({ agentId: 'a', kind: 'decision', content }),
    ])
    expect(memoryCount()).toBe(1)
    expect(a.id).toBe(b.id)
  })
})

describe('F25: whitespace-significant content is not false-deduped', () => {
  it('keeps distinct entries for content differing only in indentation', async () => {
    const a = await memoryWrite({ agentId: 'a', kind: 'note', content: 'def f():\n    return risky()' })
    const b = await memoryWrite({ agentId: 'a', kind: 'note', content: 'def f():\n        return risky()' })
    expect(b.id).not.toBe(a.id)
    expect(memoryCount()).toBe(2)
  })
})
