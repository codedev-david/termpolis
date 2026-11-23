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
import { promises as fsPromises } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { filterOverrides, filterScanArgs, guardGitArgs, guardGitEnv, needsFilterScan } from './gitSafety'
import { withSubmoduleEdits, type DirtySubmodule, type SubmoduleDeps } from './gitSubmodules'

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
 * name: on Windows a bare `git` with `cwd` at a repository runs a `git.exe` planted in that repository. A git that
 * lies inside the folder it would run in is refused too. When there is no git, nothing is started and the call
 * fails with code 'ENOENT', exactly as a missing git always did, so every caller degrades as it did before.
 */
export function safeGitAsync(args: string[], opts: GitOptions): Promise<string> {
  return guardedGit(args, opts, 0)
}

/** safeGitAsync, `depth` submodules below the status that started it (gitSubmodules.ts MAX_DEPTH). */
async function guardedGit(args: string[], opts: GitOptions, depth: number): Promise<string> {
  const bin = await resolveGitBin()
  if (bin === null || (await binInsideFolder(bin, opts.cwd))) throw gitNotFound()
  // The one chokepoint for git safety (gitSafety.ts): a read never runs a program the repository's own config,
  // hooks or attributes name; a write runs exactly as the person's git would. status and diff first read which
  // filter drivers the repository defines, so each can be switched off by name.
  const isWindows = process.platform === 'win32'
  try {
    const overrides = needsFilterScan(args) ? await repoFilterOverrides(bin, args, opts, isWindows) : []
    const out = await execOffThread(bin, guardGitArgs(args, isWindows, overrides), {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 10000,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
      // GIT_NO_LAZY_FETCH for a read: a partial clone missing an object never starts a fetch (gitSafety.ts).
      addEnv: guardGitEnv(args),
    })
    // A status leaves each submodule's dirty state out (its own config would run); it is asked for here, one guarded
    // status per submodule, and written back in (gitSubmodules.ts). Any other command comes back as git wrote it.
    return await withSubmoduleEdits(args, opts.cwd, out, depth, submoduleDeps(opts), cachedDirtySubmodules)
  } catch (e) {
    // `code` still means what it always meant: the string 'ENOENT' when the binary was not found, a number when
    // git ran and refused. ProcError carries it across the process boundary. The git found earlier has gone
    // (uninstalled or moved): look for it again on the next call.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') forgetGitBin()
    throw e
  }
}

/** How long one repository's filter-driver scan is reused while the config files it reads say the same: a ceiling,
 *  so a change nothing below notices (the person's own global config, say) is seen within it. */
const FILTER_SCAN_TTL_MS = 30_000
/** The window where the config cannot be watched: outside a repository, or a repository whose own config includes
 *  another file. The git cache's own window (gitCache.ts GIT_CACHE_TTL_MS), so one tick's panels still share a scan. */
const FILTER_SCAN_SHORT_TTL_MS = 1500
/** Scans remembered at once; expired ones go first, then the oldest. */
const FILTER_SCAN_MAX = 64
const filterScans = new Map<string, { at: number; ttl: number; stamp: string; value: Promise<string[]> }>()

/**
 * The `-c` options that switch off the filter drivers the repository at `opts.cwd` defines (gitSafety.ts
 * filterOverrides). `git config --get-regexp` exits 1 when nothing matches: no driver, nothing to switch off. Any
 * other failure, or a driver that cannot be switched off, fails the read itself: it is never run with a driver left on.
 *
 * One scan serves every folder of a repository (keyed on its git folder) for up to FILTER_SCAN_TTL_MS, and is read
 * again as soon as the text of the repository's config or config.worktree changes. Accepted race: a config edit that
 * lands after those files are read and before the command itself starts (a few milliseconds) is not seen by that one
 * command; the next read sees it. A file the repository's config includes is not read here, so such a repository
 * keeps the short window, as does a folder outside any repository.
 */
async function repoFilterOverrides(bin: string, args: string[], opts: GitOptions, isWindows: boolean): Promise<string[]> {
  const scanArgs = filterScanArgs(args, isWindows)
  // Reading the config files can only fail oddly (a folder that vanished, a test's stand-in fs): the short window then.
  const place = await scanPlace(opts.cwd, scanArgs)
    .catch(() => ({ key: resolve(opts.cwd), args: scanArgs, stamp: '', ttl: FILTER_SCAN_SHORT_TTL_MS }))
  const key = `${place.key}\u0000${place.args.join('\u0000')}`
  const now = Date.now()
  const hit = filterScans.get(key)
  if (hit && now - hit.at < hit.ttl && hit.stamp === place.stamp) return hit.value
  const value = execOffThread(bin, scanArgs, { cwd: opts.cwd, timeout: opts.timeout ?? 10000, maxBuffer: 1024 * 1024, addEnv: guardGitEnv(scanArgs) })
    .catch((e: unknown) => {
      if ((e as { code?: unknown } | null)?.code === 1) return ''
      throw e
    })
    .then(filterOverrides)
  for (const [k, v] of filterScans) if (now - v.at >= v.ttl) filterScans.delete(k)
  filterScans.delete(key)
  filterScans.set(key, { at: now, ttl: place.ttl, stamp: place.stamp, value })
  if (filterScans.size > FILTER_SCAN_MAX) filterScans.delete(filterScans.keys().next().value as string)
  value.catch(() => {
    if (filterScans.get(key)?.value === value) filterScans.delete(key)
  })
  return value
}

/** Where a scan reads its config: the key that names the repository, the scan's arguments without the `-C` already
 *  folded into that key, the text of the config files (the stamp) and how long the scan may be kept. */
async function scanPlace(cwd: string, scanArgs: readonly string[]): Promise<{ key: string; args: string[]; stamp: string; ttl: number }> {
  let base = resolve(cwd)
  let gitDirArg: string | undefined
  const args: string[] = []
  for (let i = 0; i < scanArgs.length; i++) {
    const a = scanArgs[i]
    if (a === '-C' && i + 1 < scanArgs.length) base = resolve(base, scanArgs[++i])
    else {
      if (a === '--git-dir' && i + 1 < scanArgs.length) gitDirArg = scanArgs[i + 1]
      else if (a.startsWith('--git-dir=')) gitDirArg = a.slice('--git-dir='.length)
      args.push(a)
    }
  }
  const dirs = gitDirArg !== undefined ? await gitDirs(resolve(base, gitDirArg)) : await findGitDirs(base)
  if (dirs === null) return { key: base, args, stamp: '', ttl: FILTER_SCAN_SHORT_TTL_MS }
  const texts = await Promise.all([join(dirs.common, 'config'), join(dirs.gitDir, 'config.worktree')].map(readOrEmpty))
  const includes = texts.some((t) => /^\s*\[\s*include/im.test(t))
  return { key: dirs.gitDir, args, stamp: texts.join('\u0000'), ttl: includes ? FILTER_SCAN_SHORT_TTL_MS : FILTER_SCAN_TTL_MS }
}

async function readOrEmpty(file: string): Promise<string> {
  return fsPromises.readFile(file, 'utf8').catch(() => '')
}

/** The git folder for the repository at or above `dir` (following a `.git` file's `gitdir:`), or null. */
async function findGitDirs(dir: string): Promise<{ gitDir: string; common: string } | null> {
  for (let at = dir; ; at = dirname(at)) {
    const dotGit = join(at, '.git')
    const st = await fsPromises.stat(dotGit).catch(() => null)
    if (st?.isDirectory()) return gitDirs(dotGit)
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readOrEmpty(dotGit))
      return m ? gitDirs(resolve(at, m[1])) : null
    }
    if (dirname(at) === at) return null
  }
}

/** A git folder and the common folder its `commondir` names (a linked worktree's), or itself. */
async function gitDirs(gitDir: string): Promise<{ gitDir: string; common: string }> {
  const common = (await readOrEmpty(join(gitDir, 'commondir'))).trim()
  return { gitDir, common: common === '' ? gitDir : resolve(gitDir, common) }
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
    git: (args, cwd, depth) => guardedGit(args, { cwd, timeout: opts.timeout, maxBuffer: opts.maxBuffer }, depth),
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
