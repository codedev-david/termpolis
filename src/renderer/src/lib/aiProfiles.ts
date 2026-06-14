import { v4 as uuid } from 'uuid'
import type { AIProfile, ShellInfo, ShellType, TerminalSession } from '../types'
import { resolveAgentCommand, testDelay } from './testAgents'
import { getTerminalDefaults, agentTerminalName } from './terminalDefaults'
import { isAutoPrimerEnabled } from '../hooks/useAutoPrimer'
import qwenIcon from '../assets/qwen-ai-logo.svg'
import { claudeModelArg } from './modelBroker'

/**
 * The four built-in AI agents. Always rendered first in the sidebar and always
 * mapped to launch shortcuts 1..4, so this order is load-bearing.
 */
export const DEFAULT_AI_PROFILES: AIProfile[] = [
  { id: 'claude', name: 'Claude Code', icon: 'fa-solid fa-robot', command: 'claude', shell: 'bash', color: '#D97706' },
  { id: 'codex', name: 'OpenAI Codex', icon: 'fa-solid fa-microchip', command: 'codex', shell: 'bash', color: '#10B981' },
  { id: 'gemini', name: 'Gemini CLI', icon: 'fa-brands fa-google', command: 'gemini', shell: 'bash', color: '#4285F4' },
  { id: 'qwen-code', name: 'Qwen Code', icon: 'fa-solid fa-feather', iconImage: qwenIcon, command: 'qwen', shell: 'bash', color: '#A855F7' },
]

export function resolveShellType(profileShell: string, availableShells: ShellInfo[]): ShellType {
  const available = availableShells.map(s => s.type)
  if (profileShell === 'bash') {
    // On Windows, prefer gitbash if available
    if (navigator.platform.startsWith('Win') && available.includes('gitbash')) return 'gitbash'
    if (available.includes('bash')) return 'bash'
  }
  if (available.includes(profileShell as ShellType)) return profileShell as ShellType
  // Fallback to first available shell
  return available[0] ?? 'bash'
}

export interface LaunchAgentDeps {
  availableShells: ShellInfo[]
  addTerminal: (t: TerminalSession) => void
  setLaunchingAgent: (name: string | null) => void
}

/**
 * Canonical AI-agent launch flow, shared by the sidebar click and the keyboard
 * launch shortcuts. Prompts for a directory, spawns the shell, seeds Claude's
 * project memory invisibly via --append-system-prompt-file when available, then
 * types the launch command and the agent's trust-prompt confirmations.
 */
export async function launchAgentProfile(profile: AIProfile, deps: LaunchAgentDeps): Promise<void> {
  const { availableShells, addTerminal, setLaunchingAgent } = deps
  // Prompt user to pick a project directory
  const dirRes = await window.termpolis.pickDirectory()
  if (!dirRes.success || !dirRes.data) return // user cancelled
  const cwd = dirRes.data
  setLaunchingAgent(profile.name)
  const id = uuid()
  const shellType = resolveShellType(profile.shell, availableShells)
  const res = await window.termpolis.createTerminal(id, shellType, cwd)
  if (!res.success) {
    setLaunchingAgent(null)
    alert(`Failed to open terminal: ${res.error}`)
    return
  }
  // Claude: seed project memory invisibly at launch via a system-prompt file
  // (--append-system-prompt-file) instead of typing a visible primer into the
  // terminal. The prepare call is the relevance gate — it returns null when
  // there's no saved memory for this project, in which case we launch bare.
  // The other agents get the slim typed pointer via useAutoPrimer on detection.
  let launchCommand = resolveAgentCommand(profile.command)
  let launchPrimed = false
  const isClaude = profile.id === 'claude' || profile.command.trim().toLowerCase().startsWith('claude')
  if (isClaude && isAutoPrimerEnabled()) {
    try {
      const project = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
      const query = project
        ? `recent work, decisions, conventions, and context for ${project}`
        : 'recent work, key decisions, and conventions'
      const primerRes = await window.termpolis.memoryPreparePrimerFile(query, cwd)
      if (primerRes?.success && primerRes.data) {
        const fileArg = primerRes.data.replace(/\\/g, '/')
        launchCommand = `${launchCommand} --append-system-prompt-file "${fileArg}"`
        launchPrimed = true
      }
    } catch {
      // Memory unavailable — fall back to a bare launch + the normal typed pointer.
    }
  }
  // Per-profile model selection: append a validated --model for Claude launches.
  if (isClaude) launchCommand = launchCommand + claudeModelArg(profile.model)
  addTerminal({
    id,
    name: agentTerminalName(profile.name, cwd),
    color: profile.color,
    shellType,
    cwd,
    ...getTerminalDefaults(),
    agentCommand: profile.command,
    launchPrimed,
  })
  // These timers fire seconds after the call returns. In unit tests jsdom may
  // tear down before they run — guard each writeToTerminal call so a gone-away
  // window doesn't raise an unhandled exception.
  const writeIfAlive = (data: string) => {
    if (typeof window === 'undefined' || !window.termpolis?.writeToTerminal) return
    window.termpolis.writeToTerminal(id, data)
  }
  // Wait for shell to fully initialize before sending command
  // Git Bash on Windows can take 3-5 seconds to show the prompt
  // Send a no-op newline first to flush any partial shell init, then the real command
  setTimeout(() => {
    writeIfAlive('\r')
    setTimeout(() => {
      writeIfAlive(launchCommand + '\r')
    }, 500)
  }, testDelay(4000))
  // Auto-trust: Claude/Codex show trust prompts ~5s after launch.
  // Send Enter to confirm the pre-selected trust option.
  if (profile.command.startsWith('claude')) {
    setTimeout(() => writeIfAlive('\r'), testDelay(9000))
  }
  if (profile.command.startsWith('codex')) {
    // Codex requires '1' to trust the directory
    setTimeout(() => writeIfAlive('1\r'), testDelay(9000))
  }
  const dismissMs = (profile.id === 'gemini' || profile.id === 'qwen-code') ? 15000 : 8000
  setTimeout(() => setLaunchingAgent(null), testDelay(dismissMs))
}
