import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { publish } from '../agentEventBus'
import { mapLimit } from '../asyncPool'
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
  /** Resolves when the tail has delivered what it found so far (for tests, and a caller that must know it caught up). */
  settled(): Promise<void>
}

/**
 * Find the most-recently-modified session file under CODEX_SESSIONS_DIR.
 * Codex's directory structure varies — we walk one level deep.
 */
export async function findLatestCodexSessionFile(): Promise<string | null> {
  const candidates: { path: string; mtime: number }[] = []

  // readdir already reports whether each entry is a file or a directory, and the name
  // already says whether it could be a transcript at all. This used to stat every entry
  // to re-learn both — a syscall per entry, on the thread that pumps every PTY, against
  // a directory the user has been filling up for months. Now the only stats left are on
  // files that are genuinely candidates, for the one thing readdir cannot report: mtime.
  //
  // All of it on the thread pool, a bounded number of stats at a time (attaching a watcher to a codex terminal
  // used to walk this on the main thread).
  const collect = async (dir: string, recurse: boolean): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const files: string[] = []
    const folders: string[] = []
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      // Security: enforce containment
      try {
        resolvePathWithinRoot(CODEX_SESSIONS_DIR, full)
      } catch {
        continue
      }
      if (entry.isDirectory()) {
        if (recurse) folders.push(full) // one level deep, as before
        continue
      }
      if (!entry.isFile() || !/\.(jsonl|json)$/.test(entry.name)) continue
      files.push(full)
    }
    const stats = await mapLimit(files, 16, async (full) => {
      try {
        return { path: full, mtime: (await fs.promises.stat(full)).mtimeMs }
      } catch {
        return null // vanished between readdir and stat
      }
    })
    for (const s of stats) if (s) candidates.push(s)
    for (const folder of folders) await collect(folder, false)
  }

  await collect(CODEX_SESSIONS_DIR, true)

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

export async function attachCodexWatcher(terminalId: string): Promise<CodexWatcherHandle | null> {
  const sessionFile = await findLatestCodexSessionFile()
  if (!sessionFile) return null

  try {
    resolvePathWithinRoot(CODEX_SESSIONS_DIR, sessionFile)
  } catch {
    return null
  }

  // startAtEnd — live events only. See claudeCodeWatcher: opening at byte 0 replayed the entire
  // transcript through the event bus on the main thread. runConversationIngest owns the backfill.
  const tail: TailHandle = tailFile(sessionFile, (line) => processCodexLine(line, terminalId), { startAtEnd: true })
  await tail.ready // attached means the start position is fixed: a line appended after this is delivered

  return {
    terminalId,
    sessionFile,
    stop: () => tail.stop(),
    settled: () => tail.settled?.() ?? Promise.resolve(),
  }
}
