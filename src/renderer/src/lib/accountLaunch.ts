// Launching an agent on an account (§6.3), the renderer's side. Main resolves the account and
// builds the line (accounts:launch-account, accounts:launch-line), so the renderer never builds a
// path or an env value, and what a terminal records about its account is what main answered.
// Where this preload has no accounts bridge, every launch is today's: the bare command.
import { ACCOUNT_AGENT_LABEL } from '../../../shared/agentAccounts'
import type { AccountsAPI } from '../types'
import { agentOfCommand } from './accountsView'

export type AccountsBridge = Pick<AccountsAPI, 'launchAccount' | 'launchLine'>

/** The line a launch types, without its Enter, and the account and session it is on; or, as a
 *  sentence to show, why nothing may be typed. */
export type LaunchLine = { line: string; accountId?: string; sessionId?: string } | { refused: string }

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The bridge, when this preload has one. */
export function accountsBridge(): AccountsBridge | null {
  const api = window.accounts
  return api && typeof api.launchLine === 'function' && typeof api.launchAccount === 'function' ? api : null
}

/** The account a launch of `command` goes on: `requested` while it is registered, else its
 *  agent's preferred one. Undefined for a command of no account agent, an agent with no accounts,
 *  or an answer main couldn't give: the launch's writes then go to the default profile, as
 *  before accounts. */
export async function launchAccountFor(command: string | undefined, requested?: string, api: AccountsBridge | null = accountsBridge()): Promise<string | undefined> {
  const agent = agentOfCommand(command)
  if (!agent || !api) return undefined
  try {
    const res = await api.launchAccount(agent, requested ?? null)
    return res.success && res.data.accountId ? res.data.accountId : undefined
  } catch {
    return undefined
  }
}

/** What to type to start `command` in terminal `terminalId`: main's line, on `accountId` (else the
 *  preferred account). The bare command for a command of no account agent, or with no bridge.
 *  `agentCommand` is what tells which agent it is (the command can be a test shim's). */
export async function accountLaunchLine(
  terminalId: string,
  shellType: string,
  command: string,
  agentCommand: string,
  accountId?: string,
  api: AccountsBridge | null = accountsBridge(),
): Promise<LaunchLine> {
  const agent = agentOfCommand(agentCommand)
  if (!agent || !api) return { line: command }
  // Nothing is typed then: the bare command would start the agent on whatever account the shell
  // is on, which once the agent has accounts may be the wrong one.
  const refused = (why: string): LaunchLine => ({ refused: `Termpolis didn't start ${ACCOUNT_AGENT_LABEL[agent]}: ${why}` })
  try {
    const res = await api.launchLine({ terminalId, agent, shellType, command, accountId: accountId ?? null })
    if (!res.success) return refused(res.error)
    const out: LaunchLine = { line: res.data.line }
    if (res.data.accountId) out.accountId = res.data.accountId
    if (res.data.sessionId) out.sessionId = res.data.sessionId
    return out
  } catch (e) {
    return refused(errorText(e))
  }
}
