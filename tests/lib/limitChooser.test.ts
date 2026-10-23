// The switch dialog's words in limit mode (src/renderer/src/lib/limitChooser.ts, §8.4): the account
// that ran out and the sign-in it actually has (R23), what is left when nothing is a way out, the
// other terminals the same limit stopped, and the agents "Use another agent" offers.
import { describe, it, expect } from 'vitest'
import { AGENT_COMMAND, groupNote, limitOn, limitedAccount, noWayOut, otherAgents } from '../../src/renderer/src/lib/limitChooser'
import type { LimitContext } from '../../src/renderer/src/lib/limitWatch'
import type { LimitTarget } from '../../src/shared/accountLimits'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true,
    order: 0, connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: null, connection: null, bypassReady: false,
    terminals: 0, recopyAvailable: false, ...over,
  }
}
const view = (accounts: AccountRowView[]): AccountsView => ({
  accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
  advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h',
})
const ctx = (over: Partial<LimitContext> = {}): LimitContext => ({
  agent: 'claude', accountId: 'acc_a', terminals: ['t1'], words: 'w', resetsAt: null, kind: { scope: 'account', window: 'session' }, ...over,
})

describe('limitedAccount', () => {
  it("reads a profile's sign-in from what it last named, agy's from the email it was given", () => {
    expect(limitedAccount(view([row({ lastEmail: 'x@example.test' })]), ctx()).email).toBe('x@example.test')
    expect(limitedAccount(view([row({})]), ctx()).email).toBeNull()
    const g = row({ id: 'g', agent: 'agy', email: 'g@example.test' })
    expect(limitedAccount(view([g]), ctx({ agent: 'agy', accountId: 'g' })).email).toBe('g@example.test')
    expect(limitedAccount(view([row({ id: 'g', agent: 'agy' })]), ctx({ agent: 'agy', accountId: 'g' })).email).toBeNull()
    expect(limitedAccount(view([]), ctx())).toEqual({ row: undefined, email: null })
    expect(limitedAccount(view([row({})]), ctx({ accountId: null }))).toEqual({ row: undefined, email: null })
  })
})

describe('limitOn', () => {
  it('names the account, and the sign-in it has when that is not its own (R23)', () => {
    expect(limitOn(view([row({ email: 'a@example.test', lastEmail: 'a@example.test' })]), ctx(), false)).toBe('on personal (a@example.test)')
    expect(limitOn(view([row({ email: 'a@example.test', lastEmail: 'B@example.test' })]), ctx(), false)).toBe('on personal (signed in as B@example.test, not a@example.test)')
    expect(limitOn(view([row({ lastEmail: 'b@example.test' })]), ctx(), false)).toBe('on personal (b@example.test)')
    expect(limitOn(view([row({})]), ctx(), false)).toBe('on personal')
    expect(limitOn(view([]), ctx(), false)).toBe("on an account Termpolis doesn't know")
    expect(limitOn(view([row({})]), ctx(), true)).toBe('on an account changed by hand')
  })
})

describe('noWayOut', () => {
  const now = new Date(2026, 9, 23, 14, 0).getTime()
  const t = (label: string, resetsAt: number | null, state: LimitTarget['state'] = 'limited'): LimitTarget => ({
    row: row({ id: label, label, limit: { seenAt: 1, resetsAt, text: 'x', scope: 'account' } }), state, text: '',
  })
  it('names the account that frees up first, among those out with a reset ahead', () => {
    expect(noWayOut('codex', [t('b', now + 7_200_000), t('c', now + 3_600_000), t('d', now - 1), t('e', null)], now)).toMatch(/^No other Codex account is free\. c is out of usage until /)
    expect(noWayOut('claude', [t('d', now - 1), t('e', null), t('f', now + 1, 'same-sign-in')], now)).toBe('No other Claude Code account is free.')
    expect(noWayOut('claude', [{ row: row({ label: 'g' }), state: 'limited', text: '' }], now)).toBe('No other Claude Code account is free.')
  })
})

describe('groupNote', () => {
  it('says how many more terminals the same limit stopped, on which account', () => {
    const v = view([row({})])
    expect(groupNote(ctx(), v)).toBeNull()
    expect(groupNote(ctx({ terminals: ['t1', 't2'] }), v)).toBe('1 more Claude Code terminal ran out on personal too: Termpolis asks about each after this one.')
    expect(groupNote(ctx({ terminals: ['t1', 't2', 't3'], accountId: null }), v)).toBe('2 more Claude Code terminals ran out too: Termpolis asks about each after this one.')
    expect(groupNote(ctx({ terminals: ['t1', 't2'], accountId: 'gone' }), v)).toBe('1 more Claude Code terminal ran out too: Termpolis asks about each after this one.')
  })
})

describe('otherAgents', () => {
  it('offers the installed agents but the terminal\'s, each with its bare command', () => {
    expect(otherAgents({ claude: true, codex: true, agy: true }, 'codex')).toEqual(['claude', 'agy'])
    expect(otherAgents({ claude: true, codex: false }, 'agy')).toEqual(['claude'])
    expect(otherAgents(null, 'claude')).toEqual([])
    expect(AGENT_COMMAND).toEqual({ claude: 'claude', codex: 'codex', agy: 'agy' })
  })
})
