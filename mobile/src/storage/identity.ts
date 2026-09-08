import * as SecureStore from 'expo-secure-store'
import { generateIdentity, publicKeyFor } from '../wire/sessionCrypto'
import { sanitizeDeviceLabel } from '../wire/deviceLabel'

/** v1 kept one key and one desktop. v2 keeps one record per desktop, each with
 *  its own key.
 *
 *  Versioned in the KEY name rather than inside the value, so a phone that ends
 *  up back on 1.39 reads the record it understands and not the tail of a format
 *  it has never seen. */
const IDENTITY_KEY_V1 = 'termpolis.remote.identity.v1'
const PAIRED_KEY_V1 = 'termpolis.remote.paired.v1'

/** Which desktops exist, in the order they were paired, and which one is on
 *  screen.
 *
 *  Held apart from the records for two reasons. SecureStore warns above roughly
 *  2 KB per value, and a single array of full records would cross that at about
 *  five desktops -- silently, on a platform where the failure is a keystore write
 *  that does not stick. And this is the one value that changes on every switch:
 *  rewriting a desktop's key material to remember a tap would be a great deal of
 *  keychain churn for a UI detail. */
const INDEX_KEY = 'termpolis.remote.pairings.v2'

/** One record per desktop, keyed by the desktop's public key -- the only handle
 *  that is unique per machine and already known before the record exists. */
const RECORD_PREFIX = 'termpolis.remote.pairing.v2.'

/** A ceiling, so the index value stays far inside SecureStore's limit: sixteen
 *  64-character keys plus the active one is roughly 1.1 KB. It is also well past
 *  any real desk -- a laptop, a workstation, a VM and a server is four. */
export const MAX_PAIRINGS = 16

/** Everything written here is the phone's authority over some desktop, or the
 *  address of a live connection to one, so none of it belongs in a cloud backup.
 *
 *  `THIS_DEVICE_ONLY` is the load-bearing half. Without it a restored iCloud
 *  keychain produces a second handset holding the same private keys -- two
 *  devices the desktop cannot tell apart, where revoking one does not revoke the
 *  other. */
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

/** Both halves of an X25519 keypair are 32 bytes, so one shape checks a secret
 *  key, a desktop's public key, and the index entries keyed by one. */
const HEX_KEY_RE = /^[0-9a-f]{64}$/
const ROOM_ID_RE = /^[0-9a-f]{32}$/
const DEVICE_ID_RE = /^[0-9a-f]{16}$/

export interface Identity {
  secretKey: string
  publicKey: string
}

/** A paired desktop as any screen may see it. */
export interface PairedDesktop {
  desktopPublicKey: string
  /** Derived from the two identity keys and never announced. */
  sessionRoomId: string
  relayUrl: string
  /** What that desktop calls this phone in its device list. */
  deviceId: string
  /** What this phone calls that desktop, for the screen. */
  label: string
  pairedAt: number
}

/**
 * A pairing as it is stored: the record above, plus the private key that IS this
 * phone's authority over that ONE desktop.
 *
 * Per desktop, not per phone, and the reasons are in that order of importance:
 *
 *  1. Unpairing one desktop must not cost the phone its authority over the
 *     others. With a single shared key the erase promised in PRIVACY.md would
 *     either be broken or would silently unpair every other desktop at once.
 *  2. Two desktops handed the same public key can compare notes and know they
 *     are talking to the same handset. Separate keys make the phone a different
 *     device to each one -- and since a device id is a hash of the public key,
 *     they genuinely are different rows.
 *
 * The cost is that re-pairing a desktop this phone already knows arrives as a
 * NEW device there, leaving the old row behind to be revoked. That was already
 * true whenever a phone was unpaired and paired again, and it is the right trade.
 */
export interface StoredPairing extends PairedDesktop {
  secretKey: string
}

/** Everything the app knows about who it is paired with, read in one go. */
export interface PairingBook {
  /** In the order they were paired. Append order, not most-recently-used: a list
   *  that reorders itself under the user's finger is a list that gets mis-tapped. */
  pairings: StoredPairing[]
  /** The desktop to show. Null only when there are none. */
  active: string | null
}

interface StoredIndex {
  order: string[]
  active: string | null
}

/** Read a key, treating a keystore that refuses as an empty one.
 *
 *  SecureStore throws on a locked keychain, and these callers run at launch --
 *  before any screen exists to catch it. Null means the pair screen; a throw
 *  means an app that will not start. */
async function read(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key)
  } catch {
    return null
  }
}

async function readJson(key: string): Promise<unknown> {
  const raw = await read(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** A fresh keypair for one pairing attempt.
 *
 *  Deliberately not persisted here. A key is written only alongside the record
 *  that gives it a purpose, so an abandoned pairing leaves nothing behind in the
 *  keystore for a later version to find and wonder about. */
export function newIdentity(): Identity {
  return generateIdentity()
}

/** The public half of a stored pairing, for the parts of the app that draw it.
 *
 *  The one place the redaction happens. A screen that could read `secretKey` off
 *  the store is one `JSON.stringify` away from putting this phone's authority in
 *  a log. */
export function publicPairing(pairing: StoredPairing): PairedDesktop {
  return {
    desktopPublicKey: pairing.desktopPublicKey,
    sessionRoomId: pairing.sessionRoomId,
    relayUrl: pairing.relayUrl,
    deviceId: pairing.deviceId,
    label: pairing.label,
    pairedAt: pairing.pairedAt,
  }
}

/** The public key this phone presents to one desktop. Derived rather than
 *  stored, because storing both halves invites them to disagree -- which would
 *  be a phone that greets under one identity and is trusted under another. */
export function publicKeyOf(pairing: StoredPairing): string {
  return publicKeyFor(pairing.secretKey)
}

/** Everything the phone is paired with. Migrates a v1 install on first read. */
export async function loadBook(): Promise<PairingBook> {
  const index = validateIndex(await readJson(INDEX_KEY))
  if (index === null) return migrateFromV1()

  const pairings: StoredPairing[] = []
  for (const key of index.order) {
    const record = validatePairing(await readJson(RECORD_PREFIX + key))
    // A record the index names but the keystore no longer holds is a pairing
    // whose key is gone: the phone could not authenticate to that desktop if it
    // tried, so drawing the row would be offering a button that cannot work.
    if (record !== null && record.desktopPublicKey === key) pairings.push(record)
  }

  return { pairings, active: pickActive(pairings, index.active) }
}

/** Add or replace one pairing.
 *
 *  Record first, index second. Interrupted between the two, the keystore holds a
 *  record nothing names -- invisible, and overwritten the next time this same
 *  desktop is paired, because the key it is filed under is the desktop's own.
 *  The other order would leave the index naming a record that does not exist. */
export async function addPairing(pairing: StoredPairing): Promise<void> {
  await writePairing(pairing)
  const index = validateIndex(await readJson(INDEX_KEY)) ?? { order: [], active: null }
  const order = index.order.includes(pairing.desktopPublicKey)
    ? index.order
    : [...index.order, pairing.desktopPublicKey]
  await writeIndex({ order, active: pairing.desktopPublicKey })
}

/** Overwrite one pairing's record, leaving the index alone. Renaming.
 *
 *  Written field by field rather than as the caller's object, so a value that
 *  picked up an extra property -- the one-time secret above all -- cannot ride
 *  along into the keystore. Wire format section 7.5 requires that secret be
 *  discarded the moment the hello is sealed. */
export async function writePairing(pairing: StoredPairing): Promise<void> {
  const record: StoredPairing = {
    desktopPublicKey: pairing.desktopPublicKey,
    sessionRoomId: pairing.sessionRoomId,
    relayUrl: pairing.relayUrl,
    deviceId: pairing.deviceId,
    label: sanitizeDeviceLabel(pairing.label),
    pairedAt: pairing.pairedAt,
    secretKey: pairing.secretKey,
  }
  await SecureStore.setItemAsync(
    RECORD_PREFIX + record.desktopPublicKey,
    JSON.stringify(record),
    KEYCHAIN,
  )
}

/**
 * Forget one desktop: its record AND the key that was this phone's authority
 * over it. This is what unpairing does, and it is what PRIVACY.md promises.
 *
 * There is deliberately no "forget the desktop, keep the key" variant. Keeping
 * it would make a re-pair land on that desktop's existing row instead of a
 * second one -- pleasant, and not worth what it costs: a desktop that has not
 * also revoked the device goes on trusting whoever holds the key.
 *
 * Index first, record second. Between the two writes the pairing is invisible
 * rather than named-but-missing, and the key is gone by the end either way.
 */
export async function removePairing(
  desktopPublicKey: string,
  nextActive: string | null,
): Promise<void> {
  const index = validateIndex(await readJson(INDEX_KEY)) ?? { order: [], active: null }
  await writeIndex({
    order: index.order.filter((key) => key !== desktopPublicKey),
    active: nextActive,
  })
  await SecureStore.deleteItemAsync(RECORD_PREFIX + desktopPublicKey)
}

/** Remember which desktop is on screen, so a relaunch comes back to it. */
export async function setActivePairing(desktopPublicKey: string | null): Promise<void> {
  const index = validateIndex(await readJson(INDEX_KEY)) ?? { order: [], active: null }
  await writeIndex({ order: index.order, active: desktopPublicKey })
}

/**
 * Forget everything: every record, every key, and the index.
 *
 * Not reachable from the UI -- Settings unpairs one desktop at a time -- but the
 * store's teardown path needs a way to leave nothing behind, and so does anyone
 * reading PRIVACY.md's "delete the app" promise and wanting to see the code that
 * makes it true.
 */
export async function wipeEverything(): Promise<void> {
  const index = validateIndex(await readJson(INDEX_KEY))
  // Index first: interrupted, what is left is orphaned records no code path can
  // reach, rather than an index pointing at keys that are already gone.
  await SecureStore.deleteItemAsync(INDEX_KEY)
  for (const key of index?.order ?? []) {
    await SecureStore.deleteItemAsync(RECORD_PREFIX + key)
  }
  await forgetV1()
}

async function writeIndex(index: StoredIndex): Promise<void> {
  const stored = { v: 2, order: index.order, active: pickActiveKey(index) }
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(stored), KEYCHAIN)
}

/** An active key that is not in `order` would come back as a desktop the app
 *  cannot find. Dropped here, at the one place the index is written. */
function pickActiveKey(index: StoredIndex): string | null {
  if (index.active !== null && index.order.includes(index.active)) return index.active
  return index.order[0] ?? null
}

function pickActive(pairings: StoredPairing[], wanted: string | null): string | null {
  if (wanted !== null && pairings.some((p) => p.desktopPublicKey === wanted)) return wanted
  // Falls back rather than showing nothing: an index whose active desktop failed
  // to load still has other perfectly good pairings, and a phone that opens on
  // the pair screen while three desktops are stored has lost them as far as the
  // user can tell.
  return pairings[0]?.desktopPublicKey ?? null
}

/**
 * Carry a 1.39 install forward.
 *
 * Runs when there is no index at all, which is true exactly once per install --
 * the index is written unconditionally below, so a phone with nothing to migrate
 * does not come back through here on every launch.
 *
 * The v1 keys are deleted afterwards, and that is not optional: leaving them
 * would mean this phone's authority over the migrated desktop exists in two
 * places, and unpairing -- which erases the v2 copy -- would quietly leave the
 * other one behind. It does mean a downgrade to 1.39 arrives unpaired, which is
 * the correct trade and is not a route a store-installed app can take anyway.
 */
async function migrateFromV1(): Promise<PairingBook> {
  const legacy = validateDesktop(await readJson(PAIRED_KEY_V1))
  const secretKey = validateSecretKey(await readJson(IDENTITY_KEY_V1))

  // Both halves or nothing. A record whose key is gone is a phone that believes
  // it is paired and fails every handshake with nothing on screen to explain it;
  // a key with no record is simply a phone that has been opened before.
  const book: PairingBook =
    legacy !== null && secretKey !== null
      ? { pairings: [{ ...legacy, secretKey }], active: legacy.desktopPublicKey }
      : { pairings: [], active: null }

  for (const pairing of book.pairings) await writePairing(pairing)
  await writeIndex({
    order: book.pairings.map((p) => p.desktopPublicKey),
    active: book.active,
  })
  // Written before the old keys go, so an interruption leaves the v1 format
  // intact and the migration simply runs again next launch.
  await forgetV1()
  return book
}

async function forgetV1(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRED_KEY_V1)
  await SecureStore.deleteItemAsync(IDENTITY_KEY_V1)
}

function validateSecretKey(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const secretKey = (value as { secretKey?: unknown }).secretKey
  // A truncated key is not a key. Trusting one produces a phone that fails every
  // handshake with no explanation available anywhere in the UI.
  return typeof secretKey === 'string' && HEX_KEY_RE.test(secretKey) ? secretKey : null
}

function validateIndex(value: unknown): StoredIndex | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (r.v !== 2) return null
  if (!Array.isArray(r.order)) return null
  const order: string[] = []
  for (const key of r.order) {
    // A duplicate would draw the same desktop twice and, worse, would let one
    // removal leave the other copy naming a record that has just been deleted.
    if (typeof key === 'string' && HEX_KEY_RE.test(key) && !order.includes(key)) order.push(key)
  }
  // Clamped BEFORE the active key is checked against it, so an index that
  // somehow grew past the ceiling cannot come back naming a desktop that was
  // just trimmed off the end of the list.
  const kept = order.slice(0, MAX_PAIRINGS)
  const active = typeof r.active === 'string' && kept.includes(r.active) ? r.active : null
  return { order: kept, active }
}

function validatePairing(value: unknown): StoredPairing | null {
  const desktop = validateDesktop(value)
  if (desktop === null) return null
  const secretKey = validateSecretKey(value)
  if (secretKey === null) return null
  return { ...desktop, secretKey }
}

function validateDesktop(value: unknown): PairedDesktop | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (typeof r.desktopPublicKey !== 'string' || !HEX_KEY_RE.test(r.desktopPublicKey)) return null
  if (typeof r.sessionRoomId !== 'string' || !ROOM_ID_RE.test(r.sessionRoomId)) return null
  if (typeof r.relayUrl !== 'string' || r.relayUrl.length === 0) return null
  if (typeof r.deviceId !== 'string' || !DEVICE_ID_RE.test(r.deviceId)) return null
  if (typeof r.label !== 'string') return null
  if (typeof r.pairedAt !== 'number' || !Number.isFinite(r.pairedAt)) return null
  return {
    desktopPublicKey: r.desktopPublicKey,
    sessionRoomId: r.sessionRoomId,
    relayUrl: r.relayUrl,
    deviceId: r.deviceId,
    label: r.label,
    pairedAt: r.pairedAt,
  }
}
