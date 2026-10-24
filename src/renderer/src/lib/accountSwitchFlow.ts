// The account switch's logic (§7), under the account menu and the limit card: the target's sign-in
// check (§4.4), the target's preparation the launch makes too (folder trust, Codex's instruction),
// the run itself in main (accounts:switch), what each outcome tells a swarm worker's conductor, and
// the new terminals the menu and the card open. Main does the typing; this never writes to a
// terminal.
import { ACCOUNT_AGENT_LABEL } from '../../../shared/agentAccounts'
import type { AccountAgent, AccountRowView, AccountsView } from '../../../shared/agentAccounts'
import type { SwitchOutcome, SwitchRequest } from '../../../shared/accountSwitch'
import { isShellSafeInstruction } from '../../../shared/agentIntegration'
import type { AccountsAPI, TermpolisAPI, TerminalSession } from '../types'
import { signedInEmail } from './accountChip'
import { agentOfTerminal } from './accountsView'
import type { AgentLaunchTarget } from './agentLaunch'
import { launchTerminalArgs } from './accountLaunch'
import { isClaudeCommand } from './testAgents'

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

/** What the dialog shows after a switch: its words, how they read, and what the user can do next. */
export interface OutcomeView {
  tone: 'good' | 'warn' | 'bad'
  text: string
  /** The answer that runs the switch again, and its button's words. */
  retry?: { label: string; answers: SwitchAnswers }
  /** The line to copy, when nothing was entered. */
  line?: string
  /** It is done: the dialog can close. */
  done: boolean
}

export function outcomeView(o: SwitchOutcome, agent: AccountAgent, target: AccountRowView): OutcomeView {
  const name = ACCOUNT_AGENT_LABEL[agent]
  const exit = agent === 'codex' ? '/quit' : '/exit'
  switch (o.kind) {
    case 'switched': {
      const parts = [`Now on ${target.label}. Your conversation continues. Its first answer re-reads the whole conversation (no shared prompt cache).`]
      if (o.kept) parts.push(`${target.label} had a newer copy of it, kept beside it as ${o.kept}.`)
      return { tone: 'good', text: parts.join(' '), done: true }
    }
    case 'fresh': {
      const why = o.why === 'not-found'
        ? `${name} can't carry this conversation to ${target.label}, so a new session started there. Termpolis's memory still has what it learned.`
        : o.why === 'no-session'
          ? `${name} named no conversation to resume, so a new session started on ${target.label}.`
          : `A new session started on ${target.label}.`
      return { tone: 'warn', text: why, done: true }
    }
    case 'busy':
      return { tone: 'warn', text: `${name} is working. Stop it and switch?`, retry: { label: 'Stop it and switch', answers: { stopBusy: true } }, done: false }
    case 'unknown-exit':
      return { tone: 'warn', text: `Termpolis can't tell whether ${name} is still running here, so it typed nothing. Has ${name} exited?`, retry: { label: 'It has exited, switch now', answers: { assumeExited: true } }, done: false }
    case 'exit-unconfirmed':
      return { tone: 'warn', text: `Termpolis couldn't confirm ${name} exited, so it typed nothing more. Exit it yourself with ${exit}, then switch again.`, retry: { label: 'It has exited, switch now', answers: { assumeExited: true } }, done: false }
    case 'agent-alive':
      return { tone: 'bad', text: `${name} didn't exit: the account line showed in its own input, so Termpolis took it back out and entered nothing.`, done: false }
    case 'didnt-start':
      return { tone: 'bad', text: 'The switch didn\'t start: the line never showed in the terminal, so nothing was entered.', retry: { label: 'Try again', answers: { assumeExited: true } }, line: o.line, done: false }
    case 'resume-not-found':
      return { tone: 'bad', text: `${target.label} can't see that conversation.`, retry: { label: `Start a new session on ${target.label}`, answers: { assumeExited: true, fresh: true } }, done: false }
    case 'sign-in':
      return { tone: 'bad', text: `${target.label}'s sign-in has expired: sign it in again from its card in Settings ▸ Accounts. Termpolis answers nothing on its sign-in screen.`, done: true }
    case 'asks-user':
      return { tone: 'warn', text: `${target.label} is asking something only you can answer: answer it in the terminal.`, done: true }
    case 'no-outcome':
      return { tone: 'warn', text: 'The switch didn\'t finish: nothing showed in the terminal within 30 seconds. Look at the terminal.', done: true }
    default:
      return { tone: 'bad', text: `Termpolis didn't switch: ${o.why}.`, done: false }
  }
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
export async function openOnAccount(source: TerminalSession, target: AccountRowView, deps: NewTerminalDeps): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const id = deps.newId()
  const command = source.agentCommand as string
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
