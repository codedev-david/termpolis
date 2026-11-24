// readOnlyIsolation.ts
//
// What an isolated read-only headless run (ExecRequest.isolated) adds to each agent's launch, so that
// the run can read the folder it was given and do nothing else: no MCP server of the person's, no shell
// command, no file write. A read-only launch alone does not get there for every agent:
//   - Codex's sandbox covers only the commands the model runs. An MCP tool call is not sandboxed, so
//     every server in its config.toml stays live in `--sandbox read-only`. Codex has no flag that drops
//     them all (`-c mcp_servers={}` does not), so each one is switched off by name with
//     CODEX_MCP_SERVER_OFF, the names read from the config.toml files Codex reads.
//   - agy has no per-run MCP flag and no tool allowlist flag in the versions Termpolis supports, and
//     its servers, its allow rules and its settings all live under the OS home folder. The run gets a
//     throwaway home of its own (HOME and USERPROFILE), which holds no MCP server and one settings
//     file that denies commands and file writes (AGY_READ_ONLY_SETTINGS). agy keeps its Google
//     sign-in in the OS keyring, not in that folder, so the run stays signed in. The person's own
//     ~/.gemini is never read or written.
//   - Claude Code's read-only launch already has no MCP server (`--strict-mcp-config`) and only
//     Read, Grep and Glob, so it needs nothing more.
// Every agent also gets TERMPOLIS_READ_ONLY_RUN, which narrows Termpolis's own MCP server and memory
// hook to read-only wherever one is still reached.
//
// The person's files are only ever read: config.toml for the server names. Nothing here writes outside
// the run's own temp folder.

import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import { codexMcpServerNames } from './codexConfigEdit'
import { CODEX_ISOLATE_MCP_ARGS, type SecondOpinionAgent } from './secondOpinion'

/** The marker Termpolis's MCP adapter and memory hook read as "this run is read-only". */
export const READ_ONLY_RUN_ENV = { TERMPOLIS_READ_ONLY_RUN: '1' } as const

/** Codex's documented config override that switches one MCP server off for one run (`-c` takes a
 *  dotted path; the value parses as TOML). Verified per server against codex-cli 0.153.4 (spec
 *  2026-10-05-linked-machines-design.md); 0.171.0's `exec --help` documents the same `-c` form and has
 *  no flag that drops every server. The one place this override is spelled. */
export const CODEX_MCP_SERVER_OFF = (name: string): string[] => ['-c', `mcp_servers.${name}.enabled=false`]

/** The settings agy reads from the run's own home: no command runs and no file is written, whatever
 *  the mode. Rule names as agy 1.4.8 reports them (`command(...)`, `write_file(...)`); verified here:
 *  a headless run with these refused both and still read and answered. */
export const AGY_READ_ONLY_SETTINGS = { permissions: { deny: ['command(*)', 'write_file(*)'] } } as const

/** A server name that is safe as one segment of a `-c` dotted path. Anything else would need TOML
 *  quoting the override parser may read differently, so it fails the run instead. */
const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** A config.toml bigger than this is not read: no real one comes near it. */
export const MAX_CODEX_CONFIG_BYTES = 1024 * 1024

export interface IsolatedLaunch {
  /** Options for the agent's argv, placed with its other options (Codex only). */
  args: string[]
  /** Set on top of the run's environment. */
  env: Record<string, string>
  /** Called once the run has settled, however it ended. Never throws. */
  dispose: () => Promise<void>
}

export interface IsolationIO {
  /** A file's text; null when it does not exist. Throws when it exists but can't be read. */
  readText: (p: string) => Promise<string | null>
  /** Makes a new empty folder named from `prefix`, as fs.mkdtemp does. */
  mkdtemp: (prefix: string) => Promise<string>
  mkdir: (p: string) => Promise<void>
  writeFile: (p: string, text: string) => Promise<void>
  /** Removes a folder and everything in it. */
  removeDir: (p: string) => Promise<void>
  tmpdir: () => string
  homedir: () => string
  /** The app's own environment, for CODEX_HOME. */
  env: Readonly<Record<string, string | undefined>>
}

/** Reads at most MAX_CODEX_CONFIG_BYTES; a missing file is null, anything else unreadable throws. */
async function readTextCapped(p: string): Promise<string | null> {
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(p, 'r')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) throw new Error(`${p} is not a file`)
    if (st.size > MAX_CODEX_CONFIG_BYTES) throw new Error(`${p} is too big to read`)
    const buf = Buffer.alloc(st.size + 1)
    let filled = 0
    for (;;) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
      if (filled === buf.length) throw new Error(`${p} is too big to read`)
    }
    return buf.toString('utf8', 0, filled)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export const defaultIsolationIO: IsolationIO = {
  readText: readTextCapped,
  mkdtemp: (prefix) => fsp.mkdtemp(prefix),
  mkdir: async (p) => {
    await fsp.mkdir(p, { recursive: true })
  },
  writeFile: (p, text) => fsp.writeFile(p, text, 'utf8'),
  removeDir: (p) => fsp.rm(p, { recursive: true, force: true }),
  tmpdir: () => os.tmpdir(),
  homedir: () => os.homedir(),
  env: process.env,
}

const noop = async (): Promise<void> => undefined

/** The MCP servers Codex would start for a run in `cwd`: the user config.toml (in the run's CODEX_HOME,
 *  else the app's, else ~/.codex) and the project's `.codex/config.toml`. Throws when a file can't be
 *  read or listed, or names a server that can't be switched off safely: a run that can't switch every
 *  server off doesn't start. */
async function codexServerNames(cwd: string, runEnv: Readonly<Record<string, string>>, io: IsolationIO): Promise<string[]> {
  const home = runEnv.CODEX_HOME || io.env.CODEX_HOME || path.join(io.homedir(), '.codex')
  const names: string[] = []
  for (const file of [path.join(home, 'config.toml'), path.join(cwd, '.codex', 'config.toml')]) {
    const text = await io.readText(file)
    if (text === null) continue
    const listed = codexMcpServerNames(text)
    if ('error' in listed) throw new Error(`can't switch Codex's MCP servers off: ${file}: ${listed.error}`)
    for (const name of listed.names) {
      if (!SAFE_SERVER_NAME.test(name)) throw new Error(`can't switch Codex's MCP server "${name}" off: ${file}`)
      if (!names.includes(name)) names.push(name)
    }
  }
  return names
}

/** What an isolated read-only run of `agent` in `cwd` adds to its launch. Throws when the isolation
 *  can't be set up; the run must then not start. */
export async function prepareIsolatedLaunch(
  agent: SecondOpinionAgent,
  cwd: string,
  runEnv: Readonly<Record<string, string>>,
  io: IsolationIO = defaultIsolationIO,
): Promise<IsolatedLaunch> {
  if (agent === 'codex') {
    const names = await codexServerNames(cwd, runEnv, io)
    // Termpolis's own server is switched off with its placeholder command too, as every isolated Codex
    // run already does, so it is off even when no config file names it.
    const args = [...names.filter((n) => n !== 'termpolis').flatMap(CODEX_MCP_SERVER_OFF), ...CODEX_ISOLATE_MCP_ARGS]
    return { args, env: { ...READ_ONLY_RUN_ENV }, dispose: noop }
  }
  if (agent === 'gemini') {
    const home = await io.mkdtemp(path.join(io.tmpdir(), 'termpolis-agy-'))
    const dispose = async (): Promise<void> => {
      await io.removeDir(home).catch(() => undefined)
    }
    try {
      const dir = path.join(home, '.gemini', 'antigravity-cli')
      await io.mkdir(dir)
      await io.writeFile(path.join(dir, 'settings.json'), `${JSON.stringify(AGY_READ_ONLY_SETTINGS, null, 2)}\n`)
    } catch (e) {
      await dispose()
      throw e
    }
    return { args: [], env: { ...READ_ONLY_RUN_ENV, HOME: home, USERPROFILE: home }, dispose }
  }
  return { args: [], env: { ...READ_ONLY_RUN_ENV }, dispose: noop }
}
