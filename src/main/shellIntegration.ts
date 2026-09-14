/**
 * Teaching each shell to announce where it is.
 *
 * The git mark needs the directory a terminal is CURRENTLY in, not the one it was
 * launched in. On Linux and macOS that is already answerable — terminalManager reads
 * /proc/<pid>/cwd or asks lsof. On Windows there is no supported way to read a live
 * child's working directory without cooperation from the shell itself, so before this
 * module the mark was frozen at the launch directory for the life of the terminal:
 * `cd` into a repo and nothing happened.
 *
 * The fix is the same one every serious terminal uses (VS Code, Windows Terminal,
 * iTerm2): have the shell emit an escape sequence containing its directory every time
 * it draws a prompt. Two sequences are in use in the wild and we emit whichever suits
 * the shell:
 *
 *   OSC 7   ESC ] 7 ; file://<host>/<path> BEL     the cross-platform standard
 *   OSC 9;9 ESC ] 9 ; 9 ; <path> BEL               ConEmu/Windows Terminal, raw path
 *
 * Both are invisible to the user: a terminal that understands them consumes them, and
 * this app registers handlers for both. Nothing is echoed into the visible buffer.
 *
 * Design constraints that shaped every choice below:
 *
 *  - NEVER break the user's prompt. A broken prompt is a broken terminal, which is far
 *    worse than a git mark that does not update. So we WRAP the existing prompt rather
 *    than replace it, and every wrapper swallows its own errors.
 *  - Never modify anything on disk that the user owns. No writes to .bashrc, $PROFILE
 *    or the registry. Integration lives entirely in the spawned process's argv and env
 *    and dies with it.
 *  - Be switchable off. TERMPOLIS_DISABLE_SHELL_INTEGRATION=1 restores the exact old
 *    spawn, because an escape hatch you can describe over the phone is worth more than
 *    any amount of confidence in the happy path.
 *
 * Pure and injectable so every shell dialect is testable on any platform.
 */

export type ShellKind = 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'unknown'

/** Set inside every integrated shell: lets a nested shell skip re-wrapping. */
export const INTEGRATION_MARKER = 'TERMPOLIS_SHELL_INTEGRATION'

/** The user's escape hatch. Any truthy value restores the pre-integration spawn. */
export const DISABLE_FLAG = 'TERMPOLIS_DISABLE_SHELL_INTEGRATION'

/**
 * Which shell is this executable? Matched on the basename so it works for
 * `C:\Program Files\Git\bin\bash.exe`, `/usr/bin/zsh` and a bare `pwsh` alike.
 */
export function detectShellKind(executable: string): ShellKind {
  if (!executable) return 'unknown'
  const base = executable.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  const stem = base.replace(/\.exe$/, '')
  switch (stem) {
    case 'powershell': return 'powershell'
    case 'pwsh': return 'pwsh'
    case 'cmd': return 'cmd'
    case 'bash': case 'sh': return 'bash'
    case 'zsh': return 'zsh'
    case 'fish': return 'fish'
    default: return 'unknown'
  }
}

/**
 * The PowerShell prompt wrapper, dot-sourced at startup.
 *
 * Runs AFTER the user's $PROFILE (because -Command runs after profile load), so it
 * wraps whatever prompt they ended up with rather than fighting it. Re-entrant by
 * design: a nested PowerShell inside an integrated one must not wrap twice, or every
 * prompt would emit the sequence N times.
 *
 * `(Get-Location).ProviderPath` rather than `$PWD`: inside a PSDrive (or a UNC-mapped
 * location) $PWD is a provider path like `HKLM:\Software` that no filesystem call can
 * open, while ProviderPath is the real one. If the current location has no filesystem
 * path at all it comes back empty and we simply say nothing that prompt.
 */
export const POWERSHELL_INTEGRATION_SCRIPT = `# Termpolis shell integration — reports the working directory to the app.
# Loaded with -NoExit -Command; safe to dot-source twice.
if (-not $global:__termpolis_wrapped) {
  $global:__termpolis_wrapped = $true
  $global:__termpolis_inner_prompt = $function:prompt
  function global:prompt {
    $rendered = ''
    try {
      if ($global:__termpolis_inner_prompt) { $rendered = & $global:__termpolis_inner_prompt }
    } catch { $rendered = '' }
    if ([string]::IsNullOrEmpty($rendered)) { $rendered = "PS $($ExecutionContext.SessionState.Path.CurrentLocation)> " }
    try {
      $tp = (Get-Location).ProviderPath
      if ($tp) { [Console]::Write("$([char]27)]9;9;$tp$([char]7)") }
    } catch { }
    return $rendered
  }
}
`

/**
 * Extra argv for shells whose integration cannot be delivered through the environment.
 *
 * Only PowerShell needs this: it has no environment hook equivalent to PROMPT_COMMAND,
 * so the wrapper has to be dot-sourced from the command line. `-NoExit` keeps the
 * session interactive afterwards — without it the shell would run the script and exit,
 * which would close the terminal the instant it opened.
 *
 * Returns [] for every other shell, so the caller can concatenate unconditionally.
 */
export function integrationArgs(kind: ShellKind, scriptPath: string | null): string[] {
  if (!scriptPath) return []
  if (kind !== 'powershell' && kind !== 'pwsh') return []
  // Single quotes are PowerShell's literal string; a quote inside a path is escaped by
  // doubling it. Paths under a user profile can contain almost anything.
  const quoted = scriptPath.replace(/'/g, "''")
  return ['-NoExit', '-Command', `. '${quoted}'`]
}

/**
 * Environment additions that make a shell report its directory.
 *
 * `existing` is the environment the child will otherwise inherit; it is read, never
 * mutated, so an existing PROMPT/PROMPT_COMMAND can be preserved and chained rather
 * than clobbered. Losing someone's customised prompt to gain a git mark is not a
 * trade this app gets to make on their behalf.
 */
export function integrationEnv(
  kind: ShellKind,
  existing: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {}

  switch (kind) {
    case 'bash': {
      // bash evaluates PROMPT_COMMAND before drawing each prompt, and honours one
      // inherited from the environment. $PWD is MSYS-shaped under Git Bash
      // (/c/Users/...); the renderer's path normalizer converts it.
      //
      // BEL terminates the sequence instead of ST purely to keep the escaping legible:
      // ST is ESC-backslash, which would need four levels of backslash by the time it
      // reaches printf through a JS string and an env var.
      const report = `printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-}" "$PWD"`
      const prior = existing.PROMPT_COMMAND
      // Ours first: if the user's own command errors or exits non-zero, the report has
      // already been written.
      out.PROMPT_COMMAND = prior ? `${report}; ${prior}` : report
      break
    }
    case 'cmd': {
      // cmd has no prompt hook, but PROMPT itself is expanded fresh each time it is
      // drawn: $e is ESC, $p the current directory, $g '>'. So the sequence can simply
      // be prefixed to whatever prompt string they already use.
      const prior = existing.PROMPT && existing.PROMPT.trim() ? existing.PROMPT : '$p$g'
      out.PROMPT = `$e]9;9;$p$e\\${prior}`
      break
    }
    // zsh and fish are deliberately absent. Neither honours an environment-supplied
    // prompt hook, so integrating them means writing a ZDOTDIR or a vendor conf dir —
    // real files, in the user's world, that outlive a crash. Both shells are POSIX-only
    // in practice, and on POSIX terminalManager can already read the live cwd straight
    // from /proc or lsof, which needs no cooperation from the shell at all. The cost is
    // not worth paying for a capability we already have there.
    default:
      break
  }

  if (Object.keys(out).length > 0) out[INTEGRATION_MARKER] = '1'
  return out
}

/** Has the user switched integration off? */
export function integrationDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[DISABLE_FLAG]
  return !!v && v !== '0' && v.toLowerCase() !== 'false'
}

/**
 * Does this shell need a script file on disk before it can be integrated?
 * Only the PowerShell family; everything else is env-only.
 */
export function needsScriptFile(kind: ShellKind): boolean {
  return kind === 'powershell' || kind === 'pwsh'
}
