// Lumopolis folder walk (world host, Node only): the files of a folder git does not know, for a world of a plain
// folder. Breadth first and sorted, so a capped walk keeps the folder's top levels; links are never followed (a link
// can point anywhere on the computer); the dependency, build and version-control folders below are never entered.
import type { Dirent } from 'node:fs'
import { readdir as fsReaddir } from 'node:fs/promises'
import { join } from 'node:path'

/** The most files a walk lists. Past it the world says it shows only the first ones. */
export const WALK_FILE_CAP = 20_000
/** The most folder entries a walk reads, kept or not, so a folder of millions of entries still ends. */
export const WALK_ENTRY_LIMIT = 200_000
/** Folders a walk never enters: version control, dependencies, virtual environments, build and test output. */
export const WALK_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn',
  'node_modules', 'bower_components', 'vendor',
  '.venv', 'venv', '__pycache__',
  'dist', 'out', 'build', 'target', '.next', 'coverage'
])

export interface WalkResult {
  /** Folder-relative, `/` separated, in walk order. */
  files: string[]
  /** The walk stopped at the file cap or the entry limit: the folder holds more than `files`. */
  capped: boolean
}

export interface WalkOptions {
  /** Whether a file (folder-relative) is listed. Refused files do not count toward the cap. */
  keep: (rel: string) => boolean
  cap?: number
  entryLimit?: number
  /** Reads one folder (default: node's readdir with file types). */
  readdir?: (dir: string) => Promise<Dirent[]>
}

// Names in one folder are unique, so two entries never compare equal.
const byName = (a: Dirent, z: Dirent): number => (a.name < z.name ? -1 : 1)

export async function walkFolder(root: string, opts: WalkOptions): Promise<WalkResult> {
  const cap = opts.cap ?? WALK_FILE_CAP
  const limit = opts.entryLimit ?? WALK_ENTRY_LIMIT
  const readdir = opts.readdir ?? ((d: string) => fsReaddir(d, { withFileTypes: true }))
  const files: string[] = []
  const queue: string[] = ['']
  let seen = 0
  for (let q = 0; q < queue.length; q++) {
    const rel = queue[q]
    // An unreadable folder (no permission, gone since) lists nothing; the walk goes on.
    const entries = await readdir(rel === '' ? root : join(root, rel)).catch((): Dirent[] => [])
    for (const ent of entries.sort(byName)) {
      if (++seen > limit) return { files, capped: true }
      const path = rel === '' ? ent.name : `${rel}/${ent.name}`
      // A link is neither a directory nor a file here (readdir does not follow it), so it is skipped.
      if (ent.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(ent.name)) queue.push(path)
      } else if (ent.isFile() && opts.keep(path)) {
        if (files.length === cap) return { files, capped: true }
        files.push(path)
      }
    }
  }
  return { files, capped: false }
}
