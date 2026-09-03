import { v4 as uuid } from 'uuid'
import type { AIProfile, ShellInfo, ShellType, TerminalSession } from '../types'
import { resolveAgentCommand, testDelay } from './testAgents'
import { getTerminalDefaults, agentTerminalName } from './terminalDefaults'
import { isAutoPrimerEnabled } from '../hooks/useAutoPrimer'
import { autoIndexRepo } from '../hooks/useAutoCodeIndex'
import { useTerminalStore } from '../store/terminalStore'
import { claudeModelArg } from './modelBroker'
import {
  waitForShellReady, afterCommandDelay, SHELL_READY_CEILING_MS, SHELL_QUIET_MS,
  PROMPT_ECHO_CEILING_MS,
} from './launchSequence'

/**
 * The three built-in AI agents. Always rendered first in the sidebar and always
 * mapped to launch shortcuts 1..3, so this order is load-bearing.
 */
export const DEFAULT_AI_PROFILES: AIProfile[] = [
  { id: 'claude', name: 'Claude Code', icon: 'fa-solid fa-robot', command: 'claude', shell: 'bash', color: '#D97706' },
  { id: 'codex', name: 'OpenAI Codex', icon: 'fa-solid fa-microchip', command: 'codex', shell: 'bash', color: '#10B981' },
  { id: 'gemini', name: 'Gemini CLI', icon: 'fa-brands fa-google', command: 'agy', shell: 'bash', color: '#4285F4' },
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
  // Claude Code launches through the always-on Headroom compression proxy: signal main
  // to inject ANTHROPIC_BASE_URL (main owns the proxy env; returns direct if unhealthy).
  const isClaude = profile.id === 'claude' || profile.command.trim().toLowerCase().startsWith('claude')
  const isCodex = profile.id === 'codex' || profile.command.trim().toLowerCase().startsWith('codex')
  const res = await window.termpolis.createTerminal(id, shellType, cwd, undefined, isClaude)
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
  const project = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  const label = project || 'this project'

  // START the recall now; do NOT await it yet. It used to sit in front of the shell wait, so its
  // whole duration was added to the launch — usually ~275 ms, but the tail is long (a 24 s recall
  // sits in this machine's own metrics). Running it alongside the shell wait costs nothing and
  // removes that tail from the critical path entirely.
  type PrimerOutcome = { file: string; count: number } | 'failed' | null
  const primerPromise: Promise<PrimerOutcome> = isClaude && isAutoPrimerEnabled()
    ? (async () => {
        try {
          const query = project
            ? `recent work, decisions, conventions, and context for ${project}`
            : 'recent work, key decisions, and conventions'
          const primerRes = await window.termpolis.memoryPreparePrimerFile(query, cwd)
          if (primerRes?.success && primerRes.data?.file) {
            return { file: primerRes.data.file, count: primerRes.data.count }
          }
          // The recall call FAILED (brain unreachable / error) — make the silent
          // failure visible instead of pretending nothing was available (#1).
          if (primerRes && !primerRes.success) return 'failed'
          return null // succeeded, nothing relevant — launch bare, no notice
        } catch {
          return 'failed' // the recall call threw — surface it rather than dropping recall (#1)
        }
      })()
    : Promise.resolve(null)

  // Codex parity. Codex takes no system-prompt flag, so the same instruction is written into the
  // file it reads by itself at session start — `<cwd>/AGENTS.md`. Byte-stable, so this only ever
  // writes once per project and never dirties a tracked file twice. Overlapped for the same reason.
  const codexPromise: Promise<void> = isCodex && isAutoPrimerEnabled()
    ? (async () => { try { await window.termpolis.memoryPrepareCodexContext(cwd) } catch { /* launch bare */ } })()
    : Promise.resolve()

  // Pre-approve the folder in Claude Code's own config so its workspace-trust dialog never
  // renders. Overlapped with the recall and the shell wait — it is a small local file write —
  // but AWAITED before the command is typed, because the seed only counts if it is on disk
  // before Claude reads it. See src/main/claudeTrust.ts for why typing Enter is not the answer.
  const claudeTrusted: Promise<void> = isClaude
    ? (async () => { try { await window.termpolis.claudeTrustWorkspace(cwd) } catch { /* dialog handler covers it */ } })()
    : Promise.resolve()

  // Started HERE, next to the recall, so the two overlap. Replaces a blind 4 s sleep with the
  // condition it stood for — the shell has spoken and gone quiet — keeping that 4 s as a ceiling.
  const shellReady = waitForShellReady({
    terminalId: id,
    subscribe: (cb) => window.termpolis.onTerminalData(cb),
    quietMs: testDelay(SHELL_QUIET_MS),
    ceilingMs: testDelay(SHELL_READY_CEILING_MS),
  })

  const primer = await primerPromise
  await codexPromise
  if (primer === 'failed') {
    useTerminalStore.getState().setMemoryNotice(`⚠️ Memory recall unavailable for "${label}" this session`)
  } else if (primer) {
    const fileArg = primer.file.replace(/\\/g, '/')
    launchCommand = `${launchCommand} --append-system-prompt-file "${fileArg}"`
    launchPrimed = true
    // Claude's priming is invisible (system-prompt file + SessionStart hook),
    // so surface HOW MUCH recall was injected — otherwise a working memory load
    // looks like nothing happened (#1 observable recall). Auto-dismisses (App.tsx).
    const n = primer.count
    useTerminalStore.getState().setMemoryNotice(`🧠 Loaded ${n} ${n === 1 ? 'memory' : 'memories'} for "${label}"`)
  }
  // Per-profile model selection: append a validated --model for Claude launches.
  if (isClaude) launchCommand = launchCommand + claudeModelArg(profile.model)
  // Registered as soon as the recall lands — exactly as before — so the pane appears while the
  // shell is still coming up rather than waiting on it.
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
  // Deterministically index the picked repo for EVERY agent (Claude/Codex/Gemini) — the
  // folder was chosen explicitly, so don't wait on cwd-tracking (agent TUIs don't emit OSC 633).
  // Deduped against the per-terminal effect, and it surfaces a "🧭 Code graph: N symbols" notice.
  void autoIndexRepo(cwd)
  // These timers fire seconds after the call returns. In unit tests jsdom may
  // tear down before they run — guard each writeToTerminal call so a gone-away
  // window doesn't raise an unhandled exception.
  const writeIfAlive = (data: string) => {
    if (typeof window === 'undefined' || !window.termpolis?.writeToTerminal) return
    window.termpolis.writeToTerminal(id, data)
  }
  // The no-op newline that used to precede the command was removed in v1.38.0 on the reasoning that
  // waiting for the shell to go quiet is the same guarantee, obtained rather than assumed. It is
  // not. Going quiet proves the shell has FINISHED SPEAKING; it does not prove the shell is yet
  // READING. Between those two moments the first byte we type is dropped on the floor — Git Bash
  // under ConPTY reliably eats it — and with the command typed first, the byte lost is the `c` of
  // `claude`:
  //
  //   ~/repos/termpolis $ laude --append-system-prompt-file "…/primer-c2db4f68….txt"
  //   bash: laude: command not found
  //
  // The primer was built and the file was written; the launch died on a missing first character.
  // So the sacrificial newline is back, and it is now the ONLY thing that byte can be. It is also
  // no longer followed by a blind 500 ms: we wait for the shell to ECHO it, which is the first
  // positive proof that input is being consumed rather than discarded. If nothing comes back, the
  // newline itself was the swallowed byte — the case this exists for — and the short ceiling lets
  // the command through regardless.
  await shellReady
  await claudeTrusted
  writeIfAlive('\r')
  await waitForShellReady({
    terminalId: id,
    subscribe: (cb) => window.termpolis.onTerminalData(cb),
    quietMs: testDelay(SHELL_QUIET_MS),
    ceilingMs: testDelay(PROMPT_ECHO_CEILING_MS),
  })
  writeIfAlive(launchCommand + '\r')
  // Auto-trust: Codex still shows a trust prompt a few seconds after the command. It is BLIND —
  // sent on a timer whether or not a prompt is showing — so it is measured from the command, not
  // from the launch click. Typing the command earlier without this would stretch the gap it was
  // tuned for (4.5 s) to as much as 8.5 s, widening the window for a stray keypress to land
  // somewhere it was never meant to.
  //
  // Claude has NO blind reply any more. Its dialog now opens focused on "No, exit", so a timed
  // Enter quit the session instead of trusting it — the folder is pre-approved in config above,
  // and if the dialog somehow still appears, App.tsx's poller answers the row that is actually
  // highlighted rather than guessing.
  if (profile.command.startsWith('codex')) {
    // Codex requires '1' to trust the directory
    setTimeout(() => writeIfAlive('1\r'), testDelay(afterCommandDelay(9000)))
  }
  const dismissMs = profile.id === 'gemini' ? 15000 : 8000
  setTimeout(() => setLaunchingAgent(null), testDelay(afterCommandDelay(dismissMs)))
}
