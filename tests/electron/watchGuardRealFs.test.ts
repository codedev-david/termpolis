// The storm guard against the REAL fs.watch of this platform (no injected watcher): the filenames the
// OS actually delivers (backslashes on Windows, the case a directory was created in) must go through
// the ignore rule the way the unit tests assume. Everything the OS reports is real; only the debounce
// is shortened.
//
// The negative claims ("this never reached the handler") are only made after a RAW watcher on the same
// root has seen the last event of the ignored burst and a little more real time has passed, so they
// cannot pass just because the OS had not delivered the events yet.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { watchRepo, fsBackedWatchDeps } from '../../src/main/codeWatch'
import { createGitWatcherRegistry, type GitWatcherDeps } from '../../src/main/gitWatcher'

let root: string
let raw: string[]
let rawWatcher: fs.FSWatcher | null

const norm = (s: string): string => s.replace(/\\/g, '/')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function put(rel: string, content = 'x'): void {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

/** Write files a few at a time, yielding to the event loop between groups: the OS keeps a small buffer of
 *  changes (4 KB in libuv on Windows), and a tight synchronous loop overflows it and DROPS events. */
async function putAll(rels: string[]): Promise<void> {
  for (let i = 0; i < rels.length; i++) {
    put(rels[i])
    if (i % 3 === 2) await sleep(2)
  }
  await sleep(5)
}

/** Has the raw watcher seen an event for a file whose name ends with `tail`? */
const rawSaw = (tail: string): boolean => raw.some((n) => n.endsWith(tail))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-realfs-'))
  fs.mkdirSync(path.join(root, '.git'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, '.worktrees', 'wt1', 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, '.WORKTREES-UPPER'), { recursive: true }) // NOT a worktree folder: must stay watched
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true })
  fs.mkdirSync(path.join(root, 'vendor', 'lib', 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'vendor', 'lib', '.git'))
  raw = []
  rawWatcher = fs.watch(root, { recursive: true }, (_e, f) => { if (f) raw.push(norm(String(f))) })
})
afterEach(() => {
  try { rawWatcher?.close() } catch { /* closed */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* temp */ }
})

describe('codeWatch on the real fs.watch', () => {
  it('re-indexes a real source edit, and not what happens in worktrees, node_modules or a nested repository', async () => {
    const reindex = vi.fn()
    const w = watchRepo(root, { ...fsBackedWatchDeps(fs.watch as never, reindex), debounceMs: 100 })
    try {
      // The ignored places first, in different cases and many times ...
      const burst: string[] = []
      for (let i = 0; i < 20; i++) {
        burst.push(`.worktrees/wt1/src/a${i}.ts`, `.Worktrees/wt2/src/b${i}.ts`, `node_modules/x/i${i}.js`, `vendor/lib/src/n${i}.ts`)
      }
      await putAll(burst)
      // ... then one real edit through the same pipe.
      put('src/real.ts')
      await vi.waitFor(() => expect(reindex).toHaveBeenCalled(), { timeout: 20_000, interval: 25 })
      await vi.waitFor(() => expect(rawSaw('n19.ts') && rawSaw('i19.js') && rawSaw('b19.ts')).toBe(true), { timeout: 20_000, interval: 25 })
      await sleep(400) // the watcher under test has had its turn at every one of them, and its debounce
      const named = reindex.mock.calls.flatMap((c) => c[1] as string[]).map(norm)
      expect(named).toContain('src/real.ts')
      expect(named.filter((n) => /(^|\/)(\.worktrees|node_modules)\//i.test(n))).toEqual([])
      // vendor/lib is a nested repository (it has a .git folder). Events inside it that arrive while
      // the filter is still asking the disk are let through (dropping a real change is the worse
      // mistake), so the first burst may have named some. Once the answer is in, none may: a second
      // burst, written after the first has been fully delivered and answered, must name nothing.
      const second = Array.from({ length: 10 }, (_, i) => `vendor/lib/src/m${i}.ts`)
      await putAll(second)
      await vi.waitFor(() => expect(rawSaw('m9.ts')).toBe(true), { timeout: 20_000, interval: 25 })
      await sleep(400) // the watcher under test has had its turn, and its debounce
      const all = reindex.mock.calls.flatMap((c) => c[1] as string[]).map(norm)
      expect(all.filter((n) => /vendor\/lib\/src\/m\d+\.ts$/.test(n))).toEqual([])
      expect(all.filter((n) => /(^|\/)(\.worktrees|node_modules)\//i.test(n))).toEqual([])
    } finally {
      w.close()
    }
  })

  it('a folder whose name only RESEMBLES an ignored one is still watched', async () => {
    const reindex = vi.fn()
    const w = watchRepo(root, { ...fsBackedWatchDeps(fs.watch as never, reindex), debounceMs: 100 })
    try {
      put('.WORKTREES-UPPER/src/c.ts')
      put('my_node_modules/d.ts')
      await vi.waitFor(() => {
        const named = reindex.mock.calls.flatMap((c) => c[1] as string[]).map(norm)
        expect(named).toEqual(expect.arrayContaining(['.WORKTREES-UPPER/src/c.ts', 'my_node_modules/d.ts']))
      }, { timeout: 20_000, interval: 25 })
    } finally {
      w.close()
    }
  })
})

describe('gitWatcher on the real fs.watch', () => {
  function registry(onChange: () => void) {
    return createGitWatcherRegistry({
      watch: fs.watch as unknown as GitWatcherDeps['watch'],
      onChange,
      throttleMs: 50,
      readSubmodulePaths: async () => [],
    })
  }

  it('a burst entirely inside nested worktrees, node_modules and .git/worktrees is not a repaint; a real edit and a real ref move are', async () => {
    const onChange = vi.fn()
    const reg = registry(onChange)
    reg.add(root)
    try {
      const burst: string[] = []
      for (let i = 0; i < 30; i++) burst.push(`.worktrees/wt1/src/q${i}.ts`, `node_modules/x/q${i}.js`)
      for (let i = 0; i < 10; i++) burst.push(`.git/worktrees/wt1/index`)
      await putAll(burst)
      // The raw watcher has seen the whole burst, and the registry has had its turn.
      await vi.waitFor(() => expect(rawSaw('q29.ts') && rawSaw('q29.js') && rawSaw('worktrees/wt1/index')).toBe(true), { timeout: 20_000, interval: 25 })
      await sleep(300)
      expect(onChange).not.toHaveBeenCalled()

      put('src/a.ts') // a real edit
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 20_000, interval: 25 })
      await sleep(150) // the throttle window closes
      onChange.mockClear()

      fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true })
      fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n') // a ref moved
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 20_000, interval: 25 })
    } finally {
      reg.closeAll()
    }
  })
})
