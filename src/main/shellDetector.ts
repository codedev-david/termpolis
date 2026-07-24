import { existsSync } from 'fs'
import * as os from 'os'
import type { ShellInfo, ShellType } from './types'

const SHELL_CANDIDATES: Record<string, { type: ShellType; label: string; paths: string[] }[]> = {
  win32: [
    { type: 'powershell', label: 'PowerShell', paths: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] },
    { type: 'cmd', label: 'Command Prompt', paths: ['C:\\Windows\\System32\\cmd.exe'] },
    { type: 'gitbash', label: 'Git Bash', paths: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'] },
  ],
  darwin: [
    { type: 'zsh', label: 'Zsh', paths: ['/bin/zsh'] },
    { type: 'bash', label: 'Bash', paths: ['/bin/bash'] },
    { type: 'powershell', label: 'PowerShell', paths: ['/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh'] },
  ],
  linux: [
    { type: 'bash', label: 'Bash', paths: ['/bin/bash', '/usr/bin/bash'] },
    { type: 'zsh', label: 'Zsh', paths: ['/bin/zsh', '/usr/bin/zsh'] },
    { type: 'powershell', label: 'PowerShell', paths: ['/usr/bin/pwsh', '/usr/local/bin/pwsh'] },
  ],
}

// Synchronous core: probe the platform's candidate shells and return the ones
// whose executable actually exists. The body is fully synchronous (existsSync),
// so callers that cannot await — e.g. resolving a workflow step's shell inside
// a synchronous spawn wrapper — use this directly.
export function detectAvailableShellsSync(): ShellInfo[] {
  const currentPlatform = os.platform()
  const key = currentPlatform === 'win32' ? 'win32' : currentPlatform === 'darwin' ? 'darwin' : 'linux'
  const candidates = SHELL_CANDIDATES[key] ?? []
  const found: ShellInfo[] = []
  for (const candidate of candidates) {
    const exe = candidate.paths.find(p => existsSync(p))
    if (exe) found.push({ type: candidate.type, label: candidate.label, executable: exe })
  }
  return found
}

export async function detectAvailableShells(): Promise<ShellInfo[]> {
  return detectAvailableShellsSync()
}

// When an exact shell type isn't installed, fall back to the nearest compatible
// one (a step asking for POSIX `bash` on Windows should get Git Bash; a Windows
// step asking for `powershell` should get cmd if pwsh is missing).
const SHELL_FALLBACKS: Record<string, ShellType[]> = {
  bash: ['bash', 'gitbash', 'zsh'],
  gitbash: ['gitbash', 'bash', 'zsh'],
  zsh: ['zsh', 'bash', 'gitbash'],
  powershell: ['powershell', 'cmd'],
  cmd: ['cmd', 'powershell'],
}

// A shell value is already a concrete executable (not a logical type) if it
// looks like a path or names a .exe — pass those straight through.
function isExecutablePath(shell: string): boolean {
  return shell.includes('/') || shell.includes('\\') || shell.toLowerCase().endsWith('.exe')
}

// Map a workflow step's logical shell TYPE (what the Designer stores, e.g.
// 'bash') to a concrete executable node-pty can spawn. This is PURE — it takes
// the already-detected shell list so it can be unit-tested without fs/os.
//
// node-pty on Windows CANNOT resolve a bare 'bash' via PATH — it must be handed
// a real path or it throws "File not found". So a Command step that stores
// shell:'bash' has to be resolved to the Git Bash executable before spawning.
export function pickShellExecutable(shells: ShellInfo[], shell: string): string {
  if (isExecutablePath(shell)) return shell
  const order = SHELL_FALLBACKS[shell] ?? [shell as ShellType]
  for (const type of order) {
    const match = shells.find(s => s.type === type)
    if (match) return match.executable
  }
  // Unknown type with nothing compatible detected: return the raw value and let
  // node-pty fail honestly (the adapter turns that throw into a failed step)
  // rather than silently substituting an unrelated shell.
  return shell
}

// Real substrate: detect the machine's shells, then resolve a logical type to a
// concrete executable. Used to wire the workflow Command-step spawn.
export function resolveShellExecutable(shell: string): string {
  return pickShellExecutable(detectAvailableShellsSync(), shell)
}

export function getDefaultShell(shells: ShellInfo[], os: string): ShellInfo | undefined {
  const preferredByOs: Record<string, ShellType> = { darwin: 'zsh', linux: 'bash', win32: 'powershell' }
  const preferred = preferredByOs[os] ?? 'bash'
  return shells.find(s => s.type === preferred) ?? shells[0]
}
