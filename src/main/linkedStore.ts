// The links this machine joined, and what this machine knows about every linked
// machine: the name the user gave it, what it may do here, and whether the user
// has confirmed its safety words.
//
// Stored through secureKeyStore, because a joined link carries the private key
// minted for it: `osk:v1:` (DPAPI / Keychain / libsecret) when a keyring exists,
// honest plaintext when one does not -- the treatment the Remote identity gets.
// MAIN ONLY, for the same reason: `safeStorage` does not exist in the bridge's
// utilityProcess, so the bridge is handed the links rather than reading them.
//
// This file is an authorization boundary like remote-devices.json: `grants` is
// what another computer may make this one do. So it is read defensively -- every
// record rebuilt field by field, a malformed one dropped, permission granted only
// by an explicit boolean -- and nothing a hand edit invents survives a load.
import * as path from 'path'
import { readSecret, writeSecret } from './secureKeyStore'
import { isBridgeLink } from './remoteBridge/linkCode'
import { sanitizeDeviceLabel } from './remoteBridge/deviceLabel'
import { PHRASE_WORDS } from './remoteBridge/sealedChannel'
import type { LinkTarget } from './remoteBridge/protocol'

/** What a linked machine may do on THIS one. `write` implies `run`. */
export interface LinkedGrants {
  /** Start read-only agents here. */
  run: boolean
  /** Start agents here that may edit files and run commands. */
  write: boolean
}

/** What a new link may do until the user says otherwise: read-only agents. The
 *  write grant is never on by default (spec §4.6). Frozen, so a caller that
 *  mutates the grants it was handed cannot change every later default. */
export const DEFAULT_GRANTS: LinkedGrants = Object.freeze({ run: true, write: false })

/** The name a machine gets when nothing better is known. */
export const DEFAULT_MACHINE_NAME = 'Computer'

/** A link this machine JOINED: the bridge's `BridgeLink` plus when it was made. */
export interface JoinedLink {
  /** The device id the host assigned: sha256(link public key)[:16], hex. */
  id: string
  hostPublicKey: string
  relayUrl: string
  sessionRoomId: string
  /** The private key minted for this one link, never the machine identity. */
  secretKey: string
  linkedAt: number
}

/** What this machine knows about one linked machine, hosted or joined. */
export interface LinkMeta {
  /** `'device:<id>'` for a machine that entered our code, `'link:<id>'` for one
   *  whose code we entered. */
  ref: string
  name: string
  grants: LinkedGrants
  /** Whether the user compared the safety words and clicked "They match" here.
   *  Nothing but `peerHello` is served until then. */
  confirmed: boolean
  linkedAt: number
  /** The safety words, kept only while the link waits for confirmation. */
  phrase?: string
}

export interface LinkedState {
  links: JoinedLink[]
  meta: LinkMeta[]
}

export const LINKED_STATE_FILE = 'linked-machines'

/** Written for a future reader. This one reads field by field whatever it says:
 *  every record is validated anyway, and a downgrade must not cost the user
 *  every link they made. */
const STATE_VERSION = 1

const REF_RE = /^(device|link):([0-9a-f]{16})$/

/** Eight lowercase safety words (sealedChannel `deriveVerificationPhrase`). */
const PHRASE_RE = new RegExp(`^[a-z]+(?: [a-z]+){${PHRASE_WORDS - 1}}$`)

type Unknown = Record<string, unknown>

const isRecord = (v: unknown): v is Unknown => typeof v === 'object' && v !== null
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function statePath(userDataDir: string): string {
  return path.join(userDataDir, LINKED_STATE_FILE)
}

export function refOf(target: LinkTarget): string {
  return `${target.via}:${target.id}`
}

/** The inverse of `refOf`, or null for anything that is not exactly a ref.
 *  Takes what IPC hands it, so a non-string is refused rather than assumed. */
export function targetOf(ref: string): LinkTarget | null {
  const m = typeof ref === 'string' ? REF_RE.exec(ref) : null
  if (!m) return null
  return m[1] === 'device' ? { via: 'device', id: m[2] } : { via: 'link', id: m[2] }
}

/** Grants from untrusted input, or null when they are not exactly two booleans.
 *  Rejects rather than coerces, like Remote's capability check: a payload that
 *  is not two booleans is a bug or an attack, and "granted nothing" would hide
 *  both. An agent that may edit files may certainly read them, so `write`
 *  forces `run` on. */
export function normalizeGrants(g: unknown): LinkedGrants | null {
  if (!isRecord(g)) return null
  const { run, write } = g
  if (typeof run !== 'boolean' || typeof write !== 'boolean') return null
  return { run: run || write, write }
}

function linkFrom(v: unknown): JoinedLink | null {
  // The bridge's own check: these keys reach the curve library, where a bad one
  // is an exception inside a socket handler rather than a dropped record.
  if (!isBridgeLink(v)) return null
  return {
    id: v.id,
    hostPublicKey: v.hostPublicKey,
    relayUrl: v.relayUrl,
    sessionRoomId: v.sessionRoomId,
    secretKey: v.secretKey,
    linkedAt: num((v as unknown as Unknown).linkedAt),
  }
}

function metaFrom(v: unknown): LinkMeta | null {
  if (!isRecord(v)) return null
  const ref = typeof v.ref === 'string' && targetOf(v.ref) ? v.ref : null
  const grants = normalizeGrants(v.grants)
  if (!ref || !grants) return null
  const confirmed = v.confirmed === true
  const phrase = !confirmed && typeof v.phrase === 'string' && PHRASE_RE.test(v.phrase) ? v.phrase : null
  return {
    ref,
    name: sanitizeDeviceLabel(v.name) || DEFAULT_MACHINE_NAME,
    grants,
    confirmed,
    linkedAt: num(v.linkedAt),
    ...(phrase ? { phrase } : {}),
  }
}

/** First record wins: two rooms for one link id would fight over one seat. */
function firstOf<T>(items: (T | null)[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    if (item === null || seen.has(key(item))) continue
    seen.add(key(item))
    out.push(item)
  }
  return out
}

/** Every link and meta record that still parses. Never throws: missing, corrupt,
 *  undecryptable and wrong-shaped all read as no links, a state the feature
 *  already handles, unlike a throw out of startup. */
export function loadLinkedState(userDataDir: string): LinkedState {
  let doc: unknown = null
  try {
    const raw = readSecret(statePath(userDataDir))
    if (raw !== null) doc = JSON.parse(raw)
  } catch {
    /* unreadable is the same as absent */
  }
  const record = isRecord(doc) ? doc : {}
  return {
    links: firstOf(list(record.links).map(linkFrom), (l) => l.id),
    meta: firstOf(list(record.meta).map(metaFrom), (m) => m.ref),
  }
}

/** Persist, best effort, writing only the known fields. The caller has already
 *  changed the links in memory by the time this runs, so a throw here would
 *  abort a handler halfway through and leave the two out of step -- worse than
 *  a file that is stale until the next successful write. */
export function saveLinkedState(userDataDir: string, state: LinkedState): void {
  try {
    const doc = {
      v: STATE_VERSION,
      links: state.links.map((l) => ({
        id: l.id,
        hostPublicKey: l.hostPublicKey,
        relayUrl: l.relayUrl,
        sessionRoomId: l.sessionRoomId,
        secretKey: l.secretKey,
        linkedAt: l.linkedAt,
      })),
      meta: state.meta.map((m) => ({
        ref: m.ref,
        name: m.name,
        grants: { run: m.grants.run, write: m.grants.write },
        confirmed: m.confirmed,
        linkedAt: m.linkedAt,
        ...(!m.confirmed && m.phrase ? { phrase: m.phrase } : {}),
      })),
    }
    writeSecret(statePath(userDataDir), JSON.stringify(doc))
  } catch {
    /* see above */
  }
}
