import { existsSync } from 'fs'
import * as os from 'os'
import type { ShellInfo, ShellType } from './types'

const SHELL_CANDIDATES: Record<string, { type: ShellType; label: string; paths: string[] }[]> = {
  win32: [
    { type: 'powershell', label: 'PowerShell', paths: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] },
    { type: 'cmd', label: 'Command Prompt', paths: ['C:\\Windows\\System32\\cmd.exe'] },
    { type: 'gitbash', label: 'Git Bash', paths: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'] },
    { type: 'bash', label: 'Bash (WSL)', paths: ['C:\\Windows\\System32\\bash.exe'] },
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

export async function detectAvailableShells(): Promise<ShellInfo[]> {
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

export function getDefaultShell(shells: ShellInfo[], os: string): ShellInfo | undefined {
  const preferredByOs: Record<string, ShellType> = { darwin: 'zsh', linux: 'bash', win32: 'powershell' }
  const preferred = preferredByOs[os] ?? 'bash'
  return shells.find(s => s.type === preferred) ?? shells[0]
}
