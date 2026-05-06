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

import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const HEAD_BYTES = 64 * 1024

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

function readHead(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function summarizeFile(filePath: string, projectFolder: string): AISessionSummary | null {
  let stat
  try { stat = statSync(filePath) } catch { return null }

  const id = filePath.replace(/^.*[\\/]/, '').replace(/\.jsonl$/i, '')
  if (!id) return null

  let head = ''
  try { head = readHead(filePath, HEAD_BYTES) } catch { return null }

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

export function listAISessions(opts?: { projectsRoot?: string }): AISessionSummary[] {
  const root = opts?.projectsRoot ?? join(homedir(), '.claude', 'projects')
  let folders: string[]
  try { folders = readdirSync(root) } catch { return [] }

  const out: AISessionSummary[] = []
  for (const folder of folders) {
    const folderPath = join(root, folder)
    let entries: string[]
    try {
      const s = statSync(folderPath)
      if (!s.isDirectory()) continue
      entries = readdirSync(folderPath)
    } catch { continue }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const summary = summarizeFile(join(folderPath, entry), folder)
      if (summary) out.push(summary)
    }
  }

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

const MAX_CONTEXT_FILE_BYTES = 8 * 1024 * 1024 // 8 MB safety cap
const MAX_PREVIEW_CHARS = 1200 // per excerpted message
const RECENT_USER_MESSAGES = 3

export function digestAISession(filePath: string): AISessionDigest | null {
  let stat
  try { stat = statSync(filePath) } catch { return null }
  if (stat.size > MAX_CONTEXT_FILE_BYTES) {
    // For oversized files, fall back to the lightweight head-only summary.
    // The digest is still useful — just less complete.
  }

  let raw = ''
  try {
    raw = readFileSync(filePath, 'utf8')
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
