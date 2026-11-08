// @vitest-environment node
// Lending a note to another project (Settings > Memory, off by default): which notes may travel, how many,
// where they land in the results, and that none ever does while the switch is off. The first half is pure;
// the second runs the real store, so "another project's search" means the store's own hard project filter.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const secDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-share-sec-'))
vi.mock('electron', () => ({ app: { getPath: () => secDir } }))
vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  _resetForTests,
  _setEmbeddingsAvailable,
  initSwarmMemory,
  memoryList,
  memorySearch,
  memoryWrite,
  normalizeProjectSlug,
} from '../../src/main/swarmMemory'
import {
  BORROW_FETCH,
  BORROW_MAX,
  BORROW_MIN_SCORE,
  pickBorrowed,
  withBorrowedNotes,
  withoutUnshareableNotes,
  type LendableHit,
} from '../../src/main/claudeNotesShare'
import { encodeProjectFolder } from '../../src/main/claudeNotesParse'
import { runClaudeNotesIngest, type NotesStore } from '../../src/main/claudeNotesIngest'
import type { McpToolHandlers } from '../../src/main/mcpServer'
import { CWD, FOLDER, deps, note, session, setupWorld, teardownWorld } from './_claudeNotesHarness'

const { executeTool } = await import('../../src/main/mcpServer')

const hit = (o: Partial<LendableHit> & { id: string }): LendableHit => ({
  score: 0.8, project: 'other', source: 'claude-notes', agentId: 'claude-notes', tags: ['type:reference', 'note:a.md'], ...o,
})

describe('pickBorrowed: which notes may be lent', () => {
  const pick = (c: LendableHit[], over: Partial<{ project: string; room: number; have: string[] }> = {}): string[] =>
    pickBorrowed(c, { project: 'app', room: 5, have: new Set(over.have ?? []), ...(over.project ? { project: over.project } : {}), ...(over.room !== undefined ? { room: over.room } : {}) }).map((h) => h.id)

  it('lends reference, feedback and user notes, and never a project note or an untyped one', () => {
    const c = ['reference', 'feedback', 'user', 'project', 'untyped'].map((t) => hit({ id: t, tags: [`type:${t}`, 'note:a.md'] }))
    expect(pick(c, { room: 10 })).toEqual(['reference', 'feedback'])
    expect(pick(c.slice(2), { room: 10 })).toEqual(['user'])
    expect(pick([hit({ id: 'no-type', tags: ['note:a.md'] }), hit({ id: 'no-tags', tags: undefined })])).toEqual([])
  })

  it('lends only what came from another project', () => {
    expect(pick([hit({ id: 'same', project: 'app' }), hit({ id: 'none', project: undefined }), hit({ id: 'other', project: 'billing' })])).toEqual(['other'])
  })

  it('lends only notes that match well: the bar is inclusive, and a score that is not a number never clears it', () => {
    expect(BORROW_MIN_SCORE).toBe(0.5)
    expect(pick([hit({ id: 'low', score: 0.49 }), hit({ id: 'edge', score: 0.5 }), hit({ id: 'nan', score: NaN }), hit({ id: 'high', score: 0.9 })])).toEqual(['edge', 'high'])
  })

  it('does not lend what the search already returned', () => {
    expect(pick([hit({ id: 'a' }), hit({ id: 'b' })], { have: ['a'] })).toEqual(['b'])
  })

  it('lends only the notes this module imported: not a transcript, and not an agent passing itself off as the importer', () => {
    expect(pick([
      hit({ id: 'chunk', source: 'claude', agentId: 'claude-history' }),
      hit({ id: 'spoof', source: 'claude-notes', agentId: 'claude' }),
      hit({ id: 'real' }),
    ])).toEqual(['real'])
  })

  it('lends at most two, in the order given, and no more than the room there is', () => {
    expect(BORROW_MAX).toBe(2)
    const c = ['a', 'b', 'c', 'd', 'e'].map((id) => hit({ id }))
    expect(pick(c, { room: 10 })).toEqual(['a', 'b'])
    expect(pick(c, { room: 1 })).toEqual(['a'])
    expect(pick(c, { room: 0 })).toEqual([])
    expect(pick([], { room: 3 })).toEqual([])
  })
})

describe('withoutUnshareableNotes: a door that cannot tell which project is asking', () => {
  const rows = (): LendableHit[] => [
    hit({ id: 'ref', tags: ['type:reference', 'note:a.md'] }),
    hit({ id: 'proj', tags: ['type:project', 'note:b.md'] }),
    hit({ id: 'fb', tags: ['type:feedback', 'note:c.md'] }),
    hit({ id: 'user', tags: ['type:user', 'note:d.md'] }),
    hit({ id: 'untyped', tags: ['type:untyped', 'note:e.md'] }),
    hit({ id: 'chunk', source: 'claude', agentId: 'claude-history', tags: undefined }),
    hit({ id: 'spoof', source: 'claude-notes', agentId: 'claude', tags: ['type:project'] }),
  ]

  it('takes every note out while sharing is off, and leaves everything that is not one', () => {
    expect(withoutUnshareableNotes(rows(), false).map((h) => h.id)).toEqual(['chunk', 'spoof'])
  })

  it('keeps only the general kinds once sharing is on', () => {
    expect(withoutUnshareableNotes(rows(), true).map((h) => h.id)).toEqual(['ref', 'fb', 'user', 'chunk', 'spoof'])
  })

  it('keeps the order, and an empty list stays empty', () => {
    expect(withoutUnshareableNotes([], true)).toEqual([])
    expect(withoutUnshareableNotes([], false)).toEqual([])
  })

  // A listing and a walk of the graph return rows with no score, and some with no tags or agent at all.
  it('takes rows that carry no score, no tags or no agent the same way', () => {
    const listed = [
      { id: 'a', source: 'claude-notes', agentId: 'claude-notes', tags: ['type:reference', 'note:a.md'] },
      { id: 'b', source: 'claude-notes', agentId: 'claude-notes', tags: ['type:project', 'note:b.md'] },
      { id: 'c', source: 'claude-notes', agentId: 'claude-notes' }, // a note with no tags at all is untyped: it does not travel
      { id: 'd' },
      { id: 'e', source: 'claude' },
    ]
    expect(withoutUnshareableNotes(listed, false).map((r) => r.id)).toEqual(['d', 'e'])
    expect(withoutUnshareableNotes(listed, true).map((r) => r.id)).toEqual(['a', 'd', 'e'])
  })

  it('hands back whatever is not a list as it came, because it sits on every agent-facing read', () => {
    const graph = { nodes: [], edges: [] }
    for (const v of [graph, null, undefined, 'x', 7]) expect(withoutUnshareableNotes(v as never, false)).toBe(v)
  })
})

describe('withBorrowedNotes: the extra search', () => {
  const own = (n: number): LendableHit[] => Array.from({ length: n }, (_, i) => hit({ id: `own${i}`, project: 'app', tags: undefined, source: 'claude', agentId: 'claude-history' }))
  const ctx = (over: Partial<Parameters<typeof withBorrowedNotes>[1]> = {}) => ({
    enabled: true, project: 'app', query: 'cache', limit: 5,
    search: vi.fn(async () => [hit({ id: 'x1', project: 'billing' }), hit({ id: 'x2', project: 'billing' }), hit({ id: 'x3', project: 'billing' })]),
    ...over,
  })

  it('does nothing, and does not search, while the switch is off', async () => {
    const c = ctx({ enabled: false })
    const served = own(2)
    expect(await withBorrowedNotes(served, c)).toBe(served)
    expect(c.search).not.toHaveBeenCalled()
  })

  it('lends nothing to a search that names no project, or no query', async () => {
    const a = ctx({ project: '' })
    const b = ctx({ query: '' })
    expect(await withBorrowedNotes(own(1), a)).toHaveLength(1)
    expect(await withBorrowedNotes(own(1), b)).toHaveLength(1)
    expect(a.search).not.toHaveBeenCalled()
    expect(b.search).not.toHaveBeenCalled()
  })

  it('appends up to two after the project\'s own results, asking for the notes\' best six by the notes\' author', async () => {
    const c = ctx()
    const res = await withBorrowedNotes(own(2), c)
    expect(res.map((h) => h.id)).toEqual(['own0', 'own1', 'x1', 'x2'])
    expect(c.search).toHaveBeenCalledWith({ query: 'cache', limit: BORROW_FETCH, agentId: 'claude-notes' })
  })

  it('never goes above the limit the search was given, and does not look when there is no room', async () => {
    const full = ctx({ limit: 2 })
    expect(await withBorrowedNotes(own(2), full)).toHaveLength(2)
    expect(full.search).not.toHaveBeenCalled()
    const one = ctx({ limit: 3 })
    expect((await withBorrowedNotes(own(2), one)).map((h) => h.id)).toEqual(['own0', 'own1', 'x1'])
  })

  it('reads a missing limit as the store\'s own default, and clamps one that is out of range', async () => {
    expect((await withBorrowedNotes(own(9), ctx({ limit: undefined }))).map((h) => h.id).slice(9)).toEqual(['x1']) // 10 - 9
    expect((await withBorrowedNotes(own(0), ctx({ limit: 0 }))).map((h) => h.id)).toEqual(['x1']) // clamped up to 1
    expect(await withBorrowedNotes(own(99), ctx({ limit: 500 }))).toHaveLength(100) // clamped down to 100: one slot, one note
  })

  it('returns what it was given when the extra search fails, or finds nothing it may lend', async () => {
    const served = own(1)
    expect(await withBorrowedNotes(served, ctx({ search: vi.fn(async () => { throw new Error('host down') }) }))).toBe(served)
    expect(await withBorrowedNotes(served, ctx({ search: vi.fn(async () => [hit({ id: 'p', tags: ['type:project'] })]) }))).toBe(served)
  })

  // The limit arrives from a model, as JSON. The store clamps it with Math.min(Math.max(limit ?? 10, 1), 100), which turns a
  // value it cannot read into NaN and answers with nothing; the lender must not read the same value as "no limit at all".
  it('lends nothing to a search whose limit is not a number: the store answered it with nothing', async () => {
    for (const limit of ['abc', Number.NaN, {}, [1, 2]] as unknown as number[]) {
      const c = ctx({ limit })
      const served = own(0)
      expect(await withBorrowedNotes(served, c), String(limit)).toBe(served)
      expect(c.search).not.toHaveBeenCalled()
    }
  })

  it('reads a limit given as a numeric string or a fraction the way the store does', async () => {
    expect((await withBorrowedNotes(own(2), ctx({ limit: '3' as unknown as number }))).map((h) => h.id)).toEqual(['own0', 'own1', 'x1']) // slice(0, '3')
    expect((await withBorrowedNotes(own(2), ctx({ limit: 3.9 }))).map((h) => h.id)).toEqual(['own0', 'own1', 'x1']) // slice(0, 3.9) is three
    expect(await withBorrowedNotes(own(3), ctx({ limit: 3.9 }))).toHaveLength(3) // and three is full
  })

  // Only the notes' best BORROW_FETCH matches are looked at, and the first of them is as likely as not to be this project's own
  // note or a note about a project's own state, which cannot be lent. A look at one candidate would leave a lender blind.
  it('looks past a first match it may not lend', async () => {
    const search = vi.fn(async () => [
      hit({ id: 'mine', project: 'app' }), // this project's own note
      hit({ id: 'about', project: 'billing', tags: ['type:project', 'note:p.md'] }), // a project note
      hit({ id: 'weak', project: 'billing', score: 0.2 }), // a poor match
      hit({ id: 'good', project: 'billing' }),
    ])
    const res = await withBorrowedNotes(own(1), ctx({ search }))
    expect(res.map((h) => h.id)).toEqual(['own0', 'good'])
    expect(search).toHaveBeenCalledWith({ query: 'cache', limit: BORROW_FETCH, agentId: 'claude-notes' })
  })

  it('looks at six matches: the number the privacy notes and the research design name', () => {
    expect(BORROW_FETCH).toBe(6)
  })
})

// ---------------------------------------------------------------------------------------------
// The real store.
// ---------------------------------------------------------------------------------------------

let storeDir = ''
const store: NotesStore = {
  write: (i) => memoryWrite(i),
  remove: async () => {},
  list: async (o) => memoryList(o),
}

const OTHER_CWD = 'C:\\work\\billing'
const OTHER_FOLDER = encodeProjectFolder(OTHER_CWD)

beforeEach(async () => {
  setupWorld()
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-share-store-'))
  _resetForTests()
  initSwarmMemory(storeDir)
  _setEmbeddingsAvailable(false)
  // The app's notes, one of each type, all saying something about the widget cache.
  for (const t of ['reference', 'feedback', 'user', 'project']) {
    note(FOLDER, `${t}.md`, `---\nname: ${t}\ndescription: widget cache invalidation\ntype: ${t}\n---\nInvalidate the widget cache on write, never on a timer: ${t}.`)
  }
  session(FOLDER, CWD)
  // The billing project has two notes of its own about the same words.
  note(OTHER_FOLDER, 'mine.md', '---\nname: mine\ndescription: widget cache invalidation\ntype: reference\n---\nBilling invalidates the widget cache when a charge settles.')
  note(OTHER_FOLDER, 'mine2.md', '---\nname: mine2\ndescription: widget cache invalidation\ntype: feedback\n---\nBilling widget cache invalidation: always on charge write.')
  session(OTHER_FOLDER, OTHER_CWD)
  await runClaudeNotesIngest(deps(store))
  expect(memoryList({ agentId: 'claude-notes' })).toHaveLength(6)
})

afterEach(() => {
  _resetForTests()
  teardownWorld()
  fs.rmSync(storeDir, { recursive: true, force: true })
})

afterAll(() => {
  fs.rmSync(secDir, { recursive: true, force: true })
})

/** memory_search as the app wires it: the store's search, then the lending step. */
function handlers(enabled: boolean): McpToolHandlers {
  return {
    memorySearch: async (opts: { query: string; limit?: number; project?: string }) =>
      withBorrowedNotes(await memorySearch(opts), {
        enabled,
        project: opts.project ? normalizeProjectSlug(opts.project) : '',
        query: opts.query,
        limit: opts.limit,
        search: (o) => memorySearch(o),
      }),
  } as unknown as McpToolHandlers
}

type Row = { project?: string; tags?: string[]; content: string; source?: string }
const ask = (enabled: boolean, args: Record<string, unknown>): Promise<Row[]> =>
  executeTool('memory_search', { query: 'invalidate widget cache write', ...args }, handlers(enabled)) as Promise<Row[]>

describe('another project\'s search, against the real store', () => {
  it('with sharing off, finds none of the app\'s notes, whatever their type', async () => {
    const res = await ask(false, { project: OTHER_CWD })
    expect(res.length).toBeGreaterThan(0)
    expect(res.every((r) => r.project === 'billing')).toBe(true)
  })

  it('with sharing on, finds the project\'s own notes first, then at most two of the app\'s, never a project note', async () => {
    const res = await ask(true, { project: OTHER_CWD, limit: 10 })
    const own = res.filter((r) => r.project === 'billing')
    const lent = res.filter((r) => r.project === 'app')
    expect(own).toHaveLength(2)
    expect(lent.length).toBeGreaterThan(0)
    expect(lent.length).toBeLessThanOrEqual(2)
    expect(res.slice(0, own.length).every((r) => r.project === 'billing')).toBe(true) // own results first
    expect(res.slice(own.length).every((r) => r.project === 'app')).toBe(true) // lent ones after
    for (const r of lent) {
      expect(r.source).toBe('claude-notes')
      expect(['type:reference', 'type:feedback', 'type:user']).toContain(r.tags?.[0]) // the origin project is on each, and its type
    }
    expect(res.some((r) => r.tags?.includes('type:project'))).toBe(false)
  })

  // PRIVACY.md, DOCUMENTATION.md and the Settings row say that notes from sessions run in the home folder belong to no project,
  // so a search that names a project is never lent them. The store drops the home folder from a project's name, which leaves the
  // note with nothing to say where it came from; the lender takes only notes that do.
  it('lends nothing from a session run in the home folder: such a note belongs to no project', async () => {
    const home = os.homedir() // only the text of the path is used: nothing under the real home is read
    const homeFolder = encodeProjectFolder(home)
    note(homeFolder, 'user_style.md', '---\nname: style\ndescription: widget cache invalidation\ntype: user\n---\nInvalidate the widget cache on write, always: the home style.')
    session(homeFolder, home)
    await runClaudeNotesIngest(deps(store))
    const homeNote = memoryList({ agentId: 'claude-notes' }).find((r) => r.content.includes('the home style'))
    expect(homeNote).toBeDefined()
    expect(homeNote!.project).toBeUndefined()
    // Its own words make it the best match of the lot, so it would be the first note lent if it could be.
    const query = 'invalidate widget cache write home style'
    expect((await ask(false, { query, limit: 10 }))[0].content).toContain('the home style') // found when nothing is scoped
    for (const enabled of [false, true]) {
      const res = await ask(enabled, { query, project: OTHER_CWD, limit: 10 })
      expect(res.some((r) => r.content.includes('the home style')), `sharing ${enabled}`).toBe(false)
    }
    expect((await ask(true, { query, project: OTHER_CWD, limit: 10 })).some((r) => r.project === 'app')).toBe(true) // others are lent
  })

  it('never goes above the limit', async () => {
    expect((await ask(true, { project: OTHER_CWD, limit: 2 }))).toHaveLength(2) // the project\'s own two fill it
    expect((await ask(true, { project: OTHER_CWD, limit: 3 })).length).toBeLessThanOrEqual(3)
  })

  it('lends nothing to a search that names no project, which already covers every project', async () => {
    const off = await ask(false, {})
    const on = await ask(true, {})
    expect(on.map((r) => r.content)).toEqual(off.map((r) => r.content))
  })

  it('a project\'s own scoped search still finds its own notes with sharing on', async () => {
    const res = await ask(true, { project: CWD, limit: 10 })
    expect(res.filter((r) => r.project === 'app').length).toBeGreaterThanOrEqual(4)
  })
})
