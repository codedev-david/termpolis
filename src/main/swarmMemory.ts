import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { recordSwarmError } from './telemetry'
import { embedText, EMBED_DIM } from './localEmbedder'
import { deriveKey, newSalt, encryptLine, decryptLine, isEncryptedLine } from './memoryCrypto'
import { VectorStore } from './vectorStore'

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
  hash?: string                   // content hash for idempotent ingestion dedup
}

export interface MemorySearchResult extends MemoryEntry {
  score: number                   // 0..1, higher is better
}

// Semantic-search window kept hot in memory. The durable JSONL on disk is
// append-only and retains everything written; this only caps how many of the
// most-recent chunks stay loaded for vector/keyword search, to bound RAM.
// Embeddings now live in a packed Float32Array (~1.5 KB/chunk — half the old
// per-entry number[] cost; see vectorStore.ts), so the window can be larger for
// the same memory: 100k chunks is years of real usage. Configurable for tests.
// (A truly-unbounded corpus would want an on-disk HNSW/ANN index — the planned
// next step, for which this packed store is the foundation. Keyword recall
// degrades gracefully regardless.)
const DEFAULT_MAX_ENTRIES = 100_000
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
  let obj: { id?: unknown; content?: unknown; deleted?: unknown; clearedBefore?: unknown }
  try { obj = JSON.parse(plain) } catch { return /* skip malformed line */ }
  if (!obj || typeof obj !== 'object') return
  if (typeof obj.deleted === 'string') { tombstones.add(obj.deleted); return }
  if (typeof obj.clearedBefore === 'number') { if (obj.clearedBefore > clearEpoch) clearEpoch = obj.clearedBefore; return }
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
}

export function initSwarmMemory(userDataPath: string, opts: { syncDir?: string | null } = {}): void {
  if (!userDataPath || typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new Error('initSwarmMemory: absolute userDataPath required')
  }
  const resolved = path.resolve(userDataPath)
  userDataDir = resolved
  legacyPath = path.join(resolved, 'swarm-memory.jsonl')
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
}

export function _resetForTests(): void {
  memPath = null
  userDataDir = null
  legacyPath = null
  deviceId = ''
  syncDir = null
  entries.length = 0
  seenHashes.clear()
  tombstones.clear()
  clearEpoch = 0
  encKey = null
  lockedShards = false
  vectorStore = new VectorStore(EMBED_DIM)
  rowToEntry.clear()
  seq = 0
  maxEntries = DEFAULT_MAX_ENTRIES
  embeddingsAvailable = null
  embedOverride = null
}

export function _setMaxEntriesForTests(n: number): void {
  maxEntries = n
}

/** True if a chunk with this content hash is already stored (idempotent ingest). */
export function memoryHasHash(hash: string): boolean {
  return typeof hash === 'string' && seenHashes.has(hash)
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
  hash?: string
}

export async function memoryWrite(input: WriteInput): Promise<MemoryEntry> {
  if (!input || typeof input.content !== 'string' || !input.content.trim()) {
    throw new Error('memoryWrite: content required')
  }
  const kind = input.kind || 'note'
  const content = input.content.length > MAX_CONTENT
    ? input.content.slice(0, MAX_CONTENT)
    : input.content

  const entry: MemoryEntry = {
    id: `mem-${Date.now()}-${++seq}-${crypto.randomBytes(3).toString('hex')}`,
    ts: Date.now(),
    agentId: input.agentId || 'unknown',
    kind,
    content,
    ...(input.tags && input.tags.length > 0 && { tags: input.tags.slice(0, 20) }),
    ...(input.taskId && { taskId: input.taskId }),
    ...(input.source && { source: input.source }),
    ...(input.hash && { hash: input.hash }),
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
  entries.push(stored)
  if (stored.hash) seenHashes.add(stored.hash)
  if (entries.length > maxEntries) {
    const dropped = entries.shift()
    if (dropped) {
      if (dropped.hash) seenHashes.delete(dropped.hash)
      const r = entryRow.get(dropped)
      if (r !== undefined) rowToEntry.delete(r) // its packed row is now dead
    }
  }
  // Trims leave orphaned vectors behind; rebuild from disk once they pile up.
  if (vectorStore.size - rowToEntry.size > maxEntries) reloadFrom(shardFiles())

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
}

// Rebuild the packed store from the current hot window (after reload/trim/clear).
function rebuildVectorIndex(): void {
  vectorStore = new VectorStore(EMBED_DIM)
  rowToEntry.clear()
  for (const e of entries) indexEntryVector(e)
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
  return true
}

// ---- Search ----

export interface SearchOptions {
  query: string
  limit?: number
  agentId?: string
  kind?: MemoryEntry['kind']
  taskId?: string
}

export async function memorySearch(opts: SearchOptions): Promise<MemorySearchResult[]> {
  if (!opts || typeof opts.query !== 'string' || !opts.query.trim()) return []
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100)

  // Filter pool first — cheap wins
  let pool = entries
  if (opts.agentId) pool = pool.filter(e => e.agentId === opts.agentId)
  if (opts.kind) pool = pool.filter(e => e.kind === opts.kind)
  if (opts.taskId) pool = pool.filter(e => e.taskId === opts.taskId)
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
      const allow = (row: number): boolean => {
        const e = rowToEntry.get(row)
        return e ? passesFilter(e, opts) : false
      }
      for (const h of vectorStore.searchTopK(queryEmb, limit, allow)) {
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

  scored.sort((a, b) => b.score - a.score || b.ts - a.ts)
  return scored.filter(r => r.score > 0).slice(0, limit)
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
  vectorStore = new VectorStore(EMBED_DIM)
  rowToEntry.clear()
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
  tombstones.add(id)
  appendShardLine(JSON.stringify({ deleted: id }), 'delete')
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
  try {
    const k = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'base64')
    return k.length === 32 ? k : null
  } catch { return null }
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
  if (p) { try { fs.writeFileSync(p, key.toString('base64')) } catch { /* best effort */ } }
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
}

export function _setEmbedFnForTests(fn: ((text: string) => Promise<number[] | null>) | null): void {
  embedOverride = fn
}
