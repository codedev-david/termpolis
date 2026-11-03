// v1.26 — the MAIN-process proxy for the memory brain that now lives in a utilityProcess.
//
// src/main/index.ts talks to this module instead of ./swarmMemory. Every store call becomes a
// Promise, so step 2 is a mechanical `await` insertion; everything else (spawn, correlation,
// timeouts, crash recovery, fallback, and the secret-scrub boundary) is handled here.
//
// The shape mirrors localEmbedder.ts + embedWorker.ts, this repo's existing off-thread pattern:
// the transport is INJECTABLE (setMemoryHostSpawner) so the unit suite exercises the orchestration
// without a real fork, and any spawn/init failure degrades silently to the in-process module rather
// than taking the app down.
//
// v1.54.5 — "degrades to the in-process module" has a limit. Loading the store on the main thread is
// synchronous (4.3 s on a 475 MB store, up to 18.8 s with the index rebuild), on the thread that
// paints the window and echoes every keystroke, and a CPU-starved machine makes a slow or failed host
// start an ordinary event. So above a size limit (memoryFallbackGuard: 256 MB, tunable, with a kill
// switch) the client stays OFF the main thread: mode 'unavailable', every call refused with an honest
// error, and the host retried in the background on a capped exponential backoff. Below the limit
// nothing changes.
//
// ── The three things that are NOT a mechanical port ───────────────────────────────────────────────
//
// 1. THE SCRUB BOUNDARY (security).  setMemoryScrubber(fn) installs a CALLBACK that redacts secrets
//    BEFORE content is hashed, embedded or written to disk. A function cannot cross IPC, so a naive
//    port drops it and starts persisting secrets verbatim — and a leaked key in a transcript becomes
//    permanently recallable into an agent's context. So the scrub runs HERE, in main, before the
//    content is posted. The secret never enters the memory process at all: strictly better than
//    today, where it did (it was merely redacted on arrival).
//
// 2. THE KEY (security).  The child has no `safeStorage` — DPAPI / Keychain / libsecret are
//    main-process-only. Main therefore owns key provisioning end to end: it unwraps the existing
//    at-rest key (or mints one, exactly as maybeAutoEncrypt would) and injects it. The child's
//    keychain is fenced off so it can never fall back to writing a key in plaintext.
//
// 3. consolidationSimOf().  It returns a CLOSURE over the packed vector store. Functions do not
//    cross process boundaries, and proxying it per-pair would be ~20,000 round trips per pass. The
//    host ships the pairwise matrix as data and an identical closure is rebuilt over it here.

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { fileURLToPath } from 'url'
import { utilityProcess } from 'electron'
import { isOsEncryptionAvailable, keyStorageMode, createSecretExclusive, retireSecretFile } from './secureKeyStore'
import {
  HOST_HANDLERS,
  readKeysOf,
  type HostRequest,
  type HostResponse,
  type HostInitMsg,
  type SerializedError,
} from './memoryHost'
import {
  initSwarmMemory as inprocInit,
  adoptEncryptionKey as inprocAdoptKey,
  setMemoryScrubber as inprocSetScrubber,
  setVectorQuantization as inprocSetQuantization,
  inspectMemoryKey, retiredMemoryKeys,
  KEY_CACHE_FILE, ENCRYPTION_OPTOUT_FILE,
  type KeyFileProblem,
  // Pure, stateless helpers — see the re-export block at the bottom.
  normalizeProjectSlug, projectKeyOf, entityDedupHash, contentHash, canonicalEntityName,
  type MemoryEntry, type MemorySearchResult, type WriteInput, type SearchOptions,
  type RelatedOptions, type GraphQueryOptions, type ListOptions, type SyncStatus,
  type MemoryScrubber, type VectorRamStats, type MemoryDashboardStats, type ActivityRow,
  type EmbeddingsStatus,
} from './swarmMemory'
import type { MemoryEdge } from './memoryGraph'
import type { GraphSample } from './memoryGraphSample'
import type { ConsolEntry } from './mnemeConsolidate'
import type { WeaveEntry, WeaveNeighbour } from './mnemeWeave'
import type { CodeRef } from './codeGraph'
import { killUtility } from './utilityKill'
import {
  resolveInprocGuard, measureMemoryStoreBytes, retryDelayMs, retryReadyTimeoutMs, RETRY_CAP_MS,
  unavailableMessage, setMemoryUnavailableState,
} from './memoryFallbackGuard'

// ── Transport seam ───────────────────────────────────────────────────────────────────────────────
// Deliberately NOT Electron's UtilityProcess type: keeping the surface to four methods is what lets
// the whole crash/timeout/fallback story be unit-tested without forking anything. The real adapter
// (createMemoryHostTransport) is the only Electron-aware code, and lives at the bottom of this file.

export interface MemoryHostTransport {
  postMessage(msg: HostRequest): void
  onMessage(cb: (msg: HostResponse) => void): void
  onExit(cb: (code: number) => void): void
  kill(): void
  pid?: number
}

export type MemoryHostSpawner = () => MemoryHostTransport | null

export interface StartMemoryHostOptions {
  userDataPath: string
  syncDir?: string | null
  /** The persisted int8-quantization choice. Applied BEFORE the store is built, on whichever side
   *  ends up owning it — see HostInitMsg.quantize. */
  quantize?: boolean
  /** Skip the child entirely and run in-process (the fallback path). Used by tests + as a kill switch. */
  inProcess?: boolean
}

const READY_TIMEOUT_MS = 120_000 // init is ~4.3s on the real 475MB store, but rebuildVectorIndex has hit 18.8s
const CALL_TIMEOUT_MS = 60_000
const MAX_RESTARTS = 3           // within RESTART_WINDOW_MS, then we stop flapping and go in-process
const RESTART_WINDOW_MS = 60_000

// 'unavailable' (v1.54.5): the host is not running, the store is too big to load on the main thread,
// and a retry is pending or running. Calls are refused (never answered from an unloaded store).
type Mode = 'unstarted' | 'starting' | 'host' | 'inproc' | 'unavailable'

interface Pending {
  fn: string
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let spawner: MemoryHostSpawner | null = null
let transport: MemoryHostTransport | null = null
let mode: Mode = 'unstarted'
let initParams: HostInitMsg | null = null
let readyPromise: Promise<void> | null = null
let nextId = 1
const pending = new Map<number, Pending>()
const restartTimes: number[] = []
let scrubber: MemoryScrubber | null = null
let scrubbedWrites = 0
let secretsRedacted = 0
// Set by stopMemoryHost (app shutdown) and never cleared: from then on nothing starts a host, and
// nothing falls back to loading the store on the main thread, while the app is trying to exit.
let stopped = false

// ── v1.54.5: the in-process fallback guard ───────────────────────────────────────────────────────
type StoreSizeProbe = (userDataPath: string, syncDir: string | null) => Promise<number | null> | number | null

/** P13's hook: asked when a retry is due. Returns how many ms to wait before asking again; 0 (or
 *  anything that is not a positive number) means go. See setMemoryRetryGovernor. */
export type MemoryRetryGovernor = (ctx: { attempt: number }) => number

/** A hung share (a sync folder that went offline) must not hold the verdict, and every call queued
 *  behind it, hostage. */
const STORE_PROBE_TIMEOUT_MS = 3_000

let storeSizeProbe: StoreSizeProbe = measureMemoryStoreBytes
// What the disk said, per store location (the local folder, or a sync folder). Only a real number is
// kept: a probe that could not tell (null) is asked again at the next failure, not remembered.
const storeSizes = new Map<string, number>()
const storeProbes = new Map<string, Promise<number | null>>() // asks in flight
let retryGovernor: MemoryRetryGovernor | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let nextRetryAt: number | null = null
let retrying = false         // a retry's child is loading right now
let startFailures = 0        // starts that failed in a row; drives the backoff
let hostReadyAt = 0          // when the host last reported ready: tells a crash loop from a long run
let unavailableSince = 0
let lastReason = ''
let lastStoreBytes: number | null = null
let lastLimit = 0
let clientGen = 0            // bumped by the test reset, so a continuation from a torn-down client cannot act

/** Set the spawner (the app wires this to a real utilityProcess; tests inject a fake). Mirrors
 *  localEmbedder.setWorkerSpawner. With none set, startMemoryHost runs the store in-process. */
export function setMemoryHostSpawner(fn: MemoryHostSpawner | null): void {
  spawner = fn
}

/**
 * P13 HOOK (pull): the event-loop governor's say over WHEN an unavailable memory host is retried.
 * When a retry is due the client calls `fn({ attempt })`; a positive answer is a number of ms to wait
 * before it asks again (clamped to 5 minutes), anything else means "start now". A governor that
 * throws or answers nonsense is treated as "start now": a broken governor must never be the reason
 * memory stays down. With none set the capped exponential backoff alone decides.
 */
export function setMemoryRetryGovernor(fn: MemoryRetryGovernor | null): void {
  retryGovernor = fn
}

/**
 * P13 HOOK (push): start a retry right now, skipping the wait and the governor. Returns false, and
 * does nothing, unless memory is unavailable with no retry already running (and the app not quitting).
 */
export function retryMemoryHostNow(): boolean {
  if (stopped || mode !== 'unavailable' || retrying) return false
  clearRetryTimer()
  void retryStart()
  return true
}

/** How the size of the store on disk is measured. A seam for tests (and for a future caller with a
 *  better answer); null restores the real probe. */
export function setMemoryStoreSizeProbe(fn: StoreSizeProbe | null): void {
  storeSizeProbe = fn ?? measureMemoryStoreBytes
  storeSizes.clear()
  storeProbes.clear()
}

/** @internal test-only — tear the client back down to a virgin module. */
export function _resetMemoryClientForTests(): void {
  try { transport?.kill() } catch { /* already gone */ }
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('memory client reset')) }
  pending.clear()
  spawner = null
  transport = null
  mode = 'unstarted'
  initParams = null
  readyPromise = null
  nextId = 1
  restartTimes.length = 0
  scrubber = null
  scrubbedWrites = 0
  secretsRedacted = 0
  stopped = false
  // v1.54.5: a pending retry, a size already asked for, a governor — none may leak into the next test.
  clientGen++
  clearRetryTimer()
  retrying = false
  startFailures = 0
  hostReadyAt = 0
  unavailableSince = 0
  lastReason = ''
  lastStoreBytes = null
  lastLimit = 0
  storeSizeProbe = measureMemoryStoreBytes
  storeSizes.clear()
  storeProbes.clear()
  retryGovernor = null
  setMemoryUnavailableState(null)
}

/** @internal test-only — undo stopMemoryHost()'s latch, for a suite that fires before-quit and
 *  then needs the store again. Nothing in the app may call this: after a quit, nothing restarts. */
export function _unlatchMemoryHostForTests(): void {
  stopped = false
}

/** Which side is actually serving memory. Observable so the app can SAY so (and so a test can prove
 *  the fallback engaged rather than assuming it). */
export function memoryHostMode(): Mode { return mode }
export function memoryHostPid(): number | undefined { return transport?.pid }

function logLoud(msg: string): void {
  if (process.env.NODE_ENV === 'test') return
  try { console.log(`[termpolis][memory] ${msg}`) } catch { /* ignore */ }
}

function rehydrate(e: SerializedError | undefined, fallback: string): Error {
  const err = new Error(e?.message || fallback)
  if (e?.name) err.name = e.name
  // Keep the child's stack — without it a failure in the host is an anonymous message in main, and
  // "which memory call blew up?" becomes a guessing game.
  if (e?.stack) err.stack = e.stack
  return err
}

// ── Key provisioning (main only) ─────────────────────────────────────────────────────────────────
/**
 * Resolve this device's at-rest AES key, minting one if the store has none — i.e. everything
 * swarmMemory's maybeAutoEncrypt() does EXCEPT the shard rewrite, which stays with the store.
 *
 * This has to happen in main: `safeStorage` does not exist in a utilityProcess, so the child can
 * neither unwrap the stored key (it would read the encrypted store as EMPTY) nor wrap a new one (it
 * would silently leave every fresh install unencrypted — default-on at-rest encryption, quietly off).
 *
 * Policy is copied deliberately, not approximated: no auto-key for a SYNCED store (peers cannot share
 * a per-device key — that is the passphrase model), none when the user opted out, and none without a
 * real OS keychain (a plaintext key beside the ciphertext is security theatre — stay honestly plaintext).
 *
 * The key FILE is never overwritten (Decision 1). It used to be: a blob the keychain refused once — a
 * DPAPI hiccup, a keyring not unlocked yet, an Electron upgrade reading the old wrap — read as "no key",
 * and a fresh one was minted over it, which made the whole brain unreadable for good. Now:
 *   - no file: mint one, exclusively (it can't clobber a file that appears meanwhile);
 *   - a file that opens to a 32-byte key: use it, write nothing;
 *   - a file that doesn't (no keychain, unwrap refused, wrong length): leave it exactly as it is and
 *     report why. The store comes up LOCKED, and only the user's "Start a new memory key" moves it.
 * Retired keys that still unwrap come back as `readKeys`, so lines under them stay readable.
 */
export function provisionMemoryKey(
  userDataPath: string,
  syncDir: string | null,
): { key: Buffer | null; minted: boolean; readKeys: Buffer[]; problem: KeyFileProblem | null } {
  const keyPath = path.join(userDataPath, KEY_CACHE_FILE)
  const readKeys = retiredMemoryKeys(keyPath)
  const found = inspectMemoryKey(keyPath)
  if (!found.absent) return { key: found.key, minted: false, readKeys, problem: found.problem }

  const none = { key: null, minted: false, readKeys, problem: null }
  if (syncDir) return none                                   // passphrase model
  try {
    if (fs.existsSync(path.join(userDataPath, ENCRYPTION_OPTOUT_FILE))) return none
  } catch { /* treat an unreadable opt-out marker as absent */ }
  if (keyStorageMode() !== 'keychain') return none            // honest plaintext

  const key = crypto.randomBytes(32)
  try {
    createSecretExclusive(keyPath, key.toString('base64')) // OS-encrypted at rest, in the ONLY process that can
    return { key, minted: true, readKeys, problem: null }
  } catch (err) {
    // A file appeared between the look and the write (EEXIST): that one is the key — use it, as found.
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      const raced = inspectMemoryKey(keyPath)
      return { key: raced.key, minted: false, readKeys, problem: raced.problem }
    }
    return none // the keychain refused: nothing was left behind, so stay honestly plaintext
  }
}

// ── Spawn / init / crash ─────────────────────────────────────────────────────────────────────────

function failAllPending(reason: string): void {
  if (pending.size === 0) return
  const err = new Error(reason)
  for (const [, p] of pending) {
    clearTimeout(p.timer)
    // Name the call. "memory host exited" is a shrug; "…during memorySearch" is a bug report.
    p.reject(new Error(`${err.message} (during ${p.fn})`))
  }
  pending.clear()
}

function fallBackToInProcess(why: string): void {
  if (stopped) return
  // The cost of this move, in the one number that shows it: main's resident set before the load and after.
  const rssBefore = mainRssMb()
  logLoud(`FALLBACK — running the memory store on the MAIN thread: ${why}`)
  // Leaving 'unavailable' for good (the store turned out to be small enough after all): no retry loop
  // may outlive the move, and the panel must stop reporting a state that no longer exists.
  clearRetryTimer()
  retrying = false
  setMemoryUnavailableState(null)
  transport = null
  mode = 'inproc'
  if (!initParams) return
  // The in-process module is the same swarmMemory the host would have used, and every write already
  // went to the same JSONL on disk — so re-initialising here reloads the store rather than losing it.
  try {
    const encKey = initParams.encKeyB64 ? Buffer.from(initParams.encKeyB64, 'base64') : null
    // Same ordering the host uses (and that index.ts used in-process): mode BEFORE the store, or the
    // packed array is allocated in the wrong one and setVectorQuantization has to rebuild it.
    try { inprocSetQuantization(initParams.quantize === true) } catch { /* exact floats */ }
    inprocInit(initParams.userDataPath, { syncDir: initParams.syncDir, encKey, readKeys: readKeysOf(initParams.readKeysB64), keyProblem: initParams.keyProblem })
    // As in the host: a rewrite that fails (or a LOCKED store refusing it) must not cost the scrubber.
    if (encKey && initParams.encKeyMinted) { try { inprocAdoptKey(encKey) } catch { /* the key is in force regardless */ } }
    if (scrubber) inprocSetScrubber(scrubber)
    logLoud(`in-process store loaded — main rss ${rssBefore} MB -> ${mainRssMb()} MB`)
  } catch (err) {
    logLoud(`in-process memory init FAILED too: ${(err as Error)?.message}`)
  }
}

// ── v1.54.5: above a size limit, a host that cannot serve never moves the store onto the main thread ─

/** Main's resident set in whole MB: one cheap read of THIS process, not an enumeration of any other. */
function mainRssMb(): number {
  try { return Math.round(process.memoryUsage.rss() / (1024 * 1024)) } catch { return -1 }
}

function clearRetryTimer(): void {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  nextRetryAt = null
}

const storeKey = (p: HostInitMsg): string => (p.syncDir ? `sync:${p.syncDir}` : `local:${p.userDataPath}`)

function probeWithTimeout(p: Promise<number | null>, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    ;(timer as { unref?: () => void }).unref?.()
    p.then(
      (v) => { clearTimeout(timer); resolve(typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null) },
      () => { clearTimeout(timer); resolve(null) },
    )
  })
}

/** How big the store is on the location `p` points at: from memory when it is already known, else one
 *  read of the disk (shared by everyone who asks while it is in flight). Never rejects and never takes
 *  longer than STORE_PROBE_TIMEOUT_MS: null means "could not tell", and the guard then fails open.
 *  Async: not one synchronous file call lands on the main thread. */
function ensureStoreSize(p: HostInitMsg): Promise<number | null> {
  const key = storeKey(p)
  const known = storeSizes.get(key)
  if (known !== undefined) return Promise.resolve(known)
  let probe = storeProbes.get(key)
  if (!probe) {
    const gen = clientGen
    probe = probeWithTimeout((async () => storeSizeProbe(p.userDataPath, p.syncDir))(), STORE_PROBE_TIMEOUT_MS)
      .then((bytes) => {
        if (gen === clientGen) {
          storeProbes.delete(key)
          if (bytes !== null) storeSizes.set(key, bytes)
        }
        return bytes
      })
    storeProbes.set(key, probe)
  }
  return probe
}

/** Start measuring the store now, if the guard is on (off means no extra file call at all). Resolves
 *  with the size, or null when it was not asked for or could not be read. */
function warmStoreSize(p: HostInitMsg): Promise<number | null> {
  return resolveInprocGuard().enabled ? ensureStoreSize(p) : Promise.resolve(null)
}

/** Let go of the current child, killing it: a failed start must not leave a hung process behind (a
 *  retry loop would stack them). */
function abandonChild(): void {
  const dead = transport
  transport = null
  try { dead?.kill() } catch { /* already gone */ }
}

/**
 * Every way the host can fail to serve ends here. Below the limit (or with the guard switched off, or
 * when the size cannot be read) it is exactly what it always was: load the store on the main thread.
 * Above the limit the main thread is never asked to: the client says so, honestly, and retries.
 *
 * Async only because the size may not be known yet; when it is (the normal case: it was asked for
 * beside the first spawn) the whole verdict runs synchronously, in the same turn as the failure. Every
 * caller keeps the client from answering in between, by holding readyPromise on this promise.
 */
async function fallBack(why: string): Promise<void> {
  if (stopped) return
  const gen = clientGen
  const guard = resolveInprocGuard()
  if (guard.enabled && initParams) {
    // Known already (the normal case: it was asked for beside the first spawn) means the verdict is
    // reached without waiting for the disk, in the same turn as the failure.
    const bytes = storeSizes.get(storeKey(initParams)) ?? await ensureStoreSize(initParams)
    if (stopped || gen !== clientGen) return
    if (bytes !== null && bytes > guard.maxBytes) { enterUnavailable(why, bytes, guard.maxBytes); return }
  }
  fallBackToInProcess(why)
}

function enterUnavailable(why: string, bytes: number, limit: number): void {
  const rssBefore = mainRssMb()
  abandonChild()
  readyPromise = null
  retrying = false
  mode = 'unavailable'
  startFailures += 1
  if (!unavailableSince) unavailableSince = Date.now()
  lastReason = why
  lastStoreBytes = bytes
  lastLimit = limit
  const delay = retryDelayMs(startFailures)
  logLoud(
    `UNAVAILABLE — ${why}. The store is ${Math.round(bytes / (1024 * 1024))} MB, above the ${Math.round(limit / (1024 * 1024))} MB limit for ` +
    `loading it on the main thread, so it is NOT loaded there: memory calls are refused until the host is back ` +
    `(main rss ${rssBefore} MB -> ${mainRssMb()} MB). Retry ${startFailures} in ${Math.round(delay / 1000)} s`,
  )
  scheduleRetry(delay)
}

/** Tell the Settings panel (through the guard module's small record) what state we are in. */
function publishUnavailable(): void {
  if (mode !== 'unavailable') { setMemoryUnavailableState(null); return }
  setMemoryUnavailableState({
    attempt: startFailures, nextRetryAt, retrying,
    storeBytes: lastStoreBytes, limitBytes: lastLimit, reason: lastReason, since: unavailableSince,
  })
}

function scheduleRetry(delayMs: number): void {
  clearRetryTimer()
  nextRetryAt = Date.now() + delayMs
  const timer = setTimeout(onRetryTimer, delayMs)
  // A pending retry must never be what keeps a quitting process (or a test worker) alive.
  ;(timer as { unref?: () => void }).unref?.()
  retryTimer = timer
  publishUnavailable()
}

function onRetryTimer(): void {
  // A retry timer exists only while mode is 'unavailable' with no retry running and the app not
  // quitting: every way out of that state (a retry that comes up, the in-process fallback, a restart of
  // the client, the quit) clears it first. So nothing is re-checked here.
  retryTimer = null
  nextRetryAt = null
  // P13 hook: the governor may say "not now". A broken governor must never keep memory down.
  let wait = 0
  if (retryGovernor) {
    try { wait = Number(retryGovernor({ attempt: startFailures })) } catch { wait = 0 }
  }
  if (Number.isFinite(wait) && wait > 0) { scheduleRetry(Math.min(wait, RETRY_CAP_MS)); return }
  void retryStart()
}

/**
 * One more try at the memory host, in the background. The mode stays 'unavailable' until the child
 * reports ready, so calls keep failing fast instead of queuing behind a start that may take minutes.
 * A retry is given longer than the last to load (a starved machine needs it); a failure goes back
 * through fallBack(), which re-judges the store from the size already known and schedules the next,
 * longer, wait.
 *
 * Preconditions, not re-checked: mode is 'unavailable', no retry is running, the app is not quitting.
 * Its two callers guarantee them (the timer exists only in that state; retryMemoryHostNow checks).
 */
async function retryStart(): Promise<void> {
  const gen = clientGen
  const attemptNo = startFailures
  retrying = true
  nextRetryAt = null
  publishUnavailable()
  logLoud(`retry ${attemptNo}: starting the memory host again`)
  try {
    await spawnAndInit({ timeoutMs: retryReadyTimeoutMs(READY_TIMEOUT_MS, attemptNo), keepMode: true })
    if (stopped || gen !== clientGen) return
    retrying = false
    unavailableSince = 0
    publishUnavailable() // the mode is 'host' now, so this clears the record
    logLoud(`memory is back (failed starts before it: ${attemptNo}): the store is OFF the main thread again`)
  } catch (err) {
    if (stopped || gen !== clientGen) return
    abandonChild()
    retrying = false
    await fallBack(`retry ${attemptNo} failed: ${(err as Error)?.message}`)
  }
}

function onChildMessage(msg: HostResponse): void {
  if (!msg || typeof msg !== 'object') return
  if (msg.kind !== 'result') return // 'ready' / 'init-error' are consumed by the handshake below
  const p = pending.get(msg.id)
  if (!p) return // a late reply to a call we already timed out / rejected — drop it
  pending.delete(msg.id)
  clearTimeout(p.timer)
  if (msg.ok) p.resolve(msg.result)
  else p.reject(rehydrate(msg.error, `memory host: ${p.fn} failed`))
}

function onChildExit(code: number, from?: MemoryHostTransport): void {
  // v1.54.5: an exit from a child that is no longer THE child must change nothing. That is a child we
  // abandoned (a failed start, killed), whose exit event lands after the next retry began (it would null
  // the live transport and make the retry's own 'ready' look like a start that was stopped), OR while
  // the verdict on the failure is still being reached (it would null readyPromise, and a call arriving
  // then would be answered from a store nobody loaded). utilityProcess is an EventEmitter: the same
  // exit can also be delivered twice.
  if (from && transport !== from) return
  const wasHost = mode === 'host'
  transport = null
  readyPromise = null
  // (a) nothing may hang. A pending call whose process just died must REJECT — a silent "empty
  // result" here would be indistinguishable from "you have no memories", the worst lie this app
  // can tell.
  failAllPending(`memory host exited unexpectedly (code ${code})`)
  if (!wasHost || !initParams || stopped) return

  // (b) respawn — but do not flap. A child that dies on init (bad key, corrupt store) would
  // otherwise restart forever, and the app would look alive while every call failed.
  const now = Date.now()
  // A host that ran a full restart window before it died is a fresh episode, not a crash loop: the
  // next failure starts the retry backoff over instead of climbing from where the last one stopped.
  if (now - hostReadyAt >= RESTART_WINDOW_MS) startFailures = 0
  restartTimes.push(now)
  while (restartTimes.length > 0 && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift()
  if (restartTimes.length > MAX_RESTARTS) {
    // 'starting' until the verdict is in, and readyPromise held on it: a call that arrives while the
    // store's size is still being read waits for the answer instead of reaching a store nobody loaded.
    mode = 'starting'
    readyPromise = fallBack(`host crashed ${restartTimes.length}x in ${RESTART_WINDOW_MS / 1000}s`)
    return
  }
  logLoud(`host exited (code ${code}) — respawning (${restartTimes.length}/${MAX_RESTARTS})`)
  // (c) no data loss: every write was appended to the JSONL before its RPC resolved, so the fresh
  // child reloads the same store from disk. Only genuinely in-flight calls are lost, and those
  // rejected loudly in (a).
  mode = 'starting' // a respawn is a start: 'host' with no child would be a lie, and a call waits on readyPromise
  readyPromise = spawnAndInit().catch((err) => {
    abandonChild() // a respawn that hung is killed, not left running beside whatever takes over
    return fallBack(`respawn failed: ${(err as Error)?.message}`)
  })
}

interface SpawnOptions {
  /** How long this start may take to report ready (default READY_TIMEOUT_MS). */
  timeoutMs?: number
  /** Leave the mode alone until the child is really ready (a background retry stays 'unavailable'). */
  keepMode?: boolean
}

async function spawnAndInit(opts: SpawnOptions = {}): Promise<void> {
  if (!initParams) throw new Error('memory client: no init params')
  if (!spawner) throw new Error('memory client: no spawner set')
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS
  // v1.38.2 — 'starting' is NOT cosmetic. The child can take a minute to come up on a large store
  // (a 3.2 GB shard set is decrypted and parsed before it reports ready), and for that whole window
  // the mode used to read 'unstarted' — which the Memory & Learning panel renders with the copy
  // written for a REAL failure: "could not start in a separate process... fell back to the main
  // thread". That is a lie told at exactly the moment a user opens the tab after launch, and the
  // panel never re-reads, so the lie sticks for the rest of the session. Startup and failure are
  // different states, so they get different names.
  //
  // v1.54.5: a background RETRY keeps the mode at 'unavailable' until its child is really ready. That is
  // the honest name for it (nothing can be served yet), and it keeps calls failing fast instead of
  // queuing behind a start that is allowed several minutes.
  if (!opts.keepMode) mode = 'starting'
  const t = spawner()
  if (!t) throw new Error('memory client: spawner returned null')
  transport = t

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`memory host did not report ready within ${timeoutMs}ms`))
    }, timeoutMs)

    t.onMessage((msg: HostResponse) => {
      if (!settled && msg?.kind === 'ready' && transport !== t) {
        // stopMemoryHost() ran while this child was starting, and its 'ready' was already on the
        // way. Taking it would set mode 'host' for a child that has been killed, and that child's
        // exit would then read as a crash and fork a replacement in the middle of the app's quit.
        // The stop's own kill may have come before the child had a pid, and been dropped: again.
        settled = true
        clearTimeout(timer)
        try { t.kill() } catch { /* already gone */ }
        reject(new Error('memory host stopped while starting'))
        return
      }
      if (!settled && msg?.kind === 'ready') {
        settled = true
        clearTimeout(timer)
        mode = 'host'
        hostReadyAt = Date.now()
        logLoud(`store is OFF the main thread — utilityProcess pid ${msg.pid}, ${msg.entries} entries`)
        resolve()
        return
      }
      if (!settled && msg?.kind === 'init-error') {
        settled = true
        clearTimeout(timer)
        reject(rehydrate(msg.error, 'memory host init failed'))
        return
      }
      onChildMessage(msg)
    })
    t.onExit((code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`memory host exited during startup (code ${code})`))
        return
      }
      onChildExit(code, t)
    })

    try {
      t.postMessage(initParams as HostInitMsg)
    } catch (err) {
      if (!settled) { settled = true; clearTimeout(timer); reject(err as Error) }
    }
  })
}

/**
 * Bring the memory store up. Resolves once it is serving — in the child if we could fork one, in
 * this process if we could not. Never rejects: a memory store that fails to start must not take the
 * terminal down with it.
 *
 * v1.54.5: "in this process" has a size limit. A store above it is NOT loaded on the main thread when
 * the child cannot serve: this resolves 'unavailable' and the child is retried in the background.
 */
export async function startMemoryHost(opts: StartMemoryHostOptions): Promise<Mode> {
  if (stopped) return mode
  const userDataPath = opts.userDataPath
  const syncDir = opts.syncDir ?? null
  // Provision the key BEFORE we choose a mode, so the host and the in-process fallback are given
  // byte-for-byte the same key story and can't diverge on which one encrypts.
  const { key, minted, readKeys, problem } = provisionMemoryKey(userDataPath, syncDir)
  initParams = {
    kind: 'init',
    userDataPath,
    syncDir,
    quantize: opts.quantize === true,
    encKeyB64: key ? key.toString('base64') : null,
    encKeyMinted: minted,
    readKeysB64: readKeys.map((k) => k.toString('base64')),
    keyProblem: problem,
    osEncryptionAvailable: isOsEncryptionAvailable(),
  }

  // A fresh start is a fresh episode: nothing from an earlier one (a retry timer, a backoff step) carries over.
  clearRetryTimer()
  retrying = false
  startFailures = 0
  unavailableSince = 0
  setMemoryUnavailableState(null)

  if (opts.inProcess || !spawner) {
    // Asked for, or nothing could ever start a host (and so nothing could ever retry one): in-process.
    fallBackToInProcess(opts.inProcess ? 'explicitly requested' : 'no utilityProcess spawner wired')
    return mode
  }
  // How big is the store? Asked for NOW, beside the spawn and not before it (the spawn below is still
  // synchronous), so that if the child fails the verdict does not have to wait for the disk.
  const sized = warmStoreSize(initParams)
  // Held on the verdict too (fallBack), not just on the spawn: a call that arrives while the size is
  // still being read must wait for it, not be answered from a store nobody has loaded.
  readyPromise = spawnAndInit().catch(async (err) => {
    abandonChild()
    await fallBack(`could not start the memory host: ${(err as Error)?.message}`)
  })
  try { await readyPromise } catch { /* fallBack does not throw; the mode below says what happened */ }
  // Resolve only once the size is known (or was given up on after 3 s): the first failure is then judged
  // without waiting for the disk. Nothing depends on this promise (calls wait on readyPromise, and the
  // app does not await us), and in the real app the child takes far longer than the read, so it adds
  // nothing; it keeps the verdict deterministic for a child that is ready at once.
  await sized
  return mode
}

/**
 * Stop the child (app shutdown). The store is already durable on disk. Final: the app is quitting,
 * so a host that is still starting, or one that exits after this, is never replaced.
 */
export function stopMemoryHost(): void {
  stopped = true
  // v1.54.5: a pending retry must not start a child in the middle of the quit, and the panel's record
  // must not outlive the thing it describes.
  clearRetryTimer()
  retrying = false
  setMemoryUnavailableState(null)
  try { transport?.kill() } catch { /* already gone */ }
  transport = null
  readyPromise = null
  // Back to 'unstarted', NOT 'host'. Leaving mode==='host' with a dead transport would route every
  // later call into inprocCall — against a swarmMemory in this process that was never initialised.
  // memoryCount() would then cheerfully answer 0 and memoryList() []: a silent empty store, which is
  // the precise lie this whole design exists to prevent. Unstarted makes those calls REJECT instead.
  mode = 'unstarted'
  failAllPending('memory host stopped')
}

// ── The call path ────────────────────────────────────────────────────────────────────────────────

function inprocCall(fn: string, args: unknown[]): Promise<unknown> {
  const handler = HOST_HANDLERS[fn] // the SAME whitelist the host dispatches through — they cannot drift
  if (typeof handler !== 'function') return Promise.reject(new Error(`memory client: unknown fn "${fn}"`))
  // Wrapped so a SYNC throw becomes a rejected promise: callers must never have to handle both.
  return Promise.resolve().then(() => (handler as (...a: unknown[]) => unknown)(...args))
}

async function call<T>(fn: string, args: unknown[] = []): Promise<T> {
  // Await the handshake FIRST, then judge the mode.
  //
  // Main deliberately does NOT block on startMemoryHost() — that is the whole point of the move, so
  // the window paints while the child loads. But `mode` only becomes 'host' when the child reports
  // ready, so between kickoff and ready it is still 'unstarted'. Testing it before the await would
  // reject every call made during those seconds — i.e. exactly the calls a just-launched app makes —
  // with "startMemoryHost() has not been called", which is both false and unrecoverable.
  //
  // Order matters and the two states are distinguishable: a client that was never started (or was
  // stopped) has readyPromise === null and still rejects, which is what keeps a call from silently
  // falling through to an uninitialised in-process store and answering "you have no memories".
  if (readyPromise) { try { await readyPromise } catch { /* handled — mode is now inproc */ } }
  if (mode === 'unstarted') {
    throw new Error(`memory client: startMemoryHost() has not been called (fn "${fn}")`)
  }
  // v1.54.5: the host is down and the store is too big to load here. REFUSE, with fixed text an agent
  // can recognise: falling through to inprocCall would run the handler against a store nobody
  // initialised and answer "0 memories" — the lie this whole module exists to prevent.
  if (mode === 'unavailable') throw new Error(unavailableMessage())
  if (mode !== 'host' || !transport) return (await inprocCall(fn, args)) as T

  const t = transport
  const id = nextId++
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      // A timeout is NOT a silent empty result. Say which call, and how long we waited.
      reject(new Error(`memory host timed out after ${CALL_TIMEOUT_MS}ms (fn "${fn}")`))
    }, CALL_TIMEOUT_MS)
    pending.set(id, { fn, resolve: resolve as (v: unknown) => void, reject, timer })
    try {
      t.postMessage({ kind: 'call', id, fn, args })
    } catch (err) {
      pending.delete(id)
      clearTimeout(timer)
      reject(err as Error)
    }
  })
}

// ── THE SCRUB BOUNDARY ───────────────────────────────────────────────────────────────────────────
/**
 * Install the secret scrubber. It stays HERE, in main — the whole point.
 *
 * It is also forwarded to the in-process module, so the fallback path scrubs exactly as it does
 * today and any direct swarmMemory.memoryWrite caller (brainIpc's snapshot import, the test suite)
 * is still covered. In host mode that forwarded copy is simply never reached.
 */
export function setMemoryScrubber(fn: MemoryScrubber | null): void {
  scrubber = fn
  inprocSetScrubber(fn)
}

export function memoryScrubStats(): { scrubbedWrites: number; secretsRedacted: number } {
  return { scrubbedWrites, secretsRedacted }
}

/**
 * Scrub UNCONDITIONALLY, before dispatch — never "only in host mode".
 *
 * Whether a secret gets redacted must not depend on a mode flag that a respawn or a slow handshake
 * could have flipped mid-call. Fail closed: always scrub, then dispatch. In host mode the secret
 * therefore never crosses into the memory process. In in-process mode swarmMemory scrubs the text a
 * second time, which is provably a no-op (the scanner finds nothing in already-redacted text, so
 * scrubContent's `hitCount > 0` guard returns the content byte-for-byte unchanged and increments
 * nothing) — so the cost of being safe here is zero.
 */
function scrubForWrite(content: string): { content: string; hits: number } {
  if (!scrubber) return { content, hits: 0 }
  try {
    const r = scrubber(content)
    if (!r || typeof r.redacted !== 'string' || !(r.hitCount > 0)) return { content, hits: 0 }
    scrubbedWrites++
    secretsRedacted += r.hitCount
    return { content: r.redacted, hits: r.hitCount }
  } catch {
    // Fail OPEN but loudly, matching swarmMemory.scrubContent: dropping the agent's memory because a
    // regex threw would be the bigger harm. The store's own scrubber (forwarded above) is the backstop.
    logLoud('secret scrubber threw — content sent unscrubbed (the store-side scrubber is the backstop)')
    return { content, hits: 0 }
  }
}

export async function memoryWrite(input: WriteInput): Promise<MemoryEntry> {
  if (!input || typeof input.content !== 'string' || !input.content.trim()) {
    throw new Error('memoryWrite: content required')
  }
  const { content, hits } = scrubForWrite(input.content)
  const entry = await call<MemoryEntry>('memoryWrite', [{ ...input, content }])
  // swarmMemory sets the transient `scrubbed` count when IT redacts. In host mode it never sees a
  // secret, so it reports nothing — preserve the contract by reporting what we redacted here.
  if (hits > 0 && entry && typeof entry === 'object') entry.scrubbed = hits
  return entry
}

// ── Proxied store API (all async — step 2 is an `await` insertion) ───────────────────────────────

export const memorySearch = (opts: SearchOptions): Promise<MemorySearchResult[]> => call('memorySearch', [opts])
export const memoryRelated = (opts: RelatedOptions): Promise<Array<MemorySearchResult & { relation?: string }>> => call('memoryRelated', [opts])
export const memoryGraphQuery = (opts: GraphQueryOptions): Promise<Array<MemorySearchResult & { relation: string; distance: number }>> => call('memoryGraphQuery', [opts])
export const memoryLink = (input: Parameters<typeof import('./swarmMemory').memoryLink>[0]): Promise<MemoryEdge | null> => call('memoryLink', [input])
export const memoryFeedback = (input: { id: string; helpful?: boolean; query?: string }): Promise<{ id: string; used: number }> => call('memoryFeedback', [input])
export const memoryList = (opts: ListOptions = {}): Promise<MemoryEntry[]> => call('memoryList', [opts])
export const memoryCount = (): Promise<number> => call('memoryCount', [])
export const memoryClear = (): Promise<void> => call('memoryClear', [])
export const memoryHasHash = (hash: string): Promise<boolean> => call('memoryHasHash', [hash])
export const memoryStats = (): Promise<{ count: number; capacity: number; corruptLinesSkipped: number; unreadableShards: string[] }> =>
  call('memoryStats', [])
export const memoryDashboardStats = (): Promise<MemoryDashboardStats> => call('memoryDashboardStats', [])
export const memoryGraphSample = (opts: { limit?: number } = {}): Promise<GraphSample> => call('memoryGraphSample', [opts])
// The knowledge graph is IN the memory process — it is loaded by initSwarmMemory, which runs there.
// Reading the in-main memoryGraph module instead gets you a scrupulously honest report on an empty
// adjacency Map: "0 nodes, 0 relation types" over a live 4.4 MB graph, and a brain export with no
// edges in it. Both shipped in v1.26.0. Counting stays in the child (in place, no copy of the edge
// set); only the tallies — or, for export, the JSONL — cross the wire.
export const graphStats = (): Promise<{ edges: number; nodes: number }> => call('graphStats', [])
export const graphRelationStats = (): Promise<Record<string, number>> => call('graphRelationStats', [])
// B2: WHO drew the edges, not just what they are. The Weave mines on the idle tick and its stats were
// thrown away, so a miner re-drawing the same edges forever looked exactly like a healthy one.
export const graphCreatorStats = (): Promise<Record<string, number>> => call('graphCreatorStats', [])
// B2: the pre-pass snapshot the Weave checks pairs against. It runs in main with SYNC deps, so it
// cannot ask per pair — one bounded call hands it the keys already drawn around this pass's window.
export const edgeKeysIncident = (ids: string[]): Promise<string[]> => call('edgeKeysIncident', [ids])
export const exportGraphEdges = (): Promise<string> => call('exportGraphEdges', [])
export const importGraphEdges = (jsonl: string): Promise<number> => call('importGraphEdges', [jsonl])
export const memoryRecentActivity = (limit = 14): Promise<ActivityRow[]> => call('memoryRecentActivity', [limit])
export const embeddingsReady = (): Promise<boolean> => call('embeddingsReady', [])
export const memorySourceById = (id: string): Promise<string | undefined> => call('memorySourceById', [id])
export const memoryDelete = (id: string): Promise<void> => call('memoryDelete', [id])
export const memoryArchive = (id: string): Promise<void> => call('memoryArchive', [id])
export const searchArchive = (query: string, limit = 20): Promise<MemoryEntry[]> => call('searchArchive', [query, limit])
export const memoryPatchProjects = (patches: Array<{ hash: string; project: string }>): Promise<number> => call('memoryPatchProjects', [patches])
export const memoryLessons = (limit = 200): Promise<MemoryEntry[]> => call('memoryLessons', [limit])
export const memoryPruneCodePath = (filePath: string): Promise<number> => call('memoryPruneCodePath', [filePath])
export const memoryForget = (opts: { now?: number; max?: number } = {}): Promise<number> => call('memoryForget', [opts])
export const memoryBackfillVectors = (max = 200): Promise<number> => call('memoryBackfillVectors', [max])
export const warmProbeEmbeddings = (): Promise<boolean> => call('warmProbeEmbeddings', [])
export const compactSelfShard = (opts?: { force?: boolean }): Promise<{ compacted: boolean; before: number; after: number }> => call('compactSelfShard', [opts])
export const persistMemoryIndex = (): Promise<void> => call('persistMemoryIndex', [])
export const consolidationCandidates = (limit = 500): Promise<ConsolEntry[]> => call('consolidationCandidates', [limit])
export const weaveCandidates = (limit = 300): Promise<WeaveEntry[]> => call('weaveCandidates', [limit])
export const weaveNeighbours = (id: string, k = 6): Promise<WeaveNeighbour[]> => call('weaveNeighbours', [id, k])
/** Every candidate's neighbourhood in ONE round trip. runWeave calls neighbours() from inside a sync
 *  loop over ~300 candidates; proxying it per-id would be ~300 RPCs per idle pass. Pre-fetch this,
 *  then hand runWeave a sync `(id) => map[id] ?? []`. */
export const weaveNeighboursBatch = (ids: string[], k = 6): Promise<Record<string, WeaveNeighbour[]>> => call('weaveNeighboursBatch', [ids, k])
/** The subset of `hashes` already in the store, in ONE round trip. The ingest loops consume hasHash
 *  as a SYNC predicate over every chunk (tens of thousands per pass) — and a Promise is truthy, so a
 *  per-chunk async proxy would mark every chunk "already stored" and silently ingest nothing. */
export const memoryKnownHashes = (hashes: string[]): Promise<string[]> => call('memoryKnownHashes', [hashes])
export const backfillCodeRefs = (id: string, refs: CodeRef[]): Promise<void> => call('backfillCodeRefs', [id, refs])
export const symbolHistory = (query: string, projectKey?: string): Promise<MemoryEntry[]> => call('symbolHistory', [query, projectKey])
export const vectorRamStats = (): Promise<VectorRamStats> => call('vectorRamStats', [])
export const setVectorQuantization = (on: boolean): Promise<VectorRamStats> => call('setVectorQuantization', [on])
export const getSyncStatus = (): Promise<SyncStatus> => call('getSyncStatus', [])
export const reloadMemoryFromSync = (): Promise<void> => call('reloadMemoryFromSync', [])
export const disableSyncEncryption = (): Promise<SyncStatus> => call('disableSyncEncryption', [])

// A respawn re-inits from initParams, so every call that changes what the store is running on records
// it there — or a crash mid-session would quietly put the store back the way it booted.

// (A call that resolved means startMemoryHost ran, so initParams is set — hence the casts below.)

/** Point the store at a sync folder, or (null) back at its own local file. */
export async function setSyncDir(dir: string | null): Promise<SyncStatus> {
  const status = await call<SyncStatus>('setSyncDir', [dir])
  initParams = { ...(initParams as HostInitMsg), syncDir: status.syncing ? status.dir : null }
  // The store now lives somewhere else: have its size ready before a failure needs it, so that verdict
  // never waits on a disk read at the moment the machine is struggling (v1.54.5).
  void warmStoreSize(initParams)
  return status
}

/** Turn local at-rest encryption off. The store decrypts everything and retires the key file; a
 *  respawn must then come up without that key too. */
export async function disableEncryption(): Promise<SyncStatus> {
  const status = await call<SyncStatus>('disableEncryption', [])
  const p = initParams as HostInitMsg
  if (p.encKeyB64) {
    // Not dropped: the store keeps the old key in its read ring, and so must a fresh child.
    initParams = { ...p, encKeyB64: null, encKeyMinted: false, readKeysB64: [p.encKeyB64, ...p.readKeysB64] }
  }
  return status
}
// brainIpc.ts imports these two DIRECTLY from swarmMemory today — which, once the store moves, would
// export/import against an EMPTY in-main store. Proxied here so step 2 can repoint it.
// string[] not string: a >512 MiB brain joined into ONE string throws RangeError (V8 max-string) and
// can't cross IPC as a single value — an array of small lines does both fine. See swarmMemory export.
export const exportMemorySnapshot = (): Promise<string[]> => call('exportMemorySnapshot', [])
export const importMemorySnapshot = (lines: string[]): Promise<{ imported: number }> => call('importMemorySnapshot', [lines])

// ── Encryption: the ops that need main's keychain ────────────────────────────────────────────────

/**
 * enableLocalEncryption, but with the mint done where a keychain exists.
 *
 * In the child, maybeAutoEncrypt() can't mint (the child has no keychain) and the call would be a
 * SILENT no-op: the user ticks "encrypt my memory" and nothing happens. So mint + persist here, then
 * have the store adopt the key (which clears the opt-out and ciphertext-ifies the existing plaintext).
 *
 * An existing key file is used if it opens, and never replaced if it doesn't (Decision 1): a file the
 * keychain refuses is still the only key to whatever was written under it.
 */
export async function enableLocalEncryption(): Promise<SyncStatus> {
  const p = initParams
  if (mode !== 'host' || !p) return call('enableLocalEncryption', []) // in-process: safeStorage is right here
  if (p.syncDir) return call('enableLocalEncryption', [])             // synced stores use the passphrase model
  if (keyStorageMode() !== 'keychain') return call('enableLocalEncryption', []) // no keychain → honest no-op, encrypted:false

  const keyPath = path.join(p.userDataPath, KEY_CACHE_FILE)
  const found = inspectMemoryKey(keyPath)
  if (found.problem) {
    throw new Error(`The memory key file can't be used (${found.problem}), so encryption can't be turned on. It was left exactly as it is.`)
  }
  let key = found.key
  if (!key) {
    key = crypto.randomBytes(32)
    createSecretExclusive(keyPath, key.toString('base64')) // throws — writing nothing — if a file beat us to it
  }
  const status = await call<SyncStatus>('adoptEncryptionKeyB64', [key.toString('base64')])
  initParams = { ...p, encKeyB64: key.toString('base64'), encKeyMinted: false } // survive a respawn
  return status
}

/**
 * setSyncPassphrase: the store derives, validates and applies the key itself (it has the salt and the
 * ciphertext to check against).
 *
 * Main no longer caches the result. It used to write it into memory-sync.key — the DEVICE key's file —
 * overwriting the key the local brain is encrypted under (Decision 1). The passphrase key lives for the
 * session; persisting it belongs in its own file, which v2 sync introduces.
 */
export const setSyncPassphrase = (passphrase: string): Promise<SyncStatus> => call('setSyncPassphrase', [passphrase])

/**
 * Decision 1 — "Start a new memory key", the only way past a LOCKED store, and only ever by the user.
 *
 * The old key file is retired (renamed aside, its bytes verified, never deleted), a new key is minted
 * exclusively, and the store starts writing under it. Nothing is rewritten: older memories stay on disk
 * as they are, readable again whenever the old key works — every retired key is retried on every
 * launch. It needs a real keychain (a new key is never written in the clear), and it is refused on a
 * store that isn't locked, where it would only cost every later launch an extra key to try.
 */
export async function startNewMemoryKey(): Promise<SyncStatus> {
  const p = initParams
  if (!p) throw new Error(`memory client: startMemoryHost() has not been called (fn "startNewMemoryKey")`)
  if (keyStorageMode() !== 'keychain') {
    throw new Error("This computer has no OS keychain to protect a new memory key, so one can't be started.")
  }
  const before = await call<SyncStatus>('getSyncStatus', [])
  if (!before.ownLocked) throw new Error("Memory isn't locked — there is no need to start a new key.")
  const keyPath = path.join(p.userDataPath, KEY_CACHE_FILE)
  if (!inspectMemoryKey(keyPath).absent) {
    const retired = retireSecretFile(keyPath, 'new-memory-key')
    logLoud(`memory key retired to ${path.basename(retired)} — a new one is being started`)
  }
  const key = crypto.randomBytes(32)
  createSecretExclusive(keyPath, key.toString('base64'))
  const readKeysB64 = retiredMemoryKeys(keyPath).map((k) => k.toString('base64')) // includes the one just retired, if it opens
  const status = await call<SyncStatus>('startNewMemoryKeyB64', [key.toString('base64'), readKeysB64])
  initParams = { ...p, encKeyB64: key.toString('base64'), encKeyMinted: false, readKeysB64, keyProblem: null } // survive a respawn
  return status
}

// ── consolidationSimOf — a closure rebuilt from data ─────────────────────────────────────────────
/**
 * Same signature shape as swarmMemory's (returns a `(a, b) => number` comparator), but the vectors
 * are compared in the host and only the resulting matrix crosses. Pass the SAME limit you pass to
 * consolidationCandidates, or the comparator will not know some of the entries you hand it (unknown
 * ids score 0 — precisely what the in-process closure does for a vector-less entry).
 */
export async function consolidationSimOf(limit = 200): Promise<(a: ConsolEntry, b: ConsolEntry) => number> {
  const { ids, sim } = await call<{ ids: string[]; sim: number[] }>('consolidationSimMatrix', [limit])
  const idx = new Map<string, number>()
  ids.forEach((id, i) => idx.set(id, i))
  const n = ids.length
  return (a, b) => {
    const i = idx.get(a?.id)
    const j = idx.get(b?.id)
    if (i === undefined || j === undefined) return 0
    return sim[i * n + j] ?? 0
  }
}

/**
 * Pairwise similarity over ids the CALLER chose, row-major, `ids.length²` long. The consolidation
 * variant picks its own set in the host; memory_pool already holds the lesson rows it wants
 * grouped, so it needs this one. Bounded host-side (MAX_SIM_IDS) — a longer id list is truncated,
 * never shipped whole.
 */
export const entrySimMatrix = (ids: string[]): Promise<number[]> => call('entrySimMatrix', [ids])

// ── Pure helpers — deliberately NOT proxied ──────────────────────────────────────────────────────
// These read no store state. RPC-ing them would mean a process round-trip to lowercase a string, and
// worse, it would make them async — poisoning the tight sync loops and hash paths that call them.
// Re-exported straight through, so they stay synchronous and step 2 doesn't touch those call sites.
export {
  normalizeProjectSlug, projectKeyOf, entityDedupHash, contentHash, canonicalEntityName,
}
export type {
  MemoryEntry, MemorySearchResult, WriteInput, SearchOptions, RelatedOptions, GraphQueryOptions,
  ListOptions, SyncStatus, MemoryScrubber, VectorRamStats, MemoryDashboardStats, ActivityRow,
  EmbeddingsStatus,
}

// ── The real Electron transport ──────────────────────────────────────────────────────────────────
// Integration code: exercised in the running app, not the unit suite (the orchestration above is
// what the tests drive, through an injected transport). Excluded from coverage for the same reason
// embedWorker.ts's main half is.
/* c8 ignore start */

/** The bundled host entry, emitted next to the main `index.js` (a third electron-vite input).
 *  `import.meta.url`, not `__dirname`: package.json is `"type": "module"` and the built main bundle
 *  is real ESM, where __dirname does not exist. Same resolution embedWorker.resolveWorkerPath uses. */
export function resolveMemoryHostPath(): string {
  // e2e seam (v1.54.5, e2e/memory-host-unavailable.spec.ts): lets a real-Electron spec point the memory
  // process at a script that dies at once, to watch the "unavailable" state in the real app. Unset in
  // every real run, like TERMPOLIS_TEST_SHIM_DIR.
  const override = process.env.TERMPOLIS_TEST_MEMORY_HOST_PATH
  return override || fileURLToPath(new URL('./memoryHost.js', import.meta.url))
}

/**
 * Fork the real utilityProcess. Wired by the app via
 *   setMemoryHostSpawner(() => createMemoryHostTransport())
 * and never in tests.
 *
 * GOTCHA (asymmetric, and it bites): in the CHILD, `parentPort.on('message', e => …)` receives an
 * Electron MessageEvent and the payload is `e.data`. In the PARENT, `child.on('message', m => …)`
 * receives the payload DIRECTLY. Unwrap `.data` on both sides and every message arrives undefined —
 * which looks exactly like an empty memory store.
 */
export function createMemoryHostTransport(hostPath: string = resolveMemoryHostPath()): MemoryHostTransport {
  const child = utilityProcess.fork(hostPath, [], {
    serviceName: 'termpolis-memory',
    // The store is the app's biggest heap by far (the BM25 index alone measured 1,914 MB). Give the
    // child room, and note that this ceiling is now the CHILD's problem, not the window's.
    execArgv: ['--max-old-space-size=4096'],
  })
  return {
    postMessage: (msg) => child.postMessage(msg),
    onMessage: (cb) => { child.on('message', (m: HostResponse) => cb(m)) },
    onExit: (cb) => { child.on('exit', (code: number) => cb(code)) },
    kill: () => killUtility(child),
    get pid() { return child.pid },
  }
}
/* c8 ignore stop */
