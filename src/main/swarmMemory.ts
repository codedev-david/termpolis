import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { recordSwarmError } from './telemetry'
import { recordAnomaly } from './memoryAnomalyLog'
import { embedText, EMBED_DIM, isEmbedderReady } from './localEmbedder'
import { deriveKey, newSalt, encryptLine, decryptLine, isEncryptedLine } from './memoryCrypto'
import { VectorStore } from './vectorStore'
import { LexicalIndex } from './lexicalIndex'
import { TtlLruCache, rankScore, mergeRelated, gateByScore } from './memoryEconomy'
import { rerankEnabled, getRerankScorer, rerankByScorer } from './crossEncoderRerank'
import { initMemoryAudit, auditMemory, redactPreview } from './memoryAudit'
import { mmrRerank } from './mmrRerank'
import { initMemoryGraph, addMemoryEdge, traverseGraph, edgesFrom, neighboursOf, graphStats, graphRelationStats, getAllEdges, expandWithGraph, effectiveWeight, EDGE_EPSILON, _resetGraphForTests, clearMemoryGraph, removeNodeEdges, type MemoryEdge } from './memoryGraph'
import { relationPrior, filterSuperseded } from './mnemeGraphLogic'
import { learnedUtility } from './mnemeRetrieval'
import { interestCentroid, cosineSim, tasteBoost } from './mnemeAdapt'
import { inferMemoryType, isLessonType } from './mnemeTypeInfer'
import { sampleGraph, graphNodeLabel, type GraphSample } from './memoryGraphSample'
import { weeklyGrowth, activityOp, type TimeBucket } from './memoryTimeline'
import { type ConsolEntry } from './mnemeConsolidate'
import { HnswIndex, type SerializedHnsw } from './hnswIndex'
import { readSecret, writeSecret, isOsEncryptionAvailable } from './secureKeyStore'
import { projectKeyOf } from './projectKey'
import type { CodeRef } from './codeGraph'
import type { WeaveEntry, WeaveNeighbour } from './mnemeWeave'

// Shared swarm memory — a lightweight RAG layer so agents can write facts,
// decisions, and hand-offs once and have other agents retrieve them later
// without re-discovering the same context. Storage is JSONL in userData so
// we don't need native deps (better-sqlite3/sqlite-vec require per-Electron-
// ABI builds that are painful to ship on Windows). Vector search uses the
// in-process local embedder (bge-small via WASM — see localEmbedder.ts); if
// the model isn't ready it falls back to a keyword-overlap score that's
// "good enough" for small corpora. Either way the API is identical.

export interface MemoryEntry {
  id: string
  ts: number
  agentId: string                 // terminal id or logical name ("conductor")
  kind: 'message' | 'result' | 'decision' | 'fact' | 'note'
  content: string
  tags?: string[]
  taskId?: string
  embedding?: number[]
  source?: string                 // provenance (e.g. 'claude'|'codex'|'gemini' for ingested transcripts)
  project?: string                // normalized project slug (cwd basename) — current-directory recall
  projectKey?: string             // F19: stable unique key of the FULL path — disambiguates same-basename repos
  hash?: string                   // content hash for idempotent ingestion dedup
  // --- Mneme learning layer (see docs/learning-architecture.md). All optional and
  // additive: old records simply lack them, and JSONL round-trips them for free. ---
  memoryType?: 'episodic' | 'semantic' | 'procedural' | 'entity' | 'summary' // cognitive facet — ORTHOGONAL to `kind`
  importance?: number             // 0..1 base salience set at write (reflection sets this high for lessons)
  originEpisode?: string          // the task/session id a distilled lesson was derived from
  // F6: TRANSIENT write-result flag on the value RETURNED by memoryWrite — never persisted
  // and never present on stored entries. `durable === false` means the append did not reach
  // disk (the write is RAM-only this session and will be retried), so the caller isn't misled.
  durable?: boolean
  // F14: TRANSIENT — set on the returned entry when content exceeded MAX_CONTENT and its
  // tail was dropped, so the caller (agent) knows to split rather than believing it filed
  // the whole note. Never persisted.
  truncated?: boolean
  originalChars?: number
  // WP-G: TRANSIENT — how many secrets the memory-at-rest scrub redacted out of this write's
  // content before it was hashed/embedded/persisted. Present only on the value RETURNED by
  // memoryWrite (never on a stored entry, never on disk) so the caller can write an audit
  // entry. Absent ⇒ nothing was scrubbed.
  scrubbed?: number
  // v1.23 C2 — the memory<->code BRIDGE join key. Structured code anchors for the files/symbols
  // this memory is about, resolved through the code graph. Optional + additive (old records lack
  // it; JSONL round-trips it). symbolHistory() maps a code symbol back to the memories that carry it.
  codeRefs?: CodeRef[]
}

/** Normalize a cwd/path or bare name into a lowercase project slug (its basename). This is
 *  the DISPLAY scope; it collides across repos with the same folder name (see projectKeyOf). */
export function normalizeProjectSlug(pathOrName: string): string {
  if (typeof pathOrName !== 'string') return ''
  const base = pathOrName.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  return base.trim().toLowerCase().slice(0, 128)
}

// F19: projectKeyOf is now shared with the code graph (src/main/projectKey.ts) so the SAME repo
// resolves to the SAME key on both sides — the join the memory<->code bridge relies on. Imported
// above and re-exported here for back-compat with existing importers of swarmMemory.projectKeyOf.
export { projectKeyOf }

export interface MemorySearchResult extends MemoryEntry {
  score: number                   // 0..1, higher is better
}

// Semantic-search window kept hot in memory. The durable JSONL on disk is
// append-only and retains everything written; this only caps how many of the
// most-recent chunks stay loaded for vector/keyword search, to bound RAM.
// The machinery to carry a 500k window shipped across v1.11.66–69: embeddings
// live in a packed Float32Array (~1.5 KB/chunk; vectorStore.ts), the HNSW graph
// makes search sub-linear (hnsw.ts, recall-gated, brute-force fallback), its
// build is lazy/yielded so it can't freeze startup, and the graph persists to
// disk so relaunches skip the rebuild. Worst-case RAM at a FULL window is real
// but acceptable for a dev tool: ~750 MB of vectors (500k × 384 dims × 4 B)
// plus entry text — and a corpus only pays for what it actually has; typical
// brains are far below the cap. Configurable for tests.
const DEFAULT_MAX_ENTRIES = 500_000
let maxEntries = DEFAULT_MAX_ENTRIES
let evictedAny = false  // Tier-2: true once any entry was evicted beyond the hot window; blocks LOCAL-shard compaction that would otherwise drop on-disk overflow
const MAX_CONTENT = 16 * 1024      // cap per-entry content size
const MAX_EMBEDDING_DIM = 1024

// ---- State ----
let memPath: string | null = null     // active WRITE target: legacy local file OR this device's sync shard
let userDataDir: string | null = null
let legacyPath: string | null = null  // <userData>/swarm-memory.jsonl (default local store / migration source)
let deviceId = ''                     // stable per-machine id — names this device's shard
let syncDir: string | null = null     // null = local-only (default); a folder = cross-machine sync
const entries: MemoryEntry[] = []
const seenHashes = new Set<string>()  // content hashes present — idempotent ingest guard
const tombstones = new Set<string>()  // deleted entry ids (OR-Set) — propagate across devices via shards
const tombstonedHashes = new Set<string>() // F22: deleted CONTENT hashes — kills the dedup twin so a deleted memory can't resurface under a different id
let clearEpoch = 0                    // epoch tombstone: entries with ts <= this are cleared everywhere
let seq = 0
let embeddingsAvailable: boolean | null = null  // cached probe result
let embedOverride: ((text: string) => Promise<number[] | null>) | null = null
let scrubFn: MemoryScrubber | null = null   // WP-G: injected secret scrubber (null = store verbatim)
let scrubbedWrites = 0                      // WP-G: writes whose content was redacted before storage
let secretsRedacted = 0                     // WP-G: total secrets redacted out of those writes
let encKey: Buffer | null = null      // AES key for at-rest shard encryption (null = plaintext)
let lockedShards = false              // encrypted shards present that we couldn't read (need passphrase)
let initDegraded = false              // F5: init failed and fell back to a local writable store (writes still persist)
let corruptLinesSkipped = 0           // F28: unparseable shard lines dropped on the last reload (surfaced, not silent)
let lockedLinesSkipped = 0            // F28: encrypted-but-undecryptable lines on the last reload
let fsyncCount = 0                    // F26: observable count of durable (fsync'd) appends — for tests
// Packed vector index: real (EMBED_DIM) embeddings live in one Float32Array
// instead of per-entry number[] (the memory win), with bidirectional maps to the
// owning entry. Non-EMBED_DIM vectors (tests/legacy) stay as number[] on the
// entry and use the exact per-object path, so behaviour there is unchanged.
// Tier-1 (BB8): int8 vector quantization — a pure IN-RAM representation (~4x less vector RAM).
// Disk keeps exact floats and re-packs on load, so this is safe to toggle. OFF by default; enable
// with TERMPOLIS_MEM_QUANTIZE=1. Every (re)build of the store goes through newVectorStore() so the
// setting survives reload / rebuild / compaction.
// How many lines OUR OWN shard has on disk, and which entry ids we contributed. Both are known
// without reading anything: we counted them at load, and we increment on every append.
//
// They exist so compactSelfShard can answer "is this even worth doing?" from MEMORY. The exact
// answer needs the whole shard read, every line AES-DECRYPTED and parsed, and every output line
// AES-RE-ENCRYPTED -- and the "not enough dead weight to bother" gate used to run AFTER all of
// that. Measured on a real 450 MB / 107k-line encrypted shard: 4.4 SECONDS of synchronous
// main-thread work, every 30 minutes, then thrown away. That was the app going "(Not Responding)".
let ownShardLines = 0
const ownShardAddIds = new Set<string>()

let quantizeVectors = false
/** An explicit user/app choice (Settings toggle). `null` = never chosen, fall back to env. */
let quantizeExplicit: boolean | null = null
function newVectorStore(): VectorStore { return new VectorStore(EMBED_DIM, 1024, { quantize: quantizeVectors }) }
/** @internal test-only */ export function _setQuantizeForTests(v: boolean): void { quantizeVectors = v }
/** @internal test-only */ export function _isVectorStoreQuantizedForTests(): boolean { return vectorStore.quantized }
let vectorStore = newVectorStore()
const rowToEntry = new Map<number, MemoryEntry>()    // store row → live entry
const entryRow = new WeakMap<MemoryEntry, number>()  // live entry → store row
// HNSW graph for sub-linear search once the store is large. Below the threshold,
// the exact brute-force scan over the packed store is already fast, so we don't
// bother. The graph is built LAZILY, in the BACKGROUND, and YIELDED on a frame
// budget (never at startup, so it can't reintroduce a launch freeze; never
// blocking the search that triggers it — that search falls back to the exact
// brute-force scan until the graph is ready) and kept fresh incrementally on write.
let hnsw: HnswIndex | null = null
let hnswStale = false
let hnswDeletedSinceBuild = 0                   // Tier-2: deletions excluded by the search-time `allow` filter but not yet rebuilt out of the graph
const HNSW_REPAIR_RATIO = 0.15                  // rebuild the graph once >15% of indexed rows are dead (below that the allow-filter handles it cheaply)
let hnswThreshold = 50_000
let hnswBuilding = false                       // a background build is in flight
let buildGen = 0                               // F34: bumped when the store is replaced (reload/rebuild) — an in-flight build aborts if this changed under it
let hnswBuildDone: Promise<void> = Promise.resolve() // resolves when it finishes (tests await this)
let hnswYieldMs = 8                            // yield to the event loop every N ms of build work

// ---- Init / persistence ----
//
// Cross-machine sync model: the store is an append-only set of immutable entries
// keyed by id + content hash — i.e. a grow-only set, so merging two devices is a
// conflict-free union (order-independent, idempotent). Each device writes ONLY
// its own shard file (`<syncDir>/<deviceId>.jsonl`); a file-sync tool (Syncthing/
// Dropbox/git) moves shards around, and single-writer-per-file means there are
// never write conflicts. Deletes are tombstones (per-id) + a clear epoch, which
// propagate the same way. Local-only (no syncDir) keeps the original single-file
// behaviour byte-for-byte.

const SYNC_CONFIG_FILE = 'memory-sync.json'
const DEVICE_ID_FILE = 'device-id'
const SALT_FILE = '.termpolis-salt'      // lives in the SYNC folder — shared across devices, not secret
const KEY_CACHE_FILE = 'memory-sync.key' // lives in userData — LOCAL to this device, never synced
const ENCRYPTION_OPTOUT_FILE = 'memory-encryption.optout' // WP-F: presence = user turned default-on encryption OFF
const DELETES_FILE = 'memory-deletes.json' // userData — device-local DURABLE floor of clearEpoch + tombstones
// F1: reject a clear epoch further than this into the future — a mis-clocked (dead-CMOS/
// drifted-VM) or corrupt peer must never be able to poison the global epoch and wipe the brain.
const MAX_CLOCK_SKEW_MS = 2 * 86_400_000

function deletesFile(): string | null { return userDataDir ? path.join(userDataDir, DELETES_FILE) : null }

// Device-local durable delete floor: the highest clear epoch and the union of tombstoned
// ids this device has ever observed, persisted in userData. It (a) refuses an absurd
// future epoch (F1), (b) keeps a clear/delete in force after the shard that first carried
// it is lost or lags (F10), and (c) is seeded into every reload instead of resetting to ∅.
function loadDeletesFloor(): { clearEpoch: number; tombstones: string[]; tombstonedHashes: string[] } {
  const f = deletesFile()
  if (!f) return { clearEpoch: 0, tombstones: [], tombstonedHashes: [] }
  try {
    if (fs.existsSync(f)) {
      const o = JSON.parse(fs.readFileSync(f, 'utf8')) as { clearEpoch?: unknown; tombstones?: unknown; tombstonedHashes?: unknown }
      const ce = typeof o.clearEpoch === 'number' && o.clearEpoch >= 0 && o.clearEpoch <= Date.now() + MAX_CLOCK_SKEW_MS ? o.clearEpoch : 0
      const ts = Array.isArray(o.tombstones) ? (o.tombstones as unknown[]).filter((x): x is string => typeof x === 'string') : []
      const th = Array.isArray(o.tombstonedHashes) ? (o.tombstonedHashes as unknown[]).filter((x): x is string => typeof x === 'string') : []
      return { clearEpoch: ce, tombstones: ts, tombstonedHashes: th }
    }
  } catch { /* corrupt → empty floor (never throws) */ }
  return { clearEpoch: 0, tombstones: [], tombstonedHashes: [] }
}
function persistDeletesFloor(): void {
  const f = deletesFile()
  if (!f) return
  try { fs.writeFileSync(f, JSON.stringify({ clearEpoch, tombstones: [...tombstones], tombstonedHashes: [...tombstonedHashes] })) } catch { /* best effort */ }
}

// F35: a coarse per-machine fingerprint. deviceId names this device's shard, and the
// merge model relies on single-writer-per-shard. If the device-id file rides along in a
// restored backup / cloned disk / imaged VM onto a DIFFERENT machine, that invariant breaks
// (two machines append to one shard → interleaved-write corruption). Binding the id to a
// machine fingerprint lets us detect the restore and mint a fresh id.
function machineFingerprint(): string {
  let host = ''
  try { host = os.hostname() } catch { /* ignore */ }
  return crypto.createHash('sha1').update(`${host}|${process.platform}|${process.arch}`).digest('hex').slice(0, 16)
}

function loadOrCreateDeviceId(dir: string): string {
  const p = path.join(dir, DEVICE_ID_FILE)
  const fp = machineFingerprint()
  try {
    const raw = fs.readFileSync(p, 'utf8').trim()
    let stored: { id?: unknown; fp?: unknown }
    try { stored = JSON.parse(raw) } catch { stored = { id: raw } } // legacy: a bare id string
    if (stored && typeof stored.id === 'string' && stored.id) {
      // Same machine (or a legacy file with no fingerprint) → adopt the id, upgrading the
      // format to record this machine's fingerprint. A DIFFERENT fingerprint means the file
      // was restored onto another machine → fall through and mint a fresh id.
      if (typeof stored.fp !== 'string' || stored.fp === fp) {
        if (stored.fp !== fp) { try { fs.writeFileSync(p, JSON.stringify({ id: stored.id, fp })) } catch { /* best effort */ } }
        return stored.id
      }
    }
  } catch { /* create below */ }
  const id = crypto.randomBytes(8).toString('hex')
  try { fs.writeFileSync(p, JSON.stringify({ id, fp })) } catch { /* best effort — falls back to an ephemeral id */ }
  return id
}

function readSyncConfig(dir: string): string | null {
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, SYNC_CONFIG_FILE), 'utf8'))
    return obj && typeof obj.dir === 'string' && obj.dir ? obj.dir : null
  } catch { return null }
}

function writeSyncConfig(dir: string, syncTo: string | null): void {
  try { fs.writeFileSync(path.join(dir, SYNC_CONFIG_FILE), JSON.stringify({ dir: syncTo })) } catch { /* best effort */ }
}

// Every shard this device should read in sync mode: all *.jsonl in the folder
// (own shard + peers'). In local-only mode it's just the single store file.
function shardFiles(): string[] {
  if (!syncDir) return memPath ? [memPath] : []
  try {
    return fs.readdirSync(syncDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(syncDir as string, f))
  } catch { return memPath ? [memPath] : [] }
}

type ShardLineClass =
  | { t: 'add'; entry: MemoryEntry }
  | { t: 'delete'; id: string }
  | { t: 'deleteHash'; hash: string } // F22: tombstone by content hash (kills the dedup twin)
  | { t: 'clear'; before: number }
  | { t: 'clearIds'; ids: string[] }
  | { t: 'reinforce'; deltas: Array<{ id: string; used: number; ts: number }> }
  | { t: 'patch'; hash: string; project: string; projectKey?: string } // F30: persisted project backfill
  | { t: 'codeRefsPatch'; id: string; codeRefs: CodeRef[] } // v1.23 C4: persisted bridge backfill by id
  | { t: 'locked' }   // encrypted line we couldn't decrypt (need passphrase)
  | { t: 'corrupt' }  // unparseable bytes (torn write / bit-rot / bad merge) — counted, not silent
  | { t: 'skip' }     // blank / valid-JSON-but-not-a-record

// Classify ONE shard line without mutating any module state. The stateful merge —
// tombstones, the clamped clear epoch, own-shard causal exemption — lives in reloadFrom
// so it can reason about which shard a line came from and where it sits in that shard.
function classifyShardLine(line: string): ShardLineClass {
  const s = line.trim()
  if (!s) return { t: 'skip' }
  let plain: string = s
  if (isEncryptedLine(s)) {
    const dec = encKey ? decryptLine(encKey, s) : null
    if (dec === null) return { t: 'locked' } // no key / wrong key → can't read this entry
    plain = dec
  }
  let obj: { id?: unknown; content?: unknown; deleted?: unknown; deletedHash?: unknown; clearedBefore?: unknown; clearedIds?: unknown; reinforce?: unknown; patch?: unknown; codeRefsPatch?: unknown }
  try { obj = JSON.parse(plain) } catch { return { t: 'corrupt' } } // F28: a genuine parse failure is corruption, not noise
  if (!obj || typeof obj !== 'object') return { t: 'skip' }
  if (typeof obj.deleted === 'string') return { t: 'delete', id: obj.deleted }
  if (typeof obj.deletedHash === 'string') return { t: 'deleteHash', hash: obj.deletedHash }
  if (obj.codeRefsPatch && typeof obj.codeRefsPatch === 'object') {
    const p = obj.codeRefsPatch as { id?: unknown; codeRefs?: unknown }
    if (typeof p.id === 'string' && Array.isArray(p.codeRefs)) {
      return { t: 'codeRefsPatch', id: p.id, codeRefs: p.codeRefs as CodeRef[] }
    }
    return { t: 'skip' }
  }
  if (obj.patch && typeof obj.patch === 'object') {
    const p = obj.patch as { hash?: unknown; project?: unknown; projectKey?: unknown }
    if (typeof p.hash === 'string' && typeof p.project === 'string') {
      return { t: 'patch', hash: p.hash, project: p.project, projectKey: typeof p.projectKey === 'string' ? p.projectKey : undefined }
    }
    return { t: 'skip' }
  }
  if (Array.isArray(obj.clearedIds)) return { t: 'clearIds', ids: (obj.clearedIds as unknown[]).filter((x): x is string => typeof x === 'string') }
  if (typeof obj.clearedBefore === 'number') return { t: 'clear', before: obj.clearedBefore }
  if (Array.isArray(obj.reinforce)) {
    const deltas: Array<{ id: string; used: number; ts: number }> = []
    for (const r of obj.reinforce as Array<{ id?: unknown; used?: unknown; ts?: unknown }>) {
      if (r && typeof r.id === 'string' && typeof r.used === 'number') deltas.push({ id: r.id, used: r.used, ts: typeof r.ts === 'number' ? r.ts : 0 })
    }
    return { t: 'reinforce', deltas }
  }
  if (obj.id && typeof obj.content === 'string') return { t: 'add', entry: obj as unknown as MemoryEntry }
  return { t: 'skip' }
}

// Rebuild the hot window from a set of shard files: union of adds, minus
// tombstones (deleted ids + clear epoch), deduped by id and content-hash,
// newest-maxEntries kept. Order-independent → safe to merge any device set.
function reloadFrom(paths: string[]): void {
  entries.length = 0
  seenHashes.clear()
  // reloadFrom() only runs when the shard file EXISTS, so on a fresh store these would keep the
  // previous store's values and the compaction gate would be answered from stale facts.
  ownShardLines = 0
  ownShardAddIds.clear()
  // F1/F10: seed from the device-local durable floor rather than from ∅, so a clear/delete
  // survives the loss of whatever shard first carried it, and a bogus future epoch is
  // refused (loadDeletesFloor already clamps it) instead of poisoning the store.
  const floor = loadDeletesFloor()
  clearEpoch = floor.clearEpoch
  tombstones.clear()
  for (const id of floor.tombstones) tombstones.add(id)
  tombstonedHashes.clear()
  for (const h of floor.tombstonedHashes) tombstonedHashes.add(h)
  lockedShards = false
  corruptLinesSkipped = 0
  lockedLinesSkipped = 0
  pendingReinforce = []
  const skewCap = Date.now() + MAX_CLOCK_SKEW_MS
  const adds: MemoryEntry[] = []
  const patches: Array<{ hash: string; project: string; projectKey?: string }> = [] // F30
  const codeRefsPatches: Array<{ id: string; codeRefs: CodeRef[] }> = [] // v1.23 C4 bridge backfill
  const ownAddIds = new Set<string>()      // adds that came from THIS device's own shard
  let ownLineCount = 0 // lines physically in OUR shard, counted as we already walk them
  const ownVulnerable = new Set<string>()  // own adds appearing BEFORE an own clear line (pre-clear → epoch-droppable)
  const ownTombstoned = new Set<string>()  // ids the own shard already records (delete/clearIds) — re-emission dedup
  for (const p of paths) {
    let raw: string
    try { raw = fs.readFileSync(p, 'utf8') } catch { continue }
    const isOwn = !!memPath && path.resolve(p) === path.resolve(memPath)
    const shardAdds: string[] = [] // own-shard add ids seen so far — marked vulnerable when a clear line follows
    for (const line of raw.split('\n')) {
      if (isOwn && line.trim()) ownLineCount++
      const c = classifyShardLine(line)
      switch (c.t) {
        case 'add':
          adds.push(c.entry)
          if (isOwn) { ownAddIds.add(c.entry.id); shardAdds.push(c.entry.id) }
          break
        case 'delete':
          tombstones.add(c.id)
          if (isOwn) ownTombstoned.add(c.id)
          break
        case 'deleteHash':
          tombstonedHashes.add(c.hash)
          break
        case 'clearIds':
          for (const id of c.ids) { tombstones.add(id); if (isOwn) ownTombstoned.add(id) }
          break
        case 'clear':
          // F1: never let an unbounded/absurd future epoch (bad clock / corruption) poison the store.
          if (c.before > clearEpoch && c.before > 0 && c.before <= skewCap) clearEpoch = c.before
          // F23: entries written to this shard BEFORE this clear line pre-date the clear.
          if (isOwn) for (const id of shardAdds) ownVulnerable.add(id)
          break
        case 'reinforce':
          for (const d of c.deltas) pendingReinforce.push(d)
          break
        case 'patch':
          patches.push({ hash: c.hash, project: c.project, projectKey: c.projectKey })
          break
        case 'codeRefsPatch':
          codeRefsPatches.push({ id: c.id, codeRefs: c.codeRefs })
          break
        case 'locked':
          lockedShards = true
          lockedLinesSkipped++
          break
        case 'corrupt':
          corruptLinesSkipped++ // F28: count, don't silently swallow
          break
        case 'skip':
          break
      }
    }
  }
  // Publish what we learned about our own shard, so compaction can be gated from memory
  // instead of by re-reading and re-decrypting the entire thing.
  ownShardLines = ownLineCount
  ownShardAddIds.clear()
  for (const id of ownAddIds) ownShardAddIds.add(id)

  // F28: partial corruption used to shrink the brain invisibly. Surface it so the UI can
  // warn and the raw bytes can be recovered before the next rewrite overwrites them.
  if (corruptLinesSkipped > 0) {
    recordSwarmError('swarmMemory.reload.corruptLines', new Error(`skipped ${corruptLinesSkipped} corrupt shard line(s)`), { corruptLinesSkipped, lockedLinesSkipped })
  }
  adds.sort((a, b) => (a.ts || 0) - (b.ts || 0)) // stable, oldest→newest
  const seenIds = new Set<string>()
  const clearedByEpoch: string[] = [] // ids suppressed by the epoch this reload — pinned as identity tombstones
  for (const e of adds) {
    if (seenIds.has(e.id)) continue                 // same id in >1 file (e.g. legacy migration)
    if (tombstones.has(e.id)) continue              // explicitly deleted / identity-cleared
    if (e.hash && tombstonedHashes.has(e.hash)) continue // F22: content-hash tombstone kills the twin
    if ((e.ts || 0) <= clearEpoch) {
      // F23: the wall-clock epoch clears PEER entries (a peer's pre-clear content) and this
      // device's OWN entries only when they predate an own clear line — so a slow local
      // clock can never wipe this device's post-clear writes (own & not vulnerable).
      const own = ownAddIds.has(e.id)
      if (!own || ownVulnerable.has(e.id)) { clearedByEpoch.push(e.id); continue }
    }
    if (e.hash && seenHashes.has(e.hash)) continue  // same content from another shard
    seenIds.add(e.id)
    if ((e.ts || 0) > skewCap) e.ts = skewCap // Wave2: a mis-clocked peer can't pin an entry to the top of list/rank (and immune to decay) forever
    entries.push(e)
    if (e.hash) seenHashes.add(e.hash)
  }
  while (entries.length > maxEntries) {
    const dropped = entries.shift()
    evictedAny = true // Tier-2: hot-window overflow — disk may hold entries outside RAM
    if (dropped?.hash) { seenHashes.delete(dropped.hash); rememberForgot(dropped.hash) } // Wave2: evicted content must not re-ingest
  }
  // F30: apply persisted project backfills so legacy conversation chunks (written before
  // `project` existed) stay current-directory-recallable across reloads/sync — the docstring
  // used to promise this "for free" but the tags were RAM-only and vanished on every reload.
  if (patches.length > 0) {
    const byHash = new Map<string, MemoryEntry>()
    for (const e of entries) if (e.hash) byHash.set(e.hash, e)
    for (const p of patches) {
      const e = byHash.get(p.hash)
      if (e) { if (!e.project) e.project = p.project; if (p.projectKey && !e.projectKey) e.projectKey = p.projectKey }
    }
  }
  // v1.23 C4: replay bridge backfills so weave-stamped code anchors survive reload/sync. Applied
  // last so a later backfill wins; a compaction bakes them into the add (the entry is mutated).
  if (codeRefsPatches.length > 0) {
    const byId = new Map<string, MemoryEntry>()
    for (const e of entries) byId.set(e.id, e)
    for (const p of codeRefsPatches) {
      const e = byId.get(p.id)
      if (e && (!e.codeRefs || e.codeRefs.length === 0)) e.codeRefs = p.codeRefs
    }
  }
  rebuildVectorIndex()
  // BB13: replay usage deltas now that the final entry/tombstone/clear state is known —
  // skip tombstoned ids, anything at/before the clear epoch, and ids not in the window.
  usageMap.clear()
  if (pendingReinforce.length > 0) {
    const liveIds = new Set(entries.map(e => e.id))
    for (const r of pendingReinforce) {
      if (tombstones.has(r.id) || r.ts <= clearEpoch || !liveIds.has(r.id)) continue
      usageMap.set(r.id, (usageMap.get(r.id) ?? 0) + r.used)
    }
  }
  pendingReinforce = []
  // F10: persist the observed delete state device-locally, and replicate into THIS device's
  // own shard any tombstone it knows but hasn't recorded there yet — so a deletion survives
  // losing the peer/originating shard that first carried it. Pin epoch-cleared ids by
  // identity too, so the clear holds even if its clearedBefore line is later lost.
  for (const id of clearedByEpoch) tombstones.add(id)
  persistDeletesFloor()
  if (syncDir && memPath) {
    const toEmit = [...tombstones].filter(id => !ownTombstoned.has(id))
    if (toEmit.length > 0) appendShardLine(JSON.stringify({ clearedIds: toEmit }), 'replicate-tombstones')
  }
  if (corruptLinesSkipped > 0) recordAnomaly('corrupt-lines', `${corruptLinesSkipped} unparseable shard line(s) skipped on reload`)
  bumpSearchGen() // Wave2: a reload can add/drop entries (peer sync) — don't serve stale cached results
}

export function initSwarmMemory(userDataPath: string, opts: { syncDir?: string | null } = {}): void {
  if (!userDataPath || typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new Error('initSwarmMemory: absolute userDataPath required')
  }
  const resolved = path.resolve(userDataPath)
  userDataDir = resolved
  legacyPath = path.join(resolved, 'swarm-memory.jsonl')
  initMemoryGraph(resolved)
  initMemoryAudit(resolved) // WP-E: local, on-by-default memory/learning audit rooted at the data dir
  deviceId = loadOrCreateDeviceId(resolved)
  // explicit opt wins; otherwise the persisted choice; otherwise local-only
  syncDir = opts.syncDir !== undefined ? (opts.syncDir || null) : readSyncConfig(resolved)

  entries.length = 0
  // reloadFrom() only runs when the shard file EXISTS, so a brand-new store would otherwise
  // inherit the previous store's counters and gate compaction on stale facts.
  ownShardLines = 0
  ownShardAddIds.clear()
  seenHashes.clear()
  tombstones.clear()
  clearEpoch = 0
  lockedShards = false
  initDegraded = false
  encKey = null
  seq = 0
  embeddingsAvailable = null
  // Tier-1: honor the quantization gate and (re)build the packed store in the chosen mode BEFORE any
  // vectors are loaded/added, so a fresh dir gets it too.
  //
  // Precedence: an EXPLICIT choice (the Settings toggle, via setVectorQuantization) beats everything.
  // It has to: the previous line was `quantizeVectors = quantizeVectors || env`, a one-way latch that
  // could turn the flag ON but never OFF — so a user un-ticking the box in the UI would have been
  // silently ignored. Absent an explicit choice we fall back to the env var (the dev/bench escape
  // hatch) or whatever was already set in-process.
  quantizeVectors =
    quantizeExplicit !== null
      ? quantizeExplicit
      : quantizeVectors || process.env.TERMPOLIS_MEM_QUANTIZE === '1'
  vectorStore = newVectorStore()
  rowToEntry.clear()

  try {
    if (syncDir) {
      fs.mkdirSync(syncDir, { recursive: true })
      memPath = path.join(syncDir, `${deviceId}.jsonl`)
      // One-time migration: seed this device's shard from the legacy local store
      // so existing memories join the synced set.
      if (!fs.existsSync(memPath)) {
        if (legacyPath && fs.existsSync(legacyPath)) {
          try { fs.copyFileSync(legacyPath, memPath) } catch { fs.writeFileSync(memPath, '') }
        } else {
          fs.writeFileSync(memPath, '')
        }
      }
      ensureTrailingNewline(memPath) // F27: heal a torn tail before any new append
      // Load this device's locally-cached encryption key (if the user enabled
      // encryption previously) so reloadFrom can decrypt — auto-unlocks on launch.
      encKey = loadCachedKey()
      reloadFrom(shardFiles())
    } else {
      memPath = legacyPath
      // WP-F: load a device key created on a prior launch BEFORE reading, so local ciphertext
      // decrypts (otherwise encrypted lines would be skipped and the store would look empty).
      encKey = loadCachedKey()
      if (fs.existsSync(memPath)) { ensureTrailingNewline(memPath); reloadFrom([memPath]) }
      else fs.writeFileSync(memPath, '')
    }
  } catch (err) {
    // Real failure — sync folder offline/not-yet-mounted, perms broken, disk full, etc.
    // F5: do NOT null memPath for the whole session (that silently discards every write
    // while the API keeps reporting success). Degrade to the local legacy store so writes
    // still persist, and flag it so the UI can warn; sync re-attaches on a later init.
    recordSwarmError('swarmMemory.init.failed', err, { memPath })
    initDegraded = true
    recordAnomaly('degraded-init', 'memory init failed — degraded to the local fallback store')
    try {
      memPath = legacyPath
      if (!encKey) encKey = loadCachedKey() // WP-F: decrypt local ciphertext on the fallback path too
      if (memPath) {
        if (fs.existsSync(memPath)) { ensureTrailingNewline(memPath); reloadFrom([memPath]) }
        else fs.writeFileSync(memPath, '')
      }
    } catch (err2) {
      recordSwarmError('swarmMemory.init.localFallback.failed', err2, {})
      memPath = null
    }
  }
  loadForgotSet() // BB15: device-local forgot-set (anti-thrash for the 30-min re-ingest)
  maybeAutoEncrypt() // WP-F: default-ON transparent at-rest encryption for a local store
}

export function _resetForTests(): void {
  memPath = null
  userDataDir = null
  legacyPath = null
  deviceId = ''
  syncDir = null
  entries.length = 0
  evictedAny = false
  seenHashes.clear()
  forgotSet.clear()
  usageMap.clear()
  pendingReinforce = []
  tombstones.clear()
  tombstonedHashes.clear()
  clearEpoch = 0
  encKey = null
  lockedShards = false
  ownShardLines = 0
  ownShardAddIds.clear()
  quantizeVectors = false
  quantizeExplicit = null // a reset must clear the explicit choice too, or it leaks across tests
  vectorStore = newVectorStore()
  rowToEntry.clear()
  hnsw = null
  hnswStale = false
  hnswDeletedSinceBuild = 0
  archiveCache = null
  archiveCacheKey = ''
  archiveReadCount = 0
  hnswThreshold = 50_000
  hnswBuilding = false
  buildGen = 0
  hnswBuildDone = Promise.resolve()
  hnswYieldMs = 8
  seq = 0
  maxEntries = DEFAULT_MAX_ENTRIES
  embeddingsAvailable = null
  embedOverride = null
  scrubFn = null
  scrubbedWrites = 0
  secretsRedacted = 0
  initDegraded = false
  corruptLinesSkipped = 0
  lockedLinesSkipped = 0
  fsyncCount = 0
  searchGen = 0
  searchCache.clear()
  lexicalIndex.clear()
  graphFusionEnabled = false
  prfEnabled = false
  _resetGraphForTests()
}

export function _setMaxEntriesForTests(n: number): void {
  maxEntries = n
}

export function _setHnswThresholdForTests(n: number): void {
  hnswThreshold = n
}

/** Override the build's frame-budget yield (ms). 0 ⇒ yield every insert, which
 *  forces the background (async) build path for deterministic tests. */
export function _setHnswYieldMsForTests(ms: number): void {
  hnswYieldMs = ms
}

/** Resolves when the in-flight background HNSW build (if any) has finished —
 *  lets tests assert on the built/persisted graph without racing the build. */
export function _whenHnswSettledForTests(): Promise<void> {
  return hnswBuildDone
}

/** True once a fresh HNSW graph is in place (searches use it; before this they
 *  fall back to brute-force). Lets tests prove the search didn't block on it. */
export function _isHnswReadyForTests(): boolean {
  return hnsw !== null && !hnswStale
}

// BB15: device-local forgot-set — hashes of cold message chunks we've forgotten from
// the hot window. Stored DEVICE-LOCAL (userData), NEVER in synced shards (a synced
// {forgot:hash} would silently delete data another device actively uses). Consulted by
// memoryHasHash so the 30-min idempotent re-ingest doesn't resurrect what we forgot.
const forgotSet = new Set<string>()
const FORGOT_CAP = 50_000

// BB13/BB14: in-memory usage counts (how often a memory was confirmed helpful), keyed
// by id. Persisted as additive CRDT-safe DELTA control lines `{reinforce:[{id,used,ts}]}`
// in the shard and replayed on reload (pendingReinforce holds the parsed deltas until
// the full entry/tombstone/clear state is known). Bounded by USAGE_MAP_CAP.
const usageMap = new Map<string, number>()
// WP-C: a memory whose NET feedback falls to this or below is filtered out of recall entirely
// (a strong "this was wrong, stop surfacing it" signal). Recoverable — positive feedback lifts it
// back above the threshold; the entry is NEVER deleted, only excluded from results while suppressed.
const SUPPRESS_THRESHOLD = -3
const USAGE_MAP_CAP = 50_000
let pendingReinforce: Array<{ id: string; used: number; ts: number }> = []
function forgotFile(): string | null { return userDataDir ? path.join(userDataDir, 'memory-forgot.json') : null }
function loadForgotSet(): void {
  forgotSet.clear()
  const f = forgotFile()
  if (!f) return
  try {
    if (fs.existsSync(f)) for (const h of JSON.parse(fs.readFileSync(f, 'utf8')) as string[]) forgotSet.add(h)
  } catch { /* missing/corrupt → empty set */ }
}
function persistForgotSet(): void {
  const f = forgotFile()
  if (!f) return
  try { fs.writeFileSync(f, JSON.stringify([...forgotSet])) } catch { /* best effort */ }
}

// Add a content hash to the device-local forgot-set (anti-re-ingest), bounded by FORGOT_CAP.
function rememberForgot(hash: string): void {
  if (!hash) return
  forgotSet.add(hash)
  while (forgotSet.size > FORGOT_CAP) {
    const oldest = forgotSet.values().next().value
    if (oldest === undefined) break
    forgotSet.delete(oldest)
  }
}

/** True if a chunk with this content hash is already stored OR was forgotten on this
 *  device (so re-ingest skips it — the anti-thrash prize of BB15). */
export function memoryHasHash(hash: string): boolean {
  // Wave2 (consolidation-forget-resurrected): a content-hash tombstone (from memoryDelete /
  // the "sleep" forget pass) must also count as "already accounted for", so the auto-indexer
  // doesn't re-ingest a memory the fleet just forgot (which would flap + thrash the shard).
  return typeof hash === 'string' && (seenHashes.has(hash) || forgotSet.has(hash) || tombstonedHashes.has(hash))
}

/**
 * BB15 cold-chunk predicate: a chunk is forgettable ONLY if it's a cold, untethered
 * transcript message — kind 'message', older than `minAgeMs`, with no tags and no
 * outgoing graph edges (never a note/decision/fact, never something linked). Pure.
 */
export function isForgettable(
  entry: { kind: string; ts: number; tags?: string[] },
  now: number,
  hasOutgoingEdges: boolean,
  minAgeMs = 14 * 86_400_000,
): boolean {
  return entry.kind === 'message'
    && now - entry.ts >= minAgeMs
    && (!entry.tags || entry.tags.length === 0)
    && !hasOutgoingEdges
}

/** Backfill project scope onto already-stored entries by content hash — used by re-ingest
 *  so legacy conversation chunks (written before `project` existed) become current-directory-
 *  recallable. F30: the backfill is now PERSISTED as an additive `{patch}` control line and
 *  re-applied on reload, so it survives relaunch/sync (it used to be RAM-only and vanish).
 *  Never overwrites an existing tag. Returns how many entries were patched. */
export function memoryPatchProjects(patches: Array<{ hash: string; project: string }>): number {
  if (!Array.isArray(patches) || patches.length === 0) return 0
  const byHash = new Map<string, MemoryEntry>()
  for (const e of entries) { if (e.hash && !e.project) byHash.set(e.hash, e) }
  let patched = 0
  for (const p of patches) {
    if (!p || typeof p.hash !== 'string') continue
    const slug = p.project ? normalizeProjectSlug(p.project) : ''
    if (!slug) continue
    const e = byHash.get(p.hash)
    if (e && !e.project) {
      e.project = slug
      const key = projectKeyOf(p.project)
      if (key && !e.projectKey) e.projectKey = key
      appendShardLine(JSON.stringify({ patch: { hash: p.hash, project: slug, ...(key && { projectKey: key }) } }), 'patch-project')
      patched++
    }
  }
  if (patched > 0) bumpSearchGen() // scope changed → invalidate cached searches
  return patched
}

/** Store stats for observability / UI: current count + the hot-window capacity, plus
 *  how many corrupt shard lines the last reload skipped (F28 — a shrinking store is no
 *  longer indistinguishable from "nothing was there"). */
export function memoryStats(): { count: number; capacity: number; corruptLinesSkipped: number } {
  return { count: entries.length, capacity: maxEntries, corruptLinesSkipped }
}

/** What the packed vector store is actually costing, and what the other mode would cost. */
export interface VectorRamStats {
  vectors: number
  dim: number
  quantized: boolean
  /** Vector RAM in the CURRENT mode. */
  ramBytes: number
  /** What the same vectors cost as exact float32 (4 B/component) … */
  ramBytesFloat: number
  /** … and as int8 (1 B/component). */
  ramBytesInt8: number
}

/**
 * Live vector-RAM figures for the Memory dashboard.
 *
 * This exists so the quantization toggle can be a DECISION AID rather than a mystery switch:
 * nobody can answer "should I enable int8 quantization?" in the abstract, but anyone can answer
 * "do I want to trade an approximation for 120 MB?" once they can see the 120 MB.
 *
 * These vectors live in the MAIN process — the same thread that pumps the PTY — so the number
 * that matters is not disk, it is resident heap on the thread whose stalls surface as typing lag.
 */
export function vectorRamStats(): VectorRamStats {
  const vectors = vectorStore.size
  const dim = vectorStore.dimension
  return {
    vectors,
    dim,
    quantized: vectorStore.quantized,
    ramBytes: vectors * dim * (vectorStore.quantized ? 1 : 4),
    ramBytesFloat: vectors * dim * 4,
    ramBytesInt8: vectors * dim * 1,
  }
}

/**
 * Turn int8 quantization on or off and REBUILD the packed store in the new mode.
 *
 * Safe and lossless in both directions, which is the whole reason this can be a runtime toggle
 * instead of a migration: the JSONL on disk always holds EXACT floats, so a rebuild simply re-packs
 * from the source of truth. Turning it off restores full precision; nothing was ever destroyed.
 *
 * The rebuild is just `initSwarmMemory` — the same path taken at every launch — so it is well
 * trodden rather than a bespoke mutation of live state.
 *
 * Note the persisted HNSW graph survives this untouched: it stores only ADJACENCY (row -> neighbour
 * rows) plus a vector accessor, and it is validated against an *entries* fingerprint that does not
 * change here. So the graph reloads and simply reads from the new store. A graph whose links were
 * chosen with exact float distances is, if anything, better than one built from int8 — which is why
 * enabling this LATER costs nothing and is mildly preferable to having shipped it on.
 */
export function setVectorQuantization(on: boolean): VectorRamStats {
  quantizeExplicit = on === true
  quantizeVectors = quantizeExplicit
  if (userDataDir) initSwarmMemory(userDataDir, { syncDir })
  return vectorRamStats()
}

export interface MemoryDashboardStats {
  total: number
  capacity: number
  byType: Record<string, number>   // episodic / semantic / procedural / entity / summary (inferred)
  bySource: Record<string, number> // claude / codex / gemini / qwen / code / mneme / …
  lessons: number                  // semantic + procedural (the distilled, reusable knowledge)
  timeline: TimeBucket[]           // cumulative store growth over the last 12 weeks
}

/** One row of the dashboard's live activity ticker. */
export interface ActivityRow { ts: number; op: string; type: string; detail: string }

/** Store composition for the Memory & Learning dashboard: counts over the hot
 *  window by cognitive type and by authoring source, plus the lesson total.
 *  Computed on demand from live state — no persistence, no side effects. */
export function memoryDashboardStats(): MemoryDashboardStats {
  const byType: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  let lessons = 0
  const items: Array<{ ts: number; lesson: boolean }> = []
  for (const e of entries) {
    // Read-time cognitive classification (mnemeTypeInfer): most legacy entries carry
    // no explicit memoryType, so we project their real kind/source onto a facet instead
    // of dumping everything into "untyped". An explicitly-typed entry keeps its type.
    const t = inferMemoryType(e)
    byType[t] = (byType[t] || 0) + 1
    const s = e.source || e.agentId || 'unknown'
    bySource[s] = (bySource[s] || 0) + 1
    const lesson = isLessonType(t)
    if (lesson) lessons++
    items.push({ ts: e.ts, lesson })
  }
  const timeline = weeklyGrowth(items, Date.now(), 12)
  return { total: entries.length, capacity: maxEntries, byType, bySource, lessons, timeline }
}

/** The most recent memory operations, newest first — the dashboard's live ticker. Reads
 *  the tail of the store (newest entries) and labels each with the op that created it
 *  (index / ingest / reflect / write). Cheap: only formats the last handful. */
export function memoryRecentActivity(limit = 14): ActivityRow[] {
  const tail = entries.slice(Math.max(0, entries.length - limit * 6))
  const rows: ActivityRow[] = tail.map((e) => {
    const isCode = e.source === 'code' || e.agentId === 'code-index'
    const type = inferMemoryType(e)
    const op = activityOp({ source: e.source, kind: e.kind, lesson: isLessonType(type) })
    return { ts: e.ts, op, type, detail: `${e.source || e.agentId} · ${graphNodeLabel(e.content, isCode, e.kind)}` }
  })
  return rows.sort((a, b) => b.ts - a.ts).slice(0, limit)
}

/** A legible sample of the live knowledge graph for the dashboard's connections view:
 *  the densest subgraph (see memoryGraphSample.ts), each node labeled from its content
 *  and colored by inferred cognitive type. Computed on demand from live state. */
export function memoryGraphSample(opts: { limit?: number } = {}): GraphSample {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const meta = (id: string): { label: string; type: ReturnType<typeof inferMemoryType> } | null => {
    const e = byId.get(id)
    if (!e) return null
    const isCode = e.source === 'code' || e.agentId === 'code-index'
    return { label: graphNodeLabel(e.content, isCode, e.kind), type: inferMemoryType(e) }
  }
  const raw = getAllEdges().map((e) => ({ from: e.from, to: e.to, relation: e.relation }))
  return sampleGraph(raw, meta, { limit: opts.limit ?? 160 })
}

/** The authoring source (agent) of a stored memory by id — for cross-agent
 *  attribution: who authored a memory that another agent later reused. Prefers
 *  the provenance `source` (claude/codex/gemini/qwen/mneme) over the writer id. */
export function memorySourceById(id: string): string | undefined {
  const e = entries.find((x) => x.id === id)
  return e ? (e.source || e.agentId) : undefined
}

// ---- Write ----

export interface WriteInput {
  agentId: string
  kind: MemoryEntry['kind']
  content: string
  tags?: string[]
  taskId?: string
  source?: string
  project?: string                // raw cwd/path or slug — normalized on write
  hash?: string
  memoryType?: MemoryEntry['memoryType'] // Mneme cognitive facet (episodic/semantic/procedural/entity/summary)
  importance?: number             // 0..1 base salience — clamped on write
  originEpisode?: string          // task/session id a distilled lesson was derived from
  ts?: number                     // optional backdate (ingestion / tests); defaults to Date.now()
  codeRefs?: CodeRef[]            // v1.23 C2 — structured code anchors (the memory<->code bridge)
}

// Auto-link only high-signal kinds so the knowledge graph stays meaningful (not
// flooded by transcript/code chunks); each links to its top-K nearest neighbours.
const AUTO_LINK_KINDS = new Set<MemoryEntry['kind']>(['decision', 'fact', 'result'])
const AUTO_LINK_K = 3
// v1.23 C7 — a minimum-cosine floor on the auto-link so curated writes stop accreting weak
// `relates-to` edges (the old `score > 0` gate minted an edge for ANY positive similarity, which
// inflated the graph with low-signal links redundant with the vector index). Below densify's 0.6
// but well above noise, so genuine relations still form.
const AUTO_LINK_MIN_COSINE = 0.35
// BB16: densify the bulk (message/note) too, but ONLY on a genuinely tight relation —
// a single best neighbour at high cosine — so the graph grows without flooding.
const DENSIFY_KINDS = new Set<MemoryEntry['kind']>(['message', 'note'])
const DENSIFY_MIN_COSINE = 0.6

/** Stable content-addressed hash for a memory's text — the key we use to skip
 *  storing the same information twice (in the vector store AND in the on-disk
 *  log). We normalize Unicode form and collapse/trim whitespace so trivially
 *  different copies (reflowed, padded) of the same text map to one entry. Case
 *  is preserved so we never merge genuinely distinct content. */
export function contentHash(content: string): string {
  // F25: normalize Unicode form and strip trailing whitespace per line + trailing blank
  // lines, but PRESERVE internal newlines/indentation — otherwise whitespace-significant
  // content (Python, YAML, diffs, Markdown fences, ASCII tables) false-dedups into a
  // different snippet and the second, genuinely-distinct write is silently dropped.
  const normalized = (content || '').normalize('NFC').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '')
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

/** WP-D: dedup key for an ENTITY node, SCOPED by projectKey so a same-named entity in two different
 *  repos (e.g. `parse` in repoA vs repoB) becomes a DISTINCT node instead of collapsing into one
 *  shared node — which used to manufacture false cross-repo connections. Only the dedup HASH is
 *  scoped; the entity's CONTENT stays the bare name (recall and `entities:[content]` must stay
 *  clean). With no projectKey this is exactly contentHash(name), so unscoped/global entities are
 *  byte-for-byte unchanged. The space + 16-hex projectKey suffix won't realistically collide. */
// Known code file extensions we canonicalize away so a file entity ("parser.ts") and its symbol
// entity ("parser") resolve to one node. Applied ONLY to a single token (no internal whitespace),
// so an extension is never stripped from the middle of a phrase.
const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|cpp|cc|cxx|hpp|cs|swift|kt|kts|php|scala|lua|dart|h|c|m|mm)$/

/** Tier-2 entity resolution: canonical form of an entity name for DEDUP only (the stored/displayed
 *  content keeps the original name). CONSERVATIVE by design — it merges high-confidence aliases:
 *    - Unicode/whitespace normalization + lowercasing ("Parser" == "parser")
 *    - a leading article the/a/an ("the parser" == "parser")
 *    - a trailing code file extension on a bare token ("parser.ts" == "parser", "src/x.py" == "src/x")
 *  It deliberately does NOT fold plurals ("parser" != "parsers") or separator/case styles
 *  ("parse_tree" != "parseTree"), which would risk collapsing genuinely distinct entities. */
export function canonicalEntityName(name: string): string {
  let n = (name || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
  n = n.replace(/^(the|a|an) /, '')
  if (n.length > 0 && !/\s/.test(n)) n = n.replace(CODE_EXT_RE, '')
  return n
}

export function entityDedupHash(name: string, projectKey?: string): string {
  const n = canonicalEntityName(name)
  return projectKey ? contentHash(`${n} ${projectKey}`) : contentHash(n)
}

/** v1.23 C2 — the reverse side of the memory<->code bridge: every memory anchored to a code
 *  symbol or file. Matches a symbol id, a symbol name, a full file path, or a bare filename
 *  against each entry's codeRefs. Optionally repo-scoped. Newest first. This is what lets
 *  "what do we know about this function?" and the issue->location predictor cross from code to
 *  memory without traversing the disjoint id spaces. */
/** v1.23 C7 — the knowledge graph's edge mix by relation (causal/supersedes/entity vs the damped
 *  relates-to/follows co-occurrence). Surfaced so the memory dashboard can show the high-signal
 *  ratio. Thin passthrough to the graph so callers don't import memoryGraph directly. */
export function memoryGraphRelationStats(): Record<string, number> {
  return graphRelationStats()
}

export function symbolHistory(query: string, projectKey?: string): MemoryEntry[] {
  const q = (query ?? '').trim()
  if (!q) return []
  const base = q.split(/[\\/]/).pop() || q
  const out: MemoryEntry[] = []
  for (const e of entries) {
    const refs = e.codeRefs
    if (!refs || refs.length === 0) continue
    const hit = refs.some(
      (r) =>
        (!projectKey || r.projectKey === projectKey) &&
        (r.symbolId === q || r.symbol === q || r.file === q || (!!r.file && (r.file.split(/[\\/]/).pop() || '') === base)),
    )
    if (hit) out.push(e)
  }
  return out.sort((a, b) => b.ts - a.ts)
}

// ---- v1.23 C4: the weave (background connection-miner) reads these three seams ----

/** Durably stamp resolved code anchors onto an existing memory that lacked them — the weave
 *  bridge miner backfilling older memories that predate the C2 write-time stamping. Mutates the
 *  hot-window entry AND appends a control line so it survives reload/sync; a later compaction
 *  bakes it into the add via the mutated entry. No-op if the entry is gone or already anchored. */
export function backfillCodeRefs(id: string, refs: CodeRef[]): void {
  if (!id || !Array.isArray(refs) || refs.length === 0) return
  const e = entries.find((x) => x.id === id)
  if (!e || (e.codeRefs && e.codeRefs.length > 0)) return
  e.codeRefs = refs
  try { appendShardLine(JSON.stringify({ codeRefsPatch: { id, codeRefs: refs } }), 'codeRefsPatch') } catch { /* best effort */ }
  bumpSearchGen()
}

/** A code chunk's content is `${filePath}:${start}-${end}\n${body}` (chunkCode) — the same
 *  convention memoryPruneCodePath keys off. Recover the file so the weave's `explains` miner
 *  has an anchor on the CODE side of the bridge. */
function codeChunkFile(e: MemoryEntry): string | undefined {
  if (e.source !== 'code' || typeof e.content !== 'string') return undefined
  const nl = e.content.indexOf('\n')
  const m = /^(.*):\d+-\d+$/.exec(nl === -1 ? e.content : e.content.slice(0, nl))
  return m ? m[1] : undefined
}

/** A bounded, newest-first sample of high-signal embedded memories for the weave miner (raw
 *  message chatter excluded). Entity nodes expose their name as `entities` so the bridge miner
 *  can resolve them to code. */
export function weaveCandidates(limit = 300): WeaveEntry[] {
  const out: WeaveEntry[] = []
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i]
    if (e.kind === 'message') continue
    out.push({
      id: e.id,
      kind: e.kind,
      memoryType: e.memoryType,
      source: e.source,
      projectKey: e.projectKey,
      entities: e.memoryType === 'entity' ? [e.content] : undefined,
      hasCodeRefs: !!(e.codeRefs && e.codeRefs.length),
      // v1.25 — anchors for the Weave's `explains` miner (the code<->purpose bridge). The
      // miner gates on BOTH cosine similarity and a shared file/symbol anchor, so without
      // these two fields projected it runs but can never anchor, and mints zero edges.
      codeRefs: e.codeRefs, // the SEMANTIC side's anchor (stamped at write time by mnemeGround)
      filePath: codeChunkFile(e), // the CODE side's anchor
    })
  }
  return out
}

/** Cross-store nearest neighbours of a memory (by its packed embedding), each tagged with its
 *  repo key so the miner can gate on CROSS-repo. Empty when the memory has no packed vector. */
export function weaveNeighbours(id: string, k = 6): WeaveNeighbour[] {
  const self = entries.find((e) => e.id === id)
  if (!self) return []
  const row = entryRow.get(self)
  const v = row !== undefined ? vectorStore.get(row) : null
  if (!v) return []
  const byId = new Map(entries.map((e) => [e.id, e]))
  return nearestNeighbours(Array.from(v), k, id).map((n) => ({ id: n.id, score: n.score, projectKey: byId.get(n.id)?.projectKey }))
}

export async function memoryWrite(input: WriteInput): Promise<MemoryEntry> {
  if (!input || typeof input.content !== 'string' || !input.content.trim()) {
    throw new Error('memoryWrite: content required')
  }
  const kind = input.kind || 'note'
  const projectSlug = input.project ? normalizeProjectSlug(input.project) : ''
  const projectKey = input.project ? projectKeyOf(input.project) : undefined // F19
  // WP-G: scrub secrets out FIRST — ahead of the hash, the embed and the persist — so the
  // JSONL, the content hash and the vector all carry the REDACTED text. A secret that reaches
  // the brain isn't merely at rest on disk: recall would later re-inject it into another
  // agent's context. With no scrubber installed (or the setting off) this is a byte-for-byte
  // no-op and the content is stored exactly as written.
  const scrub = scrubContent(input.content)
  const truncated = scrub.content.length > MAX_CONTENT
  const content = truncated ? scrub.content.slice(0, MAX_CONTENT) : scrub.content

  // De-duplicate by content so the same information never lands twice — not in
  // the packed vector store, not in the JSONL on disk. Ingestion supplies its
  // own source-scoped hash (idempotent re-ingest of a transcript/file); direct
  // writes get a content hash. A hit returns the already-stored entry and skips
  // the embed + persist + index work entirely (the Memex content-addressed win).
  // F14: hash over the ORIGINAL (untruncated) content so a corrected/identical long
  // note dedups to one entry instead of proliferating truncated fragments. WP-G: over the
  // SCRUBBED text, so re-pasting the same note with a rotated key dedups to one redacted entry.
  const effectiveHash = input.hash || contentHash(scrub.content)
  if (seenHashes.has(effectiveHash)) {
    const existing = entries.find(e => e.hash === effectiveHash)
    if (existing) {
      // F15: a dedup hit must not silently discard the new call's scoping metadata — the
      // agent believes it filed the note under THIS project/tags/task. Backfill what's missing.
      let changed = false
      if (!existing.project && projectSlug) { existing.project = projectSlug; changed = true }
      if (input.tags && input.tags.length > 0) {
        const merged = Array.from(new Set([...(existing.tags || []), ...input.tags])).slice(0, 20)
        if (merged.length !== (existing.tags?.length ?? 0)) { existing.tags = merged; changed = true }
      }
      if (!existing.taskId && input.taskId) { existing.taskId = input.taskId; changed = true }
      if (changed) bumpSearchGen() // scoping changed → invalidate cached searches
      await backfillVectorIfMissing(existing) // F18: upgrade a vector-less entry now that the embedder is back
      return existing
    }
  }

  const entry: MemoryEntry = {
    id: `mem-${Date.now()}-${++seq}-${crypto.randomBytes(3).toString('hex')}`,
    ts: Math.min(input.ts ?? Date.now(), Date.now() + MAX_CLOCK_SKEW_MS), // Wave2: clamp a future ts so it can't dominate ranking/list forever

    agentId: input.agentId || 'unknown',
    kind,
    content,
    ...(input.tags && input.tags.length > 0 && { tags: input.tags.slice(0, 20) }),
    ...(input.taskId && { taskId: input.taskId }),
    ...(input.source && { source: input.source }),
    ...(projectSlug && { project: projectSlug }),
    ...(projectKey && { projectKey }),
    ...(input.memoryType && { memoryType: input.memoryType }),
    ...(typeof input.importance === 'number' && { importance: Math.min(1, Math.max(0, input.importance)) }),
    ...(input.originEpisode && { originEpisode: input.originEpisode }),
    ...(input.codeRefs && input.codeRefs.length > 0 && { codeRefs: input.codeRefs }),
    hash: effectiveHash,
  }

  // Opportunistic embedding — swallow any failure silently
  try {
    const emb = await embed(content, false)
    if (emb) entry.embedding = emb
  } catch { /* ignore */ }

  // F17: the dedup check above ran BEFORE the embed await yielded the event loop, so a
  // concurrent write of identical content could have interleaved. Re-check now (no await
  // between here and the insert) so two racing writers can't both land the same content.
  if (seenHashes.has(effectiveHash)) {
    const existing = entries.find(e => e.hash === effectiveHash)
    if (existing) return existing
  }

  const durable = persist(entry) // disk gets the full entry incl. embedding, BEFORE we pack it

  // Keep a lean copy in the hot window: its EMBED_DIM vector moves to the packed
  // store and the number[] is freed (the memory win). Return the ORIGINAL (with
  // embedding) so the write contract still exposes it.
  const stored: MemoryEntry = { ...entry }
  indexEntryVector(stored)
  lexicalIndex.add(stored.id, stored.content) // BB1: keep the lexical index in sync
  entries.push(stored)
  // F6: only guard the dedup hash once the write actually reached disk — a swallowed
  // append failure can then be retried by an identical re-write instead of being masked.
  if (durable && stored.hash) seenHashes.add(stored.hash)
  if (entries.length > maxEntries) {
    const dropped = entries.shift()
    evictedAny = true // Tier-2: hot-window overflow — disk may hold entries outside RAM
    if (dropped) {
      if (dropped.hash) { seenHashes.delete(dropped.hash); rememberForgot(dropped.hash) } // Wave2: evicted content must not re-ingest
      lexicalIndex.remove(dropped.id)
      const r = entryRow.get(dropped)
      if (r !== undefined) rowToEntry.delete(r) // its packed row is now dead
    }
  }
  // BB10: trims leave orphaned vectors; compact them out IN MEMORY (no disk re-read)
  // once they exceed ~45% of the store, replacing the old full reloadFrom.
  const orphans = vectorStore.size - rowToEntry.size
  if (orphans > 0 && orphans / vectorStore.size > 0.45 && !hnswBuilding) compactVectorStore()

  bumpSearchGen() // a new entry invalidates cached searches
  // WP-E: audit what the brain stored (secret-redacted preview; full content stays only in the store).
  if (durable) auditMemory({ event: 'write', id: stored.id, kind: stored.kind, agentId: stored.agentId, preview: redactPreview(stored.content) })

  // Knowledge graph: auto-link a curated memory to its nearest neighbours so the
  // graph grows passively as you work. High-value kinds only (transcript/code
  // chunks would flood it; the agent can still link anything via memory_link).
  if (AUTO_LINK_KINDS.has(kind) && entry.embedding) {
    try {
      // Side-effect-free neighbour lookup: reuse the embedding we just computed and
      // scan the packed store directly, so growing the graph never kicks an HNSW
      // (re)build or a disk-persist — those stay owned by memorySearch alone.
      for (const n of nearestNeighbours(entry.embedding, AUTO_LINK_K, entry.id)) {
        if (n.score < AUTO_LINK_MIN_COSINE) continue // C7: floor out weak, low-signal auto-links
        addMemoryEdge({ from: entry.id, to: n.id, relation: 'relates-to', weight: n.score, createdBy: 'auto', ts: entry.ts })
      }
    } catch { /* best effort — linking never blocks a write */ }
  } else if (DENSIFY_KINDS.has(kind) && entry.embedding) {
    // BB16: link a message/note chunk to its single best neighbour, but only when
    // the relation is genuinely tight (cosine >= 0.6) — densifies the bulk without
    // flooding the graph. Idempotent via upsertEdge; never blocks a write.
    try {
      const [n] = nearestNeighbours(entry.embedding, 1, entry.id)
      if (n && n.score >= DENSIFY_MIN_COSINE) {
        addMemoryEdge({ from: entry.id, to: n.id, relation: 'relates-to', weight: n.score, createdBy: 'auto', ts: entry.ts })
      }
    } catch { /* best effort */ }
  }
  if (!durable) entry.durable = false // F6: surface a non-durable write so the API doesn't lie
  if (truncated) { entry.truncated = true; entry.originalChars = input.content.length } // F14
  // WP-G: report the scrub on the RETURNED entry only (set after `stored` was copied and after
  // persist(), so it never reaches the hot window or the disk) — the caller writes the audit.
  if (scrub.hits > 0) entry.scrubbed = scrub.hits
  return entry
}

// Append one raw JSON line to this device's shard, encrypting it at rest when a key
// is set. Returns whether the bytes reached disk so callers can stop pretending a
// failed write succeeded (F6). F26: `fsync` forces the OS to flush before returning,
// so a power loss right after can't roll back an acknowledged high-value write.
function appendShardLine(raw: string, ctx: string, opts: { fsync?: boolean } = {}): boolean {
  if (!memPath) return false
  const line = (encKey ? encryptLine(encKey, raw) : raw) + '\n'
  try {
    if (opts.fsync) {
      const fd = fs.openSync(memPath, 'a')
      try { fs.appendFileSync(fd, line); fs.fsyncSync(fd); fsyncCount++ } finally { fs.closeSync(fd) }
    } else {
      fs.appendFileSync(memPath, line)
    }
    ownShardLines++ // keep the compaction gate answerable without reading the file back
    return true
  } catch (err) {
    // Append failure means this swarm fact never reaches disk — agents would lose
    // context on next launch. Surface it AND report non-durability to the caller.
    recordSwarmError('swarmMemory.persist.failed', err, { entryId: ctx })
    return false
  }
}

// F26: curated knowledge (decision/fact/result) is fsync'd; bulk transcript/code
// chunks (message/note) trade durability for throughput on a big ingest pass.
const FSYNC_KINDS = new Set<MemoryEntry['kind']>(['decision', 'fact', 'result'])

function persist(entry: MemoryEntry): boolean {
  const ok = appendShardLine(JSON.stringify(entry), entry.id, { fsync: FSYNC_KINDS.has(entry.kind) })
  // Record that THIS device contributed this id. The compaction gate needs it to work out how
  // much of our own shard is still live -- without which it has to re-read and re-decrypt the
  // whole file just to find out, which is the 4.4-second freeze this all exists to kill.
  if (ok) ownShardAddIds.add(entry.id)
  return ok
}

// Atomic whole-file write: temp + fsync + rename, so a crash or a concurrent cloud-sync
// read during a full-file rewrite can never leave a truncated or half-written file. The
// original is untouched until the rename, so a failure loses nothing (F7/F33).
function atomicWriteFile(target: string, data: string): void {
  const tmp = target + '.tmp'
  const fd = fs.openSync(tmp, 'w')
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  try {
    fs.renameSync(tmp, target)
  } catch (err) {
    // Windows can reject a rename over an existing/locked target — unlink then rename
    // (the contextPinStore fallback). On any failure, drop the temp and surface.
    try { fs.rmSync(target, { force: true }); fs.renameSync(tmp, target) }
    catch (err2) { try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ } throw err2 }
  }
}

/**
 * Atomic whole-file write from LINES -- without ever building one giant string.
 *
 * compactSelfShard used to finish with `atomicWriteFile(memPath, out.join('\n') + '\n')`, which
 * materialises the ENTIRE shard as a single JS string. V8 caps a string at MAX_STRING_LENGTH --
 * 536,870,888 chars (512 MB) on 64-bit -- and a real store here is already 450 MB. That is 12%
 * of headroom.
 *
 * Cross it and `join()` throws RangeError. The 30-minute compaction timer catches and swallows
 * it, so compaction would SILENTLY never run again -- forever -- while the shard grew without
 * bound. A failure with no error message anywhere is the worst kind there is, and this one
 * strands the whole store.
 *
 * Writing incrementally has no cap and costs nothing. Same bytes, same atomicity (temp + fsync +
 * rename), same durability -- it simply never asks V8 for a half-gigabyte string.
 */
function atomicWriteLines(target: string, lines: string[]): void {
  const tmp = target + '.tmp'
  const fd = fs.openSync(tmp, 'w')
  try {
    // Batch so we are not doing a syscall per line, while never holding more than a few MB.
    const CHUNK = 4 * 1024 * 1024
    let buf = ''
    for (const line of lines) {
      buf += line + '\n'
      if (buf.length >= CHUNK) { fs.writeFileSync(fd, buf); buf = '' }
    }
    if (buf) fs.writeFileSync(fd, buf)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  try {
    fs.renameSync(tmp, target)
  } catch (err) {
    // Windows can reject a rename over an existing/locked target -- unlink then rename.
    try { fs.rmSync(target, { force: true }); fs.renameSync(tmp, target) }
    catch (err2) { try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ } throw err2 }
  }
}

// F27: guarantee JSONL frame integrity. A crash mid-append can leave the shard ending
// in a truncated, newline-less line; the NEXT append would then land on that same
// physical line and corrupt an otherwise-good record. If the file doesn't end in '\n',
// terminate the torn line so a torn tail costs at most the torn entry, never the next.
function ensureTrailingNewline(p: string): void {
  try {
    const size = fs.statSync(p).size
    if (size === 0) return
    const fd = fs.openSync(p, 'r')
    let last = 0x0a
    try { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); last = b[0] } finally { fs.closeSync(fd) }
    if (last !== 0x0a) fs.appendFileSync(p, '\n')
  } catch { /* best effort — a repair failure must never block init */ }
}

// ---- Packed vector index helpers ----

// Move a real (EMBED_DIM) embedding into the packed store and free the number[]
// from RAM. Non-EMBED_DIM vectors are left on the entry for the per-object path.
function indexEntryVector(entry: MemoryEntry): void {
  if (!entry.embedding || entry.embedding.length !== EMBED_DIM) return
  const row = vectorStore.add(entry.embedding)
  if (row < 0) return
  rowToEntry.set(row, entry)
  entryRow.set(entry, row)
  delete entry.embedding
  if (hnswBuilding) buildGen++ // Wave2 (hnsw-build-freshness-by-count): a live add during a build must abort it — the count check alone is fooled by a concurrent add+delete
  if (hnsw && !hnswStale) hnsw.add(row)                        // keep the graph fresh incrementally
  else if (vectorStore.size >= hnswThreshold) hnswStale = true // crossed the threshold → (re)build on next search
}

// F18: an entry stored while the embedder was down carries no packed vector, so it is
// reachable ONLY by lexical/BM25 overlap — never by semantic similarity — and dedup
// otherwise blocks it from ever being re-embedded. If the embedder is back and this entry
// lacks a vector, embed + index it so it becomes first-class semantically recallable.
async function backfillVectorIfMissing(entry: MemoryEntry): Promise<void> {
  if (entryRow.has(entry)) return                                                       // already packed
  if (entry.embedding && entry.embedding.length === EMBED_DIM) { indexEntryVector(entry); bumpSearchGen(); return }
  if (entry.embedding) return                                                           // non-EMBED_DIM legacy vector — leave it
  if (embeddingsAvailable === false) return
  try {
    const emb = await embed(entry.content, false)
    if (emb && emb.length === EMBED_DIM) { entry.embedding = emb; indexEntryVector(entry); bumpSearchGen() }
  } catch { /* best effort — a backfill failure never breaks the write */ }
}

/** F18: bounded background pass — embed hot-window entries that lack a packed vector once
 *  the embedder is available (e.g. captured during a model outage). Returns how many were
 *  backfilled. Safe to call on launch after the embedder is ready. */
export async function memoryBackfillVectors(max = 200): Promise<number> {
  if (embeddingsAvailable === false) return 0 // embed() self-skips per-entry if the model isn't ready
  let done = 0
  for (const e of entries) {
    if (done >= max) break
    if (entryRow.has(e) || e.embedding) continue
    try {
      const emb = await embed(e.content, false)
      if (emb && emb.length === EMBED_DIM) { e.embedding = emb; indexEntryVector(e); done++ }
    } catch { /* best effort */ }
  }
  if (done > 0) bumpSearchGen()
  return done
}

// Rebuild the packed store from the current hot window (after reload/trim/clear).
function rebuildVectorIndex(): void {
  buildGen++ // F34: invalidate any in-flight HNSW build — the store rows it indexes are about to change
  vectorStore = newVectorStore()
  rowToEntry.clear()
  hnsw = null
  lexicalIndex.clear() // BB1: rebuild the lexical index alongside the vector index
  for (const e of entries) { indexEntryVector(e); lexicalIndex.add(e.id, e.content) }
  hnswStale = vectorStore.size >= hnswThreshold
}

// BB10: compact orphaned vectors out of the packed store IN MEMORY, remapping the
// row↔entry maps. The HNSW graph indexes by row, so it must be discarded (file +
// memory): entriesFingerprint is unchanged by compaction, so leaving the file would
// make the next launch load the OLD-row graph against the remapped store (silent
// mis-scoring). The yielded ensureHnsw rebuilds it on the next large search.
function compactVectorStore(): void {
  if (hnswBuilding) return // never compact mid-build — rows would shift under it
  const live: number[] = []
  const liveEntries: MemoryEntry[] = []
  for (const e of entries) {
    const r = entryRow.get(e)
    if (r !== undefined && rowToEntry.get(r) === e) { live.push(r); liveEntries.push(e) }
  }
  const remap = vectorStore.compact(live)
  rowToEntry.clear()
  for (let i = 0; i < liveEntries.length; i++) {
    const nr = remap.get(live[i])
    if (nr === undefined) continue
    rowToEntry.set(nr, liveEntries[i])
    entryRow.set(liveEntries[i], nr) // overwrite the stale row
  }
  try { const hp = hnswFile(); if (hp) fs.rmSync(hp, { force: true }) } catch { /* best effort */ }
  hnsw = null
  hnswStale = vectorStore.size >= hnswThreshold
}

export function _vectorStoreSizeForTests(): number { return vectorStore.size }

// Ensure an HNSW graph exists for the current (large) store, WITHOUT blocking the
// caller. Below the threshold there's no graph (brute-force is fast). On disk a
// saved graph loads instantly. Otherwise a build is kicked off in the BACKGROUND
// and this returns immediately — the triggering search uses the exact brute-force
// fallback until `hnsw` is set. The build yields on a frame budget so it never
// freezes the UI, and only ONE build runs at a time. Small stores (tests) finish
// the build synchronously before the first yield, so callers see the graph at once.
async function ensureHnsw(): Promise<void> {
  if (vectorStore.size < hnswThreshold) { hnsw = null; hnswStale = false; return }
  if (hnsw && !hnswStale) return
  if (hnswBuilding) return // a build is already in flight → search uses brute-force meanwhile
  // Try the on-disk graph first — skips the O(n log n) rebuild when the store is
  // unchanged since it was saved (e.g. a fresh launch over a large store).
  const loaded = loadPersistedHnsw()
  if (loaded) { hnsw = loaded; hnswStale = false; hnswDeletedSinceBuild = 0; return }
  hnswBuilding = true
  const gen = buildGen // F34: capture the store generation; abort if a sync reload swaps the store under us
  hnswBuildDone = (async () => {
    try {
      const rows = [...rowToEntry.keys()] // snapshot: mid-build writes don't corrupt the walk
      const idx = new HnswIndex((r) => vectorStore.get(r))
      let last = Date.now()
      for (const row of rows) {
        // F34: a reload replaced the VectorStore (rows now point at DIFFERENT entries' vectors) —
        // abandon this build so it can't wire a mis-matched graph or mark itself fresh/persist.
        if (buildGen !== gen) return
        if (!rowToEntry.has(row)) continue // deleted mid-build → skip
        idx.add(row)
        if (Date.now() - last >= hnswYieldMs) { await new Promise<void>((r) => setImmediate(r)); last = Date.now() }
      }
      if (buildGen !== gen) return // final guard before publishing the graph
      hnsw = idx
      hnswDeletedSinceBuild = 0 // fresh graph — built from live rows only, no dead nodes yet
      // Only mark fresh + persist if the store didn't grow during the build; if it
      // did, the snapshot is incomplete → keep it usable but stale (a later search
      // rebuilds) and DON'T persist a graph whose fingerprint would over-claim.
      if (rowToEntry.size === rows.length) { hnswStale = false; savePersistedHnsw() }
      else hnswStale = true
    } finally {
      hnswBuilding = false
    }
  })()
}

// ---- HNSW on-disk persistence ----
// The graph is device-local (it indexes this device's packed rows), so it lives
// in userData, NOT the synced folder. It's keyed to the hot window by a content
// fingerprint: same entry set+order ⇒ same packed rows ⇒ the saved graph is
// valid; any change invalidates it (→ rebuild + re-save). A stale/corrupt file
// is simply ignored.
const HNSW_FILE = 'memory-hnsw.json'
function hnswFile(): string | null { return userDataDir ? path.join(userDataDir, HNSW_FILE) : null }

function entriesFingerprint(): string {
  const h = crypto.createHash('sha1')
  h.update(String(entries.length))
  for (const e of entries) { h.update(e.id); h.update('\n') }
  return h.digest('hex')
}

function loadPersistedHnsw(): HnswIndex | null {
  const p = hnswFile()
  if (!p) return null
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8')) as { fp?: string; graph?: SerializedHnsw }
    if (!obj || obj.fp !== entriesFingerprint() || obj.graph?.v !== 2) return null // stale / wrong format
    return HnswIndex.fromJSON(obj.graph, (r) => vectorStore.get(r))
  } catch { return null }
}

function savePersistedHnsw(): void {
  const p = hnswFile()
  if (!p || !hnsw) return
  try {
    fs.writeFileSync(p, JSON.stringify({ fp: entriesFingerprint(), graph: hnsw.toJSON() }))
  } catch { /* best effort */ }
}

// Persist the current graph if it's fresh — called from the background indexer so
// the on-disk graph tracks recent state. Safe no-op when there's no graph yet.
export function persistMemoryIndex(): void {
  if (hnsw && !hnswStale) savePersistedHnsw()
}

// Serialize an entry for disk, reconstructing its embedding from the packed store
// when it was moved there — so snapshots/exports never lose a vector.
function serializeEntry(e: MemoryEntry): string {
  const row = entryRow.get(e)
  if (row === undefined) return JSON.stringify(e)
  const v = vectorStore.get(row)
  return JSON.stringify(v ? { ...e, embedding: Array.from(v) } : e)
}

// F19: match a project scope by the precise full-path key when the search supplied one
// (so `.../acme/api` and `.../globex/api` never collide), falling back to the display slug
// for bare-name searches and legacy entries written before projectKey existed.
function matchesProject(e: MemoryEntry, opts: SearchOptions): boolean {
  if (!opts.project) return true
  if (opts.projectKey) {
    if (e.projectKey) return e.projectKey === opts.projectKey
    return e.project === opts.project // legacy entry (no key) — best-effort slug match
  }
  return e.project === opts.project
}

function passesFilter(e: MemoryEntry, opts: SearchOptions): boolean {
  if (opts.agentId && e.agentId !== opts.agentId) return false
  if (opts.kind && e.kind !== opts.kind) return false
  if (opts.taskId && e.taskId !== opts.taskId) return false
  if (!opts.crossProject && !matchesProject(e, opts)) return false // C6: crossProject keeps all repos
  return true
}

// ---- Search ----

export interface SearchOptions {
  query: string
  limit?: number
  agentId?: string
  kind?: MemoryEntry['kind']
  taskId?: string
  project?: string                // path or slug — normalized on entry
  projectKey?: string             // F19: internal — the full-path key, derived from `project` in memorySearch
  diversify?: boolean             // BB2: over-fetch + MMR re-rank so near-dups don't crowd the top
  rerank?: boolean                // Tier-1: opt-in cross-encoder relevance rerank of the candidate pool
  fuseGraph?: boolean             // BB7: expand top hits one hop along graph edges (agent-facing recall)
  crossProject?: boolean          // v1.23 C6: unified-brain recall — include OTHER repos' memories,
                                  // ranked BELOW same-project (relevance-scoped) instead of excluded
}

// v1.23 C6: how much to damp an out-of-project hit under crossProject recall, so same-project
// wins ties but a strong cross-repo lesson still surfaces (the "one unified brain, but scoped"
// choice). Multiplicative on the 0..1 score, so a penalized hit can fall under the gate.
const CROSS_PROJECT_PENALTY = 0.6

// Search-result cache — identical repeated searches return instantly. Any write
// (or a test embed-fn / availability swap) bumps `searchGen`, which is part of the
// cache key, so old-generation entries simply age out and results are never stale.
let searchGen = 0
const searchCache = new TtlLruCache<MemorySearchResult[]>(128, 5 * 60 * 1000)
function bumpSearchGen(): void { searchGen++ }

// BB7: GraphRAG one-hop fusion in the hot retrieval path. Default OFF — the
// mechanism is fully wired and tested, but the roadmap gates enabling it on a
// measured recall delta vs a plain vector-limit bump (much auto-edge gain is
// illusory). When off, memorySearch is byte-identical to the pre-BB7 behavior.
let graphFusionEnabled = false
export function _setGraphFusionForTests(v: boolean): void { graphFusionEnabled = v; bumpSearchGen() }

// Frontier: training-free taste-vector adaptation (mnemeAdapt). DEFAULT OFF — the
// review found full corpus-whitening's payoff uncertain for an already-tuned bge model,
// so this ships the endorsed positive-only interest-centroid boost, gated on a measured
// recall lift before enabling. When off, memorySearch ranking is byte-identical.
let adaptEnabled = false
export function _setAdaptForTests(v: boolean): void { adaptEnabled = v; bumpSearchGen() }

// BB1: BM25 lexical index maintained beside the vector store — the exact-token half
// of hybrid retrieval and the graceful-degrade signal when the embedder is down.
const lexicalIndex = new LexicalIndex()
// Saturate unbounded BM25 into 0..1 for the calibrated fusion: bm25 / (bm25 + K).
const LEX_SAT_K = 1

// BB3: pseudo-relevance feedback (Rocchio, dense-only). DEFAULT OFF — enabling is
// gated on a measured recall lift over a labeled set. When on, a moderately-relevant
// thin result expands the query toward the centroid of its top hits and unions a
// second pass by MAX cosine (never RRF — preserves the 0..1 score contract).
let prfEnabled = false
export function _setPrfForTests(v: boolean): void { prfEnabled = v; bumpSearchGen() }
const PRF_M = 3       // top hits whose centroid feeds the expansion
const PRF_MIN = 0.3   // below this top-1 cosine there's nothing worth expanding around
const PRF_MAX = 0.65  // above this the first pass is already strong
const PRF_BETA = 0.3  // expansion strength toward the centroid

/** Rocchio dense query expansion: normalize(q + beta * mean(topVecs)). Pure. */
export function rocchioExpand(q: number[], topVecs: number[][], beta = PRF_BETA): number[] {
  const dim = q.length
  const out = q.slice()
  if (topVecs.length > 0) {
    const mean = new Array(dim).fill(0)
    for (const v of topVecs) for (let i = 0; i < dim; i++) mean[i] += v[i] ?? 0
    for (let i = 0; i < dim; i++) out[i] += beta * (mean[i] / topVecs.length)
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += out[i] * out[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i++) out[i] /= norm
  return out
}
function searchCacheKey(o: SearchOptions, limit: number): string {
  return `${searchGen}|${o.query}|${limit}|${o.agentId ?? ''}|${o.kind ?? ''}|${o.taskId ?? ''}|${o.project ?? ''}|${o.projectKey ?? ''}|${o.diversify ? 'd' : ''}|${o.rerank ? 'r' : ''}|${o.fuseGraph ? 'g' : ''}|${o.crossProject ? 'x' : ''}`
}

export async function memorySearch(opts: SearchOptions): Promise<MemorySearchResult[]> {
  if (!opts || typeof opts.query !== 'string' || !opts.query.trim()) return []
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100)
  // BB2: when diversifying, over-fetch a wider candidate pool so MMR has room to swap
  // near-duplicates for distinct hits; otherwise fetch exactly the requested count.
  const fetchN = opts.diversify ? Math.min(Math.max(limit * 4, limit), 100) : limit
  // Accept either a raw cwd/path or an already-normalized slug for `project`.
  const projectSlug = opts.project ? normalizeProjectSlug(opts.project) : ''
  if (opts.project && !projectSlug) return []
  const projectKey = opts.project ? projectKeyOf(opts.project) : undefined // F19: precise full-path scope
  if (projectSlug) opts = { ...opts, project: projectSlug, projectKey }

  const cacheKey = searchCacheKey(opts, limit)
  const cached = searchCache.get(cacheKey)
  if (cached) return cached

  // Filter pool first — cheap wins
  let pool = entries
  if (opts.agentId) pool = pool.filter(e => e.agentId === opts.agentId)
  if (opts.kind) pool = pool.filter(e => e.kind === opts.kind)
  if (opts.taskId) pool = pool.filter(e => e.taskId === opts.taskId)
  // C6: a project scope normally hard-filters to that repo; crossProject keeps every repo in the
  // pool (they're damped below, not excluded) so a lesson learned elsewhere can still surface.
  if (opts.project && !opts.crossProject) pool = pool.filter(e => matchesProject(e, opts))
  if (pool.length === 0) return []

  // Try vector search first
  let queryEmb: number[] | null = null
  try { queryEmb = await embed(opts.query, true) } catch { /* fall back */ }

  const scored: MemorySearchResult[] = []
  if (queryEmb) {
    // Fast path: packed Float32 store for real EMBED_DIM vectors — a tight,
    // cache-friendly scan over half-the-memory storage (HNSW will make it
    // sub-linear). Exact cosine, since stored vectors are normalized.
    if (queryEmb.length === EMBED_DIM && vectorStore.size > 0) {
      void ensureHnsw() // kicks a background build when large; never blocks this search
      const allow = (row: number): boolean => {
        const e = rowToEntry.get(row)
        return e ? passesFilter(e, opts) : false
      }
      let hits: { row: number; score: number }[] = []
      // HNSW compares against the packed Float32 store, so match that precision
      // for the query too (cheap: one 384-float copy per search, ~µs).
      const queryF32 = Float32Array.from(queryEmb)
      // Use the graph only when it's fresh; while it's (re)building in the
      // background `hnsw` is null or stale, so we serve the exact brute-force scan.
      if (hnsw && !hnswStale) { try { hits = hnsw.search(queryF32, fetchN, allow) } catch { hits = [] } }
      // Wave2 (hnsw-filtered-underrecall): HNSW applies `allow` AFTER walking ~ef GLOBAL neighbours,
      // so a SELECTIVE filter (project/agent/kind/task) can leave most of them rejected and in-scope
      // hits unreturned. When a filter is active and the graph result is short, run the exact scan
      // (which is filter-exhaustive across the whole store) instead of only falling back on empty.
      const filtered = !!(opts.project || opts.agentId || opts.kind || opts.taskId)
      if (hits.length === 0 || (filtered && hits.length < fetchN)) hits = vectorStore.searchTopK(queryF32, fetchN, allow)
      // BB3: optional pseudo-relevance feedback (default OFF). When the top hit is only
      // MODERATELY relevant and the result is thin, expand the query toward the centroid
      // of the top-m hits and union a second pass by MAX cosine.
      if (prfEnabled && hits.length > 0 && hits.length < limit && hits[0].score >= PRF_MIN && hits[0].score <= PRF_MAX) {
        const topVecs: number[][] = []
        for (const h of hits.slice(0, PRF_M)) { const v = vectorStore.get(h.row); if (v) topVecs.push(Array.from(v)) }
        if (topVecs.length > 0) {
          const q2 = Float32Array.from(rocchioExpand(queryEmb, topVecs))
          const byRow = new Map<number, number>(hits.map(h => [h.row, h.score]))
          for (const h of vectorStore.searchTopK(q2, fetchN, allow)) {
            const prev = byRow.get(h.row)
            if (prev === undefined || h.score > prev) byRow.set(h.row, h.score) // union by MAX cosine
          }
          hits = [...byRow.entries()].map(([row, score]) => ({ row, score })).sort((a, b) => b.score - a.score)
        }
      }
      for (const h of hits) {
        const e = rowToEntry.get(h.row)
        if (e) scored.push({ ...e, score: h.score })
      }
    }
    // Legacy path: entries still holding a number[] embedding (non-EMBED_DIM,
    // e.g. tests). An entry is in exactly one of the two paths — never both.
    for (const entry of pool) {
      if (!entry.embedding || entry.embedding.length !== queryEmb.length) continue
      scored.push({ ...entry, score: cosineSimilarity(queryEmb, entry.embedding) })
    }
    // Nothing scored via vectors (entries written before the embedder was ready)
    // → keyword safety net.
    if (scored.length === 0) {
      for (const entry of pool) scored.push({ ...entry, score: keywordScore(opts.query, entry.content) })
    }
  } else {
    for (const entry of pool) scored.push({ ...entry, score: keywordScore(opts.query, entry.content) })
  }

  // BB1: fuse the dense ranking with a BM25 lexical signal so exact tokens (paths,
  // symbols, error codes, CLI flags) that bge blurs are recalled — and the lexical
  // index is the graceful-degrade path when the embedder is down. The score stays a
  // calibrated 0..1 (soft-OR of dense + saturated BM25), so the adaptiveGate /
  // gateByScore 0.25-floor contract still holds.
  if (lexicalIndex.size > 0) {
    const byId = new Map<string, MemorySearchResult>()
    for (const s of scored) byId.set(s.id, s)
    let entriesById: Map<string, MemoryEntry> | null = null
    const resolve = (id: string): MemoryEntry | undefined => {
      if (!entriesById) entriesById = new Map(entries.map(e => [e.id, e]))
      return entriesById.get(id)
    }
    const candidateN = Math.min(Math.max(limit * 4, limit), 100)
    const lexHits = lexicalIndex.search(opts.query, candidateN, (id) => {
      const e = resolve(id)
      return e ? passesFilter(e, opts) : false
    })
    for (const lh of lexHits) {
      const lexSat = lh.score / (lh.score + LEX_SAT_K)
      const existing = byId.get(lh.id)
      if (existing) {
        existing.score = 1 - (1 - existing.score) * (1 - lexSat) // soft-OR boost (in place)
      } else {
        const e = resolve(lh.id)
        if (e) { const hit: MemorySearchResult = { ...e, score: lexSat }; byId.set(lh.id, hit); scored.push(hit) }
      }
    }
  }

  // QW1: fuse relevance with recency + per-kind importance. Decorate ONCE per
  // candidate (never call rankScore inside the comparator over the keyword pool),
  // then sort by the stored rank, keeping the original recency tie-break. The
  // score>0 gate is preserved because rank>0 ⇔ relevance>0 (positive multipliers).
  const now = Date.now()
  // C6: relevance-scoped cross-repo — damp OTHER repos' hits so an equally-similar same-project
  // memory ranks above them, while a strong cross-repo lesson still clears the gate. Only when
  // crossProject recall is requested against a known target key; leaves same-project untouched.
  if (opts.crossProject && opts.projectKey) {
    for (const r of scored) {
      if (r.projectKey && r.projectKey !== opts.projectKey) r.score *= CROSS_PROJECT_PENALTY
    }
  }
  // P4: learned utility — the existing recency+kind rank and capped usage nudge,
  // PLUS a capped boost from a typed memory's `importance` (reflection sets lessons
  // high). Byte-identical for memories with no importance field; the score>0 gate is
  // preserved (all factors positive, relevance 0 → 0).
  const ranked = scored.map(r => ({ r, k: learnedUtility({ id: r.id, relevance: rankScore({ relevance: r.score, ts: r.ts, kind: r.kind, now }), importance: r.importance, useCount: usageMap.get(r.id) ?? 0 }, now) }))
  if (adaptEnabled) applyTasteBoost(ranked) // frontier: default-off interest-centroid nudge
  ranked.sort((a, b) => b.k - a.k || b.r.ts - a.r.ts)
  const survivors = ranked.map(x => x.r).filter(r => r.score > 0 && (usageMap.get(r.id) ?? 0) > SUPPRESS_THRESHOLD) // WP-C: drop strongly-downvoted memories
  let result: MemorySearchResult[]
  // Tier-1: opt-in cross-encoder rerank. Best-effort — only engages when a relevance scorer is
  // actually available (a local model or an injected one); otherwise falls through to MMR/gate
  // BYTE-IDENTICALLY, so the default (no bundled reranker) path is unchanged.
  const rerankScorer = (opts.rerank || rerankEnabled()) ? await getRerankScorer() : null
  if (rerankScorer) {
    // Widen the candidate pool past `limit` (the whole point of reranking is to reconsider more than
    // the top-`limit` first-stage hits), rescore each (query, doc) jointly, then take the top-`limit`.
    const poolCap = Math.max(limit * 5, 20)
    const pool = gateByScore(survivors, { minScore: 0, floor: Math.min(poolCap, survivors.length), cap: poolCap })
    result = (await rerankByScorer(opts.query, pool, rerankScorer)).slice(0, limit)
  } else if (opts.diversify) {
    // BB2: gate to the relevant pool (with a floor), then MMR-rerank to `limit` using
    // cosine over the packed vectors (token-Jaccard fallback when vectors are absent),
    // so a cluster of near-identical hits doesn't crowd out diverse context.
    let rowById: Map<string, number> | null = null
    const simFn = (a: MemorySearchResult, b: MemorySearchResult): number => {
      if (!rowById) rowById = new Map<string, number>([...rowToEntry].map(([row, e]) => [e.id, row]))
      const ra = rowById.get(a.id), rb = rowById.get(b.id)
      if (ra !== undefined && rb !== undefined) {
        const va = vectorStore.get(ra), vb = vectorStore.get(rb)
        if (va && vb) { let s = 0; for (let i = 0; i < va.length; i++) s += va[i] * vb[i]; return Math.max(0, s) }
      }
      return jaccardContentSim(a.content, b.content)
    }
    const gated = gateByScore(survivors, { minScore: 0.25, floor: Math.min(3, limit), cap: survivors.length })
    result = mmrRerank(gated, simFn, { lambda: 0.7, k: limit })
  } else {
    // Wave2 (diversify-false-no-relevance-floor): apply the same 0.25 relevance floor (with a
    // floor-count so a thin result never starves) on the non-diversify path too, so internal
    // callers (memory_related, the graph-seed search) don't treat sub-0.25 dense noise as a hit.
    result = gateByScore(survivors, { minScore: 0.25, floor: Math.min(3, limit), cap: limit })
  }

  // BB7: fold in graph-connected neighbours of the top results (off by default, and
  // skipped when the graph is empty — byte-identical to the non-fused path then).
  if ((graphFusionEnabled || opts.fuseGraph) && graphStats().edges > 0) {
    const entriesById = new Map<string, MemoryEntry>(entries.map(e => [e.id, e]))
    result = expandWithGraph(
      result,
      (id) => neighboursOf(id),
      (id, score) => {
        const e = entriesById.get(id)
        // WP-C: never let a suppressed (strongly-downvoted) memory re-enter via graph fusion.
        return e && passesFilter(e, opts) && (usageMap.get(id) ?? 0) > SUPPRESS_THRESHOLD ? { ...e, score } : null
      },
      { seeds: 5, tau: 0.1, lambda: 0.5, cap: limit },
    ).slice(0, limit)
  }

  // F2: never hand back a memory that a later one supersedes. The memory_link tool
  // actively solicits supersedes/superseded-by edges to keep replaced decisions from
  // resurfacing, but only the graph-query path honored them — search (and the primer that
  // rides on it) returned the deprecated answer as top recall. Filter it here too.
  const active = filterSuperseded(result, getAllEdges())
  searchCache.set(cacheKey, active)
  return active
}

// Nudge the ranking toward the centroid of the memories the fleet has reinforced
// (positive-only, capped — a zero-relevance hit stays zero). Only invoked when
// adaptEnabled (default off); best-effort, skips any candidate without a packed vector.
function applyTasteBoost(ranked: Array<{ r: MemorySearchResult; k: number }>): void {
  const byId = new Map(entries.map(e => [e.id, e]))
  const vecOf = (id: string): number[] | null => {
    const e = byId.get(id); if (!e) return null
    const row = entryRow.get(e); if (row === undefined) return null
    const v = vectorStore.get(row); return v ? Array.from(v) : null
  }
  const reinforcedIds = [...usageMap.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
    .map(([id]) => id)
  const reinforced: number[][] = []
  for (const id of reinforcedIds) { const v = vecOf(id); if (v) reinforced.push(v) }
  const centroid = interestCentroid(reinforced)
  if (!centroid) return
  for (const x of ranked) { const v = vecOf(x.r.id); if (v) x.k = tasteBoost(x.k, cosineSim(v, centroid)) }
}

export interface RelatedOptions {
  id?: string
  query?: string
  limit?: number
  project?: string
}

// One-hop "what connects to this?" traversal over the memory graph (the HNSW
// nearest-neighbour links). By id: use that entry's content as the query and drop
// the entry itself; by query: a plain semantic search. Cheap — reuses memorySearch
// (and its cache). The first concrete step toward an explicit knowledge graph.
export async function memoryRelated(opts: RelatedOptions): Promise<Array<MemorySearchResult & { relation?: string }>> {
  if (!opts || (!opts.id && !opts.query)) return []
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 100)

  // Query mode is unchanged — a plain semantic search.
  if (!opts.id) {
    const query = opts.query
    if (!query || !query.trim()) return []
    return memorySearch({ query, limit, project: opts.project })
  }

  // Id mode (QW6): hybrid of typed-edge neighbours + vector neighbours, so
  // memory_related actually "follows the thread" (its documented contract) instead
  // of being a relabeled vector search — and degrades to edges when embeddings are
  // off (an explicit link surfaces even with zero content overlap).
  const src = entries.find(e => e.id === opts.id)
  if (!src) return []
  const vectorHits = (await memorySearch({ query: src.content, limit: limit + 1, project: opts.project }))
    .filter(r => r.id !== opts.id)
  // C7: UNDIRECTED — a node reachable only by an INCOMING edge (e.g. a fix reachable via
  // bug --solved-by--> fix) now surfaces, consistent with memory_graph's traversal. edgesFrom
  // (forward-only) silently dropped those, so "follow the thread" from a fix to its bug failed.
  const edges = neighboursOf(opts.id)
    .filter(e => e.id !== opts.id)
    .map(e => ({ id: e.id, relation: e.relation, weight: e.weight }))
  const merged = mergeRelated({ vectorHits: vectorHits.map(r => ({ id: r.id, score: r.score })), edges })

  // Resolve ids back to entries. An edge can point to an entry outside the vector
  // hits (or trimmed from the hot window) — skip ids we can't resolve.
  const vById = new Map(vectorHits.map(r => [r.id, r]))
  const byId = new Map(entries.map(e => [e.id, e]))
  const out: Array<MemorySearchResult & { relation?: string }> = []
  for (const m of merged) {
    const e = vById.get(m.id) || byId.get(m.id)
    if (!e) continue
    out.push(m.relation ? { ...e, score: m.score, relation: m.relation } : { ...e, score: m.score })
    if (out.length >= limit) break
  }
  return out
}

export interface GraphQueryOptions { id?: string; query?: string; relation?: string; depth?: number; limit?: number }

// BB5: per-hop discount for graph-proximity path scoring (score ~ pathWeight * gamma^(hops-1)).
const GRAPH_GAMMA = 0.8

// Walk the knowledge graph from a seed memory (by id, or by a query that finds the
// seed) and resolve the connected entries — the agent-facing "follow the chain".
export async function memoryGraphQuery(opts: GraphQueryOptions): Promise<Array<MemorySearchResult & { relation: string; distance: number }>> {
  if (!opts || (!opts.id && !opts.query)) return []
  let startId = opts.id
  if (!startId && opts.query) {
    const seed = await memorySearch({ query: opts.query, limit: 1 })
    startId = seed[0]?.id
  }
  if (!startId) return []
  const hits = traverseGraph(startId, { relation: opts.relation, depth: opts.depth ?? 2, limit: opts.limit ?? 20 })
  if (hits.length === 0) return []
  const byId = new Map<string, MemoryEntry>(entries.map(e => [e.id, e]))
  const out: Array<MemorySearchResult & { relation: string; distance: number }> = []
  const now = Date.now()
  for (const h of hits) {
    const e = byId.get(h.id)
    if (!e) continue
    // BB5: graph-proximity weighted-path score — the product of clamped edge weights
    // along the path (h.pathWeight) discounted by gamma^(hops-1), then time-decayed by
    // the freshest edge's recency (QW5). So a strong, short, recent connection scores
    // highest; stale or weak paths fall below EDGE_EPSILON and drop out.
    // P3: causal/solution edges (solves/causes/...) outrank generic 'relates-to'
    // links via a per-relation prior — the graph now knows a fix matters more than
    // a mere association.
    const score = h.pathWeight * Math.pow(GRAPH_GAMMA, h.distance - 1) * effectiveWeight(1, h.ts, now) * relationPrior(h.relation)
    if (score < EDGE_EPSILON) continue
    out.push({ ...e, score, relation: h.relation, distance: h.distance })
  }
  // P3: never hand back a memory that a later one supersedes — the "no confusion as
  // the store grows" guarantee (superseded ids derive from supersedes/superseded-by edges).
  const active = filterSuperseded(out, getAllEdges())
  active.sort((a, b) => b.score - a.score)
  return active
}

// Record a typed connection between two memories (agent-facing memory_link).
export function memoryLink(input: { from: string; to: string; relation?: string; weight?: number; createdBy?: string; ts?: number; validFrom?: number; validTo?: number }): MemoryEdge | null {
  const edge = addMemoryEdge(input)
  // BB7: an explicit edge changes graph-fused results — invalidate the search cache
  // so the new connection is reflected (auto-link writes already bump via memoryWrite).
  if (edge) bumpSearchGen()
  return edge
}

// BB2: token-Jaccard similarity between two snippets — the MMR diversity fallback
// when packed vectors aren't available (embedder down / legacy entries).
function jaccardContentSim(a: string, b: string): number {
  const ta = new Set((a || '').toLowerCase().split(/\W+/).filter(t => t.length > 2))
  const tb = new Set((b || '').toLowerCase().split(/\W+/).filter(t => t.length > 2))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / (ta.size + tb.size - inter)
}

function keywordScore(query: string, content: string): number {
  const q = query.toLowerCase()
  const c = content.toLowerCase()
  if (c.includes(q)) return 1                              // direct substring
  const qTokens = new Set(q.split(/\W+/).filter(t => t.length > 2))
  const cTokens = new Set(c.split(/\W+/).filter(t => t.length > 2))
  if (qTokens.size === 0 || cTokens.size === 0) return 0
  let hits = 0
  for (const t of qTokens) if (cTokens.has(t)) hits++
  return hits / qTokens.size
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}

// Top-k nearest neighbours of an embedding with NO side effects — pure reads over
// the in-memory store. Unlike memorySearch it never calls ensureHnsw() (so no
// background graph build) and never persists, so auto-linking can grow the
// knowledge graph on every curated write without disturbing the search index's
// build/persist lifecycle. Exact brute-force, which is what such writes want.
function nearestNeighbours(queryEmb: number[], k: number, excludeId: string): Array<{ id: string; score: number }> {
  // Packed path: real EMBED_DIM vectors live in the Float32 store. Exact
  // brute-force top-k (the same fallback memorySearch uses) — no graph build.
  if (queryEmb.length === EMBED_DIM && vectorStore.size > 0) {
    const queryF32 = Float32Array.from(queryEmb)
    const allow = (row: number): boolean => {
      const e = rowToEntry.get(row)
      return !!e && e.id !== excludeId
    }
    const out: Array<{ id: string; score: number }> = []
    for (const h of vectorStore.searchTopK(queryF32, k, allow)) {
      const e = rowToEntry.get(h.row)
      if (e) out.push({ id: e.id, score: h.score })
    }
    return out
  }
  // Legacy path: entries still carrying a number[] embedding (e.g. tests with
  // injected non-EMBED_DIM vectors). One-pass cosine, top-k.
  const out: Array<{ id: string; score: number }> = []
  for (const e of entries) {
    if (e.id === excludeId || !e.embedding || e.embedding.length !== queryEmb.length) continue
    out.push({ id: e.id, score: cosineSimilarity(queryEmb, e.embedding) })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, k)
}

// ---- List ----

export interface ListOptions {
  limit?: number
  agentId?: string
  kind?: MemoryEntry['kind']
  since?: number
}

export function memoryList(opts: ListOptions = {}): MemoryEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  // P0: order by real conversation ts (desc), not insertion order — a backdated
  // re-ingest is appended LAST but must not masquerade as newest. Reverse first so
  // the stable sort keeps newest-inserted first among equal-ts entries.
  let pool = entries.slice().reverse().sort((a, b) => (b.ts || 0) - (a.ts || 0))
  if (opts.agentId) pool = pool.filter(e => e.agentId === opts.agentId)
  if (opts.kind) pool = pool.filter(e => e.kind === opts.kind)
  if (opts.since) pool = pool.filter(e => e.ts >= opts.since!)
  return pool.slice(0, limit)
}

export function memoryCount(): number {
  return entries.length
}

/** F13: the lessons (semantic/procedural) in the hot window, newest-first, up to `limit` —
 *  scanning the FULL window so distilled, cross-validated knowledge isn't missed just because
 *  newer bulk transcript chunks fill the most-recent rows. Powers memory_pool. */
export function memoryLessons(limit = 200): MemoryEntry[] {
  const cap = Math.min(Math.max(limit, 1), 5000)
  const out: MemoryEntry[] = []
  for (let i = entries.length - 1; i >= 0 && out.length < cap; i--) {
    const e = entries[i]
    if (e.memoryType === 'semantic' || e.memoryType === 'procedural') out.push(e)
  }
  return out
}

export function memoryClear(): void {
  const liveIds = entries.map(e => e.id) // F23: capture the concrete live set BEFORE wiping
  const liveHashes = entries.map(e => e.hash).filter((h): h is string => typeof h === 'string')
  entries.length = 0
  evictedAny = false // a cleared store has no on-disk overflow
  seenHashes.clear()
  forgotSet.clear()
  // Wave2 (memory-clear-undone-by-reingest): remember the cleared content hashes so the
  // auto-indexer doesn't silently re-ingest the same on-disk transcripts minutes later and
  // undo the clear (clear doesn't touch ~/.claude etc; forgotSet is the anti-re-ingest guard).
  for (const h of liveHashes) rememberForgot(h)
  persistForgotSet()
  usageMap.clear()
  vectorStore = newVectorStore()
  rowToEntry.clear()
  lexicalIndex.clear()
  hnsw = null
  hnswStale = false
  try { const hp = hnswFile(); if (hp) fs.rmSync(hp, { force: true }) } catch { /* best effort */ }
  clearMemoryGraph() // Wave2 (clear-doesnt-reset-graph): don't leave dangling edges / a growing graph file
  bumpSearchGen() // Wave2: a cleared store must not serve pre-clear results from the search cache
  if (!memPath) return
  if (syncDir) {
    // Propagating clear: the (clamped) epoch sweeps not-yet-synced OLDER peer content by
    // time, while an IDENTITY clear (F23) tombstones the concrete set we currently know —
    // so a fast-clock peer's future-ts entry can't survive, and a slow local clock can't
    // over-delete future writes (they get fresh, un-tombstoned ids). Both persist in the
    // device-local floor (F10) so the clear holds even if this shard is later lost.
    clearEpoch = Date.now()
    for (const id of liveIds) tombstones.add(id)
    appendShardLine(JSON.stringify({ clearedBefore: clearEpoch }), 'clear', { fsync: true })
    if (liveIds.length > 0) appendShardLine(JSON.stringify({ clearedIds: liveIds }), 'clear-ids', { fsync: true })
    persistDeletesFloor()
  } else {
    // Local-only: truncating the single file is a real, durable clear (no peers to merge).
    try { atomicWriteFile(memPath, '') } catch { /* best effort */ } // F33: atomic truncate
    clearEpoch = 0
    tombstones.clear()
    persistDeletesFloor()
  }
}

/** Delete a single entry everywhere — writes a tombstone that propagates via shards. */
/** A bounded snapshot of the oldest hot-window entries as P2 consolidation
 *  candidates — with edge presence and usage attached so that curated, connected,
 *  or frequently-recalled memories are protected from the "sleep" pass. */
export function consolidationCandidates(limit = 500): ConsolEntry[] {
  const edgeIds = new Set<string>()
  for (const e of getAllEdges()) {
    // Wave2 (consolidation-decay-inert): the BB6 'follows' temporal backbone + auto 'relates-to'
    // links give nearly EVERY message chunk an edge, so the isForgettable !hasEdges guard
    // protected almost everything and the sleep pass forgot nothing. Only MEANINGFUL links
    // (explicit memory_link, causal solves/causes/part-of/supersedes) should protect a memory.
    if (e.relation === 'follows' || e.createdBy === 'auto') continue
    edgeIds.add(e.from); edgeIds.add(e.to)
  }
  return entries.slice(0, Math.max(0, limit)).map((e) => ({
    id: e.id,
    content: e.content,
    ts: e.ts,
    kind: e.kind,
    memoryType: e.memoryType,
    importance: e.importance ?? 0.2, // un-scored raw chunks decay as low-value noise (consolidation-only default)
    useCount: usageMap.get(e.id) ?? 0,
    tags: e.tags,
    hasEdges: edgeIds.has(e.id),
  }))
}

/** A fast id→vector cosine similarity over the current hot window, for P2 near-
 *  duplicate clustering (summaries). Returns 0 when vectors are unavailable (embedder
 *  off / model absent), so summarization cleanly no-ops without the model. */
export function consolidationSimOf(): (a: ConsolEntry, b: ConsolEntry) => number {
  const vecById = new Map<string, Float32Array>()
  for (const e of entries) {
    const row = entryRow.get(e)
    if (row === undefined) continue
    const v = vectorStore.get(row)
    if (v) vecById.set(e.id, v)
  }
  return (a, b) => {
    const va = vecById.get(a.id)
    const vb = vecById.get(b.id)
    if (!va || !vb) return 0
    let s = 0
    for (let i = 0; i < va.length; i++) s += va[i] * vb[i]
    return Math.max(0, s)
  }
}

export function memoryDelete(id: string): void {
  if (!id) return
  let removedHash: string | undefined
  const idx = entries.findIndex((e) => e.id === id)
  if (idx !== -1) {
    const [removed] = entries.splice(idx, 1)
    if (removed) {
      removedHash = removed.hash
      if (removed.hash) seenHashes.delete(removed.hash)
      const r = entryRow.get(removed)
      if (r !== undefined) rowToEntry.delete(r)
    }
  }
  lexicalIndex.remove(id)
  removeNodeEdges(id) // Wave2 (graph-edges-dangle-after-delete): prune incident edges so traversals don't hit a dangling link
  tombstones.add(id)
  appendShardLine(JSON.stringify({ deleted: id }), 'delete', { fsync: true })
  // F22: dedup is content-addressed but deletion was id-addressed, so deleting one copy of
  // de-duplicated content left the twin (same hash, different id) alive to resurface on the
  // next reload. Tombstone the CONTENT hash too, and drop any in-window twins right now.
  if (removedHash) {
    tombstonedHashes.add(removedHash)
    appendShardLine(JSON.stringify({ deletedHash: removedHash }), 'deleteHash', { fsync: true })
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].hash === removedHash) {
        const [twin] = entries.splice(i, 1)
        if (twin) {
          tombstones.add(twin.id)
          lexicalIndex.remove(twin.id)
          const r = entryRow.get(twin)
          if (r !== undefined) rowToEntry.delete(r)
        }
      }
    }
    seenHashes.delete(removedHash)
  }
  bumpSearchGen() // deleted entries must not linger in cached search results
  hnswStaleAfterDelete()
  persistDeletesFloor() // F10: durable device-local floor so the delete survives shard loss
}

const ARCHIVE_FILE = 'swarm-memory.archive.jsonl'
function archivePath(): string | null {
  return userDataDir ? path.join(userDataDir, ARCHIVE_FILE) : null
}
// Tier-2: parsed-archive cache, keyed by the file's size+mtime, so repeated deep-recall queries
// don't re-read + re-parse the whole archive JSONL each time. Self-invalidates when the file changes
// (a new archive append, a different data dir), so it can never serve stale results.
let archiveCache: MemoryEntry[] | null = null
let archiveCacheKey = ''
let archiveReadCount = 0 // test-only: counts actual archive file reads (cache misses)
/** @internal test-only — how many times searchArchive re-read+parsed the archive from disk. */
export function _archiveReadCountForTests(): number { return archiveReadCount }

/** v1.23 C6 — RECOVERABLE cold storage, the "rock solid: never silently lose memory" guarantee.
 *  Unlike memoryDelete (which permanently tombstones the id AND the content hash), archive moves a
 *  cold, low-value entry OUT of the searchable hot window but PRESERVES its full content in a
 *  device-local archive so it stays recoverable + reachable via searchArchive. The ID is
 *  tombstoned so the hot window skips it on reload; the CONTENT hash is deliberately NOT
 *  tombstoned, so the same information may legitimately return later. */
export function memoryArchive(id: string): void {
  if (!id) return
  const idx = entries.findIndex((e) => e.id === id)
  if (idx === -1) return
  const [removed] = entries.splice(idx, 1)
  if (!removed) return
  const ap = archivePath()
  if (ap) { try { fs.appendFileSync(ap, JSON.stringify(removed) + '\n') } catch { /* best effort — worst case it stays in the shard */ } }
  if (removed.hash) seenHashes.delete(removed.hash)
  const r = entryRow.get(removed)
  if (r !== undefined) rowToEntry.delete(r)
  lexicalIndex.remove(id)
  tombstones.add(id) // hot-window skip on reload (NOT a content-hash tombstone)
  appendShardLine(JSON.stringify({ deleted: id }), 'archive', { fsync: true })
  bumpSearchGen()
  persistDeletesFloor()
}

/** v1.23 C6 — DEEP recall over the archive: keyword-scan cold/archived memories that have left the
 *  hot window, so nothing is permanently unrecallable. A recovery tier, not the hot search path. */
export function searchArchive(query: string, limit = 20): MemoryEntry[] {
  const ap = archivePath()
  if (!ap) return []
  const terms = (query || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2)
  if (terms.length === 0) return []
  // Tier-2: parse the archive ONCE and reuse it across queries, re-reading only when the file
  // actually changed (size+mtime key) — instead of re-reading+re-parsing the whole JSONL per query.
  let stat: import('fs').Stats
  try { stat = fs.statSync(ap) } catch { archiveCache = null; archiveCacheKey = ''; return [] }
  const key = `${stat.size}:${stat.mtimeMs}`
  if (!archiveCache || archiveCacheKey !== key) {
    archiveReadCount++
    const parsed: MemoryEntry[] = []
    try {
      for (const line of fs.readFileSync(ap, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { parsed.push(JSON.parse(line) as MemoryEntry) } catch { /* skip corrupt line */ }
      }
    } catch { return [] }
    archiveCache = parsed
    archiveCacheKey = key
  }
  const scored: Array<{ e: MemoryEntry; score: number }> = []
  for (const e of archiveCache) {
    const text = (e.content || '').toLowerCase()
    let score = 0
    for (const w of terms) if (text.includes(w)) score++
    if (score > 0) scored.push({ e, score })
  }
  scored.sort((a, b) => b.score - a.score || (b.e.ts || 0) - (a.e.ts || 0))
  return scored.slice(0, Math.max(1, limit)).map((s) => s.e)
}

/** Wave2 (codeIngest-stale-chunks): remove all stored code chunks for a file path so a
 *  re-index of an EDITED file REPLACES its chunks instead of accumulating stale copies with
 *  wrong line numbers / deleted code (code chunks are kind:'note', so the sleep pass never
 *  reclaims them). Tombstones by id (propagates + survives reload) but NOT by content hash,
 *  so unchanged regions can be re-written on the same pass. Returns how many were pruned. */
export function memoryPruneCodePath(filePath: string): number {
  if (!filePath || typeof filePath !== 'string') return 0
  const prefix = `${filePath}:`
  const victims = entries.filter(e => e.source === 'code' && typeof e.content === 'string' && e.content.startsWith(prefix))
  for (const v of victims) {
    const idx = entries.indexOf(v)
    if (idx !== -1) entries.splice(idx, 1)
    if (v.hash) seenHashes.delete(v.hash) // NOT tombstonedHashes — the new chunk for an unchanged region may reuse the hash
    const r = entryRow.get(v); if (r !== undefined) rowToEntry.delete(r)
    lexicalIndex.remove(v.id)
    removeNodeEdges(v.id)
    tombstones.add(v.id)
    appendShardLine(JSON.stringify({ deleted: v.id }), 'prune-code')
  }
  if (victims.length > 0) { hnswStaleAfterDelete(); bumpSearchGen(); persistDeletesFloor() }
  return victims.length
}

// Shared with memoryDelete/prune: a removal leaves an orphan packed row + a graph the HNSW
// index no longer matches — mark stale + drop the persisted graph so it can't reload against
// the renumbered store and silently mis-rank recall.
function hnswStaleAfterDelete(): void {
  if (hnswBuilding) buildGen++ // a delete during a build must abort it too
  if (!hnsw || hnswStale) return // nothing fresh to repair — the `allow` filter or a pending rebuild already excludes it
  // Tier-2 delete-repair: a deleted row is dropped from results by the search-time `allow` filter
  // immediately, so we no longer rebuild the WHOLE graph on every delete (the old behavior — a full
  // rebuild per delete under churn). We rebuild only once enough of the graph is dead that traversal
  // cost/quality would degrade.
  hnswDeletedSinceBuild++
  if (hnswDeletedSinceBuild > HNSW_REPAIR_RATIO * Math.max(1, vectorStore.size)) {
    hnswStale = true
    hnswDeletedSinceBuild = 0
    try { const hp = hnswFile(); if (hp) fs.rmSync(hp, { force: true }) } catch { /* best effort */ }
  }
}

/**
 * BB15: forget up to `max` (≤200) cold message chunks — drop them from the hot window
 * + indexes and record their hashes in the DEVICE-LOCAL forgot-set so re-ingest won't
 * resurrect them. NOT a CRDT delete (no tombstone — it's a local working-set trim, not
 * a propagated deletion). Returns the number forgotten. Off by default — callable for
 * a power-user near the cap; never auto-runs.
 */
export function memoryForget(opts: { now?: number; max?: number } = {}): number {
  const now = opts.now ?? Date.now()
  const max = Math.min(Math.max(opts.max ?? 200, 0), 200)
  if (max === 0) return 0
  const victims: MemoryEntry[] = []
  for (const e of entries) {
    if (victims.length >= max) break
    if (isForgettable(e, now, edgesFrom(e.id).length > 0)) victims.push(e)
  }
  for (const v of victims) {
    if (v.hash) {
      forgotSet.add(v.hash)
      while (forgotSet.size > FORGOT_CAP) { // cap, evict oldest (insertion order)
        const oldest = forgotSet.values().next().value
        if (oldest === undefined) break
        forgotSet.delete(oldest)
      }
      seenHashes.delete(v.hash)
    }
    const idx = entries.indexOf(v)
    if (idx !== -1) entries.splice(idx, 1)
    const r = entryRow.get(v)
    if (r !== undefined) rowToEntry.delete(r)
    lexicalIndex.remove(v.id)
  }
  if (victims.length > 0) {
    persistForgotSet()
    if (!hnswBuilding) compactVectorStore() // reclaim the orphaned rows after the batch
    bumpSearchGen()
  }
  return victims.length
}

/**
 * BB14 / WP-C: record agent feedback on a memory. `helpful=true` bumps an additive, CRDT-safe
 * usage counter (+1); `helpful=false` DECREMENTS it (-1) — both persisted as `{reinforce}` DELTA
 * control lines and replayed on reload. A net-positive count gently lifts a repeatedly-useful
 * memory in ranking (capped, never overrides relevance); a net-negative count DEMOTES it via
 * learnedUtility, and once it reaches SUPPRESS_THRESHOLD the memory is filtered out of recall
 * entirely (recoverable — later positive feedback lifts it back). This closes the previously
 * positive-only loop. POSITIVE feedback does NOT bump searchGen (a small rank nudge shouldn't
 * invalidate every cached search); NEGATIVE feedback DOES, so a demotion/suppression takes effect
 * on the very next search instead of lingering until the cache turns over.
 */
export function memoryFeedback(input: { id: string; helpful?: boolean; query?: string }): { id: string; used: number } {
  const id = input?.id
  if (!id || typeof id !== 'string') return { id: '', used: 0 }
  const delta = input.helpful === false ? -1 : 1 // WP-C: negative feedback is a real signal now
  const used = (usageMap.get(id) ?? 0) + delta
  usageMap.set(id, used)
  while (usageMap.size > USAGE_MAP_CAP) { // bound the map (evict oldest)
    const oldest = usageMap.keys().next().value
    if (oldest === undefined) break
    usageMap.delete(oldest)
  }
  appendShardLine(JSON.stringify({ reinforce: [{ id, used: delta, ts: Date.now() }] }), 'reinforce') // ±1 DELTA, not cumulative
  if (delta < 0) bumpSearchGen() // WP-C: negative feedback changes suppression/rank — invalidate cached searches so it applies to the NEXT search
  auditMemory({ event: 'learn', kind: 'feedback', detail: `${id} ${delta < 0 ? 'not-helpful' : 'helpful'} (net ${used})` }) // WP-E
  return { id, used }
}

// ---- Cross-machine sync control ----

export interface SyncStatus {
  syncing: boolean
  dir: string | null
  deviceId: string
  devices: number // shard files in the sync folder (≈ machines sharing this brain)
  count: number
  encrypted: boolean // this device holds the key and writes ciphertext at rest
  locked: boolean    // encrypted shards present that we can't read yet (passphrase needed)
  degraded: boolean  // F5: init failed and fell back to a local writable store (sync unavailable)
  corruptLinesSkipped: number // F28: unparseable shard lines dropped on the last reload
  embeddings: EmbeddingsStatus // honest tri-state — must not imply healthy before the first embed
}

export type EmbeddingsStatus = 'ready' | 'unavailable' | 'unprobed'

/** Honest embedder state: 'ready' (a real embed has SUCCEEDED), 'unavailable' (the model is
 *  known-dead or forced off), or 'unprobed' (not exercised yet — the status must NOT read as
 *  healthy before the first embed, which is the embeddingsready-overreports bug). */
export function embeddingsStatus(): EmbeddingsStatus {
  return embeddingsAvailable === true ? 'ready' : embeddingsAvailable === false ? 'unavailable' : 'unprobed'
}

/** Off-thread warm probe: if the embedder hasn't been exercised yet, run ONE embed to move the
 *  status out of 'unprobed'. It goes through the normal embed path, which uses the worker thread
 *  when one is registered — so it never blocks the PTY/main thread (that was the whole point of
 *  not doing this at init). Idempotent; only latches TRUE on success (a transient failure is left
 *  for the normal dead-model detection to latch, so we never false-downgrade to keyword-only). */
export async function warmProbeEmbeddings(): Promise<boolean> {
  if (embeddingsAvailable !== null) return embeddingsAvailable === true // already probed
  try {
    const vec = await embed('warm probe', true)
    if (vec && vec.length > 0 && embeddingsAvailable === null) embeddingsAvailable = true
  } catch {
    /* leave the state to the normal path's dead-model latch */
  }
  return embeddingsAvailable === true
}

/** Re-read all shards to pick up entries synced from other devices. No-op when local-only. */
export function reloadMemoryFromSync(): void {
  if (!syncDir) return
  reloadFrom(shardFiles())
}

export function getSyncStatus(): SyncStatus {
  let devices = 0
  if (syncDir) {
    try { devices = fs.readdirSync(syncDir).filter((f) => f.endsWith('.jsonl')).length } catch { devices = 0 }
  }
  return {
    syncing: !!syncDir,
    dir: syncDir,
    deviceId,
    devices,
    count: entries.length,
    encrypted: encKey !== null,
    locked: lockedShards,
    degraded: initDegraded,
    corruptLinesSkipped,
    embeddings: embeddingsStatus(),
  }
}

// ---- At-rest encryption ----
//
// When on, every shard line is AES-256-GCM encrypted under a key derived (scrypt)
// from the user's passphrase + a per-store salt (the salt lives in the sync
// folder; the derived key is cached LOCALLY, never synced). The sync provider
// sees only ciphertext; Termpolis, holding the key, reads it. Plaintext and
// ciphertext lines coexist, so enabling/disabling never corrupts a store.

function keyCachePath(): string | null { return userDataDir ? path.join(userDataDir, KEY_CACHE_FILE) : null }
function saltPath(): string | null { return syncDir ? path.join(syncDir, SALT_FILE) : null }
function optoutPath(): string | null { return userDataDir ? path.join(userDataDir, ENCRYPTION_OPTOUT_FILE) : null }
function encryptionOptedOut(): boolean { const p = optoutPath(); return !!p && fs.existsSync(p) }

// WP-F: default-ON, transparent at-rest encryption for a LOCAL-ONLY store. A random per-device key is
// stored in the OS keychain (safeStorage: DPAPI / Keychain / libsecret), so the on-disk store is
// AES-256-GCM ciphertext under a key that is NOT sitting in plaintext beside it. Synced stores are
// deliberately NOT auto-keyed here — a per-device key can't be shared across peers, so those use the
// passphrase model (setSyncPassphrase). Honest: if the OS keychain is unavailable we stay plaintext
// (never write a plaintext key) and getSyncStatus reports encrypted:false. Idempotent + migration-safe:
// enabling rewrites this device's shard atomically and plaintext/ciphertext lines coexist.
function maybeAutoEncrypt(): void {
  if (syncDir || encKey) return          // synced (passphrase-driven) or already encrypted
  if (encryptionOptedOut()) return       // the user turned it off
  if (!isOsEncryptionAvailable()) return // no keychain → honest plaintext, encrypted:false
  const p = keyCachePath()
  if (!p || !memPath) return
  try {
    const key = crypto.randomBytes(32)
    writeSecret(p, key.toString('base64')) // OS-encrypted at rest
    encKey = key
    rewriteSelfShard((plain) => encryptLine(key, plain)) // ciphertext-ify any existing plaintext
    reloadFrom(shardFiles())
  } catch (err) {
    encKey = null
    recordSwarmError('swarmMemory.autoEncrypt.failed', err, {})
  }
}

/** WP-F: explicitly turn ON transparent at-rest encryption for a local store (also clears an opt-out).
 *  Reports honestly (encrypted:false) and is a no-op when the OS keychain is unavailable. */
export function enableLocalEncryption(): SyncStatus {
  if (!userDataDir) throw new Error('enableLocalEncryption: memory not initialised')
  const op = optoutPath()
  if (op) { try { fs.rmSync(op, { force: true }) } catch { /* ignore */ } } // clear the opt-out so it stays on
  maybeAutoEncrypt()
  return getSyncStatus()
}

/** WP-F: turn OFF at-rest encryption for a local store — decrypt this device's shard back to plaintext,
 *  drop the device key, and REMEMBER the opt-out so default-on won't re-enable on the next launch.
 *  (For a cross-machine synced store, use disableSyncEncryption.) */
export function disableEncryption(): SyncStatus {
  if (!userDataDir) throw new Error('disableEncryption: memory not initialised')
  if (encKey) rewriteSelfShard((plain) => plain) // decrypt on read, write plaintext (must run WHILE encKey is set)
  encKey = null
  const p = keyCachePath()
  if (p) { try { fs.rmSync(p, { force: true }) } catch { /* ignore */ } }
  const op = optoutPath()
  if (op) { try { fs.writeFileSync(op, '1') } catch { /* ignore */ } } // remember the choice across launches
  reloadFrom(shardFiles())
  return getSyncStatus()
}

function loadCachedKey(): Buffer | null {
  const p = keyCachePath()
  if (!p) return null
  const b64 = readSecret(p) // transparently OS-decrypts (or reads legacy plaintext)
  if (!b64) return null
  const k = Buffer.from(b64, 'base64')
  return k.length === 32 ? k : null
}

function loadOrCreateSalt(): Buffer {
  const p = saltPath()
  if (!p) return newSalt()
  // F4: an existing salt is AUTHORITATIVE — read it and NEVER overwrite it. Minting a
  // replacement on a transient read hiccup, a half-synced file, or a bad merge would
  // re-derive a different key and permanently orphan every peer's ciphertext. Surface it.
  if (fs.existsSync(p)) {
    let b: Buffer
    try { b = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'base64') }
    catch { throw new Error('memory salt unavailable — retry (the encryption salt could not be read)') }
    if (b.length !== 16) throw new Error('memory salt malformed — retry (refusing to overwrite the existing salt)')
    return b
  }
  // F11: create write-once. If a peer wins the race after existsSync, adopt the winner
  // rather than clobbering it — the same passphrase must derive the same key everywhere.
  const s = newSalt()
  try {
    fs.writeFileSync(p, s.toString('base64'), { flag: 'wx' })
    return s
  } catch {
    try {
      const b = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'base64')
      if (b.length === 16) return b
    } catch { /* fall through to surface */ }
    throw new Error('memory salt unavailable — retry (could not create or read the encryption salt)')
  }
}

// Find one encrypted line across the synced shards, to validate a passphrase.
function findAnyEncryptedLine(): string | null {
  for (const f of shardFiles()) {
    let raw: string
    try { raw = fs.readFileSync(f, 'utf8') } catch { continue }
    for (const line of raw.split('\n')) { const s = line.trim(); if (isEncryptedLine(s)) return s }
  }
  return null
}

// Rewrite this device's shard in place, mapping each line's plaintext through
// `xform`. Lines we can't decrypt are kept verbatim (never dropped).
function rewriteSelfShard(xform: (plain: string) => string): void {
  if (!memPath) return
  let raw: string
  try { raw = fs.readFileSync(memPath, 'utf8') } catch { return }
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    const plain = isEncryptedLine(s) ? (encKey ? decryptLine(encKey, s) : null) : s
    out.push(plain === null ? s : xform(plain))
  }
  try {
    atomicWriteLines(memPath, out) // F7/F33: never truncate mid-rewrite
  } catch (err) {
    // The atomic write kept the ORIGINAL shard intact — surface the failure instead of
    // silently leaving a truncated/half-rewritten store.
    recordSwarmError('swarmMemory.rewriteShard.failed', err, { memPath })
  }
}

// Shard compaction thresholds — only worth rewriting a large shard that's mostly dead lines.
const COMPACT_MIN_LINES = 200
const COMPACT_DEAD_RATIO = 0.5

/**
 * Compact THIS device's append-only shard (shard-never-compacted). The log accumulates a line
 * per write/edit/delete/reinforce forever, so per-reload parse cost grows even as the live count
 * stays flat. Compaction rewrites the shard down to its EXACT CRDT contribution — the current
 * live own entries (dropping superseded edits + adds for since-deleted entries), the coalesced
 * usage deltas, and every tombstone / deleted-hash / clear-epoch line (kept so the deletions
 * still propagate to peers). A reload here or on any peer therefore converges to the identical
 * state. It is ATOMIC (temp+rename) and ABORTS if any line is locked/corrupt, so it can never
 * drop data it couldn't account for. Gated on size + dead-ratio unless forced.
 */
/**
 * Would compaction actually rewrite anything? Answered from MEMORY, without touching the disk.
 *
 * This exists because the real answer is ruinously expensive: read the entire shard, AES-decrypt
 * every line, JSON.parse it, rebuild, then AES-RE-ENCRYPT every output line -- and only THEN ask
 * "was there enough dead weight to bother?". Measured on a real 450 MB / 107k-line encrypted shard:
 *
 *     readFileSync                   792 ms
 *     split                           56 ms
 *     decrypt + parse x 107,288     1592 ms
 *     re-encrypt x 107,288          1835 ms
 *     join                           120 ms
 *     ------------------------------------
 *     4.4 SECONDS of synchronous main-thread work, every 30 minutes -- and then DISCARDED,
 *     because a healthy store is never 50% dead. That was the app going "(Not Responding)".
 *
 * The gate only ever needed an ESTIMATE, and an estimate is free: we know how many lines our own
 * shard has (we wrote them) and which of our entries are still live (they are in memory).
 *
 * Deliberately biased toward saying YES. The estimate omits patch/reinforce/clear lines, so it can
 * only ever OVER-state dead weight -- meaning it may send us off to do work that turns out to be
 * unnecessary, but it can never skip a compaction that was genuinely needed. A wrong guess costs
 * time; it cannot cost correctness.
 */
function compactionMayBeWorthwhile(): boolean {
  if (ownShardLines < COMPACT_MIN_LINES) return false
  if (ownShardAddIds.size === 0) return true // we know nothing about our shard -> go and look properly
  const liveIds = new Set<string>(entries.map((e) => e.id))
  let liveOwn = 0
  for (const id of ownShardAddIds) if (liveIds.has(id)) liveOwn++
  // Under-counts the real `after` (ignores patch/reinforce/clear lines) -> OVER-states dead weight.
  const estimatedAfter = liveOwn + tombstones.size + tombstonedHashes.size
  const estimatedDeadRatio = (ownShardLines - estimatedAfter) / ownShardLines
  return estimatedDeadRatio >= COMPACT_DEAD_RATIO
}

/** @internal test-only */
export function _compactionMayBeWorthwhileForTests(): boolean { return compactionMayBeWorthwhile() }
/** @internal test-only */
export function _ownShardStateForTests(): { lines: number; addIds: number } {
  return { lines: ownShardLines, addIds: ownShardAddIds.size }
}

export function compactSelfShard(opts?: { force?: boolean }): { compacted: boolean; before: number; after: number } {
  if (!memPath) return { compacted: false, before: 0, after: 0 }
  // Tier-2: a LOCAL-only store (no syncDir) is now compactable too — but ONLY when nothing has been
  // evicted, else on-disk entries outside the 500k hot window would be dropped. Sync shards: as before.
  if (!syncDir && evictedAny) return { compacted: false, before: 0, after: 0 }
  // THE GATE, MOVED IN FRONT OF THE WORK. Everything below -- the 450 MB read, the 107k
  // decrypts, the 107k re-encrypts -- used to run BEFORE we asked whether it was worth doing.
  if (!opts?.force && !compactionMayBeWorthwhile()) {
    return { compacted: false, before: ownShardLines, after: ownShardLines }
  }
  let raw: string
  try { raw = fs.readFileSync(memPath, 'utf8') } catch { return { compacted: false, before: 0, after: 0 } }
  const rawLines = raw.split('\n').filter((l) => l.trim())
  const before = rawLines.length
  if (before === 0) return { compacted: false, before: 0, after: 0 }

  const ownAddIds = new Set<string>()
  const shardTombstones = new Set<string>()
  const shardDeletedHashes = new Set<string>()
  const shardClearedIds = new Set<string>()
  let shardClearEpoch = 0
  const shardReinforce = new Map<string, number>()
  const patchLines: string[] = []
  for (const line of rawLines) {
    const c = classifyShardLine(line)
    switch (c.t) {
      case 'add': ownAddIds.add(c.entry.id); break
      case 'delete': shardTombstones.add(c.id); break
      case 'deleteHash': shardDeletedHashes.add(c.hash); break
      case 'clear': shardClearEpoch = Math.max(shardClearEpoch, c.before); break
      case 'clearIds': for (const id of c.ids) shardClearedIds.add(id); break
      case 'reinforce': for (const d of c.deltas) shardReinforce.set(d.id, (shardReinforce.get(d.id) ?? 0) + d.used); break
      case 'patch': patchLines.push(JSON.stringify({ patch: { hash: c.hash, project: c.project, ...(c.projectKey && { projectKey: c.projectKey }) } })); break
      case 'locked':
      case 'corrupt':
        return { compacted: false, before, after: before } // never rewrite over data we can't read
      case 'skip':
        break
    }
  }

  // Live own entries = own add-ids still present in the merged hot window (all tombstones / clears
  // / dedup already applied), re-emitted in their CURRENT form.
  const liveById = new Map<string, MemoryEntry>(entries.map((e) => [e.id, e] as [string, MemoryEntry]))
  const liveOwn: MemoryEntry[] = []
  for (const id of ownAddIds) { const e = liveById.get(id); if (e) liveOwn.push(e) }

  const emit = (plain: string): string => (encKey ? encryptLine(encKey, plain) : plain)
  const out: string[] = []
  if (shardClearEpoch > 0) out.push(emit(JSON.stringify({ clearedBefore: shardClearEpoch })))
  if (shardClearedIds.size > 0) out.push(emit(JSON.stringify({ clearedIds: [...shardClearedIds] })))
  for (const e of liveOwn) out.push(emit(serializeEntry(e)))
  const reinforce = [...shardReinforce.entries()].filter(([id, u]) => u !== 0 && liveById.has(id)).map(([id, used]) => ({ id, used, ts: Date.now() }))
  if (reinforce.length > 0) out.push(emit(JSON.stringify({ reinforce })))
  for (const id of shardTombstones) out.push(emit(JSON.stringify({ deleted: id })))
  for (const hash of shardDeletedHashes) out.push(emit(JSON.stringify({ deletedHash: hash })))
  for (const p of patchLines) out.push(emit(p))

  const after = out.length
  if (!opts?.force && (before < COMPACT_MIN_LINES || (before - after) / before < COMPACT_DEAD_RATIO)) {
    return { compacted: false, before, after: before } // not enough dead weight to bother
  }
  try {
    atomicWriteLines(memPath, out)
  } catch (err) {
    recordSwarmError('swarmMemory.compact.failed', err, { memPath })
    return { compacted: false, before, after: before }
  }
  reloadFrom(shardFiles())
  return { compacted: true, before, after }
}

// ---- Brain export / import (portable .zip) --------------------------------

/** Serialize the FULL current brain (the live merged entries + usage) as JSONL — the portable
 *  memory content for an export. Always plaintext (the archive carries its own integrity/opt
 *  encryption). Deliberately add-only: no tombstones/clear lines, so importing this into another
 *  brain never DELETES anything there — it only contributes memories. */
export function exportMemorySnapshot(): string {
  const lines: string[] = entries.map(serializeEntry)
  const reinforce = [...usageMap.entries()].filter(([, u]) => u !== 0).map(([id, used]) => ({ id, used, ts: Date.now() }))
  if (reinforce.length > 0) lines.push(JSON.stringify({ reinforce }))
  return lines.length ? lines.join('\n') + '\n' : ''
}

/** Merge an exported memory snapshot into THIS brain (grow-only CRDT union — additive, never
 *  destructive). Adds are deduped by id/content-hash on reload; usage deltas are folded in. Lines
 *  are appended through the normal path, so they inherit at-rest encryption if this store is
 *  encrypted. Returns how many memory rows were contributed. */
export function importMemorySnapshot(jsonl: string): { imported: number } {
  if (!memPath || !jsonl) return { imported: 0 }
  let imported = 0
  for (const line of jsonl.split('\n')) {
    const s = line.trim()
    if (!s) continue
    const c = classifyShardLine(s)
    if (c.t !== 'add' && c.t !== 'reinforce') continue // only additive content is imported
    if (appendShardLine(s, 'brain-import', { fsync: false }) && c.t === 'add') {
      ownShardAddIds.add(c.entry.id) // imported adds are ours too, for the compaction gate
      imported++
    }
  }
  reloadFrom(shardFiles())
  return { imported }
}

// Enable encryption (first time) OR unlock an already-encrypted store on a new
// device: derive the key from the passphrase + the store's salt, validate it
// against any existing ciphertext, cache it locally, (re-)encrypt this device's
// shard, and reload.
export function setSyncPassphrase(passphrase: string): SyncStatus {
  if (!syncDir) throw new Error('setSyncPassphrase: cross-machine sync is not enabled')
  if (!passphrase || !passphrase.trim()) throw new Error('setSyncPassphrase: passphrase required')
  const key = deriveKey(passphrase, loadOrCreateSalt())
  // If the store already holds ciphertext, the passphrase must decrypt it.
  const sample = findAnyEncryptedLine()
  if (sample && decryptLine(key, sample) === null) {
    throw new Error('Incorrect passphrase for the existing encrypted memory.')
  }
  encKey = key
  const p = keyCachePath()
  if (p) { try { writeSecret(p, key.toString('base64')) } catch { /* best effort */ } } // OS-keychain at rest
  rewriteSelfShard((plain) => encryptLine(key, plain)) // ciphertext-ify our own shard
  reloadFrom(shardFiles())
  return getSyncStatus()
}

// Turn encryption off: decrypt this device's shard back to plaintext and drop the
// local key. (Peers stay encrypted until they do the same.)
export function disableSyncEncryption(): SyncStatus {
  if (!syncDir) throw new Error('disableSyncEncryption: cross-machine sync is not enabled')
  if (encKey) rewriteSelfShard((plain) => plain) // decrypts on read, writes plaintext
  encKey = null
  const p = keyCachePath()
  if (p) { try { fs.rmSync(p, { force: true }) } catch { /* best effort */ } }
  reloadFrom(shardFiles())
  return getSyncStatus()
}

// Turn cross-machine sync on (point at a synced folder) or off (null = local-only).
// Persists the choice and re-initialises from the new location.
export function setSyncDir(dir: string | null): SyncStatus {
  if (!userDataDir) throw new Error('setSyncDir: memory not initialised')
  const clean = dir && dir.trim() ? path.resolve(dir.trim()) : null
  // Turning sync OFF: snapshot the current (unioned) memories into the local store so we
  // don't appear to lose everything synced from peers. F3: ALSO serialize the usage
  // (reinforcement) deltas so the learning layer survives the round-trip (serializeEntry
  // emits ONLY entries, so usageMap was silently lost before), plus tombstones for
  // deletion durability. Write it ATOMICALLY and ABORT the switch on failure so a disk
  // hiccup never drops the user onto a stale/empty local store. (clearEpoch is carried by
  // the device-local floor, NOT written here — a clear line after the entries would
  // wrongly mark these post-clear survivors epoch-vulnerable on the next reload.)
  if (!clean && syncDir && legacyPath) {
    const lines: string[] = entries.map(serializeEntry)
    const reinforce = [...usageMap.entries()].filter(([, u]) => u !== 0).map(([id, used]) => ({ id, used, ts: Date.now() }))
    if (reinforce.length > 0) lines.push(JSON.stringify({ reinforce }))
    for (const id of tombstones) lines.push(JSON.stringify({ deleted: id }))
    try {
      atomicWriteFile(legacyPath, lines.length ? lines.join('\n') + '\n' : '')
    } catch (err) {
      recordSwarmError('swarmMemory.syncOff.snapshot.failed', err, { legacyPath })
      throw new Error('Could not snapshot memory to the local store — sync left ON to avoid data loss. Retry once the disk is writable.')
    }
  }
  writeSyncConfig(userDataDir, clean)
  initSwarmMemory(userDataDir, { syncDir: clean })
  return getSyncStatus()
}

// ---- WP-G: memory-at-rest secret scrub ----
//
// Secrets must be redacted OUT of a memory BEFORE the brain stores it. A key that reaches the
// store isn't just at rest on disk — it's embedded into a vector and later RECALLED and
// re-injected into another agent's context, which is exactly the leak the AI Security Center
// exists to close. So the scrub runs on the WRITE path, ahead of the hash/embed/persist.
//
// The ~70-rule scanner lives in aiSecurity.ts, which imports `electron` at module scope —
// importing it here would drag electron into swarmMemory's electron-free unit suite. So the
// scrubber is INJECTED, exactly like the embedder (embedOverride/_setEmbedFnForTests): main
// installs the real one at startup, tests inject a fake, and with nothing installed the write
// path is a byte-for-byte no-op. aiSecurity's ScanResult is a superset of MemoryScrubResult,
// so `scanText` satisfies this contract directly.

/** What swarmMemory needs back from a secret scanner: the redacted text + how many it found. */
export interface MemoryScrubResult {
  redacted: string
  hitCount: number
}

export type MemoryScrubber = (content: string) => MemoryScrubResult

/** Install the secret scrubber used on the write path (src/main/index.ts wires aiSecurity's
 *  scanText, gated on the `memoryScrub` setting). `null` uninstalls it — content is then
 *  stored verbatim, which is also the default when main never wires one up. */
export function setMemoryScrubber(fn: MemoryScrubber | null): void {
  scrubFn = fn
}

/** @internal test-only — the same seam under the file's test-seam naming. */
export function _setScrubFnForTests(fn: MemoryScrubber | null): void {
  scrubFn = fn
}

/** Observable proof the scrub is doing work: how many writes were redacted this session and
 *  how many secrets that removed. Feeds the security panel / dashboard; per-write reporting
 *  rides on the TRANSIENT `scrubbed` count of the entry memoryWrite returns. */
export function memoryScrubStats(): { scrubbedWrites: number; secretsRedacted: number } {
  return { scrubbedWrites, secretsRedacted }
}

// Run the installed scrubber over a memory's content. Returns the text to store and how many
// secrets were redacted out of it.
function scrubContent(raw: string): { content: string; hits: number } {
  if (!scrubFn) return { content: raw, hits: 0 }
  try {
    const r = scrubFn(raw)
    // Swap the text in ONLY when a secret was actually found (and the scrubber handed back a
    // usable string): secret-free content must land byte-for-byte as the agent wrote it — no
    // silent normalization via a scanner round-trip.
    if (!r || typeof r.redacted !== 'string' || !(r.hitCount > 0)) return { content: raw, hits: 0 }
    scrubbedWrites++
    secretsRedacted += r.hitCount
    return { content: r.redacted, hits: r.hitCount }
  } catch (err) {
    // Fail OPEN, loudly. The scanner is pure regex and shouldn't throw; if it does, dropping the
    // agent's memory would be the bigger harm — so store it and surface the failure rather than
    // letting a broken scrubber silently disable the protection.
    recordSwarmError('swarmMemory.scrub.failed', err, { kind: 'memory-scrub' })
    recordAnomaly('scrub-failed', 'secret scrubber threw — content was stored unscrubbed')
    return { content: raw, hits: 0 }
  }
}

// ---- Embedding helper ----
//
// Delegates to the in-process local embedder (bge-small via WASM). The
// embedOverride seam lets tests inject deterministic vectors, and the
// embeddingsAvailable flag both forces keyword-only mode in tests and caches a
// "model is dead, stop trying" signal so we don't repeatedly attempt loads.

async function embed(text: string, isQuery: boolean): Promise<number[] | null> {
  if (embedOverride) {
    try {
      const r = await embedOverride(text)
      if (!Array.isArray(r)) return null
      if (r.length > MAX_EMBEDDING_DIM) return null
      return r
    } catch {
      return null
    }
  }
  if (embeddingsAvailable === false) return null  // forced off (tests) / known-dead model
  try {
    const emb = await embedText(text, { isQuery })
    // F29: the REAL model must output EXACTLY EMBED_DIM — a wrong bundled model (e.g. 768)
    // would otherwise pass a loose <=1024 gate, fail the packed store's ===EMBED_DIM check,
    // and silently collapse recall onto the slow/legacy path.
    if (!emb || emb.length !== EMBED_DIM) {
      // F8: only latch OFF when the model is genuinely dead (localEmbedder owns the terminal
      // loadFailed latch → isEmbedderReady()===false). A transient per-call null with a
      // loaded model must NOT permanently downgrade the whole session to keyword-only.
      // (embeddingsAvailable is true|null here — the early `=== false` return excluded false.)
      if (!isEmbedderReady()) {
        embeddingsAvailable = false
        recordSwarmError('swarmMemory.embed.unavailable', new Error('embedder not ready or wrong dim'), {})
      }
      return null
    }
    embeddingsAvailable = true
    return emb
  } catch (err) {
    if (!isEmbedderReady()) {
      embeddingsAvailable = false
      recordSwarmError('swarmMemory.embed.unavailable', err, {})
    }
    return null
  }
}

/** Whether the local semantic embedder is available (vs the keyword-only fallback).
 *  Not-yet-probed (null) reports true — the bge model is bundled and normally loads; a
 *  probe flips it false only on a real failure. Feeds the dashboard reliability SLI. */
export function embeddingsReady(): boolean {
  return embeddingsAvailable !== false
}

// Exposed for tests
export function _setEmbeddingsAvailable(v: boolean | null): void {
  embeddingsAvailable = v
  bumpSearchGen() // toggling embed availability changes results — invalidate the cache
}

export function _setEmbedFnForTests(fn: ((text: string) => Promise<number[] | null>) | null): void {
  embedOverride = fn
  bumpSearchGen() // swapping the embedder changes results — invalidate the cache
}

/** F26: how many durable (fsync'd) appends have happened — lets tests prove high-value
 *  writes are flushed to disk while bulk chunks are not, without spying on fs. */
export function _fsyncCountForTests(): number { return fsyncCount }
