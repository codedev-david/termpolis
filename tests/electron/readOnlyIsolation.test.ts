import { promises as fsp } from 'fs'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGY_NO_MCP_SERVERS, AGY_READ_ONLY_SETTINGS, CLAUDE_ISOLATE_ARGS, CODEX_MCP_OFF_COMMAND, CODEX_MCP_OFF_URL, CODEX_MCP_SERVER_OFF,
  CODEX_NO_CONNECTORS_ARGS, ISOLATION_SETUP_FAILED, MAX_CODEX_CONFIG_BYTES, MCP_LIST_PASS_MS, MCP_LIST_TIMEOUT_MS, READ_ONLY_RUN_ENV,
  agyMcpListEmpty, clearIsolationChecks, codexLayerPaths, codexMcpListAllOff, codexPinArgs, defaultIsolationIO, prepareIsolatedLaunch, removeDirRetrying,
  sweepStaleAgyHomes, type IsolationIO, type McpListRun, type SweepIO,
} from '../../src/main/readOnlyIsolation'
import { CODEX_ISOLATE_MCP_ARGS } from '../../src/main/secondOpinion'

// Every test runs against a fake home and a fake temp folder of its own: nothing reads or writes the
// real ~/.codex or ~/.gemini of whoever runs the suite, and no agent CLI is started (`run` is a fake).

let base: string
let home: string
let tmp: string
let project: string
beforeEach(async () => {
  clearIsolationChecks()
  base = await mkdtemp(join(os.tmpdir(), 'ro-isolation-'))
  home = join(base, 'home')
  tmp = join(base, 'tmp')
  project = join(base, 'project')
  await Promise.all([mkdir(home), mkdir(tmp), mkdir(project)])
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(base, { recursive: true, force: true })
})

let clock = 1_000_000
/** The real file IO, pointed at the fake home and temp folder, on a clock the test moves. */
const realIO = (env: Record<string, string | undefined> = {}): IsolationIO => ({
  ...defaultIsolationIO, homedir: () => home, tmpdir: () => tmp, env, now: () => clock,
})

/** A `codex mcp list --json` / `agy mcp list` that reports everything off. */
const passing = (): ReturnType<typeof vi.fn<McpListRun>> => vi.fn<McpListRun>(async (bin) => ({
  stdout: bin === 'agy' ? `${AGY_NO_MCP_SERVERS}\n` : '[{"name":"docs","enabled":false,"transport":{"type":"stdio"}}]',
  code: 0,
}))

/** Every file under `dir`, with its bytes and modified time. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of await readdir(dir, { recursive: true })) {
    const p = join(dir, String(name))
    const st = await stat(p)
    out[String(name)] = st.isFile() ? `${st.mtimeMs}:${await readFile(p, 'utf8')}` : 'dir'
  }
  return out
}

const userConfig = async (text: string): Promise<string> => {
  await mkdir(join(home, '.codex'), { recursive: true })
  const p = join(home, '.codex', 'config.toml')
  await writeFile(p, text)
  return p
}
const trust = (dir: string): string => `[projects.'${dir}']\ntrust_level = "trusted"\n`
const projectConfig = async (dir: string, text: string): Promise<string> => {
  await mkdir(join(dir, '.codex'), { recursive: true })
  const p = join(dir, '.codex', 'config.toml')
  await writeFile(p, text)
  return p
}
const OFF_CMD = (n: string): string[] => ['-c', `mcp_servers.${n}.enabled=false`, '-c', `mcp_servers.${n}.command=${CODEX_MCP_OFF_COMMAND}`]
const TAIL = [...CODEX_ISOLATE_MCP_ARGS, ...CODEX_NO_CONNECTORS_ARGS]

/** Termpolis's own registration (agentMcpRegistry's termpolisServerEntry), which a linked job's run pins (HOLD-A N1). */
const KEPT = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\app\\resources\\mcp-adapter\\stdio-adapter.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }
const PIN = [
  '-c', "mcp_servers.termpolis.command='C:\\Program Files\\nodejs\\node.exe'",
  '-c', "mcp_servers.termpolis.args=['C:\\app\\resources\\mcp-adapter\\stdio-adapter.cjs']",
  '-c', "mcp_servers.termpolis.env.ELECTRON_RUN_AS_NODE='1'",
]
/** The kept server as `codex mcp list --json` lists it (codex-cli 0.164.0: every top-level and stdio transport key it
 *  prints), with `over` on its transport and `top` on the server. */
const keptListed = (over: Record<string, unknown> = {}, enabled = true, top: Record<string, unknown> = {}): string => JSON.stringify({
  name: 'termpolis', enabled, disabled_reason: null,
  transport: { type: 'stdio', command: KEPT.command, args: KEPT.args, env: { ...KEPT.env }, env_vars: [], cwd: null, ...over },
  startup_timeout_sec: null, tool_timeout_sec: null, auth_status: 'unsupported', ...top,
})

describe('readOnlyIsolation constants', () => {
  it('spells the Codex override, the agy rules, the Claude flag and the read-only marker once', () => {
    expect(CODEX_MCP_SERVER_OFF('docs')).toEqual(['-c', 'mcp_servers.docs.enabled=false', '-c', 'mcp_servers.docs.command=termpolis-mcp-disabled'])
    expect(CODEX_MCP_SERVER_OFF('web', true)).toEqual(['-c', 'mcp_servers.web.enabled=false', '-c', 'mcp_servers.web.url=http://127.0.0.1:9/termpolis-mcp-disabled'])
    expect(CODEX_MCP_OFF_URL).toBe('http://127.0.0.1:9/termpolis-mcp-disabled')
    expect(CODEX_NO_CONNECTORS_ARGS).toEqual(['-c', 'features.apps=false'])
    expect(AGY_READ_ONLY_SETTINGS).toEqual({ permissions: { deny: ['command(*)', 'unsandboxed(*)', 'write_file(*)', 'edit_file(*)', 'mcp(*)'] } })
    expect(CLAUDE_ISOLATE_ARGS).toEqual(['--setting-sources', 'user'])
    expect(READ_ONLY_RUN_ENV).toEqual({ TERMPOLIS_READ_ONLY_RUN: '1' })
    expect(ISOLATION_SETUP_FAILED).toBe("Lumopolis couldn't set up a safe read-only run for your agent. Try again, or pick another agent in Settings.")
    expect(MCP_LIST_TIMEOUT_MS).toBe(10_000)
    expect(MCP_LIST_PASS_MS).toBe(60_000)
    expect(defaultIsolationIO.tmpdir()).toBe(os.tmpdir())
    expect(defaultIsolationIO.homedir()).toBe(os.homedir())
    expect(defaultIsolationIO.env).toBe(process.env)
    expect(defaultIsolationIO.platform).toBe(process.platform)
    expect(Math.abs(defaultIsolationIO.now() - Date.now())).toBeLessThan(1000)
  })
})

describe('codexMcpListAllOff', () => {
  it('passes only an array of objects that each have a string name and enabled: false', () => {
    expect(codexMcpListAllOff('[]')).toBe(true)
    expect(codexMcpListAllOff('[{"name":"a","enabled":false},{"name":"b","enabled":false,"disabled_reason":null}]')).toBe(true)
    for (const bad of [
      '', 'not json', '{}', '{"servers":[]}', 'null', '[null]', '[[]]', '["a"]', '[{"enabled":false}]', '[{"name":1,"enabled":false}]',
      '[{"name":"a"}]', '[{"name":"a","enabled":"false"}]', '[{"name":"a","enabled":0}]', '[{"name":"a","enabled":false},{"name":"b","enabled":true}]',
    ]) expect([bad, codexMcpListAllOff(bad)]).toEqual([bad, false])
  })

  // HOLD-A I2 and N1: a linked job's run keeps Termpolis's own server, so it may be on, but only as the registration pinned.
  it('with a kept registration, passes Termpolis\'s server on only when its transport is the one pinned, and still every other only off', () => {
    expect(codexMcpListAllOff(`[${keptListed()},{"name":"docs","enabled":false}]`, KEPT)).toBe(true)
    expect(codexMcpListAllOff(`[${keptListed({ cwd: undefined })}]`, KEPT)).toBe(true)
    expect(codexMcpListAllOff(`[${keptListed({ command: 'evil' }, false)}]`, KEPT)).toBe(true)
    expect(codexMcpListAllOff('[{"name":"termpolis","enabled":true,"transport":{"type":"stdio","command":"n","args":[],"env":null}}]', { command: 'n', args: [] })).toBe(true)
    expect(codexMcpListAllOff(`[${keptListed()},{"name":"docs","enabled":true}]`, KEPT)).toBe(false)
    expect(codexMcpListAllOff(`[${keptListed()}]`)).toBe(false)
    expect(codexMcpListAllOff(`[${keptListed().replace('"termpolis"', '"Termpolis"')}]`, KEPT)).toBe(false)
    for (const over of [
      { type: 'streamable_http' }, { command: 'evil-binary' }, { args: 'x' }, { args: [] }, { args: ['C:\\evil.cjs'] },
      { args: [...KEPT.args, '--more'] }, { cwd: 'C:\\elsewhere' }, { env: null }, { env: {} }, { env: { ELECTRON_RUN_AS_NODE: '0' } },
    ]) expect([over, codexMcpListAllOff(`[${keptListed(over)}]`, KEPT)]).toEqual([over, false])
    for (const transport of [undefined, null, 'stdio', []]) {
      const listed = JSON.stringify([{ name: 'termpolis', enabled: true, transport }])
      expect([transport, codexMcpListAllOff(listed, KEPT)]).toEqual([transport, false])
    }
  })

  // HOLD-A R2-1: the kept server must be exactly the registration. A layer nobody has found yet (a linked worktree's
  // config, a managed one) can only add to it, and anything added fails the check closed.
  it('with a kept registration, refuses a variable, an env_vars entry or a key the registration does not have', () => {
    for (const over of [
      { env: { ...KEPT.env, NODE_OPTIONS: '--require=C:\\evil.cjs' } }, { env: { ELECTRON_RUN_AS_NODE: 1 } }, { env: 'ELECTRON_RUN_AS_NODE=1' },
      { env_vars: ['NODE_OPTIONS'] }, { env_vars: 'NODE_OPTIONS' }, { env_vars: {} },
      { url: 'https://evil.example' }, { bearer_token_env_var: 'X' }, { http_headers: null }, { startup: 'x' },
    ]) expect([over, codexMcpListAllOff(`[${keptListed(over)}]`, KEPT)]).toEqual([over, false])
    for (const top of [{ hooks: null }, { env: { NODE_OPTIONS: 'x' } }, { tools: {} }]) {
      expect([top, codexMcpListAllOff(`[${keptListed({}, true, top)}]`, KEPT)]).toEqual([top, false])
    }
    // Only what codex-cli 0.164.0 lists for the registration itself passes: env_vars empty or absent, and no env at
    // all for a registration with none.
    for (const over of [{ env_vars: null }, { env_vars: undefined }, { cwd: undefined }]) {
      expect([over, codexMcpListAllOff(`[${keptListed(over)}]`, KEPT)]).toEqual([over, true])
    }
    const bare = { command: 'n', args: [] }
    for (const env of [null, undefined, {}]) {
      expect([env, codexMcpListAllOff(JSON.stringify([{ name: 'termpolis', enabled: true, transport: { type: 'stdio', command: 'n', args: [], env } }]), bare)]).toEqual([env, true])
    }
    expect(codexMcpListAllOff(JSON.stringify([{ name: 'termpolis', enabled: true, transport: { type: 'stdio', command: 'n', args: [], env: { A: '1' } } }]), bare)).toBe(false)
    // The rule is for the kept server on: one off, or any other server off, is still read as before.
    expect(codexMcpListAllOff(`[${keptListed({ env_vars: ['NODE_OPTIONS'] }, false, { hooks: 1 })},{"name":"docs","enabled":false,"extra":1}]`, KEPT)).toBe(true)
  })
})

describe('agyMcpListEmpty', () => {
  it('passes only the no-server line agy prints', () => {
    expect(agyMcpListEmpty('No MCP servers configured.')).toBe(true)
    expect(agyMcpListEmpty('\r\n No MCP servers configured.\r\n')).toBe(true)
    for (const bad of ['', '[]', 'Name  Status\ndocs  enabled', 'No MCP servers configured. docs', 'Usage: agy mcp list']) expect(agyMcpListEmpty(bad)).toBe(false)
  })
})

describe('prepareIsolatedLaunch for Codex', () => {
  it('switches off every server of the user config, a url one with the placeholder url, Termpolis\'s with its own pair, connectors off, and writes nothing', async () => {
    await userConfig('mcp_servers.inline = { url = "https://y" }\n[mcp_servers.docs]\ncommand = "d"\n[mcp_servers.termpolis]\ncommand = "t"\n[mcp_servers.web]\nurl = "https://x"\n')
    const before = { home: await snapshot(home), project: await snapshot(project), tmp: await snapshot(tmp) }
    const run = passing()
    const launch = await prepareIsolatedLaunch('codex', project, { PATH: 'p' }, run, realIO())
    const expected = [...CODEX_MCP_SERVER_OFF('inline', true), ...OFF_CMD('docs'), ...CODEX_MCP_SERVER_OFF('web', true), ...TAIL]
    expect(launch.args).toEqual(expected)
    expect(launch.env).toEqual({ TERMPOLIS_READ_ONLY_RUN: '1' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('codex', ['mcp', 'list', '--json', ...expected], { cwd: project, env: { PATH: 'p', TERMPOLIS_READ_ONLY_RUN: '1' }, timeoutMs: MCP_LIST_TIMEOUT_MS })
    await launch.dispose()
    expect({ home: await snapshot(home), project: await snapshot(project), tmp: await snapshot(tmp) }).toEqual(before)
  })

  // HOLD-A I2 and N1: a linked job keeps Termpolis's server, pinned to Termpolis's own registration, which execCommand
  // narrows with the job's marker or switches off (codexLinkedJobArgs); every other server and the connectors still go off.
  it('with keepTermpolis, pins Termpolis\'s own server to its registration, leaves it to the run, and checks every other server off', async () => {
    await userConfig('[mcp_servers.docs]\ncommand = "d"\n[mcp_servers.termpolis]\ncommand = "t"\n')
    const run = vi.fn<McpListRun>(async () => ({ stdout: `[{"name":"docs","enabled":false},${keptListed()}]`, code: 0 }))
    const launch = await prepareIsolatedLaunch('codex', project, { TERMPOLIS_LINKED_JOB: 'j1' }, run, realIO(), { keepTermpolis: KEPT })
    const expected = [...OFF_CMD('docs'), ...PIN, ...CODEX_NO_CONNECTORS_ARGS]
    expect(launch.args).toEqual(expected)
    expect(launch.args).not.toContain('mcp_servers.termpolis.enabled=false')
    expect(launch.env).toEqual({ TERMPOLIS_READ_ONLY_RUN: '1' })
    expect(run).toHaveBeenCalledWith('codex', ['mcp', 'list', '--json', ...expected], {
      cwd: project, env: { TERMPOLIS_LINKED_JOB: 'j1', TERMPOLIS_READ_ONLY_RUN: '1' }, timeoutMs: MCP_LIST_TIMEOUT_MS,
    })
    // Any other server on still fails it, and so does a kept server that is not the one pinned.
    for (const stdout of [`[{"name":"docs","enabled":true},${keptListed()}]`, `[${keptListed({ command: 'evil-binary' })}]`]) {
      clearIsolationChecks()
      await expect(prepareIsolatedLaunch('codex', project, {}, async () => ({ stdout, code: 0 }), realIO(), { keepTermpolis: KEPT }))
        .rejects.toThrow(/did not show every MCP server off/)
    }
    // Without the option, Termpolis's server on fails it.
    clearIsolationChecks()
    await expect(prepareIsolatedLaunch('codex', project, {}, run, realIO())).rejects.toThrow(/did not show every MCP server off/)
  })

  // HOLD-A N1. The repository's author writes a trusted project's .codex/config.toml. Codex merges a server's table
  // across layers, so a `-c` pin beats the keys it sets but not one it doesn't (another variable, a cwd): a run
  // that would keep Termpolis's server is refused instead. One that keeps nothing switches it off over the project's.
  it('refuses to keep Termpolis\'s server when a project config Codex loads defines one, and checks nothing', async () => {
    await userConfig(`[mcp_servers.termpolis]\ncommand = "t"\n${trust(project)}`)
    const sub = join(project, 'pkg')
    await mkdir(sub)
    const cfg = await projectConfig(project, '[mcp_servers.termpolis]\ncommand = "evil-binary"\nargs = ["x"]\n')
    const run = passing()
    const keep = (dir: string): Promise<unknown> => prepareIsolatedLaunch('codex', dir, {}, run, realIO(), { keepTermpolis: KEPT })
    const refused = `can't keep Termpolis's MCP server for the run: ${cfg} sets a server of its own named termpolis`
    await expect(keep(project)).rejects.toThrow(refused)
    await expect(keep(sub)).rejects.toThrow(refused)
    // Any key of it counts: a dotted one in a folder further down, too.
    await writeFile(cfg, '[mcp_servers.docs]\ncommand = "d"\n')
    const subCfg = await projectConfig(sub, 'mcp_servers.termpolis.env.NODE_OPTIONS = "--require=evil.js"\n')
    await expect(keep(sub)).rejects.toThrow(`can't keep Termpolis's MCP server for the run: ${subCfg} sets a server of its own named termpolis`)
    expect(run).not.toHaveBeenCalled()
    // A run that keeps nothing goes ahead, Termpolis's server switched off.
    expect((await prepareIsolatedLaunch('codex', sub, {}, run, realIO())).args).toEqual([...OFF_CMD('docs'), ...TAIL])
    // A project config Codex doesn't load (no folder trusted) is not the run's, so the kept run goes ahead.
    await userConfig('[mcp_servers.termpolis]\ncommand = "t"\n')
    const ok = vi.fn<McpListRun>(async () => ({ stdout: `[${keptListed()}]`, code: 0 }))
    expect((await prepareIsolatedLaunch('codex', sub, {}, ok, realIO(), { keepTermpolis: KEPT })).args).toEqual([...PIN, ...CODEX_NO_CONNECTORS_ARGS])
  })

  // HOLD-A N4: a run that keeps Termpolis's server and one that keeps nothing never share a passed check.
  it('a passed check that kept Termpolis\'s server is not a pass for a run in the same folder that keeps nothing', async () => {
    await userConfig('[mcp_servers.termpolis]\ncommand = "t"\n')
    const io = realIO()
    const run = vi.fn<McpListRun>(async (_bin, args) => ({
      stdout: args.includes('mcp_servers.termpolis.enabled=false') ? '[{"name":"termpolis","enabled":false}]' : `[${keptListed()}]`, code: 0,
    }))
    expect((await prepareIsolatedLaunch('codex', project, {}, run, io, { keepTermpolis: KEPT })).args).toEqual([...PIN, ...CODEX_NO_CONNECTORS_ARGS])
    expect((await prepareIsolatedLaunch('codex', project, {}, run, io)).args).toEqual(TAIL)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][1]).toEqual(['mcp', 'list', '--json', ...TAIL])
    // Each pass still stands for its own kind of run.
    await prepareIsolatedLaunch('codex', project, {}, run, io, { keepTermpolis: KEPT })
    await prepareIsolatedLaunch('codex', project, {}, run, io)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('still switches Termpolis\'s server and the connectors off when there is no config at all', async () => {
    const launch = await prepareIsolatedLaunch('codex', project, {}, passing(), realIO())
    expect(launch.args).toEqual(TAIL)
  })

  it('reads the config in the run\'s CODEX_HOME first, then the app\'s, then ~/.codex', async () => {
    const readText = vi.fn(async () => null)
    const io = { ...realIO({ CODEX_HOME: join(base, 'app-codex') }), readText }
    await prepareIsolatedLaunch('codex', project, { CODEX_HOME: join(base, 'run-codex') }, passing(), io)
    expect(readText.mock.calls.map((c) => c[0])).toEqual([join(base, 'run-codex', 'config.toml')])
    readText.mockClear()
    await prepareIsolatedLaunch('codex', project, {}, passing(), io)
    expect(readText.mock.calls[0][0]).toBe(join(base, 'app-codex', 'config.toml'))
    readText.mockClear()
    await prepareIsolatedLaunch('codex', project, {}, passing(), { ...io, env: {} })
    expect(readText.mock.calls[0][0]).toBe(join(home, '.codex', 'config.toml'))
  })

  it('reads no project config in a folder nothing marks trusted: a project-only name gets no override', async () => {
    await userConfig('[mcp_servers.docs]\ncommand = "d"\n')
    await projectConfig(project, '[mcp_servers.projonly]\ncommand = "p"\n')
    const open = vi.spyOn(fsp, 'open')
    const launch = await prepareIsolatedLaunch('codex', project, {}, passing(), realIO())
    expect(launch.args).toEqual([...OFF_CMD('docs'), ...TAIL])
    expect(open.mock.calls.map((c) => String(c[0]))).toEqual([join(home, '.codex', 'config.toml')])
  })

  it('reads each project config from the trusted folder down to the run folder, an ancestor\'s between them included', async () => {
    const sub = join(project, 'pkg', 'app')
    await mkdir(sub, { recursive: true })
    await userConfig(`[mcp_servers.docs]\ncommand = "d"\n${trust(project)}`)
    await projectConfig(project, '[mcp_servers.root]\ncommand = "r"\n')
    await projectConfig(join(project, 'pkg'), '[mcp_servers.mid]\nurl = "https://m"\n')
    await projectConfig(sub, 'mcp_servers.leaf.command = "l"\nmcp_servers.docs.args = []\n')
    // A config above the trusted folder is not Codex's to load.
    await projectConfig(base, '[mcp_servers.above]\ncommand = "a"\n')
    const launch = await prepareIsolatedLaunch('codex', sub, {}, passing(), realIO())
    expect(launch.args).toEqual([...OFF_CMD('docs'), ...OFF_CMD('root'), ...CODEX_MCP_SERVER_OFF('mid', true), ...OFF_CMD('leaf'), ...TAIL])
  })

  it('takes the topmost trusted folder as the root, matching folder names case-insensitively on Windows only', async () => {
    const sub = join(project, 'app')
    await mkdir(sub)
    await userConfig(`${trust(sub)}${trust(project.toUpperCase())}`)
    await projectConfig(project, '[mcp_servers.root]\ncommand = "r"\n')
    const win = await prepareIsolatedLaunch('codex', sub, {}, passing(), { ...realIO(), platform: 'win32' })
    expect(win.args).toEqual([...OFF_CMD('root'), ...TAIL])
    clearIsolationChecks()
    // On a case-sensitive platform the upper-cased folder is a different one: only `sub` is trusted.
    const posix = await prepareIsolatedLaunch('codex', sub, {}, passing(), { ...realIO(), platform: 'linux', realpath: async (p) => p })
    expect(posix.args).toEqual(TAIL)
  })

  it('never opens a symlinked project config, and refuses the run', async () => {
    await userConfig(trust(project))
    const target = join(base, 'elsewhere')
    await mkdir(target)
    await mkdir(join(project, '.codex'))
    // A junction on Windows (no privilege needed), a plain directory symlink elsewhere: lstat sees a link either way.
    await symlink(target, join(project, '.codex', 'config.toml'), 'junction')
    const open = vi.spyOn(fsp, 'open')
    await expect(prepareIsolatedLaunch('codex', project, {}, passing(), realIO())).rejects.toThrow(`${join(project, '.codex', 'config.toml')} is not a regular file`)
    expect(open.mock.calls.map((c) => String(c[0]))).toEqual([join(home, '.codex', 'config.toml')])
  })

  it('refuses a project config that is a folder, or that resolves outside the trusted folder', async () => {
    await userConfig(trust(project))
    await mkdir(join(project, '.codex', 'config.toml'), { recursive: true })
    await expect(prepareIsolatedLaunch('codex', project, {}, passing(), realIO())).rejects.toThrow('is not a regular file')
    await rm(join(project, '.codex'), { recursive: true })
    const outside = join(base, 'outside')
    await projectConfig(outside, '[mcp_servers.x]\ncommand = "x"\n')
    await symlink(join(outside, '.codex'), join(project, '.codex'), 'junction')
    await expect(prepareIsolatedLaunch('codex', project, {}, passing(), realIO())).rejects.toThrow(`${join(project, '.codex', 'config.toml')} is outside ${project}`)
  })

  it('opens a project config without following a link where the OS can refuse one', async () => {
    await userConfig(trust(project))
    const cfg = await projectConfig(project, '[mcp_servers.p]\ncommand = "p"\n')
    const readText = vi.fn(defaultIsolationIO.readText)
    await prepareIsolatedLaunch('codex', project, {}, passing(), { ...realIO(), readText })
    expect(readText.mock.calls).toEqual([[join(home, '.codex', 'config.toml')], [cfg, { noFollow: true }]])
  })

  it('a project config gone between the check and the read is skipped', async () => {
    await userConfig(trust(project))
    await projectConfig(project, '[mcp_servers.p]\ncommand = "p"\n')
    const readText: IsolationIO['readText'] = async (p, o) => (o?.noFollow ? null : defaultIsolationIO.readText(p))
    const launch = await prepareIsolatedLaunch('codex', project, {}, passing(), { ...realIO(), readText })
    expect(launch.args).toEqual(TAIL)
  })

  it('reads the profile config the user config names, listed like it, with its trusted folders', async () => {
    await userConfig('profile = "work"\n[mcp_servers.docs]\ncommand = "d"\n')
    await writeFile(join(home, '.codex', 'work.config.toml'), `[mcp_servers.jira]\nurl = "https://j"\n${trust(project)}`)
    await projectConfig(project, '[mcp_servers.p]\ncommand = "p"\n')
    const launch = await prepareIsolatedLaunch('codex', project, {}, passing(), realIO())
    expect(launch.args).toEqual([...OFF_CMD('docs'), ...CODEX_MCP_SERVER_OFF('jira', true), ...OFF_CMD('p'), ...TAIL])
  })

  it('a profile with no config file of its own adds nothing', async () => {
    await userConfig('profile = "work"\n')
    expect((await prepareIsolatedLaunch('codex', project, {}, passing(), realIO())).args).toEqual(TAIL)
  })

  it('refuses the run when a config can\'t be listed, names an unsafe server or profile, or can\'t be read', async () => {
    const cfg = await userConfig('mcp_servers = { docs = { command = "d" } }\n')
    const go = (): Promise<unknown> => prepareIsolatedLaunch('codex', project, {}, passing(), realIO())
    await expect(go()).rejects.toThrow(`can't switch Codex's MCP servers off: ${cfg}: mcp_servers is set as an inline table`)
    await writeFile(cfg, '[mcp_servers."has space"]\ncommand = "d"\n')
    await expect(go()).rejects.toThrow(`can't switch Codex's MCP server "has space" off: ${cfg}`)
    await writeFile(cfg, '[mcp_servers."a.b"]\ncommand = "d"\n')
    await expect(go()).rejects.toThrow('"a.b"')
    await writeFile(cfg, 'profile = 3\n')
    await expect(go()).rejects.toThrow(`${cfg}: profile is not set as one plain string`)
    await writeFile(cfg, 'profile = "../x"\n')
    await expect(go()).rejects.toThrow(`${cfg}: profile "../x" can't be read`)
    await writeFile(cfg, 'profile = "work"\n')
    await writeFile(join(home, '.codex', 'work.config.toml'), '[[mcp_servers]]\nname = "x"\n')
    await expect(go()).rejects.toThrow(`${join(home, '.codex', 'work.config.toml')}: mcp_servers is written as an array of tables`)
    await rm(cfg)
    await mkdir(cfg)
    await expect(go()).rejects.toThrow('is not a file')
  })

  it('refuses the run unless `codex mcp list --json` exits 0 and lists every server off', async () => {
    await userConfig('[mcp_servers.docs]\ncommand = "d"\n')
    const answers: Array<{ stdout: string; code: number }> = [
      { stdout: '[{"name":"docs","enabled":true}]', code: 0 },
      { stdout: '[]', code: 1 },
      { stdout: 'error: unknown subcommand', code: 0 },
    ]
    for (const a of answers) {
      await expect(prepareIsolatedLaunch('codex', project, {}, async () => a, realIO()))
        .rejects.toThrow(`codex mcp list did not show every MCP server off (exit ${a.code})`)
    }
    await expect(prepareIsolatedLaunch('codex', project, {}, async () => { throw new Error('codex did not finish within 15s') }, realIO()))
      .rejects.toThrow('did not finish')
  })

  it('a passed check stands for 60 s for the same folder and config, and runs again after or on any change', async () => {
    const cfg = await userConfig('[mcp_servers.docs]\ncommand = "d"\n')
    const run = passing()
    const io = realIO()
    await prepareIsolatedLaunch('codex', project, {}, run, io)
    clock += MCP_LIST_PASS_MS - 1
    await prepareIsolatedLaunch('codex', project, {}, run, io)
    expect(run).toHaveBeenCalledTimes(1)
    clock += 1
    await prepareIsolatedLaunch('codex', project, {}, run, io)
    expect(run).toHaveBeenCalledTimes(2)
    await writeFile(cfg, '[mcp_servers.docs]\ncommand = "d2"\n')
    await prepareIsolatedLaunch('codex', project, {}, run, io)
    expect(run).toHaveBeenCalledTimes(3)
    await prepareIsolatedLaunch('codex', base, {}, run, io)
    expect(run).toHaveBeenCalledTimes(4)
    await prepareIsolatedLaunch('codex', project, { CODEX_HOME: join(home, '.codex') }, run, io)
    expect(run).toHaveBeenCalledTimes(5)
    // A failed check is never cached.
    const failing = vi.fn<McpListRun>(async () => ({ stdout: '[{"name":"docs","enabled":true}]', code: 0 }))
    await writeFile(cfg, '[mcp_servers.docs]\ncommand = "d3"\n')
    await expect(prepareIsolatedLaunch('codex', project, {}, failing, io)).rejects.toThrow()
    await expect(prepareIsolatedLaunch('codex', project, {}, failing, io)).rejects.toThrow()
    expect(failing).toHaveBeenCalledTimes(2)
  })
})

// HOLD-A N1: verified with codex-cli 0.164.0 (`codex mcp list --json`, a throwaway CODEX_HOME, no sign-in): each
// value set this way wins over a trusted project's .codex/config.toml.
// HOLD-A R2-1, verified with codex-cli 0.164.0 (`codex mcp list --json`, a throwaway CODEX_HOME, no sign-in): in a
// linked git worktree Codex trusts the folder through the worktree's main repository, and loads the worktree's own
// .codex/config.toml (and those below it, down to the run folder) when only the main repository is trusted.
describe('prepareIsolatedLaunch for Codex in a linked git worktree', () => {
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', [
    '-c', 'user.email=t@example.test', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args,
  ], { cwd, stdio: 'pipe' }).toString()
  /** Rewrites a file git made: Git for Windows makes a worktree's .git file hidden, which Windows won't open for
   *  writing over, so it is removed first. */
  const rewrite = async (p: string, text: string): Promise<void> => {
    await rm(p)
    await writeFile(p, text)
  }
  /** A real repository with one commit, and a worktree of it added beside it with `git worktree add`. */
  async function worktree(): Promise<{ main: string; wt: string }> {
    const main = join(base, 'main')
    const wt = join(base, 'wt')
    await mkdir(main)
    git(main, 'init', '-q')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'first')
    git(main, 'worktree', 'add', '-q', '--detach', wt)
    return { main, wt }
  }

  it('reads the worktree\'s project configs down to the run folder when only its main repository is trusted', async () => {
    const { main, wt } = await worktree()
    await userConfig(trust(main))
    const sub = join(wt, 'pkg')
    await mkdir(sub)
    await projectConfig(wt, '[mcp_servers.wtsrv]\ncommand = "w"\n')
    await projectConfig(sub, '[mcp_servers.subsrv]\nurl = "https://s"\n')
    // The folder above the worktree is not the repository's, and Codex does not read it.
    await projectConfig(base, '[mcp_servers.above]\ncommand = "a"\n')
    expect((await prepareIsolatedLaunch('codex', wt, {}, passing(), realIO())).args).toEqual([...OFF_CMD('wtsrv'), ...TAIL])
    clearIsolationChecks()
    expect((await prepareIsolatedLaunch('codex', sub, {}, passing(), realIO())).args)
      .toEqual([...OFF_CMD('wtsrv'), ...CODEX_MCP_SERVER_OFF('subsrv', true), ...TAIL])
  })

  it('refuses to keep Termpolis\'s server when the worktree\'s config defines one, the main repository alone trusted', async () => {
    const { main, wt } = await worktree()
    await userConfig(`[mcp_servers.termpolis]\ncommand = "t"\n${trust(main)}`)
    const cfg = await projectConfig(wt, '[mcp_servers.termpolis.env]\nNODE_OPTIONS = "--require=evil.js"\n')
    const run = passing()
    await expect(prepareIsolatedLaunch('codex', wt, {}, run, realIO(), { keepTermpolis: KEPT }))
      .rejects.toThrow(`can't keep Termpolis's MCP server for the run: ${cfg} sets a server of its own named termpolis`)
    expect(run).not.toHaveBeenCalled()
  })

  // HOLD-A R3-2. Codex matches a trusted project by its real path, so a trust spelled another way (a link, a junction,
  // an 8.3 short name) to the main repository is its trust too.
  it('a trust spelled another way than the main repository is its trust when both name the same real folder', async () => {
    const { main, wt } = await worktree()
    const alias = join(base, 'main-alias')
    await userConfig(trust(alias))
    await projectConfig(wt, '[mcp_servers.wtsrv]\ncommand = "w"\n')
    const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()
    // The alias leads to the main repository, as a link would; every other path is its own.
    const aliased: IsolationIO = { ...realIO(), realpath: async (p) => defaultIsolationIO.realpath(same(p, alias) ? main : p) }
    expect((await prepareIsolatedLaunch('codex', wt, {}, passing(), aliased)).args).toEqual([...OFF_CMD('wtsrv'), ...TAIL])
    // Without the alias leading anywhere, the trust is another folder's, and nothing of the worktree is read.
    clearIsolationChecks()
    expect((await prepareIsolatedLaunch('codex', wt, {}, passing(), realIO())).args).toEqual(TAIL)
  })

  it('reads nothing of the worktree when neither it nor its main repository is trusted', async () => {
    const { wt } = await worktree()
    await userConfig(trust(join(base, 'elsewhere')))
    await projectConfig(wt, '[mcp_servers.wtsrv]\ncommand = "w"\n')
    expect((await prepareIsolatedLaunch('codex', wt, {}, passing(), realIO())).args).toEqual(TAIL)
  })

  it('a change to the worktree\'s .git file or its commondir runs the check again', async () => {
    const { main, wt } = await worktree()
    await userConfig(trust(main))
    const run = passing()
    await prepareIsolatedLaunch('codex', wt, {}, run, realIO())
    await prepareIsolatedLaunch('codex', wt, {}, run, realIO())
    expect(run).toHaveBeenCalledTimes(1)
    const dotGit = join(wt, '.git')
    await rewrite(dotGit, `${await readFile(dotGit, 'utf8')}\n`)
    await prepareIsolatedLaunch('codex', wt, {}, run, realIO())
    expect(run).toHaveBeenCalledTimes(2)
    const gitdir = /^gitdir: (.+)$/m.exec(await readFile(dotGit, 'utf8'))![1].trim()
    const commondir = join(gitdir, 'commondir')
    await rewrite(commondir, `${await readFile(commondir, 'utf8')}\n`)
    await prepareIsolatedLaunch('codex', wt, {}, run, realIO())
    expect(run).toHaveBeenCalledTimes(3)
  })

  // A .git file Termpolis can read without git: one with no commondir (git's --separate-git-dir) counts the folder
  // above its git directory as the repository. Codex reads nothing there, so this reads more than Codex, which only
  // switches more off.
  it('a .git file with no commondir takes the folder above its git directory as the main repository', async () => {
    const repo = join(base, 'x')
    const gitDir = join(base, 'sep', 'x.git')
    await mkdir(gitDir, { recursive: true })
    await mkdir(repo)
    await writeFile(join(repo, '.git'), `gitdir: ${gitDir}\n`)
    await userConfig(trust(join(base, 'sep')))
    await projectConfig(repo, '[mcp_servers.xsrv]\ncommand = "x"\n')
    expect((await prepareIsolatedLaunch('codex', repo, {}, passing(), realIO())).args).toEqual([...OFF_CMD('xsrv'), ...TAIL])
  })

  it('a relative gitdir is read from the folder that holds the .git file', async () => {
    const { main, wt } = await worktree()
    const dotGit = join(wt, '.git')
    const gitdir = /^gitdir: (.+)$/m.exec(await readFile(dotGit, 'utf8'))![1].trim()
    await rewrite(dotGit, `gitdir: ${relative(wt, gitdir)}\n`)
    await userConfig(trust(main))
    await projectConfig(wt, '[mcp_servers.wtsrv]\ncommand = "w"\n')
    expect((await prepareIsolatedLaunch('codex', wt, {}, passing(), realIO())).args).toEqual([...OFF_CMD('wtsrv'), ...TAIL])
  })

  it('a .git file that names no git directory or a missing one, a linked .git and a .git folder trust nothing more', async () => {
    const { main, wt } = await worktree()
    await userConfig(trust(main))
    await projectConfig(wt, '[mcp_servers.wtsrv]\ncommand = "w"\n')
    const dotGit = join(wt, '.git')
    const real = await readFile(dotGit, 'utf8')
    for (const text of ['not a git file\n', 'gitdir:\n', `gitdir: ${join(base, 'gone', 'wt.git')}\n`]) {
      await rewrite(dotGit, text)
      expect([text, (await prepareIsolatedLaunch('codex', wt, {}, passing(), realIO())).args]).toEqual([text, TAIL])
    }
    await rewrite(dotGit, real)
    const linked: IsolationIO = { ...realIO(), entryKind: async (p) => (p === dotGit ? 'link' : defaultIsolationIO.entryKind(p)) }
    expect((await prepareIsolatedLaunch('codex', wt, {}, passing(), linked)).args).toEqual(TAIL)
    // In the main repository itself, its .git folder ends the search, and its own trust reads its config.
    await projectConfig(main, '[mcp_servers.mainsrv]\ncommand = "m"\n')
    expect((await prepareIsolatedLaunch('codex', main, {}, passing(), realIO())).args).toEqual([...OFF_CMD('mainsrv'), ...TAIL])
  })
})

describe('codexPinArgs', () => {
  it('pins the command, the args and each variable of the registration as TOML literal strings', () => {
    expect(codexPinArgs(KEPT)).toEqual(PIN)
    expect(codexPinArgs({ command: '/usr/local/bin/node', args: ['/opt/Termpolis/mcp-adapter/stdio-adapter.cjs', 'b'] })).toEqual([
      '-c', "mcp_servers.termpolis.command='/usr/local/bin/node'",
      '-c', "mcp_servers.termpolis.args=['/opt/Termpolis/mcp-adapter/stdio-adapter.cjs','b']",
    ])
    expect(codexPinArgs({ command: 'node', args: [], env: {} })).toEqual(['-c', "mcp_servers.termpolis.command='node'", '-c', 'mcp_servers.termpolis.args=[]'])
  })

  it('throws for a value a literal string can\'t hold, or a variable name that is not a bare key', () => {
    for (const bad of [
      { command: "C:\\Users\\O'Brien\\node.exe", args: [] },
      { command: 'node', args: ['a\nb'] },
      { command: 'node', args: ['a\u0000'] },
      { command: 'node', args: [], env: { 'A B': '1' } },
      { command: 'node', args: [], env: { A: 'x\ry' } },
    ]) expect(() => codexPinArgs(bad)).toThrow(/^can't keep Termpolis's MCP server for the run: its registration has a value Codex can't be handed as it is$/)
  })
})

describe('codexLayerPaths', () => {
  it('names the machine-wide, managed and plugin layers for each OS', () => {
    const tail = (h: string): string[] => [join(h, 'managed_config.toml'), join(h, 'plugins'), join(h, 'plugins', 'cache')]
    const win = (dir: string): string[] => ['config.toml', 'requirements.toml', 'managed_config.toml'].map((f) => `${dir}\\${f}`)
    expect(codexLayerPaths('h', { platform: 'win32', env: { ProgramData: 'D:\\PD' } })).toEqual([...win('D:\\PD\\OpenAI\\Codex'), ...tail('h')])
    expect(codexLayerPaths('h', { platform: 'win32', env: { PROGRAMDATA: 'E:\\PD' } })).toEqual([...win('E:\\PD\\OpenAI\\Codex'), ...tail('h')])
    expect(codexLayerPaths('h', { platform: 'win32', env: {} })).toEqual([...win('C:\\ProgramData\\OpenAI\\Codex'), ...tail('h')])
    const etc = ['/etc/codex/config.toml', '/etc/codex/requirements.toml', '/etc/codex/managed_config.toml']
    expect(codexLayerPaths('h', { platform: 'linux', env: {} })).toEqual([...etc, ...tail('h')])
    expect(codexLayerPaths('h', { platform: 'darwin', env: {} })).toEqual([...etc, '/Library/Managed Preferences/com.openai.codex.plist', ...tail('h')])
  })

  it('a change to a layer the parser doesn\'t read runs the check again inside the 60 s', async () => {
    await userConfig('[mcp_servers.docs]\ncommand = "d"\n')
    const stamps: Record<string, string> = {}
    const stamp = vi.fn(async (p: string) => stamps[p] ?? 'absent')
    const io = { ...realIO(), stamp }
    const run = passing()
    await prepareIsolatedLaunch('codex', project, {}, run, io)
    const layers = codexLayerPaths(join(home, '.codex'), io)
    expect(stamp.mock.calls.map((c) => c[0])).toEqual(layers)
    await prepareIsolatedLaunch('codex', project, {}, run, io)
    expect(run).toHaveBeenCalledTimes(1)
    for (const [i, p] of layers.entries()) {
      stamps[p] = `1:${i}`
      await prepareIsolatedLaunch('codex', project, {}, run, io)
      expect(run).toHaveBeenCalledTimes(i + 2)
    }
  })
})

describe('prepareIsolatedLaunch for agy', () => {
  it('gives the run a home of its own holding only the deny rules, checks it lists no server, removes it after, and never touches the real one', async () => {
    await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    await writeFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), '{"permissions":{"allow":["command(*)"]}}')
    await writeFile(join(home, '.gemini', 'mcp_config.json'), '{"mcpServers":{"docs":{}}}')
    const before = await snapshot(home)
    const run = passing()
    const launch = await prepareIsolatedLaunch('gemini', project, { HOME: home, PATH: 'p' }, run, realIO())
    const runHome = launch.env.HOME
    expect(launch.args).toEqual([])
    expect(launch.env).toEqual({ TERMPOLIS_READ_ONLY_RUN: '1', HOME: runHome, USERPROFILE: runHome })
    expect(runHome.startsWith(join(tmp, 'termpolis-agy-'))).toBe(true)
    expect(run).toHaveBeenCalledWith('agy', ['mcp', 'list'], {
      cwd: project, env: { HOME: runHome, PATH: 'p', TERMPOLIS_READ_ONLY_RUN: '1', USERPROFILE: runHome }, timeoutMs: MCP_LIST_TIMEOUT_MS,
    })
    expect(await snapshot(runHome)).toEqual({
      '.gemini': 'dir',
      [join('.gemini', 'antigravity-cli')]: 'dir',
      [join('.gemini', 'antigravity-cli', 'settings.json')]: expect.stringMatching(/:\{\n {2}"permissions": \{\n {4}"deny": \[\n {6}"command\(\*\)",\n/),
    })
    expect(JSON.parse(await readFile(join(runHome, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'))).toEqual(AGY_READ_ONLY_SETTINGS)
    await launch.dispose()
    await expect(stat(runHome)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await snapshot(home)).toEqual(before)
  })

  it('writes only inside the run\'s own home', async () => {
    const writeFileSpy = vi.fn(defaultIsolationIO.writeFile)
    const mkdirSpy = vi.fn(defaultIsolationIO.mkdir)
    const launch = await prepareIsolatedLaunch('gemini', project, {}, passing(), { ...realIO(), writeFile: writeFileSpy, mkdir: mkdirSpy })
    for (const p of [...writeFileSpy.mock.calls.map((c) => c[0]), ...mkdirSpy.mock.calls.map((c) => c[0])]) {
      expect(p.startsWith(launch.env.HOME)).toBe(true)
    }
    await launch.dispose()
  })

  it('removes the home and refuses the run when `agy mcp list` lists a server, fails, or can\'t be run, and caches only a pass', async () => {
    for (const run of [
      async () => ({ stdout: 'NAME   STATUS\ndocs   enabled\n', code: 0 }),
      async () => ({ stdout: AGY_NO_MCP_SERVERS, code: 2 }),
      async () => { throw new Error('agy did not finish within 15s') },
    ] as McpListRun[]) {
      await expect(prepareIsolatedLaunch('gemini', project, {}, run, realIO())).rejects.toThrow(/agy mcp list did not show every MCP server off|did not finish/)
      expect(await readdir(tmp)).toEqual([])
    }
    const run = passing()
    await (await prepareIsolatedLaunch('gemini', project, {}, run, realIO())).dispose()
    await (await prepareIsolatedLaunch('gemini', project, {}, run, realIO())).dispose()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('removes a half-made home and refuses the run when its settings can\'t be written', async () => {
    const removeDir = vi.fn(defaultIsolationIO.removeDir)
    const io = { ...realIO(), removeDir, writeFile: async () => { throw new Error('disk full') } }
    await expect(prepareIsolatedLaunch('gemini', project, {}, passing(), io)).rejects.toThrow('disk full')
    expect(removeDir).toHaveBeenCalledTimes(1)
    expect(await readdir(tmp)).toEqual([])
  })

  it('a home that can\'t be removed never fails the cleanup', async () => {
    const io = { ...realIO(), removeDir: async () => { throw new Error('busy') } }
    const launch = await prepareIsolatedLaunch('gemini', project, {}, passing(), io)
    await expect(launch.dispose()).resolves.toBeUndefined()
  })
})

describe('prepareIsolatedLaunch for Claude Code', () => {
  it('reads only the person\'s own settings and adds the read-only marker: its read-only launch already has no MCP server', async () => {
    const io = { ...realIO(), readText: vi.fn(), mkdtemp: vi.fn() }
    const run = passing()
    const launch = await prepareIsolatedLaunch('claude', project, {}, run, io)
    expect(launch.args).toEqual(['--setting-sources', 'user'])
    expect(launch.env).toEqual({ TERMPOLIS_READ_ONLY_RUN: '1' })
    await expect(launch.dispose()).resolves.toBeUndefined()
    expect(io.readText).not.toHaveBeenCalled()
    expect(io.mkdtemp).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  // HOLD-A I2: keepTermpolis is Codex's alone. Claude's linked job brings its own server file, and agy's
  // run home holds no server at all, so an agy linked job that may not write runs without Termpolis's.
  it('keepTermpolis changes nothing for Claude Code or agy', async () => {
    const claude = await prepareIsolatedLaunch('claude', project, {}, passing(), realIO(), { keepTermpolis: KEPT })
    expect(claude.args).toEqual([...CLAUDE_ISOLATE_ARGS])
    const run = passing()
    const agy = await prepareIsolatedLaunch('gemini', project, { TERMPOLIS_LINKED_JOB: 'j1' }, run, realIO(), { keepTermpolis: KEPT })
    expect(agy.args).toEqual([])
    expect(agy.env).toEqual({ TERMPOLIS_READ_ONLY_RUN: '1', HOME: agy.env.HOME, USERPROFILE: agy.env.HOME })
    expect(await snapshot(agy.env.HOME)).not.toHaveProperty(join('.gemini', 'config', 'mcp_config.json'))
    await agy.dispose()
  })
})

describe('defaultIsolationIO', () => {
  it('readText reads a file, gives null for a missing one, and throws for anything else it can\'t read', async () => {
    const p = join(base, 'c.toml')
    await writeFile(p, 'model = "x"\n')
    expect(await defaultIsolationIO.readText(p)).toBe('model = "x"\n')
    expect(await defaultIsolationIO.readText(p, { noFollow: true })).toBe('model = "x"\n')
    expect(await defaultIsolationIO.readText(join(base, 'missing.toml'))).toBeNull()
    await expect(defaultIsolationIO.readText(join(base, 'bad\0name'))).rejects.toThrow()
  })

  it('readText with noFollow refuses a link or a folder without opening it, and a missing file is null', async () => {
    const open = vi.spyOn(fsp, 'open')
    await symlink(tmp, join(base, 'l'), 'junction')
    await expect(defaultIsolationIO.readText(join(base, 'l'), { noFollow: true })).rejects.toThrow('is not a regular file')
    await expect(defaultIsolationIO.readText(tmp, { noFollow: true })).rejects.toThrow('is not a regular file')
    expect(await defaultIsolationIO.readText(join(base, 'none'), { noFollow: true })).toBeNull()
    expect(open).not.toHaveBeenCalled()
    vi.spyOn(fsp, 'lstat').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(defaultIsolationIO.readText(join(base, 'x'), { noFollow: true })).rejects.toThrow('denied')
  })

  it('readText with noFollow refuses a file swapped after it was checked: the opened file must be the one looked at', async () => {
    const p = join(base, 'c.toml')
    await writeFile(p, 'model = "x"\n')
    const real = await fsp.lstat(p, { bigint: true })
    const swapped = { isFile: () => true, dev: real.dev, ino: real.ino + 1n }
    vi.spyOn(fsp, 'lstat').mockResolvedValueOnce(swapped as never)
    await expect(defaultIsolationIO.readText(p, { noFollow: true })).rejects.toThrow(`${p} changed while it was opened`)
    vi.spyOn(fsp, 'lstat').mockResolvedValueOnce({ ...swapped, ino: real.ino, dev: real.dev + 1n } as never)
    await expect(defaultIsolationIO.readText(p, { noFollow: true })).rejects.toThrow('changed while it was opened')
    // Gone between the look and the open: null, as a missing file is.
    vi.spyOn(fsp, 'lstat').mockResolvedValueOnce(swapped as never)
    expect(await defaultIsolationIO.readText(join(base, 'gone.toml'), { noFollow: true })).toBeNull()
  })

  it('stamp gives size and time, absent for nothing there, and never throws', async () => {
    const f = join(base, 'f')
    await writeFile(f, 'abc')
    const st = await stat(f)
    expect(await defaultIsolationIO.stamp(f)).toBe(`3:${st.mtimeMs}`)
    expect(await defaultIsolationIO.stamp(tmp)).toMatch(/^\d+:[\d.]+$/)
    expect(await defaultIsolationIO.stamp(join(base, 'none'))).toBe('absent')
    expect(await defaultIsolationIO.stamp(join(f, 'under-a-file'))).toBe('absent')
    vi.spyOn(fsp, 'stat').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    expect(await defaultIsolationIO.stamp(f)).toBe('unreadable:EACCES')
  })

  it('readText refuses a file over the cap without reading it', async () => {
    const p = join(base, 'big.toml')
    await writeFile(p, Buffer.alloc(MAX_CODEX_CONFIG_BYTES + 1, 0x61))
    await expect(defaultIsolationIO.readText(p)).rejects.toThrow('is too big to read')
  })

  it('readText refuses a file that grows past its size while it is read, and a close that fails changes nothing', async () => {
    const handle = {
      stat: async () => ({ isFile: () => true, size: 2 }),
      read: async (buf: Buffer, offset: number, length: number) => ({ bytesRead: length, buffer: buf.fill(0x61, offset, offset + length) }),
      close: async () => { throw new Error('close failed') },
    }
    vi.spyOn(fsp, 'open').mockResolvedValue(handle as never)
    await expect(defaultIsolationIO.readText('grows.toml')).rejects.toThrow('grows.toml is too big to read')
  })

  it('entryKind tells a file, a link, anything else and nothing apart, and throws on any other error', async () => {
    const f = join(base, 'f')
    await writeFile(f, 'x')
    await symlink(tmp, join(base, 'l'), 'junction')
    expect(await defaultIsolationIO.entryKind(f)).toBe('file')
    expect(await defaultIsolationIO.entryKind(join(base, 'l'))).toBe('link')
    expect(await defaultIsolationIO.entryKind(tmp)).toBe('other')
    expect(await defaultIsolationIO.entryKind(join(base, 'none'))).toBeNull()
    vi.spyOn(fsp, 'lstat').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(defaultIsolationIO.entryKind(f)).rejects.toThrow('denied')
  })

  it('realpath, mkdtemp, mkdir, writeFile and removeDir work on real folders', async () => {
    expect(await defaultIsolationIO.realpath(tmp)).toBe(await fsp.realpath(tmp))
    const made = await defaultIsolationIO.mkdtemp(join(tmp, 'x-'))
    await defaultIsolationIO.mkdir(join(made, 'a', 'b'))
    await defaultIsolationIO.writeFile(join(made, 'a', 'b', 'c.txt'), 'hi')
    expect(await readFile(join(made, 'a', 'b', 'c.txt'), 'utf8')).toBe('hi')
    await defaultIsolationIO.removeDir(made)
    await expect(stat(made)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removeDirRetrying retries while a file is held', async () => {
    const rmSpy = vi.spyOn(fsp, 'rm').mockResolvedValue(undefined)
    await removeDirRetrying('some/dir')
    expect(rmSpy).toHaveBeenCalledWith('some/dir', { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
})

describe('sweepStaleAgyHomes', () => {
  const HOUR = 60 * 60_000
  const old = async (name: string): Promise<string> => {
    const p = join(tmp, name)
    await mkdir(p)
    await writeFile(join(p, 'f'), 'x')
    const t = new Date(Date.now() - 2 * HOUR)
    await utimes(p, t, t)
    return p
  }

  it('removes an old run home a stopped run left, and keeps a fresh one, other names, files and links', async () => {
    const stale = await old('termpolis-agy-Ab12Cd')
    const fresh = join(tmp, 'termpolis-agy-Zz99Yy')
    await mkdir(fresh)
    const other = await old('termpolis-agy-toolongname')
    const notOurs = await old('someone-else-abc123')
    await writeFile(join(tmp, 'termpolis-agy-file01'), 'x')
    const target = await old('target')
    await symlink(target, join(tmp, 'termpolis-agy-link01'), 'junction')
    const t = new Date(Date.now() - 2 * HOUR)
    await utimes(join(tmp, 'termpolis-agy-file01'), t, t)
    vi.spyOn(os, 'tmpdir').mockReturnValue(tmp)
    expect(await sweepStaleAgyHomes(HOUR)).toBe(1)
    await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const p of [fresh, other, notOurs, join(tmp, 'termpolis-agy-file01'), join(tmp, 'termpolis-agy-link01'), join(target, 'f')]) await stat(p)
  })

  it('a stopped Ask\'s leftover home is gone after a sweep', async () => {
    // A run stopped by a quit never reaches its dispose: its home stays until the next start's sweep.
    const launch = await prepareIsolatedLaunch('gemini', project, {}, passing(), realIO())
    const t = new Date(Date.now() - 2 * HOUR)
    await utimes(launch.env.HOME, t, t)
    vi.spyOn(os, 'tmpdir').mockReturnValue(tmp)
    expect(await sweepStaleAgyHomes(HOUR)).toBe(1)
    expect(await readdir(tmp)).toEqual([])
  })

  it('never throws: one folder that fails doesn\'t stop the others, and an unreadable temp folder sweeps nothing', async () => {
    const removed: string[] = []
    const io: SweepIO = {
      tmpdir: () => '/t',
      readdir: async () => ['termpolis-agy-aaaaaa', 'termpolis-agy-bbbbbb', 'termpolis-agy-cccccc'],
      folderMtime: async (p) => {
        if (p.endsWith('aaaaaa')) throw new Error('gone')
        return 0
      },
      removeDir: async (p) => {
        if (p.endsWith('bbbbbb')) throw new Error('busy')
        removed.push(p)
      },
      now: () => HOUR * 10,
    }
    expect(await sweepStaleAgyHomes(HOUR, io)).toBe(1)
    expect(removed).toEqual([join('/t', 'termpolis-agy-cccccc')])
    expect(await sweepStaleAgyHomes(HOUR, { ...io, readdir: async () => { throw new Error('EACCES') } })).toBe(0)
  })
})
