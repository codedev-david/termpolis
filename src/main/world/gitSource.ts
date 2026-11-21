// Lumopolis git source: opens a world from a git URL by cloning the repository, shallow and read-only,
// into `<userData>/world/repos/<hash>`. A clone is never executed: no install, no scripts, no hooks
// (core.hooksPath points at the null device), and only https and ssh transports are allowed.
//
// Security: a URL or branch name is never allowed to reach git as an option. The URL must match
// `^(https://|ssh://|git@)[^\s]+$`, the branch a conservative character set, both are placed after
// `--` or validated not to start with `-`, and the environment forbids prompts and other protocols.
//
// Logins: each run takes a login mode (gitLogin.ts). By default (`none`) git may not ask for a login: no
// terminal prompt, no askpass program, no helper, so no sign-in window. `machine` lets git use the
// person's own login helper, with its window only on a run the person asked for. The login settings
// travel in the environment, never on the command line. An https auth failure comes back as `needsLogin`,
// so the app can offer a sign-in; an ssh one stays a plain message. `token` hands git a token the person
// pasted, through the environment of that one run and the askpass Termpolis ships; a token git refuses
// comes back as TOKEN_REJECTED_MESSAGE, and every message and error of a token run has the token hidden.
// Never outside the clone: symlinks check out as small text files (core.symlinks=false), so indexing
// cannot be led to a file elsewhere on the computer.
//
// This runs inside the world host utilityProcess: no Electron imports (worldHostImports.test.ts).
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { BAD_REF_MESSAGE, stripUrlUserinfo, validateGitUrl, validGitRef } from '../../shared/world/gitUrl'
import { hideValue, normalizeToken, TOKEN_REJECTED_MESSAGE, type NeedsLogin } from '../../shared/world/repoAccess'
import { binInside } from '../binPath'
import {
  configEnv,
  gitNewEnough,
  hasLoginHelper,
  inheritedEnv,
  loginConfig,
  loginEnv,
  OLD_GIT_MESSAGE,
  parseGitVersion,
  safetyFlags,
  withoutTrace,
  type LoginRun
} from './gitLogin'

export { BAD_URL_MESSAGE, BAD_REF_MESSAGE, validateGitUrl } from '../../shared/world/gitUrl'
export { DROPPED_ENV, OLD_GIT_MESSAGE, safetyFlags, type LoginRun } from './gitLogin'
export const TOO_BIG_MESSAGE = 'That repository is larger than 2 GB, so Lumopolis stopped cloning it.'
export const CANCELLED_MESSAGE = 'Cancelled'
export const CLEAR_MESSAGE = "Lumopolis couldn't clear an earlier partial copy of that repository. Try again in a moment."
export const FINISH_MESSAGE = "Lumopolis couldn't save that repository. Try again in a moment."
export const NO_GIT_MESSAGE = 'Lumopolis needs git to open a repository, and git was not found on this computer.'
export const TIMEOUT_MESSAGE = 'That repository took longer than 5 minutes to download, so Lumopolis stopped.'
export const AUTH_MESSAGE = 'That repository needs you to sign in. Sign in with the login this computer already uses for git, or use a token.'
/** A signed-in https run that the host answers with "not found": the account it used cannot see the repository. */
export function notFoundMessage(host: string): string {
  return `The account you signed in to ${host} with can't see that repository. Use a token from an account that can see it.`
}
export const SSH_AUTH_MESSAGE =
  "That repository needs you to sign in, and your ssh agent couldn't open it. Check that your ssh key is added, or clone it yourself and choose Open a folder."
/** Written inside `.git` once a clone is complete; only a marked clone is updated in place. */
export const CLONE_MARKER = 'lumopolis-complete'

/** A clone larger than this is aborted and deleted. */
export const MAX_CLONE_BYTES = 2 * 1024 * 1024 * 1024
/** A whole clone or update (every git command in it together) may run this long; kept well under the
 *  world client's 10-minute call timeout, with room for the kill grace. */
export const CLONE_TIMEOUT_MS = 5 * 60_000
/** How often the clone's folder size is checked while git runs. */
export const SIZE_POLL_MS = 2000

/** The folder name for a clone: the first 16 hex digits of sha1(url + NUL + ref). The separator keeps
 *  `a.gitx` with no ref apart from `a.git` with ref `x`. */
export function cloneKey(url: string, ref?: string): string {
  return createHash('sha1')
    .update(`${String(url)}\0${typeof ref === 'string' ? ref : ''}`)
    .digest('hex')
    .slice(0, 16)
}

/** How long `git --version` may take. */
export const VERSION_TIMEOUT_MS = 30_000
/** The most a `git --version` or `git rev-parse HEAD` may print. */
const SMALL_OUTPUT_MAX = 4096

/** What a host says when the account a run signed in with has no access: GitHub answers 404 rather than
 *  401, so as not to reveal that a private repository exists. */
const NOT_FOUND_RE = /repository not found|repository '[^']*' not found|returned error: 404\b/i
/** What git's own messages say when a host wanted a login it was not given. */
const AUTH_RE = /terminal prompts disabled|could not read (username|password)|authentication failed|permission denied \(publickey|access denied|host key verification failed|invalid username or/i

export function cloneArgs(url: string, dir: string, ref?: string, isWindows: boolean = process.platform === 'win32'): string[] {
  return [
    ...safetyFlags(isWindows),
    'clone',
    '--quiet',
    '--depth',
    '1',
    '--filter=blob:none',
    '--single-branch',
    ...(ref ? ['--branch', ref] : []),
    '--',
    url,
    dir
  ]
}

export interface ExecOpts {
  env: Record<string, string>
  /** The folder git starts in (default: this process's). */
  cwd?: string
  timeout: number
  signal?: AbortSignal
  /** Test hook: the wait after a kill (default KILL_GRACE_MS). */
  killGraceMs?: number
  /** Collect stdout, up to this many bytes (more fails the run). Without it stdout is ignored. */
  stdoutMax?: number
}
export interface ExecResult {
  code: number
  stderr: string
  /** With `stdoutMax`: what the program printed when it exited 0, otherwise ''. */
  stdout?: string
  /** With `stdoutMax`: the program could not be found (ENOENT). */
  missing?: boolean
}
export type ExecFn = (cmd: string, args: string[], opts: ExecOpts) => Promise<ExecResult>

export interface CloneDeps {
  execFile: ExecFn
  /** The full path of git, or null when it is not installed (binPath.ts resolveGitBin). Git is started by exactly
   *  this path, never by the bare name, and never when it lies inside the clone folder. */
  gitBin: () => Promise<string | null>
  /** Resolves links, so a git reached through a junction into the clone folder counts as inside it (default: fs realpath). */
  realpath?: (p: string) => Promise<string>
  baseDir: string
  dirSize(p: string): Promise<number>
  rm(p: string): Promise<void>
  isWindows: boolean
  /** Whether a path exists (default: an fs access check). */
  exists?: (p: string) => Promise<boolean>
  /** Lists a folder's entry names (default: readdir; a missing folder is empty). */
  listDir?: (p: string) => Promise<string[]>
  /** Marks a finished clone by writing this file (default: writeFile). */
  mark?: (p: string) => Promise<void>
  /** Moves the finished clone into place (default: fs rename). */
  rename?: (from: string, to: string) => Promise<void>
  /** Waits between rename attempts (default: a timer). */
  sleep?: (ms: number) => Promise<void>
  /** A random suffix for the temporary folder (default: 4 random bytes as hex). */
  random?: () => string
  /** Cancels the clone: git is stopped and the folder removed. */
  signal?: AbortSignal
  /** The environment git inherits (default: process.env). */
  env?: NodeJS.ProcessEnv
  /** How often the size is checked (default SIZE_POLL_MS). */
  pollMs?: number
  /** The size cap (default MAX_CLONE_BYTES). */
  maxBytes?: number
  /** The clock for the overall deadline (default Date.now). */
  now?: () => number
  /** The time the whole job may take (default CLONE_TIMEOUT_MS). The world host passes less when the call
   *  already waited behind another run, so wait plus run stays inside CLONE_TIMEOUT_MS. */
  timeoutMs?: number
  /** The full path of the askpass Termpolis ships (resources/git-askpass/askpass.sh). A token run without
   *  it is refused before git starts. */
  askpassPath?: string
}

// ── Real implementations of the injectable deps ──────────────────────────────────────────────────

/** After an abort or timeout kills git, how long to wait for it to exit before giving up on it. */
export const KILL_GRACE_MS = 10_000

/**
 * Runs git without a shell; never rejects: a non-zero exit, a spawn failure, a timeout and an abort all
 * resolve `{code, stderr}`. It resolves only when the child has CLOSED (exited and its stderr ended), so
 * a caller that removes the folder afterwards is not racing git's last writes; `killGraceMs` bounds
 * the wait when a grandchild keeps stderr open after the kill. With `stdoutMax` it also collects
 * stdout (the world host's `git ls-files`), and the result says whether the program was missing.
 */
export const nodeExecFile: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stderr = ''
    let settled = false
    let stopped = false
    let timedOut = false
    let overflow = false
    let outBytes = 0
    const out: Buffer[] = []
    const capture = opts.stdoutMax !== undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let child: ChildProcess
    const finish = (code: number, text: string, missing = false): void => {
      if (settled) return
      settled = true
      clearTimeout(runTimer)
      clearTimeout(graceTimer)
      opts.signal?.removeEventListener('abort', stop)
      const r: ExecResult = { code, stderr: text }
      if (capture) {
        r.stdout = code === 0 ? Buffer.concat(out).toString('utf8') : ''
        r.missing = missing
      }
      resolve(r)
    }
    const stop = (): void => {
      if (stopped) return
      stopped = true
      child.kill()
      graceTimer = setTimeout(() => finish(1, timedOut ? 'it took too long' : stderr || 'it was stopped'), opts.killGraceMs ?? KILL_GRACE_MS)
    }
    const runTimer = setTimeout(() => {
      timedOut = true
      stop()
    }, opts.timeout)
    try {
      child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] })
    } catch (e) {
      return finish(1, (e as Error).message)
    }
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < 65536) stderr += c.toString()
    })
    if (capture) {
      ;(child.stdout as NonNullable<ChildProcess['stdout']>).on('data', (c: Buffer) => {
        outBytes += c.length
        if (outBytes > (opts.stdoutMax as number)) {
          // Once past the cap it stays past it: nothing more is kept, and stop() runs once.
          overflow = true
          out.length = 0
          stop()
          return
        }
        out.push(c)
      })
    }
    child.on('error', (e: NodeJS.ErrnoException) => finish(1, e.message, e.code === 'ENOENT'))
    child.on('close', (code) => {
      if (overflow) return finish(1, 'too much output')
      if (timedOut) return finish(1, 'it took too long')
      if (code === 0) return finish(0, stderr)
      finish(code ?? 1, stderr || `git exited with code ${code}`)
    })
    if (opts.signal?.aborted) stop()
    else opts.signal?.addEventListener('abort', stop, { once: true })
  })

/** Total file bytes under `p`, not following symlinks. A missing folder is 0. */
export async function dirSizeOf(p: string): Promise<number> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(p, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const e of entries) {
    const child = join(p, e.name)
    if (e.isDirectory()) total += await dirSizeOf(child)
    else if (e.isFile()) total += (await fsp.lstat(child)).size
  }
  return total
}

export const removeDir = (p: string): Promise<void> => fsp.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })

export const listNames = (p: string): Promise<string[]> => fsp.readdir(p).catch(() => [])
export const writeMarker = (p: string): Promise<void> => fsp.writeFile(p, 'ok')
export const randomSuffix = (): string => randomBytes(4).toString('hex')

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Error codes a virus scanner or indexer holding a fresh file makes a rename fail with, briefly. */
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
export const RENAME_ATTEMPTS = 5

/** Renames, retrying a transient lock up to RENAME_ATTEMPTS times with 100 ms x attempt of backoff. Other errors throw at once. */
export async function renameWithRetry(
  rename: (from: string, to: string) => Promise<void>,
  sleep: (ms: number) => Promise<void>,
  from: string,
  to: string
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (e) {
      if (attempt >= RENAME_ATTEMPTS || !RETRY_CODES.has((e as NodeJS.ErrnoException).code ?? '')) throw e
      await sleep(100 * attempt)
    }
  }
}

export const pathExists = (p: string): Promise<boolean> =>
  fsp.access(p).then(
    () => true,
    () => false
  )

// ── cloneRepo ────────────────────────────────────────────────────────────────────────────────────

/** The line that says what went wrong: the first fatal:/error:/remote: line, else the first one; no `user:pass@`. */
function firstLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).filter((l) => l.trim() !== '')
  const line = lines.find((l) => /^(fatal|error|remote):/.test(l)) ?? lines[0] ?? ''
  return line.trim().replace(/\/\/[^/@\s]+@/g, '//***@') || 'no details'
}

export type { NeedsLogin }

/** The host (with any port) of an https URL as written, without a login; '' for ssh and anything else.
 *  This is the form git puts in its prompts, which the askpass matches. */
function rawHttpsHost(url: string): string {
  const m = /^https:\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(url)
  return m ? m[1] : ''
}

/** The host (with any port) of an https URL, lower case and without a login; null for ssh and anything else. */
function httpsHost(url: string): string | null {
  const host = rawHttpsHost(url)
  return host ? host.toLowerCase() : null
}

/** Each CloneDeps object asks git its version once: 'ok', 'missing' (git could not be started) or 'old'. */
const versionChecks = new WeakMap<CloneDeps, Promise<'ok' | 'missing' | 'old'>>()

function checkGitVersion(deps: CloneDeps, gitBin: string, env: Record<string, string>): Promise<'ok' | 'missing' | 'old'> {
  let check = versionChecks.get(deps)
  if (!check) {
    check = deps.execFile(gitBin, ['--version'], { env, timeout: VERSION_TIMEOUT_MS, signal: deps.signal, stdoutMax: SMALL_OUTPUT_MAX }).then(
      (r) => (r.missing ? 'missing' : gitNewEnough(parseGitVersion(r.code === 0 ? (r.stdout ?? '') : '')) ? 'ok' : 'old'),
      () => 'old' as const
    )
    versionChecks.set(deps, check)
  }
  return check
}

export type CloneResult = { ok: true; root: string; changed: boolean } | { ok: false; error: string; needsLogin?: NeedsLogin }

/**
 * Clones `url` (or updates the clone made earlier) under `<baseDir>/world/repos`. `run` says how git may
 * log in (default `none`). `changed` says whether the files may differ from before: always for a new
 * clone, and for an update only when HEAD moved (or could not be read).
 *
 * A token run is refused before git starts when the askpass is not shipped, the URL is not https (a token
 * is only ever sent over https) or the token cannot be one. Its returned error, and anything it throws,
 * has every copy of the token hidden.
 */
export async function cloneRepo(url: string, ref: string | undefined, deps: CloneDeps, run: LoginRun = { mode: 'none' }): Promise<CloneResult> {
  if (run.mode !== 'token') return cloneOnce(url, ref, deps, run)
  if (!deps.askpassPath || !rawHttpsHost(url)) return { ok: false, error: TOKEN_REJECTED_MESSAGE }
  const token = normalizeToken(run.value)
  if (!token.ok) return { ok: false, error: token.error }
  const value = token.value
  try {
    const r = await cloneOnce(url, ref, deps, { mode: 'token', value })
    return r.ok ? r : { ...r, error: hideValue(r.error, value) }
  } catch (e) {
    throw new Error(hideValue(e instanceof Error ? e.message : String(e), value))
  }
}

async function cloneOnce(url: string, ref: string | undefined, deps: CloneDeps, run: LoginRun): Promise<CloneResult> {
  const checked = validateGitUrl(url)
  if (!checked.ok) return { ok: false, error: checked.reason }
  if (ref !== undefined && !validGitRef(ref)) return { ok: false, error: BAD_REF_MESSAGE }

  const reposDir = join(deps.baseDir, 'world', 'repos')
  const hash = cloneKey(url, ref)
  const root = join(reposDir, hash)
  const exists = deps.exists ?? pathExists
  const maxBytes = deps.maxBytes ?? MAX_CLONE_BYTES
  const ext = deps.signal
  if (ext?.aborted) return { ok: false, error: CANCELLED_MESSAGE }

  /** Removes a folder; a failure (a file still held open) is swallowed: the next call sweeps it. */
  const rmq = (p: string): Promise<boolean> =>
    deps.rm(p).then(
      () => true,
      () => false
    )

  // Git by its full path; no git (or one inside the clone folder) means nothing is started.
  const gitBin = await deps.gitBin()
  if (gitBin === null || (await binInside(gitBin, reposDir, deps.realpath ?? ((p) => fsp.realpath(p))))) return { ok: false, error: NO_GIT_MESSAGE }

  const env = inheritedEnv(deps.env ?? process.env)
  // Ssh must never open a window or prompt.
  env.SSH_ASKPASS_REQUIRE = 'never'
  env.GIT_ALLOW_PROTOCOL = 'https:ssh'
  // git must never search upward out of the clone and act on a parent repository.
  env.GIT_CEILING_DIRECTORIES = reposDir

  // A git too old to read the login settings from the environment is refused before anything is touched.
  // It gets its own copy: the login settings below, a token's among them, are never in what it saw.
  const version = await checkGitVersion(deps, gitBin, { ...env })
  if (ext?.aborted) return { ok: false, error: CANCELLED_MESSAGE }
  if (version === 'missing') return { ok: false, error: NO_GIT_MESSAGE }
  if (version === 'old') return { ok: false, error: OLD_GIT_MESSAGE }
  // The login settings for this run (and whether git may prompt) go over the inherited environment, which
  // for a token run first loses any git trace. The local steps (rev-parse, remote set-url, reset) get that
  // login-free env; only the network steps (clone, fetch) of a token run also get the askpass, the token
  // and the host it answers for. Both are built afresh for every run and dropped when it ends: nothing here
  // keeps or returns them.
  const localEnv = { ...(run.mode === 'token' ? withoutTrace(env) : env), ...configEnv(loginConfig(run)), ...loginEnv(run) }
  const netEnv = run.mode === 'token' ? { ...localEnv, ...loginEnv(run, deps.askpassPath, rawHttpsHost(url)) } : localEnv

  // Only a clone that finished (marker inside .git) is updated in place. Anything else is not trusted.
  const updating = await exists(join(root, '.git', CLONE_MARKER))
  if (!updating) {
    for (const name of await (deps.listDir ?? listNames)(reposDir)) {
      if (name.startsWith(`${hash}.tmp-`)) await rmq(join(reposDir, name))
    }
    if (!(await rmq(root))) return { ok: false, error: CLEAR_MESSAGE }
  }
  // A new clone is made beside its final place and renamed into it on success, so a partial clone never sits at root.
  const work = updating ? root : `${root}.tmp-${(deps.random ?? randomSuffix)()}`

  const flags = safetyFlags(deps.isWindows)
  const pin = ['--git-dir', join(root, '.git'), '--work-tree', root]
  // A url with a login in it (https://user:secret@host/...) clones with it, then the clone's origin is
  // set to the url without it, so the secret is not left in .git/config under userData.
  const bare = stripUrlUserinfo(url)
  const commands: Array<{ args: string[]; env: Record<string, string> }> = updating
    ? [
        { args: [...flags, ...pin, 'fetch', '--quiet', '--depth', '1', 'origin', ref ?? 'HEAD'], env: netEnv },
        { args: [...flags, ...pin, 'reset', '--hard', 'FETCH_HEAD'], env: localEnv }
      ]
    : [
        { args: cloneArgs(url, work, ref, deps.isWindows), env: netEnv },
        ...(bare !== url ? [{ args: [...flags, '--git-dir', join(work, '.git'), 'remote', 'set-url', 'origin', bare], env: localEnv }] : [])
      ]

  const ctl = new AbortController()
  const onAbort = (): void => ctl.abort()
  ext?.addEventListener('abort', onAbort)
  if (ext?.aborted) ctl.abort()
  let tooBig = false
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    deps
      .dirSize(work)
      .then((n) => {
        if (n > maxBytes) {
          tooBig = true
          ctl.abort()
        }
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false
      })
  }, deps.pollMs ?? SIZE_POLL_MS)

  // One deadline for the whole job, so fetch plus reset can never add up past the client's call timeout.
  const now = deps.now ?? Date.now
  const deadline = now() + (deps.timeoutMs ?? CLONE_TIMEOUT_MS)
  let failure = ''
  let timedOut = false
  let auth = false
  let notFound = false
  let failedStep = -1
  /** The clone's HEAD commit, or null when it cannot be read in the time left. */
  const readHead = async (): Promise<string | null> => {
    const left = deadline - now()
    if (left <= 0) return null
    const r = await deps
      .execFile(gitBin, [...flags, ...pin, 'rev-parse', 'HEAD'], { env: localEnv, timeout: left, signal: ctl.signal, stdoutMax: SMALL_OUTPUT_MAX })
      .catch(() => null)
    const head = r !== null && r.code === 0 ? (r.stdout ?? '').trim() : ''
    return head === '' ? null : head
  }
  let headBefore: string | null = null
  try {
    if (updating) headBefore = await readHead()
    for (const [step, { args, env: stepEnv }] of commands.entries()) {
      const left = deadline - now()
      if (left <= 0) {
        timedOut = true
        failedStep = step
        break
      }
      const r = await deps
        .execFile(gitBin, args, { env: stepEnv, timeout: left, signal: ctl.signal })
        .catch((e: unknown) => ({ code: 1, stderr: e instanceof Error ? e.message : String(e) }))
      if (r.code !== 0) {
        failedStep = step
        timedOut = now() >= deadline
        auth = AUTH_RE.test(r.stderr)
        notFound = NOT_FOUND_RE.test(r.stderr)
        failure = firstLine(r.stderr)
        break
      }
    }
  } finally {
    clearInterval(timer)
    ext?.removeEventListener('abort', onAbort)
  }

  // A cap hit or a cancel aborts git, which then also looks like a failed exit: check those first.
  if (!tooBig && !ext?.aborted && !failure && !timedOut && (await deps.dirSize(work).catch(() => 0)) > maxBytes) tooBig = true
  if (tooBig) {
    await rmq(work)
    return { ok: false, error: TOO_BIG_MESSAGE }
  }
  if (ext?.aborted) {
    await rmq(work)
    return { ok: false, error: CANCELLED_MESSAGE }
  }
  if (timedOut) {
    // A reset stopped half way leaves a working tree nobody can trust: drop it so the next open clones fresh.
    if (!updating || failedStep > 0) await rmq(work)
    return { ok: false, error: TIMEOUT_MESSAGE }
  }
  if (failure) {
    // A failed update leaves the earlier complete clone alone; a failed first clone leaves nothing.
    if (!updating) await rmq(work)
    const host = httpsHost(url)
    // "Not found" after a sign-in means that account can't see it; with no login it is just not there (a typo
    // must never ask for a sign-in), and over ssh it is the ssh agent's business.
    const unseen = notFound && run.mode !== 'none' && host !== null
    if (!auth && !unseen) return { ok: false, error: `Couldn't reach that repository: ${failure}` }
    // An https host that wanted a login can be signed in to; ssh logins are the ssh agent's business.
    if (host === null) return { ok: false, error: SSH_AUTH_MESSAGE }
    // A token that git refused, or that cannot see the repository, is one that did not open it.
    const error = run.mode === 'token' ? TOKEN_REJECTED_MESSAGE : auth ? AUTH_MESSAGE : notFoundMessage(host)
    return { ok: false, error, needsLogin: { host, helper: await hasLoginHelper(deps, host) } }
  }
  if (!updating) {
    try {
      await (deps.mark ?? writeMarker)(join(work, '.git', CLONE_MARKER))
      await renameWithRetry(deps.rename ?? fsp.rename, deps.sleep ?? sleepMs, work, root)
    } catch {
      await rmq(work)
      return { ok: false, error: FINISH_MESSAGE }
    }
    return { ok: true, root, changed: true }
  }
  const headAfter = await readHead()
  return { ok: true, root, changed: headBefore === null || headAfter === null || headBefore !== headAfter }
}
