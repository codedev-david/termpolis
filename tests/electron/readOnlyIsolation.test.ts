import { promises as fsp } from 'fs'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGY_READ_ONLY_SETTINGS, CODEX_MCP_SERVER_OFF, MAX_CODEX_CONFIG_BYTES, READ_ONLY_RUN_ENV, defaultIsolationIO, prepareIsolatedLaunch,
  type IsolationIO,
} from '../../src/main/readOnlyIsolation'
import { CODEX_ISOLATE_MCP_ARGS } from '../../src/main/secondOpinion'

// Every test runs against a fake home and a fake temp folder of its own: nothing reads or writes the
// real ~/.codex or ~/.gemini of whoever runs the suite.

let base: string
let home: string
let tmp: string
let project: string
beforeEach(async () => {
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

/** The real file IO, pointed at the fake home and temp folder. */
const realIO = (env: Record<string, string | undefined> = {}): IsolationIO => ({
  ...defaultIsolationIO, homedir: () => home, tmpdir: () => tmp, env,
})

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

describe('readOnlyIsolation constants', () => {
  it('spells the Codex override, the agy rules and the read-only marker once', () => {
    expect(CODEX_MCP_SERVER_OFF('docs')).toEqual(['-c', 'mcp_servers.docs.enabled=false'])
    expect(AGY_READ_ONLY_SETTINGS).toEqual({ permissions: { deny: ['command(*)', 'write_file(*)'] } })
    expect(READ_ONLY_RUN_ENV).toEqual({ TERMPOLIS_READ_ONLY_RUN: '1' })
    expect(defaultIsolationIO.tmpdir()).toBe(os.tmpdir())
    expect(defaultIsolationIO.homedir()).toBe(os.homedir())
    expect(defaultIsolationIO.env).toBe(process.env)
  })
})

describe('prepareIsolatedLaunch for Codex', () => {
  it('switches off every server in the user and project config, each once, Termpolis\'s with its placeholder, and writes nothing', async () => {
    await mkdir(join(home, '.codex'))
    await writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "d"\n[mcp_servers.termpolis]\ncommand = "t"\n')
    await mkdir(join(project, '.codex'))
    await writeFile(join(project, '.codex', 'config.toml'), 'mcp_servers.docs.args = []\n[mcp_servers.github]\ncommand = "g"\n')
    const before = { home: await snapshot(home), project: await snapshot(project), tmp: await snapshot(tmp) }
    const launch = await prepareIsolatedLaunch('codex', project, {}, realIO())
    expect(launch.args).toEqual([
      '-c', 'mcp_servers.docs.enabled=false',
      '-c', 'mcp_servers.github.enabled=false',
      ...CODEX_ISOLATE_MCP_ARGS,
    ])
    expect(launch.env).toEqual({ TERMPOLIS_READ_ONLY_RUN: '1' })
    await launch.dispose()
    expect({ home: await snapshot(home), project: await snapshot(project), tmp: await snapshot(tmp) }).toEqual(before)
  })

  it('still switches Termpolis\'s server off when there is no config at all', async () => {
    const launch = await prepareIsolatedLaunch('codex', project, {}, realIO())
    expect(launch.args).toEqual([...CODEX_ISOLATE_MCP_ARGS])
  })

  it('reads the config in the run\'s CODEX_HOME first, then the app\'s, then ~/.codex', async () => {
    const readText = vi.fn(async () => null)
    const io = { ...realIO({ CODEX_HOME: join(base, 'app-codex') }), readText }
    await prepareIsolatedLaunch('codex', project, { CODEX_HOME: join(base, 'run-codex') }, io)
    expect(readText.mock.calls.map((c) => c[0])).toEqual([join(base, 'run-codex', 'config.toml'), join(project, '.codex', 'config.toml')])
    readText.mockClear()
    await prepareIsolatedLaunch('codex', project, {}, io)
    expect(readText.mock.calls[0][0]).toBe(join(base, 'app-codex', 'config.toml'))
    readText.mockClear()
    await prepareIsolatedLaunch('codex', project, {}, { ...io, env: {} })
    expect(readText.mock.calls[0][0]).toBe(join(home, '.codex', 'config.toml'))
  })

  it('refuses the run when a config can\'t be listed, names an unsafe server, or can\'t be read', async () => {
    await mkdir(join(home, '.codex'))
    const cfg = join(home, '.codex', 'config.toml')
    await writeFile(cfg, 'mcp_servers = { docs = { command = "d" } }\n')
    await expect(prepareIsolatedLaunch('codex', project, {}, realIO())).rejects.toThrow(`can't switch Codex's MCP servers off: ${cfg}: mcp_servers is set as an inline table`)
    await writeFile(cfg, '[mcp_servers."has space"]\ncommand = "d"\n')
    await expect(prepareIsolatedLaunch('codex', project, {}, realIO())).rejects.toThrow(`can't switch Codex's MCP server "has space" off: ${cfg}`)
    await writeFile(cfg, '[mcp_servers."a.b"]\ncommand = "d"\n')
    await expect(prepareIsolatedLaunch('codex', project, {}, realIO())).rejects.toThrow('"a.b"')
    await rm(cfg)
    await mkdir(cfg)
    await expect(prepareIsolatedLaunch('codex', project, {}, realIO())).rejects.toThrow('is not a file')
  })
})

describe('prepareIsolatedLaunch for agy', () => {
  it('gives the run a home of its own holding only the deny rules, removes it after, and never touches the real one', async () => {
    await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    await writeFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), '{"permissions":{"allow":["command(*)"]}}')
    await writeFile(join(home, '.gemini', 'mcp_config.json'), '{"mcpServers":{"docs":{}}}')
    const before = await snapshot(home)
    const launch = await prepareIsolatedLaunch('gemini', project, { HOME: home }, realIO())
    const runHome = launch.env.HOME
    expect(launch.args).toEqual([])
    expect(launch.env).toEqual({ TERMPOLIS_READ_ONLY_RUN: '1', HOME: runHome, USERPROFILE: runHome })
    expect(runHome.startsWith(join(tmp, 'termpolis-agy-'))).toBe(true)
    expect(await snapshot(runHome)).toEqual({
      '.gemini': 'dir',
      [join('.gemini', 'antigravity-cli')]: 'dir',
      [join('.gemini', 'antigravity-cli', 'settings.json')]: expect.stringMatching(/:\{\n {2}"permissions": \{\n {4}"deny": \[\n {6}"command\(\*\)",\n {6}"write_file\(\*\)"\n {4}\]\n {2}\}\n\}\n$/),
    })
    expect(JSON.parse(await readFile(join(runHome, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'))).toEqual(AGY_READ_ONLY_SETTINGS)
    await launch.dispose()
    await expect(stat(runHome)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await snapshot(home)).toEqual(before)
  })

  it('writes only inside the run\'s own home', async () => {
    const writeFileSpy = vi.fn(defaultIsolationIO.writeFile)
    const mkdirSpy = vi.fn(defaultIsolationIO.mkdir)
    const launch = await prepareIsolatedLaunch('gemini', project, {}, { ...realIO(), writeFile: writeFileSpy, mkdir: mkdirSpy })
    for (const p of [...writeFileSpy.mock.calls.map((c) => c[0]), ...mkdirSpy.mock.calls.map((c) => c[0])]) {
      expect(p.startsWith(launch.env.HOME)).toBe(true)
    }
    await launch.dispose()
  })

  it('removes a half-made home and refuses the run when its settings can\'t be written', async () => {
    const removeDir = vi.fn(defaultIsolationIO.removeDir)
    const io = { ...realIO(), removeDir, writeFile: async () => { throw new Error('disk full') } }
    await expect(prepareIsolatedLaunch('gemini', project, {}, io)).rejects.toThrow('disk full')
    expect(removeDir).toHaveBeenCalledTimes(1)
    expect(await readdir(tmp)).toEqual([])
  })

  it('a home that can\'t be removed never fails the cleanup', async () => {
    const io = { ...realIO(), removeDir: async () => { throw new Error('busy') } }
    const launch = await prepareIsolatedLaunch('gemini', project, {}, io)
    await expect(launch.dispose()).resolves.toBeUndefined()
  })
})

describe('prepareIsolatedLaunch for Claude Code', () => {
  it('adds only the read-only marker: its read-only launch already has no MCP server', async () => {
    const io = { ...realIO(), readText: vi.fn(), mkdtemp: vi.fn() }
    const launch = await prepareIsolatedLaunch('claude', project, {}, io)
    expect(launch.args).toEqual([])
    expect(launch.env).toEqual({ TERMPOLIS_READ_ONLY_RUN: '1' })
    await expect(launch.dispose()).resolves.toBeUndefined()
    expect(io.readText).not.toHaveBeenCalled()
    expect(io.mkdtemp).not.toHaveBeenCalled()
  })
})

describe('defaultIsolationIO.readText', () => {
  it('reads a file, gives null for a missing one, and throws for anything else it can\'t read', async () => {
    const p = join(base, 'c.toml')
    await writeFile(p, 'model = "x"\n')
    expect(await defaultIsolationIO.readText(p)).toBe('model = "x"\n')
    expect(await defaultIsolationIO.readText(join(base, 'missing.toml'))).toBeNull()
    await expect(defaultIsolationIO.readText(join(base, 'bad\0name'))).rejects.toThrow()
  })

  it('refuses a file over the cap without reading it', async () => {
    const p = join(base, 'big.toml')
    await writeFile(p, Buffer.alloc(MAX_CODEX_CONFIG_BYTES + 1, 0x61))
    await expect(defaultIsolationIO.readText(p)).rejects.toThrow('is too big to read')
  })

  it('refuses a file that grows past its size while it is read, and a close that fails changes nothing', async () => {
    const handle = {
      stat: async () => ({ isFile: () => true, size: 2 }),
      read: async (buf: Buffer, offset: number, length: number) => ({ bytesRead: length, buffer: buf.fill(0x61, offset, offset + length) }),
      close: async () => { throw new Error('close failed') },
    }
    vi.spyOn(fsp, 'open').mockResolvedValue(handle as never)
    await expect(defaultIsolationIO.readText('grows.toml')).rejects.toThrow('grows.toml is too big to read')
  })
})
