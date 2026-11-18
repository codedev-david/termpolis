// Test runs read from agent transcripts. This runs in the world host (a utility process): main only says
// which files to read, and the host reads the tail of each one asynchronously, parses it and yields to the
// event loop between files, so a 20-file refresh never holds one long synchronous block. No Electron imports.

import * as fsp from 'node:fs/promises'
import type { TestRun } from './testStatus'
import { parseTranscriptTestRuns } from './testStatus'

/** Transcript files read per project: the newest ones. */
export const MAX_TRANSCRIPTS = 20
/** The last bytes of a transcript that are read (a transcript can run to hundreds of MB; its newest part is what matters). */
export const MAX_TRANSCRIPT_BYTES = 512 * 1024
/** How long one project's transcript runs are reused (a watcher recompile can come every few seconds). */
export const TRANSCRIPT_CACHE_MS = 20_000

/** The last `maxBytes` of a file as text, read asynchronously; null when it cannot be read. A cut can start mid-line: the parser skips a line that does not parse. */
export async function tailOfFile(path: string, maxBytes: number): Promise<string | null> {
  let handle
  try {
    handle = await fsp.open(path, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, size - length)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Main's list of transcript files, checked: JSONL file paths only, at most MAX_TRANSCRIPTS. */
export function cleanTranscriptFiles(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const f of v) {
    if (out.length === MAX_TRANSCRIPTS) break
    if (typeof f === 'string' && f.length > 0 && f.length < 1024 && f.endsWith('.jsonl') && !f.includes('\0')) out.push(f)
  }
  return out
}

export interface TranscriptReadDeps {
  readTail?: (path: string, maxBytes: number) => Promise<string | null>
  now: () => number
  /** Lets the event loop run between two files. */
  yieldNow?: () => Promise<void>
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** The test runs the transcript files hold, read and parsed one file at a time. */
export async function readTranscriptRuns(files: string[], root: string, d: TranscriptReadDeps): Promise<TestRun[]> {
  const readTail = d.readTail ?? tailOfFile
  const wait = d.yieldNow ?? defaultYield
  const runs: TestRun[] = []
  for (const file of files) {
    try {
      const text = await readTail(file, MAX_TRANSCRIPT_BYTES)
      if (text !== null) runs.push(...parseTranscriptTestRuns(text, root, d.now()))
    } catch {
      // unreadable: the runs found so far stand
    }
    await wait()
  }
  return runs
}
