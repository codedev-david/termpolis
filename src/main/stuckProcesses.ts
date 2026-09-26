/**
 * Stuck-process finder — the engine behind Settings ▸ Processes.
 *
 * Three kinds of leftovers slow a dev box down, and none of them announce themselves:
 *   1. HEADLESS AI AGENTS (`claude -p`, `codex exec`, `gemini -p`) that outlived whatever
 *      launched them: a scheduled job, a git hook, a swarm run that crashed.
 *   2. GIT that is frozen, orphaned or has been running for half an hour. The frozen kind is
 *      the common one on Windows: MSYS starts every child CREATE_SUSPENDED and resumes it a
 *      moment later, so a parent that dies inside that window leaves the child suspended
 *      forever. A status line that runs git on every render leaks a few of those a day.
 *   3. The SHELLS, wrappers and tools those left behind (`bash -c`, `timeout`, `jq`, `tail`).
 *
 * Scanning is ON DEMAND only — when the tab opens or the user clicks Refresh, never on a
 * timer. A background netstat poll was one of the signals behind the Defender false positive.
 *
 * Nothing is killed on the renderer's say-so. A kill takes a FRESH scan and re-checks every
 * target by pid AND creation time, so a pid that exited and was handed to something else
 * since the list was drawn is skipped, not killed ("Kill all stuck" also skips anything that
 * stopped being stuck). This process, its ancestors and its direct children (renderer, GPU,
 * terminal shells) are never listed and never killed.
 *
 * "Stuck" is deliberately narrower than "listed": a row is only stuck when it is frozen, or
 * orphaned and serving no port, because those are the rows "Kill all stuck" ends in bulk.
 * Everything else is shown so the user can decide.
 */
import * as path from 'path'
import { homedir } from 'os'
import { execCaptureOffThread, type ProcOutcome } from './procClient'
import type { ProcOptions } from './procHost'
import { redactSecrets } from '../shared/appLog'

export type StuckCategory = 'agent' | 'git' | 'leftover'
export type StuckAgent = 'claude' | 'codex' | 'gemini'
export type StuckReason = 'headless' | 'orphaned' | 'suspended' | 'long-running'
export type StuckOwner = 'termpolis' | 'external' | 'orphaned'

/** One OS process, normalised across platforms. */
export interface ProcRecord {
  pid: number
  ppid: number
  /** Lower-case basename, no `.exe`. */
  name: string
  /** Full command line; '' when the OS would not say (an elevated or another user's process). */
  cmd: string
  /** Creation time, epoch ms. 0 = unknown. */
  created: number
  cpuSec: number
  memBytes: number
  /** Windows: every thread suspended. POSIX: stopped (`T`). */
  suspended: boolean
  /** Windows session id or POSIX uid. Only processes in the app's own scope are ever listed. */
  scope?: number
}

export interface ProcSnapshot {
  procs: ProcRecord[]
  /** pid → listening TCP ports. null when the port table could not be read. */
  listening: Map<number, number[]> | null
  takenAt: number
  platform: NodeJS.Platform
  warnings: string[]
  /**
   * Windows only: MSYS/Cygwin pid → the Windows pid of its live POSIX parent, or 0 when Cygwin
   * says it has none. Only asked for processes whose Windows parent is gone (see findMsysParents).
   */
  msysParents?: Map<number, number>
}

export interface StuckProcess {
  pid: number
  created: number
  name: string
  category: StuckCategory
  agent?: StuckAgent
  /** A leftover MCP server (only set on leftover rows; an agent row is already an agent). */
  mcp?: boolean
  reasons: StuckReason[]
  owner: StuckOwner
  parentName?: string
  /** Frozen, or orphaned and serving nothing: what "Kill all stuck" ends. */
  stuck: boolean
  /** Listening TCP ports across the whole tree. */
  serving: number[]
  ageMs: number
  cpuSec: number
  memBytes: number
  command: string
  /** The member that made the row interesting, when it is not the root. */
  detail?: string
  /** The root plus every descendant that would be ended with it. */
  treeSize: number
}

/** A row plus its members in kill order (root first). Main-side only. */
export type StuckRow = StuckProcess & { tree: number[] }

export interface StuckClassification {
  rows: StuckRow[]
  protectedPids: Set<number>
  created: Map<number, number>
  children: Map<number, number[]>
  selfPid: number
  warnings: string[]
}

export interface StuckScan {
  processes: StuckProcess[]
  scannedAt: number
  platform: NodeJS.Platform
  totalProcesses: number
  warnings: string[]
}

export interface StuckKillTarget {
  pid: number
  created: number
}

export interface StuckKillResult {
  killed: number[]
  failed: { pid: number; error: string }[]
  skipped: { pid: number; reason: string }[]
}

export type StuckRunner = (bin: string, args: string[], opts?: ProcOptions) => Promise<ProcOutcome>

export interface StuckScanDeps {
  runner?: StuckRunner
  platform?: NodeJS.Platform
  selfPid?: number
  now?: () => number
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

export interface StuckKillDeps {
  classify?: () => Promise<StuckClassification>
  kill?: (pid: number, signal?: NodeJS.Signals) => void
  alive?: (pid: number) => boolean
  wait?: (ms: number) => Promise<void>
  platform?: NodeJS.Platform
}

export interface StuckKillOptions {
  /** "Kill all stuck": also skip a target that is still listed but is no longer stuck. */
  stuckOnly?: boolean
}

const MINUTE_MS = 60_000
/** Younger orphans may just be a parent's normal exit racing its child's. */
const ORPHAN_MIN_AGE_MS = 5 * MINUTE_MS
/** Frozen for a whole minute is not a scheduling blip. */
const SUSPENDED_MIN_AGE_MS = MINUTE_MS
const GIT_LONG_RUNNING_MS = 30 * MINUTE_MS
/** An orphaned headless agent may be a deliberate `nohup` job that is still working. */
const AGENT_ORPHAN_STUCK_MS = 60 * MINUTE_MS
/** Windows hands out a dead parent's pid again, so a "parent" younger than its child is not one. */
const CREATED_TOLERANCE_MS = 2_000
/** POSIX start times come from whole-second `etime` plus scan latency, so two scans disagree more. */
const POSIX_KILL_TOLERANCE_MS = 5_000
const KILL_GRACE_MS = 3_000
const KILL_POLL_MS = 250
const MAX_KILL_TARGETS = 1_000
const MAX_COMMAND_CHARS = 1_000
/** Longest command line read from the OS, so masking and matching stay cheap however long one gets. */
const MAX_CMDLINE_CHARS = 4_000
const SCAN_OPTS: ProcOptions = { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }

const GIT_NAMES = new Set([
  'git', 'git-remote-https', 'git-remote-http', 'git-lfs', 'git-credential-manager',
  'git-credential-manager-core', 'git-upload-pack', 'git-receive-pack',
])
/** Long-lived by design: listing them as "long-running" would be noise. */
const GIT_DAEMON_SUBCOMMANDS = new Set(['fsmonitor--daemon', 'credential-cache--daemon', 'daemon'])
const GIT_VALUE_FLAGS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])
const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'fish', 'ksh'])
const SHELL_VALUE_FLAGS = new Set(['-o', '-O', '+o', '+O', '--rcfile', '--init-file'])
/** The glue a hook or an agent's Bash tool leaves behind. Never interactive programs like ssh. */
const TOOLS = new Set([
  'nohup', 'timeout', 'env', 'xargs', 'watch', 'sleep', 'tail', 'head', 'cat', 'tee', 'grep', 'egrep',
  'fgrep', 'rg', 'sed', 'awk', 'gawk', 'tr', 'wc', 'cut', 'sort', 'uniq', 'find', 'date', 'jq', 'yq',
  'gh', 'curl', 'wget',
])
const RUNTIMES = new Set(['node', 'bun', 'deno', 'npx', 'npm', 'pnpm', 'yarn', 'uv', 'uvx'])
const PYTHON_RE = /^python(\d+(\.\d+)*)?w?$/
const PTY_HOSTS = new Set(['openconsole', 'winpty-agent'])
/** A tree with one of these in it is waiting on a person, not stuck. */
const INTERACTIVE_CHILDREN = new Set([
  'less', 'more', 'most', 'vim', 'vi', 'nvim', 'nano', 'emacs', 'code', 'code-insiders', 'cursor',
  'windsurf', 'subl', 'sublime_text', 'notepad', 'notepad++',
])
/** A POSIX process re-parented to one of these has lost the parent that started it. */
const POSIX_ADOPTERS = new Set(['systemd', 'launchd', 'init'])
const WRAPPER_NAMES = new Set(['cmd', 'powershell', 'pwsh'])
const MCP_RE = /(?:^|[\\/\s@._-])mcp(?:[\\/\s@._-]|$)|modelcontextprotocol/i
const CODEX_NATIVE_RE = /^codex-(x86_64|aarch64|arm64|i686)-/
const AGENT_PACKAGES: readonly [string, StuckAgent][] = [
  ['@anthropic-ai/claude-code', 'claude'],
  ['@openai/codex', 'codex'],
  ['@google/gemini-cli', 'gemini'],
]
const CLAUDE_HEADLESS = new Set(['-p', '--print', '--output-format', '--input-format'])
const GEMINI_HEADLESS = new Set(['-p', '--prompt', '--experimental-acp', '--acp'])
const CODEX_HEADLESS = new Set(['exec', 'e', 'app-server', 'proto', 'mcp-server'])
const CODEX_VALUE_FLAGS = new Set([
  '-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval',
  '-C', '--cd', '-i', '--image', '--enable', '--disable', '--local-provider',
])
const NODE_INLINE_FLAGS = new Set(['-e', '--eval', '-p', '--print'])
const NODE_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--title'])
const PS_COMMAND_ALIASES = new Set(['c', 'f', 'e', 'ec', 'enc'])
const PS_COMMAND_FLAGS = ['command', 'file', 'encodedcommand']
const PS_VALUE_ALIASES = new Set(['ep', 'ex', 'w', 'win', 'v', 'if', 'inp', 'in', 'of', 'o', 'out', 'config', 'wd', 'settings', 'ea'])
const PS_VALUE_FLAGS = [
  'executionpolicy', 'windowstyle', 'version', 'inputformat', 'outputformat', 'psconsolefile',
  'configurationname', 'workingdirectory', 'settingsfile', 'custompipename', 'encodedarguments',
]

/** Split a command line the way CreateProcess would, closely enough to find flags. */
export function tokenizeCommand(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  let has = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '\\' && cmd[i + 1] === '"') {
      cur += '"'
      i++
      has = true
      continue
    }
    if (ch === '"') {
      inQuote = !inQuote
      has = true
      continue
    }
    if (!inQuote && /\s/.test(ch)) {
      if (has) {
        out.push(cur)
        cur = ''
        has = false
      }
      continue
    }
    cur += ch
    has = true
  }
  if (has) out.push(cur)
  return out
}

/** The first argument that is not a flag, skipping the values of flags that take one. */
function firstPositional(args: string[], valueFlags: ReadonlySet<string>): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('-')) return a
    if (valueFlags.has(a)) i++
  }
  return undefined
}

function stem(token: string): string {
  const base = token.replace(/\\/g, '/').split('/').pop() as string
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|cjs|mjs)$/, '')
}

function isGitDaemon(name: string, args: string[]): boolean {
  if (name !== 'git') return false
  const sub = firstPositional(args, GIT_VALUE_FLAGS)
  if (sub === undefined) return false
  if (GIT_DAEMON_SUBCOMMANDS.has(sub)) return true
  return sub === 'cat-file' && args.some((a) => a.startsWith('--batch'))
}

/** True when a shell is running a command or a script rather than waiting for a person. */
function shellRunsScript(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') return i + 1 < args.length
    if (a === '--command' || a.startsWith('--command=')) return true
    if (SHELL_VALUE_FLAGS.has(a)) {
      i++
      continue
    }
    if (a.startsWith('--')) continue
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a.includes('i')) return false
      if (a.includes('c')) return true
      continue
    }
    return true
  }
  return false
}

/** cmd /c and PowerShell -Command / -File run one thing and exit; /k and -NoExit stay open. */
function wrapperRunsCommand(name: string, args: string[]): boolean {
  if (name === 'cmd') {
    for (const a of args) {
      if (!a.startsWith('/')) return false
      const s = a.toLowerCase()
      if (s.startsWith('/c') || s.startsWith('/r')) return true
      if (s.startsWith('/k')) return false
    }
    return false
  }
  let noExit = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    // A bare argument is the command (5.1) or the script (7): either way it runs and exits.
    if (!/^[-/]/.test(a)) return !noExit
    const f = a.replace(/^(--|-|\/)/, '').toLowerCase()
    if (f.length >= 3 && 'noexit'.startsWith(f)) {
      noExit = true
      continue
    }
    if (PS_COMMAND_ALIASES.has(f) || (f.length >= 3 && PS_COMMAND_FLAGS.some((l) => l.startsWith(f)))) return !noExit
    if (PS_VALUE_ALIASES.has(f) || (f.length >= 3 && PS_VALUE_FLAGS.some((l) => l.startsWith(f)))) i++
  }
  return false
}

function agentByName(name: string): StuckAgent | null {
  if (name === 'claude') return 'claude'
  if (name === 'gemini' || name === 'agy') return 'gemini'
  if (name === 'codex' || CODEX_NATIVE_RE.test(name)) return 'codex'
  return null
}

/** Index of the script a runtime was started with, or -1 for inline code / no script. */
function runtimeScriptIndex(tokens: string[]): number {
  for (let i = 1; i < tokens.length; i++) {
    const a = tokens[i]
    if (a === '--') return i + 1 < tokens.length ? i + 1 : -1
    if (!a.startsWith('-')) return i
    if (NODE_INLINE_FLAGS.has(a) || a.startsWith('--eval=') || a.startsWith('--print=')) return -1
    if (NODE_VALUE_FLAGS.has(a)) i++
  }
  return -1
}

/** Which agent CLI a process is, and the arguments it was given. */
function detectAgent(name: string, tokens: string[], runtime: boolean): { kind: StuckAgent; args: string[] } | null {
  const byName = agentByName(name)
  if (byName) return { kind: byName, args: tokens.slice(1) }
  if (!runtime) return null
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i].replace(/\\/g, '/').toLowerCase()
    for (const [pkg, kind] of AGENT_PACKAGES) if (t.includes(pkg)) return { kind, args: tokens.slice(i + 1) }
  }
  const script = runtimeScriptIndex(tokens)
  if (script < 0) return null
  const kind = agentByName(stem(tokens[script]))
  return kind ? { kind, args: tokens.slice(script + 1) } : null
}

function isHeadless(kind: StuckAgent, args: string[]): boolean {
  if (kind === 'codex') {
    const sub = firstPositional(args, CODEX_VALUE_FLAGS)
    return sub !== undefined && CODEX_HEADLESS.has(sub)
  }
  if (kind === 'claude') {
    return args.some(
      (a, i) => CLAUDE_HEADLESS.has(a) || /^--(output|input)-format=/.test(a) || (a === 'mcp' && args[i + 1] === 'serve'),
    )
  }
  return args.some((a) => GEMINI_HEADLESS.has(a) || a.startsWith('--prompt='))
}

interface ProcInfo {
  /** A git-family process with a known command line that is not a daemon. */
  git: boolean
  shellish: boolean
  wrapper: boolean
  runtime: boolean
  headless: StuckAgent | null
  mcp: boolean
  ownHelper: boolean
  pty: boolean
  interactive: boolean
  /** An agent CLI that is not headless: someone is using it in a terminal. */
  interactiveAgent: boolean
}

function analyze(p: ProcRecord, platform: NodeJS.Platform, selfName: string): ProcInfo {
  const tokens = tokenizeCommand(p.cmd)
  const args = tokens.slice(1)
  const name = p.name
  const runtime = RUNTIMES.has(name) || PYTHON_RE.test(name) || name.startsWith('npm ')
  const agent = detectAgent(name, tokens, runtime)
  const headless = agent && isHeadless(agent.kind, agent.args) ? agent.kind : null
  return {
    // Unknown command line = unknown subcommand: never assume a daemon is a stuck git.
    git: GIT_NAMES.has(name) && p.cmd !== '' && !isGitDaemon(name, args),
    shellish: (SHELLS.has(name) && shellRunsScript(args)) || TOOLS.has(name),
    wrapper: WRAPPER_NAMES.has(name) && wrapperRunsCommand(name, args),
    runtime,
    headless,
    // An agent started with --mcp-config is a client of MCP servers, not one itself.
    mcp: agent === null && ((runtime && MCP_RE.test(p.cmd)) || MCP_RE.test(name)),
    // Electron helpers carry --type=; the main process never does.
    ownHelper: (name === selfName || name.startsWith(`${selfName} helper`)) && p.cmd.includes('--type='),
    pty: platform === 'win32' && PTY_HOSTS.has(name),
    interactive: INTERACTIVE_CHILDREN.has(name),
    interactiveAgent: agent !== null && headless === null,
  }
}

/**
 * One shell word from `i`: '…' is literal, "…" honours \-escapes, and unquoted space or an
 * operator ends it. `end` is where the word stopped (the input's length if a quote never closed).
 */
function readShellWord(s: string, i: number): { word: string; end: number } {
  let out = ''
  while (i < s.length && !/[\s;&|<>()]/.test(s[i])) {
    const ch = s[i]
    if (ch === "'") {
      const close = s.indexOf("'", i + 1)
      if (close < 0) return { word: out + s.slice(i + 1), end: s.length }
      out += s.slice(i + 1, close)
      i = close + 1
    } else if (ch === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '\\' && '"\\$`'.includes(s[i + 1])) i++
        out += s[i]
      }
      i++
    } else {
      if (ch === '\\') i++
      out += s.charAt(i)
      i++
    }
  }
  return { word: out, end: i }
}

/** What follows the command in the harness: an optional stdin redirect, then `&& pwd -P`. */
const EVAL_HARNESS_TAIL_RE = /^\s*(?:\\?<\s*\/dev\/null\s*)?&&\s*pwd\s+-P\b/

/**
 * Claude's Bash tool runs `bash -c "… && eval '<the command>' < /dev/null && pwd -P …"`: show
 * the command, not the harness. Only an eval followed by that `&& pwd -P` tail is unwrapped —
 * `rm -rf ~/work; eval 'echo hi'` or `node --eval "…"` must be shown whole. On Windows the
 * script is one argument whose inner double quotes arrive as \", so those are unescaped first.
 */
function unwrapEval(cmd: string): string {
  const s = cmd.replace(/\\"/g, '"')
  const re = /\beval\s+(?=['"])/g
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const { word, end } = readShellWord(s, re.lastIndex)
    if (word.trim() && EVAL_HARNESS_TAIL_RE.test(s.slice(end))) return word
  }
  return cmd
}

/**
 * One shell value: a \"…\" (a quoted value inside a quoted Windows argument), "…", '…' or an
 * unquoted run. A quote that never closes runs to the end, because the scanner cuts long
 * command lines and half a secret is still a secret.
 */
const VALUE = /(?:\\"(?:[^"\\]|\\(?!"))*(?:\\"|$)|"(?:[^"\\]|\\.)*(?:"|$)|'[^']*(?:'|$)|[^\s;&|<>()"'`]+)/.source

/** Names that say they hold a secret. TOKEN must end a word so TOKENIZERS_PARALLELISM is left alone. */
const SECRET_NAME =
  '[A-Za-z0-9_]*(?:TOKEN(?![A-Za-z])|SECRET|PASSWORD|PASSWD|PASSPHRASE|SSHPASS|API_?KEY|CREDENTIAL|PRIVATE)[A-Za-z0-9_]*' +
  // AUTH and PASS only as a whole segment (GIT_AUTH, DB_PASS — not OAUTH_DONE or BYPASS_CACHE),
  // PWD and KEY only after a prefix (MYSQL_PWD, AWS_ACCESS_KEY — not the shell's own PWD).
  '|(?:[A-Za-z0-9]+_)*(?:AUTH|PASS)(?:_[A-Za-z0-9]+)*' +
  '|(?:[A-Za-z0-9]+_)+(?:PWD|KEY)(?:_[A-Za-z0-9]+)*'

/** `mysql -pSECRET` (attached only: `mysql -p db` prompts), `sshpass -p`, `docker login -p`, `redis-cli -a`, `curl -b`. */
const SHORT_FLAG_RES: readonly RegExp[] = [
  /(\b(?:mysql|mysqldump|mariadb|mariadb-dump|mysqladmin|mysqlimport|mysqlcheck)(?:\.exe)?\b[^;&|]*?\s-p)(?!\s)/,
  /(\bsshpass(?:\.exe)?\b[^;&|]*?\s-p\s*)/,
  // Bounded gaps: two open-ended ones backtrack cubically on a long command line.
  /(\b(?:docker|podman|nerdctl)(?:\.exe)?\b[^;&|]{0,300}?\slogin\b[^;&|]{0,300}?\s-p\s*)/,
  /(\bredis-cli(?:\.exe)?\b[^;&|]*?\s-a\s*)/,
  /(\bcurl(?:\.exe)?\b[^;&|]*?\s-b(?:\s+|=)?)/,
].map((re) => new RegExp(re.source + VALUE, 'g'))

/** Tokens recognisable by shape alone, on top of the ones redactSecrets already knows. */
const TOKEN_SHAPES: readonly { re: RegExp; with: string }[] = [
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, with: '<redacted-token>' },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g, with: '<redacted-token>' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, with: '<redacted-token>' },
  { re: /\bnpm_[A-Za-z0-9]{36}/g, with: '<redacted-token>' },
  { re: /\bpypi-[A-Za-z0-9_-]{50,}/g, with: '<redacted-token>' },
  { re: /\bhf_[A-Za-z0-9]{30,}/g, with: '<redacted-token>' },
  { re: /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, with: '<redacted-token>' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, with: '<redacted-key>' },
  { re: /\bAKIA[0-9A-Z]{16}/g, with: '<redacted-key>' },
]

/**
 * What redactSecrets does not know about command lines: URL credentials, secret-named env
 * assignments and flags, per-tool password flags, auth headers and cookies, signed-URL query
 * parameters, webhook URLs, token shapes and JSON secret fields. Best effort — it masks the
 * common formats, and a secret in a format nobody names can still get through.
 */
function maskCommandSecrets(input: string): string {
  let s = input
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1$2:<redacted>@')
    // A long colon-less userinfo is a token used as the user name (https://<token>@host).
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9_-]{20,})@/gi, '$1<redacted>@')
    .replace(new RegExp(`(?<![\\w-])(${SECRET_NAME})=${VALUE}`, 'gi'), '$1=<redacted>')
    // --token, --api-key, --db-password … but not --max-tokens, --password-file or a valueless
    // --no-password followed by another flag.
    .replace(
      new RegExp(
        `(--(?:[a-z0-9_-]*[-_])?(?:token|password|passwd|passphrase|pass|secret|api-?key|api_key|key|cookie|credentials?)(?:=|\\s+))(?!-)${VALUE}`,
        'gi',
      ),
      '$1<redacted>',
    )
  for (const re of SHORT_FLAG_RES) s = s.replace(re, '$1<redacted>')
  s = s
    // curl -u / -U / --user / --proxy-user user:password — the user stays, the password goes.
    .replace(
      /((?:^|\s)(?:-u|-U|--user|--proxy-user)(?:\s+|=)?)(?:(\\?["'])([^:"'\s]+):[^"']*\2|([^\s:"']+):[^\s;&|<>()"'`]+)/g,
      (_m, flag: string, q: string | undefined, qUser: string, user: string) =>
        q ? `${flag}${q}${qUser}:<redacted>${q}` : `${flag}${user}:<redacted>`,
    )
    .replace(/(authorization:\s*(?:[A-Za-z][\w-]*\s+)?)[^\s"'\\]+/gi, '$1<redacted>')
    .replace(/((["'])\s*cookie:\s*)[^"'\\]+/gi, '$1<redacted>')
    .replace(/(\bcookie:\s*)[^\s"'\\;]+(?:;\s*[^\s"'\\;]+)*;?/gi, '$1<redacted>')
    .replace(new RegExp(`(\\baws(?:\\.exe)?\\s+configure\\s+set\\s+[\\w.-]*(?:secret|token|key)[\\w.-]*\\s+)${VALUE}`, 'gi'), '$1<redacted>')
    .replace(
      /([?&](?:key|sig|signature|access_token|token|api_key|apikey|client_secret|password|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|code)=)[^&\s"'#\\]+/gi,
      '$1<redacted>',
    )
    .replace(/(hooks\.slack\.com\/services\/)[^\s"'\\]+/gi, '$1<redacted>')
    .replace(/(discord(?:app)?\.com\/api\/webhooks\/)[^\s"'\\]+/gi, '$1<redacted>')
  for (const t of TOKEN_SHAPES) s = s.replace(t.re, t.with)
  // "password": "…" in inline JSON, including the \"…\" form inside a quoted Windows argument.
  return s.replace(
    /(\\?"[\w.-]*(?:token(?![a-z])|secret|passw(?:or)?d|pass(?![a-z])|pwd|auth(?![a-z])|authorization|api[-_]?key|key(?![a-z])|credential|private[-_]?key)[\w.-]*\\?"\s*:\s*\\?")(?:[^"\\]|\\(?!"))+(?=\\?")/gi,
    '$1<redacted>',
  )
}

function homePatterns(home: string): RegExp[] {
  const trimmed = home.replace(/[\\/]+$/, '')
  if (!trimmed) return []
  const variants = new Set([trimmed, trimmed.replace(/\\/g, '/')])
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(trimmed)
  if (drive) variants.add(`/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`)
  return [...variants]
    .sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(`${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\\\/\\s"']|$)`, 'gi'))
}

/**
 * At most MAX_CMDLINE_CHARS of a command line, without the word a cut there splits: half a secret
 * can be too short for any pattern to recognise, and it is still half a secret. The OS readers cut
 * at the same length, so a command line that long may already have lost its end.
 */
function capCommandLine(cmd: string): string {
  if (cmd.length < MAX_CMDLINE_CHARS) return cmd
  const cut = cmd.slice(0, MAX_CMDLINE_CHARS)
  return cut.slice(0, cut.search(/\s\S*$/) + 1)
}

/** A command line fit to show: the real command, secrets masked, home shortened to `~`, capped. */
export function displayCommand(cmd: string, homeDir = ''): string {
  // Mask first: redactSecrets stops a quoted value at its first space and would leave the rest.
  let s = redactSecrets(maskCommandSecrets(unwrapEval(capCommandLine(cmd))))
  for (const re of homePatterns(homeDir)) s = s.replace(re, '~')
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > MAX_COMMAND_CHARS ? `${s.slice(0, MAX_COMMAND_CHARS)}…` : s
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Parse the PowerShell scanner's JSON. It is sliced from the first `[` to the last `]`
 * because a UTF-8 console can prefix a BOM and a host can print a stray line around it.
 */
export function parseWindowsProcesses(stdout: string): ProcRecord[] {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('Could not list processes: PowerShell returned nothing')
  let rows: unknown[]
  try {
    rows = JSON.parse(stdout.slice(start, end + 1)) as unknown[]
  } catch {
    throw new Error('Could not list processes: PowerShell returned a list that could not be read')
  }
  const out: ProcRecord[] = []
  for (const e of rows) {
    if (!isRecord(e) || typeof e.i !== 'number' || !Number.isInteger(e.i) || e.i < 0) continue
    out.push({
      pid: e.i,
      ppid: num(e.p),
      name: (typeof e.n === 'string' ? e.n : '').toLowerCase().replace(/\.exe$/, ''),
      cmd: typeof e.c === 'string' ? e.c : '',
      created: Math.max(0, num(e.t)),
      cpuSec: num(e.u) / 1e7,
      memBytes: num(e.m),
      suspended: e.s === true,
      scope: num(e.x),
    })
  }
  return out
}

function addPort(map: Map<number, number[]>, pid: number, port: number): void {
  const list = map.get(pid)
  if (!list) map.set(pid, [port])
  else if (!list.includes(port)) list.push(port)
}

/** `netstat -ano`. Listeners are told apart by their foreign address, not the localised state word. */
export function parseNetstat(stdout: string): Map<number, number[]> {
  const map = new Map<number, number[]>()
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue
    if (cols[2] !== '0.0.0.0:0' && cols[2] !== '[::]:0') continue
    const port = /:(\d+)$/.exec(cols[1])
    const pid = Number(cols[cols.length - 1])
    if (!port || !Number.isInteger(pid) || pid <= 0) continue
    addPort(map, pid, Number(port[1]))
  }
  return map
}

/** `ss -ltnp`: every pid that holds the socket (a forked server shares it). */
export function parseSs(stdout: string): Map<number, number[]> {
  const map = new Map<number, number[]>()
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] !== 'LISTEN' || cols.length < 4) continue
    const port = /:(\d+)$/.exec(cols[3])
    if (!port) continue
    for (const m of line.matchAll(/pid=(\d+)/g)) addPort(map, Number(m[1]), Number(port[1]))
  }
  return map
}

/** `lsof -Fpn`: a `p<pid>` line, then one `n<addr>:<port>` line per socket. */
export function parseLsof(stdout: string): Map<number, number[]> {
  const map = new Map<number, number[]>()
  let pid = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || 0
    else if (line.startsWith('n') && pid > 0) {
      const port = /:(\d+)$/.exec(line)
      if (port) addPort(map, pid, Number(port[1]))
    }
  }
  return map
}

/** `[dd-][hh:]mm:ss[.cc]`, as both `etime` and `time` print it. Anything else reads as 0. */
export function parseClock(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s.trim())
  if (!m) return 0
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4])
}

const PS_STAT_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/
const PS_ARGS_RE = /^\s*(\d+)\s+(.*)$/

/** Join `ps -o pid,ppid,uid,stat,etime,time,rss,comm` with `ps -o pid,args`. Zombies are dropped. */
export function parsePosixProcesses(statOut: string, argsOut: string, takenAt: number, platform: NodeJS.Platform): ProcRecord[] {
  const argsByPid = new Map<number, string>()
  for (const line of argsOut.split(/\r?\n/)) {
    const m = PS_ARGS_RE.exec(line)
    if (m) argsByPid.set(Number(m[1]), m[2].trim().slice(0, MAX_CMDLINE_CHARS))
  }
  const out: ProcRecord[] = []
  for (const line of statOut.split(/\r?\n/)) {
    const m = PS_STAT_RE.exec(line)
    if (!m || m[4].startsWith('Z')) continue
    const pid = Number(m[1])
    const cmd = argsByPid.get(pid) ?? ''
    // macOS prints the executable's full path, and a login shell's argv0 starts with '-'.
    let name = path.posix.basename(m[8].trim()).toLowerCase().replace(/^-/, '')
    // Linux truncates comm to 15 characters: git-remote-https would read as git-remote-http.
    if (platform === 'linux' && name.length === 15) {
      const argv0 = path.posix.basename(tokenizeCommand(cmd)[0] ?? '').toLowerCase()
      if (argv0.startsWith(name)) name = argv0
    }
    out.push({
      pid,
      ppid: Number(m[2]),
      name,
      cmd,
      created: Math.max(0, takenAt - parseClock(m[5]) * 1000),
      cpuSec: parseClock(m[6]),
      memBytes: Number(m[7]) * 1024,
      suspended: /^[Tt]/.test(m[4]),
      scope: Number(m[3]),
    })
  }
  return out
}

/**
 * One pass over every process. `Get-Process` supplies the suspended flag (thread states are in
 * its snapshot and need no handle), CIM supplies everything else. Single line, no double quotes:
 * it is handed to powershell.exe as one argv element, and never as -EncodedCommand.
 */
const WINDOWS_SCAN_SCRIPT =
  "$ErrorActionPreference='SilentlyContinue'; try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}; " +
  '$s = @{}; foreach ($p in Get-Process) { $n = 0; $all = $true; foreach ($t in $p.Threads) { $n++; ' +
  "if ([string]$t.ThreadState -ne 'Wait' -or [string]$t.WaitReason -ne 'Suspended') { $all = $false; break } }; " +
  'if ($n -gt 0 -and $all) { $s[[string]$p.Id] = 1 } }; ' +
  "$e = [datetime]'1970-01-01'; " +
  '$r = foreach ($w in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize,SessionId) { ' +
  `$c = [string]$w.CommandLine; if ($c.Length -gt ${MAX_CMDLINE_CHARS}) { $c = $c.Substring(0, ${MAX_CMDLINE_CHARS}) }; ` +
  '$t = 0; if ($w.CreationDate) { $t = [long](($w.CreationDate.ToUniversalTime() - $e).TotalMilliseconds) }; ' +
  '[pscustomobject]@{ i = [int]$w.ProcessId; p = [int]$w.ParentProcessId; n = [string]$w.Name; c = $c; t = $t; ' +
  'u = [long]$w.UserModeTime + [long]$w.KernelModeTime; m = [long]$w.WorkingSetSize; x = [int]$w.SessionId; ' +
  's = [bool]$s.ContainsKey([string]$w.ProcessId) } }; ' +
  'ConvertTo-Json -InputObject @($r) -Compress'

const PORTS_UNKNOWN = 'Could not read which processes are listening on ports, so nothing was marked stuck.'

/** A runner that rejects (the proc host timed out) reads as a failed command, not a crash. */
async function run(runner: StuckRunner, bin: string, args: string[]): Promise<ProcOutcome> {
  try {
    return await runner(bin, args, SCAN_OPTS)
  } catch (e) {
    return { stdout: '', stderr: '', error: { message: e instanceof Error ? e.message : String(e) } }
  }
}

function failure(r: ProcOutcome): string {
  return r.stderr.trim() || (r.error as { message: string }).message
}

/** An MSYS2, Git Bash or Cygwin program: `<install>\usr\bin\x.exe`, or `<cygwin>\bin\x.exe`. */
const MSYS_IMAGE_RE = /^(.*[\\/](?:usr|cygwin(?:64)?)[\\/]bin)[\\/][^\\/]+$/i
/** Installs asked per scan. More than this on one box is unusual enough to warn instead. */
const MAX_MSYS_ROOTS = 3
/** A `ps -a` row: an optional status letter, then PID, PPID, PGID and WINPID. */
const MSYS_PS_RE = /^\s*[A-Za-z]?\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/
const MSYS_UNKNOWN = 'Could not confirm which Git Bash processes lost their parent, so none of those were marked orphaned.'

/** The bin directory of an MSYS/Cygwin program, from the first token of its command line. */
function msysBinDir(cmd: string): string | null {
  const m = MSYS_IMAGE_RE.exec(tokenizeCommand(cmd)[0] ?? '')
  return m ? path.win32.normalize(m[1]) : null
}

/**
 * The directory comes from another process's command line, which that process chose, so only
 * an install location gets its ps.exe run: Program Files, %LOCALAPPDATA% (a per-user Git lives
 * in its Programs folder), Scoop, or a usual MSYS2/Cygwin root. Never a folder a sandbox can
 * write: an AppContainer app keeps its storage under %LOCALAPPDATA%\Packages and, with a library
 * capability, writes Documents, Downloads and the like elsewhere in the profile; a low-integrity
 * one writes LocalLow and \Low\ folders. Temp is refused too, since anything can drop files there.
 */
function trustedMsysDir(dir: string, env: NodeJS.ProcessEnv): boolean {
  if (!/^[A-Za-z]:\\/.test(dir) || /\\(?:LocalLow|Low)(?:\\|$)/i.test(dir)) return false
  const drive = env.SystemDrive || 'C:'
  const profile = env.USERPROFILE || ''
  const local = env.LOCALAPPDATA || `${profile}\\AppData\\Local`
  const lower = `${dir.toLowerCase()}\\`
  const within = (r: string | undefined): boolean => {
    if (!r) return false
    const root = `${path.win32.normalize(r).replace(/\\+$/, '').toLowerCase()}\\`
    // A bare drive would trust everything on it.
    return /^[a-z]:\\[^\\]/.test(root) && lower.startsWith(root)
  }
  if (within(local)) return !within(`${local}\\Packages`) && !within(`${local}\\Temp`)
  return [
    env.ProgramFiles,
    env.ProgramW6432,
    env['ProgramFiles(x86)'],
    env.SCOOP || `${profile}\\scoop`,
    ...['msys64', 'msys32', 'cygwin64', 'cygwin', 'tools\\msys64'].map((d) => `${drive}\\${d}`),
  ].some(within)
}

/**
 * The parent `p` really has. Windows never re-parents and hands a dead parent's pid to the next
 * process, so there a "parent" created after its child is a stranger. POSIX re-parents on death.
 */
function liveParent(p: ProcRecord, byPid: Map<number, ProcRecord>, win: boolean): ProcRecord | undefined {
  const par = byPid.get(p.ppid)
  if (!par || par.pid === p.pid) return undefined
  if (win && p.created > 0 && par.created > p.created + CREATED_TOLERANCE_MS) return undefined
  return par
}

/**
 * `ps -a` from one MSYS/Cygwin install, as Windows pid → Windows pid of its POSIX parent. 0 means
 * it has none: PPID 1 is Cygwin's "started by a Windows program, or the parent exited".
 */
export function parseMsysPs(stdout: string): Map<number, number> {
  const rows: { ppid: number; win: number }[] = []
  const winOf = new Map<number, number>()
  for (const line of stdout.split(/\r?\n/)) {
    const m = MSYS_PS_RE.exec(line)
    if (!m) continue
    rows.push({ ppid: Number(m[2]), win: Number(m[4]) })
    winOf.set(Number(m[1]), Number(m[4]))
  }
  const out = new Map<number, number>()
  for (const { ppid, win } of rows) {
    const parent = ppid === 1 ? 0 : (winOf.get(ppid) ?? 0)
    if (parent !== win) out.set(win, parent)
  }
  return out
}

/**
 * MSYS emulates exec with a new Windows process, and when the new program is an MSYS one too
 * the old process exits: `sleep` in a live `bash -c` has a Windows parent that is gone while its
 * POSIX parent is running. Without this every stage of a running pipeline reads as an orphan and
 * "Kill all stuck" would end live work. The install's own ps.exe knows the POSIX parent, so it is
 * asked — once per install, only when one of its processes has lost its Windows parent, and
 * only for a trusted install. Anything it cannot answer is left unmarked, never guessed.
 */
async function findMsysParents(
  procs: ProcRecord[],
  runner: StuckRunner,
  env: NodeJS.ProcessEnv,
  selfPid: number,
  warnings: string[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const self = procs.find((p) => p.pid === selfPid)
  // Nothing is listed without it (classifyProcesses says so), so there is nothing to ask about.
  if (!self) return out
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const dirs = new Map<string, string>()
  let unresolved = false
  for (const p of procs) {
    if (p.scope !== self.scope || liveParent(p, byPid, true)) continue
    const dir = msysBinDir(p.cmd)
    if (!dir || dirs.has(dir.toLowerCase())) continue
    if (dirs.size >= MAX_MSYS_ROOTS || !trustedMsysDir(dir, env)) unresolved = true
    else dirs.set(dir.toLowerCase(), dir)
  }
  const results = await Promise.all([...dirs.values()].map((dir) => run(runner, path.win32.join(dir, 'ps.exe'), ['-a'])))
  for (const r of results) {
    if (r.error && !r.stdout.trim()) unresolved = true
    else for (const [pid, parent] of parseMsysPs(r.stdout)) out.set(pid, parent)
  }
  if (unresolved) warnings.push(MSYS_UNKNOWN)
  return out
}

export async function takeProcessSnapshot(deps: StuckScanDeps = {}): Promise<ProcSnapshot> {
  const runner = deps.runner ?? execCaptureOffThread
  const platform = deps.platform ?? process.platform
  const now = deps.now ?? Date.now
  const warnings: string[] = []

  if (platform === 'win32') {
    const env = deps.env ?? process.env
    const root = env.SystemRoot || env.windir || 'C:\\Windows'
    const ps = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const [list, net] = await Promise.all([
      run(runner, ps, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCAN_SCRIPT]).then((r) => ({ r, at: now() })),
      run(runner, path.win32.join(root, 'System32', 'NETSTAT.EXE'), ['-ano']),
    ])
    if (list.r.error && !list.r.stdout.includes('[')) throw new Error(`Could not list processes: ${failure(list.r)}`)
    let listening: Map<number, number[]> | null = null
    // A netstat that timed out or was killed printed only part of the table.
    if (net.error && (!net.stdout.trim() || net.error.killed || net.error.signal)) warnings.push(PORTS_UNKNOWN)
    else listening = parseNetstat(net.stdout)
    const procs = parseWindowsProcesses(list.r.stdout)
    const msysParents = await findMsysParents(procs, runner, env, deps.selfPid ?? process.pid, warnings)
    return { procs, listening, takenAt: list.at, platform, warnings, msysParents }
  }

  const psBin = platform === 'darwin' ? '/bin/ps' : 'ps'
  const [stat, args, ports] = await Promise.all([
    run(runner, psBin, ['-A', '-ww', '-o', 'pid=,ppid=,uid=,stat=,etime=,time=,rss=,comm=']).then((r) => ({ r, at: now() })),
    run(runner, psBin, ['-A', '-ww', '-o', 'pid=,args=']),
    platform === 'darwin'
      ? run(runner, '/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])
      : run(runner, 'ss', ['-ltnp']),
  ])
  if (stat.r.error && !stat.r.stdout.trim()) throw new Error(`Could not list processes: ${failure(stat.r)}`)
  // Without command lines nothing can be told apart (a git daemon from a stuck git), so refuse.
  if (args.error && !args.stdout.trim()) throw new Error(`Could not read command lines: ${failure(args)}`)
  let listening: Map<number, number[]> | null = null
  // lsof exits 1 when nothing is listening at all.
  if (ports.error && !(platform === 'darwin' && ports.error.code === 1)) warnings.push(PORTS_UNKNOWN)
  else listening = platform === 'darwin' ? parseLsof(ports.stdout) : parseSs(ports.stdout)
  return { procs: parsePosixProcesses(stat.r.stdout, args.stdout, stat.at, platform), listening, takenAt: stat.at, platform, warnings }
}

export function classifyProcesses(snap: ProcSnapshot, opts: { selfPid: number; homeDir?: string }): StuckClassification {
  const { procs, platform, takenAt: now } = snap
  const win = platform === 'win32'
  const homeDir = opts.homeDir ?? ''
  const byPid = new Map<number, ProcRecord>()
  const created = new Map<number, number>()
  for (const p of procs) {
    byPid.set(p.pid, p)
    created.set(p.pid, p.created)
  }
  // An MSYS program whose Windows parent (an exec stub) is gone hangs under its POSIX parent.
  const msysParents = snap.msysParents ?? new Map<number, number>()
  const validParent = (p: ProcRecord): ProcRecord | undefined => {
    const par = liveParent(p, byPid, win)
    if (par) return par
    const w = msysParents.get(p.pid)
    // 0 is "no parent" — and the System Idle process's pid, which must never be adopted.
    return w ? byPid.get(w) : undefined
  }
  const children = new Map<number, number[]>()
  for (const p of procs) {
    const par = validParent(p)
    if (!par) continue
    const list = children.get(par.pid)
    if (list) list.push(p.pid)
    else children.set(par.pid, [p.pid])
  }
  const warnings = [...snap.warnings]
  const self = byPid.get(opts.selfPid)
  if (!self) {
    warnings.push('Termpolis could not find itself in the process list, so nothing was flagged.')
    return { rows: [], protectedPids: new Set([opts.selfPid]), created, children, selfPid: opts.selfPid, warnings }
  }

  const infos = new Map<number, ProcInfo>()
  for (const p of procs) infos.set(p.pid, analyze(p, platform, self.name))
  const info = (pid: number): ProcInfo => infos.get(pid) as ProcInfo

  const protectedPids = new Set<number>([self.pid])
  for (let a = validParent(self); a && !protectedPids.has(a.pid); a = validParent(a)) protectedPids.add(a.pid)
  // The renderer, GPU and terminal shells — but a headless agent the app launched itself is fair game.
  for (const c of children.get(self.pid) ?? []) if (info(c).headless === null) protectedPids.add(c)

  const selfTree = new Set<number>()
  const walk = [self.pid]
  while (walk.length) {
    const pid = walk.pop() as number
    if (selfTree.has(pid)) continue
    selfTree.add(pid)
    walk.push(...(children.get(pid) ?? []))
  }

  const age = (p: ProcRecord): number => (p.created > 0 ? Math.max(0, now - p.created) : 0)
  const isOrphan = (p: ProcRecord): boolean => {
    const par = validParent(p)
    // An MSYS program is only orphaned when its own install confirmed it has no parent.
    if (!par) return !win || msysParents.get(p.pid) === 0 || msysBinDir(p.cmd) === null
    return !win && (p.ppid === 1 || POSIX_ADOPTERS.has(par.name))
  }
  const hasAncestor = (p: ProcRecord, test: (a: ProcRecord) => boolean): boolean => {
    const seen = new Set<number>([p.pid])
    for (let a = validParent(p); a && !seen.has(a.pid); a = validParent(a)) {
      if (test(a)) return true
      seen.add(a.pid)
    }
    return false
  }
  const covered = new Set<number>()
  const open = (p: ProcRecord): boolean =>
    !covered.has(p.pid) && !protectedPids.has(p.pid) && (self.scope === undefined || p.scope === self.scope)
  const treeOf = (root: number): number[] => {
    const tree: number[] = []
    const seen = new Set<number>()
    const queue = [root]
    for (let i = 0; i < queue.length; i++) {
      const pid = queue[i]
      if (seen.has(pid)) continue
      seen.add(pid)
      if (!open(byPid.get(pid) as ProcRecord)) continue
      tree.push(pid)
      queue.push(...(children.get(pid) ?? []))
    }
    return tree
  }
  const core = (i: ProcInfo): boolean => i.git || i.headless !== null || i.mcp || i.ownHelper || i.pty
  const frozen = (p: ProcRecord): boolean => p.suspended && age(p) >= SUSPENDED_MIN_AGE_MS
  // Someone is at the keyboard: a pager, an editor or an agent CLI in a terminal. A frozen one on
  // Windows is the MSYS race, not a person; a stopped one on POSIX is a Ctrl+Z they can resume.
  const attended = (pid: number): boolean => {
    const i = info(pid)
    return (i.interactive || i.interactiveAgent) && !(win && frozen(byPid.get(pid) as ProcRecord))
  }

  const rows: StuckRow[] = []
  const addRow = (root: ProcRecord, tree: number[]): void => {
    for (const pid of tree) covered.add(pid)
    const members = tree.map((pid) => byPid.get(pid) as ProcRecord)
    const mi = tree.map(info)
    const owner: StuckOwner = selfTree.has(root.pid) ? 'termpolis' : isOrphan(root) ? 'orphaned' : 'external'
    // The root's own state: a frozen member worth ending already got a row of its own.
    const rootFrozen = frozen(root)
    const headlessAt = mi.findIndex((x) => x.headless !== null)
    const gitAt = mi.findIndex((x) => x.git)
    const mcpAt = mi.findIndex((x) => x.mcp)
    const reasons: StuckReason[] = []
    if (headlessAt >= 0) reasons.push('headless')
    if (owner === 'orphaned') reasons.push('orphaned')
    if (rootFrozen) reasons.push('suspended')
    // A frozen git is not "running"; the suspended reason already says what is wrong with it.
    if (mi.some((x, k) => x.git && !members[k].suspended && age(members[k]) >= GIT_LONG_RUNNING_MS)) reasons.push('long-running')
    const category: StuckCategory = headlessAt >= 0 ? 'agent' : gitAt >= 0 ? 'git' : 'leftover'
    const definingAt = category === 'agent' ? headlessAt : category === 'git' ? gitAt : Math.max(mcpAt, 0)
    const listening = snap.listening
    const serving = listening
      ? [...new Set(members.flatMap((m) => listening.get(m.pid) ?? []))].sort((a, b) => a - b)
      : []
    const agentAge = headlessAt >= 0 ? age(members[headlessAt]) : 0
    const stuck =
      listening !== null &&
      serving.length === 0 &&
      !tree.some(attended) &&
      ((win && rootFrozen) || (owner === 'orphaned' && (category !== 'agent' || agentAge >= AGENT_ORPHAN_STUCK_MS)))
    const parent = validParent(root)
    const defining = members[definingAt]
    rows.push({
      pid: root.pid,
      created: root.created,
      name: root.name,
      category,
      ...(headlessAt >= 0 ? { agent: mi[headlessAt].headless as StuckAgent } : {}),
      ...(category === 'leftover' && mcpAt >= 0 ? { mcp: true } : {}),
      reasons,
      owner,
      ...(parent ? { parentName: parent.name } : {}),
      stuck,
      serving,
      ageMs: age(root),
      cpuSec: members.reduce((n, m) => n + m.cpuSec, 0),
      memBytes: members.reduce((n, m) => n + m.memBytes, 0),
      command: displayCommand(root.cmd || root.name, homeDir),
      ...(definingAt > 0 ? { detail: displayCommand(defining.cmd || defining.name, homeDir) } : {}),
      treeSize: tree.length,
      tree,
    })
  }

  // Oldest first, so an ancestor claims its descendants before they can become rows of their own.
  const sorted = [...procs].sort((a, b) => (a.created || Infinity) - (b.created || Infinity) || a.pid - b.pid)

  // 1. Frozen (Windows): the MSYS CREATE_SUSPENDED race. Stopped POSIX jobs are usually a Ctrl+Z.
  //    First, so a frozen process is a row of its own and never marks the tree around it stuck.
  if (win) {
    for (const p of sorted) {
      if (!frozen(p) || !open(p)) continue
      const i = info(p.pid)
      const parent = validParent(p)
      const scriptChild = !parent || WRAPPER_NAMES.has(parent.name) || SHELLS.has(parent.name)
      if (i.git || i.shellish || i.wrapper || i.headless !== null || (i.runtime && (i.mcp || scriptChild))) addRow(p, treeOf(p.pid))
    }
  }

  // 2. Orphans, rooted where the parent vanished, unless someone is still using the tree.
  for (const p of sorted) {
    if (!open(p) || age(p) < ORPHAN_MIN_AGE_MS || !isOrphan(p)) continue
    const i = info(p.pid)
    const tree = treeOf(p.pid)
    if (tree.some(attended)) continue
    const members = tree.map(info)
    // Windows never re-parents, so an orphaned shell or tool there is almost always junk (an MSYS
    // program that only looked orphaned was already re-linked to its POSIX parent). On POSIX
    // everything a closed terminal or a GUI launcher started is "orphaned" — only a tree that
    // holds git, an agent or an MCP server is worth showing.
    const eligible =
      core(i) ||
      (win
        ? i.shellish || (i.wrapper && members.some((m) => core(m) || m.shellish))
        : (i.shellish || i.wrapper) && members.some(core))
    if (eligible) addRow(p, tree)
  }

  // 3. Every other headless agent, alive or not — "what is running without a window?"
  for (const p of sorted) {
    if (!open(p) || info(p.pid).headless === null) continue
    if (hasAncestor(p, (a) => !protectedPids.has(a.pid) && info(a.pid).headless !== null)) continue
    addRow(p, treeOf(p.pid))
  }

  // 4. Git that has run for half an hour and is not waiting on a pager or an editor.
  for (const p of sorted) {
    if (!info(p.pid).git || !open(p) || age(p) < GIT_LONG_RUNNING_MS) continue
    if (hasAncestor(p, (a) => !protectedPids.has(a.pid) && info(a.pid).git)) continue
    const tree = treeOf(p.pid)
    if (tree.some(attended)) continue
    addRow(p, tree)
  }

  rows.sort((a, b) => Number(b.stuck) - Number(a.stuck) || b.ageMs - a.ageMs)
  return { rows, protectedPids, created, children, selfPid: self.pid, warnings }
}

export async function classifyStuckProcesses(deps: StuckScanDeps = {}): Promise<{ snap: ProcSnapshot; cls: StuckClassification }> {
  const snap = await takeProcessSnapshot(deps)
  const cls = classifyProcesses(snap, { selfPid: deps.selfPid ?? process.pid, homeDir: deps.homeDir ?? homedir() })
  return { snap, cls }
}

export async function scanStuckProcesses(deps: StuckScanDeps = {}): Promise<StuckScan> {
  const { snap, cls } = await classifyStuckProcesses(deps)
  return {
    processes: cls.rows.map(({ tree: _tree, ...view }) => view),
    scannedAt: snap.takenAt,
    platform: snap.platform,
    totalProcesses: snap.procs.length,
    warnings: cls.warnings,
  }
}

/** Validate what the renderer sent. Anything malformed refuses the whole request. */
export function normalizeKillTargets(input: unknown): StuckKillTarget[] {
  if (!Array.isArray(input)) throw new Error('A list of processes to end is required')
  if (input.length > MAX_KILL_TARGETS) throw new Error(`At most ${MAX_KILL_TARGETS} processes can be ended at once`)
  const seen = new Set<number>()
  const out: StuckKillTarget[] = []
  for (const raw of input) {
    const pid = isRecord(raw) ? raw.pid : undefined
    const created = isRecord(raw) ? raw.created : undefined
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || typeof created !== 'number' || !Number.isFinite(created)) {
      throw new Error('Each process to end needs a pid and a start time')
    }
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push({ pid, created })
  }
  return out
}

function errCode(e: unknown): unknown {
  return isRecord(e) ? e.code : undefined
}

function describeKillError(e: unknown): string {
  if (errCode(e) === 'EPERM') return 'access denied — elevated or owned by another user'
  return e instanceof Error ? e.message : String(e)
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return errCode(e) === 'EPERM'
  }
}

export async function killStuckProcesses(
  input: unknown,
  deps: StuckKillDeps = {},
  opts: StuckKillOptions = {},
): Promise<StuckKillResult> {
  const targets = normalizeKillTargets(input)
  const result: StuckKillResult = { killed: [], failed: [], skipped: [] }
  if (targets.length === 0) return result
  const cls = await (deps.classify ?? (async () => (await classifyStuckProcesses()).cls))()
  const platform = deps.platform ?? process.platform
  const kill = deps.kill ?? ((pid: number, signal?: NodeJS.Signals) => void process.kill(pid, signal))
  const alive = deps.alive ?? defaultAlive
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const tolerance = platform === 'win32' ? CREATED_TOLERANCE_MS : POSIX_KILL_TOLERANCE_MS

  const rowOf = new Map<number, StuckRow>()
  for (const row of cls.rows) for (const pid of row.tree) rowOf.set(pid, row)
  const order: number[] = []
  const queued = new Set<number>()
  for (const t of targets) {
    const row = rowOf.get(t.pid)
    if (!row) {
      result.skipped.push({ pid: t.pid, reason: 'already exited or no longer listed' })
      continue
    }
    if (Math.abs((cls.created.get(t.pid) as number) - t.created) > tolerance) {
      result.skipped.push({ pid: t.pid, reason: 'pid reused by a different process' })
      continue
    }
    // Resumed, re-adopted or now serving a port since the list was drawn.
    if (opts.stuckOnly && !row.stuck) {
      result.skipped.push({ pid: t.pid, reason: 'no longer stuck' })
      continue
    }
    // Parent first, so nothing is left alive to respawn what was just ended.
    const members = new Set(row.tree)
    const queue = [t.pid]
    for (let i = 0; i < queue.length; i++) {
      const pid = queue[i]
      if (queued.has(pid) || !members.has(pid) || pid === cls.selfPid || cls.protectedPids.has(pid)) continue
      queued.add(pid)
      order.push(pid)
      queue.push(...(cls.children.get(pid) ?? []))
    }
  }

  const signal = (pid: number, sig?: NodeJS.Signals): boolean => {
    try {
      kill(pid, sig)
      return true
    } catch (e) {
      // Already gone is the outcome the user asked for.
      if (errCode(e) === 'ESRCH') result.killed.push(pid)
      else result.failed.push({ pid, error: describeKillError(e) })
      return false
    }
  }

  if (platform === 'win32') {
    // TerminateProcess: immediate, and it works on a suspended process.
    for (const pid of order) if (signal(pid)) result.killed.push(pid)
    return result
  }

  const signalled = order.filter((pid) => signal(pid, 'SIGTERM'))
  // A stopped process cannot act on SIGTERM until it runs again.
  for (const pid of signalled) {
    try {
      kill(pid, 'SIGCONT')
    } catch {
      // It exited between the two signals.
    }
  }
  let pending = signalled.filter(alive)
  for (let waited = 0; pending.length > 0 && waited < KILL_GRACE_MS; waited += KILL_POLL_MS) {
    await wait(KILL_POLL_MS)
    pending = pending.filter(alive)
  }
  for (const pid of signalled) if (!pending.includes(pid)) result.killed.push(pid)
  for (const pid of pending) if (signal(pid, 'SIGKILL')) result.killed.push(pid)
  return result
}
