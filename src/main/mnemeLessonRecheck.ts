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
// nothing better matches, and a later correction through memory_correct replaces the demotion (amend it,
// even to the same words, and it is back at full rank). It is recorded in the same correction log as an
// agent's or the user's corrections, so the reason travels with it. Nothing in the app revokes a
// correction outright; the marker file below is what keeps a demotion from being made twice.
//
// 1.55.0 adds a second pass over the same store (recheckStoredLessonsV2): the same rules plus the
// substance gate (lessonSubstance.ts) that groundEpisode now applies at write time, for the lessons
// written before it existed. It keeps its own marker, so a store that already ran the first pass runs it.

import {
  isDecisionSentence,
  isFixSentence,
  isProblemSentence,
  LEGACY_GOTCHA_RE,
  matchesGotchaRule,
  splitSentences,
} from './mnemeReflect'
import { lessonSubstance, substanceBand } from './lessonSubstance'

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
  'problems, fixes and decisions, so it was demoted, not deleted: still found, ranked lower.'

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

export const RECHECK_V2_MARKER = 'mneme-lesson-recheck-v2.json'

export const RECHECK_V2_REASON =
  'Re-checked by Termpolis 1.55.0: this lesson says nothing a later reader could act on (an announcement, ' +
  'a progress note or a fragment), so it was demoted, not deleted: still found, ranked lower.'

/** Would today's pipeline still store this lesson: the extractor's rules, and the substance gate that
 *  groundEpisode applies before it writes? A lesson the gate holds back as a candidate IS still stored, so it
 *  passes; only one it would refuse outright fails. A stored lesson cannot be re-tagged as a candidate
 *  afterwards, so the middle band of lessons written before 1.55.0 is left as it is.
 *
 *  Only the distiller's lessons are judged (semantic and procedural), as groundEpisode judges them: an entity
 *  stub is a bare name, a summary is a rollup, and neither is something the gate was ever meant to score. */
export function wouldStillWriteV2(lesson: StoredLesson): boolean {
  if (lesson.memoryType !== 'semantic' && lesson.memoryType !== 'procedural') return true
  // A row that is not text is not a lesson to judge. The pass sits on a loop that only marks itself done at
  // the end, so one row that threw would stop it at that row on every launch.
  if (typeof lesson.content !== 'string') return true
  if (!wouldStillWrite(lesson)) return false
  return substanceBand(lessonSubstance(lesson.content).score) !== 'drop'
}

export interface RecheckDeps {
  /** Pages of the store's own lessons, newest first, older than `before` when given. */
  list: (opts: { agentId: 'mneme'; limit: number; before?: number }) => Promise<StoredLesson[]>
  /** Already-corrected ids are left alone: someone decided about them already. */
  isCorrected: (id: string) => boolean
  demote: (id: string, reason: string) => { ok: boolean }
  /** Whether this pass has run on this install before. Asynchronous: the marker is a file (recheckMarker), and the
   *  indexer that runs the pass is on the main thread, where a synchronous file call stalls typing. */
  done: () => Promise<boolean>
  markDone: () => Promise<void>
  /** Awaited every YIELD_EVERY demotions. Each demotion appends to the correction log
   *  synchronously, on the main thread, so a store with thousands of junk lessons must not do them
   *  in one unbroken run. Default: a setImmediate macrotask, which lets IPC and the PTYs through. */
  yield?: () => Promise<void>
  /** Whether a lesson stays as it is. Defaults to the 1.50.1 extractor rules (wouldStillWrite). */
  judge?: (lesson: StoredLesson) => boolean
  /** What the correction log says about a demotion. Defaults to RECHECK_REASON. */
  reason?: string
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
  if (await deps.done()) return { checked: 0, demoted: 0, skipped: 'already-run' }
  const judge = deps.judge ?? wouldStillWrite
  const reason = deps.reason ?? RECHECK_REASON
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
      if (deps.isCorrected(lesson.id) || judge(lesson)) continue
      try {
        if (deps.demote(lesson.id, reason).ok) demoted++
      } catch { /* left as it is; counted as checked */ }
      if (++attempts % YIELD_EVERY === 0) await (deps.yield ?? macrotask)()
    }
    if (page.length < PAGE || fresh === 0) break
    // The next page starts AT the oldest timestamp seen, not below it, so lessons that share it and
    // didn't fit on this page are not skipped; `seen` drops the ones already judged.
    before = (page[page.length - 1].ts || 0) + 1
  }
  await deps.markDone()
  return { checked, demoted }
}

/** The 1.55.0 pass: every stored lesson the substance gate would refuse today, demoted with its own reason.
 *  Run it with a marker of its own (RECHECK_V2_MARKER), once per device: corrections are not synced, so each
 *  computer demotes for itself. A lesson someone already corrected, the first pass included, is skipped. */
export function recheckStoredLessonsV2(deps: Omit<RecheckDeps, 'judge' | 'reason'>): Promise<RecheckResult> {
  return recheckStoredLessons({ ...deps, judge: wouldStillWriteV2, reason: RECHECK_V2_REASON })
}

/** What the disk said about each marker file this launch: the first look's answer, or the look itself while it is out, so
 *  passes that ask at the same time share one look; true once a pass has run to the end this launch. Module-level because
 *  the indexer builds a fresh marker object on every pass (index.ts), so a memo inside the object would be thrown away. */
const markerKnown = new Map<string, Promise<boolean>>()
/** Markers whose pass ran to the end this launch but whose record is not on disk yet: the text still to write. */
const markerOwed = new Map<string, string>()
/** A marker write under way, so passes that retry it at the same time share it. */
const markerWriting = new Map<string, Promise<void>>()
/** A temp file a failed marker write could not remove, by marker: removed before that marker's next write. */
const markerTempLeft = new Map<string, string>()

/** @internal test-only */
export function _resetRecheckMarkersForTests(): void {
  markerKnown.clear()
  markerOwed.clear()
  markerWriting.clear()
  markerTempLeft.clear()
}

let markerTemps = 0
/** How many temp names a write tries before it gives up, when each is already taken (EEXIST). */
const MARKER_TEMP_TRIES = 8
const errCode = (err: unknown): unknown => (err as { code?: unknown } | null)?.code

/** The marker files' store, asynchronous so no look or write is made on the main thread (on David's laptop Defender
 *  inspects each synchronous file call, and one can stall typing for up to 1.5 s). The app passes fs.promises.
 *
 *  A missing marker (ENOENT) is the answer "not run". Any other failure (EACCES, EPERM, EIO...) is "could not tell" and
 *  rejects: recheckMarker reads that as not run too, but does not remember it, so the next pass asks again.
 *
 *  A marker is written whole or not at all, since its being there is the whole answer: the text goes to a temp file beside
 *  it (same folder, so the rename never crosses a volume) and is renamed onto it. A write that fails part way, or a rename
 *  that is refused, removes the temp and rejects, leaving no marker. (agentConfigIO's atomicWriteText is synchronous, and
 *  ingestWatermark's writer falls back to writing the file in place, which could leave half a marker.)
 *
 *  The temp is created exclusively ('wx'), so the write never goes into, or through a link at, a file already there: a
 *  name that is taken is left alone and the next is tried, up to MARKER_TEMP_TRIES. A temp the failed write could not
 *  remove is remembered and removed before that marker's next write, which does not go ahead while it stays, so failures
 *  that persist leave one temp per marker, not one per try. A temp left by a crash between the write and the rename is
 *  not known to the next launch and stays: a few bytes, beside the marker, named for it. */
export function markerFs(fsp: {
  access: (p: string) => Promise<void>
  writeFile: (p: string, text: string, options: { flag: 'wx' }) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  unlink: (p: string) => Promise<void>
}): { exists: (p: string) => Promise<boolean>; write: (p: string, text: string) => Promise<void> } {
  return {
    exists: (p) => fsp.access(p).then(
      () => true,
      (err: unknown) => {
        if (errCode(err) === 'ENOENT') return false
        throw err
      },
    ),
    write: async (p, text) => {
      const unlink = (f: string): Promise<void> => new Promise<void>((resolve) => { resolve(fsp.unlink(f)) })
      // Our temp is gone (removed, or never made), or it is remembered for the next write to remove.
      const discard = (tmp: string): Promise<void> =>
        unlink(tmp).catch((e: unknown) => { if (errCode(e) !== 'ENOENT') markerTempLeft.set(p, tmp) })
      const left = markerTempLeft.get(p)
      if (left !== undefined) {
        // Still there and not removable: fail now rather than leave a second temp beside it.
        await unlink(left).catch((e: unknown) => { if (errCode(e) !== 'ENOENT') throw e })
        markerTempLeft.delete(p)
      }
      let tmp = ''
      for (let tries = 1; ; tries++) {
        tmp = `${p}.${process.pid}.${++markerTemps}.tmp`
        try {
          await fsp.writeFile(tmp, text, { flag: 'wx' })
          break
        } catch (err) {
          if (errCode(err) === 'EEXIST') {
            if (tries < MARKER_TEMP_TRIES) continue // someone else's file: left alone
            throw err
          }
          await discard(tmp) // a write that failed part way may have made it
          throw err
        }
      }
      try {
        await fsp.rename(tmp, p)
      } catch (err) {
        await discard(tmp)
        throw err
      }
    },
  }
}

/** Whether the pass has run, kept in userData under `name`. Unreadable counts as not run: running
 *  a pass twice only re-judges what it judged, and an already-demoted entry is skipped as corrected.
 *  The linked-history pass keeps its own marker the same way (linkedHistoryRecheck). */
export function recheckMarker(userDataPath: string, fs: {
  exists: (p: string) => Promise<boolean>
  write: (p: string, text: string) => Promise<void>
}, join: (...parts: string[]) => string, name = 'mneme-lesson-recheck.json', version = 1): Pick<RecheckDeps, 'done' | 'markDone'> {
  const file = join(userDataPath, name)
  const text = JSON.stringify({ version })
  // The disk is asked ONCE per launch. The indexer asks on every pass (every 30 minutes, on the main thread), and only
  // markDone() below changes the answer afterwards (one Termpolis per profile writes this file), so a second look at the
  // disk could only repeat the first. Passes that ask while the look is out wait for it instead of asking again. An
  // unreadable disk is not remembered: it is asked again on the next pass.
  //
  // Writes the record that is owed; one already under way is shared. Never rejects: a write that fails leaves the record
  // owed, for the next pass to write again.
  const persist = (owed: string): Promise<void> => {
    const under = markerWriting.get(file)
    if (under !== undefined) return under
    const writing = new Promise<void>((resolve) => { resolve(fs.write(file, owed)) }).then(
      () => { markerOwed.delete(file) },
      () => { /* still owed */ },
    ).finally(() => { markerWriting.delete(file) })
    markerWriting.set(file, writing)
    return writing
  }
  return {
    done: () => {
      // The pass ran this launch but its record is not on disk: done, and this pass only writes the record again.
      const owed = markerOwed.get(file)
      if (owed !== undefined) return persist(owed).then(() => true)
      let known = markerKnown.get(file)
      if (known === undefined) {
        // The executor runs now, so an exists() that throws instead of rejecting is caught here as well.
        const look = new Promise<boolean>((resolve) => { resolve(fs.exists(file)) })
        known = look
        markerKnown.set(file, look)
        // Forget a failed look, unless markDone() has recorded the pass meanwhile (that answer stands).
        look.catch(() => { if (markerKnown.get(file) === look) markerKnown.delete(file) })
      }
      return known.catch(() => false)
    },
    markDone: async () => {
      // The scan ran to the end: it is done for the rest of this launch whether or not the record reaches the disk, so a
      // folder that refuses the write costs one scan per launch, not one per pass. Until the record is written, each later
      // pass writes it again (done() above); a launch that never manages to write it scans once more at the next launch.
      markerKnown.set(file, Promise.resolve(true))
      markerOwed.set(file, text)
      await persist(text)
    },
  }
}
