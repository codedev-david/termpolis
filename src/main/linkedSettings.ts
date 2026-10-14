// Whether Linked machines is on, and whether it says so when another computer starts a job here.
//
// They arrive from IPC, so they are validated here rather than at the call site. Off until the
// user asks, for the reason Remote is: a channel that lets another computer start agents on this
// one is not something an upgrade should switch on quietly. Notifications are the other way round:
// on unless the user switches them off, because nothing asks per job and they are how the user
// sees what the grants let through. The relay URL is not repeated here -- linked machines dial the
// one Remote is set to (remoteSettings.ts).
import * as fs from 'fs'
import * as path from 'path'

export interface LinkedSettings {
  enabled: boolean
  /** `false` turns job notifications off. Absent is on, and is how on is written: a file from
   *  before notifications existed, or one a user never changed, reads the same. */
  notifyJobs?: boolean
}

export const LINKED_SETTINGS_FILE = 'linked-settings.json'

/** Whether jobs another computer starts here are notified. */
export const notifiesJobs = (s: LinkedSettings): boolean => s.notifyJobs !== false

/** The settings with only the known fields, each in its safe direction: on only for an explicit
 *  `true`, notifications off only for an explicit `false`. `'true'`, `1` and `{}` are truthy, and a
 *  check written `if (settings.enabled)` would honour every one of them. */
function clean(raw: Record<string, unknown>): LinkedSettings {
  return { enabled: raw.enabled === true, ...(raw.notifyJobs === false ? { notifyJobs: false } : {}) }
}

/** Missing, corrupt and wrong-shaped all read as off, with notifications on. */
export function loadLinkedSettings(userDataDir: string): LinkedSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(userDataDir, LINKED_SETTINGS_FILE), 'utf8'))
  } catch {
    return { enabled: false }
  }
  return clean(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {})
}

/** Persist the settings, best effort, writing only the known fields. A failed write is swallowed:
 *  an unwritable userData directory must not abort the toggle it describes -- the user gets the
 *  change for this run and a setting that forgets on restart. */
export function saveLinkedSettings(userDataDir: string, s: LinkedSettings): void {
  try {
    fs.writeFileSync(path.join(userDataDir, LINKED_SETTINGS_FILE), JSON.stringify(clean({ ...s }), null, 2), 'utf8')
  } catch {
    /* see above */
  }
}
