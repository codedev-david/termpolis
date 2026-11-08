// @vitest-environment node
// A digest's searches against the REAL stores when rows the builder must not show crowd the top of a page. The store cuts a
// search to its limit, best rows first, and the builder drops another project's saved notes and every lesson the substance
// gate holds back AFTER that: a page those rows fill used to leave the digest thin, or empty, with rows it may show sitting just
// behind them. Saved notes are stored at importance 0.9 and match the topic they were written about, so on a busy topic a few
// dozen of them rank ahead of everything else. A stub cannot show that the real search ranks them there, nor that the overlay
// and the deeper read compose with it: these tests use the real writer, the real search, the real correction overlay and the
// real freshness-lane lister.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import { _resetForTests, _setEmbeddingsAvailable, initSwarmMemory, memoryList, memorySearch, memoryWrite } from '../../src/main/swarmMemory'
import { applyCorrections, applyEntryCorrections, correctMemory, initMemoryCorrections, resetMemoryCorrections } from '../../src/main/memoryCorrectionStore'
import { buildContextPrimer, type PrimerHit, type PrimerRecent, type PrimerSearch } from '../../src/main/contextPrimer'
import { createPrimerRecent } from '../../src/main/primerLane'
import { fillVisible } from '../../src/main/doorFill'
import { isCandidate } from '../../src/main/lessonSubstance'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const DAY = 86_400_000
const HERE = 'C:/repos/orderflow'
const ELSEWHERE = 'C:/repos/billing'
const FRESH = 'C:/repos/fresh-start'

// The query names three topic words. A row that holds all three outranks a row that holds one.
const QUERY = 'cachewarm retryqueue flushorder'
const BEST = 'cachewarm retryqueue flushorder'

let tmp = ''
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'primer-crowd-'))
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

/** A conversation chunk the way the indexer files it: it holds one of the three topic words, and wording of its own so that
 *  the digest's near-duplicate pass keeps every one. */
const converse = (i: number, project: string, ago = 5 * HOUR) =>
  memoryWrite({ agentId: 'claude-history', kind: 'message', source: 'claude', project, content: `conversation ${i} alpha${i} beta${i} gamma${i} delta${i} cachewarm`, ts: NOW - ago - i * 1000 })
/** A saved note the way claudeNotesIngest files it: all three topic words, so it ranks ahead of a conversation. */
const saveNote = (i: number, project: string) =>
  memoryWrite({
    agentId: 'claude-notes', source: 'claude-notes', kind: 'fact', memoryType: 'summary', importance: 0.9,
    tags: ['type:reference', `note:topic${i}.md`], project, content: `${BEST} note ${i}: how we handle the queue after a deploy`, ts: NOW - 52 * DAY,
  })
/** A lesson the gate stored but holds back (the middle band): all three topic words. */
const holdBack = (i: number, project: string) =>
  memoryWrite({
    agentId: 'mneme', source: 'claude', kind: 'fact', memoryType: 'procedural', importance: 0.45, tags: ['candidate'],
    project, content: `${BEST} borderline lesson ${i}: we decided to look at the helper later`, ts: NOW - 3 * DAY,
  })

/** What the builder does by itself: the search as the store answers it (the overlay is not even applied). */
const rawSearch: PrimerSearch = async (o) => (await memorySearch({ query: o.query, limit: o.limit, project: o.project })) as PrimerHit[]
/** What every digest in the app searches through (index.ts correctedSearch): the overlay, asked again deeper while it dropped rows. */
const corrected: PrimerSearch = (o) =>
  fillVisible(o.limit, (limit) => memorySearch({ query: o.query, limit, project: o.project }), (rows) => applyCorrections(rows), { fallback: 10, ceiling: 100 }) as Promise<PrimerHit[]>
const lane: PrimerRecent = createPrimerRecent({ list: memoryList, correct: applyEntryCorrections })

const digest = (search: PrimerSearch, extra: Record<string, unknown> = {}) => buildContextPrimer(search, { query: QUERY, limit: 10, now: NOW, ...extra })
const conversationLines = (out: string | null): string[] => (out ?? '').split('\n').filter((l) => /^- \[claude · /.test(l))

describe('the premise: the real search ranks the rows a digest must not show ahead of everything else', () => {
  it('puts every one of 45 other projects\' notes ahead of the conversations in an unscoped page of 40', async () => {
    for (let i = 0; i < 6; i++) await converse(i, HERE)
    for (let i = 0; i < 45; i++) await saveNote(i, ELSEWHERE)
    const page = await memorySearch({ query: QUERY, limit: 40 })
    expect(page).toHaveLength(40)
    expect(page.every((h) => h.agentId === 'claude-notes')).toBe(true)
  })

  it('puts every one of 40 held-back lessons ahead of the conversations in a project page of 28', async () => {
    for (let i = 0; i < 6; i++) await converse(i, HERE)
    for (let i = 0; i < 40; i++) await holdBack(i, HERE)
    const page = await memorySearch({ query: QUERY, limit: 28, project: HERE })
    expect(page).toHaveLength(28)
    expect(page.every((h) => isCandidate(h))).toBe(true)
  })
})

describe('a digest that names no project, while other projects\' saved notes hold the best 45 places', () => {
  beforeEach(async () => {
    for (let i = 0; i < 6; i++) await converse(i, HERE)
    for (let i = 0; i < 45; i++) await saveNote(i, ELSEWHERE)
  })

  it.each([['the store\'s own answer', rawSearch], ['the search every digest in the app goes through', corrected]])('still shows the conversations behind them: %s', async (_name, search) => {
    const out = await digest(search)
    expect(conversationLines(out)).toHaveLength(6)
    expect(out).not.toContain('how we handle the queue after a deploy') // and none of those notes
  })
})

describe('a digest for a folder with no memory of its own, while other projects\' saved notes hold the best 45 places', () => {
  it('still shows what other projects\' conversations hold, under the label that says they may not apply', async () => {
    for (let i = 0; i < 6; i++) await converse(i, HERE)
    for (let i = 0; i < 45; i++) await saveNote(i, ELSEWHERE)
    const out = await digest(corrected, { project: 'fresh-start', projectPath: FRESH })
    expect(out).toContain('Other saved context (may NOT apply to this project):')
    expect(conversationLines(out)).toHaveLength(6)
    expect(out).not.toContain('how we handle the queue after a deploy')
  })
})

describe('a digest for a project, while lessons the gate holds back hold the best places of its own search', () => {
  beforeEach(async () => {
    for (let i = 0; i < 4; i++) await converse(i, HERE)
    for (let i = 0; i < 40; i++) await holdBack(i, HERE)
  })

  it.each([['the store\'s own answer', rawSearch], ['the search every digest in the app goes through', corrected]])('still shows its conversations: %s', async (_name, search) => {
    const out = await digest(search, { project: 'orderflow', projectPath: HERE, limit: 7, recent: lane })
    expect(conversationLines(out).length).toBeGreaterThanOrEqual(4)
    expect(out).not.toContain('borderline lesson')
  })

  it('also when the lane is off and the page is cut to a limit of 5', async () => {
    const out = await digest(corrected, { project: 'orderflow', projectPath: HERE, limit: 5 })
    expect(conversationLines(out).length).toBeGreaterThan(0)
    expect(out).not.toContain('borderline lesson')
  })
})

describe('a digest for a project, while what someone retracted holds the best places of its own search', () => {
  it('still shows the memories behind it', async () => {
    const ids: string[] = []
    for (let i = 0; i < 40; i++) {
      const e = await memoryWrite({ agentId: 'claude-history', kind: 'message', source: 'claude', project: HERE, content: `${BEST} retracted claim ${i}`, ts: NOW - 2 * HOUR })
      ids.push(e.id)
    }
    for (let i = 0; i < 4; i++) await converse(i, HERE)
    for (const id of ids) correctMemory({ id, kind: 'retract', reason: 'wrong', by: 'david' })
    const out = await digest(corrected, { project: 'orderflow', projectPath: HERE, limit: 10 })
    expect(conversationLines(out).length).toBeGreaterThanOrEqual(4)
    expect(out).not.toContain('retracted claim')
  })
})

describe('a digest with nothing crowding it', () => {
  it('is the digest it always was, from one read of each search', async () => {
    for (let i = 0; i < 6; i++) await converse(i, HERE)
    const spy = vi.fn(corrected)
    const out = await digest(spy, { project: 'orderflow', projectPath: HERE })
    expect(spy).toHaveBeenCalledTimes(2) // the project search and the unscoped one, once each
    expect(conversationLines(out)).toHaveLength(6)
  })
})
