import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { publish } from '../agentEventBus'
import { mapLimit } from '../asyncPool'
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
  /** Resolves when the tail has delivered what it found so far (for tests, and a caller that must know it caught up). */
  settled(): Promise<void>
}

export async function findLatestGeminiSessionFile(): Promise<string | null> {
  const candidates: { path: string; mtime: number }[] = []

  // As in codexWatcher: readdir already reports the entry type and the name already says
  // whether it could be a transcript, so the only stat left is the one fetching the
  // mtime we sort by.
  //
  // The separate "flat layout" pass that used to follow this walk is gone. Depth 0 IS
  // the top level, so that pass re-stat'd and re-collected every .jsonl sitting directly
  // in ~/.gemini — duplicating both the syscalls and the candidate entries.
  //
  // All of it on the thread pool, a bounded number of stats at a time (attaching a watcher to a Gemini terminal
  // used to walk this on the main thread).
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2) return // cap recursion — don't scan whole home dir
    let items: fs.Dirent[]
    try { items = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
    const files: string[] = []
    const folders: string[] = []
    for (const item of items) {
      const full = path.join(dir, item.name)
      try { resolvePathWithinRoot(GEMINI_DIR, full) } catch { continue }
      if (item.isDirectory()) { folders.push(full); continue }
      if (!item.isFile() || !item.name.endsWith('.jsonl')) continue
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
    for (const folder of folders) await walk(folder, depth + 1)
  }

  await walk(GEMINI_DIR, 0)

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

export async function attachGeminiWatcher(terminalId: string): Promise<GeminiWatcherHandle | null> {
  const sessionFile = await findLatestGeminiSessionFile()
  if (!sessionFile) return null
  try { resolvePathWithinRoot(GEMINI_DIR, sessionFile) } catch { return null }

  // startAtEnd — live events only. See claudeCodeWatcher: opening at byte 0 replayed the entire
  // transcript through the event bus on the main thread. runConversationIngest owns the backfill.
  const tail: TailHandle = tailFile(sessionFile, (line) => processGeminiLine(line, terminalId), { startAtEnd: true })
  await tail.ready // attached means the start position is fixed: a line appended after this is delivered

  return {
    terminalId,
    sessionFile,
    stop: () => tail.stop(),
    settled: () => tail.settled?.() ?? Promise.resolve(),
  }
}
