// Router evaluation: the user's real prompts, read from Claude Code's local transcripts (JSONL), each with
// what answering it took (tool calls, output tokens, the model that ran). Pure line parsing plus a
// streaming file reader: a transcript can be hundreds of MB, so nothing reads one whole.

import * as fs from 'fs'
import * as readline from 'readline'
import { createHash } from 'crypto'

export type Family = 'opus' | 'sonnet' | 'haiku'

export interface Turn {
  /** Stable id from the session and the prompt's uuid: the labelling sheet keys on it. */
  id: string
  sessionId: string
  ts: string
  prompt: string
  /** 0 for a session's first prompt. */
  position: number
  toolCalls: number
  outTokens: number
  /** The family that answered most of the turn's requests; null when none did. */
  model: Family | null
}

const JUNK_PREFIXES = [
  'Caveat:', '[Request interrupted', 'This session is being continued', 'Base directory for this skill',
]

export function familyOf(model: unknown): Family | null {
  const m = String(model ?? '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return null
}

/** The text a person typed, or null for a tool result, a slash command's echo, a hook's note or a summary. */
export function promptText(content: unknown): string | null {
  let s: string
  if (typeof content === 'string') s = content
  else if (Array.isArray(content)) {
    const blocks = content as Array<{ type?: string; text?: string }>
    if (blocks.some((b) => b && b.type === 'tool_result')) return null
    s = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
  } else return null
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (!s) return null
  if (/^<[a-z][\w-]*[\s>]/i.test(s)) return null // <command-name>, <local-command-stdout>, <task-notification>, ...
  if (JUNK_PREFIXES.some((p) => s.startsWith(p))) return null
  return s
}

function turnId(sessionId: string, uuid: string, prompt: string): string {
  return createHash('sha1').update(`${sessionId}\n${uuid}\n${prompt}`).digest('hex').slice(0, 12)
}

/** Folds transcript lines into turns: a turn is a typed prompt and everything answered until the next one. */
export class TurnCollector {
  readonly turns: Turn[] = []
  private cur: (Turn & { models: Record<string, number>; seen: Set<string> }) | null = null
  private positions = new Map<string, number>()

  line(raw: string): void {
    if (!raw || raw.charCodeAt(0) !== 123 /* { */) return
    let o: Record<string, unknown>
    try { o = JSON.parse(raw) } catch { return }
    if (o.isSidechain) return
    const msg = (o.message ?? {}) as { content?: unknown; model?: unknown; id?: unknown; usage?: { output_tokens?: unknown } }
    if (o.type === 'user') {
      if (o.isMeta || o.isCompactSummary) return
      const text = promptText(msg.content)
      if (text === null) return
      this.close()
      const sid = String(o.sessionId ?? '')
      const position = this.positions.get(sid) ?? 0
      this.positions.set(sid, position + 1)
      this.cur = {
        id: turnId(sid, String(o.uuid ?? ''), text), sessionId: sid, ts: String(o.timestamp ?? ''), prompt: text, position,
        toolCalls: 0, outTokens: 0, model: null, models: {}, seen: new Set(),
      }
      return
    }
    if (o.type !== 'assistant' || !this.cur) return
    const fam = familyOf(msg.model)
    if (fam) this.cur.models[fam] = (this.cur.models[fam] ?? 0) + 1
    if (Array.isArray(msg.content)) {
      for (const b of msg.content as Array<{ type?: string }>) if (b && b.type === 'tool_use') this.cur.toolCalls++
    }
    const mid = String(msg.id ?? o.uuid ?? '')
    const out = Number(msg.usage?.output_tokens)
    if (!this.cur.seen.has(mid) && Number.isFinite(out) && out > 0) {
      this.cur.seen.add(mid)
      this.cur.outTokens += out
    }
  }

  close(): void {
    const c = this.cur
    if (!c) return
    this.cur = null
    let model: Family | null = null
    for (const f of ['opus', 'sonnet', 'haiku'] as const) if ((c.models[f] ?? 0) > (model ? c.models[model] : 0)) model = f
    const { models: _m, seen: _s, ...turn } = c
    this.turns.push({ ...turn, model })
  }
}

/** Every turn in one transcript, streamed line by line. A file that cannot be read gives none. */
export async function readTranscript(file: string): Promise<Turn[]> {
  const col = new TurnCollector()
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const l of rl) col.line(l)
  } catch { /* unreadable: what was read so far stands */ }
  col.close()
  return col.turns
}
