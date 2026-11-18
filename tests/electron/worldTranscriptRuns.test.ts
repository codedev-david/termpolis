import * as fsp from 'fs/promises'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { MAX_TRANSCRIPTS, MAX_TRANSCRIPT_BYTES, cleanTranscriptFiles, readTranscriptRuns, tailOfFile } from '../../src/main/world/transcriptRuns'

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const ROOT = '/repo'
const NOW = Date.parse('2026-12-01T00:00:00Z')
const AT = Date.parse('2026-11-02T10:00:00.000Z')
const block = (file: string, ok: boolean): string =>
  JSON.stringify({
    timestamp: '2026-11-02T10:00:00.000Z',
    message: { content: [{ type: 'tool_result', content: ` ${ok ? 'PASS' : 'FAIL'} ${file}\n Tests  1 ${ok ? 'passed' : 'failed'} (1)` }] }
  })

describe('readTranscriptRuns', () => {
  it('reads and parses each file, with real runs in the result', async () => {
    const yielded = vi.fn(async () => undefined)
    const runs = await readTranscriptRuns(['a.jsonl', 'b.jsonl'], ROOT, {
      now: () => NOW,
      yieldNow: yielded,
      readTail: async (f) => (f === 'a.jsonl' ? block('src/a.test.ts', true) : block('src/b.test.ts', false))
    })
    expect(runs.length).toBeGreaterThan(0)
    expect(runs).toEqual([
      { file: 'src/a.test.ts', passed: true, at: AT, source: 'transcript' },
      { file: 'src/b.test.ts', passed: false, at: AT, source: 'transcript' }
    ])
    expect(yielded).toHaveBeenCalledTimes(2)
  })

  it('reads each tail with the 512 KB cap, skips unreadable files and survives a throwing read', async () => {
    expect(MAX_TRANSCRIPT_BYTES).toBe(512 * 1024)
    const readTail = vi.fn(async (f: string, max: number) => {
      if (f === 'gone.jsonl') return null
      if (f === 'boom.jsonl') throw new Error('x')
      expect(max).toBe(MAX_TRANSCRIPT_BYTES)
      return block('src/ok.test.ts', true)
    })
    const runs = await readTranscriptRuns(['gone.jsonl', 'boom.jsonl', 'ok.jsonl'], ROOT, { now: () => NOW, readTail })
    expect(runs.map((r) => r.file)).toEqual(['src/ok.test.ts'])
    expect(readTail).toHaveBeenCalledTimes(3)
  })

  it('uses the real tail reader and yield by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wtr-'))
    try {
      const f = join(dir, 's.jsonl')
      await writeFile(f, block('src/real.test.ts', true))
      const runs = await readTranscriptRuns([f], ROOT, { now: () => NOW })
      expect(runs).toEqual([{ file: 'src/real.test.ts', passed: true, at: AT, source: 'transcript' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('cleanTranscriptFiles', () => {
  it('keeps only jsonl paths, at most 20', () => {
    expect(cleanTranscriptFiles('x')).toEqual([])
    expect(cleanTranscriptFiles([1, '', 'a.txt', 'a\0.jsonl', 'x'.repeat(1100) + '.jsonl', 'ok.jsonl'])).toEqual(['ok.jsonl'])
    expect(cleanTranscriptFiles(Array.from({ length: 30 }, (_, i) => `f${i}.jsonl`))).toHaveLength(MAX_TRANSCRIPTS)
  })
})

describe('tailOfFile', () => {
  it('reads only the last bytes of a file, whole when small, null when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wtr-'))
    try {
      const f = join(dir, 't.jsonl')
      await writeFile(f, 'abcdef')
      expect(await tailOfFile(f, 3)).toBe('def')
      expect(await tailOfFile(f, 100)).toBe('abcdef')
      expect(await tailOfFile(join(dir, 'none'), 10)).toBeNull()
      const real = await vi.importActual<typeof import('fs/promises')>('fs/promises')
      vi.mocked(fsp.open).mockImplementationOnce((async (...args: Parameters<typeof real.open>) => {
        const h = await real.open(...args)
        const close = h.close.bind(h)
        h.close = async () => {
          await close()
          throw new Error('close failed')
        }
        return h
      }) as never)
      expect(await tailOfFile(f, 3)).toBe('def')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
