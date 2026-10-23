// The switch dialog in limit mode, its words (§8.4): what ran out, on which sign-in, and what is left
// to do when no account is a way out. Pure; the dialog (AccountSwitcherDialog.tsx) draws it, and
// limitTargets (src/shared/accountLimits.ts) says which accounts are a way out.
import { ACCOUNT_AGENT_LABEL, isProfileAgent } from '../../../shared/agentAccounts'
import type { AccountAgent, AccountRowView, AccountsView } from '../../../shared/agentAccounts'
import { untilText } from '../../../shared/accountLimits'
import type { LimitTarget } from '../../../shared/accountLimits'
import type { LimitContext } from './limitWatch'

/** The account that ran out, and the email its profile is actually signed in to (R23): for a
 *  profile agent the one it last named, for agy the one it was registered with. */
export function limitedAccount(view: AccountsView, limit: LimitContext): { row: AccountRowView | undefined; email: string | null } {
  const row = limit.accountId ? view.accounts.find((r) => r.id === limit.accountId) : undefined
  if (!row) return { row: undefined, email: null }
  return { row, email: (isProfileAgent(row.agent) ? row.lastEmail : row.email) ?? null }
}

/** "on personal (a@example.test)", or when the profile is signed in to another address than the
 *  account's own, "on personal (signed in as b@…, not a@…)" (R23). */
export function limitOn(view: AccountsView, limit: LimitContext, byHand: boolean): string {
  if (byHand) return 'on an account changed by hand'
  const { row, email } = limitedAccount(view, limit)
  if (!row) return 'on an account Termpolis doesn\'t know'
  if (email && row.email && email.toLowerCase() !== row.email.toLowerCase()) return `on ${row.label} (signed in as ${email}, not ${row.email})`
  return email ? `on ${row.label} (${email})` : `on ${row.label}`
}

/** What the dialog says when no account is a way out: which one frees up first, if one says when. */
export function noWayOut(agent: AccountAgent, targets: readonly LimitTarget[], now: number): string {
  const name = ACCOUNT_AGENT_LABEL[agent]
  const timed = targets
    .filter((t) => t.state === 'limited' && t.row.limit && t.row.limit.resetsAt !== null && t.row.limit.resetsAt > now)
    .sort((a, b) => (a.row.limit!.resetsAt as number) - (b.row.limit!.resetsAt as number))
  const first = timed[0]
  return first ? `No other ${name} account is free. ${first.row.label} is out of usage ${untilText(first.row.limit!.resetsAt, now)}.` : `No other ${name} account is free.`
}

/** The other terminals the same limit stopped, which the dialog asks about next, one at a time. */
export function groupNote(limit: LimitContext, view: AccountsView): string | null {
  const more = limit.terminals.length - 1
  if (more <= 0) return null
  const label = limit.accountId ? view.accounts.find((r) => r.id === limit.accountId)?.label : undefined
  const on = label ? ` on ${label}` : ''
  return `${more} more ${ACCOUNT_AGENT_LABEL[limit.agent]} terminal${more === 1 ? '' : 's'} ran out${on} too: Termpolis asks about each after this one.`
}

/** The command each agent starts with, bare, for "Use another agent". */
export const AGENT_COMMAND: Readonly<Record<AccountAgent, string>> = { claude: 'claude', codex: 'codex', agy: 'agy' }

/** The agents "Use another agent" offers: the installed ones but the terminal's, as Termpolis
 *  detected them (detectAgents: claude, codex, agy). */
export function otherAgents(installed: Readonly<Record<string, boolean>> | null, agent: AccountAgent): AccountAgent[] {
  if (!installed) return []
  return (['claude', 'codex', 'agy'] as const).filter((a) => a !== agent && installed[a] === true)
}
