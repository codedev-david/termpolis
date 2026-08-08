import { describe, it, expect, vi } from 'vitest'
import { buildContextPrimer, getLastPrimerCost, recentSlotCount, type PrimerHit } from '../../src/main/contextPrimer'

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
    expect(search).toHaveBeenCalledWith({ query: 'auth', limit: 40 })
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

  it('points the agent at the code_* tools for structural (who-calls / blast-radius) questions', async () => {
    const out = await buildContextPrimer(vi.fn().mockResolvedValue(hits), { query: 'auth' })
    expect(out).toContain('code_explore')
    expect(out).toContain('blast radius')
    expect(out).toContain('over grepping')
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

  it('QW4: a near-duplicate paraphrase does not occupy a second inject slot — backfills with a distinct hit', async () => {
    const mk = (content: string, score: number): PrimerHit => ({ content, kind: 'note', score })
    const search = vi.fn().mockResolvedValue([
      mk('we use HNSW for vector search in the brain', 0.9),
      mk('we use HNSW for the vector lookup in the brain', 0.88), // near-dup paraphrase of #1 (~0.75 Jaccard)
      mk('rate limiting uses a token bucket algorithm', 0.86),
      mk('the deploy pipeline runs on kubernetes', 0.84),
    ])
    const out = await buildContextPrimer(search, { query: 'q', limit: 3 })
    expect(out).toContain('we use HNSW for vector search')
    expect(out).not.toContain('vector lookup')   // near-dup dropped
    expect(out).toContain('rate limiting')
    expect(out).toContain('kubernetes')          // backfilled into the freed slot
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

  it('injects NOTHING when every hit is below the absolute noise bar (#5)', async () => {
    const mk = (content: string, score: number): PrimerHit => ({ content, kind: 'note', score })
    const search = vi.fn().mockResolvedValue([
      mk('low one', 0.2), mk('low two', 0.15), mk('low three', 0.1), mk('low four', 0.05),
    ])
    const out = await buildContextPrimer(search, { query: 'q' })
    // #5: when even the best hit is below the 0.25 noise bar the recall is noise —
    // weak filler anchors the agent and can mislead it, so we inject nothing.
    expect(out).toBeNull()
  })

  it('still surfaces a genuine-but-thin recall via the floor — keeps real hits, drops noise (#5)', async () => {
    const mk = (content: string, score: number): PrimerHit => ({ content, kind: 'note', score })
    const search = vi.fn().mockResolvedValue([
      mk('real one', 0.9), mk('real two', 0.4), mk('real three', 0.3), mk('noise four', 0.05),
    ])
    const out = await buildContextPrimer(search, { query: 'q' })
    expect(out).toContain('real one')
    expect(out).toContain('real three')
    expect(out).not.toContain('noise four')
  })

  it('flags a code memory whose source file no longer exists as STALE (#3)', async () => {
    const search = vi.fn().mockResolvedValue([
      { content: 'C:\\repo\\src\\gone.ts:10-20\nconst x = 1', source: 'code', kind: 'note', score: 0.9 },
    ])
    const out = await buildContextPrimer(search, { query: 'q', fileExists: () => false })
    expect(out).toContain('STALE')
    expect(out).toContain('gone.ts')
  })

  it('does NOT flag a code memory whose source file still exists (#3)', async () => {
    const search = vi.fn().mockResolvedValue([
      { content: '/home/u/repo/here.ts:10-20\nconst x = 1', source: 'code', kind: 'note', score: 0.9 },
    ])
    const out = await buildContextPrimer(search, { query: 'q', fileExists: () => true })
    expect(out).not.toContain('STALE')
    expect(out).toContain('here.ts')
  })

  it('never flags a non-code memory even with a path-like first line (#3)', async () => {
    const search = vi.fn().mockResolvedValue([
      { content: 'C:\\repo\\notes.md:1-5\nsome note', source: 'note', kind: 'note', score: 0.9 },
    ])
    const out = await buildContextPrimer(search, { query: 'q', fileExists: () => false })
    expect(out).not.toContain('STALE')
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
    expect(search).toHaveBeenCalledWith({ query: 'q', limit: 40, project: proj })
    expect(search).toHaveBeenCalledWith({ query: 'q', limit: 40 })
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

// ── Freshness lane ──────────────────────────────────────────────────────────
// Regression cover for "the primer never carries today's work". Relevance ranking
// fuses in recency as a nudge only (alpha 0.25, 30-day half-life), so an hour-old
// memory outranks a 22-day-old one by under 9% — noise against a generic query.
// Measured on a live brain: a primer for this repo returned hits aged 12d–1mo and
// nothing from that same day, while the store held that day's work the whole time.
// The fix is structural: slots RESERVED for a newest-first read, not a bigger nudge.
describe('buildContextPrimer — freshness lane', () => {
  const proj = 'termpolis'
  const NOW = 1_700_000_000_000
  const ago = (ms: number) => NOW - ms
  const HOUR = 3_600_000
  const DAY = 86_400_000

  // Long enough to clear MIN_RECENT_CHARS — short chunks never earn a slot.
  const long = (s: string) => `${s} ${'detail '.repeat(30)}`
  const WORDS = ('installer shortcut taskbar icon overflow description clamp registry sidebar workspace terminal relaunch ' +
    'digest recency window slot budget lister scope repo session boot restore welcome pane shell profile agent memory brain').split(' ')

  const staleSearch = vi.fn(async () => [
    { id: 'old1', content: long('a decision from three weeks ago'), source: 'claude', kind: 'message', score: 0.9, project: proj, ts: ago(22 * DAY) },
    { id: 'old2', content: long('a note from five days ago'), source: 'code', kind: 'note', score: 0.85, project: proj, ts: ago(5 * DAY) },
  ] as PrimerHit[])

  const freshOne = (over: Partial<PrimerHit> = {}): PrimerHit => ({
    id: 'fresh1', content: long('shipped the shortcut icon fix an hour ago'), source: 'claude', kind: 'message', score: 0, project: proj, ts: ago(HOUR), ...over,
  })

  it('injects an hour-old memory that relevance ranking alone would have dropped', async () => {
    const recent = vi.fn().mockResolvedValue([freshOne()])
    const out = await buildContextPrimer(staleSearch, { query: 'q', project: proj, recent, now: NOW })
    expect(out).toContain('shipped the shortcut icon fix an hour ago')
    expect(out).toContain(`Most recent activity here (${proj}, newest first)`)
    expect(out).toContain('1h ago')
    // ...without evicting the relevant older context
    expect(out).toContain('a decision from three weeks ago')
  })

  it('is a pure no-op when no lister is supplied — the old digest, byte for byte', async () => {
    const withLane = await buildContextPrimer(staleSearch, { query: 'q', project: proj, recent: vi.fn().mockResolvedValue([]), now: NOW })
    const without = await buildContextPrimer(staleSearch, { query: 'q', project: proj, now: NOW })
    expect(without).toBe(withLane)
    expect(without).not.toContain('Most recent activity here')
  })

  it('scopes the lane to this repo and bounds it to the freshness window', async () => {
    const recent = vi.fn().mockResolvedValue([freshOne()])
    await buildContextPrimer(staleSearch, { query: 'q', project: proj, projectPath: 'C:/repos/termpolis', recent, now: NOW })
    const arg = recent.mock.calls[0][0]
    expect(arg.project).toBe('C:/repos/termpolis') // the precise path, not the ambiguous slug
    expect(arg.since).toBe(NOW - 7 * DAY)
    expect(arg.limit).toBeGreaterThan(3) // over-fetches: most recent chunks are too short to use
  })

  it('drops anything older than the window even if the lister ignores `since`', async () => {
    const recent = vi.fn().mockResolvedValue([freshOne({ id: 'ancient', content: long('a year-old chat'), ts: ago(400 * DAY) })])
    const out = await buildContextPrimer(staleSearch, { query: 'q', project: proj, recent, now: NOW })
    expect(out).not.toContain('a year-old chat')
    expect(out).not.toContain('Most recent activity here')
  })

  it('skips trivially short chunks rather than spending a slot on them', async () => {
    const recent = vi.fn().mockResolvedValue([
      freshOne({ id: 'tiny', content: 'assistant: Now tests 8 and 9:', ts: ago(HOUR) }),
      freshOne({ id: 'real', content: long('the substantive one'), ts: ago(2 * HOUR) }),
    ])
    const out = await buildContextPrimer(staleSearch, { query: 'q', project: proj, recent, now: NOW })
    expect(out).not.toContain('Now tests 8 and 9')
    expect(out).toContain('the substantive one')
  })

  it('never shows the same memory twice when relevance already picked it', async () => {
    const shared = long('a decision from three weeks ago')
    const recent = vi.fn().mockResolvedValue([{ id: 'old1', content: shared, source: 'claude', kind: 'message', score: 0, project: proj, ts: ago(DAY) }])
    const out = await buildContextPrimer(staleSearch, { query: 'q', project: proj, recent, now: NOW })
    expect(out!.match(/a decision from three weeks ago/g)).toHaveLength(1)
  })

  // Fully disjoint wording per hit — overlapping filler gets collapsed by the diversity
  // pass and the budget assertion would end up measuring THAT instead of the budget.
  const distinct = (i: number) => `relevant hit ${i} ` + Array.from({ length: 12 }, (_, j) => `tok${i}x${j}`).join(' ')

  it('spends from the SAME budget — the digest gets fresher, not bigger', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`, content: distinct(i), source: 'claude', kind: 'message', score: 0.9 - i * 0.01, project: proj, ts: ago(10 * DAY),
    })) as PrimerHit[]
    const recent = vi.fn().mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, content: long(`fresh hit ${i}`), source: 'claude', kind: 'message', score: 0, project: proj, ts: ago(HOUR) })),
    )
    const search = vi.fn(async () => many)
    const withLane = await buildContextPrimer(search, { query: 'q', limit: 6, project: proj, recent, now: NOW })
    const without = await buildContextPrimer(search, { query: 'q', limit: 6, project: proj, now: NOW })
    const count = (s: string | null) => (s!.match(/^- \[/gm) || []).length
    expect(count(withLane)).toBe(count(without))
    expect((withLane!.match(/fresh hit/g) || []).length).toBe(2) // round(6 * 0.3)
  })

  it('caps the lane so a huge digest is not swamped by raw recency', async () => {
    const recent = vi.fn().mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, content: long(`fresh hit ${i}`), source: 'claude', kind: 'message', score: 0, project: proj, ts: ago(HOUR) })),
    )
    const out = await buildContextPrimer(staleSearch, { query: 'q', limit: 50, project: proj, recent, now: NOW })
    expect((out!.match(/fresh hit/g) || []).length).toBe(3) // RECENT_MAX_SLOTS
  })

  it('leaves a one-line digest entirely to relevance', async () => {
    const recent = vi.fn().mockResolvedValue([freshOne()])
    const out = await buildContextPrimer(staleSearch, { query: 'q', limit: 1, project: proj, recent, now: NOW })
    expect(out).not.toContain('Most recent activity here')
    expect(recent).not.toHaveBeenCalled()
  })

  it('survives a lister that throws — a broken lane is not a broken primer', async () => {
    const recent = vi.fn().mockRejectedValue(new Error('memory host down'))
    const out = await buildContextPrimer(staleSearch, { query: 'q', project: proj, recent, now: NOW })
    expect(out).toContain('a decision from three weeks ago')
    expect(out).not.toContain('Most recent activity here')
  })

  it('tolerates a lister that returns nothing at all', async () => {
    const recent = vi.fn().mockResolvedValue(null)
    const out = await buildContextPrimer(staleSearch, { query: 'q', project: proj, recent, now: NOW })
    expect(out).toContain('a decision from three weeks ago')
  })

  it('tolerates a lister that answers with something that is not a list', async () => {
    const recent = vi.fn().mockResolvedValue({ oops: true } as any)
    const out = await buildContextPrimer(staleSearch, { query: 'q', project: proj, recent, now: NOW })
    expect(out).toContain('a decision from three weeks ago')
    expect(out).not.toContain('Most recent activity')
  })

  it('also fills the lane on the flat (no-project) digest, and labels both blocks', async () => {
    const recent = vi.fn().mockResolvedValue([freshOne()])
    const out = await buildContextPrimer(staleSearch, { query: 'q', recent, now: NOW })
    // Unscoped: the lane spans every repo, so the title must NOT say "here".
    expect(out).toContain('Most recent activity (newest first)')
    expect(out).not.toContain('Most recent activity here')
    expect(out).toContain('Other relevant context:')
    expect(out).toContain('shipped the shortcut icon fix an hour ago')
    // The header must stop claiming a pure relevance ordering once the lane leads.
    expect(out).not.toContain('most relevant first')
  })

  it('renders a lane-only digest when relevance finds nothing', async () => {
    const recent = vi.fn().mockResolvedValue([freshOne()])
    const out = await buildContextPrimer(vi.fn(async () => []), { query: 'q', project: proj, recent, now: NOW })
    expect(out).toContain('shipped the shortcut icon fix an hour ago')
    expect(out).not.toContain('This project')
  })

  it('keeps an undated recent entry rather than assuming it is stale', async () => {
    const recent = vi.fn().mockResolvedValue([freshOne({ id: 'nots', ts: undefined, content: long('an entry with no timestamp') })])
    const out = await buildContextPrimer(staleSearch, { query: 'q', project: proj, recent, now: NOW })
    expect(out).toContain('an entry with no timestamp')
  })
})

describe('recentSlotCount', () => {
  it('reserves ~30% of the digest, floored at 1 and capped at 3', () => {
    expect(recentSlotCount(10)).toBe(3)
    expect(recentSlotCount(6)).toBe(2)
    expect(recentSlotCount(3)).toBe(1)
    expect(recentSlotCount(2)).toBe(1)
  })

  it('gives a one-line digest no lane at all — relevance owns the single slot', () => {
    expect(recentSlotCount(1)).toBe(0)
    expect(recentSlotCount(0)).toBe(0)
  })

  it('never takes the last slot from relevance', () => {
    expect(recentSlotCount(2)).toBeLessThan(2)
  })
})
