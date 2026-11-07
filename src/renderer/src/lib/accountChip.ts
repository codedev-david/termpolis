// The terminal header's account chip (§6.4), the pure half: what it says about a terminal's
// account, from the terminal's own record (what main answered at its launch or switch) and the
// account rows main sends. Nothing here reads a file.
import { ACCOUNT_AGENT_LABEL, isProfileAgent, tildifyPath } from '../../../shared/agentAccounts'
import type { AccountAgent, AccountRowView, AccountsView } from '../../../shared/agentAccounts'
import { AGENT_COLOR, agentOfTerminal } from './accountsView'

export interface ChipTerminal {
  agentCommand?: string
  agentAccountId?: string
  isConductor?: boolean
  isSwarm?: boolean
  swarmAgent?: AccountAgent
}

export interface AccountChipView {
  agent: AccountAgent
  /** The account's label, or "?" (changed by hand), "default?" (no record), "removed account". */
  label: string
  color: string
  /** Red: the account was changed by hand, removed, or its profile is signed in to another email. */
  alert: boolean
  title: string
  /** The account, when it is known and registered. */
  account?: AccountRowView
}

function sameEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** The email the account's profile is signed in to, as last read; null when unknown. */
export function signedInEmail(r: AccountRowView): string | null {
  if (r.identity && r.identity.signedIn !== null) return r.identity.signedIn ? r.identity.email : null
  return r.lastEmail
}

/** The profile's sign-in is another email than the account's own. */
export function signedInElsewhere(r: AccountRowView): string | null {
  const actual = signedInEmail(r)
  return r.email && actual && !sameEmail(r.email, actual) ? actual : null
}

/**
 * The chip for a terminal, or null when it shows none: not an agent terminal Termpolis launched
 * (the conductor's is never switched), or its agent has fewer than two accounts and nothing is
 * wrong with the one it is on (D13).
 */
export function accountChipFor(t: ChipTerminal | undefined, view: AccountsView | null, byHand: boolean): AccountChipView | null {
  const agent = agentOfTerminal(t)
  if (!agent || !view) return null
  const rows = view.accounts.filter((r) => r.agent === agent)
  if (rows.length === 0) return null
  const name = ACCOUNT_AGENT_LABEL[agent]
  const click = 'Click to switch.'
  if (byHand) {
    return { agent, label: '?', color: AGENT_COLOR[agent], alert: true, title: `${name}: its account was changed by hand in this terminal, so Termpolis doesn't know which one it runs on. ${click}` }
  }
  const row = t!.agentAccountId ? rows.find((r) => r.id === t!.agentAccountId) : undefined
  if (t!.agentAccountId && !row) {
    return { agent, label: 'removed account', color: AGENT_COLOR[agent], alert: true, title: `${name} on an account that was removed from Settings ▸ Accounts. ${click}` }
  }
  if (!row) {
    if (rows.length < 2) return null
    return { agent, label: 'default?', color: AGENT_COLOR[agent], alert: false, title: `${name}, started before Termpolis knew its accounts: most likely on its default profile. ${click}` }
  }
  const elsewhere = signedInElsewhere(row)
  if (rows.length < 2 && !elsewhere) return null
  const email = signedInEmail(row)
  const parts = [`${name} on ${row.label}`]
  if (elsewhere) parts.push(`but its profile is signed in to ${elsewhere}, not ${row.email}`)
  // agy shows its email on its own screen only: an agy account is named by the email it should have.
  else if (email) parts.push(`last signed in as ${email}`)
  else if (row.email) parts.push(row.email)
  if (isProfileAgent(agent) && row.folder) parts.push(`profile ${tildifyPath(row.folder, view.home)}`)
  return { agent, label: row.label, color: row.color ?? AGENT_COLOR[agent], alert: !!elsewhere, title: `${parts.join(', ')}. ${click}`, account: row }
}
