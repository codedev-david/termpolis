/**
 * The Windows installer closes a running Termpolis without listing processes (build/installer.nsh).
 *
 * electron-builder's own check runs PowerShell's Get-CimInstance Win32_Process, or tasklist, on
 * every install, uninstall and auto-update, and on a monitored work computer that process query,
 * started under Termpolis.exe, reads as discovery to endpoint security. build/installer.nsh defines
 * customCheckAppRunning to replace it. This file keeps the replacement free of any process query and
 * fails if an electron-builder upgrade stops honouring the hook; the Tests workflow's
 * installer-update job proves the replacement on a real install, updating over a running Termpolis.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')
const INCLUDE = readFileSync(join(ROOT, 'build', 'installer.nsh'), 'utf8')
const TEMPLATE = readFileSync(
  join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include', 'allowOnlyOneInstallerInstance.nsh'),
  'utf8',
)

/** The include without its comments: what makensis compiles. */
const code = INCLUDE.split('\n')
  .filter((line) => !/^\s*[;#]/.test(line))
  .join('\n')

/** A macro's body, from `!macro <name>` to its `!macroend`. */
function macroBody(source: string, name: string): string {
  const m = new RegExp(`^!macro ${name}\\b[^\\n]*\\n([\\s\\S]*?)^!macroend`, 'm').exec(source)
  expect(m, `!macro ${name} is defined`).not.toBeNull()
  return (m as RegExpExecArray)[1]
}

describe('Windows installer: closing a running Termpolis', () => {
  it('replaces electron-builder\'s check with its own', () => {
    expect(code).toMatch(/^!macro customCheckAppRunning\b/m)
  })

  it('runs no process query: no PowerShell, WMI, tasklist or wmic anywhere in the include', () => {
    for (const forbidden of [/powershell/i, /pwsh/i, /Get-CimInstance/i, /Get-WmiObject/i, /Win32_Process/i, /\btasklist\b/i, /\bwmic\b/i, /Get-Process/i]) {
      expect(code, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('tells "running" by whether Termpolis.exe can be opened for writing', () => {
    const probe = macroBody(code, 'termpolisExeInUse')
    expect(probe).toContain('FileOpen $R9 "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" a')
    // Guarded, because opening in "a" mode would create a missing file.
    expect(probe).toMatch(/\$\{If\} \$\{FileExists\} "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/)
    expect(probe).toContain('FileClose $R9')
  })

  it('closes it by name, for this user only: asks first, then insists', () => {
    const check = macroBody(code, 'customCheckAppRunning')
    expect(check).toContain('nsExec::Exec `"$SYSDIR\\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq $R2"`')
    expect(check).toContain('nsExec::Exec `"$SYSDIR\\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq $R2"`')
    expect(check).toContain('ExpandEnvStrings $R2 "%USERNAME%"')
    // Every nsExec result is taken off the stack.
    expect(check.match(/nsExec::Exec/g)?.length).toBe(2)
    expect(check).toMatch(/\$\{EndIf\}\s+Pop \$R9/)
  })

  it('gives up rather than looping forever, and restores every register it uses', () => {
    const check = macroBody(code, 'customCheckAppRunning')
    expect(check).toMatch(/\$\{If\} \$R1 >= 10\s+\$\{ExitDo\}/)
    expect(check).toContain('"$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2')
    const pushes = [...check.matchAll(/^\s*Push (\$R\d)/gm)].map((m) => m[1])
    const pops = [...check.matchAll(/^\s*Pop (\$R\d)\s*$/gm)].map((m) => m[1]).slice(-pushes.length)
    expect(pushes).toEqual(['$R0', '$R1', '$R2', '$R9'])
    expect(pops).toEqual([...pushes].reverse())
  })

  it('is used by electron-builder: its check defers to customCheckAppRunning when one is defined', () => {
    expect(TEMPLATE).toMatch(/!ifmacrodef customCheckAppRunning\s+!insertmacro customCheckAppRunning\s+!else/)
    // ...and only then leaves out the variable its own check needs, which -WX would reject unused.
    expect(TEMPLATE).toMatch(/!ifmacrondef customCheckAppRunning\s+!include "getProcessInfo\.nsh"\s+Var pid\s+!endif/)
  })
})
