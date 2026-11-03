import * as fs from 'fs'
import * as path from 'path'
import { createRunGate, WATCH_MIN_INTERVAL_MS } from '../watchGuard'

/**
 * Base class for tailing a JSONL (or line-oriented) transcript file.
 *
 * Security:
 * - MAX_LINE_BYTES caps one line so a runaway file can't exhaust memory
 * - MAX_READ_BYTES caps how much is read per poll — prevents DOS via giant file
 * - Path inputs go through resolvePathWithinRoot() to prevent traversal
 * - fs.watch + polling fallback keeps CPU low while still catching missed events
 *
 * Pacing (watchGuard.ts): a write to the transcript used to cost a synchronous stat + open + read +
 * close on the MAIN thread for EVERY fs.watch event, and the main thread is the one that echoes
 * keystrokes. A streaming agent writes many times a second and Defender can stall one open for over
 * a second. Now an event only tells a run gate "something happened": the first one after quiet reads
 * at once (async, off the main thread), the rest of that 2 s window collapses into one trailing read,
 * two reads never overlap, and a flood backs off. The 1.5 s poll is the same request, not a second
 * code path. Only the pass at attach time stays synchronous.
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

  /** Newly read bytes -> complete lines -> the consumer. Shared by the attach-time pass and the gate. */
  const deliver = (buf: Buffer): void => {
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

  // The pass at attach time. Synchronous on purpose, for now: `startAtEnd` has just fixed the offset
  // synchronously and a caller (the session watcher) reads its first line from here.
  const tickSync = () => {
    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      return
    }

    // Nothing new. (A file that shrank in the instant between startAtEnd's stat and this one is
    // caught by the next pass, tickAsync, which resets the offset.)
    if (stats.size <= offset) return

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
    deliver(buf)
  }

  // Everything after attach: the same read, off the main thread. The gate never starts one while the
  // previous is still awaiting the disk.
  const tickAsync = async (): Promise<void> => {
    // (No `stopped` check up here: stop() disposes the gate first, so the gate never starts a pass on
    // a stopped tail. The checks below are for a stop() that lands while a pass is awaiting the disk.)
    let size: number
    try {
      size = (await fs.promises.stat(filePath)).size
    } catch {
      return
    }
    if (stopped) return

    // File truncated / rotated — reset
    if (size < offset) {
      offset = 0
      leftover = ''
    }

    if (size === offset) return

    const toRead = Math.min(size - offset, MAX_READ_BYTES)
    let buf: Buffer
    let got: number
    try {
      const handle = await fs.promises.open(filePath, 'r')
      try {
        buf = Buffer.alloc(toRead)
        got = (await handle.read(buf, 0, toRead, offset)).bytesRead
      } finally {
        await handle.close()
      }
    } catch {
      return // the offset only advances after a read that worked, so the next pass retries
    }
    if (stopped || got === 0) return

    offset += got
    deliver(got === toRead ? buf : buf.subarray(0, got))
  }

  const gate = createRunGate({
    mode: 'leading',
    windowMs: WATCH_MIN_INTERVAL_MS,
    label: `transcript ${path.basename(filePath)}`,
    log: (msg) => console.warn(msg),
    run: tickAsync,
  })

  // fs.watch for change events
  try {
    watcher = fs.watch(filePath, { persistent: false }, () => gate.note())
    watcher.on('error', () => {
      try { watcher?.close() } catch {}
      watcher = null
    })
  } catch {
    // Watch may fail if file doesn't exist — polling will pick it up
  }

  // Always run a slow poll as a safety net — fs.watch misses events on some platforms
  poller = setInterval(() => gate.poke(), POLL_INTERVAL_MS)

  // Immediate tick in case there's content
  tickSync()

  return {
    stop() {
      stopped = true
      gate.dispose()
      try { watcher?.close() } catch {}
      watcher = null
      if (poller) { clearInterval(poller); poller = null }
    },
  }
}
