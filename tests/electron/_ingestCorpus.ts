// An in-memory transcript folder for the ingest-pass tests: fake files with sizes and mtimes, counters on
// every call the ingest loop makes (stat, read, head read, hash question, write), and a fake store.
// Synthetic only. Nothing touches the disk, so a "read" here is exactly one call to deps.readFile.

import type { IngestChunk, IngestDeps } from '../../src/main/conversationIngest'
import type { WatermarkIO } from '../../src/main/ingestWatermark'
import { prose } from './_ingestGolden'
import { assistantLine, lines, userLine } from './_transcriptFixture'

export const MIB = 1024 * 1024

export interface FakeFile {
  content: string
  size: number
  mtimeMs: number
}

/** A watermark file in memory, counting what is done to it. */
export function memoryIO(initial: string | null = null): WatermarkIO & { text: string | null; reads: number; writes: number } {
  const io = {
    text: initial,
    reads: 0,
    writes: 0,
    async read(): Promise<string | null> {
      io.reads++
      return io.text
    },
    async write(text: string): Promise<void> {
      io.writes++
      io.text = text
    },
  }
  return io
}

/** The lines of one small session: `pairs` user+assistant turns of distinct, deterministic text. */
export function sessionText(id: number | string, pairs = 3, size = 400): string {
  const out: string[] = []
  for (let i = 0; i < pairs; i++) {
    out.push(userLine(`ask ${id}/${i}: ${prose(size, i + Number(String(id).length))}`, { sessionId: `sess-${id}`, cwd: '/r' }))
    out.push(assistantLine(`answer ${id}/${i}: ${prose(size, i + 5)}`))
  }
  return lines(...out)
}

export function corpus(base = 1_000_000) {
  const files = new Map<string, FakeFile>()
  const reads: string[] = []
  const heads: string[] = []
  const stats: string[] = []
  const known = new Set<string>()
  const written: IngestChunk[] = []
  const hashAsks: string[][] = []
  const hooks: { onRead?: (path: string) => void; writeFails?: (chunk: IngestChunk) => boolean; readFails?: (path: string) => boolean } = {}
  let version = 0

  const api = {
    files,
    reads,
    heads,
    stats,
    known,
    written,
    hashAsks,
    hooks,
    /** Add (or replace) a file. `size` defaults to the content's own length (override it to model a big one). */
    add(path: string, content: string, size?: number): string {
      files.set(path, { content, size: size ?? Buffer.byteLength(content), mtimeMs: base + ++version })
      return path
    },
    /** Append text to a file: the size grows and the mtime moves, as a writer's appends do. */
    append(path: string, text: string): void {
      const f = files.get(path) as FakeFile
      const content = f.content + text
      files.set(path, { content, size: Buffer.byteLength(content), mtimeMs: base + ++version })
    },
    /** Same size, new mtime: touched, not changed. */
    touch(path: string): void {
      const f = files.get(path) as FakeFile
      files.set(path, { ...f, mtimeMs: base + ++version })
    },
    clearCounters(): void {
      reads.length = 0
      heads.length = 0
      stats.length = 0
      hashAsks.length = 0
      written.length = 0
    },
    deps(over: Partial<IngestDeps> = {}): IngestDeps {
      return {
        sources: ['claude'],
        listFiles: async () => [...files.keys()],
        readFile: async (p: string) => {
          reads.push(p)
          if (hooks.readFails?.(p)) throw new Error('EBUSY')
          const f = files.get(p)
          if (!f) throw new Error('ENOENT')
          const content = f.content
          hooks.onRead?.(p)
          return content
        },
        statFile: async (p: string) => {
          stats.push(p)
          const f = files.get(p)
          return f ? { size: f.size, mtimeMs: f.mtimeMs } : null
        },
        hasHashes: async (hs: string[]) => {
          hashAsks.push(hs)
          return hs.filter((h) => known.has(h))
        },
        write: async (chunk: IngestChunk) => {
          if (hooks.writeFails?.(chunk)) throw new Error('store refused')
          known.add(chunk.hash)
          written.push(chunk)
        },
        yield: async () => {},
        ...over,
      }
    },
  }
  return api
}
