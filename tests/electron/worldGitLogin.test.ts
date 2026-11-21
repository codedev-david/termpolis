import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DROPPED_ENV,
  HELPER_LIST_MAX,
  MIN_GIT,
  OLD_GIT_MESSAGE,
  configEnv,
  gitNewEnough,
  hasLoginHelper,
  inheritedEnv,
  loginConfig,
  loginEnv,
  parseGitVersion,
  safetyFlags,
  type LoginRun
} from '../../src/main/world/gitLogin'
import type { ExecFn, ExecOpts, ExecResult } from '../../src/main/world/gitSource'
import * as gitSource from '../../src/main/world/gitSource'

const BASE = join('/ud')
const GIT = '/usr/bin/git'
const NONE: LoginRun = { mode: 'none' }
const BACKGROUND: LoginRun = { mode: 'machine', interactive: false }
const INTERACTIVE: LoginRun = { mode: 'machine', interactive: true }
const VALUE = 'tv-' + 'Q7'.repeat(20)
const TOKEN: LoginRun = { mode: 'token', value: VALUE }
const ASKPASS = join('/res', 'git-askpass', 'askpass.sh')
const LOGIN_WORDS = /credential|password|oauth|secret|token/i

/** A `git config --list -z` listing: each entry is `key\nvalue`, entries end with NUL. */
const listing = (...entries: string[]): string => entries.map((e) => `${e}\0`).join('')

function helperDeps(result: Partial<ExecResult> | (() => Promise<ExecResult>), env: NodeJS.ProcessEnv = { PATH: 'p' }) {
  const calls: { cmd: string; args: string[]; opts: ExecOpts }[] = []
  const execFile: ExecFn = async (cmd, args, opts) => {
    // No login word and no pasted value ever reaches a command line.
    expect(args.join(' ')).not.toMatch(LOGIN_WORDS)
    expect(args.join(' ')).not.toContain(VALUE)
    calls.push({ cmd, args, opts })
    if (typeof result === 'function') return result()
    return { code: 0, stderr: '', stdout: '', missing: false, ...result }
  }
  return { deps: { execFile, gitBin: async () => GIT as string | null, baseDir: BASE, env }, calls }
}

describe('login modes', () => {
  it('each mode changes only the three login settings', () => {
    for (const isWindows of [true, false]) {
      const flags = safetyFlags(isWindows)
      expect(flags).toEqual([
        '-c', 'protocol.file.allow=never',
        '-c', `core.hooksPath=${isWindows ? 'NUL' : '/dev/null'}`,
        '-c', 'core.symlinks=false',
        '-c', 'core.fsmonitor=false'
      ])
      expect(flags.join(' ')).not.toMatch(/credential|askpass/i)
    }
    expect(loginConfig(NONE)).toEqual([['credential.helper', ''], ['credential.interactive', 'false'], ['core.askPass', '']])
    expect(loginConfig(BACKGROUND)).toEqual([['credential.interactive', 'false'], ['core.askPass', '']])
    expect(loginConfig(INTERACTIVE)).toEqual([['core.askPass', '']])
    expect(loginConfig(TOKEN)).toEqual([['credential.helper', '']])
    // Every mode's settings are drawn from the same three, so nothing else can differ by mode.
    const three = new Set(['credential.helper', 'credential.interactive', 'core.askPass'])
    for (const run of [NONE, BACKGROUND, INTERACTIVE, TOKEN]) expect(loginConfig(run).every(([k]) => three.has(k))).toBe(true)
  })

  it('gitSource still hands out the same safety flags and dropped variables', () => {
    expect(gitSource.safetyFlags).toBe(safetyFlags)
    expect(gitSource.DROPPED_ENV).toBe(DROPPED_ENV)
  })

  it('configEnv numbers each pair from zero', () => {
    expect(configEnv([['a.b', '']])).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '' })
    expect(configEnv([['a.b', 'x'], ['c.d', 'y']])).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: 'x',
      GIT_CONFIG_KEY_1: 'c.d',
      GIT_CONFIG_VALUE_1: 'y'
    })
    expect(configEnv([])).toEqual({ GIT_CONFIG_COUNT: '0' })
  })

  it('a background machine run can never prompt', () => {
    expect(loginEnv(BACKGROUND)).toEqual({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })
    expect(loginEnv(NONE)).toEqual({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })
    // Only a run the person asked for may show the login helper's own window.
    expect(loginEnv(INTERACTIVE)).toEqual({ GIT_TERMINAL_PROMPT: '0' })
    expect(loginEnv(INTERACTIVE)).not.toHaveProperty('GCM_INTERACTIVE')
    expect(loginEnv(TOKEN, ASKPASS)).not.toHaveProperty('GCM_INTERACTIVE')
  })

  it('a token run hands git the shipped askpass and the value, in the environment only', () => {
    expect(loginEnv(TOKEN, ASKPASS)).toEqual({
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: ASKPASS,
      TERMPOLIS_GIT_ASKPASS_USER: 'x-access-token',
      TERMPOLIS_GIT_ASKPASS_REPLY: VALUE
    })
    // With no askpass to read it, the value is not put anywhere.
    expect(loginEnv(TOKEN)).toEqual({ GIT_TERMINAL_PROMPT: '0' })
    // Only a token run ever names an askpass.
    for (const run of [NONE, BACKGROUND, INTERACTIVE]) {
      const env = loginEnv(run, ASKPASS)
      expect(env).not.toHaveProperty('GIT_ASKPASS')
      expect(Object.keys(env).some((k) => k.startsWith('TERMPOLIS_GIT_ASKPASS_'))).toBe(false)
    }
  })

  it('inherited askpass answers are dropped, in any case', () => {
    expect(DROPPED_ENV).toEqual(expect.arrayContaining(['GIT_ASKPASS', 'SSH_ASKPASS', 'TERMPOLIS_GIT_ASKPASS_USER', 'TERMPOLIS_GIT_ASKPASS_REPLY']))
    expect(inheritedEnv({ PATH: 'p', termpolis_git_askpass_reply: 'x', Termpolis_Git_Askpass_User: 'u', git_askpass: '/evil' })).toEqual({ PATH: 'p' })
  })

  it('inheritedEnv drops git path variables and any inherited numbered config, in any case', () => {
    const src: NodeJS.ProcessEnv = { PATH: 'p', GONE: undefined, Git_Dir: 'x', GIT_CONFIG_KEY_0: 'core.askPass', git_config_value_0: 'evil', GIT_CONFIG_VALUE_ZZ: 'x' }
    for (const k of DROPPED_ENV) src[k] = 'x'
    expect(inheritedEnv(src)).toEqual({ PATH: 'p' })
    // Only the numbered-config prefixes go: git's other config variables are left as they were.
    expect(inheritedEnv({ GIT_CONFIG_GLOBAL: '/g', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_KEYS: 'x' })).toEqual({ GIT_CONFIG_GLOBAL: '/g', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_KEYS: 'x' })
  })
})

describe('git version gate', () => {
  it('parseGitVersion reads major and minor', () => {
    expect(parseGitVersion('git version 2.47.1.windows.2')).toEqual([2, 47])
    expect(parseGitVersion('git version 2.30.0')).toEqual([2, 30])
    expect(parseGitVersion('git version 2.39.3 (Apple Git-145)\n')).toEqual([2, 39])
    expect(parseGitVersion('  git version 3.0.0\r\n')).toEqual([3, 0])
    for (const junk of ['', 'garbage', 'version 2.47', 'git version two']) expect(parseGitVersion(junk)).toBeNull()
  })

  it('2.31 is the first git that reads GIT_CONFIG_COUNT', () => {
    expect(MIN_GIT).toEqual([2, 31])
    expect(gitNewEnough([2, 31])).toBe(true)
    expect(gitNewEnough([2, 47])).toBe(true)
    expect(gitNewEnough([3, 0])).toBe(true)
    expect(gitNewEnough([2, 30])).toBe(false)
    expect(gitNewEnough([1, 99])).toBe(false)
    expect(gitNewEnough(null)).toBe(false)
    expect(OLD_GIT_MESSAGE).toBe('Lumopolis needs git 2.31 or newer to open a repository. Update git, then try again.')
  })
})

describe('hasLoginHelper', () => {
  it('a configured helper is found', async () => {
    const { deps } = helperDeps({ stdout: listing('user.name\nMe', 'credential.helper\nmanager') })
    expect(await hasLoginHelper(deps, 'github.com')).toBe(true)
  })

  it('a helper scoped to the same host counts; one scoped to another host does not', async () => {
    const same = helperDeps({ stdout: listing('credential.https://github.com.helper\n!gh auth git-credential') })
    expect(await hasLoginHelper(same.deps, 'github.com')).toBe(true)
    const caseAndPath = helperDeps({ stdout: listing('Credential.https://GitHub.com/org.Helper\nstore') })
    expect(await hasLoginHelper(caseAndPath.deps, 'github.com')).toBe(true)
    const other = helperDeps({ stdout: listing('credential.https://gitlab.com.helper\n!glab auth git-credential') })
    expect(await hasLoginHelper(other.deps, 'github.com')).toBe(false)
    const noScheme = helperDeps({ stdout: listing('credential.github.com.helper\nstore') })
    expect(await hasLoginHelper(noScheme.deps, 'github.com')).toBe(false)
    const port = helperDeps({ stdout: listing('credential.https://git.example:8443.helper\nstore') })
    expect(await hasLoginHelper(port.deps, 'git.example:8443')).toBe(true)
    expect(await hasLoginHelper(port.deps, 'git.example')).toBe(false)
  })

  it('an empty value is no helper, and an empty value after a helper clears it (as git does)', async () => {
    expect(await hasLoginHelper(helperDeps({ stdout: listing('credential.helper\n') }).deps, 'github.com')).toBe(false)
    expect(await hasLoginHelper(helperDeps({ stdout: listing('credential.helper\nmanager', 'credential.helper\n') }).deps, 'github.com')).toBe(false)
    expect(await hasLoginHelper(helperDeps({ stdout: listing('credential.helper\n', 'credential.helper\nosxkeychain') }).deps, 'github.com')).toBe(true)
    // A reset scoped to another host does not clear this host's helper.
    expect(await hasLoginHelper(helperDeps({ stdout: listing('credential.helper\nmanager', 'credential.https://other.example.helper\n') }).deps, 'github.com')).toBe(true)
    // A helper key with no value at all (a bare boolean) is neither a helper nor a reset.
    expect(await hasLoginHelper(helperDeps({ stdout: listing('credential.helper') }).deps, 'github.com')).toBe(false)
    expect(await hasLoginHelper(helperDeps({ stdout: listing('credential.helper\nmanager', 'credential.helper') }).deps, 'github.com')).toBe(true)
  })

  it('no helper, no git, a failed run, too much output or a rejecting run all say no', async () => {
    expect(await hasLoginHelper(helperDeps({ stdout: listing('user.name\nMe', 'credential.usehttppath\ntrue', 'credentialx.helper\nx') }).deps, 'github.com')).toBe(false)
    expect(await hasLoginHelper(helperDeps({ stdout: '' }).deps, 'github.com')).toBe(false)
    expect(await hasLoginHelper(helperDeps({ code: 1, stdout: '', missing: true }).deps, 'github.com')).toBe(false)
    expect(await hasLoginHelper(helperDeps({ code: 0, stdout: listing('credential.helper\nmanager'), missing: true }).deps, 'github.com')).toBe(false)
    expect(await hasLoginHelper(helperDeps({ code: 1, stdout: listing('credential.helper\nmanager') }).deps, 'github.com')).toBe(false)
    expect(await hasLoginHelper(helperDeps({ code: 1, stderr: 'too much output', stdout: '' }).deps, 'github.com')).toBe(false)
    expect(await hasLoginHelper(helperDeps({ code: 0, stdout: undefined }).deps, 'github.com')).toBe(false)
    expect(await hasLoginHelper(helperDeps(() => Promise.reject(new Error('spawn failed'))).deps, 'github.com')).toBe(false)
    const noGit = helperDeps({ stdout: listing('credential.helper\nmanager') })
    expect(await hasLoginHelper({ ...noGit.deps, gitBin: async () => null }, 'github.com')).toBe(false)
    expect(noGit.calls).toHaveLength(0)
  })

  it('reads git config only: the argv, folder, ceiling and output cap', async () => {
    const env: NodeJS.ProcessEnv = { PATH: 'p', GIT_DIR: '/elsewhere', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' }
    const { deps, calls } = helperDeps({ stdout: listing('credential.helper\nmanager') }, env)
    expect(await hasLoginHelper(deps, 'github.com')).toBe(true)
    expect(calls).toHaveLength(1)
    const [c] = calls
    expect(c.cmd).toBe(GIT)
    const flags = safetyFlags(process.platform === 'win32')
    expect(c.args.slice(0, flags.length)).toEqual(flags)
    expect(c.args.slice(flags.length)).toEqual(['config', '--list', '-z'])
    expect(c.args.join(' ')).not.toMatch(/credential|password|oauth|secret|token/i)
    expect(c.opts.cwd).toBe(BASE)
    expect(c.opts.stdoutMax).toBe(1_048_576)
    expect(HELPER_LIST_MAX).toBe(1_048_576)
    expect(c.opts.timeout).toBeGreaterThan(0)
    expect(c.opts.env).toEqual({ PATH: 'p', GIT_CEILING_DIRECTORIES: BASE, GIT_TERMINAL_PROMPT: '0' })
  })

  it('defaults the environment to process.env', async () => {
    const { deps, calls } = helperDeps({ stdout: '' }, undefined)
    await hasLoginHelper({ ...deps, env: undefined }, 'github.com')
    expect(calls[0].opts.env.GIT_CEILING_DIRECTORIES).toBe(BASE)
  })
})

// The script Termpolis ships, run for real through the sh git itself brings. git is not involved: on this
// machine no git run may hand a prompt to it, so the prompts here are neutral stand-ins for git's.
describe('the shipped askpass script', () => {
  const script = resolve(__dirname, '..', '..', 'resources', 'git-askpass', 'askpass.sh')
  const sh = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\sh.exe' : '/bin/sh'
  const env: Record<string, string> = { TERMPOLIS_GIT_ASKPASS_USER: 'x-access-token', TERMPOLIS_GIT_ASKPASS_REPLY: VALUE }
  for (const k of ['PATH', 'SYSTEMROOT']) if (process.env[k]) env[k] = process.env[k] as string
  const ask = (prompt: string): string => {
    const args = [script, prompt]
    expect(args.join(' ')).not.toMatch(LOGIN_WORDS)
    expect(args.join(' ')).not.toContain(VALUE)
    return execFileSync(sh, args, { env, encoding: 'utf8', windowsHide: true })
  }

  it('is exactly the one-shot script, with plain line endings, and never names what it answers', () => {
    const text = readFileSync(script, 'utf8')
    expect(text).toBe(
      '#!/bin/sh\ncase "$1" in\n  Username*) printf \'%s\\n\' "$TERMPOLIS_GIT_ASKPASS_USER" ;;\n  *) printf \'%s\\n\' "$TERMPOLIS_GIT_ASKPASS_REPLY" ;;\nesac\n'
    )
    expect(text).not.toContain('\r')
    expect(text).not.toMatch(LOGIN_WORDS)
  })

  it('answers the user prompt with the user, and any other prompt with the value from its environment', () => {
    expect(ask("Username for 'https://example.test': ")).toBe('x-access-token\n')
    expect(ask("Enter value for 'https://example.test': ")).toBe(`${VALUE}\n`)
  })
})
