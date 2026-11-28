import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'
import {
  RECHECK_REASON,
  _resetRecheckMarkersForTests,
  RECHECK_V2_MARKER,
  RECHECK_V2_REASON,
  markerFs,
  recheckMarker,
  recheckStoredLessons,
  recheckStoredLessonsV2,
  wouldStillWrite,
  wouldStillWriteV2,
  type RecheckDeps,
  type StoredLesson,
} from '../../src/main/mnemeLessonRecheck'
import { lessonSubstance, substanceBand } from '../../src/main/lessonSubstance'

let n = 0
const lesson = (content: string, memoryType: string, kind = 'fact', ts = 1000 - n): StoredLesson =>
  ({ id: `m${++n}`, ts, agentId: 'mneme', kind, content, memoryType })

// Stored verbatim in a real brain between 2026-09-25 and 2026-10-06.
const JUNK: StoredLesson[] = [
  lesson('Problem: Confirming the installers, adding the release notes, and checking the email notification: → Fix: I added the release notes covering Linked machines, the setup steps and the fixes.', 'procedural'),
  lesson('Problem: When he does, adding each person takes one API call. → Fix: - **SDP 73754:** still In Progress, not resolved.', 'procedural'),
  lesson('Problem: Reading the extractor and its base class first. → Fix: Only `GetContentBlocksFromFile` routes by extension, so the fix covers that extractor\'s whole path.', 'procedural'),
  lesson('Problem: The OCR check found the cause of the prod "PDF not valid" failures, and the fix is small. → Fix: Want me to send either message and write the OCR fix PR?', 'procedural'),
  lesson('Problem: - **Full suite with coverage (`--retry=2`, as CI):** 608 files passed (1 skipped), 14,626 tests passed (16 skipped), 0 failed. → Fix: The full suite is running with the macOS fixes and the ⌘Q fix.', 'procedural'),
  lesson('- **Password:** the Samba password you chose when running the script.', 'semantic', 'decision'),
  lesson('- decide with Mike whether OrchDebug goes beyond Dev. The rest:', 'semantic', 'decision'),
  lesson('| **ADO tokens** | Not decided. All 4 still exist, valid to Sep 2027.', 'semantic', 'decision'),
  lesson("Pulling the specifics for 73138 from today's log so the plan is concrete:", 'semantic', 'decision'),
  lesson('If working across machines turns out to be worth it, build "Linked machines" as the version that works both ways and includes Gemini.', 'semantic'),
  lesson('The old values are saved, so I can put them back if something turns out to need them.', 'semantic'),
  lesson('Recording the new failure signature in the DP troubleshooting memory, since the old note that drafts live in memory needs updating.', 'semantic'),
]

// Real lessons, from the same store or shaped like the distiller's tests: these must stay as they are.
const KEEP: StoredLesson[] = [
  lesson('Problem: - The one error during the run was an Anthropic "The PDF specified was not valid" rejection. → Fix: That\'s the known PNG-saved-as-`.pdf` problem, fixed in PR !40758.', 'procedural'),
  lesson('Problem: - an iteration path `MSI-PAS\\Current` that doesn\'t exist in any project. → Fix: - **Fix:** [PR 40835](https://dev.azure.com/x/_git/y/pullrequest/40835), merged into the sandbox branch and deployed.', 'procedural'),
  lesson('Problem: The patch failed safely (nothing was written): the file contains a literal "·" character where my anchor had its `\\u00b7` escape. → Fix: Fixing the anchor in my patch to match it.', 'procedural'),
  lesson('Problem: npm install dies with EACCES on the global prefix. → Fix: Fixed by switching to a user-level prefix.', 'procedural'),
  lesson('We decided to use HNSW instead of brute force for the vector index.', 'semantic', 'decision'),
  lesson('The plan is clear. Use HNSW for the vector index instead of brute force.', 'semantic', 'decision'),
  lesson('It turns out the cache key ignored the locale, so every language shared one entry.', 'semantic'),
  lesson('Root cause: the watcher fired before the file was flushed.', 'semantic'),
  // Not shapes the heuristic distiller writes: never judged.
  lesson('Use a per-user npm prefix to avoid EACCES on global installs.', 'procedural'),
  lesson('EACCES', 'entity'),
  lesson('Summary of 3 related memories:\n- a\n- b\n- c', 'summary', 'note'),
  lesson('Rotating the key means updating the Key Vault reference first.', 'semantic'),
]

describe('wouldStillWrite', () => {
  it.each(JUNK.map((l) => [l.content.slice(0, 70), l] as const))('demotes: %s', (_label, l) => {
    expect(wouldStillWrite(l)).toBe(false)
  })

  it.each(KEEP.map((l) => [l.content.slice(0, 70), l] as const))('keeps: %s', (_label, l) => {
    expect(wouldStillWrite(l)).toBe(true)
  })

  it('judges a decision too short to be a sentence as it stands', () => {
    expect(wouldStillWrite(lesson('Go.', 'semantic', 'decision'))).toBe(false)
  })

  it('judges a lesson that was cut at 600 characters on what is left', () => {
    const cut = lesson(`Problem: The build failed on Linux. → Fix: Fixed by pinning the toolchain${' and more'.repeat(80)}…`, 'procedural')
    expect(wouldStillWrite(cut)).toBe(true)
  })
})

function deps(store: StoredLesson[], over: Partial<RecheckDeps> = {}) {
  const demoted: string[] = []
  let marked = false
  const d: RecheckDeps & { demoted: string[]; marked: () => boolean } = {
    list: vi.fn(async ({ limit, before }) =>
      store
        .filter((l) => before === undefined || l.ts < before)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)),
    isCorrected: () => false,
    demote: vi.fn((id: string) => { demoted.push(id); return { ok: true } }),
    done: async () => marked,
    markDone: async () => { marked = true },
    ...over,
    demoted,
    marked: () => marked,
  }
  return d
}

describe('recheckStoredLessons', () => {
  it('demotes exactly the junk, with the reason, and marks the pass done', async () => {
    const d = deps([...JUNK, ...KEEP])
    expect(await recheckStoredLessons(d)).toEqual({ checked: JUNK.length + KEEP.length, demoted: JUNK.length })
    expect(new Set(d.demoted)).toEqual(new Set(JUNK.map((l) => l.id)))
    expect(d.demote).toHaveBeenCalledWith(JUNK[0].id, RECHECK_REASON)
    expect(d.marked()).toBe(true)
  })

  it('runs once per install', async () => {
    const d = deps(JUNK, { done: async () => true })
    expect(await recheckStoredLessons(d)).toEqual({ checked: 0, demoted: 0, skipped: 'already-run' })
    expect(d.list).not.toHaveBeenCalled()
  })

  it('leaves alone a lesson someone already corrected, and keeps going when a demotion fails', async () => {
    const [a, b, c] = JUNK
    const d = deps([a, b, c], {
      isCorrected: (id) => id === a.id,
      demote: vi.fn((id: string) => { if (id === b.id) throw new Error('log unwritable'); return { ok: id !== c.id } }),
    })
    expect(await recheckStoredLessons(d)).toEqual({ checked: 3, demoted: 0 })
    expect(d.demote).toHaveBeenCalledTimes(2)
  })

  it('pages through more lessons than one listing returns, including ones sharing a timestamp', async () => {
    const many: StoredLesson[] = []
    for (let i = 0; i < 1203; i++) {
      // Groups of three share a timestamp, so page boundaries fall inside a group.
      many.push({ id: `p${i}`, ts: 10_000 - Math.floor(i / 3), agentId: 'mneme', kind: 'decision', content: '- decide later.', memoryType: 'semantic' })
    }
    const d = deps(many)
    expect(await recheckStoredLessons(d)).toEqual({ checked: 1203, demoted: 1203 })
    expect(new Set(d.demoted).size).toBe(1203)
  })

  it('yields to the event loop between batches of demotions', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `y${i}`, ts: 100 - i, agentId: 'mneme', kind: 'decision', content: '- decide later.', memoryType: 'semantic' }))
    const yieldFn = vi.fn(async () => {})
    expect(await recheckStoredLessons(deps(many, { yield: yieldFn }))).toEqual({ checked: 60, demoted: 60 })
    expect(yieldFn).toHaveBeenCalledTimes(2) // after the 25th and the 50th
  })

  // Any interval from 21 to 30 gives two yields over 60 demotions, so the count alone does not say the interval is 25.
  it('yields after exactly the 25th and the 50th demotion', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `w${i}`, ts: 100 - i, agentId: 'mneme', kind: 'decision', content: '- decide later.', memoryType: 'semantic' }))
    const d = deps(many)
    const at: number[] = []
    d.yield = async () => { at.push(d.demoted.length) }
    await recheckStoredLessons(d)
    expect(at).toEqual([25, 50])
  })

  it('yields with a real macrotask by default', async () => {
    const many = Array.from({ length: 26 }, (_, i) => ({ id: `z${i}`, ts: 100 - i, agentId: 'mneme', kind: 'decision', content: '- decide later.', memoryType: 'semantic' }))
    let ticks = 0
    const tick = (): void => { ticks++; if (ticks < 50) setImmediate(tick) }
    setImmediate(tick)
    await recheckStoredLessons(deps(many))
    expect(ticks).toBeGreaterThan(0)
  })

  it('pages past lessons with no timestamp without looping', async () => {
    const undated = Array.from({ length: 500 }, (_, i) => ({ id: `u${i}`, ts: 0, agentId: 'mneme', kind: 'decision', content: '- decide later.', memoryType: 'semantic' }))
    const d = deps(undated)
    expect(await recheckStoredLessons(d)).toEqual({ checked: 500, demoted: 500 })
    expect(d.list).toHaveBeenLastCalledWith({ agentId: 'mneme', limit: 500, before: 1 })
  })

  it('stops instead of looping when a page brings nothing new', async () => {
    const same = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, ts: 5, agentId: 'mneme', kind: 'fact', content: 'x', memoryType: 'entity' }))
    const d = deps(same, { list: vi.fn(async () => same) })
    expect(await recheckStoredLessons(d)).toEqual({ checked: 500, demoted: 0 })
    expect(d.list).toHaveBeenCalledTimes(2)
  })

  it('leaves the pass unmarked when the store cannot be listed, so it runs again', async () => {
    const d = deps([], { list: vi.fn(async () => { throw new Error('memory host stopped') }) })
    await expect(recheckStoredLessons(d)).rejects.toThrow('memory host stopped')
    expect(d.marked()).toBe(false)
  })

  // The marker is asked and recorded off the main thread now (async fs), so the pass has to wait for both.
  it('waits for the marker: a pass not yet known to have run starts only once the answer is in', async () => {
    let answer!: (v: boolean) => void
    const d = deps(JUNK, { done: () => new Promise<boolean>((r) => { answer = r }) })
    const result = recheckStoredLessons(d)
    await macrotasks()
    expect(d.list).not.toHaveBeenCalled()
    answer(true)
    expect(await result).toEqual({ checked: 0, demoted: 0, skipped: 'already-run' })
    expect(d.list).not.toHaveBeenCalled()
  })

  it('reports the pass finished only once its marker is recorded', async () => {
    let recorded!: () => void
    const markDone = vi.fn(() => new Promise<void>((r) => { recorded = r }))
    let finished = false
    const result = recheckStoredLessons(deps(JUNK, { markDone })).then((r) => { finished = true; return r })
    await macrotasks()
    expect(markDone).toHaveBeenCalledTimes(1)
    expect(finished).toBe(false)
    recorded()
    expect(await result).toEqual({ checked: JUNK.length, demoted: JUNK.length })
    expect(finished).toBe(true)
  })
})

/** Let every promise and setImmediate already queued run (a pass yields with setImmediate). */
async function macrotasks(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r))
}

/** A promise the test settles itself. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// ── 1.55.0: the second pass, judged by the substance gate (lessonSubstance.ts) ──────────────────────────
// Invented lessons. The first pass asked "would the 1.50.1 extractor still write this?"; this one also asks
// "would the substance gate still store it?". It demotes, as the first did, and never deletes.
const GATE_DROP: Array<[string, string, string]> = [
  ['an announcement', 'Root cause found.', 'semantic'],
  ['narration', "I'll start with the failing spec and then look through the logs.", 'semantic'],
  ['a progress report', 'Still in progress today; waiting on the reviewer, will pick it up this afternoon.', 'semantic'],
  ['a question to the user', 'Want me to open the pull request now, or should I wait for the other branch to land?', 'semantic'],
  ['a stapled pair with nothing in it', 'Problem: the build failed again. → Fix: I fixed the build and pushed it.', 'procedural'],
]
const GATE_KEEP: Array<[string, string, string]> = [
  ['a rule with identifiers', 'Never call `app.quit()` from the `will-quit` handler because it re-enters the quit sequence.', 'semantic'],
  ['a recipe', 'Problem: npm install dies with EACCES on the global prefix. → Fix: Fixed by switching to a user-level prefix with `npm config set prefix`.', 'procedural'],
  ['a borderline lesson (stored as a candidate today, so not failing)', 'Check the defaults in `memorySettings.ts` before changing the primer size.', 'semantic'],
]

describe('wouldStillWriteV2', () => {
  it.each(GATE_DROP)('demotes %s', (_what, content, memoryType) => {
    expect(substanceBand(lessonSubstance(content).score)).toBe('drop') // the fixture is what it says it is
    expect(wouldStillWriteV2(lesson(content, memoryType, 'fact'))).toBe(false)
  })

  it.each(GATE_KEEP)('keeps %s', (_what, content, memoryType) => {
    expect(wouldStillWriteV2(lesson(content, memoryType, 'fact'))).toBe(true)
  })

  it('still applies the 1.50.1 extractor rules first', () => {
    // Plenty of substance, but the old rules read the first sentence as a to-do, not a decision.
    const todo = lesson('Decide with `OrchDebug` and `Mike` whether the retry helper in retryHelper.ts goes beyond dev, because it is risky.', 'semantic', 'decision')
    expect(substanceBand(lessonSubstance(todo.content).score)).toBe('keep')
    expect(wouldStillWrite(todo)).toBe(false)
    expect(wouldStillWriteV2(todo)).toBe(false)
  })

  it('never judges what is not a lesson the distiller writes: entity stubs, summaries, untyped rows', () => {
    expect(wouldStillWriteV2(lesson('EACCES', 'entity'))).toBe(true)
    expect(wouldStillWriteV2(lesson('Summary of 3 related memories:\n- a\n- b\n- c', 'summary', 'note'))).toBe(true)
    expect(wouldStillWriteV2({ id: 'x', ts: 1, content: 'Done.' })).toBe(true)
    expect(wouldStillWriteV2(lesson('Done.', 'episodic'))).toBe(true)
  })

  it('leaves a row that is not text alone, rather than throw and abort the whole pass for good', () => {
    // A pass that throws on one bad row never reaches its marker, so it would stop at that row on every launch.
    for (const content of [undefined, null, 42, { text: 'x' }]) {
      expect(wouldStillWriteV2({ id: 'x', ts: 1, content: content as unknown as string, memoryType: 'semantic' })).toBe(true)
      expect(wouldStillWriteV2({ id: 'x', ts: 1, content: content as unknown as string, memoryType: 'procedural' })).toBe(true)
    }
  })

  it('judges an empty lesson as the gate does: nothing in it', () => {
    expect(wouldStillWriteV2(lesson('', 'semantic'))).toBe(false)
    expect(wouldStillWriteV2(lesson('   ', 'procedural'))).toBe(false)
  })
})

describe('recheckStoredLessonsV2', () => {
  const store = (): StoredLesson[] => [
    ...GATE_DROP.map(([, content, memoryType]) => lesson(content, memoryType)),
    ...GATE_KEEP.map(([, content, memoryType]) => lesson(content, memoryType)),
    lesson('EACCES', 'entity'),
    lesson('Summary of 3 related memories:\n- a\n- b\n- c', 'summary', 'note'),
  ]

  it('demotes exactly the lessons the gate would refuse, with its own reason, and marks the pass done', async () => {
    const all = store()
    const failing = all.slice(0, GATE_DROP.length)
    const d = deps(all)
    expect(await recheckStoredLessonsV2(d)).toEqual({ checked: all.length, demoted: failing.length })
    expect(new Set(d.demoted)).toEqual(new Set(failing.map((l) => l.id)))
    expect(d.demote).toHaveBeenCalledWith(failing[0].id, RECHECK_V2_REASON)
    expect(RECHECK_V2_REASON).not.toBe(RECHECK_REASON)
    expect(RECHECK_V2_REASON).toMatch(/1\.55/)
    expect(RECHECK_V2_REASON).toMatch(/demoted, not deleted/)
    expect(d.marked()).toBe(true)
  })

  it('is idempotent: a second pass over the same store demotes nothing more', async () => {
    const all = store()
    const demoted = new Set<string>()
    const d = deps(all, { isCorrected: (id) => demoted.has(id), demote: vi.fn((id: string) => { demoted.add(id); return { ok: true } }) })
    const first = await recheckStoredLessonsV2(d)
    expect(first.demoted).toBe(GATE_DROP.length)
    // The marker is gone (a reinstall, a deleted file): the pass runs again and finds them already corrected.
    const again = deps(all, { isCorrected: (id) => demoted.has(id), demote: d.demote })
    const second = await recheckStoredLessonsV2(again)
    expect(second).toEqual({ checked: all.length, demoted: 0 })
    expect(d.demote).toHaveBeenCalledTimes(GATE_DROP.length)
  })

  it('runs once per device: a marked pass reads nothing', async () => {
    const d = deps(store(), { done: async () => true })
    expect(await recheckStoredLessonsV2(d)).toEqual({ checked: 0, demoted: 0, skipped: 'already-run' })
    expect(d.list).not.toHaveBeenCalled()
    expect(d.demote).not.toHaveBeenCalled()
  })

  it('honours an existing correction: a lesson someone already decided about is left as they left it', async () => {
    const all = store()
    const [first, second] = all
    const d = deps(all, { isCorrected: (id) => id === first.id })
    await recheckStoredLessonsV2(d)
    expect(d.demoted).not.toContain(first.id)
    expect(d.demoted).toContain(second.id)
  })

  it('never deletes: the only thing it can do to a lesson is demote it', async () => {
    const d = deps(store())
    await recheckStoredLessonsV2(d)
    // RecheckDeps has no delete, archive or write: the whole surface it was handed is these five.
    expect(Object.keys(d).sort()).toEqual(['demote', 'demoted', 'done', 'isCorrected', 'list', 'markDone', 'marked'].sort())
    expect(d.demote).toHaveBeenCalledTimes(GATE_DROP.length)
  })

  it('yields to the event loop every 25 demotions, like the first pass', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `g${i}`, ts: 100 - i, agentId: 'mneme', kind: 'fact', content: 'Root cause found.', memoryType: 'semantic' }))
    const yieldFn = vi.fn(async () => {})
    expect(await recheckStoredLessonsV2(deps(many, { yield: yieldFn }))).toEqual({ checked: 60, demoted: 60 })
    expect(yieldFn).toHaveBeenCalledTimes(2) // after the 25th and the 50th
  })

  it('yields after exactly the 25th and the 50th demotion', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `h${i}`, ts: 100 - i, agentId: 'mneme', kind: 'fact', content: 'Root cause found.', memoryType: 'semantic' }))
    const d = deps(many)
    const at: number[] = []
    d.yield = async () => { at.push(d.demoted.length) }
    await recheckStoredLessonsV2(d)
    expect(at).toEqual([25, 50])
  })

  it('pages through more lessons than one listing returns', async () => {
    const many: StoredLesson[] = Array.from({ length: 1203 }, (_, i) => ({ id: `p${i}`, ts: 10_000 - Math.floor(i / 3), agentId: 'mneme', kind: 'fact', content: 'Next:', memoryType: 'semantic' }))
    const d = deps(many)
    expect(await recheckStoredLessonsV2(d)).toEqual({ checked: 1203, demoted: 1203 })
    expect(new Set(d.demoted).size).toBe(1203)
  })

  it('leaves the pass unmarked when the store cannot be listed, so it runs again', async () => {
    const d = deps([], { list: vi.fn(async () => { throw new Error('memory host stopped') }) })
    await expect(recheckStoredLessonsV2(d)).rejects.toThrow('memory host stopped')
    expect(d.marked()).toBe(false)
  })

  it('keeps going when a demotion fails, and does not count it', async () => {
    const all = store()
    const d = deps(all, { demote: vi.fn((id: string) => { if (id === all[0].id) throw new Error('log unwritable'); return { ok: id !== all[1].id } }) })
    expect(await recheckStoredLessonsV2(d)).toEqual({ checked: all.length, demoted: GATE_DROP.length - 2 })
  })

  it('does not change the first pass: same judge, same reason', async () => {
    const d = deps([...JUNK, ...KEEP])
    await recheckStoredLessons(d)
    expect(d.demote).toHaveBeenCalledWith(JUNK[0].id, RECHECK_REASON)
    expect(d.demote).not.toHaveBeenCalledWith(expect.anything(), RECHECK_V2_REASON)
  })

  it('lets a caller bring its own judge and reason to the shared pass', async () => {
    const d = deps([lesson('anything at all', 'semantic'), lesson('keep me', 'semantic')], { judge: (l) => l.content === 'keep me', reason: 'because I said so' })
    expect(await recheckStoredLessons(d)).toEqual({ checked: 2, demoted: 1 })
    expect(d.demote).toHaveBeenCalledWith(expect.any(String), 'because I said so')
  })
})

describe('recheckMarker', () => {
  beforeEach(() => { _resetRecheckMarkersForTests() })

  /** A marker store in memory, asked and written asynchronously as the app's (markerFs over fs.promises) is. */
  function memFs(files = new Map<string, string>()) {
    const fs = {
      files,
      asks: 0,
      exists: vi.fn(async (p: string) => { fs.asks++; return files.has(p) }),
      write: vi.fn(async (p: string, t: string) => { files.set(p, t) }),
    }
    return fs
  }

  it('records the pass in userData and reads it back', async () => {
    const fs = memFs()
    const m = recheckMarker('/data', fs, join)
    expect(await m.done()).toBe(false)
    await m.markDone()
    expect(fs.files.get(join('/data', 'mneme-lesson-recheck.json'))).toBe('{"version":1}')
    expect(await m.done()).toBe(true)
  })

  it('asks the disk once the marker is there, not on every pass (the indexer asks every few minutes, on the main thread)', async () => {
    const fs = memFs(new Map([[join('/data', 'mneme-lesson-recheck.json'), '{"version":1}']]))
    const m = recheckMarker('/data', fs, join)
    for (let i = 0; i < 50; i++) expect(await m.done()).toBe(true)
    expect(fs.asks).toBe(1)
  })

  it('asks the disk once per launch, however many marker objects ask (the indexer builds a new one on every pass)', async () => {
    const fs = memFs()
    for (let pass = 0; pass < 30; pass++) expect(await recheckMarker('/data', fs, join).done()).toBe(false)
    expect(fs.asks).toBe(1)
    await recheckMarker('/data', fs, join).markDone() // this pass finished
    expect(await recheckMarker('/data', fs, join).done()).toBe(true) // the next pass's fresh marker knows
    expect(fs.asks).toBe(1)
    expect(await recheckMarker('/data', fs, join, 'linked-history-recheck.json').done()).toBe(false) // another marker is its own question
    expect(fs.asks).toBe(2)
  })

  it('asks the disk once even when the marker is missing: only markDone() changes the answer, and it needs no read back', async () => {
    const fs = memFs()
    const m = recheckMarker('/data', fs, join)
    for (let i = 0; i < 20; i++) expect(await m.done()).toBe(false) // twenty passes that could not finish: one look at the disk
    expect(fs.asks).toBe(1)
    await m.markDone()
    expect(await m.done()).toBe(true)
    expect(await m.done()).toBe(true)
    expect(fs.asks).toBe(1)
  })

  it('takes a recorded pass as done without asking the disk at all', async () => {
    const fs = memFs()
    await recheckMarker('/data', fs, join).markDone() // the first pass of this launch ran to the end before anything asked
    expect(await recheckMarker('/data', fs, join).done()).toBe(true)
    expect(fs.asks).toBe(0)
  })

  it('does not remember a disk that could not be read: the next pass asks again', async () => {
    let asks = 0
    let broken = true
    const m = recheckMarker('/data', { exists: async () => { asks++; if (broken) throw new Error('EIO'); return true }, write: async () => {} }, join)
    expect(await m.done()).toBe(false)
    expect(await m.done()).toBe(false)
    expect(asks).toBe(2)
    broken = false
    expect(await m.done()).toBe(true)
    expect(await m.done()).toBe(true)
    expect(asks).toBe(3)
  })

  it('treats an exists that throws before it returns a promise as unreadable, not remembered', async () => {
    let asks = 0
    const exists = (): Promise<boolean> => { asks++; throw new Error('EIO') }
    const m = recheckMarker('/data', { exists, write: async () => {} }, join)
    expect(await m.done()).toBe(false)
    expect(await m.done()).toBe(false)
    expect(asks).toBe(2)
  })

  it('asks the disk once for passes that ask at the same time, and gives them all its answer', async () => {
    const answer = deferred<boolean>()
    let asks = 0
    const fs = { exists: () => { asks++; return answer.promise }, write: async () => {} }
    const asking = [recheckMarker('/data', fs, join).done(), recheckMarker('/data', fs, join).done(), recheckMarker('/data', fs, join).done()]
    expect(asks).toBe(1)
    answer.resolve(true)
    expect(await Promise.all(asking)).toEqual([true, true, true])
    expect(await recheckMarker('/data', fs, join).done()).toBe(true)
    expect(asks).toBe(1)
  })

  it('a look that fails while several passes wait fails them all as "not run", and the next pass asks again', async () => {
    const answer = deferred<boolean>()
    let asks = 0
    const fs = { exists: () => { asks++; return asks === 1 ? answer.promise : Promise.resolve(true) }, write: async () => {} }
    const asking = [recheckMarker('/data', fs, join).done(), recheckMarker('/data', fs, join).done()]
    answer.reject(new Error('EIO'))
    expect(await Promise.all(asking)).toEqual([false, false])
    expect(asks).toBe(1)
    expect(await recheckMarker('/data', fs, join).done()).toBe(true)
    expect(asks).toBe(2)
  })

  it('a pass recorded while a look is still out is done afterwards, whatever that look comes back with', async () => {
    const answer = deferred<boolean>()
    let asks = 0
    const files = new Map<string, string>()
    const fs = { exists: () => { asks++; return answer.promise }, write: async (p: string, t: string) => { files.set(p, t) } }
    const early = recheckMarker('/data', fs, join).done() // asked before the pass finished
    await recheckMarker('/data', fs, join).markDone()
    answer.resolve(false) // the disk as it was when asked
    expect(await early).toBe(false) // what was true when it asked, as a synchronous look would have said
    expect(await recheckMarker('/data', fs, join).done()).toBe(true)
    expect(asks).toBe(1)
  })

  it('a look that fails after the pass was recorded does not forget the record', async () => {
    const answer = deferred<boolean>()
    let asks = 0
    const fs = { exists: () => { asks++; return answer.promise }, write: async () => {} }
    const early = recheckMarker('/data', fs, join).done()
    await recheckMarker('/data', fs, join).markDone()
    answer.reject(new Error('EIO'))
    expect(await early).toBe(false)
    expect(await recheckMarker('/data', fs, join).done()).toBe(true)
    expect(asks).toBe(1)
  })

  it('keeps the second pass in its own file, so a store that ran the first still runs it', async () => {
    const fs = memFs()
    await recheckMarker('/data', fs, join).markDone() // the 1.50.1 pass has run
    const v2 = recheckMarker('/data', fs, join, RECHECK_V2_MARKER, 2)
    expect(RECHECK_V2_MARKER).toBe('mneme-lesson-recheck-v2.json')
    expect(await v2.done()).toBe(false)
    await v2.markDone()
    expect(fs.files.get(join('/data', 'mneme-lesson-recheck-v2.json'))).toBe('{"version":2}')
    expect(fs.files.get(join('/data', 'mneme-lesson-recheck.json'))).toBe('{"version":1}') // untouched
    expect(await v2.done()).toBe(true)
  })

  it('never rejects, and a pass whose record could not be written is done for the rest of this launch, not after it', async () => {
    let asks = 0
    const m = recheckMarker('/data', { exists: async () => { asks++; return false }, write: async () => { throw new Error('EROFS') } }, join)
    expect(await m.done()).toBe(false)
    await expect(m.markDone()).resolves.toBeUndefined()
    expect(await m.done()).toBe(true) // the scan ran to the end: not again this launch
    expect(asks).toBe(1)
    _resetRecheckMarkersForTests() // the next launch: nothing on disk says it ran
    expect(await m.done()).toBe(false)
    expect(asks).toBe(2)
    const sync = recheckMarker('/data', { exists: async () => false, write: () => { throw new Error('EROFS') } }, join, 'other.json')
    await expect(sync.markDone()).resolves.toBeUndefined()
    expect(await sync.done()).toBe(true)
  })

  it('a record that could not be written is written again by the next pass that asks, until it lands, and not after', async () => {
    let fails = 2
    const written: string[] = []
    const fs = {
      exists: vi.fn(async () => false),
      write: vi.fn(async (p: string, t: string) => { if (fails-- > 0) throw new Error('EBUSY'); written.push(`${p}=${t}`) }),
    }
    await recheckMarker('/data', fs, join).markDone() // fails
    expect(await recheckMarker('/data', fs, join).done()).toBe(true) // retries, fails again
    expect(fs.write).toHaveBeenCalledTimes(2)
    expect(written).toEqual([])
    expect(await recheckMarker('/data', fs, join).done()).toBe(true) // retries, lands
    expect(written).toEqual([`${join('/data', 'mneme-lesson-recheck.json')}={"version":1}`])
    for (let i = 0; i < 5; i++) expect(await recheckMarker('/data', fs, join).done()).toBe(true)
    expect(fs.write).toHaveBeenCalledTimes(3) // landed: nothing more to write
    expect(fs.exists).not.toHaveBeenCalled() // and the disk was never asked: the pass is known to have run
  })

  it('passes that retry the write at the same time share one write', async () => {
    let first = true
    const landing = deferred<void>()
    const fs = { exists: async () => false, write: vi.fn(() => { if (first) { first = false; return Promise.reject(new Error('EBUSY')) } return landing.promise }) }
    await recheckMarker('/data', fs, join).markDone()
    const asking = [recheckMarker('/data', fs, join).done(), recheckMarker('/data', fs, join).done(), recheckMarker('/data', fs, join).done()]
    expect(fs.write).toHaveBeenCalledTimes(2) // the failed one, then one retry for all three
    landing.resolve()
    expect(await Promise.all(asking)).toEqual([true, true, true])
    expect(await recheckMarker('/data', fs, join).done()).toBe(true)
    expect(fs.write).toHaveBeenCalledTimes(2)
  })

  it('a pass that finishes while a retry is out shares that write rather than start a second', async () => {
    let first = true
    const landing = deferred<void>()
    const fs = { exists: async () => false, write: vi.fn(() => { if (first) { first = false; return Promise.reject(new Error('EBUSY')) } return landing.promise }) }
    await recheckMarker('/data', fs, join).markDone()
    const retry = recheckMarker('/data', fs, join).done()
    const marking = recheckMarker('/data', fs, join).markDone()
    expect(fs.write).toHaveBeenCalledTimes(2)
    landing.resolve()
    await marking
    expect(await retry).toBe(true)
    expect(await recheckMarker('/data', fs, join).done()).toBe(true)
    expect(fs.write).toHaveBeenCalledTimes(2)
  })

  it('a write that keeps failing (EACCES/EPERM on the folder) scans the store once per launch, and only retries the write after (Codex R1 probe)', async () => {
    const denied = (): never => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }
    const fs = markerFs({ access: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }, writeFile: async () => denied(), rename: async () => denied(), unlink: async () => {} })
    const store = [...JUNK, ...KEEP]
    const d = deps(store, recheckMarker('/data', fs, join))
    const writes = vi.spyOn(fs, 'write')
    const first = await recheckStoredLessons({ ...d, ...recheckMarker('/data', fs, join) })
    expect(first.checked).toBeGreaterThan(0)
    for (let pass = 0; pass < 3; pass++) {
      expect(await recheckStoredLessons({ ...d, ...recheckMarker('/data', fs, join) })).toEqual({ checked: 0, demoted: 0, skipped: 'already-run' })
    }
    expect(d.list).toHaveBeenCalledTimes(1) // one scan, not one per pass
    expect(writes).toHaveBeenCalledTimes(4) // the pass's own write, then one retry per later pass
  })
})

describe('markerFs (the app\'s marker store, over fs.promises: off the main thread)', () => {
  const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })
  const quiet = { writeFile: async () => {}, rename: async () => {}, unlink: async () => {} }
  beforeEach(() => { _resetRecheckMarkersForTests() }) // a temp left by one test's marker is not the next test's

  /** fs.promises in memory, enough of it for the marker: a file is there once written ('wx' refuses one already there);
   *  a rename moves it. */
  function disk(over: { writeFile?: (p: string, t: string, o?: { flag?: string }) => Promise<void>; rename?: (a: string, b: string) => Promise<void>; unlink?: (p: string) => Promise<void> } = {}, files = new Map<string, string>()) {
    const io = {
      files,
      access: vi.fn(async (p: string) => { if (!files.has(p)) throw err('ENOENT') }),
      writeFile: vi.fn(over.writeFile ?? (async (p: string, t: string, o?: { flag?: string }) => {
        if (o?.flag === 'wx' && files.has(p)) throw err('EEXIST')
        files.set(p, t)
      })),
      rename: vi.fn(over.rename ?? (async (a: string, b: string) => {
        const t = files.get(a)
        if (t === undefined) throw err('ENOENT')
        files.delete(a)
        files.set(b, t)
      })),
      unlink: vi.fn(over.unlink ?? (async (p: string) => { if (!files.delete(p)) throw err('ENOENT') })),
    }
    return io
  }

  it('a marker that is there exists', async () => {
    const access = vi.fn(async () => {})
    expect(await markerFs({ access, ...quiet }).exists('/data/m.json')).toBe(true)
    expect(access).toHaveBeenCalledWith('/data/m.json')
  })

  it('a missing marker (ENOENT) is a plain no: the pass has not run', async () => {
    expect(await markerFs({ access: async () => { throw err('ENOENT') }, ...quiet }).exists('/data/m.json')).toBe(false)
  })

  it('any other failure is "could not tell", which recheckMarker does not remember', async () => {
    for (const code of ['EACCES', 'EPERM', 'EIO', 'EBUSY']) {
      await expect(markerFs({ access: async () => { throw err(code) }, ...quiet }).exists('/data/m.json')).rejects.toThrow(code)
    }
    await expect(markerFs({ access: async () => { throw 'odd' }, ...quiet }).exists('/data/m.json')).rejects.toBe('odd')
    await expect(markerFs({ access: async () => { throw null }, ...quiet }).exists('/data/m.json')).rejects.toBeNull()
  })

  it('writes the marker whole or not at all: its text to a temp file in the same folder, then renamed into place', async () => {
    const io = disk()
    await markerFs(io).write(join('/data', 'm.json'), '{"version":1}')
    expect([...io.files]).toEqual([[join('/data', 'm.json'), '{"version":1}']]) // the marker, and no temp left behind
    expect(io.writeFile).toHaveBeenCalledTimes(1)
    const tmp = io.writeFile.mock.calls[0][0]
    expect(tmp).not.toBe(join('/data', 'm.json'))
    expect(tmp.startsWith(`${join('/data', 'm.json')}.`)).toBe(true) // same folder, so the rename cannot cross a volume
    expect(tmp.endsWith('.tmp')).toBe(true)
    expect(io.writeFile).toHaveBeenCalledWith(tmp, '{"version":1}', { flag: 'wx' })
    expect(io.rename).toHaveBeenCalledWith(tmp, join('/data', 'm.json'))
    expect(io.unlink).not.toHaveBeenCalled()
  })

  it('gives every write its own temp file, so two writes at once never share one', async () => {
    const io = disk()
    const fs = markerFs(io)
    await Promise.all([fs.write('/data/m.json', 'a'), fs.write('/data/m.json', 'b')])
    const [one, two] = io.writeFile.mock.calls.map((c) => c[0])
    expect(one).not.toBe(two)
    expect([...io.files.keys()]).toEqual(['/data/m.json'])
  })

  it('a write that fails mid-way (disk full) leaves no marker, removes its temp, and fails (Codex R1 probe)', async () => {
    const files = new Map<string, string>()
    const io = disk({ writeFile: async (p, t) => { files.set(p, t.slice(0, 3)); throw err('ENOSPC') } }, files)
    const fs = markerFs(io)
    await expect(fs.write('/data/m.json', '{"version":1}')).rejects.toThrow('ENOSPC')
    expect([...io.files.keys()]).toEqual([]) // no marker, no half-written temp
    expect(io.rename).not.toHaveBeenCalled()
    expect(await fs.exists('/data/m.json')).toBe(false)
    // Through recheckMarker: this launch knows the pass ran; the next launch finds nothing that says so, and runs it.
    _resetRecheckMarkersForTests()
    await recheckMarker('/data', fs, join, 'm.json').markDone()
    _resetRecheckMarkersForTests()
    expect(await recheckMarker('/data', fs, join, 'm.json').done()).toBe(false)
  })

  it('a rename that is refused leaves no marker and removes the temp', async () => {
    const io = disk({ rename: async () => { throw err('EPERM') } })
    await expect(markerFs(io).write('/data/m.json', '{"version":1}')).rejects.toThrow('EPERM')
    expect([...io.files.keys()]).toEqual([])
    expect(io.unlink).toHaveBeenCalledWith(io.writeFile.mock.calls[0][0])
  })

  it('a temp that cannot be removed does not hide why the write failed', async () => {
    const io = disk({ rename: async () => { throw err('EPERM') }, unlink: async () => { throw err('EBUSY') } })
    await expect(markerFs(io).write('/data/m.json', 'x')).rejects.toThrow('EPERM')
    const sync = disk({ rename: async () => { throw err('EPERM') }, unlink: () => { throw err('EBUSY') } })
    await expect(markerFs(sync).write('/data/other.json', 'x')).rejects.toThrow('EPERM')
  })

  it("creates its temp file exclusively ('wx'), so it never writes into, or through, a file already there", async () => {
    const io = disk()
    await markerFs(io).write('/data/m.json', '{"version":1}')
    expect(io.writeFile).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), '{"version":1}', { flag: 'wx' })
  })

  it('a temp name already taken (EEXIST) is left alone and the next name is used (Codex R2)', async () => {
    const files = new Map<string, string>()
    const io = disk({}, files)
    let squat = 2
    io.writeFile.mockImplementation(async (p: string, t: string, o?: { flag?: string }) => {
      if (squat-- > 0) files.set(p, 'not ours') // someone else's file stands at this name
      if (o?.flag === 'wx' && files.has(p)) throw err('EEXIST')
      files.set(p, t)
    })
    await markerFs(io).write('/data/m.json', '{"version":1}')
    const tried = io.writeFile.mock.calls.map((c) => c[0])
    expect(tried).toHaveLength(3)
    expect(new Set(tried).size).toBe(3)
    expect(files.get('/data/m.json')).toBe('{"version":1}')
    expect([...files.entries()].filter(([, t]) => t === 'not ours').map(([f]) => f)).toEqual(tried.slice(0, 2)) // untouched
    expect(io.unlink).not.toHaveBeenCalled()
  })

  it('gives up after a bounded number of taken names, and removes none of them', async () => {
    const io = disk({ writeFile: async () => { throw err('EEXIST') } })
    await expect(markerFs(io).write('/data/m.json', 'x')).rejects.toThrow('EEXIST')
    expect(io.writeFile).toHaveBeenCalledTimes(8)
    expect(io.rename).not.toHaveBeenCalled()
    expect(io.unlink).not.toHaveBeenCalled()
    // Not ours, so not remembered as a temp to clear: the next write starts clean.
    io.writeFile.mockImplementation(async (p: string, t: string) => { io.files.set(p, t) })
    await markerFs(io).write('/data/m.json', 'x')
    expect(io.unlink).not.toHaveBeenCalled()
    expect(io.files.get('/data/m.json')).toBe('x')
  })

  it('a write that keeps failing leaves at most one temp per marker: the one left last time is removed before the next try (Codex R2)', async () => {
    let stuck = true
    const io = disk({
      rename: async () => { throw err('EPERM') },
      unlink: async (p: string) => { if (stuck) throw err('EBUSY'); if (!io.files.delete(p)) throw err('ENOENT') },
    })
    const temps = () => [...io.files.keys()].filter((f) => f.endsWith('.tmp'))
    for (let i = 0; i < 5; i++) await expect(markerFs(io).write('/data/m.json', 'x')).rejects.toThrow()
    expect(temps()).toHaveLength(1) // not one per try
    expect(io.writeFile).toHaveBeenCalledTimes(1) // with the old temp still there, no new one is made
    const left = temps()[0]
    // The folder lets go: the old temp is removed first, then the write goes ahead (and its own temp is cleared as usual).
    stuck = false
    io.unlink.mockClear()
    await expect(markerFs(io).write('/data/m.json', 'x')).rejects.toThrow('EPERM')
    expect(io.unlink.mock.calls[0][0]).toBe(left)
    expect(temps()).toEqual([])
    expect(io.writeFile).toHaveBeenCalledTimes(2)
    // Nothing is left to clear now, so the next write removes nothing first.
    io.rename.mockImplementation(async (a: string, b: string) => { io.files.set(b, io.files.get(a)!); io.files.delete(a) })
    io.unlink.mockClear()
    await markerFs(io).write('/data/m.json', 'x')
    expect(io.unlink).not.toHaveBeenCalled()
    expect([...io.files.keys()]).toEqual(['/data/m.json'])
  })

  it('a temp left last time that is gone by now (ENOENT) is no obstacle, and each marker clears only its own', async () => {
    let stuck = true
    const io = disk({
      rename: async () => { throw err('EPERM') },
      unlink: async (p: string) => { if (stuck) throw err('EBUSY'); if (!io.files.delete(p)) throw err('ENOENT') },
    })
    await expect(markerFs(io).write('/data/a.json', 'x')).rejects.toThrow('EPERM')
    await expect(markerFs(io).write('/data/b.json', 'x')).rejects.toThrow('EPERM') // b's own try: a's temp does not block it
    expect(io.writeFile).toHaveBeenCalledTimes(2)
    const leftA = io.writeFile.mock.calls[0][0]
    io.files.delete(leftA) // removed by someone else meanwhile
    stuck = false
    io.rename.mockImplementation(async (a: string, b: string) => { io.files.set(b, io.files.get(a)!); io.files.delete(a) })
    await markerFs(io).write('/data/a.json', 'x')
    expect(io.files.get('/data/a.json')).toBe('x')
    expect(io.unlink.mock.calls.map((c) => c[0])).toContain(leftA)
  })

  it('a write that fails part way remembers its temp when it cannot be removed, and clears it next time', async () => {
    let stuck = true
    const files = new Map<string, string>()
    const io = disk({
      writeFile: async (p: string, t: string) => { files.set(p, t.slice(0, 2)); throw err('ENOSPC') },
      unlink: async (p: string) => { if (stuck) throw err('EBUSY'); files.delete(p) },
    }, files)
    await expect(markerFs(io).write('/data/m.json', '{"version":1}')).rejects.toThrow('ENOSPC')
    const left = io.writeFile.mock.calls[0][0]
    expect([...files.keys()]).toEqual([left])
    stuck = false
    io.unlink.mockClear()
    await expect(markerFs(io).write('/data/m.json', '{"version":1}')).rejects.toThrow('ENOSPC')
    expect(io.unlink.mock.calls[0][0]).toBe(left)
    expect([...files.keys()]).toEqual([])
  })

  it('a temp the failed write never made (ENOENT on removal) is not remembered as left', async () => {
    const io = disk({ writeFile: async () => { throw err('EACCES') } }) // refused before the file exists
    await expect(markerFs(io).write('/data/m.json', 'x')).rejects.toThrow('EACCES')
    expect(io.unlink).toHaveBeenCalledTimes(1) // tried, and found nothing
    io.unlink.mockClear()
    await expect(markerFs(io).write('/data/m.json', 'x')).rejects.toThrow('EACCES')
    expect(io.unlink).toHaveBeenCalledTimes(1) // only this write's own: nothing was left to clear first
    expect(io.unlink.mock.calls[0][0]).toBe(io.writeFile.mock.calls[1][0])
  })

  it('the reset for tests forgets a temp left behind, as a new launch would', async () => {
    const io = disk({ rename: async () => { throw err('EPERM') }, unlink: async () => { throw err('EBUSY') } })
    await expect(markerFs(io).write('/data/m.json', 'x')).rejects.toThrow('EPERM')
    _resetRecheckMarkersForTests()
    await expect(markerFs(io).write('/data/m.json', 'x')).rejects.toThrow('EPERM') // not stopped by the old temp
    expect(io.writeFile).toHaveBeenCalledTimes(2)
  })

  it('through recheckMarker: passes that keep failing to record a pass leave one temp, not one per pass', async () => {
    const io = disk({ rename: async () => { throw err('EPERM') }, unlink: async () => { throw err('EBUSY') } })
    const fs = markerFs(io)
    await recheckMarker('/data', fs, join).markDone()
    for (let pass = 0; pass < 6; pass++) expect(await recheckMarker('/data', fs, join).done()).toBe(true)
    expect([...io.files.keys()].filter((f) => f.endsWith('.tmp'))).toHaveLength(1)
  })

  it('through recheckMarker: an unreadable disk is asked again, a missing marker is remembered', async () => {
    _resetRecheckMarkersForTests()
    let code = 'EACCES'
    let asks = 0
    const fs = markerFs({ access: async () => { asks++; throw err(code) }, ...quiet })
    expect(await recheckMarker('/data', fs, join).done()).toBe(false)
    expect(await recheckMarker('/data', fs, join).done()).toBe(false)
    expect(asks).toBe(2) // EACCES: not remembered
    code = 'ENOENT'
    expect(await recheckMarker('/data', fs, join).done()).toBe(false)
    expect(await recheckMarker('/data', fs, join).done()).toBe(false)
    expect(asks).toBe(3) // ENOENT: an answer, remembered for the launch
  })

  it('over the real fs.promises, in a real folder', async () => {
    _resetRecheckMarkersForTests()
    const { mkdtemp, rm, readFile, readdir, mkdir, access, writeFile, rename, unlink } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const dir = await mkdtemp(join(tmpdir(), 'termpolis-marker-'))
    try {
      const fs = markerFs({ access, writeFile, rename, unlink })
      expect(await fs.exists(join(dir, 'none.json'))).toBe(false)
      const m = recheckMarker(dir, fs, join, 'real.json', 3)
      expect(await m.done()).toBe(false)
      await m.markDone()
      expect(await readFile(join(dir, 'real.json'), 'utf8')).toBe('{"version":3}')
      expect(await readdir(dir)).toEqual(['real.json']) // no temp left behind
      _resetRecheckMarkersForTests() // the next launch
      expect(await recheckMarker(dir, fs, join, 'real.json', 3).done()).toBe(true)
      // A marker under a folder that is not there: still a plain no (ENOENT).
      expect(await fs.exists(join(dir, 'missing-folder', 'm.json'))).toBe(false)
      // A rename the OS refuses (a folder stands where the marker goes): the write fails and its temp is gone.
      await mkdir(join(dir, 'blocked.json'))
      await expect(fs.write(join(dir, 'blocked.json'), '{"version":1}')).rejects.toThrow()
      expect((await readdir(dir)).sort()).toEqual(['blocked.json', 'real.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
