// Lumopolis settings (main process): a cached object backed by a small JSON file under userData.
// Nothing here blocks the main thread: `ready()` loads the file once with fs/promises, `get()` reads
// the cache, and `set()` changes the cache at once and queues one atomic write, so several quick
// sets write the file once with the last values. Writes are best effort.
// The file path is a parameter, so this module never imports Electron and the tests use a temp dir.
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
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
  /**
   * "Read CI results with GitHub CLI": ON by default (David, 2026-11-18); only a literal `false` turns it off. On,
   * Lumopolis runs the `gh` command (which uses its own stored GitHub login) to read the newest CI result, and only
   * for a repository with a GitHub remote when `gh` is on PATH. Off, the compile never starts `gh`, nor git for CI.
   */
  worldCiResults: boolean
  /** The agent that answers questions, drafts designs and (cheapest model) describes parts. Claude by default; an unknown value reads as claude. */
  worldAgent: ExecAgent
  /** Lumopolis has been opened at least once: the sidebar's "New" badge and the 2.0 hint stop showing. Only a literal `true` counts. */
  worldOpened: boolean
  /** The "New in 2.0" hint was dismissed: it never shows again. Only a literal `true` counts. */
  worldHintDismissed: boolean
  /** Settings ▸ Lumopolis ▸ Show frame rate: the 3D map's corner readout of fps, p95 and tier (look spec §6.1). Off by default. */
  showFrameRate: boolean
}

export const DEFAULT_WORLD_SETTINGS: Readonly<WorldSettings> = { worldLabelling: true, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude', worldOpened: false, worldHintDismissed: false, showFrameRate: false }

/** The file name under userData. */
export const WORLD_SETTINGS_FILE = 'world-settings.json'

export interface WorldSettingsStore {
  /** The cached settings; the defaults until `ready()` has loaded the file. */
  get(): WorldSettings
  /** Loads the file once (later calls share the first load). Never rejects. */
  ready(): Promise<void>
  /** Applies the known fields of `patch` at once, queues a write (best effort) and returns the new settings. */
  set(patch: Partial<WorldSettings>): WorldSettings
  /** Resolves once every queued write has finished. Never rejects. */
  flush(): Promise<void>
}

function parse(text: string): WorldSettings | null {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const rec = parsed as Record<string, unknown>
  return { worldLabelling: rec.worldLabelling !== false, worldSpeakAnswers: rec.worldSpeakAnswers === true, worldCiResults: rec.worldCiResults !== false, worldAgent: isExecAgent(rec.worldAgent) ? rec.worldAgent : 'claude', worldOpened: rec.worldOpened === true, worldHintDismissed: rec.worldHintDismissed === true, showFrameRate: rec.showFrameRate === true }
}

let tmpCounter = 0

/** Best-effort steps swallow their failure. */
const ignore = (): void => undefined

/** Writes `text` beside `p` and renames it into place, so a reader never sees half a file. */
async function writeAtomic(p: string, text: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}-${++tmpCounter}`
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, p)
  } catch (e) {
    await rm(tmp, { force: true }).catch(ignore)
    throw e
  }
}

export function createWorldSettings(file: string | (() => string)): WorldSettingsStore {
  const path = (): string => (typeof file === 'function' ? file() : file)
  let settings: WorldSettings = { ...DEFAULT_WORLD_SETTINGS }
  // Fields set before the file finished loading win over the file's values.
  let early: Partial<WorldSettings> = {}
  let loaded = false
  let loading: Promise<void> | null = null
  let writing: Promise<void> = Promise.resolve()
  let queued = false

  const ready = (): Promise<void> => {
    loading ??= (async () => {
      try {
        const fromFile = parse(await readFile(path(), 'utf8'))
        if (fromFile) settings = { ...fromFile, ...early }
      } catch {
        // keep the defaults on a missing file, a read or parse error, or a path that throws
      }
      loaded = true
      early = {}
    })()
    return loading
  }

  const queueWrite = (): void => {
    if (queued) return
    queued = true
    writing = writing
      .then(() => ready())
      .then(() => {
        queued = false
        return writeAtomic(path(), JSON.stringify(settings, null, 2))
      })
      // best effort: the setting still applies for this run
      .catch(ignore)
  }

  return {
    get() {
      return { ...settings }
    },
    ready,
    set(patch) {
      const next: Partial<WorldSettings> = {}
      if (typeof patch?.worldLabelling === 'boolean') next.worldLabelling = patch.worldLabelling
      if (typeof patch?.worldSpeakAnswers === 'boolean') next.worldSpeakAnswers = patch.worldSpeakAnswers
      if (typeof patch?.worldCiResults === 'boolean') next.worldCiResults = patch.worldCiResults
      if (isExecAgent(patch?.worldAgent)) next.worldAgent = patch.worldAgent
      if (typeof patch?.worldOpened === 'boolean') next.worldOpened = patch.worldOpened
      if (typeof patch?.worldHintDismissed === 'boolean') next.worldHintDismissed = patch.worldHintDismissed
      if (typeof patch?.showFrameRate === 'boolean') next.showFrameRate = patch.showFrameRate
      settings = { ...settings, ...next }
      if (!loaded) early = { ...early, ...next }
      queueWrite()
      return { ...settings }
    },
    flush() {
      return writing
    }
  }
}
