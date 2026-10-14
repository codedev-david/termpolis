// The one-time pass over memory that 1.50-1.52 stored from jobs other computers ran here. It must
// take whole delegated sessions, including the windows a long primer was cut into and the chunks
// a later ingest pass wrote without linking them, and nothing of the user's own sessions.
import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'
import {
  HISTORY_AGENTS,
  LINKED_RECHECK_MARKER,
  LINKED_RECHECK_REASON,
  LINKED_SINCE,
  recheckLinkedHistory,
  type LinkedRecheckDeps,
  type StoredChunk,
} from '../../src/main/linkedHistoryRecheck'
import { recheckMarker } from '../../src/main/mnemeLessonRecheck'
import { chunkTurns, parseClaudeTranscript } from '../../src/main/conversationIngest'
import { buildExecPrompt } from '../../src/main/headlessExec'
import { delegationHeader } from '../../src/shared/headlessPrompt'

const DAY = 24 * 60 * 60_000
const T0 = LINKED_SINCE + 3 * DAY
const HEADER = delegationHeader('laptop', '/home/me/repos/app')

interface Edge {
  from: string
  to: string
  relation: string
}

/** The store as the pass sees it: listMemory's filters and order, and the edge index. */
function store(chunks: StoredChunk[], edges: Edge[] = []) {
  const list = vi.fn<LinkedRecheckDeps['list']>(async (opts) =>
    chunks
      .filter((c) => c.agentId === opts.agentId && c.ts >= opts.since && (opts.before === undefined || c.ts < opts.before))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, opts.limit),
  )
  const edgeKeys = vi.fn<LinkedRecheckDeps['edgeKeys']>(async (ids) => {
    const wanted = new Set(ids)
    return edges.filter((e) => wanted.has(e.from) || wanted.has(e.to)).map((e) => `${e.from}\0${e.to}\0${e.relation}`)
  })
  return { list, edgeKeys }
}

function run(chunks: StoredChunk[], edges: Edge[] = [], over: Partial<LinkedRecheckDeps> = {}) {
  const demoted: string[] = []
  const marks: number[] = []
  const s = store(chunks, edges)
  const deps: LinkedRecheckDeps = {
    ...s,
    isCorrected: () => false,
    demote: (id, reason) => {
      expect(reason).toBe(LINKED_RECHECK_REASON)
      demoted.push(id)
      return { ok: true }
    },
    done: () => false,
    markDone: () => marks.push(1),
    yield: async () => {},
    ...over,
  }
  return { result: recheckLinkedHistory(deps), demoted, marks, ...s }
}

/** One session as the indexer stored it: its chunks, in order, each `follows` the one before. */
function session(
  name: string,
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
  at: number,
  over: Partial<StoredChunk> = {},
): { chunks: StoredChunk[]; edges: Edge[] } {
  const jsonl = turns
    .map((t) =>
      JSON.stringify(
        t.role === 'user'
          ? { type: 'user', sessionId: name, cwd: '/home/me/repos/app', message: { role: 'user', content: t.text } }
          : { type: 'assistant', sessionId: name, message: { role: 'assistant', content: [{ type: 'text', text: t.text }] } },
      ),
    )
    .join('\n')
  const chunks = chunkTurns(parseClaudeTranscript(jsonl)).map((c, i) => ({
    id: `${name}-${i}`,
    ts: at + i,
    agentId: 'claude-history',
    content: c.text,
    hash: c.hash,
    project: 'app',
    ...over,
  }))
  const edges = chunks.slice(1).map((c, i) => ({ from: chunks[i].id, to: c.id, relation: 'follows' }))
  return { chunks, edges }
}

const ids = (chunks: StoredChunk[]): string[] => chunks.map((c) => c.id)

describe('what it reads', () => {
  it("lists both histories' messages since Linked machines shipped, page by page", async () => {
    expect(new Date(LINKED_SINCE).toISOString()).toBe('2026-10-05T00:00:00.000Z')
    expect(HISTORY_AGENTS).toEqual(['claude-history', 'codex-history'])
    // 1,100 chunks with a shared timestamp at the page boundary: none is skipped, none read twice.
    const many: StoredChunk[] = Array.from({ length: 1_100 }, (_, i) => ({
      id: `c${i}`,
      ts: T0 + Math.floor(i / 2),
      agentId: 'codex-history',
      content: `assistant: answer ${i}`,
    }))
    const h = run(many)
    expect(await h.result).toEqual({ checked: 1_100, demoted: 0 })
    expect(h.list.mock.calls[0][0]).toEqual({ agentId: 'claude-history', kind: 'message', since: LINKED_SINCE, limit: 500 })
    const codexCalls = h.list.mock.calls.map(([o]) => o).filter((o) => o.agentId === 'codex-history')
    expect(codexCalls.length).toBeGreaterThanOrEqual(3)
    expect(codexCalls[1].before).toBe((many[600].ts as number) + 1)
    // Edges are asked for in batches, so no one message to the memory host is huge.
    expect(h.edgeKeys.mock.calls.map(([batch]) => batch.length)).toEqual([1_000, 100])
    expect(h.marks).toEqual([1])
  })

  it('stops paging when a page brings nothing new', async () => {
    const same: StoredChunk[] = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, ts: T0, agentId: 'claude-history', content: 'x' }))
    const s = store(same)
    // A store that ignores `before` keeps answering with the same page.
    s.list.mockImplementation(async (opts) => (opts.agentId === 'claude-history' ? same : []))
    const result = await recheckLinkedHistory({ ...s, isCorrected: () => false, demote: () => ({ ok: true }), done: () => false, markDone: () => {}, yield: async () => {} })
    expect(result.checked).toBe(500)
    expect(s.list.mock.calls.filter(([o]) => o.agentId === 'claude-history')).toHaveLength(2)
  })

  it('runs once per install', async () => {
    const h = run([], [], { done: () => true })
    expect(await h.result).toEqual({ checked: 0, demoted: 0, skipped: 'already-run' })
    expect(h.list).not.toHaveBeenCalled()
    expect(h.marks).toEqual([])
  })

  it('leaves the pass unmarked when the store cannot be read, so the next pass tries again', async () => {
    const h = run([], [], { list: async () => { throw new Error('host down') } })
    await expect(h.result).rejects.toThrow('host down')
    expect(h.marks).toEqual([])
  })
})

describe('what it demotes', () => {
  it('a whole delegated session, user and assistant chunks, both ways from the header', async () => {
    // Codex's preamble turns ahead of the prompt: an AGENTS.md long enough to be cut into windows,
    // and its environment, each a chunk the prompt's own comes after.
    const job = session('job', [
      { role: 'user', text: `# AGENTS.md instructions for /home/me/repos/app\n\n${'x'.repeat(4_500)}` },
      { role: 'user', text: `<environment_context>${'e'.repeat(1_900)}</environment_context>` },
      { role: 'user', text: `${HEADER}\n\nReview the parser.` },
      { role: 'assistant', text: 'y'.repeat(1_990) },
      { role: 'assistant', text: 'Reviewed: two bugs.' },
    ], T0, { agentId: 'codex-history' })
    const own = session('own', [{ role: 'user', text: 'Fix the lexer.' }, { role: 'assistant', text: 'Fixed.' }], T0 + DAY)
    const h = run([...job.chunks, ...own.chunks], [...job.edges, ...own.edges])
    expect(job.chunks.length).toBeGreaterThanOrEqual(6)
    expect(await h.result).toEqual({ checked: job.chunks.length + own.chunks.length, demoted: job.chunks.length })
    expect(h.demoted.sort()).toEqual(ids(job.chunks).sort())
  })

  it("not the user's own session, where a later message starts with a pasted header, wherever it falls", async () => {
    // Debugging a job: its prompt pasted at the start of a later message, in the chunk with the
    // user's own first turn...
    const inline = session('own-1', [
      { role: 'user', text: 'Why did the linked job fail?' },
      { role: 'assistant', text: 'Paste the prompt it was sent.' },
      { role: 'user', text: `${HEADER}\n\nReview the parser.` },
      { role: 'assistant', text: 'The folder does not exist there.' },
    ], T0)
    expect(inline.chunks).toHaveLength(1)
    // ...or starting a chunk of its own, after the user's long turns...
    const own = session('own-2', [
      { role: 'user', text: `Why did it fail? ${'w'.repeat(1_980)}` },
      { role: 'assistant', text: 'a'.repeat(1_990) },
      { role: 'user', text: `${HEADER}\n\nReview the parser.` },
      { role: 'assistant', text: 'Checked.' },
    ], T0 + 10)
    expect(own.chunks.some((c) => c.content.startsWith(`user: ${HEADER}`))).toBe(true)
    // ...or after a window of the user's own long message.
    const long = session('own-3', [
      { role: 'user', text: `Here is the log:\n${'l'.repeat(3_500)}` },
      { role: 'user', text: `${HEADER}\n\nGo.` },
    ], T0 + 20)
    const h = run([...inline.chunks, ...own.chunks, ...long.chunks], [...inline.edges, ...own.edges, ...long.edges])
    expect((await h.result).demoted).toBe(0)
  })

  it('not a chunk that only looks like an opening: after a window whose start is gone, or where the backbone forks', async () => {
    const opening: StoredChunk = { id: 'p', ts: T0 + 2, agentId: 'codex-history', content: `user: ${HEADER}\n\nGo.`, project: 'app' }
    // A window of some long turn, its first window never stored: it can't be told from the user's own.
    const window: StoredChunk = { id: 'w', ts: T0 + 1, agentId: 'codex-history', content: 'ns continue', project: 'app' }
    const orphan = run([window, opening], [{ from: 'w', to: 'p', relation: 'follows' }])
    expect((await orphan.result).demoted).toBe(0)
    // Two chunks before it, which no ingest pass writes.
    const env = (id: string): StoredChunk => ({ id, ts: T0, agentId: 'codex-history', content: 'user: <environment_context>x</environment_context>', project: 'app' })
    const forked = run([env('e1'), env('e2'), opening], [
      { from: 'e1', to: 'p', relation: 'follows' },
      { from: 'e2', to: 'p', relation: 'follows' },
    ])
    expect((await forked.result).demoted).toBe(0)
    // More chunks before it than any run of preambles takes.
    const lead = Array.from({ length: 33 }, (_, i): StoredChunk => (
      i === 0 ? env('l0') : { id: `l${i}`, ts: T0 + i / 100, agentId: 'codex-history', content: 'more of it', project: 'app' }
    ))
    const edges = [...lead.slice(1), opening].map((c, i) => ({ from: lead[i].id, to: c.id, relation: 'follows' }))
    const far = run([...lead, opening], edges)
    expect((await far.result).demoted).toBe(0)
  })

  it('not an opening read on past a fork, or past where a whole opening turn would have ended', async () => {
    // A long opening's first window, whose header would come in the next: but the backbone forks.
    const head: StoredChunk = { id: 'h', ts: T0, agentId: 'claude-history', content: `user: [${'z'.repeat(1_990)}`, project: 'app' }
    const a: StoredChunk = { id: 'a', ts: T0 + 1, agentId: 'claude-history', content: HEADER.slice(1), project: 'app' }
    const b: StoredChunk = { ...a, id: 'b', ts: T0 + 2 }
    const forked = run([head, a, b], [{ from: 'h', to: 'a', relation: 'follows' }, { from: 'h', to: 'b', relation: 'follows' }])
    expect((await forked.result).demoted).toBe(0)
    // Windows that never reach a header within the length a primer and a header take.
    const windows = Array.from({ length: 8 }, (_, i): StoredChunk => ({
      id: `n${i}`,
      ts: T0 + 10 + i,
      agentId: 'claude-history',
      content: i === 0 ? `user: [${'n'.repeat(1_990)}` : i === 7 ? `]${HEADER}` : 'n'.repeat(2_000),
      project: 'app',
    }))
    const long = run(windows, windows.slice(1).map((c, i) => ({ from: windows[i].id, to: c.id, relation: 'follows' })))
    expect((await long.result).demoted).toBe(0)
  })

  it('every window of a 4,500-character primer, and the answer after it', async () => {
    const primer = Array.from({ length: 80 }, (_, i) => `- [claude-history · ${i}d ago] fact ${i} about the parser and the lexer`).join('\n').slice(0, 4_500)
    const job = session('long', [
      { role: 'user', text: buildExecPrompt(`${HEADER}\n\nReview the parser.`, primer) },
      { role: 'assistant', text: 'Reviewed.' },
    ], T0)
    expect(job.chunks.length).toBeGreaterThanOrEqual(4)
    // The windows before the header hold no header at all: they are reached along the backbone.
    expect(job.chunks[0].content.startsWith('user: <project-memory>')).toBe(true)
    const h = run(job.chunks, job.edges)
    expect((await h.result).demoted).toBe(job.chunks.length)
  })

  it('a session whose header a window boundary cut in two', async () => {
    const opening = buildExecPrompt(`${HEADER}\n\nReview the parser.`, 'p'.repeat(1_700))
    const job = session('cut', [{ role: 'user', text: opening }, { role: 'assistant', text: 'Reviewed.' }], T0)
    const cut = job.chunks.findIndex((c) => c.content.includes('[Delegated by "lap') && !c.content.includes(HEADER))
    // The pieces are only whole when read together.
    expect(cut).toBeGreaterThanOrEqual(0)
    expect(job.chunks.some((c) => c.content.includes(HEADER))).toBe(false)
    const h = run(job.chunks, job.edges)
    expect((await h.result).demoted).toBe(job.chunks.length)
  })

  it('the chunks a later ingest pass wrote without linking them, by the hashes the indexer just computed', async () => {
    const first = session('job', [{ role: 'user', text: `${HEADER}\n\nRun the tests.` }], T0)
    // A second pass's chunks: same session, no header, no edge back to the first.
    const later = session('job', [{ role: 'assistant', text: 'z'.repeat(1_990) }, { role: 'assistant', text: '3 failed.' }], T0 + 10)
    const later2: StoredChunk[] = later.chunks.map((c) => ({ ...c, id: `${c.id}-later` }))
    const laterEdges = later2.slice(1).map((c, i) => ({ from: later2[i].id, to: c.id, relation: 'follows' }))
    const all = [...first.chunks, ...later2]
    const edges = [...first.edges, ...laterEdges]

    const without = run(all, edges)
    expect((await without.result).demoted).toBe(first.chunks.length)

    const withHashes = run(all, edges, { delegatedHashes: new Set([later2[0].hash as string]) })
    expect((await withHashes.result).demoted).toBe(all.length)
  })

  it('stays inside one session: not across another project or agent, and not along other relations', async () => {
    const job = session('job', [{ role: 'user', text: `${HEADER}\n\nGo.` }], T0)
    const otherProject = session('p2', [{ role: 'assistant', text: 'other repo' }], T0 + 1, { project: 'other' })
    const otherAgent = session('a2', [{ role: 'assistant', text: 'codex said' }], T0 + 2, { agentId: 'codex-history' })
    // Same folder name, another repo: told apart by the full-path key (F19).
    const otherKey = session('k2', [{ role: 'assistant', text: 'twin repo' }], T0 + 4, { projectKey: 'pk:/srv/app' })
    const unscoped = session('u2', [{ role: 'assistant', text: 'no project' }], T0 + 5, { project: undefined })
    const related = session('rel', [{ role: 'assistant', text: 'similar' }], T0 + 3)
    const edges = [
      ...job.edges,
      { from: job.chunks[0].id, to: otherProject.chunks[0].id, relation: 'follows' },
      { from: otherAgent.chunks[0].id, to: job.chunks[0].id, relation: 'follows' },
      { from: job.chunks[0].id, to: related.chunks[0].id, relation: 'relates-to' },
      { from: job.chunks[0].id, to: otherKey.chunks[0].id, relation: 'follows' },
      { from: unscoped.chunks[0].id, to: job.chunks[0].id, relation: 'follows' },
      // An edge to a memory outside the window.
      { from: job.chunks[0].id, to: 'old-1', relation: 'follows' },
    ]
    const h = run([...job.chunks, ...otherProject.chunks, ...otherAgent.chunks, ...related.chunks, ...otherKey.chunks, ...unscoped.chunks], edges)
    await h.result
    expect(h.demoted).toEqual(ids(job.chunks))
  })

  it("keeps the user's own sessions, local headless runs and quoted headers included", async () => {
    const exec = session('exec', [{ role: 'user', text: buildExecPrompt('List the TODOs.', 'a fact') }, { role: 'assistant', text: 'Two.' }], T0)
    const quoted = session('quote', [{ role: 'user', text: `What does this line mean? ${HEADER}` }, { role: 'assistant', text: 'It marks a job.' }], T0 + 1)
    const h = run([...exec.chunks, ...quoted.chunks], [...exec.edges, ...quoted.edges])
    expect(await h.result).toEqual({ checked: exec.chunks.length + quoted.chunks.length, demoted: 0 })
  })

  it('leaves alone what was corrected already, and counts only demotions that took', async () => {
    // Three turns too long to share a chunk: three chunks.
    const job = session('job', [
      { role: 'user', text: `${HEADER}\n\n${'g'.repeat(1_500)}` },
      { role: 'assistant', text: 'y'.repeat(1_500) },
      { role: 'assistant', text: `Done. ${'d'.repeat(1_500)}` },
    ], T0)
    expect(job.chunks).toHaveLength(3)
    const [a, b, c] = ids(job.chunks)
    const demote = vi.fn((id: string) => {
      if (id === b) throw new Error('log unwritable')
      return { ok: id !== c }
    })
    const h = run(job.chunks, job.edges, { isCorrected: (id) => id === a, demote })
    expect(await h.result).toEqual({ checked: 3, demoted: 0 })
    expect(demote.mock.calls.map(([id]) => id).sort()).toEqual([b, c].sort())
    expect(h.marks).toEqual([1])
  })

  it('pauses for the event loop while it matches and while it demotes', async () => {
    const chunks: StoredChunk[] = Array.from({ length: 520 }, (_, i) => ({
      id: `j${i}`,
      ts: T0 + i,
      agentId: 'claude-history',
      content: i === 0 ? `user: ${HEADER}\n\nGo.` : `assistant: part ${i}`,
      project: 'app',
    }))
    const edges = chunks.slice(1).map((c, i) => ({ from: chunks[i].id, to: c.id, relation: 'follows' }))
    const pause = vi.fn(async () => {})
    const h = run(chunks, edges, { yield: pause })
    expect((await h.result).demoted).toBe(520)
    // One pause after 500 chunks matched, then one every 25 demotions.
    expect(pause).toHaveBeenCalledTimes(1 + Math.floor(520 / 25))
  })

  it('uses a macrotask to pause when none is given', async () => {
    const job = session('job', [{ role: 'user', text: `${HEADER}\n\nGo.` }], T0)
    const many = Array.from({ length: 30 }, (_, i) => ({ ...job.chunks[0], id: `m${i}`, ts: T0 + i, hash: undefined }))
    const s = store(many)
    const result = await recheckLinkedHistory({ ...s, isCorrected: () => false, demote: () => ({ ok: true }), done: () => false, markDone: () => {} })
    expect(result.demoted).toBe(30)
  })
})

describe('the marker', () => {
  it('lives in userData under its own name, next to the lesson recheck', () => {
    const files = new Map<string, string>()
    const m = recheckMarker('/data', { exists: (p) => files.has(p), write: (p, t) => { files.set(p, t) } }, join, LINKED_RECHECK_MARKER)
    expect(m.done()).toBe(false)
    m.markDone()
    expect([...files.keys()]).toEqual([join('/data', 'linked-history-recheck.json')])
    expect(m.done()).toBe(true)
  })
})
