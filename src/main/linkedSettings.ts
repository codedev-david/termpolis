// Whether Linked machines is on.
//
// One field, and it arrives from IPC, so it is validated here rather than at the
// call site. Off until the user asks, for the reason Remote is: a channel that
// lets another computer start agents on this one is not something an upgrade
// should switch on quietly. The relay URL is not repeated here -- linked
// machines dial the one Remote is set to (remoteSettings.ts).
import * as fs from 'fs'
import * as path from 'path'

export interface LinkedSettings {
  enabled: boolean
}

export const LINKED_SETTINGS_FILE = 'linked-settings.json'

/** Missing, corrupt and wrong-shaped all read as off. Only an explicit `true`
 *  enables: `'true'`, `1` and `{}` are truthy, and a check written
 *  `if (settings.enabled)` would honour every one of them. */
export function loadLinkedSettings(userDataDir: string): LinkedSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(userDataDir, LINKED_SETTINGS_FILE), 'utf8'))
  } catch {
    return { enabled: false }
  }
  const raw = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  return { enabled: raw.enabled === true }
}

/** Persist the switch, best effort. Only the known field is written, and only an
 *  explicit `true` as on. A failed write is swallowed: an unwritable userData
 *  directory must not abort the toggle it describes -- the user gets linked
 *  machines for this run and a switch that forgets on restart. */
export function saveLinkedSettings(userDataDir: string, s: LinkedSettings): void {
  try {
    const next: LinkedSettings = { enabled: s.enabled === true }
    fs.writeFileSync(path.join(userDataDir, LINKED_SETTINGS_FILE), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* see above */
  }
}
