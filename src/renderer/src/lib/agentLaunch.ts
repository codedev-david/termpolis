import { resolveAgentCommand, testDelay } from './testAgents'
import { catalogForLaunch, defaultModelFor, droppedDefaultNotice } from './agentModelDefaults'
import { useTerminalStore } from '../store/terminalStore'
import { providerForCommand, type ModelCatalog } from './modelCatalog'

/**
 * Launching an agent in a terminal is a timed sequence, not a single write: the
 * shell has to finish printing its prompt, then the command has to land. Nothing
 * is typed after it — a folder-trust prompt the agent puts up is the user's to
 * answer (see the end of launchAgents).
 *
 * That sequence used to be copy-pasted at every launch site, and the
 * workspace-restore path simply never got a copy — activating a saved workspace
 * re-opened the shells in the right repos but left the agents unlaunched. Since
 * loose terminals stopped being restored at boot, workspaces are the ONLY
 * restore path, so that gap became the whole story. It lives here once now.
 */

/** How long a freshly-spawned shell gets to finish its init before anything is typed. */
export const SHELL_SETTLE_MS = 4000
/** Gap between the flush newline and the real command. */
export const COMMAND_DELAY_MS = 500
/** How long the "Launching …" overlay stays up. */
export const DISMISS_MS = 8000
/** Gemini takes noticeably longer to come up than the others. */
export const SLOW_DISMISS_MS = 15000

export interface AgentLaunchTarget {
  id: string
  agentCommand?: string
  /** The folder the terminal was opened in — pre-approved for Claude before it launches. */
  cwd?: string
}

export interface AgentLaunchOptions {
  /** Writes to a terminal. Defaults to the preload bridge. */
  write?: (id: string, data: string) => void
  /** Pre-approves a folder in Claude Code's config. Defaults to the preload bridge. */
  trustClaudeWorkspace?: (cwd: string) => Promise<unknown>
  /** Called once every agent has been typed and has had time to come up. */
  onSettled?: () => void
  /** Shows a one-line notice. Defaults to the app's notice bar. */
  notify?: (message: string) => void
}

/** The subset of `targets` that actually carries an agent command. */
export function agentTargets<T extends AgentLaunchTarget>(targets: T[]): T[] {
  return targets.filter(t => !!t.agentCommand)
}

/**
 * Type each target's agent command into its terminal and answer the trust
 * prompt that follows. Targets without an `agentCommand` are ignored, so it is
 * safe to hand this a whole terminal list.
 */
export function launchAgents(targets: AgentLaunchTarget[], options: AgentLaunchOptions = {}): void {
  const agents = agentTargets(targets)
  const write = options.write ?? ((id: string, data: string) => window.termpolis.writeToTerminal(id, data))
  const trustClaude = options.trustClaudeWorkspace
    ?? ((cwd: string) => window.termpolis.claudeTrustWorkspace(cwd))

  if (agents.length === 0) {
    options.onSettled?.()
    return
  }

  // Pre-approve every Claude folder in Claude Code's own config so its workspace-trust
  // dialog never renders — only once the user connected the agents, and never for the home
  // folder or a drive root (main decides, and otherwise writes nothing). Fire-and-forget is
  // safe here: the shell settle below is seconds long and this is a local file write, so the
  // seed is on disk well before Claude reads it.
  for (const t of agents) {
    if (t.cwd && t.agentCommand!.startsWith('claude')) {
      void Promise.resolve(trustClaude(t.cwd)).catch(() => { /* dialog handler covers it */ })
    }
  }

  // The agent's own list, for checking a saved Codex or Antigravity default against. Asked for now
  // and used when the command is typed seconds later; if it has not arrived by then the default is
  // checked on its shape alone, which is all a launch can do without it. A launch with no such
  // default saved makes no call at all.
  let catalog: ModelCatalog | null = null
  void catalogForLaunch().then((c) => { catalog = c })
  const notify = options.notify ?? ((message: string) => useTerminalStore.getState().setMemoryNotice(message))

  // Send a no-op newline to flush shell init, then the real command.
  setTimeout(() => {
    for (const t of agents) write(t.id, '\r')
    setTimeout(() => {
      for (const t of agents) {
        // Settings › General › Default Models: a new terminal starts on the model chosen for its
        // agent, unless its command already picks one or resumes a session.
        const command = resolveAgentCommand(t.agentCommand!)
        const model = defaultModelFor(command, catalog)
        if (model.dropped) notify(droppedDefaultNotice(command, model.dropped))
        write(t.id, command + model.arg + '\r')
      }
    }, COMMAND_DELAY_MS)
  }, testDelay(SHELL_SETTLE_MS))

  // Nothing is typed after the command. Codex used to get a blind `1⏎` on a timer, which
  // accepted its folder-trust prompt whether or not the user wanted that folder trusted (and
  // became a chat message when no prompt showed), and Claude a blind Enter, which since its
  // dialog opens on "No, exit" quit the session instead. Only once the user connected the
  // agents does App.tsx's poller answer a trust prompt, on the row that is actually
  // highlighted, and never for the home folder or a drive root.

  // Gemini is the Antigravity CLI (`agy`) now; `gemini` is the retired command, kept for old sessions.
  const hasSlowAgent = agents.some(t => t.agentCommand === 'gemini' || providerForCommand(t.agentCommand) === 'gemini')
  setTimeout(() => options.onSettled?.(), testDelay(hasSlowAgent ? SLOW_DISMISS_MS : DISMISS_MS))
}
