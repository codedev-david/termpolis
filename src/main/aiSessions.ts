// Past AI Sessions browser — scans ~/.claude/projects/ for session JSONL files
// and returns lightweight summaries the renderer can display in a picker.
//
// Why this exists: `claude --resume` is cwd-scoped — it only lists sessions
// from the project folder matching the current working directory. When an AI
// agent runs inside a Termpolis terminal pane, its session lands in whatever
// cwd that pane was opened from, which won't show up if the user later runs
// `claude --resume` from a different folder. This module gives Termpolis a
// global view across every project folder so any past session can be resumed
// from any terminal.
//
// Read strategy: per file, only top-of-file (first ~64 KB). That's enough to
// extract cwd, version, gitBranch, and the first user message. Skips full
// scans — assumes ~100 sessions × 64 KB = a few MB total when the picker
// opens. No state held — recomputed each call.
//
// IMPORTANT: All fs is async (fs.promises). Real users have hundreds of
// session files (the author hit 803 / 515 MB on his own machine), so a
// synchronous scan blocks the main process for seconds — looks like the
// whole app is frozen because keystroke and terminal-output IPC queues
// can't drain. Stay non-blocking.

import { promises as fsp } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const HEAD_BYTES = 64 * 1024
const SCAN_CONCURRENCY = 16

export interface AISessionSummary {
  id: string
  filePath: string
  projectFolder: string
  cwd: string
  gitBranch?: string
  version?: string
  firstUserMessage?: string
  startTime?: string
  lastModified: number
  sizeBytes: number
}

function extractContentString(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
        return (part as { text: string }).text
      }
      if (typeof part === 'string') return part
    }
  }
  return undefined
}

async function readHead(filePath: string, maxBytes: number): Promise<string> {
  const fh = await fsp.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

async function summarizeFile(filePath: string, projectFolder: string): Promise<AISessionSummary | null> {
  let stat
  try { stat = await fsp.stat(filePath) } catch { return null }

  const id = filePath.replace(/^.*[\\/]/, '').replace(/\.jsonl$/i, '')
  if (!id) return null

  let head = ''
  try { head = await readHead(filePath, HEAD_BYTES) } catch { return null }

  const lines = head.split('\n')
  // The last line of a partial-head read may be truncated mid-JSON — drop it.
  if (lines.length > 1 && !head.endsWith('\n')) lines.pop()

  let cwd: string | undefined
  let gitBranch: string | undefined
  let version: string | undefined
  let firstUserMessage: string | undefined
  let startTime: string | undefined

  for (const line of lines) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try { obj = JSON.parse(line) as Record<string, unknown> } catch { continue }

    if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
    if (!gitBranch && typeof obj.gitBranch === 'string') gitBranch = obj.gitBranch
    if (!version && typeof obj.version === 'string') version = obj.version
    if (!startTime && typeof obj.timestamp === 'string') startTime = obj.timestamp

    if (!firstUserMessage && obj.type === 'user' && obj.message && typeof obj.message === 'object') {
      const msg = obj.message as { content?: unknown; role?: string }
      if (msg.role === 'user' || msg.role === undefined) {
        const text = extractContentString(msg.content)
        if (text && !text.startsWith('<command-name>') && !text.startsWith('<local-command-')) {
          firstUserMessage = text.length > 240 ? text.slice(0, 237) + '...' : text
        }
      }
    }

    if (cwd && firstUserMessage && gitBranch && version) break
  }

  // No cwd means we can't resume confidently — Claude Code keys context off it.
  if (!cwd) return null

  return {
    id,
    filePath,
    projectFolder,
    cwd,
    gitBranch,
    version,
    firstUserMessage,
    startTime,
    lastModified: stat.mtimeMs,
    sizeBytes: stat.size,
  }
}

// Bounded-concurrency map: limits how many file reads happen at once so
// we don't spawn 800 parallel fd opens (Windows ulimit, AV scanning).
async function mapWithConcurrency<T, U>(items: T[], limit: number, fn: (t: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length)
  let i = 0
  const workers: Promise<void>[] = []
  const next = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  }
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(next())
  await Promise.all(workers)
  return out
}

export async function listAISessions(opts?: { projectsRoot?: string }): Promise<AISessionSummary[]> {
  const root = opts?.projectsRoot ?? join(homedir(), '.claude', 'projects')
  let folders: string[]
  try { folders = await fsp.readdir(root) } catch { return [] }

  // Collect (filePath, projectFolder) pairs first, then process in parallel.
  const targets: { filePath: string; projectFolder: string }[] = []
  await Promise.all(folders.map(async folder => {
    const folderPath = join(root, folder)
    try {
      const s = await fsp.stat(folderPath)
      if (!s.isDirectory()) return
      const entries = await fsp.readdir(folderPath)
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue
        targets.push({ filePath: join(folderPath, entry), projectFolder: folder })
      }
    } catch { /* unreadable folder — skip */ }
  }))

  const summaries = await mapWithConcurrency(targets, SCAN_CONCURRENCY, t => summarizeFile(t.filePath, t.projectFolder))
  const out = summaries.filter((s): s is AISessionSummary => s !== null)
  out.sort((a, b) => b.lastModified - a.lastModified)
  return out
}

// =====================================================
// Cross-AI context handoff
// =====================================================
// Produces a portable summary of a past Claude Code session that can be
// injected as the first prompt to ANY AI agent (Codex, Gemini, Qwen, or
// even back into Claude). The goal is to give the new agent enough context
// to "pick up where the last one left off" without re-reading the full
// JSONL — that file can be megabytes.
//
// What we extract:
//   • cwd + gitBranch + version (where the work was happening)
//   • The first user message (intent — what the user originally asked for)
//   • The last few user messages (most recent direction)
//   • The last assistant text turn (current state of play)
// All concatenated into a markdown block with a clear "context handoff"
// preamble so the receiving agent treats it as background, not a new task.

export interface AISessionDigest {
  id: string
  filePath: string
  cwd: string
  gitBranch?: string
  version?: string
  firstUserMessage?: string
  recentUserMessages: string[]
  lastAssistantText?: string
  totalUserTurns: number
  totalAssistantTurns: number
}

const MAX_PREVIEW_CHARS = 1200 // per excerpted message
const RECENT_USER_MESSAGES = 3

export async function digestAISession(filePath: string): Promise<AISessionDigest | null> {
  try { await fsp.stat(filePath) } catch { return null }

  let raw = ''
  try {
    raw = await fsp.readFile(filePath, 'utf8')
  } catch { return null }

  const id = filePath.replace(/^.*[\\/]/, '').replace(/\.jsonl$/i, '')
  if (!id) return null

  const lines = raw.split('\n')
  let cwd: string | undefined
  let gitBranch: string | undefined
  let version: string | undefined
  let firstUserMessage: string | undefined
  const userMessages: string[] = []
  let lastAssistantText: string | undefined
  let totalUserTurns = 0
  let totalAssistantTurns = 0

  for (const line of lines) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try { obj = JSON.parse(line) as Record<string, unknown> } catch { continue }

    if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
    if (!gitBranch && typeof obj.gitBranch === 'string') gitBranch = obj.gitBranch
    if (!version && typeof obj.version === 'string') version = obj.version

    if (obj.type === 'user' && obj.message && typeof obj.message === 'object') {
      const msg = obj.message as { content?: unknown; role?: string }
      if (msg.role === 'user' || msg.role === undefined) {
        const text = extractContentString(msg.content)
        if (text && !text.startsWith('<command-name>') && !text.startsWith('<local-command-')) {
          totalUserTurns++
          if (!firstUserMessage) firstUserMessage = truncate(text, MAX_PREVIEW_CHARS)
          userMessages.push(truncate(text, MAX_PREVIEW_CHARS))
        }
      }
    }

    if (obj.type === 'assistant' && obj.message && typeof obj.message === 'object') {
      const msg = obj.message as { content?: unknown }
      const text = extractContentString(msg.content)
      if (text) {
        totalAssistantTurns++
        lastAssistantText = truncate(text, MAX_PREVIEW_CHARS)
      }
    }
  }

  if (!cwd) return null

  return {
    id,
    filePath,
    cwd,
    gitBranch,
    version,
    firstUserMessage,
    recentUserMessages: userMessages.slice(-RECENT_USER_MESSAGES),
    lastAssistantText,
    totalUserTurns,
    totalAssistantTurns,
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + '...' : s
}

// Render a digest into a portable prompt that any AI agent can consume.
// Designed to be shell-paste-safe: no backticks (the AI shells we target
// often interpret backticks as command substitution if not single-quoted),
// uses simple "---" dividers and indented blocks.
export function renderDigestAsPrompt(d: AISessionDigest): string {
  const out: string[] = []
  out.push('Context handoff from a previous Claude Code session.')
  out.push('Continue where the previous AI left off — do not start from scratch.')
  out.push('')
  out.push('Project: ' + d.cwd + (d.gitBranch ? '  (branch: ' + d.gitBranch + ')' : ''))
  out.push('Source session: ' + d.id)
  out.push('Turns: ' + d.totalUserTurns + ' user / ' + d.totalAssistantTurns + ' assistant')
  out.push('')

  if (d.firstUserMessage) {
    out.push('--- Original goal (first user message) ---')
    out.push(d.firstUserMessage)
    out.push('')
  }

  if (d.recentUserMessages.length > 1) {
    out.push('--- Most recent user direction ---')
    for (const m of d.recentUserMessages.slice(-2)) {
      out.push(m)
      out.push('')
    }
  }

  if (d.lastAssistantText) {
    out.push('--- Last assistant turn (current state of play) ---')
    out.push(d.lastAssistantText)
    out.push('')
  }

  out.push('--- Your task ---')
  out.push('Acknowledge this context briefly, then continue the work.')
  return out.join('\n')
}
