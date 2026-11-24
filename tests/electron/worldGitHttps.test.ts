// Lumopolis private repositories against a real git and a real signed-in https server
// (tests/fixtures/gitHttps/server.ts). cloneRepo runs exactly as the world host runs it: the real git,
// the real size check and remover, the askpass Termpolis ships. Only the git config differs: every git
// run here has GIT_CONFIG_NOSYSTEM=1 and a temporary home (HOME, XDG_CONFIG_HOME) with its own ~/.gitconfig, so no
// login helper of this computer (Git Credential Manager, the keychain) ever runs. The one helper git may meet is
// tests/fixtures/gitHttps/fake-helper.sh, named by that temporary config, and the only host is 127.0.0.1.
//
// The token cases run only in CI (CI=true): git hands the askpass its prompt as a command line argument,
// and a sign-in prompt on a command line is something this project keeps off developer machines.
// The exec-mock unit tests (worldGitSourceExec, worldGitLogin) cover the token path locally.
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveGitBin } from '../../src/main/binPath'
import { cloneRepo, dirSizeOf, nodeExecFile, removeDir, type CloneDeps, type LoginRun } from '../../src/main/world/gitSource'
import { TOKEN_REJECTED_MESSAGE } from '../../src/shared/world/repoAccess'
import { fakeHelperConfig, fixtureSkipReason, FAKE_HELPER_PATH, startGitHttps, type GitHttps } from '../fixtures/gitHttps/server'

// Locally a missing git-http-backend or openssl skips this file; on CI (CI=true) it throws and fails it.
const missing = fixtureSkipReason()
if (missing) console.warn(`[worldGitHttps] skipped: ${missing}`)
const inCi = process.env.CI === 'true'

/** Every file's bytes under `dir`, not following links. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push(p)
    }
  }
  walk(dir)
  return out
}

describe.skipIf(missing !== null)('Lumopolis private repositories against a local signed-in git server', () => {
  // Random per run, in memory only: they reach the server's check and the fake helper's env, nothing else.
  const user = `u${randomBytes(6).toString('hex')}`
  const reply = randomBytes(20).toString('hex')
  let work: string
  let server: GitHttps
  let helperConfig: string
  let emptyConfig: string
  let helperLog: string

  beforeAll(async () => {
    work = await fsp.mkdtemp(join(tmpdir(), 'lumopolis-https-'))
    server = await startGitHttps({ user, reply, dir: join(work, 'server') })
    // Each config is a home's ~/.gitconfig: the app's git leaves an inherited GIT_CONFIG_GLOBAL out (gitSafety.ts
    // INHERITED_GIT_DROP), so it finds the person's config, and their login helper, where git looks by default.
    helperConfig = join(work, 'home-helper', '.gitconfig')
    emptyConfig = join(work, 'home-empty', '.gitconfig')
    await fsp.mkdir(dirname(helperConfig), { recursive: true })
    await fsp.mkdir(dirname(emptyConfig), { recursive: true })
    helperLog = join(work, 'helper.log')
    await fsp.writeFile(helperConfig, fakeHelperConfig())
    await fsp.writeFile(emptyConfig, '')
  }, 60_000)

  afterAll(async () => {
    await server?.stop()
    if (work) await removeDir(work)
  })

  /** The environment the app's git would inherit: the fixture's CA, no system config and a temporary home whose
   *  ~/.gitconfig is `config` (GIT_CONFIG_GLOBAL names it too, for this test's own plain git). Any GCM_ or
   *  FAKE_HELPER_ variable of this shell is left out. */
  const gitEnvFor = (config: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) if (!/^(GCM_|FAKE_HELPER_)/i.test(k)) env[k] = v
    const home = dirname(config)
    return { ...env, GIT_SSL_CAINFO: server.caFile, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, HOME: home, XDG_CONFIG_HOME: join(home, 'xdg'), ...extra }
  }
  /** gitEnvFor plus the fake helper's answers, for the runs whose config names the helper. A token run
   *  uses gitEnvFor alone, so the reply reaches git only as the token. */
  const envFor = (config: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
    gitEnvFor(config, { FAKE_HELPER_LOG: helperLog, FAKE_HELPER_USER: user, FAKE_HELPER_REPLY: reply, ...extra })

  const depsFor = async (env: NodeJS.ProcessEnv): Promise<CloneDeps> => ({
    execFile: nodeExecFile,
    gitBin: resolveGitBin,
    baseDir: await fsp.mkdtemp(join(work, 'base-')),
    dirSize: dirSizeOf,
    rm: removeDir,
    isWindows: process.platform === 'win32',
    env,
    askpassPath: resolve('resources/git-askpass/askpass.sh'),
    timeoutMs: 60_000
  })

  const helperLines = async (): Promise<string[]> =>
    (await fsp.readFile(helperLog, 'utf8').catch(() => '')).split('\n').filter((l) => l.trim() !== '')
  const clearLog = (): Promise<void> => fsp.rm(helperLog, { force: true })

  it('none mode cannot open the private repo and asks for a sign-in', async () => {
    await clearLog()
    for (const [config, helper] of [
      [helperConfig, true],
      [emptyConfig, false]
    ] as const) {
      const r = await cloneRepo(server.url, undefined, await depsFor(envFor(config)))
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.needsLogin).toEqual({ host: new URL(server.url).host, helper })
    }
    // A run with no login never asks any helper.
    expect(await helperLines()).toEqual([])
  }, 60_000)

  it('machine interactive opens it through the helper', async () => {
    await clearLog()
    const r = await cloneRepo(server.url, undefined, await depsFor(envFor(helperConfig)), { mode: 'machine', interactive: true })
    expect(r).toMatchObject({ ok: true, changed: true })
    const lines = await helperLines()
    expect(lines.some((l) => l.startsWith('get '))).toBe(true)
    expect(lines.filter((l) => l.includes('GCM_INTERACTIVE=never'))).toEqual([])
    if (r.ok) expect(fs.existsSync(join(r.root, 'src', 'index.ts'))).toBe(true)
  }, 60_000)

  it('a background machine update never prompts', async () => {
    const deps = await depsFor(envFor(helperConfig))
    const background: LoginRun = { mode: 'machine', interactive: false }
    expect(await cloneRepo(server.url, undefined, deps, { mode: 'machine', interactive: true })).toMatchObject({ ok: true })

    await clearLog()
    expect(await cloneRepo(server.url, undefined, deps, background)).toMatchObject({ ok: true, changed: false })
    const lines = await helperLines()
    expect(lines.some((l) => l.startsWith('get '))).toBe(true)
    expect(lines.filter((l) => l.startsWith('get ')).every((l) => l.includes('GCM_INTERACTIVE=never'))).toBe(true)

    // The login is gone: the helper answers nothing, and the update ends at once asking for a sign-in.
    await clearLog()
    const gone = { ...deps, env: envFor(helperConfig, { FAKE_HELPER_EMPTY: '1' }) }
    const started = Date.now()
    const r = await cloneRepo(server.url, undefined, gone, background)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.needsLogin).toEqual({ host: new URL(server.url).host, helper: true })
    const goneLines = await helperLines()
    // The helper was asked (so the check below cannot pass on an empty log), and never allowed to prompt.
    expect(goneLines.some((l) => l.startsWith('get '))).toBe(true)
    expect(goneLines.filter((l) => l.startsWith('get ')).every((l) => l.includes('GCM_INTERACTIVE=never'))).toBe(true)
  }, 60_000)

  it.runIf(inCi)('token mode opens it, and leaves nothing behind', async () => {
    const deps = await depsFor(gitEnvFor(emptyConfig))
    const r = await cloneRepo(server.url, undefined, deps, { mode: 'token', value: ` ${reply}\n` })
    expect(r).toMatchObject({ ok: true, changed: true })
    if (!r.ok) return
    const needle = Buffer.from(reply)
    const holders = [...filesUnder(r.root), ...filesUnder(deps.baseDir), emptyConfig].filter((f) => fs.readFileSync(f).includes(needle))
    expect(holders).toEqual([])
    const list = execFileSync('git', ['config', '--list'], { cwd: r.root, env: gitEnvFor(emptyConfig) as Record<string, string>, encoding: 'utf8' })
    expect(list.includes(reply)).toBe(false)
  }, 60_000)

  it.runIf(inCi)('a wrong token gets TOKEN_REJECTED_MESSAGE without the token in it', async () => {
    const wrong = `w${randomBytes(20).toString('hex')}`
    const r = await cloneRepo(server.url, undefined, await depsFor(gitEnvFor(emptyConfig)), { mode: 'token', value: wrong })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe(TOKEN_REJECTED_MESSAGE)
    expect(JSON.stringify(r).includes(wrong)).toBe(false)
  }, 60_000)

  it('a clone inherits no template folder, git config file, transport program or trace from Termpolis’s environment', async () => {
    const templates = join(work, 'planted-templates')
    await fsp.mkdir(templates, { recursive: true })
    await fsp.writeFile(join(templates, 'planted-template'), 'x\n')
    const trace = join(work, 'planted-trace.log')
    const other = join(work, 'planted-other.gitconfig')
    await fsp.writeFile(other, '[core]\n\tautocrlf = false\n')
    const planted = { GIT_TEMPLATE_DIR: templates, GIT_TRACE: trace, GIT_CONFIG: other, GIT_SSH_COMMAND: join(work, 'no-such-program') }
    const r = await cloneRepo(server.url, undefined, await depsFor(envFor(helperConfig, planted)), { mode: 'machine', interactive: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(fs.existsSync(join(r.root, '.git', 'planted-template'))).toBe(false)
    expect(fs.existsSync(trace)).toBe(false)
    // Positive control: plain git with the same environment copies the template and writes the trace.
    const plainDir = join(work, 'plain-init')
    execFileSync('git', ['init', '-q', plainDir], { env: gitEnvFor(emptyConfig, planted) as Record<string, string> })
    expect(fs.existsSync(join(plainDir, '.git', 'planted-template'))).toBe(true)
    expect(fs.existsSync(trace)).toBe(true)
  }, 60_000)

  it('a pushed commit makes the next update report changed', async () => {
    const deps = await depsFor(envFor(helperConfig))
    const background: LoginRun = { mode: 'machine', interactive: false }
    expect(await cloneRepo(server.url, undefined, deps, { mode: 'machine', interactive: true })).toMatchObject({ ok: true })
    expect(await cloneRepo(server.url, undefined, deps, background)).toMatchObject({ ok: true, changed: false })
    await server.pushCommit('A second commit')
    expect(await cloneRepo(server.url, undefined, deps, background)).toMatchObject({ ok: true, changed: true })
  }, 60_000)

  // The update's reset downloads the new files of this partial clone through a git fetch child: without the
  // askpass on the reset too, a token update of a pushed commit would fail to check them out.
  it.runIf(inCi)('a token update of a pushed commit reports changed and checks the new files out', async () => {
    const deps = await depsFor(gitEnvFor(emptyConfig))
    const token: LoginRun = { mode: 'token', value: reply }
    const first = await cloneRepo(server.url, undefined, deps, token)
    expect(first).toMatchObject({ ok: true, changed: true })
    if (!first.ok) return
    const before = new Set(fs.readdirSync(join(first.root, 'src')))
    await server.pushCommit('A commit for the token update')
    const r = await cloneRepo(server.url, undefined, deps, token)
    expect(r).toMatchObject({ ok: true, root: first.root, changed: true })
    const added = fs.readdirSync(join(first.root, 'src')).filter((f) => !before.has(f))
    expect(added).toHaveLength(1)
    expect(fs.readFileSync(join(first.root, 'src', added[0]), 'utf8')).toMatch(/^export const change\d+ = \d+\n$/)
    const needle = Buffer.from(reply)
    expect([...filesUnder(first.root), ...filesUnder(deps.baseDir)].filter((f) => fs.readFileSync(f).includes(needle))).toEqual([])
  }, 60_000)

  it('the fake helper is the shipped LF shell script the config names', () => {
    expect(fs.readFileSync(FAKE_HELPER_PATH, 'utf8').includes('\r')).toBe(false)
    expect(fakeHelperConfig()).toContain(FAKE_HELPER_PATH.replace(/\\/g, '/'))
  })
})
