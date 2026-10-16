import { describe, it, expect } from 'vitest'
import { conductorRunScript, conductorLaunchCommand } from '../../src/renderer/src/lib/conductorLaunch'

// GitHub #36: on Windows the conductor's whole prompt went on the command line through
// Windows PowerShell 5.1, which ends a native argument at every embedded `"`. The rest of
// the prompt arrived as extra arguments, `--watch`-like words as options, and claude exited.
// The prompt now goes on stdin. These pin the shape; conductorLaunch.win.test.ts runs it.

const WIN = {
  taskFile: "C:\\Users\\O'Brien $x\\.termpolis-conductor-task.md",
  mcpConfigPath: "C:\\Users\\O'Brien $x\\AppData\\Roaming\\termpolis\\claude-mcp-config.json",
}
const UNIX = {
  taskFile: "/home/o'brien/.termpolis-conductor-task.md",
  mcpConfigPath: "/home/o'brien/.config/termpolis/claude-mcp-config.json",
}

describe('conductorRunScript on Windows', () => {
  const script = conductorRunScript(true, WIN)

  it('pipes the task file into claude on stdin and puts only flags on its command line', () => {
    expect(script).toContain(
      "Get-Content -Raw -Encoding UTF8 -LiteralPath 'C:\\Users\\O''Brien $x\\.termpolis-conductor-task.md' | " +
        "& $claudeExe -p --mcp-config 'C:\\Users\\O''Brien $x\\AppData\\Roaming\\termpolis\\claude-mcp-config.json' --dangerously-skip-permissions",
    )
    expect(script).not.toContain('$task')
  })

  it('sets both encodings to UTF-8 without a BOM before the pipe', () => {
    // $OutputEncoding alone is not enough: with the console on code page 65001, .NET writes
    // [Console]::InputEncoding's BOM into the pipe first.
    expect(script).toContain('$enc = New-Object System.Text.UTF8Encoding $false')
    expect(script).toMatch(/^\$OutputEncoding = \$enc$/m)
    expect(script).toMatch(/\[Console\]::InputEncoding = \$enc/)
    const pipe = script.indexOf('Get-Content -Raw')
    expect(script.indexOf('$OutputEncoding = $enc')).toBeLessThan(pipe)
    expect(script.indexOf('[Console]::InputEncoding = $enc')).toBeLessThan(pipe)
  })

  it('never puts a path in double quotes, where a $ or a backtick in it would expand', () => {
    expect(script).not.toMatch(/"[^"\n]*termpolis-conductor-task\.md"/)
    expect(script).not.toMatch(/"[^"\n]*claude-mcp-config\.json"/)
  })

  it('still probes for a claude binary that answers --version', () => {
    expect(script).toContain('function Resolve-WorkingClaude {')
    expect(script).toContain('$claudeExe = Resolve-WorkingClaude')
  })

  it('leaves --mcp-config out when there is no config path, rather than pass it empty', () => {
    const bare = conductorRunScript(true, { ...WIN, mcpConfigPath: '' })
    expect(bare).not.toContain('--mcp-config')
    expect(bare).toContain('| & $claudeExe -p --dangerously-skip-permissions')
  })

  it('in test mode runs the stand-in with the same delivery and skips the binary probe', () => {
    const test = conductorRunScript(true, { ...WIN, testCommand: 'node e2e/mocks/mock-claude.cjs' })
    expect(test).not.toContain('Resolve-WorkingClaude')
    expect(test).toContain('[Console]::InputEncoding = $enc')
    expect(test).toContain(
      "Get-Content -Raw -Encoding UTF8 -LiteralPath 'C:\\Users\\O''Brien $x\\.termpolis-conductor-task.md' | " +
        "node e2e/mocks/mock-claude.cjs -p --mcp-config 'C:\\Users\\O''Brien $x\\AppData\\Roaming\\termpolis\\claude-mcp-config.json' --dangerously-skip-permissions",
    )
  })
})

describe('conductorRunScript on Linux and macOS', () => {
  const script = conductorRunScript(false, UNIX)

  it('feeds the task file on stdin, which no per-argument size cap applies to', () => {
    expect(script.startsWith('#!/bin/bash\n')).toBe(true)
    expect(script).toContain("TASK_FILE='/home/o'\\''brien/.termpolis-conductor-task.md'")
    expect(script).toContain(
      `"$CLAUDE_EXE" -p --mcp-config '/home/o'\\''brien/.config/termpolis/claude-mcp-config.json' --dangerously-skip-permissions < "$TASK_FILE"`,
    )
    expect(script).not.toContain('$(cat')
  })

  it('leaves --mcp-config out when there is no config path', () => {
    const bare = conductorRunScript(false, { ...UNIX, mcpConfigPath: '' })
    expect(bare).not.toContain('--mcp-config')
    expect(bare).toContain('"$CLAUDE_EXE" -p --dangerously-skip-permissions < "$TASK_FILE"')
  })

  it('in test mode runs the stand-in with the same delivery and skips the binary probe', () => {
    const test = conductorRunScript(false, { ...UNIX, testCommand: 'node e2e/mocks/mock-claude.cjs' })
    expect(test).not.toContain('resolve_claude')
    expect(test).toContain(
      "node e2e/mocks/mock-claude.cjs -p --mcp-config '/home/o'\\''brien/.config/termpolis/claude-mcp-config.json' --dangerously-skip-permissions < \"$TASK_FILE\"",
    )
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
