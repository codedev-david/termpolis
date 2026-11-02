// Persisted, user-tunable memory settings (main process). Currently just the
// primer size — how many of the most relevant memories are injected when an
// agent launches or calls the memory_primer MCP tool. Lives in main (not
// renderer localStorage like the auto-primer on/off toggle) because the MCP
// primer handler runs here, so the setting must be readable server-side.
//
// Mirrors the persistence shape of aiSecurity.ts: a cached object backed by a
// small JSON file under userData, lazily initialized, best-effort on write.

import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { DEFAULT_PRIMER_LIMIT } from './contextPrimer'
import { atomicWriteText } from './agentConfigIO'

export interface MemorySettings {
  /** Memories injected per primer (banner + MCP memory_primer load). */
  primerLimit: number
  /**
   * int8 vector quantization — 4x less vector RAM, at the cost of storing an approximation.
   *
   * OFF by default, and that is the correct default: the saving only matters once the corpus is
   * large, and until then you would be trading exactness for headroom nobody needs. It is a pure
   * IN-RAM representation — the JSONL on disk always keeps exact floats and re-packs on load — so
   * this is losslessly reversible, which is exactly why it can be a runtime toggle instead of a
   * migration.
   */
  vectorQuantize: boolean
  /**
   * Bring Claude Code's saved notes (~/.claude/projects/*\/memory/*.md) into memory, so Codex and Antigravity
   * can find them too and a search finds them by their own wording. ON by default, and only ever acted on while
   * the user's agents are connected (the consent every agent integration is gated on). Turning it off stops
   * the reading; "Remove imported notes" takes what was read back out.
   */
  indexClaudeNotes: boolean
  /**
   * Let a search scoped to one project be handed up to two reference / feedback / user notes from another
   * (claudeNotesShare.ts). OFF by default (David, 2026-10-31): the store holds employer and personal projects
   * side by side, and a note that crosses over widens what goes into a prompt. Notes about one project's own
   * state never travel, on or off.
   */
  shareNotesAcrossProjects: boolean
}

// UI/UX bounds. The pure builder still hard-caps at 100; this keeps the panel
// control (and any bad persisted value) in a sane range.
export const PRIMER_LIMIT_MIN = 1
export const PRIMER_LIMIT_MAX = 50

function clampPrimerLimit(value: unknown): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_PRIMER_LIMIT
  return Math.min(PRIMER_LIMIT_MAX, Math.max(PRIMER_LIMIT_MIN, n))
}

let settings: MemorySettings = { primerLimit: DEFAULT_PRIMER_LIMIT, vectorQuantize: false, indexClaudeNotes: true, shareNotesAcrossProjects: false }
let initialized = false

function settingsPath(): string {
  return join(app.getPath('userData'), 'memory-settings.json')
}

function init(): void {
  if (initialized) return
  try {
    if (existsSync(settingsPath())) {
      const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = {
          primerLimit: clampPrimerLimit(parsed.primerLimit),
          // Absent key => false. A memory system defaults to EXACT; you opt in to the approximation.
          vectorQuantize: parsed.vectorQuantize === true,
          // Absent key => ON (never asked: the notes are a default, disclosed). A key that is there is somebody's answer, and
          // only a literal true is a yes: a hand-edited or damaged value must not agree for the user.
          indexClaudeNotes: 'indexClaudeNotes' in parsed ? parsed.indexClaudeNotes === true : true,
          // Absent key => OFF: nothing crosses between projects until the user says so.
          shareNotesAcrossProjects: parsed.shareNotesAcrossProjects === true,
        }
      } else {
        throw new Error('not a settings object')
      }
    }
  } catch {
    // Keep the defaults on any read/parse error, EXCEPT the notes import. Nothing throws here for a file that is not there, so
    // this is a file that is there and cannot be read (a write cut short by a crash, an antivirus lock): the user's answer is
    // lost, which is not the same as never having given one. The import stays off until they turn it on in Settings, where the
    // switch shows what is held.
    settings.indexClaudeNotes = false
  }
  initialized = true
}

/** Write the settings. False when they could not be written, so a caller that must not claim a choice was kept can say so. */
function persist(): boolean {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // Replaced whole, from a copy written beside it first: a crash cannot leave the file cut short, which is the one state the
    // notes switch has to fail closed on (init).
    atomicWriteText(settingsPath(), JSON.stringify(settings, null, 2))
    return true
  } catch {
    return false /* best effort for the tuning settings: a failed write just means the setting won't survive restart */
  }
}

/** A switch that is a privacy choice: kept, or not changed and said so. The panel shows what main holds, so a choice that could
 *  not be written must not be held either, or it would show OFF while the file says ON and the next start would import again. */
function saveSwitch(key: 'indexClaudeNotes' | 'shareNotesAcrossProjects', value: boolean): MemorySettings {
  if (!initialized) init()
  const before = settings[key]
  settings[key] = value
  // The file is written whenever it can be, so a damaged one is put right. A switch that is already what was asked for has
  // nothing in the file to keep, though: "Remove imported notes" turns the import off first, and an import that is off must not
  // have that removal refused because the settings file cannot be written.
  if (!persist() && value !== before) {
    settings[key] = before
    throw new Error('The setting could not be saved (the settings file could not be written)')
  }
  return getMemorySettings()
}

export function getMemorySettings(): MemorySettings {
  if (!initialized) init()
  return { ...settings }
}

export function getPrimerLimit(): number {
  if (!initialized) init()
  return settings.primerLimit
}

export function setPrimerLimit(value: unknown): MemorySettings {
  if (!initialized) init()
  settings.primerLimit = clampPrimerLimit(value)
  persist()
  return getMemorySettings()
}

export function getVectorQuantize(): boolean {
  if (!initialized) init()
  return settings.vectorQuantize
}

/** Persist the choice. Applying it (rebuilding the packed store) is swarmMemory's job — this
 *  module only remembers what the user picked, so the choice survives a restart. */
export function setVectorQuantize(value: unknown): MemorySettings {
  if (!initialized) init()
  settings.vectorQuantize = value === true
  persist()
  return getMemorySettings()
}

export function getIndexClaudeNotes(): boolean {
  if (!initialized) init()
  return settings.indexClaudeNotes
}

/** Persist the switch. Only a literal true turns it on: anything else is the user not having agreed. Throws, and changes nothing,
 *  when the choice could not be written. */
export function setIndexClaudeNotes(value: unknown): MemorySettings {
  return saveSwitch('indexClaudeNotes', value === true)
}

export function getShareNotesAcrossProjects(): boolean {
  if (!initialized) init()
  return settings.shareNotesAcrossProjects
}

/** Persist the switch. Only a literal true lets a note cross from one project to another. Throws, and changes nothing, when the
 *  choice could not be written. */
export function setShareNotesAcrossProjects(value: unknown): MemorySettings {
  return saveSwitch('shareNotesAcrossProjects', value === true)
}
