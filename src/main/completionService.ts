import { readdirSync, statSync, accessSync, constants } from 'fs'
import { join } from 'path'

export function listPathEntries(dirPath: string): { name: string; isDir: boolean }[] {
  try {
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

export function listPathCommands(): string[] {
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
  return commands.sort()
}

export function listEnvVars(): Record<string, string> {
  return { ...process.env } as Record<string, string>
}
