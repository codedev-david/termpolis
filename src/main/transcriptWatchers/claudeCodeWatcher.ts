import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { publish } from '../agentEventBus'
import { tailFile, resolvePathWithinRoot, type TailHandle } from './baseWatcher'

/**
 * Claude Code transcript watcher.
 *
 * Claude Code writes per-session JSONL files under:
 *   ~/.claude/projects/<mangled-cwd>/*.jsonl
 *
 * where <mangled-cwd> replaces path separators (/ \) with "-" and drops
 * drive colons on Windows. Example:
 *   C:\Users\david\repos\app  →  C--Users-david-repos-app
 *
 * Each JSONL line is one turn (user or assistant) or a system event.
 * Common shapes we care about:
 *   { type: "user", message: { role, content } }
 *   { type: "assistant", message: { role, content, usage: { input_tokens, output_tokens, cache_read_input_tokens } } }
 *   { type: "system", subtype: "compact_boundary" | ... }
 *
 * Tolerances:
 * - Unknown types are ignored silently (schema drift without crash)
 * - Malformed JSON lines are skipped
 * - Token fields may be missing on older sessions — only emit when present
 */

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

export interface ClaudeCodeWatcherHandle {
  terminalId: string
  sessionFile: string
  stop(): void
}

/**
 * Convert a working-directory path to Claude Code's mangled form.
 *
 * "C:\foo\bar" → "C--foo-bar"
 * "/home/u/r"  → "-home-u-r"
 *
 * No filesystem escape is possible here — we only transform the string.
 */
export function mangleCwd(cwd: string): string {
  if (!cwd) return ''
  // Replace all separators (both / and \) AND the Windows drive colon with "-"
  // "C:\\foo\\bar" → "C--foo-bar"   "/home/u/r" → "-home-u-r"
  return cwd.replace(/[\\/:]/g, '-')
}

/**
 * Find the most-recently-modified JSONL transcript for a given cwd.
 * Returns null if no matching directory or no JSONL files found.
 */
export function findLatestSessionFile(cwd: string): string | null {
  const mangled = mangleCwd(cwd)
  if (!mangled) return null

  const dir = path.join(CLAUDE_PROJECTS_DIR, mangled)
  let stat: fs.Stats
  try {
    stat = fs.statSync(dir)
  } catch {
    return null
  }
  if (!stat.isDirectory()) return null

  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }

  const files = entries
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(dir, f)
      // Security: refuse entries that escape the projects dir
      try {
        resolvePathWithinRoot(CLAUDE_PROJECTS_DIR, full)
      } catch {
        return null
      }
      try {
        return { path: full, mtime: fs.statSync(full).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)

  return files.length > 0 ? files[0].path : null
}

interface ClaudeEntry {
  type?: string
  subtype?: string
  message?: {
    role?: string
    content?: unknown
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  timestamp?: string
  sessionId?: string
}

function parseTimestamp(ts: unknown): number {
  if (typeof ts === 'string') {
    const d = Date.parse(ts)
    if (!isNaN(d)) return d
  }
  return Date.now()
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const t = (item as Record<string, unknown>).type
    if (t === 'text') {
      const text = (item as Record<string, unknown>).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join(' ')
}

export function processClaudeLine(line: string, terminalId: string): void {
  let entry: ClaudeEntry
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  if (!entry || typeof entry !== 'object') return

  const ts = parseTimestamp(entry.timestamp)
  const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined

  // Handle message entries (user / assistant)
  if ((entry.type === 'user' || entry.type === 'assistant') && entry.message) {
    const msg = entry.message
    const content = msg.content

    // Tool calls embedded in assistant content
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== 'object') continue
        const itemType = (item as Record<string, unknown>).type
        if (itemType === 'tool_use') {
          const toolName = String((item as Record<string, unknown>).name || 'unknown')
          const toolInput = (item as Record<string, unknown>).input
          publish({
            ts,
            terminalId,
            agentType: 'claude',
            kind: 'tool_call',
            taskId: sessionId,
            summary: `${toolName}`,
            payload: { tool: toolName, input: toolInput },
          })
        } else if (itemType === 'tool_result') {
          const toolUseId = String((item as Record<string, unknown>).tool_use_id || '')
          const isError = Boolean((item as Record<string, unknown>).is_error)
          publish({
            ts,
            terminalId,
            agentType: 'claude',
            kind: 'tool_result',
            taskId: sessionId,
            summary: isError ? 'tool error' : 'tool result',
            payload: { toolUseId, isError },
          })
        }
      }
    }

    // Message text (for feed)
    const text = extractTextContent(content)
    if (text) {
      publish({
        ts,
        terminalId,
        agentType: 'claude',
        kind: 'message',
        taskId: sessionId,
        summary: (msg.role === 'user' ? 'user: ' : 'assistant: ') + text.slice(0, 200),
        payload: { role: msg.role, length: text.length },
      })
    }

    // Token usage
    if (msg.usage) {
      const inTok = Number(msg.usage.input_tokens || 0)
      const outTok = Number(msg.usage.output_tokens || 0)
      const cacheRead = Number(msg.usage.cache_read_input_tokens || 0)
      const cacheCreate = Number(msg.usage.cache_creation_input_tokens || 0)
      if (inTok || outTok || cacheRead || cacheCreate) {
        publish({
          ts,
          terminalId,
          agentType: 'claude',
          kind: 'token_update',
          taskId: sessionId,
          summary: `in:${inTok} out:${outTok}${cacheRead ? ` cache:${cacheRead}` : ''}`,
          payload: {
            inputTokens: inTok,
            outputTokens: outTok,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: cacheCreate,
          },
        })
      }
    }
    return
  }

  // System events
  if (entry.type === 'system') {
    if (entry.subtype === 'compact_boundary') {
      publish({
        ts,
        terminalId,
        agentType: 'claude',
        kind: 'compaction',
        taskId: sessionId,
        summary: 'context compacted',
        payload: { subtype: entry.subtype },
      })
    }
    return
  }
}

/**
 * Attach a watcher to a terminal's working directory.
 * Tails the latest JSONL transcript and emits events.
 */
export function attachClaudeCodeWatcher(terminalId: string, cwd: string): ClaudeCodeWatcherHandle | null {
  const sessionFile = findLatestSessionFile(cwd)
  if (!sessionFile) return null

  // Security: sessionFile must be within CLAUDE_PROJECTS_DIR
  try {
    resolvePathWithinRoot(CLAUDE_PROJECTS_DIR, sessionFile)
  } catch {
    return null
  }

  const tail: TailHandle = tailFile(sessionFile, (line) => processClaudeLine(line, terminalId))

  return {
    terminalId,
    sessionFile,
    stop: () => tail.stop(),
  }
}
