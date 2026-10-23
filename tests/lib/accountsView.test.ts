import { describe, it, expect } from 'vitest'
import type { AccountRowView } from '../../src/shared/agentAccounts'
import {
  accountBadge, accountsOf, agentOfCommand, agentOfName, folderLine, hasAccounts, signInShell,
} from '../../src/renderer/src/lib/accountsView'

const HOME = 'C:\\Users\\me'

function row(over: Partial<AccountRowView> = {}): AccountRowView {
  return {
    id: 'acc_000000000001', agent: 'claude', label: 'codedev', profile: `${HOME}\\.claude-codedev`, folder: `${HOME}\\.claude-codedev`,
    isDefault: false, autoOffer: true, order: 1, connect: true, origin: 'created', folderExists: true, shares: [],
    lastEmail: null, connection: { server: true, hook: true, allow: true }, bypassReady: true, terminals: 0, recopyAvailable: false,
    ...over,
  }
}

describe('accountsOf and hasAccounts', () => {
  it('keeps one agent\'s rows, in the order main sent them', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', agent: 'codex' }), row({ id: 'c' })]
    expect(accountsOf(rows, 'claude').map((r) => r.id)).toEqual(['a', 'c'])
    expect(accountsOf(rows, 'agy')).toEqual([])
  })

  it('says whether any account is registered at all (D13: none, no change)', () => {
    expect(hasAccounts([])).toBe(false)
    expect(hasAccounts([row()])).toBe(true)
  })
})

describe('accountBadge: the row\'s state, worst first', () => {
  const now = 1_000_000

  it('says the profile folder is missing before anything else', () => {
    expect(accountBadge(row({ folderExists: false }), now)).toEqual({ text: 'folder missing', tone: 'bad' })
  })

  it('names a recorded limit with its reset, or the hook\'s marker, before the sign-in', () => {
    const reset = new Date(2026, 9, 19, 15, 0).getTime()
    const limited = accountBadge(row({ limit: { seenAt: now, resetsAt: reset, text: 'x', scope: 'account' } }), now)
    expect(limited.tone).toBe('warn')
    expect(limited.text).toMatch(/^out of usage · resets /)
    expect(accountBadge(row({ limit: { seenAt: now, resetsAt: null, text: 'x', scope: 'account' } }), now)).toEqual({ text: 'out of usage', tone: 'warn' })
    // A limit on one model leaves the account eligible: it is said, not counted as out.
    expect(accountBadge(row({ limit: { seenAt: now, resetsAt: null, text: 'You\'ve hit your Opus limit', scope: 'model' } }), now)).toEqual({ text: 'a model is out of usage', tone: 'warn' })
    expect(accountBadge(row({ limitedOutside: now - 1000 }), now)).toEqual({ text: 'out of usage (seen by your failover hook)', tone: 'warn' })
  })

  it('warns when the profile is signed in to another email than the account\'s own', () => {
    expect(accountBadge(row({ email: 'b@example.test', lastEmail: 'a@example.test' }), now))
      .toEqual({ text: 'signed in to a@example.test instead!', tone: 'bad' })
    // Case doesn't make another account.
    expect(accountBadge(row({ email: 'B@Example.test', lastEmail: 'b@example.test' }), now).tone).not.toBe('bad')
  })

  it('reads the last check first, then "last signed in as", then signed out', () => {
    const checked = { email: 'b@example.test', signedIn: true, checkedAt: 5, source: 'auth-status' as const }
    expect(accountBadge(row({ identity: checked }), now)).toEqual({ text: 'signed in as b@example.test', tone: 'good' })
    expect(accountBadge(row({ identity: { ...checked, email: null } }), now)).toEqual({ text: 'signed in', tone: 'good' })
    expect(accountBadge(row({ identity: { ...checked, signedIn: false } }), now)).toEqual({ text: 'signed out', tone: 'muted' })
    // A check that couldn't tell falls back to the email the profile names.
    expect(accountBadge(row({ identity: { ...checked, signedIn: null }, lastEmail: 'b@example.test' }), now)).toEqual({ text: 'last signed in as b@example.test', tone: 'muted' })
    expect(accountBadge(row({ lastEmail: 'b@example.test' }), now)).toEqual({ text: 'last signed in as b@example.test', tone: 'muted' })
    expect(accountBadge(row(), now)).toEqual({ text: 'signed out', tone: 'muted' })
  })

  it('compares the check\'s email with the account\'s too', () => {
    const checked = { email: 'c@example.test', signedIn: true, checkedAt: 5, source: 'auth-status' as const }
    expect(accountBadge(row({ email: 'b@example.test', identity: checked }), now)).toEqual({ text: 'signed in to c@example.test instead!', tone: 'bad' })
  })

  it('shows an agy label by its email alone: agy draws who is signed in on its own screen', () => {
    expect(accountBadge(row({ agent: 'agy', profile: null, folder: null, folderExists: false, email: 'g@example.test' }), now))
      .toEqual({ text: 'g@example.test', tone: 'muted' })
    expect(accountBadge(row({ agent: 'agy', profile: null, folder: null, folderExists: false }), now))
      .toEqual({ text: 'no email given', tone: 'muted' })
  })
})

describe('folderLine', () => {
  it('shows the folder with the home folder as ~, and says which is the main profile', () => {
    expect(folderLine(row(), HOME)).toBe('~\\.claude-codedev')
    expect(folderLine(row({ isDefault: true, profile: null, folder: `${HOME}\\.claude` }), HOME)).toBe('~\\.claude (main profile)')
    expect(folderLine(row({ folder: null }), HOME)).toBe('')
    expect(folderLine(row({ folder: 'D:\\profiles\\x' }), HOME)).toBe('D:\\profiles\\x')
  })
})

describe("agentOfName: which account agent a swarm worker's name says it runs", () => {
  it('reads Claude, Codex, and Gemini as agy, which Termpolis runs for it', () => {
    expect(agentOfName('Claude')).toBe('claude')
    expect(agentOfName('Claude Code')).toBe('claude')
    expect(agentOfName('Codex')).toBe('codex')
    expect(agentOfName('Gemini')).toBe('agy')
    expect(agentOfName('Antigravity CLI')).toBe('agy')
    expect(agentOfName('agy')).toBe('agy')
    expect(agentOfName('Legacy')).toBeNull()
    expect(agentOfName('Stagy')).toBeNull()
  })
})

describe('agentOfCommand: which account agent a terminal runs', () => {
  it('maps a launch command to its agent, and anything else to none', () => {
    expect(agentOfCommand('claude --model opus')).toBe('claude')
    expect(agentOfCommand('codex')).toBe('codex')
    expect(agentOfCommand('agy')).toBe('agy')
    expect(agentOfCommand('gemini')).toBe(null)
    expect(agentOfCommand('npm test')).toBe(null)
    expect(agentOfCommand(undefined)).toBe(null)
  })
})

describe('signInShell: the shell a sign-in terminal opens in', () => {
  it('takes the user\'s default shell when Termpolis can type an account line into it', () => {
    expect(signInShell('powershell', ['powershell', 'cmd'])).toBe('powershell')
    expect(signInShell('gitbash', ['gitbash', 'powershell'])).toBe('gitbash')
    expect(signInShell('zsh', ['zsh'])).toBe('zsh')
  })

  it('falls back to another installed shell, PowerShell first, and to none', () => {
    // The default shell isn't installed any more (a saved setting from another machine).
    expect(signInShell('zsh', ['cmd', 'powershell'])).toBe('powershell')
    expect(signInShell('gitbash', ['bash'])).toBe('bash')
    expect(signInShell('powershell', ['cmd'])).toBe('cmd')
    expect(signInShell('powershell', [])).toBe(null)
  })
})
