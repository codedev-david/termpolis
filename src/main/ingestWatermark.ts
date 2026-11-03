// ingestWatermark.ts
//
// "This transcript was COMPLETELY ingested when it looked like this." One small file in userData remembers,
// per transcript, its size and modified time at the moment the pass that ingested it finished it, so the
// next pass can skip an unchanged file without opening it. Before this, every pass (every 90 s for the
// fast tier, every drain tick for the full tier) re-read and re-parsed whole transcripts, subagent
// transcripts included, to find out that nothing was new: on the main thread, where every keystroke is.
//
// Rules that make a skip safe (a wrong skip loses memory silently, so everything that is not a clean yes
// is a no):
//   - a mark is kept only for a file that was completely ingested: every chunk stored or already known.
//     The caller decides; this module never marks on its own.
//   - the stamp is the size and mtime taken BEFORE the file was read, so a file appended to while it was
//     being read looks changed next pass and is read again.
//   - two tiers: the fast pass emits only sealed chunks (it leaves the trailing partial chunk for later),
//     so its mark ("sealed") does not cover a full pass; a full mark covers both.
//   - a third kind of mark, "delegated": a session another computer started (never ingested). A pass that
//     wants no hashes of such sessions may skip it unread; the pass that feeds the one-time linked-history
//     recheck still reads it, because the recheck needs those hashes.
//   - marks are held in memory and written only at the end of a pass, after the caller has decided they
//     are safe to keep (the store was not locked, the pass was not cut short by quit or by the pause
//     switch). discard() drops them.
//   - a mark is a claim about the MEMORY STORE, and the store can be cleared, restored or re-keyed behind
//     it. So the file also keeps a few PROBES, the first chunk hash of the files marked most recently, and
//     each pass asks the store whether any of them still exist; if none does, clear() drops every mark and
//     the next pass learns everything again (which is what every pass used to do).
//   - the file carries a stamp (format version + app version). Any other stamp, a damaged file, an
//     unreadable file: the store opens EMPTY, which costs one budgeted re-scan, never a wrong skip.
//
// The format is { v, stamp, files: { <path>: [size, mtimeMs, tierBits] }, probes: [hash, ...] },
// tierBits 1 = sealed, 2 = full.

import { promises as fsp } from 'fs'
import { dirname } from 'path'

/**
 * Bump when what a transcript turns into changes on purpose (parsing rules, chunking). The golden hashes
 * in tests/fixtures/ingest-golden.json carry the same number (tests/electron/ingestWatermark.test.ts keeps
 * the two in step); every watermark written under another version is ignored.
 */
export const INGEST_FORMAT_VERSION = 1

/** Where the marks live, in userData. */
export const WATERMARK_FILE = 'ingest-watermark.json'

/** A file larger than this is treated as damaged rather than parsed on the main thread. */
const MAX_FILE_CHARS = 32 * 1024 * 1024

/** How many probes are kept: enough that one deleted memory cannot fake "the store was wiped". */
export const MAX_PROBES = 8
const PROBE_SHAPE = /^[0-9a-f]{8,128}$/

export type MarkTier = 'sealed' | 'full'
/** What a mark vouches for: an ingest tier, or "another computer's session, left out". */
export type MarkKind = MarkTier | 'delegated'

/** What a file looked like when it was read. */
export interface FileStamp {
  size: number
  mtimeMs: number
}

const SEALED = 1
const FULL = 2
/** Another computer's session, known at this size and time. Never combined with an ingest tier. */
const DELEGATED = 4
const TIERS = SEALED | FULL
const bitsOf = (kind: MarkKind): number => (kind === 'full' ? FULL : kind === 'sealed' ? SEALED : DELEGATED)

interface Entry {
  size: number
  mtimeMs: number
  bits: number
}

export interface WatermarkIO {
  /** The file's text, or null when there is none. Throws on any other failure. */
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

export interface IngestWatermark {
  /** True only when `path` was completely ingested at exactly this size and mtime, for this tier or a stronger one. */
  isDone(path: string, stamp: FileStamp, tier: MarkTier): boolean
  /** True only when `path` is known to be another computer's session at exactly this size and mtime. */
  isDelegated(path: string, stamp: FileStamp): boolean
  /**
   * Remember `path` as complete (in memory until flush). A stamp that is not a real size and time is refused.
   * `probe` is the hash of one chunk the store now holds for this file, kept to check the store later.
   */
  markDone(path: string, stamp: FileStamp, kind: MarkKind, probe?: string): void
  /** Write what changed since the last flush. True when a write happened and succeeded. Never throws. */
  flush(): Promise<boolean>
  /** Forget the marks made since the last flush. */
  discard(): void
  /** Forget the files that are not in `listed` (they are gone from disk). Returns how many. */
  forgetMissing(listed: ReadonlySet<string>): number
  /** Forget everything (the store was wiped or replaced); written by the next flush. */
  clear(): void
  /** The chunk hashes to ask the store about before trusting a mark (at most MAX_PROBES, newest last). */
  probes(): string[]
  /** Files known, flushed or not. */
  readonly size: number
  /** Marks made since the last flush. */
  readonly pending: number
}

/** TERMPOLIS_INGEST_FAST=off|0|false|no restores the whole mechanism-free behaviour of 1.54.4 (the kill switch). */
export function ingestFastEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.TERMPOLIS_INGEST_FAST ?? '').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no')
}

const isSize = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/** `older` then `newer`, each hash once (its newest place), the last MAX_PROBES of them. */
function mergeProbes(older: readonly string[], newer: readonly string[]): string[] {
  const out: string[] = []
  for (const h of [...older, ...newer]) {
    const at = out.indexOf(h)
    if (at >= 0) out.splice(at, 1)
    out.push(h)
  }
  return out.slice(-MAX_PROBES)
}

/** What a stored file holds, if it is ours and was written under `stamp`; nothing otherwise. */
function parseStored(text: string | null, stamp: string): { files: Map<string, Entry>; probes: string[] } {
  const files = new Map<string, Entry>()
  const probes: string[] = []
  const nothing = { files, probes }
  if (!text || text.length > MAX_FILE_CHARS) return nothing
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return nothing
  }
  if (!doc || typeof doc !== 'object') return nothing
  const d = doc as { v?: unknown; stamp?: unknown; files?: unknown; probes?: unknown }
  if (d.v !== 1 || d.stamp !== stamp || !d.files || typeof d.files !== 'object' || Array.isArray(d.files)) return nothing
  for (const [path, raw] of Object.entries(d.files as Record<string, unknown>)) {
    if (!Array.isArray(raw) || raw.length !== 3) continue
    const [size, mtimeMs, bits] = raw
    if (!isSize(size) || !isSize(mtimeMs) || (bits !== SEALED && bits !== FULL && bits !== DELEGATED)) continue
    files.set(path, { size, mtimeMs, bits })
  }
  if (Array.isArray(d.probes)) {
    for (const h of d.probes) if (typeof h === 'string' && PROBE_SHAPE.test(h)) probes.push(h)
  }
  return { files, probes: mergeProbes([], probes) }
}

/** Open the store over `io`. Never throws: whatever cannot be read is an empty store. */
export async function openWatermark(io: WatermarkIO, stamp: string): Promise<IngestWatermark> {
  let text: string | null = null
  try {
    text = await io.read()
  } catch {
    text = null
  }
  const stored = parseStored(text, stamp)
  /** What was last written. */
  let flushed = stored.files
  let flushedProbes = stored.probes
  /** Changes since: a path maps to its new entry. */
  let changed = new Map<string, Entry>()
  let changedProbes: string[] = []
  /** The part of `changed` a write is on its way with: still vouched for while it is out. */
  let inflight = new Map<string, Entry>()
  /** Something left the store (a forgotten file, a clear) that the file on disk still lists. */
  let dirty = false
  /** Writes run one at a time, so a mark made during a write is never lost between two snapshots. */
  let writes: Promise<unknown> = Promise.resolve()

  const entryOf = (path: string): Entry | undefined => changed.get(path) ?? inflight.get(path) ?? flushed.get(path)

  const writeOnce = async (): Promise<boolean> => {
    if (changed.size === 0 && changedProbes.length === 0 && !dirty) return false
    const snapshot = changed
    const snapshotProbes = changedProbes
    const wasDirty = dirty
    changed = new Map()
    changedProbes = []
    dirty = false
    inflight = snapshot
    const files: Record<string, [number, number, number]> = {}
    for (const [p, e] of flushed) files[p] = [e.size, e.mtimeMs, e.bits]
    for (const [p, e] of snapshot) files[p] = [e.size, e.mtimeMs, e.bits]
    const probes = mergeProbes(flushedProbes, snapshotProbes)
    try {
      await io.write(JSON.stringify({ v: 1, stamp, files, probes }))
    } catch {
      // Keep the marks, under anything made since: the next flush tries again.
      for (const [p, e] of snapshot) if (!changed.has(p)) changed.set(p, e)
      changedProbes = mergeProbes(snapshotProbes, changedProbes)
      dirty = dirty || wasDirty
      inflight = new Map()
      return false
    }
    for (const [p, e] of snapshot) flushed.set(p, e)
    flushedProbes = probes
    inflight = new Map()
    return true
  }

  return {
    isDone(path, stamp2, tier) {
      const e = entryOf(path)
      // bits are ordered by strength (1 sealed < 2 full), and a stronger mark answers a weaker question.
      return e !== undefined && e.size === stamp2.size && e.mtimeMs === stamp2.mtimeMs && (e.bits & TIERS) >= bitsOf(tier)
    },
    isDelegated(path, stamp2) {
      const e = entryOf(path)
      return e !== undefined && e.size === stamp2.size && e.mtimeMs === stamp2.mtimeMs && (e.bits & DELEGATED) !== 0
    },
    markDone(path, stamp2, kind, probe) {
      if (!isSize(stamp2.size) || !isSize(stamp2.mtimeMs)) return
      if (typeof probe === 'string' && PROBE_SHAPE.test(probe)) changedProbes = mergeProbes(changedProbes, [probe])
      const old = entryOf(path)
      const same = old !== undefined && old.size === stamp2.size && old.mtimeMs === stamp2.mtimeMs
      // The same stamp keeps the stronger tier: a sealed pass after a full one does not take the full mark back.
      // A verdict of the other kind (delegated or not) replaces the old one: a file is one or the other.
      const kindBits = bitsOf(kind)
      const bits = same && kindBits !== DELEGATED && (old.bits & DELEGATED) === 0 ? Math.max(old.bits, kindBits) : kindBits
      if (same && bits === old.bits) return
      changed.set(path, { size: stamp2.size, mtimeMs: stamp2.mtimeMs, bits })
    },
    flush() {
      const run = writes.then(writeOnce, writeOnce)
      writes = run.catch(() => undefined)
      return run
    },
    discard() {
      changed = new Map()
      changedProbes = []
    },
    forgetMissing(listed) {
      let n = 0
      for (const p of [...flushed.keys()]) {
        if (!listed.has(p)) {
          flushed.delete(p)
          changed.delete(p)
          inflight.delete(p)
          dirty = true
          n++
        }
      }
      for (const p of [...changed.keys()]) {
        if (!listed.has(p)) {
          changed.delete(p)
          n++
        }
      }
      return n
    },
    clear() {
      flushed = new Map()
      flushedProbes = []
      changed = new Map()
      changedProbes = []
      inflight = new Map()
      dirty = true
    },
    probes() {
      return mergeProbes(flushedProbes, changedProbes)
    },
    get size() {
      const keys = new Set<string>(flushed.keys())
      for (const p of inflight.keys()) keys.add(p)
      for (const p of changed.keys()) keys.add(p)
      return keys.size
    },
    get pending() {
      return changed.size
    },
  }
}

/** The real file: read as text (null when absent), written through a temp file and a rename, folder created on demand. */
export function fileWatermarkIO(path: string): WatermarkIO {
  return {
    async read() {
      try {
        return await fsp.readFile(path, 'utf8')
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return null
        throw e
      }
    },
    async write(text) {
      await fsp.mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      await fsp.writeFile(tmp, text)
      try {
        await fsp.rename(tmp, path)
      } catch {
        // Windows can refuse a rename onto a file something (a scanner) holds open for a moment.
        try {
          await fsp.writeFile(path, text)
        } finally {
          await fsp.rm(tmp, { force: true }).catch(() => undefined)
        }
      }
    },
  }
}
