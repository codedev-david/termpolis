import { existsSync, promises as fsp } from 'fs'
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

function candidatesForPlatform(): { type: ShellType; label: string; paths: string[] }[] {
  const currentPlatform = os.platform()
  const key = currentPlatform === 'win32' ? 'win32' : currentPlatform === 'darwin' ? 'darwin' : 'linux'
  return SHELL_CANDIDATES[key] ?? []
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/** Callers that ask while a probe is running share it: a swarm opening twenty terminals probes once. */
let probeInFlight: Promise<ShellInfo[]> | null = null
/** The last probe, for resolveShellExecutable. */
let lastProbe: ShellInfo[] | null = null

/**
 * The shells installed here. The probe runs on the thread pool, never on the main thread: it used to be
 * existsSync per candidate path, on EVERY terminal creation, on the thread that echoes keystrokes.
 * Candidates are probed together; within one candidate the first path that exists wins, as before.
 */
export async function detectAvailableShells(): Promise<ShellInfo[]> {
  if (!probeInFlight) {
    probeInFlight = (async () => {
      const candidates = candidatesForPlatform()
      const exes = await Promise.all(candidates.map(async (candidate) => {
        for (const p of candidate.paths) if (await pathExists(p)) return p
        return null
      }))
      const found: ShellInfo[] = []
      candidates.forEach((candidate, i) => {
        const exe = exes[i]
        if (exe) found.push({ type: candidate.type, label: candidate.label, executable: exe })
      })
      lastProbe = found
      return found
    })().finally(() => { probeInFlight = null })
  }
  return (await probeInFlight).map((s) => ({ ...s }))
}

/** @internal test-only */
export function _resetShellProbeForTests(): void {
  probeInFlight = null
  lastProbe = null
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
// From memory once the app has probed (start-up and every terminal creation do, on the thread pool): a step is
// started by a timer or a trigger, on the main thread. A probe of its own before the first one, and in a test.
export function resolveShellExecutable(shell: string): string {
  return pickShellExecutable(lastProbe ?? detectAvailableShellsSync(), shell)
}

export function getDefaultShell(shells: ShellInfo[], os: string): ShellInfo | undefined {
  const preferredByOs: Record<string, ShellType> = { darwin: 'zsh', linux: 'bash', win32: 'powershell' }
  const preferred = preferredByOs[os] ?? 'bash'
  return shells.find(s => s.type === preferred) ?? shells[0]
}
