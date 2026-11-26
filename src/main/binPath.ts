// Where a program is, found without starting anything. Used for `git` everywhere the app and the world host run it
// (gitCommand.ts), and for `gh` (Lumopolis CI results). The Commit Shield hook, which git starts in a plain `node`, finds
// git by the same rules through its synchronous twin, src/mcp-adapter/binPath.cjs.
//
// Why it exists: on Windows, a program started by its bare name (`git`) is looked for in the folder the process
// runs in BEFORE the PATH folders. Git runs with its working folder set to a repository, and Lumopolis maps any
// repository the user clones, so a `git.exe` committed to a repository would run instead of the real git. Every
// program here is therefore started by the full path this module finds, and never by its bare name.
//
// The rules: only PATH folders fixed on disk count (relative entries, `.` and the current folder are skipped), then
// the known install locations; on Windows only `<name>.exe` (started without a shell, so a `.cmd` or `.bat` would
// need one); the file must be a regular file this process may run; a program inside the folder it would run in is
// refused (see binInside). Nothing is started to look: only async file checks, so it is safe on the main thread
// and in the utility processes alike. No Electron imports: the world host uses it too.

import * as fsp from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/** A PATH folder that names one place whatever the current folder is: on Windows a drive path (`C:\…`) or a share
 *  (`\\server\…`), never `\tools` or `C:tools`, which hang off the current drive or folder. */
const FIXED_WIN_DIR = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/

/** The full path of the program `name` in the PATH folders, or null. Only a folder fixed on disk counts: relative
 *  entries, `.` and the current folder (`cwd`) are skipped, so a program planted in a repository never answers. On
 *  Windows only `name.exe` counts: it is started without a shell, and a `.cmd` or `.bat` would need one, so they
 *  are refused rather than run. `runnable` throws for a file that is missing or may not be run; it is the only
 *  thing that touches the disk, and nothing is started. */
export async function commandOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  runnable: (file: string) => Promise<unknown>,
  cwd?: string
): Promise<string | null> {
  const win = platform === 'win32'
  const p = win ? win32 : posix
  const key = (dir: string): string => {
    const n = p.normalize(dir).replace(/[\\/]+$/, '')
    return win ? n.toLowerCase() : n
  }
  const here = cwd === undefined ? null : key(cwd)
  const dirs = (env.PATH ?? env.Path ?? '').replace(/"/g, '').split(win ? ';' : ':')
  for (const dir of dirs) {
    if (!(win ? FIXED_WIN_DIR.test(dir) : p.isAbsolute(dir)) || key(dir) === here) continue
    const file = p.join(dir, win ? name + '.exe' : name)
    try {
      await runnable(file)
      return file
    } catch {
      // not in this folder, or not a program this process may run
    }
  }
  return null
}

/** Throws unless `file` is a regular file this process may run (the execute bit on POSIX; on Windows X_OK only
 *  checks that it exists, so the regular-file check is what keeps a folder named `git.exe` out). */
export async function assertRunnable(
  file: string,
  fs: { stat: (f: string) => Promise<{ isFile: () => boolean }>; access: (f: string, mode: number) => Promise<unknown> },
  xOk: number
): Promise<void> {
  if (!(await fs.stat(file)).isFile()) throw new Error('not a file')
  await fs.access(file, xOk)
}

/** Where git is installed when the PATH does not name it: a packaged app started from the Start menu may have no
 *  git on its PATH. The one list, for main and the world host alike. */
export function gitInstallCandidates(platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe']
    : ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git', '/bin/git']
}

/** The full path of git: the PATH folders first (commandOnPath's rules), then the install locations. Null when
 *  there is none. Never the bare name `git`. */
export async function findGit(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  runnable: (file: string) => Promise<unknown>,
  cwd?: string
): Promise<string | null> {
  const onPath = await commandOnPath('git', env, platform, runnable, cwd)
  if (onPath !== null) return onPath
  for (const candidate of gitInstallCandidates(platform)) {
    try {
      await runnable(candidate)
      return candidate
    } catch {
      // not installed here
    }
  }
  return null
}

/** Whether `file` lies inside the folder `root`, compared case-blind with either slash (which can only refuse more). */
export function insideFolder(file: string, root: string): boolean {
  const n = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return n(file).startsWith(n(root) + '/')
}

/** Whether the program `file` lies inside the folder `root`, as written or after following links (a program reached
 *  through a junction into the folder counts as inside). A path that cannot be resolved is compared as written. */
export async function binInside(file: string, root: string, realpath: (p: string) => Promise<string>): Promise<boolean> {
  if (insideFolder(file, root)) return true
  const real = (p: string): Promise<string> => realpath(p).catch(() => p)
  const [realFile, realRoot] = await Promise.all([real(file), real(root)])
  return insideFolder(realFile, realRoot)
}

/** How long "git is not installed" is believed before looking again (so installing git shows up within a minute). */
export const GIT_MISS_TTL_MS = 60_000

export interface BinResolver {
  /** The full path, or null when the program is not installed. Looked up once; concurrent callers share the look. */
  get: () => Promise<string | null>
  /** Forget the answer (the program it named has gone): the next get() looks again. */
  forget: () => void
}

/** Caches `find`: a path found is kept until forget(), a miss for `missTtlMs`. */
export function createBinResolver(find: () => Promise<string | null>, now: () => number, missTtlMs: number): BinResolver {
  let found: { at: number; path: string | null } | null = null
  let looking: Promise<string | null> | null = null
  const get = (): Promise<string | null> => {
    if (found && (found.path !== null || now() - found.at < missTtlMs)) return Promise.resolve(found.path)
    if (looking) return looking
    looking = find()
      .catch(() => null)
      .then((path) => {
        found = { at: now(), path }
        looking = null
        return path
      })
    return looking
  }
  return {
    get,
    forget: () => {
      found = null
    }
  }
}

const runnableFile = (f: string): Promise<void> => assertRunnable(f, fsp, fsp.constants.X_OK)

/** This process's git: found once in this process's PATH (never its current folder) or the install locations. */
const gitResolver = createBinResolver(() => findGit(process.env, process.platform, runnableFile, process.cwd()), () => Date.now(), GIT_MISS_TTL_MS)

/** The full path of git for this process, or null when git is not installed. Never the bare name `git`. */
export const resolveGitBin = (): Promise<string | null> => gitResolver.get()
/** The git found earlier is gone (starting it said ENOENT): look again next time. */
export const forgetGitBin = (): void => gitResolver.forget()
/** Whether the program `file` lies inside `root`, following links on the real disk. */
export const binInsideFolder = (file: string, root: string): Promise<boolean> => binInside(file, root, (p) => fsp.realpath(p))
/** Whether `file` is a regular file this process may run (rejects otherwise). */
export const assertRunnableFile = runnableFile
