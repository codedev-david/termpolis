// @vitest-environment node
// The freshness lane in the parts of a digest that the project block's tests do not reach: a digest with NO project (the flat list) and the
// "other saved context" block. In both, the lane gives a recent passage up for the fuller chunk that begins with it when the digest certainly
// shows that chunk, a hit with no text of its own does not end the block it is in, and the lane never repeats a memory that only one of
// the two searches found.
import { describe, expect, it, vi } from 'vitest'
import { buildContextPrimer, type PrimerHit } from '../../src/main/contextPrimer'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const proj = 'termpolis'
const long = (s: string) => `${s} ${'detail '.repeat(30)}`
const HEAD = long('user: how do I cut a release?\n\nassistant: bump the version and push a tag')
const FULL = `${HEAD}\n\nuser: and the changelog?\n\nassistant: the release workflow writes it`
const chunk = (id: string, content: string, over: Partial<PrimerHit> = {}): PrimerHit =>
  ({ id, content, source: 'claude', kind: 'message', score: 0.8, project: proj, ts: NOW - 3 * HOUR, ...over })
const rows = (out: string | null): string[] => (out ?? '').split('\n').filter((l) => l.startsWith('- ['))
const ranked = (n: number, over: Partial<PrimerHit> = {}) =>
  Array.from({ length: n }, (_, i) => chunk(`p${i}`, long(`unrelated conversation ${i} about ${['alpha', 'beta', 'gamma', 'delta'][i]}`), { score: 0.9 - i * 0.02, ...over }))
const headLane = (over: Partial<PrimerHit> = {}) => vi.fn().mockResolvedValue([
  chunk('head', HEAD, { score: 0, ts: NOW - HOUR, ...over }),
  chunk('next', long('something else entirely from today'), { score: 0, ts: NOW - 2 * HOUR, ...over }),
])

describe('the lane gives a head up for a fuller chunk that the digest certainly shows', () => {
  it('in a digest with no project', async () => {
    const search = vi.fn(async () => [...ranked(2), chunk('full', FULL, { score: 0.8 })].map((h) => ({ ...h, project: undefined })))
    const out = await buildContextPrimer(search, { query: 'q', recent: headLane({ project: undefined }), now: NOW, limit: 4 })
    expect(out!.match(/how do I cut a release/g)).toHaveLength(1)
    expect(out).toContain('the release workflow writes it') // the fuller chunk, in the relevance block
    expect(out).toContain('something else entirely from today') // and the head's lane slot went to the next entry
    expect(rows(out)).toHaveLength(4)
  })

  it('in the "other saved context" block of a digest about a project', async () => {
    // The fuller chunk carries another project's name, so it is not promoted into this project's block.
    const search = vi.fn(async (o: { project?: string }) => (o.project ? ranked(2) : [chunk('full', FULL, { score: 0.95, project: 'other-app' })]))
    const out = await buildContextPrimer(search, { query: 'q', project: proj, recent: headLane(), now: NOW, limit: 4 })
    expect(out!.match(/how do I cut a release/g)).toHaveLength(1)
    expect(out).toContain('the release workflow writes it')
    expect(out).toContain('something else entirely from today')
    expect(rows(out)).toHaveLength(4)
  })
})

describe('a hit with no text of its own to show does not stop the block it is in', () => {
  const blank = (over: Partial<PrimerHit> = {}) => chunk('blank', '   ', { score: 0.95, ...over })

  it('in a digest with no project', async () => {
    const search = vi.fn(async () => [blank(), chunk('a', long('first alpha'), { score: 0.9 }), chunk('b', long('second beta'), { score: 0.85 })].map((h) => ({ ...h, project: undefined })))
    const out = await buildContextPrimer(search, { query: 'q', now: NOW })
    expect(rows(out)).toHaveLength(2)
    expect(out).toContain('second beta')
  })

  it('in the "other saved context" block', async () => {
    const search = vi.fn(async (o: { project?: string }) => (o.project ? [] : [blank({ project: 'other-app' }), chunk('a', long('first alpha'), { score: 0.9, project: 'other-app' }), chunk('b', long('second beta'), { score: 0.85, project: 'other-app' })]))
    const out = await buildContextPrimer(search, { query: 'q', project: proj, now: NOW })
    expect(rows(out)).toHaveLength(2)
    expect(out).toContain('second beta')
  })
})

describe('the lane never repeats a memory that only one of the two searches found', () => {
  const mine = () => chunk('shared', long('a decision only one search found'), { score: 0.9, ts: NOW - 20 * HOUR })
  const laneOf = () => vi.fn().mockResolvedValue([{ ...mine(), score: 0, ts: NOW - HOUR }])

  it('found only by the project search', async () => {
    const search = vi.fn(async (o: { project?: string }) => (o.project ? [mine()] : []))
    const out = await buildContextPrimer(search, { query: 'q', project: proj, recent: laneOf(), now: NOW })
    expect(out!.match(/a decision only one search found/g)).toHaveLength(1)
  })

  it('found only by the unscoped search', async () => {
    const search = vi.fn(async (o: { project?: string }) => (o.project ? [] : [mine()]))
    const out = await buildContextPrimer(search, { query: 'q', project: proj, recent: laneOf(), now: NOW })
    expect(out!.match(/a decision only one search found/g)).toHaveLength(1)
  })
})
