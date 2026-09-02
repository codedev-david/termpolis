import { resolveAgentCommand, testDelay } from './testAgents'

/**
 * Launching an agent in a terminal is a timed sequence, not a single write: the
 * shell has to finish printing its prompt, the command has to land, and Claude
 * and Codex then put up a trust prompt that needs an answer before the agent is
 * usable.
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
/** When Claude's / Codex's own trust prompt is answered. */
export const AUTO_TRUST_MS = 10000
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
  /** Called once every agent has been typed and its trust prompt answered. */
  onSettled?: () => void
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
  // dialog never renders. Fire-and-forget is safe here: the shell settle below is seconds
  // long and this is a local file write, so the seed is on disk well before Claude reads it.
  for (const t of agents) {
    if (t.cwd && t.agentCommand!.startsWith('claude')) {
      void Promise.resolve(trustClaude(t.cwd)).catch(() => { /* dialog handler covers it */ })
    }
  }

  // Send a no-op newline to flush shell init, then the real command.
  setTimeout(() => {
    for (const t of agents) write(t.id, '\r')
    setTimeout(() => {
      for (const t of agents) write(t.id, resolveAgentCommand(t.agentCommand!) + '\r')
    }, COMMAND_DELAY_MS)
  }, testDelay(SHELL_SETTLE_MS))

  // Auto-trust: Codex wants option 1. Claude gets NOTHING typed at it any more — since
  // Claude Code 2.1.x the trust dialog opens focused on "No, exit", so the bare Enter that
  // used to live here quit the session instead of trusting it. Trust is seeded in config
  // above; if the dialog still appears, App.tsx's poller answers the highlighted row.
  for (const t of agents) {
    const reply = t.agentCommand!.startsWith('codex') ? '1\r' : null
    if (reply) setTimeout(() => write(t.id, reply), testDelay(AUTO_TRUST_MS))
  }

  const hasSlowAgent = agents.some(t => t.agentCommand === 'gemini')
  setTimeout(() => options.onSettled?.(), testDelay(hasSlowAgent ? SLOW_DISMISS_MS : DISMISS_MS))
}
