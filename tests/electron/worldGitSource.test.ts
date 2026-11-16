import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BAD_REF_MESSAGE,
  BAD_URL_MESSAGE,
  CANCELLED_MESSAGE,
  CLEAR_MESSAGE,
  CLONE_MARKER,
  FINISH_MESSAGE,
  TOO_BIG_MESSAGE,
  cloneArgs,
  cloneKey,
  cloneRepo,
  dirSizeOf,
  listNames,
  nodeExecFile,
  pathExists,
  removeDir,
  validateGitUrl,
  type CloneDeps,
  type ExecFn
} from '../../src/main/world/gitSource'

const URL1 = 'https://github.com/a/b.git'
const REPOS = join('/ud', 'world', 'repos')
const HASH = cloneKey(URL1)
const ROOT = join(REPOS, HASH)
const WORK = `${ROOT}.tmp-r1`

function mkDeps(over: Partial<CloneDeps> = {}) {
  const calls: { cmd: string; args: string[]; opts: Parameters<ExecFn>[2] }[] = []
  const rm = vi.fn(async (_p: string) => undefined)
  const mark = vi.fn(async (_p: string) => undefined)
  const rename = vi.fn(async (_a: string, _b: string) => undefined)
  const deps: CloneDeps = {
    execFile: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return { code: 0, stderr: '' }
    },
    baseDir: join('/ud'),
    dirSize: async () => 10,
    rm,
    isWindows: false,
    exists: async () => false,
    listDir: async () => [],
    mark,
    rename,
    random: () => 'r1',
    ...over
  }
  return { deps, calls, rm, mark, rename }
}

const FLAGS = ['-c', 'protocol.file.allow=never', '-c', 'core.hooksPath=/dev/null']

describe('validateGitUrl', () => {
  it.each(['--upload-pack=x', 'ext::sh -c touch/tmp/x', 'file:///etc', 'C:\\x', '-oProxyCommand=x', '', 'https://a b/c', ' https://a/b', 'http://a/b', 'https://a/\nb', 'https://a/\u0000b'])(
    'rejects %j',
    (u) => {
      expect(validateGitUrl(u)).toEqual({ ok: false, reason: BAD_URL_MESSAGE })
    }
  )
  it('rejects a non-string', () => {
    expect(validateGitUrl(undefined as unknown as string).ok).toBe(false)
  })
  it.each(['https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@host/a/b'])('accepts %s', (u) => {
    expect(validateGitUrl(u)).toEqual({ ok: true })
  })
})

describe('cloneArgs', () => {
  it('puts -- before the url, is quiet, and carries the safety flags (Linux: /dev/null)', () => {
    const a = cloneArgs(URL1, '/d', undefined, false)
    expect(a).toEqual([
      ...FLAGS,
      'clone', '--quiet', '--depth', '1', '--filter=blob:none', '--single-branch', '--', URL1, '/d'
    ])
  })
  it('uses NUL on Windows and adds --branch before --', () => {
    const a = cloneArgs(URL1, 'C:/d', 'main', true)
    expect(a).toContain('core.hooksPath=NUL')
    expect(a.indexOf('--branch')).toBeLessThan(a.indexOf('--'))
    expect(a[a.indexOf('--branch') + 1]).toBe('main')
    expect(a[a.indexOf('--') + 1]).toBe(URL1)
  })
  it('defaults the platform from the process', () => {
    expect(cloneArgs(URL1, '/d')).toContain(`core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`)
  })
})

describe('cloneKey', () => {
  it('is 16 hex digits of sha1(url+ref)', () => {
    expect(cloneKey(URL1)).toMatch(/^[0-9a-f]{16}$/)
    expect(cloneKey(URL1, 'x')).not.toBe(cloneKey(URL1))
    expect(cloneKey(URL1, undefined)).toBe(cloneKey(URL1, ''))
  })
})

describe('cloneRepo', () => {
  it('refuses a hostile url and a bad branch before running anything', async () => {
    const { deps, calls, rm } = mkDeps()
    expect(await cloneRepo('--upload-pack=x', undefined, deps)).toEqual({ ok: false, error: BAD_URL_MESSAGE })
    for (const ref of ['-x', 'a..b', 'a b', '', 'a;b', 5 as unknown as string]) {
      expect(await cloneRepo(URL1, ref, deps)).toEqual({ ok: false, error: BAD_REF_MESSAGE })
    }
    expect(calls).toHaveLength(0)
    expect(rm).not.toHaveBeenCalled()
  })

  it('clones into a temp sibling, marks it, renames it into <base>/world/repos/<hash>', async () => {
    const { deps, calls, mark, rename } = mkDeps({ env: { PATH: 'p', GONE: undefined } })
    const r = await cloneRepo(URL1, undefined, deps)
    expect(r).toEqual({ ok: true, root: ROOT })
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('git')
    expect(calls[0].args).toEqual(cloneArgs(URL1, WORK, undefined, false))
    expect(calls[0].opts.env).toEqual({
      PATH: 'p',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'https:ssh',
      GIT_CEILING_DIRECTORIES: REPOS
    })
    expect(calls[0].opts.timeout).toBe(300_000)
    expect(calls[0].opts.signal).toBeInstanceOf(AbortSignal)
    expect(mark).toHaveBeenCalledWith(join(WORK, '.git', CLONE_MARKER))
    expect(rename).toHaveBeenCalledWith(WORK, ROOT)
  })

  it('defaults the env to process.env and still sets the safety variables', async () => {
    const { deps, calls } = mkDeps()
    await cloneRepo(URL1, 'v1.0/x', deps)
    expect(calls[0].opts.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(calls[0].opts.env.GIT_ALLOW_PROTOCOL).toBe('https:ssh')
    expect(calls[0].args).toContain('v1.0/x')
  })

  it('a 404 shows git\'s own error line, not "Cloning into", and leaves nothing at root', async () => {
    const stderr = [
      "Cloning into 'C:\\Users\\x\\world\\repos\\abc.tmp-r1'...",
      'remote: Repository not found.',
      "fatal: repository 'https://user:pw@github.com/a/b.git/' not found"
    ].join('\n')
    const { deps, rm, rename, mark } = mkDeps({ execFile: async () => ({ code: 128, stderr }) })
    const r = await cloneRepo(URL1, undefined, deps)
    expect(r).toEqual({ ok: false, error: "Couldn't reach that repository: remote: Repository not found." })
    expect(rm).toHaveBeenLastCalledWith(WORK)
    expect(rename).not.toHaveBeenCalled()
    expect(mark).not.toHaveBeenCalled()
  })

  it('an auth failure shows the fatal line, with any user:pass@ removed', async () => {
    const stderr = "Cloning into 'x'...\nfatal: could not read Username for 'https://user:pw@github.com': terminal prompts disabled"
    const { deps } = mkDeps({ execFile: async () => ({ code: 128, stderr }) })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({
      ok: false,
      error: "Couldn't reach that repository: fatal: could not read Username for 'https://***@github.com': terminal prompts disabled"
    })
  })

  it('without a fatal/error/remote line the first line is used; empty stderr and a rejecting execFile still clean up', async () => {
    const plain = mkDeps({ execFile: async () => ({ code: 1, stderr: '\nsomething odd\nmore' }) })
    expect(await cloneRepo(URL1, undefined, plain.deps)).toEqual({ ok: false, error: "Couldn't reach that repository: something odd" })
    const a = mkDeps({ execFile: async () => ({ code: 1, stderr: '' }) })
    expect(await cloneRepo(URL1, undefined, a.deps)).toEqual({ ok: false, error: "Couldn't reach that repository: no details" })
    const b = mkDeps({ execFile: async () => Promise.reject(new Error('spawn git ENOENT')) })
    expect(await cloneRepo(URL1, undefined, b.deps)).toEqual({ ok: false, error: "Couldn't reach that repository: spawn git ENOENT" })
    const c = mkDeps({ execFile: async () => Promise.reject('boom') })
    expect(await cloneRepo(URL1, undefined, c.deps)).toEqual({ ok: false, error: "Couldn't reach that repository: boom" })
    expect(c.rm).toHaveBeenLastCalledWith(WORK)
  })

  it('sweeps stale <hash>.tmp-* siblings (and only those), then clears root', async () => {
    const { deps, rm } = mkDeps({ listDir: async () => [`${HASH}.tmp-old`, `${HASH}.tmp-older`, 'other', `${cloneKey('https://x/y')}.tmp-z`, HASH] })
    await cloneRepo(URL1, undefined, deps)
    expect(rm.mock.calls.map((c) => c[0])).toEqual([join(REPOS, `${HASH}.tmp-old`), join(REPOS, `${HASH}.tmp-older`), ROOT])
  })

  it('an unmarked folder at root is not trusted: even with a .git it is deleted and cloned fresh', async () => {
    const seen: string[] = []
    const { deps, calls, rm } = mkDeps({
      exists: async (p) => {
        seen.push(p)
        return p === join(ROOT, '.git')
      }
    })
    await cloneRepo(URL1, undefined, deps)
    expect(seen).toEqual([join(ROOT, '.git', CLONE_MARKER)])
    expect(rm).toHaveBeenCalledWith(ROOT)
    expect(calls[0].args).toContain('clone')
  })

  it('an rm failure on root gives a friendly error and runs no git; a failing sweep is ignored', async () => {
    const a = mkDeps({ rm: vi.fn(async () => Promise.reject(new Error('EBUSY'))) })
    expect(await cloneRepo(URL1, undefined, a.deps)).toEqual({ ok: false, error: CLEAR_MESSAGE })
    expect(a.calls).toHaveLength(0)
    const b = mkDeps({
      listDir: async () => [`${HASH}.tmp-old`],
      rm: vi.fn(async (p: string) => {
        if (p.includes('.tmp-')) throw new Error('EBUSY')
      })
    })
    expect(await cloneRepo(URL1, undefined, b.deps)).toMatchObject({ ok: true })
  })

  it('size over the cap after git exits: removes the temp folder and gives the size error', async () => {
    const { deps, rm, rename } = mkDeps({ dirSize: async () => 3_000, maxBytes: 2_000 })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: TOO_BIG_MESSAGE })
    expect(rm).toHaveBeenLastCalledWith(WORK)
    expect(rename).not.toHaveBeenCalled()
  })

  it('a final size check that throws counts as 0', async () => {
    const { deps } = mkDeps({ dirSize: async () => Promise.reject(new Error('gone')) })
    expect(await cloneRepo(URL1, undefined, deps)).toMatchObject({ ok: true })
  })

  it('size over the cap while git runs: aborts git, removes the temp folder, ignores a failing size check', async () => {
    vi.useFakeTimers()
    try {
      let n = 0
      let seen: AbortSignal | undefined
      const sizedPaths: string[] = []
      const { deps, rm } = mkDeps({
        pollMs: 100,
        maxBytes: 1_000,
        dirSize: async (p) => {
          sizedPaths.push(p)
          n++
          if (n === 1) throw new Error('walk failed')
          return 5_000
        },
        execFile: (_c, _a, o) =>
          new Promise((resolve) => {
            seen = o.signal
            o.signal?.addEventListener('abort', () => resolve({ code: 143, stderr: 'killed' }))
          })
      })
      const p = cloneRepo(URL1, undefined, deps)
      await vi.advanceTimersByTimeAsync(350)
      expect(await p).toEqual({ ok: false, error: TOO_BIG_MESSAGE })
      expect(seen?.aborted).toBe(true)
      expect(rm).toHaveBeenLastCalledWith(WORK)
      expect(new Set(sizedPaths)).toEqual(new Set([WORK]))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a second size check while one is still running', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const resolvers: ((n: number) => void)[] = []
      let finish: () => void = () => undefined
      const { deps } = mkDeps({
        pollMs: 100,
        dirSize: () => {
          calls++
          return new Promise<number>((resolve) => resolvers.push(resolve))
        },
        execFile: () =>
          new Promise((resolve) => {
            finish = () => resolve({ code: 0, stderr: '' })
          })
      })
      const p = cloneRepo(URL1, undefined, deps)
      await vi.advanceTimersByTimeAsync(350)
      expect(calls).toBe(1)
      resolvers[0](1)
      finish()
      await vi.advanceTimersByTimeAsync(1)
      // the check after git exits asks once more
      resolvers[resolvers.length - 1](1)
      expect(await p).toMatchObject({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('an existing complete clone is pinned with --git-dir/--work-tree, with a ceiling, and never renamed', async () => {
    const seen: string[] = []
    const { deps, calls, rm, mark, rename } = mkDeps({
      exists: async (p) => {
        seen.push(p)
        return true
      }
    })
    const r = await cloneRepo(URL1, 'dev', deps)
    const root = join(REPOS, cloneKey(URL1, 'dev'))
    expect(r).toEqual({ ok: true, root })
    expect(seen).toEqual([join(root, '.git', CLONE_MARKER)])
    const pin = ['--git-dir', join(root, '.git'), '--work-tree', root]
    expect(calls.map((c) => c.args)).toEqual([
      [...FLAGS, ...pin, 'fetch', '--quiet', '--depth', '1', 'origin', 'dev'],
      [...FLAGS, ...pin, 'reset', '--hard', 'FETCH_HEAD']
    ])
    for (const c of calls) {
      expect(c.opts.env.GIT_CEILING_DIRECTORIES).toBe(REPOS)
      // the pin comes before the subcommand, so git never discovers a repository by searching upward
      expect(c.args.indexOf('--git-dir')).toBeLessThan(c.args.findIndex((a) => a === 'fetch' || a === 'reset'))
    }
    expect(rm).not.toHaveBeenCalled()
    expect(mark).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
  })

  it('an update without a ref fetches HEAD; a failed update keeps the earlier clone', async () => {
    const calls: string[][] = []
    const { deps, rm } = mkDeps({
      exists: async () => true,
      execFile: async (_c, args) => {
        calls.push(args)
        return { code: args.includes('fetch') ? 1 : 0, stderr: 'fatal: offline' }
      }
    })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: "Couldn't reach that repository: fatal: offline" })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('HEAD')
    expect(rm).not.toHaveBeenCalled()
  })

  it('an update that grows past the cap is deleted', async () => {
    const { deps, rm } = mkDeps({ exists: async () => true, dirSize: async () => 9, maxBytes: 5 })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: TOO_BIG_MESSAGE })
    expect(rm).toHaveBeenCalledWith(ROOT)
  })

  it('Windows deps use NUL on the fetch and reset too', async () => {
    const { deps, calls } = mkDeps({ isWindows: true, exists: async () => true })
    await cloneRepo(URL1, undefined, deps)
    expect(calls.every((c) => c.args.includes('core.hooksPath=NUL'))).toBe(true)
  })

  it('abort signal during git: removes the temp folder and returns Cancelled', async () => {
    const ctl = new AbortController()
    const { deps, rm, rename } = mkDeps({
      signal: ctl.signal,
      execFile: (_c, _a, o) =>
        new Promise((resolve) => {
          o.signal?.addEventListener('abort', () => resolve({ code: 143, stderr: 'terminated' }))
          ctl.abort()
        })
    })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: CANCELLED_MESSAGE })
    expect(rm).toHaveBeenLastCalledWith(WORK)
    expect(rename).not.toHaveBeenCalled()
  })

  it('a cancel that arrives before git starts still stops it', async () => {
    const ctl = new AbortController()
    let seen: AbortSignal | undefined
    const { deps } = mkDeps({
      signal: ctl.signal,
      exists: async () => {
        ctl.abort()
        return false
      },
      execFile: async (_c, _a, o) => {
        seen = o.signal
        return { code: 143, stderr: '' }
      }
    })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: CANCELLED_MESSAGE })
    expect(seen?.aborted).toBe(true)
  })

  it('an rm failure while cancelling or capping never rejects', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const stuck = vi.fn(async (_p: string) => Promise.reject(new Error('EBUSY: resource busy')))
    const a = mkDeps({ signal: ctl.signal, rm: stuck })
    expect(await cloneRepo(URL1, undefined, a.deps)).toEqual({ ok: false, error: CANCELLED_MESSAGE })
    const ctl2 = new AbortController()
    let first = true
    const b = mkDeps({
      signal: ctl2.signal,
      rm: vi.fn(async (_p: string) => {
        if (first) {
          first = false
          return
        }
        throw new Error('EBUSY')
      }),
      execFile: async () => {
        ctl2.abort()
        return { code: 143, stderr: '' }
      }
    })
    expect(await cloneRepo(URL1, undefined, b.deps)).toEqual({ ok: false, error: CANCELLED_MESSAGE })
    const c = mkDeps({
      dirSize: async () => 9,
      maxBytes: 1,
      rm: vi.fn(async (p: string) => {
        if (p === WORK) throw new Error('EBUSY')
      })
    })
    expect(await cloneRepo(URL1, undefined, c.deps)).toEqual({ ok: false, error: TOO_BIG_MESSAGE })
    const d = mkDeps({
      execFile: async () => ({ code: 128, stderr: 'fatal: x' }),
      rm: vi.fn(async (p: string) => {
        if (p === WORK) throw new Error('EBUSY')
      })
    })
    expect(await cloneRepo(URL1, undefined, d.deps)).toMatchObject({ ok: false })
  })

  it('an already-aborted signal runs nothing', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const { deps, calls } = mkDeps({ signal: ctl.signal })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: CANCELLED_MESSAGE })
    expect(calls).toHaveLength(0)
  })

  it('a failure to mark or rename the finished clone leaves root untouched and gives a friendly error', async () => {
    const m = mkDeps({ mark: vi.fn(async () => Promise.reject(new Error('disk full'))) })
    expect(await cloneRepo(URL1, undefined, m.deps)).toEqual({ ok: false, error: FINISH_MESSAGE })
    expect(m.rename).not.toHaveBeenCalled()
    expect(m.rm).toHaveBeenLastCalledWith(WORK)
    const r = mkDeps({ rename: vi.fn(async () => Promise.reject(new Error('EPERM'))) })
    expect(await cloneRepo(URL1, undefined, r.deps)).toEqual({ ok: false, error: FINISH_MESSAGE })
    expect(r.rm).toHaveBeenLastCalledWith(WORK)
    // the only folder ever removed or renamed onto is under repos/, and root was only cleared up front
    expect(r.rm.mock.calls.map((c) => c[0])).toEqual([ROOT, WORK])
  })
})

describe('cloneRepo with the real fs defaults', () => {
  let base = ''
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'world-git-ex-'))
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('clones to a temp folder, marks it, renames it into place; the next call updates it in place', async () => {
    const gitCalls: string[][] = []
    const deps: CloneDeps = {
      execFile: async (_c, args) => {
        gitCalls.push(args)
        if (args.includes('clone')) await mkdir(join(args[args.length - 1], '.git'), { recursive: true })
        return { code: 0, stderr: '' }
      },
      baseDir: base,
      dirSize: dirSizeOf,
      rm: removeDir,
      isWindows: false
    }
    const reposDir = join(base, 'world', 'repos')
    const root = join(reposDir, HASH)
    await mkdir(reposDir, { recursive: true })
    // a stale temp folder from a crashed clone is swept
    await mkdir(join(reposDir, `${HASH}.tmp-old`, '.git'), { recursive: true })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: true, root })
    expect(await pathExists(join(root, '.git', CLONE_MARKER))).toBe(true)
    expect(await pathExists(join(reposDir, `${HASH}.tmp-old`))).toBe(false)
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: true, root })
    expect(gitCalls[gitCalls.length - 1]).toContain('reset')
    // a folder with a .git but no marker (a killed clone) is not updated in place
    await rm(join(root, '.git', CLONE_MARKER))
    await cloneRepo(URL1, undefined, deps)
    expect(gitCalls[gitCalls.length - 1]).toContain('clone')
  })
})

describe('real deps', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'world-git-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const env = { PATH: process.env.PATH ?? '' }
  const node = (code: string, o: Partial<Parameters<ExecFn>[2]> = {}) =>
    nodeExecFile(process.execPath, ['-e', code], { env, timeout: 20_000, ...o })

  it('dirSizeOf sums files recursively, skips symlinks, and a missing folder is 0', async () => {
    await mkdir(join(dir, 'a', 'b'), { recursive: true })
    await writeFile(join(dir, 'a', 'x.txt'), '12345')
    await writeFile(join(dir, 'a', 'b', 'y.txt'), '123')
    try {
      await symlink(join(dir, 'a'), join(dir, 'link'), 'junction')
    } catch {
      // no symlink right: the sum is unaffected
    }
    expect(await dirSizeOf(dir)).toBe(8)
    expect(await dirSizeOf(join(dir, 'nope'))).toBe(0)
  })

  it('listNames lists a folder and a missing one is empty', async () => {
    await writeFile(join(dir, 'f1'), 'x')
    expect(await listNames(dir)).toEqual(['f1'])
    expect(await listNames(join(dir, 'nope'))).toEqual([])
  })

  it('removeDir deletes a tree and tolerates a missing one; pathExists tells', async () => {
    await mkdir(join(dir, 'c'), { recursive: true })
    await writeFile(join(dir, 'c', 'f'), 'x')
    expect(await pathExists(join(dir, 'c'))).toBe(true)
    await removeDir(join(dir, 'c'))
    expect(await pathExists(join(dir, 'c'))).toBe(false)
    await expect(removeDir(join(dir, 'c'))).resolves.toBeUndefined()
  })

  it('nodeExecFile resolves 0, a numeric exit with stderr, and a spawn failure (never rejects)', async () => {
    expect(await node('0')).toEqual({ code: 0, stderr: '' })
    const bad = await node('console.error("oops");process.exit(3)')
    expect(bad.code).toBe(3)
    expect(bad.stderr).toContain('oops')
    const quiet = await node('process.exit(4)')
    expect(quiet).toEqual({ code: 4, stderr: 'git exited with code 4' })
    const missing = await nodeExecFile(join(dir, 'no-such-binary'), [], { env, timeout: 20_000 })
    expect(missing.code).toBe(1)
    expect(missing.stderr).not.toBe('')
    // a command spawn rejects synchronously (an invalid argument) is still just a result
    const invalid = await nodeExecFile('bad\u0000cmd', [], { env, timeout: 20_000 })
    expect(invalid.code).toBe(1)
    expect(invalid.stderr).not.toBe('')
  })

  it('keeps only the first 64 KB of stderr', async () => {
    const r = await node(
      'process.stderr.write("x".repeat(200000));setTimeout(()=>{process.stderr.write("tail");process.exit(2)},150)'
    )
    expect(r.code).toBe(2)
    expect(r.stderr.length).toBeLessThan(200_000)
    expect(r.stderr.endsWith('tail')).toBe(false)
  })

  it('an AbortSignal resolves only after the child has exited', async () => {
    const pidFile = join(dir, 'pid')
    const ctl = new AbortController()
    const p = node(
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)`,
      { signal: ctl.signal }
    )
    for (let i = 0; i < 100 && !(await pathExists(pidFile)); i++) await new Promise((r) => setTimeout(r, 50))
    const pid = Number(await readFile(pidFile, 'utf8'))
    ctl.abort()
    const r = await p
    expect(r.code).not.toBe(0)
    // the child is gone by the time the promise resolves (signal 0 throws for a dead process)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('an already-aborted signal stops the child at once', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const r = await node('setInterval(()=>{},1000)', { signal: ctl.signal })
    expect(r.code).not.toBe(0)
  })

  it('a kill by signal still resolves with a failing code', async () => {
    const r = await node('process.kill(process.pid, "SIGTERM");setInterval(()=>{},1000)')
    expect(r.code).not.toBe(0)
  })

  it('a timeout kills the child and says it took too long', async () => {
    const r = await node('setInterval(()=>{},1000)', { timeout: 150 })
    expect(r).toEqual({ code: 1, stderr: 'it took too long' })
  })
})
