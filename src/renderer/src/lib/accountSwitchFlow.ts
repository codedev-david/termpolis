// The account switch's logic (§7), under the account menu and the limit card: the target's sign-in
// check (§4.4), the target's preparation the launch makes too (folder trust, Codex's instruction),
// the run itself in main (accounts:switch), what each outcome tells a swarm worker's conductor, and
// the new terminals the menu and the card open. Main does the typing; this never writes to a
// terminal.
import { ACCOUNT_AGENT_LABEL } from '../../../shared/agentAccounts'
import type { AccountAgent, AccountRowView, AccountsView } from '../../../shared/agentAccounts'
import { carryForSwitch, isSessionId, relaunchCommand } from '../../../shared/accountSwitch'
import type { SwitchOutcome, SwitchRequest } from '../../../shared/accountSwitch'
import { isShellSafeInstruction } from '../../../shared/agentIntegration'
import type { AccountsAPI, TermpolisAPI, TerminalSession } from '../types'
import { signedInEmail } from './accountChip'
import { agentOfTerminal } from './accountsView'
import type { AgentLaunchTarget } from './agentLaunch'
import { launchTerminalArgs } from './accountLaunch'
import { isClaudeCommand } from './testAgents'
import { freshCommand } from '../../../shared/launchCarry'

/** The agent a terminal runs, as Termpolis knows it: the one it launched there, or a swarm
 *  worker's (main's record of run_command). Never the conductor's, which runs `claude -p` behind
 *  its script and is never switched. */
export function terminalAgent(t: Pick<TerminalSession, 'agentCommand' | 'isConductor' | 'isSwarm' | 'swarmAgent'> | undefined): AccountAgent | null {
  return agentOfTerminal(t)
}

export type SignInCheck =
  /** Signed in now, as the agent itself says, or as its profile last said when the agent can't
   *  be asked (a Termpolis terminal runs on it: a check could refresh its sign-in). */
  | { kind: 'signed-in'; email: string | null; note?: string }
  | { kind: 'signed-out' }
  /** Couldn't tell: the agent couldn't be asked, and the profile names no sign-in. */
  | { kind: 'unknown'; why: string }

/** Is the target signed in now (§4.4)? A target signed out would relaunch into its sign-in. */
export async function checkSignIn(api: Pick<AccountsAPI, 'check'>, target: AccountRowView): Promise<SignInCheck> {
  let why: string
  try {
    const res = await api.check(target.id)
    if (res.success && res.data?.identity) {
      const id = res.data.identity
      if (id.signedIn === false) return { kind: 'signed-out' }
      if (id.signedIn === true) return { kind: 'signed-in', email: id.email }
    }
    why = res.success ? `${ACCOUNT_AGENT_LABEL[target.agent]} gave no answer` : res.error
  } catch (e) {
    why = e instanceof Error ? e.message : String(e)
  }
  const last = signedInEmail(target)
  return last ? { kind: 'signed-in', email: last, note: why } : { kind: 'unknown', why }
}

export interface SwitchDeps {
  accounts: Pick<AccountsAPI, 'switchAccount'>
  termpolis: Pick<TermpolisAPI, 'claudeTrustWorkspace' | 'memoryPrepareCodexContext'>
  /** "Load memory at launch" (useAutoPrimer): Codex's instruction rides on its command line. */
  primerEnabled: () => boolean
}

export interface SwitchAnswers {
  assumeExited?: boolean
  stopBusy?: boolean
  fresh?: boolean
  /** The user's second confirmation (D14, R17): a switch onto an account that isn't offered
   *  automatically, or off one, is refused in main without it. */
  confirmedCarry?: boolean
}

/**
 * Runs the switch: the target is prepared first, as a launch on it would be (its folder trust for
 * Claude Code, awaited before anything is typed; Codex's approvals and instruction in its home),
 * then main exits the agent, types the line and watches what it does.
 */
export async function runSwitch(
  terminal: Pick<TerminalSession, 'id' | 'cwd' | 'shellType'>,
  agent: AccountAgent,
  target: AccountRowView,
  answers: SwitchAnswers,
  deps: SwitchDeps,
  reason = 'by hand',
): Promise<SwitchOutcome> {
  const req: SwitchRequest = { terminalId: terminal.id, targetId: target.id, shellType: terminal.shellType, reason, ...answers }
  try {
    if (agent === 'claude' && terminal.cwd) {
      try { await deps.termpolis.claudeTrustWorkspace(terminal.cwd, target.id) } catch { /* its trust dialog is the user's then */ }
    }
    if (agent === 'codex' && terminal.cwd) {
      try {
        const r = await deps.termpolis.memoryPrepareCodexContext(terminal.cwd, target.id)
        const text = r?.success ? r.data?.developerInstructions : null
        if (text && deps.primerEnabled() && isShellSafeInstruction(text)) req.instructions = text
      } catch { /* resumed without it */ }
    }
    const res = await deps.accounts.switchAccount(req)
    return res.success ? res.data : { kind: 'refused', why: res.error }
  } catch (e) {
    return { kind: 'refused', why: e instanceof Error ? e.message : String(e) }
  }
}

/** The command that resumes `id` in a new terminal beside `source`: its agent, model and other options as the
 *  switch relaunches them (carryForSwitch), then the conversation. Null when the source's command holds what
 *  can't be repeated word for word, or the source is no account agent. */
function resumeCommand(source: TerminalSession, id: string): string | null {
  const agent = terminalAgent(source)
  if (agent !== 'claude' && agent !== 'codex') return null
  const carry = carryForSwitch(agent, source.agentCommand)
  if (!carry.ok) return null
  return relaunchCommand({ agent, id, ...(carry.model ? { model: carry.model } : {}), extra: carry.extra })
}

export interface NewTerminalDeps {
  createTerminal: TermpolisAPI['createTerminal']
  addTerminal: (t: TerminalSession) => void
  /** agentLaunch.ts's launchAgents: types the agent on its account. */
  launch: (targets: AgentLaunchTarget[]) => void
  newId: () => string
}

/** "New terminal on <account>" (§7.4): the same agent in a new terminal in the same folder, on the
 *  account, with a fresh session, for parallel work while this one waits out its reset. */
export async function openOnAccount(source: TerminalSession, target: AccountRowView, deps: NewTerminalDeps, resume?: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const id = deps.newId()
  // A new session beside the source, never its conversation: two agents on one transcript is the R8 harm.
  // The one exception is a conversation the source holds no longer: its agent sits at the target's sign-in
  // screen (a switch landed there), and `resume` names the conversation that relaunch was resuming.
  const command = resume !== undefined && isSessionId(resume) ? resumeCommand(source, resume) : freshCommand(source.agentCommand as string)
  if (command === null) {
    return {
      ok: false,
      error: resume !== undefined && isSessionId(resume)
        ? "Termpolis can't continue the conversation in a new terminal: this terminal's command holds options Termpolis can't take apart. Start the agent from the sidebar on that account, and resume the conversation from Past AI Sessions."
        : "Termpolis can't start a new session from this terminal's command: it picks a conversation and holds options Termpolis can't take apart. Start the agent from the sidebar on that account instead.",
    }
  }
  try {
    const res = await deps.createTerminal(id, source.shellType, source.cwd, undefined, isClaudeCommand(command), ...launchTerminalArgs(target.id, command))
    if (!res.success) return { ok: false, error: `Termpolis couldn't open the terminal: ${res.error}` }
  } catch (e) {
    return { ok: false, error: `Termpolis couldn't open the terminal: ${e instanceof Error ? e.message : String(e)}` }
  }
  deps.addTerminal({
    id, name: `${source.name} · ${target.label}`, color: source.color, shellType: source.shellType, cwd: source.cwd,
    fontSize: source.fontSize, theme: source.theme, fontFamily: source.fontFamily, agentCommand: command, agentAccountId: target.id,
  })
  deps.launch([{ id, agentCommand: command, cwd: source.cwd, shellType: source.shellType, agentAccountId: target.id }])
  return { ok: true, id }
}

/** "Use another agent" (§8.4): another agent in a new terminal in the same folder, on its preferred
 *  account, with a fresh session. Termpolis types nothing of the conversation into it: its memory
 *  primes the new agent at its start. */
export async function openOtherAgent(source: TerminalSession, command: string, label: string, deps: NewTerminalDeps): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const id = deps.newId()
  try {
    const res = await deps.createTerminal(id, source.shellType, source.cwd, undefined, isClaudeCommand(command), ...launchTerminalArgs(undefined, command))
    if (!res.success) return { ok: false, error: `Termpolis couldn't open the terminal: ${res.error}` }
  } catch (e) {
    return { ok: false, error: `Termpolis couldn't open the terminal: ${e instanceof Error ? e.message : String(e)}` }
  }
  deps.addTerminal({
    id, name: `${source.name} · ${label}`, color: source.color, shellType: source.shellType, cwd: source.cwd,
    fontSize: source.fontSize, theme: source.theme, fontFamily: source.fontFamily, agentCommand: command,
  })
  deps.launch([{ id, agentCommand: command, cwd: source.cwd, shellType: source.shellType }])
  return { ok: true, id }
}

/** The agent has more than one account: a relaunch can land on a profile whose sign-in expired,
 *  so its login-method picker is the user's to answer (R10). */
export function hasManyAccounts(view: AccountsView | null, agent: AccountAgent | null): boolean {
  return !!view && !!agent && view.accounts.filter((r) => r.agent === agent).length > 1
}
