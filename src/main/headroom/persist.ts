import { writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getSettings, setSettings, type HeadroomSettings } from './config'
import { summarizeSavings, loadCumulativeBase, type SavingsTotals } from './savingsLedger'

const SETTINGS_FILE = 'headroom-settings.json'
const LEDGER_FILE = 'headroom-totals.json'

// Settings are merged through setSettings, which validates every field, so a file written by an older
// version needs no migration step of its own: a field it lacks keeps its default, and one it holds
// that is not valid reads as the default too. That is how firstSightElision (v1.55) reaches a file
// from v1.54: it has none, so it reads as 'late'. Held by tests/electron/headroomFirstSightSettings.test.ts.
export function loadSettingsFromDisk(dir: string): void {
  try {
    const raw = readFileSync(join(dir, SETTINGS_FILE), 'utf8')
    setSettings(JSON.parse(raw) as Partial<HeadroomSettings>)
  } catch { /* keep defaults */ }
}

export function saveSettingsToDisk(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify(getSettings()), 'utf8')
  } catch { /* best effort */ }
}

export function loadLedgerBaseFromDisk(dir: string): void {
  try {
    const raw = readFileSync(join(dir, LEDGER_FILE), 'utf8')
    loadCumulativeBase(JSON.parse(raw) as SavingsTotals)
  } catch { /* start at zero */ }
}

export function saveLedgerToDisk(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, LEDGER_FILE), JSON.stringify(summarizeSavings().cumulative), 'utf8')
  } catch { /* best effort */ }
}
