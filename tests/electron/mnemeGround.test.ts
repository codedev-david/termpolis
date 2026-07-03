import { describe, it, expect, vi } from 'vitest'
import { groundEpisode, lessonToWriteInput } from '../../src/main/mnemeGround'
import type { Episode, Lesson } from '../../src/main/mnemeReflect'

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
  content: 'do the thing',
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
      source: 'mneme',
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
      lesson({ content: 'a' }),
      lesson({ content: 'b', memoryType: 'semantic', kind: 'decision' }),
    ])
    const res = await groundEpisode(episode(), { distill, write })
    expect(res).toEqual({ written: ['mem-1', 'mem-2'], lessons: 2 })
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1][0]).toMatchObject({ memoryType: 'semantic', kind: 'decision', originEpisode: 'ep-9' })
  })

  it('survives a distiller failure', async () => {
    const res = await groundEpisode(episode(), {
      distill: vi.fn().mockRejectedValue(new Error('boom')),
      write: vi.fn(),
    })
    expect(res).toEqual({ written: [], lessons: 0 })
  })

  it('skips a lesson whose write throws but keeps the rest', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({ id: 'mem-2' })
    const distill = vi.fn().mockResolvedValue([lesson({ content: 'x' }), lesson({ content: 'y' })])
    const res = await groundEpisode(episode(), { distill, write })
    expect(res).toEqual({ written: ['mem-2'], lessons: 2 })
  })

  it('ignores a write that returns no id', async () => {
    const write = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: 'mem-2' })
    const distill = vi.fn().mockResolvedValue([lesson(), lesson()])
    const res = await groundEpisode(episode(), { distill, write })
    expect(res.written).toEqual(['mem-2'])
  })

  it('returns empty for no lessons', async () => {
    const res = await groundEpisode(episode(), { distill: vi.fn().mockResolvedValue([]), write: vi.fn() })
    expect(res).toEqual({ written: [], lessons: 0 })
  })
})

describe('mnemeGround — connections (entity nodes + typed edges)', () => {
  it('links each written lesson to an entity node via refers-to', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const distill = vi.fn().mockResolvedValue([lesson({ content: 'fix', entities: ['swarmMemory.ts', 'ENOENT'] })])
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
    expect(res).toEqual({ written: ['mem-1'], lessons: 1 })
  })

  it('works without link/ensureEntity deps (back-compat, no edges)', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'mem-1' })
    const distill = vi.fn().mockResolvedValue([lesson({ entities: ['a'], links: [{ to: 'b', relation: 'solves' }] })])
    const res = await groundEpisode(episode(), { distill, write })
    expect(res).toEqual({ written: ['mem-1'], lessons: 1 })
  })
})
