// P4: what a conversation-ingest PASS costs. The proof is counters (reads, parses, stats, hash questions,
// bytes, slices), never wall-clock ratios: the same pass is run with and without the mechanism and the
// counters are compared. Every behaviour test has its negative control next to it.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { ingestConversations, parseBySource, PARENT_HEAD_BYTES, type IngestChunk, type IngestStats } from '../../src/main/conversationIngest'
import { openWatermark } from '../../src/main/ingestWatermark'
import { passResult } from '../../src/main/ingestRuntime'
import { ownDialogue, delegationHeader } from '../../src/shared/headlessPrompt'
import { corpus, memoryIO, MIB, sessionText } from './_ingestCorpus'
import { referenceChunkTurns, referenceParseClaude } from './_ingestOracle'
import { assistantLine, delegated, lines, metaLine, mulberry32, noiseLine, userLine } from './_transcriptFixture'

afterEach(() => { vi.restoreAllMocks() })

const refHashes = (content: string, opts: { sealedOnly?: boolean } = {}): string[] => {
  const own = ownDialogue(referenceParseClaude(content))
  return own ? referenceChunkTurns(own, opts).map((c) => c.hash) : []
}

async function open() {
  const io = memoryIO()
  return { io, wm: await openWatermark(io, 'test-stamp') }
}

function fill(c: ReturnType<typeof corpus>, n: number, pairs = 3): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(c.add(`/proj/s${String(i).padStart(2, '0')}.jsonl`, sessionText(i, pairs)))
  return out
}

describe('unchanged files cost nothing', () => {
  it('a pass over 20 unchanged files reads none, parses none and asks the store nothing', async () => {
    const c = corpus()
    fill(c, 20)
    const { wm } = await open()
    const first = await ingestConversations(c.deps({ watermark: wm }))
    expect(first.filesScanned).toBe(20)
    expect(c.reads).toHaveLength(20)
    expect(first.chunksWritten).toBeGreaterThan(20)

    c.clearCounters()
    const parse = vi.spyOn(JSON, 'parse')
    const second = await ingestConversations(c.deps({ watermark: wm }))
    const parsed = parse.mock.calls.length
    parse.mockRestore()

    expect(c.reads).toEqual([]) // 0 readFile
    expect(parsed).toBe(0) // 0 JSON.parse
    // The store is asked ONE small question, whatever the corpus holds: do the few probe chunks the watermark kept
    // still exist? (If none does the store was wiped, and the marks are no good.) Never about the chunks of a file.
    expect(c.hashAsks).toHaveLength(1)
    expect(c.hashAsks[0].length).toBeLessThanOrEqual(8)
    expect(c.stats).toHaveLength(20) // a stat per file is the whole cost
    expect(second).toMatchObject({ filesScanned: 0, chunksWritten: 0, chunksSkipped: 0, truncated: false, unchanged: 20 })
  })

  // NEGATIVE CONTROL: the same second pass without a watermark is today's behaviour: everything again.
  it('control: without a watermark the same second pass reads and parses all 20 again', async () => {
    const c = corpus()
    fill(c, 20)
    await ingestConversations(c.deps())
    c.clearCounters()
    const parse = vi.spyOn(JSON, 'parse')
    const second = await ingestConversations(c.deps())
    expect(c.reads).toHaveLength(20)
    expect(parse.mock.calls.length).toBeGreaterThanOrEqual(20 * 6)
    expect(second.filesScanned).toBe(20)
    expect(second.unchanged).toBeUndefined()
  })

  it('a pass that finds a file unchanged does not wait for the typing gate either', async () => {
    const c = corpus()
    fill(c, 5)
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    const stuck = new Promise<void>(() => { /* typing never stops */ })
    const stats = await ingestConversations(c.deps({ watermark: wm, quiet: () => stuck }))
    expect(stats.unchanged).toBe(5)
  })
})

describe('one appended line', () => {
  it('re-reads only that file, and the chunks it offers are what a full parse of the new file gives', async () => {
    const c = corpus()
    const paths = fill(c, 20, 4)
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))

    const target = paths[7]
    const before = refHashes(c.files.get(target)!.content)
    c.append(target, lines(userLine('one more question about the build', { sessionId: 'sess-7', cwd: '/r' }), assistantLine('and the one more answer')))
    const after = refHashes(c.files.get(target)!.content)
    c.clearCounters()

    const stats = await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([target])
    expect(stats.filesScanned).toBe(1)
    expect(stats.unchanged).toBe(19)
    // exactly the chunks a full parse adds over the old file, in order: the idempotency contract
    expect(c.written.map((w) => w.hash)).toEqual(after.filter((h) => !before.includes(h)))
    // and every chunk of the new file is in the store, as they would be after a full pass
    for (const h of after) expect(c.known.has(h)).toBe(true)
  })

  it('a touched file (new mtime, same size) and a grown file (new size) are re-read; an identical stamp is not', async () => {
    const c = corpus()
    const [a, b, d] = fill(c, 3)
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    c.touch(a)
    c.append(b, lines(userLine('more', { sessionId: 'sess-1', cwd: '/r' })))
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads.sort()).toEqual([a, b].sort())
    expect(c.reads).not.toContain(d)
  })

  it('the mark is the stamp from BEFORE the read: a file appended to while it is being read is read again next pass', async () => {
    const c = corpus()
    const [a, b] = fill(c, 2)
    const { wm } = await open()
    c.hooks.onRead = (p) => { if (p === a) c.append(a, lines(userLine('written while we were reading', { sessionId: 'sess-0', cwd: '/r' }))) }
    await ingestConversations(c.deps({ watermark: wm }))
    c.hooks.onRead = undefined
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([a]) // b is unchanged, a moved under us
    expect(c.known.has(refHashes(c.files.get(a)!.content).slice(-1)[0])).toBe(true)
    expect(b).toBeDefined()
  })
})

describe('only a COMPLETE ingest is marked', () => {
  it('a chunk the store refuses leaves its file unmarked: the next pass retries it and only it', async () => {
    const c = corpus()
    const [a, b, d] = fill(c, 3)
    const { wm } = await open()
    let refused = 0
    c.hooks.writeFails = (chunk) => { if (chunk.text.includes('ask 1/1') && refused++ < 1) return true; return false }
    const first = await ingestConversations(c.deps({ watermark: wm }))
    expect(refused).toBe(1)
    expect(first.filesScanned).toBe(3)
    c.hooks.writeFails = undefined
    c.clearCounters()
    const second = await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([b]) // a and d were complete
    expect(second.chunksWritten).toBeGreaterThanOrEqual(1)
    expect(a).toBeDefined()
    expect(d).toBeDefined()
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([]) // now b is complete too
  })

  it('a pass cut by maxChunks inside a file leaves that file unmarked; the pass after it finishes the file', async () => {
    const c = corpus()
    const [a, b] = [c.add('/proj/a.jsonl', sessionText('a', 8, 700)), c.add('/proj/b.jsonl', sessionText('b', 2, 200))]
    const { wm } = await open()
    const first = await ingestConversations(c.deps({ watermark: wm, maxChunks: 2 }))
    expect(first).toMatchObject({ truncated: true, chunksWritten: 2, stop: 'chunks' })
    c.clearCounters()
    const total = new Set([...refHashes(c.files.get(a)!.content), ...refHashes(c.files.get(b)!.content)])
    let passes = 1
    for (let more = true; more && passes < 20; passes++) {
      const s = await ingestConversations(c.deps({ watermark: wm, maxChunks: 2 }))
      more = s.truncated
    }
    expect(passes).toBeLessThan(20)
    for (const h of total) expect(c.known.has(h)).toBe(true)
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm, maxChunks: 2 }))
    expect(c.reads).toEqual([]) // everything is marked once it is all in
  })

  it('a cap reached exactly on the last chunk of the last file still marks that file (no wasted re-read)', async () => {
    const c = corpus()
    const a = c.add('/proj/a.jsonl', sessionText('a', 2, 200))
    const { wm } = await open()
    const n = refHashes(c.files.get(a)!.content).length
    const first = await ingestConversations(c.deps({ watermark: wm, maxChunks: n }))
    expect(first.chunksWritten).toBe(n)
    c.clearCounters()
    const second = await ingestConversations(c.deps({ watermark: wm, maxChunks: n }))
    expect(c.reads).toEqual([])
    expect(second.truncated).toBe(false)
  })

  it('an unreadable file and a file that cannot be stat-ed are never marked, never skipped', async () => {
    const c = corpus()
    const [a, b] = fill(c, 2)
    const { wm } = await open()
    c.hooks.readFails = (p) => p === a
    await ingestConversations(c.deps({ watermark: wm }))
    c.hooks.readFails = undefined
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([a]) // a was never read the first time
    c.clearCounters()
    // no stat available: always processed, and nothing is marked
    await ingestConversations(c.deps({ watermark: wm, statFile: async () => null }))
    await ingestConversations(c.deps({ watermark: wm, statFile: async () => null }))
    expect(c.reads).toEqual([a, b, a, b])
  })

  it("a pass that wants the hashes of another computer's sessions (the one-time linked-history recheck) reads them every time, and gets the same hashes", async () => {
    const c = corpus()
    const own = c.add('/proj/own.jsonl', sessionText('own', 2))
    const job = c.add('/proj/job.jsonl', lines(userLine(delegated('Review the parser.'), { sessionId: 'sess-job', cwd: '/r' }), assistantLine('Reviewed.')))
    const { wm } = await open()
    const seen: string[][] = []
    const onDelegated = (h: string[]): void => { seen.push(h) }
    const first = await ingestConversations(c.deps({ watermark: wm, onDelegated }))
    expect(first.delegatedSkipped).toBe(1)
    c.clearCounters()
    const second = await ingestConversations(c.deps({ watermark: wm, onDelegated }))
    expect(c.reads).toEqual([job])
    expect(second.delegatedSkipped).toBe(1)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual(seen[0])
    expect(own).toBeDefined()
  })

  it('a file with nothing to remember (command noise only) is complete: marked, and not read again', async () => {
    const c = corpus()
    const noise = c.add('/proj/noise.jsonl', lines(metaLine(), noiseLine()))
    const empty = c.add('/proj/empty.jsonl', '')
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    c.clearCounters()
    const s = await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([])
    expect(s.unchanged).toBe(2)
    expect(noise).toBeDefined()
    expect(empty).toBeDefined()
  })
})

describe('a mark is a claim about the store (it was cleared, restored or re-keyed behind the watermark)', () => {
  it('a wiped store makes the next pass learn everything again, and the pass after it skips again', async () => {
    const c = corpus()
    fill(c, 6, 3)
    const { io, wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    const stored = c.known.size
    expect(stored).toBeGreaterThan(6)

    c.known.clear() // memory:clear, a restore, a new memory key: the store holds nothing now
    c.clearCounters()
    const again = await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toHaveLength(6) // every file is read again
    expect(again.chunksWritten).toBe(stored)
    expect(again.unchanged).toBe(0)
    expect(c.known.size).toBe(stored)

    c.clearCounters()
    const steady = await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([])
    expect(steady.unchanged).toBe(6)
    expect(JSON.parse(io.text as string).probes.length).toBeGreaterThan(0)
  })

  // NEGATIVE CONTROL: the same second pass over an intact store reads nothing.
  it('control: with the store intact the second pass reads nothing, and asks about at most 8 probe chunks, once', async () => {
    const c = corpus()
    fill(c, 6, 3)
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([])
    expect(c.hashAsks).toHaveLength(1)
    expect(c.hashAsks[0].length).toBeLessThanOrEqual(8)
  })

  it('a store that has lost SOME of what the marks vouch for (a few memories deleted) is still a store: the marks stay', async () => {
    const c = corpus()
    fill(c, 6, 3)
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    for (const h of wm.probes().slice(0, 3)) c.known.delete(h)
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([])
  })

  it('a store that cannot answer is not evidence of anything: the marks stay (and the pass reads nothing)', async () => {
    const c = corpus()
    fill(c, 6, 3)
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    c.clearCounters()
    const s = await ingestConversations(c.deps({ watermark: wm, hasHashes: async () => { throw new Error('memory host down') } }))
    expect(c.reads).toEqual([])
    expect(s.unchanged).toBe(6)
    expect(wm.size).toBe(6)
  })

  it('works through the synchronous per-chunk predicate too; with no way to ask the store at all the marks stay', async () => {
    const c = corpus()
    fill(c, 4, 3)
    const { wm } = await open()
    const syncDeps = (): Partial<Parameters<typeof ingestConversations>[0]> => ({ hasHashes: undefined, hasHash: (h: string) => c.known.has(h) })
    await ingestConversations(c.deps({ watermark: wm, ...syncDeps() }))
    c.known.clear()
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm, ...syncDeps() }))
    expect(c.reads).toHaveLength(4) // the wipe was seen through hasHash

    c.known.clear()
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm, hasHashes: undefined, hasHash: undefined }))
    expect(c.reads).toEqual([]) // nothing to ask: the marks are all there is, and they stay
  })

  it('a store wiped while its marks were never confirmed (a first pass after a restart) is seen at the start of that pass', async () => {
    const c = corpus()
    fill(c, 5, 3)
    const io = memoryIO()
    const first = await openWatermark(io, 'test-stamp')
    await ingestConversations(c.deps({ watermark: first }))
    c.known.clear()
    const restarted = await openWatermark(io, 'test-stamp') // the app was restarted over a wiped store
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: restarted }))
    expect(c.reads).toHaveLength(5)
  })
})

describe('a write that returned is not proof the store kept the chunk', () => {
  // The memory store answers a write whose disk append failed: it keeps the entry in memory, does not count
  // its hash as stored, and the old loop made up for it by offering the chunk again every pass.
  const dropping = (c: ReturnType<typeof corpus>, drop: (chunk: IngestChunk) => boolean) => async (chunk: IngestChunk): Promise<void> => {
    if (drop(chunk)) return // resolved, but not kept
    c.known.add(chunk.hash)
    c.written.push(chunk)
  }

  it('a chunk the store accepted but did not keep leaves its file unmarked: the next pass reads that file again, and only it', async () => {
    const c = corpus()
    const [a, b, d] = fill(c, 3, 3)
    const { wm } = await open()
    let lost = 0
    const first = await ingestConversations(c.deps({ watermark: wm, write: dropping(c, (ch) => ch.text.includes('ask 1/1') && lost++ < 1) }))
    expect(lost).toBe(1)
    expect(first.filesScanned).toBe(3)
    c.clearCounters()
    const second = await ingestConversations(c.deps({ watermark: wm })) // the store behaves now
    expect(c.reads).toEqual([b]) // a and d were kept in full
    expect(second.chunksWritten).toBeGreaterThanOrEqual(1)
    expect(a).toBeDefined()
    expect(d).toBeDefined()
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([]) // and now b is complete too
    for (const f of [a, b, d]) for (const h of refHashes(c.files.get(f)!.content)) expect(c.known.has(h)).toBe(true)
  })

  // NEGATIVE CONTROL: a store that keeps everything marks every file on the first pass.
  it('control: a store that keeps what it is given marks every file, with one membership question per file that wrote', async () => {
    const c = corpus()
    fill(c, 3, 3)
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(wm.size).toBe(3)
    // per file: the question before the writes, and one more to prove they were kept (no probes yet, so no question about them)
    expect(c.hashAsks.length).toBe(3 * 2)
  })

  it('a file whose chunks were all known already is marked without any extra question', async () => {
    const c = corpus()
    fill(c, 3, 3)
    await ingestConversations(c.deps()) // a first pass with no watermark stores everything
    c.clearCounters()
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(wm.size).toBe(3)
    expect(c.hashAsks.length).toBe(3) // one per file, before: nothing was written, so nothing needed proving
  })

  it('a store that cannot answer the proof leaves the file unmarked (read again next pass), never marked on faith', async () => {
    const c = corpus()
    const [a] = fill(c, 1, 3)
    const { wm } = await open()
    let asks = 0
    const hasHashes = async (hs: string[]): Promise<string[]> => {
      if (++asks > 1) throw new Error('memory host down') // the first question (before the writes) is answered, the proof is not
      return hs.filter((h) => c.known.has(h))
    }
    await ingestConversations(c.deps({ watermark: wm, hasHashes }))
    expect(wm.size).toBe(0)
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([a])
  })

  it('a cap that falls on the last chunk of a file still proves it before it marks it', async () => {
    const c = corpus()
    const a = c.add('/proj/a.jsonl', sessionText('a', 2, 400))
    const { wm } = await open()
    const n = refHashes(c.files.get(a)!.content).length
    let lost = 0
    await ingestConversations(c.deps({ watermark: wm, maxChunks: n, write: dropping(c, () => lost++ === n - 1) })) // the LAST chunk is dropped
    expect(wm.size).toBe(0)
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm, maxChunks: n }))
    expect(c.reads).toEqual([a])
    expect(wm.size).toBe(1)
  })

  it('a file with thousands of new chunks is proven in batches the store can answer (at most 4,000 per question)', async () => {
    const c = corpus()
    // One 9 MB turn: exactly 4,500 windows of 2,000, every one of them different (identical windows would hash alike and dedup to one).
    const blocks = Array.from({ length: 4_500 }, (_, i) => String(i).padStart(2_000, 'k'))
    const turn = userLine(blocks.join('').slice(0, 2_000 * 4_500 - 'user: '.length), { sessionId: 'big', cwd: '/r' })
    c.add('/proj/big.jsonl', lines(turn))
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    const sizes = c.hashAsks.map((a) => a.length)
    expect(sizes[0]).toBe(4_500) // the question before the writes: as it always was
    expect(sizes.slice(1).every((n) => n <= 4_000)).toBe(true)
    expect(sizes.slice(1).reduce((a, b) => a + b, 0)).toBe(4_500)
    expect(wm.size).toBe(1)
  })
})

describe("another computer's sessions are passed over by a pass that wants no hashes of them", () => {
  const JOB = (id: string): string => lines(userLine(delegated('Review the parser.'), { sessionId: `sess-${id}`, cwd: '/r' }), assistantLine('Reviewed.'))

  it('the drain and fast tiers (no onDelegated) skip a session an earlier pass found delegated, unread', async () => {
    const c = corpus()
    c.add('/proj/own.jsonl', sessionText('own', 2))
    c.add('/proj/job.jsonl', JOB('job'))
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm, onDelegated: () => {} })) // the full pass: reads both, marks both
    c.clearCounters()
    const drain = await ingestConversations(c.deps({ watermark: wm })) // wants no hashes
    expect(c.reads).toEqual([])
    expect(drain).toMatchObject({ filesScanned: 0, unchanged: 2, truncated: false })
  })

  // NEGATIVE CONTROL: the pass that WANTS the hashes reads it again, and reports the same ones.
  it('control: the pass that wants the hashes (onDelegated) still reads it every time', async () => {
    const c = corpus()
    const job = c.add('/proj/job.jsonl', JOB('job'))
    const { wm } = await open()
    const seen: string[][] = []
    const onDelegated = (h: string[]): void => { seen.push(h) }
    await ingestConversations(c.deps({ watermark: wm, onDelegated }))
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm, onDelegated }))
    expect(c.reads).toEqual([job])
    expect(seen).toHaveLength(2)
    expect(seen[0].length).toBeGreaterThan(0)
    expect(seen[1]).toEqual(seen[0])
  })

  it('a session a pass that wanted no hashes found delegated is marked too: the next such pass skips it, the one that wants hashes reads it', async () => {
    const c = corpus()
    const job = c.add('/proj/job.jsonl', JOB('job'))
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([job])
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([])
    const seen: string[][] = []
    await ingestConversations(c.deps({ watermark: wm, onDelegated: (h) => { seen.push(h) } }))
    expect(c.reads).toEqual([job])
    expect(seen).toHaveLength(1)
  })

  it('a delegated session that grows is read again (the mark is for the size and time it had)', async () => {
    const c = corpus()
    const job = c.add('/proj/job.jsonl', JOB('job'))
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    c.append(job, lines(assistantLine('One more reply.')))
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([job])
  })

  it('they do not eat the byte budget of a pass that skips them: the files behind them are not starved', async () => {
    const c = corpus()
    const jobs = [0, 1, 2, 3].map((i) => c.add(`/a/job${i}.jsonl`, JOB(`j${i}`), 6 * MIB)) // listed first, 6 MiB each
    const owns = [0, 1, 2, 3].map((i) => c.add(`/b/own${i}.jsonl`, sessionText(`o${i}`, 2), 1 * MIB))
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm, onDelegated: () => {} })) // a full pass with no budget marks everything
    for (const f of owns) c.touch(f) // they changed (same virtual size, new time)
    c.clearCounters()
    const skipping = await ingestConversations(c.deps({ watermark: wm, maxBytes: 8 * MIB }))
    expect(c.reads.slice().sort()).toEqual(owns.slice().sort())
    expect(skipping.truncated).toBe(false)
    // CONTROL: a pass that wants the hashes pays for reading the jobs, and the budget ends it among them.
    c.clearCounters()
    const wants = await ingestConversations(c.deps({ watermark: wm, onDelegated: () => {}, maxBytes: 8 * MIB }))
    expect(c.reads).toEqual(jobs.slice(0, 2))
    expect(wants).toMatchObject({ truncated: true, stop: 'bytes' })
  })
})

describe('a pass that gets nowhere asks for no follow-up (the memory host is down)', () => {
  const files = (c: ReturnType<typeof corpus>, n: number): void => {
    for (let i = 0; i < n; i++) c.add(`/proj/b${String(i).padStart(2, '0')}.jsonl`, sessionText(i, 1, 200), MIB)
  }

  it('a budget-limited pass over a store that refuses everything writes nothing, vouches for nothing, and does not ask for a drain', async () => {
    const c = corpus()
    files(c, 12)
    const { wm } = await open()
    const down = async (): Promise<never> => { throw new Error('memory host down') }
    const s = await ingestConversations(c.deps({ watermark: wm, maxBytes: 4 * MIB, write: down, hasHashes: down }))
    expect(s).toMatchObject({ truncated: true, stop: 'bytes', chunksWritten: 0, marked: 0 })
    expect(passResult(s).more).toBe(false)
  })

  // NEGATIVE CONTROL: with the store up the same pass vouches for files, and does ask for more.
  it('control: with the store up the same pass marks files and asks for more', async () => {
    const c = corpus()
    files(c, 12)
    const { wm } = await open()
    const s = await ingestConversations(c.deps({ watermark: wm, maxBytes: 4 * MIB }))
    expect(s).toMatchObject({ truncated: true, stop: 'bytes', marked: 4 })
    expect(passResult(s).more).toBe(true)
  })

  it('files that were all stored already (a cold watermark over a full store) are progress too: the pass asks for more', async () => {
    const c = corpus()
    files(c, 12)
    await ingestConversations(c.deps()) // the store holds everything; no watermark yet
    const { wm } = await open()
    const s = await ingestConversations(c.deps({ watermark: wm, maxBytes: 4 * MIB }))
    expect(s).toMatchObject({ truncated: true, stop: 'bytes', chunksWritten: 0, marked: 4 })
    expect(passResult(s).more).toBe(true)
  })
})

describe('the two tiers (the fast pass emits only sealed chunks)', () => {
  it('a sealed pass marks "sealed": the next FULL pass still reads the file for its trailing partial chunk, the next sealed one does not', async () => {
    const c = corpus()
    const a = c.add('/proj/a.jsonl', sessionText('a', 3, 400))
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm, chunkOptions: { sealedOnly: true } }))
    const afterSealed = new Set(c.known)
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm, chunkOptions: { sealedOnly: true } }))
    expect(c.reads).toEqual([]) // sealed over sealed: nothing to do
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([a]) // full over sealed: the partial tail is still owed
    expect(c.known.size).toBeGreaterThan(afterSealed.size)
    for (const h of refHashes(c.files.get(a)!.content)) expect(c.known.has(h)).toBe(true)
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm, chunkOptions: { sealedOnly: true } }))
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([]) // a full mark covers both
  })

  it('a non-default chunk size is never marked and never skipped (a mark made under other chunking would lie)', async () => {
    const c = corpus()
    fill(c, 3)
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm, chunkOptions: { maxChars: 120 } }))
    expect(wm.size).toBe(0)
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm, chunkOptions: { maxChars: 120 } }))
    expect(c.reads).toHaveLength(3)
  })
})

describe('when the marks are kept', () => {
  const stoppedAfter = (c: ReturnType<typeof corpus>, files: number) => () => c.reads.length >= files

  it('a pass that ends, or is cut by its caps, persists its marks; one stopped by quit or pause does not', async () => {
    for (const [name, over, persisted] of [
      ['complete', {}, true],
      ['maxChunks', { maxChunks: 3 }, true],
      ['maxBytes', { maxBytes: 1 }, true],
    ] as const) {
      const c = corpus()
      fill(c, 4)
      const { io, wm } = await open()
      await ingestConversations(c.deps({ watermark: wm, ...over }))
      expect(io.writes, name).toBe(persisted ? 1 : 0)
    }
    const c = corpus()
    fill(c, 6)
    const { io, wm } = await open()
    const stats = await ingestConversations(c.deps({ watermark: wm, stopped: stoppedAfter(c, 3) }))
    expect(stats).toMatchObject({ truncated: true, stop: 'stopped', filesScanned: 3 })
    expect(io.writes).toBe(0) // the patches were not flushed either: the next pass redoes these three
    expect(wm.pending).toBe(0)
    expect(wm.size).toBe(0)
  })

  it('a store that is LOCKED keeps no marks (a pass that ran into the lock must be redone after the unlock)', async () => {
    const c = corpus()
    fill(c, 3)
    const { io, wm } = await open()
    await ingestConversations(c.deps({ watermark: wm, canMark: async () => false }))
    expect(io.writes).toBe(0)
    expect(wm.size).toBe(0)
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm, canMark: async () => { throw new Error('host down') } }))
    expect(io.writes).toBe(0)
    expect(c.reads).toHaveLength(3) // read again: nothing was ever marked
    await ingestConversations(c.deps({ watermark: wm, canMark: async () => true }))
    expect(io.writes).toBe(1)
  })

  it('project backfill patches are flushed before the marks are kept, in the same order they were found', async () => {
    const c = corpus()
    fill(c, 2)
    const order: string[] = []
    const { wm } = await open()
    const flush = wm.flush.bind(wm)
    wm.flush = async () => { order.push('marks'); return flush() }
    // a first pass stores everything; a second one over a NEW store-less watermark finds every chunk known and patches their projects
    await ingestConversations(c.deps())
    await ingestConversations(c.deps({ watermark: wm, patchProjects: () => { order.push('patch') } }))
    expect(order).toEqual(['patch', 'marks'])
  })

  it('files that are gone from a COMPLETE listing leave the watermark; a partial listing leaves it alone', async () => {
    const c = corpus()
    const [a, b] = fill(c, 2)
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    c.files.delete(b)
    await ingestConversations(c.deps({ watermark: wm })) // not declared a full listing: nothing forgotten
    expect(wm.size).toBe(2)
    await ingestConversations(c.deps({ watermark: wm, fullListing: true }))
    expect(wm.size).toBe(1)
    expect(a).toBeDefined()
  })
})

describe('forgetting files that are gone (only from a listing that was complete)', () => {
  const setup = async () => {
    const c = corpus()
    const a = c.add('/claude/a.jsonl', sessionText('a', 2))
    const b = c.add('/claude/b.jsonl', sessionText('b', 2))
    const r1 = c.add('/codex/r1.jsonl', 'not a rollout')
    const r2 = c.add('/codex/r2.jsonl', 'nor is this')
    const { wm } = await open()
    const deps = (over: Record<string, unknown> = {}) =>
      c.deps({
        watermark: wm,
        sources: ['claude', 'codex'],
        listFiles: async (src) => (src === 'claude' ? [a, b] : [r1, r2]),
        fullListing: true,
        ...over,
      })
    return { c, a, b, r1, r2, wm, deps }
  }

  it('a pass cut short before it listed every source does not forget the marks of the sources it never reached', async () => {
    const { c, a, b, r1, r2, wm, deps } = await setup()
    await ingestConversations(deps())
    expect(wm.size).toBe(4)
    c.append(a, lines(userLine('more', { sessionId: 'sess-a', cwd: '/r' })))
    c.append(b, lines(userLine('more', { sessionId: 'sess-b', cwd: '/r' })))
    const cut = await ingestConversations(deps({ maxBytes: 1 })) // stops in claude: codex is never listed this pass
    expect(cut).toMatchObject({ truncated: true, stop: 'bytes' })
    expect(wm.size).toBe(4)
    for (const f of [r1, r2]) {
      const st = c.files.get(f)!
      expect(wm.isDone(f, { size: st.size, mtimeMs: st.mtimeMs }, 'full')).toBe(true)
    }
  })

  // NEGATIVE CONTROL: a COMPLETE pass over a listing without r2 does forget it, and only it.
  it('control: a complete pass whose listing lacks a file forgets that file and keeps the rest', async () => {
    const { r1, r2, wm, deps } = await setup()
    await ingestConversations(deps())
    await ingestConversations(deps({ listFiles: async (src: string) => (src === 'claude' ? ['/claude/a.jsonl', '/claude/b.jsonl'] : [r1]) }))
    expect(wm.size).toBe(3)
    expect(wm.isDone(r2, { size: 11, mtimeMs: 0 }, 'full')).toBe(false)
  })

  it('a source whose listing fails makes the listing incomplete: nothing is forgotten from it', async () => {
    const { wm, deps } = await setup()
    await ingestConversations(deps())
    await ingestConversations(deps({ listFiles: async (src: string) => { if (src === 'codex') throw new Error('EACCES'); return ['/claude/a.jsonl', '/claude/b.jsonl'] } }))
    expect(wm.size).toBe(4) // codex could not be listed, so its files are not "gone"
  })
})

describe('the per-pass byte budget', () => {
  const big = (c: ReturnType<typeof corpus>, n: number, mib: number): string[] => {
    const out: string[] = []
    for (let i = 0; i < n; i++) out.push(c.add(`/proj/big${String(i).padStart(3, '0')}.jsonl`, sessionText(`big${i}`, 1, 200), mib * MIB))
    return out
  }

  it('stops at the budget with truncated true, having read no file past it; the next pass takes the rest', async () => {
    const c = corpus()
    big(c, 12, 1)
    const { wm } = await open()
    const first = await ingestConversations(c.deps({ watermark: wm, maxBytes: 8 * MIB }))
    expect(c.reads).toHaveLength(8)
    expect(first).toMatchObject({ truncated: true, stop: 'bytes', filesScanned: 8, bytesRead: 8 * MIB })
    c.clearCounters()
    const second = await ingestConversations(c.deps({ watermark: wm, maxBytes: 8 * MIB }))
    expect(c.reads).toHaveLength(4)
    expect(second.truncated).toBe(false)
    expect(second.unchanged).toBe(8)
  })

  it('a cold index of 90 MiB drains in at most ceil(MiB / 8) passes, and then every pass reads nothing', async () => {
    const c = corpus()
    const n = 100
    for (let i = 0; i < n; i++) c.add(`/proj/s${String(i).padStart(3, '0')}.jsonl`, sessionText(i, 1, 200), Math.floor(0.9 * MIB))
    const totalMiB = (n * Math.floor(0.9 * MIB)) / MIB
    const { wm } = await open()
    let passes = 0
    let worst = 0
    for (let more = true; more && passes < 40; passes++) {
      const s = await ingestConversations(c.deps({ watermark: wm, maxBytes: 8 * MIB }))
      worst = Math.max(worst, s.bytesRead ?? 0)
      more = s.truncated
    }
    expect(passes).toBeLessThanOrEqual(Math.ceil(totalMiB / 8))
    expect(worst).toBeLessThan(8 * MIB + Math.floor(0.9 * MIB)) // never more than the budget plus the one file that crossed it
    expect(c.known.size).toBeGreaterThanOrEqual(n)
    c.clearCounters()
    const steady = await ingestConversations(c.deps({ watermark: wm, maxBytes: 8 * MIB }))
    expect(c.reads).toEqual([])
    expect(steady).toMatchObject({ truncated: false, unchanged: n })
  })

  it('one file bigger than the whole budget is still read whole (a file is never cut), and it ends the pass', async () => {
    const c = corpus()
    const [huge] = big(c, 1, 20)
    c.add('/proj/zz-small.jsonl', sessionText('zz', 1, 100))
    const { wm } = await open()
    const first = await ingestConversations(c.deps({ watermark: wm, maxBytes: 8 * MIB }))
    expect(c.reads).toEqual([huge])
    expect(first).toMatchObject({ truncated: true, stop: 'bytes', bytesRead: 20 * MIB })
  })

  it('unchanged files spend none of the budget, so a steady pass over a big corpus is never "truncated"', async () => {
    const c = corpus()
    big(c, 30, 4) // 120 MiB
    const { wm } = await open()
    for (let more = true; more;) more = (await ingestConversations(c.deps({ watermark: wm, maxBytes: 8 * MIB }))).truncated
    c.clearCounters()
    const s = await ingestConversations(c.deps({ watermark: wm, maxBytes: 8 * MIB }))
    expect(s.truncated).toBe(false)
    expect(c.reads).toEqual([])
  })

  // NEGATIVE CONTROL: no budget (today's default) reads the whole corpus in one pass.
  it('control: with no budget one pass reads every file', async () => {
    const c = corpus()
    big(c, 12, 1)
    const { wm } = await open()
    const s = await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toHaveLength(12)
    expect(s.truncated).toBe(false)
    expect(s.stop).toBeUndefined()
  })

  it('without a stat the size of what was read (its characters) is what the budget spends', async () => {
    const c = corpus()
    for (let i = 0; i < 5; i++) c.add(`/proj/t${i}.jsonl`, sessionText(`t${i}`, 6, 900))
    const s = await ingestConversations(c.deps({ statFile: undefined, maxBytes: 20_000 }))
    expect(s.truncated).toBe(true)
    expect(s.filesScanned).toBeLessThan(5)
    expect(s.bytesRead).toBeGreaterThanOrEqual(20_000)
  })
})

describe('synchronous slices', () => {
  /** A clock that moves 0.01 ms every time it is read, so "time" is a count of the work that consulted it. */
  const fakeClock = (step = 0.01) => { const k = { t: 0, now: () => (k.t += step) }; return k }

  /** A claude file of `n` short turns (one per line). */
  const longFile = (n: number): string => {
    const rnd = mulberry32(5)
    const out: string[] = []
    for (let i = 0; i < n; i++) out.push(i % 2 === 0 ? userLine(`q${i} ${Math.floor(rnd() * 1e9)}`, { sessionId: 's', cwd: '/r' }) : assistantLine(`a${i} ${Math.floor(rnd() * 1e9)}`))
    return lines(...out)
  }

  /**
   * Run a pass over a file of `n` lines that is already fully stored (so the pass writes nothing and every
   * yield is a slice boundary) and measure its synchronous stretches two ways: in fake milliseconds (the
   * clock moves 0.01 ms every time the code consults it) and in COUNTED work (JSON.parse calls between
   * yields: a counter, which no clock can distort).
   */
  async function sliced(sliceMs: number | undefined, n = 6_000) {
    const c = corpus()
    const path = c.add('/proj/long.jsonl', longFile(n))
    await ingestConversations(c.deps())
    c.clearCounters()
    const parse = vi.spyOn(JSON, 'parse')
    const clock = fakeClock()
    const marks: number[] = []
    const stretches: number[] = []
    let lastParses = 0
    const start = clock.t
    const stats = await ingestConversations(c.deps({
      now: clock.now,
      sliceMs,
      yield: async () => {
        marks.push(clock.t)
        stretches.push(parse.mock.calls.length - lastParses)
        lastParses = parse.mock.calls.length
      },
    }))
    stretches.push(parse.mock.calls.length - lastParses) // what ran after the last yield
    const parses = parse.mock.calls.length
    parse.mockRestore()
    const slices = marks.map((m, i) => m - (i === 0 ? start : marks[i - 1]))
    slices.push(clock.t - (marks.length ? marks[marks.length - 1] : start))
    return { c, path, stats, marks, slices, stretches, parses, total: clock.t - start }
  }

  it('no synchronous slice runs longer than the budget (25 ms) under a fake clock, and the file is cut into a few of them', async () => {
    const { stats, marks, slices, stretches, parses, total } = await sliced(25)
    expect(stats.filesScanned).toBe(1)
    expect(parses).toBeGreaterThanOrEqual(6_000)
    expect(marks.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...slices)).toBeLessThanOrEqual(25 + 0.5)
    expect(Math.max(...stretches)).toBeLessThanOrEqual(2_600) // 25 ms at 0.01 ms per look at the clock: counted work per stretch
    expect(total).toBeGreaterThan(50) // it really was more than two budgets of work
    expect(marks.length).toBeLessThanOrEqual(Math.ceil(total / 25) + 2) // and it does not yield more often than it must
  })

  // NEGATIVE CONTROL: with no slicing the same file is ONE uninterrupted stretch of every parse in it.
  it('control: with no time budget the same file is a single stretch (no yield at all, every parse in a row)', async () => {
    const { marks, stretches, parses } = await sliced(undefined)
    expect(marks).toHaveLength(0)
    expect(stretches).toEqual([parses])
    expect(parses).toBeGreaterThanOrEqual(6_000)
  })

  it('slicing changes nothing about what is stored: the same chunks, the same order, as an unsliced pass', async () => {
    const run = async (sliceMs: number | undefined) => {
      const c = corpus()
      c.add('/proj/long.jsonl', longFile(3_000))
      c.add('/proj/two.jsonl', sessionText('two', 5))
      const clock = fakeClock(0.05)
      await ingestConversations(c.deps({ now: clock.now, sliceMs }))
      return c.written.map((w: IngestChunk) => w.hash)
    }
    const a = await run(undefined)
    const b = await run(5)
    expect(a.length).toBeGreaterThan(10)
    expect(b).toEqual(a)
  })

  it('building the chunks is sliced too: a long file lets the event loop in many times while it is parsed, cut and hashed, before the first write', async () => {
    const c = corpus()
    const turns: string[] = []
    for (let i = 0; i < 4_000; i++) turns.push(i % 2 ? assistantLine('y'.repeat(900)) : userLine('x'.repeat(900) + i, { sessionId: 's', cwd: '/r' }))
    c.add('/proj/many.jsonl', lines(...turns))
    const clock = fakeClock(0.05)
    const marks: number[] = []
    let wrote = false
    let yieldsBeforeFirstWrite = 0 // a COUNT of event-loop turns, which no clock can distort
    const s = await ingestConversations(c.deps({
      now: clock.now,
      sliceMs: 25,
      yield: async () => {
        marks.push(clock.t)
        if (!wrote) yieldsBeforeFirstWrite++
      },
      write: async (chunk) => {
        wrote = true
        c.known.add(chunk.hash)
      },
    }))
    expect(s.filesScanned).toBe(1)
    expect(s.chunksWritten).toBeGreaterThan(1_500)
    // Parsing 4,000 lines is 8 slices of 25 fake ms; cutting and hashing 2,000 chunks is 4 more. With no slicing the
    // pass lets the loop in only after a write, so none come before the first one (that is what the base does).
    expect(yieldsBeforeFirstWrite).toBeGreaterThan(8)
    const slices = marks.map((m, i) => m - (i === 0 ? 0 : marks[i - 1]))
    slices.push(clock.t - marks[marks.length - 1]) // the stretch after the last yield counts too
    // Parsing runs straight into chunking with no event-loop turn between them: that is ONE stretch, and it is cut at the budget too.
    expect(Math.max(...slices)).toBeLessThanOrEqual(25 + 0.5 + 0.2)
  })

  it('the typing gate is asked at every slice boundary too, not only before a file', async () => {
    const c = corpus()
    c.add('/proj/long.jsonl', longFile(6_000))
    await ingestConversations(c.deps()) // stored: the pass below writes nothing, so every yield is a slice boundary
    const clock = fakeClock()
    let asks = 0
    let yields = 0
    const stats = await ingestConversations(c.deps({ now: clock.now, sliceMs: 25, yield: async () => { yields++ }, quiet: async () => { asks++ } }))
    expect(stats.filesScanned).toBe(1)
    expect(yields).toBeGreaterThanOrEqual(2)
    expect(asks).toBe(1 + yields) // once before the file, and once after each slice's yield
  })

  it('stopped() is asked at every slice boundary: a pass stopped mid-file ends within one slice and keeps nothing of that file', async () => {
    const c = corpus()
    const path = c.add('/proj/long.jsonl', longFile(6_000))
    const { io, wm } = await open()
    const clock = fakeClock()
    let yields = 0
    let gateAsks = 0
    const parse = vi.spyOn(JSON, 'parse')
    const stats = await ingestConversations(c.deps({
      watermark: wm,
      now: clock.now,
      sliceMs: 25,
      yield: async () => { yields++ },
      quiet: async () => { gateAsks++ },
      stopped: () => yields >= 2,
    }))
    const parsed = parse.mock.calls.length
    parse.mockRestore()
    expect(stats).toMatchObject({ truncated: true, stop: 'stopped', chunksWritten: 0 })
    expect(yields).toBe(2)
    // A pass that has been stopped does not wait (up to 2 s) for the user to stop typing: the gate was asked before
    // the file and after the first slice, and NOT at the boundary where the pass was stopped.
    expect(gateAsks).toBe(2)
    expect(parsed).toBeLessThanOrEqual(3 * 2_600) // two full slices plus the start of the third: not the whole file
    expect(io.writes).toBe(0)
    expect(wm.isDone(path, { size: c.files.get(path)!.size, mtimeMs: c.files.get(path)!.mtimeMs }, 'full')).toBe(false)
  })

  it('nothing starts while the user is typing: a held typing gate holds every slice and every file, then lets them go', async () => {
    const c = corpus()
    fill(c, 3)
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    let asked = 0
    const parse = vi.spyOn(JSON, 'parse')
    const running = ingestConversations(c.deps({ quiet: () => { asked++; return gate } }))
    // Wait for a COUNTER, not for a time: the pass has parked on the gate once it has asked it.
    for (let i = 0; i < 5_000 && asked === 0; i++) await new Promise((r) => setImmediate(r))
    expect(asked).toBeGreaterThanOrEqual(1)
    expect(parse.mock.calls.length).toBe(0)
    expect(c.reads).toEqual([])
    open()
    const stats = await running
    expect(stats.filesScanned).toBe(3)
    expect(parse.mock.calls.length).toBeGreaterThan(0)
  })

  // NEGATIVE CONTROL for the gate: without one, the same pass starts at once.
  it('control: without a typing gate nothing holds the pass back: it reads every file', async () => {
    const c = corpus()
    fill(c, 3)
    const stats = await ingestConversations(c.deps())
    expect(c.reads).toHaveLength(3)
    expect(stats.filesScanned).toBe(3)
  })
})

describe('reading the file in pieces', () => {
  it('a file read in pieces of any size (even one character) gives the same chunks as the whole file', async () => {
    const text = sessionText('piece', 14, 400) + lines(userLine('日本語 🎉 end', { sessionId: 'sess-piece', cwd: '/r' }))
    const whole = corpus()
    whole.add('/proj/a.jsonl', text)
    await ingestConversations(whole.deps())
    const expected = whole.written.map((w) => w.hash)
    expect(expected.length).toBeGreaterThan(3)

    const rnd = mulberry32(11)
    for (const piece of [1, 7, 64, 1_000, () => 1 + Math.floor(rnd() * 500), text.length, text.length + 5]) {
      const c = corpus()
      c.add('/proj/a.jsonl', text)
      const readText = async function* (): AsyncGenerator<string> {
        for (let i = 0; i < text.length;) {
          const n = typeof piece === 'function' ? piece() : piece
          yield text.slice(i, i + n)
          i += n
        }
      }
      await ingestConversations(c.deps({ readText, readFile: async () => { throw new Error('the whole file must not be read when pieces are offered') } }))
      expect(c.written.map((w) => w.hash), String(piece)).toEqual(expected)
    }
  })

  it('a last line with no newline, CRLF endings and blank lines parse as they always did', async () => {
    const text = [userLine('first', { sessionId: 's', cwd: '/r' }), '', '   ', assistantLine('second'), userLine('last, no newline', { sessionId: 's' })].join('\r\n')
    const viaWhole = corpus()
    viaWhole.add('/p/a.jsonl', text)
    await ingestConversations(viaWhole.deps())
    const viaPieces = corpus()
    viaPieces.add('/p/a.jsonl', text)
    await ingestConversations(viaPieces.deps({ readText: async function* () { for (let i = 0; i < text.length; i += 13) yield text.slice(i, i + 13) } }))
    expect(viaPieces.written.map((w) => w.text)).toEqual(viaWhole.written.map((w) => w.text))
    expect(viaWhole.written.map((w) => w.text).join('')).toContain('last, no newline')
  })

  it('a piece source that fails part-way is an unreadable file: nothing stored from it, not marked', async () => {
    const c = corpus()
    const a = c.add('/p/a.jsonl', sessionText('a', 3))
    const { wm } = await open()
    const stats = await ingestConversations(c.deps({
      watermark: wm,
      readText: async function* () { yield sessionText('a', 1); throw new Error('EBUSY') },
    }))
    expect(stats.filesScanned).toBe(0)
    expect(c.written).toHaveLength(0)
    expect(wm.size).toBe(0)
    expect(a).toBeDefined()
  })
})

describe('a subagent file and its parent', () => {
  const PARENT = '/proj/sess-A.jsonl'
  const CHILD = '/proj/sess-A/subagents/agent-1.jsonl'

  function tree(c: ReturnType<typeof corpus>, parentText: string) {
    c.add(PARENT, parentText)
    c.add(CHILD, sessionText('child', 2))
  }
  const head = (c: ReturnType<typeof corpus>) => async (p: string, max: number) => {
    c.heads.push(p)
    const f = c.files.get(p)!
    return { text: f.content.slice(0, max), eof: f.content.length <= max }
  }

  it('an appended subagent file is read alone: its parent is judged from its head, not read whole again', async () => {
    const c = corpus()
    tree(c, sessionText('parent', 400, 200)) // a long parent
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm, readHead: head(c) }))
    expect(c.reads).toEqual([PARENT, CHILD]) // both new: each read once; the parent's verdict came from its head
    expect(c.heads).toContain(PARENT)

    c.append(CHILD, lines(userLine('one more thing for the subagent', { sessionId: 'sess-child', cwd: '/r' })))
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm, readHead: head(c) }))
    expect(c.reads).toEqual([CHILD]) // only the file that changed
    expect(c.heads).toEqual([PARENT])
  })

  // NEGATIVE CONTROL: without a head reader the parent is read whole to find out (today's behaviour).
  it('control: without a head reader the changed subagent drags its whole parent in', async () => {
    const c = corpus()
    tree(c, sessionText('parent', 400, 200))
    const { wm } = await open()
    await ingestConversations(c.deps({ watermark: wm }))
    c.append(CHILD, lines(userLine('more', { sessionId: 'sess-child', cwd: '/r' })))
    c.clearCounters()
    await ingestConversations(c.deps({ watermark: wm }))
    expect(c.reads).toEqual([CHILD, PARENT])
  })

  /** Lines that make no turn at all (meta messages), enough of them to push the opening prompt past the head window. */
  const noiseBeyondHead = (): string[] => Array.from({ length: Math.ceil((PARENT_HEAD_BYTES * 1.5) / 4_000) }, () => userLine('m'.repeat(4_000), { isMeta: true }))

  it('a parent whose opening is not inside the head is read whole for its verdict, and the verdict is the same', async () => {
    const c = corpus()
    tree(c, lines(...noiseBeyondHead(), userLine('a perfectly ordinary first question', { sessionId: 'sess-A', cwd: '/r' }), assistantLine('an ordinary answer')))
    const stats = await ingestConversations(c.deps({ readHead: head(c) }))
    expect(c.heads).toEqual([PARENT]) // asked first
    expect(c.reads.filter((p) => p === PARENT)).toHaveLength(2) // once as a transcript of its own, once more because the head did not settle it
    expect(stats.filesScanned).toBe(2)
    expect(stats.delegatedSkipped).toBeUndefined()
  })

  it('a delegated parent whose opening is beyond the head is still found delegated, and its subagent is left out', async () => {
    const c = corpus()
    tree(c, lines(...noiseBeyondHead(), userLine(delegated('Review it.'), { sessionId: 'sess-A' }), assistantLine('ok')))
    const stats = await ingestConversations(c.deps({ readHead: head(c) }))
    expect(stats.delegatedSkipped).toBe(2) // the delegated parent itself, and the subagent with it
    expect(c.written).toHaveLength(0)
  })

  it("a delegated parent's subagent is another computer's work and is left out, from the head alone", async () => {
    const c = corpus()
    tree(c, lines(userLine(delegated('Review it.'), { sessionId: 'sess-A' }), assistantLine('ok')))
    const stats = await ingestConversations(c.deps({ readHead: head(c) }))
    expect(stats.delegatedSkipped).toBe(2)
    expect(c.written).toHaveLength(0)
    expect(c.heads).toEqual([PARENT])
    expect(c.reads.filter((p) => p === PARENT)).toHaveLength(1) // read once as its own transcript, never again for the verdict
  })

  it('a parent that cannot be read is "not delegated", as before', async () => {
    const c = corpus()
    c.add(CHILD, sessionText('child', 2))
    const stats = await ingestConversations(c.deps({ readHead: async () => { throw new Error('ENOENT') } }))
    expect(stats.filesScanned).toBe(1)
    expect(stats.chunksWritten).toBeGreaterThan(0)
  })
})

describe('the counters of a pass', () => {
  it('onPass reports files, skipped, bytes, hashes, known, written and the time spent', async () => {
    const c = corpus()
    fill(c, 4)
    const { wm } = await open()
    const seen: Array<Record<string, number | boolean>> = []
    const clock = { t: 0, now: () => (clock.t += 1) }
    await ingestConversations(c.deps({ watermark: wm, now: clock.now, onPass: (m) => { seen.push({ ...m }) } }))
    await ingestConversations(c.deps({ watermark: wm, now: clock.now, onPass: (m) => { seen.push({ ...m }) } }))
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ files: 4, unchanged: 0, truncated: false })
    expect(seen[0].bytes).toBeGreaterThan(1_000)
    expect(seen[0].hashed).toBeGreaterThan(4)
    expect(seen[0].written).toBe(seen[0].hashed)
    expect(seen[0].known).toBe(0)
    expect(seen[0].parseMsSum).toBeGreaterThan(0)
    expect(seen[0].parseMsMax).toBeGreaterThan(0)
    expect(seen[1]).toMatchObject({ files: 0, unchanged: 4, bytes: 0, hashed: 0, written: 0, known: 0, truncated: false })
  })

  it('onPass is called once for every way a pass can end: complete, capped, budgeted, stopped, and a throw from the store', async () => {
    const run = async (over: Record<string, unknown>) => {
      const c = corpus()
      fill(c, 4)
      const seen: unknown[] = []
      const s = await ingestConversations(c.deps({ onPass: (m) => { seen.push(m) }, ...over })).catch((e) => e)
      return { seen, s }
    }
    for (const over of [{}, { maxChunks: 2 }, { maxBytes: 1 }, { stopped: () => true }]) {
      const { seen } = await run(over)
      expect(seen, JSON.stringify(Object.keys(over))).toHaveLength(1)
    }
    const { seen } = await run({ listFiles: async () => { throw new Error('walk failed') } })
    expect(seen).toHaveLength(1) // a listing that throws is skipped, the pass still ends and is counted
  })
})

describe('what this module leaves exactly as it was', () => {
  it('the old stats shape is unchanged when none of the new deps is given', async () => {
    const c = corpus()
    fill(c, 2)
    const s: IngestStats = await ingestConversations(c.deps({ statFile: undefined }))
    expect(Object.keys(s).sort()).toEqual(['chunksSkipped', 'chunksWritten', 'filesScanned', 'truncated'].sort())
  })

  it('parseBySource is the parser of old: a sanity pin for the three sources', () => {
    expect(parseBySource('claude', userLine('hi', { sessionId: 's' }) + '\n').map((t) => t.text)).toEqual(['hi'])
    expect(parseBySource('gemini', 'not json')).toEqual([])
    expect(delegationHeader('m', '/r')).toContain('/r')
  })
})
