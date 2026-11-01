import { resolveAgentCommand, testDelay } from './testAgents'
import { accountLaunchLine, accountsBridge, launchAccountFor } from './accountLaunch'
import type { AccountsBridge, LaunchLine } from './accountLaunch'
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
  /** The terminal's shell: which shell's syntax the account line is in. */
  shellType?: string
  /** The account it launches on (a restored workspace's own); else the agent's preferred one. */
  agentAccountId?: string
}

export interface AgentLaunchOptions {
  /** Writes to a terminal. Defaults to the preload bridge. */
  write?: (id: string, data: string) => void
  /** Pre-approves a folder in Claude Code's config, in the account's profile when there is one.
   *  Defaults to the preload bridge. */
  trustClaudeWorkspace?: (cwd: string, accountId?: string) => Promise<unknown>
  /** Called once every agent has been typed and has had time to come up. */
  onSettled?: () => void
  /** Main's account lines (accountLaunch.ts). Defaults to the preload's; null, or a preload
   *  without them, launches every agent bare, as before accounts. */
  accounts?: AccountsBridge | null
  /** A target's agent was typed on an account: what to record on its terminal. Defaults to the
   *  store's terminal. */
  onLaunched?: (id: string, launched: { agentAccountId: string; agentSessionId?: string }) => void
  /** A target's line was refused, and nothing typed: the sentence why. Defaults to a notice. */
  onRefused?: (id: string, why: string) => void
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
    ?? ((cwd: string, ...accountId: [] | [string]) => window.termpolis.claudeTrustWorkspace(cwd, ...accountId))
  const accounts = options.accounts === undefined ? accountsBridge() : options.accounts
  const onLaunched = options.onLaunched ?? ((id, launched) => useTerminalStore.getState().updateTerminal(id, launched))
  const onRefused = options.onRefused ?? ((_id, why) => useTerminalStore.getState().setMemoryNotice(`⚠️ ${why}`))

  if (agents.length === 0) {
    options.onSettled?.()
    return
  }

  // Pre-approve every Claude folder in Claude Code's own config so its workspace-trust
  // dialog never renders — only once the user connected the agents, and never for the home
  // folder or a drive root (main decides, and otherwise writes nothing). Fire-and-forget is
  // safe here: the shell settle below is seconds long and this is a local file write, so the
  // seed is on disk well before Claude reads it. With accounts, it goes into the profile of the
  // account the agent launches on, which main names first.
  const trust = (t: AgentLaunchTarget, accountId?: string): void => {
    if (t.cwd && t.agentCommand!.startsWith('claude')) {
      void Promise.resolve(accountId ? trustClaude(t.cwd, accountId) : trustClaude(t.cwd)).catch(() => { /* dialog handler covers it */ })
    }
  }
  const accountOf = new Map<string, Promise<string | undefined>>()
  for (const t of agents) {
    if (!accounts) {
      trust(t)
      continue
    }
    const account = launchAccountFor(t.agentCommand, t.agentAccountId, accounts)
    accountOf.set(t.id, account)
    void account.then((id) => trust(t, id))
  }

  // The agent's own list, for checking a saved Codex or Antigravity default against. Asked for now
  // and used when the command is typed seconds later; if it has not arrived by then the default is
  // checked on its shape alone, which is all a launch can do without it. A launch with no such
  // default saved makes no call at all.
  let catalog: ModelCatalog | null = null
  void catalogForLaunch().then((c) => { catalog = c })
  const notify = options.notify ?? ((message: string) => useTerminalStore.getState().setMemoryNotice(message))

  /** Types a target's agent: its command as is, or main's line on its account. */
  const type = (t: AgentLaunchTarget): void => {
    // Settings › General › Default Models: a new terminal starts on the model chosen for its
    // agent, unless its command already picks one or resumes a session. It is part of the command
    // the account line wraps, so the agent comes up on that account and that model.
    const base = resolveAgentCommand(t.agentCommand!)
    const model = defaultModelFor(base, catalog)
    if (model.dropped) notify(droppedDefaultNotice(base, model.dropped))
    const command = base + model.arg
    const account = accountOf.get(t.id)
    if (!account) {
      write(t.id, command + '\r')
      return
    }
    void account
      .then((accountId) => accountLaunchLine(t.id, t.shellType ?? '', command, t.agentCommand!, accountId, accounts))
      .then((built: LaunchLine) => {
        if ('refused' in built) {
          onRefused(t.id, built.refused)
          return
        }
        write(t.id, built.line + '\r')
        if (built.accountId) onLaunched(t.id, { agentAccountId: built.accountId, ...(built.sessionId ? { agentSessionId: built.sessionId } : {}) })
      })
  }

  // Send a no-op newline to flush shell init, then the real command.
  setTimeout(() => {
    for (const t of agents) write(t.id, '\r')
    setTimeout(() => {
      for (const t of agents) type(t)
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
