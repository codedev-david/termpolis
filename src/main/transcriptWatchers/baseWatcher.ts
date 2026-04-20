import * as fs from 'fs'
import * as path from 'path'

/**
 * Base class for tailing a JSONL (or line-oriented) transcript file.
 *
 * Security:
 * - MAX_LINE_BYTES caps one line so a runaway file can't exhaust memory
 * - MAX_READ_BYTES caps how much is read per poll — prevents DOS via giant file
 * - Path inputs go through resolvePathWithinRoot() to prevent traversal
 * - fs.watch + polling fallback keeps CPU low while still catching missed events
 */

export const MAX_LINE_BYTES = 64 * 1024        // 64KB — any longer line is skipped
export const MAX_READ_BYTES = 2 * 1024 * 1024  // 2MB per poll — chunk huge files
export const POLL_INTERVAL_MS = 1500           // polling fallback cadence

export interface TailHandle {
  stop(): void
}

/**
 * Ensure a target path resolves beneath a root directory (inclusive).
 * Throws if the target escapes the root via traversal.
 */
export function resolvePathWithinRoot(root: string, target: string): string {
  const normalizedRoot = path.resolve(root) + path.sep
  const resolved = path.resolve(target)
  if (resolved !== path.resolve(root) && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`Path escapes root: ${target}`)
  }
  return resolved
}

/**
 * Tail a file, invoking onLine for each newly-appended line.
 *
 * Tracks offset across invocations so repeated calls of the returned `tick`
 * read only new content. Returns a handle with a stop() method.
 */
export function tailFile(
  filePath: string,
  onLine: (line: string) => void,
  opts: { startAtEnd?: boolean } = {},
): TailHandle {
  let offset = 0
  let stopped = false
  let leftover = ''
  let watcher: fs.FSWatcher | null = null
  let poller: ReturnType<typeof setInterval> | null = null

  // Initialize offset
  try {
    if (opts.startAtEnd) {
      const stats = fs.statSync(filePath)
      offset = stats.size
    }
  } catch {
    // File may not exist yet — start at 0, tick will handle it
  }

  const tick = () => {
    if (stopped) return
    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      return
    }

    // File truncated / rotated — reset
    if (stats.size < offset) {
      offset = 0
      leftover = ''
    }

    if (stats.size === offset) return

    const toRead = Math.min(stats.size - offset, MAX_READ_BYTES)
    let buf: Buffer
    try {
      const fd = fs.openSync(filePath, 'r')
      try {
        buf = Buffer.alloc(toRead)
        fs.readSync(fd, buf, 0, toRead, offset)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return
    }

    offset += toRead
    const chunk = leftover + buf.toString('utf-8')
    const lines = chunk.split('\n')
    leftover = lines.pop() ?? ''

    // If leftover grows past MAX_LINE_BYTES, drop it — prevents memory growth from a pathological file with no newlines
    if (leftover.length > MAX_LINE_BYTES) {
      leftover = ''
    }

    for (const line of lines) {
      if (!line.trim()) continue
      if (line.length > MAX_LINE_BYTES) continue
      try {
        onLine(line)
      } catch {
        // Isolate parser errors — don't kill the tailer
      }
    }
  }

  // fs.watch for change events
  try {
    watcher = fs.watch(filePath, { persistent: false }, () => tick())
    watcher.on('error', () => {
      try { watcher?.close() } catch {}
      watcher = null
    })
  } catch {
    // Watch may fail if file doesn't exist — polling will pick it up
  }

  // Always run a slow poll as a safety net — fs.watch misses events on some platforms
  poller = setInterval(tick, POLL_INTERVAL_MS)

  // Immediate tick in case there's content
  tick()

  return {
    stop() {
      stopped = true
      try { watcher?.close() } catch {}
      watcher = null
      if (poller) { clearInterval(poller); poller = null }
    },
  }
}
