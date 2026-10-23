// The account chip's words (src/renderer/src/lib/accountChip.ts, §6.4): hidden with one account and
// nothing wrong (D13), the account's label in its colour, and red with "?" for a change by hand,
// for a removed account, or for a profile signed in to another email.
import { describe, it, expect } from 'vitest'
import { accountChipFor, signedInElsewhere, signedInEmail } from '../../src/renderer/src/lib/accountChip'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/home/me/.claude', isDefault: true, autoOffer: true,
    order: 0, connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: null, connection: null, bypassReady: false,
    terminals: 0, recopyAvailable: false, ...over,
  }
}

function view(accounts: AccountRowView[]): AccountsView {
  return {
    accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
    advice: { stopFailureHooks: [], authOverrides: [] }, home: '/home/me',
  }
}

const a = row({ id: 'acc_a', label: 'personal', email: 'a@example.test', lastEmail: 'a@example.test' })
const b = row({ id: 'acc_b', label: 'codedev', profile: '/home/me/.claude-codedev', folder: '/home/me/.claude-codedev', isDefault: false, color: '#123456', email: 'b@example.test', lastEmail: 'b@example.test', order: 1 })
const two = view([a, b])

describe('accountChipFor', () => {
  it('shows nothing for a terminal that isn\'t an account agent\'s, the conductor\'s, or with no view', () => {
    expect(accountChipFor(undefined, two, false)).toBeNull()
    expect(accountChipFor({ agentCommand: 'aider' }, two, false)).toBeNull()
    expect(accountChipFor({ agentCommand: 'claude', isConductor: true, agentAccountId: 'acc_a' }, two, false)).toBeNull()
    expect(accountChipFor({ agentCommand: 'claude' }, null, false)).toBeNull()
    expect(accountChipFor({ agentCommand: 'codex' }, two, false)).toBeNull()
  })

  it('shows nothing with one account and nothing wrong (D13)', () => {
    expect(accountChipFor({ agentCommand: 'claude', agentAccountId: 'acc_a' }, view([a]), false)).toBeNull()
    expect(accountChipFor({ agentCommand: 'claude' }, view([a]), false)).toBeNull()
  })

  it('names the account in its colour, with who it last signed in as and its folder', () => {
    expect(accountChipFor({ agentCommand: 'claude --model opus', agentAccountId: 'acc_b' }, two, false)).toEqual({
      agent: 'claude', label: 'codedev', color: '#123456', alert: false, account: b,
      title: 'Claude Code on codedev, last signed in as b@example.test, profile ~/.claude-codedev. Click to switch.',
    })
    // An account with no colour has its agent's.
    expect(accountChipFor({ agentCommand: 'claude', agentAccountId: 'acc_a' }, two, false)?.color).toBe('#D97706')
  })

  it('says "?" in red when the account was changed by hand', () => {
    const chip = accountChipFor({ agentCommand: 'claude', agentAccountId: 'acc_b' }, two, true)!
    expect(chip).toEqual(expect.objectContaining({ label: '?', alert: true }))
    expect(chip.title).toMatch(/changed by hand/)
  })

  it('says "removed account" in red for an account no longer registered, even as the only one', () => {
    expect(accountChipFor({ agentCommand: 'claude', agentAccountId: 'acc_gone' }, view([a]), false)).toEqual(expect.objectContaining({ label: 'removed account', alert: true }))
  })

  it('says "default?" for a terminal with no record once the agent has two accounts', () => {
    expect(accountChipFor({ agentCommand: 'claude' }, two, false)).toEqual(expect.objectContaining({ label: 'default?', alert: false }))
  })

  it('turns red when the profile is signed in to another email, even with one account', () => {
    const drifted = row({ ...a, lastEmail: 'other@example.test' })
    const chip = accountChipFor({ agentCommand: 'claude', agentAccountId: 'acc_a' }, view([drifted]), false)!
    expect(chip.alert).toBe(true)
    expect(chip.title).toBe('Claude Code on personal, but its profile is signed in to other@example.test, not a@example.test, profile ~/.claude. Click to switch.')
  })

  it('names an agy account by its email, with no folder, and an account it knows no email of by none', () => {
    const g1 = row({ id: 'g1', agent: 'agy', label: 'home', profile: null, folder: null, isDefault: false, email: 'h@example.test' })
    const g2 = row({ id: 'g2', agent: 'agy', label: 'work', profile: null, folder: null, isDefault: false })
    expect(accountChipFor({ agentCommand: 'agy', agentAccountId: 'g1' }, view([g1, g2]), false)?.title).toBe('Gemini / Antigravity CLI on home, h@example.test. Click to switch.')
    expect(accountChipFor({ agentCommand: 'agy', agentAccountId: 'g2' }, view([g1, g2]), false)?.title).toBe('Gemini / Antigravity CLI on work. Click to switch.')
    // A profile account with no email known and no folder shown.
    const c = row({ id: 'c', agent: 'codex', label: 'c', folder: null, lastEmail: null })
    const d = row({ id: 'd', agent: 'codex', label: 'd', folder: null })
    expect(accountChipFor({ agentCommand: 'codex', agentAccountId: 'c' }, view([c, d]), false)?.title).toBe('Codex on c. Click to switch.')
  })
})

describe('signedInEmail and signedInElsewhere', () => {
  it('prefers the agent\'s own last check over the profile\'s config', () => {
    expect(signedInEmail(row({ lastEmail: 'x@e.test' }))).toBe('x@e.test')
    expect(signedInEmail(row({ lastEmail: 'x@e.test', identity: { email: 'y@e.test', signedIn: true, checkedAt: 1, source: 'auth-status' } }))).toBe('y@e.test')
    expect(signedInEmail(row({ lastEmail: 'x@e.test', identity: { email: 'y@e.test', signedIn: false, checkedAt: 1, source: 'auth-status' } }))).toBeNull()
    expect(signedInEmail(row({ lastEmail: 'x@e.test', identity: { email: null, signedIn: null, checkedAt: 1, source: 'auth-status' } }))).toBe('x@e.test')
  })

  it('compares emails ignoring case, and only when both are known', () => {
    expect(signedInElsewhere(row({ email: 'A@Example.Test', lastEmail: 'a@example.test' }))).toBeNull()
    expect(signedInElsewhere(row({ email: 'a@example.test', lastEmail: 'b@example.test' }))).toBe('b@example.test')
    expect(signedInElsewhere(row({ lastEmail: 'b@example.test' }))).toBeNull()
    expect(signedInElsewhere(row({ email: 'a@example.test' }))).toBeNull()
  })
})
