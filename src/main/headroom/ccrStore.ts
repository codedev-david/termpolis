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
// Redemptions of a well-shaped token this store has no record of ever holding. Tokens are content
// hashes, so this space and the space of real tokens are the SAME space: a one-character typo of a
// live token is indistinguishable from a handle the model invented. Counting these as misses is
// what made the "should never happen" alarm fire over four calls that destroyed nothing.
let unknownTokens = 0
// Redemptions of content the disk cap aged out. Real losses, but designed ones: counted apart so
// a full cache cannot masquerade as a defect the user is told to report.
let expiredTokens = 0

/** WHY a token's content is gone, which decides whether anyone should be told to report it. */
export type CcrLossCause =
  /** The 200 MB disk cap aged it out. Designed behaviour for a bounded cache: the content is
   *  really unrecoverable, but nothing is broken and there is nothing to report. */
  | 'expired'
  /** It was never durable and the memory LRU rolled over it, or its file would not read back.
   *  The store destroyed something it had no intention of destroying — the real alarm. */
  | 'evicted'

/**
 * Tokens this store HELD and then destroyed — the only positive evidence that an elision stopped
 * being reversible. Shape cannot supply that evidence and never could; this map can, so the alarm
 * rests on something the store actually witnessed. Persisted beside the entries themselves: a
 * broken promise that healed at the next launch would be worse than no alarm at all.
 */
const forgotten = new Map<string, CcrLossCause>()
const FORGOTTEN_FILE = '_forgotten.json'
/** Bounded so a pathological session cannot grow the file without limit; oldest drop out first. */
const FORGOTTEN_MAX = 4096

/** The last few failed redemptions, with the token that failed. Before this the token was dropped
 *  on the floor and a miss could only be investigated by reconstructing it from agent transcripts. */
export interface CcrFailure { token: string; kind: CcrMissKind }
const RECENT_FAILURES_MAX = 20
const recentFailures: CcrFailure[] = []

function saveForgotten(): void {
  if (!dir) return
  try { writeFileSync(join(dir, FORGOTTEN_FILE), JSON.stringify(Object.fromEntries(forgotten)), 'utf8') } catch { /* best effort */ }
}

function loadForgotten(): void {
  forgotten.clear()
  if (!dir) return
  try {
    const raw = JSON.parse(readFileSync(join(dir, FORGOTTEN_FILE), 'utf8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [t, cause] of Object.entries(raw as Record<string, unknown>)) {
        // An unrecognised cause is read as the milder one. Guessing "defect" from a file this
        // version does not understand would raise exactly the unfounded alarm all this is about.
        if (typeof t === 'string') forgotten.set(t, cause === 'evicted' ? 'evicted' : 'expired')
      }
    }
  } catch { /* none recorded yet */ }
}

/** In-memory half of forget(). Returns whether anything changed, so a batch can flush once. */
function forgetOnly(token: string, cause: CcrLossCause): boolean {
  // 'evicted' is the louder verdict and outranks 'expired' — a token the cap aged out and that
  // later proves corrupt is still a defect, and downgrading it would silence the alarm.
  if (forgotten.get(token) === cause || (forgotten.has(token) && cause === 'expired')) return false
  forgotten.set(token, cause)
  while (forgotten.size > FORGOTTEN_MAX) {
    const oldest = forgotten.keys().next().value
    if (oldest === undefined) break
    forgotten.delete(oldest)
  }
  return true
}

/** Record that a token's content is gone. Idempotent, and durable as soon as a dir is configured. */
function forget(token: string, cause: CcrLossCause): void {
  if (forgetOnly(token, cause)) saveForgotten()
}

/**
 * Tokens the durable tier refused (over the entry cap, non-serializable, or an I/O failure). For
 * these the in-memory record is the ONLY copy in existence, so evicting one turns a reversible
 * elision into a permanent hole. They are pinned: eviction prefers any backed entry over them.
 */
const memoryOnly = new Set<string>()

function memPut(token: string, rec: CcrRecord): void {
  let dirty = false
  if (store.has(token)) store.delete(token) // re-insert at end → LRU
  store.set(token, rec)
  while (store.size > CCR_MAX_ENTRIES) {
    // Oldest entry that still has a disk copy — dropping it costs a slower retrieve, nothing more.
    let victim: string | undefined
    for (const k of store.keys()) { if (!memoryOnly.has(k)) { victim = k; break } }
    // Every resident is unbacked: the cap still wins (an unbounded map is its own outage), but this
    // is the one path that can actually lose content, so it is counted rather than left silent.
    if (victim === undefined) { victim = store.keys().next().value; if (victim !== undefined) { unbackedEvictions++; if (forgetOnly(victim, 'evicted')) dirty = true } }
    if (victim === undefined) break
    store.delete(victim)
    memoryOnly.delete(victim)
  }
  if (dirty) saveForgotten() // once, not once per evicted record
}

function fileFor(token: string): string | null {
  if (!dir || !TOKEN_RE.test(token)) return null
  return join(dir, `${token}.json`)
}

/** Drop oldest-indexed files until the disk tier is back under the byte cap. */
function evictDisk(): void {
  let dirty = false
  if (diskBytes <= diskCapBytes) return
  const bySeq = [...diskIndex.entries()].sort((a, b) => a[1].seq - b[1].seq)
  for (const [token, entry] of bySeq) {
    if (diskBytes <= diskCapBytes) break
    const f = fileFor(token)
    if (f) { try { unlinkSync(f) } catch { /* already gone */ } }
    diskIndex.delete(token)
    diskBytes -= entry.bytes
    // The durable copy is gone. Any resident copy is now the ONLY one, so pin it against the LRU —
    // leaving it unpinned would let the next eviction pass pick it as a cheap, "backed" victim and
    // destroy it silently. With no resident copy the content is already gone.
    if (store.has(token)) memoryOnly.add(token)
    else if (forgetOnly(token, 'expired')) dirty = true
  }
  if (diskBytes < 0) diskBytes = 0
  if (dirty) saveForgotten() // once, not once per evicted entry
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
  // A record with no durable copy is pinned whether the durable tier REFUSED it or does not
  // exist. "Memory-only by configuration" still destroys content when the LRU rolls over, and a
  // null dir is not always configuration: setCcrDir falls back to null on any mkdir/readdir
  // failure, so one transient EPERM at launch would otherwise make a whole session quietly lossy
  // while every counter that is supposed to notice stayed at zero.
  if (diskPut(token, rec)) memoryOnly.delete(token)
  else memoryOnly.add(token)
  memPut(token, rec)
}

function diskGet(token: string): CcrRecord | undefined {
  const f = fileFor(token)
  if (!f || !diskIndex.has(token)) return undefined
  try {
    const rec = JSON.parse(readFileSync(f, 'utf8')) as CcrRecord
    if (!rec || typeof rec !== 'object' || !('value' in rec)) throw new Error('not a record')
    return { value: rec.value, origin: rec.origin === 'proxy' ? 'proxy' : 'mcp' }
  } catch {
    // Indexed but unreadable — truncated by a hard kill mid-write, or corrupted underneath us.
    // Leaving it indexed makes the damage PERMANENT: diskPut short-circuits on `diskIndex.has` for
    // hash tokens, so no future stash of the identical original would ever rewrite the file. Drop
    // the index entry and the file so the next stash heals it, and count what was lost.
    const entry = diskIndex.get(token)
    if (entry) { diskIndex.delete(token); diskBytes -= entry.bytes; if (diskBytes < 0) diskBytes = 0 }
    try { unlinkSync(f) } catch { /* already gone */ }
    if (!store.has(token)) forget(token, 'evicted')
    return undefined
  }
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
    loadForgotten() // before evictDisk below, which may add to it
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

/**
 * Full record (value + issuing layer), memory first then disk. A pure lookup: it counts hits but
 * never judges a failure, because one failed lookup is not yet a failed redemption. The wire proxy
 * commits originals from the CHILD process over parentPort while `retrieve_full` arrives on a
 * loopback socket into MAIN — two queues with no ordering between them — so a caller is entitled
 * to look again before concluding anything. Classification lives in ccrNoteMiss, called once.
 */
export function ccrRetrieveRecord(token: string): CcrRecord | undefined {
  const hit = store.get(token)
  if (hit) { memHits++; memPut(token, hit); return hit } // touch → stays hot
  const fromDisk = diskGet(token)
  if (fromDisk) { diskHits++; memPut(token, fromDisk); return fromDisk }
  return undefined
}

/** What a redemption that resolved nothing actually means. */
export type CcrMissKind =
  /** This store held the content and destroyed it without meaning to. The only real alarm. */
  | 'forgotten'
  /** This store held the content and the disk cap aged it out. Unrecoverable, but working as
   *  designed — the honest response is a bigger cap, not a bug report. */
  | 'expired'
  /** Well-shaped, but no record of ever holding it: a typo of a live token, a handle the model
   *  invented, or a stash that never arrived. Says nothing about content this app removed. */
  | 'unknown'
  /** Not a shape this store can mint, so it cannot name anything we elided. */
  | 'badShape'

/**
 * Classify and count ONE failed redemption.
 *
 * Split from the lookup so a caller may retry without booking a miss per attempt, and so the alarm
 * rests on evidence instead of on the token's shape. Shape can never supply that evidence: tokens
 * ARE content hashes, so every real token and every plausible typo of one live in the same 16-hex
 * space. Treating that space as proof of issuance is what reported four destroyed elisions on an
 * install where the store had never destroyed anything.
 */
export function ccrNoteMiss(token: string): CcrMissKind {
  const cause = forgotten.get(token)
  const kind: CcrMissKind = !ISSUABLE_RE.test(token)
    ? 'badShape'
    : cause === 'evicted'
      ? 'forgotten'
      : cause === 'expired'
        ? 'expired'
        : 'unknown'
  if (kind === 'badShape') badTokens++
  else if (kind === 'forgotten') misses++
  else if (kind === 'expired') expiredTokens++
  else unknownTokens++
  // No timestamp: this module is swept by the cache-safety guard and may not read a clock at
  // all. retrieveFull logs each failure through appLog, which stamps it from outside the sweep.
  recentFailures.push({ token, kind })
  while (recentFailures.length > RECENT_FAILURES_MAX) recentFailures.shift()
  return kind
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
  /** Redemptions of a well-shaped token with no record of ever being held here. Not lost content. */
  unknownTokens: number
  /** Redemptions of content the disk cap aged out. Lost, but by design — not a defect. */
  expiredTokens: number
  /** Tokens known to have been destroyed — what `misses` is measured against. */
  forgottenEntries: number
  /** The last few failed redemptions, token included, so the next one is diagnosable in place. */
  recentFailures: CcrFailure[]
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
  return {
    memEntries: store.size, diskEntries: diskIndex.size, diskBytes, dir, memHits, diskHits, misses,
    badTokens, unknownTokens, expiredTokens, memoryOnlyEntries: memoryOnly.size, unbackedEvictions,
    forgottenEntries: forgotten.size, recentFailures: [...recentFailures],
  }
}

export function resetCcr(): void {
  store.clear(); diskIndex.clear(); redeemed.clear(); diskBytes = 0; seq = 0; fallbackCounter = 0; dir = null
  diskCapBytes = CCR_MAX_BYTES; entryCapBytes = CCR_MAX_ENTRY_BYTES
  memHits = 0; diskHits = 0; misses = 0; badTokens = 0; unknownTokens = 0; expiredTokens = 0; unbackedEvictions = 0
  memoryOnly.clear(); forgotten.clear(); recentFailures.length = 0
}

/** Test-only: shrink the disk caps so eviction is exercisable without writing 200 MB. */
export function _setCcrLimits(maxBytes: number, maxEntryBytes: number): void {
  diskCapBytes = maxBytes
  entryCapBytes = maxEntryBytes
  evictDisk()
}
