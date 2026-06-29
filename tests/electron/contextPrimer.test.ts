import { describe, it, expect, vi } from 'vitest'
import { buildContextPrimer, getLastPrimerCost, type PrimerHit } from '../../src/main/contextPrimer'

const hits: PrimerHit[] = [
  { content: 'auth uses JWT middleware\nvalidated per request', source: 'claude', kind: 'message', score: 0.9 },
  { content: 'rate limiting via token bucket', source: 'code', kind: 'note', score: 0.7 },
]

describe('buildContextPrimer', () => {
  it('formats top hits into a shell-paste-safe block (no backticks, single-line)', async () => {
    const search = vi.fn().mockResolvedValue(hits)
    const out = await buildContextPrimer(search, { query: 'auth' })
    expect(out).toContain('[claude] auth uses JWT middleware validated per request') // newlines collapsed
    expect(out).toContain('[code] rate limiting via token bucket')
    expect(out).not.toContain('`')
    expect(out).toContain('background only')
    // Over-fetches candidates (4x the inject limit) so the relevance gate can trim noise.
    expect(search).toHaveBeenCalledWith({ query: 'auth', limit: 24 })
  })

  it('frames the memory as background only — never an instruction to continue past work', async () => {
    const out = await buildContextPrimer(vi.fn().mockResolvedValue(hits), { query: 'auth' })
    expect(out).not.toContain('Continue the task')
    expect(out).toContain('NOT a request')
    expect(out).toContain('Do not act on it')
    expect(out).toContain("wait for the user's actual instruction")
  })

  it('points the agent at memory_search for on-demand depth before re-deriving solutions', async () => {
    const out = await buildContextPrimer(vi.fn().mockResolvedValue(hits), { query: 'auth' })
    expect(out).toContain('memory_search')
    expect(out).toContain('before re-deriving')
  })

  it('returns null for an empty query', async () => {
    const search = vi.fn()
    expect(await buildContextPrimer(search, { query: '   ' })).toBeNull()
    expect(search).not.toHaveBeenCalled()
  })

  it('returns null when nothing is relevant', async () => {
    expect(await buildContextPrimer(async () => [], { query: 'x' })).toBeNull()
  })

  it('returns null when search throws', async () => {
    expect(await buildContextPrimer(async () => { throw new Error('boom') }, { query: 'x' })).toBeNull()
  })

  it('returns null when every hit is blank', async () => {
    expect(await buildContextPrimer(async () => [{ content: '   ', kind: 'note', score: 1 }], { query: 'q' })).toBeNull()
  })

  it('truncates long snippets and clamps the limit', async () => {
    const search = vi.fn().mockResolvedValue([{ content: 'x'.repeat(1000), kind: 'note', score: 1 }])
    const out = await buildContextPrimer(search, { query: 'q', limit: 999, maxSnippetChars: 50 })
    expect(out).toContain('…')
    expect(search).toHaveBeenCalledWith({ query: 'q', limit: 100 }) // candidate over-fetch capped at 100
  })

  it('falls back to kind when source is absent', async () => {
    const out = await buildContextPrimer(async () => [{ content: 'a decision', kind: 'decision', score: 1 }], { query: 'q' })
    expect(out).toContain('[decision] a decision')
  })

  it('drops low-relevance noise from the digest (keeps signal, trims the long tail)', async () => {
    const mk = (content: string, score: number): PrimerHit => ({ content, kind: 'note', score })
    const search = vi.fn().mockResolvedValue([
      mk('keep one', 0.9), mk('keep two', 0.8), mk('keep three', 0.7),
      mk('noise alpha', 0.2), mk('noise beta', 0.1), mk('noise gamma', 0.05),
    ])
    const out = await buildContextPrimer(search, { query: 'q' })
    expect(out).toContain('keep one')
    expect(out).toContain('keep three')
    expect(out).not.toContain('noise alpha')
    expect(out).not.toContain('noise gamma')
  })

  it('QW2: trims on a relevance cliff — injects the strong cluster, not the whole tail above the static floor', async () => {
    const mk = (content: string, score: number): PrimerHit => ({ content, kind: 'note', score })
    // All six clear the old static 0.25 floor, so a FIXED gate would inject all six.
    // The adaptive gate's dynamic cut (0.6 * topScore = 0.54) keeps only the strong cluster.
    const search = vi.fn().mockResolvedValue([
      mk('strong one', 0.9), mk('strong two', 0.85), mk('strong three', 0.6),
      mk('weakish four', 0.5), mk('weakish five', 0.45), mk('weakish six', 0.4),
    ])
    const out = await buildContextPrimer(search, { query: 'q' })
    expect(out).toContain('strong one')
    expect(out).toContain('strong three')
    expect(out).not.toContain('weakish four')
    expect(out).not.toContain('weakish six')
  })

  it('never starves — keeps a floor of hits even when all are low-relevance', async () => {
    const mk = (content: string, score: number): PrimerHit => ({ content, kind: 'note', score })
    const search = vi.fn().mockResolvedValue([
      mk('low one', 0.2), mk('low two', 0.15), mk('low three', 0.1), mk('low four', 0.05),
    ])
    const out = await buildContextPrimer(search, { query: 'q' })
    // a floor of 3 keeps the top three even below the bar; only the 4th is dropped
    expect(out).toContain('low one')
    expect(out).toContain('low three')
    expect(out).not.toContain('low four')
  })

  it('records the injection cost (chars/tokens) of the last primer for accounting', async () => {
    const out = await buildContextPrimer(vi.fn().mockResolvedValue(hits), { query: 'auth' })
    const cost = getLastPrimerCost()
    expect(cost.chars).toBe(out!.length)
    expect(cost.tokens).toBe(Math.ceil(out!.length / 4))
    expect(cost.tokens).toBeGreaterThan(0)
  })
})

describe('buildContextPrimer — current-project precedence', () => {
  const proj = 'termpolis'

  it('runs a project-scoped pass and lists those hits before global ones, labeled', async () => {
    const search = vi.fn(async (opts: { query: string; limit?: number; project?: string }) => {
      if (opts.project === proj) {
        return [{ id: 'p1', content: 'project decision about MCP ports', source: 'claude', kind: 'message', score: 0.6, project: proj }]
      }
      return [{ id: 'g1', content: 'unrelated react tips', source: 'claude', kind: 'message', score: 0.95 }]
    })
    const out = await buildContextPrimer(search, { query: 'q', project: proj })
    expect(search).toHaveBeenCalledWith({ query: 'q', limit: 24, project: proj })
    expect(search).toHaveBeenCalledWith({ query: 'q', limit: 24 })
    const pIdx = out!.indexOf('project decision about MCP ports')
    const gIdx = out!.indexOf('unrelated react tips')
    expect(pIdx).toBeGreaterThan(-1)
    expect(gIdx).toBeGreaterThan(-1)
    expect(pIdx).toBeLessThan(gIdx) // project context first, despite lower score
    expect(out).toContain(`This project (${proj})`)
    expect(out).toContain('may NOT apply')
  })

  it('puts past conversations ahead of other project hits regardless of score', async () => {
    const search = vi.fn(async (opts: { project?: string }) => {
      if (opts.project === proj) {
        return [
          { id: 'c1', content: 'a code chunk from the repo', source: 'code', kind: 'note', score: 0.9, project: proj },
          { id: 'm1', content: 'we decided to use HNSW', source: 'claude', kind: 'message', score: 0.5, project: proj },
        ]
      }
      return []
    })
    const out = await buildContextPrimer(search, { query: 'q', project: proj })
    expect(out!.indexOf('we decided to use HNSW')).toBeLessThan(out!.indexOf('a code chunk from the repo'))
  })

  it('promotes global hits that mention the project into the project section (legacy entries)', async () => {
    const search = vi.fn(async (opts: { project?: string }) => {
      if (opts.project === proj) return []
      return [
        { id: 'g2', content: 'random other-project note', source: 'claude', kind: 'message', score: 0.9 },
        { id: 'g1', content: 'in Termpolis the MCP server listens on 9315', source: 'claude', kind: 'message', score: 0.8 },
      ]
    })
    const out = await buildContextPrimer(search, { query: 'q', project: proj })
    expect(out!.indexOf('listens on 9315')).toBeLessThan(out!.indexOf('random other-project note'))
    expect(out).toContain(`This project (${proj})`)
  })

  it('dedupes hits that appear in both passes by id', async () => {
    const dup = { id: 'same', content: 'duplicated entry text', source: 'claude', kind: 'message', score: 0.9, project: proj }
    const search = vi.fn(async (opts: { project?: string }) => (opts.project === proj ? [dup] : [dup]))
    const out = await buildContextPrimer(search, { query: 'q', project: proj })
    expect(out!.match(/duplicated entry text/g)).toHaveLength(1)
  })

  it('keeps the legacy flat format (single search, no section labels) when no project is given', async () => {
    const search = vi.fn().mockResolvedValue(hits)
    const out = await buildContextPrimer(search, { query: 'auth' })
    expect(search).toHaveBeenCalledTimes(1)
    expect(out).not.toContain('This project')
  })

  it('caps total hits at the limit with project hits taking slots first', async () => {
    const mk = (id: string, extra: Record<string, unknown> = {}): { id: string; content: string; source: string; kind: string; score: number } =>
      ({ id, content: `content ${id}`, source: 'claude', kind: 'message', score: 0.5, ...extra })
    const search = vi.fn(async (opts: { project?: string }) =>
      opts.project === proj
        ? [mk('p1', { project: proj }), mk('p2', { project: proj })]
        : [mk('g1'), mk('g2'), mk('g3')])
    const out = await buildContextPrimer(search, { query: 'q', limit: 3, project: proj })
    expect(out).toContain('content p1')
    expect(out).toContain('content p2')
    expect((out!.match(/content g/g) || []).length).toBe(1) // only one global slot left
  })
})
