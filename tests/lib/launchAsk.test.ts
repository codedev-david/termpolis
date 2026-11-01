// Launching an agent on an account that is out of usage (src/renderer/src/lib/launchAsk.ts, the design's
// launch paths §6.3, ask mode): who is asked, what, and what each answer does to the launch. A user with
// no account, or none out of usage, is asked nothing (D13).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { _resetLaunchAskForTest, answerLaunchAsk, askInApp, launchAccountAsked, launchAskHeadline } from '../../src/renderer/src/lib/launchAsk'
import type { LaunchAskContext, LaunchChoice } from '../../src/renderer/src/lib/launchAsk'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { isAccountLimited } from '../../src/shared/accountLimits'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0)
const LATER = NOW + 4 * 3_600_000

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true, order: 0, connect: true,
    origin: 'adopted', folderExists: true, shares: [], lastEmail: 'a@example.test', connection: null, bypassReady: true, terminals: 0, recopyAvailable: false, ...over,
  }
}
const limit = (over: Partial<NonNullable<AccountRowView['limit']>> = {}) => ({ seenAt: NOW - 1000, resetsAt: LATER, text: "You've hit your session limit", scope: 'account' as const, ...over })
const PERSONAL = row({})
const CODEDEV = row({ id: 'acc_b', label: 'codedev', profile: '/h/.claude-b', folder: '/h/.claude-b', isDefault: false, order: 1, lastEmail: 'b@example.test' })
const SPARE = row({ id: 'acc_c', label: 'spare', profile: '/h/.claude-c', folder: '/h/.claude-c', isDefault: false, order: 2, lastEmail: 'c@example.test' })
const WORK = row({ id: 'acc_w', label: 'work', profile: '/h/.claude-w', folder: '/h/.claude-w', isDefault: false, order: 3, autoOffer: false, lastEmail: 'w@corp.test' })
const view = (accounts: AccountRowView[]): AccountsView => ({
  accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
  advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h',
})

/** The bridge main answers a launch with: the preferred account is `preferred`, or the one requested. */
const bridge = (preferred: string | null) => ({
  launchLine: vi.fn(),
  launchAccount: vi.fn(async (_agent: string, requested: string | null) => ({ success: true as const, data: { accountId: requested ?? preferred } })),
}) as never

beforeEach(() => {
  _resetLaunchAskForTest()
  useTerminalStore.setState({ launchAsk: null, accountsView: view([{ ...PERSONAL, limit: limit() }, CODEDEV, SPARE, WORK]) })
})

const asks = (choice: LaunchChoice) => vi.fn(async (_c: LaunchAskContext) => choice)

describe('isAccountLimited: out of usage as Termpolis knows it now', () => {
  it('is a limit of the whole account that has not lifted, or one the failover hook saw', () => {
    expect(isAccountLimited({ limit: limit() }, NOW)).toBe(true)
    expect(isAccountLimited({ limit: limit({ resetsAt: null }) }, NOW)).toBe(true)
    expect(isAccountLimited({ limitedOutside: NOW - 5000 }, NOW)).toBe(true)
  })

  it('is not one that lifted, one of a model (the account stays on offer), or none', () => {
    expect(isAccountLimited({ limit: limit({ resetsAt: NOW - 1 }) }, NOW)).toBe(false)
    expect(isAccountLimited({ limit: limit({ scope: 'model' }) }, NOW)).toBe(false)
    expect(isAccountLimited({}, NOW)).toBe(false)
  })
})

describe('launchAccountAsked', () => {
  it('asks when the preferred account is out of usage and another is free, naming when it is back and the ways out', async () => {
    const ask = asks({ kind: 'on', accountId: 'acc_b' })
    const r = await launchAccountAsked('claude', undefined, bridge('acc_a'), ask, NOW)
    expect(r).toEqual({ cancelled: false, accountId: 'acc_b' })
    const ctx = ask.mock.calls[0][0]
    expect(ctx).toMatchObject({ agent: 'claude', limited: { id: 'acc_a', label: 'personal' }, options: [{ id: 'acc_b', label: 'codedev' }, { id: 'acc_c', label: 'spare' }] })
    expect(ctx.until).toMatch(/^until /)
    // The work account is never a way out (D14).
    expect(ctx.options.map((o) => o.id)).not.toContain('acc_w')
  })

  it('keeps the account when the user launches on it anyway, and stops the launch when they cancel', async () => {
    expect(await launchAccountAsked('claude', undefined, bridge('acc_a'), asks({ kind: 'anyway' }), NOW)).toEqual({ cancelled: false, accountId: 'acc_a' })
    expect(await launchAccountAsked('claude', undefined, bridge('acc_a'), asks({ kind: 'cancel' }), NOW)).toEqual({ cancelled: true })
  })

  it('asks nothing for an account the user picked (Launch on ▸), whether or not it is out of usage', async () => {
    const ask = asks({ kind: 'cancel' })
    expect(await launchAccountAsked('claude', 'acc_a', bridge('acc_a'), ask, NOW)).toEqual({ cancelled: false, accountId: 'acc_a' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks nothing when the preferred account is not out of usage, or its limit lifted', async () => {
    const ask = asks({ kind: 'cancel' })
    expect(await launchAccountAsked('claude', undefined, bridge('acc_b'), ask, NOW)).toEqual({ cancelled: false, accountId: 'acc_b' })
    expect(await launchAccountAsked('claude', undefined, bridge('acc_a'), ask, LATER + 1)).toEqual({ cancelled: false, accountId: 'acc_a' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks nothing when no other account is a way out: it launches as asked, and the limit shows on its own', async () => {
    const ask = asks({ kind: 'cancel' })
    useTerminalStore.setState({ accountsView: view([{ ...PERSONAL, limit: limit() }, { ...CODEDEV, limit: limit() }, WORK]) })
    expect(await launchAccountAsked('claude', undefined, bridge('acc_a'), ask, NOW)).toEqual({ cancelled: false, accountId: 'acc_a' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks nothing of a user with no account, an agent with none, or a command that is no account agent (D13)', async () => {
    const ask = asks({ kind: 'cancel' })
    expect(await launchAccountAsked('claude', undefined, bridge(null), ask, NOW)).toEqual({ cancelled: false, accountId: undefined })
    expect(await launchAccountAsked('npm test', undefined, bridge('acc_a'), ask, NOW)).toEqual({ cancelled: false, accountId: undefined })
    expect(await launchAccountAsked('claude', undefined, null, ask, NOW)).toEqual({ cancelled: false, accountId: undefined })
    useTerminalStore.setState({ accountsView: null })
    expect(await launchAccountAsked('claude', undefined, bridge('acc_a'), ask, NOW)).toEqual({ cancelled: false, accountId: 'acc_a' })
    useTerminalStore.setState({ accountsView: view([CODEDEV]) })
    expect(await launchAccountAsked('claude', undefined, bridge('acc_gone'), ask, NOW)).toEqual({ cancelled: false, accountId: 'acc_gone' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('says the time when the CLI named none as nothing, not as a made-up one', async () => {
    useTerminalStore.setState({ accountsView: view([{ ...PERSONAL, limit: limit({ resetsAt: null }) }, CODEDEV]) })
    const ask = asks({ kind: 'cancel' })
    await launchAccountAsked('claude', undefined, bridge('acc_a'), ask, NOW)
    expect(ask.mock.calls[0][0].until).toBe('')
    expect(launchAskHeadline(ask.mock.calls[0][0])).toBe('Claude Code: personal is out of usage. Launch on codedev?')
  })
})

describe('askInApp and answerLaunchAsk', () => {
  const ctx: LaunchAskContext = { agent: 'codex', limited: { id: 'x', label: 'solo' }, until: 'until 3:00 pm', options: [{ id: 'y', label: 'second' }] }

  it('shows the sheet and hands the user\'s word back, clearing it', async () => {
    const p = askInApp(ctx)
    expect(useTerminalStore.getState().launchAsk).toEqual(ctx)
    answerLaunchAsk({ kind: 'on', accountId: 'y' })
    expect(await p).toEqual({ kind: 'on', accountId: 'y' })
    expect(useTerminalStore.getState().launchAsk).toBeNull()
  })

  it('cancels an ask that a newer one replaces', async () => {
    const first = askInApp(ctx)
    const second = askInApp({ ...ctx, limited: { id: 'z', label: 'other' } })
    expect(await first).toEqual({ kind: 'cancel' })
    answerLaunchAsk({ kind: 'anyway' })
    expect(await second).toEqual({ kind: 'anyway' })
  })

  it('ignores an answer when nothing is asked', () => {
    expect(() => answerLaunchAsk({ kind: 'cancel' })).not.toThrow()
    expect(useTerminalStore.getState().launchAsk).toBeNull()
  })
})
