import * as fs from 'fs'
import * as path from 'path'
import { createRunGate, WATCH_MIN_INTERVAL_MS } from '../watchGuard'
import { openSheddingWatch, type ShedFsWatcher, type ShedFsWatchFn } from '../shedWatch'

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
 * code path. Nothing here is synchronous, the pass at attach time included.
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
  let watcher: ShedFsWatcher | null = null
  let poller: ReturnType<typeof setInterval> | null = null

  // The offset a tail starts from: the end of the file when asked, else its first byte. Fixed on the thread pool,
  // before the first read: attaching to a transcript used to stat and read it on the main thread.
  const ready: Promise<void> = (async () => {
    if (!opts.startAtEnd) return
    try {
      offset = (await fs.promises.stat(filePath)).size
    } catch {
      // File may not exist yet — start at 0, the first pass will handle it
    }
  })()

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

  // Every pass, the first at attach time included, runs on the thread pool. The gate never starts one while the
  // previous is still awaiting the disk.
  const tickAsync = async (): Promise<void> => {
    await ready
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
    // (No log here: the shedding watch below caps what reaches this gate at 200 events a second, which is not
    // a flood to the gate, so it has nothing to say; the shedding watch logs its own closing.)
    run: tickAsync,
  })

  // fs.watch for change events. A shedding watch: a transcript that is written to hundreds of times a second
  // (every event costs the main thread about a millisecond and a half) is not listened to for a while, and the
  // poll below reads it anyway, at most once per window as it always did. On reopening the gate is told once.
  try {
    watcher = openSheddingWatch(fs.watch as unknown as ShedFsWatchFn, filePath, { persistent: false }, () => gate.note(), {
      label: `transcript ${path.basename(filePath)}`,
      log: (msg) => console.warn(msg),
      onResume: () => gate.note(),
    })
    watcher.on?.('error', () => {
      try { watcher?.close() } catch {}
      watcher = null
    })
  } catch {
    // Watch may fail if file doesn't exist — polling will pick it up
  }

  // Always run a slow poll as a safety net — fs.watch misses events on some platforms
  poller = setInterval(() => gate.poke(), POLL_INTERVAL_MS)

  // Immediate pass in case there's content (the gate's leading edge: it runs at once, off the main thread)
  gate.poke()

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
