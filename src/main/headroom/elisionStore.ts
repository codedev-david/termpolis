import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { elisionState, loadElisionState } from './elisionLedger'

/**
 * Where the elision ledger's lifetime counts live between launches: one small file beside
 * proxy-totals.json. Without it the redemption rate would restart from nothing every time the app
 * does, and the rolling window alone could not show a month's trend. Best effort throughout, like
 * the proxy totals: a file that cannot be read starts the count over, and one that cannot be
 * written costs the next launch its history, never a request.
 */
export const ELISION_FILE = 'elision-ledger.json'

/** Adopt the counts a previous run left. A missing or unparseable file leaves the ledger as it is. */
export function loadElisionFromDisk(dir: string): void {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(join(dir, ELISION_FILE), 'utf8')) } catch { return /* start at zero */ }
  loadElisionState(raw)
}

export function saveElisionToDisk(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ELISION_FILE), JSON.stringify(elisionState()), 'utf8')
  } catch { /* best effort */ }
}
