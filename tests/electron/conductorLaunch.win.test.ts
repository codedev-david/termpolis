import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { conductorRunScript, conductorLaunchCommand } from '../../src/renderer/src/lib/conductorLaunch'
import { psQuote } from '../../src/shared/shellQuote'
import { powershellPath } from '../../src/main/secondOpinion'

// GitHub #36. The conductor's run script promises that claude gets the task EXACTLY, on stdin,
// with only flags on its command line. That rests on Windows PowerShell 5.1's pipeline and
// encoding rules, which no string assertion can prove, so this runs the generated script in the
// real powershell.exe, through the production launch line, against claude stand-ins that record
// what they received. PATH and the profile folders point into a temp sandbox, so the script's
// binary probe can never find a real claude on a developer's machine.
// The session claude is started under, whose transcript the dashboard's Trace follows.
const SESSION = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'

describe.runIf(process.platform === 'win32')('conductor run script on real Windows PowerShell', () => {
  let dir = ''
  let recorderDir = ''
  let recorder = ''
  // Every hazard from the report: quotes, option-like words, non-ASCII, and a body past the
  // 32,767-char Windows command line.
  let task = 'You are the Swarm Conductor — orchestrate the task.\nGoal: run "npm test --watch" -NoProfile, then reply "all good" ✓ → ⚠\n'
  for (let i = 0; task.length < 40_000; i++) task += `Line ${i}: "quoted" --flag-${i} -NoProfile — ✓ → 'single' $env:PATH \`tick\`\n`

  beforeAll(() => {
    // A home folder name that needs the single-quoted literals (a space, an apostrophe and a $),
    // and one 5.1 reads wrong from a BOM-less script: letters outside ASCII, and a typographic
    // apostrophe, which PowerShell also takes as a quote.
    dir = mkdtempSync(join(tmpdir(), "tp-conductor O'Brien O’Neil José MUÑOZ $x-"))
    // The stand-ins below name the recorder in files of their own, BOM-less as npm writes its
    // shims, which find their target at run time instead; so it lives in an ASCII folder.
    recorderDir = mkdtempSync(join(tmpdir(), 'tp-recorder-'))
    recorder = join(recorderDir, 'recorder.cjs')
    // Written to files rather than stdout so the check can't depend on console code pages.
    writeFileSync(recorder, [
      "const fs = require('fs')",
      'const argv = process.argv.slice(2)',
      // TP_VANISH: answer --version, then remove the launcher it was found by, as an uninstall
      // between the probe and the pipe would.
      "if (argv.includes('--version')) { if (process.env.TP_VANISH) fs.rmSync(process.env.TP_VANISH); console.log('2.1.300 (Claude Code)'); process.exit(0) }",
      'const chunks = []',
      "process.stdin.on('data', (c) => chunks.push(c))",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(process.env.TP_RECORD + '.stdin', Buffer.concat(chunks))",
      '  fs.writeFileSync(process.env.TP_RECORD, JSON.stringify(argv))',
      // A last line with no newline, when asked: claude printing one must not swallow the report.
      "  process.stdout.write(process.env.TP_SAY || '', () => process.exit(Number(process.env.TP_EXIT || 0)))",
      '})',
      '',
    ].join('\n'))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    if (recorderDir) rmSync(recorderDir, { recursive: true, force: true })
  })

  /** Runs one launch the way the conductor terminal does: an outer PowerShell types the launch
   *  line, which runs the script in PS 5.1. `utf8Console` leaves the console on code page 65001
   *  first, as a profile that sets UTF-8 does: that is when .NET writes a BOM into the pipe.
   *  `constrained` runs the script in ConstrainedLanguage instead, as AppLocker or WDAC would: the
   *  outer session switches to it and dot-sources the script, since a new powershell.exe would
   *  start in FullLanguage again. `vanish` removes that bin file once its --version answered.
   *  `binName` names the folder on PATH the stand-ins are in. `nodeOnPath` puts node's folder on
   *  PATH too, for a test command that starts `node` by name, as e2e's does. `vanishTask` removes the
   *  task file instead, once the probe's --version answered. `configDir` is the CLAUDE_CONFIG_DIR the
   *  script's shell has, none without it. */
  function launch(name: string, opts: { bin?: Record<string, string>; binName?: string; testCommand?: string; utf8Console?: boolean; exitCode?: number; say?: string; constrained?: boolean; vanish?: string; vanishTask?: boolean; nodeOnPath?: boolean; configDir?: string }): { status: number | null; stdout: string; stderr: string; argv: string[] | null; stdin: Buffer | null; cfg: string; recorded: Buffer | null } {
    const root = join(dir, name)
    const home = join(root, 'home')
    const bin = join(root, opts.binName ?? 'bin')
    mkdirSync(join(home, 'AppData', 'Local'), { recursive: true })
    mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    for (const [file, content] of Object.entries(opts.bin ?? {})) writeFileSync(join(bin, file), content)
    const taskFile = join(home, '.termpolis-conductor-task.md')
    const claudeHomeFile = join(home, '.termpolis-conductor-claude-home')
    const cfg = join(home, 'AppData', 'Roaming', 'claude-mcp-config.json')
    const script = join(home, '.termpolis-conductor-run.ps1')
    writeFileSync(taskFile, task, 'utf8') // BOM-less, as configFileManager writes it
    writeFileSync(cfg, '{"mcpServers":{}}')
    writeFileSync(script, conductorRunScript(true, { taskFile, mcpConfigPath: cfg, sessionId: SESSION, claudeHomeFile, testCommand: opts.testCommand }))
    const outer = join(root, 'outer.ps1')
    const pre = opts.utf8Console ? '[Console]::InputEncoding = [Text.Encoding]::UTF8\r\n' : ''
    const run = opts.constrained
      ? `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\r\n. ${psQuote(script)}`
      : conductorLaunchCommand(true, script)
    // With a BOM: the app types this line, which reaches PowerShell as Unicode whatever the path.
    writeFileSync(outer, `\uFEFF${pre}${run}\r\nexit $LASTEXITCODE\r\n`)

    const record = join(root, 'record.json')
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k]
    const sys = process.env.SystemRoot || 'C:\\Windows'
    env.PATH = [bin, ...(opts.nodeOnPath ? [dirname(process.execPath)] : []), join(sys, 'System32'), sys, join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
    env.USERPROFILE = home
    env.APPDATA = join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA = join(home, 'AppData', 'Local')
    // Claude Code's config home, as the shell claude runs in has it: none unless the test gives one.
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'CLAUDE_CONFIG_DIR') delete env[k]
    if (opts.configDir !== undefined) env.CLAUDE_CONFIG_DIR = opts.configDir
    env.TP_RECORD = record
    env.TP_EXIT = String(opts.exitCode ?? 0)
    env.TP_SAY = opts.say ?? ''
    if (opts.vanish) env.TP_VANISH = join(bin, opts.vanish)
    if (opts.vanishTask) env.TP_VANISH = taskFile
    const r = spawnSync(powershellPath(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', outer], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      windowsHide: true,
    })
    return {
      status: r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      argv: existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as string[]) : null,
      stdin: existsSync(record + '.stdin') ? readFileSync(record + '.stdin') : null,
      cfg,
      recorded: existsSync(claudeHomeFile) ? readFileSync(claudeHomeFile) : null,
    }
  }

  // npm's PowerShell shim, as cmd-shim writes it: pipeline input is forwarded through $input.
  const npmShim = (): string => [
    '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
    'if ($MyInvocation.ExpectingInput) {',
    `  $input | & ${psQuote(process.execPath)} ${psQuote(recorder)} $args`,
    '} else {',
    `  & ${psQuote(process.execPath)} ${psQuote(recorder)} $args`,
    '}',
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n')
  const cmdShim = (): string => `@"${process.execPath}" "${recorder}" %*\r\n`

  /** `stdin`: what claude must get, byte for byte. A pipe appends a CRLF to the task; a task file
   *  handed over as it is (ConstrainedLanguage's Start-Process) has none. */
  function expectDelivered(r: ReturnType<typeof launch>, exitCode = 0, stdin = task + '\r\n'): void {
    expect(r.argv, r.stderr).toEqual(['-p', '--mcp-config', r.cfg, '--session-id', SESSION, '--dangerously-skip-permissions'])
    // Byte for byte: no BOM in front, nothing garbled.
    expect(r.stdin?.equals(Buffer.from(stdin, 'utf8')), r.stderr).toBe(true)
    // The script's first line marks where its output starts; claude's exit is reported on a
    // line of its own, and passed on as the script's exit code.
    const lines = r.stdout.split(/\r?\n/)
    expect(lines[0]).toBe('[termpolis-conductor-started]')
    expect(lines).toContain(`[termpolis-conductor-exited] ${exitCode}`)
    expect(r.status).toBe(exitCode)
  }

  it('hands the npm PowerShell shim the task on stdin and keeps the command line to flags', () => {
    const r = launch('ps1', { bin: { 'claude.ps1': npmShim(), 'claude.cmd': cmdShim() } })
    expectDelivered(r)
  }, 60_000)

  it('writes no BOM into the pipe when the console is already on UTF-8', () => {
    const r = launch('ps1-utf8', { bin: { 'claude.ps1': npmShim() }, utf8Console: true })
    expect(r.stdin?.subarray(0, 3).toString('hex')).not.toBe('efbbbf')
    expectDelivered(r)
  }, 60_000)

  it('delivers the task intact through a lone claude.cmd', () => {
    const r = launch('cmd', { bin: { 'claude.cmd': cmdShim() } })
    expectDelivered(r)
  }, 60_000)

  // R3-4: Test-Path reads a path as a wildcard pattern, so a claude in a folder named with square
  // brackets was skipped, and the run ended with "No working claude binary found".
  it('finds claude in a folder on PATH whose name has square brackets', () => {
    expectDelivered(launch('brackets-ps1', { bin: { 'claude.ps1': npmShim() }, binName: 'tools [x64]' }))
    expectDelivered(launch('brackets-cmd', { bin: { 'claude.cmd': cmdShim() }, binName: 'tools [x64]' }))
  }, 120_000)

  it('delivers the task intact to a native program in test mode, with no binary probe', () => {
    const r = launch('test', { testCommand: `& ${psQuote(process.execPath)} ${psQuote(recorder)}`, utf8Console: true })
    expectDelivered(r)
  }, 60_000)

  it("reports claude's own exit code through every kind of launcher", () => {
    expectDelivered(launch('exit-ps1', { bin: { 'claude.ps1': npmShim() }, exitCode: 3 }), 3)
    expectDelivered(launch('exit-cmd', { bin: { 'claude.cmd': cmdShim() }, exitCode: 4 }), 4)
    expectDelivered(launch('exit-test', { testCommand: `& ${psQuote(process.execPath)} ${psQuote(recorder)}`, exitCode: 5 }), 5)
  }, 120_000)

  it("keeps the report on a line of its own when claude's last line has no newline", () => {
    const r = launch('no-newline', { testCommand: `& ${psQuote(process.execPath)} ${psQuote(recorder)}`, exitCode: 2, say: 'Partial line' })
    expectDelivered(r, 2) // the report is a whole line...
    expect(r.stdout.split(/\r?\n/)).toContain('Partial line') // ...and did not join claude's
  }, 60_000)

  it('reports exit code 1, with the reason, when no claude binary answers', () => {
    const r = launch('no-claude', {})
    expect(r.argv).toBeNull()
    expect(r.stdout).toContain('No working claude binary found')
    expect(r.stdout.split(/\r?\n/)).toContain('[termpolis-conductor-exited] 1')
    expect(r.status).toBe(1)
  }, 60_000)

  it('reports exit code 1 when the claude it found never starts, not the 0 its --version left', () => {
    const r = launch('vanished', { bin: { 'claude.ps1': npmShim() }, vanish: 'claude.ps1' })
    expect(r.stdout).not.toContain('No working claude binary found') // the probe found it...
    expect(r.argv).toBeNull() // ...and it never ran with the task
    expect(r.stdout.split(/\r?\n/)).toContain('[termpolis-conductor-exited] 1')
    expect(r.status).toBe(1)
  }, 60_000)

  // WL-4. ConstrainedLanguage (AppLocker or WDAC) refuses what makes UTF-8 without a BOM, and its
  // stock UTF-8 put a BOM in front of the task on claude's stdin, two with the console on 65001.
  // Start-Process now hands claude the task file itself: byte for byte as written, with neither a
  // BOM nor the CRLF a pipe appends, on the console's own code page and on 65001.
  function expectConstrained(r: ReturnType<typeof launch>, exitCode = 0): void {
    expectDelivered(r, exitCode, task)
    expect(r.stderr).toBe('') // nothing it was refused
    expect(r.stdout).not.toContain('ConstrainedLanguage') // nothing to say
  }

  it("hands claude the task file itself in ConstrainedLanguage, through npm's shims and a lone claude.cmd", () => {
    for (const utf8Console of [false, true]) {
      const tag = utf8Console ? '-utf8' : ''
      // npm's PowerShell shim is what PATH gives first, and Start-Process can't start a .ps1:
      // the claude.cmd npm writes beside it is started.
      expectConstrained(launch(`clm-ps1${tag}`, { bin: { 'claude.ps1': npmShim(), 'claude.cmd': cmdShim() }, constrained: true, utf8Console }))
      expectConstrained(launch(`clm-cmd${tag}`, { bin: { 'claude.cmd': cmdShim() }, constrained: true, utf8Console }))
    }
  }, 240_000)

  it("hands the e2e stand-in the task file itself in ConstrainedLanguage, as it does claude", () => {
    for (const utf8Console of [false, true]) {
      expectConstrained(launch(utf8Console ? 'clm-test-utf8' : 'clm-test', { testCommand: `node ${recorder}`, nodeOnPath: true, constrained: true, utf8Console }))
    }
  }, 120_000)

  it("reports claude's own exit code in ConstrainedLanguage, through each kind of launcher", () => {
    expectConstrained(launch('clm-exit-ps1', { bin: { 'claude.ps1': npmShim(), 'claude.cmd': cmdShim() }, constrained: true, exitCode: 3 }), 3)
    expectConstrained(launch('clm-exit-cmd', { bin: { 'claude.cmd': cmdShim() }, constrained: true, exitCode: 4 }), 4)
    expectConstrained(launch('clm-exit-test', { testCommand: `node ${recorder}`, nodeOnPath: true, constrained: true, exitCode: 5 }), 5)
  }, 180_000)

  it('finds and starts claude in ConstrainedLanguage in a folder whose name has square brackets', () => {
    expectConstrained(launch('clm-brackets-ps1', { bin: { 'claude.ps1': npmShim(), 'claude.cmd': cmdShim() }, binName: 'tools [x64]', constrained: true }))
    expectConstrained(launch('clm-brackets-cmd', { bin: { 'claude.cmd': cmdShim() }, binName: 'tools [x64]', constrained: true }))
  }, 120_000)

  it('reports exit code 1 in ConstrainedLanguage when the claude it found never starts', () => {
    // A batch file deleted while it runs ends in an error, which the probe takes for a broken claude:
    // the task file goes instead, which Start-Process then can't hand over.
    const r = launch('clm-vanished', { bin: { 'claude.cmd': cmdShim() }, vanishTask: true, constrained: true })
    expect(r.stdout).not.toContain('No working claude binary found') // the probe found it...
    expect(r.argv).toBeNull() // ...and it never ran with the task
    expect(r.stdout.split(/\r?\n/)).toContain('[termpolis-conductor-exited] 1')
    expect(r.status).toBe(1)
  }, 60_000)

  it('still pipes to a claude.ps1 with no claude.cmd beside it in ConstrainedLanguage, behind a BOM, and says so', () => {
    // Start-Process can't start a .ps1, and a PowerShell started to run it would feed the shim its
    // stdin re-encoded. Piped to, every character gets through behind a BOM: one for
    // $OutputEncoding, and one more for [Console]::InputEncoding when that is UTF-8 too.
    for (const utf8Console of [false, true]) {
      const r = launch(utf8Console ? 'clm-lone-ps1-utf8' : 'clm-lone-ps1', { bin: { 'claude.ps1': npmShim() }, constrained: true, utf8Console })
      expect(r.argv, r.stderr).toEqual(['-p', '--mcp-config', r.cfg, '--session-id', SESSION, '--dangerously-skip-permissions'])
      let stdin = r.stdin ?? Buffer.alloc(0)
      expect(stdin.subarray(0, 3).toString('hex')).toBe('efbbbf')
      while (stdin.subarray(0, 3).toString('hex') === 'efbbbf') stdin = stdin.subarray(3)
      expect(stdin.equals(Buffer.from(task + '\r\n', 'utf8')), r.stderr).toBe(true)
      expect(r.stdout).toContain('ConstrainedLanguage')
      expect(r.stderr).toBe('')
      expect(r.stdout.split(/\r?\n/)).toContain('[termpolis-conductor-exited] 0')
      expect(r.status).toBe(0)
    }
  }, 120_000)

  // Trace follows the conductor's session under the config home its claude gets from the shell,
  // which main reads from what the script recorded before it started claude.
  it('records the session and the CLAUDE_CONFIG_DIR claude gets, in either language mode, the path in UTF-8', () => {
    const configDir = join(dir, 'profiles', 'José ’s work')
    for (const constrained of [false, true]) {
      const tag = constrained ? 'clm-' : ''
      const none = launch(`${tag}record-none`, { bin: { 'claude.cmd': cmdShim() }, constrained })
      expect(none.recorded?.toString('utf8'), none.stderr).toBe(`\uFEFF${SESSION}\r\n\r\n`)
      const set = launch(`${tag}record-set`, { bin: { 'claude.cmd': cmdShim() }, constrained, configDir })
      expect(set.recorded?.toString('utf8'), set.stderr).toBe(`\uFEFF${SESSION}\r\n${configDir}\r\n`)
      expectDelivered(set, 0, constrained ? task : task + '\r\n')
    }
  }, 240_000)
})
