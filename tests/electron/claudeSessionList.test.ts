import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { countSyncFs, type SyncFsCounter } from './_syncFsCounter'

// listSessionFiles lists a project folder with a sync readdirSync and ONE sync statSync per file: on a
// folder with 3,675 transcripts that is 641 to 964 ms in a single block of the main thread, and
// memory:reflect-session did it on every pass. listSessionFilesAsync is the async, cached answer for
// that hot path. The synchronous function is untouched (attaching a watcher needs its exactness).
//
// Everything runs on REAL files under a scratch home: os.homedir() reads USERPROFILE / HOME, so they are
// pointed at the scratch tree BEFORE the modules under test are first imported. A guard stops the whole
// file if that did not take, so nothing here can ever touch the real ~/.claude.

type ListMod = typeof import('../../src/main/claudeSessionList')
type WatcherMod = typeof import('../../src/main/transcriptWatchers/claudeCodeWatcher')

let home: string
let work: string
let list: ListMod
let watcher: WatcherMod
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-list-home-'))
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-list-work-'))
  for (const k of ['USERPROFILE', 'HOME']) saved[k] = process.env[k]
  process.env.USERPROFILE = home
  process.env.HOME = home
  watcher = await import('../../src/main/transcriptWatchers/claudeCodeWatcher')
  list = await import('../../src/main/claudeSessionList')
  // The guard: never go on if the scratch home did not take.
  expect(path.resolve(watcher.CLAUDE_PROJECTS_DIR).toLowerCase().startsWith(path.resolve(home).toLowerCase())).toBe(true)
})

afterAll(() => {
  for (const k of ['USERPROFILE', 'HOME']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  for (const d of [home, work]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

let seq = 0
const T0 = 1_700_000_000 // seconds
const at = (s: number): Date => new Date((T0 + s) * 1000)

/** The folder Claude Code files a working folder's transcripts under, worked out synchronously for the fixtures
 *  (the watcher's own claudeCwd is async since 1.54.5 and the fixtures are built synchronously): every link
 *  resolved, a folder that can't be read or none at all taken as given. */
function claudeCwdSync(cwd: string): string {
  if (!cwd) return cwd
  try {
    return fs.realpathSync(cwd)
  } catch {
    return cwd
  }
}

/** A working folder that exists, and Claude Code's project folder for it (created, with its mtime pinned). */
function project(): { cwd: string; dir: string; pin: () => void } {
  const cwd = path.join(work, `repo-${seq++}`)
  fs.mkdirSync(cwd, { recursive: true })
  const dir = path.join(watcher.CLAUDE_PROJECTS_DIR, watcher.mangleCwd(claudeCwdSync(cwd)))
  fs.mkdirSync(dir, { recursive: true })
  // The folder's own mtime is what the cache keys on: pin it so a test says exactly when it "changes".
  const pin = (): void => fs.utimesSync(dir, at(0), at(0))
  pin()
  return { cwd, dir, pin }
}

function session(dir: string, name: string, mtimeS: number, body = '{"type":"user"}\n'): string {
  const file = path.join(dir, `${name}.jsonl`)
  fs.writeFileSync(file, body)
  fs.utimesSync(file, at(mtimeS), at(mtimeS))
  return file
}

/** The real async fs, with every call counted (and, when asked, one file's stat failing). */
function countingIo(opts: { failStat?: string } = {}) {
  const calls = { stat: 0, readdir: 0, realpath: 0 }
  const io: import('../../src/main/claudeSessionList').ListFs = {
    stat: async (p) => {
      calls.stat++
      if (opts.failStat && p === opts.failStat) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return fs.promises.stat(p)
    },
    readdir: async (p) => {
      calls.readdir++
      return fs.promises.readdir(p)
    },
    realpath: (p) => {
      calls.realpath++
      return new Promise((res, rej) => fs.realpath(p, (e, r) => (e ? rej(e) : res(r))))
    },
  }
  return { calls, io }
}

let counter: SyncFsCounter | null = null
beforeEach(() => {
  list.resetSessionListCache()
})
afterEach(() => {
  counter?.restore()
  counter = null
})

describe('listSessionFilesAsync', () => {
  it('lists the same files in the same order as the synchronous listing, and only the .jsonl ones', async () => {
    const p = project()
    // created out of order on purpose: the order must come from the mtimes
    session(p.dir, 'bbb', 20)
    session(p.dir, 'aaa', 50)
    session(p.dir, 'ddd', 10)
    session(p.dir, 'ccc', 30)
    fs.writeFileSync(path.join(p.dir, 'notes.txt'), 'x')
    fs.mkdirSync(path.join(p.dir, 'aaa'), { recursive: true }) // a session's subagents folder
    p.pin()

    const sync = await watcher.listSessionFiles(p.cwd)
    expect(sync.map((f) => path.basename(f))).toEqual(['aaa.jsonl', 'ccc.jsonl', 'bbb.jsonl', 'ddd.jsonl'])
    expect(await list.listSessionFilesAsync(p.cwd)).toEqual(sync)
  })

  it('is [] for no working folder, a folder Claude Code never saw, and a project "folder" that is a file', async () => {
    expect(await list.listSessionFilesAsync('')).toEqual([])
    expect(await list.listSessionFilesAsync(path.join(work, 'never-had-a-session'))).toEqual([])

    const cwd = path.join(work, `file-${seq++}`)
    fs.mkdirSync(cwd)
    fs.mkdirSync(watcher.CLAUDE_PROJECTS_DIR, { recursive: true })
    fs.writeFileSync(path.join(watcher.CLAUDE_PROJECTS_DIR, watcher.mangleCwd(claudeCwdSync(cwd))), 'not a folder')
    expect(await list.listSessionFilesAsync(cwd)).toEqual([])
  })

  it('returns only the newest `limit` when asked', async () => {
    const p = project()
    for (let i = 0; i < 6; i++) session(p.dir, `s${i}`, i * 10)
    p.pin()
    const two = await list.listSessionFilesAsync(p.cwd, { limit: 2 })
    expect(two.map((f) => path.basename(f))).toEqual(['s5.jsonl', 's4.jsonl'])
  })

  it('makes no synchronous fs call at all, on the first look or any later one', async () => {
    const p = project()
    for (let i = 0; i < 12; i++) session(p.dir, `s${i}`, i * 10)
    p.pin()
    await list.listSessionFilesAsync(p.cwd) // warm any lazy module state
    list.resetSessionListCache()

    counter = countSyncFs([home, work])
    await list.listSessionFilesAsync(p.cwd) // cold
    await list.listSessionFilesAsync(p.cwd) // warm
    session(p.dir, 'fresh', 500)
    p.pin()
    fs.utimesSync(p.dir, at(7), at(7)) // the folder changed
    await list.listSessionFilesAsync(p.cwd) // rebuilt
    const made = { ...counter.counts }
    counter.restore()
    counter = null

    expect(made).toEqual({})
  })

  it('CONTROL: the uncached listing it replaces lists the folder and stats every file on every pass', async () => {
    // The watcher's listSessionFiles went async in 1.54.5 (no sync call left), but it still remembers nothing:
    // each pass pays one readdir and one stat per transcript. That per-pass cost is what the cache removes.
    const p = project()
    const N = 25
    for (let i = 0; i < N; i++) session(p.dir, `s${i}`, i * 10)
    p.pin()

    const under = (a: unknown): boolean => typeof a === 'string' && path.resolve(a).startsWith(path.resolve(p.dir))
    const readdir = vi.spyOn(fs.promises, 'readdir')
    const stat = vi.spyOn(fs.promises, 'stat')
    counter = countSyncFs([home, work])
    let readdirs = 0
    let stats = 0
    try {
      await watcher.listSessionFiles(p.cwd)
      await watcher.listSessionFiles(p.cwd) // every pass pays it again: nothing is remembered
      readdirs = readdir.mock.calls.filter((a) => under(a[0])).length
      stats = stat.mock.calls.filter((a) => under(a[0])).length
    } finally {
      readdir.mockRestore()
      stat.mockRestore()
    }
    const c = { ...counter.counts }
    counter.restore()
    counter = null

    expect(readdirs).toBe(2)
    expect(stats).toBeGreaterThanOrEqual(2 * (N + 1))
    expect(c.readdirSync ?? 0).toBe(0)
    expect(c.statSync ?? 0).toBe(0)
  })

  describe('the folder cache', () => {
    it('on a second look with nothing changed: stats the folder and the newest few files, lists nothing, stats no other', async () => {
      const p = project()
      const N = 40
      for (let i = 0; i < N; i++) session(p.dir, `s${i}`, i * 10)
      p.pin()
      const { calls, io } = countingIo()

      const first = await list.listSessionFilesAsync(p.cwd, { fs: io })
      expect(calls.readdir).toBe(1)
      expect(calls.stat).toBe(1 + N) // the folder, then every file: a cold look pays in full, async
      expect(first[0]).toMatch(/s39\.jsonl$/)

      calls.stat = calls.readdir = calls.realpath = 0
      const second = await list.listSessionFilesAsync(p.cwd, { fs: io })
      expect(second).toEqual(first)
      expect(calls.readdir).toBe(0)
      expect(calls.stat).toBe(1 + list.LIST_RECHECK) // the folder and the newest few: not N
      expect(list.LIST_RECHECK).toBeLessThan(N)
    })

    it('sees a transcript that is being written (its mtime moves) without listing the folder again', async () => {
      const p = project()
      session(p.dir, 'a', 10)
      session(p.dir, 'b', 20)
      const c = session(p.dir, 'c', 30)
      p.pin()
      const { calls, io } = countingIo()
      expect((await list.listSessionFilesAsync(p.cwd, { fs: io })).map((f) => path.basename(f))).toEqual(['c.jsonl', 'b.jsonl', 'a.jsonl'])

      // `a` is appended to: its mtime becomes the newest. Appending does not change the folder's mtime.
      fs.utimesSync(path.join(p.dir, 'a.jsonl'), at(99), at(99))
      p.pin()
      calls.readdir = 0
      expect((await list.listSessionFilesAsync(p.cwd, { fs: io })).map((f) => path.basename(f))).toEqual(['a.jsonl', 'c.jsonl', 'b.jsonl'])
      expect(calls.readdir).toBe(0)
      expect(c).toBeTruthy()
    })

    it('when a file appears the folder is rebuilt: it is listed again, and only the NEW name and the newest few are statted', async () => {
      const p = project()
      const N = 40
      for (let i = 0; i < N; i++) session(p.dir, `s${i}`, i * 10)
      p.pin()
      const { calls, io } = countingIo()
      await list.listSessionFilesAsync(p.cwd, { fs: io })

      session(p.dir, 'brand-new', 1000)
      fs.utimesSync(p.dir, at(5), at(5)) // a new entry changes the folder's mtime
      calls.stat = calls.readdir = 0
      const files = await list.listSessionFilesAsync(p.cwd, { fs: io })
      expect(path.basename(files[0])).toBe('brand-new.jsonl')
      expect(files).toHaveLength(N + 1)
      expect(calls.readdir).toBe(1)
      expect(calls.stat).toBe(1 + 1 + list.LIST_RECHECK) // folder + the new name + the newest few
    })

    it('when a file is deleted the folder is rebuilt and the file is gone', async () => {
      const p = project()
      session(p.dir, 'a', 10)
      session(p.dir, 'b', 20)
      p.pin()
      const { io } = countingIo()
      expect((await list.listSessionFilesAsync(p.cwd, { fs: io })).map((f) => path.basename(f))).toEqual(['b.jsonl', 'a.jsonl'])
      fs.rmSync(path.join(p.dir, 'b.jsonl'))
      fs.utimesSync(p.dir, at(5), at(5))
      expect((await list.listSessionFilesAsync(p.cwd, { fs: io })).map((f) => path.basename(f))).toEqual(['a.jsonl'])
    })

    it('drops a newest file that vanishes between two looks even though the folder did not change', async () => {
      const p = project()
      session(p.dir, 'a', 10)
      const b = session(p.dir, 'b', 20)
      p.pin()
      const base = countingIo()
      await list.listSessionFilesAsync(p.cwd, { fs: base.io })
      const failing = countingIo({ failStat: b })
      expect((await list.listSessionFilesAsync(p.cwd, { fs: failing.io })).map((f) => path.basename(f))).toEqual(['a.jsonl'])
    })

    it('trusts the remembered mtimes of the older files for LIST_FULL_REFRESH_MS, then looks at every file again', async () => {
      const p = project()
      const N = 30
      for (let i = 0; i < N; i++) session(p.dir, `s${i}`, i * 10)
      p.pin()
      const { calls, io } = countingIo()
      let now = 5_000_000
      const opts = { fs: io, now: () => now }
      await list.listSessionFilesAsync(p.cwd, opts)

      // an OLD session (s0, the oldest by far) is resumed in place: its mtime jumps to the newest, the folder does not change
      fs.utimesSync(path.join(p.dir, 's0.jsonl'), at(9999), at(9999))
      p.pin()

      // CONTROL for the contract: inside the window it is NOT noticed (this is the cost of not looking at 3,675 files every pass)...
      now += list.LIST_FULL_REFRESH_MS - 1
      expect(path.basename((await list.listSessionFilesAsync(p.cwd, opts))[0])).toBe(`s${N - 1}.jsonl`)

      // ...and at the window's end every file is looked at again, so it is noticed.
      now += 1
      calls.stat = 0
      expect(path.basename((await list.listSessionFilesAsync(p.cwd, opts))[0])).toBe('s0.jsonl')
      expect(calls.stat).toBe(1 + N)
    })

    it('treats a clock that went backwards as an expired window rather than trusting the cache forever', async () => {
      const p = project()
      for (let i = 0; i < 12; i++) session(p.dir, `s${i}`, i * 10)
      p.pin()
      const { calls, io } = countingIo()
      let now = 9_000_000
      await list.listSessionFilesAsync(p.cwd, { fs: io, now: () => now })
      now -= 60_000
      calls.stat = 0
      await list.listSessionFilesAsync(p.cwd, { fs: io, now: () => now })
      expect(calls.stat).toBe(1 + 12)
    })

    it('shares one listing between callers that arrive together', async () => {
      const p = project()
      const N = 20
      for (let i = 0; i < N; i++) session(p.dir, `s${i}`, i * 10)
      p.pin()
      const { calls, io } = countingIo()
      const all = await Promise.all(Array.from({ length: 5 }, () => list.listSessionFilesAsync(p.cwd, { fs: io })))
      expect(new Set(all.map((a) => a.join('|'))).size).toBe(1)
      expect(calls.readdir).toBe(1)
      // five looks at the folder itself, but nothing like five passes over its files (which would be 5 * (1 + N) stats)
      expect(calls.stat).toBeLessThan(5 * (1 + N))
    })

    it('remembers at most LIST_MAX_DIRS folders, forgetting the least recently used', async () => {
      const { calls, io } = countingIo()
      const made = Array.from({ length: list.LIST_MAX_DIRS + 3 }, () => {
        const p = project()
        session(p.dir, 'only', 10)
        p.pin()
        return p
      })
      for (const p of made) await list.listSessionFilesAsync(p.cwd, { fs: io })

      calls.readdir = 0
      await list.listSessionFilesAsync(made[made.length - 1].cwd, { fs: io })
      expect(calls.readdir).toBe(0) // the newest is still remembered
      await list.listSessionFilesAsync(made[0].cwd, { fs: io })
      expect(calls.readdir).toBe(1) // the oldest was forgotten
    })
  })

  describe('it fails closed', () => {
    const io = (over: Partial<import('../../src/main/claudeSessionList').ListFs> = {}): import('../../src/main/claudeSessionList').ListFs => ({
      stat: (p) => fs.promises.stat(p),
      readdir: (p) => fs.promises.readdir(p),
      realpath: async (p) => p,
      ...over,
    })

    it('refuses a listed name that would leave the projects folder', async () => {
      const p = project()
      session(p.dir, 'ok', 10)
      p.pin()
      // The file it points at EXISTS (one level above the projects folder), so only the check can keep it out.
      const outside = path.join(path.dirname(watcher.CLAUDE_PROJECTS_DIR), 'escape.jsonl')
      fs.writeFileSync(outside, '{}\n')
      expect(fs.existsSync(path.join(p.dir, '..', '..', 'escape.jsonl'))).toBe(true)
      const out = await list.listSessionFilesAsync(p.cwd, { fs: io({ readdir: async () => ['../../escape.jsonl', 'ok.jsonl'] }) })
      expect(out.map((f) => path.basename(f))).toEqual(['ok.jsonl'])
      expect(out.every((f) => list.entryWithinRoot(watcher.CLAUDE_PROJECTS_DIR, f))).toBe(true)
    })

    it('is [] when the folder cannot be listed after it was found (it vanished in between)', async () => {
      const p = project()
      session(p.dir, 'a', 10)
      p.pin()
      expect(await list.listSessionFilesAsync(p.cwd, { fs: io({ readdir: async () => { throw new Error('ENOENT') } }) })).toEqual([])
    })

    it('never lists the projects folder itself when a working folder resolves to nothing', async () => {
      let listed = 0
      const out = await list.listSessionFilesAsync(path.join(work, 'x'), {
        fs: io({ realpath: async () => '', readdir: async (p) => { listed++; return fs.promises.readdir(p) } }),
      })
      expect(out).toEqual([])
      expect(listed).toBe(0)
    })

    it('uses the projects folder it is given instead of the default', async () => {
      const other = fs.mkdtempSync(path.join(work, 'projects-'))
      const cwd = path.join(work, `repo-${seq++}`)
      fs.mkdirSync(cwd)
      const dir = path.join(other, watcher.mangleCwd(claudeCwdSync(cwd)))
      fs.mkdirSync(dir)
      const file = session(dir, 'there', 10)
      expect(await list.listSessionFilesAsync(cwd, { projectsDir: other })).toEqual([file])
      expect(await list.listSessionFilesAsync(cwd)).toEqual([]) // the default folder has no such project
    })
  })

  describe('entryWithinRoot / claudeCwdAsync', () => {
    it('refuses a path outside the projects folder, as the synchronous listing does', () => {
      const root = path.join(work, 'projects-root')
      expect(list.entryWithinRoot(root, path.join(root, 'C--x', 'a.jsonl'))).toBe(true)
      expect(list.entryWithinRoot(root, path.join(root, '..', 'elsewhere', 'a.jsonl'))).toBe(false)
    })

    it('resolves a working folder the way claudeCwd does: a link is followed, a missing folder is kept as given, nothing stays nothing', async () => {
      const target = path.join(work, `target-${seq++}`)
      fs.mkdirSync(target)
      const link = path.join(work, `link-${seq++}`)
      fs.symlinkSync(target, link, 'junction')
      const missing = path.join(work, 'does-not-exist')

      for (const cwd of [target, link, missing, '']) {
        expect(await list.claudeCwdAsync(cwd)).toBe(await watcher.claudeCwd(cwd))
      }
      expect(await list.claudeCwdAsync(link)).not.toBe(link)
    })
  })
})
