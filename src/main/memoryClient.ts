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
import { deriveKey } from './memoryCrypto'
import { readSecret, writeSecret, isOsEncryptionAvailable } from './secureKeyStore'
import {
  HOST_HANDLERS,
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
  KEY_CACHE_FILE, SALT_FILE, ENCRYPTION_OPTOUT_FILE,
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

type Mode = 'unstarted' | 'host' | 'inproc'

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

/** Set the spawner (the app wires this to a real utilityProcess; tests inject a fake). Mirrors
 *  localEmbedder.setWorkerSpawner. With none set, startMemoryHost runs the store in-process. */
export function setMemoryHostSpawner(fn: MemoryHostSpawner | null): void {
  spawner = fn
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
 */
export function provisionMemoryKey(
  userDataPath: string,
  syncDir: string | null,
): { key: Buffer | null; minted: boolean } {
  const keyPath = path.join(userDataPath, KEY_CACHE_FILE)
  try {
    const existing = readSecret(keyPath)
    if (existing) {
      const k = Buffer.from(existing, 'base64')
      if (k.length === 32) return { key: k, minted: false }
    }
  } catch { /* fall through to the mint decision */ }

  if (syncDir) return { key: null, minted: false }                                   // passphrase model
  try {
    if (fs.existsSync(path.join(userDataPath, ENCRYPTION_OPTOUT_FILE))) return { key: null, minted: false }
  } catch { /* treat an unreadable opt-out marker as absent */ }
  if (!isOsEncryptionAvailable()) return { key: null, minted: false }                // honest plaintext

  try {
    const key = crypto.randomBytes(32)
    writeSecret(keyPath, key.toString('base64')) // OS-encrypted at rest, in the ONLY process that can
    return { key, minted: true }
  } catch {
    return { key: null, minted: false } // never leave a half-written key behind — stay plaintext
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
  logLoud(`FALLBACK — running the memory store on the MAIN thread: ${why}`)
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
    inprocInit(initParams.userDataPath, { syncDir: initParams.syncDir, encKey })
    if (encKey && initParams.encKeyMinted) inprocAdoptKey(encKey)
    if (scrubber) inprocSetScrubber(scrubber)
  } catch (err) {
    logLoud(`in-process memory init FAILED too: ${(err as Error)?.message}`)
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

function onChildExit(code: number): void {
  const wasHost = mode === 'host'
  transport = null
  readyPromise = null
  // (a) nothing may hang. A pending call whose process just died must REJECT — a silent "empty
  // result" here would be indistinguishable from "you have no memories", the worst lie this app
  // can tell.
  failAllPending(`memory host exited unexpectedly (code ${code})`)
  if (!wasHost || !initParams) return

  // (b) respawn — but do not flap. A child that dies on init (bad key, corrupt store) would
  // otherwise restart forever, and the app would look alive while every call failed.
  const now = Date.now()
  restartTimes.push(now)
  while (restartTimes.length > 0 && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift()
  if (restartTimes.length > MAX_RESTARTS) {
    fallBackToInProcess(`host crashed ${restartTimes.length}x in ${RESTART_WINDOW_MS / 1000}s`)
    return
  }
  logLoud(`host exited (code ${code}) — respawning (${restartTimes.length}/${MAX_RESTARTS})`)
  // (c) no data loss: every write was appended to the JSONL before its RPC resolved, so the fresh
  // child reloads the same store from disk. Only genuinely in-flight calls are lost, and those
  // rejected loudly in (a).
  readyPromise = spawnAndInit().catch((err) => {
    fallBackToInProcess(`respawn failed: ${(err as Error)?.message}`)
  })
}

async function spawnAndInit(): Promise<void> {
  if (!initParams) throw new Error('memory client: no init params')
  if (!spawner) throw new Error('memory client: no spawner set')
  const t = spawner()
  if (!t) throw new Error('memory client: spawner returned null')
  transport = t

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`memory host did not report ready within ${READY_TIMEOUT_MS}ms`))
    }, READY_TIMEOUT_MS)

    t.onMessage((msg: HostResponse) => {
      if (!settled && msg?.kind === 'ready') {
        settled = true
        clearTimeout(timer)
        mode = 'host'
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
      onChildExit(code)
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
 */
export async function startMemoryHost(opts: StartMemoryHostOptions): Promise<Mode> {
  const userDataPath = opts.userDataPath
  const syncDir = opts.syncDir ?? null
  // Provision the key BEFORE we choose a mode, so the host and the in-process fallback are given
  // byte-for-byte the same key story and can't diverge on which one encrypts.
  const { key, minted } = provisionMemoryKey(userDataPath, syncDir)
  initParams = {
    kind: 'init',
    userDataPath,
    syncDir,
    quantize: opts.quantize === true,
    encKeyB64: key ? key.toString('base64') : null,
    encKeyMinted: minted,
    osEncryptionAvailable: isOsEncryptionAvailable(),
  }

  if (opts.inProcess || !spawner) {
    fallBackToInProcess(opts.inProcess ? 'explicitly requested' : 'no utilityProcess spawner wired')
    return mode
  }
  readyPromise = spawnAndInit()
  try {
    await readyPromise
  } catch (err) {
    try { transport?.kill() } catch { /* already gone */ }
    fallBackToInProcess(`could not start the memory host: ${(err as Error)?.message}`)
  }
  return mode
}

/** Stop the child (app shutdown). The store is already durable on disk. */
export function stopMemoryHost(): void {
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
export const memoryStats = (): Promise<{ count: number; capacity: number; corruptLinesSkipped: number }> => call('memoryStats', [])
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
export const setSyncDir = (dir: string | null): Promise<SyncStatus> => call('setSyncDir', [dir])
export const reloadMemoryFromSync = (): Promise<void> => call('reloadMemoryFromSync', [])
export const disableSyncEncryption = (): Promise<SyncStatus> => call('disableSyncEncryption', [])
export const disableEncryption = (): Promise<SyncStatus> => call('disableEncryption', [])
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
 * In the child, maybeAutoEncrypt() bails at `!isOsEncryptionAvailable()` and the call is a SILENT
 * no-op: the user ticks "encrypt my memory" and nothing happens. So mint + persist here, then have
 * the store adopt the key (which clears the opt-out and ciphertext-ifies the existing plaintext).
 */
export async function enableLocalEncryption(): Promise<SyncStatus> {
  const p = initParams
  if (mode !== 'host' || !p) return call('enableLocalEncryption', []) // in-process: safeStorage is right here
  if (p.syncDir) return call('enableLocalEncryption', [])             // synced stores use the passphrase model
  if (!isOsEncryptionAvailable()) return call('enableLocalEncryption', []) // no keychain → honest no-op, encrypted:false

  const keyPath = path.join(p.userDataPath, KEY_CACHE_FILE)
  let key: Buffer | null = null
  try {
    const existing = readSecret(keyPath)
    if (existing) { const k = Buffer.from(existing, 'base64'); if (k.length === 32) key = k }
  } catch { /* mint a fresh one below */ }
  if (!key) {
    key = crypto.randomBytes(32)
    writeSecret(keyPath, key.toString('base64'))
  }
  const status = await call<SyncStatus>('adoptEncryptionKeyB64', [key.toString('base64')])
  initParams = { ...p, encKeyB64: key.toString('base64'), encKeyMinted: false } // survive a respawn
  return status
}

/**
 * setSyncPassphrase, plus the keychain write the child cannot do.
 *
 * The store derives, validates and applies the key itself (it has the salt and the ciphertext to
 * check against) — but it cannot CACHE it: writeSecret needs safeStorage, and the host fences off
 * its plaintext fallback precisely so a child can never drop the sync key on disk in the clear. So
 * main re-derives the same key from the same passphrase + salt and persists it properly; without
 * this the store would work all session and then ask for the passphrase again on every launch.
 */
export async function setSyncPassphrase(passphrase: string): Promise<SyncStatus> {
  const status = await call<SyncStatus>('setSyncPassphrase', [passphrase])
  const p = initParams
  if (mode === 'host' && p?.syncDir) {
    try {
      const salt = fs.readFileSync(path.join(p.syncDir, SALT_FILE)) // written by the store; present by now
      const key = deriveKey(passphrase, salt)
      writeSecret(path.join(p.userDataPath, KEY_CACHE_FILE), key.toString('base64'))
      initParams = { ...p, encKeyB64: key.toString('base64'), encKeyMinted: false } // survive a respawn
    } catch {
      // Best effort, exactly as swarmMemory treats it. The store is unlocked for this session; the
      // worst case is re-entering the passphrase next launch. Never a plaintext key on disk.
      logLoud('could not cache the sync key in the OS keychain — the passphrase will be needed again next launch')
    }
  }
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
  return fileURLToPath(new URL('./memoryHost.js', import.meta.url))
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
    kill: () => { try { child.kill() } catch { /* already gone */ } },
    get pid() { return child.pid },
  }
}
/* c8 ignore stop */
