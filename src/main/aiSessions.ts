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

import { readdirSync, statSync, openSync, readSync, closeSync } from 'fs'
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
