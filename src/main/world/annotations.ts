// Lumopolis annotations: what a person confirmed in the pane, kept apart from the compiled world so a
// recompile never loses it. One JSON file per world under `<dir>/world/annotations/`, named by the
// sha256 of the world key (any key is safe as a file name), written atomically with async fs under a lock file
// that holds across processes. A display read shows nothing when the file cannot be read; a writer never writes after a
// failed read: a held file is read again, any other read error refuses the add (a fixed, path-free WorldReadError), and a
// file that does not parse is moved aside to a numbered .bad backup before the add starts it fresh.
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { Claim, ClaimState, Evidence, EvidenceKind, WorldDoc } from '../../shared/world/types'
import { isRuntimeText, namesOfRuntimeText, runtimeText } from '../../shared/world/runtimeNames'
import { createKeyedLock } from './keyedLock'
import { copyClaims } from './idMigration'
import { copyAside, moveAside, retryLocked, type Sleep } from './storeFiles'
import { WorldReadError, type WorldStore } from './worldStore'

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
   *  Rejects with WorldReadError (code ANNOTATIONS_READ_FAILED) when the stored annotations cannot be read, writing nothing. */
  add(key: string, itemId: string, claim: Claim): Promise<void>
  /**
   * Copies each renamed item's annotations (old id -> new id) to its new id, after any it already has, a claim held under
   * both kept once and the item capped as an add caps it (idMigration.ts). The old ids keep theirs (WP5 fix I2). Writes only
   * when a claim was not yet under its new id, and rejects when that write fails.
   */
  copyRenamed(key: string, renames: Record<string, string>): Promise<void>
}

const STATES = new Set<string>(['proposed', 'observed', 'inferred', 'verified'])
export const EVIDENCE_KINDS = new Set<string>(['file', 'symbol', 'test', 'transcriptStep', 'memory', 'commit', 'trace', 'metric', 'log', 'deploy', 'person'])
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A well-formed, capped claim from whatever was given (or read back from disk), else null. */
function cleanClaim(v: unknown): Claim | null {
  if (!isRec(v) || typeof v.text !== 'string' || !STATES.has(v.state as string) || !Array.isArray(v.evidence)) return null
  const evidence: Evidence[] = []
  for (const e of v.evidence) {
    if (evidence.length === MAX_ANNOTATION_EVIDENCE) break
    if (isRec(e) && EVIDENCE_KINDS.has(e.kind as string) && typeof e.ref === 'string') {
      evidence.push(typeof e.excerpt === 'string' ? { kind: e.kind as EvidenceKind, ref: capped(e.ref, MAX_EVIDENCE_REF), excerpt: capped(e.excerpt, MAX_EVIDENCE_EXCERPT) } : { kind: e.kind as EvidenceKind, ref: capped(e.ref, MAX_EVIDENCE_REF) })
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
 *  waiting and goes on without the lock, so a world open or an add always ends. */
export const ANNOTATION_LOCK_RETRY_MS = 25
export const ANNOTATION_LOCK_RETRY_MAX_MS = 200
export const ANNOTATION_LOCK_STALE_MS = 5_000
export const ANNOTATION_LOCK_DEADLINE_MS = 2_000
const pause = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })
const codeOf = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? '')

/**
 * WPA fix round 2 (R-M2): the annotation store's lock on one file, across processes. The world host adds annotations through
 * its own store and main adopts older keys' files, so the in-process keyed lock alone cannot keep them apart: each takes this
 * one too, a `<file>.lock` made with O_EXCL (`wx`) that holds a nonce of its own.
 * Fix round 3 (R2-I1): it always ends. Only EEXIST is another holder: it is looked at again after a pause that doubles each
 * time, and past ANNOTATION_LOCK_DEADLINE_MS the work goes on without the lock. Any other error making the lock (EPERM and
 * EACCES are what Windows answers for a folder it will not let us write in), and a stale lock that cannot be removed, mean no
 * lock can be had here: the work runs without one, as every write did before, and fails on its own if it must.
 * Fix round 3 (R2-M2): the holder removes the lock only while it still holds its nonce, so a holder slower than
 * ANNOTATION_LOCK_STALE_MS never removes the lock of the one that broke its own.
 * Final minors (R3-M2): two writers that break the same stale lock both try again, since the one whose delete finds it gone
 * (ENOENT) lost only the race to delete it. A lock made whose nonce cannot be written (a full disk) is ours and empty: it is
 * removed, so nobody waits on it, and the take is tried once more; a second such failure means no lock here.
 */
export async function withAnnotationFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lockFile = `${file}.lock`
  const nonce = `${process.pid}:${randomUUID()}`
  const deadline = Date.now() + ANNOTATION_LOCK_DEADLINE_MS
  let wait = ANNOTATION_LOCK_RETRY_MS
  let held = false
  let unwritten = false
  for (;;) {
    let made: FileHandle | null = null
    try {
      made = await open(lockFile, 'wx')
    } catch (err) {
      if (codeOf(err) !== 'EEXIST') break // no lock can be made here
    }
    if (made) {
      let wrote = false
      try { await made.writeFile(nonce, 'utf8'); wrote = true } catch { /* a full disk: made, but empty */ }
      try { await made.close() } catch { /* the lock file stands, written or not */ }
      if (wrote) { held = true; break }
      // Made but not written: the empty lock is ours. Remove it either way, so nobody waits on it.
      let removed = true
      try { await rm(lockFile, { force: true }) } catch { removed = false }
      if (unwritten || !removed) break // the second time, or it cannot be removed: no lock here
      unwritten = true
    } else {
      let age = -1
      try { age = Date.now() - (await stat(lockFile)).mtimeMs } catch { /* let go meanwhile: try again after the pause */ }
      if (age >= ANNOTATION_LOCK_STALE_MS) {
        try { await rm(lockFile) } catch (err) {
          if (codeOf(err) !== 'ENOENT') break // a stale lock that cannot be removed: no lock can be had here
        } // ENOENT: another writer broke it first; try again
      }
    }
    if (Date.now() >= deadline) break
    await pause(wait)
    wait = Math.min(wait * 2, ANNOTATION_LOCK_RETRY_MAX_MS)
  }
  try {
    return await work()
  } finally {
    if (held) {
      try {
        if ((await readFile(lockFile, 'utf8')) === nonce) await rm(lockFile, { force: true })
      } catch { /* gone already: broken by another and let go */ }
    }
  }
}

/** The rename errors a virus scanner or the indexer holding the file causes on Windows, for a moment. A rename refused with
 *  one is tried again after 100 ms x the attempt, ANNOTATION_RENAME_ATTEMPTS times in all (about a second of pauses, as
 *  graceful-fs does and as gitSource's renameWithRetry does for a world's sources); any other error throws at once. */
export const ANNOTATION_RENAME_RETRY_CODES: readonly string[] = ['EPERM', 'EACCES', 'EBUSY']
const ANNOTATION_RENAME_ATTEMPTS = 5
export const ANNOTATION_RENAME_RETRY_TOTAL_MS = 100 * ((ANNOTATION_RENAME_ATTEMPTS - 1) * ANNOTATION_RENAME_ATTEMPTS) / 2

async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (err) {
      if (attempt >= ANNOTATION_RENAME_ATTEMPTS || !ANNOTATION_RENAME_RETRY_CODES.includes(codeOf(err))) throw err
      await pause(100 * attempt)
    }
  }
}

/** Write `text` to `target` whole or not at all: a temp file beside it, then a rename (tried again while Windows refuses it
 *  for a moment). The temp file never outlives a failure. */
async function writeAtomic(target: string, text: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, text, 'utf8')
    await renameRetrying(tmp, target)
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
const loses = (cleaned: Record<string, Claim[]>, parsed: unknown): boolean => JSON.stringify(cleaned) !== JSON.stringify(parsed)

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

/** The older keys still to adopt, or null when nothing is pending (no marker, or one that cannot be read now). */
async function readPending(file: string): Promise<string[] | null> {
  try {
    const keys: unknown = JSON.parse(await readFile(file, 'utf8'))
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return null
  }
}

/** Records the older keys still to adopt, or removes the record when there are none. Best effort. */
async function keepPending(file: string, keys: string[]): Promise<void> {
  try {
    if (keys.length > 0) await writeAtomic(file, JSON.stringify(keys))
    else await rm(file, { force: true })
  } catch {
    // a record that cannot be written loses only the retry of a file that could not be read
  }
}

/**
 * WPA fix M2: a world key is its root's project key, and WPA gave a few spellings of a folder (Git Bash `/c/...`, Cygwin, WSL
 * `/mnt/c/...`, doubled separators) the canonical key instead of their own. A normal Windows root keeps its key, so this is a
 * no-op for it. For a root whose key changed, the annotations a person made under its older keys follow it to the new key the
 * first time the world opens. Fix round 2 (R-M2): it runs under the annotation store's lock on the new key's file (so an add
 * in the world host cannot replace the copy, nor the copy an add); every older key that has a file is merged in, in the order
 * given, a claim found under two keys kept once, each item capped as an add caps it; the file is written whole (a temp file,
 * then a rename). It never overwrites a file the new key already has (that file is the newer one), never deletes an older
 * one, and never throws. Resolves with the older keys it merged, or an empty list.
 * WP3 round 2: an older file that exists but cannot be read (held by another program through the retries) is not given up
 * on. Its key is recorded beside the new key's file (ADOPT_PENDING_SUFFIX), and every later open tries it again, even once
 * the new key has a file of its own: its claims then go in before the new key's own (which are newer), nothing of the new
 * key's file is lost, and the record goes once nothing is left to try. A new key's file that cannot be read keeps the record.
 */
export async function adoptAnnotationAliases(dir: string, key: string, aliasKeys: readonly string[], deps: { sleep?: Sleep; now?: () => number } = {}): Promise<string[]> {
  const others = aliasKeys.filter((k, i) => k && k !== key && aliasKeys.indexOf(k) === i)
  if (!key || others.length === 0) return []
  const sleep = deps.sleep ?? pause
  const now = deps.now ?? Date.now
  const target = annotationsFileOf(dir, key)
  const pendingFile = `${target}${ADOPT_PENDING_SUFFIX}`
  const exists = (f: string): Promise<boolean> => access(f).then(() => true, () => false)
  const had = await exists(target)
  let wanted = others
  if (had) {
    // The common case, every open after the first: one look for a record, no lock taken.
    const pending = await readPending(pendingFile)
    if (!pending) return []
    wanted = others.filter((k) => pending.includes(k))
  }
  const found: Array<[string, Record<string, Claim[]>]> = []
  const unread: string[] = []
  for (const old of wanted) {
    const claims = await readAlias(annotationsFileOf(dir, old), sleep)
    if (claims === 'unread') unread.push(old)
    else if (claims !== 'none') found.push([old, claims])
  }
  if (!had && found.length === 0 && unread.length === 0) return []
  try {
    return await withAnnotationFileLock(target, async () => {
      let own: Record<string, Claim[]> | null = null
      if (await exists(target)) {
        if (!had) {
          // the world host saved the new key's own file while we read: it is the newer one, left as it is
          await keepPending(pendingFile, unread)
          return []
        }
        own = await readOwn(target, sleep, now)
        if (!own) return [] // the record stays, so a later open tries again (a held-back merge never loses the new key's notes)
      }
      if (found.length > 0) {
        const merged: Record<string, Claim[]> = Object.create(null)
        for (const claims of [...found.map(([, c]) => c), ...(own ? [own] : [])]) {
          for (const [id, list] of Object.entries(claims)) {
            const have = merged[id] ?? []
            const seen = new Set(have.map((c) => JSON.stringify(c)))
            merged[id] = [...have, ...list.filter((c) => !seen.has(JSON.stringify(c)))]
          }
        }
        for (const id of Object.keys(merged)) merged[id] = capClaims(merged[id])
        await writeAtomic(target, JSON.stringify(merged))
      }
      await keepPending(pendingFile, unread)
      return found.map(([old]) => old)
    })
  } catch {
    return [] // the file could not be written: every older key's file stays as it was
  }
}

/** Seams for tests: the file read, the wait between reads of a held file, and the clock that stamps a backup. */
export interface AnnotationStoreDeps {
  readFile?: (file: string, encoding: 'utf8') => Promise<string>
  sleep?: Sleep
  now?: () => number
}

export function createAnnotationStore(dir: string, deps: AnnotationStoreDeps = {}): AnnotationStore {
  const folder = annotationsFolder(dir)
  const lock = createKeyedLock()
  const fileOf = (key: string): string => annotationsFileOf(dir, key)
  const readText = deps.readFile ?? readFile
  const sleep = deps.sleep ?? pause
  const now = deps.now ?? Date.now

  /** For display: what can be read, nothing when the file is missing, unreadable or broken. */
  const read = async (key: string): Promise<Record<string, Claim[]>> => {
    try {
      return cleanFile(JSON.parse(await retryLocked(() => readText(fileOf(key), 'utf8'), sleep)))
    } catch {
      return cleanFile(undefined)
    }
  }

  /** For a writer: the stored annotations, empty only for a missing file or one just moved aside; otherwise it throws. */
  const readForWrite = async (key: string): Promise<Record<string, Claim[]>> => {
    const file = fileOf(key)
    let text: string
    try {
      text = await retryLocked(() => readText(file, 'utf8'), sleep)
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return cleanFile(undefined)
      console.warn(`[world annotations] a world's annotations could not be read, so nothing was added: ${String(err)}`)
      throw new WorldReadError('ANNOTATIONS_READ_FAILED')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Kept for inspection, never written over: without the backup the add is refused.
      if (await moveAside(file, { now, sleep })) return cleanFile(undefined)
      console.warn("[world annotations] a world's annotations do not parse and could not be moved aside, so nothing was added")
      throw new WorldReadError('ANNOTATIONS_READ_FAILED')
    }
    const cleaned = cleanFile(parsed)
    // N1: the write after this keeps only what this version reads. A file holding more (an evidence kind or claim state it
    // does not know, a field or shape of a later version, past a cap) goes into the backups first, untouched (once per
    // distinct content); without that backup the add is refused. A file this version wrote reads back the same.
    if (loses(cleaned, parsed) && !(await copyAside(file, { now, sleep }))) {
      console.warn("[world annotations] a world's annotations hold notes this version cannot read and could not be backed up, so nothing was added")
      throw new WorldReadError('ANNOTATIONS_READ_FAILED')
    }
    return cleaned
  }

  return {
    list: (key) => read(key),
    add: (key, itemId, claim) =>
      lock(key, async () => {
        const clean = cleanClaim(claim)
        if (clean === null) throw new Error('annotation needs text, a state and evidence')
        await mkdir(folder, { recursive: true })
        // The file lock as well as the keyed one: an adoption in main writes this file too (adoptAnnotationAliases).
        await withAnnotationFileLock(fileOf(key), async () => {
          const all = await readForWrite(key)
          all[itemId] = capClaims([...(all[itemId] ?? []), clean])
          await writeAtomic(fileOf(key), JSON.stringify(all))
        })
      }),
    copyRenamed: (key, renames) =>
      lock(key, async () => {
        const map = new Map(Object.entries(renames))
        const pending = (all: Record<string, Claim[]>): Record<string, Claim[]> | null => {
          const next = copyClaims(all, map)
          return next === all ? null : next
        }
        if (pending(await read(key)) === null) return // the common case: nothing to copy, no lock file taken
        await withAnnotationFileLock(fileOf(key), async () => {
          const next = pending(await read(key))
          if (next === null) return
          for (const id of Object.keys(next)) next[id] = capClaims(next[id])
          await writeAtomic(fileOf(key), JSON.stringify(next))
        })
      })
  }
}

/** True when a claim was added by a person (only annotations carry person evidence). */
const isPerson = (c: Claim): boolean => c.evidence.some((e) => e.kind === 'person')

/**
 * The doc with each building's and edge's annotations as its person claims: any person claim it carried
 * is replaced, so merging twice, or after the store dropped an old one, never duplicates or keeps a stale claim.
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
    return { ...item, claims: [...item.claims.filter((c) => !isPerson(c) && !isRuntime(c)), ...own.filter((c) => !isRuntime(c))] }
  }
  const buildings = doc.buildings.map(merge)
  const edges = doc.edges.map(merge)
  const base: WorldDoc = { ...doc }
  delete base.runtimeHandSet
  return { ...base, buildings, edges, runtimeNames, ...(handSet.size > 0 ? { runtimeHandSet: [...handSet].sort() } : {}) }
}

/** Whether `id` names a building or an edge of the doc (the parts a person can annotate). */
export const hasPart = (doc: WorldDoc, id: string): boolean => doc.buildings.some((b) => b.id === id) || doc.edges.some((e) => e.id === id)

/**
 * A store whose design worlds (keys `design:<id>`) always carry their annotations: they are merged on
 * load and on save, so a confirmation made while a designer run was saving a stale copy is still
 * shown, whatever order the writes landed in. Merging is idempotent. Other keys pass through (a
 * project world is recompiled, which merges them).
 */
export function withAnnotations(store: WorldStore, annotations: Pick<AnnotationStore, 'list'>): WorldStore {
  const merged = async (doc: WorldDoc): Promise<WorldDoc> =>
    doc.projectKey.startsWith('design:') ? mergeAnnotations(doc, await annotations.list(doc.projectKey)) : doc
  return {
    ...store,
    load: async (key) => {
      const doc = await store.load(key)
      return doc ? merged(doc) : null
    },
    save: async (doc) => {
      const out = await merged(doc)
      await store.save(out)
      // A design key saves a merged copy: the newer-world mark the store puts on it belongs to the caller's doc too.
      if (out.savedByNewer) doc.savedByNewer = true
    }
  }
}
