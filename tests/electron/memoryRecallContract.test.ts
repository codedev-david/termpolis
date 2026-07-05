// F2 / F24 / F21 — the recall contract: don't resurface superseded knowledge, don't
// mislabel the primer's ordering, and don't promote unrelated memories into a project
// just because their text happens to contain the (short) slug as a substring.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryLink,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { buildContextPrimer, type PrimerHit } from '../../src/main/contextPrimer'

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-recall-'))
  _resetForTests()
  initSwarmMemory(tmpDir)
  _setEmbeddingsAvailable(false) // keyword mode — deterministic
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('F2: memorySearch never returns a superseded memory', () => {
  it('drops the old decision once a newer one supersedes it', async () => {
    const a = await memoryWrite({ agentId: 'x', kind: 'decision', content: 'Use REST for the sync API transport' })
    const b = await memoryWrite({ agentId: 'x', kind: 'decision', content: 'Switched sync API transport to gRPC; REST is deprecated' })
    memoryLink({ from: b.id, to: a.id, relation: 'supersedes' })
    const ids = (await memorySearch({ query: 'sync API transport REST gRPC' })).map((r) => r.id)
    expect(ids).toContain(b.id)     // the current decision surfaces
    expect(ids).not.toContain(a.id) // the superseded one is filtered out of primary recall
  })
})

describe('F24: the primer is honest about ordering and dates', () => {
  const now = Date.now()
  it('flat primer claims most-relevant-first and stamps a relative age', async () => {
    const search = async (): Promise<PrimerHit[]> => [
      { id: 'h1', kind: 'decision', source: 'claude', score: 0.8, content: 'a real decision worth recalling', ts: now - 45 * 86_400_000 },
    ]
    const primer = await buildContextPrimer(search, { query: 'x' })
    expect(primer).toContain('most relevant first')
    expect(primer).toMatch(/ago\]/) // a relative-age marker is present in the line label
  })

  it('project primer does not falsely claim most-relevant-first at the top', async () => {
    const search = async (opts: { project?: string }): Promise<PrimerHit[]> =>
      opts.project ? [{ id: 'p1', kind: 'message', source: 'claude', score: 0.7, content: 'a project conversation', ts: now }] : []
    const primer = await buildContextPrimer(search, { query: 'x', project: 'foo' })
    expect(primer).toContain('This project (foo) — past conversations first')
    expect(primer).not.toContain('most relevant first') // the sub-headers describe the real ordering
  })
})

describe('F21: a slug substring in content does not promote a hit into This project', () => {
  it('does not promote "mapping"/"append" into project "app"', async () => {
    const search = async (opts: { project?: string }): Promise<PrimerHit[]> =>
      opts.project === 'app'
        ? [] // no genuinely project-tagged hits
        : [{ id: 'g1', kind: 'message', source: 'claude', score: 0.6, content: 'Refactored the mapping layer and appended the signature' }]
    const primer = await buildContextPrimer(search, { query: 'x', project: 'app' })
    expect(primer).not.toContain('This project (app)') // the substring match must NOT promote it
    expect(primer).toContain('Other saved context') // it belongs in the non-project bucket
  })

  it('still promotes a real word-boundary mention of a >=4-char slug', async () => {
    const search = async (opts: { project?: string }): Promise<PrimerHit[]> =>
      opts.project === 'termpolis'
        ? []
        : [{ id: 'g1', kind: 'message', source: 'claude', score: 0.8, content: 'in Termpolis the MCP server listens on 9315' }]
    const primer = await buildContextPrimer(search, { query: 'x', project: 'termpolis' })
    expect(primer).toContain('This project (termpolis)')
    expect(primer).toContain('listens on 9315')
  })
})
