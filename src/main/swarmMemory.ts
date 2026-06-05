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

const MAX_ENTRIES = 10_000         // prevents unbounded growth
const MAX_CONTENT = 16 * 1024      // cap per-entry content size
const MAX_EMBEDDING_DIM = 1024

// ---- State ----
let memPath: string | null = null
const entries: MemoryEntry[] = []
const seenHashes = new Set<string>()  // content hashes present — idempotent ingest guard
let seq = 0
let embeddingsAvailable: boolean | null = null  // cached probe result
let embedOverride: ((text: string) => Promise<number[] | null>) | null = null

// ---- Init / persistence ----

export function initSwarmMemory(userDataPath: string): void {
  if (!userDataPath || typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new Error('initSwarmMemory: absolute userDataPath required')
  }
  const resolved = path.resolve(userDataPath)
  memPath = path.join(resolved, 'swarm-memory.jsonl')
  entries.length = 0
  seenHashes.clear()
  seq = 0
  embeddingsAvailable = null

  // Load existing entries (best effort)
  try {
    if (fs.existsSync(memPath)) {
      const raw = fs.readFileSync(memPath, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as MemoryEntry
          if (entry && entry.id && typeof entry.content === 'string') {
            entries.push(entry)
            if (entry.hash) seenHashes.add(entry.hash)
          }
        } catch { /* skip malformed line */ }
      }
      // Trim if the file grew past the cap between runs
      while (entries.length > MAX_ENTRIES) {
        const dropped = entries.shift()
        if (dropped?.hash) seenHashes.delete(dropped.hash)
      }
    } else {
      fs.writeFileSync(memPath, '')
    }
  } catch (err) {
    // Real failure — disk unwritable, perms broken, etc. memPath -> null
    // means subsequent writes silently disappear, which is data loss for
    // the user's swarm context. Worth surfacing.
    recordSwarmError('swarmMemory.init.failed', err, { memPath })
    memPath = null
  }
}

export function _resetForTests(): void {
  memPath = null
  entries.length = 0
  seenHashes.clear()
  seq = 0
  embeddingsAvailable = null
  embedOverride = null
}

/** True if a chunk with this content hash is already stored (idempotent ingest). */
export function memoryHasHash(hash: string): boolean {
  return typeof hash === 'string' && seenHashes.has(hash)
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
  if (entries.length > MAX_ENTRIES) {
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
  if (memPath) {
    try { fs.writeFileSync(memPath, '') } catch { /* best effort */ }
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
