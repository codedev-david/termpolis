// Lumopolis annotations: what a person confirmed in the pane, kept apart from the compiled world so a
// recompile never loses it. One JSON file per world under `<dir>/world/annotations/`, named by the
// sha256 of the world key (any key is safe as a file name), written atomically with async fs under a lock file
// that holds across processes. A file that does not parse reads as empty and the next add overwrites it.
import { createHash } from 'node:crypto'
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Claim, ClaimState, Evidence, EvidenceKind, WorldDoc } from '../../shared/world/types'
import { isRuntimeText, namesOfRuntimeText, runtimeText } from '../../shared/world/runtimeNames'
import { createKeyedLock } from './keyedLock'
import type { WorldStore } from './worldStore'

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
  /** Adds one annotation: text capped at MAX_ANNOTATION_TEXT, evidence at MAX_ANNOTATION_EVIDENCE, the oldest dropped past MAX_ANNOTATIONS_PER_ITEM. */
  add(key: string, itemId: string, claim: Claim): Promise<void>
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

/** How often a writer looks again at another's lock on an annotation file, and the age past which a lock is taken over (its
 *  holder died mid-write: every write under it is a read, a small write and a rename). */
export const ANNOTATION_LOCK_RETRY_MS = 25
export const ANNOTATION_LOCK_STALE_MS = 5_000
const pause = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })
const codeOf = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? '')

/**
 * WPA fix round 2 (R-M2): the annotation store's lock on one file, across processes. The world host adds annotations through
 * its own store and main adopts older keys' files, so the in-process keyed lock alone cannot keep them apart: each takes this
 * one too, a `<file>.lock` made with O_EXCL. A lock older than ANNOTATION_LOCK_STALE_MS is taken over. When no lock file can be
 * made at all (a read-only folder), the work runs without one, as every write did before, and fails on its own if it must.
 */
async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lockFile = `${file}.lock`
  let held = false
  for (;;) {
    try {
      await (await open(lockFile, 'wx')).close()
      held = true
      break
    } catch (err) {
      // EPERM: Windows answers it for a lock file another process is deleting this moment.
      if (codeOf(err) !== 'EEXIST' && codeOf(err) !== 'EPERM') break
    }
    try {
      if (Date.now() - (await stat(lockFile)).mtimeMs >= ANNOTATION_LOCK_STALE_MS) { await rm(lockFile, { force: true }); continue }
    } catch { continue } // released meanwhile: try again at once
    await pause(ANNOTATION_LOCK_RETRY_MS)
  }
  try {
    return await work()
  } finally {
    if (held) await rm(lockFile, { force: true })
  }
}

/** Write `text` to `target` whole or not at all: a temp file beside it, then a rename. The temp file never outlives a failure. */
async function writeAtomic(target: string, text: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/** One file's claims, or null when it is missing or does not parse. */
async function readClaims(file: string): Promise<Record<string, Claim[]> | null> {
  try {
    return cleanFile(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return null
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
 */
export async function adoptAnnotationAliases(dir: string, key: string, aliasKeys: readonly string[]): Promise<string[]> {
  const others = aliasKeys.filter((k, i) => k && k !== key && aliasKeys.indexOf(k) === i)
  if (!key || others.length === 0) return []
  const target = annotationsFileOf(dir, key)
  const exists = (f: string): Promise<boolean> => access(f).then(() => true, () => false)
  if (await exists(target)) return [] // the common case, every open after the first: no lock taken
  const found: Array<[string, Record<string, Claim[]>]> = []
  for (const old of others) {
    const claims = await readClaims(annotationsFileOf(dir, old))
    if (claims && Object.keys(claims).length > 0) found.push([old, claims])
  }
  if (found.length === 0) return []
  try {
    return await withFileLock(target, async () => {
      if (await exists(target)) return [] // the world host saved the new key's own file while we read
      const merged: Record<string, Claim[]> = Object.create(null)
      for (const [, claims] of found) {
        for (const [id, list] of Object.entries(claims)) {
          const have = merged[id] ?? []
          const seen = new Set(have.map((c) => JSON.stringify(c)))
          merged[id] = [...have, ...list.filter((c) => !seen.has(JSON.stringify(c)))]
        }
      }
      for (const id of Object.keys(merged)) merged[id] = capClaims(merged[id])
      await writeAtomic(target, JSON.stringify(merged))
      return found.map(([old]) => old)
    })
  } catch {
    return [] // the file could not be written: every older key's file stays as it was
  }
}

export function createAnnotationStore(dir: string): AnnotationStore {
  const folder = annotationsFolder(dir)
  const lock = createKeyedLock()
  const fileOf = (key: string): string => annotationsFileOf(dir, key)

  const read = async (key: string): Promise<Record<string, Claim[]>> => {
    let text: string
    try {
      text = await readFile(fileOf(key), 'utf8')
    } catch {
      return cleanFile(undefined)
    }
    try {
      return cleanFile(JSON.parse(text))
    } catch {
      return cleanFile(undefined)
    }
  }

  return {
    list: (key) => read(key),
    add: (key, itemId, claim) =>
      lock(key, async () => {
        const clean = cleanClaim(claim)
        if (clean === null) throw new Error('annotation needs text, a state and evidence')
        await mkdir(folder, { recursive: true })
        // The file lock as well as the keyed one: an adoption in main writes this file too (adoptAnnotationAliases).
        await withFileLock(fileOf(key), async () => {
          const all = await read(key)
          all[itemId] = capClaims([...(all[itemId] ?? []), clean])
          await writeAtomic(fileOf(key), JSON.stringify(all))
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
    save: async (doc) => store.save(await merged(doc))
  }
}
