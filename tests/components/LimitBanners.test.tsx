// The usage-limit banners (src/renderer/src/components/Accounts/LimitBanners.tsx, §8.4): one line
// each, never a dialog. The one-account banner with [Add an account] and [Don't show again], the
// banner that opens the chooser, a menu's; each closable, and gone once its terminals are.
import React from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LimitBanners } from '../../src/renderer/src/components/Accounts/LimitBanners'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import type { LimitBanner, LimitContext } from '../../src/renderer/src/lib/limitWatch'
import type { AccountsView } from '../../src/shared/agentAccounts'
import * as settingsNav from '../../src/renderer/src/lib/settingsNav'

const ctx = (over: Partial<LimitContext> = {}): LimitContext => ({
  agent: 'claude', accountId: 'acc_a', terminals: ['t1'], words: "You've hit your session limit · resets 3pm (UTC)", resetsAt: null, kind: { scope: 'account', window: 'session' }, ...over,
})
const T = (id: string) => ({ id, name: `term ${id}`, color: '', shellType: 'gitbash' as const, cwd: '/r', fontSize: 13, theme: 'dark', fontFamily: 'mono', agentCommand: 'claude' })
const VIEW = {
  accounts: [{ id: 'acc_a', agent: 'claude', label: 'personal' }], preferred: {}, chooser: true, hidden: {}, integrationConnected: true,
  importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h',
} as unknown as AccountsView

function show(banners: LimitBanner[]) {
  act(() => { useTerminalStore.setState({ limitBanners: banners, terminals: [T('t1'), T('t2')], accountsView: VIEW }) })
}

beforeEach(() => {
  useTerminalStore.setState({ limitBanners: [], terminals: [], accountsView: null, accountSwitch: null, showSettings: false, activeTerminalId: null })
})
afterEach(() => {
  cleanup()
  delete (window as any).accounts
  vi.restoreAllMocks()
})

describe('LimitBanners', () => {
  it('shows nothing with no banner, or none whose terminal is still open', () => {
    const { container } = render(<LimitBanners />)
    expect(container.innerHTML).toBe('')
    act(() => { useTerminalStore.setState({ limitBanners: [{ id: 'b', kind: 'single', ctx: ctx({ terminals: ['gone'] }) }], terminals: [T('t1')] }) })
    expect(container.innerHTML).toBe('')
  })

  it("says an agent with one account is out of usage, with the CLI's words on hover, and opens Settings ▸ Accounts to add one", () => {
    const req = vi.spyOn(settingsNav, 'requestSettingsTab')
    render(<LimitBanners />)
    show([{ id: 'b1', kind: 'single', ctx: ctx() }])
    const banner = screen.getByTestId('limit-banner')
    expect(banner.getAttribute('data-kind')).toBe('single')
    expect(banner.textContent).toContain('Claude Code is out of usage.')
    expect(banner.getAttribute('title')).toBe("Claude Code: You've hit your session limit · resets 3pm (UTC)")
    fireEvent.click(screen.getByTestId('limit-banner-add'))
    expect(req).toHaveBeenCalledWith('accounts', false)
    expect(useTerminalStore.getState().showSettings).toBe(true)
    expect(useTerminalStore.getState().limitBanners).toEqual([])
  })

  it("hides the one-account banner for good on Don't show again, and keeps the view main answers", async () => {
    const answered = { ...VIEW, hidden: { limitBanner: true } }
    const hideAdvice = vi.fn(async () => ({ success: true, data: answered }))
    ;(window as any).accounts = { hideAdvice }
    render(<LimitBanners />)
    show([{ id: 'b1', kind: 'single', ctx: ctx() }])
    await act(async () => { fireEvent.click(screen.getByTestId('limit-banner-hide')) })
    expect(hideAdvice).toHaveBeenCalledWith('limitBanner')
    expect(useTerminalStore.getState().accountsView).toBe(answered)
    expect(useTerminalStore.getState().limitBanners).toEqual([])
  })

  it('keeps going when main refuses, or there is no bridge', async () => {
    ;(window as any).accounts = { hideAdvice: vi.fn(async () => ({ success: false, error: 'x' })) }
    render(<LimitBanners />)
    show([{ id: 'b1', kind: 'single', ctx: ctx() }, { id: 'b2', kind: 'single', ctx: ctx({ terminals: ['t2'] }) }])
    await act(async () => { fireEvent.click(screen.getAllByTestId('limit-banner-hide')[0]) })
    expect(useTerminalStore.getState().accountsView).toBe(VIEW)
    ;(window as any).accounts = { hideAdvice: vi.fn(async () => { throw new Error('gone') }) }
    await act(async () => { fireEvent.click(screen.getByTestId('limit-banner-hide')) })
    delete (window as any).accounts
    show([{ id: 'b3', kind: 'single', ctx: ctx() }])
    await act(async () => { fireEvent.click(screen.getByTestId('limit-banner-hide')) })
    expect(useTerminalStore.getState().limitBanners).toEqual([])
  })

  it('opens the chooser from its banner, for every terminal it gathered, and shows the first one with its card', () => {
    render(<LimitBanners />)
    show([{ id: 'b1', kind: 'choose', ctx: ctx({ terminals: ['t1', 't2'] }) }])
    act(() => { useTerminalStore.setState({ showSettings: true, activeTerminalId: 't2' }) })
    expect(screen.getByTestId('limit-banner').textContent).toContain('2 Claude Code terminals ran out of usage on personal.')
    fireEvent.click(screen.getByTestId('limit-banner-choose'))
    expect(useTerminalStore.getState().accountSwitch).toEqual({ terminalId: 't1', limit: ctx({ terminals: ['t1', 't2'] }) })
    expect(useTerminalStore.getState().limitBanners).toEqual([])
    // The card is on that terminal's pane: Settings gives way, and the terminal shows.
    expect(useTerminalStore.getState().showSettings).toBe(false)
    expect(useTerminalStore.getState().activeTerminalId).toBe('t1')
  })

  it("leaves a chooser open for another account's stop as it is, shows that card's pane, and keeps this banner waiting", () => {
    render(<LimitBanners />)
    const open = { terminalId: 't2', limit: ctx({ terminals: ['t2'], accountId: 'acc_b' }) }
    show([{ id: 'b1', kind: 'choose', ctx: ctx() }])
    act(() => { useTerminalStore.setState({ accountSwitch: open, activeTerminalId: 't1', showSettings: true }) })
    fireEvent.click(screen.getByTestId('limit-banner-choose'))
    expect(useTerminalStore.getState().accountSwitch).toBe(open)
    expect(useTerminalStore.getState().activeTerminalId).toBe('t2')
    expect(useTerminalStore.getState().showSettings).toBe(false)
    // A stop is offered once: its banner stays until its card can open.
    expect(useTerminalStore.getState().limitBanners.map((x) => x.id)).toEqual(['b1'])
    // When that card is answered, the banner opens this one.
    act(() => { useTerminalStore.setState({ accountSwitch: null }) })
    fireEvent.click(screen.getByTestId('limit-banner-choose'))
    expect(useTerminalStore.getState().accountSwitch).toEqual({ terminalId: 't1', limit: ctx() })
    expect(useTerminalStore.getState().limitBanners).toEqual([])
  })

  it('joins the chooser already open for the same account: each terminal gets its card, and the banner goes', () => {
    render(<LimitBanners />)
    const open = { terminalId: 't1', limit: ctx({ terminals: ['t1'] }) }
    show([{ id: 'b1', kind: 'choose', ctx: ctx({ terminals: ['t2'] }) }])
    act(() => { useTerminalStore.setState({ accountSwitch: open, activeTerminalId: 't1' }) })
    fireEvent.click(screen.getByTestId('limit-banner-choose'))
    expect(useTerminalStore.getState().accountSwitch).toEqual({ terminalId: 't1', limit: ctx({ terminals: ['t1', 't2'] }) })
    expect(useTerminalStore.getState().limitBanners).toEqual([])
    expect(useTerminalStore.getState().activeTerminalId).toBe('t2')
  })

  it('is announced to assistive technology without taking the focus (a polite status)', () => {
    render(<LimitBanners />)
    show([{ id: 'b1', kind: 'single', ctx: ctx() }, { id: 'm1', kind: 'menu', ctx: ctx({ agent: 'codex', terminals: ['t2'] }) }])
    for (const b of screen.getAllByTestId('limit-banner')) expect(b).toHaveAttribute('role', 'status')
  })

  it("shows a menu's terminal, and closes any banner on ×", () => {
    render(<LimitBanners />)
    show([{ id: 'm1', kind: 'menu', ctx: ctx({ agent: 'codex', terminals: ['t2'] }) }, { id: 'b1', kind: 'single', ctx: ctx() }])
    const [menu] = screen.getAllByTestId('limit-banner')
    expect(menu.textContent).toContain('Codex is waiting on a menu in term t2: answer it there.')
    expect(menu.getAttribute('title')).toBeNull()
    fireEvent.click(screen.getByTestId('limit-banner-show'))
    expect(useTerminalStore.getState().activeTerminalId).toBe('t2')
    fireEvent.click(screen.getByTestId('limit-banner-close'))
    expect(useTerminalStore.getState().limitBanners).toEqual([])
  })
})
