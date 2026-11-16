// Lumopolis settings (main process), persisted the way memorySettings.ts persists its own: a cached
// object backed by a small JSON file under userData, read lazily on first use, best effort on write.
// The file path is a parameter, so this module never imports Electron and the tests use a temp dir.
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { atomicWriteText } from '../agentConfigIO'

export interface WorldSettings {
  /**
   * "Describe parts with AI": name and explain districts, buildings and edges with the default
   * agent's cheapest model. ON by default; only a literal `false` turns it off, so a damaged or
   * hand-edited file never silently stops it. Off, the world still renders with code-derived names.
   */
  worldLabelling: boolean
}

export const DEFAULT_WORLD_SETTINGS: Readonly<WorldSettings> = { worldLabelling: true }

/** The file name under userData. */
export const WORLD_SETTINGS_FILE = 'world-settings.json'

export interface WorldSettingsStore {
  get(): WorldSettings
  /** Applies the known fields of `patch`, writes the file (best effort) and returns the new settings. */
  set(patch: Partial<WorldSettings>): WorldSettings
}

export function createWorldSettings(file: string | (() => string)): WorldSettingsStore {
  const path = (): string => (typeof file === 'function' ? file() : file)
  let settings: WorldSettings = { ...DEFAULT_WORLD_SETTINGS }
  let loaded = false

  const load = (): void => {
    if (loaded) return
    loaded = true
    try {
      const p = path()
      if (!existsSync(p)) return
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = { worldLabelling: (parsed as Record<string, unknown>).worldLabelling !== false }
      }
    } catch {
      // keep the defaults on any read or parse error
    }
  }

  return {
    get() {
      load()
      return { ...settings }
    },
    set(patch) {
      load()
      if (typeof patch?.worldLabelling === 'boolean') settings = { ...settings, worldLabelling: patch.worldLabelling }
      try {
        const p = path()
        mkdirSync(dirname(p), { recursive: true })
        atomicWriteText(p, JSON.stringify(settings, null, 2))
      } catch {
        // best effort: the setting still applies for this run
      }
      return { ...settings }
    }
  }
}
