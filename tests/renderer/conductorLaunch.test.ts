import { describe, it, expect } from 'vitest'
import {
  conductorRunScript,
  conductorLaunchCommand,
  findConductorExit,
  conductorScreenText,
  CONDUCTOR_EXIT_SENTINEL,
  CONDUCTOR_START_LINE,
} from '../../src/renderer/src/lib/conductorLaunch'

// GitHub #36: on Windows the conductor's whole prompt went on the command line through
// Windows PowerShell 5.1, which ends a native argument at every embedded `"`. The rest of
// the prompt arrived as extra arguments, `--watch`-like words as options, and claude exited.
// The prompt now goes on stdin. These pin the shape; conductorLaunch.win.test.ts runs it.

const SESSION = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
const WIN = {
  taskFile: "C:\\Users\\O'Brien $x\\.termpolis-conductor-task.md",
  mcpConfigPath: "C:\\Users\\O'Brien $x\\AppData\\Roaming\\termpolis\\claude-mcp-config.json",
  sessionId: SESSION,
}
const UNIX = {
  taskFile: "/home/o'brien/.termpolis-conductor-task.md",
  mcpConfigPath: "/home/o'brien/.config/termpolis/claude-mcp-config.json",
  sessionId: SESSION,
}

describe('conductorRunScript on Windows', () => {
  const script = conductorRunScript(true, WIN)

  it('pipes the task file into claude on stdin and puts only flags on its command line', () => {
    expect(script).toContain(
      "Get-Content -Raw -Encoding UTF8 -LiteralPath 'C:\\Users\\O''Brien $x\\.termpolis-conductor-task.md' | " +
        "& $claudeExe -p --mcp-config 'C:\\Users\\O''Brien $x\\AppData\\Roaming\\termpolis\\claude-mcp-config.json' --session-id '1b4e28ba-2fa1-41d2-883f-0016d3cca427' --dangerously-skip-permissions",
    )
    expect(script).not.toContain('$task')
  })

  it('starts with a BOM, so 5.1 reads the paths in it as UTF-8 and not in the ANSI code page', () => {
    // The paths are under the user's home folder. Without a BOM, 5.1 read "José" as "JosÃ©", and
    // the bytes of Ñ, ł or ’ as quotes that ended the literal before the path did.
    expect(script.charCodeAt(0)).toBe(0xfeff)
    expect(conductorRunScript(true, { ...WIN, testCommand: 'node m.cjs' }).charCodeAt(0)).toBe(0xfeff)
    // bash reads its script as the UTF-8 it is.
    expect(conductorRunScript(false, UNIX).charCodeAt(0)).toBe('#'.charCodeAt(0))
  })

  it('sets both encodings to UTF-8 without a BOM before the pipe', () => {
    // $OutputEncoding alone is not enough: with the console on code page 65001, .NET writes
    // [Console]::InputEncoding's BOM into the pipe first.
    expect(script).toContain('$enc = New-Object System.Text.UTF8Encoding $false')
    expect(script).toMatch(/^ {2}\$OutputEncoding = \$enc$/m)
    expect(script).toMatch(/\[Console\]::InputEncoding = \$enc/)
    const pipe = script.indexOf('Get-Content -Raw')
    expect(script.indexOf('$OutputEncoding = $enc')).toBeLessThan(pipe)
    expect(script.indexOf('[Console]::InputEncoding = $enc')).toBeLessThan(pipe)
  })

  // AppLocker and WDAC run an untrusted script, such as one in the home folder, in
  // ConstrainedLanguage, which refuses New-Object and setting [Console]::InputEncoding. The
  // defaults then turned every non-ASCII character of the prompt into '?', with no word of it, and
  // its stock UTF-8 put a BOM in front (WL-4). Start-Process hands claude the task file itself.
  const START = (program: string, args: string): string =>
    `$run = Start-Process -FilePath ${program} -ArgumentList '${args}' -NoNewWindow -PassThru -RedirectStandardInput 'C:\\Users\\O''Brien $x\\.termpolis-conductor-task.md'\n` +
    'if ($run) {\n  $null = $run.Handle\n  Wait-Process -InputObject $run\n  $global:LASTEXITCODE = $run.ExitCode\n}'
  const ARGS = `-p --mcp-config "C:\\Users\\O''Brien $x\\AppData\\Roaming\\termpolis\\claude-mcp-config.json" --session-id ${SESSION} --dangerously-skip-permissions`
  const indented = (text: string, by: number): string => text.split('\n').map((line) => ' '.repeat(by) + line).join('\n')

  it('pipes the task only in FullLanguage, where the encodings can be set', () => {
    expect(script).toContain(
      "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {\n  $enc = New-Object System.Text.UTF8Encoding $false\n" +
        '  $OutputEncoding = $enc\n  [Console]::InputEncoding = $enc\n  Get-Content -Raw ',
    )
  })

  it('in ConstrainedLanguage hands claude the task file itself as its stdin, with Start-Process', () => {
    expect(script).toContain(`\n  } else {\n${indented(START('$launcher', ARGS), 4)}\n  }\n}\n$code = $LASTEXITCODE\n`)
    // Neither the pipe's BOM nor its encodings: the only Start-Process is after the FullLanguage pipe.
    expect(script.indexOf('Start-Process')).toBeGreaterThan(script.indexOf("-eq 'FullLanguage'"))
  })

  it("starts the claude.cmd npm writes beside its PowerShell shim, which Start-Process can't start", () => {
    expect(script).toContain(
      "} else {\n  $launcher = $claudeExe\n  $cmdShim = $launcher -replace '\\.ps1$', '.cmd'\n" +
        "  if ($launcher -like '*.ps1' -and (Test-Path -LiteralPath $cmdShim)) { $launcher = $cmdShim }\n  if ($launcher -like '*.ps1') {\n",
    )
  })

  it('pipes to a .ps1 with no claude.cmd beside it in ConstrainedLanguage, as UTF-8 behind a BOM, and says so', () => {
    expect(script).toMatch(
      /\n {2}if \(\$launcher -like '\*\.ps1'\) \{\n {4}\$OutputEncoding = \[System\.Text\.Encoding\]::UTF8\n {4}Write-Output '[^'\n]*ConstrainedLanguage[^'\n]*byte order mark[^'\n]*'\n {4}Get-Content -Raw -Encoding UTF8 -LiteralPath '[^\n]*\.termpolis-conductor-task\.md' \| & \$launcher -p --mcp-config '[^\n]*' --session-id '[^']+' --dangerously-skip-permissions\n {2}\} else \{\n/,
    )
  })

  it("in test mode starts the stand-in's program with Start-Process, its arguments in front of claude's", () => {
    const test = conductorRunScript(true, { ...WIN, testCommand: 'node e2e/mocks/mock-claude.cjs' })
    expect(test).toContain(`\n} else {\n${indented(START("'node'", `e2e/mocks/mock-claude.cjs ${ARGS}`), 2)}\n}\n$code = $LASTEXITCODE\n`)
    expect(test).not.toContain('$launcher')
    // A program alone, with no arguments of its own.
    expect(conductorRunScript(true, { ...WIN, testCommand: 'mock-claude' })).toContain(`-FilePath 'mock-claude' -ArgumentList '${ARGS}' `)
  })

  it('leaves --mcp-config out of the Start-Process command line too when there is no config path', () => {
    const bare = conductorRunScript(true, { ...WIN, mcpConfigPath: '' })
    expect(bare).toContain(`-ArgumentList '-p --session-id ${SESSION} --dangerously-skip-permissions' `)
  })

  it("clears the last exit code before claude is started either way: one that never starts reports 1, not the probe's 0", () => {
    // Resolve-WorkingClaude's `--version` leaves $LASTEXITCODE at 0, so a pipe that failed before
    // claude ran (a binding error, a binary gone) reported "exited 0", and so would a Start-Process
    // that started nothing. Global: a script-scope variable would hide the one the native command sets.
    for (const s of [script, conductorRunScript(true, { ...WIN, testCommand: 'node m.cjs' })]) {
      expect(s).toMatch(/\n\$global:LASTEXITCODE = \$null\nif \(\$ExecutionContext\.SessionState\.LanguageMode -eq 'FullLanguage'\) \{\n/)
      expect(s.match(/\$global:LASTEXITCODE = \$null/g)).toHaveLength(1)
      expect(s).toContain('if ($null -eq $code) { $code = 1 }')
    }
  })

  it('never puts a path in a double-quoted PowerShell string, where a $ or a backtick in it would expand', () => {
    // Start-Process's command line is a single-quoted literal, whose double quotes are the program's.
    const outsideLiterals = script.replace(/'(?:[^']|'')*'/g, "''")
    expect(outsideLiterals).not.toMatch(/termpolis-conductor-task\.md|claude-mcp-config\.json/)
    expect(script).not.toMatch(/"[^"'\n]*termpolis-conductor-task\.md"/)
  })

  it('still probes for a claude binary that answers --version', () => {
    expect(script).toContain('function Resolve-WorkingClaude {')
    expect(script).toContain('$claudeExe = Resolve-WorkingClaude')
    // Only a program or a script, the first one PATH gives: any command type made 5.1 search its
    // modules when claude was missing, and the narrowed lookup lists every match on PATH.
    expect(script).toContain(
      'Get-Command claude -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object Source',
    )
  })

  it('leaves --mcp-config out when there is no config path, rather than pass it empty', () => {
    const bare = conductorRunScript(true, { ...WIN, mcpConfigPath: '' })
    expect(bare).not.toContain('--mcp-config')
    expect(bare).toContain("| & $claudeExe -p --session-id '1b4e28ba-2fa1-41d2-883f-0016d3cca427' --dangerously-skip-permissions")
  })

  it('in test mode runs the stand-in with the same delivery and skips the binary probe', () => {
    const test = conductorRunScript(true, { ...WIN, testCommand: 'node e2e/mocks/mock-claude.cjs' })
    expect(test).not.toContain('Resolve-WorkingClaude')
    expect(test).toContain('[Console]::InputEncoding = $enc')
    expect(test).toContain(
      "Get-Content -Raw -Encoding UTF8 -LiteralPath 'C:\\Users\\O''Brien $x\\.termpolis-conductor-task.md' | " +
        "node e2e/mocks/mock-claude.cjs -p --mcp-config 'C:\\Users\\O''Brien $x\\AppData\\Roaming\\termpolis\\claude-mcp-config.json' --session-id '1b4e28ba-2fa1-41d2-883f-0016d3cca427' --dangerously-skip-permissions",
    )
  })
})

describe('conductorRunScript on Linux and macOS', () => {
  const script = conductorRunScript(false, UNIX)

  it('feeds the task file on stdin, which no per-argument size cap applies to', () => {
    expect(script.startsWith('#!/bin/bash\n')).toBe(true)
    expect(script).toContain("TASK_FILE='/home/o'\\''brien/.termpolis-conductor-task.md'")
    expect(script).toContain(
      `"$CLAUDE_EXE" -p --mcp-config '/home/o'\\''brien/.config/termpolis/claude-mcp-config.json' --session-id '1b4e28ba-2fa1-41d2-883f-0016d3cca427' --dangerously-skip-permissions < "$TASK_FILE"`,
    )
    expect(script).not.toContain('$(cat')
  })

  it('leaves --mcp-config out when there is no config path', () => {
    const bare = conductorRunScript(false, { ...UNIX, mcpConfigPath: '' })
    expect(bare).not.toContain('--mcp-config')
    expect(bare).toContain(`"$CLAUDE_EXE" -p --session-id '1b4e28ba-2fa1-41d2-883f-0016d3cca427' --dangerously-skip-permissions < "$TASK_FILE"`)
  })

  it('in test mode runs the stand-in with the same delivery and skips the binary probe', () => {
    const test = conductorRunScript(false, { ...UNIX, testCommand: 'node e2e/mocks/mock-claude.cjs' })
    expect(test).not.toContain('resolve_claude')
    expect(test).toContain(
      "node e2e/mocks/mock-claude.cjs -p --mcp-config '/home/o'\\''brien/.config/termpolis/claude-mcp-config.json' --session-id '1b4e28ba-2fa1-41d2-883f-0016d3cca427' --dangerously-skip-permissions < \"$TASK_FILE\"",
    )
  })
})

// Trace follows the conductor's own session's transcript, `<id>.jsonl`, which claude names after
// the id it is started with: not the newest transcript in the folder, which could be another's.
describe('the run scripts start claude under the session id they are given', () => {
  it('hand it to claude with --session-id in every launch mode: a single-quoted literal where it is code', () => {
    const id = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d'
    // Every way a script starts claude: the pipe (bash's, PowerShell's in FullLanguage and to a lone
    // .ps1 in ConstrainedLanguage), and Start-Process's command line, itself a literal.
    for (const [isWindows, paths, starts] of [[true, WIN, 3], [false, UNIX, 1]] as const) {
      for (const testCommand of [undefined, 'node e2e/mocks/mock-claude.cjs']) {
        const script = conductorRunScript(isWindows, { ...paths, sessionId: id, testCommand })
        const given = [...script.matchAll(/--session-id (\S+) --dangerously-skip-permissions/g)].map((m) => m[1])
        expect(given).toHaveLength(isWindows && testCommand ? 2 : starts)
        for (const value of given) expect([`'${id}'`, id]).toContain(value)
        expect(script.match(/--session-id/g)).toHaveLength(given.length)
        expect(script).toContain(` --session-id '${id}' --dangerously-skip-permissions`)
      }
    }
  })
})

// GitHub #36, item 2: when claude exited, the conductor terminal's own shell lived on, so
// nothing told the monitor and the swarm looked "running" forever.
describe('the run scripts report when claude exits', () => {
  it('print the sentinel and claude\'s exit code on a line of their own, then exit with that code (Windows)', () => {
    for (const script of [conductorRunScript(true, WIN), conductorRunScript(true, { ...WIN, testCommand: 'node e2e/mocks/mock-claude.cjs' })]) {
      // After claude, however it was started: the last } closes the FullLanguage test.
      expect(script).toMatch(/\n\}\n\$code = \$LASTEXITCODE\n/)
      // Two blank lines first: claude's output ending mid-line would otherwise take the report in,
      // and ConPTY draws the first of them as nothing when that output filled its last row.
      expect(script).toContain(`Write-Output ''\nWrite-Output ''\nWrite-Output "${CONDUCTOR_EXIT_SENTINEL} $code"\nexit $code\n`)
      // A command that never started leaves no exit code; the sentinel still needs one.
      expect(script).toContain('if ($null -eq $code) { $code = 1 }')
    }
  })

  it('print the sentinel and claude\'s exit code on a line of their own, then exit with that code (bash)', () => {
    for (const script of [conductorRunScript(false, UNIX), conductorRunScript(false, { ...UNIX, testCommand: 'node e2e/mocks/mock-claude.cjs' })]) {
      expect(script.endsWith(` < "$TASK_FILE"\ncode=$?\necho\necho "${CONDUCTOR_EXIT_SENTINEL} $code"\nexit $code\n`)).toBe(true)
    }
  })

  it('print a start line before anything else, so a report can leave out the echoed launch line', () => {
    // After the BOM, which is no line.
    expect(conductorRunScript(true, WIN).startsWith(`\uFEFFWrite-Output '${CONDUCTOR_START_LINE}'\nfunction Resolve-WorkingClaude {`)).toBe(true)
    expect(conductorRunScript(true, { ...WIN, testCommand: 'node m.cjs' }).startsWith(`\uFEFFWrite-Output '${CONDUCTOR_START_LINE}'\n$global:LASTEXITCODE = $null\n`)).toBe(true)
    expect(conductorRunScript(false, UNIX).startsWith(`#!/bin/bash\necho '${CONDUCTOR_START_LINE}'\nTASK_FILE=`)).toBe(true)
  })

  it('report exit code 1 when no claude binary answers, rather than leave without a word', () => {
    const ps = conductorRunScript(true, WIN)
    expect(ps).toContain(
      "if (-not $claudeExe) {\n  Write-Output 'No working claude binary found. Install Claude Code natively or run: npm install -g @anthropic-ai/claude-code --force'\n" +
        `  Write-Output '${CONDUCTOR_EXIT_SENTINEL} 1'\n  exit 1\n}\n`,
    )
    // The probe itself no longer exits the script, which skipped the report.
    expect(ps.slice(0, ps.indexOf('$claudeExe = Resolve-WorkingClaude'))).not.toContain('exit 1')
    const sh = conductorRunScript(false, UNIX)
    expect(sh).toContain(`>&2\n  echo "${CONDUCTOR_EXIT_SENTINEL} 1"\n  exit 1\n}\n`)
  })
})

describe('findConductorExit', () => {
  it('reads the code and the last lines the terminal showed before the sentinel', () => {
    const out = 'error: unknown option \'-NoProfile\'\r\n(Did you mean --no-profile?)\r\n[termpolis-conductor-exited] 1\r\nPS C:\\proj> '
    expect(findConductorExit(out)).toEqual({ code: 1, lastLines: ["error: unknown option '-NoProfile'", '(Did you mean --no-profile?)'] })
  })

  it('counts only a whole line: the sentinel quoted mid-line or in an echoed script line is no exit', () => {
    expect(findConductorExit('Claude said [termpolis-conductor-exited] 1 in passing\r\nnext\r\n')).toBeNull()
    expect(findConductorExit('+ Write-Output "[termpolis-conductor-exited] $code"\r\n+ ~~~~\r\n')).toBeNull()
    expect(findConductorExit('PS C:\\> echo [termpolis-conductor-exited] 0\r\n')).toBeNull()
  })

  it('waits for the line to end, so a read that cut it short is no exit, then finds it whole', () => {
    expect(findConductorExit('done\r\n[termpolis-conductor-ex')).toBeNull()
    // `1` of a code still arriving (`127`) must not be read as 1.
    expect(findConductorExit('done\r\n[termpolis-conductor-exited] 1')).toBeNull()
    expect(findConductorExit('done\r\n[termpolis-conductor-exited] 127\r\n')).toEqual({ code: 127, lastLines: ['done'] })
  })

  it('reads a ConPTY repaint, where a cursor move rather than a newline starts the next line', () => {
    const out = '\x1b[?25l\x1b[4;1HError: Invalid MCP configuration\x1b[K\x1b[5;1H\x1b[32m[termpolis-conductor-exited] 1\x1b[0m\x1b[K\x1b[6;1HPS C:\\proj> \x1b[?25h'
    expect(findConductorExit(out)).toEqual({ code: 1, lastLines: ['Error: Invalid MCP configuration'] })
  })

  // Captured from Windows PowerShell 5.1 through ConPTY, paths shortened. PSReadLine drew the
  // typed launch line twice, the first time cut off mid-path, so filtering lines by what they
  // say let a piece of it into the report. Everything before the start line is left out now.
  it('leaves out every piece of the echoed launch line, as ConPTY really draws it', () => {
    const typed = (end: string) => "$p\x1b[90m=\x1b[36m'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'\x1b[37m; " +
      '\x1b[92mif \x1b[37m(\x1b[90m-not \x1b[37m(\x1b[93mTest-Path \x1b[92m$p\x1b[37m)) { \x1b[92m$p\x1b[90m=\x1b[37m(\x1b[93mGet-Process ' +
      '\x1b[90m-Id \x1b[92m$PID\x1b[37m).\x1b[97mPath \x1b[37m}; & \x1b[92m$p \x1b[90m-ExecutionPolicy \x1b[37mBypass \x1b[90m-File ' +
      "\x1b[36m'C:\\Users\\me\\" + end
    const out = '\x1b[?25l\x1b[93m$\x1b[?25h\x1b[m\x1b[?25l\x1b[92m\x08' + typed('.termpolis-conductor') +
      '\x1b[?25l\x1b[m\x1b[92m\x1b[2;63H' + typed(".termpolis-conductor-run.ps1'\r\n") +
      '\x1b[?25h\x1b[m[termpolis-conductor-started]\r\nAll work handed out.\r\n\r\n[termpolis-conductor-exited] 0\r\n' +
      '\x1b]9;9;C:\\proj\x07PS C:\\proj> '
    expect(findConductorExit(out)).toEqual({ code: 0, lastLines: ['All work handed out.'] })
  })

  // Real ConPTY output at 80 columns, of a claude whose last 80 characters had no newline (killed or
  // crashed mid-line). ConPTY draws a full row that the cursor left as a soft wrap, so one blank
  // line put the report on the end of that row, where no whole-line rule finds it. With two, it
  // moves the cursor to the report's row first.
  it('finds the report after output that filled its last row with no newline', () => {
    const x = 'x'.repeat(80)
    expect(findConductorExit(`[termpolis-conductor-started]\r\n${x}[termpolis-conductor-exited] 4\r\n`)).toBeNull()
    expect(findConductorExit(`[termpolis-conductor-started]\r\n${x}\x1b[24;1H[termpolis-conductor-exited] 4\r\n`))
      .toEqual({ code: 4, lastLines: [x] })
  })

  it('reads a cursor-forward as the spaces it moves over: ConPTY draws a tab that way', () => {
    const out = '[termpolis-conductor-started]\r\nName\x1b[4CStatus\x1b[2CAgent\r\nlogin-ui\x1b[Crunning\r\n[termpolis-conductor-exited] 2\r\n'
    expect(findConductorExit(out)).toEqual({ code: 2, lastLines: ['Name    Status  Agent', 'login-ui running'] })
    expect(conductorScreenText('a\x1b[3Cb')).toBe('a   b')
  })

  it('reads a negative code, as Windows reports a process ended by Ctrl+C', () => {
    expect(findConductorExit('[termpolis-conductor-exited] -1073741510\r\n')?.code).toBe(-1073741510)
  })

  it('quotes at most the last 15 non-empty lines printed after the start line, not the echoed launch line', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const out = "PS C:\\> & $p -ExecutionPolicy Bypass -File 'C:\\Users\\me\\.termpolis-conductor-run.ps1'\r\n[termpolis-conductor-started]\r\n" +
      lines.join('\r\n\r\n') + '\r\n[termpolis-conductor-exited] 2\r\n'
    expect(findConductorExit(out)).toEqual({ code: 2, lastLines: lines.slice(-15) })
    expect(findConductorExit("$ bash '/home/me/.termpolis-conductor-run.sh'\r\n[termpolis-conductor-started]\r\n\r\n[termpolis-conductor-exited] 0\r\n"))
      .toEqual({ code: 0, lastLines: [] })
  })

  it('quotes everything before the report when the start line is no longer in the buffer', () => {
    expect(findConductorExit('...the end of a long answer\r\n\r\n[termpolis-conductor-exited] 0\r\n'))
      .toEqual({ code: 0, lastLines: ['...the end of a long answer'] })
  })

  it('takes the last report when the screen holds more than one', () => {
    expect(findConductorExit('[termpolis-conductor-exited] 1\r\nagain\r\n[termpolis-conductor-exited] 4\r\n')).toEqual({
      code: 4,
      lastLines: ['[termpolis-conductor-exited] 1', 'again'],
    })
  })
})

describe('conductorScreenText', () => {
  it('turns raw terminal output into plain lines, with no escapes and no runs of blank lines', () => {
    const out = '\x1b]0;title\x07\x1b[2J\x1b[1;1HWindows PowerShell\r\n\r\n\r\n\r\n\x1b[2;1H\x1b[33mPS C:\\proj>\x1b[0m run  \r\nspinner\rspinner done\r\n'
    expect(conductorScreenText(out)).toBe('Windows PowerShell\n\nPS C:\\proj> run\nspinner\nspinner done')
  })

  it('is empty for no output', () => {
    expect(conductorScreenText('')).toBe('')
  })

  it('applies backspaces, as PSReadLine echoes a typed line, and drops other control characters', () => {
    expect(conductorScreenText('\x1b[93m$\x1b[m\x1b[92m\x08$p\x1b[90m=1\r\n')).toBe('$p=1')
    expect(conductorScreenText('ab\x08\x08c\x07d\r\n\x08start')).toBe('cd\nstart')
  })

  it('takes back as many characters as there are backspaces, and no more', () => {
    expect(conductorScreenText('x'.repeat(16_000) + '\x08'.repeat(16_000) + 'left')).toBe('left')
    expect(conductorScreenText('keep' + 'x'.repeat(500) + '\x08'.repeat(500) + '!')).toBe('keep!')
  })
})

describe('conductorLaunchCommand', () => {
  it('runs the .ps1 through Windows PowerShell 5.1 by absolute path, its path a single-quoted literal', () => {
    const cmd = conductorLaunchCommand(true, "C:\\Users\\O'Brien $x\\.termpolis-conductor-run.ps1")
    expect(cmd).toBe(
      "$p='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; " +
        'if (-not (Test-Path $p)) { $p=(Get-Process -Id $PID).Path }; ' +
        "& $p -ExecutionPolicy Bypass -File 'C:\\Users\\O''Brien $x\\.termpolis-conductor-run.ps1'",
    )
  })

  it('runs the .sh with bash, its path single-quoted so the shell expands nothing in it', () => {
    expect(conductorLaunchCommand(false, '/home/$USER/.termpolis-conductor-run.sh')).toBe("bash '/home/$USER/.termpolis-conductor-run.sh'")
  })
})
