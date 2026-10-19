// "Signed in now": asking an account's own CLI, on demand, which account its profile is signed in
// to. Termpolis reads only what the CLI prints; the CLI reads its own sign-in to answer, as it does
// at every start. Never on a timer: only when the user presses Check, after a sign-in, and when
// the chooser opens.
//
//   Claude Code  `claude auth status --json`   exit 0/1; for a claude.ai sign-in, email and plan
//   Codex        `codex login status`          exit 0/1, no email (its words go to stderr: "Not
//                                              logged in", "Logged in using ChatGPT"); then, signed in
//                                              only, `codex app-server` → initialize → account/read {}
//                                              for the email and plan
//
// Each CLI is spawned by its resolved path with no shell, in a clean env holding only what it
// needs to find itself plus the account's variable (deleted for the default profile: an empty
// CLAUDE_CONFIG_DIR would make Claude Code's config home relative to the working folder), in a
// folder of Termpolis's own, with a 15 s limit. On Windows `codex` is an npm shim (`codex.cmd`)
// that Node won't spawn without a shell, so the vendor `codex.exe` it runs is spawned instead;
// failing that, the shim goes through `cmd.exe /d /s /c` with fixed arguments only, which is safe
// because the profile path travels in the env, never on the command line.
//
// The app-server client reads only the replies to its own two requests, drops every notification
// unread, never logs what the server prints, and never sends a login, logout or refresh request
// (account/read is sent with no `refreshToken`).
import { spawn as nodeSpawn } from 'child_process'
import type { ChildProcess, SpawnOptions } from 'child_process'
import { dirname, extname, isAbsolute, join } from 'path'
import { PROFILE_VARIABLE, isPlainEmail } from '../shared/agentAccounts'
import type { AccountIdentity, ProfileAgent } from '../shared/agentAccounts'
import { accountFs } from './accountFs'
import type { AccountFs } from './accountFs'

export const CHECK_TIMEOUT_MS = 15_000

/** The oldest Codex whose app-server answers account/read as Termpolis reads it (0.153.4 was
 *  verified); the app-server is labelled experimental, so an older or unknown one isn't asked. */
const MIN_CODEX_APP_SERVER = [0, 153, 0] as const

export type Spawner = (file: string, args: readonly string[], opts: SpawnOptions) => ChildProcess

export interface CheckDeps {
  /** A folder of Termpolis's own to run the CLIs in. */
  cwd: string
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  arch?: string
  spawn?: Spawner
  fsx?: AccountFs
  timeoutMs?: number
}

export type CliPath = { kind: 'exe'; file: string } | { kind: 'shim'; file: string }

/** `name` on PATH as the shell finds it: on Windows each PATHEXT extension in each folder, in turn. */
export function findOnPath(name: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform, fsx: AccountFs = accountFs): string | null {
  const pathVar = env.PATH ?? env.Path ?? ''
  const sep = platform === 'win32' ? ';' : ':'
  const exts = platform === 'win32' ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  for (const dir of pathVar.replace(/"/g, '').split(sep)) {
    if (!dir || !isAbsolute(dir)) continue
    for (const ext of exts) {
      const file = join(dir, name + ext.toLowerCase())
      const s = fsx.stat(file)
      if (s && s.isFile()) return file
    }
  }
  return null
}

/** The codex.exe an npm `codex.cmd` shim runs: the platform package next to the main one, or
 *  hoisted beside it, as codex.js finds it. */
export function codexVendorExe(shim: string, arch: string, fsx: AccountFs = accountFs): string | null {
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const pkg = arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64'
  const root = join(dirname(shim), 'node_modules', '@openai')
  for (const base of [join(root, 'codex', 'node_modules', '@openai', pkg), join(root, pkg)]) {
    const exe = join(base, 'vendor', triple, 'bin', 'codex.exe')
    const s = fsx.stat(exe)
    if (s && s.isFile()) return exe
  }
  return null
}

export function resolveCli(agent: ProfileAgent, deps: Pick<CheckDeps, 'env' | 'platform' | 'arch' | 'fsx'> = {}): CliPath | null {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const fsx = deps.fsx ?? accountFs
  const found = findOnPath(agent, env, platform, fsx)
  if (!found) return null
  if (platform !== 'win32') return { kind: 'exe', file: found }
  const ext = extname(found).toLowerCase()
  if (ext === '.exe' || ext === '.com') return { kind: 'exe', file: found }
  if (agent === 'codex') {
    const exe = codexVendorExe(found, deps.arch ?? process.arch, fsx)
    if (exe) return { kind: 'exe', file: exe }
  }
  return { kind: 'shim', file: found }
}

/** Only what a CLI needs to find itself and its own sign-in. Never a key, a token or a proxy. */
const CHECK_ENV_KEYS: readonly string[] = [
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramFiles',
  'USERNAME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
]

export function checkEnv(agent: ProfileAgent, profile: string | null, base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of CHECK_ENV_KEYS) {
    const v = base[k]
    if (typeof v === 'string') env[k] = v
  }
  // A test run's scratch home stands in for the real one, so a CLI started by a test can never
  // reach the developer's own sign-ins.
  const testHome = base.TERMPOLIS_TEST_AGENT_HOME?.trim()
  if (testHome) {
    env.HOME = testHome
    env.USERPROFILE = testHome
  }
  env.NO_COLOR = '1'
  if (profile) env[PROFILE_VARIABLE[agent]] = profile
  else delete env[PROFILE_VARIABLE[agent]]
  return env
}

/** `cmd.exe /d /s /c "<shim> <args>"`, for a shim Node won't spawn without a shell. Only fixed,
 *  plain arguments; a shim path cmd would read specially is refused. */
function shimInvocation(shim: string, args: readonly string[], env: Record<string, string>): { file: string; args: string[] } | null {
  if (/["%!^&|<>]/.test(shim) || args.some((a) => !/^[A-Za-z0-9/_.-]+$/.test(a))) return null
  return { file: env.COMSPEC || env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `""${shim}" ${args.join(' ')}"`] }
}

interface RunResult {
  code: number | null
  stdout: string
  /** The first few KB of stderr, read only for a CLI's own status words, never logged or kept. */
  stderr: string
  timedOut: boolean
  error?: string
}

const MAX_STDOUT = 256 * 1024
const MAX_STDERR = 4 * 1024

function launch(cli: CliPath, args: readonly string[], env: Record<string, string>, deps: CheckDeps, stdin: boolean): ChildProcess | string {
  const spawn = deps.spawn ?? (nodeSpawn as unknown as Spawner)
  const platform = deps.platform ?? process.platform
  const opts: SpawnOptions = { cwd: deps.cwd, env, windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] }
  if (cli.kind === 'shim' && platform === 'win32') {
    const inv = shimInvocation(cli.file, args, env)
    if (!inv) return 'the CLI is installed in a folder Termpolis can\'t run it from safely'
    return spawn(inv.file, inv.args, { ...opts, windowsVerbatimArguments: true })
  }
  return spawn(cli.file, args, opts)
}

/** Run a CLI once and collect what it prints. */
export function runCli(cli: CliPath, args: readonly string[], env: Record<string, string>, deps: CheckDeps): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess | string
    try {
      child = launch(cli, args, env, deps, false)
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: (e as NodeJS.ErrnoException)?.code ?? 'could not start' })
      return
    }
    if (typeof child === 'string') {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: child })
      return
    }
    const proc = child
    let stdout = ''
    let stderr = ''
    let done = false
    let timedOut = false
    const finish = (r: RunResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { proc.kill() } catch { /* already gone */ }
      finish({ code: null, stdout, stderr, timedOut: true })
    }, deps.timeoutMs ?? CHECK_TIMEOUT_MS)
    proc.stdout?.on('data', (d: Buffer | string) => {
      if (stdout.length < MAX_STDOUT) stdout += d.toString()
    })
    proc.stderr?.on('data', (d: Buffer | string) => {
      if (stderr.length < MAX_STDERR) stderr = (stderr + d.toString()).slice(0, MAX_STDERR)
    })
    proc.on('error', (e: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, timedOut, error: e.code ?? 'could not start' }))
    proc.on('close', (code: number | null) => finish({ code, stdout, stderr, timedOut }))
  })
}

export type IdentityCheck = { identity: AccountIdentity } | { error: string }

function noCli(agent: ProfileAgent): { error: string } {
  return { error: `${agent === 'claude' ? 'Claude Code' : 'Codex'} isn't installed where Termpolis can find it (not on PATH)` }
}

/** The JSON object in `text`, or null. */
function jsonObjectIn(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    // A JSON text that starts with { and ends with } is an object, when it parses at all.
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** `claude auth status --json` for a profile (null: the default one). */
export async function claudeSignedInNow(profile: string | null, deps: CheckDeps): Promise<IdentityCheck> {
  const env = checkEnv('claude', profile, deps.env ?? process.env)
  const cli = resolveCli('claude', { ...deps, env: deps.env ?? process.env })
  if (!cli) return noCli('claude')
  const r = await runCli(cli, ['auth', 'status', '--json'], env, deps)
  if (r.error) return { error: `Claude Code couldn't be started (${r.error})` }
  if (r.timedOut) return { error: 'Claude Code took longer than 15 s to answer' }
  const json = jsonObjectIn(r.stdout)
  if (!json || typeof json.loggedIn !== 'boolean') return { error: 'Claude Code\'s answer couldn\'t be read' }
  const signedIn = json.loggedIn && r.code === 0
  const identity: AccountIdentity = {
    email: signedIn && isPlainEmail(json.email) ? json.email : null,
    signedIn,
    checkedAt: Date.now(),
    source: 'auth-status',
  }
  if (signedIn && typeof json.subscriptionType === 'string' && json.subscriptionType) identity.plan = json.subscriptionType
  return { identity }
}

function versionAtLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    if (v[i] !== min[i]) return v[i] > min[i]
  }
  return true
}

export type AccountRead = { email: string | null; plan?: string } | { error: string }

/** `codex app-server`: initialize, then account/read {}. Reads only the replies to those two. */
export function codexAccountRead(cli: CliPath, env: Record<string, string>, deps: CheckDeps): Promise<AccountRead> {
  return new Promise((resolve) => {
    let child: ChildProcess | string
    try {
      child = launch(cli, ['app-server'], env, deps, true)
    } catch {
      resolve({ error: 'Codex\'s app server couldn\'t be started' })
      return
    }
    if (typeof child === 'string') {
      resolve({ error: child })
      return
    }
    const proc = child
    let buf = ''
    let done = false
    const finish = (r: AccountRead): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { proc.kill() } catch { /* already gone */ }
      resolve(r)
    }
    const timer = setTimeout(() => finish({ error: 'Codex\'s app server took longer than 15 s to answer' }), deps.timeoutMs ?? CHECK_TIMEOUT_MS)
    const send = (msg: Record<string, unknown>): void => {
      try { proc.stdin?.write(JSON.stringify(msg) + '\n') } catch { finish({ error: 'Codex\'s app server stopped' }) }
    }
    const onReply = (msg: Record<string, unknown>): void => {
      if (msg.id === 1) {
        const result = msg.result as Record<string, unknown> | undefined
        const ua = typeof result?.userAgent === 'string' ? result.userAgent : ''
        const m = /\/(\d+)\.(\d+)\.(\d+)/.exec(ua)
        if (!m || !versionAtLeast([Number(m[1]), Number(m[2]), Number(m[3])], MIN_CODEX_APP_SERVER)) {
          finish({ error: 'this Codex is too old, or too new to be sure of, for Termpolis to ask its app server' })
          return
        }
        send({ jsonrpc: '2.0', method: 'initialized' })
        send({ jsonrpc: '2.0', id: 2, method: 'account/read', params: {} })
      } else if (msg.id === 2) {
        const account = (msg.result as Record<string, unknown> | undefined)?.account
        if (msg.error || (account !== null && typeof account !== 'object')) {
          finish({ error: 'Codex\'s app server gave no account' })
          return
        }
        const a = account as Record<string, unknown> | null
        const out: { email: string | null; plan?: string } = { email: a && isPlainEmail(a.email) ? a.email : null }
        if (a && typeof a.planType === 'string' && a.planType) out.plan = a.planType
        finish(out)
      }
      // Anything else (notifications, other ids) is dropped unread.
    }
    proc.stdout?.on('data', (d: Buffer | string) => {
      buf += d.toString()
      if (buf.length > MAX_STDOUT) buf = buf.slice(-MAX_STDOUT)
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('{')) continue
        let msg: Record<string, unknown>
        try { msg = JSON.parse(line) } catch { continue }
        onReply(msg)
      }
    })
    proc.stderr?.on('data', () => { /* never read, never logged */ })
    proc.on('error', () => finish({ error: 'Codex\'s app server couldn\'t be started' }))
    proc.on('close', () => finish({ error: 'Codex\'s app server stopped before it answered' }))
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'termpolis', version: '1' } } })
  })
}

/** `codex login status` for a home (null: the default one), then, when it is signed in, the
 *  email and plan from Codex's app server. */
export async function codexSignedInNow(profile: string | null, deps: CheckDeps): Promise<IdentityCheck> {
  const env = checkEnv('codex', profile, deps.env ?? process.env)
  const cli = resolveCli('codex', { ...deps, env: deps.env ?? process.env })
  if (!cli) return noCli('codex')
  const r = await runCli(cli, ['login', 'status'], env, deps)
  if (r.error) return { error: `Codex couldn't be started (${r.error})` }
  if (r.timedOut) return { error: 'Codex took longer than 15 s to answer' }
  // Only the status line's opening words are looked at: an API-key sign-in prints a masked key
  // after them, which is never kept.
  const said = `${r.stdout}\n${r.stderr}`
  const signedIn = r.code === 0 && /^Logged in using\b/m.test(said)
  if (!signedIn) {
    if (!/^Not logged in\b/m.test(said)) return { error: 'Codex\'s answer couldn\'t be read' }
    return { identity: { email: null, signedIn: false, checkedAt: Date.now(), source: 'login-status' } }
  }
  const read = await codexAccountRead(cli, env, deps)
  if ('error' in read) return { identity: { email: null, signedIn: true, checkedAt: Date.now(), source: 'login-status' } }
  const identity: AccountIdentity = { email: read.email, signedIn: true, checkedAt: Date.now(), source: 'account-read' }
  if (read.plan) identity.plan = read.plan
  return { identity }
}
