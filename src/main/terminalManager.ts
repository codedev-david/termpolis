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
  onData: (data: string) => void
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
  const existingPath = process.env.PATH || process.env.Path || ''
  const needsBundled = checkBundledToolsNeeded()
  const env = needsBundled
    ? { ...process.env, PATH: `${toolsDir}${process.platform === 'win32' ? ';' : ':'}${existingPath}` } as Record<string, string>
    : { ...process.env } as Record<string, string>

  const proc = pty.spawn(executable, getShellArgs(executable), {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env,
  })

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
