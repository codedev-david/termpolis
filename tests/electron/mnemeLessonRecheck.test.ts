import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'
import {
  RECHECK_REASON,
  recheckMarker,
  recheckStoredLessons,
  wouldStillWrite,
  type RecheckDeps,
  type StoredLesson,
} from '../../src/main/mnemeLessonRecheck'

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

describe('recheckMarker', () => {
  it('records the pass in userData and reads it back', () => {
    const files = new Map<string, string>()
    const m = recheckMarker('/data', { exists: (p) => files.has(p), write: (p, t) => { files.set(p, t) } }, join)
    expect(m.done()).toBe(false)
    m.markDone()
    expect(files.get(join('/data', 'mneme-lesson-recheck.json'))).toBe('{"version":1}')
    expect(m.done()).toBe(true)
  })

  it('never throws', () => {
    const m = recheckMarker('/data', { exists: () => { throw new Error('EIO') }, write: () => { throw new Error('EROFS') } }, join)
    expect(m.done()).toBe(false)
    expect(() => m.markDone()).not.toThrow()
  })
})
