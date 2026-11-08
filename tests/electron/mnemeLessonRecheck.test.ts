import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'
import {
  RECHECK_REASON,
  _resetRecheckMarkersForTests,
  RECHECK_V2_MARKER,
  RECHECK_V2_REASON,
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
    done: () => marked,
    markDone: () => { marked = true },
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
    const d = deps(JUNK, { done: () => true })
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
})

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
    const d = deps(store(), { done: () => true })
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

  it('records the pass in userData and reads it back', () => {
    const files = new Map<string, string>()
    const m = recheckMarker('/data', { exists: (p) => files.has(p), write: (p, t) => { files.set(p, t) } }, join)
    expect(m.done()).toBe(false)
    m.markDone()
    expect(files.get(join('/data', 'mneme-lesson-recheck.json'))).toBe('{"version":1}')
    expect(m.done()).toBe(true)
  })

  it('asks the disk once the marker is there, not on every pass (the indexer asks every few minutes, on the main thread)', () => {
    let asks = 0
    const files = new Map<string, string>([[join('/data', 'mneme-lesson-recheck.json'), '{"version":1}']])
    const m = recheckMarker('/data', { exists: (p) => { asks++; return files.has(p) }, write: () => {} }, join)
    for (let i = 0; i < 50; i++) expect(m.done()).toBe(true)
    expect(asks).toBe(1)
  })

  it('asks the disk once per launch, however many marker objects ask (the indexer builds a new one on every pass)', () => {
    let asks = 0
    const files = new Map<string, string>()
    const fsLike = { exists: (p: string) => { asks++; return files.has(p) }, write: (p: string, t: string) => { files.set(p, t) } }
    for (let pass = 0; pass < 30; pass++) expect(recheckMarker('/data', fsLike, join).done()).toBe(false)
    expect(asks).toBe(1)
    recheckMarker('/data', fsLike, join).markDone() // this pass finished
    expect(recheckMarker('/data', fsLike, join).done()).toBe(true) // the next pass's fresh marker knows
    expect(asks).toBe(1)
    expect(recheckMarker('/data', fsLike, join, 'linked-history-recheck.json').done()).toBe(false) // another marker is its own question
    expect(asks).toBe(2)
  })

  it('asks the disk once even when the marker is missing: only markDone() changes the answer, and it needs no read back', () => {
    let asks = 0
    const files = new Map<string, string>()
    const m = recheckMarker('/data', { exists: (p) => { asks++; return files.has(p) }, write: (p, t) => { files.set(p, t) } }, join)
    for (let i = 0; i < 20; i++) expect(m.done()).toBe(false) // twenty passes that could not finish: one look at the disk
    expect(asks).toBe(1)
    m.markDone()
    expect(m.done()).toBe(true)
    expect(m.done()).toBe(true)
    expect(asks).toBe(1)
  })

  it('does not remember a disk that could not be read: the next pass asks again', () => {
    let asks = 0
    let broken = true
    const m = recheckMarker('/data', { exists: () => { asks++; if (broken) throw new Error('EIO'); return true }, write: () => {} }, join)
    expect(m.done()).toBe(false)
    expect(m.done()).toBe(false)
    expect(asks).toBe(2)
    broken = false
    expect(m.done()).toBe(true)
    expect(m.done()).toBe(true)
    expect(asks).toBe(3)
  })

  it('keeps the second pass in its own file, so a store that ran the first still runs it', () => {
    const files = new Map<string, string>()
    const fs = { exists: (p: string) => files.has(p), write: (p: string, t: string) => { files.set(p, t) } }
    recheckMarker('/data', fs, join).markDone() // the 1.50.1 pass has run
    const v2 = recheckMarker('/data', fs, join, RECHECK_V2_MARKER, 2)
    expect(RECHECK_V2_MARKER).toBe('mneme-lesson-recheck-v2.json')
    expect(v2.done()).toBe(false)
    v2.markDone()
    expect(files.get(join('/data', 'mneme-lesson-recheck-v2.json'))).toBe('{"version":2}')
    expect(files.get(join('/data', 'mneme-lesson-recheck.json'))).toBe('{"version":1}') // untouched
    expect(v2.done()).toBe(true)
  })

  it('never throws', () => {
    const m = recheckMarker('/data', { exists: () => { throw new Error('EIO') }, write: () => { throw new Error('EROFS') } }, join)
    expect(m.done()).toBe(false)
    expect(() => m.markDone()).not.toThrow()
  })
})
