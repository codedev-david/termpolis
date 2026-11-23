// WPA item 1 and 2 in the primer: one combined search instead of two in a row, no nested deeper reads, and a cancel signal
// checked between reads.
import { describe, it, expect, vi } from 'vitest'
import * as crypto from 'crypto'
import { buildContextPrimer, getLastPrimerIds, type PrimerHit, type PrimerSearch } from '../../src/main/contextPrimer'

const sha = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
const ROOT = '/srv/work/termpolis'
const KEY = sha(ROOT)
const NOW = 1_800_000_000_000

const hit = (id: string, content: string, score: number, extra: Partial<PrimerHit> = {}): PrimerHit =>
  ({ id, content, score, kind: 'fact', source: 'claude', ts: NOW - 3_600_000, ...extra })

const own = (id: string, content: string, score: number, extra: Partial<PrimerHit> = {}): PrimerHit =>
  hit(id, content, score, { project: 'termpolis', projectKey: KEY, ...extra })

const ROWS: PrimerHit[] = [
  own('p1', 'the memory host lowers its own priority below normal at start up', 0.92),
  hit('g1', 'a lesson from another repository about lowering process priority', 0.6, { project: 'other', projectKey: sha('/srv/work/other') }),
  own('p2', 'the world compile reads each file once thirty two at a time', 0.81),
  hit('legacy', 'a legacy termpolis note with no key, filed by its folder name', 0.7, { project: 'termpolis' }),
  own('alias', 'a note written from git bash keeps matching through its alias key', 0.66, { projectKey: sha('/srv/work//termpolis') }),
  hit('g2', 'an unrelated note about a different project entirely', 0.3, { project: 'zoo', projectKey: sha('/srv/zoo') }),
]

function combinedSearch(rows: PrimerHit[] = ROWS): { search: PrimerSearch; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  const search: PrimerSearch = async (o) => { calls.push({ ...o }); return rows }
  return { search, calls }
}

const base = { query: 'recent work, decisions, conventions, and context for termpolis', limit: 6, project: 'termpolis', now: NOW, fileExists: () => true }

describe('buildContextPrimer: combined read', () => {
  it('makes exactly one search, project-scoped with cross-project recall, at the most the store gives in one read', async () => {
    const { search, calls } = combinedSearch()
    const out = await buildContextPrimer(search, { ...base, projectPath: ROOT, combined: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ query: base.query, limit: 100, project: ROOT, crossProject: true })
    expect(out).toContain('This project (termpolis)')
    expect(out).toContain('the memory host lowers its own priority')
    expect(out).toContain('Other saved context (may NOT apply to this project):')
    expect(out).toContain('a lesson from another repository')
  })

  it('splits locally: own key, an alias key of the folder and a legacy no-key row of the folder lead; others go under "may NOT apply"', async () => {
    const { search } = combinedSearch()
    const out = (await buildContextPrimer(search, { ...base, projectPath: '/srv/work//termpolis', combined: true })) as string
    const projectBlock = out.split('Other saved context')[0]
    expect(projectBlock).toContain('git bash keeps matching')
    expect(projectBlock).toContain('legacy termpolis note')
    expect(projectBlock).not.toContain('another repository')
    expect(getLastPrimerIds()).toEqual(expect.arrayContaining(['p1', 'p2', 'alias', 'legacy']))
  })

  it('a slug-only digest (no path) splits by the folder name', async () => {
    const { search, calls } = combinedSearch()
    const out = (await buildContextPrimer(search, { ...base, combined: true })) as string
    expect(calls[0]).toMatchObject({ project: 'termpolis', crossProject: true })
    expect(out.split('Other saved context')[0]).toContain('the world compile reads each file once')
  })

  it('a digest that names no project makes one plain read', async () => {
    const { search, calls } = combinedSearch()
    const out = await buildContextPrimer(search, { ...base, project: undefined, combined: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toHaveProperty('crossProject')
    expect(calls[0]).not.toHaveProperty('project')
    expect(out).toContain('the memory host lowers')
  })

  it('never reads deeper, even when hidden rows leave the page short', async () => {
    const lesson = (id: string): PrimerHit => own(id, `held back lesson ${id}`, 0.9, { tags: ['candidate'], agentId: 'mneme', memoryType: 'semantic' })
    const rows = Array.from({ length: 100 }, (_, i) => lesson(`c${i}`))
    const { search, calls } = combinedSearch(rows)
    const out = await buildContextPrimer(search, { ...base, projectPath: ROOT, combined: true })
    expect(calls).toHaveLength(1)
    expect(out).toBeNull()
  })

  it('never more rows than it asked for: a search that ignores its limit is cut to 100', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => own(`r${i}`, `row ${i} about the termpolis memory host and its lane`, 0.9 - i / 1000))
    const { search } = combinedSearch(rows)
    const out = await buildContextPrimer(search, { ...base, projectPath: ROOT, combined: true })
    expect(out).toContain('row 0 about')
  })

  it('a failing combined read is no digest (it never throws); a non-list answer is no rows', async () => {
    expect(await buildContextPrimer(async () => { throw new Error('host down') }, { ...base, projectPath: ROOT, combined: true })).toBeNull()
    expect(await buildContextPrimer(async () => null as unknown as PrimerHit[], { ...base, projectPath: ROOT, combined: true })).toBeNull()
    expect(await buildContextPrimer(async () => ({ rows: ROWS }) as unknown as PrimerHit[], { ...base, projectPath: ROOT, combined: true })).toBeNull()
  })

  it('excluded ids and another project\'s saved notes stay out of a combined digest', async () => {
    const note = hit('n1', 'termpolis saved note from another folder of the same name', 0.95, {
      project: 'termpolis', projectKey: sha('/elsewhere/termpolis'), agentId: 'claude-notes', tags: ['claude-note', 'note-file:x.md'],
    })
    const { search } = combinedSearch([note, ...ROWS])
    const out = (await buildContextPrimer(search, { ...base, projectPath: ROOT, combined: true, excludeIds: new Set(['p1']) })) as string
    expect(out).not.toContain('the memory host lowers')
    expect(getLastPrimerIds()).not.toContain('p1')
  })
})

describe('buildContextPrimer: cancel', () => {
  it('a signal that fires during the combined read: no digest, nothing recorded, the lane is never listed', async () => {
    const ctl = new AbortController()
    const recent = vi.fn(async () => [])
    const search: PrimerSearch = async (o) => { expect(o.signal).toBe(ctl.signal); ctl.abort(); return ROWS }
    expect(await buildContextPrimer(search, { ...base, projectPath: ROOT, combined: true, recent, signal: ctl.signal })).toBeNull()
    expect(recent).not.toHaveBeenCalled()
    expect(getLastPrimerIds()).toEqual([])
  })

  it('a signal that fires during the lane listing: no digest', async () => {
    const ctl = new AbortController()
    const recent = vi.fn(async (o: { signal?: AbortSignal }) => { expect(o.signal).toBe(ctl.signal); ctl.abort(); return [] })
    const { search } = combinedSearch()
    expect(await buildContextPrimer(search, { ...base, projectPath: ROOT, combined: true, recent, signal: ctl.signal })).toBeNull()
    expect(recent).toHaveBeenCalledTimes(1)
  })

  it('a signal that fires while the world check runs: no digest, nothing recorded', async () => {
    const ctl = new AbortController()
    const { search } = combinedSearch()
    const hasWorld = (): Promise<boolean> => new Promise((r) => setTimeout(() => { ctl.abort(); r(true) }, 20))
    const out = await buildContextPrimer(search, { ...base, projectPath: ROOT, combined: true, signal: ctl.signal, hasWorld })
    expect(out).toBeNull()
    expect(getLastPrimerIds()).toEqual([])
  })

  it('the two-read path: a cancel during the global read is no digest', async () => {
    const ctl = new AbortController()
    let n = 0
    const search: PrimerSearch = async () => { if (++n === 2) ctl.abort(); return ROWS }
    expect(await buildContextPrimer(search, { ...base, projectPath: ROOT, signal: ctl.signal })).toBeNull()
    expect(n).toBe(2)
  })

  it('the two-read path: a global read that fails after a cancel is no digest, even with project rows in hand', async () => {
    const ctl = new AbortController()
    let n = 0
    const search: PrimerSearch = async () => { if (++n === 2) { ctl.abort(); throw new Error('cancelled') } return ROWS }
    expect(await buildContextPrimer(search, { ...base, projectPath: ROOT, signal: ctl.signal })).toBeNull()
  })

  it('already cancelled: no read at all', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const { search, calls } = combinedSearch()
    expect(await buildContextPrimer(search, { ...base, projectPath: ROOT, combined: true, signal: ctl.signal })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('the two-read path checks between its reads: a cancel after the project read skips the global one', async () => {
    const ctl = new AbortController()
    const calls: Array<Record<string, unknown>> = []
    const search: PrimerSearch = async (o) => { calls.push(o); ctl.abort(); return ROWS }
    expect(await buildContextPrimer(search, { ...base, projectPath: ROOT, signal: ctl.signal })).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('a signal that never fires changes nothing: the digest is the one built without it', async () => {
    const { search } = combinedSearch()
    const a = await buildContextPrimer(search, { ...base, projectPath: ROOT, combined: true })
    const b = await buildContextPrimer(search, { ...base, projectPath: ROOT, combined: true, signal: new AbortController().signal })
    expect(b).toBe(a)
  })
})

describe('buildContextPrimer: line labels', () => {
  it('a passage stamped this minute says "just now"; a message with no source is labelled by its kind', async () => {
    const rows = [
      own('m1', 'a message that names no source, written seconds ago about the lane and its priority', 0.9, { kind: 'message', source: undefined, ts: NOW - 5_000 }),
      own('m2', 'a note written five minutes ago about the lane and its priority raise', 0.85, { ts: NOW - 5 * 60_000 }),
    ]
    const out = (await buildContextPrimer(async () => rows, { ...base, projectPath: ROOT, combined: true })) as string
    expect(out).toContain('- [message · just now] a message that names no source')
    expect(out).toContain('- [claude · 5m ago] a note written five minutes ago')
  })

  it('a code hit whose first line is empty is not read as a path', async () => {
    const rows = [hit('c1', '\nsrc/main/x.ts:1-4 body of a chunk', 0.9, { source: 'code' })]
    const out = (await buildContextPrimer(async () => rows, { ...base, project: undefined, combined: true, fileExists: () => false })) as string
    expect(out).toContain('- [code · 1h ago] src/main/x.ts:1-4 body')
    expect(out).not.toContain('STALE')
  })
})
