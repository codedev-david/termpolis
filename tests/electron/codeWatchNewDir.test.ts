// A directory that appears under a watched root: the source files already inside it are re-indexed.
// The scoped watch (scopedWatch.ts) subscribes a new top-level directory a moment after it appears, so
// a file written in that instant (an agent's `mkdir -p src/payments && write src/payments/index.ts`)
// raises no event of its own; the directory's own `rename` is all that is heard. codeWatch lists the
// directory then, so the file is still indexed (Lumopolis Build it watches a fresh folder this way).
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { watchRepo, fsBackedWatchDeps, listSourceFiles, type WatchDeps } from '../../src/main/codeWatch'

function harness(over: Partial<WatchDeps> = {}) {
  let listener: (event: string, filename: string | null) => void = () => {}
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const deps: WatchDeps = {
    watch: (_dir, l) => {
      listener = l
      return { close: vi.fn() }
    },
    reindex: vi.fn(),
    setTimer: (fn) => {
      const id = nextTimer++
      timers.set(id, fn)
      return id
    },
    clearTimer: (t) => { timers.delete(t as number) },
    debounceMs: 100,
    probeNested: async () => false,
    ...over,
  }
  return {
    deps,
    fire: (event: string, name: string | null) => listener(event, name),
    flush: () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn() },
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('codeWatch: a directory that appears', () => {
  it('re-indexes the source files already inside it, next to the files named by events', async () => {
    const listSources = vi.fn(async () => ['payments/index.ts', 'README.md', 'payments/util.py'])
    const h = harness({ listSources })
    watchRepo('/repo', h.deps)
    h.fire('rename', 'src')
    h.fire('change', 'lib/a.ts')
    h.flush()
    await vi.waitFor(() => expect(h.deps.reindex).toHaveBeenCalledTimes(1))
    expect(listSources).toHaveBeenCalledWith(path.join('/repo', 'src'))
    expect(h.deps.reindex).toHaveBeenCalledWith('/repo', ['lib/a.ts', path.join('src', 'payments/index.ts'), path.join('src', 'payments/util.py')])
  })

  it('a name that is not a directory (listing fails) adds nothing, and nothing found means no re-index', async () => {
    const listSources = vi.fn(async () => { throw new Error('ENOTDIR') })
    const h = harness({ listSources })
    watchRepo('/repo', h.deps)
    h.fire('rename', 'Makefile')
    h.flush()
    await vi.waitFor(() => expect(listSources).toHaveBeenCalledTimes(1))
    await tick()
    // An empty list would mean "re-sweep the whole repo": a lone non-source rename never asks for that.
    expect(h.deps.reindex).not.toHaveBeenCalled()
    h.fire('rename', 'Makefile')
    h.fire('change', 'a.ts')
    h.flush()
    await vi.waitFor(() => expect(h.deps.reindex).toHaveBeenCalledWith('/repo', ['a.ts']))
  })

  it('only a rename is listed, never a change, an ignored name or a source file', async () => {
    const listSources = vi.fn(async () => ['x.ts'])
    const h = harness({ listSources })
    watchRepo('/repo', h.deps)
    h.fire('change', 'src')
    h.fire('rename', 'node_modules')
    h.fire('rename', 'b.ts')
    h.flush()
    expect(listSources).not.toHaveBeenCalled()
    expect(h.deps.reindex).toHaveBeenCalledWith('/repo', ['b.ts'])
  })

  it('drops listed files the ignore filter rejects', async () => {
    const listSources = vi.fn(async () => ['node_modules/dep/index.js', 'app.ts'])
    const h = harness({ listSources })
    watchRepo('/repo', h.deps)
    h.fire('rename', 'web')
    h.flush()
    await vi.waitFor(() => expect(h.deps.reindex).toHaveBeenCalledWith('/repo', [path.join('web', 'app.ts')]))
  })

  it('too many files in what appeared is a mass change: one whole-repo re-sweep', async () => {
    const many = Array.from({ length: 2100 }, (_, i) => `f${i}.ts`)
    const h = harness({ listSources: async () => many })
    watchRepo('/repo', h.deps)
    h.fire('rename', 'gen')
    h.flush()
    await vi.waitFor(() => expect(h.deps.reindex).toHaveBeenCalledWith('/repo', []))
  })

  it('an overflow re-sweeps without listing anything', () => {
    const listSources = vi.fn(async () => ['x.ts'])
    const h = harness({ listSources })
    watchRepo('/repo', h.deps)
    h.fire('rename', 'src')
    h.fire('overflow', null)
    h.flush()
    expect(listSources).not.toHaveBeenCalled()
    expect(h.deps.reindex).toHaveBeenCalledWith('/repo', [])
  })

  it('closed while listing: no re-index after close', async () => {
    let release: (v: string[]) => void = () => {}
    const h = harness({ listSources: () => new Promise<string[]>((r) => { release = r }) })
    const w = watchRepo('/repo', h.deps)
    h.fire('rename', 'src')
    h.flush()
    w.close()
    release(['a.ts'])
    await tick()
    await tick()
    expect(h.deps.reindex).not.toHaveBeenCalled()
  })

  it('a re-index that throws after a listing is that run failing, not the watcher', async () => {
    const reindex = vi.fn(() => { throw new Error('boom') })
    const h = harness({ listSources: async () => ['a.ts'], reindex })
    watchRepo('/repo', h.deps)
    h.fire('rename', 'src')
    h.flush()
    await vi.waitFor(() => expect(reindex).toHaveBeenCalledTimes(1))
  })

  it('without listSources a new directory is not listed (the old behaviour)', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    h.fire('rename', 'src')
    h.flush()
    expect(h.deps.reindex).not.toHaveBeenCalled()
  })

  it('remembers at most 256 directories per window', async () => {
    const listSources = vi.fn(async () => [] as string[])
    const h = harness({ listSources })
    watchRepo('/repo', h.deps)
    for (let i = 0; i < 300; i++) h.fire('rename', `d${i}`)
    h.flush()
    await vi.waitFor(() => expect(listSources).toHaveBeenCalledTimes(256))
  })
})

describe('listSourceFiles (real fs)', () => {
  const made: string[] = []
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  function tree(files: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-listsrc-'))
    made.push(dir)
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
      fs.writeFileSync(path.join(dir, f), 'x')
    }
    return dir
  }

  it('lists source files below a directory, relative and slash-separated, skipping ignored directories', async () => {
    const dir = tree(['payments/index.ts', 'payments/deep/x.py', 'README.md', 'node_modules/dep/i.js', 'top.go'])
    expect((await listSourceFiles(dir)).sort()).toEqual(['payments/deep/x.py', 'payments/index.ts', 'top.go'])
  })

  it('stops at the limit', async () => {
    const dir = tree(['a.ts', 'b.ts', 'c/d.ts', 'c/e.ts'])
    expect(await listSourceFiles(dir, 2)).toHaveLength(2)
    expect(await listSourceFiles(dir, 3)).toHaveLength(3)
  })

  it('rejects for a path that is not a directory, and skips a subdirectory it cannot read', async () => {
    const dir = tree(['a.ts'])
    await expect(listSourceFiles(path.join(dir, 'a.ts'))).rejects.toThrow()
    const reads: string[] = []
    const fake = async (p: string): Promise<fs.Dirent[]> => {
      reads.push(p)
      if (p !== dir) throw new Error('EACCES')
      return fs.promises.readdir(dir, { withFileTypes: true }).then((d) => [...d, { name: 'locked', isDirectory: () => true, isFile: () => false } as fs.Dirent])
    }
    expect(await listSourceFiles(dir, 10, fake)).toEqual(['a.ts'])
    expect(reads).toEqual([dir, path.join(dir, 'locked')])
  })

  it('fsBackedWatchDeps lists with it', async () => {
    const dir = tree(['src/a.ts'])
    const deps = fsBackedWatchDeps(() => ({ close: () => {} }), () => undefined)
    expect(await deps.listSources?.(dir)).toEqual(['src/a.ts'])
  })
})
