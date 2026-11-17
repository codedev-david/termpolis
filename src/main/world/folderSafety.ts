// Lumopolis folder safety (main process and world host, Node only, no Electron):
//  - which folders Build it may write into and watch (never a whole drive, the home folder, or
//    Termpolis's own data),
//  - whether a folder is empty without listing all of it,
//  - and a reader that refuses a file whose real path leaves its folder, used for cloned repositories,
//    so a symlink committed to a hostile repository can never lead indexing to a file elsewhere.
import * as fsp from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

/** A folder as a comparable key: resolved, and lowercased where the file system ignores case. */
export function folderKey(p: string, isWindows: boolean = process.platform === 'win32'): string {
  const r = resolve(p)
  return isWindows ? r.toLowerCase() : r
}

/** Whether `child` is `parent` itself or somewhere inside it. */
export function isInside(parent: string, child: string, isWindows: boolean = process.platform === 'win32'): boolean {
  const rel = relative(folderKey(parent, isWindows), folderKey(child, isWindows))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Whether `root` is a Lumopolis clone: a folder under `<userData>/world/repos`. */
export function isCloneRoot(userData: string, root: string, isWindows?: boolean): boolean {
  const repos = join(userData, 'world', 'repos')
  return isInside(repos, root, isWindows) && folderKey(repos, isWindows) !== folderKey(root, isWindows)
}

export const FORBIDDEN_FOLDER = 'Choose a project folder, not your home folder, a whole drive or Termpolis’s own data.'

/**
 * Why `root` may not be a Build it or open-folder target, or null when it may: a drive or file-system
 * root, the home folder or a folder above it, or anything inside Termpolis's data folder.
 */
export function forbiddenFolder(root: string, opts: { home: string; userData?: string; isWindows?: boolean }): string | null {
  const key = folderKey(root, opts.isWindows)
  if (parse(key).root === key) return FORBIDDEN_FOLDER
  if (isInside(root, opts.home, opts.isWindows)) return FORBIDDEN_FOLDER
  if (opts.userData && isInside(opts.userData, root, opts.isWindows)) return FORBIDDEN_FOLDER
  return null
}

/** The slice of a `fs.promises` Dir isFolderEmpty uses. */
export interface DirLike {
  read(): Promise<unknown | null>
  close(): Promise<void>
}

/** Whether a folder has no entries; reads one entry at most, so a huge folder costs the same as an empty one. */
export async function isFolderEmpty(root: string, open: (p: string) => Promise<DirLike> = (p) => fsp.opendir(p)): Promise<boolean> {
  const dir = await open(root)
  try {
    return (await dir.read()) === null
  } finally {
    await dir.close().catch(() => undefined)
  }
}

/**
 * Wraps a file reader so it only reads files whose real path (symlinks resolved) stays inside `root`'s
 * real path; anything else rejects, which every caller already treats as an unreadable file. The file
 * is read through its resolved path.
 */
export function confinedReader<T>(root: string, read: (p: string) => Promise<T>, real: (p: string) => Promise<string> = (p) => fsp.realpath(p)): (p: string) => Promise<T> {
  let rootReal: Promise<string> | undefined
  return async (p) => {
    rootReal ??= real(root)
    const [r, f] = await Promise.all([rootReal, real(p)])
    if (!isInside(r, f)) throw new Error('outside the folder')
    return read(f)
  }
}
