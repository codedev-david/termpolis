// Lumopolis world store: one JSON file per project under `<dir>/world/`. Writes are atomic (a
// unique temp file, then rename) so a crash never leaves a half-written world. A read or rename that
// fails because another program holds the file for a moment (Defender, the indexer) is tried again.
// Loads migrate an older schema version, validate, and drop a bad claim or tour step rather than the
// whole world; a file that still fails is moved aside to a timestamped `.bad` and treated as absent (one that
// cannot be moved aside is refused, by loads and saves alike, so nothing writes over it).
// A world written by a newer Termpolis is opened read-only: it is never moved aside or written over,
// and what this version compiles for that project is kept in memory only (marked savedByNewer).
// The labelling cache lives here too (`<dir>/world/label-cache/`, pruned of old entries), so the store
// stays the one place Lumopolis persists anything, as does each world's stage cache
// (`<world file>.stages.json`, see stageCache.ts), which lets a recompile re-read only the files that changed.
import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import type { WorldDoc } from '../../shared/world/types'
import { isNewerWorld, migrateWorld, validateWorld, WORLD_VERSION, type DroppedItem } from '../../shared/world/validate'
import { upgradeSavedWords } from './kindWords'
import { isStageCache, type StageCache } from './stageCache'
import { copyAside, moveAside, retryLocked, sleepMs, type Sleep } from './storeFiles'

/** `<key>.json` with every character outside `[A-Za-z0-9._-]` replaced by `_`. */
export function worldFileName(projectKey: string): string {
  const name = projectKey.replace(/[^A-Za-z0-9._-]/g, '_')
  if (name === '' || name === '.' || name === '..') throw new Error(`invalid project key: ${JSON.stringify(projectKey)}`)
  return `${name}.json`
}

/** Model replies keyed by their prompt hash. Best effort: a read problem is a miss, a write problem is dropped. */
export interface LabelCache {
  get(hash: string): Promise<string | null>
  set(hash: string, value: string): Promise<void>
}

export interface WorldStore {
  /** The stored world (marked savedByNewer when a newer Termpolis wrote it); null when there is none or it was broken
   *  and is now moved aside. Rejects with WorldReadError when the file cannot be read, backed up or moved aside. */
  load(projectKey: string): Promise<WorldDoc | null>
  /** Stores a world. Over a newer Termpolis's world it writes nothing and marks the doc savedByNewer: a compile's world
   *  (`compiled`) is kept in memory, what a load then shows, so the world is compiled once per run (sign-off #16); any
   *  other save is refused and leaves that copy as it was (DSN R4 D4-2, DSN R5 T6). A file this store
   *  has not loaded is loaded first, so a save rejects (WorldReadError) wherever that load would. */
  save(doc: WorldDoc, opts?: WorldSaveOptions): Promise<void>
  /** DSN R5 (T3): load for a write about to happen. A design's load only reads; this one may also make the backup or the
   *  move-aside a save would make first. Elsewhere it is load. */
  loadForWrite?(projectKey: string): Promise<WorldDoc | null>
  /** DSN R5: runs `work` as the one transaction on the world's notes, claims and names (withAnnotations). */
  transact?<T>(projectKey: string, work: (tx: StoreTx) => Promise<T>): Promise<T>
  labelCache: LabelCache
  /** The project's stage cache; null when there is none or it has the wrong shape. Never rejects. */
  loadStages?(projectKey: string): Promise<StageCache | null>
  /** Stores the project's stage cache (atomic write). Best effort: never rejects. */
  saveStages?(projectKey: string, cache: StageCache): Promise<void>
}

/** How a world is saved: `compiled` for the world a compile made (WorldStore.save), and `fence`, asked just before the
 *  rename (after the look for a newer world), which rejects to stop the write: a transaction's check that it still holds
 *  its lock and the files it read (DSN R5, T1). */
export interface WorldSaveOptions {
  compiled?: boolean
  fence?: () => Promise<void>
}

/** DSN R5: a transaction's hold on the files it read. `fence` rejects (AnnotationFenceLost) once its lock was lost or a file
 *  changed under it; `track` takes the design's world file as the transaction just wrote it. */
export interface StoreTx {
  fence(): Promise<void>
  track(): Promise<void>
}

export interface WorldStoreDeps {
  /** The store's record of which world files hold a newer version's world (a seam for tests); a new map when not given. */
  newerOnDisk?: Map<string, boolean>
  sleep?: Sleep
  now?: () => number
  readFile?: typeof fsp.readFile
  rename?: typeof fsp.rename
  /** A file's size and modified time (default fs.promises.stat). */
  stat?: (file: string) => Promise<FileSeen>
  /** Writes a line to the app log. Default console.warn, which main mirrors into the app log. */
  log?: (message: string) => void
}

/** A world file's size and modified time, as this store last read or wrote it. */
export interface FileSeen {
  size: number
  mtimeMs: number
}

/** What a stored world that cannot be read says: the raw error (its code and full path) goes to the log only. */
export const WORLD_READ_FAILED = "Lumopolis couldn't read this world's saved map. Try again in a moment."

/** PENDING SIGN-OFF (M5): what the list of recent worlds that cannot be read says; the raw error goes to the log only. */
export const SOURCES_READ_FAILED_MESSAGE = "Lumopolis couldn't read your recent worlds. Try again in a moment."

/** Which stored file could not be read: a world, its annotations, or the list of worlds. */
export type WorldReadCode = 'WORLD_READ_FAILED' | 'ANNOTATIONS_READ_FAILED' | 'SOURCES_READ_FAILED'

/** A stored file that exists but cannot be read. Its message is fixed and carries no path; its code says which file, and
 *  the list of worlds has words of its own (M5). */
export class WorldReadError extends Error {
  readonly code: WorldReadCode
  constructor(code: WorldReadCode = 'WORLD_READ_FAILED') {
    super(code === 'SOURCES_READ_FAILED' ? SOURCES_READ_FAILED_MESSAGE : WORLD_READ_FAILED)
    this.name = 'WorldReadError'
    this.code = code
  }
}

/** PENDING SIGN-OFF by David (WP3 round 2): what the window shows for a file operation that failed in the world host (a
 *  world, notes or cache that could not be written). The raw error names folders on this computer, so it goes to the log only. */
export const WORLD_SAVE_FAILED = "Lumopolis couldn't save this world's map. Try again in a moment."

/** PENDING SIGN-OFF by David (the M8 line, the same text as the pane's SAVED_BY_NEWER note): what refusing to change a
 *  world a newer Termpolis saved answers. */
export const WORLD_SAVED_BY_NEWER = 'This world was saved by a newer Termpolis, so this version shows a copy and leaves the saved one as it is. Update Termpolis to save changes to it.'

/** A change this version will not make to a world a newer version saved (annotating it would rewrite its notes file). */
export class WorldSavedByNewerError extends Error {
  readonly code = 'WORLD_SAVED_BY_NEWER'
  constructor() {
    super(WORLD_SAVED_BY_NEWER)
    this.name = 'WorldSavedByNewerError'
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
/** A label cache entry unread for this long is removed. */
export const LABEL_MAX_AGE_MS = 90 * DAY_MS
/** At most this many label cache entries are kept: the most recently used. */
export const LABEL_MAX_ENTRIES = 20_000
/** A hit refreshes its entry's time only when it is older than this, so most hits cost no write. */
const LABEL_TOUCH_AFTER_MS = DAY_MS
/** A temp file left by a write that never finished is removed once it is this old. */
const TMP_MAX_AGE_MS = DAY_MS
const STAT_BATCH = 64

/** Unique temp name next to `target`, renamed over it once written. */
const tmpFor = (target: string): string => `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`

/** Item labels for the log: kind and place only, never what the item said. */
const droppedText = (dropped: DroppedItem[]): string => dropped.map((d) => `${d.kind} #${d.index}`).join(', ')

/** Whether a file looked up now is as it was last seen: false when either is unknown. */
const same = (now: FileSeen | null, last: FileSeen | undefined): boolean =>
  now !== null && last !== undefined && now.size === last.size && now.mtimeMs === last.mtimeMs

/** A doc as the disk holds it: the in-memory-only marks taken off. */
const forDisk = (doc: WorldDoc): WorldDoc => {
  if (doc.savedByNewer === undefined) return doc
  const { savedByNewer: _newer, ...rest } = doc
  return rest
}

/**
 * Removes label cache entries unused for LABEL_MAX_AGE_MS, then the least recently used beyond `maxEntries`, and
 * temp files older than a day. Best effort: an entry it cannot read or remove is left, and it never rejects.
 */
export async function pruneLabelCache(cacheDir: string, now: number, maxEntries = LABEL_MAX_ENTRIES): Promise<number> {
  let names: string[]
  try {
    names = await fsp.readdir(cacheDir)
  } catch {
    return 0
  }
  const entries: { name: string; at: number }[] = []
  const gone: string[] = []
  for (let i = 0; i < names.length; i += STAT_BATCH) {
    await Promise.all(names.slice(i, i + STAT_BATCH).map(async (name) => {
      const entry = name.endsWith('.txt')
      if (!entry && !name.endsWith('.tmp')) return
      const st = await fsp.stat(join(cacheDir, name)).catch(() => null)
      if (!st || !st.isFile()) return
      if (!entry) {
        if (now - st.mtimeMs > TMP_MAX_AGE_MS) gone.push(name)
      } else if (now - st.mtimeMs > LABEL_MAX_AGE_MS) gone.push(name)
      else entries.push({ name, at: st.mtimeMs })
    }))
  }
  entries.sort((a, b) => b.at - a.at)
  for (const extra of entries.slice(maxEntries)) gone.push(extra.name)
  let removed = 0
  for (let i = 0; i < gone.length; i += STAT_BATCH) {
    const results = await Promise.allSettled(gone.slice(i, i + STAT_BATCH).map((name) => fsp.rm(join(cacheDir, name), { force: true })))
    removed += results.filter((r) => r.status === 'fulfilled').length
  }
  return removed
}

export function createWorldStore(dir: string, deps: WorldStoreDeps = {}): WorldStore {
  const sleep = deps.sleep ?? sleepMs
  const now = deps.now ?? Date.now
  const read = deps.readFile ?? fsp.readFile
  const rename = deps.rename ?? fsp.rename
  const statOf = deps.stat ?? fsp.stat
  const log = deps.log ?? ((message: string) => console.warn(message))
  const folder = join(dir, 'world')
  const cacheDir = join(folder, 'label-cache')
  // Whatever the key looks like, the file name is its sha256: fixed length, nothing to escape.
  const cacheFile = (hash: string): string => join(cacheDir, `${createHash('sha256').update(hash).digest('hex')}.txt`)
  const stagesFile = (projectKey: string): string => join(folder, `${worldFileName(projectKey)}.stages.json`)
  /** Per world file name: true when the disk holds a newer version's world, false when it holds one of ours or none.
   *  A name is here only after a load that ended well, set once its backup or move-aside is done; a save of a name not
   *  here loads it first, so no save writes over a file this store could not read, could not back up, or could not move
   *  aside. */
  const newerOnDisk = deps.newerOnDisk ?? new Map<string, boolean>()
  /** WP3 round 3 (M1): per world file name, the load running now. Loads of one name run one after another (a second
   *  load of a broken file finds it moved aside, never races the first one's rename), and a save waits for the running
   *  load's outcome before it looks at newerOnDisk. */
  const loading = new Map<string, Promise<unknown>>()
  const ignore = (): void => undefined
  /** Per world file name of a newer version's world: what this version compiled or saved for it, kept in memory only. */
  const shadow = new Map<string, WorldDoc>()
  /** DSN R2, F4: per world file name, the file's size and modified time as this store last read or wrote it. A save reads
   *  the file again before its rename only when they changed (or cannot be looked up), so a recompile reads nothing more. */
  const seen = new Map<string, FileSeen>()
  /** The file's size and modified time; null when they cannot be looked up. */
  const look = async (file: string): Promise<FileSeen | null> => {
    try {
      const st = await statOf(file)
      return { size: st.size, mtimeMs: st.mtimeMs }
    } catch {
      return null
    }
  }
  let pruning: Promise<unknown> | null = null

  const readText = (file: string): Promise<string> => retryLocked(() => read(file, 'utf8'), sleep)

  /** Writes `text` to `target` through a temp file, removing the temp file when the write fails. With `beforeRename`,
   *  the temp file is put in place only when it answers true once the temp file (its path given) is written, and then
   *  `ready`, asked with no wait between it and the rename, answers true too; false removes it instead. Both are asked
   *  again before each try of a rename that waits out a held file (DSN R4, D4-1). */
  async function writeAtomic(target: string, text: string, beforeRename?: (tmp: string) => Promise<boolean>, ready?: () => boolean): Promise<void> {
    const tmp = tmpFor(target)
    try {
      await fsp.writeFile(tmp, text, 'utf8')
      const placed = await retryLocked(async () => {
        if (beforeRename && !(await beforeRename(tmp))) return false
        if (ready && !ready()) return false
        await rename(tmp, target)
        return true
      }, sleep)
      if (!placed) await fsp.rm(tmp, { force: true })
    } catch (err) {
      await fsp.rm(tmp, { force: true })
      throw err
    }
  }

  /** The lenient view of a stored world, and whether it left items out; null when it is broken past that. */
  const checked = (doc: unknown): { doc: WorldDoc; dropped: boolean } | null => {
    const result = validateWorld(doc, { dropBadItems: true })
    if (!result.ok) return null
    if (result.dropped) log(`[world store] a stored world loaded without its bad items: ${droppedText(result.dropped)}`)
    return { doc: result.doc, dropped: result.dropped !== undefined }
  }

  /** Throws the fixed, path-free WorldReadError after logging `why`, and forgets what the disk held, so the next
   *  save looks again instead of writing. */
  const refuse = (name: string, why: string): never => {
    newerOnDisk.delete(name)
    log(`[world store] the stored world ${name} ${why}`)
    throw new WorldReadError()
  }

  async function load(projectKey: string, beforeSave = false): Promise<WorldDoc | null> {
    const name = worldFileName(projectKey)
    const before = loading.get(name)
    const run = (async () => {
      if (before) await before.catch(ignore)
      return loadNow(name, beforeSave, projectKey.startsWith('design:'))
    })()
    loading.set(name, run)
    try {
      return await run
    } finally {
      if (loading.get(name) === run) loading.delete(name)
    }
  }

  async function loadNow(name: string, beforeSave: boolean, design: boolean): Promise<WorldDoc | null> {
    const file = join(folder, name)
    // DSN R5 (T3, T5): a design's load that is not a save's only reads. A backup or a move-aside is a write's, so a design
    // that leaves items out is handed out unmarked (the save's own load backs it up first), and one that does not read is
    // reported, never moved aside.
    const readOnly = design && !beforeSave
    // Looked up before the read: a file changed in between is read again by the next save, never taken as unchanged.
    const at = await look(file)
    let text: string
    try {
      text = await readText(file)
    } catch (err) {
      seen.delete(name)
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') refuse(name, `could not be read${beforeSave ? ' before a save' : ''}: ${String(err)}`)
      newerOnDisk.set(name, false)
      shadow.delete(name)
      return null
    }
    const parsed = parseOrUndefined(text)
    if (isNewerWorld(parsed)) {
      // Not taken as read (DSN R3-1): a save that looks at the file while this load runs reads it again, never going by
      // this look and writing over the newer file.
      seen.delete(name)
      // Never moved aside, never written over: this version shows its own copy, or reads what it can of the newer one.
      newerOnDisk.set(name, true)
      const own = shadow.get(name)
      if (own) return { ...upgradeSavedWords(structuredClone(own)), savedByNewer: true }
      // No backup is needed for what this view leaves out: a newer version's file is never written by this one.
      const view = checked({ ...(parsed as Record<string, unknown>), version: WORLD_VERSION })
      return view ? { ...upgradeSavedWords(view.doc), savedByNewer: true } : null
    }
    if (at) seen.set(name, at)
    else seen.delete(name)
    // Safe to save over only once the backup or the move-aside below is done (M1).
    const ours = (): void => { newerOnDisk.set(name, false); shadow.delete(name) }
    const view = checked(migrateWorld(parsed))
    if (view) {
      // A later save writes the doc without the items left out, so the file as it is goes into the backups first,
      // untouched (once per distinct content). Without that backup the world is not handed out to be saved over.
      if (view.dropped && readOnly) {
        newerOnDisk.delete(name)
        return upgradeSavedWords(view.doc)
      }
      if (view.dropped && !(await copyAside(file, { now, sleep }))) refuse(name, 'left items out and could not be backed up first')
      ours()
      // A word an older compiler gave wrongly (TCP for a message port) is brought up to date as the world loads.
      return upgradeSavedWords(view.doc)
    }
    // Kept for inspection. A broken file that cannot be moved aside is not read as absent: a compile would then save
    // over it. Until it can be moved aside (each load and save tries again) or reads, loads and saves are refused.
    if (readOnly) refuse(name, 'does not read; a save moves it aside')
    if (!(await moveAside(file, { now, rename, sleep }))) refuse(name, 'does not read and could not be moved aside, so nothing is saved over it')
    ours()
    return null
  }

  return {
    load: (projectKey) => load(projectKey),
    loadForWrite: (projectKey) => load(projectKey, true),

    async save(doc, opts) {
      const name = worldFileName(doc.projectKey)
      const clean = forDisk(doc)
      // A load running now decides first (M1): its outcome is what this save goes by, or, refused, this save's own load.
      await loading.get(name)?.catch(ignore)
      if (!newerOnDisk.has(name)) await load(doc.projectKey, true)
      if (newerOnDisk.get(name) === true) {
        // A compile's world is what a load shows until the next restart (#16). Any other save is refused (DSN R4, D4-2).
        // DSN R5 (T6): a refused save leaves that copy as it was.
        if (opts?.compiled === true) shadow.set(name, structuredClone(clean))
        // The caller's doc is marked as well, so a compile that hands it on says what load would.
        doc.savedByNewer = true
        return
      }
      await fsp.mkdir(folder, { recursive: true })
      const file = join(folder, name)
      // DSN Round 1, item 4: another Termpolis, a newer one, may have saved this world since this store last read or wrote
      // it. Once the temp copy is written, just before the rename, the file is looked at again: read only when its size or
      // modified time changed since then (DSN R2, F4). A newer world found there is kept as it is, and this copy is not
      // kept in memory either (DSN R2, F2): a change refused there never shows later in the session. A compile's copy kept
      // before stays as it was (DSN R5, T6). Then the caller's fence, if any, is asked (DSN R5, T1). DSN R4 (D4-1): that look comes before every try of the rename,
      // a try after a held file's wait included, and a load that found a newer file meanwhile (during the temp copy's
      // look, the file's, its read, or the wait) refuses the save too, asked last with no wait before the rename.
      // Two gaps are accepted. A newer file of the same size and modified time as this store last saw is not read, so it
      // is written over: one Termpolis runs per profile (its single-instance lock), so only a later version could write
      // it, and it would have to match both (R3-4). And a newer version writing between that last look and the rename,
      // which no look of this version can see.
      let wrote = null as FileSeen | null
      const refused = (): false => {
        newerOnDisk.set(name, true)
        doc.savedByNewer = true
        wrote = null
        return false
      }
      await writeAtomic(file, JSON.stringify(clean), async (tmp) => {
        // The rename keeps the temp copy's size and modified time: what the file will have once it is in place.
        wrote = await look(tmp)
        if (same(await look(file), seen.get(name))) {
          await opts?.fence?.()
          return true
        }
        let text: string | null = null
        try {
          text = await readText(file)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') refuse(name, `could not be read before a save: ${String(err)}`)
        }
        if (text !== null && isNewerWorld(parseOrUndefined(text))) return refused()
        await opts?.fence?.()
        return true
      }, () => newerOnDisk.get(name) !== true || refused())
      if (wrote) seen.set(name, wrote)
      else seen.delete(name)
    },

    async loadStages(projectKey) {
      try {
        const parsed: unknown = JSON.parse(await readText(stagesFile(projectKey)))
        return isStageCache(parsed) ? parsed : null
      } catch {
        return null
      }
    },

    async saveStages(projectKey, cache) {
      try {
        // A newer version's world keeps its own stage cache too.
        if (newerOnDisk.get(worldFileName(projectKey)) === true) return
        const file = stagesFile(projectKey)
        await fsp.mkdir(folder, { recursive: true })
        await writeAtomic(file, JSON.stringify(cache))
      } catch {
        // a lost stage cache only costs a full compile next time
      }
    },

    labelCache: {
      async get(hash) {
        const file = cacheFile(hash)
        let text: string
        try {
          text = await read(file, 'utf8')
        } catch {
          return null
        }
        // A hit marks the entry recently used, so pruning removes the entries nobody reads.
        try {
          const at = now()
          if (at - (await fsp.stat(file)).mtimeMs > LABEL_TOUCH_AFTER_MS) await fsp.utimes(file, at / 1000, at / 1000)
        } catch {
          // an entry whose time cannot be refreshed may be pruned sooner, which costs one model call
        }
        return text
      },
      async set(hash, value) {
        try {
          await fsp.mkdir(cacheDir, { recursive: true })
          await writeAtomic(cacheFile(hash), value)
        } catch {
          // an unwritable cache only costs a repeat model call
        }
        // Once per run, in the background: nobody waits on pruning.
        if (!pruning) pruning = pruneLabelCache(cacheDir, now())
      }
    }
  }
}

function parseOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
