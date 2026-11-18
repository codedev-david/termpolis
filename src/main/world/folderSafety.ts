// Lumopolis folder safety (main process and world host, Node only, no Electron):
//  - which folders Build it may write into and watch (never a whole drive, the home folder, or
//    Termpolis's own data),
//  - the same check on a folder's real path, so a junction, symlink or 8.3 short name never disguises one,
//  - whether a folder is empty without listing all of it, and whether it looks like a project,
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

/**
 * forbiddenFolder on the folder's real path too (symlinks, junctions and 8.3 short names resolved), with
 * the home and data folders resolved the same way: a link to the home folder is the home folder. A path
 * that cannot be resolved is judged as written.
 */
export async function forbiddenFolderReal(
  root: string,
  opts: { home: string; userData?: string; isWindows?: boolean },
  real: (p: string) => Promise<string> = (p) => fsp.realpath(p)
): Promise<string | null> {
  const lexical = forbiddenFolder(root, opts)
  if (lexical) return lexical
  const resolved = (p: string): Promise<string> => real(p).catch(() => p)
  const [r, home, userData] = await Promise.all([resolved(root), resolved(opts.home), opts.userData === undefined ? undefined : resolved(opts.userData)])
  return forbiddenFolder(r, opts) ?? forbiddenFolder(r, { home, userData, isWindows: opts.isWindows })
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

/** The slice of a `fs.promises` Dir isProjectFolder uses. */
export interface NamedDirLike {
  read(): Promise<{ name: string } | null>
  close(): Promise<void>
}

/** Files or folders whose presence marks a project root. */
const PROJECT_MARKERS = new Set([
  '.git', '.hg', '.svn', 'package.json', 'deno.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile',
  'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'Gemfile', 'composer.json',
  'mix.exs', 'pubspec.yaml', 'Package.swift', 'CMakeLists.txt', 'Makefile', 'meson.build', 'global.json', 'Directory.Build.props'
])
const PROJECT_EXT_RE = /\.(sln|slnx|csproj|fsproj|vbproj|vcxproj|xcodeproj|xcworkspace)$/i
/** How many entries isProjectFolder reads before it gives up: a project root names its marker early enough. */
export const MAX_PROJECT_SCAN = 2000

/**
 * Whether `root` looks like a project: one of its first entries is a project marker (.git, package.json,
 * a .sln, ...). A folder that cannot be listed is not one.
 */
export async function isProjectFolder(
  root: string,
  open: (p: string) => Promise<NamedDirLike> = (p) => fsp.opendir(p),
  limit: number = MAX_PROJECT_SCAN
): Promise<boolean> {
  let dir: NamedDirLike
  try {
    dir = await open(root)
  } catch {
    return false
  }
  try {
    for (let i = 0; i < limit; i++) {
      const e = await dir.read()
      if (e === null) return false
      if (PROJECT_MARKERS.has(e.name) || PROJECT_EXT_RE.test(e.name)) return true
    }
    return false
  } catch {
    return false
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
