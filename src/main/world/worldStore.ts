// Lumopolis world store: one JSON file per project under `<dir>/world/`. Writes are atomic (a
// unique temp file, then rename) so a crash never leaves a half-written world; loads validate,
// and a file that fails to parse or validate is moved aside to `.bad` and treated as absent.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorldDoc } from '../../shared/world/types'
import { validateWorld } from '../../shared/world/validate'

/** `<key>.json` with every character outside `[A-Za-z0-9._-]` replaced by `_`. */
export function worldFileName(projectKey: string): string {
  const name = projectKey.replace(/[^A-Za-z0-9._-]/g, '_')
  if (name === '' || name === '.' || name === '..') throw new Error(`invalid project key: ${JSON.stringify(projectKey)}`)
  return `${name}.json`
}

export interface WorldStore {
  load(projectKey: string): Promise<WorldDoc | null>
  save(doc: WorldDoc): Promise<void>
}

export function createWorldStore(dir: string): WorldStore {
  const folder = join(dir, 'world')

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
      const target = join(folder, name)
      const tmp = join(folder, `${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
      try {
        await writeFile(tmp, JSON.stringify(doc), 'utf8')
        await rename(tmp, target)
      } catch (err) {
        await rm(tmp, { force: true })
        throw err
      }
    }
  }
}
