import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { recordSwarmError } from './telemetry'
import { embedText, EMBED_DIM } from './localEmbedder'
import { deriveKey, newSalt, encryptLine, decryptLine, isEncryptedLine } from './memoryCrypto'
import { VectorStore } from './vectorStore'
import { LexicalIndex } from './lexicalIndex'
import { TtlLruCache, rankScore, mergeRelated, gateByScore, fuseImportance } from './memoryEconomy'
import { mmrRerank } from './mmrRerank'
import { initMemoryGraph, addMemoryEdge, traverseGraph, edgesFrom, neighboursOf, graphStats, expandWithGraph, effectiveWeight, EDGE_EPSILON, _resetGraphForTests, type MemoryEdge } from './memoryGraph'
import { HnswIndex, type SerializedHnsw } from './hnswIndex'
import { readSecret, writeSecret } from './secureKeyStore'

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
  hash?: string                   // content hash for idempotent ingestion dedup
}

/** Normalize a cwd/path or bare name into a lowercase project slug (its basename). */
export function normalizeProjectSlug(pathOrName: string): string {
  if (typeof pathOrName !== 'string') return ''
  const base = pathOrName.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  return base.trim().toLowerCase().slice(0, 128)
}

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
let clearEpoch = 0                    // epoch tombstone: entries with ts <= this are cleared everywhere
let seq = 0
let embeddingsAvailable: boolean | null = null  // cached probe result
let embedOverride: ((text: string) => Promise<number[] | null>) | null = null
let encKey: Buffer | null = null      // AES key for at-rest shard encryption (null = plaintext)
let lockedShards = false              // encrypted shards present that we couldn't read (need passphrase)
// Packed vector index: real (EMBED_DIM) embeddings live in one Float32Array
// instead of per-entry number[] (the memory win), with bidirectional maps to the
// owning entry. Non-EMBED_DIM vectors (tests/legacy) stay as number[] on the
// entry and use the exact per-object path, so behaviour there is unchanged.
let vectorStore = new VectorStore(EMBED_DIM)
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
let hnswThreshold = 50_000
let hnswBuilding = false                       // a background build is in flight
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

function loadOrCreateDeviceId(dir: string): string {
  const p = path.join(dir, DEVICE_ID_FILE)
  try {
    const existing = fs.readFileSync(p, 'utf8').trim()
    if (existing) return existing
  } catch { /* create below */ }
  const id = crypto.randomBytes(8).toString('hex')
  try { fs.writeFileSync(p, id) } catch { /* best effort — falls back to an ephemeral id */ }
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

function parseShardLine(line: string, adds: MemoryEntry[]): void {
  const s = line.trim()
  if (!s) return
  let plain: string = s
  if (isEncryptedLine(s)) {
    const dec = encKey ? decryptLine(encKey, s) : null
    if (dec === null) { lockedShards = true; return } // no key / wrong key → can't read this entry
    plain = dec
  }
  let obj: { id?: unknown; content?: unknown; deleted?: unknown; clearedBefore?: unknown; reinforce?: unknown }
  try { obj = JSON.parse(plain) } catch { return /* skip malformed line */ }
  if (!obj || typeof obj !== 'object') return
  if (typeof obj.deleted === 'string') { tombstones.add(obj.deleted); return }
  if (typeof obj.clearedBefore === 'number') { if (obj.clearedBefore > clearEpoch) clearEpoch = obj.clearedBefore; return }
  if (Array.isArray(obj.reinforce)) {
    // BB13/BB14: collect usage deltas; applied after the full state is known (reloadFrom).
    for (const r of obj.reinforce as Array<{ id?: unknown; used?: unknown; ts?: unknown }>) {
      if (r && typeof r.id === 'string' && typeof r.used === 'number') {
        pendingReinforce.push({ id: r.id, used: r.used, ts: typeof r.ts === 'number' ? r.ts : 0 })
      }
    }
    return
  }
  if (obj.id && typeof obj.content === 'string') adds.push(obj as unknown as MemoryEntry)
}

// Rebuild the hot window from a set of shard files: union of adds, minus
// tombstones (deleted ids + clear epoch), deduped by id and content-hash,
// newest-maxEntries kept. Order-independent → safe to merge any device set.
function reloadFrom(paths: string[]): void {
  entries.length = 0
  seenHashes.clear()
  tombstones.clear()
  clearEpoch = 0
  lockedShards = false
  pendingReinforce = []
  const adds: MemoryEntry[] = []
  for (const p of paths) {
    let raw: string
    try { raw = fs.readFileSync(p, 'utf8') } catch { continue }
    for (const line of raw.split('\n')) parseShardLine(line, adds)
  }
  adds.sort((a, b) => (a.ts || 0) - (b.ts || 0)) // stable, oldest→newest
  const seenIds = new Set<string>()
  for (const e of adds) {
    if (seenIds.has(e.id)) continue                 // same id in >1 file (e.g. legacy migration)
    if (tombstones.has(e.id)) continue              // explicitly deleted
    if ((e.ts || 0) <= clearEpoch) continue         // cleared epoch
    if (e.hash && seenHashes.has(e.hash)) continue  // same content from another shard
    seenIds.add(e.id)
    entries.push(e)
    if (e.hash) seenHashes.add(e.hash)
  }
  while (entries.length > maxEntries) {
    const dropped = entries.shift()
    if (dropped?.hash) seenHashes.delete(dropped.hash)
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
}

export function initSwarmMemory(userDataPath: string, opts: { syncDir?: string | null } = {}): void {
  if (!userDataPath || typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new Error('initSwarmMemory: absolute userDataPath required')
  }
  const resolved = path.resolve(userDataPath)
  userDataDir = resolved
  legacyPath = path.join(resolved, 'swarm-memory.jsonl')
  initMemoryGraph(resolved)
  deviceId = loadOrCreateDeviceId(resolved)
  // explicit opt wins; otherwise the persisted choice; otherwise local-only
  syncDir = opts.syncDir !== undefined ? (opts.syncDir || null) : readSyncConfig(resolved)

  entries.length = 0
  seenHashes.clear()
  tombstones.clear()
  clearEpoch = 0
  lockedShards = false
  encKey = null
  seq = 0
  embeddingsAvailable = null

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
      // Load this device's locally-cached encryption key (if the user enabled
      // encryption previously) so reloadFrom can decrypt — auto-unlocks on launch.
      encKey = loadCachedKey()
      reloadFrom(shardFiles())
    } else {
      memPath = legacyPath
      if (fs.existsSync(memPath)) reloadFrom([memPath])
      else fs.writeFileSync(memPath, '')
    }
  } catch (err) {
    // Real failure — disk unwritable, perms broken, sync folder gone, etc.
    // memPath -> null means subsequent writes silently disappear (data loss for
    // the user's context). Worth surfacing.
    recordSwarmError('swarmMemory.init.failed', err, { memPath })
    memPath = null
  }
  loadForgotSet() // BB15: device-local forgot-set (anti-thrash for the 30-min re-ingest)
}

export function _resetForTests(): void {
  memPath = null
  userDataDir = null
  legacyPath = null
  deviceId = ''
  syncDir = null
  entries.length = 0
  seenHashes.clear()
  forgotSet.clear()
  usageMap.clear()
  pendingReinforce = []
  tombstones.clear()
  clearEpoch = 0
  encKey = null
  lockedShards = false
  vectorStore = new VectorStore(EMBED_DIM)
  rowToEntry.clear()
  hnsw = null
  hnswStale = false
  hnswThreshold = 50_000
  hnswBuilding = false
  hnswBuildDone = Promise.resolve()
  hnswYieldMs = 8
  seq = 0
  maxEntries = DEFAULT_MAX_ENTRIES
  embeddingsAvailable = null
  embedOverride = null
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

/** True if a chunk with this content hash is already stored OR was forgotten on this
 *  device (so re-ingest skips it — the anti-thrash prize of BB15). */
export function memoryHasHash(hash: string): boolean {
  return typeof hash === 'string' && (seenHashes.has(hash) || forgotSet.has(hash))
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

/** Backfill project slugs onto already-stored entries by content hash — used by
 *  re-ingest so legacy conversation chunks (written before `project` existed)
 *  become current-directory-recallable. IN-MEMORY ONLY by design: the durable
 *  JSONL/shard format stays append-only and untouched; the auto-indexer re-runs
 *  ingest every launch, so the tags re-derive for free each session. Never
 *  overwrites an existing tag. Returns how many entries were patched. */
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
    if (e && !e.project) { e.project = slug; patched++ }
  }
  return patched
}

/** Store stats for observability / UI: current count + the hot-window capacity. */
export function memoryStats(): { count: number; capacity: number } {
  return { count: entries.length, capacity: maxEntries }
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
}

// Auto-link only high-signal kinds so the knowledge graph stays meaningful (not
// flooded by transcript/code chunks); each links to its top-K nearest neighbours.
const AUTO_LINK_KINDS = new Set<MemoryEntry['kind']>(['decision', 'fact', 'result'])
const AUTO_LINK_K = 3
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
  const normalized = (content || '').normalize('NFC').replace(/\s+/g, ' ').trim()
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

export async function memoryWrite(input: WriteInput): Promise<MemoryEntry> {
  if (!input || typeof input.content !== 'string' || !input.content.trim()) {
    throw new Error('memoryWrite: content required')
  }
  const kind = input.kind || 'note'
  const projectSlug = input.project ? normalizeProjectSlug(input.project) : ''
  const content = input.content.length > MAX_CONTENT
    ? input.content.slice(0, MAX_CONTENT)
    : input.content

  // De-duplicate by content so the same information never lands twice — not in
  // the packed vector store, not in the JSONL on disk. Ingestion supplies its
  // own source-scoped hash (idempotent re-ingest of a transcript/file); direct
  // writes get a content hash. A hit returns the already-stored entry and skips
  // the embed + persist + index work entirely (the Memex content-addressed win).
  const effectiveHash = input.hash || contentHash(content)
  if (seenHashes.has(effectiveHash)) {
    const existing = entries.find(e => e.hash === effectiveHash)
    if (existing) return existing
  }

  const entry: MemoryEntry = {
    id: `mem-${Date.now()}-${++seq}-${crypto.randomBytes(3).toString('hex')}`,
    ts: Date.now(),
    agentId: input.agentId || 'unknown',
    kind,
    content,
    ...(input.tags && input.tags.length > 0 && { tags: input.tags.slice(0, 20) }),
    ...(input.taskId && { taskId: input.taskId }),
    ...(input.source && { source: input.source }),
    ...(projectSlug && { project: projectSlug }),
    hash: effectiveHash,
  }

  // Opportunistic embedding — swallow any failure silently
  try {
    const emb = await embed(content, false)
    if (emb) entry.embedding = emb
  } catch { /* ignore */ }

  persist(entry) // disk gets the full entry incl. embedding, BEFORE we pack it

  // Keep a lean copy in the hot window: its EMBED_DIM vector moves to the packed
  // store and the number[] is freed (the memory win). Return the ORIGINAL (with
  // embedding) so the write contract still exposes it.
  const stored: MemoryEntry = { ...entry }
  indexEntryVector(stored)
  lexicalIndex.add(stored.id, stored.content) // BB1: keep the lexical index in sync
  entries.push(stored)
  if (stored.hash) seenHashes.add(stored.hash)
  if (entries.length > maxEntries) {
    const dropped = entries.shift()
    if (dropped) {
      if (dropped.hash) seenHashes.delete(dropped.hash)
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

  // Knowledge graph: auto-link a curated memory to its nearest neighbours so the
  // graph grows passively as you work. High-value kinds only (transcript/code
  // chunks would flood it; the agent can still link anything via memory_link).
  if (AUTO_LINK_KINDS.has(kind) && entry.embedding) {
    try {
      // Side-effect-free neighbour lookup: reuse the embedding we just computed and
      // scan the packed store directly, so growing the graph never kicks an HNSW
      // (re)build or a disk-persist — those stay owned by memorySearch alone.
      for (const n of nearestNeighbours(entry.embedding, AUTO_LINK_K, entry.id)) {
        if (n.score <= 0) continue
        addMemoryEdge({ from: entry.id, to: n.id, relation: 'relates-to', weight: n.score, createdBy: 'auto' })
      }
    } catch { /* best effort — linking never blocks a write */ }
  } else if (DENSIFY_KINDS.has(kind) && entry.embedding) {
    // BB16: link a message/note chunk to its single best neighbour, but only when
    // the relation is genuinely tight (cosine >= 0.6) — densifies the bulk without
    // flooding the graph. Idempotent via upsertEdge; never blocks a write.
    try {
      const [n] = nearestNeighbours(entry.embedding, 1, entry.id)
      if (n && n.score >= DENSIFY_MIN_COSINE) {
        addMemoryEdge({ from: entry.id, to: n.id, relation: 'relates-to', weight: n.score, createdBy: 'auto' })
      }
    } catch { /* best effort */ }
  }
  return entry
}

// Append one raw JSON line to this device's shard, encrypting it at rest when a
// key is set. Best-effort: a write failure is surfaced but never thrown.
function appendShardLine(raw: string, ctx: string): void {
  if (!memPath) return
  try {
    fs.appendFileSync(memPath, (encKey ? encryptLine(encKey, raw) : raw) + '\n')
  } catch (err) {
    // Append failure means this swarm fact never reaches disk — agents
    // will lose context on next launch. Surface it.
    recordSwarmError('swarmMemory.persist.failed', err, { entryId: ctx })
  }
}

function persist(entry: MemoryEntry): void {
  appendShardLine(JSON.stringify(entry), entry.id)
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
  if (hnsw && !hnswStale) hnsw.add(row)                        // keep the graph fresh incrementally
  else if (vectorStore.size >= hnswThreshold) hnswStale = true // crossed the threshold → (re)build on next search
}

// Rebuild the packed store from the current hot window (after reload/trim/clear).
function rebuildVectorIndex(): void {
  vectorStore = new VectorStore(EMBED_DIM)
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
  if (loaded) { hnsw = loaded; hnswStale = false; return }
  hnswBuilding = true
  hnswBuildDone = (async () => {
    try {
      const rows = [...rowToEntry.keys()] // snapshot: mid-build writes don't corrupt the walk
      const idx = new HnswIndex((r) => vectorStore.get(r))
      let last = Date.now()
      for (const row of rows) {
        if (!rowToEntry.has(row)) continue // deleted mid-build → skip
        idx.add(row)
        if (Date.now() - last >= hnswYieldMs) { await new Promise<void>((r) => setImmediate(r)); last = Date.now() }
      }
      hnsw = idx
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

function passesFilter(e: MemoryEntry, opts: SearchOptions): boolean {
  if (opts.agentId && e.agentId !== opts.agentId) return false
  if (opts.kind && e.kind !== opts.kind) return false
  if (opts.taskId && e.taskId !== opts.taskId) return false
  if (opts.project && e.project !== opts.project) return false
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
  diversify?: boolean             // BB2: over-fetch + MMR re-rank so near-dups don't crowd the top
}

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
  return `${searchGen}|${o.query}|${limit}|${o.agentId ?? ''}|${o.kind ?? ''}|${o.taskId ?? ''}|${o.project ?? ''}|${o.diversify ? 'd' : ''}`
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
  if (projectSlug) opts = { ...opts, project: projectSlug }

  const cacheKey = searchCacheKey(opts, limit)
  const cached = searchCache.get(cacheKey)
  if (cached) return cached

  // Filter pool first — cheap wins
  let pool = entries
  if (opts.agentId) pool = pool.filter(e => e.agentId === opts.agentId)
  if (opts.kind) pool = pool.filter(e => e.kind === opts.kind)
  if (opts.taskId) pool = pool.filter(e => e.taskId === opts.taskId)
  if (opts.project) pool = pool.filter(e => e.project === opts.project)
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
      if (hits.length === 0) hits = vectorStore.searchTopK(queryF32, fetchN, allow) // exact brute-force fallback
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
  const ranked = scored.map(r => ({ r, k: fuseImportance(rankScore({ relevance: r.score, ts: r.ts, kind: r.kind, now }), usageMap.get(r.id) ?? 0) }))
  ranked.sort((a, b) => b.k - a.k || b.r.ts - a.r.ts)
  const survivors = ranked.map(x => x.r).filter(r => r.score > 0)
  let result: MemorySearchResult[]
  if (opts.diversify) {
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
    result = survivors.slice(0, limit)
  }

  // BB7: fold in graph-connected neighbours of the top results (off by default, and
  // skipped when the graph is empty — byte-identical to the non-fused path then).
  if (graphFusionEnabled && graphStats().edges > 0) {
    const entriesById = new Map<string, MemoryEntry>(entries.map(e => [e.id, e]))
    result = expandWithGraph(
      result,
      (id) => neighboursOf(id),
      (id, score) => {
        const e = entriesById.get(id)
        return e && passesFilter(e, opts) ? { ...e, score } : null
      },
      { seeds: 5, tau: 0.1, lambda: 0.5, cap: limit },
    ).slice(0, limit)
  }

  searchCache.set(cacheKey, result)
  return result
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
  const edges = edgesFrom(opts.id)
    .filter(e => e.to !== opts.id)
    .map(e => ({ id: e.to, relation: e.relation, weight: e.weight }))
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
    const score = h.pathWeight * Math.pow(GRAPH_GAMMA, h.distance - 1) * effectiveWeight(1, h.ts, now)
    if (score < EDGE_EPSILON) continue
    out.push({ ...e, score, relation: h.relation, distance: h.distance })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

// Record a typed connection between two memories (agent-facing memory_link).
export function memoryLink(input: { from: string; to: string; relation?: string; weight?: number; createdBy?: string }): MemoryEdge | null {
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
  let pool = entries.slice().reverse()  // newest first
  if (opts.agentId) pool = pool.filter(e => e.agentId === opts.agentId)
  if (opts.kind) pool = pool.filter(e => e.kind === opts.kind)
  if (opts.since) pool = pool.filter(e => e.ts >= opts.since!)
  return pool.slice(0, limit)
}

export function memoryCount(): number {
  return entries.length
}

export function memoryClear(): void {
  entries.length = 0
  seenHashes.clear()
  forgotSet.clear()
  persistForgotSet()
  usageMap.clear()
  vectorStore = new VectorStore(EMBED_DIM)
  rowToEntry.clear()
  lexicalIndex.clear()
  hnsw = null
  hnswStale = false
  try { const hp = hnswFile(); if (hp) fs.rmSync(hp, { force: true }) } catch { /* best effort */ }
  if (!memPath) return
  if (syncDir) {
    // Propagating clear: an epoch tombstone so every device drops everything up
    // to now (truncating the shard would just resurrect from peers on next sync).
    clearEpoch = Date.now()
    appendShardLine(JSON.stringify({ clearedBefore: clearEpoch }), 'clear')
  } else {
    try { fs.writeFileSync(memPath, '') } catch { /* best effort */ }
  }
}

/** Delete a single entry everywhere — writes a tombstone that propagates via shards. */
export function memoryDelete(id: string): void {
  if (!id) return
  const idx = entries.findIndex((e) => e.id === id)
  if (idx !== -1) {
    const [removed] = entries.splice(idx, 1)
    if (removed) {
      if (removed.hash) seenHashes.delete(removed.hash)
      const r = entryRow.get(removed)
      if (r !== undefined) rowToEntry.delete(r)
    }
  }
  lexicalIndex.remove(id)
  tombstones.add(id)
  appendShardLine(JSON.stringify({ deleted: id }), 'delete')
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
 * BB14: record agent feedback that a memory was helpful. `helpful=true` bumps an
 * additive, CRDT-safe usage counter — persisted as a `{reinforce}` DELTA control line
 * and replayed on reload — which gently lifts repeatedly-useful memories in ranking
 * (BB13's fuseImportance, capped so it never overrides relevance). `helpful=false` is a
 * no-op for now (no suppression until a forgetting curve can consume it). Deliberately
 * does NOT bump searchGen (reinforcement shouldn't invalidate every cached search).
 */
export function memoryFeedback(input: { id: string; helpful?: boolean; query?: string }): { id: string; used: number } {
  const id = input?.id
  if (!id || typeof id !== 'string') return { id: '', used: 0 }
  if (input.helpful === false) return { id, used: usageMap.get(id) ?? 0 }
  const used = (usageMap.get(id) ?? 0) + 1
  usageMap.set(id, used)
  while (usageMap.size > USAGE_MAP_CAP) { // bound the map (evict oldest)
    const oldest = usageMap.keys().next().value
    if (oldest === undefined) break
    usageMap.delete(oldest)
  }
  appendShardLine(JSON.stringify({ reinforce: [{ id, used: 1, ts: Date.now() }] }), 'reinforce') // DELTA, not cumulative
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
  try {
    const b = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'base64')
    if (b.length === 16) return b
  } catch { /* create below */ }
  const s = newSalt()
  try { fs.writeFileSync(p, s.toString('base64')) } catch { /* best effort */ }
  return s
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
  try { fs.writeFileSync(memPath, out.length ? out.join('\n') + '\n' : '') } catch { /* best effort */ }
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
  // Turning sync OFF: snapshot the current (unioned) memories into the local
  // store so we don't appear to lose everything synced from peers.
  if (!clean && syncDir && legacyPath) {
    try {
      const snap = entries.map(serializeEntry).join('\n')
      fs.writeFileSync(legacyPath, snap ? snap + '\n' : '')
    } catch { /* best effort */ }
  }
  writeSyncConfig(userDataDir, clean)
  initSwarmMemory(userDataDir, { syncDir: clean })
  return getSyncStatus()
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
  if (embeddingsAvailable === false) return null  // forced off / known-dead
  try {
    const emb = await embedText(text, { isQuery })
    if (!emb || emb.length > MAX_EMBEDDING_DIM) {
      embeddingsAvailable = false
      return null
    }
    embeddingsAvailable = true
    return emb
  } catch {
    embeddingsAvailable = false
    return null
  }
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
