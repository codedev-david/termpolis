import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { publish } from '../agentEventBus'
import { tailFile, resolvePathWithinRoot, type TailHandle } from './baseWatcher'

/**
 * Gemini CLI transcript watcher.
 *
 * Gemini CLI stores session data under ~/.gemini/. Exact format is
 * version-dependent; we tail any .jsonl file in a conservative best-effort
 * fashion and emit generic message events.
 */

export const GEMINI_DIR = path.join(os.homedir(), '.gemini')

export interface GeminiWatcherHandle {
  terminalId: string
  sessionFile: string
  stop(): void
}

export function findLatestGeminiSessionFile(): string | null {
  const candidates: { path: string; mtime: number }[] = []

  // As in codexWatcher: readdir already reports the entry type and the name already says
  // whether it could be a transcript, so the only stat left is the one fetching the
  // mtime we sort by.
  //
  // The separate "flat layout" pass that used to follow this walk is gone. Depth 0 IS
  // the top level, so that pass re-stat'd and re-collected every .jsonl sitting directly
  // in ~/.gemini — duplicating both the syscalls and the candidate entries.
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return // cap recursion — don't scan whole home dir
    let items: fs.Dirent[]
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      const full = path.join(dir, item.name)
      try { resolvePathWithinRoot(GEMINI_DIR, full) } catch { continue }
      if (item.isDirectory()) { walk(full, depth + 1); continue }
      if (!item.isFile() || !item.name.endsWith('.jsonl')) continue
      try {
        candidates.push({ path: full, mtime: fs.statSync(full).mtimeMs })
      } catch { /* vanished between readdir and stat */ }
    }
  }

  walk(GEMINI_DIR, 0)

  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates.length > 0 ? candidates[0].path : null
}

export function processGeminiLine(line: string, terminalId: string): void {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  if (!entry || typeof entry !== 'object') return

  const role = typeof entry.role === 'string' ? entry.role : (typeof entry.author === 'string' ? entry.author : null)
  const text =
    typeof entry.content === 'string' ? entry.content :
    typeof entry.text === 'string' ? entry.text :
    Array.isArray(entry.content)
      ? entry.content
          .map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as Record<string, unknown>).text || '') : ''))
          .join(' ')
      : ''

  if (role && text) {
    publish({
      terminalId,
      agentType: 'gemini',
      kind: 'message',
      summary: `${role}: ${text.slice(0, 200)}`,
      payload: { role, length: text.length },
    })
  }
}

export function attachGeminiWatcher(terminalId: string): GeminiWatcherHandle | null {
  const sessionFile = findLatestGeminiSessionFile()
  if (!sessionFile) return null
  try { resolvePathWithinRoot(GEMINI_DIR, sessionFile) } catch { return null }

  // startAtEnd — live events only. See claudeCodeWatcher: opening at byte 0 replayed the entire
  // transcript through the event bus on the main thread. runConversationIngest owns the backfill.
  const tail: TailHandle = tailFile(sessionFile, (line) => processGeminiLine(line, terminalId), { startAtEnd: true })

  return {
    terminalId,
    sessionFile,
    stop: () => tail.stop(),
  }
}
