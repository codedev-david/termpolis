// Lumopolis world store: one JSON file per project under `<dir>/world/`. Writes are atomic (a
// unique temp file, then rename) so a crash never leaves a half-written world; loads validate,
// and a file that fails to parse or validate is moved aside to `.bad` and treated as absent.
// The labelling cache lives here too (`<dir>/world/label-cache/`), so the store stays the one
// place Lumopolis persists anything, as does each world's stage cache (`<world file>.stages.json`,
// see stageCache.ts), which lets a recompile re-read only the files that changed.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorldDoc } from '../../shared/world/types'
import { validateWorld } from '../../shared/world/validate'
import { isStageCache, type StageCache } from './stageCache'

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
  load(projectKey: string): Promise<WorldDoc | null>
  save(doc: WorldDoc): Promise<void>
  labelCache: LabelCache
  /** The project's stage cache; null when there is none or it has the wrong shape. Never rejects. */
  loadStages?(projectKey: string): Promise<StageCache | null>
  /** Stores the project's stage cache (atomic write). Best effort: never rejects. */
  saveStages?(projectKey: string, cache: StageCache): Promise<void>
}

/** Unique temp name next to `target`, renamed over it once written. */
const tmpFor = (target: string): string => `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`

/** Writes `text` to `target` through a temp file, removing the temp file when the write fails. */
async function writeAtomic(target: string, text: string): Promise<void> {
  const tmp = tmpFor(target)
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

export function createWorldStore(dir: string): WorldStore {
  const folder = join(dir, 'world')
  const cacheDir = join(folder, 'label-cache')
  // Whatever the key looks like, the file name is its sha256: fixed length, nothing to escape.
  const cacheFile = (hash: string): string => join(cacheDir, `${createHash('sha256').update(hash).digest('hex')}.txt`)
  const stagesFile = (projectKey: string): string => join(folder, `${worldFileName(projectKey)}.stages.json`)

  return {
    async load(projectKey) {
      const file = join(folder, worldFileName(projectKey))
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      const result = validateWorld(parsed)
      if (result.ok) return result.doc
      // Keep the broken file for inspection; a failed backup still reads as absent.
      await rename(file, `${file}.bad`).catch(() => undefined)
      return null
    },

    async save(doc) {
      const name = worldFileName(doc.projectKey)
      await mkdir(folder, { recursive: true })
      await writeAtomic(join(folder, name), JSON.stringify(doc))
    },

    async loadStages(projectKey) {
      try {
        const parsed: unknown = JSON.parse(await readFile(stagesFile(projectKey), 'utf8'))
        return isStageCache(parsed) ? parsed : null
      } catch {
        return null
      }
    },

    async saveStages(projectKey, cache) {
      try {
        const file = stagesFile(projectKey)
        await mkdir(folder, { recursive: true })
        await writeAtomic(file, JSON.stringify(cache))
      } catch {
        // a lost stage cache only costs a full compile next time
      }
    },

    labelCache: {
      async get(hash) {
        try {
          return await readFile(cacheFile(hash), 'utf8')
        } catch {
          return null
        }
      },
      async set(hash, value) {
        try {
          await mkdir(cacheDir, { recursive: true })
          await writeAtomic(cacheFile(hash), value)
        } catch {
          // an unwritable cache only costs a repeat model call
        }
      }
    }
  }
}
