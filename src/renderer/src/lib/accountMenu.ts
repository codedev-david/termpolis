// The account menu (the in-app account UI, §2.1), the logic under AccountMenu.tsx: one row per
// account of the terminal's agent, in registry order, with its status in a few words and what
// picking it does; the second confirmation the work account takes (D14, R17); the menu's keyboard
// moves; and where it opens, and where the keyboard goes back to when it closes.
import { isProfileAgent } from '../../../shared/agentAccounts'
import type { AccountAgent, AccountRowView, AccountsView } from '../../../shared/agentAccounts'
import { untilText } from '../../../shared/accountLimits'
import { signedInElsewhere, signedInEmail } from './accountChip'
import { AGENT_COLOR, workerBlocker } from './accountsView'

/** What picking a row does: switch now; wait for the agent's turn to end, then switch; sign in
 *  first, then switch; agy's switch-all; nothing (the current account, or one that can't). */
export type MenuAction = 'switch' | 'queue' | 'sign-in-and-switch' | 'agy' | 'none'

export type MenuTone = 'good' | 'muted' | 'warn' | 'bad'

export interface MenuRow {
  account: AccountRowView
  current: boolean
  initial: string
  color: string
  /** The email its CLI reports, else the one it was registered with. */
  email: string | null
  status: string
  tone: MenuTone
  /** A warning under the status: switching there drops Termpolis's tools (R30). */
  note: string | null
  /** Why it can't be picked, in a few words; null when it can. */
  disabled: string | null
  action: MenuAction
}

const WORKER_BLOCKED: Readonly<Record<'not-connected' | 'bypass', string>> = {
  'not-connected': 'Not connected: a worker needs Termpolis\'s tools',
  bypass: 'Accept bypass mode in it once to take workers',
}

/** Signed in, as the agent last said, or as its profile last named. */
export function isSignedIn(r: AccountRowView): boolean {
  return r.identity && r.identity.signedIn !== null ? r.identity.signedIn : !!r.lastEmail
}

function statusOf(r: AccountRowView, now: number): { status: string; tone: MenuTone } {
  if (!isProfileAgent(r.agent)) return { status: r.autoOffer ? 'Google account' : 'Not offered automatically', tone: 'muted' }
  if (r.identity?.source === 'sign-in-screen' && r.identity.signedIn === false) return { status: 'Sign-in expired', tone: 'bad' }
  if (r.limit && r.limit.scope !== 'model') {
    const until = untilText(r.limit.resetsAt, now)
    return { status: until ? `Out of usage ${until}` : 'Out of usage', tone: 'warn' }
  }
  if (r.limit) return { status: 'A model is out of usage', tone: 'warn' }
  if (r.limitedOutside !== undefined) return { status: 'Out of usage (your failover hook)', tone: 'warn' }
  const elsewhere = signedInElsewhere(r)
  if (elsewhere) return { status: `Signed in as ${elsewhere}`, tone: 'warn' }
  if (!isSignedIn(r)) return { status: 'Signed out', tone: 'muted' }
  return r.autoOffer ? { status: 'Signed in', tone: 'good' } : { status: 'Not offered automatically', tone: 'muted' }
}

export function menuRows(view: AccountsView, agent: AccountAgent, currentId: string | undefined, now: number, opts: { busy: boolean; worker: boolean }): MenuRow[] {
  return view.accounts.filter((r) => r.agent === agent).map((r): MenuRow => {
    const current = r.id === currentId
    const profile = isProfileAgent(agent)
    const blocker = opts.worker && !current ? workerBlocker(r, view) : null
    const disabled = !current && profile && !r.folderExists ? 'Its profile folder is missing' : blocker ? WORKER_BLOCKED[blocker] : null
    const { status, tone } = statusOf(r, now)
    const signIn = profile && (status === 'Sign-in expired' || !isSignedIn(r))
    const action: MenuAction = current || disabled ? 'none' : !profile ? 'agy' : signIn ? 'sign-in-and-switch' : opts.busy ? 'queue' : 'switch'
    return {
      account: r,
      current,
      initial: (r.label.trim().charAt(0) || '?').toUpperCase(),
      color: r.color ?? AGENT_COLOR[agent],
      email: (profile ? signedInEmail(r) : null) ?? r.email ?? null,
      status: disabled ?? status,
      tone: disabled ? 'bad' : tone,
      note: profile && !r.isDefault && !r.connect ? 'Not connected: loses Termpolis\'s tools' : null,
      disabled,
      action,
    }
  })
}

/** What a row's action says under it, or null for a plain switch. */
export function actionWords(row: MenuRow): string | null {
  if (row.action === 'queue') return 'Switch when it finishes'
  if (row.action === 'sign-in-and-switch') return `Sign in to ${row.account.label} and switch`
  if (row.action === 'agy') return 'Moves every Gemini terminal'
  return null
}

/** When Termpolis doesn't know which account a terminal runs on (the user changed it by hand, or an
 *  agent was started by hand, so `current` is none), the account kept from the automatic offers
 *  that its conversation may be on: main's switch gate asks the same (D14, R17). */
export function maybeOnUnoffered(accounts: readonly AccountRowView[], agent: AccountAgent, current: AccountRowView | undefined): AccountRowView | undefined {
  return current ? undefined : accounts.find((r) => r.agent === agent && !r.autoOffer)
}

/** The second confirmation (D14, R17): onto an account not offered automatically, or carrying a
 *  conversation off one, or one that may be on one (`maybeOn`, when the terminal's account isn't
 *  known). Carrying off one offers a fresh session in a new terminal instead. */
export function confirmFor(from: AccountRowView | undefined, to: AccountRowView, maybeOn?: AccountRowView): { question: string; newTerminal: boolean } | null {
  if (!to.autoOffer) return { question: `${to.label} isn't offered automatically. Switch this terminal to ${to.label}?`, newTerminal: false }
  if (from && !from.autoOffer) return { question: `This conversation is on ${from.label}, which isn't offered automatically. Carry it to ${to.label}?`, newTerminal: true }
  if (!from && maybeOn) return { question: `This conversation may be on ${maybeOn.label}, which isn't offered automatically. Carry it to ${to.label}?`, newTerminal: true }
  return null
}

/** Where the menu's focus goes from `at`: the next or previous enabled item, round the ends, or the
 *  first or last one; -1 when none is enabled. */
export function moveIndex(enabled: readonly boolean[], at: number, how: 'next' | 'prev' | 'first' | 'last'): number {
  const ids = enabled.map((e, i) => (e ? i : -1)).filter((i) => i >= 0)
  if (ids.length === 0) return -1
  if (how === 'first') return ids[0]
  if (how === 'last') return ids[ids.length - 1]
  const k = ids.indexOf(at)
  if (k < 0) return how === 'next' ? ids[0] : ids[ids.length - 1]
  return ids[(k + (how === 'next' ? 1 : -1) + ids.length) % ids.length]
}

/** Type-ahead: the first label after `from` (round the end) that starts with what was typed; -1
 *  for none. */
export function typeAhead(labels: readonly string[], typed: string, from: number): number {
  const q = typed.toLowerCase()
  for (let k = 1; k <= labels.length; k++) {
    const i = (from + k + labels.length) % labels.length
    if (labels[i].toLowerCase().startsWith(q)) return i
  }
  return -1
}

export const MENU_WIDTH = 320
const MARGIN = 6

/** The terminal's own input, which takes the keyboard back when the menu closes. */
export function focusTerminal(terminalId: string): void {
  document.querySelector<HTMLElement>(`[data-terminal-id="${terminalId}"] textarea`)?.focus()
}

/** Where the menu opens: under the terminal's chip, else at the top right of its pane, else at the
 *  top of the window; always inside the window. */
export function menuPosition(terminalId: string, width = MENU_WIDTH): { top: number; left: number } {
  const chip = document.querySelector(`[data-account-chip="${terminalId}"]`)
  const pane = document.querySelector(`[data-terminal-id="${terminalId}"]`)
  const r = (chip ?? pane)?.getBoundingClientRect()
  const top = !r ? 80 : chip ? r.bottom + 4 : r.top + 32
  const left = !r ? (window.innerWidth - width) / 2 : r.right - width - (chip ? 0 : 8)
  return { top: Math.max(MARGIN, top), left: Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN)) }
}
