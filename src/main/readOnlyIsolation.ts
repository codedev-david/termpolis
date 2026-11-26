// readOnlyIsolation.ts
//
// What an isolated read-only headless run (ExecRequest.isolated) adds to each agent's launch, so that
// the run can read the folder it was given and do nothing else: no MCP server of the person's, no shell
// command, no file write. A read-only launch alone does not get there for every agent:
//   - Codex's sandbox covers only the commands the model runs. An MCP tool call is not sandboxed, so
//     every server in its config.toml stays live in `--sandbox read-only`. Codex has no flag that drops
//     them all (`-c mcp_servers={}` does not), so each one is switched off by name with
//     CODEX_MCP_SERVER_OFF, the names read from the config.toml files Codex reads: the user config, the
//     profile config it names, and the project configs Codex loads in a trusted folder. Its built-in
//     connectors (the codex_apps server, remote tools that can write) are switched off as a feature
//     (CODEX_NO_CONNECTORS_ARGS). Before the run, `codex mcp list --json` with the same options must list
//     every server off; a run it doesn't prove isolated doesn't start.
//   - agy has no per-run MCP flag and no tool allowlist flag in the versions Termpolis supports, and
//     its servers, its allow rules and its settings all live under the OS home folder. The run gets a
//     throwaway home of its own (HOME and USERPROFILE), which holds no MCP server and one settings
//     file that denies commands, file writes and edits, and MCP calls (AGY_READ_ONLY_SETTINGS). agy
//     keeps its Google sign-in in the OS keyring, not in that folder, so the run stays signed in. The
//     person's own ~/.gemini is never read or written. Before the run, `agy mcp list` under that home
//     must report no server.
//   - Claude Code's read-only launch already has no MCP server (`--strict-mcp-config`) and only
//     Read, Grep and Glob. It also reads only the person's own settings (CLAUDE_ISOLATE_ARGS): a
//     project's .claude/settings.json can carry hooks, which run commands outside the tool list.
// Every agent also gets TERMPOLIS_READ_ONLY_RUN, which narrows Termpolis's own MCP server and memory
// hook to read-only wherever one is still reached.
//
// A Linked machines job that may not write is isolated too (HOLD-A I2), with `keepTermpolis`: Codex
// then leaves Termpolis's own server to the run, which the job's marker narrows to its read-only tools
// (or switches off, codexLinkedJobArgs in headlessExec.ts), and its check lets that one server be on.
// The kept server is pinned to Termpolis's own registration (codexPinArgs, HOLD-A N1), and a run that
// would keep it is refused when a project config Codex loads names a server termpolis: Codex merges a
// server's table across layers, so a pin wins only for the keys it sets.
// Claude's linked job brings its own server file; agy's run home has no server, so an agy job that may
// not write runs without Termpolis's.
//
// The person's files are only ever read: config.toml for the server names. Nothing here writes outside
// the run's own temp folder, and the startup sweep removes only the run homes a crash left behind.

import { createHash } from 'crypto'
import { constants as fsConstants, promises as fsp, type BigIntStats } from 'fs'
import os from 'os'
import path from 'path'
import type { ServerEntry } from './agentMcpRegistry'
import { codexMcpServerNames, codexTopLevelString, codexTrustedProjects } from './codexConfigEdit'
import { CODEX_ISOLATE_MCP_ARGS, type SecondOpinionAgent } from './secondOpinion'

/** The marker Termpolis's MCP adapter and memory hook read as "this run is read-only". */
export const READ_ONLY_RUN_ENV = { TERMPOLIS_READ_ONLY_RUN: '1' } as const

/** Claude Code reads the person's own settings only: no project or local .claude/settings.json, whose
 *  hooks would run commands in the folder being read. The person's own hooks still run. Checked with
 *  Claude Code 2.1.331: without it, `claude -p` in a folder whose project settings have SessionStart
 *  and UserPromptSubmit hooks ran both; with it, neither. */
export const CLAUDE_ISOLATE_ARGS: readonly string[] = ['--setting-sources', 'user']

/** The placeholder transports an off-switch gives a server: Codex refuses to start when a server it
 *  knows only from `-c` has no transport, so every off-switch names one, which is never started. A
 *  server whose config gives it a `url` gets the placeholder URL, since a command next to a url is a
 *  config error to Codex; any other gets the placeholder command, as CODEX_ISOLATE_MCP_ARGS does. */
export const CODEX_MCP_OFF_COMMAND = 'termpolis-mcp-disabled'
export const CODEX_MCP_OFF_URL = 'http://127.0.0.1:9/termpolis-mcp-disabled'

/** Codex's documented config override that switches one MCP server off for one run (`-c` takes a
 *  dotted path; the value parses as TOML, else as a plain string), with its placeholder transport.
 *  Checked with codex-cli 0.164.0 and 0.171.0: `codex mcp list --json` lists each such server
 *  disabled, a url one included. The one place this override is spelled. */
export const CODEX_MCP_SERVER_OFF = (name: string, url = false): string[] => [
  '-c', `mcp_servers.${name}.enabled=false`,
  '-c', url ? `mcp_servers.${name}.url=${CODEX_MCP_OFF_URL}` : `mcp_servers.${name}.command=${CODEX_MCP_OFF_COMMAND}`,
]

/** Codex's connectors (the built-in codex_apps server) off: they are remote tools that can write, in a
 *  read-only run. An unknown `features.*` key is ignored by a Codex without the feature, where
 *  `--disable apps` would exit 1. */
export const CODEX_NO_CONNECTORS_ARGS: readonly string[] = ['-c', 'features.apps=false']

/** The settings agy reads from the run's own home: no command runs (agy checks a shell run as
 *  `unsandboxed(<cmd>)` as well as `command(...)`), no file is written or edited, no MCP tool is
 *  called, whatever the mode. A workspace's own allow rules don't override these (checked with agy
 *  1.5.15). */
export const AGY_READ_ONLY_SETTINGS = {
  permissions: { deny: ['command(*)', 'unsandboxed(*)', 'write_file(*)', 'edit_file(*)', 'mcp(*)'] },
} as const

/** The name prefix of a run's throwaway agy home in the OS temp folder. */
export const AGY_HOME_PREFIX = 'termpolis-agy-'

/** What every Lumopolis surface shows when an isolated run can't be set up. The reason goes to the log. */
export const ISOLATION_SETUP_FAILED = "Lumopolis couldn't set up a safe read-only run for your agent. Try again, or pick another agent in Settings."

/** A server or profile name that is safe as one segment of a `-c` dotted path or a file name. Anything
 *  else would need TOML quoting the override parser may read differently, so it fails the run instead. */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** A config.toml bigger than this is not read: no real one comes near it. */
export const MAX_CODEX_CONFIG_BYTES = 1024 * 1024

/** How long the MCP list check before a run may take. */
export const MCP_LIST_TIMEOUT_MS = 10_000
/** How long a passed check stands for the same folder and config: a labelling batch pays for one. */
export const MCP_LIST_PASS_MS = 60_000
/** What `agy mcp list` prints when it has no server (agy 1.5.15). Anything else fails the check. */
export const AGY_NO_MCP_SERVERS = 'No MCP servers configured.'

/** How a run is isolated. */
export interface IsolationOptions {
  /** Codex only: leave Termpolis's own MCP server to the run (a Linked machines job, which narrows it),
   *  pinned to this registration of it (agentMcpRegistry's termpolisServerEntry). */
  keepTermpolis?: ServerEntry
}

/** Why a run that keeps Termpolis's server can't start: what the person sees after EXEC_ISOLATION_FAILED. */
const KEEP_REFUSED = "can't keep Termpolis's MCP server for the run"

/** A variable name Codex reads as one bare key of a `-c` dotted path. */
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
/** What a TOML literal string can't hold: its quote, a line break or another control character. A value
 *  without them passes through as it is, a Windows path's backslashes included. */
const NOT_LITERAL = /['\u0000-\u001f\u007f]/

/** The `-c` overrides that pin Termpolis's server, for one run, to its registration: the command, the
 *  args and each variable, as TOML literal strings. Checked with codex-cli 0.164.0 (`codex mcp list --json`,
 *  a throwaway CODEX_HOME): each key set this way wins over the same key in a trusted project's
 *  .codex/config.toml, a whole args list included, while a key the pin doesn't set still merges in from
 *  the lower layers. Throws when a value can't be handed over unchanged. Pure. */
export function codexPinArgs(entry: ServerEntry): string[] {
  const env = Object.entries(entry.env ?? {})
  if ([entry.command, ...entry.args, ...env.map(([, v]) => v)].some((v) => NOT_LITERAL.test(v)) || env.some(([k]) => !BARE_KEY.test(k))) {
    throw new Error(`${KEEP_REFUSED}: its registration has a value Codex can't be handed as it is`)
  }
  const lit = (v: string): string => `'${v}'`
  return [
    '-c', `mcp_servers.termpolis.command=${lit(entry.command)}`,
    '-c', `mcp_servers.termpolis.args=[${entry.args.map(lit).join(',')}]`,
    ...env.flatMap(([k, v]) => ['-c', `mcp_servers.termpolis.env.${k}=${lit(v)}`]),
  ]
}

export interface IsolatedLaunch {
  /** Options for the agent's argv, placed with its other options (Codex and Claude). */
  args: string[]
  /** Set on top of the run's environment. */
  env: Record<string, string>
  /** Called once the run has settled, however it ended. Never throws. */
  dispose: () => Promise<void>
}

/** Runs one agent CLI command as the run itself would be spawned (same CLI, folder and environment),
 *  bounded by `timeoutMs`. Resolves with its stdout and exit code; may reject when it can't be run. */
export type McpListRun = (bin: string, args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<{ stdout: string; code: number }>

/** What a path is, not following a final symlink; null when nothing is there. */
export type EntryKind = 'file' | 'link' | 'other' | null

export interface IsolationIO {
  /** A file's text; null when it does not exist. Throws when it exists but can't be read. With
   *  `noFollow`, it must be a regular file, not a link, and the file opened must be the one checked. */
  readText: (p: string, opts?: { noFollow?: boolean }) => Promise<string | null>
  entryKind: (p: string) => Promise<EntryKind>
  /** A path's size and modification time, `absent` when nothing is there, `unreadable:<code>` when it
   *  can't be looked at. Follows links. Never throws. */
  stamp: (p: string) => Promise<string>
  realpath: (p: string) => Promise<string>
  /** Makes a new empty folder named from `prefix`, as fs.mkdtemp does. */
  mkdtemp: (prefix: string) => Promise<string>
  mkdir: (p: string) => Promise<void>
  writeFile: (p: string, text: string) => Promise<void>
  /** Removes a folder and everything in it, retrying while Windows still holds a file in it. */
  removeDir: (p: string) => Promise<void>
  tmpdir: () => string
  homedir: () => string
  /** The app's own environment, for CODEX_HOME. */
  env: Readonly<Record<string, string | undefined>>
  /** How folder names compare: case-insensitively on Windows. */
  platform: NodeJS.Platform
  now: () => number
}

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT'

/** Reads at most MAX_CODEX_CONFIG_BYTES; a missing file is null, anything else unreadable throws. With
 *  `noFollow` the path must be a regular file when looked at (lstat) and the opened handle must be that
 *  same file (dev and ino), so a swap for a link between the look and the open fails. O_NOFOLLOW is
 *  also asked for where the OS has it (Linux and macOS; elsewhere it is undefined, which `|` reads as 0). */
async function readTextCapped(p: string, opts: { noFollow?: boolean } = {}): Promise<string | null> {
  let checked: { dev: bigint; ino: bigint } | null = null
  if (opts.noFollow) {
    let l: BigIntStats
    try {
      l = await fsp.lstat(p, { bigint: true })
    } catch (e) {
      if (isMissing(e)) return null
      throw e
    }
    if (!l.isFile()) throw new Error(`${p} is not a regular file`)
    checked = { dev: l.dev, ino: l.ino }
  }
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(p, opts.noFollow ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW : 'r')
  } catch (e) {
    if (isMissing(e)) return null
    throw e
  }
  try {
    const st = await handle.stat({ bigint: true })
    if (!st.isFile()) throw new Error(`${p} is not a file`)
    if (checked && (st.dev !== checked.dev || st.ino !== checked.ino)) throw new Error(`${p} changed while it was opened`)
    if (st.size > BigInt(MAX_CODEX_CONFIG_BYTES)) throw new Error(`${p} is too big to read`)
    const buf = Buffer.alloc(Number(st.size) + 1)
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

async function entryKindOf(p: string): Promise<EntryKind> {
  try {
    const st = await fsp.lstat(p)
    return st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other'
  } catch (e) {
    if (isMissing(e)) return null
    throw e
  }
}

async function stampOf(p: string): Promise<string> {
  try {
    const st = await fsp.stat(p)
    return `${st.size}:${st.mtimeMs}`
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : `unreadable:${code}`
  }
}

/** fs.rm with retries: Windows can hold a file the agent just closed for a moment. */
export const removeDirRetrying = (p: string): Promise<void> => fsp.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })

export const defaultIsolationIO: IsolationIO = {
  readText: readTextCapped,
  entryKind: entryKindOf,
  stamp: stampOf,
  realpath: (p) => fsp.realpath(p),
  mkdtemp: (prefix) => fsp.mkdtemp(prefix),
  mkdir: async (p) => {
    await fsp.mkdir(p, { recursive: true })
  },
  writeFile: (p, text) => fsp.writeFile(p, text, 'utf8'),
  removeDir: removeDirRetrying,
  tmpdir: () => os.tmpdir(),
  homedir: () => os.homedir(),
  env: process.env,
  platform: process.platform,
  now: () => Date.now(),
}

const noop = async (): Promise<void> => undefined

const samePath = (a: string, b: string, platform: NodeJS.Platform): boolean => {
  const x = path.resolve(a)
  const y = path.resolve(b)
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** Whether `p` is `root` or inside it. */
const within = (root: string, p: string): boolean => {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** `dir` and each folder above it, nearest first. */
function folderChain(dir: string): string[] {
  const chain = [path.resolve(dir)]
  for (let up = path.dirname(chain[0]); up !== chain[chain.length - 1]; up = path.dirname(up)) chain.push(up)
  return chain
}

interface CodexServers {
  names: string[]
  url: string[]
  /** The first project config that names a server termpolis, if one does. */
  projectTermpolis?: string
  /** Every file read and its text, for the check's cache key. */
  read: Array<[string, string]>
  /** The stamp of each layer the parser doesn't read (codexLayerPaths), for the same key. */
  layers: Array<[string, string]>
}

/** Adds one config's servers. Throws when it can't be listed or names a server that can't be switched
 *  off safely: a run that can't switch every server off doesn't start. */
function addServers(found: CodexServers, file: string, text: string): void {
  found.read.push([file, text])
  const listed = orFail(file, codexMcpServerNames(text))
  for (const name of listed.names) {
    if (!SAFE_NAME.test(name)) throw new Error(`can't switch Codex's MCP server "${name}" off: ${file}`)
    if (!found.names.includes(name)) found.names.push(name)
  }
  for (const name of listed.url) if (!found.url.includes(name)) found.url.push(name)
}

/** A config parser's answer, or a throw naming the file when it couldn't read it. */
function orFail<T>(file: string, r: T | { error: string }): T {
  if (typeof r === 'object' && r !== null && 'error' in r) throw new Error(`can't switch Codex's MCP servers off: ${file}: ${r.error}`)
  return r as T
}

/** The project configs Codex loads for a run in `cwd`: `<dir>/.codex/config.toml` for each folder from
 *  the topmost trusted folder at or above `cwd` down to `cwd`, none when no such folder is trusted (a
 *  linked worktree's folder counts as trusted through its main repository, worktreeFolder). Each
 *  must be a regular file (never a symlink) that resolves inside that trusted folder, or the run fails:
 *  Codex would follow a link this can't vouch for. */
async function projectConfigs(cwd: string, trusted: string[], io: IsolationIO): Promise<string[]> {
  const chain = folderChain(cwd)
  let top = -1
  chain.forEach((dir, i) => {
    if (trusted.some((t) => samePath(t, dir, io.platform))) top = i
  })
  if (top < 0) return []
  const root = chain[top]
  const realRoot = await io.realpath(root)
  const files: string[] = []
  for (const dir of chain.slice(0, top + 1).reverse()) {
    const file = path.join(dir, '.codex', 'config.toml')
    const kind = await io.entryKind(file)
    if (kind === null) continue
    if (kind !== 'file') throw new Error(`can't switch Codex's MCP servers off: ${file} is not a regular file`)
    if (!within(realRoot, await io.realpath(file))) throw new Error(`can't switch Codex's MCP servers off: ${file} is outside ${root}`)
    files.push(file)
  }
  return files
}

/** The folder a `.git` file's `gitdir:` line names, resolved against the folder that holds the file;
 *  undefined when it names none. */
function gitFileDir(text: string, dir: string): string | undefined {
  const m = /^gitdir:[ \t]*(.*?)[ \t]*\r?$/m.exec(text)
  return m && m[1] !== '' ? path.resolve(dir, m[1]) : undefined
}

/** Whether `dir` is one of the trusted folders, as written or as each resolves on disk. */
async function isTrusted(dir: string, trusted: string[], io: IsolationIO): Promise<boolean> {
  const mine = [dir, await io.realpath(dir).catch(() => dir)]
  for (const t of trusted) {
    const theirs = [t, await io.realpath(t).catch(() => t)]
    if (theirs.some((a) => mine.some((b) => samePath(a, b, io.platform)))) return true
  }
  return false
}

/** For a run inside a linked git worktree, the worktree's folder when its main repository is trusted:
 *  codex-cli 0.164.0 trusts a worktree through its main repository and loads the worktree's own
 *  .codex/config.toml with only the main repository trusted. The nearest `.git` at or above `cwd`
 *  decides: a folder or a link is no linked worktree; a file's `gitdir:` names the git directory, whose
 *  `commondir` names the main repository's (the folder above it is the main repository), or which is
 *  the main repository's itself when it has none. That last case is also a repository whose git
 *  directory was moved with --separate-git-dir, which Codex does not trust through the folder above it:
 *  this then reads more than Codex does, which only switches more off. Each file read goes in
 *  `found.read`, so a change to one runs the check again. */
async function worktreeFolder(cwd: string, trusted: string[], io: IsolationIO, found: CodexServers): Promise<string | undefined> {
  for (const dir of folderChain(cwd)) {
    const dotGit = path.join(dir, '.git')
    const kind = await io.entryKind(dotGit)
    if (kind === null) continue
    const text = kind === 'file' ? await io.readText(dotGit, { noFollow: true }) : null
    if (text === null) return undefined
    found.read.push([dotGit, text])
    const gitdir = gitFileDir(text, dir)
    if (gitdir === undefined) return undefined
    const commonFile = path.join(gitdir, 'commondir')
    const common = await io.readText(commonFile)
    if (common !== null) found.read.push([commonFile, common])
    const main = path.dirname(common === null ? gitdir : path.resolve(gitdir, common.trim()))
    return (await isTrusted(main, trusted, io)) ? dir : undefined
  }
  return undefined
}

/** The config layers Codex can load that the parser doesn't read: the machine-wide config, enforced
 *  requirements and managed config (Codex names %ProgramData%\OpenAI\Codex on Windows, /etc/codex
 *  elsewhere, and macOS managed preferences), the legacy CODEX_HOME managed config and the installed
 *  plugins. Only their stamps go in the check's cache key, so a change to one runs the check again
 *  rather than reusing a pass. Cloud-managed config has no local file and is left to the check itself. */
export function codexLayerPaths(home: string, io: Pick<IsolationIO, 'platform' | 'env'>): string[] {
  const system = io.platform === 'win32'
    ? path.win32.join(io.env.ProgramData ?? io.env.PROGRAMDATA ?? 'C:\\ProgramData', 'OpenAI', 'Codex')
    : '/etc/codex'
  const join = io.platform === 'win32' ? path.win32.join : path.posix.join
  return [
    ...['config.toml', 'requirements.toml', 'managed_config.toml'].map((f) => join(system, f)),
    ...(io.platform === 'darwin' ? ['/Library/Managed Preferences/com.openai.codex.plist'] : []),
    path.join(home, 'managed_config.toml'),
    path.join(home, 'plugins'),
    path.join(home, 'plugins', 'cache'),
  ]
}

/** The MCP servers Codex would start for a run in `cwd`: the user config.toml (in the run's CODEX_HOME,
 *  else the app's, else ~/.codex), the `<profile>.config.toml` next to it that its top-level `profile`
 *  names, and the project configs of a trusted folder (projectConfigs). Throws when a file can't be read
 *  or listed. */
async function codexServers(cwd: string, runEnv: Readonly<Record<string, string>>, io: IsolationIO): Promise<CodexServers> {
  const home = runEnv.CODEX_HOME || io.env.CODEX_HOME || path.join(io.homedir(), '.codex')
  const found: CodexServers = { names: [], url: [], read: [], layers: [] }
  for (const p of codexLayerPaths(home, io)) found.layers.push([p, await io.stamp(p)])
  const userFile = path.join(home, 'config.toml')
  const user = await io.readText(userFile)
  if (user === null) return found
  addServers(found, userFile, user)
  const trusted = orFail(userFile, codexTrustedProjects(user))
  const profile = orFail(userFile, codexTopLevelString(user, 'profile'))
  if (profile !== undefined) {
    if (!SAFE_NAME.test(profile)) throw new Error(`can't switch Codex's MCP servers off: ${userFile}: profile "${profile}" can't be read`)
    const profileFile = path.join(home, `${profile}.config.toml`)
    const text = await io.readText(profileFile)
    if (text !== null) {
      addServers(found, profileFile, text)
      trusted.push(...orFail(profileFile, codexTrustedProjects(text)))
    }
  }
  const worktree = await worktreeFolder(cwd, trusted, io, found)
  if (worktree !== undefined) trusted.push(worktree)
  for (const file of await projectConfigs(cwd, trusted, io)) {
    const text = await io.readText(file, { noFollow: true })
    if (text === null) continue
    addServers(found, file, text)
    if (found.projectTermpolis === undefined && orFail(file, codexMcpServerNames(text)).names.includes('termpolis')) found.projectTermpolis = file
  }
  return found
}

/** Passed checks: the key's expiry. */
const passes = new Map<string, number>()

/** Forgets every passed check. Tests only. */
export function clearIsolationChecks(): void {
  passes.clear()
}

/** A plain object (not null, not an array). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The keys `codex mcp list --json` prints for a server and for a stdio transport (codex-cli 0.164.0). */
const LISTED_SERVER_KEYS: readonly string[] = ['name', 'enabled', 'disabled_reason', 'transport', 'startup_timeout_sec', 'tool_timeout_sec', 'auth_status']
const LISTED_STDIO_KEYS: readonly string[] = ['type', 'command', 'args', 'env', 'env_vars', 'cwd']

/** Null or not there. */
const absent = (v: unknown): boolean => v === null || v === undefined

/** A listed env that is exactly `kept`'s: the same variables with the same values, or none for none. */
function sameEnv(env: unknown, kept: Readonly<Record<string, string>> = {}): boolean {
  if (absent(env)) return Object.keys(kept).length === 0
  if (!isRecord(env)) return false
  const keys = Object.keys(env)
  return keys.length === Object.keys(kept).length && keys.every((k) => typeof env[k] === 'string' && env[k] === kept[k])
}

/** A listed server is exactly the kept registration: no key `codex mcp list` doesn't print for one, a stdio
 *  transport with only its own keys, its command, exactly its args, no folder of its own, exactly its
 *  variables and no variable passed through by name (env_vars). The pin sets each of these, and a config
 *  layer can only add to them (Codex merges a server's tables), so anything else means a layer this
 *  doesn't know about reached the server: the run must not start. */
function isKeptServer(s: Record<string, unknown>, kept: ServerEntry): boolean {
  const t = s.transport
  return Object.keys(s).every((k) => LISTED_SERVER_KEYS.includes(k)) &&
    isRecord(t) && Object.keys(t).every((k) => LISTED_STDIO_KEYS.includes(k)) &&
    t.type === 'stdio' && t.command === kept.command && absent(t.cwd) &&
    Array.isArray(t.args) && t.args.length === kept.args.length && t.args.every((a, i) => a === kept.args[i]) &&
    (absent(t.env_vars) || (Array.isArray(t.env_vars) && t.env_vars.length === 0)) &&
    sameEnv(t.env, kept.env)
}

/** `codex mcp list --json` output that lists every server off: a JSON array of objects, each with a
 *  string `name` and `enabled: false`, but for Termpolis's own when it is `kept`, which may be on as
 *  exactly that registration (isKeptServer). Any other shape fails. Pure. */
export function codexMcpListAllOff(stdout: string, kept?: ServerEntry): boolean {
  let listed: unknown
  try {
    listed = JSON.parse(stdout)
  } catch {
    return false
  }
  return Array.isArray(listed) && listed.every((s: unknown) =>
    isRecord(s) && typeof s.name === 'string' &&
    (s.enabled === false || (kept !== undefined && s.name === 'termpolis' && isKeptServer(s, kept))))
}

/** `agy mcp list` output that reports no server. Pure. */
export function agyMcpListEmpty(stdout: string): boolean {
  return stdout.trim() === AGY_NO_MCP_SERVERS
}

/** Runs the MCP list check unless the same one passed within MCP_LIST_PASS_MS. Throws unless it passes. */
async function checkMcpList(
  key: unknown[],
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
  passed: (stdout: string) => boolean,
  run: McpListRun,
  io: IsolationIO,
): Promise<void> {
  const id = createHash('sha256').update(JSON.stringify(key)).digest('hex')
  const now = io.now()
  if ((passes.get(id) ?? 0) > now) return
  const res = await run(bin, args, { ...opts, timeoutMs: MCP_LIST_TIMEOUT_MS })
  if (res.code !== 0 || !passed(res.stdout)) throw new Error(`${bin} ${args.slice(0, 2).join(' ')} did not show every MCP server off (exit ${res.code})`)
  for (const [k, until] of passes) if (until <= now) passes.delete(k)
  passes.set(id, now + MCP_LIST_PASS_MS)
}

/** What an isolated read-only run of `agent` in `cwd` adds to its launch. `run` spawns the MCP list
 *  check as the run itself is spawned. Throws when the isolation can't be set up or proved; the run
 *  must then not start. */
export async function prepareIsolatedLaunch(
  agent: SecondOpinionAgent,
  cwd: string,
  runEnv: Readonly<Record<string, string>>,
  run: McpListRun,
  io: IsolationIO = defaultIsolationIO,
  opts: IsolationOptions = {},
): Promise<IsolatedLaunch> {
  if (agent === 'codex') {
    const found = await codexServers(cwd, runEnv, io)
    const kept = opts.keepTermpolis
    // The repository's author writes its project configs, and a key the pin doesn't set (a variable, a
    // folder) would still reach the kept server from one: such a run doesn't start.
    if (kept !== undefined && found.projectTermpolis !== undefined) {
      throw new Error(`${KEEP_REFUSED}: ${found.projectTermpolis} sets a server of its own named termpolis`)
    }
    // Termpolis's own server is switched off with its placeholder command too, as every isolated Codex
    // run already does, so it is off even when no config file names it; unless it is kept for the run,
    // pinned to its registration.
    const args = [
      ...found.names.filter((n) => n !== 'termpolis').flatMap((n) => CODEX_MCP_SERVER_OFF(n, found.url.includes(n))),
      ...(kept !== undefined ? codexPinArgs(kept) : CODEX_ISOLATE_MCP_ARGS),
      ...CODEX_NO_CONNECTORS_ARGS,
    ]
    const env = { ...runEnv, ...READ_ONLY_RUN_ENV }
    // `kept` adds nothing to the key that `args` doesn't (its pin args carry the whole registration); it
    // is there so the key says what was checked.
    await checkMcpList([agent, cwd, args, env, found.read, found.layers, kept ?? null], 'codex', ['mcp', 'list', '--json', ...args], { cwd, env },
      (stdout) => codexMcpListAllOff(stdout, kept), run, io)
    return { args, env: { ...READ_ONLY_RUN_ENV }, dispose: noop }
  }
  if (agent === 'gemini') {
    const home = await io.mkdtemp(path.join(io.tmpdir(), AGY_HOME_PREFIX))
    const dispose = async (): Promise<void> => {
      await io.removeDir(home).catch(() => undefined)
    }
    const env = { ...READ_ONLY_RUN_ENV, HOME: home, USERPROFILE: home }
    try {
      const dir = path.join(home, '.gemini', 'antigravity-cli')
      await io.mkdir(dir)
      await io.writeFile(path.join(dir, 'settings.json'), `${JSON.stringify(AGY_READ_ONLY_SETTINGS, null, 2)}\n`)
      // Keyed without the home, which is new for every run and empty but for the settings written here.
      await checkMcpList([agent, cwd, runEnv], 'agy', ['mcp', 'list'], { cwd, env: { ...runEnv, ...env } }, agyMcpListEmpty, run, io)
    } catch (e) {
      await dispose()
      throw e
    }
    return { args: [], env, dispose }
  }
  return { args: [...CLAUDE_ISOLATE_ARGS], env: { ...READ_ONLY_RUN_ENV }, dispose: noop }
}

export interface SweepIO {
  tmpdir: () => string
  readdir: (p: string) => Promise<string[]>
  /** Modification time of a real folder; null for anything else (a file, a link, nothing). */
  folderMtime: (p: string) => Promise<number | null>
  removeDir: (p: string) => Promise<void>
  now: () => number
}

const defaultSweepIO: SweepIO = {
  tmpdir: () => os.tmpdir(),
  readdir: (p) => fsp.readdir(p),
  folderMtime: async (p) => {
    const st = await fsp.lstat(p)
    return st.isDirectory() ? st.mtimeMs : null
  },
  removeDir: removeDirRetrying,
  now: () => Date.now(),
}

/** A folder fs.mkdtemp made from AGY_HOME_PREFIX. */
const AGY_HOME_NAME = new RegExp(`^${AGY_HOME_PREFIX}[A-Za-z0-9]{6}$`)

/** Removes the agy run homes in the OS temp folder last changed more than `olderThanMs` ago: what a run
 *  the app was quit or killed during left behind. A younger one may belong to a live run and stays.
 *  Resolves with how many went; never throws. */
export async function sweepStaleAgyHomes(olderThanMs: number, io: SweepIO = defaultSweepIO): Promise<number> {
  let removed = 0
  try {
    const dir = io.tmpdir()
    const cutoff = io.now() - olderThanMs
    for (const name of await io.readdir(dir)) {
      if (!AGY_HOME_NAME.test(name)) continue
      const p = path.join(dir, name)
      try {
        const mtime = await io.folderMtime(p)
        if (mtime === null || mtime > cutoff) continue
        await io.removeDir(p)
        removed++
      } catch {
        /* one folder that can't be checked or removed doesn't stop the others */
      }
    }
  } catch {
    /* an unreadable temp folder: nothing to sweep */
  }
  return removed
}
