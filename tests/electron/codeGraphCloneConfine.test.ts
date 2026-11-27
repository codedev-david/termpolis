// A Lumopolis clone (a folder under <userData>/world/repos) is someone else's content: a symlink committed to it
// must never lead the code graph, or the code memory, to a file outside the clone (Opus R2-I1 on b8ecec16). Every
// sweep index.ts starts over a project (memory:ingest-code, code-graph:build's buildGraphFor, and the file watcher's
// re-index, with its full re-sweep fallback) takes its listing and its reader from one place, graphSourceFor
// (codeGraphSource.ts sweepSourceFor), which confines both to the clone's folder, however the root is spelled (a link to
// the clone, a link inside it: Opus R3-m3, R3-n2). Counted here on a real git clone with a committed link out of it, and
// on index.ts's text.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildCodeGraph, codeGraphStats, codeGraphSweepCounters, codeSymbols, graphKeyForRoot, reindexPaths, reindexRepoGraph,
  reindexWatchedChange, _resetCodeGraphForTests,
} from '../../src/main/codeGraph'
import { discoverRepoFiles, runCodeIngest } from '../../src/main/codeIngest'
import { sweepSourceFor } from '../../src/main/codeGraphSource'
import { isCloneRoot } from '../../src/main/world/folderSafety'

let base = ''
let userData = ''
let root = ''
let linked = false

const git = (...args: string[]): void => {
  execFileSync('git', ['-C', root, '-c', 'core.symlinks=true', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'ignore' })
}
/** What index.ts's graphSourceFor hands a sweep of `r`: the listing and the reader, both confined for a clone. */
const sourceFor = (r: string) => sweepSourceFor(r, userData)
/** A folder link (a junction on Windows, which needs no rights), or false when this machine cannot make one. */
const dirLink = (target: string, at: string): boolean => {
  try {
    symlinkSync(target, at, 'junction')
    return true
  } catch {
    return false
  }
}

beforeEach(() => {
  _resetCodeGraphForTests()
  base = mkdtempSync(join(tmpdir(), 'cg-clone-'))
  userData = join(base, 'userData')
  root = join(userData, 'world', 'repos', 'x')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(base, 'outside'))
  writeFileSync(join(base, 'outside', 'out.ts'), 'export function outsideFn() { return 1 }\n')
  writeFileSync(join(root, 'src', 'in.ts'), 'export function insideFn() { return 1 }\n')
  linked = true
  try {
    symlinkSync(join(base, 'outside', 'out.ts'), join(root, 'src', 'leak.ts'), 'file')
  } catch {
    linked = false // Windows without developer mode or admin cannot make file links
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'x')
})
afterEach(() => {
  _resetCodeGraphForTests()
  rmSync(base, { recursive: true, force: true })
})

describe('a clone with a committed link out of it', () => {
  it('is a clone, and git lists the link as one of its files', async (ctx) => {
    if (!linked) ctx.skip()
    expect(isCloneRoot(userData, root)).toBe(true)
    const listed = await discoverRepoFiles(root, { confineTo: root })
    expect(listed.map((f) => f.replace(/\\/g, '/'))).toEqual(expect.arrayContaining([expect.stringMatching(/src\/leak\.ts$/), expect.stringMatching(/src\/in\.ts$/)]))
  })

  it('a full build of it leaves the linked file out', async (ctx) => {
    if (!linked) ctx.skip()
    await buildCodeGraph(sourceFor(root), graphKeyForRoot(root))
    expect(codeSymbols('insideFn', 10, graphKeyForRoot(root))).toHaveLength(1)
    expect(codeSymbols('outsideFn', 10, graphKeyForRoot(root))).toHaveLength(0)
  })

  it("the watcher's batch, and its full re-sweep fallback, use the reader and the listing they are handed", async (ctx) => {
    if (!linked) ctx.skip()
    const key = graphKeyForRoot(root)
    const src = sourceFor(root)
    let listings = 0
    const listFiles = (): Promise<string[]> => { listings++; return src.listFiles() }
    await reindexWatchedChange(root, ['src/leak.ts', 'src/in.ts'], src.readFile, undefined, listFiles)
    expect(listings).toBe(0) // a batch lists nothing
    expect(codeSymbols('outsideFn', 10, key)).toHaveLength(0)
    expect(codeSymbols('insideFn', 10, key)).toHaveLength(1)
    // An empty change set re-sweeps the project (reindexRepoGraph): with the reader handed in, not a plain one.
    await reindexWatchedChange(root, [], src.readFile, undefined, listFiles)
    expect(listings).toBe(1)
    expect(codeSymbols('outsideFn', 10, key)).toHaveLength(0)
    expect(codeGraphStats(key).files).toBe(1)
    // And the fallback when the incremental pass throws.
    await reindexWatchedChange(root, [42 as unknown as string], src.readFile, undefined, listFiles)
    expect(listings).toBe(2)
    expect(codeSymbols('outsideFn', 10, key)).toHaveLength(0)
    expect(codeSymbols('insideFn', 10, key)).toHaveLength(1)
  })

  it('reindexRepoGraph reads through the reader and lists through the listing it is handed', async () => {
    const reads: string[] = []
    await reindexRepoGraph(root, undefined, { listFiles: async () => ['/p/a.ts'], readFile: async (f) => { reads.push(f); return 'export function viaHanded() { return 1 }\n' } })
    expect(reads).toEqual(['/p/a.ts'])
    expect(codeSymbols('viaHanded', 10, graphKeyForRoot(root))).toHaveLength(1)
  })

  it("the code memory's ingest of it leaves the linked file out", async (ctx) => {
    if (!linked) ctx.skip()
    const written: string[] = []
    await runCodeIngest({ hasHashes: async () => [], write: async (c) => { written.push(c.content) } }, { repoRoot: root, source: sourceFor(root) })
    expect(written.some((c) => c.includes('insideFn'))).toBe(true)
    expect(written.some((c) => c.includes('outsideFn'))).toBe(false)
  })

  it('a folder in it that holds a .git link out of the clone is not taken for a repository of its own', async (ctx) => {
    if (!linked) ctx.skip()
    // An untracked folder whose `.git` leads out: discovery reads `.git` files (a worktree's pointer) and checks for
    // `.gitmodules`; confined, it takes neither from outside the clone.
    const outsideRepo = join(base, 'outsideRepo')
    mkdirSync(outsideRepo)
    execFileSync('git', ['-C', outsideRepo, 'init', '-q'], { stdio: 'ignore' })
    mkdirSync(join(root, 'lib')) // not "vendor": discovery skips a folder of that name anyway (repoFileList inSkippedPath)
    writeFileSync(join(root, 'lib', 'v.ts'), 'export function libFn() { return 1 }\n')
    let dirLinked = true
    try {
      symlinkSync(join(outsideRepo, '.git'), join(root, 'lib', '.git'), 'junction')
    } catch {
      dirLinked = false
    }
    if (!dirLinked) ctx.skip()
    const norm = (l: string[]): string[] => l.map((f) => f.replace(/\\/g, '/'))
    // Unconfined, the link makes lib a repository of its own, listed by its git (the outside one's).
    expect(norm(await discoverRepoFiles(root)).some((f) => f.endsWith('lib/v.ts'))).toBe(true)
    // Confined, its `.git` is outside the clone, so it is not one: nothing is listed through it.
    expect(norm(await discoverRepoFiles(root, { confineTo: root })).some((f) => f.includes('lib/'))).toBe(false)
    expect(norm(await sourceFor(root).listFiles()).some((f) => f.includes('lib/'))).toBe(false)
    // And the code memory's ingest of a clone lists it the same way.
    const written: string[] = []
    await runCodeIngest({ hasHashes: async () => [], write: async (c) => { written.push(c.content) } }, { repoRoot: root, source: sourceFor(root) })
    expect(written.some((c) => c.includes('insideFn'))).toBe(true)
    expect(written.some((c) => c.includes('libFn'))).toBe(false)
  })
})

describe('another spelling of a clone (Opus R3-m3, R3-n2; Codex r4 M1)', () => {
  it('a link to the clone is swept confined to it, as the clone is', async (ctx) => {
    if (!linked) ctx.skip()
    const alias = join(base, 'alias')
    if (!dirLink(root, alias)) ctx.skip()
    expect(isCloneRoot(userData, alias)).toBe(false) // the spelling alone does not say so
    await buildCodeGraph(sourceFor(alias), graphKeyForRoot(alias))
    expect(codeSymbols('insideFn', 10, graphKeyForRoot(alias))).toHaveLength(1)
    expect(codeSymbols('outsideFn', 10, graphKeyForRoot(alias))).toHaveLength(0)
    await expect(sourceFor(alias).readFile(join(alias, 'src', 'leak.ts'))).rejects.toThrow('outside the folder')
    // The code memory's ingest through the link the same.
    const written: string[] = []
    await runCodeIngest({ hasHashes: async () => [], write: async (c) => { written.push(c.content) } }, { repoRoot: alias, source: sourceFor(alias) })
    expect(written.some((c) => c.includes('insideFn'))).toBe(true)
    expect(written.some((c) => c.includes('outsideFn'))).toBe(false)
  })

  it('a clone reached through a link to the data folder is one too', async (ctx) => {
    if (!linked) ctx.skip()
    const linkedData = join(base, 'dataLink')
    if (!dirLink(userData, linkedData)) ctx.skip()
    // The data folder named through the link, the root through its real path (git's toplevel, links resolved).
    await expect(sweepSourceFor(root, linkedData).readFile(join(root, 'src', 'leak.ts'))).rejects.toThrow('outside the folder')
    await expect(sweepSourceFor(root, linkedData).readFile(join(root, 'src', 'in.ts'))).resolves.toContain('insideFn')
  })

  it('a root that is a link inside a clone to a folder outside it lists and reads nothing there', async (ctx) => {
    const away = join(base, 'away')
    mkdirSync(away)
    writeFileSync(join(away, 'away.ts'), 'export function awayFn() { return 1 }\n')
    execFileSync('git', ['-C', away, 'init', '-q'], { stdio: 'ignore' })
    const sub = join(root, 'sub')
    if (!dirLink(away, sub)) ctx.skip()
    expect(isCloneRoot(userData, sub)).toBe(true)
    const src = sourceFor(sub)
    expect(await src.listFiles()).toEqual([])
    await expect(src.readFile(join(sub, 'away.ts'))).rejects.toThrow('outside the folder')
    await buildCodeGraph(src, graphKeyForRoot(sub))
    expect(codeSymbols('awayFn', 10, graphKeyForRoot(sub))).toHaveLength(0)
  })

  it('a folder that is no clone is swept as it is: listed by git, read plainly', async (ctx) => {
    const plain = join(base, 'plain')
    mkdirSync(plain)
    writeFileSync(join(plain, 'p.ts'), 'export function plainFn() { return 1 }\n')
    execFileSync('git', ['-C', plain, 'init', '-q'], { stdio: 'ignore' })
    const src = sourceFor(plain)
    expect(src.root).toBe(plain)
    expect((await src.listFiles()).map((f) => f.replace(/\\/g, '/'))).toEqual([expect.stringMatching(/plain\/p\.ts$/)])
    await expect(src.readFile(join(plain, 'p.ts'))).resolves.toContain('plainFn')
    // A link out of a folder that is no clone is the user's own: read through.
    if (!linked) ctx.skip()
    symlinkSync(join(base, 'outside', 'out.ts'), join(plain, 'mine.ts'), 'file')
    await expect(src.readFile(join(plain, 'mine.ts'))).resolves.toContain('outsideFn')
  })
})

describe('the batch path has the size cap a full sweep has', () => {
  it('a worktree of the clone inside it is still told by its .git pointer, read inside the clone, and not listed again', async () => {
    // Confined, discovery reads a nested folder's `.git` pointer file through the confined reader: one inside the
    // clone is read, so the clone's own worktree is known as one and its files are not listed a second time.
    git('worktree', 'add', '-q', join(root, 'wt'))
    const norm = (l: string[]): string[] => l.map((f) => f.replace(/\\/g, '/'))
    const listed = norm(await discoverRepoFiles(root, { confineTo: root }))
    expect(listed.filter((f) => f.endsWith('/src/in.ts'))).toHaveLength(1)
    expect(listed.some((f) => f.includes('/wt/'))).toBe(false)
  })

  it('a watcher batch leaves out a file past the cap, and counts it', async () => {
    const key = 'cap'
    process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP = '1' // 1 KB
    const before = codeGraphSweepCounters().skippedLarge
    try {
      await reindexPaths(['/p/big.ts', '/p/small.ts'], async (f) => (f.endsWith('big.ts')
        ? `export function bigFn() { return 1 }\n// ${'x'.repeat(4096)}\n`
        : 'export function smallFn() { return 1 }\n'), key)
    } finally {
      delete process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP
    }
    expect(codeSymbols('bigFn', 10, key)).toHaveLength(0)
    expect(codeSymbols('smallFn', 10, key)).toHaveLength(1)
    expect(codeGraphSweepCounters().skippedLarge - before).toBe(1)
  })

  it('a file past the cap that a batch skips while a build is held is read, so the build does not read it again', async () => {
    const key = 'cap3'
    const list = Array.from({ length: 40 }, (_, i) => `/p/f${i}.ts`)
    const small = (f: string): string => `export function ${f.slice(3, -3)}_v1() { return 1 }\n`
    await buildCodeGraph({ listFiles: async () => list, readFile: async (f) => small(f) }, key)
    let release!: () => void
    let reached!: () => void
    const atPause = new Promise<void>((r) => { reached = r })
    let held = false
    const pause = (): Promise<void> => { if (held) return Promise.resolve(); held = true; reached(); return new Promise<void>((r) => { release = r }) }
    const F = list[3] // the build read it before the boundary it is held at
    const reads: string[] = []
    const rb = buildCodeGraph({ listFiles: async () => list, readFile: async (f) => { reads.push(f); return small(f) }, pause }, key)
    await atPause
    // The cap is lowered for the batch alone: the build's own reads, and its settling reads, have the usual one.
    const before = codeGraphSweepCounters().skippedLarge
    process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP = '1'
    try {
      await reindexPaths([F], async () => `export function big() { return 1 }\n// ${'x'.repeat(4096)}\n`, key)
    } finally {
      delete process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP
    }
    release()
    await rb
    expect(reads.filter((f) => f === F)).toHaveLength(1)
    expect(codeGraphSweepCounters().skippedLarge - before).toBe(1)
    expect(codeSymbols('f3_v1', 10, key)).toHaveLength(0)
    expect(codeGraphStats(key).files).toBe(39)
  })

  it('a file past the cap that a batch skips replaces the version the graph held', async () => {
    const key = 'cap2'
    await reindexPaths(['/p/big.ts'], async () => 'export function bigFn() { return 1 }\n', key)
    expect(codeSymbols('bigFn', 10, key)).toHaveLength(1)
    process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP = '1'
    try {
      await reindexPaths(['/p/big.ts'], async () => `export function bigFn() { return 1 }\n// ${'x'.repeat(4096)}\n`, key)
    } finally {
      delete process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP
    }
    expect(codeSymbols('bigFn', 10, key)).toHaveLength(0)
  })
})

describe("index.ts takes every project sweep's listing and reader from graphSourceFor", () => {
  const index = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')

  it('graphSourceFor is sweepSourceFor with the app data folder, which confines both the listing and the reader for a clone', () => {
    const at = index.indexOf('function graphSourceFor(')
    expect(at).toBeGreaterThan(-1)
    const body = index.slice(at, index.indexOf('\n}\n', at))
    expect(body).toMatch(/return sweepSourceFor\(root, worldUserData\)/)
  })

  it('memory:ingest-code, buildGraphFor and the watcher use it, and nothing else lists or reads a project for the graph', () => {
    const builds = index.match(/buildCodeGraph\(\{[^}]*\}/g) ?? []
    expect(builds.length).toBeGreaterThanOrEqual(2)
    expect(builds.filter((c) => !/\.\.\.(graphSourceFor\(\w+\)|source),/.test(c))).toEqual([])
    const watch = index.match(/reindexWatchedChange\([^\n]*/g) ?? []
    expect(watch).toHaveLength(1)
    expect(watch[0]).toMatch(/src\.readFile, \(\) => sweepPause\(\), src\.listFiles\)$/)
    expect(index).toMatch(/const src = graphSourceFor\(root\)/)
    // The code memory's ingest takes the same source as the graph's sweep after it.
    const at = index.indexOf("ipcMain.handle('memory:ingest-code'")
    const ingest = index.slice(at, index.indexOf('\n})\n', at))
    expect(ingest).toMatch(/const source = graphSourceFor\(opts\.repoRoot\)\n\s*const stats = await runCodeIngest\([\s\S]*?\{ repoRoot: opts\.repoRoot, source \}/)
    expect(ingest).toMatch(/buildCodeGraph\(\{ \.\.\.source, pause/)
    // Nothing in index.ts lists a project but through it.
    expect(index).not.toMatch(/discoverRepoFiles\(/)
  })
})
