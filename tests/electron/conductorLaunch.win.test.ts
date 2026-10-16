import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { conductorRunScript, conductorLaunchCommand } from '../../src/renderer/src/lib/conductorLaunch'
import { psQuote } from '../../src/shared/shellQuote'
import { powershellPath } from '../../src/main/secondOpinion'

// GitHub #36. The conductor's run script promises that claude gets the task EXACTLY, on stdin,
// with only flags on its command line. That rests on Windows PowerShell 5.1's pipeline and
// encoding rules, which no string assertion can prove, so this runs the generated script in the
// real powershell.exe, through the production launch line, against claude stand-ins that record
// what they received. PATH and the profile folders point into a temp sandbox, so the script's
// binary probe can never find a real claude on a developer's machine.
describe.runIf(process.platform === 'win32')('conductor run script on real Windows PowerShell', () => {
  let dir = ''
  let recorder = ''
  // Every hazard from the report: quotes, option-like words, non-ASCII, and a body past the
  // 32,767-char Windows command line.
  let task = 'You are the Swarm Conductor — orchestrate the task.\nGoal: run "npm test --watch" -NoProfile, then reply "all good" ✓ → ⚠\n'
  for (let i = 0; task.length < 40_000; i++) task += `Line ${i}: "quoted" --flag-${i} -NoProfile — ✓ → 'single' $env:PATH \`tick\`\n`

  beforeAll(() => {
    // A home folder name that needs the single-quoted literals: a space, an apostrophe and a $.
    dir = mkdtempSync(join(tmpdir(), "tp-conductor O'Brien $x-"))
    recorder = join(dir, 'recorder.cjs')
    // Written to files rather than stdout so the check can't depend on console code pages.
    writeFileSync(recorder, [
      "const fs = require('fs')",
      'const argv = process.argv.slice(2)',
      "if (argv.includes('--version')) { console.log('2.1.300 (Claude Code)'); process.exit(0) }",
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
  })

  /** Runs one launch the way the conductor terminal does: an outer PowerShell types the launch
   *  line, which runs the script in PS 5.1. `utf8Console` leaves the console on code page 65001
   *  first, as a profile that sets UTF-8 does: that is when .NET writes a BOM into the pipe. */
  function launch(name: string, opts: { bin?: Record<string, string>; testCommand?: string; utf8Console?: boolean; exitCode?: number; say?: string }): { status: number | null; stdout: string; stderr: string; argv: string[] | null; stdin: Buffer | null; cfg: string } {
    const root = join(dir, name)
    const home = join(root, 'home')
    const bin = join(root, 'bin')
    mkdirSync(join(home, 'AppData', 'Local'), { recursive: true })
    mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    for (const [file, content] of Object.entries(opts.bin ?? {})) writeFileSync(join(bin, file), content)
    const taskFile = join(home, '.termpolis-conductor-task.md')
    const cfg = join(home, 'AppData', 'Roaming', 'claude-mcp-config.json')
    const script = join(home, '.termpolis-conductor-run.ps1')
    writeFileSync(taskFile, task, 'utf8') // BOM-less, as configFileManager writes it
    writeFileSync(cfg, '{"mcpServers":{}}')
    writeFileSync(script, conductorRunScript(true, { taskFile, mcpConfigPath: cfg, testCommand: opts.testCommand }))
    const outer = join(root, 'outer.ps1')
    const pre = opts.utf8Console ? '[Console]::InputEncoding = [Text.Encoding]::UTF8\r\n' : ''
    writeFileSync(outer, `${pre}${conductorLaunchCommand(true, script)}\r\nexit $LASTEXITCODE\r\n`)

    const record = join(root, 'record.json')
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k]
    const sys = process.env.SystemRoot || 'C:\\Windows'
    env.PATH = [bin, join(sys, 'System32'), sys, join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
    env.USERPROFILE = home
    env.APPDATA = join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA = join(home, 'AppData', 'Local')
    env.TP_RECORD = record
    env.TP_EXIT = String(opts.exitCode ?? 0)
    env.TP_SAY = opts.say ?? ''
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

  function expectDelivered(r: ReturnType<typeof launch>, exitCode = 0): void {
    expect(r.argv, r.stderr).toEqual(['-p', '--mcp-config', r.cfg, '--dangerously-skip-permissions'])
    // Byte for byte: no BOM in front, nothing garbled, only the CRLF PowerShell appends.
    expect(r.stdin?.equals(Buffer.from(task + '\r\n', 'utf8')), r.stderr).toBe(true)
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
})
