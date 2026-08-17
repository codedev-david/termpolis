// v1.26 — the memory brain, hosted OUT of the Electron main process.
//
// WHY: initSwarmMemory() blocks for ~4,276 ms at launch on a real 475 MB / 90,817-entry store
// (rebuildVectorIndex alone is an 18.8 s pathological case — see the freeze diagnosis), and every
// search/write after that competes with the thread that echoes PTY keystrokes and paints the window.
// Moving the store into a `utilityProcess` (VS Code's model) makes that cost ZERO on the main thread.
//
// This file is the CHILD half: it owns the store and serves RPC over `process.parentPort`. The MAIN
// half is memoryClient.ts, which proxies the same API and is what src/main/index.ts talks to.
//
// Shape is deliberately the same as the embedding worker (embedWorker.ts + localEmbedder.ts): the
// integration edge (a real forked process) lives here, and the testable orchestration — spawn,
// timeout, crash, fallback — lives in the client behind an injectable transport.
//
// ── Two constraints the child cannot wish away ────────────────────────────────────────────────────
//
// 1. NO safeStorage. `require('electron')` resolves in a utilityProcess but exposes no `safeStorage`
//    (DPAPI / Keychain / libsecret are main-process-only). So the child cannot unwrap the at-rest AES
//    key, and it cannot wrap a new one. Main does both and injects the unwrapped key (`encKeyB64`).
//
// 2. NO scrubber. `setMemoryScrubber(fn)` installs a CALLBACK, and a function cannot cross IPC. A
//    naive port would silently drop it and start persisting unscrubbed secrets — so the scrub runs
//    in MAIN, on the client side, BEFORE content is sent here (see memoryClient.memoryWrite). The
//    secret therefore never enters this process at all, which is strictly better than today. Nothing
//    in this file installs a scrubber, and nothing in it should: content arriving here is already
//    scrubbed, and swarmMemory's own scrubContent() is a byte-for-byte no-op with none installed.

import {
  initSwarmMemory,
  adoptEncryptionKey,
  memoryWrite, memorySearch, memoryRelated, memoryLink, memoryGraphQuery, memoryFeedback,
  memoryList, memoryCount, memoryClear, memoryHasHash, memoryStats, memoryDashboardStats,
  memoryGraphSample, memoryRecentActivity, embeddingsReady, memorySourceById, memoryDelete,
  consolidationCandidates, consolidationSimOf,
  memoryPatchProjects, memoryLessons, memoryPruneCodePath, warmProbeEmbeddings, compactSelfShard,
  weaveCandidates, weaveNeighbours, backfillCodeRefs, symbolHistory, memoryArchive, searchArchive,
  memoryForget, memoryBackfillVectors, memoryScrubStats,
  getSyncStatus, setSyncDir, reloadMemoryFromSync, setSyncPassphrase, disableSyncEncryption,
  enableLocalEncryption, disableEncryption,
  persistMemoryIndex, vectorRamStats, setVectorQuantization,
  exportMemorySnapshot, importMemorySnapshot,
} from './swarmMemory'
// The graph is part of the brain, not a main-thread sidecar: initMemoryGraph() is called by
// initSwarmMemory(), which runs HERE. v1.26.0 ported the store and left these four behind in main,
// where they read an adjacency Map that nothing ever fills — see noGhostBrainState.test.ts.
import { graphStats, graphRelationStats, graphCreatorStats, edgeKeysIncident, exportGraphEdges, importGraphEdges } from './memoryGraph'
import { setSafeStorage } from './secureKeyStore'
import type { WeaveNeighbour } from './mnemeWeave'

// ── Wire protocol ────────────────────────────────────────────────────────────────────────────────
// Discriminated on `kind` rather than "the first message is init, the rest are calls" — an ordering
// convention is exactly the kind of thing that breaks silently under a respawn race.

export interface SerializedError {
  message: string
  name: string
  stack?: string
}

export interface HostInitMsg {
  kind: 'init'
  userDataPath: string
  syncDir: string | null
  /** The user's persisted int8-quantization choice. Must be applied BEFORE the store is built: the
   *  packed vector array is allocated inside initSwarmMemory, so the mode has to be known by then.
   *  Setting it afterwards is not merely untidy — setVectorQuantization() re-runs initSwarmMemory(),
   *  so the child would build the whole 90k-entry vector store TWICE on every launch. */
  quantize?: boolean
  /** The already-unwrapped 32-byte AES key, base64. Main owns safeStorage; the child never does. */
  encKeyB64: string | null
  /** True when main MINTED this key on this launch (the store had none). The store on disk is then
   *  still PLAINTEXT and needs the one-time ciphertext rewrite that maybeAutoEncrypt() would have
   *  done. False for an existing key — rewriting a 475 MB shard on every boot is not free. */
  encKeyMinted?: boolean
  /** Whether MAIN has a working OS keychain. The child mirrors that answer rather than guessing, so
   *  its at-rest behaviour is identical to main's on the same machine (see installKeychainGuard). */
  osEncryptionAvailable?: boolean
}
export interface HostCallMsg {
  kind: 'call'
  id: number
  fn: string
  args: unknown[]
}
export type HostRequest = HostInitMsg | HostCallMsg

export interface HostReadyMsg { kind: 'ready'; pid: number; entries: number }
export interface HostInitErrorMsg { kind: 'init-error'; error: SerializedError }
export interface HostOkMsg { kind: 'result'; id: number; ok: true; result: unknown }
export interface HostErrMsg { kind: 'result'; id: number; ok: false; error: SerializedError }
export type HostResponse = HostReadyMsg | HostInitErrorMsg | HostOkMsg | HostErrMsg

/** Errors do not survive structured clone — an Error posted as-is arrives as `{}`. Flatten it, or a
 *  failed RPC reaches the client as a mystery and the caller sees "memory is empty" instead of why. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { message: err.message || String(err), name: err.name || 'Error', stack: err.stack }
  }
  return { message: typeof err === 'string' ? err : JSON.stringify(err) ?? 'unknown error', name: 'Error' }
}

// ── The dispatch whitelist ───────────────────────────────────────────────────────────────────────
// An EXPLICIT map, never `swarmMemory[msg.fn]`. A dynamic lookup on a name from the wire would let
// any message reach any export — including the test seams (_resetForTests, _setEmbedFnForTests) and
// module internals. The map is also the contract: if a name is not here, step 2 cannot call it, and
// it fails loudly at the seam instead of silently resolving `undefined`.
//
// `(...args: never[])` keeps this `any`-free: parameters are contravariant, so every concrete
// signature below is assignable to it, and the cast happens once at the call site.
type HostHandler = (...args: never[]) => unknown

// consolidationSimOf() returns a CLOSURE over the packed vector store. A function cannot cross a
// process boundary, and proxying it per-pair would be ~20,000 round trips per consolidation pass.
// So the pairwise matrix is computed HERE in one shot, over exactly the candidate set the caller is
// about to consolidate, and shipped as DATA. The client rebuilds an identical closure over it.
// Bonus: the O(n² · 384) cosine loop leaves the main thread along with everything else.
const MAX_SIM_CANDIDATES = 1000 // bounds the payload: n² floats. 200 (the real caller) => 40k.

export function consolidationSimMatrix(limit: number): { ids: string[]; sim: number[] } {
  const n0 = Math.max(0, Math.min(Math.floor(limit) || 0, MAX_SIM_CANDIDATES))
  const cands = consolidationCandidates(n0)
  const simOf = consolidationSimOf()
  const n = cands.length
  const sim = new Array<number>(n * n).fill(0)
  for (let i = 0; i < n; i++) {
    // The diagonal is computed, not assumed to be 1 — in-process, simOf(a, a) is 0 when the entry
    // has no vector (embedder off / model absent). Preserve that exactly.
    sim[i * n + i] = simOf(cands[i], cands[i])
    for (let j = i + 1; j < n; j++) {
      const s = simOf(cands[i], cands[j])
      sim[i * n + j] = s
      sim[j * n + i] = s // symmetric — cosine is
    }
  }
  return { ids: cands.map((c) => c.id), sim }
}

// runWeave calls neighbours(id, k) INSIDE its candidate loop — 300 candidates means 300 calls. In
// process that was 300 array lookups; over RPC it is 300 round trips per idle pass. So the whole
// neighbourhood is fetched in ONE call and the caller hands runWeave a sync `(id) => map.get(id)`.
// (An object, not a Map: a Map survives structured clone, but keeping the wire plain-JSON-ish means
// the payload is inspectable in the same way every other handler's is.)
const MAX_NEIGHBOUR_IDS = 1000 // the real caller passes 300; bounds the payload at ids × k

export function weaveNeighboursBatch(ids: string[], k: number): Record<string, WeaveNeighbour[]> {
  const out: Record<string, WeaveNeighbour[]> = {}
  if (!Array.isArray(ids)) return out
  for (const id of ids.slice(0, MAX_NEIGHBOUR_IDS)) {
    if (typeof id !== 'string' || !id) continue
    if (out[id]) continue // a duplicate id would re-run the ANN query for nothing
    // Per-id try/catch: one bad id must not lose the other 299 neighbourhoods. An empty list is
    // exactly what the in-process weaveNeighbours returns for a vector-less memory, so a failure
    // here degrades to "no analogies for this one", never to a wrong edge.
    try { out[id] = weaveNeighbours(id, k) } catch { out[id] = [] }
  }
  return out
}

// Same shape, same reason: conversationIngest/codeIngest ask hasHash() once PER CHUNK, and a real
// history is tens of thousands of chunks per pass. Batched per FILE, that is one round trip per
// file. Returns the subset already stored — the caller rebuilds a Set and answers synchronously.
//
// This one is load-bearing for CORRECTNESS, not just speed: `hasHash` is consumed as a SYNC
// predicate (`if (deps.hasHash(h))`), and a Promise is TRUTHY — so a per-chunk async proxy would
// report every chunk as already-stored and ingestion would silently write NOTHING, forever.
const MAX_HASH_QUERY = 5000

export function memoryKnownHashes(hashes: string[]): string[] {
  if (!Array.isArray(hashes)) return []
  const out: string[] = []
  for (const h of hashes.slice(0, MAX_HASH_QUERY)) {
    if (typeof h === 'string' && h && memoryHasHash(h)) out.push(h)
  }
  return out
}

// GOTCHA: a Buffer does NOT survive structured clone AS a Buffer — it arrives as a plain Uint8Array,
// and `Buffer.isBuffer()` on it is false. So key material crosses the wire as base64, never as a
// Buffer, and is rehydrated here. (Every other handler below takes/returns plain JSON-ish data.)
export function adoptEncryptionKeyB64(b64: string): ReturnType<typeof adoptEncryptionKey> {
  return adoptEncryptionKey(Buffer.from(String(b64 ?? ''), 'base64'))
}

export const HOST_HANDLERS: Record<string, HostHandler> = {
  // reads
  memorySearch, memoryRelated, memoryGraphQuery, memoryList, memoryCount, memoryHasHash,
  memoryStats, memoryDashboardStats, memoryGraphSample, memoryRecentActivity, embeddingsReady,
  memorySourceById, memoryLessons, searchArchive, symbolHistory, weaveCandidates, weaveNeighbours,
  consolidationCandidates, vectorRamStats, memoryScrubStats, getSyncStatus, exportMemorySnapshot,
  // the graph — counted in place, so only the tallies cross the wire, never the edge set
  graphStats, graphRelationStats, graphCreatorStats, edgeKeysIncident, exportGraphEdges,
  // writes / mutations
  memoryWrite, memoryLink, memoryFeedback, memoryDelete, memoryArchive, memoryClear,
  memoryPatchProjects, memoryPruneCodePath, memoryForget, backfillCodeRefs, importMemorySnapshot,
  importGraphEdges,
  // maintenance / lifecycle
  warmProbeEmbeddings, compactSelfShard, persistMemoryIndex, reloadMemoryFromSync,
  memoryBackfillVectors, setVectorQuantization,
  // encryption + sync. NOTE: setSyncPassphrase / enableLocalEncryption need safeStorage to PERSIST
  // the key, which this process does not have — memoryClient wraps both and does the keychain half
  // in main. adoptEncryptionKeyB64 is the injection point it calls.
  setSyncDir, setSyncPassphrase, disableSyncEncryption, enableLocalEncryption, disableEncryption,
  adoptEncryptionKeyB64,
  // composites (not 1:1 swarmMemory exports — see above). Each collapses a per-item RPC that the
  // consumer calls from INSIDE a sync loop into one round trip.
  consolidationSimMatrix, weaveNeighboursBatch, memoryKnownHashes,
}

// ── Fail-CLOSED keychain guard ───────────────────────────────────────────────────────────────────
// secureKeyStore.writeSecret() falls back to writing PLAINTEXT when no safeStorage impl is installed:
//
//     if (impl) { fs.writeFileSync(p, OSK_PREFIX + impl.encryptString(s)) }
//     else      { fs.writeFileSync(p, secret) }        // <-- the raw AES key, in the clear
//
// That fallback is sound in main (an impl is always wired there) and a LEAK here. setSyncPassphrase()
// calls writeSecret with NO `isOsEncryptionAvailable()` guard, so an unguarded child would write the
// key that decrypts the entire synced store to disk in plaintext, right beside the ciphertext. An
// impl that reports available and then THROWS makes such a write fail CLOSED instead of failing open:
// swarmMemory's existing try/catch degrades honestly (key simply not cached) and nothing lands in the
// clear. memoryClient then re-persists the key properly, through main's real keychain.
//
// When main has NO keychain we install nothing, mirroring main exactly — including its pre-existing
// plaintext fallback. The child must not be MORE broken than main, and it must not be different.
export function installKeychainGuard(osEncryptionAvailable: boolean): void {
  if (!osEncryptionAvailable) {
    setSafeStorage(null) // mirror main on a keyring-less box: honest plaintext, encrypted:false
    return
  }
  setSafeStorage({
    isEncryptionAvailable: () => true, // must be true, or setSafeStorage() drops the impl -> plaintext fallback
    encryptString: () => { throw new Error('memoryHost: no safeStorage in a utilityProcess — main owns the keychain') },
    decryptString: () => { throw new Error('memoryHost: no safeStorage in a utilityProcess — main owns the keychain') },
  })
}

// ── Request handling ─────────────────────────────────────────────────────────────────────────────

let initialised = false

/** Run one call against the whitelist. Sync and async exports are handled uniformly (`await` on a
 *  non-promise is the value itself), so the client only ever sees Promises. */
export async function handleCall(msg: HostCallMsg): Promise<HostResponse> {
  const handler = HOST_HANDLERS[msg.fn]
  if (typeof handler !== 'function') {
    // Not "return undefined" — an unknown fn is a wiring bug, and a silent undefined would read as
    // "the memory store is empty", which is the failure mode this whole design exists to prevent.
    return { kind: 'result', id: msg.id, ok: false, error: { name: 'Error', message: `memoryHost: unknown fn "${String(msg.fn)}"` } }
  }
  if (!initialised) {
    return { kind: 'result', id: msg.id, ok: false, error: { name: 'Error', message: `memoryHost: not initialised (fn "${String(msg.fn)}")` } }
  }
  try {
    const args = Array.isArray(msg.args) ? msg.args : []
    const result = await (handler as (...a: unknown[]) => unknown)(...args)
    return { kind: 'result', id: msg.id, ok: true, result }
  } catch (err) {
    return { kind: 'result', id: msg.id, ok: false, error: serializeError(err) }
  }
}

/** Bring the store up with the key main unwrapped (or minted) for us. */
export function handleInit(msg: HostInitMsg): HostResponse {
  try {
    installKeychainGuard(msg.osEncryptionAvailable !== false)
    // Quantization mode BEFORE the store is built — the packed vector array is allocated inside
    // initSwarmMemory. Setting it after would work, but only by re-running initSwarmMemory from
    // inside setVectorQuantization: a second full load of a 90k-entry store on every launch.
    // Before the store exists this is a pure flag write (userDataDir is unset, so it rebuilds
    // nothing), which is precisely how index.ts sequenced it in-process.
    try { setVectorQuantization(msg.quantize === true) } catch { /* fall back to exact floats */ }
    // A truncated/garbage key makes initSwarmMemory throw (it validates 32 bytes) — which is exactly
    // right: the client then falls back to in-process rather than serving an "empty" store that is
    // really a fully populated ENCRYPTED one we simply cannot read.
    const encKey = msg.encKeyB64 ? Buffer.from(msg.encKeyB64, 'base64') : null
    initSwarmMemory(msg.userDataPath, { syncDir: msg.syncDir ?? null, encKey })
    // Main minted this key on THIS launch, so the shard on disk is still plaintext: initSwarmMemory
    // read it fine (plaintext and ciphertext lines coexist) but maybeAutoEncrypt() early-returned
    // with a key already set, so nothing rewrote it. Do that one-time rewrite now — it is precisely
    // the half of maybeAutoEncrypt() a child process CAN do; the mint + keychain write happened in main.
    if (encKey && msg.encKeyMinted) adoptEncryptionKey(encKey)
    initialised = true
    return { kind: 'ready', pid: process.pid, entries: memoryCount() }
  } catch (err) {
    initialised = false
    return { kind: 'init-error', error: serializeError(err) }
  }
}

/** Route one inbound message. Exported so the unit suite can drive the child half without a fork. */
export async function handleMessage(msg: HostRequest): Promise<HostResponse | null> {
  if (!msg || typeof msg !== 'object') return null
  if (msg.kind === 'init') return handleInit(msg)
  if (msg.kind === 'call') return await handleCall(msg)
  return null
}

/** @internal test-only — the child is a module singleton; let the suite re-drive init. */
export function _resetHostForTests(): void {
  initialised = false
}

// ── Child-process bootstrap ──────────────────────────────────────────────────────────────────────
// `process.parentPort` exists ONLY when this module is running as a forked utilityProcess, so
// importing it from main (or from the unit suite) is a no-op — same guard as embedWorker.ts's
// `parentPort?.on(...)`.
//
// GOTCHA, and it is asymmetric: in the CHILD the listener receives an Electron MessageEvent and the
// payload is `e.data`; in the PARENT, `child.on('message', ...)` receives the payload DIRECTLY. Get
// this backwards and every message arrives as `undefined` — which, again, looks exactly like "the
// memory store is empty".
interface ParentPortLike {
  on(channel: 'message', cb: (e: { data: HostRequest }) => void): void
  postMessage(msg: HostResponse): void
  start?: () => void
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort

// Integration code: `parentPort` is undefined outside a real fork, so the unit suite can never enter
// this block — it drives handleMessage() directly instead. It IS covered, by a real Electron
// utilityProcess probe. Excluded for the same reason embedWorker.ts's main half is.
/* c8 ignore start */
if (parentPort) {
  parentPort.on('message', (e) => {
    void (async () => {
      try {
        const res = await handleMessage(e?.data)
        if (res) parentPort.postMessage(res)
      } catch (err) {
        // Last-resort net. A throw that escapes here would leave the caller's promise pending
        // FOREVER — a hang is worse than an error, because nothing upstream can even see it.
        const id = (e?.data as HostCallMsg | undefined)?.id
        if (typeof id === 'number') {
          parentPort.postMessage({ kind: 'result', id, ok: false, error: serializeError(err) })
        }
      }
    })()
  })
  parentPort.start?.()
}
/* c8 ignore stop */
