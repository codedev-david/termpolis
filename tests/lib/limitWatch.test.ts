// The usage-limit chooser's watch, the renderer's side (src/renderer/src/lib/limitWatch.ts, §8 in
// ask mode): one prompt per stop, nothing while the agent is gone (R5) or before it took a turn
// (R4), grouping by account (R22), the focus rules, the one-account banner (D13), menus only
// bannered (R22), the record of each new limit with the sign-in it hit (R23), and the swarm's seam
// (item 8): a worker's stop goes to the conductor as in v1.54.0.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  _resetLimitWatchForTest, bannerText, decideLimit, isTerminalVisible, noteLook,
  noteSwarmStop, osNotify, pruneChooser, pruneStops, sameGroup, setSwarmStopOffer, showLimit, watchTerminal,
} from '../../src/renderer/src/lib/limitWatch'
import type { DecideEnv, LimitBanner, LimitContext, LimitNote, ShowStore } from '../../src/renderer/src/lib/limitWatch'
import type { LimitLook } from '../../src/shared/accountLimits'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { TerminalSession } from '../../src/renderer/src/types'

const LIMIT = { status: 'blocked' as const, summary: 'usage limit reached (resets 3pm (America/New_York))' }
const LIMIT_LATER = { status: 'blocked' as const, summary: 'usage limit reached (resets 2:59pm (America/New_York))' }
const MENU = { status: 'blocked' as const, summary: 'waiting on a menu: Codex offers to update itself' }
const IDLE = { status: 'idle' as const, summary: 'Waiting at prompt' }
const WORKING = { status: 'working' as const, summary: 'Working...' }
const WORDS = "You've hit your session limit · resets 3pm (America/New_York)"

function look(over: Partial<LimitLook> = {}): LimitLook {
  return { agent: 'claude', live: true, turned: true, startAt: 100, status: LIMIT, words: WORDS, accountId: 'acc_a', byHand: false, ...over }
}

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true,
    order: 0, connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: null, connection: null, bypassReady: false,
    terminals: 0, recopyAvailable: false, ...over,
  }
}
function view(accounts: AccountRowView[], over: Partial<AccountsView> = {}): AccountsView {
  return {
    accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
    advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h', ...over,
  }
}
const A = row({ id: 'acc_a', label: 'personal', lastEmail: 'a@example.test' })
const B = row({ id: 'acc_b', label: 'codedev', profile: '/h/.claude-b', folder: '/h/.claude-b', isDefault: false, lastEmail: 'b@example.test', order: 1 })
const term = (id: string, over: Partial<TerminalSession> = {}): TerminalSession => ({
  id, name: `Claude Code — ${id}`, color: '#D97706', shellType: 'gitbash', cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono', agentCommand: 'claude', ...over,
})
const ctx = (over: Partial<LimitContext> = {}): LimitContext => ({
  agent: 'claude', accountId: 'acc_a', terminals: ['t1'], words: WORDS, resetsAt: null, kind: { scope: 'account', window: 'session' }, ...over,
})

beforeEach(() => _resetLimitWatchForTest())

describe('noteLook', () => {
  it('opens one prompt per stop: a countdown redrawn is the same stop', () => {
    const first = noteLook('t1', 'claude', look(), 1000)
    expect(first.kind).toBe('limit')
    expect(noteLook('t1', 'claude', look(), 1000)).toEqual({ kind: 'none' })
    expect(noteLook('t1', 'claude', look({ status: LIMIT_LATER }), 1000)).toEqual({ kind: 'none' })
  })

  it("says what the stop is: the CLI's words, when it lifts, its kind, and the account main recorded", () => {
    const seen = Date.parse('2026-10-23T18:00:00Z')
    const n = noteLook('t1', 'claude', look(), seen)
    expect(n).toEqual({ kind: 'limit', ctx: ctx({ resetsAt: Date.parse('2026-10-23T19:00:00Z') }) })
    _resetLimitWatchForTest()
    // No words found: the summary stands for them; a reset the summary doesn't name, none.
    const bare = noteLook('t1', 'codex', look({ agent: 'codex', status: { status: 'blocked', summary: 'usage limit reached' }, words: null }), seen)
    expect(bare).toEqual({ kind: 'limit', ctx: ctx({ agent: 'codex', words: 'usage limit reached', kind: { scope: 'account', window: 'other' } }) })
  })

  it('names no account for a terminal whose account was changed by hand', () => {
    const n = noteLook('t1', 'claude', look({ byHand: true }), 1000)
    expect(n.kind === 'limit' && n.ctx.accountId).toBeNull()
  })

  it('counts nothing while the agent is gone (R5) or another agent runs there', () => {
    expect(noteLook('t1', 'claude', look({ live: false }), 1000)).toEqual({ kind: 'none' })
    expect(noteLook('t1', 'claude', look({ agent: 'codex' }), 1000)).toEqual({ kind: 'none' })
    expect(noteLook('t1', 'claude', look({ agent: null }), 1000)).toEqual({ kind: 'none' })
  })

  it('counts no limit before the agent took a turn: an old one drawn again by a resumed session (R4)', () => {
    expect(noteLook('t1', 'claude', look({ turned: false }), 1000)).toEqual({ kind: 'none' })
    expect(noteLook('t1', 'claude', look({ turned: false }), 1000)).toEqual({ kind: 'none' })
    // Its first turn stopped on the limit too, with no work seen between (a limit answers at once):
    // a new stop.
    expect(noteLook('t1', 'claude', look({ turned: true }), 1000).kind).toBe('limit')
  })

  it('carries a stop across a relaunch until the agent takes a turn on the new account (R4)', () => {
    expect(noteLook('t1', 'claude', look(), 1000).kind).toBe('limit')
    // Switched: a new start, the resumed session draws the old limit again.
    expect(noteLook('t1', 'claude', look({ startAt: 900, turned: false }), 1000)).toEqual({ kind: 'none' })
    expect(noteLook('t1', 'claude', look({ startAt: 900, turned: true }), 1000).kind).toBe('limit')
  })

  it('ends a stop once the agent is seen at work, or two looks in a row show none', () => {
    expect(noteLook('t1', 'claude', look(), 1000).kind).toBe('limit')
    expect(noteLook('t1', 'claude', look({ status: WORKING }), 1000)).toEqual({ kind: 'none' })
    expect(noteLook('t1', 'claude', look(), 1000).kind).toBe('limit')
    // One look with no stop is a repaint's moment, not an end.
    noteLook('t1', 'claude', look({ status: IDLE }), 1000)
    expect(noteLook('t1', 'claude', look(), 1000)).toEqual({ kind: 'none' })
    noteLook('t1', 'claude', look({ status: IDLE }), 1000)
    noteLook('t1', 'claude', look({ status: IDLE }), 1000)
    expect(noteLook('t1', 'claude', look(), 1000).kind).toBe('limit')
    // No stop with none before: nothing.
    expect(noteLook('t2', 'claude', look({ status: IDLE }), 1000)).toEqual({ kind: 'none' })
  })

  it('reads a menu as a stop of its own, a limit after it as another', () => {
    expect(noteLook('t1', 'codex', look({ agent: 'codex', status: MENU, words: null }), 1000))
      .toEqual({ kind: 'menu', ctx: ctx({ agent: 'codex', words: MENU.summary, kind: { scope: 'account', window: 'other' } }) })
    expect(noteLook('t1', 'codex', look({ agent: 'codex' }), 1000).kind).toBe('limit')
  })

  it('forgets the stops of terminals closed since', () => {
    noteLook('t1', 'claude', look(), 1000)
    noteLook('t2', 'claude', look(), 1000)
    pruneStops(new Set(['t2']))
    expect(noteLook('t1', 'claude', look(), 1000).kind).toBe('limit')
    expect(noteLook('t2', 'claude', look(), 1000)).toEqual({ kind: 'none' })
  })
})

describe('decideLimit', () => {
  const env = (over: Partial<DecideEnv> = {}): DecideEnv => ({ view: view([A, B]), dialog: null, banners: [], mayOpen: true, newId: () => 'b1', ...over })
  const limit = (c: LimitContext = ctx()): Exclude<LimitNote, { kind: 'none' }> => ({ kind: 'limit', ctx: c })

  it('opens the chooser for an agent with more than one account, when nothing stands in its way', () => {
    expect(decideLimit(limit(), env())).toEqual({ kind: 'open', ctx: ctx() })
  })

  it('shows the one-line banner for an agent with one account or none (D13), unless hidden for good', () => {
    expect(decideLimit(limit(), env({ view: view([A]) }))).toEqual({ kind: 'banner', banner: { id: 'b1', kind: 'single', ctx: ctx() } })
    expect(decideLimit(limit(), env({ view: null }))).toEqual({ kind: 'banner', banner: { id: 'b1', kind: 'single', ctx: ctx() } })
    expect(decideLimit(limit(ctx({ agent: 'codex' })), env()).kind).toBe('banner')
    expect(decideLimit(limit(), env({ view: view([A], { hidden: { limitBanner: true } }) }))).toEqual({ kind: 'nothing' })
  })

  it('banners a menu, never opening the chooser for it (R22)', () => {
    expect(decideLimit({ kind: 'menu', ctx: ctx() }, env())).toEqual({ kind: 'banner', banner: { id: 'b1', kind: 'menu', ctx: ctx() } })
  })

  it('joins a stop on the same account to the chooser open for it, or to the banner waiting for it (R22)', () => {
    expect(decideLimit(limit(ctx({ terminals: ['t2'] })), env({ dialog: { limit: ctx() } }))).toEqual({ kind: 'join' })
    const waiting: LimitBanner = { id: 'w', kind: 'choose', ctx: ctx() }
    expect(decideLimit(limit(ctx({ terminals: ['t2'] })), env({ banners: [{ id: 'm', kind: 'menu', ctx: ctx() }, waiting] })))
      .toEqual({ kind: 'banner', banner: { id: 'w', kind: 'choose', ctx: ctx({ terminals: ['t1', 't2'] }) } })
  })

  it("banners a stop when the chooser is off, its terminal is out of view, or another chooser is open", () => {
    const choose = { kind: 'banner', banner: { id: 'b1', kind: 'choose', ctx: ctx() } }
    expect(decideLimit(limit(), env({ view: view([A, B], { chooser: false }) }))).toEqual(choose)
    expect(decideLimit(limit(), env({ mayOpen: false }))).toEqual(choose)
    expect(decideLimit(limit(), env({ dialog: {} }))).toEqual(choose)
    // A chooser open for another account is another dialog.
    expect(decideLimit(limit(), env({ dialog: { limit: ctx({ accountId: 'acc_b' }) } }))).toEqual(choose)
  })

  it('groups by agent and account', () => {
    expect(sameGroup(ctx(), ctx({ terminals: ['t9'] }))).toBe(true)
    expect(sameGroup(ctx(), ctx({ accountId: 'acc_b' }))).toBe(false)
    expect(sameGroup(ctx(), ctx({ agent: 'codex' }))).toBe(false)
  })
})

describe('pruneChooser', () => {
  it('gives up each terminal that closed, or runs another agent now, and keeps the rest', () => {
    const leaveLimitChooser = vi.fn()
    const accountSwitch = { terminalId: 'gone', limit: ctx({ terminals: ['gone', 't1', 't2', 't3'] }) }
    pruneChooser({ accountSwitch, terminals: [term('t1'), term('t2', { agentCommand: 'codex' }), term('t3', { agentCommand: undefined })], leaveLimitChooser })
    expect(leaveLimitChooser.mock.calls.map((c) => c[0])).toEqual(['gone', 't2', 't3'])
  })

  it('does nothing with no chooser, or one opened for no limit', () => {
    const leaveLimitChooser = vi.fn()
    pruneChooser({ accountSwitch: null, terminals: [], leaveLimitChooser })
    pruneChooser({ accountSwitch: { terminalId: 't1' }, terminals: [], leaveLimitChooser })
    expect(leaveLimitChooser).not.toHaveBeenCalled()
  })
})

describe('where the stopped terminal is', () => {
  it("reads a terminal as on screen: its tab active, or a pane of the split, with Settings not over them", () => {
    const s = { terminals: [term('t1'), term('t2'), term('w', { hidden: true })], viewMode: 'tabs' as const, activeTerminalId: 't1', paneTree: null, showSettings: false }
    expect(isTerminalVisible(s, 't1')).toBe(true)
    expect(isTerminalVisible(s, 't2')).toBe(false)
    expect(isTerminalVisible(s, 'w')).toBe(false)
    expect(isTerminalVisible(s, 'gone')).toBe(false)
    expect(isTerminalVisible({ ...s, showSettings: true }, 't1')).toBe(false)
    const split = {
      ...s, viewMode: 'split' as const,
      paneTree: { type: 'split' as const, direction: 'horizontal' as const, ratio: 0.5, children: [{ type: 'terminal' as const, terminalId: 't1' }, { type: 'terminal' as const, terminalId: 't2' }] as [any, any] },
    }
    expect(isTerminalVisible(split, 't2')).toBe(true)
    expect(isTerminalVisible({ ...split, paneTree: null }, 't2')).toBe(false)
  })
})

describe('bannerText', () => {
  const now = new Date(2026, 9, 23, 14, 0).getTime()
  it('says what each banner is about', () => {
    expect(bannerText({ id: 'b', kind: 'menu', ctx: ctx({ agent: 'codex' }) }, null, [term('t1', { name: 'api' })], now)).toBe('Codex is waiting on a menu in api: answer it there.')
    expect(bannerText({ id: 'b', kind: 'menu', ctx: ctx({ agent: 'codex' }) }, null, [], now)).toBe('Codex is waiting on a menu: answer it there.')
    expect(bannerText({ id: 'b', kind: 'single', ctx: ctx({ resetsAt: new Date(2026, 9, 23, 15, 0).getTime() }) }, null, [], now)).toMatch(/^Claude Code is out of usage until .+\.$/)
    expect(bannerText({ id: 'b', kind: 'single', ctx: ctx() }, null, [], now)).toBe('Claude Code is out of usage.')
    expect(bannerText({ id: 'b', kind: 'choose', ctx: ctx() }, view([A, B]), [], now)).toBe('Claude Code ran out of usage on personal.')
    expect(bannerText({ id: 'b', kind: 'choose', ctx: ctx({ accountId: null, terminals: ['t1', 't2'] }) }, view([A, B]), [], now)).toBe('2 Claude Code terminals ran out of usage.')
    expect(bannerText({ id: 'b', kind: 'choose', ctx: ctx({ terminals: ['t1', 't2', 't3'] }) }, null, [], now)).toBe('3 Claude Code terminals ran out of usage.')
  })
})

describe('showLimit', () => {
  function store(over: Partial<ShowStore> = {}): ShowStore {
    const s: ShowStore = {
      accountsView: view([A, B]), accountSwitch: null, limitBanners: [], terminals: [term('t1'), term('t2')], viewMode: 'tabs', activeTerminalId: 't1',
      paneTree: null, showSettings: false,
      openLimitChooser: vi.fn((c: LimitContext) => { s.accountSwitch = { terminalId: c.terminals[0], limit: c } }),
      joinLimitChooser: vi.fn(),
      showLimitBanner: vi.fn((b: LimitBanner) => { s.limitBanners = [...s.limitBanners.filter((x) => x.id !== b.id), b] }),
      dismissLimitBanner: vi.fn((id: string) => { s.limitBanners = s.limitBanners.filter((x) => x.id !== id) }),
      ...over,
    }
    return s
  }
  const deps = (s: ShowStore, focused = true, notify = vi.fn()) => ({ store: () => s, focused: () => focused, now: () => 1_000_000, newId: () => 'b1', notify })

  it('opens the chooser\'s card for a stop on the terminal in view, and tells the OS only when the window is elsewhere', () => {
    const s = store()
    const notify = vi.fn()
    showLimit({ kind: 'limit', ctx: ctx() }, deps(s, true, notify))
    expect(s.openLimitChooser).toHaveBeenCalledWith(ctx())
    expect(notify).not.toHaveBeenCalled()
    const away = store()
    showLimit({ kind: 'limit', ctx: ctx() }, deps(away, false, notify))
    expect(away.openLimitChooser).toHaveBeenCalledWith(ctx())
    expect(notify).toHaveBeenCalledWith('Claude Code ran out of usage', 'Claude Code ran out of usage on personal.', expect.any(Function))
    // Its click brings the window up, where the card is already.
    expect(notify.mock.calls[0][2]()).toBeUndefined()
  })

  it('joins a stop to the chooser open for its account', () => {
    const s = store({ accountSwitch: { terminalId: 't1', limit: ctx() } })
    showLimit({ kind: 'limit', ctx: ctx({ terminals: ['t2'] }) }, deps(s))
    expect(s.joinLimitChooser).toHaveBeenCalledWith('t2')
    expect(s.openLimitChooser).not.toHaveBeenCalled()
  })

  it("banners a stop on a terminal out of view, and tells the OS when the window isn't focused, once", () => {
    const notify = vi.fn()
    const s = store({ activeTerminalId: 't2' })
    showLimit({ kind: 'limit', ctx: ctx() }, deps(s, false, notify))
    expect(s.limitBanners).toEqual([{ id: 'b1', kind: 'choose', ctx: ctx() }])
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toBe('Claude Code ran out of usage')
    expect(notify.mock.calls[0][1]).toBe('Claude Code ran out of usage on personal.')
    // A second stop on the account joins the banner, and says nothing more to the OS.
    showLimit({ kind: 'limit', ctx: ctx({ terminals: ['t2'] }) }, deps(s, false, notify))
    expect(s.limitBanners).toEqual([{ id: 'b1', kind: 'choose', ctx: ctx({ terminals: ['t1', 't2'] }) }])
    expect(notify).toHaveBeenCalledTimes(1)
    // Its click: the chooser, for every terminal the banner gathered, and the banner gone.
    notify.mock.calls[0][2]()
    expect(s.openLimitChooser).toHaveBeenCalledWith(ctx({ terminals: ['t1', 't2'] }))
    expect(s.limitBanners).toEqual([])
    // Once gone, a click still opens the chooser for what it said.
    notify.mock.calls[0][2]()
    expect(s.openLimitChooser).toHaveBeenLastCalledWith(ctx())
  })

  it('tells the OS nothing for a banner the window shows', () => {
    const notify = vi.fn()
    const s = store({ activeTerminalId: 't2' })
    showLimit({ kind: 'limit', ctx: ctx() }, deps(s, true, notify))
    expect(s.limitBanners).toHaveLength(1)
    showLimit({ kind: 'menu', ctx: ctx({ terminals: ['t2'] }) }, { ...deps(s, false, notify), newId: () => 'b2' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('shows nothing where the one-account banner was hidden for good', () => {
    const s = store({ accountsView: view([A], { hidden: { limitBanner: true } }) })
    showLimit({ kind: 'limit', ctx: ctx() }, deps(s))
    expect(s.showLimitBanner).not.toHaveBeenCalled()
    expect(s.openLimitChooser).not.toHaveBeenCalled()
  })
})

describe('osNotify', () => {
  it('shows an OS notification that brings the window forward, where there is one', () => {
    const made: Array<{ title: string; body: string; onclick?: () => void }> = []
    const Fake = vi.fn(function (this: any, title: string, opts: { body: string }) { this.title = title; this.body = opts.body; made.push(this) })
    vi.stubGlobal('Notification', Fake)
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    const clicked = vi.fn()
    osNotify('T', 'B', clicked)
    expect(made).toMatchObject([{ title: 'T', body: 'B' }])
    made[0].onclick!()
    expect(focus).toHaveBeenCalled()
    expect(clicked).toHaveBeenCalled()
    vi.stubGlobal('Notification', vi.fn(() => { throw new Error('denied') }))
    expect(() => osNotify('T', 'B', clicked)).not.toThrow()
    vi.unstubAllGlobals()
    focus.mockRestore()
  })

  it('does nothing where the window has none', () => {
    vi.stubGlobal('Notification', undefined)
    expect(() => osNotify('T', 'B', () => {})).not.toThrow()
    vi.unstubAllGlobals()
  })
})

describe('noteSwarmStop: item 8\'s seam', () => {
  const worker = { terminalId: 'w1', agentName: 'Claude', role: 'Build UI' }
  beforeEach(() => {
    ;(window as any).swarmAPI = { getTasks: vi.fn(async () => ({ success: true, data: [] })), sendMessage: vi.fn(async () => ({ success: true })) }
  })

  it("tells the conductor of a worker's limit as v1.54.0 does, with no restart offer installed", async () => {
    await noteSwarmStop(worker, LIMIT)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(1)
    expect((window.swarmAPI.sendMessage as any).mock.calls[0][3]).toMatch(/close its terminal, then give its task to another installed agent/)
  })

  it('lets an installed offer take a limit over, and nothing else', async () => {
    const offer = vi.fn(async () => true)
    setSwarmStopOffer(offer)
    const words = () => 'the CLI\'s words'
    // A worker of its own: the reports remember each terminal's stop (the test above has w1's).
    const w = { ...worker, terminalId: 'w-offer' }
    await noteSwarmStop(w, LIMIT, words)
    expect(offer).toHaveBeenCalledWith(w, LIMIT, words)
    expect(window.swarmAPI.sendMessage).not.toHaveBeenCalled()
    // Once per stop: the 5 s loop reads the same limit again and again.
    await noteSwarmStop(w, LIMIT, words)
    await noteSwarmStop(w, LIMIT)
    expect(offer).toHaveBeenCalledTimes(1)
    // A menu is never offered.
    await noteSwarmStop({ ...worker, terminalId: 'w2' }, MENU)
    expect(offer).toHaveBeenCalledTimes(1)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(1)
    // An offer that declines leaves it to the conductor.
    setSwarmStopOffer(() => false)
    await noteSwarmStop({ ...worker, terminalId: 'w3' }, LIMIT)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledTimes(2)
    setSwarmStopOffer(null)
  })
})

describe('watchTerminal', () => {
  const api = (res: unknown, noteLimit = vi.fn(async () => ({ success: true }))) => ({ limitLook: vi.fn(async () => res as any), noteLimit })

  it('records a new limit against the account it hit, with the sign-in it hit (R23), and hands it on', async () => {
    const accounts = api({ success: true, data: look() })
    const onLimit = vi.fn()
    await watchTerminal('t1', 'claude', view([A, B]), { accounts, now: () => Date.parse('2026-10-23T18:00:00Z'), onLimit })
    expect(accounts.noteLimit).toHaveBeenCalledWith('acc_a', {
      text: WORDS, resetsAt: Date.parse('2026-10-23T19:00:00Z'), scope: 'account', window: 'session', email: 'a@example.test',
    })
    expect(onLimit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'limit' }))
  })

  it("records an agy account's limit under the email it was given", async () => {
    const g = row({ id: 'g1', agent: 'agy', label: 'home', profile: null, folder: null, isDefault: false, folderExists: false, email: 'g@example.test' })
    const accounts = api({ success: true, data: look({ agent: 'agy', accountId: 'g1', words: 'You have exhausted your quota on this model.' }) })
    await watchTerminal('t1', 'agy', view([g]), { accounts, now: () => 1, onLimit: vi.fn() })
    expect(accounts.noteLimit).toHaveBeenCalledWith('g1', expect.objectContaining({ scope: 'model', email: 'g@example.test' }))
  })

  it('records nothing for an account it doesn\'t know, nor for a menu, and still hands either on', async () => {
    const onLimit = vi.fn()
    const unknown = api({ success: true, data: look({ accountId: null }) })
    await watchTerminal('t1', 'claude', view([A, B]), { accounts: unknown, now: () => 1, onLimit })
    const menu = api({ success: true, data: look({ status: MENU }) })
    await watchTerminal('t2', 'claude', view([A, B]), { accounts: menu, now: () => 1, onLimit })
    const noView = api({ success: true, data: look() })
    await watchTerminal('t3', 'claude', null, { accounts: noView, now: () => 1, onLimit })
    const bare = row({ id: 'acc_a' })
    const noEmail = api({ success: true, data: look() })
    await watchTerminal('t4', 'claude', view([bare]), { accounts: noEmail, now: () => 1, onLimit })
    expect(unknown.noteLimit).not.toHaveBeenCalled()
    expect(menu.noteLimit).not.toHaveBeenCalled()
    expect(noView.noteLimit).not.toHaveBeenCalled()
    expect(noEmail.noteLimit).toHaveBeenCalledWith('acc_a', expect.not.objectContaining({ email: expect.anything() }))
    expect(onLimit).toHaveBeenCalledTimes(4)
  })

  it('opens the chooser though the record failed', async () => {
    const accounts = api({ success: true, data: look() }, vi.fn(async () => { throw new Error('locked') }))
    const onLimit = vi.fn()
    await watchTerminal('t1', 'claude', view([A, B]), { accounts, now: () => 1, onLimit })
    expect(onLimit).toHaveBeenCalledTimes(1)
  })

  it('does nothing when main gives no look, or the look shows nothing new', async () => {
    const onLimit = vi.fn()
    await watchTerminal('t1', 'claude', null, { accounts: api({ success: false, error: 'x' }), now: () => 1, onLimit })
    await watchTerminal('t1', 'claude', null, { accounts: { limitLook: vi.fn(async () => { throw new Error('gone') }), noteLimit: vi.fn() }, now: () => 1, onLimit })
    await watchTerminal('t1', 'claude', null, { accounts: api({ success: true, data: look({ status: IDLE }) }), now: () => 1, onLimit })
    expect(onLimit).not.toHaveBeenCalled()
  })
})
