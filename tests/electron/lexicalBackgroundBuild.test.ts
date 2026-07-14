// The BM25 index builds in the BACKGROUND, yielded — this is the launch-freeze fix, and
// these are the tests that would have caught the freeze.
//
// WHY THIS FILE EXISTS. Every earlier test of this code passed throughout the entire period
// the app froze for ~10 seconds at launch, because they all built the index over a handful of
// documents, where it completes inside the first chunk and never yields at all. A test for a
// freeze that never freezes anything proves nothing. So these tests deliberately force the
// yielding path (`_setLexicalYieldMsForTests(0)`) and then OBSERVE THE EVENT LOOP with a
// self-rescheduling setImmediate watchdog — the only instrument that can tell "the thread was
// served" from "the thread was dead". Against the old synchronous build the watchdog ticks
// ZERO times. That is the whole assertion.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory, memoryWrite, memorySearch, memoryDelete, memoryClear, memoryCount,
  _resetForTests, _setEmbeddingsAvailable, _setEmbedFnForTests,
  _setLexicalYieldMsForTests, _whenLexicalSettledForTests, _isLexicalReadyForTests, _lexicalSizeForTests,
} from '../../src/main/swarmMemory'

let tmp: string

// The build walks the hot window in chunks of 200, so 500 entries guarantees several chunks
// (and therefore several yields) once the yield budget is forced to 0.
const N = 500

/**
 * A self-rescheduling setImmediate counter. Each turn of the event loop increments it.
 *
 * This is the ONLY honest way to ask "was the main thread available while that ran?" — you
 * cannot ask a timer, because a timer that never fires reports a max gap of 0, which reads as
 * perfect health when it actually means the loop never turned. Zero ticks = the loop was never
 * served = the app was frozen.
 */
function watchLoop(): { stop: () => { ticks: number; maxGapMs: number } } {
  let ticks = 0
  let maxGapMs = 0
  let last = Date.now()
  let running = true
  const tick = (): void => {
    if (!running) return
    const now = Date.now()
    const gap = now - last
    if (gap > maxGapMs) maxGapMs = gap
    last = now
    ticks++
    setImmediate(tick)
  }
  setImmediate(tick)
  return {
    stop: () => {
      running = false
      return { ticks, maxGapMs }
    },
  }
}

/** Seed a store with N entries on disk, then re-init so the reload triggers a real rebuild. */
async function seedAndReload(yieldMs = 0): Promise<void> {
  _resetForTests()
  _setEmbeddingsAvailable(false)
  _setEmbedFnForTests(async () => null)
  initSwarmMemory(tmp)
  for (let i = 0; i < N; i++) {
    await memoryWrite({ agentId: 'claude', kind: 'note', content: `entry ${i} zebrafish${i} alpha beta gamma delta epsilon` })
  }
  // Re-init from the shard on disk: that is the launch path, and it is what calls
  // rebuildVectorIndex -> scheduleLexicalRebuild.
  _resetForTests()
  _setEmbeddingsAvailable(false)
  _setEmbedFnForTests(async () => null)
  _setLexicalYieldMsForTests(yieldMs) // AFTER the reset, which restores the 8ms default
  initSwarmMemory(tmp)
}

describe('BM25 index builds in the background, yielded (the launch freeze)', () => {
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-bg-')) })
  afterEach(() => { _resetForTests(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('does not block init — the index is still unbuilt when initSwarmMemory returns', async () => {
    await seedAndReload()
    // The store is fully loaded (entries are in RAM)...
    expect(memoryCount()).toBe(N)
    // ...but the expensive index is NOT built yet. This is the whole point: launch does not
    // pay for it. Before this change, initSwarmMemory did not return until it was finished.
    expect(_isLexicalReadyForTests()).toBe(false)
    await _whenLexicalSettledForTests()
    expect(_isLexicalReadyForTests()).toBe(true)
  })

  it('SERVES THE EVENT LOOP while building (the freeze regression test)', async () => {
    await seedAndReload()
    expect(_isLexicalReadyForTests()).toBe(false) // a build is genuinely in flight

    const w = watchLoop()
    await _whenLexicalSettledForTests()
    const { ticks } = w.stop()

    expect(_isLexicalReadyForTests()).toBe(true)
    // The old build was one unbroken synchronous loop: the event loop could not turn even
    // once while it ran, so this would be 0 and the app painted "(Not Responding)".
    expect(ticks).toBeGreaterThan(0)
  })

  it('yields via setImmediate, not a microtask — a resolved-promise await would NOT yield', async () => {
    // The distinction is not academic: `await` on an ALREADY-RESOLVED promise queues a
    // microtask, and Node drains the microtask queue to completion before turning the event
    // loop. A build "yielding" that way blocks exactly as hard as one that never yields — that
    // was the v1.25.11 freeze (2,777 ms of work, ZERO loop ticks, same wall time as the
    // version that yielded properly). So assert the loop turned MULTIPLE times, which only a
    // macrotask yield can produce.
    await seedAndReload()
    const w = watchLoop()
    await _whenLexicalSettledForTests()
    const { ticks } = w.stop()
    expect(ticks).toBeGreaterThanOrEqual(Math.floor(N / 200)) // at least one turn per chunk
  })

  it('a search awaits the build and still sees EVERY document (never a half-built index)', async () => {
    await seedAndReload()
    expect(_isLexicalReadyForTests()).toBe(false)
    // Ask for a token that lives only in the LAST entry. If search fused against a partially
    // built index it would miss it — and worse, it would score every other query against an
    // idf computed from a document count that was still climbing.
    const hits = await memorySearch({ query: `zebrafish${N - 1}`, limit: 5 })
    expect(hits.some((h) => h.content.includes(`zebrafish${N - 1}`))).toBe(true)
    expect(_isLexicalReadyForTests()).toBe(true) // the search waited for it
  })

  it('a memory DELETED mid-build is not resurrected by the build', async () => {
    // NOTE ON WHAT THIS ASSERTS, because the obvious version of this test is VACUOUS and I
    // shipped it before catching myself: you CANNOT detect this bug by searching for the
    // deleted memory. memorySearch resolves every lexical hit against `entries`, and a deleted
    // memory is not there — so it is filtered out even when the index is thoroughly corrupted.
    // A test that searches for it passes with the retraction entirely removed (verified by
    // mutation). The only observable is the index's document COUNT: a phantom doc still counts
    // toward N and totalLen, so it corrupts the idf/avgdl of every OTHER query, forever.
    await seedAndReload()
    const ids = await memorySearch({ query: 'alpha beta gamma delta', limit: 200 })
    const victim = ids.find((h) => h.content.includes(`zebrafish${N - 2} `) || h.content.endsWith(`zebrafish${N - 2}`))
      ?? ids.find((h) => h.content.includes(`zebrafish${N - 2}`))
    expect(victim).toBeTruthy()

    // Fresh build to race against (the search above settled the previous one).
    await seedAndReload()
    expect(_isLexicalReadyForTests()).toBe(false) // the victim's chunk has not been reached
    memoryDelete(victim!.id)

    await _whenLexicalSettledForTests()

    // THE assertion: the index must not believe in a memory that no longer exists.
    expect(memoryCount()).toBe(N - 1)
    expect(_lexicalSizeForTests()).toBe(memoryCount())
  })

  it('memoryClear during a build is not undone by the build', async () => {
    await seedAndReload()
    expect(_isLexicalReadyForTests()).toBe(false)

    memoryClear() // the in-flight build holds a snapshot of everything we just erased
    await _whenLexicalSettledForTests()

    expect(memoryCount()).toBe(0)
    // Again: searching proves nothing here (the `allow` gate filters everything once `entries`
    // is empty, however corrupt the index is). The index's own size is the observable — without
    // retiring the in-flight build, it happily re-indexes all N cleared memories.
    expect(_lexicalSizeForTests()).toBe(0)
    const hits = await memorySearch({ query: 'alpha beta gamma', limit: 20 })
    expect(hits).toHaveLength(0)
  })

  it('a write DURING a build is searchable, and does not corrupt the postings order', async () => {
    await seedAndReload()
    expect(_isLexicalReadyForTests()).toBe(false)

    // A concurrent write allocates a doc slot while the background build is mid-walk. The
    // packed postings are kept in ASCENDING doc order (search and remove both binary-search
    // against that), so a write landing between two chunks must not break the ordering.
    await memoryWrite({ agentId: 'codex', kind: 'fact', content: 'kumquat marmalade written during the build' })
    await _whenLexicalSettledForTests()

    const fresh = await memorySearch({ query: 'kumquat marmalade', limit: 5 })
    expect(fresh.some((h) => h.content.includes('kumquat marmalade'))).toBe(true)

    // ...and the pre-existing documents are all still correctly indexed around it.
    const old = await memorySearch({ query: 'zebrafish7', limit: 5 })
    expect(old.some((h) => h.content.includes('zebrafish7'))).toBe(true)
    expect(memoryCount()).toBe(N + 1)
  })

  it('a superseded build is dropped — the newer one wins', async () => {
    await seedAndReload()
    expect(_isLexicalReadyForTests()).toBe(false)
    // Re-init while the first build is still in flight. The old build must abandon its work at
    // its next chunk rather than write into the index the new one is filling.
    await seedAndReload()
    await _whenLexicalSettledForTests()

    expect(_isLexicalReadyForTests()).toBe(true)
    const hits = await memorySearch({ query: 'zebrafish3', limit: 5 })
    expect(hits.some((h) => h.content.includes('zebrafish3'))).toBe(true)
    expect(memoryCount()).toBe(N) // not doubled — the superseded build did not double-index
  })
})
