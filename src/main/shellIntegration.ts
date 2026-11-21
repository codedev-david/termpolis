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
 * zsh and fish cannot take a prompt hook from the environment, so theirs comes from files in Termpolis's
 * own data folder (never the user's): a ZDOTDIR of four start-up files for zsh that run the user's own
 * files first, and one file fish sources with --init-command after config.fish.
 *
 * The same integration also gives every one of these shells a `lumopolis` command: it prints one
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

/** What `lumopolis -h` prints, in every shell. No parentheses or apostrophes: cmd and the quoting stay simple. */
export const LUMOPOLIS_USAGE = 'usage: lumopolis [folder] - maps a folder in Lumopolis, this one by default'

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
      param([string]$Path = '.', [Alias('h')][switch]$Help)
      if ($Help -or $Path -eq '--help') { Write-Host '${LUMOPOLIS_USAGE}'; return }
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
 * The body of `lumopolis` for bash and zsh, which share it. Built-ins only: local, [, case, [[, printf, return, each
 * that can be a function or alias name called through `builtin` (zsh defines this after the person's .zshrc, so an
 * alias of theirs named printf would otherwise expand inside it; case and [[ are reserved words).
 * `-h` prints the usage. A relative folder is made absolute against $PWD; a drive with a separator after it
 * (C:\x, C:/x) counts as absolute under Git Bash, while C:foo (relative to the drive) does not. A folder whose
 * name holds a BEL would end the sequence early, so it is refused like a missing one.
 */
const POSIX_LUMOPOLIS_BODY =
  `builtin local p="\${1:-.}"; ` +
  `if builtin [ "$p" = -h ] || builtin [ "$p" = --help ]; then builtin printf '%s\\n' '${LUMOPOLIS_USAGE}'; builtin return 0; fi; ` +
  `case "$p" in /*|[A-Za-z]:[\\\\/]*) ;; *) p="$PWD/$p" ;; esac; ` +
  `if [[ "$p" == *$'\\a'* || ! -d "$p" ]]; then builtin printf 'lumopolis: no such folder: %s\\n' "\${1:-.}" >&2; builtin return 1; fi; ` +
  `builtin printf '\\033]7377;lumopolis;%s;%s\\007' "$${LUMOPOLIS_NONCE_ENV}" "$p"; `

/**
 * bash's `lumopolis`, handed over as an exported function: bash defines every `BASH_FUNC_<name>%%`
 * variable whose value starts with `() {` before it reads any startup file. Not PROMPT_COMMAND, which a
 * .bashrc commonly sets outright; a lumopolis the person defines in their own files simply replaces this one.
 */
export const BASH_FUNCTION_ENV = 'BASH_FUNC_lumopolis%%'
export const BASH_LUMOPOLIS_FUNCTION = `() { ${POSIX_LUMOPOLIS_BODY}}`

/** zsh's `lumopolis`: the same body, defined by name in Termpolis's .zshrc. */
export const ZSH_LUMOPOLIS_FUNCTION = `function lumopolis { ${POSIX_LUMOPOLIS_BODY}}`

/** Where cmd finds its doskey macro file: a quoted path, so a profile folder with spaces or & in it is safe. */
export const CMD_MACROS_ENV = 'TERMPOLIS_LUMOPOLIS_MACROS'

const CMD_PRINT = `<nul set /p "=\x1b]7377;lumopolis;%${LUMOPOLIS_NONCE_ENV}%;`
const CMD_NO_SUCH = 'echo lumopolis: no such folder: %~I'

/**
 * cmd's `lumopolis`, a doskey macro (cmd has no functions). Two commands, $T between them:
 *  1. keep the raw arguments, quotes and all, in __termpolis_lumo (the leading space keeps it set when there are none);
 *  2. clear it and, in the same line (cmd expands %...% before running any of it), read it with its quotes stripped.
 * `for /f` over a quoted string takes the whole text as one folder, with no wildcard expansion, and `tokens=*` drops
 * the leading space. Its %I expands after cmd has parsed the line, so a folder named "x (86)" or "a & b" cannot break
 * the if/else. The inner `for /f "delims=*?"` finds a wildcard: its first piece is then not the whole. No argument
 * means the current folder (%CD%). `if exist "<folder>\"` is true only for a folder, and `set /p` with no input prints
 * the sequence with no newline. All built-ins; @ keeps cmd from echoing them. cmd draws one more prompt for the
 * second command; nothing is left set afterwards.
 */
export const CMD_LUMOPOLIS_MACROS =
  `lumopolis=@set __termpolis_lumo= $*$T@set __termpolis_lumo=& ` +
  `for /f "tokens=*" %I in ("%__termpolis_lumo:"=%") do @for /f "delims=*?" %J in ("x%~I") do ` +
  `@if "%~I"=="" (${CMD_PRINT}%CD%\x07") ` +
  `else if "%~I"=="-h" (echo ${LUMOPOLIS_USAGE}) ` +
  `else if "%~I"=="--help" (echo ${LUMOPOLIS_USAGE}) ` +
  `else if not "%J"=="x%~I" (${CMD_NO_SUCH}) ` +
  `else if exist "%~fI\\" (${CMD_PRINT}%~fI\x07") ` +
  `else ${CMD_NO_SUCH}\r\n`

/** Where Termpolis passes a ZDOTDIR of the person's own to its zsh start-up files. */
export const ZSH_USER_ZDOTDIR_ENV = 'TERMPOLIS_USER_ZDOTDIR'
/**
 * Termpolis's zsh folder again, for .zshenv to read back instead of $ZDOTDIR: zsh 5.9 rewrites ZDOTDIR's stored value
 * in place as it opens $ZDOTDIR/.zshenv (getsparam_u in sourcehome), so a folder with a letter whose UTF-8 has a byte
 * in zsh's meta range (ß, č, П) reads back with that byte gone, and every hand-back would then point at no folder.
 */
export const ZSH_DIR_ENV = 'TERMPOLIS_ZSH_DIR'

// The pieces of Termpolis's zsh start-up files. zsh reads $ZDOTDIR/.zshenv, then .zprofile (login shells), .zshrc
// (interactive) and .zlogin (login), and looks ZDOTDIR up again before each. Each file of ours puts the person's
// ZDOTDIR back (or none: $HOME), runs their file of the same name at the top level, as zsh would, then, when zsh will
// read another file, points ZDOTDIR at ours again. `builtin` everywhere, so a function or alias of the person's named
// source, unset or printf changes nothing.
const ZSH_RESTORE = 'if [[ -n "${__termpolis_user_zdotdir-}" ]]; then ZDOTDIR="$__termpolis_user_zdotdir"; else builtin unset ZDOTDIR; fi'
const zshSource = (file: string): string => `if [[ -r "\${ZDOTDIR:-$HOME}/${file}" ]]; then builtin source "\${ZDOTDIR:-$HOME}/${file}"; fi`
const ZSH_HANDBACK = '__termpolis_user_zdotdir="${ZDOTDIR-}"; ZDOTDIR="$__termpolis_zdotdir"'
const ZSH_DONE = 'builtin unset __termpolis_zdotdir __termpolis_user_zdotdir'
const ZSH_HEADER = '# Termpolis shell integration for zsh, written by Termpolis on each run. It runs your own file first.\n'

export const ZSH_ZSHENV = ZSH_HEADER +
  `__termpolis_zdotdir="\${${ZSH_DIR_ENV}:-$ZDOTDIR}"\n` +
  `__termpolis_user_zdotdir="\${${ZSH_USER_ZDOTDIR_ENV}-}"\n` +
  `builtin unset ${ZSH_DIR_ENV} ${ZSH_USER_ZDOTDIR_ENV}\n` +
  `${ZSH_RESTORE}\n` +
  `${zshSource('.zshenv')}\n` +
  // A shell that reads nothing more (a script; start-up files switched off) keeps the person's ZDOTDIR.
  `if [[ -o rcs ]] && [[ -o interactive || -o login ]]; then ${ZSH_HANDBACK}; else ${ZSH_DONE}; fi\n` +
  'builtin true\n'

export const ZSH_ZPROFILE = ZSH_HEADER + `${ZSH_RESTORE}\n${zshSource('.zprofile')}\n${ZSH_HANDBACK}\nbuiltin true\n`

/**
 * After the person's .zshrc: a precmd hook that reports the folder with the same OSC 7 as bash, added with
 * add-zsh-hook (or appended to precmd_functions where that is missing) so oh-my-zsh, powerlevel10k and starship keep
 * their own; and `lumopolis`, unless the person has one.
 */
export const ZSH_ZSHRC = ZSH_HEADER +
  `${ZSH_RESTORE}\n` +
  // macOS's /etc/zshrc runs just before this file and sets HISTFILE from ZDOTDIR, which is still ours then.
  'if [[ "${HISTFILE-}" == "$__termpolis_zdotdir/.zsh_history" ]]; then HISTFILE="${ZDOTDIR:-$HOME}/.zsh_history"; fi\n' +
  `${zshSource('.zshrc')}\n` +
  `if [[ -o login ]]; then ${ZSH_HANDBACK}; else ${ZSH_DONE}; fi\n` +
  `function __termpolis_report_cwd { builtin printf '\\033]7;file://%s%s\\007' "\${HOST-}" "$PWD"; }\n` +
  'builtin autoload -Uz add-zsh-hook\n' +
  'if ! add-zsh-hook precmd __termpolis_report_cwd 2>/dev/null; then precmd_functions+=(__termpolis_report_cwd); fi\n' +
  `if ! builtin typeset -f lumopolis >/dev/null 2>&1; then ${ZSH_LUMOPOLIS_FUNCTION}; fi\n` +
  'builtin true\n'

export const ZSH_ZLOGIN = ZSH_HEADER + `${ZSH_RESTORE}\n${zshSource('.zlogin')}\n${ZSH_DONE}\nbuiltin true\n`

/**
 * fish's integration, sourced with --init-command, which fish runs after config.fish and before the first prompt. The
 * fish_prompt event reports the folder with the same OSC 7 as bash (\e and \a are ESC and BEL to fish's printf).
 * `lumopolis` is defined unless the person has one, with the same checks as bash's: `string`, `contains`, `test` and
 * `printf` are fish built-ins.
 */
export const FISH_INTEGRATION_SCRIPT = `# Termpolis shell integration for fish, written by Termpolis on each run.
if not set -q __termpolis_wrapped
    set -g __termpolis_wrapped 1
    function __termpolis_report_cwd --on-event fish_prompt
        builtin printf '\\e]7;file://%s%s\\a' "$hostname" "$PWD"
    end
    if not functions -q lumopolis
        function lumopolis --description 'Map a folder in Lumopolis'
            set -l arg .
            if set -q argv[1]; and test -n "$argv[1]"
                set arg $argv[1]
            end
            if contains -- $arg -h --help
                builtin printf '%s\\n' '${LUMOPOLIS_USAGE}'
                return 0
            end
            set -l p $arg
            if not string match -qr -- '^(/|[A-Za-z]:[/\\x5c])' $p
                set p "$PWD/$p"
            end
            if string match -q -- '*'\\a'*' $p; or not test -d $p
                builtin printf 'lumopolis: no such folder: %s\\n' $arg >&2
                return 1
            end
            builtin printf '\\e]7377;lumopolis;%s;%s\\a' "$${LUMOPOLIS_NONCE_ENV}" $p
        end
    end
end
`

/** A file a shell's integration reads at start-up, kept in Termpolis's own data folder; siblings go beside it. */
export interface IntegrationFile { name: string; content: string; siblings?: IntegrationFile[] }

export const INTEGRATION_FILES = {
  powershell: { name: 'termpolis-shell-integration.ps1', content: POWERSHELL_INTEGRATION_SCRIPT },
  cmd: { name: 'termpolis-lumopolis.doskey', content: CMD_LUMOPOLIS_MACROS },
  zsh: {
    name: 'termpolis-zsh/.zshenv',
    content: ZSH_ZSHENV,
    siblings: [
      { name: '.zprofile', content: ZSH_ZPROFILE },
      { name: '.zshrc', content: ZSH_ZSHRC },
      { name: '.zlogin', content: ZSH_ZLOGIN },
    ],
  },
  fish: { name: 'termpolis-integration.fish', content: FISH_INTEGRATION_SCRIPT },
} satisfies Record<string, IntegrationFile>

/** Every file to put on disk for `file` once its own path is known: itself, then each sibling in the same folder. */
export function integrationFileSet(file: IntegrationFile, path: string): Array<{ path: string; content: string }> {
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return [{ path, content: file.content }, ...(file.siblings ?? []).map((s) => ({ path: dir + s.name, content: s.content }))]
}

/** The file this shell's integration needs on disk, or null when it travels in argv and env alone. */
export function integrationFile(kind: ShellKind): IntegrationFile | null {
  if (kind === 'powershell' || kind === 'pwsh') return INTEGRATION_FILES.powershell
  if (kind === 'cmd') return INTEGRATION_FILES.cmd
  if (kind === 'zsh') return INTEGRATION_FILES.zsh
  if (kind === 'fish') return INTEGRATION_FILES.fish
  return null
}

/** A Windows path (zsh or fish under MSYS2 or Cygwin) with forward slashes, which those shells read; others as given. */
const unixish = (p: string): string => (/^[A-Za-z]:\\/.test(p) ? p.replace(/\\/g, '/') : p)

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
 * fish sources its file with --init-command, which fish runs after config.fish, so the person's own setup
 * comes first. (A vendor_conf.d folder on XDG_DATA_DIRS would also work, but that variable would then reach
 * every program the terminal runs and change where each looks for its data.)
 *
 * Returns [] for every other shell, so the caller can concatenate unconditionally.
 */
export function integrationArgs(kind: ShellKind, scriptPath: string | null): string[] {
  if (!scriptPath) return []
  if (kind === 'cmd') return ['/k', 'doskey', `/macrofile=%${CMD_MACROS_ENV}%`]
  if (kind === 'fish') {
    // A fish single-quoted string: backslash and quote are the only escapes.
    const quoted = unixish(scriptPath).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    return ['--init-command', `builtin source '${quoted}'`]
  }
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
    case 'zsh': {
      // zsh reads its start-up files from $ZDOTDIR: point it at Termpolis's folder of four files (INTEGRATION_FILES.zsh),
      // which run the person's own files first. A ZDOTDIR of their own travels beside it and is put back before their
      // .zshrc runs. Nothing is added when the files could not be written: zsh then starts as it always did.
      if (!scriptPath) break
      const file = unixish(scriptPath)
      const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')))
      out.ZDOTDIR = dir
      out[ZSH_DIR_ENV] = dir
      const theirs = existing.ZDOTDIR
      if (theirs && theirs !== dir) out[ZSH_USER_ZDOTDIR_ENV] = theirs
      break
    }
    // fish's file travels in argv (integrationArgs), so it needs nothing here.
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
 * The PowerShell family (its prompt wrapper), cmd (its doskey macro), zsh (its ZDOTDIR) and fish (its sourced file);
 * bash and unknown shells are env-only.
 */
export function needsScriptFile(kind: ShellKind): boolean {
  return integrationFile(kind) !== null
}
