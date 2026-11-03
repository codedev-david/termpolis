// gitWatcher under the storm guard (src/main/gitWatcher.ts + watchGuard.ts): what the rail's watcher
// is and is not asked to repaint for. The 100,000-event runs are in watcherFlood.test.ts; these are
// the single cases, on counters: repaints, timers armed, handles opened.
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { FSWatcher } from 'fs'
import { createGitWatcherRegistry, isIgnoredGitPath, isIgnoredPath, type GitWatcherDeps } from '../../src/main/gitWatcher'
import { setWatchGatesPaused } from '../../src/main/watchGuard'

type Listener = (event: string, filename: string | Buffer | null) => void

async function microtasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function harness(extra: Partial<GitWatcherDeps> = {}) {
  const opened: { path: string; listener: Listener; closed: number }[] = []
  const timers = new Map<number, () => void>()
  let seq = 0
  const onChange = vi.fn()
  const reg = createGitWatcherRegistry({
    watch: ((p: string, _o: unknown, listener: Listener) => {
      const rec = { path: p, listener, closed: 0 }
      opened.push(rec)
      return { close: () => { rec.closed++ } } as unknown as FSWatcher
    }) as GitWatcherDeps['watch'],
    onChange,
    setTimer: ((fn: () => void) => { const id = ++seq; timers.set(id, fn); return id }) as unknown as GitWatcherDeps['setTimer'],
    clearTimer: ((t: number) => { timers.delete(t) }) as unknown as GitWatcherDeps['clearTimer'],
    throttleMs: 2000,
    probeNested: async () => false,
    readSubmodulePaths: async () => [],
    ...extra,
  })
  return {
    reg,
    onChange,
    opened,
    tree: () => opened.find((w) => !w.path.endsWith('.git'))!,
    gitDir: () => opened.find((w) => w.path.endsWith('.git'))!,
    fireTimer: () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn() },
    get armedTotal() { return seq },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  setWatchGatesPaused(false)
})

describe('what the .git watch passes', () => {
  it.each([
    'worktrees', 'worktrees/wt1/index', 'worktrees\\wt1\\HEAD', 'worktrees/wt1/logs/HEAD',
    'objects/ab/cdef', 'logs/HEAD', 'index.lock', 'refs/heads/main.lock',
  ])('drops %s', (p) => {
    expect(isIgnoredGitPath(p)).toBe(true)
  })

  it.each([
    'index', 'HEAD', 'refs/heads/main', 'refs/remotes/origin/main', 'packed-refs', 'MERGE_HEAD', 'modules/sub/HEAD',
    'worktrees-old/x', 'my-worktrees/x',
  ])('keeps %s: it can change the answer', (p) => {
    expect(isIgnoredGitPath(p)).toBe(false)
  })

  it('the other checkouts of this repo cannot make it repaint, however often they run git', () => {
    const h = harness()
    h.reg.add('/repo')
    for (let i = 0; i < 20_000; i++) h.gitDir().listener('change', `worktrees/wt${i % 25}/index`)
    expect(h.onChange).not.toHaveBeenCalled()
    expect(h.armedTotal).toBe(0)
    h.gitDir().listener('change', 'refs/heads/main') // a branch tip moved: that one is real
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })
})

describe('the governor can pause it', () => {
  it('no repaint while paused; ONE repaint on resume however many events arrived', () => {
    const h = harness()
    h.reg.add('/repo')
    setWatchGatesPaused(true)
    for (let i = 0; i < 5000; i++) h.tree().listener('change', `src/f${i % 50}.ts`)
    h.gitDir().listener('change', 'refs/heads/main')
    expect(h.onChange).not.toHaveBeenCalled()
    expect(h.armedTotal).toBe(0)
    setWatchGatesPaused(false)
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })
})

describe('what the working-tree watch passes', () => {
  it('knows the nested-worktree folders by name', () => {
    expect(isIgnoredPath('.worktrees/wt1/src/a.ts')).toBe(true)
    expect(isIgnoredPath('.claude\\worktrees\\x\\a.ts')).toBe(true)
    expect(isIgnoredPath('src/worktrees.ts')).toBe(false)
  })

  it('ignores everything inside .worktrees: no repaint, no timer, no handle beyond the two it opened', () => {
    const h = harness()
    h.reg.add('/repo')
    for (let i = 0; i < 20_000; i++) h.tree().listener('change', `.worktrees/wt${i % 25}/src/f${i % 300}.ts`)
    expect(h.onChange).not.toHaveBeenCalled()
    expect(h.armedTotal).toBe(0)
    expect(h.opened).toHaveLength(2)
  })

  it('ignores a nested repository once it is known, and learns one from a .git event', async () => {
    const h = harness({ probeNested: async (abs) => abs.replace(/\\/g, '/').endsWith('/vendor/lib') })
    h.reg.add('/repo')
    h.tree().listener('change', 'vendor/lib/.git/index') // teaches, and is ignored by name
    h.tree().listener('change', 'vendor/lib/src/a.ts')
    expect(h.onChange).not.toHaveBeenCalled()
    h.tree().listener('change', 'src/a.ts')
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it('decodes a Buffer filename and still filters it', () => {
    const h = harness()
    h.reg.add('/repo')
    h.tree().listener('change', Buffer.from('.worktrees/wt1/a.ts'))
    expect(h.onChange).not.toHaveBeenCalled()
    h.tree().listener('change', Buffer.from('src/a.ts'))
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it('an event with no name is still a change, as before', () => {
    const h = harness()
    h.reg.add('/repo')
    h.tree().listener('rename', null)
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })
})

describe('submodules stay watched', () => {
  async function withSubmodule(read: GitWatcherDeps['readSubmodulePaths']) {
    const h = harness({
      probeNested: async (abs) => /\/libs\/(sub|other)$/.test(abs.replace(/\\/g, '/')),
      readSubmodulePaths: read,
    })
    h.reg.add('/repo')
    // Warm both directories so the nested-repository answer is known before the real events.
    h.tree().listener('change', 'libs/sub/warm.ts')
    h.tree().listener('change', 'libs/other/warm.ts')
    await microtasks()
    h.fireTimer() // end the window the first event opened (the dirty trailing run opens another) ...
    h.fireTimer() // ... and end that one, so the next real event is a leading edge
    h.onChange.mockClear()
    return h
  }

  it('a dirty submodule is part of the parent status, so its edits repaint; another nested repo\'s do not', async () => {
    const h = await withSubmodule(async () => ['libs/sub'])
    h.tree().listener('change', 'libs/other/src/a.ts')
    expect(h.onChange).not.toHaveBeenCalled()
    h.tree().listener('change', 'libs/sub/src/a.ts')
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it('without a .gitmodules entry every nested repository is ignored', async () => {
    const h = await withSubmodule(async () => [])
    h.tree().listener('change', 'libs/sub/src/a.ts')
    expect(h.onChange).not.toHaveBeenCalled()
  })

  it('a reader that fails leaves the default (ignore nested repositories) in place', async () => {
    const h = await withSubmodule(async () => { throw new Error('EACCES') })
    h.tree().listener('change', 'libs/sub/src/a.ts')
    expect(h.onChange).not.toHaveBeenCalled()
  })

  it('an answer that arrives after the root was removed is dropped, not applied to a dead filter', async () => {
    let answer!: (p: string[]) => void
    const h = harness({ readSubmodulePaths: () => new Promise<string[]>((r) => { answer = r }) })
    h.reg.add('/repo')
    h.reg.remove('/repo')
    answer(['libs/sub'])
    await microtasks()
    expect(h.reg.watchedRoots()).toEqual([])
  })

  it('reads .gitmodules from the real disk by default: path lines only, in any spacing, never throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gm-'))
    try {
      fs.writeFileSync(path.join(dir, '.gitmodules'), [
        '[submodule "libs/sub"]',
        '\tpath = libs/sub',
        '\turl = https://example.invalid/sub.git',
        '[submodule "other"]',
        '    path=libs/spaced name   ',
        '# path = commented/out',
        '',
      ].join('\r\n'))
      const h = harness({
        probeNested: async (abs) => /\/libs\/(sub|other)$/.test(abs.replace(/\\/g, '/')),
        readSubmodulePaths: undefined,
      })
      h.reg.add(dir)
      h.tree().listener('change', 'libs/sub/warm.ts')
      await vi.waitFor(() => { /* the read is real async I/O */
        h.tree().listener('change', 'libs/sub/probe.ts')
        h.fireTimer()
        if (h.onChange.mock.calls.length < 3) throw new Error('still ignoring the submodule')
      }, { timeout: 10_000, interval: 25 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a .gitmodules too big to be real is not read at all', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gm-'))
    try {
      fs.writeFileSync(path.join(dir, '.gitmodules'), '# '.padEnd(300 * 1024, 'x') + '\n[submodule "s"]\n\tpath = libs/sub\n')
      const h = harness({
        probeNested: async (abs) => abs.replace(/\\/g, '/').endsWith('/libs/sub'),
        readSubmodulePaths: undefined,
      })
      const read = vi.spyOn(fs.promises, 'readFile')
      h.reg.add(dir)
      h.tree().listener('change', 'libs/sub/warm.ts')
      await read.mock.results[0].value // the real read has finished ...
      await microtasks() // ... and its answer has been handled
      h.fireTimer()
      h.fireTimer()
      h.onChange.mockClear()
      h.tree().listener('change', 'libs/sub/src/a.ts')
      expect(h.onChange).not.toHaveBeenCalled() // nested, and not kept: the oversize list was ignored
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('no .gitmodules at all (nearly every repository) is just "no submodules"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gm-'))
    try {
      const h = harness({ readSubmodulePaths: undefined })
      h.reg.add(dir)
      await vi.waitFor(() => expect(h.reg.isWatching(dir)).toBe(true))
      expect(h.onChange).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
