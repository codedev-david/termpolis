// Lumopolis annotations: what a person confirmed in the pane, kept apart from the compiled world so a
// recompile never loses it. One JSON file per world under `<dir>/world/annotations/`, named by the
// sha256 of the world key (any key is safe as a file name), written atomically with async fs under a lock file
// that holds across processes. A display read shows nothing when the file cannot be read; a writer never writes after a
// failed read: a held file is read again, any other read error refuses the add (a fixed, path-free WorldReadError), and a
// file that does not parse reads as none and is moved aside to a numbered .bad backup by the next write (DSN R5, T5).
// Every write runs in one transaction under both locks, fenced just before its rename (DSN R5, T1).
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Claim, ClaimState, Evidence, EvidenceKind, WorldDoc } from '../../shared/world/types'
import { isRuntimeText, namesOfRuntimeText, runtimeText } from '../../shared/world/runtimeNames'
import { createKeyedLock } from './keyedLock'
import { copyClaims } from './idMigration'
import { copyAside, moveAside, retryLocked, type Sleep } from './storeFiles'
import { WorldReadError, worldFileName, type StoreTx, type WorldStore } from './worldStore'

export const MAX_ANNOTATION_TEXT = 400
export const MAX_ANNOTATION_EVIDENCE = 8
export const MAX_ANNOTATIONS_PER_ITEM = 20
/** The longest evidence ref and excerpt kept; a longer one is cut and ends in an ellipsis. */
export const MAX_EVIDENCE_REF = 512
export const MAX_EVIDENCE_EXCERPT = 400
const capped = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
/** What annotating an id that is not a building or line of the world answers. */
export const NO_PART = 'No part with that id.'

export interface AnnotationStore {
  /** Item id → its annotations, oldest first. Empty when none were stored or the file is unreadable. */
  list(key: string): Promise<Record<string, Claim[]>>
  /** Adds one annotation: text capped at MAX_ANNOTATION_TEXT, evidence at MAX_ANNOTATION_EVIDENCE, the oldest dropped past MAX_ANNOTATIONS_PER_ITEM.
   *  Rejects with WorldReadError (code ANNOTATIONS_READ_FAILED) when the stored annotations cannot be read, writing nothing.
   *  DSN R5 (T2): answers its undo, which takes back only this claim (and puts back the runtime-names claim it replaced),
   *  never a note the cap took; an add that changed nothing answers one that changes nothing. */
  add(key: string, itemId: string, claim: Claim): Promise<AnnotationUndo | void>
  /**
   * Copies each renamed item's annotations (old id -> new id) to its new id, after any it already has, a claim held under
   * both kept once and the item capped as an add caps it (idMigration.ts). The old ids keep theirs (WP5 fix I2) but no longer
   * show them (MOVED_SUFFIX). Writes only when a claim was not yet under its new id or the record changes, and rejects when a
   * write fails.
   */
  copyRenamed(key: string, renames: Record<string, string>): Promise<void>
  /**
   * Adds, after each part's own and in the order given, the claims a part does not hold yet: a design file saved before
   * DSN R3-2 carried its notes, and a load moves the ones the store lacks into it. A claim the part holds, or one copied
   * away from it (MOVED_SUFFIX), is left out, so two loads at once add each once. The part is capped as an add caps it.
   * DSN R4 (D4-4): the same write marks the key as moved (listStrict's `migrated`), so a design's notes move once, across
   * restarts. DSN R5 (T2): a key marked already is skipped, writing nothing; it rejects, writing nothing and marking
   * nothing, when the stored annotations cannot be read. A runtime-names claim is added only to a part that holds none.
   */
  addMissing(key: string, byItem: Record<string, Claim[]>): Promise<void>
  /**
   * DSN R4 (D4-4, D4-7): what list shows, and whether the key's design notes were moved into the store (addMissing marks
   * it, in the same write). Unlike list it rejects with WorldReadError (code ANNOTATIONS_READ_FAILED) when the stored
   * annotations cannot be read, held through the retries or not parsing, so a caller can tell none from unread.
   */
  listStrict(key: string, missing?: Record<string, Claim[]>): Promise<{ byItem: Record<string, Claim[]>; migrated: boolean }>
  /** DSN R5: runs `work` as one transaction on the key's annotations (createAnnotationStore says how). */
  transact<T>(key: string, work: (tx: StoreTx) => Promise<T>): Promise<T>
}

/** Takes back what one add added (AnnotationStore.add). */
export type AnnotationUndo = () => Promise<void>

const STATES = new Set<string>(['proposed', 'observed', 'inferred', 'verified'])
export const EVIDENCE_KINDS = new Set<string>(['file', 'symbol', 'test', 'transcriptStep', 'memory', 'commit', 'trace', 'metric', 'log', 'deploy', 'person'])
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A well-formed, capped claim from whatever was given (or read back from disk), else null. */
export function cleanClaim(v: unknown): Claim | null {
  if (!isRec(v) || typeof v.text !== 'string' || !STATES.has(v.state as string) || !Array.isArray(v.evidence)) return null
  const evidence: Evidence[] = []
  for (const e of v.evidence) {
    if (evidence.length === MAX_ANNOTATION_EVIDENCE) break
    if (isRec(e) && EVIDENCE_KINDS.has(e.kind as string) && typeof e.ref === 'string') {
      // HOLD-B #92: a test's excerpt says where its result came from ("from a test report", testStatus.ts), and the card shows
      // it. Only the test status may say that, so a note's test evidence keeps none, written or read back.
      evidence.push(typeof e.excerpt === 'string' && e.kind !== 'test' ? { kind: e.kind as EvidenceKind, ref: capped(e.ref, MAX_EVIDENCE_REF), excerpt: capped(e.excerpt, MAX_EVIDENCE_EXCERPT) } : { kind: e.kind as EvidenceKind, ref: capped(e.ref, MAX_EVIDENCE_REF) })
    }
  }
  if (evidence.length === 0) return null
  // A runtime-names claim is rebuilt from its checked names: never cut mid-name by the text cap.
  const text = isRuntimeText(v.text) ? runtimeText(namesOfRuntimeText(v.text)) : v.text.slice(0, MAX_ANNOTATION_TEXT)
  return { text, state: v.state as ClaimState, evidence }
}

const isRuntime = (c: Claim): boolean => isRuntimeText(c.text)

/** The claims of one item as kept: the newest MAX_ANNOTATIONS_PER_ITEM notes, plus at most one runtime-names claim (the newest), which no cap counts. */
function capClaims(list: Claim[]): Claim[] {
  return [...list.filter((c) => !isRuntime(c)).slice(-MAX_ANNOTATIONS_PER_ITEM), ...list.filter(isRuntime).slice(-1)]
}

/** DSN R4 (D4-4): the file's mark (its value `true`) that a design's notes were moved into it; never an item id. */
export const MIGRATED_KEY = '#migrated'
/** Whether a parsed file carries the mark. */
const markedIn = (parsed: unknown): boolean => isRec(parsed) && parsed[MIGRATED_KEY] === true
/** The file's text: the claims, and the mark when `migrated`. */
const fileText = (all: Record<string, Claim[]>, migrated: boolean): string => JSON.stringify(migrated ? { ...all, [MIGRATED_KEY]: true } : all)

/** The file holds `{ [itemId]: Claim[] }`; anything malformed in it is dropped rather than trusted. */
function cleanFile(parsed: unknown): Record<string, Claim[]> {
  const out: Record<string, Claim[]> = Object.create(null)
  if (!isRec(parsed)) return out
  for (const [id, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) continue
    const claims = capClaims(list.map(cleanClaim).filter((c): c is Claim => c !== null))
    if (claims.length > 0) out[id] = claims
  }
  return out
}

const annotationsFolder = (dir: string): string => join(dir, 'world', 'annotations')
const annotationsFileOf = (dir: string, key: string): string => join(annotationsFolder(dir), `${createHash('sha256').update(key).digest('hex')}.json`)

/** The annotation lock's timings. A writer that finds another's lock looks again after ANNOTATION_LOCK_RETRY_MS, each pause
 *  twice the last, up to ANNOTATION_LOCK_RETRY_MAX_MS. A lock older than ANNOTATION_LOCK_STALE_MS is taken over (its holder died
 *  mid-write: every write under it is a read, a small write and a rename). Past ANNOTATION_LOCK_DEADLINE_MS a writer stops
 *  waiting and fails, writing nothing (DSN R5, T1), so a world open or an add always ends. */
export const ANNOTATION_LOCK_RETRY_MS = 25
export const ANNOTATION_LOCK_RETRY_MAX_MS = 200
export const ANNOTATION_LOCK_STALE_MS = 5_000
export const ANNOTATION_LOCK_DEADLINE_MS = 2_000
const pause = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })
const codeOf = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? '')

/** DSN R5 (T1): no lock could be had on a world's annotations, after the wait or at all, so nothing was written. */
export class AnnotationLockError extends Error {
  constructor() {
    super('the annotations lock could not be had')
    this.name = 'AnnotationLockError'
  }
}

/** DSN R5 (T1): a transaction's lock was broken and taken, or a file it holds changed under it. It writes nothing more, and
 *  the transaction starts again from a fresh read (AnnotationStore.transact). */
export class AnnotationFenceLost extends Error {
  constructor() {
    super('the annotations lock was lost')
    this.name = 'AnnotationFenceLost'
  }
}

/** The lock a writer holds on one annotations file: its lock file and the nonce written in it. */
export interface AnnotationLockHold {
  lockFile: string
  nonce: string
}

/** Whether the lock file still holds the writer's nonce (nobody broke the lock and took it). */
const stillHeld = async (hold: AnnotationLockHold): Promise<boolean> => (await readFile(hold.lockFile, 'utf8').catch(() => null)) === hold.nonce

/**
 * WPA fix round 2 (R-M2): the annotation store's lock on one file, across processes. The world host adds annotations through
 * its own store and main adopts older keys' files, so the in-process keyed lock alone cannot keep them apart: each takes this
 * one too, a `<file>.lock` made with O_EXCL (`wx`) that holds a nonce of its own.
 * Fix round 3 (R2-I1): it always ends. Only EEXIST is another holder: it is looked at again after a pause that doubles each
 * time. DSN R5 (T1): never a write without the lock. Past ANNOTATION_LOCK_DEADLINE_MS, on any other error making the lock
 * (EPERM and EACCES are what Windows answers for a folder it will not let us write in), and for a stale lock that cannot be
 * removed, it rejects with AnnotationLockError and the work never runs.
 * Fix round 3 (R2-M2): the holder removes the lock only while it still holds its nonce, so a holder slower than
 * ANNOTATION_LOCK_STALE_MS never removes the lock of the one that broke its own. DSN R5 (T1): such a holder learns it
 * through its fence (the nonce checked again just before each rename) and writes nothing more.
 * Final minors (R3-M2): two writers that break the same stale lock both try again, since the one whose delete finds it gone
 * (ENOENT) lost only the race to delete it. A lock made whose nonce cannot be written (a full disk) is ours and empty: it is
 * removed, so nobody waits on it, and the take is tried once more; a second such failure means no lock here.
 */
/** Seams for tests: the pause between looks at a held lock, and the clock its deadline and a lock's age are read on. */
export interface AnnotationLockDeps {
  sleep?: Sleep
  now?: () => number
}

export async function withAnnotationFileLock<T>(file: string, work: (hold: AnnotationLockHold) => Promise<T>, deps: AnnotationLockDeps = {}): Promise<T> {
  const sleep = deps.sleep ?? pause
  const now = deps.now ?? Date.now
  const lockFile = `${file}.lock`
  const nonce = `${process.pid}:${randomUUID()}`
  const deadline = now() + ANNOTATION_LOCK_DEADLINE_MS
  let wait = ANNOTATION_LOCK_RETRY_MS
  let unwritten = false
  for (;;) {
    let made: FileHandle | null = null
    try {
      made = await open(lockFile, 'wx')
    } catch (err) {
      if (codeOf(err) !== 'EEXIST') throw new AnnotationLockError() // no lock can be made here
    }
    if (made) {
      let wrote = false
      try { await made.writeFile(nonce, 'utf8'); wrote = true } catch { /* a full disk: made, but empty */ }
      try { await made.close() } catch { /* the lock file stands, written or not */ }
      if (wrote) break
      // Made but not written: the empty lock is ours. Remove it either way, so nobody waits on it.
      let removed = true
      try { await rm(lockFile, { force: true }) } catch { removed = false }
      if (unwritten || !removed) throw new AnnotationLockError() // the second time, or it cannot be removed: no lock here
      unwritten = true
    } else {
      let age = -1
      try { age = now() - (await stat(lockFile)).mtimeMs } catch { /* let go meanwhile: try again after the pause */ }
      if (age >= ANNOTATION_LOCK_STALE_MS) {
        try { await rm(lockFile) } catch (err) {
          if (codeOf(err) !== 'ENOENT') throw new AnnotationLockError() // a stale lock that cannot be removed
        } // ENOENT: another writer broke it first; try again
      }
    }
    if (now() >= deadline) throw new AnnotationLockError()
    await sleep(wait)
    wait = Math.min(wait * 2, ANNOTATION_LOCK_RETRY_MAX_MS)
  }
  const hold = { lockFile, nonce }
  try {
    return await work(hold)
  } finally {
    try {
      if (await stillHeld(hold)) await rm(lockFile, { force: true })
    } catch { /* gone already: broken by another and let go */ }
  }
}

/** The rename errors a virus scanner or the indexer holding the file causes on Windows, for a moment. A rename refused with
 *  one is tried again after 100 ms x the attempt, ANNOTATION_RENAME_ATTEMPTS times in all (about a second of pauses, as
 *  graceful-fs does and as gitSource's renameWithRetry does for a world's sources); any other error throws at once. */
export const ANNOTATION_RENAME_RETRY_CODES: readonly string[] = ['EPERM', 'EACCES', 'EBUSY']
const ANNOTATION_RENAME_ATTEMPTS = 5
export const ANNOTATION_RENAME_RETRY_TOTAL_MS = 100 * ((ANNOTATION_RENAME_ATTEMPTS - 1) * ANNOTATION_RENAME_ATTEMPTS) / 2

async function renameRetrying(from: string, to: string, before?: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    // DSN R5 (T1): asked again before each try, so a rename that waited out a held file never lands after its lock was lost.
    await before?.()
    try {
      return await rename(from, to)
    } catch (err) {
      if (attempt >= ANNOTATION_RENAME_ATTEMPTS || !ANNOTATION_RENAME_RETRY_CODES.includes(codeOf(err))) throw err
      await pause(100 * attempt)
    }
  }
}

/** Write `text` to `target` whole or not at all: a temp file beside it, then a rename (tried again while Windows refuses it
 *  for a moment). The temp file never outlives a failure, and `fence`, when given, rejects to stop it before the rename. */
async function writeAtomic(target: string, text: string, fence?: () => Promise<void>): Promise<void> {
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, text, 'utf8')
    // DSN R5 (T1): a writer under a lock checks it still holds it just before each try of the rename, and writes nothing
    // when not.
    await renameRetrying(tmp, target, fence)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/** Beside a new key's file: the older keys whose files could not be read when it was adopted, to be tried on a later open. */
export const ADOPT_PENDING_SUFFIX = '.adopt-pending'

/** An older key's claims; 'none' when its file is missing, empty or does not parse (nothing to take, now or later);
 *  'unread' when it exists but could not be read even after the retries (held by another program, say): tried again later. */
async function readAlias(file: string, sleep: Sleep): Promise<Record<string, Claim[]> | 'none' | 'unread'> {
  let text: string
  try {
    text = await retryLocked(() => readFile(file, 'utf8'), sleep)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'unread'
  }
  try {
    const claims = cleanFile(JSON.parse(text))
    return Object.keys(claims).length > 0 ? claims : 'none'
  } catch {
    return 'none'
  }
}

/** N1: whether writing `cleaned` back would lose part of what the file held (`parsed`). A file this version wrote reads back
 *  the same; anything this version does not read (an evidence kind or claim state it does not know, a field or shape of a
 *  later version, past a cap) makes it differ. */
const loses = (cleaned: Record<string, Claim[]>, parsed: unknown): boolean => fileText(cleaned, markedIn(parsed)) !== JSON.stringify(parsed)

/** The new key's own claims, or null when its file cannot be read, does not parse, or holds notes this version cannot read
 *  that could not be backed up first (then nothing is written over it). */
async function readOwn(file: string, sleep: Sleep, now: () => number): Promise<Record<string, Claim[]> | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await retryLocked(() => readFile(file, 'utf8'), sleep))
  } catch {
    return null
  }
  const claims = cleanFile(parsed)
  return loses(claims, parsed) && !(await copyAside(file, { now, sleep })) ? null : claims
}

/** WP3 round 3 (M5): an older key that cannot be adopted is tried on at most ADOPT_RETRY_OPENS opens in all, each try
 *  after the first only once ADOPT_RETRY_BACKOFF_MS has passed, doubled after every try (1, 2, 4 ... 64 minutes: about two
 *  hours in all). A file held for good costs a few reads, never about a second on every open; then it is given up on and
 *  logged, its file is left as it was, and the record keeps it as given up. An open with nothing due reads only the
 *  record. */
export const ADOPT_RETRY_OPENS = 8
export const ADOPT_RETRY_BACKOFF_MS = 60_000
/** The `next` of a key given up on: it stays in the record, so no later open reads its file again. */
export const ADOPT_GIVEN_UP = Number.MAX_SAFE_INTEGER

/** One older key still to adopt: how many opens tried it, and the time from which the next one may. */
export interface PendingKey {
  key: string
  tries: number
  next: number
}

const isPendingKey = (v: unknown): v is PendingKey => {
  const p = v as Partial<PendingKey> | null
  return typeof p?.key === 'string' && Number.isFinite(p.tries) && Number.isFinite(p.next)
}

/** The older keys still to adopt, or null when nothing is pending (no marker, or one that cannot be read now). A round 2
 *  record (a list of keys) reads as tried once and due now; an entry of neither shape is dropped. */
async function readPending(file: string): Promise<PendingKey[] | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((v: unknown): PendingKey[] => (typeof v === 'string' ? [{ key: v, tries: 1, next: 0 }] : isPendingKey(v) ? [v] : []))
}

/** Records the older keys still to adopt, or removes the record when there are none. Resolves whether that landed. */
async function keepPending(file: string, keys: PendingKey[]): Promise<boolean> {
  try {
    if (keys.length > 0) await writeAtomic(file, JSON.stringify(keys))
    else await rm(file, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * WPA fix M2: a world key is its root's project key, and WPA gave a few spellings of a folder (Git Bash `/c/...`, Cygwin, WSL
 * `/mnt/c/...`, doubled separators) the canonical key instead of their own. A normal Windows root keeps its key, so this is a
 * no-op for it. For a root whose key changed, the annotations a person made under its older keys follow it to the new key the
 * first time the world opens. Fix round 2 (R-M2): it runs under the annotation store's lock on the new key's file (so an add
 * in the world host cannot replace the copy, nor the copy an add); every older key that has a file is merged in, in the order
 * given, a claim found under two keys kept once, each item capped as an add caps it; the file is written whole (a temp file,
 * then a rename). A file the new key already has keeps every claim it holds (they are the newer ones), no older file is
 * ever deleted, and it never throws. Resolves with the older keys it merged, or an empty list.
 * WP3 round 2: an older file that exists but cannot be read (held by another program through the retries) is not given up
 * on. Its key is recorded beside the new key's file (ADOPT_PENDING_SUFFIX), and every later open tries it again, even once
 * the new key has a file of its own: its claims then go in before the new key's own (which are newer), nothing of the new
 * key's file is lost, and the record goes once nothing is left to try. A new key's file that cannot be read keeps the record.
 * WP3 round 3 (M2): a record that adds keys is written BEFORE the merged file, so no crash between the two leaves a new
 * key's file without the record of what is still to try; a record that cannot be written means nothing is written, and the
 * next open starts over. A record that only shrinks is written after the merged file: a crash between them leaves keys
 * already merged in it, and merging them again changes nothing.
 * WP3 round 3 (M3): a new key's file that appears while the older files are read (the world host saved it meanwhile) is
 * merged into the same way, its own claims last, so what was read is not dropped. When that file cannot be read, every key
 * read or held goes in the record instead, for a later open to try again.
 * WP3 round 3 (M5): each key in the record carries its tries and when the next may run (ADOPT_RETRY_OPENS,
 * ADOPT_RETRY_BACKOFF_MS). An open before any key is due reads only the record; a key tried ADOPT_RETRY_OPENS times is
 * given up on, with a log line, and stays in the record so that no later open reads it again.
 */
export async function adoptAnnotationAliases(dir: string, key: string, aliasKeys: readonly string[], deps: { sleep?: Sleep; now?: () => number; lock?: AnnotationLockDeps } = {}): Promise<string[]> {
  const others = aliasKeys.filter((k, i) => k && k !== key && aliasKeys.indexOf(k) === i)
  if (!key || others.length === 0) return []
  const sleep = deps.sleep ?? pause
  const now = deps.now ?? Date.now
  const target = annotationsFileOf(dir, key)
  const pendingFile = `${target}${ADOPT_PENDING_SUFFIX}`
  const exists = (f: string): Promise<boolean> => access(f).then(() => true, () => false)
  const had = await exists(target)
  // The common case, every open after the first: one look for a record, no lock taken.
  const pending = await readPending(pendingFile)
  if (had && !pending) return []
  const at = now()
  const prior = (pending ?? []).filter((p) => others.includes(p.key))
  const later = prior.filter((p) => p.next > at)
  const waits = (k: string): boolean => later.some((p) => p.key === k)
  // With a file of its own, the new key needs only the keys in the record; without one (nothing merged yet, or a crash
  // came between the record and the merged file) every key but those waiting out a back-off.
  const wanted = had ? prior.filter((p) => !waits(p.key)).map((p) => p.key) : others.filter((k) => !waits(k))
  if (wanted.length === 0 && later.length > 0) return [] // none due yet: no read, no lock (M5)
  /** M5: the record's entries for `keys`, tried once more now: due again after a longer back-off, or given up on. */
  const triedNow = (keys: string[]): PendingKey[] => keys.map((k): PendingKey => {
    const tries = (prior.find((p) => p.key === k)?.tries ?? 0) + 1
    if (tries < ADOPT_RETRY_OPENS) return { key: k, tries, next: at + ADOPT_RETRY_BACKOFF_MS * 2 ** (tries - 1) }
    console.warn(`[world annotations] an older key's annotations could not be adopted in ${tries} tries and are no longer tried; their file is left as it was`)
    return { key: k, tries, next: ADOPT_GIVEN_UP }
  })
  const found: Array<[string, Record<string, Claim[]>]> = []
  const unread: string[] = []
  for (const old of wanted) {
    const claims = await readAlias(annotationsFileOf(dir, old), sleep)
    if (claims === 'unread') unread.push(old)
    else if (claims !== 'none') found.push([old, claims])
  }
  if (!had && !pending && found.length === 0 && unread.length === 0) return []
  try {
    return await withAnnotationFileLock(target, async (hold) => {
      let own: Record<string, Claim[]> | null = null
      if (await exists(target)) {
        // The new key's own claims, newer than any older key's; when `had` is false, the world host saved them while we read.
        own = await readOwn(target, sleep, now)
        if (!own) {
          // A held-back merge never loses the new key's notes. Every key read or held stays in the record (or, for a file
          // that appeared while we read, goes in it) as tried once more, so a later open tries again after its back-off.
          await keepPending(pendingFile, [...later, ...triedNow([...found.map(([old]) => old), ...unread])])
          return []
        }
      }
      const record = [...later, ...triedNow(unread)]
      // On a first adoption every key in `unread` is new to the record: it goes down before the merged file.
      const first = !had && unread.length > 0
      if (first && !(await keepPending(pendingFile, record))) return []
      if (found.length > 0) {
        await carryMoved(dir, target, own, found)
        const merged: Record<string, Claim[]> = Object.create(null)
        for (const claims of [...found.map(([, c]) => c), ...(own ? [own] : [])]) {
          for (const [id, list] of Object.entries(claims)) {
            const have = merged[id] ?? []
            const seen = new Set(have.map((c) => JSON.stringify(c)))
            merged[id] = [...have, ...list.filter((c) => !seen.has(JSON.stringify(c)))]
          }
        }
        for (const id of Object.keys(merged)) merged[id] = capClaims(merged[id])
        await writeAtomic(target, JSON.stringify(merged), async () => { if (!(await stillHeld(hold))) throw new AnnotationFenceLost() })
      }
      if (!first) await keepPending(pendingFile, record) // no key added: after the merged file
      return found.map(([old]) => old)
    }, deps.lock)
  } catch {
    // The file could not be written: every older key's file stays as it was. HOLD-B #17 (WP5 N1): every key this open wanted
    // goes in the record, tried once more, so a later open tries it again after its back-off. The record is also what tells a
    // later open that a lowered key was this folder's (adoptWorldAliases), once its recent-list line has moved.
    await keepPending(pendingFile, [...later, ...triedNow(wanted)])
    return []
  }
}

/** HOLD-B #17: the older keys the record beside `key`'s annotations still holds (due, waiting, or given up on), or none.
 *  Each was handed to adoptAnnotationAliases as this folder's on an earlier open. */
export async function pendingAdoptionKeys(dir: string, key: string): Promise<string[]> {
  return ((await readPending(`${annotationsFileOf(dir, key)}${ADOPT_PENDING_SUFFIX}`)) ?? []).map((p) => p.key)
}

/**
 * HOLD-B #37 (WP5 M4/N3): beside a world's annotations, the claims an id rename copied away from each old id, as
 * `{ [oldId]: claim JSON[] }`. The old id keeps them in its file (an older build, which still gives that id, finds them there:
 * WP5 fix I2), but this build no longer shows them under it, so a different part that later gets the old id shows only its
 * own: a namesake folder that took the plain name back once the other went, say. A part renamed back to the id, or the same
 * note added there again, shows again.
 */
export const MOVED_SUFFIX = '.moved'
type Moved = Record<string, string[]>
const claimKey = (c: Claim): string => JSON.stringify(c)

/** The record, empty when it is missing or cannot be read (what the file holds then shows, as before the record). */
async function readMoved(file: string): Promise<Moved> {
  const out: Moved = Object.create(null)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return out
  }
  if (!isRec(parsed)) return out
  for (const [id, list] of Object.entries(parsed)) {
    const keys = Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : []
    if (keys.length > 0) out[id] = keys
  }
  return out
}

/** Writes the record, or removes it when it holds nothing. Rejects when that fails. */
async function writeMoved(file: string, moved: Moved): Promise<void> {
  if (Object.keys(moved).length > 0) await writeAtomic(file, JSON.stringify(moved))
  else await rm(file, { force: true })
}

/** holdb-review M4: the record beside the new key's file (`target`) with each older key's record added, written before the
 *  merged file, so what an older key hid under an id stays hidden under the new key. A claim the new key's own file (`own`)
 *  shows under that id is newer than that record and stays shown, and so does one another older key in `found` shows there
 *  (holdb-codex-review round 2: the same note added there on its own): only the key that renamed it away hid it. Rejects when
 *  the record cannot be written; adoption then writes nothing and tries again later. */
async function carryMoved(dir: string, target: string, own: Record<string, Claim[]> | null, found: ReadonlyArray<[string, Record<string, Claim[]>]>): Promise<void> {
  const file = `${target}${MOVED_SUFFIX}`
  const have = await readMoved(file)
  const records: Array<[Record<string, Claim[]>, Moved]> = [[own ?? {}, have]]
  for (const [old, claims] of found) records.push([claims, await readMoved(`${annotationsFileOf(dir, old)}${MOVED_SUFFIX}`)])
  const shown = new Map<string, Set<string>>()
  for (const [claims, moved] of records) {
    for (const [id, list] of Object.entries(shownClaims(claims, moved))) shown.set(id, new Set([...(shown.get(id) ?? []), ...list.map(claimKey)]))
  }
  const out: Moved = Object.assign(Object.create(null), have)
  for (const [, moved] of records.slice(1)) {
    for (const [id, keys] of Object.entries(moved)) {
      const mine = shown.get(id) ?? new Set<string>()
      const add = keys.filter((k) => !mine.has(k))
      if (add.length > 0) out[id] = [...new Set([...(out[id] ?? []), ...add])]
    }
  }
  if (JSON.stringify(out) !== JSON.stringify(have)) await writeMoved(file, out)
}

/** The claims as shown: `all` less those the record says were copied away from their id. */
function shownClaims(all: Record<string, Claim[]>, moved: Moved): Record<string, Claim[]> {
  const out: Record<string, Claim[]> = Object.create(null)
  for (const [id, list] of Object.entries(all)) {
    const away = new Set(moved[id] ?? [])
    const keep = list.filter((c) => !away.has(claimKey(c)))
    if (keep.length > 0) out[id] = keep
  }
  return out
}

/** The record once `map` has copied the claims `shown` (the ones shown before the copy): each old id's claims are copied away
 *  from it, and those copied to an id show there again (a part renamed back, or two parts that swapped ids). Null when
 *  unchanged. */
function movedAfter(shown: Record<string, Claim[]>, map: ReadonlyMap<string, string>, moved: Moved): Moved | null {
  const out: Moved = Object.create(null)
  for (const [id, keys] of Object.entries(moved)) out[id] = keys
  const pairs = [...map].filter(([from, to]) => from !== to && shown[from] !== undefined)
  for (const [from] of pairs) out[from] = [...new Set([...(out[from] ?? []), ...shown[from].map(claimKey)])]
  for (const [from, to] of pairs) {
    const back = new Set(shown[from].map(claimKey))
    const left = (out[to] ?? []).filter((k) => !back.has(k))
    if (left.length > 0) out[to] = left
    else delete out[to]
  }
  return JSON.stringify(out) === JSON.stringify(moved) ? null : out
}

/** A world's stored annotations as read: the claims, and whether its design notes were moved in (MIGRATED_KEY). */
interface Stored {
  all: Record<string, Claim[]>
  migrated: boolean
}

/** What a transaction read, and the backup its next write of the file needs first: none, the file moved aside (it does not
 *  parse), or a copy kept (it holds what this version cannot read). */
interface StoredForWrite extends Stored {
  backup: 'move' | 'copy' | null
}

/** Seams for tests: the file read, the wait between reads of a held file, the clock that stamps a backup and times the lock,
 *  and the write of the annotations file (handed the real write, to make it or fail it). */
export interface AnnotationStoreDeps {
  readFile?: (file: string, encoding: 'utf8') => Promise<string>
  sleep?: Sleep
  now?: () => number
  writeFileAtomic?: (file: string, text: string, write: (file: string, text: string) => Promise<void>) => Promise<void>
}

/** DSN R5 (T1): how many times a transaction that lost its lock, or found a file it holds changed, starts again from a fresh
 *  read before it fails with AnnotationLockError. */
export const ANNOTATION_TX_TRIES = 3

/** One transaction on a world's annotations: the files it read and holds, and how to take back what it wrote. */
interface Tx {
  file: string
  /** The design's world file, read with the annotations and fenced with them; null for any other key. */
  design: string | null
  hold: AnnotationLockHold
  text: string | null
  designText: string | null
  lost: boolean
  closed: boolean
  undos: Array<{ done: boolean; run: AnnotationUndo }>
}

/** The transaction running in this async context. Shared by every store in the process, so a store made on the same
 *  folder joins a transaction another began on the same file instead of waiting for its lock (tx.file is the path). */
const transactions = new AsyncLocalStorage<Tx>()

/** No such file: a missing file reads as none. */
const isMissing = (err: unknown): boolean => codeOf(err) === 'ENOENT'

export function createAnnotationStore(dir: string, deps: AnnotationStoreDeps = {}): AnnotationStore {
  const folder = annotationsFolder(dir)
  const lock = createKeyedLock()
  const fileOf = (key: string): string => annotationsFileOf(dir, key)
  const movedOf = (key: string): string => `${fileOf(key)}${MOVED_SUFFIX}`
  const designOf = (key: string): string | null => (key.startsWith('design:') ? join(dir, 'world', worldFileName(key)) : null)
  const readText = deps.readFile ?? readFile
  const sleep = deps.sleep ?? pause
  const now = deps.now ?? Date.now
  const writeFileAtomic = deps.writeFileAtomic ?? ((file, text, write) => write(file, text))

  /** A file's text, null when it is missing; it throws when the file cannot be read (a held one is read again first). */
  const readRaw = async (file: string): Promise<string | null> => {
    try {
      return await retryLocked(() => readText(file, 'utf8'), sleep)
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  /** What a file's text holds: none for no file, and for one that does not parse (DSN R5, T5: read as empty, and moved
   *  aside by the next write), which `backup` says. */
  const parse = (text: string | null): StoredForWrite => {
    const none = (backup: StoredForWrite['backup']): StoredForWrite => ({ all: cleanFile(undefined), migrated: false, backup })
    if (text === null) return none(null)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return none('move')
    }
    const cleaned = cleanFile(parsed)
    // N1: a write keeps only what this version reads. A file holding more (an evidence kind or claim state it does not
    // know, a field or shape of a later version, past a cap) goes into the backups first, untouched.
    return { all: cleaned, migrated: markedIn(parsed), backup: loses(cleaned, parsed) ? 'copy' : null }
  }

  /** For display: what can be read, nothing when the file is missing, unreadable or broken. */
  const read = async (key: string): Promise<Stored> => {
    try {
      return parse(await readRaw(fileOf(key)))
    } catch {
      return { all: cleanFile(undefined), migrated: false }
    }
  }

  /** The transaction running here on the key's file, if any (one begun by any store on the same folder). */
  const current = (key: string): Tx | undefined => {
    const tx = transactions.getStore()
    return tx && !tx.closed && tx.file === fileOf(key) ? tx : undefined
  }

  /** Marks the transaction lost: it writes nothing more, and starts again. */
  const lose = (tx: Tx): never => {
    tx.lost = true
    throw new AnnotationFenceLost()
  }

  /** DSN R5 (T1): the fence, just before each write. The lock still holds this transaction's nonce, and the files it read
   *  are as it last read or wrote them; otherwise it is lost. */
  const fenceTx = async (tx: Tx): Promise<void> => {
    if (tx.lost) lose(tx)
    const textOf = async (file: string): Promise<string | null | undefined> => readRaw(file).catch(() => undefined)
    if ((await textOf(tx.file)) !== tx.text) lose(tx)
    if (tx.design !== null && (await textOf(tx.design)) !== tx.designText) lose(tx)
    // The lock last, read straight from the disk, so nothing waits between it and the rename: a lock taken over while
    // the files were read is still seen.
    if (!(await stillHeld(tx.hold))) lose(tx)
  }

  /** The stored annotations as the transaction holds them, read again: a file changed since loses the transaction. */
  const readTx = async (tx: Tx): Promise<StoredForWrite> => {
    if (tx.lost) lose(tx)
    let text: string | null
    try {
      text = await readRaw(tx.file)
    } catch (err) {
      console.warn(`[world annotations] a world's annotations could not be read, so nothing was added: ${String(err)}`)
      throw new WorldReadError('ANNOTATIONS_READ_FAILED')
    }
    if (text !== tx.text) lose(tx)
    return parse(text)
  }

  /** Writes the claims under the transaction's lock, fenced, after the backup the read asked for. Without that backup it
   *  writes nothing. */
  const writeTx = async (tx: Tx, all: Record<string, Claim[]>, migrated: boolean, backup: StoredForWrite['backup']): Promise<void> => {
    await fenceTx(tx)
    if (backup === 'move') {
      // Kept for inspection, never written over: without the backup nothing is written.
      if (!(await moveAside(tx.file, { now, sleep }))) {
        console.warn("[world annotations] a world's annotations do not parse and could not be moved aside, so nothing was added")
        throw new WorldReadError('ANNOTATIONS_READ_FAILED')
      }
      tx.text = null
    } else if (backup === 'copy' && !(await copyAside(tx.file, { now, sleep }))) {
      console.warn("[world annotations] a world's annotations hold notes this version cannot read and could not be backed up, so nothing was added")
      throw new WorldReadError('ANNOTATIONS_READ_FAILED')
    }
    const text = fileText(all, migrated)
    await writeFileAtomic(tx.file, text, (file, t) => writeAtomic(file, t, () => fenceTx(tx)))
    tx.text = text
  }

  /** The record of claims copied away, written under the transaction's lock once its fence holds. */
  const writeMovedTx = async (tx: Tx, key: string, moved: Moved): Promise<void> => {
    await fenceTx(tx)
    await writeMoved(movedOf(key), moved)
  }

  /** The transaction's first read, under the lock: the annotations, and a design's world file. Rejects, writing nothing,
   *  when either cannot be read. */
  const begin = async (key: string, hold: AnnotationLockHold, undos: Tx['undos']): Promise<Tx> => {
    const file = fileOf(key)
    const design = designOf(key)
    let text: string | null
    try {
      text = await readRaw(file)
    } catch (err) {
      console.warn(`[world annotations] a world's annotations could not be read, so nothing was added: ${String(err)}`)
      throw new WorldReadError('ANNOTATIONS_READ_FAILED')
    }
    let designText: string | null = null
    if (design !== null) {
      try {
        designText = await readRaw(design)
      } catch (err) {
        console.warn(`[world annotations] a design could not be read, so nothing was changed: ${String(err)}`)
        throw new WorldReadError('WORLD_READ_FAILED')
      }
    }
    return { file, design, hold, text, designText, lost: false, closed: false, undos }
  }

  /**
   * DSN R5: the one transaction for every change to a world's notes, claims or names. Under the keyed lock and the file
   * lock, it reads the annotations (and a design's world file) and runs `work`, whose reads and writes in this store go
   * through it. Each write is fenced (fenceTx): a lost lock or a file changed under it stops the write, and the whole
   * transaction starts again from a fresh read, after taking back what its writes so far added, up to ANNOTATION_TX_TRIES
   * times; then it fails with AnnotationLockError. Any other failure of `work` takes back what it added and rejects.
   * A call from inside a transaction on the same key joins it.
   */
  const transact = <T>(key: string, work: (tx: StoreTx) => Promise<T>): Promise<T> => {
    const joined = current(key)
    const handle = (tx: Tx): StoreTx => ({
      fence: () => fenceTx(tx),
      track: async () => {
        // The design's world file as this transaction just wrote it; one that cannot be read loses it.
        try {
          tx.designText = tx.design === null ? null : await readRaw(tx.design)
        } catch {
          tx.lost = true
        }
      }
    })
    if (joined) return work(handle(joined))
    const takeBack = async (undos: Tx['undos']): Promise<void> => {
      for (const undo of [...undos].reverse()) if (!undo.done) await undo.run()
    }
    return lock(key, async () => {
      await mkdir(folder, { recursive: true })
      let carried: Tx['undos'] = []
      for (let attempt = 1; ; attempt++) {
        let tx: Tx | null = null
        try {
          return await withAnnotationFileLock(fileOf(key), async (hold) => {
            const started = await begin(key, hold, carried)
            tx = started
            try {
              return await transactions.run(started, async () => {
                // What a lost try added is taken back first, under this try's lock.
                await takeBack(started.undos)
                if (attempt > ANNOTATION_TX_TRIES) throw new AnnotationLockError()
                try {
                  return await work(handle(started))
                } catch (err) {
                  if (!started.lost && !(err instanceof AnnotationFenceLost)) await takeBack(started.undos).catch(() => undefined)
                  throw err
                }
              })
            } finally {
              started.closed = true
            }
          }, { sleep, now })
        } catch (err) {
          // Only a fence loses a transaction, and only one begun: anything else, a failed first read included, rejects.
          const lostTx = tx as Tx | null
          if (lostTx === null || (!(err instanceof AnnotationFenceLost) && !lostTx.lost)) throw err
          carried = lostTx.undos
          const pending = carried.some((u) => !u.done)
          if (attempt >= ANNOTATION_TX_TRIES && (!pending || attempt >= 2 * ANNOTATION_TX_TRIES)) throw new AnnotationLockError()
        }
      }
    })
  }

  /** Adds each claim of `byItem` a part does not hold yet, after its own, in the order given: one held, or copied away from
   *  the part (`moved`), is left out, and a runtime-names claim only when the part holds none (the store's is newer). The
   *  part is capped as an add caps it. True when one was added. */
  const addInto = (all: Record<string, Claim[]>, moved: Moved, byItem: Record<string, Claim[]>): boolean => {
    let added = false
    for (const [id, list] of Object.entries(byItem)) {
      const have = all[id] ?? []
      const held = new Set([...have.map(claimKey), ...(moved[id] ?? [])])
      let named = have.some(isRuntime)
      const more: Claim[] = []
      for (const claim of list.map(cleanClaim)) {
        if (claim === null || held.has(claimKey(claim))) continue
        if (isRuntime(claim)) {
          if (named) continue
          named = true
        }
        held.add(claimKey(claim))
        more.push(claim)
      }
      if (more.length === 0) continue
      all[id] = capClaims([...have, ...more])
      added = true
    }
    return added
  }

  /** The undo of one add: it takes back only that claim, puts back the runtime-names claim it replaced when the part holds
   *  none, and never a note the cap took (DSN R5, T2). Run again, it changes nothing. */
  const undoOf = (key: string, itemId: string, clean: Claim, replaced: Claim | undefined, wasMoved: boolean): Tx['undos'][number] => {
    const entry: Tx['undos'][number] = {
      done: false,
      run: () => transact(key, async () => {
        if (entry.done) return
        const tx = current(key) as Tx
        const { all, migrated, backup } = await readTx(tx)
        const mine = claimKey(clean)
        const have = all[itemId] ?? []
        if (!have.some((c) => claimKey(c) === mine)) {
          entry.done = true
          return
        }
        if (wasMoved) {
          // The add showed again a claim copied away from the id: copied away again, and the file keeps it, as before.
          const moved = await readMoved(movedOf(key))
          if (!moved[itemId]?.includes(mine)) await writeMovedTx(tx, key, { ...moved, [itemId]: [...(moved[itemId] ?? []), mine] })
          entry.done = true
          return
        }
        let next = have.filter((c) => claimKey(c) !== mine)
        if (replaced && !next.some(isRuntime)) next = capClaims([...next, replaced])
        if (next.length > 0) all[itemId] = next
        else delete all[itemId]
        await writeTx(tx, all, migrated, backup)
        entry.done = true
      })
    }
    return entry
  }

  return {
    list: async (key) => shownClaims((await read(key)).all, await readMoved(movedOf(key))),
    listStrict: async (key, missing) => {
      const tx = current(key)
      let stored: Stored
      if (tx) stored = await readTx(tx)
      else {
        try {
          stored = parse(await readRaw(fileOf(key)))
        } catch (err) {
          console.warn(`[world annotations] a world's annotations could not be read: ${String(err)}`)
          throw new WorldReadError('ANNOTATIONS_READ_FAILED')
        }
      }
      const moved = await readMoved(movedOf(key))
      // DSN R5 (T3): an unmarked key shows, in memory, what moving `missing` into it would hold. Nothing is written.
      if (missing && !stored.migrated) addInto(stored.all, moved, missing)
      return { byItem: shownClaims(stored.all, moved), migrated: stored.migrated }
    },
    transact,
    add: async (key, itemId, claim) => {
      const clean = cleanClaim(claim)
      if (clean === null) throw new Error('annotation needs text, a state and evidence')
      return transact(key, async () => {
        const tx = current(key) as Tx
        const { all, migrated, backup } = await readTx(tx)
        let have = all[itemId] ?? []
        const moved = await readMoved(movedOf(key))
        const mine = claimKey(clean)
        const wasMoved = moved[itemId]?.includes(mine) ?? false
        // DSN R4 (D4-6): the same note on the part already, shown there, is not added again: no second slot under the cap.
        if (!wasMoved && have.some((c) => claimKey(c) === mine)) return async () => undefined
        if (wasMoved) {
          // HOLD-B #37: a note copied away from this id and added here again is this part's now: shown, once, as the newest.
          // The record goes first: when it cannot be written, nothing is. On purpose the other way round is not covered: when
          // the record lands and the file write below fails, the add rejects, yet the note shows under the id at its old place
          // (holdb-review M5). It is the note the person just added there, so that loses nothing, and the add can be retried.
          const left = moved[itemId].filter((k) => k !== mine)
          if (left.length > 0) moved[itemId] = left
          else delete moved[itemId]
          await writeMovedTx(tx, key, moved)
          have = have.filter((c) => claimKey(c) !== mine)
        }
        const replaced = isRuntime(clean) ? have.filter(isRuntime).slice(-1)[0] : undefined
        all[itemId] = capClaims([...have, clean])
        await writeTx(tx, all, migrated, backup)
        const undo = undoOf(key, itemId, clean, replaced, wasMoved)
        tx.undos.push(undo)
        return undo.run
      })
    },
    addMissing: (key, byItem) =>
      transact(key, async () => {
        const tx = current(key) as Tx
        const { all, migrated, backup } = await readTx(tx)
        // DSN R5 (T2): computed in the transaction, from the store as it is now, and skipped once the key is marked.
        if (migrated) return
        addInto(all, await readMoved(movedOf(key)), byItem)
        await writeTx(tx, all, true, backup)
      }),
    copyRenamed: async (key, renames) => {
      const map = new Map(Object.entries(renames))
      // holdb-codex-review: an id copies only the claims it shows. Those the record hides under it were copied away from it
      // by an earlier rename and are another part's; the file keeps them under the old id all the same.
      const plan = (all: Record<string, Claim[]>, record: Moved): { next: Record<string, Claim[]> | null; moved: Moved | null } => {
        const shown = shownClaims(all, record)
        const next = copyClaims(all, map, shown)
        return { next: next === all ? null : next, moved: movedAfter(shown, map, record) }
      }
      const first = plan((await read(key)).all, await readMoved(movedOf(key)))
      // The common case: nothing to copy and nothing to record, no lock taken.
      if (first.next === null && first.moved === null) return
      await transact(key, async () => {
        const tx = current(key) as Tx
        const { all, migrated, backup } = await readTx(tx)
        const { next, moved } = plan(all, await readMoved(movedOf(key)))
        if (next !== null) {
          for (const id of Object.keys(next)) next[id] = capClaims(next[id])
          await writeTx(tx, next, migrated, backup)
        }
        // HOLD-B #37: after the copy, so a failure between the two leaves the old id's claims shown, as before the record.
        // A record that cannot be written rejects, so the compile saves nothing and the next one copies and records again.
        if (moved !== null) await writeMovedTx(tx, key, moved)
      })
    }
  }
}

/** True when a claim was added by a person (only annotations carry person evidence). */
const isPerson = (c: Claim): boolean => c.evidence.some((e) => e.kind === 'person')

/**
 * The doc with each building's and edge's annotations as its person claims: any person claim it carried
 * is replaced, so merging twice, or after the store dropped an old one, never duplicates or keeps a stale claim.
 * A claim of any other kind that exactly equals a stored one (an agent's note, which carries transcriptStep evidence)
 * is the stored one saved with the doc, so it is dropped before the stored ones go back (DSN R2, F1): a design saved
 * and loaded again shows each such note once, and a file that already holds copies of one is left with one.
 */
export function mergeAnnotations(doc: WorldDoc, byItem: Record<string, Claim[]>): WorldDoc {
  const runtimeNames: Record<string, string[]> = { ...doc.runtimeNames }
  const handSet = new Set<string>()
  const merge = <T extends { id: string; claims: Claim[] }>(item: T): T => {
    const own = Object.prototype.hasOwnProperty.call(byItem, item.id) ? byItem[item.id] : []
    // A hand-edited runtime-names claim is the part's service names (an empty one clears them), never a note on its card.
    const edited = own.filter(isRuntime).slice(-1)[0]
    if (edited) {
      handSet.add(item.id)
      const names = namesOfRuntimeText(edited.text)
      if (names.length > 0) runtimeNames[item.id] = names
      else delete runtimeNames[item.id]
    }
    const notes = own.filter((c) => !isRuntime(c))
    const kept = item.claims.filter((c) => !isPerson(c) && !isRuntime(c) && !notes.some((n) => isDeepStrictEqual(n, c)))
    return { ...item, claims: [...kept, ...notes] }
  }
  const buildings = doc.buildings.map(merge)
  const edges = doc.edges.map(merge)
  const base: WorldDoc = { ...doc }
  delete base.runtimeHandSet
  return { ...base, buildings, edges, runtimeNames, ...(handSet.size > 0 ? { runtimeHandSet: [...handSet].sort() } : {}) }
}

const ownKey = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
/** What `byItem` gives the part `id`: its claims, none when it gives the part nothing. */
const claimsOf = (byItem: Record<string, Claim[]>, id: string): Claim[] => (ownKey(byItem, id) ? byItem[id] : [])
/** The part's runtime-names claim in `byItem` (the newest), if any. */
const runtimeOf = (byItem: Record<string, Claim[]>, id: string): Claim | undefined => claimsOf(byItem, id).filter(isRuntime).slice(-1)[0]

/**
 * The doc with one more stored note on the part `itemId`, as a merge with it would show it: a hand-edited runtime-names
 * note sets the part's service names (an empty one clears them); any other note goes on the part's card, unless the part
 * holds that very note already (DSN R4, D4-6: the store adds it once).
 */
export function addClaim(doc: WorldDoc, itemId: string, claim: Claim): WorldDoc {
  if (isRuntime(claim)) {
    const runtimeNames = { ...doc.runtimeNames }
    const names = namesOfRuntimeText(claim.text)
    if (names.length > 0) runtimeNames[itemId] = names
    else delete runtimeNames[itemId]
    return { ...doc, runtimeNames, runtimeHandSet: [...new Set([...(doc.runtimeHandSet ?? []), itemId])].sort() }
  }
  const add = <T extends { id: string; claims: Claim[] }>(item: T): T =>
    (item.id === itemId && !item.claims.some((c) => isDeepStrictEqual(c, claim)) ? { ...item, claims: [...item.claims, claim] } : item)
  return { ...doc, buildings: doc.buildings.map(add), edges: doc.edges.map(add) }
}

/**
 * The stored claims with one more on the part `itemId`, as the store's add keeps them: once (DSN R4, D4-6), and capped.
 * For a design whose stored notes cannot be read back just after one was added (DSN R4, D4-7).
 */
export function withClaim(byItem: Record<string, Claim[]>, itemId: string, claim: Claim): Record<string, Claim[]> {
  const have = claimsOf(byItem, itemId)
  if (have.some((c) => isDeepStrictEqual(c, claim))) return byItem
  return { ...byItem, [itemId]: capClaims([...have, claim]) }
}

/** Each part's claims less a person's, runtime names, and any equal to one `byItem` gives the part. */
const stripClaims = <T extends { id: string; claims: Claim[] }>(item: T, byItem: Record<string, Claim[]>): T => {
  const own = claimsOf(byItem, item.id)
  return { ...item, claims: item.claims.filter((c) => !isPerson(c) && !isRuntime(c) && !own.some((n) => isDeepStrictEqual(n, c))) }
}

/**
 * The design with each part's claims less a person's, runtime names, and any equal to one `byItem` gives the part: the
 * claims a design file of its own holds (DSN R3-2). Its service names stay as they are.
 */
export function stripNotes(doc: WorldDoc, byItem: Record<string, Claim[]>): WorldDoc {
  return { ...doc, buildings: doc.buildings.map((b) => stripClaims(b, byItem)), edges: doc.edges.map((e) => stripClaims(e, byItem)) }
}

/** The design with no claim on any part and no hand-set list: for a key whose notes the store holds (DSN R4, D4-4). */
function withoutNotes(doc: WorldDoc): WorldDoc {
  const none = <T extends { claims: Claim[] }>(item: T): T => ({ ...item, claims: [] })
  const base: WorldDoc = { ...doc, buildings: doc.buildings.map(none), edges: doc.edges.map(none) }
  delete base.runtimeHandSet
  return base
}

/**
 * The design as its file keeps it (DSN R3-2): without the claims the annotation store holds, so the store's cap and a
 * failed store write decide what shows. Each part's person and runtime-names claims are left out (a load puts the stored
 * ones back), as is any other claim equal to one `byItem` gives the part (an agent's note). A claim the store lacks stays,
 * for a load to move into the store.
 * DSN R4 (D4-5): a part's service names are left out only when they equal those of the runtime-names claim `byItem` gives
 * it, which makes them again. Names that differ were set in the design since (a design op), so they stay, an empty list
 * when the design cleared them, and win on a load (mergeDesign). The hand-set list keeps only the parts `byItem` gives no
 * runtime-names claim: a file saved before DSN R3-2 marked them, and a load moves them into the store.
 */
export function withoutStored(doc: WorldDoc, byItem: Record<string, Claim[]>): WorldDoc {
  const runtimeNames: Record<string, string[]> = { ...doc.runtimeNames }
  const mine: Record<string, string[]> = doc.runtimeNames ?? {}
  const stored = new Set<string>()
  const strip = <T extends { id: string; claims: Claim[] }>(item: T): T => {
    const claim = runtimeOf(byItem, item.id)
    if (claim) {
      stored.add(item.id)
      const names = ownKey(mine, item.id) ? mine[item.id] : []
      if (isDeepStrictEqual(names, namesOfRuntimeText(claim.text))) delete runtimeNames[item.id]
      else runtimeNames[item.id] = names
    }
    return stripClaims(item, byItem)
  }
  const base: WorldDoc = { ...doc }
  delete base.runtimeHandSet
  const buildings = doc.buildings.map(strip)
  const edges = doc.edges.map(strip)
  const handSet = (doc.runtimeHandSet ?? []).filter((id) => !stored.has(id))
  return { ...base, buildings, edges, runtimeNames, ...(handSet.length > 0 ? { runtimeHandSet: handSet } : {}) }
}

/**
 * A design file shown with the claims the store holds (DSN R4, D4-5): mergeAnnotations, except that service names the
 * file sets for a part (withoutStored keeps them only when they differ from the stored claim's) are the design's newer
 * edit and win over that claim; an empty list there means the design cleared them, except for a part in `legacyHandSet`,
 * the parts a file from before DSN R3-2 marks hand-set, whose names are older than the store's (NIT R5-4). With
 * `keepFileHandSet`, for a key whose notes have not moved into the store yet, those of its parts the store gives no
 * runtime-names claim stay hand-set, so such a file never loses the mark.
 */
export function mergeDesign(doc: WorldDoc, byItem: Record<string, Claim[]>, legacyHandSet: readonly string[] = [], keepFileHandSet = false): WorldDoc {
  const names: Record<string, string[]> = doc.runtimeNames ?? {}
  const shown: Record<string, Claim[]> = Object.create(null)
  for (const [id, list] of Object.entries(byItem)) {
    const claim = runtimeOf(byItem, id)
    // NIT R5-4: names a file from before DSN R3-2 marks set by hand are older than any claim the store holds for the part.
    const fileWins = claim !== undefined && ownKey(names, id) && !legacyHandSet.includes(id) && !isDeepStrictEqual(names[id], namesOfRuntimeText(claim.text))
    shown[id] = fileWins ? list.filter((c) => !isRuntime(c)) : list
  }
  const merged = mergeAnnotations(doc, shown)
  const runtimeNames: Record<string, string[]> = {}
  for (const [id, list] of Object.entries(merged.runtimeNames)) if (list.length > 0) runtimeNames[id] = list
  const handSet = new Set(merged.runtimeHandSet ?? [])
  if (keepFileHandSet) for (const id of legacyHandSet) if (hasPart(doc, id) && !runtimeOf(byItem, id)) handSet.add(id)
  const out: WorldDoc = { ...merged, runtimeNames }
  delete out.runtimeHandSet
  return { ...out, ...(handSet.size > 0 ? { runtimeHandSet: [...handSet].sort() } : {}) }
}

/**
 * Each part's newest MAX_ANNOTATIONS_PER_ITEM notes in a design file (claims neither a person's nor runtime names), each
 * once (older ones were past the store's cap already), and, for each part the file marks hand-set, the claim that makes its
 * names again (D4-5; added only where the store holds no runtime-names claim): what moving the file's notes adds.
 */
function fileNotes(doc: WorldDoc): Record<string, Claim[]> {
  const all: Record<string, Claim[]> = Object.create(null)
  for (const item of [...doc.buildings, ...doc.edges]) {
    const notes: Claim[] = []
    for (const c of item.claims) if (!isPerson(c) && !isRuntime(c) && !notes.some((n) => isDeepStrictEqual(n, c))) notes.push(c)
    if (notes.length > 0) all[item.id] = notes.slice(-MAX_ANNOTATIONS_PER_ITEM)
  }
  for (const id of doc.runtimeHandSet ?? []) if (hasPart(doc, id)) all[id] = [...claimsOf(all, id), handMade(doc.runtimeNames[id] ?? [])]
  return all
}

/** Whether `id` names a building or an edge of the doc (the parts a person can annotate). */
export const hasPart = (doc: WorldDoc, id: string): boolean => doc.buildings.some((b) => b.id === id) || doc.edges.some((e) => e.id === id)

/**
 * A store whose design worlds (keys `design:<id>`) show the annotations the annotation store holds, and only those: a
 * load merges them in, and a save leaves them out of the file (DSN R3-2), so the store's cap and a failed store write
 * decide what shows. A design file saved before that carried its notes; they move into the store once per key, across
 * restarts, the key marked in the same write (DSN R4, D4-4).
 * DSN R5: every change goes through one transaction (AnnotationStore.transact, `transact` here). A load only reads (T3): a
 * key not marked yet shows, in memory, the store's notes and what the move would add, and writes nothing, and a store that
 * cannot be read fails the load (T4), whether the key is marked or not. The move happens in a write's transaction, computed
 * there from the design and the store as they are then, and is skipped once the key is marked (T2); a design a newer
 * Termpolis saved is never moved (D4-3). Once a key is marked the file's own hand-set mark is ignored (R5-4).
 * Other keys pass through (a project world is recompiled, which merges them).
 */
export function withAnnotations(store: WorldStore, annotations: Pick<AnnotationStore, 'listStrict' | 'addMissing' | 'transact'>): WorldStore {
  const isDesign = (key: string): boolean => key.startsWith('design:')
  const loadMerged = async (key: string, forWrite: boolean): Promise<WorldDoc | null> => {
    const doc = await (forWrite && store.loadForWrite ? store.loadForWrite(key) : store.load(key))
    if (!doc || !isDesign(key)) return doc
    const { byItem, migrated } = await annotations.listStrict(key, fileNotes(doc))
    return mergeDesign(withoutNotes(doc), byItem, doc.runtimeHandSet, !migrated)
  }
  /** The move of a design's notes into the store (D4-4), inside a write's transaction: once per key, never for a newer
   *  Termpolis's design, and from the design and store as they are now. */
  const migrate = async (key: string): Promise<void> => {
    const doc = await (store.loadForWrite ?? store.load)(key)
    if (!doc || doc.savedByNewer) return
    if ((await annotations.listStrict(key)).migrated) return
    await annotations.addMissing(key, fileNotes(doc))
  }
  const transact = <T>(key: string, work: (tx: StoreTx) => Promise<T>): Promise<T> =>
    annotations.transact(key, async (tx) => {
      if (isDesign(key)) await migrate(key)
      return work(tx)
    })
  return {
    ...store,
    load: (key) => loadMerged(key, false),
    loadForWrite: (key) => loadMerged(key, true),
    transact,
    save: async (doc, opts) => {
      if (!isDesign(doc.projectKey)) return store.save(doc, opts)
      const key = doc.projectKey
      await transact(key, async (tx) => {
        const { byItem } = await annotations.listStrict(key)
        const out = withoutStored(withoutNotes(doc), byItem)
        await store.save(out, { ...opts, fence: tx.fence })
        await tx.track()
        // A design key saves a copy: the newer-world mark the store puts on it belongs to the caller's doc too.
        if (out.savedByNewer) doc.savedByNewer = true
      })
    }
  }
}

/** The claim a person's hand-set service names are stored as (ipc.ts makes the same one). */
const handMade = (names: string[]): Claim => ({ text: runtimeText(names), state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] })
