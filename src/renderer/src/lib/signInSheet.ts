// The sign-in sheet's words and decisions (the in-app account UI, §2.3), the pure half: how each
// agent signs in, the warning before a profile is signed in again (R29), what a finished sign-in's
// email says about the account (R20, R21, R23), what the live region announces at each step, and
// the keys the fallback's "Let me type here" passes on. Nothing here talks to main.
import { ACCOUNT_AGENT_LABEL } from '../../../shared/agentAccounts'
import type { AccountAgent, AccountRowView, AccountsView, ProfileAgent, SignInMethod } from '../../../shared/agentAccounts'
import type { SignInPhase } from '../../../shared/signInScreens'
import { signedInEmail } from './accountChip'

export interface MethodChoice {
  id: SignInMethod
  label: string
  hint: string
}

/** How each agent signs in: the first is its default. Claude Code's `--claudeai`, `--console` and
 *  `--sso`; Codex's browser sign-in and its device code (`--device-auth`). */
export const SIGN_IN_METHODS: Readonly<Record<ProfileAgent, readonly MethodChoice[]>> = {
  claude: [
    { id: 'claudeai', label: 'Claude subscription', hint: 'Your claude.ai plan' },
    { id: 'console', label: 'Anthropic Console', hint: 'API usage billing' },
    { id: 'sso', label: 'SSO', hint: 'Your organization\'s single sign-on' },
  ],
  codex: [
    { id: 'browser', label: 'ChatGPT account', hint: 'In your browser' },
    { id: 'device', label: 'Sign in with a code', hint: 'Use this if the browser can\'t reach this computer' },
  ],
}

/** Said before a profile that had a sign-in, or has terminals on it, is signed in again (R29):
 *  Termpolis knows only its own terminals, so it names the sessions it can't see too. */
export function resignWarning(row: AccountRowView): string | null {
  if (!signedInEmail(row) && !row.lastEmail && row.terminals === 0) return null
  const n = row.terminals
  const close = n > 0 ? ` Close the ${n} Termpolis terminal${n === 1 ? '' : 's'} on ${row.label} first.` : ''
  return `Signing in again replaces ${row.label}'s sign-in for every ${ACCOUNT_AGENT_LABEL[row.agent]} session that uses this profile, outside Termpolis too, including scheduled jobs: one still running can overwrite the new sign-in when it refreshes.${close}`
}

const sameEmail = (a: string | null | undefined, b: string): boolean => !!a && a.toLowerCase() === b.toLowerCase()

/** What the email a sign-in finished with says about the account: another account of the same
 *  agent has it already (a work account among them), or it isn't the one the account should have. */
export function successWarnings(view: AccountsView, row: AccountRowView, email: string | null): string[] {
  if (!email) return []
  const out: string[] = []
  const other = view.accounts.find((r) => r.id !== row.id && r.agent === row.agent && (sameEmail(r.email, email) || sameEmail(signedInEmail(r), email)))
  if (other) {
    out.push(other.autoOffer
      ? `${email} is ${other.label}'s sign-in too: switching between ${row.label} and ${other.label} changes nothing.`
      : `${email} is ${other.label}'s sign-in, and ${other.label} isn't offered automatically.`)
  }
  if (row.email && !sameEmail(row.email, email)) out.push(`${row.label} should sign in as ${row.email}; it's signed in as ${email}.`)
  return out
}

/** What the live region says at each step, for a screen reader. */
export function announce(phase: SignInPhase, agent: AccountAgent): string {
  const name = ACCOUNT_AGENT_LABEL[agent]
  switch (phase.kind) {
    case 'starting': return `Starting ${name}'s sign-in.`
    case 'browser': return 'Finish signing in in your browser.'
    case 'code-wanted': return 'Sign in in your browser, then paste the code the page shows.'
    case 'device-code': return `Enter the code ${phase.code} in your browser.`
    case 'choose': return `${phase.question} ${phase.options.length} choices.`
    case 'text-wanted': return phase.label
    case 'signing-out': return 'Signing agy out.'
    case 'working': return 'Working on it.'
    case 'confirming': return 'Checking the sign-in.'
    case 'success': return phase.email ? `Signed in as ${phase.email}.` : 'Signed in.'
    case 'error': return `${name} didn't sign in: ${sentence(phase.message)}`
    case 'unknown': return `Termpolis can't read ${name}'s screen, so it shows it as it is.`
    default: return 'The sign-in was cancelled.'
  }
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: '\r', Backspace: '\x7f', Escape: '\x1b', Delete: '\x1b[3~',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Home: '\x1b[H', End: '\x1b[F',
}

/** `text` as one sentence with one full stop: the CLI's own messages mostly end with one, and a line
 *  built from them is not to end with two. A question or exclamation mark stands as it is. */
export function sentence(text: string): string {
  const t = text.trim().replace(/\.+$/, '')
  return /[?!]$/.test(t) ? t : `${t}.`
}

/** The bytes a key sends to the CLI from the fallback's live view, or null for none. Tab is left to
 *  the keyboard, to leave the view. */
export function keysFor(e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): string | null {
  if (e.metaKey || e.altKey) return null
  if (NAMED_KEYS[e.key]) return NAMED_KEYS[e.key]
  if (e.ctrlKey) return /^[a-z]$/i.test(e.key) ? String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96) : null
  return e.key.length === 1 ? e.key : null
}
