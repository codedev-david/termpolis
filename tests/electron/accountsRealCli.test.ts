// Design 14.3: the real Claude Code, Codex and agy, never a real account. Every process here gets a
// temp HOME and USERPROFILE (a folder whose name holds a space, ' and &, and an accented letter) and
// a temp profile folder with NO sign-in in it, after the binary that will run is found on PATH and
// asked its version. Claude Code and Codex are asked only what a signed-out profile answers
// (`claude auth status --json`, `codex login status`, `codex mcp list`); agy runs `--version` and
// `--help` and nothing else (its sign-in is one per computer user, so it never runs further). No
// prompt is sent to any of them. Skipped where a CLI isn't installed, as on CI.
//
// What it proves, with the real binaries:
//  - the real identity checks (claudeSignedInNow, codexSignedInNow) read a signed-out profile as
//    signed out, from each CLI's own words;
//  - the line the real accountLine builds, typed into each real shell this machine has, reaches the
//    CLI with the profile variable intact whatever its path holds: `claude auth status --json`
//    reports it as its configDirectory, and `codex mcp list` lists the server Termpolis wrote into
//    that Codex home and nothing in the default one;
//  - the config Termpolis writes into a Codex home is one the real Codex accepts;
//  - the flags the resume lines rely on exist in the CLI's own help.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { claudeSignedInNow, codexSignedInNow, findOnPath, resolveCli } from '../../src/main/accountIdentity'
import { connectAccountProfile } from '../../src/main/agentIntegrationManager'
import { accountEnv, accountLine } from '../../src/shared/agentAccounts'
import { RealTerminal, cleanEnv, loadPty, prependPath, shellsHere, sleep } from './_realPty'
import type { PtyModule, ShellSpec } from './_realPty'
import { createSandbox, writeLedger } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

const pty = loadPty()
const shells = pty ? shellsHere() : []
const ownEnv = process.env as Record<string, string | undefined>

/** The binary that will run, found the way the app finds it, and the words it answers --version with. */
function installed(name: 'claude' | 'codex' | 'agy', word: RegExp): string | null {
  const file = findOnPath(name, ownEnv, process.platform)
  if (!file) return null
  const cli = name === 'agy' ? { kind: 'exe' as const, file } : resolveCli(name, { env: ownEnv })
  if (!cli) return null
  const r = cli.kind === 'shim' && process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${cli.file}" --version"`], { encoding: 'utf8', timeout: 60_000, windowsHide: true, windowsVerbatimArguments: true })
    : spawnSync(cli.file, ['--version'], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
  return word.test(`${r.stdout}${r.stderr}`) ? file : null
}

const claudePath = installed('claude', /Claude Code/)
const codexPath = installed('codex', /codex/i)
const agyPath = installed('agy', /^\d+\.\d+\.\d+/m)

const scratch: string[] = []
const terminals: RealTerminal[] = []
let sandbox: Sandbox | null = null

afterEach(async () => {
  for (const t of terminals.splice(0)) t.kill()
  sandbox?.dispose()
  sandbox = null
  // A killed shell can hold its folder a moment longer on Windows: a temp folder left is not a failure.
  await sleep(500)
  for (const d of scratch.splice(0)) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* left in the temp folder */ }
  }
})

/** A temp home with a hostile name, with no sign-in anywhere in it, and a plain folder to work in. */
function world(): { home: string; claudeProfile: string; project: string } {
  const home = mkdtempSync(join(tmpdir(), 'tp-real hé & o\'k-'))
  scratch.push(home)
  const claudeProfile = join(home, '.claude-a b\'c')
  mkdirSync(claudeProfile)
  // The shell starts in a plain folder: only the profile and home paths are hostile.
  const project = mkdtempSync(join(tmpdir(), 'tp-real-project-'))
  scratch.push(project)
  return { home, claudeProfile, project }
}

/** The environment a real CLI or shell gets: the machine's own, less every agent variable, with the
 *  temp home standing in for the real one (its app-data folders too). */
function realEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...cleanEnv({}),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    NO_COLOR: '1',
    ...extra,
  }
}

/** What the checks hand a CLI: the machine's PATH, and the temp home as the test home. */
function checkDeps(home: string, project: string) {
  return { cwd: project, env: { ...realEnv(home), TERMPOLIS_TEST_AGENT_HOME: home }, timeoutMs: 60_000 }
}

/** Non-ASCII characters of any width as one '?': a console shows an accented letter as it decodes it. */
const ascii = (s: string): string => s.replace(/[^\x00-\x7f]+/g, '?')

/** A shell of its own for one command, so the screen holds that command's answer and no other. It is
 *  wide, so a long path stays on one row. */
async function openShell(shell: ShellSpec, home: string, project: string, firstOnPath?: string): Promise<RealTerminal> {
  const env = firstOnPath ? prependPath(firstOnPath, realEnv(home)) : realEnv(home)
  const t = new RealTerminal(pty as PtyModule, shell, { cwd: project, env, cols: 400, rows: 60 })
  terminals.push(t)
  await t.until(() => t.total > 0, 30_000, 'the shell to start')
  let last = -1
  while (last !== t.total) {
    last = t.total
    await sleep(700)
  }
  return t
}

/** The line `accountLine` builds, typed into a fresh shell and entered; the screen once `done` says so. */
async function answerOf(shell: ShellSpec, home: string, project: string, env: ReturnType<typeof accountEnv>, command: string, done: RegExp, firstOnPath?: string): Promise<string> {
  const built = accountLine(shell.family, env, command)
  if ('refused' in built) throw new Error(built.refused)
  const t = await openShell(shell, home, project, firstOnPath)
  t.write(built.line + '\r')
  await t.until(() => done.test(t.screen()), 90_000, `${command} to answer`)
  await sleep(500)
  return t.screen()
}

describe.skipIf(!claudePath)(`the real Claude Code (${claudePath}) in a signed-out profile`, () => {
  it('says it is signed out, from its own status command, and names the profile as its configDirectory', async () => {
    const w = world()
    const check = await claudeSignedInNow(w.claudeProfile, checkDeps(w.home, w.project))
    expect(check).toMatchObject({ identity: { signedIn: false, email: null, source: 'auth-status' } })
    // The same command by hand: its words, not the parser's.
    const r = spawnSync(claudePath as string, ['auth', 'status', '--json'], { env: realEnv(w.home, { CLAUDE_CONFIG_DIR: w.claudeProfile }) as NodeJS.ProcessEnv, cwd: w.project, encoding: 'utf8', timeout: 60_000, windowsHide: true })
    const said = JSON.parse(r.stdout)
    expect(said).toMatchObject({ loggedIn: false })
    expect(ascii(said.configDirectory)).toBe(ascii(w.claudeProfile))
    expect(r.status).toBe(1)
  }, 90_000)

  describe.skipIf(!pty || shells.length === 0)('the account line, typed into each real shell', () => {
    for (const shell of shells) {
      it(`${shell.shellType}: reaches Claude Code with the profile variable intact, and the default account's line clears it`, async () => {
        const w = world()
        const configDirectory = async (env: ReturnType<typeof accountEnv>): Promise<string> => {
          const screen = await answerOf(shell, w.home, w.project, env, 'claude auth status --json', /"configDirectory":\s*"(?:[^"\\]|\\.)*"/)
          const all = [...screen.matchAll(/"configDirectory":\s*"((?:[^"\\]|\\.)*)"/g)]
          expect(all.length, screen).toBeGreaterThan(0)
          return JSON.parse(`"${all[all.length - 1][1]}"`) as string
        }
        // An account on a profile folder of its own: the variable is set, to a path that holds a
        // space, a quote and an ampersand.
        expect(ascii(await configDirectory(accountEnv({ agent: 'claude', profile: w.claudeProfile }, 'claude')))).toBe(ascii(w.claudeProfile))
        // The default account: the variable is unset, and Claude Code uses ~/.claude under the temp home.
        expect(ascii(await configDirectory(accountEnv({ agent: 'claude', profile: null }, 'claude')))).toBe(ascii(join(w.home, '.claude')))
      }, 240_000)
    }
  })
})

describe.skipIf(!codexPath)(`the real Codex (${codexPath}) in a signed-out home`, () => {
  it('says it is signed out, from its own status command', async () => {
    const w = world()
    const codexHome = join(w.home, '.codex-a b\'c')
    mkdirSync(codexHome)
    const check = await codexSignedInNow(codexHome, checkDeps(w.home, w.project))
    expect(check).toMatchObject({ identity: { signedIn: false } })
    const cli = resolveCli('codex', { env: ownEnv })!
    const env = realEnv(w.home, { CODEX_HOME: codexHome }) as NodeJS.ProcessEnv
    const r = cli.kind === 'shim' && process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${cli.file}" login status"`], { env, cwd: w.project, encoding: 'utf8', timeout: 60_000, windowsHide: true, windowsVerbatimArguments: true })
      : spawnSync(cli.file, ['login', 'status'], { env, cwd: w.project, encoding: 'utf8', timeout: 60_000, windowsHide: true })
    expect(`${r.stdout}${r.stderr}`).toMatch(/Not logged in/)
    expect(r.status).toBe(1)
  }, 90_000)

  describe.skipIf(!pty || shells.length === 0)('the account line, typed into each real shell', () => {
    for (const shell of shells) {
      it(`${shell.shellType}: reaches Codex with CODEX_HOME intact (it lists the server Termpolis wrote there), and the default account's line clears it`, async () => {
        const w = world()
        // A scratch home of Termpolis's own for what Connect writes (it only writes inside one).
        sandbox = createSandbox()
        writeLedger(sandbox, { consent: 'granted' })
        const codexHome = join(sandbox.home, '.codex-a b\'c')
        mkdirSync(codexHome)
        // What Connect writes into a Codex home: the real Codex has to accept it.
        const rows = connectAccountProfile(sandbox.rt, { agent: 'codex', dir: codexHome })
        expect(rows.some((r) => r.what === 'MCP server' && r.action !== 'skipped'), JSON.stringify(rows)).toBe(true)
        const on = await answerOf(shell, w.home, w.project, accountEnv({ agent: 'codex', profile: codexHome }, 'codex'), 'codex mcp list', /termpolis|No MCP servers/i)
        expect(/termpolis/i.test(on), on).toBe(true)
        // The default account's line unsets CODEX_HOME. The REAL Codex is never run that way: on
        // Windows it takes its default home from the account's profile folder and ignores the temp
        // HOME and USERPROFILE (it printed the developer's own MCP servers), so a stand-in `codex`
        // first on PATH prints what it was given instead.
        const standIn = mkdtempSync(join(tmpdir(), 'tp-standin-'))
        scratch.push(standIn)
        // Git Bash runs the extensionless script; PowerShell and cmd run the .cmd one (npm leaves both).
        writeFileSync(join(standIn, 'codex'), '#!/bin/sh\necho "CODEX_HOME=[${CODEX_HOME}]"\n', { mode: 0o755 })
        if (process.platform === 'win32') writeFileSync(join(standIn, 'codex.cmd'), '@echo CODEX_HOME=[%CODEX_HOME%]\r\n')
        const linesOf = (screen: string): string[] => screen.split('\n').map((row) => row.trim())
        const set = await answerOf(shell, w.home, w.project, accountEnv({ agent: 'codex', profile: codexHome }, 'codex'), 'codex mcp list', /^CODEX_HOME=\[[^\]]+\]/m, standIn)
        expect(linesOf(set).some((row) => ascii(row) === `CODEX_HOME=[${ascii(codexHome)}]`), set).toBe(true)
        const unset = await answerOf(shell, w.home, w.project, accountEnv({ agent: 'codex', profile: null }, 'codex'), 'codex mcp list', /^CODEX_HOME=\[\]/m, standIn)
        expect(linesOf(unset).some((row) => row === 'CODEX_HOME=[]'), unset).toBe(true)
      }, 240_000)
    }
  })
})

describe.skipIf(!agyPath)(`the real agy (${agyPath}): --version and --help, nothing else`, () => {
  it('names the flags the switch relies on', () => {
    const w = world()
    const version = spawnSync(agyPath as string, ['--version'], { env: realEnv(w.home) as NodeJS.ProcessEnv, cwd: w.project, encoding: 'utf8', timeout: 60_000, windowsHide: true })
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
    const help = spawnSync(agyPath as string, ['--help'], { env: realEnv(w.home) as NodeJS.ProcessEnv, cwd: w.project, encoding: 'utf8', timeout: 60_000, windowsHide: true })
    const text = `${help.stdout}${help.stderr}`
    // The resume line is `agy --conversation=<id>`, with the terminal's --model before it.
    expect(text).toMatch(/--conversation\s+Resume a previous conversation by ID/)
    expect(text).toMatch(/--model\s/)
  }, 90_000)
})
