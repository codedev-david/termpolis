import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginConfig, OLD_GIT_MESSAGE, type LoginRun } from '../../src/main/world/gitLogin'
import * as gitSourceModule from '../../src/main/world/gitSource'
import {
  AUTH_MESSAGE,
  CANCELLED_MESSAGE,
  NO_GIT_MESSAGE,
  SSH_AUTH_MESSAGE,
  VERSION_FAILED_MESSAGE,
  cloneArgs,
  cloneKey,
  cloneRepo,
  type CloneDeps,
  type ExecOpts,
  type ExecResult
} from '../../src/main/world/gitSource'
import { TOKEN_EMPTY_MESSAGE, TOKEN_FORMAT_MESSAGE, TOKEN_REJECTED_MESSAGE } from '../../src/shared/world/repoAccess'

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
const TOKEN = 'tv-' + 'Q7'.repeat(20)
const TOKEN_RUN: LoginRun = { mode: 'token', value: TOKEN }
const ASKPASS = join('/res', 'git-askpass', 'askpass.sh')
const MODES: LoginRun[] = [{ mode: 'none' }, { mode: 'machine', interactive: false }, { mode: 'machine', interactive: true }, TOKEN_RUN]

/** Every command line any fake git saw that carried a login word or the pasted value; checked after each test. */
const leaks: string[] = []
afterEach(() => {
  expect(leaks).toEqual([])
  leaks.length = 0
})

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
      const line = args.join(' ')
      if (LOGIN_WORDS.test(line) || line.includes(TOKEN)) leaks.push(line)
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
    askpassPath: ASKPASS,
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
      Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_CONFIG_(COUNT|KEY_|VALUE_)|^GCM_INTERACTIVE$|^GIT_ASKPASS$|^TERMPOLIS_GIT_ASKPASS_|^GIT_TRACE_REDACT$/.test(k)))
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
    await cloneRepo(HTTPS, undefined, one.deps, TOKEN_RUN)
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

  // Found by the real-git fixture (worldGitHttps.test.ts): git 2.46 and newer, told credential.interactive=false
  // (the no-login run and a background machine run), skip the prompt and die with this line instead of
  // "terminal prompts disabled". It is a sign-in failure like the others.
  it("git's no-prompt line under credential.interactive=false also returns needsLogin", async () => {
    const stderr = "Cloning into 'x'...\nfatal: unable to get password from user"
    for (const run of [{ mode: 'none' }, { mode: 'machine', interactive: false }] as LoginRun[]) {
      const { deps } = fakeDeps({ step: () => ({ code: 128, stderr }), config: { stdout: 'credential.helper\nmanager\0' } })
      expect(await cloneRepo(HTTPS, undefined, deps, run)).toEqual({ ok: false, error: AUTH_MESSAGE, needsLogin: { host: 'github.com', helper: true } })
    }
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

  // A helper (or token) signed in to an account without access gets GitHub's 404, never a 401.
  const NOT_FOUND = [
    "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
    "fatal: repository 'https://github.com/o/r.git/' not found",
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404"
  ]
  const SIGNED_IN: LoginRun[] = [{ mode: 'machine', interactive: true }, { mode: 'machine', interactive: false }, TOKEN_RUN]

  // The spec gives a sign-in failure one message (design spec, Flow 1 and Copy): a signed-in account that
  // cannot see the repository gets the same sign-in message, and the renderer shows ipc's copy of it.
  it('a repository the signed-in account cannot see comes back as needing a sign-in, for machine and token runs', async () => {
    expect('notFoundMessage' in gitSourceModule).toBe(false)
    for (const run of SIGNED_IN) {
      // A token that cannot see the repository is a token that did not open it.
      const error = run.mode === 'token' ? TOKEN_REJECTED_MESSAGE : AUTH_MESSAGE
      for (const stderr of NOT_FOUND) {
        const { deps, of } = fakeDeps({ step: () => ({ code: 128, stderr }), config: { stdout: 'credential.helper\nmanager\0' } })
        expect(await cloneRepo(HTTPS, undefined, deps, run)).toEqual({ ok: false, error, needsLogin: { host: 'github.com', helper: true } })
        expect(of('clone')).toHaveLength(1)
      }
    }
    // An update whose fetch is refused that way says the same.
    const upd = fakeDeps({ step: (args) => (args.includes('fetch') ? { code: 128, stderr: NOT_FOUND[0] } : {}) }, { exists: async () => true })
    expect(await cloneRepo(HTTPS, undefined, upd.deps, TOKEN_RUN)).toEqual({ ok: false, error: TOKEN_REJECTED_MESSAGE, needsLogin: { host: 'github.com', helper: false } })
    const updMachine = fakeDeps({ step: (args) => (args.includes('fetch') ? { code: 128, stderr: NOT_FOUND[0] } : {}) }, { exists: async () => true })
    expect(await cloneRepo(HTTPS, undefined, updMachine.deps, { mode: 'machine', interactive: true })).toEqual({
      ok: false,
      error: AUTH_MESSAGE,
      needsLogin: { host: 'github.com', helper: false }
    })
  })

  it('with no login a missing repository stays a plain failure: a typo never asks for a sign-in', async () => {
    for (const stderr of NOT_FOUND) {
      const { deps, of } = fakeDeps({ step: () => ({ code: 128, stderr }), config: { stdout: 'credential.helper\nmanager\0' } })
      const r = await cloneRepo(HTTPS, undefined, deps, { mode: 'none' })
      expect(r).toEqual({ ok: false, error: expect.stringMatching(/^Couldn't reach that repository: /) })
      expect(r).not.toHaveProperty('needsLogin')
      expect(of('--list')).toHaveLength(0)
    }
    // ssh is the ssh agent's business in every mode.
    const ssh = fakeDeps({ step: () => ({ code: 128, stderr: 'ERROR: Repository not found.\nfatal: Could not read from remote repository.' }) })
    const r = await cloneRepo('git@github.com:o/r.git', undefined, ssh.deps, { mode: 'machine', interactive: true })
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/^Couldn't reach that repository: /) })
    expect(r).not.toHaveProperty('needsLogin')
  })

  it('the not-found answer never carries the login from the url', async () => {
    const stderr = "remote: Repository not found.\nfatal: repository 'https://me:hunter2@GitHub.com/o/r.git/' not found"
    const { deps } = fakeDeps({ step: () => ({ code: 128, stderr }) })
    const r = await cloneRepo('https://me:hunter2@GitHub.com/o/r.git', undefined, deps, { mode: 'machine', interactive: false })
    expect(r).toEqual({ ok: false, error: AUTH_MESSAGE, needsLogin: { host: 'github.com', helper: false } })
    expect(JSON.stringify(r)).not.toMatch(/me:|hunter2|@/)
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
    // A version git does not print is not trusted to read the login settings either.
    for (const version of [{ stdout: 'what' }, {}]) {
      const f = fakeDeps({ version })
      expect(await cloneRepo(HTTPS, undefined, f.deps)).toEqual({ ok: false, error: OLD_GIT_MESSAGE })
      expect(f.of('clone')).toHaveLength(0)
    }
  })

  it('a version check that fails or runs out of time says git could not be checked, not that it is old', async () => {
    expect(VERSION_FAILED_MESSAGE).toBe("Lumopolis couldn't run git to check its version. Try again in a moment.")
    // a non-zero exit, and the timeout (nodeExecFile answers it as a non-zero exit)
    for (const version of [{ code: 1, stdout: '' }, { code: 1, stderr: 'it took too long', stdout: '' }, { code: 128, stdout: 'git version 2.47.1' }]) {
      const f = fakeDeps({ version })
      expect(await cloneRepo(HTTPS, undefined, f.deps)).toEqual({ ok: false, error: VERSION_FAILED_MESSAGE })
      expect(f.of('clone')).toHaveLength(0)
    }
    const rejects = fakeDeps()
    const inner = rejects.deps.execFile
    rejects.deps.execFile = async (c, args, o) => (args.includes('--version') ? Promise.reject(new Error('spawn failed')) : inner(c, args, o))
    expect(await cloneRepo(HTTPS, undefined, rejects.deps)).toEqual({ ok: false, error: VERSION_FAILED_MESSAGE })
    expect(rejects.of('clone')).toHaveLength(0)
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

// ── The one-time token: in the environment of the one run only, never on a command line or in a message ──

/** The value git's numbered config gives `key` in this env, or undefined when the key is not set there. */
function configValue(env: Record<string, string>, key: string): string | undefined {
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) if (env[`GIT_CONFIG_KEY_${i}`] === key) return env[`GIT_CONFIG_VALUE_${i}`]
  return undefined
}
const ASKPASS_VARS = /^(GIT_ASKPASS|TERMPOLIS_GIT_ASKPASS_.*)$/i

describe('cloneRepo token runs', () => {
  it('the token is only in the env of the one run, never in argv', async () => {
    const { deps, calls, of } = fakeDeps()
    const r = await cloneRepo(HTTPS, undefined, deps, TOKEN_RUN)
    expect(r).toMatchObject({ ok: true, changed: true })
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    for (const c of calls) {
      expect(c.args.join(' ')).not.toContain(TOKEN)
      expect(c.args.join(' ')).not.toMatch(LOGIN_WORDS)
    }
    const env = of('clone')[0].opts.env
    expect(env.TERMPOLIS_GIT_ASKPASS_REPLY).toBe(TOKEN)
    expect(env.TERMPOLIS_GIT_ASKPASS_USER).toBe('x-access-token')
    expect(env.GIT_ASKPASS).toBe(ASKPASS)
    // The askpass answers only prompts for this host.
    expect(env.TERMPOLIS_GIT_ASKPASS_HOST).toBe('github.com')
    expect(env.GIT_TRACE_REDACT).toBe('1')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    // No login helper may answer in the token's place.
    expect(configValue(env, 'credential.helper')).toBe('')
    // git's prompt names only the scheme and host, never the path.
    expect(configValue(env, 'credential.useHttpPath')).toBe('false')
    // The version check runs before the login settings exist: git --version never sees the token.
    expect(JSON.stringify(of('--version')[0].opts.env)).not.toContain(TOKEN)
  })

  it('an update by token carries the token on its fetch, and nowhere on a command line', async () => {
    const { deps, calls, of } = fakeDeps({}, { exists: async () => true })
    expect(await cloneRepo(HTTPS, undefined, deps, TOKEN_RUN)).toMatchObject({ ok: true })
    expect(of('fetch')[0].opts.env.TERMPOLIS_GIT_ASKPASS_REPLY).toBe(TOKEN)
    for (const c of calls) expect(c.args.join(' ')).not.toContain(TOKEN)
  })

  it('with no askpass shipped, a token run is refused without running git', async () => {
    for (const askpassPath of [undefined, '']) {
      const { deps, calls } = fakeDeps({}, { askpassPath })
      expect(await cloneRepo(HTTPS, undefined, deps, TOKEN_RUN)).toEqual({ ok: false, error: TOKEN_REJECTED_MESSAGE })
      expect(calls).toHaveLength(0)
    }
  })

  it('a pasted token is trimmed, and one with a break inside or nothing in it is refused before git runs', async () => {
    const trimmed = fakeDeps()
    await cloneRepo(HTTPS, undefined, trimmed.deps, { mode: 'token', value: `  ${TOKEN}\r\n` })
    expect(trimmed.of('clone')[0].opts.env.TERMPOLIS_GIT_ASKPASS_REPLY).toBe(TOKEN)
    for (const [value, error] of [
      [`${TOKEN.slice(0, 9)}\n${TOKEN.slice(9)}`, TOKEN_FORMAT_MESSAGE],
      [`${TOKEN.slice(0, 9)} ${TOKEN.slice(9)}`, TOKEN_FORMAT_MESSAGE],
      ['  ', TOKEN_EMPTY_MESSAGE]
    ]) {
      const { deps, calls } = fakeDeps()
      expect(await cloneRepo(HTTPS, undefined, deps, { mode: 'token', value })).toEqual({ ok: false, error })
      expect(calls).toHaveLength(0)
    }
  })

  it('a token git refuses comes back as rejected, with the sign-in actions', async () => {
    const stderr = "fatal: Authentication failed for 'https://github.com/o/r.git/'"
    const { deps, of } = fakeDeps({ step: () => ({ code: 128, stderr }), config: { stdout: 'credential.helper\nmanager\0' } })
    expect(await cloneRepo(HTTPS, undefined, deps, TOKEN_RUN)).toEqual({ ok: false, error: TOKEN_REJECTED_MESSAGE, needsLogin: { host: 'github.com', helper: true } })
    expect(of('clone')).toHaveLength(1)
    // The helper check after it never carries the token.
    expect(JSON.stringify(of('--list')[0].opts.env)).not.toContain(TOKEN)
    const upd = fakeDeps({ step: (args) => (args.includes('fetch') ? { code: 128, stderr } : {}) }, { exists: async () => true })
    expect(await cloneRepo(HTTPS, undefined, upd.deps, TOKEN_RUN)).toEqual({ ok: false, error: TOKEN_REJECTED_MESSAGE, needsLogin: { host: 'github.com', helper: false } })
  })

  it('a token failure hides the token even when git repeats it', async () => {
    const repeats = [
      `fatal: unable to access 'https://github.com/o/r.git/': server said ${TOKEN} twice ${TOKEN}`,
      `${TOKEN}\nfatal: Authentication failed for 'https://github.com/o/r.git/'`
    ]
    for (const stderr of repeats) {
      const { deps } = fakeDeps({ step: () => ({ code: 128, stderr }) })
      const r = await cloneRepo(HTTPS, undefined, deps, TOKEN_RUN)
      expect(r.ok).toBe(false)
      expect(JSON.stringify(r)).not.toContain(TOKEN)
    }
    const shown = fakeDeps({ step: () => ({ code: 128, stderr: repeats[0] }) })
    expect(await cloneRepo(HTTPS, undefined, shown.deps, TOKEN_RUN)).toEqual({
      ok: false,
      error: "Couldn't reach that repository: fatal: unable to access 'https://github.com/o/r.git/': server said [hidden] twice [hidden]"
    })
    // A git that could not be started, with the value in the error it threw.
    const thrown = fakeDeps()
    const inner = thrown.deps.execFile
    thrown.deps.execFile = async (c, args, o) => (args.includes('clone') ? Promise.reject(new Error(`spawn failed near ${TOKEN}`)) : inner(c, args, o))
    const t = await cloneRepo(HTTPS, undefined, thrown.deps, TOKEN_RUN)
    expect(t).toEqual({ ok: false, error: "Couldn't reach that repository: spawn failed near [hidden]" })
    // Anything else that fails mid-run rejects without the value too.
    const sweep = fakeDeps({}, { listDir: async () => Promise.reject(new Error(`cannot list ${TOKEN}`)) })
    const err = await cloneRepo(HTTPS, undefined, sweep.deps, TOKEN_RUN).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('cannot list [hidden]')
    const odd = fakeDeps({}, { listDir: async () => Promise.reject(`cannot list ${TOKEN}`) })
    expect(((await cloneRepo(HTTPS, undefined, odd.deps, TOKEN_RUN).catch((e: unknown) => e)) as Error).message).toBe('cannot list [hidden]')
  })

  it('a later none-mode run after a token run carries no askpass variables', async () => {
    const { deps, of } = fakeDeps()
    await cloneRepo(HTTPS, undefined, deps, TOKEN_RUN)
    await cloneRepo(HTTPS, undefined, deps, { mode: 'none' })
    const [first, second] = of('clone')
    expect(first.opts.env.TERMPOLIS_GIT_ASKPASS_REPLY).toBe(TOKEN)
    expect(Object.keys(second.opts.env).filter((k) => ASKPASS_VARS.test(k))).toEqual([])
    expect(JSON.stringify(second.opts.env)).not.toContain(TOKEN)
    // Two runs never share one env object, so nothing set for the first can linger into the second.
    expect(second.opts.env).not.toBe(first.opts.env)
    // A machine run after it carries none either.
    await cloneRepo(HTTPS, undefined, deps, { mode: 'machine', interactive: true })
    expect(Object.keys(of('clone')[2].opts.env).filter((k) => ASKPASS_VARS.test(k))).toEqual([])
  })

  it('inherited askpass variables are dropped', async () => {
    const env = {
      PATH: 'p',
      GIT_ASKPASS: '/evil',
      TERMPOLIS_GIT_ASKPASS_USER: 'someone',
      TERMPOLIS_GIT_ASKPASS_REPLY: 'leaked',
      termpolis_git_askpass_reply: 'leaked2',
      TERMPOLIS_GIT_ASKPASS_HOST: 'proxy.example'
    }
    const none = fakeDeps({}, { env })
    await cloneRepo(HTTPS, undefined, none.deps)
    expect(Object.keys(none.of('clone')[0].opts.env).filter((k) => ASKPASS_VARS.test(k))).toEqual([])
    // A token run carries only its own: the inherited ones are gone, not merely overwritten.
    const token = fakeDeps({}, { env })
    await cloneRepo(HTTPS, undefined, token.deps, TOKEN_RUN)
    const e = token.of('clone')[0].opts.env
    expect(Object.keys(e).filter((k) => ASKPASS_VARS.test(k)).sort()).toEqual(['GIT_ASKPASS', 'TERMPOLIS_GIT_ASKPASS_HOST', 'TERMPOLIS_GIT_ASKPASS_REPLY', 'TERMPOLIS_GIT_ASKPASS_USER'])
    expect(e).toMatchObject({ GIT_ASKPASS: ASKPASS, TERMPOLIS_GIT_ASKPASS_USER: 'x-access-token', TERMPOLIS_GIT_ASKPASS_REPLY: TOKEN, TERMPOLIS_GIT_ASKPASS_HOST: 'github.com' })
  })

  it('a URL that names a user still clones by token, and no message shows the user', async () => {
    const url = 'https://me@github.com/o/r.git'
    const ok = fakeDeps()
    expect(await cloneRepo(url, undefined, ok.deps, TOKEN_RUN)).toMatchObject({ ok: true })
    // git takes the user from the URL and asks the askpass only for the second answer; the token still rides the env.
    expect(ok.of('clone')[0].opts.env.TERMPOLIS_GIT_ASKPASS_REPLY).toBe(TOKEN)
    // The host the askpass answers for is the forge's, without the user.
    expect(ok.of('clone')[0].opts.env.TERMPOLIS_GIT_ASKPASS_HOST).toBe('github.com')
    const [setUrl] = ok.of('set-url')
    expect(setUrl.args.slice(-3)).toEqual(['set-url', 'origin', 'https://github.com/o/r.git'])
    for (const stderr of [
      "fatal: Authentication failed for 'https://me@github.com/o/r.git/'",
      "fatal: unable to access 'https://me@github.com/o/r.git/': Could not resolve host: github.com"
    ]) {
      const { deps } = fakeDeps({ step: () => ({ code: 128, stderr }) })
      const r = await cloneRepo(url, undefined, deps, TOKEN_RUN)
      expect(r.ok).toBe(false)
      expect(JSON.stringify(r)).not.toContain('me@')
    }
  })
})

describe('the clone folder of a URL that names a user', () => {
  // The sources registry saves the URL without the user, and an update passes that saved URL: both must
  // land in the one clone folder.
  it('cloneKey is the same with and without the user in the URL', () => {
    for (const ref of [undefined, 'main']) {
      expect(cloneKey('https://me@github.com/o/r.git', ref)).toBe(cloneKey(HTTPS, ref))
      expect(cloneKey('https://me:hunter2@github.com/o/r.git', ref)).toBe(cloneKey(HTTPS, ref))
    }
    // ssh keeps its user: it is part of the address
    expect(cloneKey('ssh://git@github.com/o/r.git')).not.toBe(cloneKey('ssh://github.com/o/r.git'))
    expect(cloneKey(7 as unknown as string)).toBe(cloneKey('7'))
  })

  it('an update of the saved URL reaches the folder the URL with the user was cloned into', async () => {
    const renamed: string[] = []
    const first = fakeDeps({}, { rename: async (_from, to) => void renamed.push(to) })
    const cloned = await cloneRepo('https://me@github.com/o/r.git', undefined, first.deps, TOKEN_RUN)
    expect(cloned).toMatchObject({ ok: true })
    const root = (cloned as { root: string }).root
    expect(renamed).toEqual([root])
    const later = fakeDeps({}, { exists: async (p) => p === join(root, '.git', 'lumopolis-complete') })
    expect(await cloneRepo(HTTPS, undefined, later.deps, TOKEN_RUN)).toMatchObject({ ok: true, root })
    expect(later.of('fetch')[0].args).toEqual(expect.arrayContaining(['--git-dir', join(root, '.git'), '--work-tree', root]))
    expect(later.of('clone')).toHaveLength(0)
  })
})

describe('cloneRepo token runs: fix round 1', () => {
  /** Whether an exec carries anything of the askpass, or the value itself. */
  const carriesLogin = (env: Record<string, string>): boolean => Object.keys(env).some((k) => ASKPASS_VARS.test(k)) || JSON.stringify(env).includes(TOKEN)

  // The reset of an update is a network step too: in a --filter=blob:none clone it downloads the files it
  // checks out through a git fetch child, which needs the askpass like the fetch before it.
  it('the askpass and the value ride only the network steps: clone, fetch and the update reset', async () => {
    // A clone of a URL that names a user also runs remote set-url afterwards.
    const clone = fakeDeps()
    expect(await cloneRepo('https://me@github.com/o/r.git', undefined, clone.deps, TOKEN_RUN)).toMatchObject({ ok: true })
    const update = fakeDeps({}, { exists: async () => true })
    expect(await cloneRepo(HTTPS, undefined, update.deps, TOKEN_RUN)).toMatchObject({ ok: true })
    const network = (args: string[]): boolean => args.includes('clone') || args.includes('fetch') || args.includes('reset')
    for (const [f, steps] of [[clone, 1], [update, 2]] as const) {
      const net = f.calls.filter((c) => network(c.args))
      const local = f.calls.filter((c) => !network(c.args))
      expect(net).toHaveLength(steps)
      for (const c of net) {
        expect(c.opts.env.TERMPOLIS_GIT_ASKPASS_REPLY).toBe(TOKEN)
        expect(c.opts.env.GIT_ASKPASS).toBe(ASKPASS)
        expect(c.opts.env.TERMPOLIS_GIT_ASKPASS_HOST).toBe('github.com')
      }
      expect(local.length).toBeGreaterThan(0)
      for (const c of local) {
        expect(carriesLogin(c.opts.env)).toBe(false)
        if (c.args.includes('--version')) continue
        // Login-free, yet still no prompt and a redacted trace.
        expect(c.opts.env.GIT_TERMINAL_PROMPT).toBe('0')
        expect(c.opts.env.GIT_TRACE_REDACT).toBe('1')
      }
    }
    expect(clone.of('set-url')).toHaveLength(1)
    expect(update.of('rev-parse')).toHaveLength(2)
    expect(update.of('reset')).toHaveLength(1)
    // A local step's env is its own object, never a network step's.
    expect(update.of('rev-parse')[0].opts.env).not.toBe(update.of('fetch')[0].opts.env)
    expect(update.of('reset')[0].opts.env).toBe(update.of('fetch')[0].opts.env)
    // A run without a token gives its reset the same env as every other step.
    const plain = fakeDeps({}, { exists: async () => true })
    await cloneRepo(HTTPS, undefined, plain.deps, { mode: 'machine', interactive: false })
    expect(plain.of('reset')[0].opts.env).toBe(plain.of('rev-parse')[0].opts.env)
  })

  it('a token run never inherits a git trace, and always redacts one', async () => {
    const env = {
      PATH: 'p',
      GIT_TRACE_CURL: '/some/path',
      GIT_TRACE_REDACT: '0',
      GIT_TRACE: '1',
      GIT_TRACE_PACKET: '/p',
      GIT_TRACE2_EVENT: '/e',
      git_trace2_perf: '/f',
      Git_Trace_Setup: '1',
      GIT_CURL_VERBOSE: '1',
      git_curl_verbose: '1',
      git_trace_redact: '0'
    }
    const update = fakeDeps({}, { env, exists: async () => true })
    await cloneRepo(HTTPS, undefined, update.deps, TOKEN_RUN)
    const clone = fakeDeps({}, { env })
    await cloneRepo(HTTPS, undefined, clone.deps, TOKEN_RUN)
    for (const f of [update, clone]) {
      for (const c of f.calls.filter((x) => !x.args.includes('--version'))) {
        const traced = Object.keys(c.opts.env).filter((k) => /^GIT_(TRACE|CURL_VERBOSE)/i.test(k))
        expect(traced).toEqual(['GIT_TRACE_REDACT'])
        expect(c.opts.env.GIT_TRACE_REDACT).toBe('1')
        expect(c.opts.env.PATH).toBe('p')
      }
    }
    // A run without a token inherits no trace either (the shared list in gitSafety.ts), and sets none of its own.
    const none = fakeDeps({}, { env })
    await cloneRepo(HTTPS, undefined, none.deps)
    for (const c of none.calls) expect(Object.keys(c.opts.env).filter((k) => /^GIT_(TRACE|CURL_VERBOSE)/i.test(k))).toEqual([])
  })

  it('no step of a clone or an update, the version check among them, inherits a transport program, another config, templates or a trace', async () => {
    const env = {
      PATH: 'p',
      HOME: '/h',
      GIT_SSH_COMMAND: 'evil',
      Git_Ssh: 'evil.exe',
      GIT_PROXY_COMMAND: 'evil',
      GIT_CONFIG: '/other',
      GIT_CONFIG_GLOBAL: '/g',
      GIT_CONFIG_SYSTEM: '/s',
      GIT_TEMPLATE_DIR: '/t',
      GIT_TRACE: '1',
      git_trace2_event: '/e',
      GIT_CURL_VERBOSE: '1',
      GIT_CONFIG_NOSYSTEM: '1'
    }
    const gone = /^(GIT_SSH_COMMAND|GIT_SSH|GIT_PROXY_COMMAND|GIT_CONFIG|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_TEMPLATE_DIR|GIT_TRACE.*|GIT_CURL_VERBOSE)$/i
    for (const run of [undefined, { mode: 'machine', interactive: true } as const, TOKEN_RUN]) {
      for (const exists of [false, true]) {
        const f = fakeDeps({}, { env, exists: async () => exists })
        await cloneRepo(HTTPS, undefined, f.deps, run)
        expect(f.calls.length).toBeGreaterThan(1)
        for (const c of f.calls) {
          expect(Object.keys(c.opts.env).filter((k) => gone.test(k) && !(k === 'GIT_TRACE_REDACT' && run === TOKEN_RUN))).toEqual([])
          // The person's own home (where git finds ~/.gitconfig and its login helper) and the no-system switch stay.
          expect(c.opts.env).toMatchObject({ PATH: 'p', HOME: '/h', GIT_CONFIG_NOSYSTEM: '1' })
        }
      }
    }
  })

  it('a token is only ever sent over https: any other address is refused before git runs', async () => {
    for (const url of ['ssh://git@github.com/o/r.git', 'git@github.com:o/r.git', 'file:///c/repos/r', 'http://github.com/o/r.git']) {
      const { deps, calls } = fakeDeps()
      expect(await cloneRepo(url, undefined, deps, TOKEN_RUN)).toEqual({ ok: false, error: TOKEN_REJECTED_MESSAGE })
      expect(calls).toHaveLength(0)
    }
  })

  it('the askpass host keeps the port and the case git will put in its prompt', async () => {
    const port = fakeDeps()
    await cloneRepo('https://git.example.test:8443/o/r.git', undefined, port.deps, TOKEN_RUN)
    expect(port.of('clone')[0].opts.env.TERMPOLIS_GIT_ASKPASS_HOST).toBe('git.example.test:8443')
    const cased = fakeDeps()
    await cloneRepo('https://GitHub.com/o/r.git', undefined, cased.deps, TOKEN_RUN)
    expect(cased.of('clone')[0].opts.env.TERMPOLIS_GIT_ASKPASS_HOST).toBe('GitHub.com')
  })
})
