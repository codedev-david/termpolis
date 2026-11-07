// The sign-in screen parser (src/shared/signInScreens.ts): what each CLI's own sign-in shows, from
// real Claude Code captures and from Codex's and agy's program-file strings
// (tests/fixtures/signInScreens.json says which is which).
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { SIGN_IN_PAGES, isSignInPage, readSignInScreen, signInText } from '../../src/shared/signInScreens'
import type { SignInScreen } from '../../src/shared/signInScreens'
import { screenOf } from '../../src/shared/terminalScreen'
import type { AccountAgent } from '../../src/shared/agentAccounts'

const F = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'signInScreens.json'), 'utf8')) as Record<string, Record<string, string>>

/** The screen the output draws, as the session reads it. */
function read(agent: AccountAgent, raw: string, cols = 120): SignInScreen {
  const screen = screenOf(raw, { cols, rows: 40 })
  return readSignInScreen(agent, { lines: screen.lines(), text: signInText(raw), title: screen.title })
}

describe('Claude Code: `claude auth login`, real captures', () => {
  it('reads the browser step, its address and its code field, for each method', () => {
    for (const [method, host] of [['claudeai', 'https://claude.com/cai/oauth/authorize?'], ['console', 'https://platform.claude.com/oauth/authorize?'], ['sso', 'https://claude.com/cai/oauth/authorize?']]) {
      const s = read('claude', F.claude[method])
      expect(s.kind).toBe('browser')
      const b = s as Extract<SignInScreen, { kind: 'browser' }>
      expect(b.codeField).toBe(true)
      expect(b.url!.startsWith(host)).toBe(true)
      // The address printed, whole: the screen wraps it, the text doesn't.
      expect(b.url).toContain('code_challenge_method=S256')
      expect(isSignInPage('claude', b.url!)).toBe(true)
    }
    expect((read('claude', F.claude.claudeai) as { url: string }).url).toContain('login_hint=probe%40example.test')
    expect((read('claude', F.claude.sso) as { url: string }).url).toContain('login_method=sso')
  })

  it('reads the address the same at any width', () => {
    const wide = read('claude', F.claude.console, 200) as { url: string }
    const narrow = read('claude', F.claude.console, 60) as { url: string }
    expect(narrow.url).toBe(wide.url)
  })

  it('reads the no-callback step as a code to paste', () => {
    const raw = "The browser can't return the sign-in to Claude Code automatically. After you sign in, paste the code shown.\r\nSign in at: https://claude.com/cai/oauth/authorize?code=true&state=x\r\nPaste code here > "
    expect(read('claude', raw)).toEqual({ kind: 'code-wanted', url: 'https://claude.com/cai/oauth/authorize?code=true&state=x' })
  })

  it('reads its success and its failures in its own words', () => {
    expect(read('claude', F.claude.claudeai + '\r\nLogin successful\r\n').kind).toBe('done')
    expect(read('claude', F.claude.claudeai + '\r\nOAuth login failed: Invalid code. Please make sure the full code was copied. Run with --debug for the underlying error\r\n'))
      .toEqual({ kind: 'error', message: 'Invalid code. Please make sure the full code was copied.' })
    expect(read('claude', 'Login failed: the token request timed out\r\n')).toEqual({ kind: 'error', message: 'the token request timed out' })
    expect(read('claude', 'Invalid code. Please make sure the full code was copied.\r\n')).toEqual({ kind: 'error', message: 'Invalid code. Please make sure the full code was copied.' })
    expect(read('claude', 'Login interrupted\r\n')).toEqual({ kind: 'error', message: 'Login interrupted' })
    // A failure after a success line: the failure.
    expect(read('claude', 'Login successful\r\nLogin failed: storing it failed\r\n')).toEqual({ kind: 'error', message: 'storing it failed' })
  })

  it('is starting with nothing printed, and unknown with something else', () => {
    expect(read('claude', '')).toEqual({ kind: 'starting' })
    expect(read('claude', '\x1b[?25l\x1b[2J\x1b[H')).toEqual({ kind: 'starting' })
    expect(read('claude', 'Something new from Claude Code\r\n')).toEqual({ kind: 'unknown' })
  })

  it('takes no address from before its own words', () => {
    expect(read('claude', 'Opening browser to sign in…\r\n')).toEqual({ kind: 'browser', url: null, codeField: false })
  })
})

describe('Codex: `codex login`, from its program file', () => {
  it('reads the browser step, never its own localhost server as the page', () => {
    const s = read('codex', F.codex.browser) as Extract<SignInScreen, { kind: 'browser' }>
    expect(s.kind).toBe('browser')
    expect(s.codeField).toBe(false)
    expect(s.url!.startsWith('https://auth.openai.com/oauth/authorize?')).toBe(true)
    expect(isSignInPage('codex', s.url!)).toBe(true)
  })

  it('reads the device code and the address to enter it at', () => {
    expect(read('codex', F.codex.device)).toEqual({ kind: 'device-code', code: 'ABCD-EFGH', url: 'https://auth.openai.com/codex/device' })
  })

  it('reads the device code off the rows drawn, however ConPTY moves between them', () => {
    // ConPTY repaints with cursor moves where the CLI wrote blank lines: with the escapes out, the
    // text runs the rows together. The screen draws them where they go.
    const rows = F.codex.device.split('\r\n')
    const conpty = rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join('')
    expect(read('codex', conpty)).toEqual({ kind: 'device-code', code: 'ABCD-EFGH', url: 'https://auth.openai.com/codex/device' })
  })

  it('waits while the code is still coming', () => {
    expect(read('codex', F.codex.device.slice(0, F.codex.device.indexOf('2. Enter'))).kind).toBe('working')
    const head = F.codex.device.slice(0, F.codex.device.indexOf('ABCD'))
    expect(read('codex', head).kind).toBe('working')
    expect(read('codex', head + '   not a code at all\r\n').kind).toBe('working')
  })

  it('reads its success and its failures', () => {
    expect(read('codex', F.codex.browser + F.codex.browserDone).kind).toBe('done')
    expect(read('codex', F.codex.browser + F.codex.browserError)).toEqual({ kind: 'error', message: 'Login was not completed' })
    expect(read('codex', F.codex.device + F.codex.deviceError)).toEqual({ kind: 'error', message: 'device auth timed out after 15 minutes' })
  })

  it('has no page while only its localhost server is printed', () => {
    const raw = 'If your browser did not open, navigate to this URL to authenticate:\r\n\r\nhttp://localhost:1455/start\r\n'
    expect(read('codex', raw)).toEqual({ kind: 'browser', url: null, codeField: false })
  })

  it('is starting with nothing, and unknown with anything else', () => {
    expect(read('codex', '')).toEqual({ kind: 'starting' })
    expect(read('codex', 'WARNING: something\r\n')).toEqual({ kind: 'unknown' })
  })
})

describe('agy: its sign-in screens', () => {
  it('reads a question with its options and the highlighted one', () => {
    expect(read('agy', F.agy.signedOut, 80)).toEqual({
      kind: 'choose', question: 'Select login method:', detail: [],
      options: ['Continue with Google', 'Use a Google Cloud project', 'Other sign-in options'], selected: 0,
    })
    expect((read('agy', F.agy.signedOutSecond, 80) as { selected: number }).selected).toBe(1)
    expect((read('agy', F.agy.license, 80) as { question: string }).question).toBe('Select available license:')
    expect((read('agy', F.agy.gcpMethod, 80) as { options: string[] }).options).toEqual(['Continue with Google Cloud', 'Continue with Advanced SSO'])
  })

  it('reads its trust question, with the text between it and the options', () => {
    expect(read('agy', F.agy.trust, 80)).toEqual({
      kind: 'choose', question: 'Do you trust the contents of this project?',
      detail: ['Antigravity CLI requires permission to read, edit, and execute files here.'],
      options: ['Yes, I trust this folder', 'No, exit'], selected: 0,
    })
  })

  it('reads the real trust menu agy 1.4.0 drew', () => {
    const real = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'agentScreens.json'), 'utf8')).agy.trust as string
    const s = read('agy', real, 80) as Extract<SignInScreen, { kind: 'choose' }>
    expect(s.kind).toBe('choose')
    expect(s.options).toEqual(['Yes, I trust this folder', 'No, exit'])
    expect(s.selected).toBe(0)
  })

  it('relays no choice whose highlight it can\'t see', () => {
    expect(read('agy', F.agy.noHighlight, 80).kind).toBe('unknown')
    // Two highlighted rows: the same.
    expect(read('agy', '\x1b[2J\x1b[HSelect login method:\r\n\r\n> One\r\n> Two\r\n\r\n  ↑/↓ Navigate · enter Confirm\r\n', 80).kind).toBe('unknown')
  })

  it('reads a project to type, a code to paste, and the browser step', () => {
    expect(read('agy', F.agy.project, 80)).toEqual({ kind: 'text-wanted', label: 'Google Cloud project ID' })
    expect(read('agy', F.agy.paste, 80)).toEqual({ kind: 'browser', url: null, codeField: true })
    const gcp = read('agy', F.agy.gcpUrl, 80) as Extract<SignInScreen, { kind: 'browser' }>
    expect(gcp.kind).toBe('browser')
    expect(gcp.codeField).toBe(true)
    expect(isSignInPage('agy', gcp.url!)).toBe(true)
    expect(read('agy', F.agy.pasteBelow, 80)).toEqual({ kind: 'code-wanted', url: null })
  })

  it('reads its work, its box and its failures', () => {
    expect(read('agy', F.agy.signingIn, 80)).toEqual({ kind: 'working' })
    expect(read('agy', F.agy.ready, 80)).toEqual({ kind: 'agy-ready' })
    expect(read('agy', F.agy.signedInAs, 80)).toEqual({ kind: 'agy-ready' })
    // agy at work (a real capture: its spinner over the box) is no box to type into.
    const busy = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'agentScreens.json'), 'utf8')).agy.busy as string
    expect(read('agy', busy, 80).kind).not.toBe('agy-ready')
    expect(read('agy', F.agy.interrupted, 80)).toEqual({ kind: 'error', message: 'Error: authentication interrupted.' })
    expect(read('agy', F.agy.licenseFailed, 80)).toEqual({ kind: 'error', message: 'License Selection Failed' })
    expect(read('agy', '\x1b[2J\x1b[HLicense fetch failed: denied\r\n', 80)).toEqual({ kind: 'error', message: 'denied' })
    expect(read('agy', '\x1b[2J\x1b[HCould not fetch licenses: offline\r\n', 80)).toEqual({ kind: 'error', message: 'offline' })
  })

  it('is starting on a blank screen, and unknown on anything else', () => {
    expect(read('agy', '\x1b[2J\x1b[H', 80)).toEqual({ kind: 'starting' })
    expect(read('agy', '\x1b[2J\x1b[HA screen agy never drew\r\n', 80)).toEqual({ kind: 'unknown' })
  })

  it('stops at its key hint, which reads like an option row', () => {
    const raw = '\x1b[2J\x1b[HSelect login method:\r\n\r\n> Continue with Google\r\n  Other sign-in options\r\n  ↑/↓ Navigate · enter Confirm\r\n'
    expect((read('agy', raw, 80) as { options: string[] }).options).toEqual(['Continue with Google', 'Other sign-in options'])
  })

  it('takes the last page address printed when no heading names it', () => {
    const raw = 'see http://localhost:1/x and https://accounts.google.com/o/oauth2/auth?a=1\r\n' + F.agy.paste
    expect(read('agy', raw, 80)).toEqual({ kind: 'browser', url: 'https://accounts.google.com/o/oauth2/auth?a=1', codeField: true })
  })

  it("reads agy's box with no title to go on", () => {
    const screen = screenOf(F.agy.ready, { cols: 80, rows: 40 })
    expect(readSignInScreen('agy', { lines: screen.lines(), text: signInText(F.agy.ready) })).toEqual({ kind: 'agy-ready' })
  })

  it('ends a question at a row that is no option', () => {
    const raw = '\x1b[2J\x1b[HSelect login method:\r\n\r\n> Continue with Google\r\nA footer row\r\n  Not an option of it\r\n'
    expect(read('agy', raw, 80)).toEqual({ kind: 'choose', question: 'Select login method:', detail: [], options: ['Continue with Google'], selected: 0 })
  })
})

describe('isSignInPage and the raw address main hands to the browser (UI-R1-I)', () => {
  const page = SIGN_IN_PAGES.claude[0]
  const ok = `https://${page.host}${page.path}`

  it('refuses an address with a space, a tab, a line break or any control character that the URL parser would have dropped', () => {
    expect(isSignInPage('claude', ok)).toBe(true)
    for (const bad of [`${ok}\n`, `${ok}\t`, `${ok} `, `${ok}\r`, `${ok}\u0000`, `${ok}\u007f`, `${ok}?next=a b`, `https:/\t/${page.host}${page.path}`, ` ${ok}`]) {
      expect(isSignInPage('claude', bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('refuses one longer than 4096 characters, and a value that is no string', () => {
    expect(isSignInPage('claude', `${ok}?${'a'.repeat(4000)}`)).toBe(true)
    expect(isSignInPage('claude', `${ok}?${'a'.repeat(4096)}`)).toBe(false)
    expect(isSignInPage('claude', 42 as never)).toBe(false)
    expect(isSignInPage('claude', undefined as never)).toBe(false)
  })
})

describe('isSignInPage: the provider pages Termpolis opens, and nothing else', () => {
  it('takes each agent\'s own pages', () => {
    expect(isSignInPage('claude', 'https://claude.com/cai/oauth/authorize?x=1')).toBe(true)
    expect(isSignInPage('claude', 'https://platform.claude.com/oauth/authorize')).toBe(true)
    expect(isSignInPage('codex', 'https://auth.openai.com/codex/device')).toBe(true)
    expect(isSignInPage('codex', 'https://auth.openai.com/codex/device/next')).toBe(true)
    expect(isSignInPage('agy', 'https://accounts.google.com/o/oauth2/auth?a=b')).toBe(true)
  })

  it('refuses everything else', () => {
    const no = [
      'http://claude.com/cai/oauth/authorize', // not https
      'https://evil.claude.com/cai/oauth/authorize', // another host
      'https://claude.com.evil.test/cai/oauth/authorize',
      'https://claude.com/cai/oauth/authorizeX', // another page
      'https://claude.com/login',
      'https://user:pw@claude.com/cai/oauth/authorize', // credentials in it
      'https://claude.com:8443/cai/oauth/authorize', // a port
      'https://claude.com/cai/oauth/authorize\nx', // a control character
      'https://claude.com/cai/oauth/authorize x',
      'not a url',
      'https//no-scheme', // no address at all
      'https://' + 'a'.repeat(4100),
      'https://auth.openai.com/oauth/authorize', // Codex's page, for Claude
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
    ]
    for (const url of no) expect(isSignInPage('claude', url), url).toBe(false)
    expect(isSignInPage('codex', 'http://localhost:1455/auth/callback')).toBe(false)
    expect(isSignInPage('agy', 'https://accounts.google.com/signin')).toBe(false)
    expect(isSignInPage('claude', 42 as unknown as string)).toBe(false)
  })
})
