// Launching an agent on an account that is out of usage (the design's launch paths, §6.3, ask mode):
// "personal is out of usage until 3pm. Launch on codedev?" Asked in the app's own sheet, before the
// terminal is made, only for a fresh launch that falls on the agent's preferred account (an account the
// user picked, Launch on ▸ one, is their choice) and only when another account is a way out by what
// Termpolis knows. With no account registered, or none out of usage, nothing is asked and the launch is
// exactly what it was (D13).
import { ACCOUNT_AGENT_LABEL } from '../../../shared/agentAccounts'
import type { AccountAgent, AccountRowView } from '../../../shared/agentAccounts'
import { isAccountLimited, limitTargets, untilText } from '../../../shared/accountLimits'
import { useTerminalStore } from '../store/terminalStore'
import { launchAccountFor } from './accountLaunch'
import type { AccountsBridge } from './accountLaunch'

/** What the sheet is asked: the account the launch would go on, when it is back, and the ways out. */
export interface LaunchAskContext {
  agent: AccountAgent
  limited: { id: string; label: string }
  /** "until 4:00 pm", or empty when the CLI named no time. */
  until: string
  /** The accounts that are a way out, in failover order. */
  options: Array<{ id: string; label: string }>
}

export type LaunchChoice = { kind: 'on'; accountId: string } | { kind: 'anyway' } | { kind: 'cancel' }

let pending: ((c: LaunchChoice) => void) | null = null

/** Shows the sheet and waits for the user's word. A second ask while one is open cancels the first. */
export function askInApp(ctx: LaunchAskContext): Promise<LaunchChoice> {
  return new Promise((resolve) => {
    pending?.({ kind: 'cancel' })
    pending = resolve
    useTerminalStore.getState().setLaunchAsk(ctx)
  })
}

/** The user's word, from the sheet: ends the ask. */
export function answerLaunchAsk(choice: LaunchChoice): void {
  const resolve = pending
  pending = null
  useTerminalStore.getState().setLaunchAsk(null)
  resolve?.(choice)
}

export function _resetLaunchAskForTest(): void {
  pending = null
}

/** The account a fresh launch of `command` goes on, and whether the user cancelled it. */
export type LaunchAccount = { cancelled: true } | { cancelled: false; accountId: string | undefined }

/**
 * launchAccountFor, then the ask: when `requested` names no account (the launch falls on the agent's
 * preferred one), that account is out of usage, and another is a way out, the user is asked. Their
 * choice becomes the account, "anyway" keeps it, and Cancel stops the launch.
 */
export async function launchAccountAsked(
  command: string | undefined,
  requested?: string,
  api?: AccountsBridge | null,
  ask: (ctx: LaunchAskContext) => Promise<LaunchChoice> = askInApp,
  now: number = Date.now(),
): Promise<LaunchAccount> {
  const accountId = await launchAccountFor(command, requested, api)
  if (requested || !accountId) return { cancelled: false, accountId }
  const view = useTerminalStore.getState().accountsView
  const row: AccountRowView | undefined = view?.accounts.find((r) => r.id === accountId)
  if (!view || !row || !isAccountLimited(row, now)) return { cancelled: false, accountId }
  // Not one known to be signed out: the agent would open on its sign-in screen inside the terminal, which the
  // account UI never asks of the user (its sign-in has a sheet of its own).
  const ways = limitTargets(view.accounts, row.agent, { accountId: row.id, email: row.lastEmail ?? null }, now)
    .filter((t) => t.state === 'available' && t.row.identity?.signedIn !== false)
  if (ways.length === 0) return { cancelled: false, accountId }
  const choice = await ask({
    agent: row.agent,
    limited: { id: row.id, label: row.label },
    until: untilText(row.limit?.resetsAt ?? null, now),
    options: ways.map((t) => ({ id: t.row.id, label: t.row.label })),
  })
  if (choice.kind === 'cancel') return { cancelled: true }
  return { cancelled: false, accountId: choice.kind === 'on' ? choice.accountId : accountId }
}

/** The sheet's headline. */
export function launchAskHeadline(ctx: LaunchAskContext): string {
  return `${ACCOUNT_AGENT_LABEL[ctx.agent]}: ${ctx.limited.label} is out of usage${ctx.until ? ` ${ctx.until}` : ''}. Launch on ${ctx.options[0].label}?`
}
