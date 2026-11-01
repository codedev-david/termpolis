// @vitest-environment node
// The digest's order against the REAL stores. Lessons are written by the real lesson writer (groundEpisode, with the real
// substance gate), a note the way the notes importer files it, conversations the way the indexer does; they come back
// through the real search, the real correction overlay and the real freshness-lane lister. What a stub cannot show is that
// the fields the builder orders on (the cognitive type, the author, the tags, the correction marker) survive the store's
// own search and listing, and that a lesson the gate holds back, one someone demoted, one that says nothing and one a
// pre-1.55 brain stored in the gate's middle band are never taken for a lesson the gate vouches for.
//
// Every memory carries a marker word of its own (mark07), and a test searches for the markers of the memories it means to
// find: with the embedder off the search is lexical, a word every memory shares carries no weight, and one rare word per
// memory gives them all about the same score, so the relevance cut keeps what the test stored and the order is the
// builder's, not the ranking's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import { _resetForTests, _setEmbeddingsAvailable, initSwarmMemory, memoryList, memorySearch, memoryWrite } from '../../src/main/swarmMemory'
import { applyCorrections, applyEntryCorrections, correctMemory, initMemoryCorrections, resetMemoryCorrections } from '../../src/main/memoryCorrectionStore'
import { buildContextPrimer, type PrimerHit, type PrimerRecent, type PrimerSearch } from '../../src/main/contextPrimer'
import { createPrimerRecent } from '../../src/main/primerLane'
import { groundEpisode } from '../../src/main/mnemeGround'
import type { Lesson } from '../../src/main/mnemeReflect'
import { KEEP_SCORE, lessonSubstance, substanceBand } from '../../src/main/lessonSubstance'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const DAY = 86_400_000
const REPO = 'C:/repos/orderflow'

const mark = (n: number): string => `mark${String(n).padStart(2, '0')}`
const q = (...ns: number[]): string => ns.map(mark).join(' ')

// What the writer does with these, by the gate: the first three are kept, the fourth is held back, the fifth is refused.
const KEPT_1 = `The installer check fails with ENOENT because \`winget\` is not on PATH inside the sandbox, so call it by its full path. ${mark(2)}`
const KEPT_2 = `Never run \`git worktree remove --force\` while node_modules is a junction, because it deletes through the link. ${mark(3)}`
const KEPT_3 = `Always run the full suite and not only the touched files, because new modules that import fs broke unrelated suites. ${mark(4)}`
const HELD = `We decided to rename the retry helper in \`retryHelper.ts\` and to move its backoff settings into the shared options object for the whole sync module family, after the release is out. ${mark(5)}`
const NOTHING = 'Root cause found.'
// A pre-1.55 brain stored lessons like this with no tag at all, whatever they said.
const OLD_MIDDLE = `We decided to move the backoff settings of \`retryHelper.ts\` into the shared options object, for the whole sync module family, soon. ${mark(6)}`
const NOTE = `invalidate the cache on write, never on a timer, because a timer serves stale data after a deploy. ${mark(1)}`
const CONVERSATIONS = [7, 8, 9].map((n) => `session ${n}: alpha${n} beta${n} gamma${n} delta${n} we talked it through ${mark(n)}`)

let tmp = ''

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'primer-order-'))
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

const lesson = (content: string, over: Partial<Lesson> = {}): Lesson =>
  ({ memoryType: 'procedural', kind: 'fact', content, entities: [], importance: 0.9, links: [], ...over })

/** Lessons through the real writer and the real store, backdated so the ages in the digest are fixed. */
async function learn(lessons: Lesson[], ago = 3 * DAY) {
  return groundEpisode(
    { id: `episode-${Math.random().toString(36).slice(2)}`, project: REPO, source: 'claude', turns: [] },
    { distill: async () => lessons, write: (input) => memoryWrite({ ...input, ts: NOW - ago }) },
  )
}

const converse = (text: string, ago = 5 * HOUR) =>
  memoryWrite({ agentId: 'claude-history', kind: 'message', source: 'claude', project: REPO, content: text, ts: NOW - ago })

/** A saved note the way claudeNotesIngest files it. */
const saveNote = (text: string, ago = 52 * DAY) =>
  memoryWrite({
    agentId: 'claude-notes', source: 'claude-notes', kind: 'fact', memoryType: 'summary', importance: 0.9,
    tags: ['type:reference', 'note:cache.md'], project: REPO, content: text, ts: NOW - ago,
  })

/** The search every primer uses (index.ts correctedSearch) and the lane as index.ts builds it. */
const search: PrimerSearch = async (o) => applyCorrections(await memorySearch({ query: o.query, limit: o.limit, project: o.project })) as PrimerHit[]
const lane: PrimerRecent = createPrimerRecent({ list: memoryList, correct: applyEntryCorrections })

const digest = (query: string, extra: Record<string, unknown> = {}) =>
  buildContextPrimer(search, { query, project: 'orderflow', projectPath: REPO, now: NOW, limit: 10, fileExists: () => true, ...extra })
const rows = (out: string | null): string[] => (out ?? '').split('\n').filter((l) => l.startsWith('- ['))
const at = (out: string | null, text: string): number => (out ?? '').indexOf(text)
/** Every marker is in the digest, and every one in a group comes before every one in the next group. Within a group the
 *  order is the search's (its score), which these tests leave alone. */
const inGroups = (out: string | null, groups: string[][]): void => {
  const positions = groups.map((g) => g.map((m) => at(out, m)))
  expect(positions.flat().every((p) => p >= 0)).toBe(true)
  for (let i = 1; i < positions.length; i++) expect(Math.max(...positions[i - 1])).toBeLessThan(Math.min(...positions[i]))
}

describe('the digest\'s order against the real stores', () => {
  it('starts from lessons the gate really does keep, hold back and refuse', () => {
    for (const t of [KEPT_1, KEPT_2, KEPT_3]) expect(substanceBand(lessonSubstance(t).score)).toBe('keep')
    expect(substanceBand(lessonSubstance(HELD).score)).toBe('candidate')
    expect(substanceBand(lessonSubstance(OLD_MIDDLE).score)).toBe('candidate')
    expect(substanceBand(lessonSubstance(NOTHING).score)).toBe('drop')
    expect(lessonSubstance(KEPT_3).score).toBeGreaterThanOrEqual(KEEP_SCORE)
  })

  it('leads with the note, then the two lessons the gate vouches for, then the conversations', async () => {
    const written = await learn([lesson(KEPT_1), lesson(KEPT_2), lesson(HELD), lesson(NOTHING)])
    expect(written.written).toHaveLength(3) // two kept and one held back; the one that says nothing is not stored
    expect(written.skipped).toBe(1)
    await saveNote(NOTE)
    for (const [i, c] of CONVERSATIONS.entries()) await converse(c, (5 + i) * HOUR)

    const out = await digest(q(1, 2, 3, 5, 7, 8, 9))
    expect(rows(out)).toHaveLength(6) // one note, two lessons, three conversations: the held back and the refused are in no line
    inGroups(out, [['invalidate the cache on write'], ['installer check fails', 'worktree remove --force'], ['session 7', 'session 8', 'session 9']])
    expect(out).toMatch(/- \[note · 1mo ago\] invalidate the cache/)
    expect(out).toMatch(/- \[lesson · 3d ago\] The installer check fails/)
    expect(out).toMatch(/- \[lesson · 3d ago\] Never run `git worktree remove --force`/)
    expect(out).toMatch(/- \[claude · 5h ago\] session 7/)
    expect(out).toContain('This project (orderflow) — saved notes, lessons learned, then past conversations:')
    expect(out).not.toContain('retry helper') // held back by the gate: stored, and in no digest
  })

  it('does not take a lesson someone demoted, or one a pre-1.55 brain stored in the middle band, for a lesson the gate vouches for', async () => {
    const { written } = await learn([lesson(KEPT_1), lesson(KEPT_3)])
    correctMemory({ id: written[1], kind: 'demote', reason: 'it broke a fix', by: 'user' }) // KEPT_3, the second one written
    await memoryWrite({ agentId: 'mneme', source: 'claude', kind: 'decision', memoryType: 'semantic', importance: 0.95, project: REPO, content: OLD_MIDDLE, ts: NOW - 4 * DAY })
    for (const [i, c] of CONVERSATIONS.entries()) await converse(c, (5 + i) * HOUR)

    const out = await digest(q(2, 4, 6, 7, 8, 9))
    expect(out).toMatch(/- \[lesson · 3d ago\] The installer check fails/) // the kept one still leads
    expect(out).not.toMatch(/- \[lesson[^\]]*\] Always run the full suite/) // the demoted one does not
    expect(out).not.toMatch(/- \[lesson[^\]]*\] We decided to move/) // and neither does the one the gate would not have stored
    expect(at(out, 'installer check fails')).toBeLessThan(at(out, 'session 7'))
    for (const other of ['Always run the full suite', 'We decided to move']) {
      const p = at(out, other)
      if (p >= 0) expect(p).toBeGreaterThan(at(out, 'session 9')) // if relevance keeps it at all, it ranks behind the conversations
    }
  })

  it('shows the lane\'s newest lesson as a lesson, and leaves out the ones the search leaves out', async () => {
    await learn([lesson(KEPT_1)], 1 * HOUR)
    const { written } = await learn([lesson(KEPT_2)], 30 * 60_000) // newer than the first, then retracted
    correctMemory({ id: written[0], kind: 'retract', reason: 'wrong', by: 'user' })
    await learn([lesson(HELD)], 10 * 60_000) // held back, and the newest of all
    await converse(CONVERSATIONS[0], 2 * DAY)

    const out = await digest(q(7), { recent: lane })
    expect(out).toContain('Most recent activity here (orderflow, newest first)')
    expect(out!.split('This project')[0]).toMatch(/- \[lesson · 1h ago\] The installer check fails/) // newest first, labelled for what it is
    expect(out).not.toContain('worktree remove --force') // retracted: in no block
    expect(out).not.toContain('retry helper') // held back: in no block
  })

  it('collapses a chunk and the fuller chunk that begins with it into one line, the fuller one', async () => {
    const head = `standup: we agreed the retry budget is three attempts and the backoff doubles each time ${mark(10)}`
    const fuller = `${head} until it reaches the cap of thirty seconds, after which the job is parked, the owner is paged, and nothing else is retried until somebody has acknowledged the page and written down what they found`
    await converse(head, 2 * HOUR)
    await converse(fuller, 1 * HOUR)
    await converse(CONVERSATIONS[1], 9 * HOUR)

    const out = await digest(q(8, 10))
    expect(rows(out).filter((r) => r.includes('standup'))).toHaveLength(1)
    expect(out).toContain('written down what they found') // the fuller chunk is the one that stays
    expect(out).toContain('session 8')
  })

  it('collapses it in the freshness lane too, where a live session\'s partial chunk and the fuller one pile up', async () => {
    const pad = ' and then some more words so the chunk is long enough for the lane to take it at all, which wants a hundred and twenty characters'
    const head = `review: we walked the queue worker top to bottom${pad} ${mark(11)}`
    const fuller = `${head} while the owner kept a list of every follow-up that came out of the walk, to be filed after lunch and triaged tomorrow`
    await converse(head, 2 * HOUR)
    await converse(fuller, 1 * HOUR)

    const out = await digest(q(12), { recent: lane }) // nothing matches the query: the lane alone carries the session
    const lines = rows(out).filter((r) => r.includes('review:'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('triaged tomorrow')
  })
})
