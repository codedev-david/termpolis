// Lumopolis git source: opens a world from a git URL by cloning the repository, shallow and read-only,
// into `<userData>/world/repos/<hash>`. A clone is never executed: no install, no scripts, no hooks
// (core.hooksPath points at the null device), and only https and ssh transports are allowed.
//
// Security: a URL or branch name is never allowed to reach git as an option. The URL must match
// `^(https://|ssh://|git@)[^\s]+$`, the branch a conservative character set, both are placed after
// `--` or validated not to start with `-`, and the environment forbids prompts and other protocols.
//
// This runs inside the world host utilityProcess: no Electron imports (worldHostImports.test.ts).
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'

export const BAD_URL_MESSAGE = "That doesn't look like a git URL (https://, ssh:// or git@ only)."
export const BAD_REF_MESSAGE = "That branch name isn't valid."
export const TOO_BIG_MESSAGE = 'That repository is larger than 2 GB, so Lumopolis stopped cloning it.'
export const CANCELLED_MESSAGE = 'Cancelled'
export const CLEAR_MESSAGE = "Lumopolis couldn't clear an earlier partial copy of that repository. Try again in a moment."
export const FINISH_MESSAGE = "Lumopolis couldn't save that repository. Try again in a moment."
/** Written inside `.git` once a clone is complete; only a marked clone is updated in place. */
export const CLONE_MARKER = 'lumopolis-complete'

/** A clone larger than this is aborted and deleted. */
export const MAX_CLONE_BYTES = 2 * 1024 * 1024 * 1024
/** One git command may run this long. */
export const CLONE_TIMEOUT_MS = 5 * 60_000
/** How often the clone's folder size is checked while git runs. */
export const SIZE_POLL_MS = 2000

const URL_RE = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/
const REF_RE = /^[A-Za-z0-9._/-]+$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/

export function validateGitUrl(url: string): { ok: true } | { ok: false; reason: string } {
  if (typeof url !== 'string' || !URL_RE.test(url) || CONTROL_RE.test(url)) return { ok: false, reason: BAD_URL_MESSAGE }
  return { ok: true }
}

function validRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_RE.test(ref) && !ref.startsWith('-') && !ref.includes('..')
}

/** The folder name for a clone: the first 16 hex digits of sha1(url + ref). */
export function cloneKey(url: string, ref?: string): string {
  return createHash('sha1')
    .update(String(url) + (typeof ref === 'string' ? ref : ''))
    .digest('hex')
    .slice(0, 16)
}

/** The flags every git command here carries: no local-file transport, no hooks. */
function safetyFlags(isWindows: boolean): string[] {
  return ['-c', 'protocol.file.allow=never', '-c', `core.hooksPath=${isWindows ? 'NUL' : '/dev/null'}`]
}

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
}
export type ExecFn = (cmd: string, args: string[], opts: ExecOpts) => Promise<{ code: number; stderr: string }>

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
}

// ── Real implementations of the injectable deps ──────────────────────────────────────────────────

/** After an abort or timeout kills git, how long to wait for it to exit before giving up on it. */
export const KILL_GRACE_MS = 10_000

/**
 * Runs git without a shell; never rejects: a non-zero exit, a spawn failure, a timeout and an abort all
 * resolve `{code, stderr}`. It resolves only when the child has CLOSED (exited and its stderr ended), so
 * a caller that removes the folder afterwards is not racing git's last writes; `killGraceMs` bounds
 * the wait when a grandchild keeps stderr open after the kill.
 */
export const nodeExecFile: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stderr = ''
    let settled = false
    let stopped = false
    let timedOut = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let child: ChildProcess
    const finish = (code: number, text: string): void => {
      if (settled) return
      settled = true
      clearTimeout(runTimer)
      clearTimeout(graceTimer)
      opts.signal?.removeEventListener('abort', stop)
      resolve({ code, stderr: text })
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
      child = spawn(cmd, args, { env: opts.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      return finish(1, (e as Error).message)
    }
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < 65536) stderr += c.toString()
    })
    child.on('error', (e) => finish(1, e.message))
    child.on('close', (code) => {
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
  if (ref !== undefined && !validRef(ref)) return { ok: false, error: BAD_REF_MESSAGE }

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
  for (const [k, v] of Object.entries(deps.env ?? process.env)) if (typeof v === 'string') env[k] = v
  env.GIT_TERMINAL_PROMPT = '0'
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

  let failure = ''
  try {
    for (const args of commands) {
      const r = await deps
        .execFile('git', args, { env, timeout: CLONE_TIMEOUT_MS, signal: ctl.signal })
        .catch((e: unknown) => ({ code: 1, stderr: e instanceof Error ? e.message : String(e) }))
      if (r.code !== 0) {
        failure = firstLine(r.stderr)
        break
      }
    }
  } finally {
    clearInterval(timer)
    ext?.removeEventListener('abort', onAbort)
  }

  // A cap hit or a cancel aborts git, which then also looks like a failed exit: check those first.
  if (!tooBig && !ext?.aborted && !failure && (await deps.dirSize(work).catch(() => 0)) > maxBytes) tooBig = true
  if (tooBig) {
    await rmq(work)
    return { ok: false, error: TOO_BIG_MESSAGE }
  }
  if (ext?.aborted) {
    await rmq(work)
    return { ok: false, error: CANCELLED_MESSAGE }
  }
  if (failure) {
    // A failed update leaves the earlier complete clone alone; a failed first clone leaves nothing.
    if (!updating) await rmq(work)
    return { ok: false, error: `Couldn't reach that repository: ${failure}` }
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
