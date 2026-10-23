// Settings ▸ Accounts, the renderer's pure half: what a row says about its account, and the
// little decisions the tab makes. Main sends the rows (src/main/accountsIpc.ts); nothing here
// reads a file or builds a path or an env value.
import { familyOf, isProfileAgent, tildifyPath } from '../../../shared/agentAccounts'
import type { AccountAgent, AccountRowView } from '../../../shared/agentAccounts'
import type { ShellType } from '../types'

/** Each agent's colour, as its terminal tab and badge show it: an account with no colour of its own. */
export const AGENT_COLOR: Readonly<Record<AccountAgent, string>> = { claude: '#D97706', codex: '#10B981', agy: '#4285F4' }

export function accountsOf(rows: readonly AccountRowView[], agent: AccountAgent): AccountRowView[] {
  return rows.filter((r) => r.agent === agent)
}

/** Any account registered at all. With none, Termpolis behaves as before accounts (D13). */
export function hasAccounts(rows: readonly AccountRowView[]): boolean {
  return rows.length > 0
}

export type BadgeTone = 'good' | 'warn' | 'bad' | 'muted'

function sameEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function resetTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/** The row's state, worst first: a missing folder, a usage limit, a profile signed in to
 *  another email than the account's own, then who it is signed in as. */
export function accountBadge(r: AccountRowView, now: number): { text: string; tone: BadgeTone } {
  if (!isProfileAgent(r.agent)) return { text: r.email ?? 'no email given', tone: 'muted' }
  if (!r.folderExists) return { text: 'folder missing', tone: 'bad' }
  if (r.limit && r.limit.scope === 'model') return { text: 'a model is out of usage', tone: 'warn' }
  if (r.limit) return { text: r.limit.resetsAt !== null && r.limit.resetsAt > now ? `out of usage · resets ${resetTime(r.limit.resetsAt)}` : 'out of usage', tone: 'warn' }
  if (r.limitedOutside !== undefined) return { text: 'out of usage (seen by your failover hook)', tone: 'warn' }
  const checked = r.identity && r.identity.signedIn !== null ? r.identity : null
  const actual = checked ? (checked.signedIn ? checked.email : null) : r.lastEmail
  if (r.email && actual && !sameEmail(r.email, actual)) return { text: `signed in to ${actual} instead!`, tone: 'bad' }
  if (checked) {
    if (!checked.signedIn) return checked.source === 'sign-in-screen' ? { text: 'sign-in expired', tone: 'bad' } : { text: 'signed out', tone: 'muted' }
    return { text: checked.email ? `signed in as ${checked.email}` : 'signed in', tone: 'good' }
  }
  return r.lastEmail ? { text: `last signed in as ${r.lastEmail}`, tone: 'muted' } : { text: 'signed out', tone: 'muted' }
}

/** The row's folder, with the home folder as ~. */
export function folderLine(r: AccountRowView, home: string): string {
  if (!r.folder) return ''
  const shown = tildifyPath(r.folder, home)
  return r.isDefault ? `${shown} (main profile)` : shown
}

/** The account agent a terminal's launch command runs, or null. agy only: Termpolis launches
 *  agy for its Gemini profile, and the legacy `gemini` CLI has no accounts in 1.54. */
export function agentOfCommand(command: string | undefined): AccountAgent | null {
  const c = (command ?? '').trim().toLowerCase()
  if (c.startsWith('claude')) return 'claude'
  if (c.startsWith('codex')) return 'codex'
  if (c.startsWith('agy')) return 'agy'
  return null
}

/** The agent a terminal runs, as Termpolis knows it: the one it launched there, or a swarm worker's,
 *  as main recorded the command run_command started it with. Never the conductor's, which runs
 *  `claude -p` behind its script and is never switched. */
export function agentOfTerminal(t: { agentCommand?: string; isConductor?: boolean; isSwarm?: boolean; swarmAgent?: AccountAgent } | undefined): AccountAgent | null {
  if (!t || t.isConductor) return null
  return agentOfCommand(t.agentCommand) ?? (t.isSwarm ? t.swarmAgent ?? null : null)
}

/** Why an account can't take a swarm worker over, or null when it can: it must be connected, its
 *  profile holding Termpolis's server entry with Agent Integration on, so the worker keeps
 *  Termpolis's tools (§8.3 rule 8); and for Claude Code it must skip the bypass-permissions
 *  warning, which a worker's --dangerously-skip-permissions opens otherwise and Termpolis never
 *  answers (R16). */
export function workerBlocker(row: AccountRowView, view: { integrationConnected: boolean }): 'not-connected' | 'bypass' | null {
  if (!view.integrationConnected || !(row.isDefault || row.connect) || row.connection?.server !== true) return 'not-connected'
  return row.agent === 'claude' && !row.bypassReady ? 'bypass' : null
}

/** The account agent a swarm worker's name says it runs ("Claude", "Codex", "Gemini"), or null.
 *  Termpolis runs agy for Gemini. */
export function agentOfName(name: string): AccountAgent | null {
  if (/claude/i.test(name)) return 'claude'
  if (/codex/i.test(name)) return 'codex'
  return /gemini|antigravity|\bagy\b/i.test(name) ? 'agy' : null
}

/** The shell a sign-in terminal opens in: the user's default when Termpolis can type an account
 *  line into it, else another installed one, PowerShell first; null when there is none. */
export function signInShell(defaultShell: ShellType, available: readonly ShellType[]): ShellType | null {
  if (available.includes(defaultShell) && familyOf(defaultShell)) return defaultShell
  const order: ShellType[] = ['powershell', 'gitbash', 'bash', 'zsh', 'cmd']
  return order.find((s) => available.includes(s)) ?? null
}
