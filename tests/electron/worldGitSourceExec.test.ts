import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginConfig, OLD_GIT_MESSAGE, type LoginRun } from '../../src/main/world/gitLogin'
import {
  AUTH_MESSAGE,
  CANCELLED_MESSAGE,
  NO_GIT_MESSAGE,
  SSH_AUTH_MESSAGE,
  cloneArgs,
  cloneKey,
  cloneRepo,
  type CloneDeps,
  type ExecOpts,
  type ExecResult
} from '../../src/main/world/gitSource'

// A child that never closes after it is killed (a grandchild keeps its stderr open): the wrapper must
// still resolve once the grace period passes.
class FakeChild extends EventEmitter {
  stderr = new EventEmitter()
  kill = vi.fn()
}
let child: FakeChild
const spawnCalls: unknown[][] = []

vi.mock('node:child_process', () => ({
  spawn: (...a: unknown[]) => {
    spawnCalls.push(a)
    return child
  }
}))

afterEach(() => {
  vi.resetModules()
})

describe('nodeExecFile when the child does not close after a kill', () => {
  it('gives up after the grace period (a timeout wins over stderr); a timeout then an abort kills once', async () => {
    child = new FakeChild()
    const { nodeExecFile } = await import('../../src/main/world/gitSource')
    const ctl = new AbortController()
    const p = nodeExecFile('git', [], { env: {}, timeout: 10, signal: ctl.signal, killGraceMs: 60 })
    child.stderr.emit('data', Buffer.from('fatal: partial'))
    await new Promise((r) => setTimeout(r, 30))
    ctl.abort()
    expect(await p).toEqual({ code: 1, stderr: 'it took too long' })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('without any stderr the message says it was stopped; the default grace is used when none is given', async () => {
    child = new FakeChild()
    vi.useFakeTimers()
    try {
      const { nodeExecFile, KILL_GRACE_MS } = await import('../../src/main/world/gitSource')
      const ctl = new AbortController()
      const p = nodeExecFile('git', [], { env: {}, timeout: 60_000, signal: ctl.signal })
      ctl.abort()
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS)
      expect(await p).toEqual({ code: 1, stderr: 'it was stopped' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a timeout whose kill also runs out the grace period still reads "took too long"', async () => {
    child = new FakeChild()
    const { nodeExecFile } = await import('../../src/main/world/gitSource')
    const r = await nodeExecFile('git', [], { env: {}, timeout: 10, killGraceMs: 20 })
    expect(r).toEqual({ code: 1, stderr: 'it took too long' })
  })
})

describe('nodeExecFile cwd', () => {
  it('passes cwd to spawn', async () => {
    child = new FakeChild()
    spawnCalls.length = 0
    const { nodeExecFile } = await import('../../src/main/world/gitSource')
    const p = nodeExecFile('git', ['config', '--list', '-z'], { env: { A: '1' }, timeout: 10_000, cwd: '/ud' })
    child.emit('close', 0)
    expect(await p).toEqual({ code: 0, stderr: '' })
    expect(spawnCalls[0][2]).toMatchObject({ cwd: '/ud', env: { A: '1' }, windowsHide: true })
    child = new FakeChild()
    const q = nodeExecFile('git', [], { env: {}, timeout: 10_000 })
    child.emit('close', 0)
    await q
    expect((spawnCalls[1][2] as { cwd?: string }).cwd).toBeUndefined()
  })
})

// ── Login modes, the sign-in result, the git version gate and the update's changed flag ──────────
// The clone's deps are all fakes here: git is never started.

const GIT = '/usr/bin/git'
const BASE = join('/ud')
const REPOS = join(BASE, 'world', 'repos')
const HTTPS = 'https://github.com/o/r.git'
const LOGIN_WORDS = /credential|password|oauth|secret|token/i
const MODES: LoginRun[] = [{ mode: 'none' }, { mode: 'machine', interactive: false }, { mode: 'machine', interactive: true }, { mode: 'token' }]

type Call = { args: string[]; opts: ExecOpts }
/** What a fake git answers: `--version`, `rev-parse`, `config --list` and the clone/fetch/reset steps. */
interface Answers {
  version?: Partial<ExecResult>
  heads?: Array<Partial<ExecResult>>
  config?: Partial<ExecResult>
  step?: (args: string[]) => Partial<ExecResult>
}
function fakeDeps(a: Answers = {}, over: Partial<CloneDeps> = {}) {
  const calls: Call[] = []
  const heads = [...(a.heads ?? [])]
  const deps: CloneDeps = {
    execFile: async (_cmd, args, opts) => {
      calls.push({ args, opts })
      const done = (r: Partial<ExecResult>): ExecResult => ({ code: 0, stderr: '', ...r })
      if (args.includes('--version')) return done(a.version ?? { stdout: 'git version 2.47.1', missing: false })
      if (args.includes('rev-parse')) return done(heads.shift() ?? { stdout: 'aaaa\n' })
      if (args.includes('config') && args.includes('--list')) return done(a.config ?? { stdout: '' })
      return done(a.step ? a.step(args) : {})
    },
    gitBin: async () => GIT,
    realpath: async (p) => p,
    baseDir: BASE,
    dirSize: async () => 10,
    rm: async () => undefined,
    isWindows: false,
    exists: async () => false,
    listDir: async () => [],
    mark: async () => undefined,
    rename: async () => undefined,
    random: () => 'r1',
    env: { PATH: 'p' },
    ...over
  }
  const of = (word: string): Call[] => calls.filter((c) => c.args.includes(word))
  return { deps, calls, of }
}

describe('cloneRepo login modes', () => {
  it("clone env carries the mode's config and argv carries no login word", async () => {
    const seen: Call[] = []
    for (const run of MODES) {
      const { deps, of, calls } = fakeDeps()
      expect(await cloneRepo(HTTPS, undefined, deps, run)).toMatchObject({ ok: true, changed: true })
      const [clone] = of('clone')
      seen.push(clone)
      const env = clone.opts.env
      const pairs = loginConfig(run)
      expect(env.GIT_CONFIG_COUNT).toBe(String(pairs.length))
      pairs.forEach(([k, v], i) => {
        expect(env[`GIT_CONFIG_KEY_${i}`]).toBe(k)
        expect(env[`GIT_CONFIG_VALUE_${i}`]).toBe(v)
      })
      expect(Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_KEY_'))).toHaveLength(pairs.length)
      for (const c of calls) expect(c.args.join(' ')).not.toMatch(LOGIN_WORDS)
      expect(clone.args).toEqual(cloneArgs(HTTPS, `${join(REPOS, cloneKey(HTTPS))}.tmp-r1`, undefined, false))
      // Git Credential Manager may show its window only on a run the person asked for.
      if (run.mode === 'machine' && run.interactive) expect(env).not.toHaveProperty('GCM_INTERACTIVE')
      else if (run.mode !== 'token') expect(env.GCM_INTERACTIVE).toBe('never')
      expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never', GIT_ALLOW_PROTOCOL: 'https:ssh', GIT_CEILING_DIRECTORIES: REPOS, PATH: 'p' })
    }
    // Every other safety setting is the same in every mode: identical argv, and the env differs only in the login keys.
    const strip = (env: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_CONFIG_(COUNT|KEY_|VALUE_)|^GCM_INTERACTIVE$/.test(k)))
    for (const c of seen) {
      expect(c.args).toEqual(seen[0].args)
      expect(strip(c.opts.env)).toEqual(strip(seen[0].opts.env))
    }
  })

  it('with no mode given a run is the no-login mode', async () => {
    const { deps, of } = fakeDeps()
    await cloneRepo(HTTPS, undefined, deps)
    expect(of('clone')[0].opts.env).toMatchObject({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GCM_INTERACTIVE: 'never' })
  })

  it('an inherited numbered config never reaches git', async () => {
    const { deps, of } = fakeDeps({}, { env: { PATH: 'p', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'core.askPass', GIT_CONFIG_VALUE_1: '/evil', GCM_INTERACTIVE: 'always' } })
    await cloneRepo(HTTPS, undefined, deps, { mode: 'machine', interactive: false })
    const env = of('clone')[0].opts.env
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_1).toBe('core.askPass')
    expect(env.GIT_CONFIG_VALUE_1).toBe('')
    expect(env.GCM_INTERACTIVE).toBe('never')
    const one = fakeDeps({}, { env: { PATH: 'p', GIT_CONFIG_KEY_3: 'core.askPass', GIT_CONFIG_VALUE_3: '/evil' } })
    await cloneRepo(HTTPS, undefined, one.deps, { mode: 'token' })
    const env1 = one.of('clone')[0].opts.env
    expect(env1).not.toHaveProperty('GIT_CONFIG_KEY_3')
    expect(env1).not.toHaveProperty('GIT_CONFIG_VALUE_3')
  })

  it('an https sign-in failure returns needsLogin with the helper answer', async () => {
    const stderr = "Cloning into 'x'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled"
    const { deps, of, calls } = fakeDeps({ step: () => ({ code: 128, stderr }), config: { stdout: 'credential.helper\nmanager\0' } })
    expect(await cloneRepo(HTTPS, undefined, deps)).toEqual({ ok: false, error: AUTH_MESSAGE, needsLogin: { host: 'github.com', helper: true } })
    expect(of('--list')).toHaveLength(1)
    for (const c of calls) expect(c.args.join(' ')).not.toMatch(LOGIN_WORDS)
    // No helper set up: the same failure says so.
    const none = fakeDeps({ step: () => ({ code: 128, stderr }) })
    expect(await cloneRepo(HTTPS, undefined, none.deps)).toEqual({ ok: false, error: AUTH_MESSAGE, needsLogin: { host: 'github.com', helper: false } })
    // The host comes without a login in the url, in lower case, with its port.
    const named = fakeDeps({ step: () => ({ code: 128, stderr: 'remote: Invalid username or token.' }) })
    const r = await cloneRepo('https://me@Git.Example:8443/o/r.git', undefined, named.deps)
    expect(r).toEqual({ ok: false, error: AUTH_MESSAGE, needsLogin: { host: 'git.example:8443', helper: false } })
    expect(JSON.stringify(r)).not.toContain('me@')
    expect(AUTH_MESSAGE).toBe('That repository needs you to sign in. Sign in with the login this computer already uses for git, or use a token.')
  })

  it('a failed update of an https clone also says it needs a sign-in', async () => {
    const { deps } = fakeDeps(
      { step: (args) => (args.includes('fetch') ? { code: 128, stderr: "fatal: Authentication failed for 'https://github.com/o/r.git/'" } : {}) },
      { exists: async () => true }
    )
    expect(await cloneRepo(HTTPS, undefined, deps, { mode: 'machine', interactive: false })).toEqual({
      ok: false,
      error: AUTH_MESSAGE,
      needsLogin: { host: 'github.com', helper: false }
    })
  })

  it('ssh sign-in failures keep the ssh message and no needsLogin', async () => {
    for (const url of ['git@github.com:o/r.git', 'ssh://git@github.com/o/r.git']) {
      for (const line of ['git@github.com: Permission denied (publickey).', 'Host key verification failed.']) {
        const { deps, of } = fakeDeps({ step: () => ({ code: 128, stderr: line }), config: { stdout: 'credential.helper\nmanager\0' } })
        expect(await cloneRepo(url, undefined, deps)).toEqual({ ok: false, error: SSH_AUTH_MESSAGE })
        expect(of('--list')).toHaveLength(0)
      }
    }
    expect(SSH_AUTH_MESSAGE).toBe(
      "That repository needs you to sign in, and your ssh agent couldn't open it. Check that your ssh key is added, or clone it yourself and choose Open a folder."
    )
  })

  it('an interactive machine run that still fails returns needsLogin once and runs git once', async () => {
    const { deps, of } = fakeDeps({
      step: () => ({ code: 128, stderr: "fatal: Authentication failed for 'https://github.com/o/r.git/'" }),
      config: { stdout: 'credential.helper\nmanager\0' }
    })
    expect(await cloneRepo(HTTPS, undefined, deps, { mode: 'machine', interactive: true })).toEqual({
      ok: false,
      error: AUTH_MESSAGE,
      needsLogin: { host: 'github.com', helper: true }
    })
    expect(of('clone')).toHaveLength(1)
  })

  it('old git is refused in plain words', async () => {
    const rm = vi.fn(async () => undefined)
    const old = fakeDeps({ version: { stdout: 'git version 2.30.0\n', missing: false } }, { rm })
    expect(await cloneRepo(HTTPS, undefined, old.deps)).toEqual({ ok: false, error: OLD_GIT_MESSAGE })
    expect(old.of('clone')).toHaveLength(0)
    expect(rm).not.toHaveBeenCalled()
    const [v] = old.of('--version')
    expect(v.args).toEqual(['--version'])
    expect(v.opts.stdoutMax).toBeGreaterThan(0)
    expect(v.opts.env.PATH).toBe('p')
    // A version git does not print, or a failed run, is not trusted to read the login settings either.
    for (const version of [{ stdout: 'what' }, { code: 1, stdout: '' }, {}]) {
      const f = fakeDeps({ version })
      expect(await cloneRepo(HTTPS, undefined, f.deps)).toEqual({ ok: false, error: OLD_GIT_MESSAGE })
      expect(f.of('clone')).toHaveLength(0)
    }
    const rejects = fakeDeps()
    const inner = rejects.deps.execFile
    rejects.deps.execFile = async (c, args, o) => (args.includes('--version') ? Promise.reject(new Error('spawn failed')) : inner(c, args, o))
    expect(await cloneRepo(HTTPS, undefined, rejects.deps)).toEqual({ ok: false, error: OLD_GIT_MESSAGE })
    // A git that cannot be started says git was not found.
    const missing = fakeDeps({ version: { code: 1, stdout: '', missing: true } })
    expect(await cloneRepo(HTTPS, undefined, missing.deps)).toEqual({ ok: false, error: NO_GIT_MESSAGE })
  })

  it('the version is asked once per set of deps', async () => {
    const { deps, of } = fakeDeps()
    await cloneRepo(HTTPS, undefined, deps)
    await cloneRepo(HTTPS, 'main', deps)
    expect(of('--version')).toHaveLength(1)
    expect(of('clone')).toHaveLength(2)
    const other = fakeDeps()
    await cloneRepo(HTTPS, undefined, other.deps)
    expect(other.of('--version')).toHaveLength(1)
  })

  it('a cancel while the version is asked returns Cancelled and starts no clone', async () => {
    const ctl = new AbortController()
    const f = fakeDeps({}, { signal: ctl.signal })
    const inner = f.deps.execFile
    f.deps.execFile = async (c, args, o) => {
      if (args.includes('--version')) {
        expect(o.signal).toBe(ctl.signal)
        ctl.abort()
        return { code: 1, stderr: 'it was stopped', stdout: '', missing: false }
      }
      return inner(c, args, o)
    }
    expect(await cloneRepo(HTTPS, undefined, f.deps)).toEqual({ ok: false, error: CANCELLED_MESSAGE })
    expect(f.of('clone')).toHaveLength(0)
  })

  it('an update reports changed only when HEAD moved', async () => {
    const root = join(REPOS, cloneKey(HTTPS))
    const pin = ['--git-dir', join(root, '.git'), '--work-tree', root]
    const same = fakeDeps({ heads: [{ stdout: 'abc\n' }, { stdout: 'abc\n' }] }, { exists: async () => true })
    expect(await cloneRepo(HTTPS, undefined, same.deps)).toEqual({ ok: true, root, changed: false })
    // HEAD is read before the fetch and after the reset, pinned to the clone like every update step.
    expect(same.calls.filter((c) => !c.args.includes('--version')).map((c) => c.args.slice(-2))).toEqual([
      ['rev-parse', 'HEAD'],
      ['origin', 'HEAD'],
      ['--hard', 'FETCH_HEAD'],
      ['rev-parse', 'HEAD']
    ])
    for (const c of same.of('rev-parse')) {
      expect(c.args).toEqual(expect.arrayContaining(pin))
      expect(c.opts.stdoutMax).toBeGreaterThan(0)
    }
    const moved = fakeDeps({ heads: [{ stdout: 'abc\n' }, { stdout: 'def\n' }] }, { exists: async () => true })
    expect(await cloneRepo(HTTPS, undefined, moved.deps)).toEqual({ ok: true, root, changed: true })
    // A HEAD that cannot be read counts as moved, so a changed copy is never missed.
    const unreadable: Array<Array<Partial<ExecResult>>> = [
      [{ code: 1, stdout: '' }, { stdout: 'abc\n' }],
      [{ stdout: 'abc\n' }, { code: 1, stdout: '' }],
      [{ stdout: '' }, { stdout: '' }],
      [{ stdout: undefined }, { stdout: undefined }]
    ]
    for (const heads of unreadable) {
      const f = fakeDeps({ heads }, { exists: async () => true })
      expect(await cloneRepo(HTTPS, undefined, f.deps)).toEqual({ ok: true, root, changed: true })
    }
    const rejecting = fakeDeps({}, { exists: async () => true })
    const inner = rejecting.deps.execFile
    rejecting.deps.execFile = async (c, args, o) => (args.includes('rev-parse') ? Promise.reject(new Error('gone')) : inner(c, args, o))
    expect(await cloneRepo(HTTPS, undefined, rejecting.deps)).toEqual({ ok: true, root, changed: true })
  })

  it('a HEAD read after the deadline is skipped and counts as moved', async () => {
    let t = 0
    const f = fakeDeps({}, { exists: async () => true, now: () => t })
    const inner = f.deps.execFile
    f.deps.execFile = async (c, args, o) => {
      const r = await inner(c, args, o)
      // the reset finishes exactly at the deadline, so the last HEAD read has no time left
      if (args.includes('reset')) t = 300_000
      return r
    }
    expect(await cloneRepo(HTTPS, undefined, f.deps)).toMatchObject({ ok: true, changed: true })
    expect(f.of('rev-parse')).toHaveLength(1)
  })
})
