// Argv-safe wrappers for child_process.
//
// All git IPC handlers funnel through safeGit so shell metacharacters in
// file names, commit messages, or ref names can never be interpreted by a
// shell — they're passed as literal argv entries to the git binary.
//
// swarm:run-command uses isSafeCommand + SAFE_RUNNERS to keep the "run the
// project's test suite" feature from turning into arbitrary RCE if a
// compromised renderer (or unsanitised MCP client) sends a crafted string.

import { execFileSync, execSync } from 'child_process'
import { existsSync } from 'fs'
import { getExtendedPath, getExtendedPathAsync } from './agentPaths'
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

function runGit(bin: string, args: string[], opts: GitOptions): string {
  return execFileSync(bin, args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: opts.timeout ?? 10000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    windowsHide: true,
    shell: false,
  }).toString()
}

export function safeGit(args: string[], opts: GitOptions): string {
  const bin = resolvedGit ?? 'git'
  try {
    return runGit(bin, args, opts)
  } catch (e) {
    // Only fall back when git itself couldn't be found (not on a real git error like "not a repo").
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT' && bin === 'git') {
      for (const candidate of gitInstallCandidates()) {
        if (existsSync(candidate)) {
          resolvedGit = candidate
          return runGit(candidate, args, opts)
        }
      }
    }
    throw e
  }
}

/**
 * safeGit's non-blocking twin — and since v1.47.1, the one every caller should use.
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
 * Identical argv-safety (shell: false) and identical git-resolution fallback as safeGit — the two
 * must not drift, or a packaged app with no git on PATH would work in one and ENOENT in the other.
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
        if (existsSync(candidate)) {
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
 * A SYNCHRONOUS child process on the main thread, whose only bound is a 10-MINUTE default timeout.
 * Nothing here yields; for however long the subprocess runs, every PTY and every IPC call in the app
 * is dead. Labelled with the actual binary (`exec:git`, `exec:npm`) so a freeze names the command
 * that caused it rather than leaving you to guess which of the app's many git calls it was.
 */
export function runSafeCommand(cmd: SafeCommand, opts: GitOptions): RunResult {
  try {
    // On Windows, npm/yarn/pnpm etc. resolve to .cmd shims which require a
    // shell to run. Since parseSafeCommand already rejected every shell
    // metacharacter, delegating to the shell here is purely a PATHEXT /
    // .cmd resolution shim — the shell has no operators to interpret.
    const needsShell = process.platform === 'win32'
    // A GUI-launched app on macOS inherits launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) —
    // NOT the login shell's — so npm/pnpm/pytest/cargo/go (the whole SAFE_RUNNERS set) live in
    // /opt/homebrew/bin or ~/.nvm and are invisible. The command then ENOENTs, returns exitCode 1,
    // and — worse — the caller records that fabricated "test failed" into the self-competence store.
    // getExtendedPath() is the same login-shell + known-dirs PATH agent detection already uses; it's
    // a superset of the current PATH, so it can only help resolution, never break it. (Windows has
    // npm on the machine PATH, so this is a no-op improvement there.)
    const env = { ...process.env, PATH: getExtendedPath() }
    const buf = needsShell
      ? execSync([cmd.bin, ...cmd.args].join(' '), {
          cwd: opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: opts.timeout ?? 10 * 60 * 1000,
          maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
          windowsHide: true,
          env,
        })
      : execFileSync(cmd.bin, cmd.args, {
          cwd: opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: opts.timeout ?? 10 * 60 * 1000,
          maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
          shell: false,
          windowsHide: true,
          env,
        })
    return { output: buf.toString(), exitCode: 0 }
  } catch (e: any) {
    const output = (e.stdout?.toString() || '') + (e.stderr?.toString() || '')
    return { output, exitCode: typeof e.status === 'number' ? e.status : 1 }
  }
}

/**
 * runSafeCommand's off-thread twin, and the one the IPC handler uses.
 *
 * The sync version's own comment says it best: "for however long the subprocess runs, every PTY and
 * every IPC call in the app is dead" — with a TEN MINUTE default bound. `npm test` on a real project
 * froze the entire app for the length of the test run. Here the run happens in procHost instead, so
 * the only thing waiting is this promise.
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
