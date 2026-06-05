import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import {
  isIndexableCodeFile,
  chunkCode,
  ingestCode,
  discoverRepoFiles,
  runCodeIngest,
  type CodeChunk,
  type CodeIngestDeps,
  type CodeIngestMemory,
} from '../../src/main/codeIngest'

describe('isIndexableCodeFile', () => {
  it('indexes normal source files', () => {
    expect(isIndexableCodeFile('src/main/index.ts')).toBe(true)
    expect(isIndexableCodeFile('/abs/path/foo.py')).toBe(true)
  })

  it('skips secret files (reuses the sensitive-file denylist)', () => {
    expect(isIndexableCodeFile('.env')).toBe(false)
    expect(isIndexableCodeFile('/home/u/.ssh/id_rsa')).toBe(false)
    expect(isIndexableCodeFile('secrets/server.pem')).toBe(false)
  })

  it('skips binaries, minified bundles, and lockfiles', () => {
    expect(isIndexableCodeFile('assets/icon.png')).toBe(false)
    expect(isIndexableCodeFile('dist/app.min.js')).toBe(false)
    expect(isIndexableCodeFile('package-lock.json')).toBe(false)
  })

  it('rejects empty / non-string', () => {
    expect(isIndexableCodeFile('')).toBe(false)
    expect(isIndexableCodeFile(undefined as unknown as string)).toBe(false)
  })
})

describe('chunkCode', () => {
  it('splits into line-windows prefixed with path:lines', () => {
    const content = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join('\n')
    const chunks = chunkCode('a/b.ts', content, { maxLines: 50 })
    expect(chunks.length).toBe(3) // 130 → 50 / 50 / 30
    expect(chunks[0].text.startsWith('a/b.ts:1-50\n')).toBe(true)
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(50)
    expect(chunks[2].endLine).toBe(130)
    expect(chunks[0].hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('skips blank windows and returns [] for empty/oversized', () => {
    expect(chunkCode('f.ts', '')).toEqual([])
    expect(chunkCode('f.ts', '\n\n\n', { maxLines: 2 })).toEqual([])
    expect(chunkCode('f.ts', 'x'.repeat(1000), { maxFileBytes: 100 })).toEqual([])
  })

  it('produces stable, content-derived hashes', () => {
    const a = chunkCode('f.ts', 'const x=1\nconst y=2')[0].hash
    const b = chunkCode('f.ts', 'const x=1\nconst y=2')[0].hash
    const c = chunkCode('f.ts', 'const x=9\nconst y=2')[0].hash
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })
})

describe('ingestCode', () => {
  const ts = 'export const a = 1\nexport const b = 2'

  it('writes new chunks, skips sensitive/binary files, and dedups', async () => {
    const seen = new Set<string>()
    const written: CodeChunk[] = []
    const deps: CodeIngestDeps = {
      listFiles: async () => ['src/a.ts', '.env', 'logo.png', 'src/b.ts'],
      readFile: async () => ts,
      hasHash: (h) => seen.has(h),
      write: async (c) => { seen.add(c.hash); written.push(c) },
      chunkOptions: { maxLines: 100 },
    }
    const s1 = await ingestCode(deps)
    expect(s1.filesScanned).toBe(2) // a.ts + b.ts
    expect(s1.filesSkipped).toBe(2) // .env + logo.png
    expect(s1.chunksWritten).toBe(2) // same content, different path → distinct hashes

    const s2 = await ingestCode(deps) // idempotent re-run
    expect(s2.chunksWritten).toBe(0)
    expect(s2.chunksSkipped).toBe(2)
  })

  it('returns zeroed stats when listFiles throws', async () => {
    const s = await ingestCode({
      listFiles: async () => { throw new Error('no git') },
      readFile: async () => '',
      hasHash: () => false,
      write: async () => {},
    })
    expect(s).toEqual({ filesScanned: 0, filesSkipped: 0, chunksWritten: 0, chunksSkipped: 0, truncated: false })
  })

  it('tolerates a readFile error and a write error', async () => {
    const deps: CodeIngestDeps = {
      listFiles: async () => ['ok.ts', 'bad.ts'],
      readFile: async (fp) => { if (fp === 'bad.ts') throw new Error('read'); return ts },
      hasHash: () => false,
      write: async () => { throw new Error('write') },
    }
    const s = await ingestCode(deps)
    expect(s.filesScanned).toBe(1) // only ok.ts read successfully
    expect(s.chunksWritten).toBe(0) // write throws
  })

  it('yields to the event loop between embeds so a bulk index cannot freeze the UI', async () => {
    const yieldSpy = vi.fn(async () => {})
    // 5 short files → 5 chunks → 5 writes → 5 yields (yieldEvery defaults to 1).
    const deps: CodeIngestDeps = {
      listFiles: async () => ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      readFile: async () => 'export const x = 1',
      hasHash: () => false,
      write: async () => {},
      yield: yieldSpy,
      chunkOptions: { maxLines: 100 },
    }
    const s = await ingestCode(deps)
    expect(s.chunksWritten).toBe(5)
    expect(yieldSpy).toHaveBeenCalledTimes(5)
  })

  it('honors yieldEvery (one breather per N writes)', async () => {
    const yieldSpy = vi.fn(async () => {})
    const deps: CodeIngestDeps = {
      listFiles: async () => ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      readFile: async () => 'export const x = 1',
      hasHash: () => false,
      write: async () => {},
      yield: yieldSpy,
      yieldEvery: 2,
      chunkOptions: { maxLines: 100 },
    }
    const s = await ingestCode(deps)
    expect(s.chunksWritten).toBe(5)
    expect(yieldSpy).toHaveBeenCalledTimes(2) // writes 2 and 4
  })

  it('stops at maxChunks and reports truncated (backlog for the next pass)', async () => {
    const written: CodeChunk[] = []
    const deps: CodeIngestDeps = {
      listFiles: async () => ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      readFile: async () => 'export const x = 1',
      hasHash: () => false,
      write: async (c) => { written.push(c) },
      maxChunks: 3,
      chunkOptions: { maxLines: 100 },
    }
    const s = await ingestCode(deps)
    expect(s.chunksWritten).toBe(3)
    expect(s.truncated).toBe(true)
    expect(written).toHaveLength(3) // it really stopped — didn't embed the rest
  })

  it('default real yield path completes without an injected yield', async () => {
    const deps: CodeIngestDeps = {
      listFiles: async () => ['a.ts'],
      readFile: async () => 'export const x = 1',
      hasHash: () => false,
      write: async () => {},
    }
    const s = await ingestCode(deps) // exercises the setImmediate default
    expect(s.chunksWritten).toBe(1)
    expect(s.truncated).toBe(false)
  })
})

describe('discoverRepoFiles + runCodeIngest (real git)', () => {
  it('lists git-tracked files of this repo', async () => {
    const files = await discoverRepoFiles(process.cwd())
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((f) => f.endsWith('package.json'))).toBe(true)
  })

  it('returns [] for empty root and a non-repo dir', async () => {
    expect(await discoverRepoFiles('')).toEqual([])
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'))
    try {
      expect(await discoverRepoFiles(tmp)).toEqual([])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('indexes a tiny git repo end-to-end and never indexes .env', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ingest-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      fs.writeFileSync(path.join(root, 'a.ts'), 'export const x = 1\n')
      fs.writeFileSync(path.join(root, '.env'), 'SECRET=abc\n') // must be skipped
      execFileSync('git', ['add', '-A'], { cwd: root })

      const seen = new Set<string>()
      const writes: Parameters<CodeIngestMemory['write']>[0][] = []
      const memory: CodeIngestMemory = {
        hasHash: (h) => seen.has(h),
        write: async (i) => { seen.add(i.hash); writes.push(i); return undefined },
      }
      const stats = await runCodeIngest(memory, { repoRoot: root })
      expect(stats.chunksWritten).toBeGreaterThan(0)
      expect(writes.every((w) => w.source === 'code' && w.agentId === 'code-index')).toBe(true)
      expect(writes.some((w) => w.content.includes('SECRET=abc'))).toBe(false) // .env never embedded
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
