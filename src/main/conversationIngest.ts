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
