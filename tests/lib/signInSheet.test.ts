import { describe, it, expect } from 'vitest'
import { SIGN_IN_METHODS, announce, keysFor, resignWarning, successWarnings } from '../../src/renderer/src/lib/signInSheet'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { SignInPhase } from '../../src/shared/signInScreens'

function row(over: Partial<AccountRowView> = {}): AccountRowView {
  return {
    id: 'acc_b', agent: 'claude', label: 'codedev', email: 'b@example.test', profile: '/h/.claude-codedev', folder: '/h/.claude-codedev',
    isDefault: false, autoOffer: true, order: 1, connect: true, origin: 'created', folderExists: true, shares: [], lastEmail: null,
    connection: null, bypassReady: true, terminals: 0, recopyAvailable: false, ...over,
  }
}

function view(accounts: AccountRowView[]): AccountsView {
  return { accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h' }
}

describe('SIGN_IN_METHODS', () => {
  it('offers each agent its own CLI\'s methods, the default first', () => {
    expect(SIGN_IN_METHODS.claude.map((m) => m.id)).toEqual(['claudeai', 'console', 'sso'])
    expect(SIGN_IN_METHODS.claude.map((m) => m.label)).toEqual(['Claude subscription', 'Anthropic Console', 'SSO'])
    expect(SIGN_IN_METHODS.codex.map((m) => [m.id, m.label])).toEqual([['browser', 'ChatGPT account'], ['device', 'Sign in with a code']])
  })
})

describe('resignWarning (R29)', () => {
  it('says nothing for a profile with no sign-in and no terminal on it', () => {
    expect(resignWarning(row())).toBeNull()
  })

  it('warns of every session on the profile, outside Termpolis too, once it had a sign-in', () => {
    const w = resignWarning(row({ lastEmail: 'b@example.test' }))!
    expect(w).toContain('replaces codedev\'s sign-in for every Claude Code session that uses this profile, outside Termpolis too, including scheduled jobs')
    expect(w).not.toContain('Close the')
    expect(resignWarning(row({ identity: { email: 'b@example.test', signedIn: true, checkedAt: 1, source: 'auth-status' } }))).not.toBeNull()
  })

  it('names the Termpolis terminals on it', () => {
    expect(resignWarning(row({ terminals: 1 }))).toContain('Close the 1 Termpolis terminal on codedev first.')
    expect(resignWarning(row({ terminals: 3, agent: 'codex' }))).toContain('every Codex session')
    expect(resignWarning(row({ terminals: 3 }))).toContain('Close the 3 Termpolis terminals on codedev first.')
  })
})

describe('successWarnings (R20, R21, R23)', () => {
  const main = row({ id: 'acc_a', label: 'personal', email: 'a@example.test', lastEmail: 'a@example.test' })
  const work = row({ id: 'acc_w', label: 'work', email: 'w@corp.test', autoOffer: false })

  it('says nothing for the account\'s own email, or none', () => {
    expect(successWarnings(view([main, row()]), row(), 'B@example.test')).toEqual([])
    expect(successWarnings(view([main, row()]), row(), null)).toEqual([])
    expect(successWarnings(view([main, row({ email: undefined })]), row({ email: undefined }), 'z@example.test')).toEqual([])
  })

  it('says when another account has that sign-in, and when it is the work account\'s', () => {
    expect(successWarnings(view([main, row()]), row(), 'a@example.test')).toEqual([
      'a@example.test is personal\'s sign-in too: switching between codedev and personal changes nothing.',
      'codedev should sign in as b@example.test; it\'s signed in as a@example.test.',
    ])
    expect(successWarnings(view([work, row()]), row(), 'w@corp.test')[0]).toBe('w@corp.test is work\'s sign-in, and work isn\'t offered automatically.')
    // By what the other profile last named, too; never another agent's account.
    const other = row({ id: 'acc_x', label: 'x', email: undefined, lastEmail: 'q@example.test' })
    expect(successWarnings(view([other, row()]), row({ email: undefined }), 'q@example.test')).toHaveLength(1)
    const codex = row({ id: 'acc_c', agent: 'codex', email: 'q@example.test' })
    expect(successWarnings(view([codex, row()]), row({ email: undefined }), 'q@example.test')).toEqual([])
  })
})

describe('announce', () => {
  it('says each step in words', () => {
    const cases: Array<[SignInPhase, string]> = [
      [{ kind: 'starting' }, 'Starting Claude Code\'s sign-in.'],
      [{ kind: 'browser', url: null, canOpen: false, codeField: false }, 'Finish signing in in your browser.'],
      [{ kind: 'code-wanted', url: null, canOpen: false }, 'Sign in in your browser, then paste the code the page shows.'],
      [{ kind: 'device-code', code: 'AB-12', url: null, canOpen: false }, 'Enter the code AB-12 in your browser.'],
      [{ kind: 'choose', question: 'Select login method:', detail: [], options: ['a', 'b'], selected: 0 }, 'Select login method: 2 choices.'],
      [{ kind: 'text-wanted', label: 'Google Cloud project ID' }, 'Google Cloud project ID'],
      [{ kind: 'signing-out' }, 'Signing agy out.'],
      [{ kind: 'working' }, 'Working on it.'],
      [{ kind: 'confirming' }, 'Checking the sign-in.'],
      [{ kind: 'success', email: 'b@example.test' }, 'Signed in as b@example.test.'],
      [{ kind: 'success', email: null }, 'Signed in.'],
      [{ kind: 'error', message: 'nope', details: [] }, 'Claude Code didn\'t sign in: nope'],
      [{ kind: 'unknown', screen: [], typing: false }, 'Termpolis can\'t read Claude Code\'s screen, so it shows it as it is.'],
      [{ kind: 'cancelled' }, 'The sign-in was cancelled.'],
    ]
    for (const [phase, words] of cases) expect(announce(phase, 'claude')).toBe(words)
  })
})

describe('keysFor: the live view\'s keys', () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => keysFor({ key, ctrlKey: false, altKey: false, metaKey: false, ...mods })
  it('passes printable keys, named keys and Ctrl+letters, and nothing else', () => {
    expect(k('a')).toBe('a')
    expect(k('Enter')).toBe('\r')
    expect(k('ArrowDown')).toBe('\x1b[B')
    expect(k('Backspace')).toBe('\x7f')
    expect(k('c', { ctrlKey: true })).toBe('\x03')
    expect(k('C', { ctrlKey: true })).toBe('\x03')
    expect(k('1', { ctrlKey: true })).toBeNull()
    expect(k('Tab')).toBeNull()
    expect(k('Shift')).toBeNull()
    expect(k('a', { altKey: true })).toBeNull()
    expect(k('v', { metaKey: true })).toBeNull()
  })
})
