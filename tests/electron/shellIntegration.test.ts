import { describe, it, expect } from 'vitest'
import {
  detectShellKind,
  integrationArgs,
  integrationEnv,
  integrationDisabled,
  needsScriptFile,
  POWERSHELL_INTEGRATION_SCRIPT,
  INTEGRATION_MARKER,
  DISABLE_FLAG,
  BASH_FUNCTION_ENV,
  BASH_LUMOPOLIS_FUNCTION,
  CMD_LUMOPOLIS_MACROS,
  CMD_MACROS_ENV,
  INTEGRATION_FILES,
  integrationFile,
  integrationFileSet,
  LUMOPOLIS_USAGE,
  ZSH_DIR_ENV,
  ZSH_USER_ZDOTDIR_ENV,
  ZSH_ZSHENV,
  ZSH_ZPROFILE,
  ZSH_ZSHRC,
  ZSH_ZLOGIN,
  ZSH_LUMOPOLIS_FUNCTION,
  FISH_INTEGRATION_SCRIPT,
} from '../../src/main/shellIntegration'

describe('detectShellKind', () => {
  it('identifies each shell from a full path', () => {
    expect(detectShellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('powershell')
    expect(detectShellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh')
    expect(detectShellKind('C:\\Windows\\System32\\cmd.exe')).toBe('cmd')
    expect(detectShellKind('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash')
    expect(detectShellKind('/usr/bin/zsh')).toBe('zsh')
    expect(detectShellKind('/usr/local/bin/fish')).toBe('fish')
  })

  it('identifies a bare command name', () => {
    expect(detectShellKind('bash')).toBe('bash')
    expect(detectShellKind('pwsh')).toBe('pwsh')
  })

  it('treats sh as bash for prompt-hook purposes', () => {
    // dash ignores PROMPT_COMMAND rather than erroring, so this is safe.
    expect(detectShellKind('/bin/sh')).toBe('bash')
  })

  it('is case-insensitive about the executable name', () => {
    expect(detectShellKind('C:\\WINDOWS\\SYSTEM32\\CMD.EXE')).toBe('cmd')
  })

  it('returns unknown for an unrecognised or empty executable', () => {
    expect(detectShellKind('/usr/bin/nu')).toBe('unknown')
    expect(detectShellKind('')).toBe('unknown')
  })
})

describe('integrationArgs', () => {
  it('dot-sources the wrapper for the PowerShell family and keeps the session open', () => {
    expect(integrationArgs('powershell', 'C:\\scripts\\si.ps1'))
      .toEqual(['-NoExit', '-Command', ". 'C:\\scripts\\si.ps1'"])
    expect(integrationArgs('pwsh', '/tmp/si.ps1'))
      .toEqual(['-NoExit', '-Command', ". '/tmp/si.ps1'"])
  })

  it("escapes a single quote in the script path by doubling it", () => {
    expect(integrationArgs('powershell', "C:\\Users\\o'brien\\si.ps1"))
      .toEqual(['-NoExit', '-Command', ". 'C:\\Users\\o''brien\\si.ps1'"])
  })

  it("loads cmd's lumopolis macro with doskey, the file named through the environment (no quotes in argv)", () => {
    expect(integrationArgs('cmd', 'C:\\Users\\a b\\termpolis-lumopolis.doskey')).toEqual(['/k', 'doskey', '/macrofile=%TERMPOLIS_LUMOPOLIS_MACROS%'])
    expect(integrationArgs('cmd', null)).toEqual([])
  })

  it('adds nothing for shells integrated through the environment', () => {
    for (const kind of ['bash', 'zsh', 'unknown'] as const) {
      expect(integrationArgs(kind, '/tmp/si.ps1')).toEqual([])
    }
  })

  it('adds nothing when no script was written', () => {
    expect(integrationArgs('powershell', null)).toEqual([])
    expect(integrationArgs('fish', null)).toEqual([])
  })

  it('fish sources its file with --init-command, which runs after config.fish; quotes and backslashes escaped', () => {
    expect(integrationArgs('fish', '/home/a/.config/Termpolis/termpolis-integration.fish'))
      .toEqual(['--init-command', "builtin source '/home/a/.config/Termpolis/termpolis-integration.fish'"])
    expect(integrationArgs('fish', "/home/o'neil/x\\y/termpolis-integration.fish"))
      .toEqual(['--init-command', "builtin source '/home/o\\'neil/x\\\\y/termpolis-integration.fish'"])
    // A Windows data folder (fish under MSYS2/Cygwin) is handed over with forward slashes.
    expect(integrationArgs('fish', 'C:\\Users\\a\\AppData\\Roaming\\Termpolis\\termpolis-integration.fish'))
      .toEqual(['--init-command', "builtin source 'C:/Users/a/AppData/Roaming/Termpolis/termpolis-integration.fish'"])
  })
})

describe('integrationEnv', () => {
  it('gives bash a PROMPT_COMMAND that reports the directory over OSC 7', () => {
    const env = integrationEnv('bash')
    expect(env.PROMPT_COMMAND).toContain(']7;file://')
    expect(env.PROMPT_COMMAND).toContain('$PWD')
    expect(env[INTEGRATION_MARKER]).toBe('1')
  })

  it("chains onto the user's existing PROMPT_COMMAND rather than replacing it", () => {
    const env = integrationEnv('bash', { PROMPT_COMMAND: 'history -a' })
    expect(env.PROMPT_COMMAND).toMatch(/;\s*history -a$/)
    // Ours runs first so a failing user command cannot suppress the report.
    expect(env.PROMPT_COMMAND!.indexOf(']7;file://')).toBeLessThan(
      env.PROMPT_COMMAND!.indexOf('history -a'),
    )
  })

  it('gives cmd a PROMPT that prefixes OSC 9;9 to the default prompt', () => {
    const env = integrationEnv('cmd')
    expect(env.PROMPT).toBe('$e]9;9;$p$e\\$p$g')
    expect(env[INTEGRATION_MARKER]).toBe('1')
  })

  it("names cmd's macro file, quoted, only when there is one", () => {
    expect(integrationEnv('cmd', {}, 'C:\\Users\\a b\\m.doskey')[CMD_MACROS_ENV]).toBe('"C:\\Users\\a b\\m.doskey"')
    expect(integrationEnv('cmd')).not.toHaveProperty(CMD_MACROS_ENV)
  })

  it('hands bash its lumopolis function as an exported function, whatever PROMPT_COMMAND the person has', () => {
    expect(integrationEnv('bash')[BASH_FUNCTION_ENV]).toBe(BASH_LUMOPOLIS_FUNCTION)
    expect(integrationEnv('bash', { PROMPT_COMMAND: 'history -a' })[BASH_FUNCTION_ENV]).toBe(BASH_LUMOPOLIS_FUNCTION)
    expect(BASH_FUNCTION_ENV).toBe('BASH_FUNC_lumopolis%%')
  })

  it("preserves a custom cmd PROMPT", () => {
    const env = integrationEnv('cmd', { PROMPT: '$t$g' })
    expect(env.PROMPT).toBe('$e]9;9;$p$e\\$t$g')
  })

  it('ignores a blank custom PROMPT and falls back to the default', () => {
    expect(integrationEnv('cmd', { PROMPT: '   ' }).PROMPT).toBe('$e]9;9;$p$e\\$p$g')
  })

  it('adds nothing for fish (its file travels in argv) and unknown shells, nor for zsh without its files', () => {
    for (const kind of ['zsh', 'fish', 'unknown'] as const) {
      expect(integrationEnv(kind)).toEqual({})
    }
    expect(integrationEnv('fish', {}, '/data/termpolis-integration.fish')).toEqual({})
  })

  it("zsh: ZDOTDIR points at Termpolis's folder, and a ZDOTDIR of the person's own travels beside it", () => {
    // The folder travels twice: ZDOTDIR for zsh to find the files, and a copy of our own for .zshenv to read back,
    // because zsh 5.9 rewrites ZDOTDIR's stored value in place as it opens $ZDOTDIR/.zshenv (getsparam_u in
    // sourcehome): a letter with a byte in zsh's meta range (ß, č, П) then reads back with that byte gone.
    expect(integrationEnv('zsh', {}, '/home/a/.config/Termpolis/termpolis-zsh/.zshenv')).toEqual({
      ZDOTDIR: '/home/a/.config/Termpolis/termpolis-zsh',
      [ZSH_DIR_ENV]: '/home/a/.config/Termpolis/termpolis-zsh',
      [INTEGRATION_MARKER]: '1',
    })
    expect(integrationEnv('zsh', { ZDOTDIR: '/home/a/.config/zsh' }, '/d/termpolis-zsh/.zshenv')).toEqual({
      ZDOTDIR: '/d/termpolis-zsh',
      [ZSH_DIR_ENV]: '/d/termpolis-zsh',
      [ZSH_USER_ZDOTDIR_ENV]: '/home/a/.config/zsh',
      [INTEGRATION_MARKER]: '1',
    })
    expect(ZSH_USER_ZDOTDIR_ENV).toBe('TERMPOLIS_USER_ZDOTDIR')
    expect(ZSH_DIR_ENV).toBe('TERMPOLIS_ZSH_DIR')
    // Inherited from a parent that was itself one of ours: not the person's, so not passed on as theirs.
    expect(integrationEnv('zsh', { ZDOTDIR: '/d/termpolis-zsh' }, '/d/termpolis-zsh/.zshenv')[ZSH_USER_ZDOTDIR_ENV]).toBeUndefined()
    // An empty ZDOTDIR means $HOME to zsh, the same as none.
    expect(integrationEnv('zsh', { ZDOTDIR: '' }, '/d/termpolis-zsh/.zshenv')[ZSH_USER_ZDOTDIR_ENV]).toBeUndefined()
    expect(integrationEnv('zsh', {}, 'C:\\Users\\a\\Termpolis\\termpolis-zsh\\.zshenv').ZDOTDIR).toBe('C:/Users/a/Termpolis/termpolis-zsh')
  })

  it('does not mutate the environment it was handed', () => {
    const existing = { PROMPT_COMMAND: 'history -a' }
    integrationEnv('bash', existing)
    expect(existing).toEqual({ PROMPT_COMMAND: 'history -a' })
  })

  it('defaults to an empty environment when none is supplied', () => {
    expect(integrationEnv('bash').PROMPT_COMMAND).toBeTruthy()
  })
})

describe('integrationDisabled', () => {
  it('is off by default', () => {
    expect(integrationDisabled({})).toBe(false)
  })

  it('treats explicit falsey values as not disabled', () => {
    expect(integrationDisabled({ [DISABLE_FLAG]: '0' })).toBe(false)
    expect(integrationDisabled({ [DISABLE_FLAG]: 'false' })).toBe(false)
    expect(integrationDisabled({ [DISABLE_FLAG]: 'FALSE' })).toBe(false)
    expect(integrationDisabled({ [DISABLE_FLAG]: '' })).toBe(false)
  })

  it('treats any other value as disabled', () => {
    expect(integrationDisabled({ [DISABLE_FLAG]: '1' })).toBe(true)
    expect(integrationDisabled({ [DISABLE_FLAG]: 'yes' })).toBe(true)
  })

  it('reads process.env when no environment is supplied', () => {
    expect(typeof integrationDisabled()).toBe('boolean')
  })
})

describe('needsScriptFile', () => {
  it('is true for every shell but bash (env only) and unknown ones', () => {
    for (const kind of ['powershell', 'pwsh', 'cmd', 'zsh', 'fish'] as const) {
      expect(needsScriptFile(kind)).toBe(true)
    }
    for (const kind of ['bash', 'unknown'] as const) {
      expect(needsScriptFile(kind)).toBe(false)
    }
  })

  it('names each file: the PowerShell script and the doskey macros', () => {
    expect(integrationFile('powershell')).toBe(INTEGRATION_FILES.powershell)
    expect(integrationFile('pwsh')).toEqual({ name: 'termpolis-shell-integration.ps1', content: POWERSHELL_INTEGRATION_SCRIPT })
    expect(integrationFile('cmd')).toEqual({ name: 'termpolis-lumopolis.doskey', content: CMD_LUMOPOLIS_MACROS })
    expect(integrationFile('zsh')).toBe(INTEGRATION_FILES.zsh)
    expect(integrationFile('fish')).toEqual({ name: 'termpolis-integration.fish', content: FISH_INTEGRATION_SCRIPT })
    expect(integrationFile('bash')).toBeNull()
  })

  it("zsh's four start-up files live together in Termpolis's own folder, .zshenv first", () => {
    const z = INTEGRATION_FILES.zsh
    expect(z.name).toBe('termpolis-zsh/.zshenv')
    expect(z.content).toBe(ZSH_ZSHENV)
    expect(z.siblings).toEqual([
      { name: '.zprofile', content: ZSH_ZPROFILE },
      { name: '.zshrc', content: ZSH_ZSHRC },
      { name: '.zlogin', content: ZSH_ZLOGIN },
    ])
  })

  it('integrationFileSet: the file at its path, each sibling beside it, on either separator', () => {
    expect(integrationFileSet(INTEGRATION_FILES.cmd, 'C:\\d\\termpolis-lumopolis.doskey')).toEqual([
      { path: 'C:\\d\\termpolis-lumopolis.doskey', content: CMD_LUMOPOLIS_MACROS },
    ])
    expect(integrationFileSet(INTEGRATION_FILES.zsh, '/u/termpolis-zsh/.zshenv').map((f) => f.path)).toEqual([
      '/u/termpolis-zsh/.zshenv', '/u/termpolis-zsh/.zprofile', '/u/termpolis-zsh/.zshrc', '/u/termpolis-zsh/.zlogin',
    ])
    expect(integrationFileSet(INTEGRATION_FILES.zsh, 'C:\\u\\termpolis-zsh\\.zshenv')[3]).toEqual({ path: 'C:\\u\\termpolis-zsh\\.zlogin', content: ZSH_ZLOGIN })
  })
})

describe('POWERSHELL_INTEGRATION_SCRIPT', () => {
  it('guards against wrapping the prompt twice', () => {
    // A nested PowerShell inside an integrated one would otherwise emit the
    // sequence once per nesting level, every prompt.
    expect(POWERSHELL_INTEGRATION_SCRIPT).toContain('$global:__termpolis_wrapped')
  })

  it('emits OSC 9;9 with the real filesystem path', () => {
    // ProviderPath, not $PWD: inside a PSDrive $PWD is not openable.
    expect(POWERSHELL_INTEGRATION_SCRIPT).toContain(']9;9;')
    expect(POWERSHELL_INTEGRATION_SCRIPT).toContain('(Get-Location).ProviderPath')
  })

  it("calls through to the user's own prompt and survives it throwing", () => {
    expect(POWERSHELL_INTEGRATION_SCRIPT).toContain('__termpolis_inner_prompt')
    expect(POWERSHELL_INTEGRATION_SCRIPT).toMatch(/catch/)
  })
})


// Every version of `lumopolis` prints the exact sequence of src/shared/world/lumopolisCommand.ts, from the nonce in
// TERMPOLIS_LUMOPOLIS_NONCE, and checks the folder with the shell's own built-ins first. Each was also run for real
// (Git Bash, Windows PowerShell 5.1 and cmd through node-pty; zsh and fish in shellIntegrationSpawn.test.ts).
describe('the lumopolis command in each shell', () => {
  const USAGE = 'usage: lumopolis [folder] - maps a folder in Lumopolis, this one by default'
  const NO_SUCH = 'if [[ "$p" == *$\'\\a\'* || ! -d "$p" ]]; then builtin printf \'lumopolis: no such folder: %s\\n\' "${1:-.}" >&2; builtin return 1; fi'
  const PRINT = String.raw`builtin printf '\033]7377;lumopolis;%s;%s\007' "$TERMPOLIS_LUMOPOLIS_NONCE" "$p"`

  it('one usage line for every shell', () => {
    expect(LUMOPOLIS_USAGE).toBe(USAGE)
  })

  it('bash: a function body with only built-ins: -h, the folder made absolute, refused unless a folder, then the sequence', () => {
    const f = BASH_LUMOPOLIS_FUNCTION
    expect(f.startsWith('() { builtin local p="${1:-.}"; ')).toBe(true)
    expect(f).toContain(`if builtin [ "$p" = -h ] || builtin [ "$p" = --help ]; then builtin printf '%s\\n' '${USAGE}'; builtin return 0; fi`)
    // Only a drive with a separator after it is absolute (C:\x, C:/x); C:foo is relative to the drive, so relative here.
    expect(f).toContain(String.raw`case "$p" in /*|[A-Za-z]:[\\/]*) ;; *) p="$PWD/$p" ;; esac`)
    // A BEL in a folder name would end the sequence early, so such a name is refused like a missing one.
    expect(f).toContain(NO_SUCH)
    expect(f).toContain(PRINT)
    expect(f.endsWith('; }')).toBe(true)
    expect(f.indexOf('-h ]')).toBeLessThan(f.indexOf('case'))
    expect(f.indexOf('no such folder')).toBeLessThan(f.indexOf('7377'))
    // zsh parses this after the person's .zshrc, so an alias or function of theirs named printf, local, [ or return
    // must not reach inside it: every one is called through `builtin`.
    expect(f.match(/(?:^|[;{]|then|\|\|) *(?:(?:printf|local|return)\b|\[ )/g)).toBeNull()
    expect(f.match(/builtin (?:printf|local|\[|return)/g)).toHaveLength(8)
  })

  it('zsh: the same body as bash, defined by name', () => {
    expect(ZSH_LUMOPOLIS_FUNCTION).toBe(`function lumopolis ${BASH_LUMOPOLIS_FUNCTION.slice(3)}`)
  })

  it("PowerShell: defined inside the once-only block, never over a lumopolis of the person's own, with -h", () => {
    const s = POWERSHELL_INTEGRATION_SCRIPT
    expect(s).toContain(String.raw`if (-not (Test-Path Function:\lumopolis)) {`)
    expect(s).toContain('function global:lumopolis {')
    expect(s).toContain("param([string]$Path = '.', [Alias('h')][switch]$Help)")
    expect(s).toContain(`if ($Help -or $Path -eq '--help') { Write-Host '${USAGE}'; return }`)
    expect(s).toContain('GetUnresolvedProviderPathFromPSPath($Path)')
    expect(s).toContain('[System.IO.Directory]::Exists($full)')
    expect(s).toContain('Write-Host "lumopolis: no such folder: $Path"')
    expect(s).toContain('[Console]::Write("$([char]27)]7377;lumopolis;$env:TERMPOLIS_LUMOPOLIS_NONCE;$full$([char]7)")')
    expect(s.indexOf('$Help -or')).toBeLessThan(s.indexOf('GetUnresolvedProviderPathFromPSPath'))
    expect(s.indexOf('function global:lumopolis')).toBeLessThan(s.lastIndexOf('}'))
  })

  it('cmd: one doskey macro; the whole argument is one folder, wildcards refused, nothing left set', () => {
    // Two commands: the first keeps the raw arguments (quotes and all) in a variable; the second clears it and, in
    // the same line, reads it with the quotes stripped. for /f takes the text as one string (no globbing), and its
    // variables expand after cmd has parsed the line, so a folder named "x (86)" or "a & b" cannot break the parse.
    // The inner for /f splits on * and ?: when the first piece is not the whole, there was a wildcard.
    const O = '<nul set /p "=\x1b]7377;lumopolis;%TERMPOLIS_LUMOPOLIS_NONCE%;'
    const N = 'lumopolis: no such folder: %~I'
    expect(CMD_LUMOPOLIS_MACROS).toBe(
      'lumopolis=@set __termpolis_lumo= $*$T@set __termpolis_lumo=& ' +
      'for /f "tokens=*" %I in ("%__termpolis_lumo:"=%") do @for /f "delims=*?" %J in ("x%~I") do ' +
      `@if "%~I"=="" (${O}%CD%\x07") ` +
      `else if "%~I"=="-h" (echo ${USAGE}) ` +
      `else if "%~I"=="--help" (echo ${USAGE}) ` +
      `else if not "%J"=="x%~I" (echo ${N}) ` +
      String.raw`else if exist "%~fI\" ` + `(${O}%~fI\x07") ` +
      `else echo ${N}\r\n`,
    )
    expect(CMD_LUMOPOLIS_MACROS.split('\r\n')).toHaveLength(2) // one macro
  })

  it('no version starts a program or reaches the network', () => {
    for (const text of [BASH_LUMOPOLIS_FUNCTION, CMD_LUMOPOLIS_MACROS, POWERSHELL_INTEGRATION_SCRIPT, ZSH_ZSHENV, ZSH_ZPROFILE, ZSH_ZSHRC, ZSH_ZLOGIN, FISH_INTEGRATION_SCRIPT]) {
      expect(text).not.toMatch(/Start-Process|Invoke-WebRequest|Invoke-Expression|curl|wget|\bstart\b|\.exe|\bexec\b|pgrep|\beval\b/i)
    }
    for (const text of [BASH_LUMOPOLIS_FUNCTION, ZSH_ZSHENV, ZSH_ZPROFILE, ZSH_ZSHRC, ZSH_ZLOGIN, FISH_INTEGRATION_SCRIPT]) {
      expect(text).not.toMatch(/\bps\b/)
    }
  })
})

// zsh reads $ZDOTDIR/.zshenv, .zprofile (login), .zshrc (interactive), .zlogin (login), in that order. Termpolis
// points ZDOTDIR at its own folder; each of its files puts the person's ZDOTDIR back, runs the person's file of the
// same name, then (if zsh will read another) points ZDOTDIR at Termpolis's again. The person's .zshrc runs with their
// own ZDOTDIR in place, and after start-up ZDOTDIR is theirs again, so a later `exec zsh` behaves as before.
describe('zsh start-up files', () => {
  const RESTORE = 'if [[ -n "${__termpolis_user_zdotdir-}" ]]; then ZDOTDIR="$__termpolis_user_zdotdir"; else builtin unset ZDOTDIR; fi'
  const source = (f: string): string => `if [[ -r "\${ZDOTDIR:-$HOME}/${f}" ]]; then builtin source "\${ZDOTDIR:-$HOME}/${f}"; fi`
  const HANDBACK = '__termpolis_user_zdotdir="${ZDOTDIR-}"; ZDOTDIR="$__termpolis_zdotdir"'
  const DONE = 'builtin unset __termpolis_zdotdir __termpolis_user_zdotdir'
  const inOrder = (text: string, parts: string[]): void => {
    let at = -1
    for (const part of parts) {
      const i = text.indexOf(part, at + 1)
      expect(i, `${JSON.stringify(part)} after position ${at}`).toBeGreaterThan(at)
      at = i
    }
  }

  it(".zshenv: remembers Termpolis's folder, takes the person's ZDOTDIR from the environment, runs their .zshenv", () => {
    inOrder(ZSH_ZSHENV, [
      // Our own copy of the folder, never $ZDOTDIR (see the integrationEnv test): zsh has already rewritten that.
      '__termpolis_zdotdir="${TERMPOLIS_ZSH_DIR:-$ZDOTDIR}"',
      '__termpolis_user_zdotdir="${TERMPOLIS_USER_ZDOTDIR-}"',
      'builtin unset TERMPOLIS_ZSH_DIR TERMPOLIS_USER_ZDOTDIR',
      RESTORE,
      source('.zshenv'),
      // Only a shell that will read more start-up files (and has not switched them off) is handed back.
      `if [[ -o rcs ]] && [[ -o interactive || -o login ]]; then ${HANDBACK}; else ${DONE}; fi`,
    ])
  })

  it(".zprofile: the person's .zprofile with their ZDOTDIR, then handed back", () => {
    inOrder(ZSH_ZPROFILE, [RESTORE, source('.zprofile'), HANDBACK])
  })

  it(".zshrc: the person's .zshrc first, then the prompt hook and lumopolis added beside theirs", () => {
    inOrder(ZSH_ZSHRC, [
      RESTORE,
      // macOS's /etc/zshrc runs first and points HISTFILE into whatever ZDOTDIR is then (Termpolis's): put it back.
      'if [[ "${HISTFILE-}" == "$__termpolis_zdotdir/.zsh_history" ]]; then HISTFILE="${ZDOTDIR:-$HOME}/.zsh_history"; fi',
      source('.zshrc'),
      `if [[ -o login ]]; then ${HANDBACK}; else ${DONE}; fi`,
      String.raw`function __termpolis_report_cwd { builtin printf '\033]7;file://%s%s\007' "${'$'}{HOST-}" "$PWD"; }`,
      'builtin autoload -Uz add-zsh-hook',
      'if ! add-zsh-hook precmd __termpolis_report_cwd 2>/dev/null; then precmd_functions+=(__termpolis_report_cwd); fi',
      `if ! builtin typeset -f lumopolis >/dev/null 2>&1; then ${ZSH_LUMOPOLIS_FUNCTION}; fi`,
    ])
    // Appended to, never replacing, a precmd of the person's (oh-my-zsh, powerlevel10k, starship).
    expect(ZSH_ZSHRC).not.toMatch(/precmd\s*\(\)|precmd_functions=\(/)
  })

  it(".zlogin: the person's .zlogin with their ZDOTDIR, then nothing of Termpolis's left behind", () => {
    inOrder(ZSH_ZLOGIN, [RESTORE, source('.zlogin'), DONE])
    expect(ZSH_ZLOGIN).not.toContain(HANDBACK)
  })

  it('every file ends in success, so a missing file of the person never fails start-up', () => {
    for (const f of [ZSH_ZSHENV, ZSH_ZPROFILE, ZSH_ZSHRC, ZSH_ZLOGIN]) expect(f.trimEnd().endsWith('\nbuiltin true')).toBe(true)
  })
})

describe('the fish integration file', () => {
  const f = FISH_INTEGRATION_SCRIPT
  it('loads once, and reports the folder before every prompt with the same OSC 7 as bash', () => {
    expect(f).toContain('if not set -q __termpolis_wrapped')
    expect(f).toContain('set -g __termpolis_wrapped 1')
    expect(f).toContain('function __termpolis_report_cwd --on-event fish_prompt')
    expect(f).toContain(String.raw`builtin printf '\e]7;file://%s%s\a' "$hostname" "$PWD"`)
  })

  it('lumopolis: never over one of the person\'s own; -h; made absolute; refused unless a folder; then the sequence', () => {
    const parts = [
      'if not functions -q lumopolis',
      'function lumopolis',
      'set -l arg .',
      'if set -q argv[1]; and test -n "$argv[1]"',
      'set arg $argv[1]',
      'if contains -- $arg -h --help',
      `builtin printf '%s\\n' '${LUMOPOLIS_USAGE}'`,
      'set -l p $arg',
      String.raw`if not string match -qr -- '^(/|[A-Za-z]:[/\x5c])' $p`,
      'set p "$PWD/$p"',
      String.raw`if string match -q -- '*'\a'*' $p; or not test -d $p`,
      String.raw`builtin printf 'lumopolis: no such folder: %s\n' $arg >&2`,
      String.raw`builtin printf '\e]7377;lumopolis;%s;%s\a' "$TERMPOLIS_LUMOPOLIS_NONCE" $p`,
    ]
    let at = -1
    for (const part of parts) {
      const i = f.indexOf(part, at + 1)
      expect(i, part).toBeGreaterThan(at)
      at = i
    }
  })
})
