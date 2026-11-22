// The git file listing every map of a repository reads: the code graph and memory ingest (codeIngest.ts) and
// Lumopolis's own snapshot in the world utility process (world/fileSnapshot.ts). Pure: no process runs here (listRepo
// is handed its git runner), so the world host can import it without reaching the main process's command runners.

/** Folders whose code no world shows and no read needs: dependencies, virtual environments, build and test output. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'out', 'build', 'vendor',
  '.venv', 'venv', '__pycache__', 'target', '.next', 'coverage', 'bower_components'
])
/** Minified and bundled files: generated, not written by a person. */
export const IGNORED_SUFFIXES: readonly string[] = ['.min.js', '.min.css', '.bundle.js']
/**
 * Folders an untracked listing and a folder walk never enter: the ignored ones, version control, tox environments and
 * .NET build output. `bin` is not one (it is often real scripts), and neither is `env`: a virtual environment by that
 * name is told by the pyvenv.cfg file in it, not by its name, so a source folder called env still shows.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([...IGNORED_DIRS, '.git', '.hg', '.svn', '.tox', 'obj'])
/** The file every Python virtual environment holds at its top (python -m venv, virtualenv, uv). */
export const VENV_MARKER = 'pyvenv.cfg'
/** The most files a map takes from one folder walk, or from all nested repositories together. Past it the world says so. */
export const MAP_FILE_CAP = 20_000
/** How deep repositories inside repositories are followed (a repository in a repository in a repository). */
export const NESTED_DEPTH = 3

const parentDirs = (rel: string): string[] => rel.split('/').slice(0, -1)
const hasIgnoredSuffix = (rel: string): boolean => IGNORED_SUFFIXES.some((end) => rel.endsWith(end))

/** A path no world shows: an ignored suffix, or under an ignored folder at any depth. */
export function isIgnoredPath(rel: string): boolean {
  return hasIgnoredSuffix(rel) || parentDirs(rel).some((seg) => IGNORED_DIRS.has(seg))
}

/** A path under a skip folder at any depth, or with an ignored suffix. A trailing `/` (a folder entry) counts its last name. */
export function inSkippedPath(rel: string): boolean {
  return hasIgnoredSuffix(rel) || parentDirs(rel).some((seg) => SKIP_DIRS.has(seg))
}

/**
 * Tracked files plus untracked ones the ignore files do not exclude, unquoted (core.quotepath=false), NUL separated and
 * tagged (-t: `H ` tracked, `? ` untracked), so untracked files can be held to the skip rules and a nested repository
 * (an untracked entry ending in `/`) can be listed on its own.
 */
export function lsFilesArgs(root: string): string[] {
  return ['-c', 'core.quotepath=false', '-C', root, 'ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard']
}

/** The top folder of the repository `root` is in (to find its .gitmodules from a subfolder). */
export function toplevelArgs(root: string): string[] {
  return ['-C', root, 'rev-parse', '--show-toplevel']
}

/** Tracked files inside the submodules too. git allows --recurse-submodules only with --cached, so it is a second listing. */
export function lsSubmoduleArgs(root: string): string[] {
  return ['-c', 'core.quotepath=false', '-C', root, 'ls-files', '-z', '--cached', '--recurse-submodules']
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 }

/** Undoes git's C quoting of a path ("caf\303\251.ts" → café.ts). A name not in double quotes comes back as it is. */
export function unquoteGitPath(name: string): string {
  if (name.length < 2 || name[0] !== '"' || name[name.length - 1] !== '"') return name
  const inner = name.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch !== '\\' || i === inner.length - 1) {
      // A whole code point, so a letter outside the BMP is encoded from both halves.
      const cp = inner.codePointAt(i) as number
      const s = String.fromCodePoint(cp)
      bytes.push(...Buffer.from(s, 'utf8'))
      i += s.length - 1
      continue
    }
    const next = inner[i + 1]
    const octal = /^[0-7]{3}$/.test(inner.slice(i + 1, i + 4)) ? inner.slice(i + 1, i + 4) : null
    if (octal) {
      bytes.push(parseInt(octal, 8))
      i += 3
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0))
      i += 1
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** The entries of a listing: -z output split on NUL as written, plain output a line each with git's quoting undone
 *  (after the two-character tag, for a tagged listing). */
function entries(stdout: string, tagged: boolean): string[] {
  const z = stdout.includes('\0')
  const raw = z ? stdout.split('\0') : stdout.split(/\r?\n/)
  const named = z ? raw : raw.map((e) => (tagged ? e.slice(0, 2) + unquoteGitPath(e.slice(2)) : unquoteGitPath(e)))
  return named.filter((e) => e !== '')
}

/** A listed name no read can find: not valid UTF-8, so it decoded with U+FFFD (or it really holds U+FFFD). */
const unreadableName = (name: string): boolean => name.includes('\uFFFD')

export interface ParsedListing {
  /** Readable names, each once, in listing order. */
  names: string[]
  /** Names that are not valid UTF-8: they are counted, so the world can say how many it could not map. */
  unreadable: string[]
}

/**
 * The paths of a git ls-files listing, relative to the folder it ran in. -z output is split on NUL and kept as
 * written; plain output (a test's or an older caller's) is one name a line with git's quoting undone. Duplicates go;
 * names that are not valid UTF-8 are set apart (they decode with a replacement character, so no read would find them).
 */
export function parseLsFiles(stdout: string): ParsedListing {
  const names = new Set<string>()
  const unreadable: string[] = []
  for (const name of entries(stdout, false)) {
    if (unreadableName(name)) unreadable.push(name)
    else names.add(name)
  }
  return { names: [...names], unreadable }
}

export interface TaggedListing {
  tracked: string[]
  /** Untracked files, and nested repositories as one entry ending in `/`. */
  untracked: string[]
  unreadableTracked: string[]
  unreadableUntracked: string[]
}

/** A tagged (-t) listing split into tracked and untracked names. Every tag but `?` (H, S, M, ...) is a tracked file. */
export function parseTaggedListing(stdout: string): TaggedListing {
  const out: TaggedListing = { tracked: [], untracked: [], unreadableTracked: [], unreadableUntracked: [] }
  const seen = new Set<string>()
  for (const entry of entries(stdout, true)) {
    const name = entry.slice(2)
    const untracked = entry[0] === '?'
    if (unreadableName(name)) (untracked ? out.unreadableUntracked : out.unreadableTracked).push(name)
    else if (!seen.has(name)) {
      seen.add(name)
      ;(untracked ? out.untracked : out.tracked).push(name)
    }
  }
  return out
}

/**
 * The repository's own listing joined with the submodule listing, sorted. A submodule shows in the own listing as one
 * entry for its folder (the gitlink); once its files are listed, that entry goes, since it is a folder, not a file.
 */
export function mergeListings(own: readonly string[], recursed: readonly string[]): string[] {
  const all = new Set<string>([...own, ...recursed])
  const folders = new Set<string>()
  for (const p of all) {
    let at = p.indexOf('/')
    while (at !== -1) {
      folders.add(p.slice(0, at))
      at = p.indexOf('/', at + 1)
    }
  }
  return [...all].filter((p) => !folders.has(p)).sort()
}

export interface RepoListing {
  /** Folder-relative files, `/` separated, sorted. */
  files: string[]
  /** Names that could not be read (not valid UTF-8), at most MAP_FILE_CAP of them. */
  unreadable: string[]
  /** The nested repositories held more files than MAP_FILE_CAP: some were left out. */
  capped: boolean
}

export interface ListRepoDeps {
  /** Runs git with these arguments: its stdout, or null when git refused or failed. */
  git: (args: string[]) => Promise<string | null>
  /** Whether a path exists. */
  exists: (path: string) => Promise<boolean>
}

/** `root` without a trailing separator, unless that is all there is to it (`/`, `C:\`). */
const trimRoot = (root: string): string => {
  const t = root.replace(/[\\/]+$/, '')
  return t === '' || t.endsWith(':') ? root : t
}

/** Whether the repository `root` is in declares submodules: a .gitmodules at its top, found from a subfolder too. */
async function hasSubmodules(root: string, deps: ListRepoDeps): Promise<boolean> {
  if (await deps.exists(`${root}/.gitmodules`)) return true
  // A .git here (folder, or a worktree's or submodule's file) makes this the top, and it has no .gitmodules.
  if (await deps.exists(`${root}/.git`)) return false
  const top = await deps.git(toplevelArgs(root))
  return top !== null && deps.exists(`${top.trim()}/.gitmodules`)
}

interface Budget {
  left: number
  capped: boolean
}

async function collect(root: string, stdout: string, deps: ListRepoDeps, budget: Budget, depth: number): Promise<{ files: string[]; unreadable: string[] }> {
  const listed = parseTaggedListing(stdout)
  // A virtual environment is told by its pyvenv.cfg, whatever its folder is called (env, .env, py311...).
  const venvs = listed.untracked.filter((n) => n.endsWith(`/${VENV_MARKER}`)).map((n) => n.slice(0, -VENV_MARKER.length))
  const keep = (n: string): boolean => !inSkippedPath(n) && !venvs.some((v) => n.startsWith(v))
  const untracked = listed.untracked.filter(keep)
  const nested = untracked.filter((n) => n.endsWith('/'))
  let recursed: string[] = []
  let unreadableTracked = listed.unreadableTracked
  if (await hasSubmodules(root, deps)) {
    const sub = await deps.git(lsSubmoduleArgs(root))
    if (sub !== null) {
      // The recursed listing holds the repository's tracked files again, so its unreadable names replace the own ones.
      const parsed = parseLsFiles(sub)
      recursed = parsed.names
      unreadableTracked = parsed.unreadable
    }
  }
  let files = mergeListings([...listed.tracked, ...untracked.filter((n) => !n.endsWith('/'))], recursed)
  if (depth > 0) {
    if (files.length > budget.left) {
      budget.capped = true
      files = files.slice(0, budget.left)
    }
    budget.left -= files.length
  }
  const unreadable = [...listed.unreadableUntracked.filter(keep), ...unreadableTracked]
  if (depth < NESTED_DEPTH) {
    for (const n of nested) {
      const at = `${root}/${n.slice(0, -1)}`
      // git lists a folder holding a repository of its own as one entry; anything else with a trailing slash is not one.
      if (!(await deps.exists(`${at}/.git`))) continue
      const out = await deps.git(lsFilesArgs(at))
      // A nested repository git refuses (an owner it does not trust) is left out.
      if (out === null) continue
      const inner = await collect(at, out, deps, budget, depth + 1)
      files = files.concat(inner.files.map((f) => n + f))
      unreadable.push(...inner.unreadable.map((u) => n + u))
    }
  }
  return { files, unreadable }
}

/**
 * Every file git lists for `root`: tracked files, untracked ones the ignore files allow (minus skip folders and virtual
 * environments, which are never read), submodules' tracked files (found from the repository top, so a subfolder gets
 * them too), and the files of nested repositories that are not submodules, each listed by its own git under the same
 * rules, NESTED_DEPTH deep and MAP_FILE_CAP files in all. Null when git refuses `root` itself.
 */
export async function listRepo(root: string, deps: ListRepoDeps): Promise<RepoListing | null> {
  const base = trimRoot(root)
  const own = await deps.git(lsFilesArgs(base))
  if (own === null) return null
  const budget: Budget = { left: MAP_FILE_CAP, capped: false }
  const got = await collect(base, own, deps, budget, 0)
  return { files: got.files.sort(), unreadable: got.unreadable.slice(0, MAP_FILE_CAP), capped: budget.capped }
}
