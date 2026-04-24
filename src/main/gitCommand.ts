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

export interface GitOptions {
  cwd: string
  timeout?: number
  maxBuffer?: number
}

export function safeGit(args: string[], opts: GitOptions): string {
  const buf = execFileSync('git', args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: opts.timeout ?? 10000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    windowsHide: true,
    shell: false,
  })
  return buf.toString()
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
