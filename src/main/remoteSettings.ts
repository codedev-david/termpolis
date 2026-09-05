// Whether remote is on, and which relay it dials.
//
// Two fields, both hostile-input: `enabled` arrives from IPC and `relayUrl` from
// a text box, so both are validated here rather than at the call site. A relay
// URL that is not `ws:`/`wss:` is rejected outright -- an `http:` URL fails at
// dial time with a message that names neither the setting nor the reason, long
// after the user has left the settings pane.
import * as fs from 'fs'
import * as path from 'path'
import { DEFAULT_RELAY_URL } from './remoteBridge/protocol'

export { DEFAULT_RELAY_URL }

const SETTINGS_FILE = 'remote-settings.json'

export interface RemoteSettings {
  /** Off until the user asks. A network-facing channel into every terminal on
   *  this machine is not something an upgrade should switch on quietly -- that
   *  is indistinguishable from a compromise. */
  enabled: boolean
  relayUrl: string
}

export const DEFAULT_REMOTE_SETTINGS: RemoteSettings = {
  enabled: false,
  relayUrl: DEFAULT_RELAY_URL,
}

export function remoteSettingsPath(userDataDir: string): string {
  return path.join(userDataDir, SETTINGS_FILE)
}

/** A relay URL this desktop will actually dial, or null.
 *
 *  `URL` accepts a great deal -- `wss:` alone parses, with an empty host -- so the
 *  host is checked too. Rejecting here keeps the bad value in front of the user
 *  instead of surfacing it as a socket error minutes later. */
function validRelayUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
    if (!url.hostname) return null
    return value.trim()
  } catch {
    return null
  }
}

export function loadRemoteSettings(userDataDir: string): RemoteSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(remoteSettingsPath(userDataDir), 'utf8'))
  } catch {
    return { ...DEFAULT_REMOTE_SETTINGS }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_REMOTE_SETTINGS }
  }
  const raw = parsed as Record<string, unknown>
  return {
    enabled: raw.enabled === true,
    // A stored URL can stop being valid -- a hand edit, a downgrade, a partial
    // write -- and the fallback has to be somewhere this desktop can reach.
    relayUrl: validRelayUrl(raw.relayUrl) ?? DEFAULT_RELAY_URL,
  }
}

/** Merge a patch over the current settings and persist. Returns what is now in
 *  effect, including any field the patch tried and failed to change, so the
 *  caller can echo the real state back to the renderer instead of the request. */
export function saveRemoteSettings(
  userDataDir: string,
  patch: Partial<RemoteSettings>,
): RemoteSettings {
  const current = loadRemoteSettings(userDataDir)
  const next: RemoteSettings = {
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
    relayUrl:
      patch.relayUrl === undefined
        ? current.relayUrl
        : (validRelayUrl(patch.relayUrl) ?? current.relayUrl),
  }
  try {
    fs.writeFileSync(remoteSettingsPath(userDataDir), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* An unwritable settings file must not abort the toggle it describes: the
       user gets remote for this run and a switch that forgets on restart. */
  }
  return next
}
