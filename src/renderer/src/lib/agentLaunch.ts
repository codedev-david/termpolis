import { resolveAgentCommand, testDelay } from './testAgents'
import { accountLaunchLine, accountsBridge, launchAccountFor } from './accountLaunch'
import type { AccountsBridge, LaunchLine } from './accountLaunch'
import { catalogForLaunch, defaultModelFor, droppedDefaultNotice } from './agentModelDefaults'
import { useTerminalStore } from '../store/terminalStore'
import { providerForCommand, type ModelCatalog } from './modelCatalog'
import { hostPlatform } from './platform'
import { promptReported, terminalOutput } from './promptReport'

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
/** How often a launch looks for the first prompt of a shell that is still starting (waitsForPrompt). */
export const PROMPT_POLL_MS = 250
/** How long after the launch began it stops looking and types anyway: a shell whose integration is
 *  off never reports a prompt, and its agent still has to start. */
export const PROMPT_WAIT_MS = 15000

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

/**
 * Where Termpolis's launch of an agent in terminal `id` stands, for useAutoPrimer's launch gate:
 * - 'pending': agentCommand is recorded but not typed yet, and the terminal holds only its shell;
 * - 'typed': the command is in;
 * - 'failed': the launch ended before the command was typed (refused, or it threw). The terminal
 *   stays a plain shell, so the gate stays shut: clearing only the pending flag would let the
 *   recorded agentCommand open it again, and a pointer would be typed into that shell.
 * Every launch site calls 'failed' from a finally block, so a throw anywhere ends the same way.
 */
export function markAgentLaunch(id: string, state: 'pending' | 'typed' | 'failed'): void {
  useTerminalStore.getState().updateTerminal(id, { agentLaunchPending: state === 'pending', agentLaunchFailed: state === 'failed' })
}

/**
 * Whether `t`'s launch waits for its shell's first prompt before anything is typed: PowerShell on
 * macOS and Linux. It starts slowly there (a second or more on a busy machine), and what is typed
 * before its line editor is up is echoed by the terminal and then read again WITHOUT its Enter: the
 * agent's line sat unsent at the prompt, and the memory pointer was pasted onto it and run with it
 * (the macOS soak of 2026-11-23, a restored workspace). Windows' console keeps typeahead with its
 * Enter, and bash, zsh and fish read theirs as typed, so the others stay on the timer.
 */
function waitsForPrompt(t: AgentLaunchTarget): boolean {
  const platform = hostPlatform()
  return t.shellType === 'powershell' && platform !== '' && platform !== 'win32'
}

/** Resolves once the terminal's shell has reported its first prompt (promptReport.ts), once its
 *  output cannot be read (nothing to wait on), or PROMPT_WAIT_MS after `startedAt`. */
async function shellCameUp(id: string, startedAt: number): Promise<void> {
  for (;;) {
    const output = await terminalOutput(id)
    if (output === null || promptReported(output) || Date.now() - startedAt >= PROMPT_WAIT_MS) return
    await new Promise<void>((resolve) => setTimeout(resolve, PROMPT_POLL_MS))
  }
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
  const startedAt = Date.now()

  // Until its command is typed, each terminal holds only its shell, whatever agentCommand says:
  // useAutoPrimer keeps its launch gate shut till then (markAgentLaunch).
  for (const t of agents) markAgentLaunch(t.id, 'pending')

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

  /** Types a target's agent: its command as is, or main's line on its account. However it ends,
   *  its terminal's launch is marked typed or failed (markAgentLaunch), a throw included. */
  const type = (t: AgentLaunchTarget): void => {
    let typed = false
    let handedOff = false
    const settle = (): void => markAgentLaunch(t.id, typed ? 'typed' : 'failed')
    try {
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
        typed = true
        return
      }
      handedOff = true
      void account
        .then((accountId) => accountLaunchLine(t.id, t.shellType ?? '', command, t.agentCommand!, accountId, accounts))
        .then((built: LaunchLine) => {
          if ('refused' in built) {
            onRefused(t.id, built.refused)
            return
          }
          write(t.id, built.line + '\r')
          typed = true
          if (built.accountId) onLaunched(t.id, { agentAccountId: built.accountId, ...(built.sessionId ? { agentSessionId: built.sessionId } : {}) })
        })
        .finally(settle)
    } finally {
      if (!handedOff) settle()
    }
  }

  // Send a no-op newline to flush shell init, then the real command. A shell that is still starting
  // where typeahead loses its Enter gets both once it has shown its first prompt (waitsForPrompt):
  // until then its terminal stays pending, so the primer's launch gate stays shut too.
  const flushThenType = (ready: AgentLaunchTarget[]): void => {
    if (ready.length === 0) return
    for (const t of ready) write(t.id, '\r')
    setTimeout(() => {
      for (const t of ready) type(t)
    }, COMMAND_DELAY_MS)
  }
  setTimeout(() => {
    flushThenType(agents.filter((t) => !waitsForPrompt(t)))
    for (const t of agents.filter(waitsForPrompt)) void shellCameUp(t.id, startedAt).then(() => flushThenType([t]))
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
