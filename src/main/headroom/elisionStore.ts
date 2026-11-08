import { readFileSync } from 'fs'
import { join } from 'path'
import { offMainFiles } from '../offMainFiles'
import { elisionState, elisionRevision, loadElisionState } from './elisionLedger'

/**
 * Where the elision ledger's lifetime counts live between launches: one small file beside
 * proxy-totals.json. Without it the redemption rate would restart from nothing every time the app
 * does, and the rolling window alone could not show a month's trend. Best effort throughout, like
 * the proxy totals: a file that cannot be read starts the count over, and one that cannot be
 * written costs the next launch its history, never a request.
 *
 * The save rides the debounce that already writes the totals, on the main thread, so it writes
 * only when a count has changed since the file last held them (a turn with no new elision and no
 * redemption writes nothing).
 */
export const ELISION_FILE = 'elision-ledger.json'

/** Where, and at which revision, the file last held exactly what the ledger holds. */
let savedDir: string | null = null
let savedRevision = -1

/** Adopt the counts a previous run left. A missing or unparseable file leaves the ledger as it is. */
export function loadElisionFromDisk(dir: string): void {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(join(dir, ELISION_FILE), 'utf8')) } catch { return /* start at zero */ }
  loadElisionState(raw)
  savedDir = dir
  savedRevision = elisionRevision()
}

export function saveElisionToDisk(dir: string): void {
  const revision = elisionRevision()
  if (dir === savedDir && revision === savedRevision) return
  // Off the main thread, like every other per-turn save (the 1.54.5 typing-lag fix): a sync write
  // here ran on each proxied turn. Marked saved up front so a second turn before the write lands
  // does not queue the same bytes again; a failed write clears the mark so the next save retries.
  savedDir = dir
  savedRevision = revision
  const retry = (): void => { if (savedDir === dir && savedRevision === revision) savedDir = null }
  void offMainFiles.write(join(dir, ELISION_FILE), JSON.stringify(elisionState())).catch(retry)
}
