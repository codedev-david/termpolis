// Lumopolis folder walk (world host, Node only): the files of a folder git does not know, for a world of a plain
// folder. Breadth first and sorted, so a capped walk keeps the folder's top levels; links are never followed (a link
// can point anywhere on the computer); the skip folders (repoFileList.ts SKIP_DIRS: version control, dependencies,
// build output) and virtual environments (a folder holding pyvenv.cfg) are never entered; what the folder's own
// .gitignore names (rootIgnore.ts, handed in as `ignored`) is left out. Each folder is read as a stream (opendir), so
// the entry limit holds inside one folder of millions of entries too.
import type { Dirent } from 'node:fs'
import { opendir as fsOpendir } from 'node:fs/promises'
import { join } from 'node:path'
import { MAP_FILE_CAP, SKIP_DIRS, VENV_MARKER } from '../repoFileList'

/** The most files a walk lists (the map's one cap). Past it the world says it shows only the first ones. */
export const WALK_FILE_CAP = MAP_FILE_CAP
/** The most folder entries a walk reads, kept or not, so a folder of millions of entries still ends. */
export const WALK_ENTRY_LIMIT = 200_000
/** Folders a walk never enters: the map's skip folders. */
export const WALK_SKIP_DIRS: ReadonlySet<string> = SKIP_DIRS

export interface WalkResult {
  /** Folder-relative, `/` separated, in walk order. */
  files: string[]
  /** The walk stopped at the file cap or the entry limit: the folder holds more than `files`. */
  capped: boolean
  /** Files keep accepts whose names are not valid UTF-8 (they decode with U+FFFD), so no read finds them. */
  unreadable: string[]
}

export interface WalkOptions {
  /** Whether a file (folder-relative) is listed. Refused files do not count toward the cap. */
  keep: (rel: string) => boolean
  /** Whether a folder or file (folder-relative) is left out: the folder's own .gitignore. */
  ignored?: (rel: string, isDir: boolean) => boolean
  cap?: number
  entryLimit?: number
  /** Opens one folder for reading entry by entry (default: node's opendir). */
  opendir?: (dir: string) => Promise<AsyncIterable<Dirent>>
}

// Names in one folder are unique, so two entries never compare equal.
const byName = (a: Dirent, z: Dirent): number => (a.name < z.name ? -1 : 1)

export async function walkFolder(root: string, opts: WalkOptions): Promise<WalkResult> {
  const cap = opts.cap ?? WALK_FILE_CAP
  const limit = opts.entryLimit ?? WALK_ENTRY_LIMIT
  const open = opts.opendir ?? ((d: string) => fsOpendir(d))
  const ignored = opts.ignored ?? ((): boolean => false)
  const files: string[] = []
  const unreadable: string[] = []
  const queue: string[] = ['']
  let seen = 0
  for (let q = 0; q < queue.length; q++) {
    const rel = queue[q]
    const entries: Dirent[] = []
    let cut = false
    try {
      // Breaking out of the loop closes the folder.
      for await (const ent of await open(rel === '' ? root : join(root, rel))) {
        if (++seen > limit) {
          cut = true
          break
        }
        entries.push(ent)
      }
    } catch {
      // An unreadable folder (no permission, gone since) lists what was read of it, if anything; the walk goes on.
    }
    // A virtual environment below the top is left out whole, whatever it is called.
    if (rel !== '' && entries.some((ent) => ent.name === VENV_MARKER && ent.isFile())) continue
    for (const ent of entries.sort(byName)) {
      const path = rel === '' ? ent.name : `${rel}/${ent.name}`
      // A link is neither a directory nor a file here (opendir does not follow it), so it is skipped.
      if (ent.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(ent.name) && !ent.name.includes('�') && !ignored(path, true)) queue.push(path)
      } else if (ent.isFile() && !ignored(path, false) && opts.keep(path)) {
        if (ent.name.includes('�')) unreadable.push(path)
        else if (files.length === cap) return { files, capped: true, unreadable }
        else files.push(path)
      }
    }
    if (cut) return { files, capped: true, unreadable }
  }
  return { files, capped: false, unreadable }
}
