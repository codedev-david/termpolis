import { promises as fsp, constants } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { mapLimit } from './asyncPool'

// Everything here runs on the thread pool. The terminal asks for these on every keystroke or Tab that opens a
// completion (completion:path-entries, completion:path-commands), and they used to be readdirSync / statSync /
// realpathSync / accessSync on the thread that pumps every PTY: the first request of a run, and every five minutes
// after, scanned every folder on PATH (and on Unix asked the OS about every file in each) before the key that
// started it could echo. Now the scan is asynchronous, bounded, shared between callers that ask at once, and an
// expired list is served stale while it is refreshed.

// Home and cwd are resolved once per process, not once per call. This used to realpathSync BOTH of
// them on EVERY getSafeRoots(), and isPathAllowed added a third realpathSync for the target — three
// synchronous resolutions behind completion:path-entries, which the terminal fires per keystroke/Tab,
// on the thread that pumps every PTY. Neither value can change while the process runs.
let safeRootsCache: string[] | null = null

/** Reset the safe-roots cache. Exported for test isolation only. */
export function resetSafeRootsCache(): void {
  safeRootsCache = null
}

async function getSafeRoots(): Promise<string[]> {
  if (safeRootsCache) return safeRootsCache
  const home = await fsp.realpath(homedir())
  const roots = [home]
  try {
    const cwd = await fsp.realpath(process.cwd())
    if (!cwd.startsWith(home)) roots.push(cwd)
  } catch {}
  safeRootsCache = roots
  return roots
}

async function isPathAllowed(targetPath: string): Promise<boolean> {
  const resolved = await fsp.realpath(targetPath)
  return (await getSafeRoots()).some(root => resolved.startsWith(root))
}

/** How many symlinked entries are looked through at once (a bin folder can hold thousands). */
const STAT_CONCURRENCY = 16

export async function listPathEntries(dirPath: string): Promise<{ name: string; isDir: boolean }[]> {
  try {
    if (!(await isPathAllowed(dirPath))) return []
    // withFileTypes takes each entry's kind from the directory read the OS already performed. The
    // old code paid an extra statSync PER ENTRY to re-ask what readdir had just told it — N+1
    // syscalls for a listing that autocomplete requests on every keystroke.
    const entries = await fsp.readdir(dirPath, { withFileTypes: true })
    return await mapLimit(entries, STAT_CONCURRENCY, async entry => {
      try {
        // A symlink is the one kind a Dirent cannot answer for: it reports "symlink", not what it
        // points AT, and stat followed the link before. Only these still cost a stat, so a
        // symlinked directory keeps completing as a directory.
        if (entry.isSymbolicLink()) {
          return { name: entry.name, isDir: (await fsp.stat(join(dirPath, entry.name))).isDirectory() }
        }
        return { name: entry.name, isDir: entry.isDirectory() }
      } catch {
        return { name: entry.name, isDir: false }
      }
    })
  } catch {
    return []
  }
}

// Cache PATH commands for 5 minutes to avoid repeated filesystem scans
let pathCommandsCache: string[] | null = null
let pathCommandsCacheTime = 0
let pathCommandsScan: Promise<string[]> | null = null
const CACHE_TTL = 5 * 60 * 1000

/** PATH folders read at once, and files on Unix asked "can I run you" at once. */
const DIR_CONCURRENCY = 4
const ACCESS_CONCURRENCY = 32

/** Reset the PATH-commands cache. Exported for test isolation only. */
export function resetPathCommandsCache(): void {
  pathCommandsCache = null
  pathCommandsCacheTime = 0
  pathCommandsScan = null
}

async function scanPathCommands(): Promise<string[]> {
  const pathDirs = (process.env.PATH || process.env.Path || '').split(process.platform === 'win32' ? ';' : ':')
  const winExts = ['.exe', '.cmd', '.bat', '.ps1', '.com']
  const win = process.platform === 'win32'

  // One list per PATH folder, merged below in PATH order: the first folder to hold a name decides how it is
  // spelled, as when the folders were read one after the other.
  const perDir = await mapLimit(pathDirs, DIR_CONCURRENCY, async (dir): Promise<string[]> => {
    try {
      const names = await fsp.readdir(dir)
      if (win) return names.filter(name => winExts.some(ext => name.toLowerCase().endsWith(ext)))
      const runnable = await mapLimit(names, ACCESS_CONCURRENCY, async name => {
        try {
          await fsp.access(join(dir, name), constants.X_OK)
          return true
        } catch {
          return false
        }
      })
      return names.filter((_, i) => runnable[i])
    } catch {
      return []
    }
  })

  const seen = new Set<string>()
  const commands: string[] = []
  for (const names of perDir) {
    for (const name of names) {
      if (win) {
        const base = name.replace(/\.[^.]+$/, '')
        if (!seen.has(base.toLowerCase())) {
          seen.add(base.toLowerCase())
          commands.push(base)
        }
      } else if (!seen.has(name)) {
        seen.add(name)
        commands.push(name)
      }
    }
  }
  return commands.sort()
}

/**
 * The commands on PATH, for completion. Scanned once per five minutes at most, by one scan however many ask while
 * it runs. The scan is on the thread pool: the request that triggers it waits for it, the main thread does not.
 */
export function listPathCommands(): Promise<string[]> {
  const now = Date.now()
  if (pathCommandsCache && now - pathCommandsCacheTime < CACHE_TTL) return Promise.resolve(pathCommandsCache)
  if (!pathCommandsScan) {
    const scan = scanPathCommands().then((commands) => {
      pathCommandsCache = commands
      pathCommandsCacheTime = Date.now()
      return commands
    })
    pathCommandsScan = scan
    const clear = (): void => { if (pathCommandsScan === scan) pathCommandsScan = null }
    scan.then(clear, clear)
  }
  return pathCommandsScan
}

const SAFE_ENV_VARS = new Set([
  'PATH', 'Path', 'SHELL', 'TERM', 'HOME', 'USERPROFILE', 'USER', 'USERNAME',
  'LANG', 'LC_ALL', 'EDITOR', 'VISUAL', 'PAGER',
  'PWD', 'OLDPWD', 'HOSTNAME', 'COMPUTERNAME',
  'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'TMPDIR', 'TEMP', 'TMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
])

export function listEnvVars(): Record<string, string> {
  const filtered: Record<string, string> = {}
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key]) filtered[key] = process.env[key]!
  }
  return filtered
}
