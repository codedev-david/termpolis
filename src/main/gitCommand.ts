// Argv-safe wrappers for child_process.
//
// All git IPC handlers funnel through safeGit so shell metacharacters in
// file names, commit messages, or ref names can never be interpreted by a
// shell — they're passed as literal argv entries to the git binary.
//
// swarm:run-command uses isSafeCommand + SAFE_RUNNERS to keep the "run the
// project's test suite" feature from turning into arbitrary RCE if a
// compromised renderer (or unsanitised MCP client) sends a crafted string.

import { execFileSync, execSync, execFile } from 'child_process'
import { existsSync } from 'fs'

/** Hand-rolled rather than `promisify(execFile)` at module scope: promisify resolves its argument
 *  AT IMPORT, so any test that mocks child_process without an `execFile` (several do — they only
 *  need execFileSync) would crash the whole module on load. Touch `execFile` when CALLED, not when
 *  imported. */
function execFileAsync(
  bin: string,
  args: string[],
  opts: Parameters<typeof execFile>[2],
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, opts, (err, stdout) => {
      if (err) reject(err)
      else resolve({ stdout: String(stdout) })
    })
  })
}

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
 * safeGit's non-blocking twin, for anything on a POLL.
 *
 * `execFileSync` blocks the main thread for the WHOLE spawn — and on Windows a cold git spawn is
 * ~106 ms of pure process-creation tax (measured; Defender), before git reads a single object. The
 * git status bar polls every 3 s, per repo terminal, and paid that twice: 227 ms (termpolis) to
 * 300 ms (MSI-PAS-CORE) of fully dead main thread per poll — a 7-10% duty cycle, forever, on the
 * thread that pumps every PTY. `async` on the IPC handler bought nothing: execFileSync blocks
 * regardless of what wraps it.
 *
 * Identical argv-safety (shell: false) and identical git-resolution fallback as safeGit — the two
 * must not drift, or a packaged app with no git on PATH would work in one and ENOENT in the other.
 */
export async function safeGitAsync(args: string[], opts: GitOptions): Promise<string> {
  const run = async (bin: string): Promise<string> => {
    const { stdout } = await execFileAsync(bin, args, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 10000,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
      windowsHide: true,
      shell: false,
    })
    return stdout.toString()
  }
  const bin = resolvedGit ?? 'git'
  try {
    return await run(bin)
  } catch (e) {
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
    const buf = needsShell
      ? execSync([cmd.bin, ...cmd.args].join(' '), {
          cwd: opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: opts.timeout ?? 10 * 60 * 1000,
          maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
          windowsHide: true,
        })
      : execFileSync(cmd.bin, cmd.args, {
          cwd: opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: opts.timeout ?? 10 * 60 * 1000,
          maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
          shell: false,
          windowsHide: true,
        })
    return { output: buf.toString(), exitCode: 0 }
  } catch (e: any) {
    const output = (e.stdout?.toString() || '') + (e.stderr?.toString() || '')
    return { output, exitCode: typeof e.status === 'number' ? e.status : 1 }
  }
}
