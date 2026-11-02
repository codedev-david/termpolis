// @vitest-environment node
// Two repos that share a folder name, against the REAL memory store, the REAL correction overlay, the REAL freshness lane and the
// REAL deeper read: the seam where a saved note of one repo reached the other's digest (the store scopes by the folder's key, the
// builder used to judge by a hash of the path). The store-level listing is covered in swarmMemory.test.ts and the builder's rule
// with a stand-in lister in contextPrimer.test.ts; only the three together show that each digest holds its own repo's note.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import { _resetForTests, _setEmbeddingsAvailable, initSwarmMemory, memoryList, memorySearch, memoryWrite } from '../../src/main/swarmMemory'
import { applyCorrections, applyEntryCorrections, initMemoryCorrections, resetMemoryCorrections } from '../../src/main/memoryCorrectionStore'
import { buildContextPrimer, type PrimerRecent } from '../../src/main/contextPrimer'
import { createPrimerRecent } from '../../src/main/primerLane'
import { fillVisible } from '../../src/main/doorFill'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0)
const NL = String.fromCharCode(10)

let tmp = ''
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'primer-same-name-'))
  _resetForTests()
  resetMemoryCorrections()
  initSwarmMemory(tmp)
  initMemoryCorrections(tmp)
  _setEmbeddingsAvailable(false)
})
afterEach(() => {
  _resetForTests()
  resetMemoryCorrections()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** The search the doors hand a digest: the store's, through the corrections, read again deeper when rows crowd the page. */
const SEARCH = (o: Parameters<typeof memorySearch>[0]) =>
  fillVisible(o.limit, (limit) => memorySearch({ ...o, limit }), (rows) => applyCorrections(rows), { fallback: 10, ceiling: 100 })
const LANE: PrimerRecent = createPrimerRecent({ list: (o) => Promise.resolve(memoryList(o)), correct: (rows) => applyEntryCorrections(rows) })

const API1 = 'C:/work/api'
const API2 = 'D:/personal/api'
const HOME = os.homedir().replace(/\\/g, '/')
/** Wording of its own per tag, so no two memories are taken for copies of each other. */
const words = (tag: string, n: number): string => Array.from({ length: n }, (_, i) => `${tag}${i % 13}`).join(' ')

async function note(cwd: string, file: string, text: string, hoursAgo: number): Promise<void> {
  await memoryWrite({
    agentId: 'claude-notes', source: 'claude-notes', kind: 'fact', content: `${file}: ${text} ${words(file.replace(/\W/g, ''), 24)}`,
    tags: ['type:reference', `note:${file}`], importance: 0.9, memoryType: 'summary', project: cwd, ts: T0 - hoursAgo * HOUR,
  })
}
async function conversation(cwd: string, topic: string, hoursAgo: number): Promise<void> {
  await memoryWrite({
    agentId: 'claude-history', kind: 'message', source: 'claude', project: cwd, ts: T0 - hoursAgo * HOUR,
    content: `user: ${topic} question${NL}${NL}assistant: ${topic} answer ${words(topic.replace(/\W/g, ''), 40)}`,
  })
}

describe('two repos named api, one saved note each', () => {
  it('each digest shows its own note and never the other\'s: lane on and off, three sizes, two queries, both repos', async () => {
    await note(API1, 'work-release.md', 'WORKRELEASE the employer release goes out on a pushed tag', 1)
    await note(API2, 'home-release.md', 'HOMERELEASE the hobby release is a manual zip', 1)
    for (let i = 0; i < 6; i++) { await conversation(API1, 'release deploy tag ' + i, 3 + i); await conversation(API2, 'release deploy zip ' + i, 3 + i) }

    let digests = 0
    for (const [cwd, mine, theirs] of [[API1, 'WORKRELEASE', 'HOMERELEASE'], [API2, 'HOMERELEASE', 'WORKRELEASE']] as const) {
      for (const withLane of [false, true]) {
        for (const limit of [3, 5, 10]) {
          for (const query of ['release', 'recent work, decisions, conventions, and context for api']) {
            const text = (await buildContextPrimer(SEARCH, { query, limit, project: 'api', projectPath: cwd, recent: withLane ? LANE : undefined, now: T0 + 2 * HOUR })) ?? ''
            digests++
            expect(text).not.toContain(theirs)
            if (query === 'release' && limit >= 5) expect(text).toContain(mine)
          }
        }
      }
    }
    expect(digests).toBe(24)
  })

  it('a digest that gives the folder\'s name and not its path cannot tell the repos apart (the documented fallback), and does not throw', async () => {
    await note(API1, 'work-release.md', 'WORKRELEASE the employer release goes out on a pushed tag', 1)
    await note(API2, 'home-release.md', 'HOMERELEASE the hobby release is a manual zip', 1)
    const out = await buildContextPrimer(SEARCH, { query: 'release', limit: 10, project: 'api', recent: LANE, now: T0 + 2 * HOUR })
    expect(out).toContain('RELEASE')
  })

  it('a note from the home folder reaches only a digest launched from the home folder', async () => {
    await note(HOME, 'tips.md', 'HOMETIPS where the shared keys live', 1)
    await note(API1, 'work-release.md', 'WORKRELEASE the release goes out on a pushed tag', 1)
    await conversation(API1, 'release tag', 2)
    const forApi = (await buildContextPrimer(SEARCH, { query: 'tips release', limit: 10, project: 'api', projectPath: API1, recent: LANE, now: T0 + 2 * HOUR }))!
    expect(forApi).toContain('WORKRELEASE')
    expect(forApi).not.toContain('HOMETIPS')
    const bare = await buildContextPrimer(SEARCH, { query: 'tips release', limit: 10, recent: LANE, now: T0 + 2 * HOUR })
    expect(bare ?? '').not.toContain('HOMETIPS')
    expect(bare ?? '').not.toContain('WORKRELEASE')
    const fromHome = await buildContextPrimer(SEARCH, { query: 'tips release', limit: 10, projectPath: HOME, recent: LANE, now: T0 + 2 * HOUR })
    expect(fromHome ?? '').toContain('HOMETIPS')
    expect(fromHome ?? '').not.toContain('WORKRELEASE')
  })

  it('a note filed under a scratch-folder name is shown to its own digest and not to the flat lane', async () => {
    await note('C:/tmp', 'scratch.md', 'SCRATCHNOTE only for the scratch folder', 1)
    await conversation('C:/tmp', 'scratch things', 1)
    const flat = await buildContextPrimer(SEARCH, { query: 'scratch', limit: 10, recent: LANE, now: T0 + 2 * HOUR })
    expect(flat ?? '').not.toContain('SCRATCHNOTE')
    const own = (await buildContextPrimer(SEARCH, { query: 'scratch', limit: 10, project: 'tmp', projectPath: 'C:/tmp', recent: LANE, now: T0 + 2 * HOUR }))!
    expect(own).toContain('SCRATCHNOTE')
  })
})
