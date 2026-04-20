import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { publish } from '../agentEventBus'
import { tailFile, resolvePathWithinRoot, type TailHandle } from './baseWatcher'

/**
 * Codex transcript watcher.
 *
 * Codex (the OpenAI CLI) writes JSONL session transcripts under:
 *   ~/.codex/sessions/**
 *
 * Format varies by Codex version — we parse a superset of known shapes
 * and tolerate schema drift. Common shapes:
 *   { type: "message", role, content, tokens? }
 *   { type: "function_call", name, arguments }
 *   { type: "function_call_output", ... }
 *
 * We intentionally accept unknown types silently and skip them.
 */

export const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions')

export interface CodexWatcherHandle {
  terminalId: string
  sessionFile: string
  stop(): void
}

/**
 * Find the most-recently-modified session file under CODEX_SESSIONS_DIR.
 * Codex's directory structure varies — we walk one level deep.
 */
export function findLatestCodexSessionFile(): string | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(CODEX_SESSIONS_DIR)
  } catch {
    return null
  }

  const candidates: { path: string; mtime: number }[] = []

  for (const entry of entries) {
    const full = path.join(CODEX_SESSIONS_DIR, entry)
    // Security: enforce containment
    try {
      resolvePathWithinRoot(CODEX_SESSIONS_DIR, full)
    } catch {
      continue
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (stat.isFile() && /\.(jsonl|json)$/.test(entry)) {
      candidates.push({ path: full, mtime: stat.mtimeMs })
    } else if (stat.isDirectory()) {
      try {
        const sub = fs.readdirSync(full)
        for (const s of sub) {
          const subFull = path.join(full, s)
          try {
            resolvePathWithinRoot(CODEX_SESSIONS_DIR, subFull)
          } catch {
            continue
          }
          try {
            const ss = fs.statSync(subFull)
            if (ss.isFile() && /\.(jsonl|json)$/.test(s)) {
              candidates.push({ path: subFull, mtime: ss.mtimeMs })
            }
          } catch {}
        }
      } catch {}
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates.length > 0 ? candidates[0].path : null
}

interface CodexEntry {
  type?: string
  role?: string
  content?: unknown
  name?: string
  arguments?: unknown
  tokens?: { input?: number; output?: number }
  usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
  timestamp?: string | number
}

function parseTs(ts: unknown): number {
  if (typeof ts === 'number' && isFinite(ts)) return ts > 1e12 ? ts : ts * 1000
  if (typeof ts === 'string') {
    const d = Date.parse(ts)
    if (!isNaN(d)) return d
  }
  return Date.now()
}

export function processCodexLine(line: string, terminalId: string): void {
  let entry: CodexEntry
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  if (!entry || typeof entry !== 'object') return

  const ts = parseTs(entry.timestamp)

  if (entry.type === 'message' || entry.role) {
    const role = typeof entry.role === 'string' ? entry.role : 'unknown'
    const textContent =
      typeof entry.content === 'string' ? entry.content :
      Array.isArray(entry.content)
        ? entry.content
            .map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as Record<string, unknown>).text || '') : ''))
            .filter((s) => s.length > 0)
            .join(' ')
        : ''
    if (textContent) {
      publish({
        ts,
        terminalId,
        agentType: 'codex',
        kind: 'message',
        summary: `${role}: ${textContent.slice(0, 200)}`,
        payload: { role, length: textContent.length },
      })
    }
  }

  if (entry.type === 'function_call' || entry.type === 'tool_call') {
    const toolName = String(entry.name || 'unknown')
    publish({
      ts,
      terminalId,
      agentType: 'codex',
      kind: 'tool_call',
      summary: toolName,
      payload: { tool: toolName, input: entry.arguments },
    })
  }

  if (entry.type === 'function_call_output' || entry.type === 'tool_result') {
    publish({
      ts,
      terminalId,
      agentType: 'codex',
      kind: 'tool_result',
      summary: 'tool result',
      payload: { type: entry.type },
    })
  }

  // Token usage — support both Codex-native and OpenAI-style fields
  const u = entry.usage || entry.tokens
  if (u && typeof u === 'object') {
    const inTok = Number(
      (u as Record<string, unknown>).input_tokens ||
      (u as Record<string, unknown>).prompt_tokens ||
      (u as Record<string, unknown>).input || 0,
    )
    const outTok = Number(
      (u as Record<string, unknown>).output_tokens ||
      (u as Record<string, unknown>).completion_tokens ||
      (u as Record<string, unknown>).output || 0,
    )
    if (inTok || outTok) {
      publish({
        ts,
        terminalId,
        agentType: 'codex',
        kind: 'token_update',
        summary: `in:${inTok} out:${outTok}`,
        payload: { inputTokens: inTok, outputTokens: outTok },
      })
    }
  }
}

export function attachCodexWatcher(terminalId: string): CodexWatcherHandle | null {
  const sessionFile = findLatestCodexSessionFile()
  if (!sessionFile) return null

  try {
    resolvePathWithinRoot(CODEX_SESSIONS_DIR, sessionFile)
  } catch {
    return null
  }

  const tail: TailHandle = tailFile(sessionFile, (line) => processCodexLine(line, terminalId))

  return {
    terminalId,
    sessionFile,
    stop: () => tail.stop(),
  }
}
