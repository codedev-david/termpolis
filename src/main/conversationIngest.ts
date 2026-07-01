// Conversation ingestion — turns past AI-agent transcripts into normalized
// turns and dedupable chunks that feed the growing memory/RAG brain.
//
// Each agent persists history in its own shape (research-verified 2026):
//   • Claude Code  ~/.claude/projects/**/*.jsonl      — JSONL, type user/assistant
//   • Codex CLI    ~/.codex/sessions/**/rollout-*.jsonl — JSONL, response_item/message
//   • Gemini CLI   ~/.gemini/tmp/<proj>/chats/session-*.json — single JSON, messages[]
//   • Qwen Code    PTY-captured for now (its on-disk format is undocumented/unstable)
//
// The parsers here are PURE (string in → turns out) so they unit-test without
// fs/model/network. They aggressively strip non-dialogue noise (tool calls,
// reasoning, injected system/developer prompts, slash-command envelopes) so we
// only embed real human/assistant content. Chunking carries provenance + a
// content-derived hash so re-ingesting the same transcript is idempotent.

import * as crypto from 'crypto'
import { promises as fsp } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type ConversationSource = 'claude' | 'codex' | 'gemini' | 'qwen'

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

function* iterJsonl(content: string): Generator<Record<string, unknown>> {
  for (const line of content.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let obj: unknown
    try {
      obj = JSON.parse(s)
    } catch {
      continue
    }
    if (obj && typeof obj === 'object') yield obj as Record<string, unknown>
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
export function parseClaudeTranscript(content: string): IngestTurn[] {
  const turns: IngestTurn[] = []
  let sessionId: string | undefined
  let cwd: string | undefined

  for (const obj of iterJsonl(content)) {
    if (!sessionId && typeof obj.sessionId === 'string') sessionId = obj.sessionId
    if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
    if (obj.isMeta === true) continue

    const ts = parseTs(obj.timestamp)
    const message = obj.message
    if (!message || typeof message !== 'object') continue

    if (obj.type === 'user') {
      const m = message as { role?: string; content?: unknown }
      if (m.role !== 'user' && m.role !== undefined) continue
      // Real human turns are plain strings; an array is tool_result output — skip.
      if (typeof m.content !== 'string') continue
      const text = m.content.trim()
      if (!text || isCommandNoise(text)) continue
      turns.push({ role: 'user', text, ts, source: 'claude', sessionId, cwd })
    } else if (obj.type === 'assistant') {
      const m = message as { content?: unknown }
      const text = joinTextBlocks(m.content)
      if (text) turns.push({ role: 'assistant', text, ts, source: 'claude', sessionId, cwd })
    }
  }
  return turns
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

export function parseCodexRollout(content: string): IngestTurn[] {
  const turns: IngestTurn[] = []
  let sessionId: string | undefined
  let cwd: string | undefined
  let sawFirstUser = false

  for (const obj of iterJsonl(content)) {
    const ts = parseTs(obj.timestamp)
    if (obj.type === 'session_meta') {
      const p = obj.payload as { id?: unknown; cwd?: unknown } | undefined
      if (p) {
        if (typeof p.id === 'string') sessionId = p.id
        if (typeof p.cwd === 'string') cwd = p.cwd
      }
      continue
    }
    if (obj.type !== 'response_item') continue
    const payload = obj.payload as { type?: string; role?: string; content?: unknown } | undefined
    if (!payload || payload.type !== 'message') continue
    // Drop injected 'developer' harness instructions — not dialogue.
    if (payload.role !== 'user' && payload.role !== 'assistant') continue

    const text = joinCodexText(payload.content)
    if (!text) continue

    if (payload.role === 'user') {
      // The first user item is a synthetic <environment_context> preamble.
      if (!sawFirstUser && text.startsWith('<environment_context>')) {
        sawFirstUser = true
        continue
      }
      sawFirstUser = true
    }
    turns.push({ role: payload.role, text, ts, source: 'codex', sessionId, cwd })
  }
  return turns
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

export function parseGeminiSession(content: string): IngestTurn[] {
  let obj: { sessionId?: unknown; messages?: unknown }
  try {
    obj = JSON.parse(content)
  } catch {
    return []
  }
  if (!obj || !Array.isArray(obj.messages)) return []
  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : undefined

  const turns: IngestTurn[] = []
  for (const m of obj.messages) {
    if (!m || typeof m !== 'object') continue
    const type = (m as { type?: unknown }).type
    const role = type === 'user' ? 'user' : type === 'gemini' ? 'assistant' : null
    if (!role) continue
    const text = joinGeminiContent((m as { content?: unknown }).content)
    if (!text) continue
    turns.push({ role, text, ts: parseTs((m as { timestamp?: unknown }).timestamp), source: 'gemini', sessionId })
  }
  return turns
}

// ---- Chunking ----
export interface ChunkOptions {
  /** Max characters per chunk (~4 chars/token; 2000 ≈ 500 tokens, the bge window). */
  maxChars?: number
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

// Greedily pack turns into ~maxChars chunks; a single oversized turn is
// windowed into multiple chunks so nothing exceeds the embedding window.
export function chunkTurns(turns: IngestTurn[], opts: ChunkOptions = {}): IngestChunk[] {
  const maxChars = opts.maxChars ?? 2000
  const chunks: IngestChunk[] = []
  let buf: { turn: IngestTurn; line: string }[] = []
  let len = 0

  const flush = (): void => {
    if (buf.length === 0) return
    const text = buf.map((b) => b.line).join('\n\n').trim()
    if (text) chunks.push(makeChunk(buf.map((b) => b.turn), text))
    buf = []
    len = 0
  }

  for (const t of turns) {
    const line = `${t.role}: ${t.text}`.trim()
    if (!line) continue
    if (line.length > maxChars) {
      flush()
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(makeChunk([t], line.slice(i, i + maxChars)))
      }
      continue
    }
    if (len > 0 && len + line.length + 2 > maxChars) flush()
    buf.push({ turn: t, line })
    len += line.length + 2
  }
  flush()
  return chunks
}

// ---- Orchestration ----

export interface IngestStats {
  filesScanned: number
  chunksWritten: number
  chunksSkipped: number // already present (content-hash dedup)
  truncated: boolean    // maxChunks halted this pass early — backlog remains for the next run
}

// A macrotask yield. Embedding is CPU-heavy and runs in-process on the main
// thread; without this, a tight write-loop over a large history starves the
// libuv event loop so renderer→main IPC never gets serviced and the whole app
// freezes. `setImmediate` returns control to the loop (poll phase → IPC) between
// embeds, turning a multi-minute freeze into a responsive background trickle.
const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

export interface IngestDeps {
  listFiles: (source: ConversationSource) => Promise<string[]>
  readFile: (filePath: string) => Promise<string>
  hasHash: (hash: string) => boolean
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
}

// Sources with stable, documented on-disk transcripts. Qwen is captured from
// the PTY stream elsewhere (its on-disk format is undocumented/unstable).
export const DISK_SOURCES: ConversationSource[] = ['claude', 'codex', 'gemini']

export function parseBySource(source: ConversationSource, content: string): IngestTurn[] {
  switch (source) {
    case 'claude':
      return parseClaudeTranscript(content)
    case 'codex':
      return parseCodexRollout(content)
    case 'gemini':
      return parseGeminiSession(content)
    default:
      return []
  }
}

// Read every transcript, chunk it, and write new (unseen) chunks. Idempotent:
// chunks whose content hash is already stored are skipped, so re-running over a
// growing set of transcripts only embeds genuinely new content. Tolerant of
// unreadable files / sources — one failure never aborts the run.
export async function ingestConversations(deps: IngestDeps): Promise<IngestStats> {
  const sources = deps.sources ?? DISK_SOURCES
  const doYield = deps.yield ?? yieldToEventLoop
  const yieldEvery = Math.max(1, deps.yieldEvery ?? 1)
  const maxChunks = deps.maxChunks ?? Infinity
  const stats: IngestStats = { filesScanned: 0, chunksWritten: 0, chunksSkipped: 0, truncated: false }
  let sinceYield = 0
  // Skipped-but-cwd-bearing chunks → project backfill for legacy entries.
  const pendingPatches: Array<{ hash: string; project: string }> = []
  const flushPatches = (): void => {
    if (pendingPatches.length === 0 || !deps.patchProjects) return
    try { deps.patchProjects(pendingPatches.splice(0)) } catch { /* best-effort */ }
  }
  for (const source of sources) {
    let files: string[]
    try {
      files = await deps.listFiles(source)
    } catch {
      continue
    }
    for (const filePath of files) {
      let content: string
      try {
        content = await deps.readFile(filePath)
      } catch {
        continue
      }
      stats.filesScanned++
      const turns = parseBySource(source, content)
      if (turns.length === 0) continue
      for (const chunk of chunkTurns(turns, deps.chunkOptions)) {
        if (deps.hasHash(chunk.hash)) {
          stats.chunksSkipped++
          if (chunk.cwd) pendingPatches.push({ hash: chunk.hash, project: chunk.cwd })
          continue
        }
        try {
          await deps.write(chunk)
          stats.chunksWritten++
        } catch {
          continue // skip a chunk that fails to persist (no embed happened to yield for)
        }
        // Let the event loop service IPC/timers between embeds so a bulk
        // first-run trickles in the background instead of freezing the app.
        if (++sinceYield >= yieldEvery) {
          sinceYield = 0
          await doYield()
        }
        // Bound the pass so a huge first index is spread over several short
        // bursts (the indexer reschedules a quick follow-up) rather than one
        // long grind. The caller decides whether to cap (background) or not (
        // an explicit user-triggered "index everything").
        if (stats.chunksWritten >= maxChunks) {
          stats.truncated = true
          flushPatches()
          return stats
        }
      }
    }
  }
  flushPatches()
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
export async function discoverTranscriptFiles(source: ConversationSource, root?: string, freshSinceTs?: number): Promise<string[]> {
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
          try { if ((await fsp.stat(full)).mtimeMs < freshSinceTs) continue } catch { continue }
        }
        out.push(full)
      }
    }
  }
  await walk(base, 0)
  return out
}

// Newest matching transcript file for a source — used by solo-session learning to read
// the ACTIVE session. Reuses the PROVEN discovery above (correct roots + patterns +
// depth-6 recursion), so it handles Codex's nested `sessions/YYYY/MM/DD/rollout-*.jsonl`
// and Gemini's `tmp/<proj>/chats/session-*.json` layouts — where the old per-agent
// watcher finders silently found nothing. Newest by mtime; null when nothing matches.
export async function findLatestTranscriptFile(source: ConversationSource, root?: string): Promise<string | null> {
  const files = await discoverTranscriptFiles(source, root)
  let best: { path: string; mtime: number } | null = null
  for (const f of files) {
    try {
      const mtime = (await fsp.stat(f)).mtimeMs
      if (!best || mtime > best.mtime) best = { path: f, mtime }
    } catch {
      /* skip an unreadable file */
    }
  }
  return best ? best.path : null
}

export interface IngestMemory {
  hasHash: (hash: string) => boolean
  write: (input: { agentId: string; kind: 'message'; content: string; source: string; hash: string; project?: string }) => Promise<unknown>
  patchProjects?: (patches: Array<{ hash: string; project: string }>) => void
  /** BB6: optionally link each newly-written chunk to the previous one in the same
   *  session with a 'follows' edge — a per-session temporal backbone for the
   *  otherwise edge-less message chunks. Wired to memoryLink in the app. */
  link?: (from: string, to: string, relation: string, weight: number) => void
}

// Compose real ingestion: discover on disk + dedup/write via the memory store.
// Kept decoupled from swarmMemory so the orchestration stays unit-testable.
export async function runConversationIngest(
  memory: IngestMemory,
  opts: { roots?: Partial<Record<ConversationSource, string>>; sources?: ConversationSource[]; chunkOptions?: ChunkOptions; maxChunks?: number; freshSinceTs?: number } = {},
): Promise<IngestStats> {
  // BB6: track the last-written chunk id per session so we can lay down a 'follows'
  // edge between consecutive same-session chunks. Idempotent: already-stored chunks
  // are skipped (this closure isn't called for them) and upsertEdge dedups repeats.
  // A fresh map per run — cross-pass continuity isn't needed for the backbone.
  const lastIdBySession = new Map<string, string>()
  return ingestConversations({
    sources: opts.sources,
    chunkOptions: opts.chunkOptions,
    maxChunks: opts.maxChunks,
    listFiles: (source) => discoverTranscriptFiles(source, opts.roots?.[source], opts.freshSinceTs),
    readFile: (fp) => fsp.readFile(fp, 'utf8'),
    hasHash: memory.hasHash,
    patchProjects: memory.patchProjects,
    write: async (chunk) => {
      const entry = (await memory.write({
        agentId: `${chunk.source}-history`,
        kind: 'message',
        content: chunk.text,
        source: chunk.source,
        hash: chunk.hash,
        ...(chunk.cwd && { project: chunk.cwd }), // store normalizes to a slug
      })) as { id?: string } | null | undefined
      const curId = entry?.id
      const sid = chunk.sessionId
      if (curId && sid) {
        const prevId = lastIdBySession.get(sid)
        if (prevId && memory.link) memory.link(prevId, curId, 'follows', 1)
        lastIdBySession.set(sid, curId)
      }
    },
  })
}
