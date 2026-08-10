import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import * as crypto from 'crypto'

/** Which compression layer issued a token — so its give-back is charged to the right ledger. */
export type CcrOrigin = 'mcp' | 'proxy'
export interface CcrRecord { value: unknown; origin: CcrOrigin }

/**
 * The reversible-compression cache: the escape hatch behind every `retrieve_full` token.
 *
 * v1.34.0 — this used to be a 192-entry, memory-only Map keyed by an incrementing counter.
 * Under real load that evicted a token within SECONDS of issuing it (measured: 2,425
 * retrieve_full calls against a store that could never have held them), and every miss makes
 * the agent re-run the original tool — full token cost paid twice, plus a wasted turn.
 * Aggressive elision is only honest when the escape hatch actually works, so the store is now
 * disk-backed, byte-capped, and survives restarts.
 *
 * Two tiers: a small in-memory map for the hot path, and one JSON file per token under
 * <userData>/headroom/ccr. Disk is the durable tier — a token issued before the last restart
 * still resolves. Eviction is oldest-first via an in-memory index, so the hot path never pays
 * a readdir.
 *
 * Tokens are CONTENT HASHES, not counters. That is a correctness requirement now that entries
 * outlive the process: a counter restarts at 1 on every boot and would resolve to a stale
 * file's contents. Content hashing also means the same result always compresses to the same
 * bytes, which keeps the prompt cache intact.
 *
 * Every disk operation is best-effort — on any I/O failure the store degrades to memory-only
 * rather than throwing into a live tool call.
 */

/** Hot in-memory tier. Small on purpose: disk is what makes retrieval durable. */
export const CCR_MAX_ENTRIES = 512
/** Durable disk tier. Originals are text; 200 MB holds a very long working history. */
export const CCR_MAX_BYTES = 200 * 1024 * 1024
/** An entry larger than this stays memory-only — never worth stalling the hot path over. */
export const CCR_MAX_ENTRY_BYTES = 8 * 1024 * 1024
/** Tokens are ours and always match this; anything else is refused so a token can't walk the path. */
const TOKEN_RE = /^hr_[A-Za-z0-9]+$/

const store = new Map<string, CcrRecord>()
const diskIndex = new Map<string, { bytes: number; seq: number }>()
// Live caps. Constant in production; overridable only by the test hook at the bottom of this file,
// so eviction can be exercised without actually writing 200 MB to a temp directory.
let diskCapBytes = CCR_MAX_BYTES
let entryCapBytes = CCR_MAX_ENTRY_BYTES
let dir: string | null = null
let diskBytes = 0
let seq = 0
let fallbackCounter = 0

function memPut(token: string, rec: CcrRecord): void {
  if (store.has(token)) store.delete(token) // re-insert at end → LRU
  store.set(token, rec)
  while (store.size > CCR_MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

function fileFor(token: string): string | null {
  if (!dir || !TOKEN_RE.test(token)) return null
  return join(dir, `${token}.json`)
}

/** Drop oldest-indexed files until the disk tier is back under the byte cap. */
function evictDisk(): void {
  if (diskBytes <= diskCapBytes) return
  const bySeq = [...diskIndex.entries()].sort((a, b) => a[1].seq - b[1].seq)
  for (const [token, entry] of bySeq) {
    if (diskBytes <= diskCapBytes) break
    const f = fileFor(token)
    if (f) { try { unlinkSync(f) } catch { /* already gone */ } }
    diskIndex.delete(token)
    diskBytes -= entry.bytes
  }
  if (diskBytes < 0) diskBytes = 0
}

function diskPut(token: string, rec: CcrRecord): void {
  const f = fileFor(token)
  if (!f) return
  let payload: string
  try { payload = JSON.stringify(rec) } catch { return } // non-serializable → memory-only
  const bytes = Buffer.byteLength(payload, 'utf8')
  if (bytes > entryCapBytes) return
  try {
    writeFileSync(f, payload, 'utf8')
    const prev = diskIndex.get(token)
    if (prev) diskBytes -= prev.bytes
    diskIndex.set(token, { bytes, seq: ++seq })
    diskBytes += bytes
    evictDisk()
  } catch { /* degrade to memory-only */ }
}

function diskGet(token: string): CcrRecord | undefined {
  const f = fileFor(token)
  if (!f || !diskIndex.has(token)) return undefined
  try {
    const rec = JSON.parse(readFileSync(f, 'utf8')) as CcrRecord
    if (!rec || typeof rec !== 'object' || !('value' in rec)) return undefined
    return { value: rec.value, origin: rec.origin === 'proxy' ? 'proxy' : 'mcp' }
  } catch { return undefined }
}

/**
 * Point the durable tier at <userData>/headroom/ccr and adopt whatever is already there.
 * Existing files are indexed oldest-first by mtime so eviction order survives the restart.
 */
export function setCcrDir(d: string | null): void {
  dir = null; diskIndex.clear(); diskBytes = 0; seq = 0
  if (!d) return
  try {
    mkdirSync(d, { recursive: true })
    const found: Array<{ token: string; bytes: number; mtime: number }> = []
    for (const name of readdirSync(d)) {
      if (!name.endsWith('.json')) continue
      const token = name.slice(0, -5)
      if (!TOKEN_RE.test(token)) continue
      try {
        const st = statSync(join(d, name))
        found.push({ token, bytes: st.size, mtime: st.mtimeMs })
      } catch { /* vanished mid-scan */ }
    }
    found.sort((a, b) => a.mtime - b.mtime)
    dir = d
    for (const f of found) { diskIndex.set(f.token, { bytes: f.bytes, seq: ++seq }); diskBytes += f.bytes }
    evictDisk()
  } catch { dir = null }
}

/** Deterministic content-hash token, so the same original always yields the same token. */
function tokenFor(value: unknown): string {
  try {
    return 'hr_' + crypto.createHash('sha1').update(JSON.stringify(value) ?? 'undefined').digest('hex').slice(0, 16)
  } catch {
    // Circular / non-serializable: still needs a unique handle, but it can't go to disk.
    return `hr_x${(++fallbackCounter).toString(36)}`
  }
}

/** Stash an original and return the token that recovers it. Used by the MCP-tool compressor. */
export function ccrStash(value: unknown, origin: CcrOrigin = 'mcp'): string {
  const token = tokenFor(value)
  const rec: CcrRecord = { value, origin }
  memPut(token, rec)
  diskPut(token, rec)
  return token
}

/** Stash under a caller-provided (already deterministic) token — used by the wire proxy, whose
 *  content-hash tokens must resolve through the same `retrieve_full` tool. */
export function ccrPut(token: string, value: unknown, origin: CcrOrigin = 'proxy'): void {
  const rec: CcrRecord = { value, origin }
  memPut(token, rec)
  diskPut(token, rec)
}

/** Full record (value + issuing layer), memory first then disk. */
export function ccrRetrieveRecord(token: string): CcrRecord | undefined {
  const hit = store.get(token)
  if (hit) { memPut(token, hit); return hit } // touch → stays hot
  const fromDisk = diskGet(token)
  if (fromDisk) { memPut(token, fromDisk); return fromDisk }
  return undefined
}

export function ccrRetrieve(token: string): unknown {
  const rec = ccrRetrieveRecord(token)
  return rec === undefined ? undefined : rec.value
}

/** Test/diagnostic view of the durable tier. */
export function ccrStats(): { memEntries: number; diskEntries: number; diskBytes: number; dir: string | null } {
  return { memEntries: store.size, diskEntries: diskIndex.size, diskBytes, dir }
}

export function resetCcr(): void {
  store.clear(); diskIndex.clear(); diskBytes = 0; seq = 0; fallbackCounter = 0; dir = null
  diskCapBytes = CCR_MAX_BYTES; entryCapBytes = CCR_MAX_ENTRY_BYTES
}

/** Test-only: shrink the disk caps so eviction is exercisable without writing 200 MB. */
export function _setCcrLimits(maxBytes: number, maxEntryBytes: number): void {
  diskCapBytes = maxBytes
  entryCapBytes = maxEntryBytes
  evictDisk()
}
