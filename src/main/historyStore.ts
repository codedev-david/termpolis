import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { writeFile, rename } from 'fs/promises'
import { join } from 'path'
import type { HistoryEntry } from './types'

const MAX_PER_TERMINAL = 1000
/** How long rapid appends are coalesced before the file is touched at all. */
const FLUSH_DEBOUNCE_MS = 1000

type HistoryFile = Record<string, HistoryEntry[]>

function getHistoryPath(): string {
  return join(app.getPath('userData'), 'history.json')
}

// The history lives in memory once loaded, and only the writes go to disk — in the
// background, coalesced.
//
// This used to re-read, re-parse, re-serialize and re-write the entire file on every
// Enter, synchronously, from the IPC handler. That handler runs on the main thread, which
// is also the thread that forwards every PTY chunk to the renderer, so the cost landed
// directly on terminal responsiveness. On a real profile the file had reached 1.26 MiB
// (pretty-printing roughly doubled it), which is tens of milliseconds of parse plus
// serialize plus a blocking write, paid once per command in every terminal.
let cache: HistoryFile | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let writerLoop: Promise<void> | null = null
let dirty = false

function ensureLoaded(): HistoryFile {
  if (cache) return cache
  const path = getHistoryPath()
  let loaded: HistoryFile = {}
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      // A file containing `null` or an array parses fine but is not a history map; treating
      // it as one would make `cache` falsy forever and re-read the file on every append.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) loaded = parsed
    } catch { /* a damaged file reads as empty history rather than taking the app down */ }
  }
  cache = loaded
  return loaded
}

/**
 * Compact, not pretty-printed: nothing reads this by eye, and the indentation was costing
 * both file size and serialize time on the hot path.
 */
function serialize(data: HistoryFile): string {
  return JSON.stringify(data)
}

/** Write via a temp file so a crash mid-write cannot leave truncated JSON behind — a
 *  half-written file parses as garbage, and the catch in `ensureLoaded` would silently
 *  present that as an empty history. */
async function writeNow(data: HistoryFile): Promise<void> {
  const path = getHistoryPath()
  const tmp = `${path}.tmp`
  await writeFile(tmp, serialize(data), 'utf-8')
  await rename(tmp, path)
}

function scheduleFlush(): void {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushHistoryNow()
  }, FLUSH_DEBOUNCE_MS)
  // Never hold the process open just to persist command history.
  flushTimer.unref?.()
}

/**
 * Drain any pending write. Safe to call at any time; concurrent callers share one write.
 * If more appends land while a write is in flight the loop runs again, so the last state
 * always reaches disk.
 */
export function flushHistoryNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!writerLoop) {
    writerLoop = (async () => {
      while (dirty && cache) {
        dirty = false
        try {
          await writeNow(cache)
        } catch { /* history is best-effort; never let it take down a quit or a keystroke */ }
      }
      writerLoop = null
    })()
  }
  return writerLoop
}

/**
 * Blocking flush for shutdown only, where there is no event loop left to await on.
 * Everywhere else uses the async path.
 */
export function flushHistorySync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!dirty || !cache) return
  dirty = false
  try {
    writeFileSync(getHistoryPath(), serialize(cache), 'utf-8')
  } catch { /* best effort */ }
}

/** Drop the in-memory copy so the next read comes from disk. */
export function resetHistoryCache(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  cache = null
  writerLoop = null
  dirty = false
}

export function appendCommand(terminalId: string, terminalName: string, command: string): void {
  const trimmed = command.trim()
  if (!trimmed) return
  const history = ensureLoaded()
  if (!history[terminalId]) history[terminalId] = []
  history[terminalId].push({ terminalId, terminalName, command: trimmed, timestamp: Date.now() })
  if (history[terminalId].length > MAX_PER_TERMINAL) {
    history[terminalId] = history[terminalId].slice(-MAX_PER_TERMINAL)
  }
  scheduleFlush()
}

export function searchHistory(query: string): HistoryEntry[] {
  const history = ensureLoaded()
  const lower = query.toLowerCase()
  return Object.values(history).flat()
    .filter(e => e.command.toLowerCase().includes(lower))
    .sort((a, b) => b.timestamp - a.timestamp)
}
