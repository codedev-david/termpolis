// Wave 2 batch D — mneme learning-loop soundness.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memoryLink,
  consolidationCandidates,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'
import { lessonToWriteInput } from '../../src/main/mnemeGround'
import { distillEpisode, extractEntities } from '../../src/main/mnemeReflect'
import { findGaps } from '../../src/main/mnemeCuriosity'

let userDir: string
beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-w2d-'))
  _resetForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  try { fs.rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

const lesson = { memoryType: 'semantic', kind: 'fact', content: 'a lesson', importance: 0.6, entities: [], links: [] } as any

describe('lessons-source-mneme-pooling-inert', () => {
  it('carries the authoring agent source instead of hardcoding mneme', () => {
    expect(lessonToWriteInput(lesson, { id: 'e1', turns: [], source: 'codex' } as any).source).toBe('codex')
  })
  it('falls back to mneme when the episode has no source', () => {
    expect(lessonToWriteInput(lesson, { id: 'e1', turns: [] } as any).source).toBe('mneme')
  })
})

describe('failed-fix-stored-as-solution', () => {
  const turns = [
    { role: 'user', text: 'I hit an error: ENOENT no such file or directory' },
    { role: 'assistant', text: 'The fix is to create the missing directory before writing.' },
  ]
  it('does NOT mint a procedural solves lesson from a FAILED episode', async () => {
    const lessons = await distillEpisode({ id: 'e', project: 'p', source: 'claude', turns, outcome: { kind: 'error', success: false, detail: 'still broken' } } as any)
    expect(lessons.some((l) => l.memoryType === 'procedural')).toBe(false)
  })
  it('still mints a procedural lesson on a successful episode', async () => {
    const lessons = await distillEpisode({ id: 'e', project: 'p', source: 'claude', turns, outcome: { kind: 'test', success: true } } as any)
    expect(lessons.some((l) => l.memoryType === 'procedural')).toBe(true)
  })
})

describe('curiosity-mislabels-perfect-records', () => {
  it('excludes a small PERFECT record (no real failures)', () => {
    expect(findGaps([{ domain: 'deploy', attempts: 3, successes: 3, confidence: 0.44, lastTs: 0 }] as any)).toHaveLength(0)
  })
  it('includes a domain with real failure evidence', () => {
    const gaps = findGaps([{ domain: 'deploy', attempts: 4, successes: 1, confidence: 0.3, lastTs: 0 }] as any)
    expect(gaps.some((g) => g.domain === 'deploy')).toBe(true)
  })
})

describe('junk-entity-hubs', () => {
  it('does not mint hub nodes for common all-caps tokens', () => {
    const ents = extractEntities('The API returns JSON over HTTP with a TODO')
    expect(ents).not.toContain('API')
    expect(ents).not.toContain('JSON')
    expect(ents).not.toContain('HTTP')
  })
  it('still extracts a real SCREAMING identifier', () => {
    expect(extractEntities('raise the MAXBUFFER limit for the FOOBAR path')).toContain('MAXBUFFER')
  })
})

describe('consolidation-decay-inert', () => {
  it('a follows/auto backbone edge does NOT protect an entry from the sleep pass', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    const a = await memoryWrite({ agentId: 'x', kind: 'message', content: 'chunk A' })
    const b = await memoryWrite({ agentId: 'x', kind: 'message', content: 'chunk B' })
    memoryLink({ from: a.id, to: b.id, relation: 'follows' })
    expect(consolidationCandidates(500).find((c) => c.id === a.id)?.hasEdges).toBe(false)
  })
  it('an explicit meaningful link protects an entry', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    const a = await memoryWrite({ agentId: 'x', kind: 'decision', content: 'decision A' })
    const b = await memoryWrite({ agentId: 'x', kind: 'decision', content: 'decision B' })
    memoryLink({ from: a.id, to: b.id, relation: 'solves' })
    expect(consolidationCandidates(500).find((c) => c.id === a.id)?.hasEdges).toBe(true)
  })
})
