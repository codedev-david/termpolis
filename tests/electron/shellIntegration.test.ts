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

  it('adds nothing for shells integrated through the environment', () => {
    for (const kind of ['bash', 'zsh', 'cmd', 'fish', 'unknown'] as const) {
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
  it('is true only for the PowerShell family', () => {
    expect(needsScriptFile('powershell')).toBe(true)
    expect(needsScriptFile('pwsh')).toBe(true)
    for (const kind of ['bash', 'zsh', 'cmd', 'fish', 'unknown'] as const) {
      expect(needsScriptFile(kind)).toBe(false)
    }
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
