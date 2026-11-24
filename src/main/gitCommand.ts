// Argv-safe wrappers for child_process.
//
// All git IPC handlers funnel through safeGit so shell metacharacters in
// file names, commit messages, or ref names can never be interpreted by a
// shell — they're passed as literal argv entries to the git binary.
//
// swarm:run-command uses isSafeCommand + SAFE_RUNNERS to keep the "run the
// project's test suite" feature from turning into arbitrary RCE if a
// compromised renderer (or unsanitised MCP client) sends a crafted string.

import { getExtendedPathAsync } from './agentPaths'
import { binInsideFolder, forgetGitBin, resolveGitBin } from './binPath'
import { execOffThread, execCaptureOffThread, execShellCaptureOffThread } from './procClient'
import { constants as fsConstants, promises as fsPromises } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { filterScanArgs, guardGitArgs, guardGitDropEnv, guardGitEnv, needsFilterScan, runFilterScan, type FilterScan } from './gitSafety'
import { PollBudgetSpent, withSubmoduleEdits, type DirtySubmodule, type SubmoduleDeps } from './gitSubmodules'
import { OLD_GIT_MESSAGE } from './world/gitLogin'

export interface GitOptions {
  cwd: string
  timeout?: number
  maxBuffer?: number
}

/**
 * Run git with an argv array, off the main thread. (There was a synchronous `safeGit` once, built on
 * `execFileSync`; nothing called it after v1.47.1 and it is gone, so that nothing can again: a synchronous spawn on
 * the main thread freezes every terminal. tests/electron/mainThreadScan.test.ts fails on any new one.)
 *
 * `execFileSync` blocks the main thread for the WHOLE spawn — and on Windows a cold git spawn is
 * ~106 ms of pure process-creation tax (measured; Defender), before git reads a single object. The
 * git status bar polls every 3 s, per repo terminal, and paid that twice: 227 ms (termpolis) to
 * 300 ms (MSI-PAS-CORE) of fully dead main thread per poll — a 7-10% duty cycle, forever, on the
 * thread that pumps every PTY. `async` on the IPC handler bought nothing: execFileSync blocks
 * regardless of what wraps it.
 *
 * Switching to `execFile` did not finish the job either, and that is the v1.47.1 fix. `execFile`
 * awaits the OUTPUT asynchronously but performs the SPAWN synchronously — libuv's uv_spawn is
 * CreateProcess on Windows, on the calling thread — measured at p50 47.9 ms and up to 623 ms per
 * git. So the work now leaves the process entirely: execOffThread hands it to the procHost
 * utilityProcess, where a blocked thread blocks nobody's typing.
 *
 * Argv-safe (shell: false), and git is always started by its FULL path (binPath.ts resolveGitBin: the fixed PATH
 * folders, then the install locations, so a packaged app with no git on PATH still finds it). Never by the bare
 * name, as defence in depth: Node's libuv resolves a bare `git` from PATH, not from `cwd` (measured on Node 24 on
 * Windows with a stand-in `git.exe` in the cwd), but a PATH entry that is relative or empty, or another launcher,
 * would look in the folder being read. A git that lies inside the folder it would run in is refused too. When there is no git, nothing is started and the call
 * fails with code 'ENOENT', exactly as a missing git always did, so every caller degrades as it did before.
 */
export function safeGitAsync(args: string[], opts: GitOptions): Promise<string> {
  return guardedGit(args, opts, true)
}

/** safeGitAsync; with `fold` false, a status inside a submodule that gitSubmodules.ts is already walking, which writes
 *  no submodule rows of its own (that walk covers every level within one budget). `start`, from that walk, is asked
 *  before a filter scan is started (gitSubmodules.ts SubmoduleDeps.git). */
async function guardedGit(args: string[], opts: GitOptions, fold: boolean, start?: () => boolean): Promise<string> {
  const bin = await resolveGitBin()
  if (bin === null || (await binInsideFolder(bin, opts.cwd))) throw gitNotFound()
  // The one chokepoint for git safety (gitSafety.ts): a read never runs a program the repository's own config,
  // hooks or attributes name; a write runs exactly as the person's git would. status and diff first read which
  // filter drivers the repository defines, so each can be switched off by name.
  const isWindows = process.platform === 'win32'
  try {
    const overrides = needsFilterScan(args) ? await repoFilterOverrides(bin, args, opts, isWindows, start) : undefined
    const out = await execOffThread(bin, guardGitArgs(args, isWindows, overrides), {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 10000,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
      // GIT_NO_LAZY_FETCH for a read: a partial clone missing an object never starts a fetch. A read also leaves out the
      // inherited GIT_CONFIG and the variables that move it to another repository, so it reads the config its scan
      // read (gitSafety.ts). A write keeps the environment as it is.
      addEnv: guardGitEnv(args),
      dropEnv: guardGitDropEnv(args),
    })
    // A status leaves each submodule's dirty state out (its own config would run); it is asked for here, one guarded
    // status per submodule, and written back in (gitSubmodules.ts). Any other command comes back as git wrote it.
    return fold ? await withSubmoduleEdits(args, opts.cwd, out, submoduleDeps(opts), cachedDirtySubmodules) : out
  } catch (e) {
    // `code` still means what it always meant: the string 'ENOENT' when the binary was not found, a number when
    // git ran and refused. ProcError carries it across the process boundary. The git found earlier has gone
    // (uninstalled or moved): look for it again on the next call.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') forgetGitBin()
    throw e
  }
}

/** Thrown by a read that needs the filter scan when git is too old to give it (`config --show-scope` arrived in git
 *  2.26). The read is not run: without the scan its filter drivers could not be switched off. `code` lets a caller tell
 *  it from an ordinary failure; the message is the one the panels show. */
export class GitTooOldError extends Error {
  readonly code = 'GIT_TOO_OLD'
  constructor() {
    super(OLD_GIT_MESSAGE)
    this.name = 'GitTooOldError'
  }
}

/** How long one repository's filter-driver scan is reused while the config files it reads say the same: a ceiling,
 *  so a change nothing below notices (the person's own global config, say) is seen within it. */
const FILTER_SCAN_TTL_MS = 30_000
/** Scans remembered at once; expired ones go first, then the oldest. */
const FILTER_SCAN_MAX = 64
const filterScans = new Map<string, { at: number; stamp: string; value: Promise<FilterScan> }>()

/**
 * The `-c` options that switch off the filter drivers the repository at `opts.cwd` defines (gitSafety.ts
 * filterOverrides). `git config --get-regexp` exits 1 when nothing matches: no driver, nothing to switch off. Any
 * other failure, or a driver that cannot be switched off, fails the read itself: it is never run with a driver left on.
 *
 * One scan serves every folder of a repository for up to FILTER_SCAN_TTL_MS, and is read again as soon as the text of
 * the repository's config or config.worktree changes. It is kept only where this module knows, the way git itself
 * finds it, which git folder the read opens (scanPlace); anywhere it is not sure, every read is scanned. Accepted race:
 * a config edit that lands after those files are read and before the command itself starts (a few milliseconds) is
 * not seen by that one command; the next read sees it.
 */
async function repoFilterOverrides(bin: string, args: string[], opts: GitOptions, isWindows: boolean, start?: () => boolean): Promise<FilterScan> {
  const scanArgs = filterScanArgs(args, isWindows)
  // Anything unexpected while reading the files (a folder that vanished, a test's stand-in fs): not kept.
  const place = await scanPlace(opts.cwd, scanArgs).catch(() => null)
  const key = place === null ? null : `${place.key}\u0000${place.args.join('\u0000')}`
  const now = Date.now()
  const hit = key === null ? undefined : filterScans.get(key)
  if (hit && now - hit.at < FILTER_SCAN_TTL_MS && hit.stamp === place?.stamp) return hit.value
  // A submodule walk counts this git against its poll's budget too, and starts nothing past it.
  if (start && !start()) throw new PollBudgetSpent()
  const value = runFilterScan(args, isWindows, (runArgs) =>
    execOffThread(bin, runArgs, { cwd: opts.cwd, timeout: opts.timeout ?? 10000, maxBuffer: 1024 * 1024, addEnv: guardGitEnv(runArgs), dropEnv: guardGitDropEnv(runArgs) })
      .catch((e: unknown) => {
        const code = (e as { code?: unknown } | null)?.code
        if (code === 1) return ''
        // 129 is git's usage error. The scan's options are fixed (and its -C, --git-dir and --work-tree are older than
        // git 2), so a usage error means a git without --show-scope.
        if (code === 129) throw new GitTooOldError()
        throw e
      }))
  if (key === null || place === null) return value
  for (const [k, v] of filterScans) if (now - v.at >= FILTER_SCAN_TTL_MS) filterScans.delete(k)
  filterScans.delete(key)
  filterScans.set(key, { at: now, stamp: place.stamp, value })
  if (filterScans.size > FILTER_SCAN_MAX) filterScans.delete(filterScans.keys().next().value as string)
  value.catch(() => {
    if (filterScans.get(key)?.value === value) filterScans.delete(key)
  })
  return value
}

/** Environment variables that change which repository git opens, or where it stops looking: with any set, the files
 *  below may not be the ones git reads. */
const DISCOVERY_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']

/** Where a scan reads its config: the git folder that names the repository, the scan's arguments without the `-C`
 *  already folded into it, and the text of the config files (the stamp). null wherever that is not certain, and the
 *  scan is then not kept: outside a repository, a `.git` that is not a whole repository, a folder on the way up that
 *  could be a git folder itself, a config that names another file (any
 *  `include`), a config that cannot be read, or one of DISCOVERY_ENV set. */
async function scanPlace(cwd: string, scanArgs: readonly string[]): Promise<{ key: string; args: string[]; stamp: string } | null> {
  if (DISCOVERY_ENV.some((k) => process.env[k] !== undefined)) return null
  // git walks up from the folder it is in as the system resolves it (getcwd, after each -C's chdir), links followed.
  let base: string | null = await fsPromises.realpath(resolve(cwd))
  let gitDirArg: string | undefined
  const args: string[] = []
  for (let i = 0; i < scanArgs.length; i++) {
    const a = scanArgs[i]
    if (a === '-C' && i + 1 < scanArgs.length) {
      // git skips an empty -C; any other is a chdir, which the system resolves (`..` after a link is the link's parent).
      const to = scanArgs[++i]
      if (to !== '') base = await gitPath(base, to)
      if (base === null) return null
    } else {
      if (a === '--git-dir' && i + 1 < scanArgs.length) gitDirArg = scanArgs[i + 1]
      else if (a.startsWith('--git-dir=')) gitDirArg = a.slice('--git-dir='.length)
      args.push(a)
    }
  }
  const named = gitDirArg === undefined ? undefined : await gitPath(base, gitDirArg)
  if (named === null) return null
  const dirs = named !== undefined ? await repositoryAt(named) : await findGitDirs(base)
  if (dirs === null) return null
  const texts = await Promise.all([join(dirs.common, 'config'), join(dirs.gitDir, 'config.worktree')].map(configText))
  // A config that names another file is read with that file, which no stamp here watches: any `include`, in any
  // spelling or layout (`[includeIf …]`, `[core][include]` on one line), and the scan is not kept.
  if (texts.some((t) => t === null || /include/i.test(t))) return null
  return { key: dirs.gitDir, args, stamp: texts.join('\u0000') }
}

/** The folder the system opens for `raw` (a path as git was handed it) from `base`: resolved by the system itself, so
 *  a `..` after a link climbs out of where the link leads, as git's chdir and realpath do. null when it cannot be
 *  resolved, or when a part of it ends in a space, a tab or a dot: Windows drops those from a name and opens another
 *  folder than git's own reading of it, so such a place is never kept (git itself takes the name as written). */
async function gitPath(base: string, raw: string): Promise<string | null> {
  if (raw.split(/[\\/]/).some((part) => part !== '.' && part !== '..' && /[ \t.]$/.test(part))) return null
  return fsPromises.realpath(isAbsolute(raw) ? raw : base + sep + raw).catch(() => null)
}

/** A file's text: '' when there is none, null when it is there but cannot be read as a file. */
async function configText(file: string): Promise<string | null> {
  return fsPromises.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => (e?.code === 'ENOENT' ? '' : null))
}

interface GitDirs { gitDir: string; common: string }

/** The git folder a read in `dir` opens, found the way git's discovery finds it: at each folder from `dir` up, a
 *  `.git` folder or `gitdir:` file first, then the folder itself as a git folder. null wherever this is not certain:
 *  a `.git` that is not a whole repository (git would skip it, or stop), one that cannot be read, a folder on the way
 *  that holds HEAD, objects or refs (git could open it as a repository of its own), or no repository at all. */
async function findGitDirs(dir: string): Promise<GitDirs | null> {
  // git stops looking where the folder above is on another filesystem (GIT_DISCOVERY_ACROSS_FILESYSTEM unset).
  const device = (await fsPromises.stat(dir)).dev
  for (let at = dir; ; at = dirname(at)) {
    if (at !== dir && (await fsPromises.stat(at)).dev !== device) return null
    const dotGit = join(at, '.git')
    const st = await fsPromises.stat(dotGit).then((s) => s, (e: NodeJS.ErrnoException) => (e?.code === 'ENOENT' ? undefined : null))
    if (st === null) return null
    if (st !== undefined) {
      if (st.isDirectory()) {
        const real = await gitPath(at, '.git')
        return real === null ? null : repositoryAt(real)
      }
      if (!st.isFile()) return null
      // git reads a `.git` file that says exactly `gitdir: <path>`, taking off only the line ending: a space or tab
      // left at the end is part of the path. Anything else it refuses.
      const text = (await fsPromises.readFile(dotGit, 'utf8').catch(() => '')).replace(/[\r\n]+$/, '')
      if (!text.startsWith('gitdir: ') || text.length === 'gitdir: '.length) return null
      const named = await gitPath(at, text.slice('gitdir: '.length))
      return named === null ? null : repositoryAt(named)
    }
    if (await mayBeGitDir(at)) return null
    if (dirname(at) === at) return null
  }
}

/** Whether `dir` holds anything git looks for in a git folder (HEAD, objects, refs): more than git itself needs. */
async function mayBeGitDir(dir: string): Promise<boolean> {
  const found = await Promise.all(['HEAD', 'objects', 'refs'].map((n) =>
    fsPromises.lstat(join(dir, n)).then(() => true, (e: NodeJS.ErrnoException) => e?.code !== 'ENOENT')))
  return found.includes(true)
}

/** `gitDir` and the common folder its `commondir` names, when git would take it as a repository (a HEAD that is a
 *  file naming a ref or an object, and objects/ and refs/ folders it can enter); otherwise null. */
async function repositoryAt(gitDir: string): Promise<GitDirs | null> {
  const commondir = await configText(join(gitDir, 'commondir'))
  if (commondir === null) return null
  // As with a `.git` file, only the line ending comes off.
  const commonText = commondir.replace(/[\r\n]+$/, '')
  const common = commonText === '' ? gitDir : await gitPath(gitDir, commonText)
  if (common === null) return null
  const headIsFile = await fsPromises.lstat(join(gitDir, 'HEAD')).then((s) => s.isFile(), () => false)
  const head = headIsFile ? await fsPromises.readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => '') : ''
  if (!/^(ref:[ \t]*refs\/[^\r\n]*|[0-9a-f]{40}|[0-9a-f]{64})[ \t\r\n]*$/.test(head)) return null
  const enterable = (p: string): Promise<boolean> => fsPromises.stat(p).then(
    (s) => s.isDirectory() && fsPromises.access(p, fsConstants.X_OK).then(() => true, () => false),
    () => false)
  const [objects, refs] = await Promise.all([enterable(join(common, 'objects')), enterable(join(common, 'refs'))])
  return objects && refs ? { gitDir, common } : null
}

/** How long one repository's dirty-submodule answer is reused: the git cache's window (gitCache.ts GIT_CACHE_TTL_MS),
 *  so the panels that wake on one tick share one look into each submodule. */
const DIRTY_SUBMODULES_TTL_MS = 1500
/** Repositories remembered at once; the oldest is dropped past this. */
const DIRTY_SUBMODULES_MAX = 64
const dirtySubmoduleCache = new Map<string, { at: number; value: Promise<DirtySubmodule[]> }>()

function cachedDirtySubmodules(root: string, untrackedNo: boolean, load: () => Promise<DirtySubmodule[]>): Promise<DirtySubmodule[]> {
  const key = `${root}\u0000${untrackedNo ? 'no' : 'all'}`
  const now = Date.now()
  const hit = dirtySubmoduleCache.get(key)
  if (hit && now - hit.at < DIRTY_SUBMODULES_TTL_MS) return hit.value
  const value = load()
  dirtySubmoduleCache.delete(key)
  dirtySubmoduleCache.set(key, { at: now, value })
  if (dirtySubmoduleCache.size > DIRTY_SUBMODULES_MAX) dirtySubmoduleCache.delete(dirtySubmoduleCache.keys().next().value as string)
  return value
}

/** The folder holding `.git` at or above `cwd`, found on disk without starting git; null outside a repository. */
export async function repoTopLevel(cwd: string): Promise<string | null> {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    try {
      await fsPromises.stat(join(dir, '.git'))
      return dir
    } catch {
      if (dirname(dir) === dir) return null
    }
  }
}

function submoduleDeps(opts: GitOptions): SubmoduleDeps {
  return {
    topLevel: repoTopLevel,
    readText: (file) => fsPromises.readFile(file, 'utf8').catch(() => null),
    exists: (p) => fsPromises.stat(p).then(() => true, () => false),
    git: (args, cwd, start) => guardedGit(args, { cwd, timeout: opts.timeout, maxBuffer: opts.maxBuffer }, false, start),
    join: (root, rel) => join(root, ...rel.split('/')),
    relative: (root, cwd) => relative(root, resolve(cwd)).split(sep).join('/')
  }
}

/** The error a missing git has always given: code 'ENOENT', and nothing was started. */
function gitNotFound(): NodeJS.ErrnoException {
  return Object.assign(new Error('git was not found'), { code: 'ENOENT' })
}

/** Test seam: reset the cached git binary resolution. */
export function _resetGitBinForTests(): void {
  forgetGitBin()
  filterScans.clear()
  dirtySubmoduleCache.clear()
}

// Conservative subset of git-check-ref-format(1): start with alphanumeric,
// then alphanumerics / `.` / `_` / `/` / `-`, max 255 chars. `..` is a range
// operator and is rejected separately. SHAs, branch names, and tags all
// match; shell metacharacters and the `@{…}` upstream syntax do not.
const REF_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}$/
export function isValidGitRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_REGEX.test(ref) && !ref.includes('..')
}

// Allowlisted first tokens for swarm:run-command. The swarm review feature
// runs a project's test suite; every runner listed here is non-interactive
// and exits with a meaningful status code.
export const SAFE_RUNNERS = new Set<string>([
  'npm', 'yarn', 'pnpm', 'bun', 'npx',
  'cargo',
  'python', 'python3', 'pytest',
  'go',
  'deno',
  'make',
  'gradle', 'mvn',
  'jest', 'vitest', 'playwright',
  'tsc', 'tsx',
  'ruby', 'rake', 'bundle',
  'dotnet',
])

// Shell metacharacters we never want in a swarm:run-command string. Even
// though we execute without a shell, rejecting these up-front keeps the
// contract clear: this handler runs one test command, nothing else.
const SHELL_META = /[;&|$`><(){}*?[\]!~"'\n\r\\]/

export interface SafeCommand {
  bin: string
  args: string[]
}

export function parseSafeCommand(command: string): SafeCommand | { error: string } {
  if (!command || !command.trim()) return { error: 'Empty command' }
  const trimmed = command.trim()
  if (SHELL_META.test(trimmed)) {
    return { error: 'Command contains forbidden shell metacharacters' }
  }
  const parts = trimmed.split(/\s+/)
  const bin = parts[0]
  if (!SAFE_RUNNERS.has(bin)) {
    return { error: `Command not in allowlist: ${bin}` }
  }
  return { bin, args: parts.slice(1) }
}

export interface RunResult {
  output: string
  exitCode: number
}

/**
 * Run one of the allow-listed test/build commands, off the main thread, in the proc host. (The synchronous
 * `runSafeCommand` that used to sit beside it is gone: a synchronous child process on the main thread, bounded only by a
 * ten-minute timeout, froze every PTY and every IPC call for as long as `npm test` ran.)
 *
 * Same `RunResult` contract, including the part callers depend on most: a FAILED command is not an
 * exception, it is `{ output, exitCode }` with the command's own output — which for a test runner is
 * the whole point. Note the two shapes node uses for "what exit status": `status` on the sync API,
 * `code` on the async one. Both land here as `error.code`.
 */
export async function runSafeCommandAsync(cmd: SafeCommand, opts: GitOptions): Promise<RunResult> {
  // Same .cmd-shim reasoning as the sync version: parseSafeCommand already rejected every shell
  // metacharacter, so the shell is a PATHEXT resolver here and nothing more.
  const needsShell = process.platform === 'win32'
  const env = { ...process.env, PATH: await getExtendedPathAsync() }
  const procOpts = {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 10 * 60 * 1000,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    env,
  }
  const r = needsShell
    ? await execShellCaptureOffThread([cmd.bin, ...cmd.args].join(' '), procOpts)
    : await execCaptureOffThread(cmd.bin, cmd.args, procOpts)
  if (!r.error) return { output: r.stdout, exitCode: 0 }
  return {
    output: r.stdout + r.stderr,
    exitCode: typeof r.error.code === 'number' ? r.error.code : 1,
  }
}
