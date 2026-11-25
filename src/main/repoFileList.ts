// The git file listing every map of a repository reads: the code graph and memory ingest (codeIngest.ts) and
// Lumopolis's own snapshot in the world utility process (world/fileSnapshot.ts). Pure: no process runs here (listRepo
// is handed its git runner), so the world host can import it without reaching the main process's command runners.
// Every git argument list built here starts with the world host's safety flags (gitLogin.ts safetyFlags: no fsmonitor
// program, no hooks, no file transport, no symlinks), so neither caller can start git without them.
import { posix, win32 } from 'node:path'
import { safetyFlags } from './world/gitLogin'

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
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ...IGNORED_DIRS, '.git', '.hg', '.svn', '.tox', 'obj',
  // What the file watcher skips too (watchGuard.ts): nested checkouts, where agents keep worktrees of this same
  // repository, and tool caches.
  '.worktrees', '.nuxt', '.turbo', '.parcel-cache', '.svelte-kit', '.angular', '.gradle',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.vs'
])
/**
 * Skip folders whose names a project also gives folders it fills by hand and commits: electron-builder's build
 * resources, a published dist, vendored code it owns, a target or obj that is not build output. Their tracked files are
 * kept (the code index reads what was committed); tracked files in every other skip folder are dropped, since a
 * committed node_modules, virtual environment, cache or worktree is code no read needs (WP4a #63).
 */
export const OWN_OUTPUT_DIRS: ReadonlySet<string> = new Set(['build', 'out', 'dist', 'vendor', 'target', 'obj', 'coverage'])
/** The file every Python virtual environment holds at its top (python -m venv, virtualenv, uv). */
export const VENV_MARKER = 'pyvenv.cfg'
/** The most files a map takes from one folder walk, or from all nested repositories together. Past it the world says so. */
export const MAP_FILE_CAP = 20_000
/** How deep repositories inside repositories are followed (a repository in a repository in a repository). */
export const NESTED_DEPTH = 3

const parentDirs = (rel: string): string[] => rel.split('/').slice(0, -1)
const hasIgnoredSuffix = (rel: string): boolean => {
  for (let k = 0; k < IGNORED_SUFFIXES.length; k++) if (rel.endsWith(IGNORED_SUFFIXES[k])) return true
  return false
}

/**
 * A path no world shows: an ignored suffix, or under an ignored folder at any depth. Every listed path passes through
 * here, so each folder name is looked at in place, with no array of them (WP4a fix round 4).
 */
export function isIgnoredPath(rel: string): boolean {
  if (hasIgnoredSuffix(rel)) return true
  for (let at = 0, end = rel.indexOf('/'); end >= 0; at = end + 1, end = rel.indexOf('/', at)) if (IGNORED_DIRS.has(rel.slice(at, end))) return true
  return false
}

/**
 * Whether a folder called `name`, inside a folder called `parent` (undefined at the top), is never entered: a skip
 * folder, or `.claude/worktrees`, where Claude Code puts its worktrees, which counts as one name (as in watchGuard.ts).
 */
export function skipsDir(name: string, parent: string | undefined): boolean {
  return SKIP_DIRS.has(name) || (name === 'worktrees' && parent === '.claude')
}

/** A path under a skip folder at any depth, or with an ignored suffix. A trailing `/` (a folder entry) counts its last name. */
export function inSkippedPath(rel: string): boolean {
  return hasIgnoredSuffix(rel) || parentDirs(rel).some((seg, i, all) => skipsDir(seg, i > 0 ? all[i - 1] : undefined))
}

/**
 * A tracked path no listing keeps: an ignored suffix, or under a skip folder that is not one of OWN_OUTPUT_DIRS, at any
 * depth. A trailing `/` (a folder entry) counts its last name, as in inSkippedPath.
 */
export function inTrackedSkipPath(rel: string): boolean {
  return hasIgnoredSuffix(rel) || parentDirs(rel).some((seg, i, all) => !OWN_OUTPUT_DIRS.has(seg) && skipsDir(seg, i > 0 ? all[i - 1] : undefined))
}

const onWindows = (): boolean => process.platform === 'win32'

/**
 * Tracked files plus untracked ones the ignore files do not exclude, unquoted (core.quotepath=false), NUL separated and
 * tagged (-t: `H ` tracked, `? ` untracked), so untracked files can be held to the skip rules and a nested repository
 * (an untracked entry ending in `/`) can be listed on its own.
 */
export function lsFilesArgs(root: string, isWindows: boolean = onWindows()): string[] {
  return [...safetyFlags(isWindows), '-c', 'core.quotepath=false', '-C', root, 'ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard']
}

/** The top folder of the repository `root` is in (to find its .gitmodules from a subfolder). */
export function toplevelArgs(root: string, isWindows: boolean = onWindows()): string[] {
  return [...safetyFlags(isWindows), '-C', root, 'rev-parse', '--show-toplevel']
}

/** Tracked files inside the submodules too. git allows --recurse-submodules only with --cached, so it is a second listing. */
export function lsSubmoduleArgs(root: string, isWindows: boolean = onWindows()): string[] {
  return [...safetyFlags(isWindows), '-c', 'core.quotepath=false', '-C', root, 'ls-files', '-z', '--cached', '--recurse-submodules']
}

/** The git folder `root` shares with every worktree of its repository, spelled in full (git 2.31 is the floor). */
export function commonDirArgs(root: string, isWindows: boolean = onWindows()): string[] {
  return [...safetyFlags(isWindows), '-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir']
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
  /** The nested repositories held more files than MAP_FILE_CAP: some were left out. The repository itself never is. */
  nestedCapped: boolean
  /** The nested repositories listed (or walked) and the submodules recursed, folder-relative, sorted: a file watcher
   *  keeps their edits. */
  nested: string[]
}

/** A plain-folder walk's answer (world/folderWalk.ts WalkResult). */
export interface NestedWalk {
  files: string[]
  unreadable: string[]
  capped: boolean
}

export interface ListRepoDeps {
  /** Runs git with these arguments: its stdout, or null when git refused or failed. */
  git: (args: string[]) => Promise<string | null>
  /** Whether a path exists. */
  exists: (path: string) => Promise<boolean>
  /** Whether a path is a file (a worktree's `.git` is one). Default: nothing is, so no worktree is looked for. */
  isFile?: (path: string) => Promise<boolean>
  /** A small file's text (a worktree's `.git` file), or null when it cannot be read. Default: none is, so a worktree
   *  is told only by git. */
  readText?: (path: string) => Promise<string | null>
  /** Walks a nested repository git refuses as a plain folder, listing at most `cap` files. Default: it is left out. */
  walk?: (absDir: string, cap: number) => Promise<NestedWalk>
  /** A nested repository (its path from the top, as a folder entry: `.superpowers/wt/`) the caller has no use for: it
   *  is never listed, so it spends none of the shared cap and never marks the listing cut. Default: none is skipped. */
  skipNested?: (rel: string) => boolean
  /** The platform git runs on: its safety flags, and whether paths fold case. Default: this one. */
  platform?: NodeJS.Platform
  /** Which safety flags git gets (the Windows hooks path or the POSIX one) when the caller names it apart from the
   *  platform. Default: whether the platform is Windows. */
  isWindows?: boolean
}

/** Platforms whose usual file systems fold case (NTFS, APFS), as watchGuard.ts CASE_FOLDING_PLATFORMS. */
const FOLDS_CASE: ReadonlySet<string> = new Set(['win32', 'darwin'])

/** A path as a comparison key: `/` separated, no trailing separator, lower case where the platform folds case. */
export function pathKey(p: string, platform: string = process.platform): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return FOLDS_CASE.has(platform) ? s.toLowerCase() : s
}

/** `root` without a trailing separator, unless that is all there is to it (`/`, `C:\`). */
const trimRoot = (root: string): string => {
  const t = root.replace(/[\\/]+$/, '')
  return t === '' || t.endsWith(':') ? root : t
}

/** Whether the repository `root` is in declares submodules: a .gitmodules at its top, found from a subfolder too. */
async function hasSubmodules(root: string, ctx: Ctx): Promise<boolean> {
  const { deps } = ctx
  if (await deps.exists(`${root}/.gitmodules`)) return true
  // A .git here (folder, or a worktree's or submodule's file) makes this the top, and it has no .gitmodules.
  if (await deps.exists(`${root}/.git`)) return false
  const top = await deps.git(toplevelArgs(root, ctx.isWindows))
  return top !== null && deps.exists(`${top.trim()}/.gitmodules`)
}

/** One listing's state: the shared file budget of the nested repositories, and the git folders already asked. */
interface Ctx {
  deps: ListRepoDeps
  isWindows: boolean
  platform: string
  left: number
  capped: boolean
  common: Map<string, Promise<string | null>>
  /** The folder the listing started at: nested paths are named from it for skipNested. */
  top: string
}

/** One absolute path, as git prints it on any platform (`/x`, `C:/x`, `C:\x`). */
const ONE_ABSOLUTE_PATH = /^(?:[A-Za-z]:)?[\\/][^\n]*$/

/**
 * The git folder `dir` shares with its worktrees, as a comparison key; null when git will not say. Asked once. A git
 * older than 2.31 does not know --path-format and prints it back, with a relative folder: that is no answer either.
 */
function commonDir(dir: string, ctx: Ctx): Promise<string | null> {
  let got = ctx.common.get(dir)
  if (got === undefined) {
    got = ctx.deps.git(commonDirArgs(dir, ctx.isWindows)).then((out) => {
      const t = out === null ? '' : out.trim()
      return ONE_ABSOLUTE_PATH.test(t) ? pathKey(t, ctx.platform) : null
    })
    ctx.common.set(dir, got)
  }
  return got
}

/**
 * Whether the `.git` file at `at` points into the `.git/worktrees` folder of one of the repositories it sits in
 * (`chain`), read without starting git: `gitdir: <a repository's .git>/worktrees/<name>`, absolute or relative to `at`.
 */
async function pointsIntoChain(at: string, chain: readonly string[], ctx: Ctx): Promise<boolean> {
  const { deps } = ctx
  if (!deps.readText || !deps.isFile || !(await deps.isFile(`${at}/.git`))) return false
  const line = /^gitdir:\s*(.+?)\s*$/m.exec((await deps.readText(`${at}/.git`)) ?? '')
  if (line === null) return false
  const paths = ctx.platform === 'win32' ? win32 : posix
  const into = pathKey(paths.dirname(paths.resolve(at, line[1])), ctx.platform)
  return chain.some((up) => pathKey(paths.resolve(up, '.git', 'worktrees'), ctx.platform) === into)
}

/**
 * Whether the repository at `at` is a worktree of one of the repositories it sits in (`chain`): its `.git` is a file,
 * pointing into one's `.git/worktrees`, or git names the same shared git folder for both. Its files are those
 * repositories' own files again.
 */
async function isOwnWorktree(at: string, chain: readonly string[], ctx: Ctx): Promise<boolean> {
  if (!ctx.deps.isFile || !(await ctx.deps.isFile(`${at}/.git`))) return false
  if (await pointsIntoChain(at, chain, ctx)) return true
  const mine = await commonDir(at, ctx)
  if (mine === null) return false
  for (const up of chain) if ((await commonDir(up, ctx)) === mine) return true
  return false
}

interface Collected {
  files: string[]
  unreadable: string[]
  nested: string[]
}

async function collect(root: string, stdout: string, ctx: Ctx, chain: readonly string[]): Promise<Collected> {
  const { deps } = ctx
  const depth = chain.length
  const listed = parseTaggedListing(stdout)
  // A virtual environment is told by its pyvenv.cfg, whatever its folder is called (env, .env, py311...), committed or not.
  const venvs = [...listed.untracked, ...listed.tracked].filter((n) => n.endsWith(`/${VENV_MARKER}`)).map((n) => n.slice(0, -VENV_MARKER.length))
  const inVenv = (n: string): boolean => venvs.some((v) => n.startsWith(v))
  const keep = (n: string): boolean => !inSkippedPath(n) && !inVenv(n)
  // Tracked files are held to the skip folders too, but for the build-output names a project also fills by hand.
  const keepTracked = (n: string): boolean => !inTrackedSkipPath(n) && !inVenv(n)
  const untracked = listed.untracked.filter(keep)
  const nested = untracked.filter((n) => n.endsWith('/'))
  let recursed: string[] = []
  let unreadableTracked = listed.unreadableTracked
  if (await hasSubmodules(root, ctx)) {
    const sub = await deps.git(lsSubmoduleArgs(root, ctx.isWindows))
    if (sub !== null) {
      // The recursed listing holds the repository's tracked files again, so its unreadable names replace the own ones.
      const parsed = parseLsFiles(sub)
      recursed = parsed.names
      unreadableTracked = parsed.unreadable
    }
  }
  // Merged before the tracked skip rule, so a submodule's gitlink goes with the files it holds, kept or not.
  let files = mergeListings([...listed.tracked, ...untracked.filter((n) => !n.endsWith('/'))], recursed).filter(keepTracked)
  // A submodule is a tracked entry (its gitlink) that the recursed listing holds files under; one in a skip folder is not
  // followed.
  const inRecursed = new Set<string>()
  for (const r of recursed) for (let at = r.indexOf('/'); at !== -1; at = r.indexOf('/', at + 1)) inRecursed.add(r.slice(0, at))
  const submodules = listed.tracked.filter((t) => inRecursed.has(t) && keepTracked(`${t}/`))
  if (depth > 0) {
    if (files.length > ctx.left) {
      ctx.capped = true
      files = files.slice(0, ctx.left)
    }
    ctx.left -= files.length
  }
  const unreadable = [...listed.unreadableUntracked.filter(keep), ...unreadableTracked.filter(keepTracked)]
  const found: string[] = [...submodules]
  if (depth < NESTED_DEPTH) {
    for (const n of nested) {
      const at = `${root}/${n.slice(0, -1)}`
      // git lists a folder holding a repository of its own as one entry; anything else with a trailing slash is not one.
      if (!(await deps.exists(`${at}/.git`))) continue
      if (deps.skipNested?.(`${at.slice(ctx.top.length + 1)}/`)) continue
      // The budget is spent: no more git is started, and the world says the nested repositories were cut, unless all
      // that is left are worktrees of the repository itself (told without git), which add nothing.
      if (ctx.left === 0) {
        if (await pointsIntoChain(at, [...chain, root], ctx)) continue
        ctx.capped = true
        break
      }
      if (await isOwnWorktree(at, [...chain, root], ctx)) continue
      const out = await deps.git(lsFilesArgs(at, ctx.isWindows))
      let inner: Collected
      if (out !== null) inner = await collect(at, out, ctx, [...chain, root])
      else if (deps.walk) {
        // A nested repository git refuses (an owner it does not trust) is walked as a plain folder, by the same rules.
        const walked = await deps.walk(at, ctx.left)
        const take = walked.files.slice(0, ctx.left)
        if (walked.capped || take.length < walked.files.length) ctx.capped = true
        ctx.left -= take.length
        inner = { files: take, unreadable: walked.unreadable, nested: [] }
      } else continue
      files = files.concat(inner.files.map((f) => n + f))
      unreadable.push(...inner.unreadable.map((u) => n + u))
      found.push(n.slice(0, -1), ...inner.nested.map((d) => n + d))
    }
  }
  return { files, unreadable, nested: found }
}

/**
 * Every file git lists for `root`: tracked files (minus those in skip folders other than OWN_OUTPUT_DIRS, and in
 * virtual environments), untracked ones the ignore files allow (minus skip folders and virtual environments, which are
 * never read), submodules' tracked files (found from the repository top, so a subfolder gets
 * them too), and the files of nested repositories that are not submodules, each listed by its own git under the same
 * rules (or walked, when git refuses one and a walk is given), NESTED_DEPTH deep and MAP_FILE_CAP files in all. A
 * nested worktree of the repository itself (its `.git` a file into the same git folder) is not listed: its files are
 * the repository's own again. Null when git refuses `root` itself.
 */
export async function listRepo(root: string, deps: ListRepoDeps): Promise<RepoListing | null> {
  const base = trimRoot(root)
  const platform = deps.platform ?? process.platform
  const ctx: Ctx = { deps, isWindows: deps.isWindows ?? platform === 'win32', platform, left: MAP_FILE_CAP, capped: false, common: new Map(), top: base }
  const own = await deps.git(lsFilesArgs(base, ctx.isWindows))
  if (own === null) return null
  const got = await collect(base, own, ctx, [])
  return { files: got.files.sort(), unreadable: got.unreadable.slice(0, MAP_FILE_CAP), nestedCapped: ctx.capped, nested: got.nested.sort() }
}
