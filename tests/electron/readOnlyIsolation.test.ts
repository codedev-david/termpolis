import { promises as fsp } from 'fs'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGY_NO_MCP_SERVERS, AGY_READ_ONLY_SETTINGS, CLAUDE_ISOLATE_ARGS, CODEX_MCP_OFF_COMMAND, CODEX_MCP_OFF_URL, CODEX_MCP_SERVER_OFF,
  CODEX_NO_CONNECTORS_ARGS, ISOLATION_SETUP_FAILED, MAX_CODEX_CONFIG_BYTES, MCP_LIST_PASS_MS, MCP_LIST_TIMEOUT_MS, READ_ONLY_RUN_ENV,
  agyMcpListEmpty, clearIsolationChecks, codexMcpListAllOff, defaultIsolationIO, prepareIsolatedLaunch, removeDirRetrying,
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
