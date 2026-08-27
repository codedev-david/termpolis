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
/**
 * Ceiling on a single durable entry. Anything larger stays memory-only — and memory-only is the
 * one state in which an elision can become UNRECOVERABLE, because the LRU may drop the only copy.
 * 8 MB was far too low for that consequence: a single large file read or `git diff` clears it, and
 * the loss was silent. 64 MB puts the cap out of reach of anything the wire compressor realistically
 * elides, and whatever still exceeds it is now pinned in memory (see `memoryOnly`) rather than
 * quietly evictable.
 */
export const CCR_MAX_ENTRY_BYTES = 64 * 1024 * 1024
/** Tokens are ours and always match this; anything else is refused so a token can't walk the path. */
const TOKEN_RE = /^hr_[A-Za-z0-9]+$/
/** The content-hash shape specifically — the only token form that PROVES what an indexed file
 *  holds. The fallback (hr_x<counter>) and caller-supplied tokens carry no such guarantee. */
const HASH_TOKEN_RE = /^hr_[0-9a-f]{16}$/
/**
 * The two shapes this store can ever MINT: a 16-hex content hash, or the `hr_x<base36>` fallback
 * used when a value will not serialize. A token outside both shapes was never issued here, so it
 * cannot represent content we removed — it is a typo or a model-invented handle, not a broken
 * promise, and counting it as a miss is what made the "should never happen" banner fire.
 */
const ISSUABLE_RE = /^(?:hr_[0-9a-f]{16}|hr_x[0-9a-z]+)$/

const store = new Map<string, CcrRecord>()
const diskIndex = new Map<string, { bytes: number; seq: number }>()
// Tokens whose give-back has already been billed. A give-back reverses ONE compression event, but
// an agent re-reads a token freely — a retry after a failed turn, a second reference to the same
// result — and billing every redemption made the receipt read pessimistically low.
const redeemed = new Set<string>()
// Live caps. Constant in production; overridable only by the test hook at the bottom of this file,
// so eviction can be exercised without actually writing 200 MB to a temp directory.
let diskCapBytes = CCR_MAX_BYTES
let entryCapBytes = CCR_MAX_ENTRY_BYTES
let dir: string | null = null
let diskBytes = 0
let seq = 0
let fallbackCounter = 0
// Redemption outcomes. A miss is a broken promise — content was elided and the token that was
// supposed to bring it back found nothing. Counting them is what turns "reversible" from a
// design intention into a checkable claim.
let memHits = 0
let diskHits = 0
let misses = 0
// Redemptions refused before any lookup because the token is not a shape we mint. Kept apart from
// `misses` so the alarm above stays a real alarm: a bad token means the agent asked for something
// that never existed, which is a prompting artefact, not lost content.
let badTokens = 0
// Times the LRU had to drop a record with no disk copy behind it. The only way this store can
// actually destroy content, so it is counted instead of being left to inference.
let unbackedEvictions = 0

/**
 * Tokens the durable tier refused (over the entry cap, non-serializable, or an I/O failure). For
 * these the in-memory record is the ONLY copy in existence, so evicting one turns a reversible
 * elision into a permanent hole. They are pinned: eviction prefers any backed entry over them.
 */
const memoryOnly = new Set<string>()

function memPut(token: string, rec: CcrRecord): void {
  if (store.has(token)) store.delete(token) // re-insert at end → LRU
  store.set(token, rec)
  while (store.size > CCR_MAX_ENTRIES) {
    // Oldest entry that still has a disk copy — dropping it costs a slower retrieve, nothing more.
    let victim: string | undefined
    for (const k of store.keys()) { if (!memoryOnly.has(k)) { victim = k; break } }
    // Every resident is unbacked: the cap still wins (an unbounded map is its own outage), but this
    // is the one path that can actually lose content, so it is counted rather than left silent.
    if (victim === undefined) { victim = store.keys().next().value; if (victim !== undefined) unbackedEvictions++ }
    if (victim === undefined) break
    store.delete(victim)
    memoryOnly.delete(victim)
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

/** True once the record is durable on disk; false means the memory copy is the only one left. */
function diskPut(token: string, rec: CcrRecord): boolean {
  const f = fileFor(token)
  if (!f) return false
  // Already on disk, byte-for-byte: a hash token IS the sha1 of the content, so an indexed one
  // cannot name a file holding anything else. Re-stashing what was already there cost 65
  // synchronous writeFileSync calls and ~101 KB per API request on the MAIN thread, and grew with
  // the conversation. Only the hash shape carries that guarantee — the rest must still be written.
  if (diskIndex.has(token) && HASH_TOKEN_RE.test(token)) return true
  let payload: string
  try { payload = JSON.stringify(rec) } catch { return false } // non-serializable → memory-only
  const bytes = Buffer.byteLength(payload, 'utf8')
  if (bytes > entryCapBytes) return false
  try {
    writeFileSync(f, payload, 'utf8')
    const prev = diskIndex.get(token)
    if (prev) diskBytes -= prev.bytes
    diskIndex.set(token, { bytes, seq: ++seq })
    diskBytes += bytes
    evictDisk()
    // evictDisk may have just evicted THIS entry (a single write bigger than the whole cap).
    return diskIndex.has(token)
  } catch { return false /* degrade to memory-only */ }
}

/** Put in both tiers, pinning the memory copy whenever the durable one could not be written. */
function put(token: string, rec: CcrRecord): void {
  // Durability is decided BEFORE the memory insert: memPut's eviction pass reads `memoryOnly`, and
  // an entry not yet marked would look backed and be chosen as its own victim the moment it lands.
  // With no dir configured there is no durable tier to refuse anything — that is a memory-only
  // store by configuration, not a lost promise, so nothing is pinned and nothing is counted.
  if (diskPut(token, rec) || dir === null) memoryOnly.delete(token)
  else memoryOnly.add(token)
  memPut(token, rec)
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
  put(token, rec)
  return token
}

/** Stash under a caller-provided (already deterministic) token — used by the wire proxy, whose
 *  content-hash tokens must resolve through the same `retrieve_full` tool. */
export function ccrPut(token: string, value: unknown, origin: CcrOrigin = 'proxy'): void {
  const rec: CcrRecord = { value, origin }
  put(token, rec)
}

/** Full record (value + issuing layer), memory first then disk. */
export function ccrRetrieveRecord(token: string): CcrRecord | undefined {
  const hit = store.get(token)
  if (hit) { memHits++; memPut(token, hit); return hit } // touch → stays hot
  const fromDisk = diskGet(token)
  if (fromDisk) { diskHits++; memPut(token, fromDisk); return fromDisk }
  // Classified only after both tiers came up empty, so a caller-supplied token that IS resolvable
  // still resolves. A shape we never mint cannot name content we removed.
  if (!ISSUABLE_RE.test(token)) badTokens++
  else misses++
  return undefined
}

/** Whether a token has a shape this store could ever have minted. */
export function ccrIsIssuableToken(token: string): boolean { return ISSUABLE_RE.test(token) }

export function ccrRetrieve(token: string): unknown {
  const rec = ccrRetrieveRecord(token)
  return rec === undefined ? undefined : rec.value
}

/** True the FIRST time a token is redeemed and false ever after, so the give-back that reverses
 *  its compression event is charged exactly once no matter how often the agent re-reads it. */
export function ccrMarkRedeemed(token: string): boolean {
  if (redeemed.has(token)) return false
  redeemed.add(token)
  return true
}

export interface CcrStats {
  memEntries: number
  diskEntries: number
  diskBytes: number
  dir: string | null
  memHits: number
  diskHits: number
  misses: number
  /** Redemptions of a token shape this store never mints — a prompting artefact, not lost content. */
  badTokens: number
  /** Resident records with no disk copy behind them; pinned against LRU eviction. */
  memoryOnlyEntries: number
  /** Pinned records the LRU still had to drop. Non-zero means content really was lost. */
  unbackedEvictions: number
}

/**
 * Test/diagnostic view of the durable tier, plus the only number that can falsify the whole
 * compression scheme: `misses`. Every elision this app makes is a promise that `retrieve_full`
 * can give the bytes back. A miss is that promise broken — content removed from the wire and
 * then unrecoverable — and before this counter existed it was invisible. It should stay at 0.
 */
export function ccrStats(): CcrStats {
  return { memEntries: store.size, diskEntries: diskIndex.size, diskBytes, dir, memHits, diskHits, misses, badTokens, memoryOnlyEntries: memoryOnly.size, unbackedEvictions }
}

export function resetCcr(): void {
  store.clear(); diskIndex.clear(); redeemed.clear(); diskBytes = 0; seq = 0; fallbackCounter = 0; dir = null
  diskCapBytes = CCR_MAX_BYTES; entryCapBytes = CCR_MAX_ENTRY_BYTES
  memHits = 0; diskHits = 0; misses = 0; badTokens = 0; unbackedEvictions = 0
  memoryOnly.clear()
}

/** Test-only: shrink the disk caps so eviction is exercisable without writing 200 MB. */
export function _setCcrLimits(maxBytes: number, maxEntryBytes: number): void {
  diskCapBytes = maxBytes
  entryCapBytes = maxEntryBytes
  evictDisk()
}
