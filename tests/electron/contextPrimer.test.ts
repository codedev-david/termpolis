import { describe, it, expect, vi } from 'vitest'
import { buildContextPrimer, getLastPrimerCost, recentSlotCount, type PrimerHit } from '../../src/main/contextPrimer'
import { projectKeyOf } from '../../src/main/projectKey'
import { KEEP_SCORE, lessonSubstance } from '../../src/main/lessonSubstance'

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

  it('tells the agent a recalled excerpt can be read on, and that memory is no proof of the present', async () => {
    const out = await buildContextPrimer(vi.fn().mockResolvedValue(hits), { query: 'auth' })
    expect(out).toContain('memory_graph with its id and relation "follows" reads on, "precedes" reads back')
    expect(out).toContain('on this computer, not what is true now: verify anything you rely on')
    // Still plain text an agent's shell can take: no backticks.
    expect(out).not.toContain('`')
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

  // buildContextPrimer never throws. A row the lister hands back that is not a passage (no text, text that is not a string, not even an
  // object) is skipped, wherever in the list it is: the lane looks at every row it was given, not only the first few.
  it.each([
    ['a number for its text', { id: 'bad', content: 123 }],
    ['an object for its text', { id: 'bad', content: { text: 'x' } }],
    ['no text', { id: 'bad' }],
    ['null', null],
    ['text instead of a row', 'oops'],
  ])('skips a row with %s and still shows the good ones around it', async (_name, bad) => {
    const recent = vi.fn().mockResolvedValue([freshOne({ id: 'a' }), bad, freshOne({ id: 'b', content: long('the second good line of the lane') })] as any)
    const out = await buildContextPrimer(staleSearch, { query: 'q', project: proj, recent, now: NOW })
    expect(out).toContain('shipped the shortcut icon fix an hour ago')
    expect(out).toContain('the second good line of the lane')
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

// 1.55: a lesson the substance gate stores but holds back carries the `candidate` tag and is never shown
// to an agent. The primer is the largest thing an agent is ever shown, and three of its four callers search
// the store directly, so the primer keeps the promise itself rather than trusting its caller to.
describe('buildContextPrimer — lessons the substance gate holds back', () => {
  const proj = 'termpolis'
  const NOW = 1_700_000_000_000
  const long = (s: string) => `${s} ${'detail '.repeat(30)}`
  const KEPT = 'we decided to keep the retry queue in memory'
  const HELD = 'timing issue between the watcher and the writer under load'

  const mk = (id: string, content: string, over: Partial<PrimerHit> = {}): PrimerHit =>
    ({ id, content, source: 'claude', kind: 'message', score: 0.8, project: proj, ts: NOW - 3_600_000, ...over })

  it('never shows a held-back hit from the project search', async () => {
    const search = vi.fn(async (opts: { project?: string }) =>
      opts.project === proj ? [mk('k', KEPT), mk('h', HELD, { tags: ['candidate'] })] : [])
    const out = await buildContextPrimer(search, { query: 'q', project: proj, now: NOW })
    expect(out).toContain(KEPT)
    expect(out).not.toContain(HELD)
  })

  it('never shows one from the global search, flat or scoped', async () => {
    const search = vi.fn(async () => [mk('k', KEPT, { project: undefined }), mk('h', HELD, { project: undefined, tags: ['candidate'] })])
    const flat = await buildContextPrimer(search, { query: 'q', now: NOW })
    expect(flat).toContain(KEPT)
    expect(flat).not.toContain(HELD)
    const scoped = await buildContextPrimer(search, { query: 'q', project: proj, now: NOW })
    expect(scoped).toContain(KEPT)
    expect(scoped).not.toContain(HELD)
  })

  it('never shows one in the freshness lane', async () => {
    const recent = vi.fn().mockResolvedValue([
      mk('h', long(HELD), { tags: ['candidate'], score: 0 }),
      mk('r', long('the substantive recent one'), { score: 0 }),
    ])
    const out = await buildContextPrimer(vi.fn(async () => []), { query: 'q', project: proj, recent, now: NOW })
    expect(out).toContain('the substantive recent one')
    expect(out).not.toContain(HELD)
  })

  it('gives the lane slot to the next real entry instead of leaving it empty', async () => {
    const recent = vi.fn().mockResolvedValue([
      mk('h1', long('held back one'), { tags: ['candidate'], score: 0 }),
      mk('h2', long('held back two'), { tags: ['candidate'], score: 0 }),
      mk('r1', long('real recent one'), { score: 0 }),
    ])
    const out = await buildContextPrimer(vi.fn(async () => []), { query: 'q', project: proj, recent, now: NOW })
    expect(out).toContain('real recent one')
    expect(out).not.toContain('held back')
  })

  it('still shows a note an agent tagged "candidate" itself, in a search and in the lane', async () => {
    const OWN = 'interview notes: the candidate shortlist for the platform team'
    const search = vi.fn(async (opts: { project?: string }) =>
      opts.project === proj ? [mk('own', OWN, { agentId: 'claude', tags: ['candidate'] }), mk('h', HELD, { agentId: 'mneme', tags: ['candidate'] })] : [])
    const recent = vi.fn().mockResolvedValue([
      mk('own2', long('a second note an agent tagged candidate'), { agentId: 'codex', tags: ['candidate'], score: 0 }),
      mk('h2', long('held back one'), { agentId: 'mneme', tags: ['candidate'], score: 0 }),
    ])
    const out = await buildContextPrimer(search, { query: 'q', project: proj, recent, now: NOW })
    expect(out).toContain(OWN)
    expect(out).toContain('a second note an agent tagged candidate')
    expect(out).not.toContain(HELD)
    expect(out).not.toContain('held back one')
  })

  it('is the old digest, byte for byte, when nothing is held back', async () => {
    const plain = [mk('a', KEPT), mk('b', 'we decided to keep the cache small', { tags: ['note:x'] })]
    const withTags = await buildContextPrimer(vi.fn(async () => plain), { query: 'q', project: proj, now: NOW })
    const withoutTags = await buildContextPrimer(vi.fn(async () => plain.map(({ tags: _t, ...h }) => h)), { query: 'q', project: proj, now: NOW })
    expect(withTags).toBe(withoutTags)
    expect(withTags).toContain('keep the cache small')
  })

  it('returns no digest at all when everything it found is held back', async () => {
    const search = vi.fn(async () => [mk('h', HELD, { tags: ['candidate'] })])
    expect(await buildContextPrimer(search, { query: 'q', now: NOW })).toBeNull()
  })
})

// Claude Code's saved notes (claudeNotesIngest.ts) are stored with source and author `claude-notes`, under the
// project of the folder they came from. They lead their own project's block, read as "note", and never reach
// another project's primer: this digest is injected without anyone asking for it.
describe('buildContextPrimer — Claude Code\'s saved notes', () => {
  const proj = 'termpolis'
  const NOW = 1_700_000_000_000
  const DAY = 86_400_000
  const long = (s: string) => `${s} ${'detail '.repeat(30)}`

  const note = (id: string, content: string, over: Partial<PrimerHit> = {}): PrimerHit =>
    ({ id, content, source: 'claude-notes', agentId: 'claude-notes', kind: 'fact', score: 0.7, project: proj, ts: NOW - 52 * DAY, tags: ['type:reference', 'note:x.md'], ...over })
  const chunk = (id: string, content: string, over: Partial<PrimerHit> = {}): PrimerHit =>
    ({ id, content, source: 'claude', agentId: 'claude-history', kind: 'message', score: 0.9, project: proj, ts: NOW - 3_600_000, ...over })
  const build = (list: PrimerHit[], extra: Record<string, unknown> = {}) =>
    buildContextPrimer(vi.fn(async () => list), { query: 'q', project: proj, now: NOW, ...extra })

  it('leads the project block, ahead of past conversations that scored higher', async () => {
    const out = (await build([chunk('c1', 'a conversation about the cache'), chunk('c2', 'another conversation'), note('n1', 'Invalidate the cache on write, never on a timer')]))!
    const lines = out.split('\n').filter((l) => l.startsWith('- ['))
    expect(lines[0]).toContain('Invalidate the cache on write')
    expect(lines[0]).toMatch(/^- \[note · 1mo ago\]/) // the note's last edit, labelled as a note
    expect(out.indexOf('Invalidate the cache')).toBeLessThan(out.indexOf('a conversation about the cache'))
  })

  it('says so in the block\'s title only when a note is shown', async () => {
    const withNote = (await build([chunk('c1', 'a conversation'), note('n1', 'a saved note')]))!
    expect(withNote).toContain(`This project (${proj}) — saved notes, then past conversations:`)
    const without = (await build([chunk('c1', 'a conversation')]))!
    expect(without).toContain(`This project (${proj}) — past conversations first:`)
  })

  it('keeps a score-ordered run of notes in the order the search gave them', async () => {
    const out = (await build([chunk('c1', 'conversation one'), note('n1', 'first note'), note('n2', 'second note')]))!
    expect(out.indexOf('first note')).toBeLessThan(out.indexOf('second note'))
    expect(out.indexOf('second note')).toBeLessThan(out.indexOf('conversation one'))
  })

  it('never shows another project\'s note, from the project search or the global one', async () => {
    const mine = note('n1', 'a note about this project')
    const theirs = note('n2', 'a note about the billing project', { project: 'billing' })
    const search = vi.fn(async (opts: { project?: string }) => (opts.project === proj ? [mine, theirs] : [theirs, chunk('c1', 'some other conversation', { project: 'billing' })]))
    const out = (await buildContextPrimer(search, { query: 'q', project: proj, now: NOW }))!
    expect(out).toContain('a note about this project')
    expect(out).not.toContain('billing project')
    expect(out).toContain('some other conversation') // other projects\' conversations still appear, labelled as before
  })

  it('shows no note at all to a primer that names no project', async () => {
    const out = await buildContextPrimer(vi.fn(async () => [note('n1', 'a note about this project'), chunk('c1', 'a conversation', { project: undefined })]), { query: 'q', now: NOW })
    expect(out).toContain('a conversation')
    expect(out).not.toContain('a note about this project')
    expect(await buildContextPrimer(vi.fn(async () => [note('n1', 'only a note')]), { query: 'q', now: NOW })).toBeNull()
  })

  // The freshness lane lists the newest rows with no score and no project filter of its own when the digest names no
  // project (memory_primer without a cwd, the Memory panel's Inject with no terminal open), and a note's date is its last
  // edit, so a note touched in the last week is among the newest rows of ANY project. A note belongs to the project it was
  // written in, in the lane as in a search.
  describe('in the freshness lane', () => {
    const lane = (rows: PrimerHit[]) => vi.fn().mockResolvedValue(rows)
    const recentNote = (id: string, text: string, over: Partial<PrimerHit> = {}) =>
      note(id, long(text), { score: 0, ts: NOW - 3_600_000, ...over })

    it('never shows another project\'s note, of any type, to a primer that names no project', async () => {
      const recent = lane([
        recentNote('n1', 'how we onboard the other client', { project: 'other-app', tags: ['type:project', 'note:a.md'] }),
        recentNote('n2', 'where the other client keeps its keys', { project: 'other-app' }),
        chunk('c1', long('a conversation from today'), { score: 0, project: undefined }),
      ])
      const out = (await buildContextPrimer(vi.fn(async () => []), { query: 'q', recent, now: NOW }))!
      expect(out).toContain('a conversation from today')
      expect(out).not.toContain('how we onboard the other client')
      expect(out).not.toContain('where the other client keeps its keys')
      expect(await buildContextPrimer(vi.fn(async () => []), { query: 'q', recent: lane([recentNote('n3', 'only a note', { project: 'other-app' })]), now: NOW })).toBeNull()
    })

    it('never shows another project\'s note to a primer about this project', async () => {
      const recent = lane([
        recentNote('n1', 'how we onboard the other client', { project: 'other-app' }),
        chunk('c1', long('shipped the first fix'), { score: 0, ts: NOW - 2 * 3_600_000 }),
      ])
      const out = (await buildContextPrimer(vi.fn(async () => []), { query: 'q', project: proj, recent, now: NOW }))!
      expect(out).not.toContain('how we onboard the other client')
      expect(out).toContain('shipped the first fix')
    })

    it('tells two repos with the same folder name apart in the lane too, by key', async () => {
      const recent = lane([recentNote('n1', 'the other termpolis checkout', { projectKey: 'not-this-repos-key' })])
      expect(await buildContextPrimer(vi.fn(async () => []), { query: 'q', project: proj, projectPath: 'C:/work/termpolis', recent, now: NOW })).toBeNull()
    })

    it('still shows this project\'s own recent note, labelled as one', async () => {
      const recent = lane([recentNote('n1', 'the note I edited an hour ago')])
      const out = (await buildContextPrimer(vi.fn(async () => []), { query: 'q', project: proj, recent, now: NOW }))!
      expect(out).toMatch(/- \[note · 1h ago\] the note I edited an hour ago/)
    })

    // A note stored in several chunks has one date for all of them (its last edit) and starts every chunk with its name and
    // description, and the store lists equal dates newest-stored first. Chunk by chunk, one long note filled the whole lane
    // with the same opening three times, last part first, and pushed the conversations out.
    describe('a note stored in several chunks', () => {
      const part = (i: number, over: Partial<PrimerHit> = {}) => recentNote(`p${i}`, `plan.md, part ${i} of 3`, { tags: ['type:project', 'note:plan.md'], ...over })
      const conversations = [
        chunk('c1', long('a conversation from this morning'), { score: 0, ts: NOW - 2 * 3_600_000 }),
        chunk('c2', long('the conversation before it'), { score: 0, ts: NOW - 3 * 3_600_000 }),
      ]
      const digest = async (rows: PrimerHit[]) => (await buildContextPrimer(vi.fn(async () => []), { query: 'q', project: proj, recent: lane(rows), now: NOW }))!

      it('takes one line of the lane, and leaves the others to the conversations', async () => {
        const out = await digest([part(3), part(2), part(1), ...conversations])
        expect(out.match(/\[note · 1h ago\]/g)).toHaveLength(1)
        expect(out).toContain('a conversation from this morning')
        expect(out).toContain('the conversation before it')
      })

      it('leaves a second note its own line', async () => {
        const other = recentNote('o1', 'ops.md, the only part', { tags: ['type:reference', 'note:ops.md'], ts: NOW - 1.5 * 3_600_000 })
        const out = await digest([part(3), part(2), part(1), other, ...conversations])
        expect(out.match(/- \[note ·/g)).toHaveLength(2)
        expect(out).toContain('plan.md, part 3 of 3') // the first one listed stands for the note
        expect(out).not.toContain('plan.md, part 2 of 3')
        expect(out).toContain('ops.md, the only part')
        expect(out).toContain('a conversation from this morning')
      })

      it('holds only the importer\'s rows to one line: a memory an agent tagged like a note is not one', async () => {
        const faux = (i: number) => recentNote(`f${i}`, `agent memory ${i}`, { agentId: 'claude', tags: ['type:project', 'note:plan.md'], ts: NOW - i * 3_600_000 })
        const out = await digest([faux(1), faux(2), faux(3)])
        for (const i of [1, 2, 3]) expect(out).toContain(`agent memory ${i}`)
      })

      it('counts a chunk with no file tag, or with another file\'s, as a note of its own', async () => {
        const out = await digest([part(2), part(1, { tags: ['type:project', 'note:other.md'] }), recentNote('bare', 'no file tag at all', { tags: undefined }), ...conversations])
        expect(out.match(/- \[note ·/g)).toHaveLength(3)
      })
    })
  })

  it('compares projects without regard to case', async () => {
    const out = (await build([note('n1', 'a note', { project: 'Termpolis' })]))!
    expect(out).toContain('a note')
  })

  // Two repos can share a folder name ("api", "app"): the slug cannot tell an employer's from a personal one,
  // the key of the full path can. A note carrying a different key than the cwd's is another project's.
  describe('two projects with the same folder name', () => {
    const MINE = 'C:\\work\\termpolis'
    const mineKey = projectKeyOf(MINE)
    const otherKey = projectKeyOf('D:\\personal\\termpolis')

    it('the note whose key is this folder\'s is shown, the other\'s is not', async () => {
      const list = [note('n1', 'a note about my termpolis', { projectKey: mineKey }), note('n2', 'a note about the other termpolis', { projectKey: otherKey })]
      const out = (await build(list, { projectPath: MINE }))!
      expect(out).toContain('a note about my termpolis')
      expect(out).not.toContain('the other termpolis')
    })

    it('falls back to the folder name when either side has no key (an older entry, or a primer with no full path)', async () => {
      const keyless = note('n1', 'a note with no key')
      expect((await build([keyless], { projectPath: MINE }))!).toContain('a note with no key')
      const keyed = note('n2', 'a note with a key', { projectKey: otherKey })
      expect((await build([keyed]))!).toContain('a note with a key') // no projectPath: nothing to compare the key with
      expect((await build([note('n3', 'a note for the wrong folder name', { project: 'billing', projectKey: mineKey })], { projectPath: MINE }))).toBeNull()
    })

    it('ignores a blank full path', async () => {
      expect((await build([note('n1', 'a note', { projectKey: otherKey })], { projectPath: '   ' }))!).toContain('a note')
    })
  })

  it('does not take something that merely carries the note source for a note: the author has to be the importer', async () => {
    const spoof = note('s1', 'a memory an agent filed under the notes source', { agentId: 'claude', project: 'billing' })
    const out = (await build([spoof, chunk('c1', 'a conversation')]))!
    expect(out).toContain('a memory an agent filed') // not a note: treated like any other hit
    expect(out).toContain('[claude-notes ·') // and labelled as the source it claims
  })

  it('shows a recently edited note in the freshness lane as a note', async () => {
    const recent = vi.fn().mockResolvedValue([note('n9', long('a note edited an hour ago'), { score: 0, ts: NOW - 3_600_000 })])
    const out = (await buildContextPrimer(vi.fn(async () => []), { query: 'q', project: proj, recent, now: NOW }))!
    expect(out).toMatch(/- \[note · 1h ago\] a note edited an hour ago/)
  })

  it('keeps the old title and the old order when there are no notes (the older tests above pin the rest, byte for byte)', async () => {
    const list = [chunk('c1', 'we decided to use HNSW'), chunk('c2', 'a code chunk', { source: 'code', kind: 'note', score: 0.5 })]
    const out = (await build(list))!
    expect(out).toContain(`This project (${proj}) — past conversations first:`)
    expect(out.indexOf('we decided to use HNSW')).toBeLessThan(out.indexOf('a code chunk'))
  })
})

// 1.55: inside the project block the digest leads with what its author vouched for. Saved notes come first (at most
// three), then lessons the substance gate vouches for (at most two), then past conversations, then the rest; every one
// of them from the same relevance-gated set and inside the same line and character budget as before.
describe('buildContextPrimer — notes, then lessons the gate vouches for, then conversations', () => {
  const proj = 'termpolis'
  const NOW = 1_700_000_000_000
  const DAY = 86_400_000
  const HOUR = 3_600_000

  // Lessons the gate keeps (score 5, 4 and exactly the bar of 2) and ones it would not.
  const G1 = 'The installer check fails with ENOENT because `winget` is not on PATH inside the sandbox, so call it by its full path.'
  const G2 = 'Never run `git worktree remove --force` while node_modules is a junction, because it deletes through the link.'
  const G3 = 'Always run the full suite and not only the touched files, because new modules that import fs broke unrelated suites.'
  const J1 = 'Root cause found.'
  const J2 = 'Next: I will check the build tomorrow and then update the plan.'

  it('uses lessons the gate really does keep and drop', () => {
    for (const g of [G1, G2, G3]) expect(lessonSubstance(g).score).toBeGreaterThanOrEqual(KEEP_SCORE)
    expect(lessonSubstance(G3).score).toBe(KEEP_SCORE)
    for (const j of [J1, J2]) expect(lessonSubstance(j).score).toBeLessThan(KEEP_SCORE)
  })

  const note = (id: string, content: string, over: Partial<PrimerHit> = {}): PrimerHit =>
    ({ id, content, source: 'claude-notes', agentId: 'claude-notes', kind: 'fact', score: 0.7, project: proj, ts: NOW - 52 * DAY, tags: ['type:reference', `note:${id}.md`], ...over })
  const lesson = (id: string, content: string, over: Partial<PrimerHit> = {}): PrimerHit =>
    ({ id, content, source: 'claude', agentId: 'mneme', kind: 'fact', memoryType: 'procedural', importance: 0.8, score: 0.7, project: proj, ts: NOW - 3 * DAY, ...over })
  // Wording of its own, so the diversity pass keeps every conversation.
  const conv = (n: number, over: Partial<PrimerHit> = {}): PrimerHit =>
    ({ id: `c${n}`, content: `conversation ${n} alpha${n} beta${n} gamma${n} delta${n}`, source: 'claude', agentId: 'claude-history', kind: 'message', score: 0.9, project: proj, ts: NOW - 5 * HOUR, ...over })
  const code = (over: Partial<PrimerHit> = {}): PrimerHit =>
    ({ id: 'code1', content: 'src/main/cache.ts:1-40 export const cache = new Map()', source: 'code', agentId: 'code-index', kind: 'note', score: 0.6, project: proj, ts: NOW - 5 * HOUR, ...over })
  const asked = (list: PrimerHit[], elsewhere: PrimerHit[] = []) => vi.fn(async (o: { project?: string }) => (o.project ? list : elsewhere))
  const build = (list: PrimerHit[], extra: Record<string, unknown> = {}, elsewhere: PrimerHit[] = []) =>
    buildContextPrimer(asked(list, elsewhere), { query: 'q', project: proj, now: NOW, fileExists: () => true, ...extra })
  const rows = (out: string | null): string[] => (out ?? '').split('\n').filter((l) => l.startsWith('- ['))
  /** Positions of the markers in the digest: every one found, and in the order given. */
  const inOrder = (out: string | null, marks: string[]): void => {
    const at = marks.map((m) => (out ?? '').indexOf(m))
    expect(at.every((p) => p >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  }
  const recentOne = (id: string, text: string, ago: number): PrimerHit =>
    ({ id, content: `${text} ${'detail '.repeat(30)}`, source: 'claude', kind: 'message', score: 0, project: proj, ts: NOW - ago })

  // The doc's scenario: seven conversations, two kept lessons, one demoted lesson, two notes.
  const crowd = (): PrimerHit[] => [
    ...[0.9, 0.88, 0.86, 0.84, 0.82, 0.8, 0.55].map((s, i) => conv(i + 1, { score: s })),
    note('n1', 'Invalidate the cache on write, never on a timer', { score: 0.75 }),
    note('n2', 'Run the full suite, not only the touched files', { score: 0.72 }),
    lesson('g1', G1, { score: 0.7 }),
    lesson('g2', G2, { score: 0.68 }),
    lesson('d1', G3, { score: 0.75 * 0.35, correction: { kind: 'demote' } }), // the overlay already scaled it
  ]

  it('puts the notes first, then the two kept lessons, then the conversations, within the line budget', async () => {
    const out = await build(crowd())
    inOrder(out, ['Invalidate the cache on write', 'Run the full suite, not only', 'installer check fails', 'worktree remove --force', 'conversation 1 ', 'conversation 2 '])
    expect(rows(out)).toHaveLength(10) // the default limit; the seventh conversation fell to the cap, the demoted lesson to the cut
    expect(out).not.toContain('Always run the full suite and not only') // the demoted lesson is absent
    expect(out).not.toContain('conversation 7 ')
  })

  it('lets the order decide who is cut when the lane has taken three of the ten slots', async () => {
    const recent = vi.fn().mockResolvedValue([recentOne('r1', 'shipped the first fix', HOUR), recentOne('r2', 'wired the check', 2 * HOUR), recentOne('r3', 'wrote the docs', 3 * HOUR)])
    const out = await build(crowd(), { recent })
    const project = (out ?? '').split('This project')[1]
    inOrder(project, ['Invalidate the cache', 'Run the full suite, not only', 'installer check fails', 'worktree remove --force', 'conversation 1 ', 'conversation 2 ', 'conversation 3 '])
    expect(project).not.toContain('conversation 4 ') // seven slots: two notes, two lessons, three conversations
    expect(rows(out)).toHaveLength(10)
  })

  it('reads the lessons as lessons, with their age, and the notes as notes', async () => {
    const out = (await build(crowd()))!
    expect(out).toMatch(/- \[lesson · 3d ago\] The installer check fails/)
    expect(out).toMatch(/- \[note · 1mo ago\] Invalidate the cache on write/)
    expect(out).toMatch(/- \[claude · 5h ago\] conversation 1 /)
  })

  // The lesson writer files a lesson as a decision, a fact or a note, by what the extractor made of it: the kind says nothing
  // about whether it is one. Only the memory type and the text do.
  it('treats a kept lesson of any kind as one', async () => {
    for (const kind of ['decision', 'fact', 'note']) {
      const out = await build([conv(1, { score: 0.9 }), lesson('k1', G1, { kind, score: 0.5 })])
      inOrder(out, ['installer check fails', 'conversation 1 '])
      expect(out).toMatch(/- \[lesson · 3d ago\] The installer check fails/)
    }
  })

  it('keeps the rest of the block when a hit has no text of its own to show', async () => {
    const out = await build([conv(1, { score: 0.95, content: '   ' }), conv(2, { score: 0.9 }), conv(3, { score: 0.85 })])
    expect(out).toContain('conversation 2 ')
    expect(out).toContain('conversation 3 ')
    expect(rows(out)).toHaveLength(2)
  })

  it('puts this project\'s own results ahead of a legacy hit promoted into the project, whatever the promoted one scored', async () => {
    // The project search is the better evidence that a memory belongs here; a hit only the unscoped search found, and
    // that merely says the project's name, comes after it even when it scored higher.
    const out = await build([conv(1, { score: 0.8 })], {}, [conv(2, { score: 0.95, project: undefined, content: `conversation 2 about ${proj} alpha2 beta2 gamma2 delta2` })])
    inOrder(out, ['conversation 1 ', 'conversation 2 about'])
  })

  it('treats a kept lesson of either type as one: a fact filed as semantic leads, and so does a rule filed as procedural', async () => {
    const out = await build([conv(1, { score: 0.9 }), lesson('s1', G1, { memoryType: 'semantic', score: 0.5 }), lesson('p1', G2, { memoryType: 'procedural', score: 0.45 })])
    inOrder(out, ['installer check fails', 'worktree remove --force', 'conversation 1 '])
    expect(out).toMatch(/- \[lesson · 3d ago\] The installer check fails/)
    expect(out).toMatch(/- \[lesson · 3d ago\] Never run `git worktree remove --force`/)
  })

  it('titles the block for what leads it', async () => {
    const both = (await build([conv(1), note('n1', 'a note'), lesson('g1', G1)]))!
    expect(both).toContain(`This project (${proj}) — saved notes, lessons learned, then past conversations:`)
    const onlyLessons = (await build([conv(1), lesson('g1', G1)]))!
    expect(onlyLessons).toContain(`This project (${proj}) — lessons learned, then past conversations:`)
    const onlyNotes = (await build([conv(1), note('n1', 'a note')]))!
    expect(onlyNotes).toContain(`This project (${proj}) — saved notes, then past conversations:`)
    const neither = (await build([conv(1), code()]))!
    expect(neither).toContain(`This project (${proj}) — past conversations first:`)
  })

  it('fills as many lines as the same hits do when nothing marks a note or a lesson, so the order spends nothing', async () => {
    const hits = crowd()
    // The same hits with nothing to tell a note or a lesson from a conversation chunk: what a digest holds without the new order.
    const plain = hits.map((h) => ({ ...h, source: 'claude', agentId: 'claude-history', kind: 'message', memoryType: undefined, tags: undefined }) as PrimerHit)
    const out = await build(hits)
    const base = await build(plain)
    expect(rows(out)).toHaveLength(rows(base).length)
    expect(rows(out).length).toBeLessThanOrEqual(10)
    const widest = (o: string | null): number => Math.max(...rows(o).map((r) => r.length))
    expect(widest(out)).toBeLessThanOrEqual(widest(base) + 'lesson'.length - 'claude'.length)
    // The character budget: the same memories, so the same snippets, in the lines of the same total length or shorter (a note's
    // label is shorter than a conversation's, a lesson's the same).
    const snippets = (o: string | null): string[] => rows(o).map((r) => r.replace(/^- \[[^\]]*\] /, '')).sort()
    const chars = (o: string | null): number => rows(o).reduce((n, r) => n + r.length, 0)
    expect(snippets(out)).toEqual(snippets(base))
    expect(chars(out)).toBeLessThanOrEqual(chars(base))
  })

  it('keeps every line to the same snippet length: a note or a lesson is not given more room than a conversation', async () => {
    const wide = 'x'.repeat(900)
    const out = await build([note('n1', `note ${wide}`), lesson('g1', `${G1} ${wide}`), conv(1, { content: `conversation ${wide}` })], { maxSnippetChars: 100 })
    for (const r of rows(out)) expect(r.length).toBeLessThanOrEqual(100 + '- [lesson · 3d ago] '.length + 1) // the snippet and its ellipsis, behind the label
  })

  describe('the caps', () => {
    it('lets three notes lead, and the notes after them rank with the conversations by relevance', async () => {
      const list = [
        note('n1', 'first note', { score: 0.9 }), note('n2', 'second note', { score: 0.85 }), note('n3', 'third note', { score: 0.8 }),
        conv(1, { score: 0.78 }), note('n4', 'fourth note', { score: 0.75 }), note('n5', 'fifth note', { score: 0.7 }), conv(2, { score: 0.6 }),
      ]
      inOrder(await build(list), ['first note', 'second note', 'third note', 'conversation 1 ', 'fourth note', 'fifth note', 'conversation 2 '])
    })

    it('lets two kept lessons lead, and a third ranks with the conversations by relevance', async () => {
      const list = [lesson('g1', G1, { score: 0.9 }), lesson('g2', G2, { score: 0.85 }), conv(1, { score: 0.8 }), lesson('g3', G3, { score: 0.75 }), conv(2, { score: 0.6 })]
      inOrder(await build(list), ['installer check fails', 'worktree remove --force', 'conversation 1 ', 'Always run the full suite and not only', 'conversation 2 '])
    })

    it('counts the notes and the lessons separately', async () => {
      const list = [conv(1), lesson('g1', G1), lesson('g2', G2), lesson('g3', G3), note('n1', 'a note one'), note('n2', 'a note two'), note('n3', 'a note three'), note('n4', 'a note four')]
      const lines = rows(await build(list, { limit: 20 }))
      expect(lines.slice(0, 5).map((l) => l.slice(2, 8))).toEqual(['[note ', '[note ', '[note ', '[lesso', '[lesso'])
    })
  })

  describe('what is not promoted', () => {
    it('does not lead with a lesson the gate would not keep, and reads it as it always did', async () => {
      const out = await build([lesson('j1', J1, { score: 0.95 }), lesson('j2', J2, { score: 0.9 }), conv(1, { score: 0.5 })])
      inOrder(out, ['conversation 1 ', 'Root cause found.', 'Next: I will check'])
      expect(out).toMatch(/- \[claude · 3d ago\] Root cause found\./)
    })

    it('does not lead with a demoted lesson, however it scores, and does not call it a lesson', async () => {
      const out = await build([lesson('d1', G1, { score: 0.9, correction: { kind: 'demote' } }), lesson('g2', G2, { score: 0.4 }), conv(1, { score: 0.5 })])
      inOrder(out, ['worktree remove --force', 'conversation 1 ', 'installer check fails'])
      expect(out).toMatch(/- \[claude · 3d ago\] The installer check fails/)
    })

    it('judges an amended lesson on the text that replaced it', async () => {
      const kept = await build([conv(1, { score: 0.9 }), lesson('a1', G2, { score: 0.5, correction: { kind: 'amend' } })])
      inOrder(kept, ['worktree remove --force', 'conversation 1 '])
      const thin = await build([conv(1, { score: 0.9 }), lesson('a2', J1, { score: 0.5, correction: { kind: 'amend' } })])
      inOrder(thin, ['conversation 1 ', 'Root cause found.'])
    })

    it('does not take a memory of another type for a lesson, whatever it says', async () => {
      const list = [conv(1, { score: 0.9 }), lesson('s1', G1, { memoryType: 'summary', score: 0.5 }), lesson('e1', G2, { memoryType: undefined, score: 0.45 })]
      const out = await build(list)
      inOrder(out, ['conversation 1 ', 'installer check fails', 'worktree remove --force'])
      expect(out).not.toContain('[lesson')
    })

    it('does not lift a lesson from another project into this one\'s block', async () => {
      const out = await build([conv(1)], {}, [lesson('o1', G1, { project: 'billing', score: 0.9 })])
      const [mine, others] = (out ?? '').split('Other saved context (may NOT apply to this project):')
      expect(mine).not.toContain('installer check fails')
      expect(others).toContain('installer check fails')
    })
  })

  it('leaves a digest with no project in the order of the search, but still reads a kept lesson as one', async () => {
    const out = await buildContextPrimer(vi.fn(async () => [conv(1, { score: 0.9, project: undefined }), lesson('g1', G1, { score: 0.8, project: undefined }), conv(2, { score: 0.7, project: undefined })]), { query: 'q', now: NOW })
    inOrder(out, ['conversation 1 ', 'installer check fails', 'conversation 2 '])
    expect(out).toMatch(/- \[lesson · 3d ago\] The installer check fails/)
  })

  it('reads a kept lesson in the freshness lane as one too', async () => {
    const recent = vi.fn().mockResolvedValue([lesson('g1', `${G1} ${'detail '.repeat(20)}`, { score: 0, ts: NOW - HOUR })])
    const out = await buildContextPrimer(vi.fn(async () => []), { query: 'q', project: proj, recent, now: NOW })
    expect(out).toMatch(/- \[lesson · 1h ago\] The installer check fails/)
  })
})

// 1.55: the freshness lane is a newest-first LISTING, the one read that skipped every filter a search applies. The
// listing (primerLane.ts) takes out what a person retracted and what a later memory supersedes; what is left for the
// builder is what it can judge from the hit itself: a memory the overlay marked as corrected, and one that belongs to no
// project at all, only to an automated run.
describe('buildContextPrimer — what the freshness lane leaves out', () => {
  const proj = 'termpolis'
  const NOW = 1_700_000_000_000
  const HOUR = 3_600_000
  const long = (s: string) => `${s} ${'detail '.repeat(30)}`
  const fresh = (id: string, text: string, over: Partial<PrimerHit> = {}): PrimerHit =>
    ({ id, content: long(text), source: 'claude', kind: 'message', score: 0, project: proj, ts: NOW - HOUR, ...over })
  const lane = (list: PrimerHit[], extra: Record<string, unknown> = {}) =>
    buildContextPrimer(vi.fn(async () => []), { query: 'q', recent: vi.fn().mockResolvedValue(list), now: NOW, ...extra })
  const rows = (out: string | null): string[] => (out ?? '').split('\n').filter((l) => l.startsWith('- ['))

  describe('a memory someone has corrected', () => {
    it('is not shown, whatever the correction, and the slot goes to the next entry', async () => {
      const out = await lane([
        fresh('r', 'was retracted but the lister still gave it', { correction: { kind: 'retract' } }),
        fresh('d', 'was demoted as unreliable', { correction: { kind: 'demote' } }),
        fresh('a', 'was amended to something else', { correction: { kind: 'amend' } }),
        fresh('ok', 'is fine and recent', { ts: NOW - 2 * HOUR }),
      ], { project: proj })
      expect(rows(out)).toHaveLength(1)
      expect(out).toContain('is fine and recent')
    })

    it('does not stop the same memory from being shown by relevance, where the overlay already ranked it', async () => {
      const demoted = { id: 'd', content: long('was demoted as unreliable'), source: 'claude', kind: 'message', score: 0.9, project: proj, ts: NOW - HOUR, correction: { kind: 'demote' } } as PrimerHit
      const out = await buildContextPrimer(vi.fn(async (o: { project?: string }) => (o.project ? [demoted] : [])), { query: 'q', project: proj, now: NOW, recent: vi.fn().mockResolvedValue([]) })
      expect(out).toContain('was demoted as unreliable')
    })
  })

  describe('the lane and the budget', () => {
    it('takes its slots from the same budget when no project is given: the relevance block yields them', async () => {
      const hits = [0.9, 0.88, 0.86, 0.84].map((score, i) =>
        ({ id: `r${i}`, content: `relevant ${i} alpha${i} beta${i} gamma${i} delta${i}`, source: 'claude', kind: 'message', score, ts: NOW - 5 * HOUR }) as PrimerHit)
      const out = await buildContextPrimer(vi.fn(async () => hits), { query: 'q', limit: 4, now: NOW, recent: vi.fn().mockResolvedValue([fresh('f1', 'the newest thing')]) })
      expect(rows(out)).toHaveLength(4) // one lane line and three relevance lines: the fourth hit does not fit
      expect(out).toContain('Other relevant context:')
      expect(out).toContain('the newest thing')
      expect(out).not.toContain('relevant 3 ')
    })

    it('gives a listed row that has no text at all no slot, so the row after it still gets the only one', async () => {
      const textless = { id: 'x', source: 'claude', kind: 'message', score: 0, project: proj, ts: NOW - HOUR } as unknown as PrimerHit
      const out = await lane([textless, fresh('ok', 'has text', { ts: NOW - 2 * HOUR })], { project: proj, limit: 4 }) // a digest of four has one lane slot
      expect(rows(out)).toHaveLength(1)
      expect(out).toContain('has text')
    })
  })

  describe('an automated run\'s memory', () => {
    it('is not shown in a digest that spans every project: the literal `cwd` a smoke test left behind, and scratch folders', async () => {
      const out = await lane([
        fresh('s1', 'reply with the word pong and nothing else, from a smoke run', { project: 'cwd' }),
        fresh('s2', 'a one-off run in a scratch folder', { project: 'tmp' }),
        fresh('s3', 'another one-off in a temp folder', { project: 'Temp' }),
        fresh('real', 'work in an actual repository', { project: 'billing', ts: NOW - 2 * HOUR }),
        fresh('none', 'a memory that names no project', { project: undefined, ts: NOW - 3 * HOUR }),
      ])
      expect(rows(out)).toHaveLength(2)
      expect(out).toContain('work in an actual repository')
      expect(out).toContain('a memory that names no project')
      expect(out).not.toContain('smoke run')
      expect(out).not.toContain('scratch folder')
      expect(out).not.toContain('temp folder')
    })

    it('is still shown when it is the project the digest is about: a repo really called temp', async () => {
      const out = await lane([fresh('own', 'work in the repo that happens to be called temp', { project: 'temp' })], { project: 'temp' })
      expect(out).toContain('work in the repo that happens to be called temp')
    })

    it('is not mistaken for a project that merely starts the same way', async () => {
      const out = await lane([fresh('w', 'work in a repo called cwd-tools', { project: 'cwd-tools' }), fresh('x', 'work in a repo called template', { project: 'template' })])
      expect(rows(out)).toHaveLength(2)
    })
  })
})

// 1.55: the ingest pass stores the trailing partial chunk of a live session, and a later pass stores the fuller chunk
// that begins with the same turns. One search returns both, and so does the freshness lane (the newest chunks are
// where they pile up). The digest says it once, in the fuller chunk, whichever block each one landed in.
describe('buildContextPrimer — a chunk and the fuller chunk that begins with it', () => {
  const proj = 'termpolis'
  const NOW = 1_700_000_000_000
  const HOUR = 3_600_000
  const long = (s: string) => `${s} ${'detail '.repeat(30)}`
  const HEAD = long('user: how do I cut a release?\n\nassistant: bump the version and push a tag')
  const FULL = `${HEAD}\n\nuser: and the changelog?\n\nassistant: the release workflow writes it`
  const chunk = (id: string, content: string, over: Partial<PrimerHit> = {}): PrimerHit =>
    ({ id, content, source: 'claude', kind: 'message', score: 0.8, project: proj, ts: NOW - 3 * HOUR, ...over })
  const OTHER = chunk('other', 'we keep the retry queue in memory and flush it on exit', { score: 0.8 })
  const rows = (out: string | null): string[] => (out ?? '').split('\n').filter((l) => l.startsWith('- ['))
  const asked = (list: PrimerHit[]) => vi.fn(async (o: { project?: string }) => (o.project ? list : []))

  it('shows the fuller chunk once and not the head of it', async () => {
    const out = await buildContextPrimer(asked([chunk('head', HEAD, { score: 0.9 }), chunk('full', FULL, { score: 0.7 }), OTHER]), { query: 'q', project: proj, now: NOW })
    expect(rows(out)).toHaveLength(2)
    expect(out!.match(/how do I cut a release/g)).toHaveLength(1)
    expect(out).toContain('the release workflow writes it')
  })

  it('lets the fuller chunk keep the head\'s better score, so the relevance cliff does not take the passage away', async () => {
    const top = chunk('top', 'something else entirely about caching and invalidation rules', { score: 0.95 })
    const out = await buildContextPrimer(asked([top, chunk('head', HEAD, { score: 0.9 }), chunk('full', FULL, { score: 0.4 })]), { query: 'q', project: proj, now: NOW, maxSnippetChars: 2000 })
    expect(out).toContain('the release workflow writes it') // 0.4 alone is under 0.6 x 0.95 and would have been cut
    expect(out!.match(/how do I cut a release/g)).toHaveLength(1)
  })

  it('does the same in a digest with no project', async () => {
    const out = await buildContextPrimer(vi.fn(async () => [chunk('head', HEAD, { score: 0.9 }), chunk('full', FULL, { score: 0.7 }), OTHER]), { query: 'q', now: NOW })
    expect(rows(out)).toHaveLength(2)
    expect(out!.match(/how do I cut a release/g)).toHaveLength(1)
  })

  it('shows the fuller chunk once when only the unscoped search found the head of it, and the project search the fuller chunk', async () => {
    // The two searches rank the same corpus on different candidate sets, so a head can reach one list and its fuller chunk the other.
    const search = vi.fn(async (o: { project?: string }) => (o.project ? [chunk('full', FULL, { score: 0.9 }), OTHER] : [chunk('head', HEAD, { score: 0.85 })]))
    const out = await buildContextPrimer(search, { query: 'q', project: proj, now: NOW, maxSnippetChars: 2000 })
    expect(rows(out).filter((r) => r.includes('how do I cut a release'))).toHaveLength(1)
    expect(out).toContain('the release workflow writes it')
  })

  describe('in the freshness lane', () => {
    const lane = (list: PrimerHit[], extra: Record<string, unknown> = {}) =>
      buildContextPrimer(vi.fn(async () => []), { query: 'q', project: proj, recent: vi.fn().mockResolvedValue(list), now: NOW, ...extra })

    it('lists the fuller chunk once, whichever the lister gave first', async () => {
      for (const list of [[chunk('head', HEAD, { score: 0 }), chunk('full', FULL, { score: 0 })], [chunk('full', FULL, { score: 0 }), chunk('head', HEAD, { score: 0 })]]) {
        const out = await lane(list)
        expect(rows(out)).toHaveLength(1)
        expect(out).toContain('the release workflow writes it')
      }
    })

    it('gives the slot the head would have taken to the next entry', async () => {
      const next = chunk('next', long('shipped the installer check an hour ago'), { score: 0, ts: NOW - 5 * HOUR })
      const out = await lane([chunk('head', HEAD, { score: 0 }), chunk('full', FULL, { score: 0 }), next])
      expect(rows(out)).toHaveLength(2)
      expect(out).toContain('shipped the installer check')
    })

    it('shows no head the relevance block already carries the fuller chunk of', async () => {
      const search = asked([chunk('full', FULL, { score: 0.9 })])
      const out = await buildContextPrimer(search, { query: 'q', project: proj, recent: vi.fn().mockResolvedValue([chunk('head', HEAD, { score: 0, ts: NOW - HOUR })]), now: NOW })
      expect(rows(out)).toHaveLength(1)
      expect(out).not.toContain('Most recent activity')
      expect(out).toContain('the release workflow writes it')
    })

    it('drops a head from the relevance block when the lane shows the fuller chunk, and gives its slot to the next hit', async () => {
      const search = asked([chunk('head', HEAD, { score: 0.9 }), OTHER])
      const out = await buildContextPrimer(search, { query: 'q', project: proj, recent: vi.fn().mockResolvedValue([chunk('full', FULL, { score: 0, ts: NOW - HOUR })]), now: NOW })
      expect(rows(out)).toHaveLength(2)
      expect(out!.match(/how do I cut a release/g)).toHaveLength(1)
      expect(out).toContain('Most recent activity here')
      expect(out).toContain('we keep the retry queue in memory')
    })

    it('does the same in a digest with no project, and leaves a lane that finds nothing alone', async () => {
      const flat = await buildContextPrimer(vi.fn(async () => [chunk('head', HEAD, { score: 0.9 })]), { query: 'q', recent: vi.fn().mockResolvedValue([chunk('full', FULL, { score: 0, ts: NOW - HOUR })]), now: NOW })
      expect(rows(flat)).toHaveLength(1)
      expect(flat).toContain('the release workflow writes it')
      const empty = await buildContextPrimer(vi.fn(async () => [chunk('head', HEAD, { score: 0.9 })]), { query: 'q', recent: vi.fn().mockResolvedValue([]), now: NOW })
      expect(rows(empty)).toHaveLength(1)
      expect(empty).toContain('how do I cut a release')
    })
  })

  // The lists are joined and NOT sorted again, so a ranking is a position: the fuller chunk that replaces a head takes the
  // head's place, not its own later one. Otherwise the passage the project search ranked first sits behind every other hit
  // and a tight budget (the lane has spent three of the ten lines) cuts it.
  it('keeps the rank of the head when only the unscoped search found the fuller chunk, so a tight budget does not lose the passage', async () => {
    const names = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma', 'kappa', 'theta', 'iota']
    const others = names.map((n, i) => chunk(`p${i}`, long(`unrelated conversation ${i} about ${n}`), { score: 0.7 - i * 0.02 }))
    const projectList = [chunk('head', HEAD, { score: 0.95 }), ...others]
    const globalList = [chunk('full', FULL, { score: 0.9 })]
    const lane = vi.fn().mockResolvedValue([1, 2, 3].map((i) => chunk(`r${i}`, long(`fresh work number ${i} in the repo today`), { score: 0, ts: NOW - i * HOUR })))
    const search = vi.fn(async (o: { project?: string }) => (o.project ? projectList : globalList))
    const out = await buildContextPrimer(search, { query: 'q', project: proj, recent: lane, now: NOW, limit: 10 })
    const project = (out ?? '').split('This project')[1]
    expect(project).toContain('how do I cut a release') // not lost to the seven-line relevance budget
    expect(project.indexOf('how do I cut a release')).toBeLessThan(project.indexOf('unrelated conversation 0')) // and still first
    expect(rows(out)).toHaveLength(10)
  })

  it('keeps the earliest place of the several heads a fuller chunk replaces, and the best score of them', async () => {
    const MID = `${HEAD}\n\nuser: and the changelog?`
    const search = asked([chunk('other-first', 'we keep the retry queue in memory and flush it on exit', { score: 0.95 }), chunk('mid', MID, { score: 0.8 }), chunk('head', HEAD, { score: 0.9 }), chunk('full', FULL, { score: 0.5 })])
    const out = await buildContextPrimer(search, { query: 'q', project: proj, now: NOW, maxSnippetChars: 2000 })
    expect(rows(out)).toHaveLength(2)
    expect(rows(out)[0]).toContain('we keep the retry queue')
    expect(rows(out)[1]).toContain('the release workflow writes it') // the fuller chunk, with the better score of its heads: 0.5 alone is under the 0.6 x 0.95 cliff
  })

  // The lane gives up a head only for a fuller chunk that the relevance block really shows. The block has `limit` minus the
  // lane's lines to spend, and a fuller chunk ranked in the last places can be cut: the digest must not then lose the passage
  // (it gave up the head for a twin that never appeared).
  describe('when the relevance block has no room for the fuller chunk', () => {
    const ranked = (n: number) => Array.from({ length: n }, (_, i) => chunk(`p${i}`, long(`unrelated conversation ${i} about ${['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma', 'kappa', 'theta', 'iota'][i]}`), { score: 0.9 - i * 0.02 }))
    const headLane = () => vi.fn().mockResolvedValue([chunk('head', HEAD, { score: 0, ts: NOW - HOUR }), chunk('next', long('something else entirely from today'), { score: 0, ts: NOW - 2 * HOUR })])

    it('keeps the head in the lane rather than lose the passage', async () => {
      // limit 4: one lane slot, three relevance lines, and the fuller chunk ranks fourth.
      const out = await buildContextPrimer(asked([...ranked(3), chunk('full', FULL, { score: 0.7 })]), { query: 'q', project: proj, recent: headLane(), now: NOW, limit: 4 })
      expect(out!.match(/how do I cut a release/g)).toHaveLength(1)
      expect(out).not.toContain('something else entirely from today') // the head took the lane's one slot
      expect(rows(out)).toHaveLength(4)
      expect(out!.indexOf('how do I cut a release')).toBeLessThan(out!.indexOf('unrelated conversation 0')) // newest first, as the lane always is
    })

    it('still gives the head up when the fuller chunk is sure to be shown, and the slot to the next entry', async () => {
      const out = await buildContextPrimer(asked([...ranked(2), chunk('full', FULL, { score: 0.8 })]), { query: 'q', project: proj, recent: headLane(), now: NOW, limit: 4 })
      expect(out!.match(/how do I cut a release/g)).toHaveLength(1)
      expect(out).toContain('the release workflow writes it') // the fuller chunk, in the relevance block
      expect(out).toContain('something else entirely from today')
      expect(rows(out)).toHaveLength(4)
    })

    it('shows the passage once when the lane could not fill its slots and so left the relevance block more room', async () => {
      // limit 10: three lane slots, but only the head to fill them, so the block has nine lines and shows the fuller chunk that
      // ranks last. It must not show the head above it too.
      const lane = vi.fn().mockResolvedValue([chunk('head', HEAD, { score: 0, ts: NOW - HOUR })])
      const out = await buildContextPrimer(asked([...ranked(8), chunk('full', FULL, { score: 0.7 })]), { query: 'q', project: proj, recent: lane, now: NOW, limit: 10 })
      expect(out!.match(/how do I cut a release/g)).toHaveLength(1)
      expect(out).toContain('the release workflow writes it')
      expect(out).not.toContain('Most recent activity') // the lane gave its only line up
      expect(rows(out)).toHaveLength(9) // and the freed slot went to relevance, which had nothing more to show
    })

    it('keeps going while the room a given-up head frees shows the fuller chunk of the next one', async () => {
      // Two heads, two fuller chunks ranked last: seven lines of relevance are certain, the lane (two entries, three slots)
      // leaves eight, so the first fuller chunk shows and the first head goes; that leaves nine, so the second shows too.
      const HEAD2 = long('user: where does the changelog go?\\n\\nassistant: into the release notes file')
      const FULL2 = `${HEAD2}\\n\\nuser: and who writes it?\\n\\nassistant: the release workflow does`
      const lane = vi.fn().mockResolvedValue([chunk('head', HEAD, { score: 0, ts: NOW - HOUR }), chunk('head2', HEAD2, { score: 0, ts: NOW - 2 * HOUR })])
      const list = [...ranked(7), chunk('full', FULL, { score: 0.7 }), chunk('full2', FULL2, { score: 0.69 })]
      const out = await buildContextPrimer(asked(list), { query: 'q', project: proj, recent: lane, now: NOW, limit: 10 })
      expect(out!.match(/how do I cut a release/g)).toHaveLength(1)
      expect(out!.match(/where does the changelog go/g)).toHaveLength(1)
      expect(out).toContain('the release workflow writes it')
      expect(out).toContain('and who writes it')
      expect(out).not.toContain('Most recent activity')
      expect(rows(out)).toHaveLength(9)
    })

    it('does the same in a digest with no project', async () => {
      const search = vi.fn(async () => [...ranked(3), chunk('full', FULL, { score: 0.7 })].map((h) => ({ ...h, project: undefined })))
      const out = await buildContextPrimer(search, { query: 'q', recent: headLane(), now: NOW, limit: 4 })
      expect(out!.match(/how do I cut a release/g)).toHaveLength(1)
      expect(rows(out)).toHaveLength(4)
    })
  })

  // Hits the digest never shows must not take the passage that begins like them with them: a held-back lesson and another
  // project's note are dropped before duplicates are collapsed, not after.
  describe('when the longer text is one the digest does not show', () => {
    it('keeps a chunk that a held-back lesson begins with', async () => {
      const held = { id: 'held', content: `${HEAD} and then a lesson the gate held back said more`, source: 'claude', agentId: 'mneme', kind: 'fact', score: 0.9, project: proj, tags: ['candidate'] } as PrimerHit
      const out = await buildContextPrimer(asked([chunk('head', HEAD, { score: 0.8 }), held]), { query: 'q', project: proj, now: NOW })
      expect(out).toContain('how do I cut a release')
      expect(out).not.toContain('a lesson the gate held back said more')
    })

    it('keeps a chunk that a note of another project begins with', async () => {
      const foreign = { id: 'n9', content: `${HEAD} and then another project's note said more`, source: 'claude-notes', agentId: 'claude-notes', kind: 'fact', score: 0.9, project: 'other-app', tags: ['type:reference', 'note:x.md'] } as PrimerHit
      const out = await buildContextPrimer(asked([chunk('head', HEAD, { score: 0.8 }), foreign]), { query: 'q', project: proj, now: NOW })
      expect(out).toContain('how do I cut a release')
      expect(out).not.toContain('note said more')
    })
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
