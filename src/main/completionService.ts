import { readdirSync, statSync, realpathSync, accessSync, constants } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

function getSafeRoots(): string[] {
  const home = realpathSync(homedir())
  const roots = [home]
  try {
    const cwd = realpathSync(process.cwd())
    if (!cwd.startsWith(home)) roots.push(cwd)
  } catch {}
  return roots
}

function isPathAllowed(targetPath: string): boolean {
  const resolved = realpathSync(targetPath)
  return getSafeRoots().some(root => resolved.startsWith(root))
}

export function listPathEntries(dirPath: string): { name: string; isDir: boolean }[] {
  try {
    if (!isPathAllowed(dirPath)) return []
    return readdirSync(dirPath).map(name => {
      try {
        return { name, isDir: statSync(join(dirPath, name)).isDirectory() }
      } catch {
        return { name, isDir: false }
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
