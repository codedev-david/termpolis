// The registry of phones the user has paired and not revoked.
//
// This file is the authorization boundary for the whole remote feature: what it
// says a device may do is what the bridge lets that device do. So it is read
// defensively and written plainly -- every field is validated on the way in,
// unknown keys are dropped, and a capability that is absent or not a boolean
// reads as `false`. Permission is granted here only by an explicit `true`.
//
// Not encrypted at rest: it holds public keys and flags, nothing secret. The
// identity secret lives in remoteIdentityStore, behind safeStorage.
import * as fs from 'fs'
import * as path from 'path'
import { NO_CAPABILITIES, type Capabilities, type PairedDevice } from './remoteBridge/protocol'

const DEVICES_FILE = 'remote-devices.json'

export function remoteDevicesPath(userDataDir: string): string {
  return path.join(userDataDir, DEVICES_FILE)
}

type Unknown = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** `=== true` and not `Boolean(v)`: `'false'`, `1` and `{}` are all truthy, and a
 *  capability check reading `if (caps.writeToTerminal)` would honour every one. */
function capabilities(v: unknown): Capabilities {
  const raw = (typeof v === 'object' && v !== null ? v : {}) as Unknown
  const keys = Object.keys(NO_CAPABILITIES) as (keyof Capabilities)[]
  const out = { ...NO_CAPABILITIES }
  for (const key of keys) out[key] = raw[key] === true
  return out
}

/** One entry, or null if it is not a device. Rebuilt field by field rather than
 *  spread, so nothing the file invented survives into the running registry. */
function device(v: unknown): PairedDevice | null {
  if (typeof v !== 'object' || v === null) return null
  const raw = v as Unknown

  // The three that cannot be defaulted: the id addresses the device, the public
  // key is what it proves itself with, and the room id is where the desktop
  // dials. An entry missing any of them is not a device with gaps.
  const id = str(raw.id)
  const publicKey = str(raw.publicKey)
  const sessionRoomId = str(raw.sessionRoomId)
  if (!id || !publicKey || !sessionRoomId) return null

  return {
    id,
    label: str(raw.label),
    publicKey,
    sessionRoomId,
    capabilities: capabilities(raw.capabilities),
    pairedAt: num(raw.pairedAt),
    lastSeenAt: num(raw.lastSeenAt),
  }
}

/** Every device on disk that still parses. Missing, corrupt and wrong-shaped all
 *  yield `[]` -- remote simply has no paired devices, which is a state the rest of
 *  the feature already handles, unlike a throw out of startup. */
export function loadRemoteDevices(userDataDir: string): PairedDevice[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(remoteDevicesPath(userDataDir), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map(device).filter((d): d is PairedDevice => d !== null)
}

/** Best-effort persist. The caller has already paired (or revoked) the device in
 *  memory by the time this runs, so throwing here would abort a handler halfway
 *  through and leave the two out of step -- worse than a registry that is stale
 *  until the next successful write. */
export function saveRemoteDevices(userDataDir: string, devices: PairedDevice[]): void {
  try {
    fs.writeFileSync(remoteDevicesPath(userDataDir), JSON.stringify(devices, null, 2), 'utf8')
  } catch {
    /* see above */
  }
}
