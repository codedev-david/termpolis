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
  let entries: string[]
  try {
    entries = fs.readdirSync(GEMINI_DIR)
  } catch {
    return null
  }

  const candidates: { path: string; mtime: number }[] = []

  const walk = (dir: string, depth: number) => {
    if (depth > 2) return // cap recursion — don't scan whole home dir
    let items: string[]
    try { items = fs.readdirSync(dir) } catch { return }
    for (const item of items) {
      const full = path.join(dir, item)
      try { resolvePathWithinRoot(GEMINI_DIR, full) } catch { continue }
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.isFile() && full.endsWith('.jsonl')) {
        candidates.push({ path: full, mtime: stat.mtimeMs })
      } else if (stat.isDirectory()) {
        walk(full, depth + 1)
      }
    }
  }

  walk(GEMINI_DIR, 0)
  // Consume top-level entries too (fallback for flat layouts)
  for (const entry of entries) {
    if (entry.endsWith('.jsonl')) {
      const full = path.join(GEMINI_DIR, entry)
      try {
        const st = fs.statSync(full)
        if (st.isFile()) candidates.push({ path: full, mtime: st.mtimeMs })
      } catch {}
    }
  }

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

  const tail: TailHandle = tailFile(sessionFile, (line) => processGeminiLine(line, terminalId))

  return {
    terminalId,
    sessionFile,
    stop: () => tail.stop(),
  }
}
