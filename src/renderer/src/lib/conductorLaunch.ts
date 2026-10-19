import { psQuote, shQuote } from '../../../shared/shellQuote'
import { stripAnsi } from './exportTerminal'

// The scripts that start the swarm conductor (`claude -p`) in its hidden terminal, and the line
// typed into that terminal to run them. Pure, so unit tests pin the shapes and
// conductorLaunch.win.test.ts can run the Windows script in a real Windows PowerShell 5.1.
//
// The prompt goes on STDIN, never on the command line (GitHub #36). The Windows script always runs
// under Windows PowerShell 5.1, which hands a native program an argument with whitespace wrapped in
// quotes and escapes nothing (secondOpinion.ts works around the same rule), so every `"` in the
// prompt ended the argument. The rest arrived as extra argv entries and words like `--watch` as
// options, and claude rejected them and exited before it did anything. The built-in conductor
// prompt has double quotes of its own, so part of it was lost on every Windows run. A command line
// is capped as well (32,767 chars on Windows, 128 KiB per argument on Linux); a pipe is not.
//
// When claude exits, the shell in the conductor terminal lives on, so nothing about the terminal
// changes. The scripts therefore print CONDUCTOR_EXIT_SENTINEL and claude's exit code on a line of
// their own, which findConductorExit reads back out of the terminal's output.

/** What a run script prints, on its own line and followed by claude's exit code, when claude exits. */
export const CONDUCTOR_EXIT_SENTINEL = '[termpolis-conductor-exited]'

/** What a run script prints first, on its own line. An exit report quotes only what follows it:
 *  before it is the terminal's echo of the launch line, which PSReadLine can draw more than once,
 *  in pieces cut anywhere, so nothing in a line's text tells it from the conductor's output. */
export const CONDUCTOR_START_LINE = '[termpolis-conductor-started]'

/** Where a run script finds its inputs. Paths are native: backslashes on Windows. */
export interface ConductorRunPaths {
  /** The prompt, written as UTF-8 without a BOM. */
  taskFile: string
  /** Claude's --mcp-config file. Empty leaves the flag out: `--mcp-config ''` is an error. */
  mcpConfigPath: string
  /** The UUID claude starts its session with (`--session-id`). Its transcript is `<id>.jsonl`, which
   *  is how the dashboard's Trace follows this conductor's and no other session's. */
  sessionId: string
  /** Where the script records that id and claude's config home (CONDUCTOR_CLAUDE_HOME_FILE). */
  claudeHomeFile: string
  /** E2E only: the command resolveAgentCommand put in claude's place. It skips the binary probe,
   *  whose `--version` check a mock can't pass, and gets its prompt exactly as claude does. A
   *  program and its arguments, none with a space in it (`node e2e/mocks/mock-claude.cjs`): in
   *  Constrained Language Mode its first word is the program Start-Process starts. */
  testCommand?: string
}

const PS51_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const NO_CLAUDE = 'No working claude binary found. Install Claude Code natively or run: npm install -g @anthropic-ai/claude-code --force'
const CONSTRAINED = 'PowerShell runs this script in ConstrainedLanguage mode (AppLocker or WDAC), so the task goes to claude as UTF-8 with a byte order mark in front.'

// The npm-global Claude Code install can end up with a broken bin/claude.exe stub when postinstall
// didn't run or the platform-native optional dep was skipped. PowerShell's PATH then resolves
// `claude` to a .ps1 shim that calls the stub → "not a valid application for this OS platform" →
// the conductor silently dies and the swarm stalls at 0 tasks. So the script probes candidate
// locations and picks the first that actually responds to `--version`. Only programs and scripts
// are looked up: an alias or a function has no path to run, and when `claude` isn't on PATH,
// asking for every command type makes 5.1 search its installed modules for one (7 s with a cold
// module cache, against under 3 s for these two types). With -CommandType, Get-Command lists every
// match on PATH (the npm folder's extensionless `claude` too), so -First 1 keeps the one
// PowerShell itself would run. Each candidate is checked by its literal path: Test-Path reads a
// path as a wildcard pattern, and a claude in a folder named with square brackets was skipped.
const RESOLVE_WORKING_CLAUDE = [
  'function Resolve-WorkingClaude {',
  '  $candidates = @()',
  '  try { $candidates += (Get-Command claude -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object Source) } catch {}',
  '  $candidates += "$env:USERPROFILE\\.local\\bin\\claude.exe"',
  '  $candidates += "$env:APPDATA\\npm\\node_modules\\@anthropic-ai\\claude-code\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\claude.exe"',
  '  $candidates += "$env:LOCALAPPDATA\\Programs\\claude-code\\claude.exe"',
  '  foreach ($c in $candidates) {',
  '    if (-not $c) { continue }',
  '    if (-not (Test-Path -LiteralPath $c)) { continue }',
  '    try {',
  '      $out = & $c --version 2>&1',
  '      if ($LASTEXITCODE -eq 0 -and "$out" -match "Claude Code") { return $c }',
  '    } catch {}',
  '  }',
  '}',
  '$claudeExe = Resolve-WorkingClaude',
  'if (-not $claudeExe) {',
  `  Write-Output ${psQuote(NO_CLAUDE)}`,
  `  Write-Output '${CONDUCTOR_EXIT_SENTINEL} 1'`,
  '  exit 1',
  '}',
]

// The same probe for bash: PATH first, then the native installer's, /usr/local's and Homebrew's
// locations, each checked by what its --version prints.
const RESOLVE_CLAUDE = [
  'resolve_claude() {',
  '  local cands=()',
  '  command -v claude >/dev/null 2>&1 && cands+=("$(command -v claude)")',
  '  cands+=("$HOME/.local/bin/claude")',
  '  cands+=("/usr/local/bin/claude")',
  '  cands+=("/opt/homebrew/bin/claude")',
  '  for c in "${cands[@]}"; do',
  '    [ -x "$c" ] || continue',
  '    if out=$("$c" --version 2>&1) && echo "$out" | grep -q "Claude Code"; then',
  '      echo "$c"; return 0',
  '    fi',
  '  done',
  '  return 1',
  '}',
  'CLAUDE_EXE=$(resolve_claude) || {',
  `  echo "${NO_CLAUDE}" >&2`,
  `  echo "${CONDUCTOR_EXIT_SENTINEL} 1"`,
  '  exit 1',
  '}',
]

/** The run script: `.termpolis-conductor-run.ps1` on Windows, `.termpolis-conductor-run.sh`
 *  elsewhere. Every path in it is a single-quoted literal, so a `$` or a backtick in a user name
 *  expands to nothing. */
export function conductorRunScript(isWindows: boolean, { taskFile, mcpConfigPath, sessionId, claudeHomeFile, testCommand }: ConductorRunPaths): string {
  const quote = isWindows ? psQuote : shQuote
  const flags = `-p${mcpConfigPath ? ` --mcp-config ${quote(mcpConfigPath)}` : ''} --session-id ${quote(sessionId)} --dangerously-skip-permissions`
  if (isWindows) {
    const pipe = (command: string): string => `Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(taskFile)} | ${command} ${flags}`
    // The same flags as one command line, for a program Start-Process starts: double quotes around
    // the one path, which can hold no `"` and doesn't end in a backslash.
    const commandLine = `-p${mcpConfigPath ? ` --mcp-config "${mcpConfigPath}"` : ''} --session-id ${sessionId} --dangerously-skip-permissions`
    // Its exit code is read through a handle taken while it runs: a process object that has none
    // can't get one once it has exited, and its ExitCode is empty. Wait-Process waits for it alone,
    // not for what it leaves running, as -Wait would.
    const start = (program: string, args: string): string[] => [
      `$run = Start-Process -FilePath ${program} -ArgumentList ${psQuote(args)} -NoNewWindow -PassThru -RedirectStandardInput ${psQuote(taskFile)}`,
      'if ($run) {',
      '  $null = $run.Handle',
      '  Wait-Process -InputObject $run',
      '  $global:LASTEXITCODE = $run.ExitCode',
      '}',
    ]
    const indent = (lines: string[]): string[] => lines.map((line) => `  ${line}`)
    const [testProgram, ...testArgs] = (testCommand ?? '').split(' ')
    // ConstrainedLanguage (AppLocker or WDAC runs an untrusted script in it) refuses New-Object and
    // setting [Console]::InputEncoding, so no UTF-8 without a BOM can be made for the pipe, and its
    // stock UTF-8 put one in front of the task (WL-4). Start-Process hands the program the task
    // file itself as its stdin instead. It can't start npm's PowerShell shim, but it can start the
    // claude.cmd npm writes beside it. A .ps1 with no .cmd beside it is still piped to, behind a
    // BOM, which the output says.
    const constrained = testCommand
      ? start(psQuote(testProgram), [...testArgs, commandLine].join(' '))
      : [
          '$launcher = $claudeExe',
          "$cmdShim = $launcher -replace '\\.ps1$', '.cmd'",
          "if ($launcher -like '*.ps1' -and (Test-Path -LiteralPath $cmdShim)) { $launcher = $cmdShim }",
          "if ($launcher -like '*.ps1') {",
          '  $OutputEncoding = [System.Text.Encoding]::UTF8',
          `  Write-Output ${psQuote(CONSTRAINED)}`,
          `  ${pipe('& $launcher')}`,
          '} else {',
          ...indent(start('$launcher', commandLine)),
          '}',
        ]
    // A BOM first, which writeConfigFile writes as UTF-8's: 5.1 reads a .ps1 without one in the
    // ANSI code page, and the paths here are under the user's home folder. "José" came out as
    // "JosÃ©", and Ñ, ł or ’ as bytes that read as quotes and ended the literal early.
    return '\uFEFF' + [
      `Write-Output '${CONDUCTOR_START_LINE}'`,
      ...(testCommand ? [] : RESOLVE_WORKING_CLAUDE),
      // Where claude keeps this session's transcript, for Trace: under the config home it gets from
      // this shell, which its profile or a command typed before the run can have set.
      `Set-Content -LiteralPath ${psQuote(claudeHomeFile)} -Value ${psQuote(sessionId)}, "$env:CLAUDE_CONFIG_DIR" -Encoding UTF8 -ErrorAction SilentlyContinue`,
      // The probe's `--version` left 0 here, and a pipe that fails before claude starts (a binary
      // gone since, a parameter that won't bind) sets nothing: the report would say "exited 0".
      // Global, or a script variable would hide the one the native command sets.
      '$global:LASTEXITCODE = $null',
      // UTF-8 without a BOM both ways. 5.1 pipes text to a native program in $OutputEncoding,
      // which is ASCII by default (every non-ASCII character became `?`), and when the console is
      // on code page 65001 .NET writes [Console]::InputEncoding's BOM into the pipe ahead of it.
      // Get-Content needs -Encoding as well: 5.1 reads a BOM-less file as ANSI (`—` became `â€”`).
      "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {",
      '  $enc = New-Object System.Text.UTF8Encoding $false',
      '  $OutputEncoding = $enc',
      '  [Console]::InputEncoding = $enc',
      `  ${pipe(testCommand ?? '& $claudeExe')}`,
      '} else {',
      ...indent(constrained),
      '}',
      '$code = $LASTEXITCODE',
      // A command that never started sets no exit code, and the report needs one.
      'if ($null -eq $code) { $code = 1 }',
      // Blank lines first: output that ends mid-line would otherwise have the report join it. Two,
      // because ConPTY draws the first as nothing after output that filled its last row.
      "Write-Output ''",
      "Write-Output ''",
      `Write-Output "${CONDUCTOR_EXIT_SENTINEL} $code"`,
      'exit $code',
      '',
    ].join('\n')
  }
  return [
    '#!/bin/bash',
    `echo '${CONDUCTOR_START_LINE}'`,
    `TASK_FILE=${shQuote(taskFile)}`,
    ...(testCommand ? [] : RESOLVE_CLAUDE),
    `printf '%s\\n%s\\n' ${shQuote(sessionId)} "\${CLAUDE_CONFIG_DIR-}" 2>/dev/null > ${shQuote(claudeHomeFile)}`,
    `${testCommand ?? '"$CLAUDE_EXE"'} ${flags} < "$TASK_FILE"`,
    'code=$?',
    'echo',
    `echo "${CONDUCTOR_EXIT_SENTINEL} $code"`,
    'exit $code',
    '',
  ].join('\n')
}

export interface ConductorExit {
  /** claude's exit code. */
  code: number
  /** The last non-empty lines the terminal showed before the report, oldest first. */
  lastLines: string[]
}

/** How many of the conductor's last lines an exit report quotes. */
const EXIT_TAIL_LINES = 15
const EXIT_LINE = /^\[termpolis-conductor-exited\]\s*(-?\d+)$/

// A cursor move to another row starts a new screen line. ConPTY draws its repaints that way, and
// stripping the move would glue two lines of the screen into one.
const ROW_MOVE = /\x1b\[\d*(?:;\d*)?[Hf]|\x1b\[\d*[ABEFd]/g
// A cursor-forward is the cells it moves over: ConPTY draws a tab, or a run of cells that didn't
// change, that way, and stripping it would glue the words either side together.
const CURSOR_FORWARD = /\x1b\[(\d*)C/g

/** A backspace takes back the character before it: PSReadLine echoes a typed line that way. One
 *  pass over the line, since this runs on every monitor tick and every Debug refresh. */
function applyBackspaces(line: string): string {
  if (!line.includes('\b')) return line
  const kept: string[] = []
  for (const ch of line) {
    if (ch === '\b') kept.pop()
    else kept.push(ch)
  }
  return kept.join('')
}

function screenLines(output: string): string[] {
  const spaced = output.replace(CURSOR_FORWARD, (_, n: string) => ' '.repeat(Math.min(Number(n) || 1, 200)))
  return stripAnsi(spaced.replace(ROW_MOVE, '\n'))
    .split(/\r\n|\r|\n/)
    .map((line) => applyBackspaces(line).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd())
}

/** The run script's report that claude exited, read from the conductor terminal's output since
 *  launch, or null while claude still runs. Only a whole line counts: a prompt, an echoed script
 *  line or claude's own output that quotes the sentinel mid-line is no exit. Nor is the line still
 *  being written, which a read can cut short in the middle of its code (the `1` of `127`). */
export function findConductorExit(output: string): ConductorExit | null {
  const lines = screenLines(output)
  lines.pop()
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = EXIT_LINE.exec(lines[i].trim())
    if (!m) continue
    // What the script and claude printed: after the script's first line, so not the echoed launch
    // line. Without that line (the buffer evicted it, and the echo before it), all that is left.
    let from = 0
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j].endsWith(CONDUCTOR_START_LINE)) { from = j + 1; break }
    }
    const printed = lines.slice(from, i).filter((line) => line.trim() !== '')
    return { code: Number(m[1]), lastLines: printed.slice(-EXIT_TAIL_LINES) }
  }
  return null
}

/** The conductor terminal's output as plain text, for the dashboard's read-only Debug view. */
export function conductorScreenText(output: string): string {
  return screenLines(output).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The line typed into the conductor terminal to run the script.
 *
 * On Windows that terminal may be pwsh 7 or Windows PowerShell 5.1, so this is a pure PowerShell
 * one-liner with no dependency on PATH for `cmd` or bare `powershell`:
 *   - pwsh 7 intentionally omits Windows PowerShell from its PATH, so bare `powershell` fails.
 *   - If the renderer process inherited a stripped PATH that's missing System32, bare `cmd` also
 *     fails (this was the v1.11.4 regression).
 * Invoking PS 5.1 by its canonical absolute path, with the current interpreter as a fallback,
 * sidesteps PATH entirely. Test-Path and the call operator `&` are built-in PowerShell language.
 */
export function conductorLaunchCommand(isWindows: boolean, scriptFile: string): string {
  if (!isWindows) return `bash ${shQuote(scriptFile)}`
  return (
    `$p='${PS51_PATH}'; ` +
    `if (-not (Test-Path $p)) { $p=(Get-Process -Id $PID).Path }; ` +
    `& $p -ExecutionPolicy Bypass -File ${psQuote(scriptFile)}`
  )
}
