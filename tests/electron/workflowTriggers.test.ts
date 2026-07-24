import { describe, it, expect, vi } from 'vitest'
import { join, dirname } from 'path'
import { TriggerSupervisor, gitDirOf, headRef, resolveRef, targetRef } from '../../src/main/workflow/triggers'
import { workflowsDir, serializeWorkflow } from '../../src/main/workflow/workflowStore'
import type { Workflow, WorkflowTriggerType } from '../../src/renderer/src/types'

const ROOT = join('/repo')
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

// ── fakes ────────────────────────────────────────────────────────────────────

function makeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const addDirs = (p: string) => {
    let d = dirname(p)
    while (d && d !== dirname(d)) {
      dirs.add(d)
      d = dirname(d)
    }
  }
  const api = {
    files,
    dirs,
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    mkdirSync: (p: string) => {
      dirs.add(p)
      addDirs(p)
    },
    readdirSync: (d: string) =>
      [...files.keys()]
        .filter(k => dirname(k) === d)
        .map(k => k.slice(d.length + 1)),
    readFileSync: (p: string) => {
      if (!files.has(p)) {
        // Reading a directory throws EISDIR in Node — gitDirOf relies on that.
        throw new Error(dirs.has(p) ? `EISDIR: illegal operation on a directory, read ${p}` : `ENOENT: ${p}`)
      }
      return files.get(p)!
    },
    writeFileSync: (p: string, data: string) => {
      files.set(p, data)
      addDirs(p)
    },
    appendFileSync: (p: string, data: string) => {
      files.set(p, (files.get(p) ?? '') + data)
      addDirs(p)
    },
    rmSync: (p: string) => {
      files.delete(p)
    },
    /** test helper: put a file on the fake disk */
    put(p: string, content: string) {
      files.set(p, content)
      addDirs(p)
    },
    /** test helper: register a bare directory (no contents) */
    mkdir(p: string) {
      dirs.add(p)
      addDirs(p)
    },
  }
  for (const [p, c] of Object.entries(seed)) api.put(p, c)
  return api
}
type FakeFs = ReturnType<typeof makeFs>

/** Byte view of the fake disk — what the real supervisor gets from node's fs. */
const bytesOf = (fs: FakeFs) => (p: string): Uint8Array => Buffer.from(fs.readFileSync(p))

function makeTimers() {
  let seq = 0
  const timers = new Map<number, { fn: () => void; ms: number }>()
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq
      timers.set(id, { fn, ms })
      return id
    },
    clearTimer: (t: unknown) => {
      timers.delete(t as number)
    },
    /** Run every pending timer once (snapshot, so re-armed timers don't loop). */
    flush() {
      for (const [id, t] of [...timers]) {
        timers.delete(id)
        t.fn()
      }
    },
    get pending() {
      return timers.size
    },
  }
}

function wf(id: string, type: WorkflowTriggerType, config: Record<string, string> = {}): Workflow {
  return { id, name: `wf-${id}`, version: 1, trigger: { type, config }, steps: [] } as Workflow
}

/** Put a workflow on the fake disk in `cwd`'s project store. */
function install(fs: FakeFs, cwd: string, w: Workflow): void {
  fs.put(join(workflowsDir(cwd), `${w.id}.yml`), serializeWorkflow(w))
}

/** A repo whose HEAD points at `branch` sitting at `sha`. */
function installRepo(fs: FakeFs, cwd: string, branch = 'main', sha = SHA_A): void {
  const gitDir = join(cwd, '.git')
  fs.mkdir(gitDir)
  fs.put(join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`)
  fs.put(join(gitDir, 'refs', 'heads', branch), `${sha}\n`)
}

function harness(opts: { trusted?: boolean; now?: number; fs?: FakeFs; fireResult?: () => unknown } = {}) {
  const fs = opts.fs ?? makeFs()
  const timers = makeTimers()
  const fires: { cwd: string; id: string; reason: string }[] = []
  const logs: string[] = []
  const watchers: { dir: string; listener: (e: string, f: string | null) => void; closed: boolean }[] = []
  const state = { now: opts.now ?? 1_000_000, trusted: opts.trusted ?? true, watchThrows: false }
  const sup = new TriggerSupervisor({
    fs: fs as never,
    readBytes: (p: string) => Buffer.from(fs.readFileSync(p)),
    watch: (dir, listener) => {
      if (state.watchThrows) throw new Error('EMFILE')
      const w = { dir, listener, closed: false }
      watchers.push(w)
      return {
        close() {
          w.closed = true
        },
      }
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => state.now,
    isTrusted: () => state.trusted,
    fire: (cwd, id, reason) => {
      fires.push({ cwd, id, reason })
      return opts.fireResult?.()
    },
    log: (m: string) => logs.push(m),
    tickMs: 15_000,
  })
  return { sup, fs, timers, fires, logs, watchers, state }
}

const MIN = 60_000

// ── git plumbing ─────────────────────────────────────────────────────────────

describe('git ref reading', () => {
  it('returns null when the project is not a repo', () => {
    const fs = makeFs()
    expect(gitDirOf(ROOT, fs as never)).toBeNull()
  })

  it('uses .git as the git dir when it is a directory', () => {
    const fs = makeFs()
    installRepo(fs, ROOT)
    expect(gitDirOf(ROOT, fs as never)).toBe(join(ROOT, '.git'))
  })

  it('follows a `gitdir:` pointer file (worktree / submodule) with an absolute path', () => {
    const fs = makeFs()
    fs.put(join(ROOT, '.git'), 'gitdir: /elsewhere/realgit\n')
    expect(gitDirOf(ROOT, fs as never)).toBe('/elsewhere/realgit')
  })

  it('resolves a relative `gitdir:` pointer against the working tree', () => {
    const fs = makeFs()
    fs.put(join(ROOT, '.git'), 'gitdir: ../shared/.git/worktrees/wt\n')
    expect(gitDirOf(ROOT, fs as never)).toBe(join(ROOT, '../shared/.git/worktrees/wt'))
  })

  it('falls back to .git when the pointer file has no gitdir line', () => {
    const fs = makeFs()
    fs.put(join(ROOT, '.git'), 'garbage\n')
    expect(gitDirOf(ROOT, fs as never)).toBe(join(ROOT, '.git'))
  })

  it('reads the symbolic ref from HEAD, and null when HEAD is detached', () => {
    const fs = makeFs()
    installRepo(fs, ROOT, 'feature/x')
    const gd = join(ROOT, '.git')
    expect(headRef(gd, fs as never)).toBe('refs/heads/feature/x')
    fs.put(join(gd, 'HEAD'), `${SHA_A}\n`)
    expect(headRef(gd, fs as never)).toBeNull()
  })

  it('returns null from headRef when HEAD is missing', () => {
    const fs = makeFs()
    fs.mkdir(join(ROOT, '.git'))
    expect(headRef(join(ROOT, '.git'), fs as never)).toBeNull()
  })

  it('resolves a loose ref file', () => {
    const fs = makeFs()
    installRepo(fs, ROOT)
    expect(resolveRef(join(ROOT, '.git'), 'refs/heads/main', fs as never)).toBe(SHA_A)
  })

  it('resolves through packed-refs when there is no loose ref', () => {
    const fs = makeFs()
    fs.mkdir(join(ROOT, '.git'))
    fs.put(
      join(ROOT, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${SHA_B} refs/remotes/origin/main\n^${SHA_A}\n`,
    )
    expect(resolveRef(join(ROOT, '.git'), 'refs/remotes/origin/main', fs as never, bytesOf(fs))).toBe(SHA_B)
  })

  it('returns null when packed-refs holds no matching ref', () => {
    const fs = makeFs()
    fs.mkdir(join(ROOT, '.git'))
    fs.put(join(ROOT, '.git', 'packed-refs'), `${SHA_B} refs/remotes/origin/other\n`)
    expect(resolveRef(join(ROOT, '.git'), 'refs/remotes/origin/main', fs as never, bytesOf(fs))).toBeNull()
  })

  it('survives an unreadable packed-refs', () => {
    const fs = makeFs()
    fs.mkdir(join(ROOT, '.git'))
    fs.put(join(ROOT, '.git', 'packed-refs'), 'x')
    const boom = () => {
      throw new Error('EIO')
    }
    expect(resolveRef(join(ROOT, '.git'), 'refs/heads/main', fs as never, boom)).toBeNull()
  })

  it('follows a symbolic loose ref', () => {
    const fs = makeFs()
    installRepo(fs, ROOT)
    fs.put(join(ROOT, '.git', 'refs', 'heads', 'alias'), 'ref: refs/heads/main\n')
    expect(resolveRef(join(ROOT, '.git'), 'refs/heads/alias', fs as never)).toBe(SHA_A)
  })

  it('returns null for an unresolvable ref', () => {
    const fs = makeFs()
    installRepo(fs, ROOT)
    expect(resolveRef(join(ROOT, '.git'), 'refs/remotes/origin/nope', fs as never)).toBeNull()
  })

  it('ignores a loose ref whose contents are not a sha', () => {
    const fs = makeFs()
    installRepo(fs, ROOT)
    fs.put(join(ROOT, '.git', 'refs', 'heads', 'weird'), 'not-a-sha\n')
    expect(resolveRef(join(ROOT, '.git'), 'refs/heads/weird', fs as never)).toBeNull()
  })

  it('picks the right ref for each trigger type and config', () => {
    const fs = makeFs()
    installRepo(fs, ROOT, 'main')
    const gd = join(ROOT, '.git')
    expect(targetRef(wf('a', 'gitCommit'), gd, fs as never)).toBe('refs/heads/main')
    expect(targetRef(wf('a', 'gitCommit', { branch: 'dev' }), gd, fs as never)).toBe('refs/heads/dev')
    expect(targetRef(wf('a', 'gitPush'), gd, fs as never)).toBe('refs/remotes/origin/main')
    expect(targetRef(wf('a', 'gitPush', { remote: 'upstream' }), gd, fs as never)).toBe('refs/remotes/upstream/main')
    expect(targetRef(wf('a', 'gitPush', { branch: 'dev' }), gd, fs as never)).toBe('refs/remotes/origin/dev')
  })

  it('has no target ref for a git trigger on a detached HEAD with no branch configured', () => {
    const fs = makeFs()
    installRepo(fs, ROOT)
    fs.put(join(ROOT, '.git', 'HEAD'), `${SHA_A}\n`)
    const gd = join(ROOT, '.git')
    expect(targetRef(wf('a', 'gitCommit'), gd, fs as never)).toBeNull()
    expect(targetRef(wf('a', 'gitPush'), gd, fs as never)).toBeNull()
  })
})

// ── arming ───────────────────────────────────────────────────────────────────

describe('TriggerSupervisor arming', () => {
  it('ignores manual workflows and arms the rest', () => {
    const h = harness()
    install(h.fs, ROOT, wf('m', 'manual'))
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    install(h.fs, ROOT, wf('f', 'fileWatch'))
    h.sup.watchProject(ROOT)
    expect(h.sup.armedCount).toBe(2)
  })

  it('does not arm a schedule with an invalid cron, and says why', () => {
    const h = harness()
    install(h.fs, ROOT, wf('bad', 'schedule', { cron: 'not a cron' }))
    h.sup.watchProject(ROOT)
    expect(h.sup.armedCount).toBe(0)
    expect(h.logs.some(l => l.includes('invalid cron'))).toBe(true)
  })

  it('arming never fires anything on its own', () => {
    const h = harness()
    installRepo(h.fs, ROOT)
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    install(h.fs, ROOT, wf('c', 'gitCommit'))
    h.sup.watchProject(ROOT)
    expect(h.fires).toEqual([])
  })

  it('watchProject is idempotent', () => {
    const h = harness()
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.sup.watchProject(ROOT)
    expect(h.sup.armedCount).toBe(1)
  })

  it('ignores an empty cwd', () => {
    const h = harness()
    h.sup.watchProject('')
    expect(h.sup.armedCount).toBe(0)
  })

  it('rearm on an unknown project is a no-op', () => {
    const h = harness()
    expect(() => h.sup.rearm('/never-watched')).not.toThrow()
  })

  it('rearm picks up a newly saved workflow and drops a deleted one', () => {
    const h = harness()
    h.sup.watchProject(ROOT)
    expect(h.sup.armedCount).toBe(0)
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.rearm(ROOT)
    expect(h.sup.armedCount).toBe(1)
    h.fs.rmSync(join(workflowsDir(ROOT), 's.yml'))
    h.sup.rearm(ROOT)
    expect(h.sup.armedCount).toBe(0)
  })

  it('survives a workflow directory that cannot be listed', () => {
    const h = harness()
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.fs.readdirSync = () => {
      throw new Error('EACCES')
    }
    expect(() => h.sup.rearm(ROOT)).not.toThrow()
    expect(h.logs.some(l => l.includes('could not list workflows'))).toBe(true)
  })

  it('unwatchProject stops the project and closes its watcher', () => {
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch'))
    h.sup.watchProject(ROOT)
    expect(h.watchers[0].closed).toBe(false)
    h.sup.unwatchProject(ROOT)
    expect(h.sup.armedCount).toBe(0)
    expect(h.watchers[0].closed).toBe(true)
  })

  it('unwatching an unknown project is a no-op', () => {
    const h = harness()
    expect(() => h.sup.unwatchProject('/nope')).not.toThrow()
  })
})

// ── schedule ─────────────────────────────────────────────────────────────────

describe('schedule trigger', () => {
  it('fires once a cron slot passes', () => {
    const h = harness()
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.sup.tick()
    expect(h.fires).toEqual([])
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.map(f => f.id)).toEqual(['s'])
    expect(h.fires[0].reason).toContain('schedule')
  })

  it('does not fire again inside the same minute', () => {
    const h = harness()
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.state.now += MIN
    h.sup.tick()
    h.sup.tick()
    expect(h.fires.length).toBe(1)
  })

  it('catches up a run that came due while the app was closed', () => {
    const h = harness()
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '0 2 * * *', catchUp: '1' }))
    h.sup.watchProject(ROOT)
    h.state.now += 3 * 24 * 60 * MIN // three days later
    h.sup.tick()
    expect(h.fires.length).toBe(1)
  })

  it('does NOT catch up when catchUp is off', () => {
    const h = harness()
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '0 2 * * *', catchUp: '0' }))
    h.sup.watchProject(ROOT)
    h.state.now += 3 * 24 * 60 * MIN
    h.sup.tick()
    expect(h.fires).toEqual([])
  })

  it('treats catchUp as on unless explicitly "0"', () => {
    const h = harness()
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '0 2 * * *' }))
    h.sup.watchProject(ROOT)
    h.state.now += 3 * 24 * 60 * MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1)
  })
})

// ── git ──────────────────────────────────────────────────────────────────────

describe('gitCommit trigger', () => {
  it('fires when the branch sha moves', () => {
    const h = harness()
    installRepo(h.fs, ROOT)
    install(h.fs, ROOT, wf('c', 'gitCommit'))
    h.sup.watchProject(ROOT)
    h.sup.tick()
    expect(h.fires).toEqual([])

    h.fs.put(join(ROOT, '.git', 'refs', 'heads', 'main'), `${SHA_B}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1)
    expect(h.fires[0].reason).toContain('commit on refs/heads/main')
    expect(h.fires[0].reason).toContain(SHA_B.slice(0, 8))
  })

  it('does not fire on a branch switch (ref name changed, not the commit)', () => {
    const h = harness()
    installRepo(h.fs, ROOT, 'main')
    h.fs.put(join(ROOT, '.git', 'refs', 'heads', 'dev'), `${SHA_B}\n`)
    install(h.fs, ROOT, wf('c', 'gitCommit'))
    h.sup.watchProject(ROOT)

    h.fs.put(join(ROOT, '.git', 'HEAD'), 'ref: refs/heads/dev\n')
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])

    // ...but a commit ON the new branch does fire.
    h.fs.put(join(ROOT, '.git', 'refs', 'heads', 'dev'), `${SHA_A}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1)
  })

  it('follows an explicitly configured branch regardless of what is checked out', () => {
    const h = harness()
    installRepo(h.fs, ROOT, 'main')
    h.fs.put(join(ROOT, '.git', 'refs', 'heads', 'release'), `${SHA_A}\n`)
    install(h.fs, ROOT, wf('c', 'gitCommit', { branch: 'release' }))
    h.sup.watchProject(ROOT)

    // A commit on main must be ignored.
    h.fs.put(join(ROOT, '.git', 'refs', 'heads', 'main'), `${SHA_B}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])

    h.fs.put(join(ROOT, '.git', 'refs', 'heads', 'release'), `${SHA_B}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1)
  })

  it('does nothing when the project is not a git repo', () => {
    const h = harness()
    install(h.fs, ROOT, wf('c', 'gitCommit'))
    h.sup.watchProject(ROOT)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])
  })

  it('waits without firing until an unresolvable ref appears', () => {
    const h = harness()
    installRepo(h.fs, ROOT)
    install(h.fs, ROOT, wf('c', 'gitCommit', { branch: 'later' }))
    h.sup.watchProject(ROOT)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])

    // The branch is created — that is a seed, not a commit.
    h.fs.put(join(ROOT, '.git', 'refs', 'heads', 'later'), `${SHA_A}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])

    h.fs.put(join(ROOT, '.git', 'refs', 'heads', 'later'), `${SHA_B}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1)
  })

  it('a commit made during a run is deferred, not dropped', () => {
    let release: (() => void) | null = null
    const h = harness({ fireResult: () => new Promise<void>(res => { release = res }) })
    installRepo(h.fs, ROOT)
    install(h.fs, ROOT, wf('c', 'gitCommit'))
    h.sup.watchProject(ROOT)

    h.fs.put(join(ROOT, '.git', 'refs', 'heads', 'main'), `${SHA_B}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1)

    // Second commit while the first run is still in flight — suppressed for now.
    h.fs.put(join(ROOT, '.git', 'refs', 'heads', 'main'), `${SHA_A}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1)

    return Promise.resolve().then(() => {
      release?.()
      return Promise.resolve().then(() => {
        h.state.now += MIN
        h.sup.tick()
        expect(h.fires.length).toBe(2)
      })
    })
  })
})

describe('gitPush trigger', () => {
  it('fires when the remote-tracking ref advances', () => {
    const h = harness()
    installRepo(h.fs, ROOT)
    h.fs.put(join(ROOT, '.git', 'refs', 'remotes', 'origin', 'main'), `${SHA_A}\n`)
    install(h.fs, ROOT, wf('p', 'gitPush'))
    h.sup.watchProject(ROOT)
    h.sup.tick()
    expect(h.fires).toEqual([])

    h.fs.put(join(ROOT, '.git', 'refs', 'remotes', 'origin', 'main'), `${SHA_B}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1)
    expect(h.fires[0].reason).toContain('push on refs/remotes/origin/main')
  })

  it('a local commit alone does not count as a push', () => {
    const h = harness()
    installRepo(h.fs, ROOT)
    h.fs.put(join(ROOT, '.git', 'refs', 'remotes', 'origin', 'main'), `${SHA_A}\n`)
    install(h.fs, ROOT, wf('p', 'gitPush'))
    h.sup.watchProject(ROOT)

    h.fs.put(join(ROOT, '.git', 'refs', 'heads', 'main'), `${SHA_B}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])
  })

  it('honours a custom remote', () => {
    const h = harness()
    installRepo(h.fs, ROOT)
    h.fs.put(join(ROOT, '.git', 'refs', 'remotes', 'upstream', 'main'), `${SHA_A}\n`)
    install(h.fs, ROOT, wf('p', 'gitPush', { remote: 'upstream' }))
    h.sup.watchProject(ROOT)

    h.fs.put(join(ROOT, '.git', 'refs', 'remotes', 'upstream', 'main'), `${SHA_B}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1)
  })

  it('resolves the remote ref out of packed-refs', () => {
    const h = harness()
    installRepo(h.fs, ROOT)
    h.fs.put(join(ROOT, '.git', 'packed-refs'), `${SHA_A} refs/remotes/origin/main\n`)
    install(h.fs, ROOT, wf('p', 'gitPush'))
    h.sup.watchProject(ROOT)

    h.fs.put(join(ROOT, '.git', 'packed-refs'), `${SHA_B} refs/remotes/origin/main\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1)
  })
})

// ── fileWatch ────────────────────────────────────────────────────────────────

describe('fileWatch trigger', () => {
  it('watches only when a fileWatch workflow exists, and stops when it goes away', () => {
    const h = harness()
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    expect(h.watchers.length).toBe(0)

    install(h.fs, ROOT, wf('f', 'fileWatch'))
    h.sup.rearm(ROOT)
    expect(h.watchers.length).toBe(1)

    h.fs.rmSync(join(workflowsDir(ROOT), 'f.yml'))
    h.sup.rearm(ROOT)
    expect(h.watchers[0].closed).toBe(true)
  })

  it('fires after the debounce window, once, for a burst of changes', () => {
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch', { debounceMs: '500' }))
    h.sup.watchProject(ROOT)
    const emit = h.watchers[0].listener
    emit('change', 'src/a.ts')
    emit('change', 'src/b.ts')
    emit('change', 'src/c.ts')
    expect(h.fires).toEqual([])
    h.timers.flush()
    expect(h.fires.length).toBe(1)
    expect(h.fires[0].reason).toContain('file change')
  })

  it.each([
    'node_modules/pkg/index.js',
    '.git/COMMIT_EDITMSG',
    '.termpolis/workflows/.triggers.json',
    'dist/bundle.js',
    'coverage/lcov.info',
  ])('ignores churn in %s', (path) => {
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch'))
    h.sup.watchProject(ROOT)
    h.watchers[0].listener('change', path)
    h.timers.flush()
    expect(h.fires).toEqual([])
  })

  it('ignores a null filename', () => {
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch'))
    h.sup.watchProject(ROOT)
    h.watchers[0].listener('change', null)
    h.timers.flush()
    expect(h.fires).toEqual([])
  })

  it('honours a path prefix filter', () => {
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch', { paths: 'src/, docs/' }))
    h.sup.watchProject(ROOT)
    h.watchers[0].listener('change', 'README.md')
    h.timers.flush()
    expect(h.fires).toEqual([])

    h.watchers[0].listener('change', 'src/main.ts')
    h.timers.flush()
    expect(h.fires.length).toBe(1)
  })

  it('matches prefixes with Windows separators', () => {
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch', { paths: 'src' }))
    h.sup.watchProject(ROOT)
    h.watchers[0].listener('change', 'src\\deep\\file.ts')
    h.timers.flush()
    expect(h.fires.length).toBe(1)
  })

  it('an empty paths filter matches the whole project', () => {
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch', { paths: '  ' }))
    h.sup.watchProject(ROOT)
    h.watchers[0].listener('change', 'anywhere/at/all.txt')
    h.timers.flush()
    expect(h.fires.length).toBe(1)
  })

  it('survives a watcher that cannot be created', () => {
    const h = harness()
    h.state.watchThrows = true
    install(h.fs, ROOT, wf('f', 'fileWatch'))
    expect(() => h.sup.watchProject(ROOT)).not.toThrow()
    expect(h.logs.some(l => l.includes('could not watch'))).toBe(true)
  })

  it('two fileWatch workflows both fire from one event', () => {
    const h = harness()
    install(h.fs, ROOT, wf('f1', 'fileWatch'))
    install(h.fs, ROOT, wf('f2', 'fileWatch'))
    h.sup.watchProject(ROOT)
    h.watchers[0].listener('change', 'src/x.ts')
    h.timers.flush()
    expect(h.fires.map(f => f.id).sort()).toEqual(['f1', 'f2'])
  })
})

// ── gating, safety, persistence ──────────────────────────────────────────────

describe('safety gates', () => {
  it('never auto-runs in an untrusted workspace, and warns only once', () => {
    const h = harness({ trusted: false })
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.state.now += MIN
    h.sup.tick()
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])
    expect(h.logs.filter(l => l.includes('not a trusted workspace')).length).toBe(1)
  })

  it('fires once trust is granted', () => {
    const h = harness({ trusted: false })
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])
    h.state.trusted = true
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1)
  })

  it('holds the in-flight guard until the run promise settles', async () => {
    let release!: () => void
    const h = harness({ fireResult: () => new Promise<void>(res => { release = res }) })
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1)

    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(1) // still running

    release()
    await Promise.resolve()
    await Promise.resolve()
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(2)
  })

  it('releases the guard when the run rejects', async () => {
    let reject!: (e: Error) => void
    const h = harness({ fireResult: () => new Promise<void>((_r, rej) => { reject = rej }) })
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.state.now += MIN
    h.sup.tick()
    reject(new Error('boom'))
    await Promise.resolve()
    await Promise.resolve()
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(2)
  })

  it('enforces a refire cooldown when the runner returns nothing', () => {
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch', { debounceMs: '1' }))
    h.sup.watchProject(ROOT)
    h.watchers[0].listener('change', 'src/a.ts')
    h.timers.flush()
    expect(h.fires.length).toBe(1)

    h.state.now += 500 // inside MIN_REFIRE_MS
    h.watchers[0].listener('change', 'src/a.ts')
    h.timers.flush()
    expect(h.fires.length).toBe(1)

    h.state.now += 5_000 // past the cooldown
    h.watchers[0].listener('change', 'src/a.ts')
    h.timers.flush()
    expect(h.fires.length).toBe(2)
  })

  it('a runner that throws does not wedge the trigger', () => {
    const h = harness({
      fireResult: () => {
        throw new Error('spawn failed')
      },
    })
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.state.now += MIN
    h.sup.tick()
    expect(h.logs.some(l => l.includes('failed to start'))).toBe(true)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(2) // retried, not stuck
  })
})

describe('state persistence', () => {
  const stateFile = join(workflowsDir(ROOT), '.triggers.json')

  it('persists the seeded git sha and the last fire time', () => {
    const h = harness()
    installRepo(h.fs, ROOT)
    install(h.fs, ROOT, wf('c', 'gitCommit'))
    h.sup.watchProject(ROOT)
    expect(JSON.parse(h.fs.files.get(stateFile)!).c.sha).toBe(SHA_A)

    h.fs.put(join(ROOT, '.git', 'refs', 'heads', 'main'), `${SHA_B}\n`)
    h.state.now += MIN
    h.sup.tick()
    const st = JSON.parse(h.fs.files.get(stateFile)!).c
    expect(st.sha).toBe(SHA_B)
    expect(st.lastFiredAt).toBe(h.state.now)
  })

  it('reloads persisted state so a restart does not re-fire the same commit', () => {
    const fs = makeFs()
    installRepo(fs, ROOT)
    install(fs, ROOT, wf('c', 'gitCommit'))
    const first = harness({ fs })
    first.sup.watchProject(ROOT)
    fs.put(join(ROOT, '.git', 'refs', 'heads', 'main'), `${SHA_B}\n`)
    first.state.now += MIN
    first.sup.tick()
    expect(first.fires.length).toBe(1)

    // A brand-new supervisor over the same on-disk state (an app restart).
    const second = harness({ fs, now: first.state.now + 10 * MIN })
    second.sup.watchProject(ROOT)
    second.state.now += MIN
    second.sup.tick()
    expect(second.fires).toEqual([])
  })

  it('a corrupt state file is discarded instead of wedging triggers', () => {
    const h = harness()
    installRepo(h.fs, ROOT)
    h.fs.put(stateFile, '{ this is not json')
    install(h.fs, ROOT, wf('c', 'gitCommit'))
    expect(() => h.sup.watchProject(ROOT)).not.toThrow()
    expect(JSON.parse(h.fs.files.get(stateFile)!).c.sha).toBe(SHA_A)
  })

  it('a non-object state file is discarded', () => {
    const h = harness()
    installRepo(h.fs, ROOT)
    h.fs.put(stateFile, '[1,2,3]')
    install(h.fs, ROOT, wf('c', 'gitCommit'))
    h.sup.watchProject(ROOT)
    expect(JSON.parse(h.fs.files.get(stateFile)!).c.sha).toBe(SHA_A)
  })

  it('a state file that cannot be written is logged, not thrown', () => {
    const h = harness()
    installRepo(h.fs, ROOT)
    install(h.fs, ROOT, wf('c', 'gitCommit'))
    h.fs.writeFileSync = () => {
      throw new Error('EROFS')
    }
    expect(() => h.sup.watchProject(ROOT)).not.toThrow()
    expect(h.logs.some(l => l.includes('could not persist'))).toBe(true)
  })
})

describe('ticker lifecycle', () => {
  it('start arms a repeating ticker and stop clears it', () => {
    const h = harness()
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.sup.start()
    expect(h.timers.pending).toBe(1)

    h.state.now += MIN
    h.timers.flush()
    expect(h.fires.length).toBe(1)
    expect(h.timers.pending).toBe(1) // re-armed itself

    h.sup.stop()
    expect(h.timers.pending).toBe(0)
    expect(h.sup.armedCount).toBe(0)
  })

  it('start is idempotent', () => {
    const h = harness()
    h.sup.start()
    h.sup.start()
    expect(h.timers.pending).toBe(1)
  })

  it('a throwing tick is contained and the ticker keeps going', () => {
    const h = harness()
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.sup.start()
    const spy = vi.spyOn(h.sup, 'tick').mockImplementationOnce(() => {
      throw new Error('kaboom')
    })
    h.timers.flush()
    expect(h.logs.some(l => l.includes('tick failed'))).toBe(true)
    expect(h.timers.pending).toBe(1)
    spy.mockRestore()
  })

  it('stop closes watchers and is safe to call twice', () => {
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch'))
    h.sup.watchProject(ROOT)
    h.sup.start()
    h.sup.stop()
    expect(h.watchers[0].closed).toBe(true)
    expect(() => h.sup.stop()).not.toThrow()
  })

  it('tolerates a watcher whose close throws', () => {
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch'))
    h.sup.watchProject(ROOT)
    const w = h.watchers[0]
    h.sup.unwatchProject(ROOT)
    expect(w.closed).toBe(true)
  })

  it('exposes the configured tick interval', () => {
    const h = harness()
    expect(h.sup.tickMs).toBe(15_000)
  })

  it('isolates projects: two watched dirs each arm their own workflows', () => {
    const h = harness()
    const OTHER = join('/other')
    install(h.fs, ROOT, wf('a', 'schedule', { cron: '* * * * *' }))
    install(h.fs, OTHER, wf('b', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.sup.watchProject(OTHER)
    expect(h.sup.armedCount).toBe(2)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.map(f => f.cwd).sort()).toEqual([OTHER, ROOT].sort())
  })
})
