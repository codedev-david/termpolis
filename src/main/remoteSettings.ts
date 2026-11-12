// Whether remote is on, and which relay it dials.
//
// Two fields, both hostile-input: `enabled` arrives from IPC and `relayUrl` from
// a text box, so both are validated here rather than at the call site. A relay
// URL is saved only if it is `wss:`, or `ws:` on this machine
// (`isSecureRelayUrl`) -- an `http:` URL fails at dial time with a message that
// names neither the setting nor the reason, long after the user has left the
// settings pane, and a plain `ws:` one to another computer puts every room id on
// the network in the clear.
import * as fs from 'fs'
import * as path from 'path'
import { DEFAULT_RELAY_URL } from './remoteBridge/protocol'
import { isSecureRelayUrl } from './remoteBridge/relayUrl'

export { DEFAULT_RELAY_URL }

const SETTINGS_FILE = 'remote-settings.json'

export interface RemoteSettings {
  /** Off until the user asks. A network-facing channel into every terminal on
   *  this machine is not something an upgrade should switch on quietly -- that
   *  is indistinguishable from a compromise. */
  enabled: boolean
  /** The relay dialled. Always `wss:`, or `ws:` on this machine. */
  relayUrl: string
  /** Agents a phone starts skip their own approval prompts (Claude and agy with
   *  --dangerously-skip-permissions, Codex with -a never). Off unless the user
   *  turns it on: by default a phone-started agent asks before it acts, like
   *  one started by hand. */
  unattendedAgents: boolean
  /** A plain `ws://` relay to another computer that an older version saved.
   *  It is not dialled -- `relayUrl` is the default relay instead -- and it is
   *  kept, on disk too, so the Remote pane can say what was replaced until the
   *  user saves a relay. */
  relayReplaced?: string
}

export const DEFAULT_REMOTE_SETTINGS: RemoteSettings = {
  enabled: false,
  relayUrl: DEFAULT_RELAY_URL,
  unattendedAgents: false,
}

export function remoteSettingsPath(userDataDir: string): string {
  return path.join(userDataDir, SETTINGS_FILE)
}

/** A relay URL a save may set, or null: `wss:`, or `ws:` on this machine.
 *
 *  Rejecting here keeps the bad value in front of the user instead of surfacing
 *  it as a socket error minutes later. */
function savableRelayUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return isSecureRelayUrl(value.trim()) ? value.trim() : null
}

/** A stored relay URL worth reading, or null.
 *
 *  Looser than a save, on purpose: any `ws:` or `wss:` address. A plain `ws:`
 *  one to another computer could be saved before 1.53. It is not dialled: the
 *  load swaps in the default relay and keeps the old address as
 *  `relayReplaced`, so the Remote pane can say what changed. */
function storedRelayUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
    // No empty-hostname check: `ws` and `wss` are WHATWG special schemes, and a
    // special scheme with no host is a parse failure, not a URL with a blank
    // one. `ws:///relay` parses as host `relay`, and `ws://` throws into the
    // catch below. A guard here would be a branch nothing can reach.
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
  // A stored URL can stop being valid -- a hand edit, a downgrade, a partial
  // write -- and the fallback has to be somewhere this desktop can reach.
  const stored = storedRelayUrl(raw.relayUrl)
  const insecure = stored !== null && !isSecureRelayUrl(stored)
  return {
    enabled: raw.enabled === true,
    relayUrl: stored === null || insecure ? DEFAULT_RELAY_URL : stored,
    unattendedAgents: raw.unattendedAgents === true,
    ...(insecure ? { relayReplaced: stored } : {}),
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
  const savable = patch.relayUrl === undefined ? null : savableRelayUrl(patch.relayUrl)
  // Saving a relay -- any relay -- is the answer to the replaced-relay notice.
  const replaced = savable === null ? current.relayReplaced : undefined
  const next: RemoteSettings = {
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
    relayUrl: savable ?? current.relayUrl,
    unattendedAgents:
      patch.unattendedAgents === undefined ? current.unattendedAgents : patch.unattendedAgents === true,
    ...(replaced ? { relayReplaced: replaced } : {}),
  }
  // On disk the replaced address stays where it was, so the notice outlives a
  // restart, and an older desktop reads the file it wrote.
  const onDisk = { enabled: next.enabled, relayUrl: replaced ?? next.relayUrl, unattendedAgents: next.unattendedAgents }
  try {
    fs.writeFileSync(remoteSettingsPath(userDataDir), JSON.stringify(onDisk, null, 2), 'utf8')
  } catch {
    /* An unwritable settings file must not abort the toggle it describes: the
       user gets remote for this run and a switch that forgets on restart. */
  }
  return next
}
