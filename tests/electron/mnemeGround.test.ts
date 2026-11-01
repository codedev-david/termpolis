import { describe, it, expect, vi } from 'vitest'
import { groundEpisode, lessonToWriteInput } from '../../src/main/mnemeGround'
import type { Episode, Lesson } from '../../src/main/mnemeReflect'
import { CANDIDATE_IMPORTANCE, CANDIDATE_TAG, importanceForScore, lessonSubstance } from '../../src/main/lessonSubstance'

// The lessons below are invented. Their gate scores (lessonSubstance) are noted, because what groundEpisode
// does with a lesson depends on it: >= 2 is written as a keeper, 1 is written held back, < 1 is not written.
const KEEP_A = 'Never call `app.quit()` from the `will-quit` handler because it re-enters the quit sequence.' // 4
const KEEP_B = 'Problem: npm install dies with EACCES on the global prefix. → Fix: set a user-level prefix with `npm config set prefix`.' // 2
const KEEP_C = '`memoryList` caps at 500 rows and has no offset, so page with the `before` cursor.' // 2
const KEEP_D = 'The coverage gate runs only when the Windows job runs, so a branch left uncovered passes in `vitest` locally.' // 3
const HOLD_A = 'Check the defaults in `memorySettings.ts` before changing the primer size.' // 1
const HOLD_B = 'There is a timing issue between the watcher and the writer in `fileWatcher.ts` under load.' // 1
const HOLD_C = '`stdout` is buffered differently in the packaged build than in dev.' // 1
const DROP_A = 'Root cause found.' // announcement
const DROP_B = "I'll start with the failing spec and then look through the logs." // progress
const DROP_C = 'Want me to open the pull request now, or should I wait for the other branch to land?' // nothing in it

const episode = (over: Partial<Episode> = {}): Episode => ({
  id: 'ep-9',
  project: 'termpolis',
  source: 'claude',
  turns: [],
  ...over,
})

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  memoryType: 'procedural',
  kind: 'fact',
  content: KEEP_A,
  entities: [],
  importance: 0.8,
  links: [],
  ...over,
})

describe('mnemeGround — write-and-ground path', () => {
  it('maps a lesson to a grounded write input', () => {
    const wi = lessonToWriteInput(lesson({ content: 'guard nulls', importance: 0.9 }), episode({ id: 'ep-1' }))
    expect(wi).toMatchObject({
      agentId: 'mneme',
      kind: 'fact',
      content: 'guard nulls',
      memoryType: 'procedural',
      importance: 0.9,
      originEpisode: 'ep-1',
      project: 'termpolis',
      source: 'claude', // Wave2: the lesson now carries the authoring agent (episode.source), not a hardcoded 'mneme'
    })
  })

  it('omits project when the episode has none', () => {
    const wi = lessonToWriteInput(lesson(), episode({ project: undefined }))
    expect('project' in wi).toBe(false)
  })

  it('distills and writes each lesson, returning ids', async () => {
    let n = 0
    const write = vi.fn().mockImplementation(async () => ({ id: `mem-${++n}` }))
    const distill = vi.fn().mockResolvedValue([
      lesson({ content: KEEP_A }),
      lesson({ content: KEEP_B, memoryType: 'semantic', kind: 'decision' }),
    ])
    const res = await groundEpisode(episode(), { distill, write })
    expect(res).toEqual({ written: ['mem-1', 'mem-2'], lessons: 2, skipped: 0 })
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1][0]).toMatchObject({ memoryType: 'semantic', kind: 'decision', originEpisode: 'ep-9' })
  })

  it('survives a distiller failure', async () => {
    const res = await groundEpisode(episode(), {
      distill: vi.fn().mockRejectedValue(new Error('boom')),
      write: vi.fn(),
    })
    expect(res).toEqual({ written: [], lessons: 0, skipped: 0 })
  })

  it('skips a lesson whose write throws but keeps the rest', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({ id: 'mem-2' })
    const distill = vi.fn().mockResolvedValue([lesson({ content: KEEP_A }), lesson({ content: KEEP_B })])
    const res = await groundEpisode(episode(), { distill, write })
    // A write that fails is not "skipped": skipped is what the substance gate refused.
    expect(res).toEqual({ written: ['mem-2'], lessons: 2, skipped: 0 })
  })

  it('ignores a write that returns no id', async () => {
    const write = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: 'mem-2' })
    const distill = vi.fn().mockResolvedValue([lesson(), lesson()])
    const res = await groundEpisode(episode(), { distill, write })
    expect(res.written).toEqual(['mem-2'])
  })

  it('returns empty for no lessons', async () => {
    const res = await groundEpisode(episode(), { distill: vi.fn().mockResolvedValue([]), write: vi.fn() })
    expect(res).toEqual({ written: [], lessons: 0, skipped: 0 })
  })
})

// 1.55.0: what a lesson says decides whether it is stored and whether agents ever see it (lessonSubstance.ts).
describe('mnemeGround — the substance gate', () => {
  const scoreOf = (content: string): number => lessonSubstance(content).score

  it('pins the scores the fixtures below stand on', () => {
    expect([KEEP_A, KEEP_B, KEEP_C, KEEP_D].map(scoreOf)).toEqual([4, 2, 2, 3])
    expect([HOLD_A, HOLD_B, HOLD_C].map(scoreOf)).toEqual([1, 1, 1])
    expect([DROP_A, DROP_B, DROP_C].map((c) => scoreOf(c) < 1)).toEqual([true, true, true])
  })

  const mixed = (): Lesson[] => [
    lesson({ content: KEEP_A, importance: 0.95 }),
    lesson({ content: HOLD_A, importance: 0.95 }),
    lesson({ content: DROP_A, importance: 0.95 }),
    lesson({ content: KEEP_B, importance: 0.5 }),
    lesson({ content: HOLD_B }),
    lesson({ content: DROP_B }),
    lesson({ content: KEEP_C, memoryType: 'semantic', kind: 'fact' }),
    lesson({ content: HOLD_C }),
    lesson({ content: DROP_C }),
    lesson({ content: KEEP_D, memoryType: 'semantic', kind: 'decision' }),
  ]

  it('writes exactly the keepers and the held-back band, skips the rest, and says how many', async () => {
    let n = 0
    const write = vi.fn().mockImplementation(async () => ({ id: `mem-${++n}` }))
    const res = await groundEpisode(episode(), { distill: vi.fn().mockResolvedValue(mixed()), write })
    expect(res).toEqual({ written: ['mem-1', 'mem-2', 'mem-3', 'mem-4', 'mem-5', 'mem-6', 'mem-7'], lessons: 10, skipped: 3 })
    expect(write.mock.calls.map((c) => c[0].content)).toEqual([KEEP_A, HOLD_A, KEEP_B, HOLD_B, KEEP_C, HOLD_C, KEEP_D])
    expect(write.mock.calls.map((c) => c[0].content)).not.toContain(DROP_A)
    expect(write.mock.calls.map((c) => c[0].content)).not.toContain(DROP_B)
    expect(write.mock.calls.map((c) => c[0].content)).not.toContain(DROP_C)
  })

  it('sets a keeper\'s importance from its score, not from what the distiller guessed', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    await groundEpisode(episode(), { distill: vi.fn().mockResolvedValue(mixed()), write })
    const keepers = write.mock.calls.map((c) => c[0]).filter((i) => i.tags === undefined)
    expect(keepers.map((i) => i.content)).toEqual([KEEP_A, KEEP_B, KEEP_C, KEEP_D])
    // KEEP_A was 0.95 and KEEP_B was 0.5 from the distiller; both now follow what they say.
    expect(keepers.map((i) => i.importance)).toEqual([importanceForScore(4), importanceForScore(2), importanceForScore(2), importanceForScore(3)])
    expect(keepers.map((i) => i.importance)).toEqual([0.8, 0.6, 0.6, 0.7])
    for (const k of keepers) expect('tags' in k).toBe(false)
  })

  it('stores a held-back lesson at 0.45 under the candidate tag', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    await groundEpisode(episode(), { distill: vi.fn().mockResolvedValue(mixed()), write })
    const held = write.mock.calls.map((c) => c[0]).filter((i) => Array.isArray(i.tags))
    expect(held.map((i) => i.content)).toEqual([HOLD_A, HOLD_B, HOLD_C])
    for (const h of held) {
      expect(h.tags).toEqual([CANDIDATE_TAG])
      expect(h.importance).toBe(CANDIDATE_IMPORTANCE)
      // ...and everything else about the write is unchanged
      expect(h).toMatchObject({ agentId: 'mneme', originEpisode: 'ep-9', project: 'termpolis', source: 'claude' })
    }
  })

  it('gives a held-back lesson no graph presence and no code anchors', async () => {
    let n = 0
    const write = vi.fn().mockImplementation(async () => ({ id: `mem-${++n}` }))
    const link = vi.fn()
    const ensureEntity = vi.fn().mockImplementation(async (name: string) => `ent-${name}`)
    const resolveCode = vi.fn().mockReturnValue([{ file: 'a.ts', symbol: 's', symbolId: 'a.ts#s@1', projectKey: 'k' }])
    await groundEpisode(episode(), {
      distill: vi.fn().mockResolvedValue([
        lesson({ content: HOLD_A, entities: ['memorySettings.ts'], links: [{ to: 'mem-x', relation: 'solves' }], problem: 'ENOENT in `x.ts`' }),
      ]),
      write, link, ensureEntity, resolveCode,
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect('codeRefs' in write.mock.calls[0][0]).toBe(false)
    expect(resolveCode).not.toHaveBeenCalled()
    expect(ensureEntity).not.toHaveBeenCalled()
    expect(link).not.toHaveBeenCalled()
  })

  it('still connects a keeper to its entities and code', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const link = vi.fn()
    const ensureEntity = vi.fn().mockImplementation(async (name: string) => `ent-${name}`)
    const resolveCode = vi.fn().mockReturnValue([{ file: 'a.ts', symbol: 's', symbolId: 'a.ts#s@1', projectKey: 'k' }])
    await groundEpisode(episode(), {
      distill: vi.fn().mockResolvedValue([lesson({ content: KEEP_A, entities: ['app.quit'] })]),
      write, link, ensureEntity, resolveCode,
    })
    expect(write.mock.calls[0][0].codeRefs).toHaveLength(1)
    expect(link).toHaveBeenCalledWith('mem-1', 'ent-app.quit', 'refers-to')
  })

  it('writes nothing for an episode of pure narration, and says so', async () => {
    const write = vi.fn()
    const res = await groundEpisode(episode(), {
      distill: vi.fn().mockResolvedValue([lesson({ content: DROP_A }), lesson({ content: DROP_B }), lesson({ content: DROP_C })]),
      write,
    })
    expect(res).toEqual({ written: [], lessons: 3, skipped: 3 })
    expect(write).not.toHaveBeenCalled()
  })

  it('skips a lesson with no usable text without touching the rest', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const res = await groundEpisode(episode(), {
      distill: vi.fn().mockResolvedValue([lesson({ content: undefined as unknown as string }), lesson({ content: KEEP_A })]),
      write,
    })
    expect(res).toEqual({ written: ['mem-1'], lessons: 2, skipped: 1 })
  })
})

describe('mnemeGround — connections (entity nodes + typed edges)', () => {
  it('links each written lesson to an entity node via refers-to', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const distill = vi.fn().mockResolvedValue([lesson({ entities: ['swarmMemory.ts', 'ENOENT'] })])
    const ensureEntity = vi.fn().mockImplementation(async (name: string) => `ent-${name}`)
    const link = vi.fn()
    await groundEpisode(episode(), { distill, write, ensureEntity, link })
    expect(ensureEntity).toHaveBeenCalledWith('swarmMemory.ts', 'termpolis')
    expect(ensureEntity).toHaveBeenCalledWith('ENOENT', 'termpolis')
    expect(link).toHaveBeenCalledWith('mem-1', 'ent-swarmMemory.ts', 'refers-to')
    expect(link).toHaveBeenCalledWith('mem-1', 'ent-ENOENT', 'refers-to')
  })

  it('creates typed edges for resolved lesson links (with a target)', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-7' })
    const distill = vi.fn().mockResolvedValue([lesson({ links: [{ to: 'mem-bug', relation: 'solves' }] })])
    const link = vi.fn()
    await groundEpisode(episode(), { distill, write, link })
    expect(link).toHaveBeenCalledWith('mem-7', 'mem-bug', 'solves')
  })

  it('ignores links that have no resolved target', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-7' })
    const distill = vi.fn().mockResolvedValue([lesson({ links: [{ relation: 'solves' }] })])
    const link = vi.fn()
    await groundEpisode(episode(), { distill, write, link })
    expect(link).not.toHaveBeenCalled()
  })

  it('is best-effort: an entity/link failure never breaks the batch', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const distill = vi.fn().mockResolvedValue([lesson({ entities: ['x'], links: [{ to: 'y', relation: 'solves' }] })])
    const ensureEntity = vi.fn().mockRejectedValue(new Error('nope'))
    const link = vi.fn().mockImplementation(() => { throw new Error('graph down') })
    const res = await groundEpisode(episode(), { distill, write, ensureEntity, link })
    expect(res).toEqual({ written: ['mem-1'], lessons: 1, skipped: 0 })
  })

  it('works without link/ensureEntity deps (back-compat, no edges)', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const distill = vi.fn().mockResolvedValue([lesson({ entities: ['a'], links: [{ to: 'b', relation: 'solves' }] })])
    const res = await groundEpisode(episode(), { distill, write })
    expect(res).toEqual({ written: ['mem-1'], lessons: 1, skipped: 0 })
  })
})

// v1.23 C3 — the automatic causal layer. A procedural fix lesson emits a targetless
// {relation:'solves'} (the distiller can't resolve the target); connectLesson now resolves
// it to `solves` edges pointing at the PROBLEM's entities, so bug→fix is traversable.
describe('mnemeGround — automatic causal (solves) edges (C3)', () => {
  it('mints solves edges to the problem entities of a procedural fix lesson', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const distill = vi.fn().mockResolvedValue([
      lesson({
        content: 'Problem: crash with ENOENT in `loader.ts` → Fix: guard the path',
        problem: 'crash with ENOENT in `loader.ts`',
        entities: ['other.ts'],
        links: [{ relation: 'solves' }], // targetless — the dead path we now resolve
      }),
    ])
    const ensureEntity = vi.fn().mockImplementation(async (name: string) => `ent-${name}`)
    const link = vi.fn()
    await groundEpisode(episode(), { distill, write, ensureEntity, link })

    // refers-to for the lesson's own entities (unchanged)
    expect(link).toHaveBeenCalledWith('mem-1', 'ent-other.ts', 'refers-to')
    // solves to each entity naming the problem (the revived causal layer)
    expect(link).toHaveBeenCalledWith('mem-1', 'ent-loader.ts', 'solves')
    expect(link).toHaveBeenCalledWith('mem-1', 'ent-ENOENT', 'solves')
  })

  it('does not mint a solves edge when the lesson has no solves link', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const distill = vi.fn().mockResolvedValue([
      lesson({ memoryType: 'semantic', kind: 'decision', problem: 'crash with ENOENT', links: [] }),
    ])
    const ensureEntity = vi.fn().mockImplementation(async (name: string) => `ent-${name}`)
    const link = vi.fn()
    await groundEpisode(episode(), { distill, write, ensureEntity, link })
    expect(link).not.toHaveBeenCalledWith('mem-1', expect.anything(), 'solves')
  })

  it('does not mint solves edges without an ensureEntity dep (needs the entity node)', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const distill = vi.fn().mockResolvedValue([
      lesson({ problem: 'crash with ENOENT', links: [{ relation: 'solves' }] }),
    ])
    const link = vi.fn()
    await groundEpisode(episode(), { distill, write, link }) // no ensureEntity
    expect(link).not.toHaveBeenCalled()
  })

  it('skips the solves edge when the entity ensurer returns null (no crash)', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const distill = vi.fn().mockResolvedValue([lesson({ problem: 'ENOENT in `x.ts`', links: [{ relation: 'solves' }] })])
    const ensureEntity = vi.fn().mockResolvedValue(null) // unresolved → no edge
    const link = vi.fn()
    const res = await groundEpisode(episode(), { distill, write, ensureEntity, link })
    expect(res).toEqual({ written: ['mem-1'], lessons: 1, skipped: 0 })
    expect(link).not.toHaveBeenCalledWith('mem-1', expect.anything(), 'solves')
  })

  it('survives a throwing ensureEntity / link in the causal loop (best-effort)', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const distill = vi.fn().mockResolvedValue([
      lesson({ problem: 'ENOENT in `x.ts`', entities: ['x.ts'], links: [{ relation: 'solves' }] }),
    ])
    const ensureEntity = vi.fn().mockRejectedValue(new Error('graph down'))
    const link = vi.fn(() => { throw new Error('edge down') })
    const res = await groundEpisode(episode(), { distill, write, ensureEntity, link })
    expect(res).toEqual({ written: ['mem-1'], lessons: 1, skipped: 0 })
  })
})

// v1.23 C2 — grounding stamps the memory<->code bridge: a lesson's entities are resolved to
// structured code anchors (via an injected resolver) and written onto the memory.
describe('mnemeGround — code anchor stamping (C2 bridge)', () => {
  it('stamps codeRefs resolved from the lesson entities onto the write input', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const distill = vi.fn().mockResolvedValue([lesson({ entities: ['reflowForMessage', 'exportTerminal.ts'] })])
    const resolveCode = vi.fn().mockReturnValue([
      { file: 'src/exportTerminal.ts', symbol: 'reflowForMessage', symbolId: 'src/exportTerminal.ts#reflowForMessage@1', projectKey: 'k1' },
    ])
    await groundEpisode(episode(), { distill, write, resolveCode })
    expect(resolveCode).toHaveBeenCalledWith(['reflowForMessage', 'exportTerminal.ts'], 'termpolis')
    expect(write.mock.calls[0][0].codeRefs).toEqual([
      { file: 'src/exportTerminal.ts', symbol: 'reflowForMessage', symbolId: 'src/exportTerminal.ts#reflowForMessage@1', projectKey: 'k1' },
    ])
  })

  it('omits codeRefs when the resolver finds nothing, and survives a resolver that throws', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const distill = vi.fn().mockResolvedValue([lesson({ entities: ['NoSuchThing'] })])
    const empty = await groundEpisode(episode(), { distill, write, resolveCode: vi.fn().mockReturnValue([]) })
    expect('codeRefs' in write.mock.calls[0][0]).toBe(false)
    expect(empty).toEqual({ written: ['mem-1'], lessons: 1, skipped: 0 })

    write.mockClear()
    const res = await groundEpisode(episode(), { distill, write, resolveCode: vi.fn(() => { throw new Error('graph down') }) })
    expect(res).toEqual({ written: ['mem-1'], lessons: 1, skipped: 0 }) // best-effort — lesson still stored
  })
})
