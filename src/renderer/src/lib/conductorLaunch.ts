import { psQuote, shQuote } from '../../../shared/shellQuote'

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

/** Where a run script finds its inputs. Paths are native: backslashes on Windows. */
export interface ConductorRunPaths {
  /** The prompt, written as UTF-8 without a BOM. */
  taskFile: string
  /** Claude's --mcp-config file. Empty leaves the flag out: `--mcp-config ''` is an error. */
  mcpConfigPath: string
  /** E2E only: the command resolveAgentCommand put in claude's place. It skips the binary probe,
   *  whose `--version` check a mock can't pass, and gets its prompt exactly as claude does. */
  testCommand?: string
}

const PS51_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const NO_CLAUDE = 'No working claude binary found. Install Claude Code natively or run: npm install -g @anthropic-ai/claude-code --force'

// The npm-global Claude Code install can end up with a broken bin/claude.exe stub when postinstall
// didn't run or the platform-native optional dep was skipped. PowerShell's PATH then resolves
// `claude` to a .ps1 shim that calls the stub → "not a valid application for this OS platform" →
// the conductor silently dies and the swarm stalls at 0 tasks. So the script probes candidate
// locations and picks the first that actually responds to `--version`. Only programs and scripts
// are looked up: an alias or a function has no path to run, and when `claude` isn't on PATH,
// asking for every command type makes 5.1 search its installed modules for one (7 s with a cold
// module cache, against under 3 s for these two types). With -CommandType, Get-Command lists every
// match on PATH (the npm folder's extensionless `claude` too), so -First 1 keeps the one
// PowerShell itself would run.
const RESOLVE_WORKING_CLAUDE = [
  'function Resolve-WorkingClaude {',
  '  $candidates = @()',
  '  try { $candidates += (Get-Command claude -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object Source) } catch {}',
  '  $candidates += "$env:USERPROFILE\\.local\\bin\\claude.exe"',
  '  $candidates += "$env:APPDATA\\npm\\node_modules\\@anthropic-ai\\claude-code\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\claude.exe"',
  '  $candidates += "$env:LOCALAPPDATA\\Programs\\claude-code\\claude.exe"',
  '  foreach ($c in $candidates) {',
  '    if (-not $c) { continue }',
  '    if (-not (Test-Path $c)) { continue }',
  '    try {',
  '      $out = & $c --version 2>&1',
  '      if ($LASTEXITCODE -eq 0 -and "$out" -match "Claude Code") { return $c }',
  '    } catch {}',
  '  }',
  `  Write-Error "${NO_CLAUDE}"`,
  '  exit 1',
  '}',
  '$claudeExe = Resolve-WorkingClaude',
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
  '  exit 1',
  '}',
]

/** The run script: `.termpolis-conductor-run.ps1` on Windows, `.termpolis-conductor-run.sh`
 *  elsewhere. Every path in it is a single-quoted literal, so a `$` or a backtick in a user name
 *  expands to nothing. */
export function conductorRunScript(isWindows: boolean, { taskFile, mcpConfigPath, testCommand }: ConductorRunPaths): string {
  const quote = isWindows ? psQuote : shQuote
  const flags = `-p${mcpConfigPath ? ` --mcp-config ${quote(mcpConfigPath)}` : ''} --dangerously-skip-permissions`
  if (isWindows) {
    return [
      ...(testCommand ? [] : RESOLVE_WORKING_CLAUDE),
      // UTF-8 without a BOM both ways. 5.1 pipes text to a native program in $OutputEncoding,
      // which is ASCII by default (every non-ASCII character became `?`), and when the console is
      // on code page 65001 .NET writes [Console]::InputEncoding's BOM into the pipe ahead of it.
      // Get-Content needs -Encoding as well: 5.1 reads a BOM-less file as ANSI (`—` became `â€”`).
      '$enc = New-Object System.Text.UTF8Encoding $false',
      '$OutputEncoding = $enc',
      '[Console]::InputEncoding = $enc',
      `Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(taskFile)} | ${testCommand ?? '& $claudeExe'} ${flags}`,
      'exit $LASTEXITCODE',
      '',
    ].join('\n')
  }
  return [
    '#!/bin/bash',
    `TASK_FILE=${shQuote(taskFile)}`,
    ...(testCommand ? [] : RESOLVE_CLAUDE),
    `${testCommand ?? '"$CLAUDE_EXE"'} ${flags} < "$TASK_FILE"`,
    '',
  ].join('\n')
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
