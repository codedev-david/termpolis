import * as pty from 'node-pty'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { app } from 'electron'
import type { ShellType } from './types'

interface PtyProcess {
  pty: pty.IPty
}

const processes = new Map<string, PtyProcess>()

// Trust prompt detection is handled by timed Enter sends in the renderer
// (AIProfiles.tsx, App.tsx, StartSwarmModal.tsx) since Claude Code's TUI
// doesn't reliably respond to output-based detection.

// Cache tool availability check — run once, reuse for all terminal spawns
let bundledToolsNeeded: boolean | null = null

function checkBundledToolsNeeded(): boolean {
  if (bundledToolsNeeded !== null) return bundledToolsNeeded
  const check = (cmd: string) => {
    try {
      execSync(process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`, { stdio: 'ignore', timeout: 2000, windowsHide: true })
      return true
    } catch { return false }
  }
  bundledToolsNeeded = !check('jq') || !check('yq') || !check('nano')
  return bundledToolsNeeded
}

export function spawnTerminal(
  id: string,
  executable: string,
  cwd: string,
  onData: (data: string) => void,
  extraPaths?: string[]
): void {
  const resolvedCwd = (() => {
    try { return existsSync(cwd) ? cwd : homedir() }
    catch { return homedir() }
  })()

  const toolsDir = join(
    app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'),
    'tools',
    process.platform
  )
  const sep = process.platform === 'win32' ? ';' : ':'
  const existingPath = process.env.PATH || process.env.Path || ''
  const needsBundled = checkBundledToolsNeeded()
  const extraPathStr = extraPaths?.length ? extraPaths.join(sep) + sep : ''
  // On Windows, ensure System32 + PowerShell 1.0 are on PATH so nested
  // `powershell` / `cmd` invocations resolve even when the parent Electron
  // process was launched with a stripped-down PATH (e.g., from Git Bash /
  // CI shells that don't include the Windows system directories).
  // Use exact-entry comparison, not substring-includes — otherwise
  // `C:\Windows\System32` is falsely considered present when the PATH
  // only contains the longer `C:\Windows\System32\WindowsPowerShell\v1.0`,
  // which leaves `cmd.exe` and `powershell.exe` unresolvable.
  const winSystemPath = process.platform === 'win32'
    ? (() => {
        const existingEntries = new Set(
          existingPath
            .split(sep)
            .map((e) => e.replace(/[\\/]+$/, '').trim().toLowerCase())
            .filter(Boolean)
        )
        return [
          'C:\\Windows\\System32',
          'C:\\Windows',
          'C:\\Windows\\System32\\Wbem',
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
        ]
          .filter((p) => !existingEntries.has(p.toLowerCase()))
          .join(sep)
      })()
    : ''
  const winSystemPrefix = winSystemPath ? winSystemPath + sep : ''
  // Git Bash hardening: if the user is launching `C:\Program Files\Git\bin\bash.exe`,
  // make sure Git's sibling `/usr/bin` is on PATH so POSIX helpers (sed, dirname,
  // uname) are always resolvable. Default Git Bash pulls these in via /etc/profile,
  // but users whose ~/.bash_profile doesn't chain to ~/.bashrc (or whose .bashrc
  // does `PATH=...` without `:$PATH`) can end up in a login shell where /usr/bin
  // is missing — which silently breaks every shell-wrapped CLI (Claude Code's
  // `claude`, gh's completion, node's npm-exec wrappers, etc.).
  const gitBashUsrBin: string = (() => {
    if (process.platform !== 'win32') return ''
    if (!/[\\/]git[\\/]+bin[\\/]+bash\.exe$/i.test(executable)) return ''
    // Derive the sibling usr\bin from the executable. Git for Windows always
    // ships <install>\bin\bash.exe alongside <install>\usr\bin, so if we got
    // here the derived path is guaranteed to exist.
    const derived = executable.replace(/[\\/]+bin[\\/]+bash\.exe$/i, '\\usr\\bin')
    const existingEntries = new Set(
      existingPath.split(sep).map((e) => e.replace(/[\\/]+$/, '').trim().toLowerCase()).filter(Boolean),
    )
    return existingEntries.has(derived.toLowerCase()) ? '' : derived
  })()
  const gitBashPrefix = gitBashUsrBin ? gitBashUsrBin + sep : ''
  const basePath = needsBundled
    ? `${toolsDir}${sep}${winSystemPrefix}${gitBashPrefix}${existingPath}`
    : `${winSystemPrefix}${gitBashPrefix}${existingPath}`
  // Test hook: e2e tests can prepend a shim directory that intercepts agent
  // binaries (claude, codex, gemini, qwen) and routes them to mocks. Keeps
  // tests from accidentally invoking real agents on developer machines.
  const testShimPath = process.env.TERMPOLIS_TEST_SHIM_DIR
    ? `${process.env.TERMPOLIS_TEST_SHIM_DIR}${sep}`
    : ''
  const env = {
    ...process.env,
    PATH: `${testShimPath}${extraPathStr}${basePath}`,
    OLLAMA_API_BASE: process.env.OLLAMA_API_BASE || 'http://localhost:11434',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
  } as Record<string, string>

  let proc: pty.IPty
  try {
    proc = pty.spawn(executable, getShellArgs(executable), {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: resolvedCwd,
      env,
    })
  } catch (e: any) {
    const msg = e?.message || String(e)
    console.error(`[node-pty] Failed to spawn "${executable}" in "${resolvedCwd}": ${msg}`)
    throw new Error(`Failed to open terminal: ${msg}`)
  }

  proc.onData(onData)
  proc.onExit(() => { processes.delete(id) })
  processes.set(id, { pty: proc })
}

export function killTerminal(id: string): void {
  const proc = processes.get(id)
  if (proc) {
    try { proc.pty.kill() } catch {}
    try { proc.pty.pid && process.kill(proc.pty.pid) } catch {}
    processes.delete(id)
  }
}

export function writeToTerminal(id: string, data: string): void {
  try { processes.get(id)?.pty.write(data) } catch {}
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  try { processes.get(id)?.pty.resize(cols, rows) } catch {}
}

export function killAll(): void {
  for (const [id] of processes) killTerminal(id)
}

export function getTerminalPid(id: string): number | null {
  const proc = processes.get(id)
  return proc?.pty.pid ?? null
}

export function getTerminalCwd(id: string): string | null {
  // Windows: no reliable way to get a child process's working directory
  // without shell integration. Return null to use the fallback cwd.
  if (process.platform === 'win32') return null

  const pid = getTerminalPid(id)
  if (!pid) return null
  try {
    // Linux: /proc/PID/cwd, macOS: lsof
    const cwd = execSync(
      `readlink /proc/${pid}/cwd 2>/dev/null || lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1 | cut -c2-`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 }
    ).toString().trim()
    return cwd || null
  } catch {
    return null
  }
}

function getShellArgs(executable: string): string[] {
  const lower = executable.toLowerCase()
  if (lower.endsWith('bash') || lower.endsWith('zsh')) return ['--login']
  return []
}

/**
 * xterm.js `windowsPty` option for a renderer Terminal: tells the emulator the
 * Windows PTY backend + OS build so its line-reflow and scrollback heuristics
 * match ConPTY (which hard-wraps lines and repaints differently than a Unix
 * pty). Without this hint a heavy-redraw TUI — e.g. Claude Code's Ink UI —
 * progressively desyncs and its output overlaps the prompt box ("text gets
 * jumbled with the prompt area"). Returns null off Windows, where xterm's
 * native reflow is already correct.
 *
 * Mirrors node-pty's OWN backend decision — ConPTY when the OS build >= 18309,
 * else winpty (see node-pty windowsPtyAgent._getWindowsBuildNumber) — so the
 * hint we hand xterm matches the pty we actually spawned. Pure + injectable
 * (platform/release passed in) for unit testing.
 */
export function computeWindowsPty(
  platform: NodeJS.Platform,
  release: string,
): { backend: 'conpty' | 'winpty'; buildNumber: number } | null {
  if (platform !== 'win32') return null
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(release)
  const buildNumber = match ? parseInt(match[3], 10) : 0
  return { backend: buildNumber >= 18309 ? 'conpty' : 'winpty', buildNumber }
}
