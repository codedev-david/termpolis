// transcriptDelta.ts
//
// What a solo-session reflection pass has to find out is small: has the transcript grown since the
// cursor, and if so, by what? It used to find out by reading the WHOLE transcript (up to five files, one
// of them 77.5 MiB), parsing every line and hashing every turn twice, on every pass, on the thread that
// echoes every keystroke. readSessionDelta is told the cursor first and does the least that answers it:
//
//   unchanged   the file still has the size and mtime the cursor recorded: nothing is opened, read or parsed;
//   grown       (Claude Code) only the bytes from the first one not yet consumed are read and parsed, after
//               checking that the 256 bytes before it are still what the cursor saw;
//   anything else (first look, another file, a rewrite, a truncation, a position it cannot trust): the file
//               is read in full, in chunks that yield to the event loop, and diffed against the cursor
//               exactly as the old path did.
//
// Why carrying on from a byte offset says what a whole read would say, for a Claude Code transcript:
//   - it is append-only JSONL and every line is parsed on its own (parseClaudeTranscript keeps state only
//     for fields that never reach a turn's role or text), so the turns of `prefix + suffix` are the turns
//     of the prefix followed by the turns of the suffix;
//   - the one thing that looks at the whole list is ownDialogue (is the session another computer's? does
//     its opening prompt carry a primer to take off?), and it only ever touches turns up to the opening
//     prompt. So the offset is recorded only when the opening is settled (openingSettled): from then on a
//     suffix can neither change that decision nor be touched by it;
//   - the cursor's hash is FNV-1a, which keeps all of its state in the 32 bits it prints, so it carries on
//     over the new turns without the old ones (continueHash);
//   - a last line that is not finished (a writer caught mid-line) is NOT consumed: the offset stops before
//     it, as the whole-file parse skips it too until it is whole. A last line that is complete JSON but has
//     no newline yet IS consumed, as the whole-file parse takes it.
// tests/electron/transcriptDelta.test.ts proves it by comparing, after every step of random sessions, what
// this says with what the old path says.
//
// The position is a hint, never the truth: it is checked (the file is not shorter, the anchor matches) and
// anything that fails the check is a full read. Not caught, by design: a file rewritten in place so that
// its last 256 consumed bytes are byte for byte what they were while an earlier part changed. Claude Code
// does not do that to a transcript, and the cost of it would be a few turns learned late.
//
// Codex and Gemini are never carried on from a byte (a rollout's parser keeps state, a Gemini session is one
// JSON document): they are gated by size and mtime, and read whole when they change, as before.
//
// Everything here is async. Any error is null, which reflectSoloSession answers by reading the whole
// transcript the way it always did. Counters (never content) go to passCounters.

import * as fs from 'fs'
import { sessionDelta, continueHash, type SessionCursor, type TranscriptDelta, type TranscriptPos } from './mnemeSession'
import { listSessionFilesAsync } from './claudeSessionList'
import { newestTranscriptFiles, parseBySource, type ConversationSource } from './conversationIngest'
import { openingSettled, ownDialogue } from '../shared/headlessPrompt'
import { recordPass } from './passCounters'

/** The newest sessions looked at for this computer's own (liveTranscript's MAX_SESSION_CANDIDATES; a test pins them equal). */
export const CANDIDATES = 5
/** Bytes before the offset that tell a file that was appended to from one that was replaced. */
export const ANCHOR_BYTES = 256
/** The most read and parsed at once. 4 MiB of JSONL is ~15 ms of parsing: a slice, not a stall. */
export const CHUNK_BYTES = 4 * 1024 * 1024
/** Delegated sessions remembered (their opening never changes, so neither does the verdict). */
export const DELEGATED_MAX = 256

const SUPPORTED = new Set(['claude', 'codex', 'gemini'])

interface Turn {
  role: 'user' | 'assistant'
  text: string
}

/** The slice of an open file this module uses (a node FileHandle satisfies it). */
export interface DeltaFile {
  stat(): Promise<{ size: number; mtimeMs: number }>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

export interface DeltaFs {
  stat(file: string): Promise<{ size: number; mtimeMs: number }>
  open(file: string): Promise<DeltaFile>
  /** The whole file as UTF-8: for the agents that are not carried on from a byte. */
  readFile(file: string): Promise<string>
}

export interface DeltaDeps {
  /** (cwd, agent) -> the agent's transcript files, newest first. */
  listFiles(cwd: string, agent: string): Promise<string[]>
  fs: DeltaFs
  parse(agent: string, content: string): Array<{ role: 'user' | 'assistant'; text: string }>
  now(): number
  /** Let the event loop run (between chunks of one big read). */
  yieldToLoop(): Promise<void>
  chunkBytes: number
}

export function defaultDeltaDeps(): DeltaDeps {
  return {
    listFiles: (cwd, agent) =>
      agent === 'claude' ? listSessionFilesAsync(cwd, { limit: CANDIDATES }) : newestTranscriptFiles(agent as ConversationSource, CANDIDATES),
    fs: {
      stat: (file) => fs.promises.stat(file),
      open: (file) => fs.promises.open(file, 'r'),
      readFile: (file) => fs.promises.readFile(file, 'utf8'),
    },
    parse: (agent, content) => parseBySource(agent as ConversationSource, content),
    now: () => Date.now(),
    yieldToLoop: () => new Promise<void>((resolve) => setImmediate(resolve)),
    chunkBytes: CHUNK_BYTES,
  }
}

// ---- remembered verdicts ------------------------------------------------------------------------

/**
 * Transcripts that are another computer's, with the size and mtime they had when that was found out. A
 * session's opening prompt is its first lines and does not change, so a delegated session that has not
 * changed since is passed over without being opened. One that HAS changed (still running, or replaced:
 * the path alone proves nothing) is looked at again.
 */
const delegated = new Map<string, { size: number; mtimeMs: number }>()

function markDelegated(file: string, size: number, mtimeMs: number): void {
  delegated.delete(file)
  delegated.set(file, { size, mtimeMs })
  // A Map iterates in insertion order, so the first keys are the least recently judged.
  for (const oldest of delegated.keys()) {
    if (delegated.size <= DELEGATED_MAX) break
    delegated.delete(oldest)
  }
}

/** Test seam. */
export function resetDeltaState(): void {
  delegated.clear()
}

// ---- counters -----------------------------------------------------------------------------------

interface Metrics {
  listed: number
  skipped: number
  stats: number
  opens: number
  reads: number
  bytes: number
  anchorBytes: number
  parsed: number
  unchanged: number
  incremental: number
  full: number
}

const newMetrics = (): Metrics => ({ listed: 0, skipped: 0, stats: 0, opens: 0, reads: 0, bytes: 0, anchorBytes: 0, parsed: 0, unchanged: 0, incremental: 0, full: 0 })

function record(m: Metrics, ms: number): void {
  recordPass('reflect-read', {
    listed: m.listed,
    skipped: m.skipped,
    stats: m.stats,
    opens: m.opens,
    reads: m.reads,
    bytes: m.bytes,
    anchor: m.anchorBytes,
    parsed: m.parsed,
    unchanged: m.unchanged,
    incremental: m.incremental,
    full: m.full,
    ms,
  })
}

// ---- small pieces -------------------------------------------------------------------------------

const EMPTY = Buffer.alloc(0)
const HEX32 = /^[0-9a-f]{1,8}$/

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** A position read back from a cursor file is a hint from the past: use it only if every field is what it should be. */
function validPos(p: unknown): TranscriptPos | null {
  if (!p || typeof p !== 'object') return null
  const o = p as Record<string, unknown>
  if (typeof o.file !== 'string' || o.file === '' || o.file.length > 4096) return null
  if (!isNum(o.size) || !isNum(o.mtimeMs)) return null
  if (o.offset !== undefined) {
    if (!Number.isInteger(o.offset) || !isNum(o.offset) || o.offset > o.size) return null
    if (typeof o.anchor !== 'string' || !HEX32.test(o.anchor)) return null
    if (!Number.isInteger(o.anchorLen) || !isNum(o.anchorLen) || o.anchorLen > ANCHOR_BYTES || o.anchorLen > o.offset) return null
  }
  return o as unknown as TranscriptPos
}

/** FNV-1a over bytes, as the cursor's own hash is over turns. A change detector, not a security hash. */
function fnv(buf: Buffer): string {
  let h = 0x811c9dc5
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** The last ANCHOR_BYTES of `tail` followed by `added` (copied: never keeps a chunk alive). */
function lastBytes(tail: Buffer, added: Buffer): Buffer {
  if (added.length >= ANCHOR_BYTES) return Buffer.from(added.subarray(added.length - ANCHOR_BYTES))
  const merged = Buffer.concat([tail, added])
  return merged.length <= ANCHOR_BYTES ? merged : Buffer.from(merged.subarray(merged.length - ANCHOR_BYTES))
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** Fill `buf[0..length)` from `position`, in as many reads as the file system wants. Fewer bytes only at the end of the file. */
async function readFully(fh: DeltaFile, buf: Buffer, length: number, position: number, m: Metrics, anchor: boolean): Promise<number> {
  let got = 0
  while (got < length) {
    const r = await fh.read(buf, got, length - got, position + got)
    m.reads++
    if (r.bytesRead === 0) break
    got += r.bytesRead
  }
  if (anchor) m.anchorBytes += got
  else m.bytes += got
  return got
}

interface Scan {
  /** The turns of every complete line (and of a last line that is whole JSON but has no newline yet). */
  turns: Turn[]
  /** The byte just past the last line consumed. A last line that is still being written stays after it. */
  consumedEnd: number
  /** The last ANCHOR_BYTES consumed. */
  tail: Buffer
}

function addTurns(out: Turn[], parsed: Array<{ role: 'user' | 'assistant'; text: string }>, m: Metrics): void {
  for (const t of parsed) out.push({ role: t.role, text: t.text })
  m.parsed += parsed.length
}

/**
 * Read bytes [from, to) of a Claude Code transcript a chunk at a time, parse the whole lines in each, and
 * yield to the event loop between chunks. `inspect` sees the turns so far after each chunk and may stop the
 * scan early (a delegated session needs only its head).
 */
async function scanLines(
  fh: DeltaFile,
  agent: string,
  from: number,
  to: number,
  tail0: Buffer,
  deps: DeltaDeps,
  m: Metrics,
  inspect?: (turns: Turn[]) => boolean,
): Promise<Scan> {
  const turns: Turn[] = []
  let at = from
  let carry: Buffer = EMPTY
  let tail = tail0
  while (at < to) {
    const want = Math.min(deps.chunkBytes, to - at)
    const buf = Buffer.allocUnsafe(want)
    const got = await readFully(fh, buf, want, at, m, false)
    if (got === 0) break
    at += got
    const joined = carry.length === 0 ? buf.subarray(0, got) : Buffer.concat([carry, buf.subarray(0, got)])
    const nl = joined.lastIndexOf(0x0a)
    if (nl < 0) {
      carry = joined // a line longer than the chunk: carry on reading it
      continue
    }
    const whole = joined.subarray(0, nl + 1)
    addTurns(turns, deps.parse(agent, whole.toString('utf8')), m)
    tail = lastBytes(tail, whole)
    carry = joined.subarray(nl + 1)
    if (inspect?.(turns)) return { turns, consumedEnd: at - carry.length, tail }
    if (at < to) await deps.yieldToLoop()
  }

  let consumedEnd = at - carry.length
  if (carry.length > 0) {
    const text = carry.toString('utf8')
    const trimmed = text.trim()
    if (trimmed === '') {
      consumedEnd = at
      tail = lastBytes(tail, carry)
    } else if (isJson(trimmed)) {
      addTurns(turns, deps.parse(agent, text), m)
      consumedEnd = at
      tail = lastBytes(tail, carry)
    } // else: a line a writer has not finished. It is read again, whole, next time.
  }
  return { turns, consumedEnd, tail }
}

// ---- the three ways of finding out --------------------------------------------------------------

const DELEGATED = 'delegated' as const

/** Carry on from the byte after the last line consumed. null = do not trust it: the caller reads in full. */
async function incremental(file: string, prev: SessionCursor, pos: TranscriptPos, deps: DeltaDeps, m: Metrics): Promise<TranscriptDelta | null> {
  const offset = pos.offset as number
  const anchorLen = Math.min(ANCHOR_BYTES, offset)
  if (pos.anchorLen !== anchorLen) return null // validPos made sure an anchor is there whenever an offset is

  const fh = await deps.fs.open(file)
  m.opens++
  try {
    const fst = await fh.stat()
    if (fst.size < offset) return null // shorter than what was consumed: not appended to
    const tail0 = Buffer.allocUnsafe(anchorLen)
    if (anchorLen > 0) {
      const got = await readFully(fh, tail0, anchorLen, offset - anchorLen, m, true)
      if (got !== anchorLen || fnv(tail0) !== pos.anchor) return null // not the file that was followed
    }
    const scan = await scanLines(fh, 'claude', offset, fst.size, tail0, deps, m)
    // The opening was settled, so ownDialogue changes none of these: they are exactly what is fresh.
    const hash = continueHash(prev.hash, scan.turns)
    if (hash === null) return null
    m.incremental = 1
    return {
      fresh: scan.turns,
      cursor: {
        count: prev.count + scan.turns.length,
        hash,
        pos: { file, size: fst.size, mtimeMs: fst.mtimeMs, offset: scan.consumedEnd, anchor: fnv(scan.tail), anchorLen: scan.tail.length },
      },
    }
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** Read a Claude Code transcript in full, in chunks, and diff it against the cursor as sessionDelta always did. */
async function fullClaude(file: string, prev: SessionCursor, deps: DeltaDeps, m: Metrics): Promise<TranscriptDelta | typeof DELEGATED> {
  const fh = await deps.fs.open(file)
  m.opens++
  try {
    const fst = await fh.stat()
    let judged = false
    const scan = await scanLines(fh, 'claude', 0, fst.size, EMPTY, deps, m, (turns) => {
      // A delegated session shows itself in its first lines: once the opening prompt is in, judge it
      // (once) and, if it is another computer's, do not read the rest. The opening prompt is within the
      // turns read so far, so ownDialogue of them gives the verdict it would give of all of them.
      if (judged || !openingSettled(turns)) return false
      judged = true
      return ownDialogue(turns) === null
    })
    const own = ownDialogue(scan.turns)
    if (own === null) {
      markDelegated(file, fst.size, fst.mtimeMs)
      return DELEGATED
    }
    m.full = 1
    const { fresh, cursor } = sessionDelta(own, prev)
    // The byte to carry on from is only worth recording once the opening can no longer change.
    cursor.pos = openingSettled(scan.turns)
      ? { file, size: fst.size, mtimeMs: fst.mtimeMs, offset: scan.consumedEnd, anchor: fnv(scan.tail), anchorLen: scan.tail.length }
      : { file, size: fst.size, mtimeMs: fst.mtimeMs }
    return { fresh, cursor }
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** Codex and Gemini: the whole file as UTF-8, once, then gated by size and mtime. */
async function fullWhole(file: string, agent: string, prev: SessionCursor, deps: DeltaDeps, m: Metrics): Promise<TranscriptDelta | typeof DELEGATED> {
  m.stats++
  const st = await deps.fs.stat(file) // BEFORE the read: a line appended in between is seen as a change next time
  const content = await deps.fs.readFile(file)
  m.opens++
  m.reads++
  m.bytes += content.length
  const parsed = deps.parse(agent, content)
  m.parsed += parsed.length
  const own = ownDialogue(parsed.map((t): Turn => ({ role: t.role, text: t.text })))
  if (own === null) {
    markDelegated(file, st.size, st.mtimeMs)
    return DELEGATED
  }
  m.full = 1
  const { fresh, cursor } = sessionDelta(own, prev)
  cursor.pos = { file, size: st.size, mtimeMs: st.mtimeMs }
  return { fresh, cursor }
}

async function examine(
  file: string,
  agent: string,
  prev: SessionCursor,
  known: TranscriptPos | null,
  deps: DeltaDeps,
  m: Metrics,
): Promise<TranscriptDelta | typeof DELEGATED> {
  const pos = known && known.file === file ? known : null
  if (pos) {
    m.stats++
    const st = await deps.fs.stat(file)
    if (st.size === pos.size && st.mtimeMs === pos.mtimeMs) {
      m.unchanged = 1
      return { fresh: [], cursor: prev }
    }
    if (agent === 'claude' && pos.offset !== undefined && st.size >= pos.offset) {
      const grown = await incremental(file, prev, pos, deps, m)
      if (grown) return grown
    }
  }
  return agent === 'claude' ? fullClaude(file, prev, deps, m) : fullWhole(file, agent, prev, deps, m)
}

/**
 * What the transcript holds after `prev`, read as cheaply as is safe: see the top of this file. Resolves to
 * what sessionDelta(<the whole transcript>, prev) would, plus the position to carry on from; null when it
 * cannot say (the caller reads the whole transcript instead). Never rejects.
 */
export async function readSessionDelta(cwd: string, agent: string, prev: SessionCursor, deps: DeltaDeps = defaultDeltaDeps()): Promise<TranscriptDelta | null> {
  if (!cwd || !agent || !SUPPORTED.has(agent)) return null
  const m = newMetrics()
  const started = deps.now()
  try {
    const files = await deps.listFiles(cwd, agent)
    m.listed = files.length
    const known = validPos(prev.pos)
    for (const file of files.slice(0, CANDIDATES)) {
      const verdict = delegated.get(file)
      if (verdict) {
        m.stats++
        const st = await deps.fs.stat(file)
        if (st.size === verdict.size && st.mtimeMs === verdict.mtimeMs) {
          m.skipped++
          continue
        }
        delegated.delete(file) // it changed: it may no longer be what it was
      }
      const found = await examine(file, agent, prev, known, deps, m)
      if (found !== DELEGATED) return found
    }
    // None of its own: what the whole-transcript reader sees, and resets the cursor for.
    return sessionDelta([], prev)
  } catch {
    return null
  } finally {
    record(m, deps.now() - started)
  }
}
