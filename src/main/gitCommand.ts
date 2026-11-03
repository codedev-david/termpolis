// Argv-safe wrappers for child_process.
//
// All git IPC handlers funnel through safeGit so shell metacharacters in
// file names, commit messages, or ref names can never be interpreted by a
// shell — they're passed as literal argv entries to the git binary.
//
// swarm:run-command uses isSafeCommand + SAFE_RUNNERS to keep the "run the
// project's test suite" feature from turning into arbitrary RCE if a
// compromised renderer (or unsanitised MCP client) sends a crafted string.

import { promises as fsp } from 'fs'
import { getExtendedPathAsync } from './agentPaths'
import { execOffThread, execCaptureOffThread, execShellCaptureOffThread } from './procClient'

export interface GitOptions {
  cwd: string
  timeout?: number
  maxBuffer?: number
}

// A packaged Electron app (especially on Windows launched from the Start Menu) can inherit a PATH
// without git — which silently broke code indexing, git-root detection, and the status bar. Resolve
// git from common install locations if the PATH lookup ENOENTs, and cache the result.
let resolvedGit: string | null = null
function gitInstallCandidates(): string[] {
  return process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe']
    : ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git', '/bin/git']
}

async function isFile(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Run git with an argv array, off the main thread. (There was a synchronous `safeGit` once, built on
 * `execFileSync`; nothing called it after v1.47.1 and it is gone, so that nothing can again: a synchronous spawn on
 * the main thread freezes every terminal. tests/electron/mainThreadScan.test.ts fails on any new one.)
 *
 * `execFileSync` blocks the main thread for the WHOLE spawn — and on Windows a cold git spawn is
 * ~106 ms of pure process-creation tax (measured; Defender), before git reads a single object. The
 * git status bar polls every 3 s, per repo terminal, and paid that twice: 227 ms (termpolis) to
 * 300 ms (MSI-PAS-CORE) of fully dead main thread per poll — a 7-10% duty cycle, forever, on the
 * thread that pumps every PTY. `async` on the IPC handler bought nothing: execFileSync blocks
 * regardless of what wraps it.
 *
 * Switching to `execFile` did not finish the job either, and that is the v1.47.1 fix. `execFile`
 * awaits the OUTPUT asynchronously but performs the SPAWN synchronously — libuv's uv_spawn is
 * CreateProcess on Windows, on the calling thread — measured at p50 47.9 ms and up to 623 ms per
 * git. So the work now leaves the process entirely: execOffThread hands it to the procHost
 * utilityProcess, where a blocked thread blocks nobody's typing.
 *
 * Argv-safe (shell: false), and a packaged app with no git on PATH finds it in the common install locations.
 */
export async function safeGitAsync(args: string[], opts: GitOptions): Promise<string> {
  const run = (bin: string): Promise<string> => execOffThread(bin, args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 10000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
  })
  const bin = resolvedGit ?? 'git'
  try {
    return await run(bin)
  } catch (e) {
    // `code` still means what it always meant: the string 'ENOENT' when the binary was not found,
    // a number when git ran and refused. ProcError carries it across the process boundary precisely
    // so this branch keeps working.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT' && bin === 'git') {
      for (const candidate of gitInstallCandidates()) {
        if (await isFile(candidate)) {
          resolvedGit = candidate
          return await run(candidate)
        }
      }
    }
    throw e
  }
}

/** Test seam: reset the cached git binary resolution. */
export function _resetGitBinForTests(): void {
  resolvedGit = null
}

// Conservative subset of git-check-ref-format(1): start with alphanumeric,
// then alphanumerics / `.` / `_` / `/` / `-`, max 255 chars. `..` is a range
// operator and is rejected separately. SHAs, branch names, and tags all
// match; shell metacharacters and the `@{…}` upstream syntax do not.
const REF_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}$/
export function isValidGitRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_REGEX.test(ref) && !ref.includes('..')
}

// Allowlisted first tokens for swarm:run-command. The swarm review feature
// runs a project's test suite; every runner listed here is non-interactive
// and exits with a meaningful status code.
export const SAFE_RUNNERS = new Set<string>([
  'npm', 'yarn', 'pnpm', 'bun', 'npx',
  'cargo',
  'python', 'python3', 'pytest',
  'go',
  'deno',
  'make',
  'gradle', 'mvn',
  'jest', 'vitest', 'playwright',
  'tsc', 'tsx',
  'ruby', 'rake', 'bundle',
  'dotnet',
])

// Shell metacharacters we never want in a swarm:run-command string. Even
// though we execute without a shell, rejecting these up-front keeps the
// contract clear: this handler runs one test command, nothing else.
const SHELL_META = /[;&|$`><(){}*?[\]!~"'\n\r\\]/

export interface SafeCommand {
  bin: string
  args: string[]
}

export function parseSafeCommand(command: string): SafeCommand | { error: string } {
  if (!command || !command.trim()) return { error: 'Empty command' }
  const trimmed = command.trim()
  if (SHELL_META.test(trimmed)) {
    return { error: 'Command contains forbidden shell metacharacters' }
  }
  const parts = trimmed.split(/\s+/)
  const bin = parts[0]
  if (!SAFE_RUNNERS.has(bin)) {
    return { error: `Command not in allowlist: ${bin}` }
  }
  return { bin, args: parts.slice(1) }
}

export interface RunResult {
  output: string
  exitCode: number
}

/**
 * Run one of the allow-listed test/build commands, off the main thread, in the proc host. (The synchronous
 * `runSafeCommand` that used to sit beside it is gone: a synchronous child process on the main thread, bounded only by a
 * ten-minute timeout, froze every PTY and every IPC call for as long as `npm test` ran.)
 *
 * Same `RunResult` contract, including the part callers depend on most: a FAILED command is not an
 * exception, it is `{ output, exitCode }` with the command's own output — which for a test runner is
 * the whole point. Note the two shapes node uses for "what exit status": `status` on the sync API,
 * `code` on the async one. Both land here as `error.code`.
 */
export async function runSafeCommandAsync(cmd: SafeCommand, opts: GitOptions): Promise<RunResult> {
  // Same .cmd-shim reasoning as the sync version: parseSafeCommand already rejected every shell
  // metacharacter, so the shell is a PATHEXT resolver here and nothing more.
  const needsShell = process.platform === 'win32'
  const env = { ...process.env, PATH: await getExtendedPathAsync() }
  const procOpts = {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 10 * 60 * 1000,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    env,
  }
  const r = needsShell
    ? await execShellCaptureOffThread([cmd.bin, ...cmd.args].join(' '), procOpts)
    : await execCaptureOffThread(cmd.bin, cmd.args, procOpts)
  if (!r.error) return { output: r.stdout, exitCode: 0 }
  return {
    output: r.stdout + r.stderr,
    exitCode: typeof r.error.code === 'number' ? r.error.code : 1,
  }
}
