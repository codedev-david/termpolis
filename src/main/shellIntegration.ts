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
 * The same integration also gives bash, PowerShell and cmd a `lumopolis` command: it prints one
 * private OSC 7377 sequence (src/shared/world/lumopolisCommand.ts) that opens the Lumopolis pane on a
 * folder. Each version checks the folder exists with the shell's own built-ins, prints
 * `lumopolis: no such folder: <path>` when it does not, and starts no process and touches no network.
 *
 * Pure and injectable so every shell dialect is testable on any platform.
 */

import { LUMOPOLIS_NONCE_ENV } from '../shared/world/lumopolisCommand'

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
  # lumopolis [folder]: opens the Lumopolis pane on a folder (this one by default). A lumopolis of the
  # person's own, from their profile, is left alone.
  if (-not (Test-Path Function:\\lumopolis)) {
    function global:lumopolis {
      param([string]$Path = '.')
      $full = $null
      try { $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path) } catch { }
      if (-not $full -or -not [System.IO.Directory]::Exists($full)) {
        Write-Host "lumopolis: no such folder: $Path"
        return
      }
      [Console]::Write("$([char]27)]7377;lumopolis;$env:${LUMOPOLIS_NONCE_ENV};$full$([char]7)")
    }
  }
}
`

/**
 * bash's `lumopolis`, handed over as an exported function: bash defines every `BASH_FUNC_<name>%%`
 * variable whose value starts with `() {` before it reads any startup file. Not PROMPT_COMMAND, which a
 * .bashrc commonly sets outright; a lumopolis the person defines in their own files simply replaces this
 * one. Built-ins only: local, case, [, printf. A relative folder is made absolute against $PWD; Windows
 * drive paths (C:\x, C:/x) count as absolute under Git Bash.
 */
export const BASH_FUNCTION_ENV = 'BASH_FUNC_lumopolis%%'
export const BASH_LUMOPOLIS_FUNCTION =
  `() { local p="\${1:-.}"; ` +
  `case "$p" in /*|[A-Za-z]:*) ;; *) p="$PWD/$p" ;; esac; ` +
  `if [ ! -d "$p" ]; then printf 'lumopolis: no such folder: %s\\n' "\${1:-.}" >&2; return 1; fi; ` +
  `printf '\\033]7377;lumopolis;%s;%s\\007' "$${LUMOPOLIS_NONCE_ENV}" "$p"; }`

/** Where cmd finds its doskey macro file: a quoted path, so a profile folder with spaces or & in it is safe. */
export const CMD_MACROS_ENV = 'TERMPOLIS_LUMOPOLIS_MACROS'

/**
 * cmd's `lumopolis`, a doskey macro (cmd has no functions). `for` with `%~f` makes the last argument (or `.`)
 * a full path, `if exist "<folder>\"` is true only for a folder, and `set /p` with no input prints the
 * sequence with no newline. All built-ins. $T separates the commands; @ keeps cmd from echoing them. cmd
 * draws one more prompt for each command after the first, so there are two and __termpolis_lumo stays set.
 */
export const CMD_LUMOPOLIS_MACROS =
  `lumopolis=for %I in (. $*) do @set "__termpolis_lumo=%~fI"` +
  `$T@if exist "%__termpolis_lumo%\\" (<nul set /p "=\x1b]7377;lumopolis;%${LUMOPOLIS_NONCE_ENV}%;%__termpolis_lumo%\x07")` +
  ` else (echo lumopolis: no such folder: $*)\r\n`

/** A file a shell's integration reads at start-up, kept in Termpolis's own data folder. */
export interface IntegrationFile { name: string; content: string }

export const INTEGRATION_FILES = {
  powershell: { name: 'termpolis-shell-integration.ps1', content: POWERSHELL_INTEGRATION_SCRIPT },
  cmd: { name: 'termpolis-lumopolis.doskey', content: CMD_LUMOPOLIS_MACROS },
} satisfies Record<string, IntegrationFile>

/** The file this shell's integration needs on disk, or null when it travels in argv and env alone. */
export function integrationFile(kind: ShellKind): IntegrationFile | null {
  if (kind === 'powershell' || kind === 'pwsh') return INTEGRATION_FILES.powershell
  if (kind === 'cmd') return INTEGRATION_FILES.cmd
  return null
}

/**
 * Extra argv for shells whose integration cannot be delivered through the environment.
 *
 * PowerShell has no environment hook equivalent to PROMPT_COMMAND, so the wrapper has to
 * be dot-sourced from the command line. `-NoExit` keeps the session interactive afterwards —
 * without it the shell would run the script and exit, which would close the terminal the
 * instant it opened.
 *
 * cmd loads its `lumopolis` macro with `/k doskey /macrofile=...`, then stays interactive.
 * The path travels in CMD_MACROS_ENV, which cmd expands itself: node-pty would escape the
 * quotes a path with spaces needs if they were in argv.
 *
 * Returns [] for every other shell, so the caller can concatenate unconditionally.
 */
export function integrationArgs(kind: ShellKind, scriptPath: string | null): string[] {
  if (!scriptPath) return []
  if (kind === 'cmd') return ['/k', 'doskey', `/macrofile=%${CMD_MACROS_ENV}%`]
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
 *
 * `scriptPath` is the shell's integration file (integrationFile), where it has one.
 */
export function integrationEnv(
  kind: ShellKind,
  existing: Record<string, string | undefined> = {},
  scriptPath: string | null = null,
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
      out[BASH_FUNCTION_ENV] = BASH_LUMOPOLIS_FUNCTION
      break
    }
    case 'cmd': {
      // cmd has no prompt hook, but PROMPT itself is expanded fresh each time it is
      // drawn: $e is ESC, $p the current directory, $g '>'. So the sequence can simply
      // be prefixed to whatever prompt string they already use.
      const prior = existing.PROMPT && existing.PROMPT.trim() ? existing.PROMPT : '$p$g'
      out.PROMPT = `$e]9;9;$p$e\\${prior}`
      if (scriptPath) out[CMD_MACROS_ENV] = `"${scriptPath}"`
      break
    }
    // zsh and fish are deliberately absent (so they have no `lumopolis` command either). Neither honours an environment-supplied
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
 * Does this shell need a file on disk before it can be integrated?
 * The PowerShell family (its prompt wrapper) and cmd (its doskey macro); everything else is env-only.
 */
export function needsScriptFile(kind: ShellKind): boolean {
  return integrationFile(kind) !== null
}
