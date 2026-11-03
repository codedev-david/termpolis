import { describe, it, expect, vi } from 'vitest'
import {
  sessionDelta,
  inferOutcome,
  buildSessionEpisode,
  reflectSoloSession,
  hashTurns,
  continueHash,
  EMPTY_CURSOR,
  type SessionCursor,
  type TranscriptDelta,
} from '../../src/main/mnemeSession'
import type { RawTurn } from '../../src/main/mnemeEpisode'

const u = (text: string): RawTurn => ({ role: 'user', text })
const a = (text: string): RawTurn => ({ role: 'assistant', text })

describe('mnemeSession', () => {
  describe('sessionDelta — fresh turns since the last reflection cursor', () => {
    it('treats every turn as fresh on the first pass (empty cursor) and advances the cursor', () => {
      const turns = [u('fix the loader'), a('done, tests pass now')]
      const { fresh, cursor } = sessionDelta(turns, EMPTY_CURSOR)
      expect(fresh).toEqual(turns)
      expect(cursor.count).toBe(2)
      expect(cursor.hash).not.toBe('')
    })

    it('returns no fresh turns when nothing new was appended (idempotent re-read)', () => {
      const turns = [u('fix the loader'), a('done')]
      const first = sessionDelta(turns, EMPTY_CURSOR)
      const second = sessionDelta(turns, first.cursor)
      expect(second.fresh).toEqual([])
      expect(second.cursor).toEqual(first.cursor)
    })

    it('returns only the newly-appended turns when the transcript grew', () => {
      const turns1 = [u('fix the loader'), a('looking into it')]
      const first = sessionDelta(turns1, EMPTY_CURSOR)
      const turns2 = [...turns1, u('any luck?'), a('fixed it, works now')]
      const second = sessionDelta(turns2, first.cursor)
      expect(second.fresh).toEqual([u('any luck?'), a('fixed it, works now')])
      expect(second.cursor.count).toBe(4)
    })

    it('treats ALL turns as fresh when the reflected prefix changed (new/rewritten session)', () => {
      const first = sessionDelta([u('old task'), a('old answer')], EMPTY_CURSOR)
      // Same length, different content under the same cursor count → prefix hash mismatch.
      const replaced = [u('brand new task'), a('brand new answer'), u('more')]
      const second = sessionDelta(replaced, first.cursor)
      expect(second.fresh).toEqual(replaced)
      expect(second.cursor.count).toBe(3)
    })

    it('defaults the previous cursor to empty when none is supplied', () => {
      const turns = [a('hello')]
      const { fresh } = sessionDelta(turns)
      expect(fresh).toEqual(turns)
    })
  })

  describe('inferOutcome — conservative success/failure classification from the final assistant turn', () => {
    it('classifies a passing-tests ending as a successful test outcome', () => {
      expect(inferOutcome([u('run the tests'), a('all tests pass now')])).toEqual({
        kind: 'test',
        success: true,
      })
    })

    it('classifies a commit ending as a successful commit outcome', () => {
      expect(inferOutcome([u('ship it'), a('committed and pushed, done')])).toEqual({
        kind: 'commit',
        success: true,
      })
    })

    it('classifies a generic resolution as a successful manual outcome', () => {
      expect(inferOutcome([u('help'), a('fixed, it works now')])).toEqual({
        kind: 'manual',
        success: true,
      })
    })

    it('classifies an unresolved-error ending as a failed error outcome', () => {
      expect(inferOutcome([u('why broken'), a('still failing, could not fix it')])).toEqual({
        kind: 'error',
        success: false,
      })
    })

    it('returns undefined for a neutral ending (no confident signal → no competence recorded)', () => {
      expect(inferOutcome([u('what is HNSW'), a('it is an approximate nearest-neighbour index')])).toBeUndefined()
    })

    it('returns undefined when success and failure signals are both present (ambiguous)', () => {
      expect(inferOutcome([u('status'), a('fixed the first error but the suite is still failing')])).toBeUndefined()
    })

    it('reads the LAST assistant turn, ignoring a trailing user turn', () => {
      const turns = [u('go'), a('all tests pass now'), u('great, close it')]
      expect(inferOutcome(turns)).toEqual({ kind: 'test', success: true })
    })

    it('returns undefined when there is no assistant turn at all', () => {
      expect(inferOutcome([u('hello'), u('anyone?')])).toBeUndefined()
    })
  })

  describe('buildSessionEpisode — assemble a solo-session episode with an inferred outcome', () => {
    it('sets id/project/source, normalizes the turns, and auto-infers a confident outcome', () => {
      const ep = buildSessionEpisode({
        id: 's1',
        project: 'termpolis',
        source: 'codex',
        turns: [u('fix the bug'), a('fixed, tests pass now')],
      })
      expect(ep.id).toBe('s1')
      expect(ep.project).toBe('termpolis')
      expect(ep.source).toBe('codex')
      expect(ep.turns).toHaveLength(2)
      expect(ep.outcome).toEqual({ kind: 'test', success: true })
    })

    it('omits the outcome for a neutral session (so no competence is recorded downstream)', () => {
      const ep = buildSessionEpisode({
        id: 's2',
        source: 'claude',
        turns: [u('what is a vector db'), a('a store for embeddings')],
      })
      expect(ep.outcome).toBeUndefined()
    })
  })

  describe('reflectSoloSession — orchestrate one solo-session reflection pass', () => {
    const reflectable = (): RawTurn[] => [
      u('the build is broken with a module error'),
      a('fixed it; tests pass now'),
    ]

    function harness(over: Record<string, unknown> = {}) {
      const cursors = new Map<string, SessionCursor>()
      const reflect = vi.fn(async () => ({ fired: true, lessons: 2 }))
      const deps = {
        readTranscript: vi.fn(async () => reflectable()),
        getCursor: (id: string) => cursors.get(id),
        setCursor: (id: string, c: SessionCursor) => {
          cursors.set(id, c)
        },
        reflect,
        ...over,
      }
      return { cursors, reflect, deps }
    }

    it('reflects the fresh turns and advances the cursor on the first pass', async () => {
      const { cursors, reflect, deps } = harness()
      const res = await reflectSoloSession(
        { terminalId: 't1', cwd: 'C:/repo/termpolis', agent: 'codex', project: 'termpolis' },
        deps,
      )
      expect(res).toEqual({ fired: true, lessons: 2 })
      expect(reflect).toHaveBeenCalledTimes(1)
      const ep = reflect.mock.calls[0][0] as { id: string; source?: string; project?: string }
      expect(ep.source).toBe('codex')
      expect(ep.project).toBe('termpolis')
      expect(ep.id).toBe('t1:2')
      expect(cursors.get('t1')?.count).toBe(2)
    })

    it('is a no-op (never calls reflect) when the transcript has no fresh turns', async () => {
      const { reflect, deps } = harness({ readTranscript: vi.fn(async () => []) })
      const res = await reflectSoloSession({ terminalId: 't2', cwd: 'C:/r', agent: 'claude', project: 'r' }, deps)
      expect(res).toEqual({ fired: false, lessons: 0 })
      expect(reflect).not.toHaveBeenCalled()
    })

    it('reflects only newly-appended turns across successive passes (cursor threading)', async () => {
      const { reflect, deps } = harness()
      let transcript = reflectable()
      deps.readTranscript = vi.fn(async () => transcript)
      await reflectSoloSession({ terminalId: 't3', cwd: 'C:/r', agent: 'claude', project: 'r' }, deps)
      transcript = [...transcript, u('one more thing to check here'), a('done, all green now')]
      await reflectSoloSession({ terminalId: 't3', cwd: 'C:/r', agent: 'claude', project: 'r' }, deps)
      expect(reflect).toHaveBeenCalledTimes(2)
      const secondEp = reflect.mock.calls[1][0] as { turns: Array<{ text: string }> }
      expect(secondEp.turns.map((t) => t.text)).toEqual(['one more thing to check here', 'done, all green now'])
    })

    it('does not advance the cursor when reflection throws (turns retry next pass)', async () => {
      const { cursors, deps } = harness({
        reflect: vi.fn(async () => {
          throw new Error('distill boom')
        }),
      })
      await expect(
        reflectSoloSession({ terminalId: 't4', cwd: 'C:/r', agent: 'claude', project: 'r' }, deps),
      ).rejects.toThrow('distill boom')
      expect(cursors.has('t4')).toBe(false)
    })
  })

  // ---- the hot path: read the cursor FIRST, then only what was added after it ------------------
  // reflectSoloSession used to read the WHOLE transcript before it looked at the cursor, hash all of it
  // twice, and only then learn that nothing was new. A delta reader (transcriptDelta.ts) is told the
  // cursor, reads only what came after it, and says what the cursor becomes.

  describe('hashTurns — what a turn contributes to the cursor hash', () => {
    it('uses `content` when a turn has no `text`, and treats a missing role and a missing body as empty', () => {
      expect(hashTurns([{ role: 'user', content: 'hello' }])).toBe(hashTurns([{ role: 'user', text: 'hello' }]))
      expect(hashTurns([{ role: undefined as unknown as string, text: 'hi' }])).toBe(hashTurns([{ role: '', text: 'hi' }]))
      expect(hashTurns([{ role: 'user' }])).toBe(hashTurns([{ role: 'user', text: '' }]))
    })
  })

  describe('continueHash — the cursor hash can be extended without re-reading the prefix', () => {
    const fixtures: RawTurn[][] = [
      [],
      [u('hello')],
      [u('fix the loader'), a('looking into it'), u('any luck?'), a('fixed it, works now')],
      [u('日本語のテキスト 🎉 and ünïcödé'), a('done ✔')],
      [u(''), a(''), u('x')],
    ]

    it('hash(before ++ after) equals continueHash(hash(before), after) for every split of every fixture', () => {
      for (const all of fixtures) {
        for (let split = 0; split <= all.length; split++) {
          const before = all.slice(0, split)
          const after = all.slice(split)
          expect(continueHash(hashTurns(before), after)).toBe(hashTurns(all))
        }
      }
    })

    it('treats the empty cursor hash as the start of a hash', () => {
      const turns = [u('a'), a('b')]
      expect(continueHash(EMPTY_CURSOR.hash, turns)).toBe(hashTurns(turns))
    })

    it('does not move when there is nothing to add', () => {
      expect(continueHash(hashTurns([u('a')]), [])).toBe(hashTurns([u('a')]))
    })

    it('says null for a hash it cannot continue (so the caller reads in full instead of inventing one)', () => {
      expect(continueHash('not-a-hash', [u('a')])).toBeNull()
      expect(continueHash('0123456789', [u('a')])).toBeNull() // more than 32 bits
      expect(continueHash('ABCDEF01', [u('a')])).toBeNull() // the cursor writes lower-case hex
    })

    it('is what sessionDelta produces: the cursor hash of a grown transcript', () => {
      const first = [u('one'), a('two')]
      const grown = [...first, u('three'), a('four')]
      const c1 = sessionDelta(first, EMPTY_CURSOR).cursor
      expect(continueHash(c1.hash, grown.slice(2))).toBe(sessionDelta(grown, c1).cursor.hash)
    })
  })

  describe('reflectSoloSession with a delta reader', () => {
    const reflectable = (): RawTurn[] => [u('the build is broken with a module error'), a('fixed it; tests pass now')]
    const POS = { file: '/p/s.jsonl', size: 100, mtimeMs: 5, offset: 100, anchor: 'abcd', anchorLen: 12 }

    function harness(over: Record<string, unknown> = {}) {
      const calls: string[] = []
      const cursors = new Map<string, SessionCursor>()
      const reflect = vi.fn(async (_episode: unknown) => ({ fired: true, lessons: 1 }))
      const readTranscript = vi.fn(async () => {
        calls.push('readTranscript')
        return reflectable()
      })
      const readDelta = vi.fn(async (): Promise<TranscriptDelta | null> => {
        calls.push('readDelta')
        return { fresh: reflectable(), cursor: { count: 2, hash: 'beef', pos: POS } }
      })
      const deps = {
        readTranscript,
        readDelta,
        getCursor: (id: string) => {
          calls.push('getCursor')
          return cursors.get(id)
        },
        setCursor: (id: string, c: SessionCursor) => {
          calls.push('setCursor')
          cursors.set(id, c)
        },
        reflect,
        ...over,
      }
      return { calls, cursors, reflect, readTranscript, readDelta, deps }
    }
    const input = { terminalId: 't1', cwd: 'C:/r', agent: 'claude', project: 'r' }

    it('reads the cursor before it reads anything, and never reads the whole transcript when the delta reader answers', async () => {
      const { calls, readTranscript, readDelta, deps } = harness()
      const res = await reflectSoloSession(input, deps)
      expect(res).toEqual({ fired: true, lessons: 1 })
      expect(calls.slice(0, 2)).toEqual(['getCursor', 'readDelta'])
      expect(readDelta).toHaveBeenCalledTimes(1)
      expect(readTranscript).not.toHaveBeenCalled()
    })

    it('hands the delta reader the stored cursor, or the empty one when there is none', async () => {
      const first = harness()
      await reflectSoloSession(input, first.deps)
      expect(first.readDelta).toHaveBeenLastCalledWith('C:/r', 'claude', EMPTY_CURSOR)

      const stored: SessionCursor = { count: 7, hash: 'cafe', pos: POS }
      const second = harness()
      second.cursors.set('t1', stored)
      await reflectSoloSession(input, second.deps)
      expect(second.readDelta).toHaveBeenLastCalledWith('C:/r', 'claude', stored)
    })

    it('reflects the delta\'s fresh turns under its count, and stores ITS cursor (byte position and all) after the reflex resolves', async () => {
      const { calls, cursors, reflect, deps } = harness()
      await reflectSoloSession(input, deps)
      const ep = reflect.mock.calls[0][0] as { id: string; turns: Array<{ text: string }> }
      expect(ep.id).toBe('t1:2')
      expect(ep.turns).toHaveLength(2)
      expect(cursors.get('t1')).toEqual({ count: 2, hash: 'beef', pos: POS })
      expect(calls[calls.length - 1]).toBe('setCursor')
    })

    it('an unchanged transcript (no fresh turns) stores the cursor and never reflects', async () => {
      const unchanged: SessionCursor = { count: 4, hash: 'f00d', pos: POS }
      const { cursors, reflect, readTranscript, deps } = harness({
        readDelta: vi.fn(async () => ({ fresh: [], cursor: unchanged })),
      })
      const res = await reflectSoloSession(input, deps)
      expect(res).toEqual({ fired: false, lessons: 0 })
      expect(reflect).not.toHaveBeenCalled()
      expect(readTranscript).not.toHaveBeenCalled()
      expect(cursors.get('t1')).toBe(unchanged)
    })

    it('does not advance the cursor when the reflex throws (those turns come back next pass)', async () => {
      const { cursors, deps } = harness({
        reflect: vi.fn(async () => {
          throw new Error('distill boom')
        }),
      })
      await expect(reflectSoloSession(input, deps)).rejects.toThrow('distill boom')
      expect(cursors.has('t1')).toBe(false)
    })

    it('falls back to reading the whole transcript when the delta reader says null', async () => {
      const { cursors, readTranscript, reflect, deps } = harness({ readDelta: vi.fn(async () => null) })
      const res = await reflectSoloSession(input, deps)
      expect(res).toEqual({ fired: true, lessons: 1 })
      expect(readTranscript).toHaveBeenCalledTimes(1)
      expect(reflect).toHaveBeenCalledTimes(1)
      // the legacy cursor: count + hash of the turns, no byte position
      expect(cursors.get('t1')).toEqual(sessionDelta(reflectable(), EMPTY_CURSOR).cursor)
    })

    it('falls back to the whole transcript when the delta reader throws (it must never cost a reflection)', async () => {
      const { readTranscript, reflect, deps } = harness({
        readDelta: vi.fn(async () => {
          throw new Error('EBUSY')
        }),
      })
      const res = await reflectSoloSession(input, deps)
      expect(res).toEqual({ fired: true, lessons: 1 })
      expect(readTranscript).toHaveBeenCalledTimes(1)
      expect(reflect).toHaveBeenCalledTimes(1)
    })

    it('CONTROL: with no delta reader it is exactly the old order, whole transcript first and the cursor after', async () => {
      const { calls, readTranscript, deps } = harness({ readDelta: undefined })
      const res = await reflectSoloSession(input, deps)
      expect(res).toEqual({ fired: true, lessons: 1 })
      expect(readTranscript).toHaveBeenCalledTimes(1)
      expect(calls.slice(0, 2)).toEqual(['readTranscript', 'getCursor'])
    })

    it('CONTROL: the legacy path still diffs against the stored cursor (reflects only what is new)', async () => {
      const { cursors, reflect, deps } = harness({ readDelta: undefined })
      cursors.set('t1', sessionDelta(reflectable().slice(0, 1), EMPTY_CURSOR).cursor)
      await reflectSoloSession(input, deps)
      const ep = reflect.mock.calls[0][0] as { turns: Array<{ text: string }> }
      expect(ep.turns.map((t) => t.text)).toEqual(['fixed it; tests pass now'])
    })
  })
})
