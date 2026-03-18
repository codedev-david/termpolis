import * as pty from 'node-pty'
import { homedir } from 'os'
import { existsSync } from 'fs'
import type { ShellType } from './types'

interface PtyProcess {
  pty: pty.IPty
}

const processes = new Map<string, PtyProcess>()

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

  const proc = pty.spawn(executable, getShellArgs(executable), {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env: { ...process.env } as Record<string, string>,
  })

  proc.onData(onData)
  proc.onExit(() => { processes.delete(id) })
  processes.set(id, { pty: proc })
}

export function killTerminal(id: string): void {
  const proc = processes.get(id)
  if (proc) {
    try { proc.pty.kill() } catch {}
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

function getShellArgs(executable: string): string[] {
  const lower = executable.toLowerCase()
  if (lower.endsWith('bash') || lower.endsWith('zsh')) return ['--login']
  return []
}
