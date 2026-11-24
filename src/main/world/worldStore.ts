// Lumopolis world store: one JSON file per project under `<dir>/world/`. Writes are atomic (a
// unique temp file, then rename) so a crash never leaves a half-written world. A read or rename that
// fails because another program holds the file for a moment (Defender, the indexer) is tried again.
// Loads migrate an older schema version, validate, and drop a bad claim or tour step rather than the
// whole world; a file that still fails is moved aside to a timestamped `.bad` and treated as absent.
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
import { isStageCache, type StageCache } from './stageCache'
import { moveAside, retryLocked, sleepMs, type Sleep } from './storeFiles'

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
  /** The stored world (marked savedByNewer when a newer Termpolis wrote it); null when there is none or it is broken. */
  load(projectKey: string): Promise<WorldDoc | null>
  /** Stores a world. Over a newer Termpolis's world it keeps the doc in memory only and marks it savedByNewer. */
  save(doc: WorldDoc): Promise<void>
  labelCache: LabelCache
  /** The project's stage cache; null when there is none or it has the wrong shape. Never rejects. */
  loadStages?(projectKey: string): Promise<StageCache | null>
  /** Stores the project's stage cache (atomic write). Best effort: never rejects. */
  saveStages?(projectKey: string, cache: StageCache): Promise<void>
}

export interface WorldStoreDeps {
  sleep?: Sleep
  now?: () => number
  readFile?: typeof fsp.readFile
  rename?: typeof fsp.rename
  /** Writes a line to the app log. Default console.warn, which main mirrors into the app log. */
  log?: (message: string) => void
}

/** What a stored world that cannot be read says: the raw error (its code and full path) goes to the log only. */
export const WORLD_READ_FAILED = "Lumopolis couldn't read this world's saved map. Try again in a moment."

/** A stored world that exists but cannot be read. Its message is fixed and carries no path. */
export class WorldReadError extends Error {
  readonly code = 'WORLD_READ_FAILED'
  constructor() {
    super(WORLD_READ_FAILED)
    this.name = 'WorldReadError'
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
  const log = deps.log ?? ((message: string) => console.warn(message))
  const folder = join(dir, 'world')
  const cacheDir = join(folder, 'label-cache')
  // Whatever the key looks like, the file name is its sha256: fixed length, nothing to escape.
  const cacheFile = (hash: string): string => join(cacheDir, `${createHash('sha256').update(hash).digest('hex')}.txt`)
  const stagesFile = (projectKey: string): string => join(folder, `${worldFileName(projectKey)}.stages.json`)
  /** Per world file name: true when the disk holds a newer version's world, false when it holds one of ours or none. */
  const newerOnDisk = new Map<string, boolean>()
  /** Per world file name of a newer version's world: what this version compiled or saved for it, kept in memory only. */
  const shadow = new Map<string, WorldDoc>()
  let pruning: Promise<unknown> | null = null

  const readText = (file: string): Promise<string> => retryLocked(() => read(file, 'utf8'), sleep)

  /** Writes `text` to `target` through a temp file, removing the temp file when the write fails. */
  async function writeAtomic(target: string, text: string): Promise<void> {
    const tmp = tmpFor(target)
    try {
      await fsp.writeFile(tmp, text, 'utf8')
      await retryLocked(() => rename(tmp, target), sleep)
    } catch (err) {
      await fsp.rm(tmp, { force: true })
      throw err
    }
  }

  /** Whether the disk holds a newer version's world for `name`: remembered from the last load, else read once.
   *  A read that fails for any reason but a missing file is not remembered and counts as no. */
  async function isNewerOnDisk(name: string): Promise<boolean> {
    const known = newerOnDisk.get(name)
    if (known !== undefined) return known
    let text: string
    try {
      text = await readText(join(folder, name))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') newerOnDisk.set(name, false)
      return false
    }
    const newer = isNewerWorld(parseOrUndefined(text))
    newerOnDisk.set(name, newer)
    return newer
  }

  const checked = (doc: unknown): WorldDoc | null => {
    const result = validateWorld(doc, { dropBadItems: true })
    if (!result.ok) return null
    if (result.dropped) log(`[world store] a stored world loaded without its bad items: ${droppedText(result.dropped)}`)
    return result.doc
  }

  return {
    async load(projectKey) {
      const name = worldFileName(projectKey)
      const file = join(folder, name)
      let text: string
      try {
        text = await readText(file)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log(`[world store] the stored world ${name} could not be read: ${String(err)}`)
          throw new WorldReadError()
        }
        newerOnDisk.set(name, false)
        shadow.delete(name)
        return null
      }
      const parsed = parseOrUndefined(text)
      if (isNewerWorld(parsed)) {
        // Never moved aside, never written over: this version shows its own copy, or reads what it can of the newer one.
        newerOnDisk.set(name, true)
        const own = shadow.get(name)
        if (own) return { ...structuredClone(own), savedByNewer: true }
        const doc = checked({ ...(parsed as Record<string, unknown>), version: WORLD_VERSION })
        return doc ? { ...doc, savedByNewer: true } : null
      }
      newerOnDisk.set(name, false)
      shadow.delete(name)
      const doc = checked(migrateWorld(parsed))
      if (doc) return doc
      // Keep the broken file for inspection; a failed backup still reads as absent.
      await moveAside(file, { now, rename })
      return null
    },

    async save(doc) {
      const name = worldFileName(doc.projectKey)
      const clean = forDisk(doc)
      if (await isNewerOnDisk(name)) {
        shadow.set(name, structuredClone(clean))
        // The caller's doc is marked as well, so a compile that hands it on says what load would.
        doc.savedByNewer = true
        return
      }
      await fsp.mkdir(folder, { recursive: true })
      await writeAtomic(join(folder, name), JSON.stringify(clean))
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
