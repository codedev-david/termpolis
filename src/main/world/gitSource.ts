// Lumopolis git source: opens a world from a git URL by cloning the repository, shallow and read-only,
// into `<userData>/world/repos/<hash>`. A clone is never executed: no install, no scripts, no hooks
// (core.hooksPath points at the null device), and only https and ssh transports are allowed.
//
// Security: a URL or branch name is never allowed to reach git as an option. The URL must match
// `^(https://|ssh://|git@)[^\s]+$`, the branch a conservative character set, both are placed after
// `--` or validated not to start with `-`, and the environment forbids prompts and other protocols.
//
// Never interactive: git is never allowed to ask for a login. No terminal prompt, no askpass program,
// no helper (so no OS sign-in window), and an auth failure becomes a plain in-app message.
// Never outside the clone: symlinks check out as small text files (core.symlinks=false), so indexing
// cannot be led to a file elsewhere on the computer.
//
// This runs inside the world host utilityProcess: no Electron imports (worldHostImports.test.ts).
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { BAD_REF_MESSAGE, validateGitUrl, validGitRef } from '../../shared/world/gitUrl'

export { BAD_URL_MESSAGE, BAD_REF_MESSAGE, validateGitUrl } from '../../shared/world/gitUrl'
export const TOO_BIG_MESSAGE = 'That repository is larger than 2 GB, so Lumopolis stopped cloning it.'
export const CANCELLED_MESSAGE = 'Cancelled'
export const CLEAR_MESSAGE = "Lumopolis couldn't clear an earlier partial copy of that repository. Try again in a moment."
export const FINISH_MESSAGE = "Lumopolis couldn't save that repository. Try again in a moment."
export const TIMEOUT_MESSAGE = 'That repository took longer than 5 minutes to download, so Lumopolis stopped.'
export const AUTH_MESSAGE =
  'That repository needs you to sign in, and Lumopolis never asks git for a login. Use an ssh URL your ssh agent can open, or clone it yourself and choose Open a folder.'
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

/**
 * The flags every git command here carries: no local-file transport, no hooks, symlinks checked out as
 * plain files, and no way to ask for a login (an empty helper list resets any configured helper, and an
 * empty askPass turns off a configured askpass program).
 */
export function safetyFlags(isWindows: boolean): string[] {
  return [
    '-c', 'protocol.file.allow=never',
    '-c', `core.hooksPath=${isWindows ? 'NUL' : '/dev/null'}`,
    '-c', 'core.symlinks=false',
    '-c', 'credential.helper=',
    '-c', 'credential.interactive=false',
    '-c', 'core.askPass='
  ]
}

/** Inherited variables that would point git at another repository, index, object store or config, or
 *  run a program to ask for a login. */
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
  'SSH_ASKPASS'
]

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
      child = spawn(cmd, args, { env: opts.env, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] })
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

export async function cloneRepo(
  url: string,
  ref: string | undefined,
  deps: CloneDeps
): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
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

  const env: Record<string, string> = {}
  const dropped = new Set(DROPPED_ENV)
  for (const [k, v] of Object.entries(deps.env ?? process.env)) {
    if (typeof v === 'string' && !dropped.has(k.toUpperCase())) env[k] = v
  }
  env.GIT_TERMINAL_PROMPT = '0'
  // Git Credential Manager and ssh must never open a window or prompt either.
  env.GCM_INTERACTIVE = 'never'
  env.SSH_ASKPASS_REQUIRE = 'never'
  env.GIT_ALLOW_PROTOCOL = 'https:ssh'
  // git must never search upward out of the clone and act on a parent repository.
  env.GIT_CEILING_DIRECTORIES = reposDir

  const flags = safetyFlags(deps.isWindows)
  const pin = ['--git-dir', join(root, '.git'), '--work-tree', root]
  const commands = updating
    ? [
        [...flags, ...pin, 'fetch', '--quiet', '--depth', '1', 'origin', ref ?? 'HEAD'],
        [...flags, ...pin, 'reset', '--hard', 'FETCH_HEAD']
      ]
    : [cloneArgs(url, work, ref, deps.isWindows)]

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
  const deadline = now() + CLONE_TIMEOUT_MS
  let failure = ''
  let timedOut = false
  let auth = false
  let failedStep = -1
  try {
    for (const [step, args] of commands.entries()) {
      const left = deadline - now()
      if (left <= 0) {
        timedOut = true
        failedStep = step
        break
      }
      const r = await deps
        .execFile('git', args, { env, timeout: left, signal: ctl.signal })
        .catch((e: unknown) => ({ code: 1, stderr: e instanceof Error ? e.message : String(e) }))
      if (r.code !== 0) {
        failedStep = step
        timedOut = now() >= deadline
        auth = AUTH_RE.test(r.stderr)
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
    return { ok: false, error: auth ? AUTH_MESSAGE : `Couldn't reach that repository: ${failure}` }
  }
  if (!updating) {
    try {
      await (deps.mark ?? writeMarker)(join(work, '.git', CLONE_MARKER))
      await renameWithRetry(deps.rename ?? fsp.rename, deps.sleep ?? sleepMs, work, root)
    } catch {
      await rmq(work)
      return { ok: false, error: FINISH_MESSAGE }
    }
  }
  return { ok: true, root }
}
