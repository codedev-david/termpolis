import { describe, it, expect, vi } from 'vitest'
import { runSummarization, defaultSummarize } from '../../src/main/mnemeConsolidateRun'
import type { ConsolEntry } from '../../src/main/mnemeConsolidate'

const ent = (id: string, content: string): ConsolEntry => ({
  id,
  content,
  ts: 1000,
  kind: 'note',
  memoryType: 'episodic',
  importance: 0.3,
  useCount: 0,
  tags: [],
  hasEdges: false,
})

describe('runSummarization — hierarchical summary nodes (P2)', () => {
  it('writes one summary node and part-of links for a near-duplicate cluster', async () => {
    const members = [
      ent('a', 'the widget loader failed'),
      ent('b', 'the widget loader failed again'),
      ent('c', 'widget loader failure once more'),
      ent('d', 'the widget loader keeps failing'),
    ]
    const write = vi.fn().mockResolvedValue({ id: 'sum-1' })
    const links: Array<[string, string, string]> = []
    const res = await runSummarization({
      candidates: () => members,
      simOf: () => 0.95, // all near-duplicates → one cluster of 4
      write,
      link: (f, t, r) => links.push([f, t, r]),
      now: 2000,
    })

    expect(res.summarized).toBe(1)
    expect(write).toHaveBeenCalledTimes(1)
    const wrote = write.mock.calls[0][0]
    expect(wrote.memoryType).toBe('summary')
    expect(wrote.content).toContain('Summary of')
    expect(links).toHaveLength(4)
    expect(links.every(([, to, rel]) => to === 'sum-1' && rel === 'part-of')).toBe(true)
    expect(links.map(([from]) => from).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('does not summarize a cluster below minSize', async () => {
    const members = [ent('a', 'x loader failed'), ent('b', 'x loader failed again')]
    const write = vi.fn().mockResolvedValue({ id: 's' })
    const res = await runSummarization({ candidates: () => members, simOf: () => 0.95, write, link: () => {}, now: 1 })
    expect(res.summarized).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })

  it('is a no-op with no similarity (no clusters)', async () => {
    const members = [ent('a', 'alpha'), ent('b', 'beta'), ent('c', 'gamma'), ent('d', 'delta')]
    const write = vi.fn()
    const res = await runSummarization({ candidates: () => members, simOf: () => 0, write, link: () => {}, now: 1 })
    expect(res.summarized).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })

  it('survives a summary write failure', async () => {
    const members = [ent('a', 'aa'), ent('b', 'bb'), ent('c', 'cc'), ent('d', 'dd')]
    const res = await runSummarization({
      candidates: () => members,
      simOf: () => 0.95,
      write: vi.fn().mockRejectedValue(new Error('disk full')),
      link: () => {},
      now: 1,
    })
    expect(res.summarized).toBe(0)
  })

  it('defaultSummarize produces a bounded, deterministic digest', () => {
    const s = defaultSummarize([ent('a', 'one'), ent('b', 'two'), ent('c', 'three')])
    expect(s).toContain('Summary of 3 related memories')
    expect(s).toContain('- one')
    expect(s).toBe(defaultSummarize([ent('a', 'one'), ent('b', 'two'), ent('c', 'three')]))
  })
})
