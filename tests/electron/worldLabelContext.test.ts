import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  codeNameOf,
  createLabelContext,
  fsReadDir,
  fsReadHead,
  MAX_DOC_BYTES,
  MAX_DOC_FILES,
  MAX_SCAN_DIRS,
  memoryForLabels,
  type DirEntry,
  type LabelContextDeps
} from '../../src/main/world/labelContext'

const none = async (): Promise<never[]> => []
const noGit = async (): Promise<string> => ''

function fakeTree(files: Record<string, string>): Pick<LabelContextDeps, 'readDir' | 'readHead'> {
  return {
    readDir: async (dir) => {
      const prefix = dir === '/r' ? '' : `${dir.slice(3)}/`
      const seen = new Map<string, DirEntry>()
      for (const f of Object.keys(files)) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        const i = rest.indexOf('/')
        const name = i < 0 ? rest : rest.slice(0, i)
        seen.set(name, { name, dir: i >= 0 })
      }
      if (seen.size === 0) throw new Error('ENOENT')
      return [...seen.values()]
    },
    readHead: async (file) => files[file.slice(3)] ?? null
  }
}

describe('codeNameOf', () => {
  it('is the shared folder, else the first file name', () => {
    expect(codeNameOf(['src/main/world/a.ts', 'src/main/world/b.ts'])).toBe('world')
    expect(codeNameOf(['src/main/a.ts', 'src/renderer/b.ts'])).toBe('src')
    expect(codeNameOf(['a/x.ts', 'b/y.ts'])).toBe('x')
    expect(codeNameOf(['index.ts'])).toBe('index')
    expect(codeNameOf(['Makefile'])).toBe('Makefile')
  })
})

describe('createLabelContext', () => {
  it('returns commits, docs lines and memory decisions, each capped, in the brief shapes', async () => {
    const git = vi.fn(async () => 'abcdef123\tfirst subject\n1234567\tsecond\nbad line\n\tno sha\nabc\t\n\n')
    const memory = vi.fn(async () => [
      { id: 'm1', text: '  chose IPC  ' },
      { id: 'm2', text: 'two' },
      { id: 'm3', text: 'three' },
      { id: 'm4', text: 'four' }
    ])
    const tree = fakeTree({
      'README.md': 'intro\nthe worker.ts file does work\nmore',
      'docs/a.md': 'nothing here\r\nworker handles jobs  ' + 'z'.repeat(400),
      'docs/b.md': 'workerish is not a whole word',
      'docs/c.md': 'worker again',
      'docs/d.md': 'worker the fourth',
      'docs/e.txt': 'worker in text',
      'node_modules/pkg/x.md': 'worker in deps',
      'src/code.ts': 'worker'
    })
    const ctx = createLabelContext({ git, memory, ...tree })
    const ev = await ctx('/r', ['src/a/worker.ts', 'src/a/b.ts', 'src/a/c.ts', 'src/a/d.ts'])
    expect(git).toHaveBeenCalledWith(['log', '-n', '5', '--format=%h%x09%s', '--', 'src/a/worker.ts', 'src/a/b.ts', 'src/a/c.ts'], '/r')
    expect(memory).toHaveBeenCalledWith('a', '/r')
    expect(ev.filter((e) => e.kind === 'commit')).toEqual([
      { kind: 'commit', ref: 'abcdef1', excerpt: 'first subject' },
      { kind: 'commit', ref: '1234567', excerpt: 'second' }
    ])
    const docs = ev.filter((e) => e.kind === 'file')
    expect(docs.map((e) => e.ref)).toEqual(['README.md:2', 'docs/a.md:2', 'docs/c.md:1'])
    expect(docs[0].excerpt).toBe('the worker.ts file does work')
    expect(docs[1].excerpt).toHaveLength(300)
    expect(ev.filter((e) => e.kind === 'memory')).toEqual([
      { kind: 'memory', ref: 'm1', excerpt: 'chose IPC' },
      { kind: 'memory', ref: 'm2', excerpt: 'two' },
      { kind: 'memory', ref: 'm3', excerpt: 'three' }
    ])
  })

  it('drops blank memory text', async () => {
    const ctx = createLabelContext({ git: noGit, memory: async () => [{ id: 'm5', text: '   ' }], ...fakeTree({ 'a.md': 'x' }) })
    expect(await ctx('/r', ['src/zzzz.ts'])).toEqual([])
  })

  it('a git or memory failure gives no evidence of that kind, never an error', async () => {
    const ctx = createLabelContext({
      git: async () => Promise.reject(new Error('not a repo')),
      memory: async () => Promise.reject(new Error('locked')),
      ...fakeTree({ 'a.md': 'x' })
    })
    expect(await ctx('/r', ['src/zzzz.ts'])).toEqual([])
    expect(await ctx('/r', [])).toEqual([])
  })

  it('skips generic and short names and matches case-sensitively as a whole word', async () => {
    const tree = fakeTree({ 'a.md': 'index main utils ab\nScanner scanner.\nre.gex(s) here' })
    const ctx = createLabelContext({ git: noGit, memory: none, ...tree })
    expect((await ctx('/r', ['x/index.ts', 'x/ab.ts'])).filter((e) => e.kind === 'file')).toEqual([])
    expect((await ctx('/r', ['x/scanner.ts'])).filter((e) => e.kind === 'file').map((e) => e.ref)).toEqual(['a.md:2'])
    expect((await ctx('/r', ['x/Scan.ts'])).filter((e) => e.kind === 'file')).toEqual([])
    expect((await ctx('/r', ['x/re.gex.ts'])).filter((e) => e.kind === 'file').map((e) => e.ref)).toEqual(['a.md:3'])
  })

  it('scans docs once per root within the cache window, and again after it', async () => {
    let t = 0
    const tree = fakeTree({ 'a.md': 'worker' })
    const readDir = vi.fn(tree.readDir as NonNullable<LabelContextDeps['readDir']>)
    const ctx = createLabelContext({ git: noGit, memory: none, readDir, readHead: tree.readHead, now: () => t })
    await Promise.all([ctx('/r', ['x/worker.ts']), ctx('/r', ['y/worker.ts'])])
    expect(readDir).toHaveBeenCalledTimes(1)
    t = 31_000
    await ctx('/r', ['x/worker.ts'])
    expect(readDir).toHaveBeenCalledTimes(2)
  })

  it('stops at the file and directory caps, skips unreadable files and directories', async () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < MAX_DOC_FILES + 20; i++) many[`f${String(i).padStart(4, '0')}.md`] = 'worker'
    const readHead = vi.fn(async (f: string) => (f.endsWith('f0000.md') ? null : 'worker'))
    const ctx1 = createLabelContext({ git: noGit, memory: none, readDir: fakeTree(many).readDir, readHead })
    await ctx1('/r', ['x/worker.ts'])
    expect(readHead).toHaveBeenCalledTimes(MAX_DOC_FILES + 1)

    const deep = vi.fn(async (): Promise<DirEntry[]> => [{ name: 'd', dir: true }])
    const ctx2 = createLabelContext({ git: noGit, memory: none, readDir: deep, readHead: async () => null })
    await ctx2('/r', ['x/worker.ts'])
    expect(deep).toHaveBeenCalledTimes(MAX_SCAN_DIRS)

    const ctx3 = createLabelContext({ git: noGit, memory: none, readDir: async () => Promise.reject(new Error('EACCES')), readHead: async () => null })
    expect(await ctx3('/r', ['x/worker.ts'])).toEqual([])
  })

  it('a docs reader that throws costs only the docs', async () => {
    const ctx = createLabelContext({
      git: async () => 'abc1234\tsubject',
      memory: none,
      readDir: async () => [{ name: 'a.md', dir: false }],
      readHead: async () => Promise.reject(new Error('boom'))
    })
    expect(await ctx('/r', ['x/worker.ts'])).toEqual([{ kind: 'commit', ref: 'abc1234', excerpt: 'subject' }])
  })

  it('gives up after the timeout with no evidence', async () => {
    vi.useFakeTimers()
    try {
      const ctx = createLabelContext({ git: () => new Promise(() => undefined), memory: none, ...fakeTree({}), timeoutMs: 50 })
      const p = ctx('/r', ['x/worker.ts'])
      await vi.advanceTimersByTimeAsync(60)
      expect(await p).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the real file readers', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'world-ctx-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('list real files and folders only, and read at most the byte cap', async () => {
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'a.md'), 'x'.repeat(MAX_DOC_BYTES + 500))
    await writeFile(join(dir, 'b.md'), 'héllo')
    try {
      await symlink(join(dir, 'a.md'), join(dir, 'link.md'))
    } catch {
      // symlinks need a privilege on Windows; the filter is covered where they exist
    }
    const entries = (await fsReadDir(dir)).sort((a, z) => a.name.localeCompare(z.name))
    expect(entries.filter((e) => e.name !== 'link.md')).toEqual([
      { name: 'a.md', dir: false },
      { name: 'b.md', dir: false },
      { name: 'sub', dir: true }
    ])
    expect(entries.find((e) => e.name === 'link.md')).toBeUndefined()
    expect(await fsReadHead(join(dir, 'a.md'), MAX_DOC_BYTES)).toHaveLength(MAX_DOC_BYTES)
    expect(await fsReadHead(join(dir, 'b.md'), MAX_DOC_BYTES)).toBe('héllo')
    expect(await fsReadHead(join(dir, 'missing.md'), 10)).toBeNull()
  })
  it('a context built with no readers reads the real folder', async () => {
    await writeFile(join(dir, 'notes.md'), 'The Scanner walks the tree.')
    const ctx = createLabelContext({ git: noGit, memory: none })
    expect((await ctx(dir, ['src/Scanner.ts'])).filter((e) => e.kind === 'file').map((e) => e.ref)).toEqual(['notes.md:1'])
  })
})

describe('memory scoped to the project', () => {
  it('asks memory for decisions scoped to the world root', async () => {
    const memory = vi.fn(async (_q: string, _r: string) => [{ id: 'm1', text: 'Use SQLite' }])
    await createLabelContext({ git: noGit, memory, ...fakeTree({}) })('C:/repos/demo', ['src/db/store.ts'])
    expect(memory).toHaveBeenCalledWith(expect.any(String), 'C:/repos/demo')
  })

  it('memoryForLabels searches decisions in the given project only', async () => {
    const search = vi.fn(async (_o: { query: string; limit: number; kind: 'decision'; project: string }) => [{ id: 'd1', content: 'x' }])
    expect(await memoryForLabels(search)('store', 'C:/repos/demo')).toEqual([{ id: 'd1', text: 'x' }])
    expect(search).toHaveBeenCalledWith({ query: 'store', limit: 3, kind: 'decision', project: 'C:/repos/demo' })
  })
})
