// Lumopolis git login: how each git run here is told whether it may use a login, and the checks around it.
//
// Every run carries the same safety flags on its command line (no local-file transport, no hooks, no
// symlinks, no fsmonitor). The three login settings (`credential.helper`, `credential.interactive`,
// `core.askPass`) are the only thing that differs between runs, and they travel in the environment as
// git's numbered config (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_<i>, GIT_CONFIG_VALUE_<i>), which git reads
// with the same weight as `-c`. Keeping them off the command line keeps every login word off it too.
//
// The modes:
// - `none`: git may not ask for a login at all (no helper, no askpass, no prompt). Used for every run
//   not named below.
// - `machine`: git may use the login helper from the person's own git config (Git Credential Manager,
//   the macOS keychain helper, the GitHub CLI). Only a run the person asked for (`interactive`) may show
//   the helper's own sign-in window; a background run never can.
// - `token`: a token the person pasted for this one run. No login helper may answer; git asks the askpass
//   Termpolis ships (resources/git-askpass/askpass.sh), which prints the user or the value from two
//   variables in this run's environment only. The value never reaches a command line, a file or a log.
//
// Git reads GIT_CONFIG_COUNT from 2.31 on, so an older git would ignore the login settings: a run is
// refused below MIN_GIT. `hasLoginHelper` reads git config only, never a login store.
//
// This runs inside the world host utilityProcess: no Electron imports (worldHostImports.test.ts).
import type { CloneDeps } from './gitSource'

/** How one git run may log in. */
export type LoginRun = { mode: 'none' } | { mode: 'machine'; interactive: boolean } | { mode: 'token'; value: string }

/**
 * The flags every git command here carries: no local-file transport, no hooks, symlinks checked out as
 * plain files, and no fsmonitor program. The login settings are not here: see loginConfig.
 */
export function safetyFlags(isWindows: boolean): string[] {
  return [
    '-c', 'protocol.file.allow=never',
    '-c', `core.hooksPath=${isWindows ? 'NUL' : '/dev/null'}`,
    '-c', 'core.symlinks=false',
    '-c', 'core.fsmonitor=false'
  ]
}

/** Inherited variables that would point git at another repository, index, object store or config, or
 *  run a program to ask for a login, or answer the shipped askpass with a value nobody pasted. */
export const DROPPED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_NAMESPACE',
  'GIT_COMMON_DIR',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'TERMPOLIS_GIT_ASKPASS_USER',
  'TERMPOLIS_GIT_ASKPASS_REPLY',
  'TERMPOLIS_GIT_ASKPASS_HOST'
]

/** Inherited numbered config entries: a run sets its own, so none of the parent's may leak in beside them. */
const DROPPED_PREFIXES = ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_']

/** The environment a git run starts from: the given one without DROPPED_ENV or any numbered config, in any case. */
export function inheritedEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const dropped = new Set(DROPPED_ENV)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(src)) {
    const key = k.toUpperCase()
    if (typeof v === 'string' && !dropped.has(key) && !DROPPED_PREFIXES.some((p) => key.startsWith(p))) env[k] = v
  }
  return env
}

/** The login settings for one run. Only these three keys ever differ between modes. */
export function loginConfig(run: LoginRun): Array<[string, string]> {
  switch (run.mode) {
    case 'machine':
      // A background run keeps any askpass program the person configured from opening a window too.
      return run.interactive ? [['core.askPass', '']] : [['credential.interactive', 'false'], ['core.askPass', '']]
    case 'token':
      return [['credential.helper', '']]
    default:
      return [['credential.helper', ''], ['credential.interactive', 'false'], ['core.askPass', '']]
  }
}

/** Git's numbered config for these pairs, numbered from zero. */
export function configEnv(pairs: Array<[string, string]>): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) }
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })
  return env
}

/** The user a token run gives git. GitHub, GitLab and Gitea all take any user beside a token; this is
 *  the one GitHub documents. */
export const TOKEN_USER = 'x-access-token'

/** The variables that keep a run from prompting: never a terminal prompt, and Git Credential Manager's
 *  window only on an interactive `machine` run. A token run always redacts any git trace. Given the shipped
 *  askpass and the forge host, it also gets the askpass, the two answers it prints and the one host it
 *  prints them for: that form belongs on the network steps (clone, fetch) only, and the plain form on the
 *  local ones. Without both it gets nothing that could answer. */
export function loginEnv(run: LoginRun, askpassPath?: string, host?: string): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' }
  if (run.mode === 'none' || (run.mode === 'machine' && !run.interactive)) env.GCM_INTERACTIVE = 'never'
  if (run.mode === 'token') {
    env.GIT_TRACE_REDACT = '1'
    if (askpassPath && host) {
      env.GIT_ASKPASS = askpassPath
      env.TERMPOLIS_GIT_ASKPASS_USER = TOKEN_USER
      env.TERMPOLIS_GIT_ASKPASS_REPLY = run.value
      env.TERMPOLIS_GIT_ASKPASS_HOST = host
    }
  }
  return env
}

/** A copy of env without any git trace or curl verbosity, in any case: GIT_TRACE and everything that starts
 *  with it (GIT_TRACE_CURL, GIT_TRACE_PACKET, GIT_TRACE2*, GIT_TRACE_REDACT, ...) and GIT_CURL_VERBOSE. A
 *  token run starts from this, so no inherited setting can write its headers anywhere. */
export function withoutTrace(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (!/^GIT_TRACE/i.test(k) && !/^GIT_CURL_VERBOSE$/i.test(k)) out[k] = v
  return out
}

/** The first git that reads GIT_CONFIG_COUNT. */
export const MIN_GIT = [2, 31] as const
export const OLD_GIT_MESSAGE = 'Lumopolis needs git 2.31 or newer to open a repository. Update git, then try again.'

/** Major and minor from `git --version` (`git version 2.47.1.windows.2` is [2, 47]); anything else is null. */
export function parseGitVersion(out: string): [number, number] | null {
  const m = /^git version (\d+)\.(\d+)/.exec(out.trim())
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** Whether a parsed version reads the login settings; an unknown version does not count as new enough. */
export function gitNewEnough(v: [number, number] | null): boolean {
  if (v === null) return false
  return v[0] > MIN_GIT[0] || (v[0] === MIN_GIT[0] && v[1] >= MIN_GIT[1])
}

/** The most `git config --list -z` output read. */
export const HELPER_LIST_MAX = 1_048_576
/** How long reading git config may take. */
export const HELPER_CHECK_TIMEOUT_MS = 15_000

/** The host (with any port) of a `scheme://[user@]host[/path]` URL, lower case; null for anything else. */
function urlHost(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(url)
  return m ? m[1].toLowerCase() : null
}

/**
 * Whether git has a login helper it would use for `host`: a `credential.helper`, or a
 * `credential.<url>.helper` whose URL names that host. It reads git config only (`git config --list -z`),
 * never a login store, and its output is neither logged nor returned. As in git, an empty value clears the
 * helpers listed before it. No git, a failed run or too much output all mean no.
 */
export async function hasLoginHelper(deps: Pick<CloneDeps, 'execFile' | 'gitBin' | 'baseDir' | 'env'>, host: string): Promise<boolean> {
  const bin = await deps.gitBin()
  if (bin === null) return false
  const env = inheritedEnv(deps.env ?? process.env)
  env.GIT_CEILING_DIRECTORIES = deps.baseDir
  env.GIT_TERMINAL_PROMPT = '0'
  const r = await deps
    .execFile(bin, [...safetyFlags(process.platform === 'win32'), 'config', '--list', '-z'], {
      env,
      cwd: deps.baseDir,
      timeout: HELPER_CHECK_TIMEOUT_MS,
      stdoutMax: HELPER_LIST_MAX
    })
    .catch(() => null)
  if (r === null || r.code !== 0 || r.missing) return false
  const want = host.toLowerCase()
  let helpers = 0
  for (const entry of (r.stdout ?? '').split('\0')) {
    const nl = entry.indexOf('\n')
    if (nl < 0) continue
    const m = /^credential\.(?:(.+)\.)?helper$/i.exec(entry.slice(0, nl))
    if (!m || (m[1] !== undefined && urlHost(m[1]) !== want)) continue
    helpers = entry.slice(nl + 1) === '' ? 0 : helpers + 1
  }
  return helpers > 0
}
