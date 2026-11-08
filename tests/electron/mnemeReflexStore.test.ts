import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { onTaskComplete } from '../../src/main/mnemeReflex'
import { distillEpisode } from '../../src/main/mnemeReflect'
import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  memoryLessons,
  memorySearch,
  memoryRelated,
  memoryGraphQuery,
  memoryLink,
  symbolHistory,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { applyCorrections, applyEntryCorrections, resetMemoryCorrections } from '../../src/main/memoryCorrectionStore'
import { buildContextPrimer, type PrimerHit } from '../../src/main/contextPrimer'
import {
  initCompetence,
  recordOutcome,
  assessCompetence,
  _resetCompetenceForTests,
} from '../../src/main/mnemeCompetence'
import { CANDIDATE_IMPORTANCE, CANDIDATE_TAG, importanceForScore, lessonSubstance, substanceBand } from '../../src/main/lessonSubstance'

// End-to-end proof of the in-app reflex against the REAL store + REAL competence
// (previously only tested with fakes): a finishing task distills a grounded lesson
// into the store AND records self-competence. Uses the same real dependencies the
// index.ts wiring passes to onTaskComplete.
describe('Mneme reflex — real-store end-to-end', () => {
  let tmp: string
  const realDeps = () => ({
    distill: (ep: Parameters<typeof distillEpisode>[0]) => distillEpisode(ep),
    write: (i: Parameters<typeof memoryWrite>[0]) => memoryWrite(i),
    recordOutcome,
    now: Date.now(),
  })
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-reflex-'))
    _resetForTests()
    _resetCompetenceForTests()
    initSwarmMemory(tmp)
    initCompetence(tmp)
    _setEmbeddingsAvailable(false)
  })
  afterEach(() => {
    _resetForTests()
    _resetCompetenceForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('a completed error→fix task grounds a lesson into the store and records competence', async () => {
    const res = await onTaskComplete(
      {
        id: 'task-1',
        status: 'completed',
        project: 'termpolis',
        title: 'fix the failing build',
        result: 'Error: cannot find module `foo` during build. Fixed by adding it to package.json. Tests pass now.',
      },
      realDeps(),
    )
    expect(res.fired).toBe(true)
    expect(res.lessons).toBeGreaterThan(0)

    const lesson = memoryList({ limit: 50 }).find((m) => m.memoryType === 'procedural' && m.originEpisode === 'task-1')
    expect(lesson).toBeDefined()
    expect(lesson!.content).toMatch(/cannot find module/i)
    // It names `foo` and package.json, so the substance gate keeps it, and its importance follows the score
    // rather than the distiller's own guess.
    const verdict = lessonSubstance(lesson!.content)
    expect(substanceBand(verdict.score)).toBe('keep')
    expect(lesson!.importance).toBe(importanceForScore(verdict.score))
    expect(lesson!.tags ?? []).not.toContain(CANDIDATE_TAG)
    expect(res.skipped).toBe(0)

    const comp = assessCompetence('termpolis')
    expect(comp.known).toBe(true)
    expect(comp.attempts).toBe(1)
    expect(comp.confidence).toBeGreaterThan(0)
  })

  it('stores a lesson the gate holds back under the candidate tag, and refuses narration outright', async () => {
    const res = await onTaskComplete(
      {
        id: 'task-4',
        status: 'completed',
        project: 'termpolis',
        title: 'tidy the retry helper',
        result:
          'We decided to rename the retry helper in `retryHelper.ts` after the release is out. ' +
          'We decided to look at it tomorrow, once the review comes back. ' +
          'We decided to use HNSW instead of brute force for the vector index.',
      },
      realDeps(),
    )
    expect(res).toMatchObject({ fired: true, lessons: 3, skipped: 1 })
    expect(res.written).toHaveLength(2)

    const stored = memoryList({ limit: 50 }).filter((m) => m.originEpisode === 'task-4')
    expect(stored).toHaveLength(2)
    const held = stored.find((m) => m.content.includes('retryHelper.ts'))
    const kept = stored.find((m) => m.content.includes('HNSW'))
    expect(held!.tags).toEqual([CANDIDATE_TAG])
    expect(held!.importance).toBe(CANDIDATE_IMPORTANCE)
    expect(kept!.tags).toBeUndefined()
    expect(kept!.importance).toBe(importanceForScore(lessonSubstance(kept!.content).score))
    expect(stored.some((m) => m.content.includes('tomorrow'))).toBe(false) // narration: not in the store at all
  })

  // A lesson stored before 1.55 sits in the store with no tag and is shown. Re-deriving the same sentence (a resumed session reads
  // the same turns again) finds it by content hash, and the store merges the new call's tags into the old row so that scoping
  // metadata is not lost. The hold-back mark is not scoping metadata: it must not turn a lesson that was being shown into one
  // that is not. ("Borderline lessons stored earlier are left as they are.")
  it('re-deriving a borderline lesson stored before 1.55 leaves that lesson shown', async () => {
    const task = {
      id: 'task-9',
      status: 'completed' as const,
      project: 'termpolis',
      title: 'tidy the retry helper',
      result: 'We decided to rename the retry helper in `retryHelper.ts` after the release is out.',
    }
    const derived: Array<Parameters<typeof memoryWrite>[0]> = []
    await onTaskComplete(task, { ...realDeps(), write: async (i) => { derived.push(i); return { id: 'dry-run' } } })
    expect(derived).toHaveLength(1)
    expect(derived[0].tags).toEqual([CANDIDATE_TAG]) // today's gate holds this one back
    // The same lesson as 1.54 stored it: no tag, and shown.
    const before = await memoryWrite({ ...derived[0], tags: undefined, importance: 0.8 })
    expect(memoryList({ limit: 50 }).find((m) => m.id === before.id)!.tags).toBeUndefined()

    // A held-back lesson hashes in a space of its own, so the re-derived one is a separate (hidden) row and the old lesson is
    // not touched at all: not retagged, not re-scored, still served.
    const res = await onTaskComplete(task, realDeps())
    expect(res.written).toHaveLength(1)
    const derivedId = res.written[0]
    expect(derivedId).not.toBe(before.id)
    const row = memoryList({ limit: 50 }).find((m) => m.id === before.id)!
    expect(row.tags).toBeUndefined()
    expect(row.importance).toBe(0.8)
    expect(memoryList({ limit: 50 }).find((m) => m.id === derivedId)!.tags).toEqual([CANDIDATE_TAG])
    expect(applyEntryCorrections(memoryList({ limit: 50 })).map((m) => m.id)).toContain(before.id)
    expect(applyEntryCorrections(memoryList({ limit: 50 })).map((m) => m.id)).not.toContain(derivedId)
    const served = applyCorrections(await memorySearch({ query: 'retry helper retryHelper.ts', limit: 10 })).map((m) => m.id)
    expect(served).toContain(before.id)
    expect(served).not.toContain(derivedId)

    // and a third derivation of the same sentence lands on the hidden row it made, so the store does not grow
    const rows = memoryList({ limit: 50 }).length
    expect((await onTaskComplete(task, realDeps())).written).toEqual([derivedId])
    expect(memoryList({ limit: 50 })).toHaveLength(rows)
  })

  // The words of a held-back lesson are not the lesson's alone. An agent that writes the same sentence as a note of its own
  // meant it to be found. De-duplicated into the hidden row it was found by nobody, and after a restart not even its tag survived.
  describe('an agent\'s own note with the words of a held-back lesson', () => {
    const SENTENCE = 'a borderline lesson about the retry helper'
    const seen = async (query: string): Promise<{ listed: string[]; served: string[] }> => ({
      listed: applyEntryCorrections(memoryList({ limit: 50 })).map((m) => m.id),
      served: applyCorrections(await memorySearch({ query, limit: 10 })).map((m) => m.id),
    })
    const restart = (): void => { _resetForTests(); initSwarmMemory(tmp); _setEmbeddingsAvailable(false) }

    it('is its own row, listed and found, and stays so after a restart (lesson first)', async () => {
      const held = await memoryWrite({ agentId: 'mneme', kind: 'decision', content: SENTENCE, tags: [CANDIDATE_TAG], importance: 0.45 })
      const mine = await memoryWrite({ agentId: 'claude', kind: 'note', content: SENTENCE, tags: ['mine'] })
      expect(mine.id).not.toBe(held.id)
      for (const phase of ['now', 'after a restart']) {
        if (phase !== 'now') restart()
        const row = memoryList({ limit: 50 }).find((m) => m.id === mine.id)!
        expect(row, phase).toMatchObject({ agentId: 'claude', tags: ['mine'] })
        const { listed, served } = await seen('borderline lesson retry helper')
        expect(listed, phase).toContain(mine.id)
        expect(served, phase).toContain(mine.id)
        expect(listed, phase).not.toContain(held.id)
        expect(served, phase).not.toContain(held.id)
        expect(memoryList({ limit: 50 }).find((m) => m.id === held.id)!.tags, phase).toEqual([CANDIDATE_TAG]) // the lesson is still held back
      }
    })

    it('does not lose the note when the lesson is derived second: both rows are kept, the note still shown', async () => {
      const mine = await memoryWrite({ agentId: 'claude', kind: 'note', content: SENTENCE, tags: ['mine'] })
      const held = await memoryWrite({ agentId: 'mneme', kind: 'decision', content: SENTENCE, tags: [CANDIDATE_TAG], importance: 0.45 })
      expect(held.id).not.toBe(mine.id)
      for (const phase of ['now', 'after a restart']) {
        if (phase !== 'now') restart()
        const { listed } = await seen('borderline lesson retry helper')
        expect(listed, phase).toContain(mine.id)
        expect(listed, phase).not.toContain(held.id)
        expect(memoryList({ limit: 50 }).find((m) => m.id === mine.id)!.tags, phase).toEqual(['mine'])
      }
    })

    it('leaves a lesson derived twice as one hidden row', async () => {
      const a = await memoryWrite({ agentId: 'mneme', kind: 'decision', content: SENTENCE, tags: [CANDIDATE_TAG], importance: 0.45 })
      const b = await memoryWrite({ agentId: 'mneme', kind: 'decision', content: SENTENCE, tags: [CANDIDATE_TAG], importance: 0.45 })
      expect(b.id).toBe(a.id)
      expect(memoryList({ limit: 50 })).toHaveLength(1)
      restart()
      expect(memoryList({ limit: 50 })).toHaveLength(1)
    })

    it('keeps the tag a lesson derived without one as a plain lesson: only the lesson writer\'s hold-back is held back', async () => {
      const plain = await memoryWrite({ agentId: 'mneme', kind: 'decision', content: SENTENCE, importance: 0.8 })
      const heldByHand = await memoryWrite({ agentId: 'claude', kind: 'note', content: SENTENCE, tags: [CANDIDATE_TAG] })
      expect(heldByHand.id).toBe(plain.id) // an agent\'s own `candidate` is not the lesson writer\'s: the same words are the same row
      expect(memoryList({ limit: 50 }).find((m) => m.id === plain.id)!.tags).toBeUndefined() // ...and the word is not added to a shown lesson
    })
  })

  // memory_write passes `tags` through as the model sent it, and the server does no schema validation: a repeat of words already
  // stored must answer with the row it has whatever the tags are, as it did before the gate.
  it.each([['text', 'release,deploy'], ['a number', 5], ['an object', { a: 1 }], ['true', true], ['null', null]])(
    'answers a repeat of stored words with the row it has when its tags are %s',
    async (_name, tags) => {
      const first = await memoryWrite({ agentId: 'codex', kind: 'note', content: 'the deploy needs the staging flag', tags: ['deploy'] })
      const again = await memoryWrite({ agentId: 'codex', kind: 'note', content: 'the deploy needs the staging flag', tags: tags as never })
      expect(again.id).toBe(first.id)
      expect(memoryList({ limit: 10 }).find((m) => m.id === first.id)!.tags).toEqual(['deploy'])
    },
  )

  it('still merges every other tag of a re-written memory into the row it already has', async () => {
    const first = await memoryWrite({ agentId: 'codex', kind: 'note', content: 'the deploy needs the staging flag', tags: ['deploy'] })
    const again = await memoryWrite({ agentId: 'codex', kind: 'note', content: 'the deploy needs the staging flag', tags: ['deploy', 'staging'] })
    expect(again.id).toBe(first.id)
    expect(memoryList({ limit: 10 }).find((m) => m.id === first.id)!.tags).toEqual(['deploy', 'staging'])
  })

  it('keeps the hold-back mark on a row that already has it, and does not add it to a row someone tagged by hand', async () => {
    const held = await memoryWrite({ agentId: 'mneme', kind: 'decision', content: 'a borderline lesson about the retry helper', tags: [CANDIDATE_TAG], importance: 0.45 })
    await memoryWrite({ agentId: 'mneme', kind: 'decision', content: 'a borderline lesson about the retry helper', tags: [CANDIDATE_TAG, 'extra'] })
    expect(memoryList({ limit: 10 }).find((m) => m.id === held.id)!.tags).toEqual([CANDIDATE_TAG, 'extra'])
    const mine = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'my own note about the release', tags: ['release'] })
    await memoryWrite({ agentId: 'mneme', kind: 'note', content: 'my own note about the release', tags: [CANDIDATE_TAG] })
    expect(memoryList({ limit: 10 }).find((m) => m.id === mine.id)!.tags).toEqual(['release'])
  })

  // The unit tests for each read door use rows they built themselves. This one uses the real store, the real
  // distiller and the real read functions, so it also proves what they cannot: that a stored lesson's `tags`
  // survive every real producer (search, list, related, graph) all the way to the door that drops it.
  it('a lesson the gate holds back is in the store, is findable by the raw reads, and is dropped at every door an agent reads through', async () => {
    resetMemoryCorrections() // no correction on file: the lesson is hidden by its tag alone
    const HELD_SENTENCE = 'We decided to rename the retry helper in `retryHelper.ts` and to move its backoff settings into the shared options object for the whole sync module family, after the release is out.'
    const KEPT_SENTENCE = 'We decided to use HNSW instead of brute force for the retry helper vector index.'
    expect(substanceBand(lessonSubstance(HELD_SENTENCE).score)).toBe('candidate')
    expect(substanceBand(lessonSubstance(KEPT_SENTENCE).score)).toBe('keep')

    const res = await onTaskComplete(
      { id: 'task-6', status: 'completed', project: 'termpolis', title: 'tidy the retry helper', result: `${HELD_SENTENCE} ${KEPT_SENTENCE}` },
      realDeps(),
    )
    expect(res.written).toHaveLength(2)
    const stored = memoryList({ limit: 50 }).filter((m) => m.originEpisode === 'task-6')
    const held = stored.find((m) => m.tags?.includes(CANDIDATE_TAG))!
    const kept = stored.find((m) => !m.tags?.includes(CANDIDATE_TAG))!
    expect(held.content).toContain('retryHelper.ts')
    expect(kept.content).toContain('HNSW')
    memoryLink({ from: kept.id, to: held.id, relation: 'relates-to' }) // a graph edge between them, as an agent could draw

    const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id)
    const search = { query: 'rename the retry helper in retryHelper.ts', limit: 20 }

    // RAW: the store has it and every raw read finds it (so each assertion below can fail).
    expect(ids(await memorySearch(search))).toContain(held.id)
    expect(ids(memoryList({ limit: 50 }))).toContain(held.id)
    expect(ids(memoryLessons(200))).toContain(held.id)
    expect(ids(await memoryRelated({ id: kept.id, limit: 20 }))).toContain(held.id)
    expect(ids(await memoryGraphQuery({ id: kept.id }))).toContain(held.id)

    // AGENT-FACING: search, list, pool/conflicts' lesson window, related and graph all go through these two doors.
    expect(ids(applyCorrections(await memorySearch(search)))).not.toContain(held.id)
    expect(ids(applyEntryCorrections(memoryList({ limit: 50 })))).not.toContain(held.id)
    expect(ids(applyEntryCorrections(memoryLessons(200)))).not.toContain(held.id)
    expect(ids(applyEntryCorrections(await memoryRelated({ id: kept.id, limit: 20 })))).not.toContain(held.id)
    expect(ids(applyEntryCorrections(await memoryGraphQuery({ id: kept.id })))).not.toContain(held.id)
    // ...while the kept lesson from the same task still comes through every one of them
    expect(ids(applyCorrections(await memorySearch(search)))).toContain(kept.id)
    expect(ids(applyEntryCorrections(memoryLessons(200)))).toContain(kept.id)

    // THE PRIMER, built the way the app builds it: raw search, plus the newest-first freshness lane.
    const lane = async (o: { limit: number; project?: string; since?: number }): Promise<PrimerHit[]> =>
      memoryList({ limit: o.limit, project: o.project, since: o.since }).map((e) => ({
        content: e.content, source: e.source, kind: e.kind, score: 0, id: e.id, project: e.project, ts: e.ts, tags: e.tags,
      }))
    const primer = await buildContextPrimer(memorySearch, { query: 'rename the retry helper', project: 'termpolis', projectPath: 'C:/repos/termpolis', recent: lane })
    expect(primer).toContain('HNSW') // the kept lesson is in it...
    expect(primer).not.toContain('retryHelper.ts') // ...and the held-back one, found by the same query and by the lane, is not
    expect(primer).not.toContain('backoff settings')

    // The tag is a plain word, so it is only honoured on what the lesson writer stored: an agent's own note that
    // happens to carry it is a note like any other and comes back from every door.
    const own = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'Interview candidate shortlist for the retry helper review panel', tags: [CANDIDATE_TAG, 'hiring'], project: 'termpolis' })
    expect(ids(applyEntryCorrections(memoryList({ limit: 50 })))).toContain(own.id)
    expect(ids(applyCorrections(await memorySearch({ query: 'interview candidate shortlist retry helper review panel', limit: 20 })))).toContain(own.id)
    expect(ids(applyEntryCorrections(memoryList({ limit: 50 })))).not.toContain(held.id) // and the real one is still gone
  })

  it('a held-back lesson has no code anchors, so the code locator cannot find it either', async () => {
    const HELD = 'We decided to rename the retry helper in `retryHelper.ts` and to move its backoff settings into the shared options object for the whole sync module family, after the release is out.'
    const resolveCode = (): never[] => [{ file: 'src/retryHelper.ts', symbol: 'retryHelper', symbolId: 's1', projectKey: 'k' }] as never[]
    await onTaskComplete(
      { id: 'task-7', status: 'completed', project: 'termpolis', title: 'tidy the retry helper', result: HELD },
      { ...realDeps(), resolveCode },
    )
    const held = memoryList({ limit: 50 }).find((m) => m.originEpisode === 'task-7')!
    expect(held.tags).toEqual([CANDIDATE_TAG])
    expect(held.codeRefs).toBeUndefined()
    expect(symbolHistory('retryHelper.ts').map((m) => m.id)).not.toContain(held.id)
  })

  it('a failed task records a failure in competence (confidence 0)', async () => {
    await onTaskComplete(
      { id: 'task-2', status: 'failed', project: 'app', title: 'attempt', result: 'Error: still broken after several attempts, giving up here.' },
      realDeps(),
    )
    const comp = assessCompetence('app')
    expect(comp.attempts).toBe(1)
    expect(comp.confidence).toBe(0)
    expect(comp.verdict).toBe('unproven')
  })

  it('does not fire for a non-boundary status', async () => {
    const res = await onTaskComplete({ id: 'task-3', status: 'in_progress', project: 'x', result: 'working on it' }, realDeps())
    expect(res.fired).toBe(false)
    expect(assessCompetence('x').known).toBe(false)
  })
})
