import { describe, it, expect, vi, afterAll } from 'vitest'
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
  repoListingNotes,
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

  it('after a prune, re-asks the store: a chunk the prune left (or a failing prune) is skipped, the rest rewritten', async () => {
    const file = Array.from({ length: 6 }, (_, i) => `export const v${i} = ${i}`).join('\n')
    const written: CodeChunk[] = []
    const kept = new Set<string>()
    let asks = 0
    const deps: CodeIngestDeps = {
      listFiles: async () => ['src/a.ts'],
      readFile: async () => file,
      // First ask: nothing known (the file changed). After the prune: the store still holds the first chunk.
      hasHashes: (hashes) => (++asks === 1 ? [] : hashes.filter((h) => kept.has(h))),
      write: async (c) => { written.push(c) },
      prunePath: async () => { throw new Error('store busy') },
      chunkOptions: { maxLines: 2 },
    }
    const chunks = chunkCode('src/a.ts', file, { maxLines: 2 })
    kept.add(chunks[0].hash)
    const s = await ingestCode(deps)
    expect(asks).toBe(2)
    expect(s.chunksSkipped).toBe(1)
    expect(s.chunksWritten).toBe(chunks.length - 1)
    expect(written.map((c) => c.hash)).toEqual(chunks.slice(1).map((c) => c.hash))
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

// Fixture git runs with no global or system config, so a developer's hooks path, templates or commit template never run.
const gitConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-cfg-'))
fs.writeFileSync(path.join(gitConfigDir, 'empty'), '')
const hermeticEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(gitConfigDir, 'empty'), GIT_CONFIG_NOSYSTEM: '1' }
afterAll(() => fs.rmSync(gitConfigDir, { recursive: true, force: true }))
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], { cwd, stdio: 'ignore', env: hermeticEnv })
}
const write = (root: string, rel: string, text = 'export const x = 1\n'): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
const relTo = (root: string, files: string[]): string[] => files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort()

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

  it('lists untracked files the ignore files allow, and names outside ASCII as written', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-'))
    try {
      git(root, 'init', '-q')
      fs.writeFileSync(path.join(root, '.gitignore'), 'skipped/\n')
      fs.writeFileSync(path.join(root, 'tracked.ts'), 'export const a = 1\n')
      git(root, 'add', '-A')
      fs.writeFileSync(path.join(root, 'new.ts'), 'export const b = 1\n')
      fs.writeFileSync(path.join(root, 'café.ts'), 'export const c = 1\n')
      fs.mkdirSync(path.join(root, 'skipped'))
      fs.writeFileSync(path.join(root, 'skipped', 'x.ts'), 'export const d = 1\n')
      const rel = (await discoverRepoFiles(root)).map((f) => path.relative(root, f).split(path.sep).join('/')).sort()
      expect(rel).toEqual(['.gitignore', 'café.ts', 'new.ts', 'tracked.ts'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('recurses into submodules: their files are listed, the submodule folder itself is not', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-sub-'))
    try {
      const lib = path.join(base, 'lib')
      fs.mkdirSync(lib)
      git(lib, 'init', '-q')
      fs.writeFileSync(path.join(lib, 'util.ts'), 'export const u = 1\n')
      git(lib, 'add', '-A')
      git(lib, 'commit', '-q', '-m', 'lib')
      const root = path.join(base, 'app')
      fs.mkdirSync(root)
      git(root, 'init', '-q')
      fs.writeFileSync(path.join(root, 'main.ts'), 'export const m = 1\n')
      git(root, 'submodule', 'add', '-q', lib, 'libs/shared')
      const rel = (await discoverRepoFiles(root)).map((f) => path.relative(root, f).split(path.sep).join('/')).sort()
      expect(rel).toEqual(['.gitmodules', 'libs/shared/util.ts', 'main.ts'])
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('never lists or ingests untracked dependency folders and virtual environments the ignore files miss', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-vendored-'))
    try {
      git(root, 'init', '-q')
      // A root-only rule: the workspace package's own node_modules is not covered.
      write(root, '.gitignore', '/node_modules\n')
      write(root, 'src/app.ts')
      git(root, 'add', '-A')
      write(root, 'packages/x/node_modules/dep/index.js', 'export const DEPENDENCY_CODE = 1\n')
      write(root, 'packages/x/index.ts')
      // An older python -m venv writes no .gitignore inside.
      write(root, '.venv/pyvenv.cfg', 'home = /usr/bin\n')
      write(root, '.venv/lib/site.py', 'VENV_CODE = 1\n')
      write(root, 'env/pyvenv.cfg', 'home = /usr/bin\n')
      write(root, 'env/lib/other.py', 'VENV_CODE = 2\n')
      write(root, '.tox/py311/lib/t.py', 'VENV_CODE = 3\n')
      expect(relTo(root, await discoverRepoFiles(root))).toEqual(['.gitignore', 'packages/x/index.ts', 'src/app.ts'])

      const writes: string[] = []
      await runCodeIngest({ hasHash: () => false, write: async (i) => { writes.push(i.content); return undefined } }, { repoRoot: root })
      expect(writes.length).toBeGreaterThan(0)
      expect(writes.some((w) => w.includes('DEPENDENCY_CODE') || w.includes('VENV_CODE'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists a nested repository that is not a submodule with its own git, under the same rules', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-nested-'))
    try {
      git(root, 'init', '-q')
      write(root, 'src/app.ts')
      git(root, 'add', '-A')
      const sdk = path.join(root, 'tools', 'sdk')
      fs.mkdirSync(sdk, { recursive: true })
      git(sdk, 'init', '-q')
      write(sdk, 'index.ts')
      git(sdk, 'add', '-A')
      git(sdk, 'commit', '-q', '-m', 'sdk')
      write(sdk, 'new.ts')
      write(sdk, 'node_modules/dep/index.js')
      expect(relTo(root, await discoverRepoFiles(root))).toEqual(['src/app.ts', 'tools/sdk/index.ts', 'tools/sdk/new.ts'])
      expect(repoListingNotes(root)).toEqual({ capped: false, unreadable: [] })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('finds a submodule from the repository top when the folder mapped is a subfolder', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-subfolder-'))
    try {
      const lib = path.join(base, 'lib')
      fs.mkdirSync(lib)
      git(lib, 'init', '-q')
      write(lib, 'util.ts')
      git(lib, 'add', '-A')
      git(lib, 'commit', '-q', '-m', 'lib')
      const root = path.join(base, 'app')
      fs.mkdirSync(root)
      git(root, 'init', '-q')
      write(root, 'services/a.ts')
      git(root, 'submodule', 'add', '-q', lib, 'services/vendor-lib')
      const services = path.join(root, 'services')
      expect(relTo(services, await discoverRepoFiles(services))).toEqual(['a.ts', 'vendor-lib/util.ts'])
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('indexes a tiny git repo end-to-end and never indexes .env', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ingest-'))
    try {
      git(root, 'init', '-q')
      fs.writeFileSync(path.join(root, 'a.ts'), 'export const x = 1\n')
      fs.writeFileSync(path.join(root, '.env'), 'SECRET=abc\n') // must be skipped
      git(root, 'add', '-A')

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

  it('tags code chunks with the repo project slug', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ingest-proj-'))
    try {
      git(root, 'init', '-q')
      fs.writeFileSync(path.join(root, 'a.ts'), 'export const x = 1\n')
      git(root, 'add', '-A')

      const writes: Parameters<CodeIngestMemory['write']>[0][] = []
      const memory: CodeIngestMemory = {
        hasHash: () => false,
        write: async (i) => { writes.push(i); return undefined },
      }
      await runCodeIngest(memory, { repoRoot: root })
      expect(writes.length).toBeGreaterThan(0)
      expect(writes.every((w) => w.project === root)).toBe(true) // raw repoRoot at the adapter; the store normalizes to a slug
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
