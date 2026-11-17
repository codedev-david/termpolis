// Lumopolis settings (main process), persisted the way memorySettings.ts persists its own: a cached
// object backed by a small JSON file under userData, read lazily on first use, best effort on write.
// The file path is a parameter, so this module never imports Electron and the tests use a temp dir.
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { atomicWriteText } from '../agentConfigIO'
import { isExecAgent, type ExecAgent } from '../headlessExec'

export interface WorldSettings {
  /**
   * "Describe parts with AI": name and explain districts, buildings and edges with Claude's
   * cheapest model (Haiku). ON by default; only a literal `false` turns it off, so a damaged or
   * hand-edited file never silently stops it. Off, the world still renders with code-derived names.
   */
  worldLabelling: boolean
  /** "Read Lumopolis answers aloud": OFF by default; only a literal `true` turns it on. */
  worldSpeakAnswers: boolean
  /** The agent that answers questions, drafts designs and (cheapest model) describes parts. Claude by default; an unknown value reads as claude. */
  worldAgent: ExecAgent
}

export const DEFAULT_WORLD_SETTINGS: Readonly<WorldSettings> = { worldLabelling: true, worldSpeakAnswers: false, worldAgent: 'claude' }

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
        const rec = parsed as Record<string, unknown>
        settings = { worldLabelling: rec.worldLabelling !== false, worldSpeakAnswers: rec.worldSpeakAnswers === true, worldAgent: isExecAgent(rec.worldAgent) ? rec.worldAgent : 'claude' }
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
      if (typeof patch?.worldSpeakAnswers === 'boolean') settings = { ...settings, worldSpeakAnswers: patch.worldSpeakAnswers }
      if (isExecAgent(patch?.worldAgent)) settings = { ...settings, worldAgent: patch.worldAgent }
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
