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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { DEFAULT_PRIMER_LIMIT } from './contextPrimer'

export interface MemorySettings {
  /** Memories injected per primer (banner + MCP memory_primer load). */
  primerLimit: number
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

let settings: MemorySettings = { primerLimit: DEFAULT_PRIMER_LIMIT }
let initialized = false

function settingsPath(): string {
  return join(app.getPath('userData'), 'memory-settings.json')
}

function init(): void {
  if (initialized) return
  try {
    if (existsSync(settingsPath())) {
      const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'))
      if (parsed && typeof parsed === 'object') {
        settings = { primerLimit: clampPrimerLimit(parsed.primerLimit) }
      }
    }
  } catch {
    /* keep defaults on any read/parse error */
  }
  initialized = true
}

function persist(): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
  } catch {
    /* best effort — a failed write just means the setting won't survive restart */
  }
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
