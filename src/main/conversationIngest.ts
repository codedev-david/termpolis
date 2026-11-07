// Conversation ingestion — turns past AI-agent transcripts into normalized
// turns and dedupable chunks that feed the growing memory/RAG brain.
//
// Each agent persists history in its own shape (research-verified 2026):
//   • Claude Code  ~/.claude/projects/**/*.jsonl      — JSONL, type user/assistant
//   • Codex CLI    ~/.codex/sessions/**/rollout-*.jsonl — JSONL, response_item/message
//   • Gemini CLI   ~/.gemini/tmp/<proj>/chats/session-*.json — single JSON, messages[]
//
// The parsers here are PURE (string in → turns out) so they unit-test without
// fs/model/network. They aggressively strip non-dialogue noise (tool calls,
// reasoning, injected system/developer prompts, slash-command envelopes) so we
// only embed real human/assistant content. Chunking carries provenance + a
// content-derived hash so re-ingesting the same transcript is idempotent.

import * as crypto from 'crypto'
import { promises as fsp } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { performance } from 'perf_hooks'
import { isDelegatedSession, openingSettled, ownDialogue } from '../shared/headlessPrompt'
import type { FileStamp, IngestWatermark, MarkTier } from './ingestWatermark'
import { getIngestRuntime, type IngestRuntime } from './ingestRuntime'
import { skipPassWhileUnavailable } from './memoryFallbackGuard'

export type ConversationSource = 'claude' | 'codex' | 'gemini'

export interface IngestTurn {
  role: 'user' | 'assistant'
  text: string
  ts?: number // epoch ms
  source: ConversationSource
  sessionId?: string
  cwd?: string
}

export interface IngestChunk {
  text: string
  source: ConversationSource
  sessionId?: string
  cwd?: string
  startTs?: number
  endTs?: number
  turnCount: number
  hash: string // sha256 over source+session+text — stable idempotent key
}

const COMMAND_PREFIXES = ['<command-name>', '<command-message>', '<command-args>', '<local-command-']

function isCommandNoise(text: string): boolean {
  const t = text.trimStart()
  return COMMAND_PREFIXES.some((p) => t.startsWith(p))
}

function parseTs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : undefined
}

/** One JSONL line as an object: blank, broken and non-object lines are nothing (never an error). */
function parseJsonLine(line: string): Record<string, unknown> | null {
  const s = line.trim()
  if (!s) return null
  let obj: unknown
  try {
    obj = JSON.parse(s)
  } catch {
    return null
  }
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
}

function* iterJsonl(content: string): Generator<Record<string, unknown>> {
  for (const line of content.split('\n')) {
    const obj = parseJsonLine(line)
    if (obj) yield obj
  }
}

// Join the text-bearing blocks of an Anthropic-style content array, ignoring
// thinking / tool_use / tool_result blocks. Also handles a plain string.
function joinTextBlocks(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
        const t = (b as { text?: unknown }).text
        if (typeof t === 'string') parts.push(t)
      }
    }
    return parts.join('\n').trim()
  }
  return ''
}

// ---- Claude Code: ~/.claude/projects/**/*.jsonl ----
// The parsers below are state machines fed one JSONL object at a time (claudeStep, codexStep), so a pass can
// parse a transcript in time slices and in pieces (ingestConversations) with exactly the code that parses a
// whole string (parseClaudeTranscript, parseCodexRollout). tests/electron/ingestChunkGolden.test.ts compares
// both with a verbatim copy of the v1.54.4 functions over random files: a chunk hash is the idempotency key
// of the whole memory store, so the output must not change by a byte.
interface ClaudeState {
  sessionId: string | undefined
  cwd: string | undefined
  turns: IngestTurn[]
}

const newClaudeState = (): ClaudeState => ({ sessionId: undefined, cwd: undefined, turns: [] })

function claudeStep(st: ClaudeState, obj: Record<string, unknown>): void {
  if (!st.sessionId && typeof obj.sessionId === 'string') st.sessionId = obj.sessionId
  // F32: track cwd PER-TURN (update on every occurrence, not first-wins) so a session that
  // moves between repos (/add-dir, resume) tags each turn with the cwd it actually ran under.
  if (typeof obj.cwd === 'string' && obj.cwd) st.cwd = obj.cwd
  if (obj.isMeta === true) return

  const ts = parseTs(obj.timestamp)
  const message = obj.message
  if (!message || typeof message !== 'object') return

  if (obj.type === 'user') {
    const m = message as { role?: string; content?: unknown }
    if (m.role !== 'user' && m.role !== undefined) return
    // Wave2 (claude-array-content): a user turn can be an ARRAY (image/attachment + text
    // blocks), not just a plain string. Extract the text blocks (joinTextBlocks ignores
    // tool_result/thinking) instead of dropping the whole turn — a pure tool_result array
    // yields no text and is still skipped.
    const text = typeof m.content === 'string' ? m.content.trim() : joinTextBlocks(m.content)
    if (!text || isCommandNoise(text)) return
    st.turns.push({ role: 'user', text, ts, source: 'claude', sessionId: st.sessionId, cwd: st.cwd })
  } else if (obj.type === 'assistant') {
    const m = message as { content?: unknown }
    const text = joinTextBlocks(m.content)
    if (text) st.turns.push({ role: 'assistant', text, ts, source: 'claude', sessionId: st.sessionId, cwd: st.cwd })
  }
}

export function parseClaudeTranscript(content: string): IngestTurn[] {
  const st = newClaudeState()
  for (const obj of iterJsonl(content)) claudeStep(st, obj)
  return st.turns
}

// ---- OpenAI Codex CLI: ~/.codex/sessions/**/rollout-*.jsonl ----
function joinCodexText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
        parts.push((b as { text: string }).text)
      }
    }
    return parts.join('\n').trim()
  }
  return ''
}

interface CodexState {
  sessionId: string | undefined
  cwd: string | undefined
  sawFirstUser: boolean
  turns: IngestTurn[]
}

const newCodexState = (): CodexState => ({ sessionId: undefined, cwd: undefined, sawFirstUser: false, turns: [] })

function codexStep(st: CodexState, obj: Record<string, unknown>): void {
  const ts = parseTs(obj.timestamp)
  if (obj.type === 'session_meta') {
    const p = obj.payload as { id?: unknown; cwd?: unknown } | undefined
    if (p) {
      if (typeof p.id === 'string') st.sessionId = p.id
      if (typeof p.cwd === 'string') st.cwd = p.cwd
    }
    return
  }
  if (obj.type !== 'response_item') return
  const payload = obj.payload as { type?: string; role?: string; content?: unknown } | undefined
  if (!payload || payload.type !== 'message') return
  // Drop injected 'developer' harness instructions — not dialogue.
  if (payload.role !== 'user' && payload.role !== 'assistant') return

  const text = joinCodexText(payload.content)
  if (!text) return

  if (payload.role === 'user') {
    // The first user item is a synthetic <environment_context> preamble.
    if (!st.sawFirstUser && text.startsWith('<environment_context>')) {
      st.sawFirstUser = true
      return
    }
    st.sawFirstUser = true
  }
  st.turns.push({ role: payload.role, text, ts, source: 'codex', sessionId: st.sessionId, cwd: st.cwd })
}

export function parseCodexRollout(content: string): IngestTurn[] {
  const st = newCodexState()
  for (const obj of iterJsonl(content)) codexStep(st, obj)
  return st.turns
}

// ---- Gemini CLI: ~/.gemini/tmp/<proj>/chats/session-*.json ----
function joinGeminiContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (typeof b === 'string') parts.push(b)
      else if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
        parts.push((b as { text: string }).text)
      }
    }
    return parts.join('\n').trim()
  }
  return ''
}

// F20: Gemini transcripts carry no cwd inline, so every Gemini memory was permanently
// project-unscoped. Recover it from an explicit field if present, else from the on-disk
// layout `<root>/.gemini/tmp/<proj>/chats/session-*.json` (the <proj> dir is the scope).
function geminiCwd(obj: { cwd?: unknown; projectPath?: unknown }, filePath?: string): string | undefined {
  if (typeof obj.cwd === 'string' && obj.cwd) return obj.cwd
  if (typeof obj.projectPath === 'string' && obj.projectPath) return obj.projectPath
  if (filePath) {
    const parts = filePath.replace(/\\/g, '/').split('/')
    const ci = parts.lastIndexOf('chats')
    if (ci > 0) return parts.slice(0, ci).join('/') // .../tmp/<proj>
  }
  return undefined
}

export function parseGeminiSession(content: string, filePath?: string): IngestTurn[] {
  let obj: { sessionId?: unknown; messages?: unknown; cwd?: unknown; projectPath?: unknown }
  try {
    obj = JSON.parse(content)
  } catch {
    return []
  }
  if (!obj || !Array.isArray(obj.messages)) return []
  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : undefined
  const cwd = geminiCwd(obj, filePath)

  const turns: IngestTurn[] = []
  for (const m of obj.messages) {
    if (!m || typeof m !== 'object') continue
    const type = (m as { type?: unknown }).type
    const role = type === 'user' ? 'user' : type === 'gemini' ? 'assistant' : null
    if (!role) continue
    const text = joinGeminiContent((m as { content?: unknown }).content)
    if (!text) continue
    turns.push({ role, text, ts: parseTs((m as { timestamp?: unknown }).timestamp), source: 'gemini', sessionId, cwd })
  }
  return turns
}

// ---- Chunking ----
export interface ChunkOptions {
  /** Max characters per chunk (~4 chars/token; 2000 ≈ 500 tokens, the bge window). */
  maxChars?: number
  /** F16: emit ONLY sealed (full) chunks — drop the not-yet-full trailing chunk. Set on the
   *  incremental/active-session pass so a growing tail doesn't deposit a new superset dup each run. */
  sealedOnly?: boolean
}

function makeChunk(turns: IngestTurn[], text: string): IngestChunk {
  const source = turns[0].source
  const sessionId = turns[0].sessionId
  const cwd = turns[0].cwd
  const tsList = turns.map((t) => t.ts).filter((n): n is number => typeof n === 'number')
  const hash = crypto
    .createHash('sha256')
    .update(`${source}${sessionId ?? ''}${text}`)
    .digest('hex')
  return {
    text,
    source,
    sessionId,
    cwd,
    startTs: tsList.length ? tsList[0] : undefined,
    endTs: tsList.length ? tsList[tsList.length - 1] : undefined,
    turnCount: turns.length,
    hash,
  }
}

/** Characters per chunk when nobody says otherwise (~500 tokens, the bge window). */
const DEFAULT_MAX_CHARS = 2000

// Greedily pack turns into ~maxChars chunks; a single oversized turn is
// windowed into multiple chunks so nothing exceeds the embedding window.
//
// A generator, so a pass can build (and hash) a long session's chunks in time slices; chunkTurns is the
// whole list. The cut points are the contract (they decide every chunk hash): do not change them without
// bumping INGEST_FORMAT_VERSION and the golden fixture.
export function* chunkTurnsIter(turns: IngestTurn[], opts: ChunkOptions = {}): Generator<IngestChunk> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  let buf: { turn: IngestTurn; line: string }[] = []
  let len = 0

  /** The chunk the buffer makes (none when it is empty or blank); the buffer is emptied either way. */
  const take = (): IngestChunk | null => {
    if (buf.length === 0) return null
    const text = buf.map((b) => b.line).join('\n\n').trim()
    const chunk = text ? makeChunk(buf.map((b) => b.turn), text) : null
    buf = []
    len = 0
    return chunk
  }

  for (const t of turns) {
    const line = `${t.role}: ${t.text}`.trim()
    if (!line) continue
    // F32: a chunk carries ONE cwd (makeChunk stamps turns[0].cwd on all its turns), so split
    // on a cwd change — otherwise a session that moves between repos mis-tags the later repo's
    // work with the first repo's project (and loses it from the true project's recall).
    if (buf.length > 0 && buf[0].turn.cwd !== t.cwd) {
      const c = take()
      if (c) yield c
    }
    if (line.length > maxChars) {
      const c = take()
      if (c) yield c
      for (let i = 0; i < line.length; i += maxChars) {
        yield makeChunk([t], line.slice(i, i + maxChars))
      }
      continue
    }
    if (len > 0 && len + line.length + 2 > maxChars) {
      const c = take()
      if (c) yield c
    }
    buf.push({ turn: t, line })
    len += line.length + 2
  }
  // F16: only sealed (full) chunks are stable across passes. On an incremental pass over the
  // ACTIVE session, skip the trailing partial — it grows by one turn each pass and would
  // deposit a new strict-superset duplicate every ~90s (and, since ts is now conversation
  // time, they'd all rank as freshest). The tail is captured once it fills, or by the full pass.
  if (!opts.sealedOnly) {
    const c = take()
    if (c) yield c
  }
}

export function chunkTurns(turns: IngestTurn[], opts: ChunkOptions = {}): IngestChunk[] {
  return [...chunkTurnsIter(turns, opts)]
}

// ---- Orchestration ----

/** Why a truncated pass stopped: its chunk cap, its byte budget, or a stop (the app is quitting, the pause switch, or the
 *  memory store is unavailable: MEM-F6). */
export type IngestStop = 'chunks' | 'bytes' | 'stopped'

export interface IngestStats {
  filesScanned: number
  chunksWritten: number
  chunksSkipped: number // already present (content-hash dedup)
  truncated: boolean    // a cap, the byte budget or a stop halted this pass early — backlog remains for the next run
  /** Sessions another computer started over Linked machines, left out. Absent when there were none. */
  delegatedSkipped?: number
  /** Changed files a drain pass left for the next episode because this episode already read them (MEM-F1). Absent when none. */
  episodeSkipped?: number
  /** Files passed over untouched because the watermark says they were completely ingested at this size and time. Present when a watermark was given. */
  unchanged?: number
  /** Files this pass vouched for (marked complete, or known to be another computer's). A pass that stopped at its byte budget without marking one got nowhere. Present when a watermark was given. */
  marked?: number
  /** Bytes the pass spent: the size of every file it read (the characters read, for one whose size is unknown). Present when the pass looks at file sizes. */
  bytesRead?: number
  /** Why a truncated pass stopped. */
  stop?: IngestStop
}

/** The counters of one pass, handed to IngestDeps.onPass: numbers only, never a path or a word of a transcript. */
export interface PassMetrics {
  /** Files read and parsed. */
  files: number
  /** Files skipped unread (watermark). */
  unchanged: number
  /** Bytes spent (see IngestStats.bytesRead). */
  bytes: number
  /** Chunks built and hashed. */
  hashed: number
  /** Chunks the store already had. */
  known: number
  /** Chunks written. */
  written: number
  /** Milliseconds of synchronous work (parse, chunk, hash) in the pass, summed over its slices. */
  parseMsSum: number
  /** The longest single synchronous slice, in milliseconds: the thing the typing path feels. */
  parseMsMax: number
  truncated: boolean
  stop?: IngestStop
  /** The whole pass, in milliseconds, waits included. */
  ms: number
  /** Which follow-up of a drain this was (0 when it was not one). */
  drainPass: number
}

// A macrotask yield. Embedding is CPU-heavy and runs in-process on the main
// thread; without this, a tight write-loop over a large history starves the
// libuv event loop so renderer→main IPC never gets serviced and the whole app
// freezes. `setImmediate` returns control to the loop (poll phase → IPC) between
// embeds, turning a multi-minute freeze into a responsive background trickle.
const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Which of these chunk hashes are already stored — resolved ONCE, up front, so the ingest loop can
 * ask a synchronous question about an out-of-process store.
 *
 * Degrades toward the EMPTY set, never toward "everything is known". An empty set means every chunk
 * is offered to the store again, and the store dedups by content hash anyway — so the cost of being
 * wrong here is wasted work. The opposite error (a truthy Promise, "everything is known") silently
 * stops ingestion dead and nothing upstream can tell.
 */
export async function knownHashes(
  deps: Pick<IngestDeps, 'hasHash' | 'hasHashes'>,
  hashes: string[],
): Promise<Set<string>> {
  if (deps.hasHashes) {
    try {
      return new Set(await deps.hasHashes(hashes))
    } catch {
      return new Set() // re-offer the chunks; the store's own hash dedup is the backstop
    }
  }
  const out = new Set<string>()
  if (!deps.hasHash) return out
  for (const h of hashes) {
    try { if (deps.hasHash(h)) out.add(h) } catch { /* treat as unknown */ }
  }
  return out
}

export interface IngestDeps {
  listFiles: (source: ConversationSource) => Promise<string[]>
  readFile: (filePath: string) => Promise<string>
  /** Per-chunk membership. SYNC on purpose — it is consumed as `if (deps.hasHash(h))`, and a Promise
   *  is truthy, so an async predicate here reports EVERY chunk as already-stored and ingestion
   *  silently writes nothing. With the store out of process, wire `hasHashes` instead. */
  hasHash?: (hash: string) => boolean
  /** v1.26: batched membership, asked once per FILE. The store lives in a utilityProcess now, so a
   *  per-chunk round trip would be tens of thousands of RPCs per pass. Returns the subset of
   *  `hashes` already stored. Takes precedence over hasHash when both are given. */
  hasHashes?: (hashes: string[]) => Promise<string[]> | string[]
  write: (chunk: IngestChunk) => Promise<void>
  /** Called with already-stored chunks that have a cwd, so legacy entries
   *  (written before project tagging existed) can be backfilled in the store. */
  patchProjects?: (patches: Array<{ hash: string; project: string }>) => void
  sources?: ConversationSource[]
  chunkOptions?: ChunkOptions
  /** Awaited between embeds so a bulk pass can't freeze the UI. Default: a setImmediate macrotask. */
  yield?: () => Promise<void>
  /** Yield after this many writes (default 1 — breathe after every embed). */
  yieldEvery?: number
  /** Stop after writing this many new chunks this pass; sets `truncated` (default: unbounded). */
  maxChunks?: number
  /** Asked before each file. True ends the pass there: the app is quitting, and a read already
   *  under way is one more request its exit has to wait out. */
  stopped?: () => boolean
  /** Told the chunk hashes a delegated session would have had, for the one-time pass that finds
   *  the ones an earlier version stored (linkedHistoryRecheck). A pass that gives none wants no
   *  such hashes, so with a watermark it passes over a delegated session already known (unread). */
  onDelegated?: (hashes: string[]) => void

  // ---- P4: everything below is optional, and with none of it given a pass is exactly what it was in 1.54.4 ----

  /** Size and mtime of a file, null when unknown (such a file is always processed). */
  statFile?: (filePath: string) => Promise<FileStamp | null>
  /** The persisted per-file watermark. With it, a file whose stamp (taken before it was read) matches a mark is skipped unread. */
  watermark?: IngestWatermark
  /** Stop before the next file once this many bytes were spent (a file is never cut: one that crosses the budget ends the pass). */
  maxBytes?: number
  /** Monotonic clock in ms (default: performance.now). */
  now?: () => number
  /** Longest synchronous stretch of parsing and chunking, in ms. When set, a pass yields to the event loop between slices
   *  and asks stopped() and quiet() at every slice boundary. */
  sliceMs?: number
  /** Resolves when background work may go ahead (the user is not typing). Asked before every file that needs reading, and at slice boundaries. */
  quiet?: () => Promise<unknown>
  /** The file's text in pieces, instead of readFile (so a very large transcript is never one read, one string and one parse). */
  readText?: (filePath: string) => AsyncIterable<string>
  /** The first bytes of a file: enough to tell whether a subagent's PARENT session was started by another computer, without reading it whole. */
  readHead?: (filePath: string, maxBytes: number) => Promise<{ text: string; eof: boolean }>
  /** Asked once at the end of the pass: false (or a throw) means the marks it made must not be kept (the store was locked). */
  canMark?: () => Promise<boolean>
  /** The listing was every transcript there is (all sources, no freshness filter): files missing from it leave the watermark. */
  fullListing?: boolean
  /** Told the counters of the pass, once, however it ended. */
  onPass?: (metrics: PassMetrics) => void
  /** Which follow-up of a drain this pass is (reported back in PassMetrics). */
  drainPass?: number
  /** v1.54.5 (MEM-F1): the files this drain episode has read (the pass that started it, and every drain pass since).
   *  A DRAIN pass passes over a file in it, and every pass adds the files it read whole. An agent's transcript that is
   *  still growing changes between two drain passes; read again each time, a big one took the whole byte budget, was
   *  marked (progress), asked for one more pass and starved every file behind it, every 3 s for as long as the agent
   *  worked. Without it (the kill switch TERMPOLIS_INGEST_FAST=off, tests) every pass reads every changed file. */
  episode?: Set<string>
}

// Sources with stable, documented on-disk transcripts.
export const DISK_SOURCES: ConversationSource[] = ['claude', 'codex', 'gemini']

export function parseBySource(source: ConversationSource, content: string, filePath?: string): IngestTurn[] {
  switch (source) {
    case 'claude':
      return parseClaudeTranscript(content)
    case 'codex':
      return parseCodexRollout(content)
    case 'gemini':
      return parseGeminiSession(content, filePath) // F20: derive cwd from the on-disk path
    default:
      return []
  }
}

/** The session file a Claude Code subagent's transcript belongs to: Claude keeps one at
 *  `<sid>/subagents/agent-*.jsonl`, beside its session's `<sid>.jsonl`. Null for any other file. */
export function parentSessionFile(source: ConversationSource, filePath: string): string | null {
  if (source !== 'claude') return null
  const dir = dirname(filePath)
  return basename(dir) === 'subagents' ? `${dirname(dir)}.jsonl` : null
}

/** The head of a subagent's parent session that settles whether another computer started it. Far less than the file. */
export const PARENT_HEAD_BYTES = 256 * 1024

/** Hashes per question when checking that the store kept what a pass wrote (the store answers at most 5,000 at a time). */
const VERIFY_BATCH = 4000

/** The tier a pass's marks are kept under: null when its chunking is not the default (a mark would vouch for another cut). */
function markTier(o?: ChunkOptions): MarkTier | null {
  if (o?.maxChars !== undefined && o.maxChars !== DEFAULT_MAX_CHARS) return null
  return o?.sealedOnly ? 'sealed' : 'full'
}

async function* singlePiece(text: string): AsyncGenerator<string> {
  yield text
}

/** The head's text up to its last complete line (all of it when it reaches the end of the file). */
function completeLines(head: { text: string; eof: boolean }): string {
  if (head.eof) return head.text
  const nl = head.text.lastIndexOf('\n')
  return nl < 0 ? '' : head.text.slice(0, nl + 1)
}

// Read every transcript, chunk it, and write new (unseen) chunks. Idempotent:
// chunks whose content hash is already stored are skipped, so re-running over a
// growing set of transcripts only embeds genuinely new content. Tolerant of
// unreadable files / sources — one failure never aborts the run.
//
// P4 (all of it through optional deps): a file the watermark vouches for is not opened; a pass spends at
// most a byte budget; the synchronous parse and hash work is cut into time slices with the event loop (and
// the keyboard) served between them; the user typing holds a pass back. Chunks, hashes and what is written
// are the same as ever.
export async function ingestConversations(deps: IngestDeps): Promise<IngestStats> {
  const sources = deps.sources ?? DISK_SOURCES
  const doYield = deps.yield ?? yieldToEventLoop
  const yieldEvery = Math.max(1, deps.yieldEvery ?? 1)
  const maxChunks = deps.maxChunks ?? Infinity
  const maxBytes = deps.maxBytes ?? Infinity
  const now = deps.now ?? ((): number => performance.now())
  const sliceMs = deps.sliceMs
  const wm = deps.watermark
  const tier = markTier(deps.chunkOptions)
  const wantStat = wm !== undefined || Number.isFinite(maxBytes)
  const stats: IngestStats = { filesScanned: 0, chunksWritten: 0, chunksSkipped: 0, truncated: false }
  const metrics: PassMetrics = { files: 0, unchanged: 0, bytes: 0, hashed: 0, known: 0, written: 0, parseMsSum: 0, parseMsMax: 0, truncated: false, ms: 0, drainPass: deps.drainPass ?? 0 }
  const startedAt = now()
  let sinceYield = 0
  let bytesRead = 0
  let marked = 0
  const listed: Set<string> | null = wm && deps.fullListing ? new Set<string>() : null
  let listingComplete = true

  const stopWith = (reason: IngestStop): void => {
    stats.truncated = true
    stats.stop = reason
  }

  // SYNCHRONOUS STRETCHES. A stretch is the time the thread was held since the last genuine await (I/O, the
  // store, a yield). `sliceStart` marks where it began and is reset ONLY after such an await: running from
  // parsing straight into chunking with no event-loop turn between them is one stretch, not two. Every
  // genuine await in the per-file pipeline goes through io(), which closes the stretch (it is counted in the
  // pass counters: the longest one is what the keyboard feels) and starts the next when the await returns.
  let sliceStart = now()
  const resume = (): void => {
    sliceStart = now()
  }
  const account = (): void => {
    const d = now() - sliceStart
    metrics.parseMsSum += d
    if (d > metrics.parseMsMax) metrics.parseMsMax = d
  }
  const io = async <T>(call: () => PromiseLike<T> | T): Promise<T> => {
    account()
    const result = await call()
    resume()
    return result
  }
  /** The stretch has used its slice. */
  const due = (): boolean => sliceMs !== undefined && now() - sliceStart >= sliceMs

  // The user typing holds work back; asked before a file is read and between slices. Fails open.
  const waitQuiet = async (): Promise<void> => {
    if (!deps.quiet) return
    try {
      await io(() => (deps.quiet as () => Promise<unknown>)())
    } catch {
      /* the work goes ahead */
    }
  }

  /** Let the event loop (the keyboard) in. false: the pass was stopped while it did. */
  const boundary = async (): Promise<boolean> => {
    await io(() => doYield())
    if (deps.stopped?.()) return false
    await waitQuiet()
    if (deps.stopped?.()) return false
    return true
  }

  // Per session file, whether another computer started it: asked once a pass however many
  // subagents it ran, and false for one that can't be read -- there is no telling then.
  const delegatedParents = new Map<string, Promise<boolean>>()
  const decideParent = async (parent: string): Promise<boolean> => {
    const whole = (): Promise<boolean> => deps.readFile(parent).then((text) => isDelegatedSession(parseClaudeTranscript(text)), () => false)
    if (!deps.readHead) return whole()
    let head: { text: string; eof: boolean }
    try {
      head = await deps.readHead(parent, PARENT_HEAD_BYTES)
    } catch {
      return false
    }
    // A session's opening decides it, and that is the head of the file: the turns of its complete lines are a
    // prefix of the turns the whole file has. Only while nothing settles it yet is the whole file read.
    const turns = parseClaudeTranscript(completeLines(head))
    if (head.eof || openingSettled(turns)) return isDelegatedSession(turns)
    return whole()
  }
  const parentDelegated = (parent: string): Promise<boolean> => {
    let known = delegatedParents.get(parent)
    if (!known) {
      known = decideParent(parent)
      delegatedParents.set(parent, known)
    }
    return known
  }

  // Skipped-but-cwd-bearing chunks → project backfill for legacy entries.
  const pendingPatches: Array<{ hash: string; project: string }> = []
  const flushPatches = (): void => {
    if (pendingPatches.length === 0 || !deps.patchProjects) return
    try { deps.patchProjects(pendingPatches.splice(0)) } catch { /* best-effort */ }
  }

  /** The turns of one file, parsed line by line from its pieces; null when the pass was stopped meanwhile. */
  const parseStream = async (
    source: ConversationSource,
    filePath: string,
    pieces: AsyncIterable<string>,
    count: (chars: number) => void,
    /** The pieces come from real reads (each fetch is a genuine await). In-memory text is not: fetching it must not reset the slice clock. */
    fromDisk: boolean,
  ): Promise<IngestTurn[] | null> => {
    const it = pieces[Symbol.asyncIterator]()
    const next = (): Promise<IteratorResult<string>> => (fromDisk ? io(() => it.next()) : it.next())
    try {
      if (source !== 'claude' && source !== 'codex') {
        // One JSON document (Gemini): nothing to slice, it is one parse.
        let text = ''
        for (;;) {
          const r = await next()
          if (r.done) break
          text += r.value
          count(r.value.length)
        }
        return parseBySource(source, text, filePath)
      }
      const st = source === 'claude' ? newClaudeState() : newCodexState()
      const handle = (line: string): void => {
        const obj = parseJsonLine(line)
        if (!obj) return
        if (source === 'claude') claudeStep(st as ClaudeState, obj)
        else codexStep(st as CodexState, obj)
      }
      // The pieces of a line whose end has not come yet, joined once when it does (a multi-MB tool result is ONE line).
      let pending: string[] = []
      for (;;) {
        const r = await next()
        if (r.done) break
        const piece = r.value
        count(piece.length)
        let pos = 0
        for (;;) {
          const nl = piece.indexOf('\n', pos)
          if (nl < 0) break
          let line: string
          if (pending.length > 0) {
            pending.push(piece.slice(pos, nl))
            line = pending.join('')
            pending = []
          } else {
            line = piece.slice(pos, nl)
          }
          pos = nl + 1
          handle(line)
          if (due() && !(await boundary())) return null
        }
        if (pos < piece.length) pending.push(pos === 0 ? piece : piece.slice(pos))
      }
      if (pending.length > 0) handle(pending.join(''))
      return st.turns
    } finally {
      // Closes the file when the pass stops early or fails; a no-op after the last piece.
      await it.return?.()
    }
  }

  /** The parsed turns of a file and what reading it cost; 'stopped'; or null when it cannot be read. */
  const readParsed = async (
    source: ConversationSource,
    filePath: string,
    stamp: FileStamp | null,
  ): Promise<{ turns: IngestTurn[]; spent: number } | 'stopped' | null> => {
    let chars = 0
    try {
      if (!deps.readText && sliceMs === undefined) {
        const content = await io(() => deps.readFile(filePath))
        const turns = parseBySource(source, content, filePath)
        return { turns, spent: stamp ? stamp.size : content.length }
      }
      const pieces = deps.readText ? deps.readText(filePath) : singlePiece(await io(() => deps.readFile(filePath)))
      const turns = await parseStream(source, filePath, pieces, (n) => { chars += n }, deps.readText !== undefined)
      return turns === null ? 'stopped' : { turns, spent: stamp ? stamp.size : chars }
    } catch {
      return null
    }
  }

  /** The chunks of `turns`, built (and hashed) in slices; null when the pass was stopped meanwhile. */
  const buildChunks = async (turns: IngestTurn[]): Promise<IngestChunk[] | null> => {
    if (sliceMs === undefined) return chunkTurns(turns, deps.chunkOptions)
    const out: IngestChunk[] = []
    for (const chunk of chunkTurnsIter(turns, deps.chunkOptions)) {
      out.push(chunk)
      if (due() && !(await boundary())) return null
    }
    return out
  }

  /**
   * A mark is a claim about the memory store, and the store can be cleared, restored or re-keyed behind it.
   * So before a pass trusts any mark it asks the store about the probes the watermark kept (the first chunk
   * of the files it marked last): if NONE of them is there the store was wiped or replaced and every mark is
   * dropped, so everything is learned again, as every pass used to do. A store that cannot answer is not
   * evidence of anything: the marks stay.
   */
  const confirmStore = async (): Promise<void> => {
    if (!wm) return
    const probes = wm.probes()
    if (probes.length === 0 || (!deps.hasHashes && !deps.hasHash)) return
    let present: number | null = null
    try {
      if (deps.hasHashes) present = [...(await io(() => (deps.hasHashes as NonNullable<IngestDeps['hasHashes']>)(probes)))].length
      else present = probes.filter((h) => (deps.hasHash as (hash: string) => boolean)(h)).length
    } catch {
      present = null
    }
    if (present === 0) wm.clear()
  }

  /**
   * Whether the store really holds `hashes` now. A write that returned is not proof of it: the store answers
   * a write whose disk append failed (it keeps the entry in memory, says nothing, and does not count the hash
   * as stored), and the old loop made up for that by offering the chunk again on the next pass. A mark would
   * stop that, so a file is marked only once the store itself says it has everything this pass wrote. A store
   * that cannot answer (it throws, or knownHashes degrades to "none") means "not proven": the file is simply
   * read again next pass.
   */
  const storeHolds = async (hashes: string[]): Promise<boolean> => {
    if (hashes.length === 0 || (!deps.hasHashes && !deps.hasHash)) return true
    for (let i = 0; i < hashes.length; i += VERIFY_BATCH) {
      const batch = hashes.slice(i, i + VERIFY_BATCH)
      const kept = await io(() => knownHashes(deps, batch))
      if (kept.size < batch.length) return false
    }
    return true
  }

  const walk = async (): Promise<void> => {
    if (deps.stopped?.()) return stopWith('stopped')
    await confirmStore()
    for (const source of sources) {
      let files: string[]
      try {
        files = await deps.listFiles(source)
      } catch {
        listingComplete = false
        continue
      }
      if (listed) for (const f of files) listed.add(f)
      for (const filePath of files) {
        if (deps.stopped?.()) {
          // No flushPatches: the store is shutting down too, and the next pass rebuilds them.
          return stopWith('stopped')
        }
        // The stamp is taken BEFORE the read, and is what gets marked: a file appended to while it is read looks changed next pass.
        let stamp: FileStamp | null = null
        if (deps.statFile && wantStat) {
          try {
            stamp = await io(() => (deps.statFile as (p: string) => Promise<FileStamp | null>)(filePath))
          } catch {
            stamp = null
          }
        }
        if (wm && tier && stamp && wm.isDone(filePath, stamp, tier)) {
          metrics.unchanged++
          continue
        }
        // Another computer's session, known at exactly this size and time: only the pass that feeds the one-time
        // linked-history recheck (it asks for the hashes, with onDelegated) has any reason to read it again.
        if (wm && stamp && !deps.onDelegated && wm.isDelegated(filePath, stamp)) {
          metrics.unchanged++
          continue
        }
        // Read already in this drain episode (it changed since: an agent is still writing it). The next full or fast
        // pass reads it; a drain pass goes on to the files behind it.
        if (deps.episode && deps.drainPass !== undefined && deps.episode.has(filePath)) {
          stats.episodeSkipped = (stats.episodeSkipped ?? 0) + 1
          continue
        }
        if (bytesRead >= maxBytes) return stopWith('bytes')
        await waitQuiet()
        if (deps.stopped?.()) return stopWith('stopped')

        const got = await readParsed(source, filePath, stamp)
        if (got === 'stopped') return stopWith('stopped')
        if (got === null) continue
        deps.episode?.add(filePath)
        bytesRead += got.spent
        metrics.bytes += got.spent
        stats.filesScanned++
        metrics.files++
        const parsed = got.turns
        const markFile = (probe?: string): void => {
          if (wm && tier && stamp) {
            wm.markDone(filePath, stamp, tier, probe)
            marked++
          }
        }
        /** Mark a file that wrote chunks, once the store has proven it keeps them. */
        const markWritten = async (written: string[], probe: string): Promise<void> => {
          if (wm && tier && stamp && (await storeHolds(written))) markFile(probe)
        }

        // A session another computer started here over Linked machines is that computer's job, not
        // this one's memory, and the primer a headless run opened with is memory already. Both are
        // left out (shared/headlessPrompt). A subagent's transcript opens with the task its session
        // gave it, not with the session's prompt: it is another computer's work when its session is.
        // Such a file is marked as another computer's, so a pass that wants no hashes of it (the drain, the
        // fast tier) passes it over unread; a pass that does (onDelegated, the one-time linked-history
        // recheck) reads it every time, so the recheck always gets the hashes it needs.
        const parent = parentSessionFile(source, filePath)
        const turns = parent !== null && (await io(() => parentDelegated(parent))) ? null : ownDialogue(parsed)
        if (!turns) {
          stats.delegatedSkipped = (stats.delegatedSkipped ?? 0) + 1
          if (deps.onDelegated) {
            const would = await buildChunks(parsed)
            if (would === null) return stopWith('stopped')
            try { deps.onDelegated(would.map((c) => c.hash)) } catch { /* best effort */ }
          }
          if (wm && stamp) {
            wm.markDone(filePath, stamp, 'delegated')
            marked++
          }
          continue
        }
        if (turns.length === 0) {
          markFile()
          continue
        }
        let chunks = await buildChunks(turns)
        if (chunks === null) return stopWith('stopped')
        if (chunks.length === 0) {
          markFile()
          continue
        }
        metrics.hashed += chunks.length
        // One membership query per FILE, resolved BEFORE the write loop, so the predicate below stays
        // synchronous. `known` is then kept current as we write: two identical chunks in one file must
        // dedup to one, exactly as they did when hasHash read the live store.
        let known = await io(() => knownHashes(deps, (chunks as IngestChunk[]).map((c) => c.hash)))
        // The primer came off this session's opening prompt. One an earlier version stored with it
        // keeps the chunking it was stored under: the shorter first turn moves every cut after it, so
        // re-cut, the whole session would get new hashes and be stored and embedded a second time,
        // beside the old copy. Its first chunk, primer and all, tells: only an earlier version stores
        // that one, where a later chunk can be cut the same with the primer or without.
        if (turns !== parsed) {
          const whole = await buildChunks(parsed)
          if (whole === null) return stopWith('stopped')
          metrics.hashed += whole.length
          const stored = await io(() => knownHashes(deps, whole.map((c) => c.hash)))
          if (stored.has(whole[0].hash)) {
            chunks = whole
            known = stored
          }
        }
        let failed = false
        const written: string[] = [] // the hashes this pass wrote for this file
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]
          if (known.has(chunk.hash)) {
            stats.chunksSkipped++
            metrics.known++
            if (chunk.cwd) pendingPatches.push({ hash: chunk.hash, project: chunk.cwd })
            continue
          }
          try {
            await io(() => deps.write(chunk))
            stats.chunksWritten++
            metrics.written++
            known.add(chunk.hash) // the store has it now — a repeat inside this same file must skip
            written.push(chunk.hash)
          } catch {
            failed = true // skip a chunk that fails to persist (no embed happened to yield for); the file is not complete
            continue
          }
          // Let the event loop service IPC/timers between embeds so a bulk
          // first-run trickles in the background instead of freezing the app.
          if (++sinceYield >= yieldEvery) {
            sinceYield = 0
            await io(() => doYield())
          }
          // Bound the pass so a huge first index is spread over several short
          // bursts (the indexer reschedules a quick follow-up) rather than one
          // long grind. The caller decides whether to cap (background) or not (
          // an explicit user-triggered "index everything").
          if (stats.chunksWritten >= maxChunks) {
            if (!failed && i === chunks.length - 1) await markWritten(written, chunks[0].hash) // the cap fell on this file's last chunk: it is complete
            else deps.episode?.delete(filePath) // cut short: the next drain pass goes on with it
            return stopWith('chunks')
          }
        }
        if (!failed) await markWritten(written, chunks[0].hash)
      }
    }
  }

  /** What the marks of this pass become: kept (written) when the pass is safe to build on, dropped otherwise. */
  const settleMarks = async (): Promise<void> => {
    if (!wm) return
    if (stats.stop === 'stopped') return wm.discard()
    let ok = true
    if (deps.canMark) {
      try {
        ok = await deps.canMark()
      } catch {
        ok = false
      }
    }
    if (!ok) return wm.discard()
    if (listed && listingComplete && !stats.truncated) wm.forgetMissing(listed)
    await wm.flush()
  }

  let threw = true
  try {
    await walk()
    threw = false
    if (stats.stop !== 'stopped') flushPatches()
    await settleMarks()
  } finally {
    if (threw) wm?.discard()
    if (wm) {
      stats.unchanged = metrics.unchanged
      stats.marked = marked
    }
    if (wantStat) stats.bytesRead = bytesRead
    metrics.truncated = stats.truncated
    metrics.stop = stats.stop
    metrics.ms = now() - startedAt
    try { deps.onPass?.(metrics) } catch { /* reporting never breaks a pass */ }
  }
  return stats
}

function defaultRoot(source: ConversationSource): string {
  switch (source) {
    case 'claude':
      return join(homedir(), '.claude', 'projects')
    case 'codex':
      return join(homedir(), '.codex', 'sessions')
    case 'gemini':
      return join(homedir(), '.gemini', 'tmp')
    default:
      return ''
  }
}

function filePattern(source: ConversationSource): RegExp {
  if (source === 'gemini') return /^session-.*\.json$/i
  if (source === 'codex') return /^rollout-.*\.jsonl$/i
  return /\.jsonl$/i
}

// Recursively discover transcript files for a source (bounded depth, tolerant
// of unreadable dirs). The on-disk roots differ per agent.
export async function discoverTranscriptFiles(
  source: ConversationSource,
  root?: string,
  freshSinceTs?: number,
  /** MEM-F7: given, the freshness filter's stat of each fresh file is kept here, to be the pass's stamp for it. */
  stamps?: Map<string, FileStamp>,
): Promise<string[]> {
  const base = root ?? defaultRoot(source)
  if (!base) return []
  const pattern = filePattern(source)
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full, depth + 1)
      else if (pattern.test(e.name)) {
        // Freshness filter (#2 live-session lag): a fast incremental pass only
        // reads files modified recently (the ACTIVE session), so it stays cheap —
        // a stat is far cheaper than re-reading + re-parsing every transcript on
        // disk. Unset (default) = scan everything, the original full-pass behavior.
        if (freshSinceTs !== undefined) {
          try {
            const st = await fsp.stat(full)
            if (st.mtimeMs < freshSinceTs) continue
            if (stamps && st.isFile()) stamps.set(full, { size: st.size, mtimeMs: st.mtimeMs })
          } catch { continue }
        }
        out.push(full)
      }
    }
  }
  await walk(base, 0)
  return out
}

// The newest transcript files for a source, newest first by mtime — used by solo-session learning
// to read the ACTIVE session. Several rather than one: the newest can be a job another computer
// ran here, which the reader then passes over (liveTranscript). Reuses the PROVEN discovery above
// (correct roots + patterns + depth-6 recursion), so it handles Codex's nested
// `sessions/YYYY/MM/DD/rollout-*.jsonl` and Gemini's `tmp/<proj>/chats/session-*.json` layouts —
// where the old per-agent watcher finders silently found nothing. Files with the same mtime keep
// discovery order. Empty when nothing matches.
export async function newestTranscriptFiles(source: ConversationSource, limit: number, root?: string): Promise<string[]> {
  const files = await discoverTranscriptFiles(source, root)
  const dated: Array<{ path: string; mtime: number }> = []
  for (const f of files) {
    try {
      dated.push({ path: f, mtime: (await fsp.stat(f)).mtimeMs })
    } catch {
      /* skip an unreadable file */
    }
  }
  dated.sort((a, b) => b.mtime - a.mtime)
  return dated.slice(0, Math.max(0, limit)).map((d) => d.path)
}

export interface IngestMemory {
  /** SYNC, and only for an in-process store — see IngestDeps.hasHash. */
  hasHash?: (hash: string) => boolean
  /** Batched membership; what the app wires, because the store is out of process. */
  hasHashes?: (hashes: string[]) => Promise<string[]> | string[]
  write: (input: { agentId: string; kind: 'message'; content: string; source: string; hash: string; project?: string; ts?: number }) => Promise<unknown>
  patchProjects?: (patches: Array<{ hash: string; project: string }>) => void
  /** BB6: optionally link each newly-written chunk to the previous one in the same
   *  session with a 'follows' edge — a per-session temporal backbone for the
   *  otherwise edge-less message chunks. Wired to memoryLink in the app.
   *  Wave2 (ingest-follows-edges-ts-now): `ts` carries the conversation time so a
   *  backbone edge over an ancient transcript isn't stamped Date.now() and mis-ranked as fresh. */
  link?: (from: string, to: string, relation: string, weight: number, ts?: number) => void
}

/** What the app's runtime (ingestRuntime) adds to every pass: the watermark, the byte budget, slices, the typing gate. */
async function runtimeDeps(
  rt: IngestRuntime,
  opts: { maxChunks?: number; maxBytes?: number; freshSinceTs?: number; sources?: ConversationSource[]; drainPass?: number },
  pausedNow: boolean,
): Promise<Partial<IngestDeps>> {
  const base: Partial<IngestDeps> = { onPass: (m) => rt.record(m), drainPass: opts.drainPass }
  if (rt.legacy) return base
  // A drain episode starts at the pass that is not a drain pass (full, fast or "index everything"), and its drain
  // passes do not re-read what it already read (MEM-F1).
  const ep = rt.drainEpisode
  if (ep && opts.drainPass === undefined) ep.files = new Set()
  // Switched OFF: the pass ends before it touches anything, and that includes our own state file.
  // (openWatermark never rejects: whatever cannot be read is an empty store.)
  const watermark: IngestWatermark | undefined = rt.openWatermark && !pausedNow ? await rt.openWatermark() : undefined
  return {
    ...base,
    statFile: rt.statFile,
    watermark,
    sliceMs: rt.sliceMs,
    quiet: rt.quiet,
    readText: rt.readText,
    readHead: rt.readHead,
    canMark: rt.canMark,
    episode: ep?.files,
    // A pass that carries a chunk cap is a background pass and gets the byte budget too; the explicit
    // "index everything" has no cap and no budget (it still yields, waits for typing and skips what is done).
    maxBytes: opts.maxBytes ?? (opts.maxChunks !== undefined ? rt.passBytes : undefined),
    fullListing: opts.freshSinceTs === undefined && opts.sources === undefined,
  }
}

/** What runConversationIngest did besides passes: numbers only. */
export interface ConversationIngestCounters {
  /** MEM-F6: passes skipped before touching a file because the memory store was unavailable. */
  unavailableSkips: number
  /** MEM-F7: stamps taken from the fast tier's freshness stat instead of a second stat of the same file. */
  freshStampsReused: number
}
const runCounters: ConversationIngestCounters = { unavailableSkips: 0, freshStampsReused: 0 }

export function conversationIngestCounters(): ConversationIngestCounters {
  return { ...runCounters }
}

export function _resetConversationIngestCountersForTests(): void {
  runCounters.unavailableSkips = runCounters.freshStampsReused = 0
}

// Compose real ingestion: discover on disk + dedup/write via the memory store.
// Kept decoupled from swarmMemory so the orchestration stays unit-testable.
export async function runConversationIngest(
  memory: IngestMemory,
  opts: { roots?: Partial<Record<ConversationSource, string>>; sources?: ConversationSource[]; chunkOptions?: ChunkOptions; maxChunks?: number; maxBytes?: number; drainPass?: number; freshSinceTs?: number; stopped?: () => boolean; onDelegated?: (hashes: string[]) => void } = {},
): Promise<IngestStats> {
  // BB6: track the last-written chunk id per session so we can lay down a 'follows'
  // edge between consecutive same-session chunks. Idempotent: already-stored chunks
  // are skipped (this closure isn't called for them) and upsertEdge dedups repeats.
  // A fresh map per run — cross-pass continuity isn't needed for the backbone.
  const lastIdBySession = new Map<string, string>()
  // MEM-F6: while the store is unavailable every write throws, and the pass would walk, stat, read and parse up to
  // 8 MiB for nothing, on the machine whose starvation took the store down. Skip it, counted. Truncated with stop
  // 'stopped': the full tier must not take it for a pass that read every transcript (its linked-history recheck),
  // and the scheduler asks for no follow-up. Nothing is marked, so the first pass after the store is back reads it all.
  // MEM-F6: memory is unavailable, so every store call of a pass would throw (switch: TERMPOLIS_INGEST_UNAVAILABLE_SKIP=off).
  if (skipPassWhileUnavailable()) {
    runCounters.unavailableSkips++
    return { filesScanned: 0, chunksWritten: 0, chunksSkipped: 0, truncated: true, stop: 'stopped' }
  }
  // Set once at start-up (ingestRuntime.configureConversationIngest); null in tests and in anything that
  // never configured it, and then a pass is exactly what it was in 1.54.4.
  const rt = getIngestRuntime()
  // The "Learn from conversations" switch: asked at every file and every slice. A switch that cannot be read is not "off".
  const pausedNow = (): boolean => {
    try { return rt?.paused() === true } catch { return false }
  }
  const stopped = rt ? (): boolean => pausedNow() || opts.stopped?.() === true : opts.stopped
  const extra = rt ? await runtimeDeps(rt, opts, pausedNow()) : {}
  // MEM-F7: the fast tier's freshness filter has already stat'ed each fresh file; that stat (taken before the read, as
  // a stamp must be) is the file's stamp, once. Only when the pass takes stamps at all (not under TERMPOLIS_INGEST_FAST=off).
  const rtStat = extra.statFile
  const freshStamps = opts.freshSinceTs !== undefined && rtStat ? new Map<string, FileStamp>() : undefined
  if (freshStamps && rtStat) {
    extra.statFile = (filePath) => {
      const st = freshStamps.get(filePath)
      if (!st) return rtStat(filePath)
      freshStamps.delete(filePath)
      runCounters.freshStampsReused++
      return Promise.resolve(st)
    }
  }
  return ingestConversations({
    sources: opts.sources,
    chunkOptions: opts.chunkOptions,
    maxChunks: opts.maxChunks,
    stopped,
    onDelegated: opts.onDelegated,
    listFiles: (source) => discoverTranscriptFiles(source, opts.roots?.[source], opts.freshSinceTs, freshStamps),
    readFile: (fp) => fsp.readFile(fp, 'utf8'),
    hasHash: memory.hasHash,
    hasHashes: memory.hasHashes,
    patchProjects: memory.patchProjects,
    write: async (chunk) => {
      const entry = (await memory.write({
        agentId: `${chunk.source}-history`,
        kind: 'message',
        content: chunk.text,
        source: chunk.source,
        hash: chunk.hash,
        // P0: stamp the entry with the REAL conversation time (last message in the
        // chunk), not the ingest wall-clock, so a re-ingested old transcript never
        // ranks as "most recent". Falls back to Date.now() in the store when a
        // transcript carries no timestamps.
        ts: chunk.endTs ?? chunk.startTs,
        ...(chunk.cwd && { project: chunk.cwd }), // store normalizes to a slug
      })) as { id?: string } | null | undefined
      const curId = entry?.id
      const sid = chunk.sessionId
      if (curId && sid) {
        const prevId = lastIdBySession.get(sid)
        if (prevId && memory.link) memory.link(prevId, curId, 'follows', 1, chunk.endTs ?? chunk.startTs) // Wave2: conversation-time backbone edge
        lastIdBySession.set(sid, curId)
      }
    },
    ...extra,
  })
}
