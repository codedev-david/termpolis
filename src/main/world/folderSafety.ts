// Lumopolis folder safety (main process and world host, Node only, no Electron):
//  - which folders Build it may write into and watch (never a whole drive, the home folder, or
//    Termpolis's own data),
//  - the same check on a folder's real path, so a junction, symlink or 8.3 short name never disguises one,
//  - whether a folder is empty without listing all of it, and whether it looks like a project,
//  - and a reader that refuses a file whose real path leaves its folder, used for cloned repositories,
//    so a symlink committed to a hostile repository can never lead indexing to a file elsewhere.
import * as fsp from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { foldsCase } from '../../shared/caseFolding'
import { normalizeShellPath } from '../../shared/cwdPath'

/** Whether this platform's file systems ignore case (WP5 X03: the one rule project keys, the code index and the watchers use).
 *  The `isWindows` options below name this: true folds case. */
const FOLDS_CASE = foldsCase()

/** A folder as a comparable key: resolved, and lowercased where the file system ignores case (Windows and macOS). */
export function folderKey(p: string, isWindows: boolean = FOLDS_CASE): string {
  const r = resolve(p)
  return isWindows ? r.toLowerCase() : r
}

/** Whether `child` is `parent` itself or somewhere inside it. */
export function isInside(parent: string, child: string, isWindows: boolean = FOLDS_CASE): boolean {
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
 * is read through its resolved path, and its real path is taken again once the read is done: a folder on
 * the path swapped for a link out of `root` between the check and the read (Codex r4 M3, Opus R3-n1) moves
 * the file, and the read is refused. What is left is a swap there and back while the read runs; a text
 * read closes that too (confinedTextReader).
 */
export function confinedReader<T>(root: string, read: (p: string) => Promise<T>, real: (p: string) => Promise<string> = (p) => fsp.realpath(p)): (p: string) => Promise<T> {
  let rootReal: Promise<string> | undefined
  return async (p) => {
    rootReal ??= real(root)
    const [r, f] = await Promise.all([rootReal, real(p)])
    if (!isInside(r, f)) throw new Error('outside the folder')
    const out = await read(f)
    if ((await real(p)) !== f) throw new Error('the file moved while it was read')
    return out
  }
}

/** A device and file id, as a stat with `bigint: true` gives them. */
export interface FileIdent { dev: bigint | number; ino: bigint | number }
/** The open file confinedTextReader reads from. */
export interface ConfinedHandle { stat(): Promise<FileIdent>; readText(): Promise<string>; close(): Promise<void> }
/** The file system confinedTextReader uses (tests inject one). */
export interface ConfinedFs {
  real(p: string): Promise<string>
  open(p: string): Promise<ConfinedHandle>
  /** The path's own id: a link at the end of it is not followed. */
  lstat(p: string): Promise<FileIdent>
}
/** The file system confinedTextReader reads with unless handed another (exported for its tests). */
export const realConfinedFs: ConfinedFs = {
  real: (p) => fsp.realpath(p),
  open: async (p) => {
    // Read-only, and never waiting for a writer: a FIFO opens at once (POSIX; Windows has no such flag). With no writer
    // its read is no error but empty text (end of file at once); with a writer that has sent nothing yet it fails with
    // EAGAIN instead of waiting.
    const h = await fsp.open(p, fsp.constants.O_RDONLY | (fsp.constants.O_NONBLOCK ?? 0))
    return { stat: () => h.stat({ bigint: true }), readText: () => h.readFile('utf8'), close: () => h.close() }
  },
  lstat: (p) => fsp.lstat(p, { bigint: true }),
}

/**
 * A text reader confined as confinedReader is, that reads the file it checked (Codex r4 M3, Opus R3-n1): it opens the
 * file first, then takes the real path of the name it opened and checks that, and reads only if the file at that real
 * path is the one it holds open (same device and file id; lstat, so a last part swapped for a link is not followed).
 * A folder swapped for a link out of `root` before the open moves the real path out, or, swapped back since, leaves
 * a different file at it; one swapped after the open does not change the file held. A real path outside `root` is
 * refused before the open too, so a committed link to something outside is never opened.
 *
 * Residual (no portable way to ask an open file its own path): a swap out before the open, back before the real path
 * is taken, and out again before the id is compared, three swaps inside one read, each landing in a window of
 * microseconds. A file system with no file ids (FAT: every id 0) leaves the id check blind, and one swap there and back
 * around the open goes through. A hard link has one id wherever it is: git never makes one.
 */
export function confinedTextReader(root: string, fs: ConfinedFs = realConfinedFs): (p: string) => Promise<string> {
  let rootReal: Promise<string> | undefined
  return async (p) => {
    rootReal ??= fs.real(root)
    const r = await rootReal
    if (!isInside(r, await fs.real(p))) throw new Error('outside the folder')
    const h = await fs.open(p)
    try {
      const [f, held] = await Promise.all([fs.real(p), h.stat()])
      if (!isInside(r, f)) throw new Error('outside the folder')
      const named = await fs.lstat(f)
      if (BigInt(named.dev) !== BigInt(held.dev) || BigInt(named.ino) !== BigInt(held.ino)) throw new Error('the file moved while it was opened')
      return await h.readText()
    } finally {
      await h.close().catch(() => undefined)
    }
  }
}

/**
 * The folder a sweep of `root` is confined to (Opus R3-m3, R3-n2): the Lumopolis clone `root` is, or is inside, as
 * `<userData>/world/repos/<name>`, or null when it is no clone. Judged on the spelling first (a Git Bash `/c/...` read
 * as its drive path), then on the real paths of both, so a junction or symlink to a clone, or a clone reached through
 * a linked userData (git's toplevel has its links resolved), is a clone too. It is the clone's own folder, not
 * `root`: a root that is a link inside a clone (`repos/c/sub -> /elsewhere`) is confined to the clone, and reads
 * nothing elsewhere. Never rejects.
 */
export async function cloneConfinement(
  userData: string,
  root: string,
  opts: { isWindows?: boolean; platform?: NodeJS.Platform; real?: (p: string) => Promise<string> } = {}
): Promise<string | null> {
  const real = opts.real ?? ((p: string) => fsp.realpath(p))
  const repos = join(userData, 'world', 'repos')
  const spelled = normalizeShellPath(root, { platform: opts.platform ?? process.platform }) ?? root
  const lexical = cloneTop(repos, spelled, opts.isWindows)
  if (lexical) return lexical
  const [realRepos, realRoot] = await Promise.all([real(repos).catch(() => null), real(spelled).catch(() => null)])
  return realRepos && realRoot ? cloneTop(realRepos, realRoot, opts.isWindows) : null
}
/** `<repos>/<name>` for a path at or under a clone folder of `repos`, or null. */
function cloneTop(repos: string, p: string, isWindows?: boolean): string | null {
  if (!isInside(repos, p, isWindows) || folderKey(repos, isWindows) === folderKey(p, isWindows)) return null
  const base = resolve(repos)
  // Inside repos and not repos itself: what follows it names one folder at least.
  return join(base, resolve(p).slice(base.length).split(/[\\/]/).find((part) => part !== '') as string)
}

/** `read`, confined (confinedReader) to the clone `root` is, or is in (cloneConfinement), and plain when it is in none.
 *  Which, is found once, on the first read. */
export function cloneReader<T>(userData: string, root: string, read: (p: string) => Promise<T>): (p: string) => Promise<T> {
  let reader: Promise<(p: string) => Promise<T>> | undefined
  return async (p) => (await (reader ??= cloneConfinement(userData, root).then((w) => (w === null ? read : confinedReader(w, read)))))(p)
}
