import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BAD_REF_MESSAGE,
  BAD_URL_MESSAGE,
  CANCELLED_MESSAGE,
  TOO_BIG_MESSAGE,
  cloneArgs,
  cloneKey,
  cloneRepo,
  dirSizeOf,
  nodeExecFile,
  pathExists,
  removeDir,
  validateGitUrl,
  type CloneDeps,
  type ExecFn
} from '../../src/main/world/gitSource'

const URL1 = 'https://github.com/a/b.git'

function mkDeps(over: Partial<CloneDeps> = {}) {
  const calls: { cmd: string; args: string[]; opts: Parameters<ExecFn>[2] }[] = []
  const rm = vi.fn(async () => undefined)
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
    ...over
  }
  return { deps, calls, rm }
}

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
  it('puts -- before the url and carries the safety flags (Linux: /dev/null)', () => {
    const a = cloneArgs(URL1, '/d', undefined, false)
    expect(a).toEqual([
      '-c', 'protocol.file.allow=never', '-c', 'core.hooksPath=/dev/null',
      'clone', '--depth', '1', '--filter=blob:none', '--single-branch', '--', URL1, '/d'
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

  it('clones into <base>/world/repos/<hash>; env forbids prompts and non-https/ssh protocols', async () => {
    const { deps, calls } = mkDeps({ env: { PATH: 'p', GONE: undefined } })
    const r = await cloneRepo(URL1, 'v1.0/x', deps)
    const root = join('/ud', 'world', 'repos', cloneKey(URL1, 'v1.0/x'))
    expect(r).toEqual({ ok: true, root })
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('git')
    expect(calls[0].args).toEqual(cloneArgs(URL1, root, 'v1.0/x', false))
    expect(calls[0].opts.env).toEqual({ PATH: 'p', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh' })
    expect(calls[0].opts.timeout).toBe(300_000)
    expect(calls[0].opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('defaults the env to process.env and still sets the two variables', async () => {
    const { deps, calls } = mkDeps()
    await cloneRepo(URL1, undefined, deps)
    expect(calls[0].opts.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(calls[0].opts.env.GIT_ALLOW_PROTOCOL).toBe('https:ssh')
  })

  it('non-zero exit: removes the folder and gives a friendly error with the first stderr line', async () => {
    const { deps, rm } = mkDeps({
      execFile: async () => ({ code: 128, stderr: '\nfatal: repository \'https://user:pw@x/a\' not found\nmore' })
    })
    const r = await cloneRepo(URL1, undefined, deps)
    expect(r).toEqual({ ok: false, error: "Couldn't reach that repository: fatal: repository 'https://***@x/a' not found" })
    const root = join('/ud', 'world', 'repos', cloneKey(URL1))
    expect(rm).toHaveBeenLastCalledWith(root)
  })

  it('an empty stderr and a rejecting execFile still give an error and clean up', async () => {
    const a = mkDeps({ execFile: async () => ({ code: 1, stderr: '' }) })
    expect(await cloneRepo(URL1, undefined, a.deps)).toEqual({ ok: false, error: "Couldn't reach that repository: no details" })
    const b = mkDeps({ execFile: async () => Promise.reject(new Error('spawn git ENOENT')) })
    expect(await cloneRepo(URL1, undefined, b.deps)).toEqual({ ok: false, error: "Couldn't reach that repository: spawn git ENOENT" })
    const c = mkDeps({ execFile: async () => Promise.reject('boom') })
    expect(await cloneRepo(URL1, undefined, c.deps)).toEqual({ ok: false, error: "Couldn't reach that repository: boom" })
    expect(c.rm.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('size over the cap after git exits: removes the folder and gives the size error', async () => {
    const { deps, rm } = mkDeps({ dirSize: async () => 3_000, maxBytes: 2_000 })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: TOO_BIG_MESSAGE })
    expect(rm).toHaveBeenLastCalledWith(join('/ud', 'world', 'repos', cloneKey(URL1)))
  })

  it('size over the cap while git runs: aborts git, removes the folder, ignores a failing size check', async () => {
    vi.useFakeTimers()
    try {
      let n = 0
      let seen: AbortSignal | undefined
      const { deps, rm } = mkDeps({
        pollMs: 100,
        maxBytes: 1_000,
        dirSize: async () => {
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
      expect(rm).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a second size check while one is still running', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      let release: () => void = () => undefined
      let finish: () => void = () => undefined
      const { deps } = mkDeps({
        pollMs: 100,
        dirSize: () => {
          calls++
          return new Promise<number>((resolve) => {
            release = () => resolve(1)
          })
        },
        execFile: () =>
          new Promise((resolve) => {
            finish = () => resolve({ code: 0, stderr: '' })
          })
      })
      const p = cloneRepo(URL1, undefined, { ...deps, dirSize: deps.dirSize })
      await vi.advanceTimersByTimeAsync(350)
      expect(calls).toBe(1)
      release()
      finish()
      // the final size check after git exits asks again, and is answered at once
      await vi.advanceTimersByTimeAsync(1)
      release()
      expect(await p).toMatchObject({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('an existing clone fetches and resets instead of cloning, with the same safety flags', async () => {
    const { deps, calls, rm } = mkDeps({ exists: async (p) => p.endsWith('.git') })
    const r = await cloneRepo(URL1, 'dev', deps)
    const root = join('/ud', 'world', 'repos', cloneKey(URL1, 'dev'))
    expect(r).toEqual({ ok: true, root })
    const flags = ['-c', 'protocol.file.allow=never', '-c', 'core.hooksPath=/dev/null']
    expect(calls.map((c) => c.args)).toEqual([
      [...flags, '-C', root, 'fetch', '--depth', '1', 'origin', 'dev'],
      [...flags, '-C', root, 'reset', '--hard', 'FETCH_HEAD']
    ])
    expect(rm).not.toHaveBeenCalled()
  })

  it('an existing clone without a ref fetches HEAD; a failed update keeps the earlier clone', async () => {
    const calls: string[][] = []
    const { deps, rm } = mkDeps({
      exists: async () => true,
      execFile: async (_c, args) => {
        calls.push(args)
        return { code: args.includes('fetch') ? 1 : 0, stderr: 'fatal: offline' }
      }
    })
    const r = await cloneRepo(URL1, undefined, deps)
    expect(r).toEqual({ ok: false, error: "Couldn't reach that repository: fatal: offline" })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('HEAD')
    expect(rm).not.toHaveBeenCalled()
  })

  it('an update that grows past the cap is deleted', async () => {
    const { deps, rm } = mkDeps({ exists: async () => true, dirSize: async () => 9, maxBytes: 5 })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: TOO_BIG_MESSAGE })
    expect(rm).toHaveBeenCalled()
  })

  it('Windows deps use NUL on the fetch and reset too', async () => {
    const { deps, calls } = mkDeps({ isWindows: true, exists: async () => true })
    await cloneRepo(URL1, undefined, deps)
    expect(calls.every((c) => c.args.includes('core.hooksPath=NUL'))).toBe(true)
  })

  it('abort signal during git: removes the folder and returns Cancelled', async () => {
    const ctl = new AbortController()
    const { deps, rm } = mkDeps({
      signal: ctl.signal,
      execFile: (_c, _a, o) =>
        new Promise((resolve) => {
          o.signal?.addEventListener('abort', () => resolve({ code: 143, stderr: 'terminated' }))
          ctl.abort()
        })
    })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: CANCELLED_MESSAGE })
    expect(rm).toHaveBeenLastCalledWith(join('/ud', 'world', 'repos', cloneKey(URL1)))
  })

  it('an already-aborted signal runs nothing', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const { deps, calls } = mkDeps({ signal: ctl.signal })
    expect(await cloneRepo(URL1, undefined, deps)).toEqual({ ok: false, error: CANCELLED_MESSAGE })
    expect(calls).toHaveLength(0)
  })
})

describe('cloneRepo default exists', () => {
  it('checks the real filesystem for an existing clone when none is injected', async () => {
    const base = await mkdtemp(join(tmpdir(), 'world-git-ex-'))
    try {
      const { deps, calls } = mkDeps({ baseDir: base, exists: undefined })
      await cloneRepo(URL1, undefined, deps)
      expect(calls[0].args).toContain('clone')
      await mkdir(join(base, 'world', 'repos', cloneKey(URL1), '.git'), { recursive: true })
      await cloneRepo(URL1, undefined, deps)
      expect(calls[calls.length - 1].args).toContain('reset')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
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

  it('removeDir deletes a tree and tolerates a missing one; pathExists tells', async () => {
    await mkdir(join(dir, 'c'), { recursive: true })
    await writeFile(join(dir, 'c', 'f'), 'x')
    expect(await pathExists(join(dir, 'c'))).toBe(true)
    await removeDir(join(dir, 'c'))
    expect(await pathExists(join(dir, 'c'))).toBe(false)
    await expect(removeDir(join(dir, 'c'))).resolves.toBeUndefined()
  })

  it('nodeExecFile resolves 0, a numeric exit with stderr, and a spawn failure (never rejects)', async () => {
    const env = { PATH: process.env.PATH ?? '' }
    expect(await nodeExecFile(process.execPath, ['-e', '0'], { env, timeout: 20_000 })).toEqual({ code: 0, stderr: '' })
    const bad = await nodeExecFile(process.execPath, ['-e', 'console.error("oops");process.exit(3)'], { env, timeout: 20_000 })
    expect(bad.code).toBe(3)
    expect(bad.stderr).toContain('oops')
    const quiet = await nodeExecFile(process.execPath, ['-e', 'process.exit(4)'], { env, timeout: 20_000 })
    expect(quiet.code).toBe(4)
    expect(quiet.stderr).toContain('Command failed')
    const missing = await nodeExecFile(join(dir, 'no-such-binary'), [], { env, timeout: 20_000 })
    expect(missing.code).toBe(1)
    expect(missing.stderr).not.toBe('')
  })
})
