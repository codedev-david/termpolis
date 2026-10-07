// mnemeLessonRecheck.ts
//
// One pass over the lessons the heuristic distiller already stored, re-judged by today's rules.
//
// Through v1.50.0 the distiller (mnemeReflect.ts) read almost any sentence as a problem: its error
// rule matched every word of four or more letters starting with an e. It also stored to-dos and
// table rows as decisions. A 2026-10 audit of a real store found only a handful of usable lessons
// among ~37 written in twelve days, and the junk carried the highest importance a lesson gets, so
// it led recall. Fixing the rules stops new junk; this pass deals with what is already stored.
//
// A lesson the current rules would not write is DEMOTED, never deleted: recall still finds it when
// nothing better matches, and memory_correct can revoke the demotion. It is recorded in the same
// correction log as an agent's or the user's corrections, so the reason travels with it.

import {
  isDecisionSentence,
  isFixSentence,
  isProblemSentence,
  LEGACY_GOTCHA_RE,
  matchesGotchaRule,
  splitSentences,
} from './mnemeReflect'

export interface StoredLesson {
  id: string
  ts: number
  agentId?: string
  kind?: string
  content: string
  memoryType?: string
}

export const RECHECK_REASON =
  'Re-checked by Termpolis 1.50.1: the lesson extractor that wrote this read ordinary sentences as ' +
  'problems, fixes and decisions, so it was demoted. Revoke this correction if it was a real lesson.'

const PROBLEM_FIX = /^Problem: ([\s\S]*?) → Fix: ([\s\S]*)$/

/** The original text, as far as the stored copy keeps it: lessons were cut to 600 characters with
 *  an ellipsis. A cut sentence is judged on what is left. */
function uncut(s: string): string {
  return s.replace(/…$/, '').trim()
}

/** Would today's rules have written this lesson? Only the shapes the heuristic distiller writes are
 *  judged. An LLM-enriched lesson, a summary or an entity stub is kept as it is.
 *
 *  A decision or gotcha is judged by its FIRST sentence: that is the trigger the distiller matched,
 *  and a short one had the next sentence appended to it (extendThin). */
export function wouldStillWrite(lesson: StoredLesson): boolean {
  if (lesson.memoryType === 'procedural') {
    const m = PROBLEM_FIX.exec(lesson.content)
    if (!m) return true // the LLM enrichment's own wording, not a stapled pair
    return isProblemSentence(uncut(m[1])) && isFixSentence(uncut(m[2]))
  }
  if (lesson.memoryType === 'semantic') {
    const text = uncut(lesson.content)
    const trigger = splitSentences(text)[0] ?? text
    if (lesson.kind === 'decision') return isDecisionSentence(trigger)
    // A semantic fact is a gotcha only when the old gotcha rule is what wrote it.
    if (lesson.kind === 'fact' && LEGACY_GOTCHA_RE.test(trigger)) return matchesGotchaRule(trigger)
  }
  return true
}

export interface RecheckDeps {
  /** Pages of the store's own lessons, newest first, older than `before` when given. */
  list: (opts: { agentId: 'mneme'; limit: number; before?: number }) => Promise<StoredLesson[]>
  /** Already-corrected ids are left alone: someone decided about them already. */
  isCorrected: (id: string) => boolean
  demote: (id: string, reason: string) => { ok: boolean }
  /** Whether this pass has run on this install before. */
  done: () => boolean
  markDone: () => void
  /** Awaited every YIELD_EVERY demotions. Each demotion appends to the correction log
   *  synchronously, on the main thread, so a store with thousands of junk lessons must not do them
   *  in one unbroken run. Default: a setImmediate macrotask, which lets IPC and the PTYs through. */
  yield?: () => Promise<void>
}

export interface RecheckResult {
  checked: number
  demoted: number
  skipped?: 'already-run'
}

const PAGE = 500
const YIELD_EVERY = 25
const macrotask = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

/** Re-judge every stored mneme lesson once per install. A store that can't be listed throws and
 *  leaves the pass unmarked, so the next indexer pass tries again; a demotion that fails is simply
 *  not counted. */
export async function recheckStoredLessons(deps: RecheckDeps): Promise<RecheckResult> {
  if (deps.done()) return { checked: 0, demoted: 0, skipped: 'already-run' }
  let checked = 0
  let demoted = 0
  let attempts = 0
  const seen = new Set<string>()
  let before: number | undefined
  for (;;) {
    const page = await deps.list({ agentId: 'mneme', limit: PAGE, ...(before !== undefined ? { before } : {}) })
    let fresh = 0
    for (const lesson of page) {
      if (seen.has(lesson.id)) continue
      seen.add(lesson.id)
      fresh++
      checked++
      if (deps.isCorrected(lesson.id) || wouldStillWrite(lesson)) continue
      try {
        if (deps.demote(lesson.id, RECHECK_REASON).ok) demoted++
      } catch { /* left as it is; counted as checked */ }
      if (++attempts % YIELD_EVERY === 0) await (deps.yield ?? macrotask)()
    }
    if (page.length < PAGE || fresh === 0) break
    // The next page starts AT the oldest timestamp seen, not below it, so lessons that share it and
    // didn't fit on this page are not skipped; `seen` drops the ones already judged.
    before = (page[page.length - 1].ts || 0) + 1
  }
  deps.markDone()
  return { checked, demoted }
}

/** Whether the pass has run, kept in userData. Unreadable counts as not run: running it twice only
 *  re-judges lessons, and an already-demoted one is skipped as corrected. */
export function recheckMarker(userDataPath: string, fs: {
  exists: (p: string) => boolean
  write: (p: string, text: string) => void
}, join: (...parts: string[]) => string): Pick<RecheckDeps, 'done' | 'markDone'> {
  const file = join(userDataPath, 'mneme-lesson-recheck.json')
  return {
    done: () => {
      try { return fs.exists(file) } catch { return false }
    },
    markDone: () => {
      try { fs.write(file, JSON.stringify({ version: 1 })) } catch { /* runs again next launch */ }
    },
  }
}
