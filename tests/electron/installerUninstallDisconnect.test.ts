// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// The Windows uninstaller runs `Termpolis.exe --disconnect-agents` from build/installer.nsh's
// customUnInit, to take Termpolis back out of the agent configs. Nothing else checks that macro
// before a user uninstalls, and each of these went wrong or nearly did:
//
//   - v1.49.0 ran it with ExecWait, which waits as long as the app runs: a Termpolis that hung
//     hung the uninstall with it. It now has a time limit, and its result can't fail the uninstall.
//   - It must not run when the installer runs the OLD version's uninstaller during an update,
//     or every update would disconnect the user's agents. The guard is electron-builder's
//     ${isUpdated}, and the second half of this file pins the electron-builder code that
//     makes that guard, and the ordering the macro relies on, so an electron-builder upgrade
//     that changes them fails here instead of on users' machines.
//
// A synthetic NSIS harness (the macro verbatim, the real StdUtils plugin, a stand-in exe in a
// folder with a space) ran it for plain, silent, update and --delete-app-data uninstalls, an app
// that fails, a missing app and an app that hangs. That can't run in CI; these keep what it showed.

const root = join(__dirname, '../..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')
const builder = (p: string): string => read(join('node_modules/app-builder-lib', p))

/** A line without its NSIS comment: `;` or `#` at the start of a token, outside quotes. */
function stripComment(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c
    } else if ((c === ';' || c === '#') && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }
  return line
}

/** The statements between `open` and `close` (whole-line regexes), comments and blank lines removed. */
function block(source: string, open: RegExp, close: RegExp): string[] {
  const lines = source.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
  const start = lines.findIndex((l) => open.test(l.trim()))
  expect(start, `no line matching ${open}`).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((l, i) => i > start && close.test(l.trim()))
  expect(end, `nothing closes ${open}`).toBeGreaterThan(start)
  return lines.slice(start + 1, end).map((l) => stripComment(l).trim()).filter(Boolean)
}

const customUnInit = (): string[] => block(read('build/installer.nsh'), /^!macro\s+customUnInit$/, /^!macroend$/)
const EXEC = /^(ExecWait|Exec|ExecShell|ExecShellWait|nsExec::\w+|ExecDos::\w+)\b/i

describe('installer.nsh: the uninstaller disconnects the agents, and nothing about it can hang or fail an uninstall', () => {
  it('only disconnects when this is not an update: the whole macro sits inside ${ifNot} ${isUpdated}', () => {
    const body = customUnInit()
    expect(body[0]).toMatch(/^\$\{ifNot\}\s+\$\{isUpdated\}$/i)
    expect(body[body.length - 1]).toMatch(/^\$\{endIf\}$/i)
    // No second branch and no second block: nothing in between runs on an update.
    for (const s of body.slice(1, -1)) expect(s).not.toMatch(/^\$\{(if|ifNot|unless|else|elseIf|endIf|orIf|andIf)\}/i)
  })

  it('runs the app once, with nsExec and a time limit between 1 and 60 seconds, never with ExecWait', () => {
    const execs = customUnInit().filter((s) => EXEC.test(s))
    expect(execs).toHaveLength(1)
    const m = /^nsExec::Exec\s+\/TIMEOUT=(\d+)\s+(.+)$/i.exec(execs[0])
    expect(m, `not a timed nsExec::Exec: ${execs[0]}`).not.toBeNull()
    const ms = Number(m![1])
    expect(ms).toBeGreaterThanOrEqual(1000)
    expect(ms).toBeLessThanOrEqual(60_000)
  })

  it('quotes the exe path, which has spaces in it on many machines, and passes the flag index.ts looks for', () => {
    const exec = customUnInit().find((s) => EXEC.test(s))!
    expect(exec.endsWith(`'"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" --disconnect-agents'`)).toBe(true)
    expect(read('src/main/index.ts')).toContain("process.argv.includes('--disconnect-agents')")
  })

  it('drops the result nsExec pushes, restores $0 and clears the error flag, whatever the app did', () => {
    const body = customUnInit()
    const at = body.findIndex((s) => EXEC.test(s))
    const before = body.slice(0, at)
    const after = body.slice(at + 1)
    const pushes = before.filter((s) => /^Push\s/i.test(s)).map((s) => s.split(/\s+/)[1])
    const pops = after.filter((s) => /^Pop\s/i.test(s)).map((s) => s.split(/\s+/)[1])
    // nsExec leaves exactly one value (exit code, "error" or "timeout") on top of the stack.
    expect(pops).toHaveLength(pushes.length + 1)
    // The last Pop gets back what was pushed first, so the caller's register is as it was.
    expect(pops[pops.length - 1]).toBe(pushes[0])
    expect(after.some((s) => /^ClearErrors$/i.test(s))).toBe(true)
    expect(after.findIndex((s) => /^ClearErrors$/i.test(s))).toBeGreaterThan(after.findIndex((s) => /^Pop\s/i.test(s)))
  })
})

describe('electron-builder still behaves the way customUnInit relies on', () => {
  const unOnInit = (): string[] => block(builder('templates/nsis/uninstaller.nsh'), /^Function\s+un\.onInit$/, /^FunctionEnd$/)

  it('inserts customUnInit at the end of un.onInit, after initMultiUser and after every close of a running Termpolis', () => {
    const onInit = unOnInit()
    const at = (re: RegExp): number[] => onInit.flatMap((s, i) => (re.test(s) ? [i] : []))
    const inserts = at(/^!insertmacro\s+customUnInit$/i)
    const closes = at(/^call\s+un\.checkAppRunning$/i)
    const multiUser = at(/^!insertmacro\s+initMultiUser$/i)
    expect(inserts).toHaveLength(1)
    expect(closes.length).toBeGreaterThan(0)
    expect(multiUser).toHaveLength(1)
    for (const c of closes) expect(inserts[0]).toBeGreaterThan(c)
    expect(inserts[0]).toBeGreaterThan(multiUser[0])
  })

  it('closes a running Termpolis in un.onInit for a non-silent uninstall too, which it does only for a one-click installer', () => {
    // An assisted installer (oneClick: false) closes it for a non-silent uninstall in
    // un.install instead, which runs after customUnInit: the disconnect would then run while
    // the app is still open, which installer.nsh says cannot happen.
    expect(JSON.parse(read('package.json')).build.nsis.oneClick).toBe(true)
    expect(unOnInit().join('\n')).toMatch(/^\$\{else\}\n!ifdef ONE_CLICK\n(?:.*\n)*?call un\.checkAppRunning\n(?:.*\n)*?!endif$/im)
  })

  it('defines ${isUpdated} as a test for the --updated parameter', () => {
    expect(builder('out/targets/nsis/NsisTarget.js')).toMatch(/scriptGenerator\.flags\(\[[^\]]*"updated"/)
    const generator = builder('out/targets/nsis/nsisScriptGenerator.js')
    expect(generator).toContain('StdUtils.TestParameter} $R9 "${flagName}"')
    expect(generator).toContain('StrCmp "$R9" "true"')
    expect(generator).toMatch(/return "is" \+ flagName\[0\]\.toUpperCase\(\) \+ flagName\.substring\(1\)/)
  })

  it('passes --updated to the old uninstaller on every update, unless the installer ran with --delete-app-data', () => {
    const util = builder('templates/nsis/include/installUtil.nsh')
    expect(util).toMatch(/\$\{if\} \$\{isDeleteAppData\}\s+StrCpy \$0 "\$0 --delete-app-data"\s+\$\{else\}[^\n]*\n(?:\s*#[^\n]*\n)*\s*StrCpy \$0 "\$0 --updated"/)
    expect(util).toMatch(/ExecWait '"\$uninstallerFileNameTemp" \/S \/KEEP_APP_DATA \$0 _\?=\$installationDir'/)
  })
})
