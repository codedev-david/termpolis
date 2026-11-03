// The ORIGINAL (v1.54.4, commit 942f2177) Claude/Codex parsers and chunker, copied verbatim from
// src/main/conversationIngest.ts by script, only renamed (reference*). They are the ORACLE the new
// incremental parsers and the generator chunker are compared against: a chunk hash is the idempotency
// key of the whole memory store, so "the same output" is not a belief but a property checked over random
// inputs. Do not edit these bodies; if the product's chunking is changed on purpose, change the
// golden fixture, bump INGEST_FORMAT_VERSION and delete this file in the same commit.

import * as crypto from 'crypto'
import type { ChunkOptions, IngestChunk, IngestTurn } from '../../src/main/conversationIngest'

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
export function referenceParseClaude(content: string): IngestTurn[] {
  const turns: IngestTurn[] = []
  let sessionId: string | undefined
  let cwd: string | undefined

  for (const obj of iterJsonl(content)) {
    if (!sessionId && typeof obj.sessionId === 'string') sessionId = obj.sessionId
    // F32: track cwd PER-TURN (update on every occurrence, not first-wins) so a session that
    // moves between repos (/add-dir, resume) tags each turn with the cwd it actually ran under.
    if (typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd
    if (obj.isMeta === true) continue

    const ts = parseTs(obj.timestamp)
    const message = obj.message
    if (!message || typeof message !== 'object') continue

    if (obj.type === 'user') {
      const m = message as { role?: string; content?: unknown }
      if (m.role !== 'user' && m.role !== undefined) continue
      // Wave2 (claude-array-content): a user turn can be an ARRAY (image/attachment + text
      // blocks), not just a plain string. Extract the text blocks (joinTextBlocks ignores
      // tool_result/thinking) instead of dropping the whole turn — a pure tool_result array
      // yields no text and is still skipped.
      const text = typeof m.content === 'string' ? m.content.trim() : joinTextBlocks(m.content)
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

export function referenceParseCodex(content: string): IngestTurn[] {
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
export function referenceChunkTurns(turns: IngestTurn[], opts: ChunkOptions = {}): IngestChunk[] {
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
    // F32: a chunk carries ONE cwd (makeChunk stamps turns[0].cwd on all its turns), so split
    // on a cwd change — otherwise a session that moves between repos mis-tags the later repo's
    // work with the first repo's project (and loses it from the true project's recall).
    if (buf.length > 0 && buf[0].turn.cwd !== t.cwd) flush()
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
  // F16: only sealed (full) chunks are stable across passes. On an incremental pass over the
  // ACTIVE session, skip the trailing partial — it grows by one turn each pass and would
  // deposit a new strict-superset duplicate every ~90s (and, since ts is now conversation
  // time, they'd all rank as freshest). The tail is captured once it fills, or by the full pass.
  if (!opts.sealedOnly) flush()
  return chunks
}
