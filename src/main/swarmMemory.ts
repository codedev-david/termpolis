import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { recordSwarmError } from './telemetry'
import { embedText } from './localEmbedder'

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
// most-recent chunks stay loaded for vector/keyword search, to bound RAM
// (~3 KB per embedded chunk). 50k chunks is months-to-years of real usage.
// Configurable for tests. (True-unbounded semantic recall over an arbitrarily
// large corpus would need an on-disk ANN index — a deliberate future native-dep
// decision; keyword recall already degrades gracefully.)
const DEFAULT_MAX_ENTRIES = 50_000
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
  let obj: { id?: unknown; content?: unknown; deleted?: unknown; clearedBefore?: unknown }
  try { obj = JSON.parse(s) } catch { return /* skip malformed line */ }
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

  entries.push(entry)
  if (entry.hash) seenHashes.add(entry.hash)
  if (entries.length > maxEntries) {
    const dropped = entries.shift()
    if (dropped?.hash) seenHashes.delete(dropped.hash)
  }

  persist(entry)
  return entry
}

function persist(entry: MemoryEntry): void {
  if (!memPath) return
  try {
    fs.appendFileSync(memPath, JSON.stringify(entry) + '\n')
  } catch (err) {
    // Append failure means this swarm fact never reaches disk — agents
    // will lose context on next launch. Surface it.
    recordSwarmError('swarmMemory.persist.failed', err, { entryId: entry.id })
  }
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
    for (const entry of pool) {
      if (!entry.embedding || entry.embedding.length !== queryEmb.length) continue
      const score = cosineSimilarity(queryEmb, entry.embedding)
      scored.push({ ...entry, score })
    }
    // If we didn't score anything via embeddings (entries were written before
    // the embedder was ready), mix in keyword-only matches as a safety net.
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
  if (!memPath) return
  if (syncDir) {
    // Propagating clear: an epoch tombstone so every device drops everything up
    // to now (truncating the shard would just resurrect from peers on next sync).
    clearEpoch = Date.now()
    try { fs.appendFileSync(memPath, JSON.stringify({ clearedBefore: clearEpoch }) + '\n') } catch { /* best effort */ }
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
    if (removed?.hash) seenHashes.delete(removed.hash)
  }
  tombstones.add(id)
  if (memPath) {
    try { fs.appendFileSync(memPath, JSON.stringify({ deleted: id }) + '\n') } catch { /* best effort */ }
  }
}

// ---- Cross-machine sync control ----

export interface SyncStatus {
  syncing: boolean
  dir: string | null
  deviceId: string
  devices: number // shard files in the sync folder (≈ machines sharing this brain)
  count: number
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
  return { syncing: !!syncDir, dir: syncDir, deviceId, devices, count: entries.length }
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
      const snap = entries.map((e) => JSON.stringify(e)).join('\n')
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
