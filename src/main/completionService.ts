import { readdirSync, statSync, realpathSync, accessSync, constants } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Home and cwd are resolved once per process, not once per call. This used to realpathSync BOTH of
// them on EVERY getSafeRoots(), and isPathAllowed added a third realpathSync for the target — three
// synchronous resolutions behind completion:path-entries, which the terminal fires per keystroke/Tab,
// on the thread that pumps every PTY. Neither value can change while the process runs.
let safeRootsCache: string[] | null = null

/** Reset the safe-roots cache. Exported for test isolation only. */
export function resetSafeRootsCache(): void {
  safeRootsCache = null
}

function getSafeRoots(): string[] {
  if (safeRootsCache) return safeRootsCache
  const home = realpathSync(homedir())
  const roots = [home]
  try {
    const cwd = realpathSync(process.cwd())
    if (!cwd.startsWith(home)) roots.push(cwd)
  } catch {}
  safeRootsCache = roots
  return roots
}

function isPathAllowed(targetPath: string): boolean {
  const resolved = realpathSync(targetPath)
  return getSafeRoots().some(root => resolved.startsWith(root))
}

export function listPathEntries(dirPath: string): { name: string; isDir: boolean }[] {
  try {
    if (!isPathAllowed(dirPath)) return []
    // withFileTypes takes each entry's kind from the directory read the OS already performed. The
    // old code paid an extra statSync PER ENTRY to re-ask what readdir had just told it — N+1
    // syscalls for a listing that autocomplete requests on every keystroke.
    return readdirSync(dirPath, { withFileTypes: true }).map(entry => {
      try {
        // A symlink is the one kind a Dirent cannot answer for: it reports "symlink", not what it
        // points AT, and statSync followed the link before. Only these still cost a stat, so a
        // symlinked directory keeps completing as a directory.
        if (entry.isSymbolicLink()) {
          return { name: entry.name, isDir: statSync(join(dirPath, entry.name)).isDirectory() }
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
const CACHE_TTL = 5 * 60 * 1000

/** Reset the PATH-commands cache. Exported for test isolation only. */
export function resetPathCommandsCache(): void {
  pathCommandsCache = null
  pathCommandsCacheTime = 0
}

export function listPathCommands(): string[] {
  const now = Date.now()
  if (pathCommandsCache && now - pathCommandsCacheTime < CACHE_TTL) {
    return pathCommandsCache
  }

  const pathDirs = (process.env.PATH || process.env.Path || '').split(process.platform === 'win32' ? ';' : ':')
  const winExts = ['.exe', '.cmd', '.bat', '.ps1', '.com']
  const seen = new Set<string>()
  const commands: string[] = []

  for (const dir of pathDirs) {
    try {
      for (const name of readdirSync(dir)) {
        const lower = name.toLowerCase()
        if (process.platform === 'win32') {
          if (winExts.some(ext => lower.endsWith(ext))) {
            const base = name.replace(/\.[^.]+$/, '')
            if (!seen.has(base.toLowerCase())) {
              seen.add(base.toLowerCase())
              commands.push(base)
            }
          }
        } else {
          try {
            accessSync(join(dir, name), constants.X_OK)
            if (!seen.has(name)) {
              seen.add(name)
              commands.push(name)
            }
          } catch {}
        }
      }
    } catch {}
  }

  pathCommandsCache = commands.sort()
  pathCommandsCacheTime = now
  return pathCommandsCache
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
