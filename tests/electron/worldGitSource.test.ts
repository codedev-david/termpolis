import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stripUrlUserinfo } from '../../src/shared/world/gitUrl'
import {
  AUTH_MESSAGE,
  BAD_REF_MESSAGE,
  BAD_URL_MESSAGE,
  CANCELLED_MESSAGE,
  CLEAR_MESSAGE,
  CLONE_MARKER,
  FINISH_MESSAGE,
  DROPPED_ENV,
  NO_GIT_MESSAGE,
  TIMEOUT_MESSAGE,
  TOO_BIG_MESSAGE,
  cloneArgs,
  cloneKey,
  cloneRepo,
  dirSizeOf,
  listNames,
  nodeExecFile,
  pathExists,
  renameWithRetry,
  removeDir,
  safetyFlags,
  validateGitUrl,
  type CloneDeps,
  type ExecFn
} from '../../src/main/world/gitSource'
import { resolveGitBin } from '../../src/main/binPath'

const URL1 = 'https://github.com/a/b.git'
const REPOS = join('/ud', 'world', 'repos')
const HASH = cloneKey(URL1)
const ROOT = join(REPOS, HASH)
const WORK = `${ROOT}.tmp-r1`
/** Where the tests' git was found: every clone command starts exactly this path. */
const GIT = '/usr/bin/git'

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
    gitBin: async () => GIT,
    realpath: async (p) => p,
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

const FLAGS = [
  '-c', 'protocol.file.allow=never',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.symlinks=false',
  '-c', 'credential.helper=',
  '-c', 'credential.interactive=false',
  '-c', 'core.askPass='
]

describe('stripUrlUserinfo', () => {
  it('drops https user-info and leaves every other URL as it was', () => {
    const userinfo = 'u' + ':' + 'p'
    expect(stripUrlUserinfo(`https://${userinfo}@h.example/r.git`)).toBe('https://h.example/r.git')
    expect(stripUrlUserinfo(`HTTPS://${userinfo}@h.example/r`)).toBe('HTTPS://h.example/r')
    expect(stripUrlUserinfo('https://name@h.example/r')).toBe('https://h.example/r')
    expect(stripUrlUserinfo('https://h.example/team@x/r')).toBe('https://h.example/team@x/r')
    for (const u of ['https://h.example/r.git', 'ssh://git@h.example/r', 'git@h.example:r.git', '/']) expect(stripUrlUserinfo(u)).toBe(u)
  })
})

describe('validateGitUrl', () => {
  it.each(['--upload-pack=x', 'ext::sh -c touch/tmp/x', 'file:///etc', 'C:\\x', '-oProxyCommand=x', '', 'ssh://-oProxyCommand=x/a', 'ssh://a@-o/x', 'git@-oX:a/b', 'https://-x/a', 'https://u@-x/a', 'https://a b/c', ' https://a/b', 'http://a/b', 'https://a/\nb', 'https://a/\u0000b'])(
    'rejects %j',
    (u) => {
      expect(validateGitUrl(u)).toEqual({ ok: false, reason: BAD_URL_MESSAGE })
    }
  )
  it('rejects a non-string', () => {
    expect(validateGitUrl(undefined as unknown as string).ok).toBe(false)
  })
  it.each(['https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@host/a/b', 'https://host/-a/b', 'ssh://git@my-host/a'])('accepts %s', (u) => {
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
  it('never lets git ask for a login: an empty helper list, no askpass, no interactive helper, no symlinks', () => {
    expect(safetyFlags(true)).toEqual(FLAGS.map((f) => (f === 'core.hooksPath=/dev/null' ? 'core.hooksPath=NUL' : f)))
    expect(safetyFlags(false)).toEqual(FLAGS)
  })
})

describe('cloneKey', () => {
  it('is 16 hex digits of sha1(url+ref)', () => {
    expect(cloneKey(URL1)).toMatch(/^[0-9a-f]{16}$/)
    expect(cloneKey(URL1, 'x')).not.toBe(cloneKey(URL1))
    expect(cloneKey(URL1, undefined)).toBe(cloneKey(URL1, ''))
  })
  it('separates the url from the branch, so moving characters between them changes the key', () => {
    expect(cloneKey('https://h/ab', 'c')).not.toBe(cloneKey('https://h/a', 'bc'))
  })
})

describe('cloneRepo', () => {
  it('a url with a login in it: the clone keeps no login in its config (origin is set to the bare url)', async () => {
    const userinfo = 'u' + ':' + 'p'
    const withLogin = `https://${userinfo}@h.example/team/r.git`
    const bare = 'https://h.example/team/r.git'
    // The argument list: clone with the login, then set-url with the same safety flags.
    const m = mkDeps()
    expect(await cloneRepo(withLogin, undefined, m.deps)).toMatchObject({ ok: true })
    const work = `${join(REPOS, cloneKey(withLogin))}.tmp-r1`
    expect(m.calls.map((c) => c.args)).toEqual([
      cloneArgs(withLogin, work, undefined, false),
      [...FLAGS, '--git-dir', join(work, '.git'), 'remote', 'set-url', 'origin', bare]
    ])
    expect(m.calls[1].opts.env).toEqual(m.calls[0].opts.env)

    // A real repository (made locally: no network), so the config git writes is what is read back.
    const base = await mkdtemp(join(tmpdir(), 'world-clone-login-'))
    try {
      const isWindows = process.platform === 'win32'
      const real = mkDeps({
        baseDir: base,
        isWindows,
        env: process.env,
        dirSize: async () => 10,
        rm: removeDir,
        listDir: listNames,
        exists: pathExists,
        mark: undefined,
        rename: undefined,
        gitBin: resolveGitBin,
        execFile: async (cmd, args, opts) => {
          if (!args.includes('clone')) return nodeExecFile(cmd, args, opts)
          const [from, dir] = args.slice(-2)
          await nodeExecFile('git', ['init', '-q', dir], opts)
          return nodeExecFile('git', ['-C', dir, 'remote', 'add', 'origin', from], opts)
        }
      })
      const r = await cloneRepo(withLogin, undefined, real.deps)
      expect(r).toEqual({ ok: true, root: join(base, 'world', 'repos', cloneKey(withLogin)) })
      const config = await readFile(join((r as { root: string }).root, '.git', 'config'), 'utf8')
      expect(config).toContain(bare)
      expect(config).not.toContain(userinfo)
      expect(config).not.toContain('@h.example')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('refuses a hostile url and a bad branch before running anything', async () => {
    const { deps, calls, rm } = mkDeps()
    expect(await cloneRepo('--upload-pack=x', undefined, deps)).toEqual({ ok: false, error: BAD_URL_MESSAGE })
    for (const ref of ['-x', 'a..b', 'a b', '', 'a;b', 5 as unknown as string]) {
      expect(await cloneRepo(URL1, ref, deps)).toEqual({ ok: false, error: BAD_REF_MESSAGE })
    }
    expect(calls).toHaveLength(0)
    expect(rm).not.toHaveBeenCalled()
  })

  it('starts git by the full path it found, never the bare name', async () => {
    const { deps, calls } = mkDeps()
    expect(await cloneRepo(URL1, undefined, deps)).toMatchObject({ ok: true })
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.cmd === GIT)).toBe(true)
  })

  it('with no git, or a git planted in the clone folder, starts nothing and says git was not found', async () => {
    const planted = [join(REPOS, 'git.exe'), join(ROOT, 'git.exe'), join(ROOT, 'tools', 'git')]
    for (const gitBin of [async () => null, ...planted.map((p) => async () => p)]) {
      const { deps, calls, rm } = mkDeps({ gitBin })
      expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: NO_GIT_MESSAGE })
      expect(calls).toHaveLength(0)
      expect(rm).not.toHaveBeenCalled()
    }
    expect(NO_GIT_MESSAGE).toMatch(/^Lumopolis needs git/)
  })

  it('clones into a temp sibling, marks it, renames it into <base>/world/repos/<hash>', async () => {
    const { deps, calls, mark, rename } = mkDeps({ env: { PATH: 'p', GONE: undefined }, now: () => 1000 })
    const r = await cloneRepo(URL1, undefined, deps)
    expect(r).toEqual({ ok: true, root: ROOT })
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe(GIT)
    expect(calls[0].args).toEqual(cloneArgs(URL1, WORK, undefined, false))
    expect(calls[0].opts.env).toEqual({
      PATH: 'p',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      SSH_ASKPASS_REQUIRE: 'never',
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
    expect(calls[0].opts.timeout).toBeGreaterThan(0)
    expect(calls[0].opts.timeout).toBeLessThanOrEqual(300_000)
  })

  it('drops inherited variables that point git elsewhere or run an askpass program, in any case', async () => {
    const env: Record<string, string> = { PATH: 'p' }
    for (const k of DROPPED_ENV) env[k] = 'x'
    env.git_dir = 'x'
    env.Ssh_AskPass = 'x'
    const { deps, calls } = mkDeps({ env })
    await cloneRepo(URL1, undefined, deps)
    expect(Object.keys(calls[0].opts.env).sort()).toEqual(
      ['GCM_INTERACTIVE', 'GIT_ALLOW_PROTOCOL', 'GIT_CEILING_DIRECTORIES', 'GIT_TERMINAL_PROMPT', 'PATH', 'SSH_ASKPASS_REQUIRE'].sort()
    )
    expect(DROPPED_ENV).toEqual(expect.arrayContaining(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_PARAMETERS', 'GIT_ASKPASS', 'SSH_ASKPASS']))
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

  it('a repository that needs a sign-in gives the plain in-app message, never a prompt', async () => {
    for (const line of [
      "fatal: could not read Username for 'https://user:pw@github.com': terminal prompts disabled",
      "remote: Invalid username or token. fatal: Authentication failed for 'https://github.com/a/b.git/'",
      'git@github.com: Permission denied (publickey).',
      'Host key verification failed.',
      'remote: Access denied'
    ]) {
      const { deps, rm } = mkDeps({ execFile: async () => ({ code: 128, stderr: `Cloning into 'x'...\n${line}` }) })
      expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: AUTH_MESSAGE })
      expect(rm).toHaveBeenLastCalledWith(WORK)
    }
    expect(AUTH_MESSAGE).not.toMatch(/user:pw/)
  })

  it('one 5-minute deadline: a first clone that runs out removes its temp folder', async () => {
    let t = 0
    const { deps, rm, rename } = mkDeps({
      now: () => t,
      execFile: async (_c, _a, opts) => {
        expect(opts.timeout).toBe(300_000)
        t = 300_000
        return { code: 1, stderr: 'it took too long' }
      }
    })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: TIMEOUT_MESSAGE })
    expect(rm).toHaveBeenLastCalledWith(WORK)
    expect(rename).not.toHaveBeenCalled()
  })

  it('an update shares the deadline: the reset gets only what the fetch left', async () => {
    let t = 0
    const timeouts: number[] = []
    const { deps, rm } = mkDeps({
      exists: async () => true,
      now: () => t,
      execFile: async (_c, _a, opts) => {
        timeouts.push(opts.timeout)
        t += 200_000
        return { code: 0, stderr: '' }
      }
    })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: true, root: ROOT })
    expect(timeouts).toEqual([300_000, 100_000])
    expect(rm).not.toHaveBeenCalled()
  })

  it('an update whose fetch runs out keeps the earlier clone; one whose reset runs out drops it', async () => {
    let t = 0
    const fetchOut = mkDeps({
      exists: async () => true,
      now: () => t,
      execFile: async () => {
        t = 300_000
        return { code: 1, stderr: 'it took too long' }
      }
    })
    expect(await cloneRepo(URL1, undefined, fetchOut.deps)).toEqual({ ok: false, error: TIMEOUT_MESSAGE })
    expect(fetchOut.rm).not.toHaveBeenCalled()

    t = 0
    const resetOut = mkDeps({
      exists: async () => true,
      now: () => t,
      execFile: async (_c, args) => {
        if (args.includes('reset')) {
          t = 300_000
          return { code: 1, stderr: 'it took too long' }
        }
        return { code: 0, stderr: '' }
      }
    })
    expect(await cloneRepo(URL1, undefined, resetOut.deps)).toEqual({ ok: false, error: TIMEOUT_MESSAGE })
    expect(resetOut.rm).toHaveBeenCalledWith(ROOT)
  })

  it('no time left before a step: that step never runs', async () => {
    let t = 0
    const calls: string[][] = []
    const { deps, rm } = mkDeps({
      exists: async () => true,
      now: () => t,
      execFile: async (_c, args) => {
        calls.push(args)
        t = 300_000 // the fetch finished exactly at the deadline
        return { code: 0, stderr: '' }
      }
    })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: TIMEOUT_MESSAGE })
    expect(calls).toHaveLength(1)
    expect(rm).toHaveBeenCalledWith(ROOT)

    let first = true
    const late = mkDeps({
      now: () => {
        if (first) {
          first = false
          return 0
        }
        return 400_000
      }
    })
    expect(await cloneRepo(URL1, undefined, late.deps)).toEqual({ ok: false, error: TIMEOUT_MESSAGE })
    expect(late.calls).toHaveLength(0)
    expect(late.rm).toHaveBeenLastCalledWith(WORK)
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
    const stuck = vi.fn(async (p: string) => {
      if (p === WORK) throw new Error('EBUSY: resource busy')
    })
    const a = mkDeps({
      signal: ctl.signal,
      rm: stuck,
      execFile: async () => {
        ctl.abort()
        return { code: 143, stderr: '' }
      }
    })
    expect(await cloneRepo(URL1, undefined, a.deps)).toEqual({ ok: false, error: CANCELLED_MESSAGE })
    expect(stuck).toHaveBeenCalledWith(WORK)
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

describe('rename retry', () => {
  const err = (code: string) => Object.assign(new Error(code), { code })

  it('a transient EPERM is retried with a growing backoff and the clone is kept', async () => {
    const sleeps: number[] = []
    const rename = vi.fn(async (_a: string, _b: string) => undefined)
    rename.mockRejectedValueOnce(err('EPERM')).mockRejectedValueOnce(err('EBUSY'))
    const { deps, rm } = mkDeps({ rename, sleep: async (ms) => void sleeps.push(ms) })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: true, root: ROOT })
    expect(rename).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([100, 200])
    expect(rm).not.toHaveBeenCalledWith(WORK)
  })

  it('a rename that keeps failing gives the friendly error and removes the temp folder', async () => {
    const sleeps: number[] = []
    const rename = vi.fn(async (_a: string, _b: string) => Promise.reject(err('EACCES')))
    const { deps, rm } = mkDeps({ rename, sleep: async (ms) => void sleeps.push(ms) })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: FINISH_MESSAGE })
    expect(rename).toHaveBeenCalledTimes(5)
    expect(sleeps).toEqual([100, 200, 300, 400])
    expect(rm).toHaveBeenLastCalledWith(WORK)
  })

  it('another error code, or none, is not retried', async () => {
    for (const e of [err('ENOENT'), new Error('plain')]) {
      const rename = vi.fn(async (_a: string, _b: string) => Promise.reject(e))
      const sleep = vi.fn(async (_ms: number) => undefined)
      await expect(renameWithRetry(rename, sleep, 'a', 'b')).rejects.toBe(e)
      expect(rename).toHaveBeenCalledTimes(1)
      expect(sleep).not.toHaveBeenCalled()
    }
  })

  it('the default sleep really waits (a short backoff)', async () => {
    const rename = vi.fn(async (_a: string, _b: string) => undefined)
    rename.mockRejectedValueOnce(err('EPERM'))
    const { deps } = mkDeps({ rename, sleep: undefined })
    const t0 = Date.now()
    expect(await cloneRepo(URL1, undefined, deps)).toMatchObject({ ok: true })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90)
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
      gitBin: async () => GIT,
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

  it('nodeExecFile with stdoutMax collects stdout, fails past the cap, and says when the program is missing', async () => {
    expect(await node('process.stdout.write("a.ts\\nb.ts\\n")', { stdoutMax: 1000 })).toEqual({ code: 0, stderr: '', stdout: 'a.ts\nb.ts\n', missing: false })
    // A failed run hands back no partial listing.
    expect(await node('process.stdout.write("half");process.exit(2)', { stdoutMax: 1000 })).toMatchObject({ code: 2, stdout: '', missing: false })
    const big = await node('process.stdout.write("x".repeat(5000));setTimeout(()=>{},5000)', { stdoutMax: 100 })
    expect(big).toMatchObject({ code: 1, stderr: 'too much output', stdout: '', missing: false })
    expect(await nodeExecFile(join(dir, 'no-such-binary'), [], { env, timeout: 20_000, stdoutMax: 100 })).toMatchObject({ code: 1, stdout: '', missing: true })
    // Without stdoutMax the result keeps its old shape.
    expect(await node('process.stdout.write("ignored")')).toEqual({ code: 0, stderr: '' })
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
