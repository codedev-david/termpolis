// What a CLI's own sign-in shows, read for the sign-in sheet (the in-app account UI, §3): main runs
// the CLI's login in a hidden session (src/main/signInSession.ts) and reads its screen here, state by
// state, from the words each CLI prints itself. Nothing here decides from text an agent's answer
// could hold: a sign-in session runs only the login, never a conversation.
//
//   Claude Code  `claude auth login --claudeai|--console|--sso`, plain lines (a real capture of 2.1.309):
//                "Opening browser to sign in…", "If the browser didn't open, visit: <url>", then
//                "Paste code here if prompted > "; with no local callback, "The browser can't return the
//                sign-in to Claude Code automatically…", "Sign in at: <url>", "Paste code here > ".
//   Codex        `codex login [--device-auth]` (its program file, 0.153.4): "Starting local login server
//                on http://localhost:<port>.", "If your browser did not open, navigate to this URL to
//                authenticate:", <url>; or "Follow these steps to sign in with ChatGPT using device code
//                authorization:", the link, "Enter this one-time code", the code.
//   agy          its full-screen sign-in (its program file, drawn in the style of its real trust menu:
//                "> " on the highlighted option, two spaces on the others, "↑/↓ Navigate · enter
//                Confirm" under them): "Select login method:", "Select available license:", "Select
//                Google Cloud sign-in method:", "Or, paste the authorization code here and press Enter:".
import { inputBoxRow, isBusyOnScreen } from './agentStatusDetector'
import type { AccountAgent } from './agentAccounts'

export type SignInScreen =
  /** Nothing of the sign-in yet. */
  | { kind: 'starting' }
  /** The CLI opened the browser: the address it printed, and whether it takes a code typed here. */
  | { kind: 'browser'; url: string | null; codeField: boolean }
  /** The browser can't hand the sign-in back by itself: the user pastes the code the page shows. */
  | { kind: 'code-wanted'; url: string | null }
  /** Codex's device code: the code to enter at the address. */
  | { kind: 'device-code'; code: string; url: string | null }
  /** agy asks the user to choose: its question, its options in order, the highlighted one. */
  | { kind: 'choose'; question: string; detail: string[]; options: string[]; selected: number }
  /** agy asks for a value typed in: a Google Cloud project. */
  | { kind: 'text-wanted'; label: string }
  /** The CLI is at work on it. */
  | { kind: 'working' }
  /** The CLI said the sign-in is done. Termpolis still asks its status command (or, for agy, waits
   *  for its input box). */
  | { kind: 'done' }
  /** agy's own input box, idle: agy is signed in and running. */
  | { kind: 'agy-ready' }
  /** The CLI said it failed: its own words. */
  | { kind: 'error'; message: string }
  /** Something Termpolis can't read as any of these. */
  | { kind: 'unknown' }

/** What a screen read takes: the rows the CLI's screen shows now, and everything it printed since it
 *  started with the escape sequences taken out (`text`), in which an address the screen wraps is
 *  still whole. */
export interface SignInRead {
  lines: readonly string[]
  text: string
  /** The terminal's title, for the busy check of agy's box. */
  title?: string
}

/** The provider's own sign-in pages, from the CLIs' program files (Claude Code's CONSOLE_AUTHORIZE_URL
 *  and CLAUDE_AI_AUTHORIZE_URL, Codex's issuer and device page, agy's Google OAuth): the only
 *  addresses Termpolis opens a browser at, and only on the user's click. */
export const SIGN_IN_PAGES: Readonly<Record<AccountAgent, ReadonlyArray<{ host: string; path: string }>>> = {
  claude: [
    { host: 'claude.com', path: '/cai/oauth/authorize' },
    { host: 'platform.claude.com', path: '/oauth/authorize' },
  ],
  codex: [
    { host: 'auth.openai.com', path: '/oauth/authorize' },
    { host: 'auth.openai.com', path: '/codex/device' },
  ],
  agy: [
    { host: 'accounts.google.com', path: '/o/oauth2/auth' },
  ],
}

/** Whether `url` is one of `agent`'s own sign-in pages: https, no user or password, the exact host,
 *  and the page's path (or below it). Anything else is never opened. */
export function isSignInPage(agent: AccountAgent, url: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (typeof url !== 'string' || url.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(url)) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
  return SIGN_IN_PAGES[agent].some((p) => u.hostname === p.host && (u.pathname === p.path || u.pathname.startsWith(`${p.path}/`)))
}

/** An address as a CLI prints it: http(s), up to the first space or quote. */
const ADDRESS = /https?:\/\/[^\s"'<>`]+/g

/** The first https address printed after the last `after`, or null. A CLI prints a localhost one
 *  for its own callback (Codex's login server) beside the page's: that one is no page to open. */
function addressAfter(text: string, after: RegExp): string | null {
  let from = -1
  for (const m of text.matchAll(new RegExp(after.source, 'g'))) from = m.index! + m[0].length
  if (from < 0) return null
  for (const m of text.slice(from).matchAll(ADDRESS)) {
    if (m[0].startsWith('https://')) return m[0]
  }
  return null
}

/** The last match of `re` in `text`: its first group, trimmed. */
function lastWords(text: string, re: RegExp): string | null {
  let found: string | null = null
  for (const m of text.matchAll(new RegExp(re.source, 'g'))) found = m[1].trim()
  return found
}

// ── Claude Code ─────────────────────────────────────────────────────────────────────────

const CLAUDE_ERRORS = [
  /OAuth login failed: ([^\n]+)/,
  /Login failed: ([^\n]+)/,
  /(Invalid code\. Please make sure the full code was copied\.)/,
  /(Login interrupted)/,
]

function claudeScreen(r: SignInRead): SignInScreen {
  const t = r.text
  for (const re of CLAUDE_ERRORS) {
    const words = lastWords(t, re)
    if (words) return { kind: 'error', message: words.replace(/\s*Run with --debug for the underlying error\.?$/, '') }
  }
  if (/Login successful/.test(t)) return { kind: 'done' }
  if (/The browser can't return the sign-in to Claude Code automatically/.test(t)) {
    return { kind: 'code-wanted', url: addressAfter(t, /Sign in at:/) }
  }
  if (/Opening browser to sign in/.test(t)) {
    return { kind: 'browser', url: addressAfter(t, /If the browser didn't open, visit:/), codeField: /Paste code here if prompted/.test(t) }
  }
  return t.trim() ? { kind: 'unknown' } : { kind: 'starting' }
}

// ── Codex ───────────────────────────────────────────────────────────────────────────────

/** A device code as Codex prints it: letters and digits, with dashes. */
const DEVICE_CODE = /^[A-Z0-9]{3,10}(?:-[A-Z0-9]{3,10}){0,3}$/i

function codexScreen(r: SignInRead): SignInScreen {
  const t = r.text
  const error = lastWords(t, /Error logging in(?: with device code)?: ([^\n]+)/)
  if (error) return { kind: 'error', message: error }
  if (/Successfully logged in/.test(t)) return { kind: 'done' }
  if (/Follow these steps to sign in with ChatGPT using device code authorization/.test(t)) {
    // The code is on its own row under "Enter this one-time code".
    const rows = t.split('\n')
    const at = rows.findIndex((row) => /Enter this one-time code/.test(row))
    const code = at < 0 ? undefined : rows.slice(at + 1).map((row) => row.trim()).find((row) => row !== '')
    if (code && DEVICE_CODE.test(code)) return { kind: 'device-code', code, url: addressAfter(t, /Open this link in your browser/) }
    return { kind: 'working' }
  }
  if (/If your browser did not open, navigate to this URL to authenticate/.test(t)) {
    return { kind: 'browser', url: addressAfter(t, /navigate to this URL to authenticate:/), codeField: false }
  }
  return t.trim() ? { kind: 'unknown' } : { kind: 'starting' }
}

// ── agy ─────────────────────────────────────────────────────────────────────────────────

/** agy's questions with options, by their heading row. */
const AGY_QUESTIONS = [
  /^\s*Select login method:\s*$/,
  /^\s*Select available license:\s*$/,
  /^\s*Select Google Cloud sign-in method:\s*$/,
  /^\s*Do you trust the contents of this project\?\s*$/,
]
/** An option row: "> " on the highlighted one, two spaces on the others. */
const AGY_OPTION = /^(>| ) (\S.*)$/
/** agy's key hint under its options. */
const AGY_HINT = /\benter Confirm\b/

const AGY_ERRORS = [
  /(Error: authentication interrupted\.)/,
  /(License Selection Failed)/,
  /License fetch failed: ([^\n]+)/,
  /Could not fetch licenses: ([^\n]+)/,
]

/** The question on agy's screen now: its heading, the text between it and the options, and the
 *  options, of which exactly one is highlighted. Null when the screen shows no such question, or
 *  shows one whose highlight can't be told: a choice is relayed only where Termpolis sees it. */
function agyQuestion(lines: readonly string[]): Extract<SignInScreen, { kind: 'choose' }> | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!AGY_QUESTIONS.some((re) => re.test(lines[i]))) continue
    const detail: string[] = []
    const options: string[] = []
    let selected = -1
    let highlighted = 0
    for (let j = i + 1; j < lines.length; j++) {
      const row = lines[j]
      if (AGY_HINT.test(row)) break
      const m = AGY_OPTION.exec(row)
      if (m) {
        if (m[1] === '>') {
          selected = options.length
          highlighted++
        }
        options.push(m[2].trim())
      } else if (row.trim() === '') {
        if (options.length > 0) break
      } else if (options.length === 0) {
        detail.push(row.trim())
      } else {
        break
      }
    }
    if (options.length === 0 || highlighted !== 1) return null
    return { kind: 'choose', question: lines[i].trim(), detail, options, selected }
  }
  return null
}

function agyScreen(r: SignInRead): SignInScreen {
  const lines = r.lines
  const shown = lines.join('\n')
  for (const re of AGY_ERRORS) {
    const words = lastWords(shown, re)
    if (words) return { kind: 'error', message: words }
  }
  const question = agyQuestion(lines)
  if (question) return question
  if (lines.some((row) => /\bproject id\.\.\./.test(row))) return { kind: 'text-wanted', label: 'Google Cloud project ID' }
  if (/Paste the authorization code below:|Enter the authorization code:/.test(shown)) {
    return { kind: 'code-wanted', url: addressAfter(r.text, /Open the following URL in your local browser to authenticate:/) }
  }
  if (/Or, paste the authorization code here and press Enter:|Open the following URL in your local browser to authenticate:/.test(shown)) {
    return {
      kind: 'browser',
      url: addressAfter(r.text, /Open the following URL in your local browser to authenticate:/) ?? lastAddress(r.text),
      codeField: /paste the authorization code/.test(shown),
    }
  }
  if (/Signing in\.\.\.|Fetching licenses\.\.\.|Assigning license\.\.\./.test(shown)) return { kind: 'working' }
  if (inputBoxRow(lines) >= 0 && !isBusyOnScreen(lines, r.title ?? '')) return { kind: 'agy-ready' }
  return shown.trim() ? { kind: 'unknown' } : { kind: 'starting' }
}

/** The last https address in `text`, or null. */
function lastAddress(text: string): string | null {
  let found: string | null = null
  for (const m of text.matchAll(ADDRESS)) if (m[0].startsWith('https://')) found = m[0]
  return found
}

/** agy's own words that its sign-in finished (agy-signin.md): its input box comes back after them. */
export const AGY_SIGNED_IN_WORDS = /Authentication successful!|Successfully authenticated\./

/** What `agent`'s sign-in shows now. */
export function readSignInScreen(agent: AccountAgent, r: SignInRead): SignInScreen {
  if (agent === 'claude') return claudeScreen(r)
  if (agent === 'codex') return codexScreen(r)
  return agyScreen(r)
}
