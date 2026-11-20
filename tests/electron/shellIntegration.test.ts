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
    for (const kind of ['bash', 'zsh', 'fish', 'unknown'] as const) {
      expect(integrationArgs(kind, '/tmp/si.ps1')).toEqual([])
    }
  })

  it('adds nothing when no script was written', () => {
    expect(integrationArgs('powershell', null)).toEqual([])
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

  it('adds nothing for zsh, fish and unknown shells', () => {
    // These are POSIX-only in practice, where the live cwd is readable from
    // /proc or lsof without any shell cooperation.
    for (const kind of ['zsh', 'fish', 'unknown'] as const) {
      expect(integrationEnv(kind)).toEqual({})
    }
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
  it('is true only for the PowerShell family and cmd', () => {
    expect(needsScriptFile('powershell')).toBe(true)
    expect(needsScriptFile('pwsh')).toBe(true)
    expect(needsScriptFile('cmd')).toBe(true)
    for (const kind of ['bash', 'zsh', 'fish', 'unknown'] as const) {
      expect(needsScriptFile(kind)).toBe(false)
    }
  })

  it('names each file: the PowerShell script and the doskey macros', () => {
    expect(integrationFile('powershell')).toBe(INTEGRATION_FILES.powershell)
    expect(integrationFile('pwsh')).toEqual({ name: 'termpolis-shell-integration.ps1', content: POWERSHELL_INTEGRATION_SCRIPT })
    expect(integrationFile('cmd')).toEqual({ name: 'termpolis-lumopolis.doskey', content: CMD_LUMOPOLIS_MACROS })
    expect(integrationFile('bash')).toBeNull()
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
// in Git Bash, Windows PowerShell 5.1 and cmd through node-pty (caveat-3-report.md has the transcript).
describe('the lumopolis command in each shell', () => {
  it('bash: a function body with only built-ins, the no-such-folder line, then the sequence', () => {
    const f = BASH_LUMOPOLIS_FUNCTION
    expect(f.startsWith('() { ')).toBe(true)
    expect(f).toContain('local p="${1:-.}"')
    expect(f).toContain('p="$PWD/$p"')
    expect(f).toContain('if [ ! -d "$p" ]; then printf \'lumopolis: no such folder: %s\\n\' "${1:-.}" >&2; return 1; fi')
    expect(f).toContain(String.raw`printf '\033]7377;lumopolis;%s;%s\007' "$TERMPOLIS_LUMOPOLIS_NONCE" "$p"`)
    expect(f.indexOf('no such folder')).toBeLessThan(f.indexOf('7377'))
  })

  it("PowerShell: defined inside the once-only block, never over a lumopolis of the person's own", () => {
    const s = POWERSHELL_INTEGRATION_SCRIPT
    expect(s).toContain(String.raw`if (-not (Test-Path Function:\lumopolis)) {`)
    expect(s).toContain('function global:lumopolis {')
    expect(s).toContain('GetUnresolvedProviderPathFromPSPath($Path)')
    expect(s).toContain('[System.IO.Directory]::Exists($full)')
    expect(s).toContain('Write-Host "lumopolis: no such folder: $Path"')
    expect(s).toContain('[Console]::Write("$([char]27)]7377;lumopolis;$env:TERMPOLIS_LUMOPOLIS_NONCE;$full$([char]7)")')
    expect(s.indexOf('function global:lumopolis')).toBeLessThan(s.lastIndexOf('}'))
  })

  it('cmd: one doskey macro, the folder made full by for, checked by if exist, printed by set /p', () => {
    const m = CMD_LUMOPOLIS_MACROS
    expect(m.startsWith(String.raw`lumopolis=for %I in (. $*) do @set "__termpolis_lumo=%~fI"$T@if exist "%__termpolis_lumo%\" (`)).toBe(true)
    expect(m).toContain('<nul set /p "=\x1b]7377;lumopolis;%TERMPOLIS_LUMOPOLIS_NONCE%;%__termpolis_lumo%\x07")')
    expect(m).toContain(' else (echo lumopolis: no such folder: $*)')
    expect(m.endsWith('\r\n')).toBe(true)
    expect(m.split('\r\n')).toHaveLength(2) // one macro
  })

  it('no version starts a program or reaches the network', () => {
    for (const text of [BASH_LUMOPOLIS_FUNCTION, CMD_LUMOPOLIS_MACROS, POWERSHELL_INTEGRATION_SCRIPT]) {
      expect(text).not.toMatch(/Start-Process|Invoke-WebRequest|Invoke-Expression|curl|wget|\bstart\b|\.exe/i)
    }
  })
})
