// Lumopolis git source: opens a world from a git URL by cloning the repository, shallow and read-only,
// into `<userData>/world/repos/<hash>`. A clone is never executed: no install, no scripts, no hooks
// (core.hooksPath points at the null device), and only https and ssh transports are allowed.
//
// Security: a URL or branch name is never allowed to reach git as an option. The URL must match
// `^(https://|ssh://|git@)[^\s]+$`, the branch a conservative character set, both are placed after
// `--` or validated not to start with `-`, and the environment forbids prompts and other protocols.
//
// This runs inside the world host utilityProcess: no Electron imports (worldHostImports.test.ts).
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'

export const BAD_URL_MESSAGE = "That doesn't look like a git URL (https://, ssh:// or git@ only)."
export const BAD_REF_MESSAGE = "That branch name isn't valid."
export const TOO_BIG_MESSAGE = 'That repository is larger than 2 GB, so Lumopolis stopped cloning it.'
export const CANCELLED_MESSAGE = 'Cancelled'

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

/** Runs git without a shell; never rejects: a non-zero exit, a spawn failure and a kill all resolve `{code, stderr}`. */
export const nodeExecFile: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env: opts.env, timeout: opts.timeout, signal: opts.signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (!err) return resolve({ code: 0, stderr: String(stderr) })
        const code = (err as NodeJS.ErrnoException).code
        resolve({ code: typeof code === 'number' ? code : 1, stderr: String(stderr) || err.message })
      }
    )
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

export const removeDir = (p: string): Promise<void> => fsp.rm(p, { recursive: true, force: true })

export const pathExists = (p: string): Promise<boolean> =>
  fsp.access(p).then(
    () => true,
    () => false
  )

// ── cloneRepo ────────────────────────────────────────────────────────────────────────────────────

/** git's first stderr line, without any `user:pass@` the URL carried. */
function firstLine(stderr: string): string {
  const line = stderr.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const clean = line.trim().replace(/\/\/[^/@\s]+@/g, '//***@')
  return clean || 'no details'
}

export async function cloneRepo(
  url: string,
  ref: string | undefined,
  deps: CloneDeps
): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
  const checked = validateGitUrl(url)
  if (!checked.ok) return { ok: false, error: checked.reason }
  if (ref !== undefined && !validRef(ref)) return { ok: false, error: BAD_REF_MESSAGE }

  const root = join(deps.baseDir, 'world', 'repos', cloneKey(url, ref))
  const exists = deps.exists ?? pathExists
  const maxBytes = deps.maxBytes ?? MAX_CLONE_BYTES
  const ext = deps.signal
  if (ext?.aborted) return { ok: false, error: CANCELLED_MESSAGE }

  const updating = await exists(join(root, '.git'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(deps.env ?? process.env)) if (typeof v === 'string') env[k] = v
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ALLOW_PROTOCOL = 'https:ssh'

  const flags = safetyFlags(deps.isWindows)
  const commands = updating
    ? [
        [...flags, '-C', root, 'fetch', '--depth', '1', 'origin', ref ?? 'HEAD'],
        [...flags, '-C', root, 'reset', '--hard', 'FETCH_HEAD']
      ]
    : [cloneArgs(url, root, ref, deps.isWindows)]
  // A leftover folder with no repository in it (an earlier crash) would make git refuse to clone.
  if (!updating) await deps.rm(root)

  const ctl = new AbortController()
  const onAbort = (): void => ctl.abort()
  ext?.addEventListener('abort', onAbort)
  let tooBig = false
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    deps
      .dirSize(root)
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
  if (!tooBig && !ext?.aborted && !failure && (await deps.dirSize(root)) > maxBytes) tooBig = true
  if (tooBig) {
    await deps.rm(root)
    return { ok: false, error: TOO_BIG_MESSAGE }
  }
  if (ext?.aborted) {
    await deps.rm(root)
    return { ok: false, error: CANCELLED_MESSAGE }
  }
  if (failure) {
    // A failed update leaves the earlier complete clone alone; a failed first clone leaves nothing.
    if (!updating) await deps.rm(root)
    return { ok: false, error: `Couldn't reach that repository: ${failure}` }
  }
  return { ok: true, root }
}
