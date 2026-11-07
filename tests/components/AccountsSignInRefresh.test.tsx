// A finished sign-in is read back by the renderer on every way out (UI-R2 UI2-1). Main keeps the new identity as it
// sends "success" (signInSession: confirm, then checkNow) and pushes nothing, so the view Settings and the menu read
// stayed "signed out" until an unrelated refresh when the user left by Skip, Esc, the X or Cancel, or the Add account
// wizard's own Done. These run the real sheets and the real store against a fake main that behaves that way.
import React from 'react'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { AddAccountSheet } from '../../src/renderer/src/components/Accounts/AddAccountSheet'
import { SignInSheet } from '../../src/renderer/src/components/Accounts/SignInSheet'

const HOME = 'C:\\Users\\me'
const row = (over: Partial<AccountRowView>): AccountRowView => ({
  id: 'acc_main', agent: 'claude', label: 'main', profile: null, folder: `${HOME}\\.claude`, isDefault: true, autoOffer: true, order: 0, connect: true,
  origin: 'created', folderExists: true, shares: [], lastEmail: 'me@example.test', connection: null, bypassReady: false, terminals: 0, recopyAvailable: false,
  identity: { email: 'me@example.test', signedIn: true, checkedAt: 1, source: 'auth-status' }, ...over,
} as AccountRowView)

let rows: AccountRowView[] = []
const mainView = (): AccountsView => ({
  accounts: rows.map((r) => ({ ...r })), preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
  advice: { stopFailureHooks: [], authOverrides: [] }, home: HOME,
} as AccountsView)

let listeners: Array<(s: unknown) => void> = []
const fake = () => {
  const api = {
    list: vi.fn(async () => ({ success: true, data: mainView() })),
    add: vi.fn(async (input: { label: string }) => {
      const created = row({
        id: 'acc_new', label: input.label, isDefault: false, order: 1, profile: `${HOME}\\.claude-${input.label}`, folder: `${HOME}\\.claude-${input.label}`, lastEmail: null, connect: false,
        identity: { email: null, signedIn: false, checkedAt: 1, source: 'auth-status' } as never,
      })
      rows.push(created)
      return { success: true, data: { account: created, leftOut: [], copied: [], changes: [] } }
    }),
    signInStart: vi.fn(async () => ({ success: true, data: { sessionId: 's1' } })),
    signInInput: vi.fn(async () => ({ success: true, data: { ok: true } })),
    onSignInState: (cb: (s: unknown) => void) => { listeners.push(cb); return () => { listeners = listeners.filter((x) => x !== cb) } },
    check: vi.fn(async () => ({ success: true, data: rows[0] })),
  }
  ;(window as any).accounts = api
  ;(window as any).termpolis = { clipboardWriteText: vi.fn(async () => ({ success: true })) }
  return api
}

/** What main does when the CLI's sign-in is done: its status command says signed in, the registry keeps it, the sheet is told. */
const mainSignsIn = (email: string): void => {
  const r = rows.find((x) => x.id === 'acc_new')!
  r.identity = { email, signedIn: true, checkedAt: 2, source: 'auth-status' } as never
  r.lastEmail = email
  act(() => { for (const cb of listeners) cb({ sessionId: 's1', accountId: 'acc_new', agent: 'claude', phase: { kind: 'success', email } }) })
}

const storeIdentity = (): { signedIn?: boolean; email?: string | null } | undefined =>
  useTerminalStore.getState().accountsView?.accounts.find((a) => a.id === 'acc_new')?.identity as never
const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 30)) }) }

beforeEach(() => {
  rows = [row({})]
  listeners = []
  useTerminalStore.setState({ addAccountSheet: null, signInSheet: null, accountsView: mainView() })
})
afterEach(() => {
  cleanup()
  delete (window as any).accounts
  delete (window as any).termpolis
})

describe('the renderer reads main again once a sign-in finished (UI2-1)', () => {
  const signInSheetFor = async () => {
    rows.push(row({ id: 'acc_new', label: 'codedev', isDefault: false, order: 1, lastEmail: null, identity: { email: null, signedIn: false, checkedAt: 1, source: 'auth-status' } as never }))
    const api = fake()
    useTerminalStore.setState({ accountsView: mainView() })
    useTerminalStore.getState().openSignInSheet('acc_new')
    render(<SignInSheet />)
    fireEvent.click(await screen.findByTestId('sign-in-method-claudeai'))
    await waitFor(() => expect(api.signInStart).toHaveBeenCalled())
    return api
  }

  it('the Add account wizard shows the new account signed in once it is finished', async () => {
    const api = fake()
    useTerminalStore.setState({ addAccountSheet: { agent: 'claude' } })
    render(<AddAccountSheet />)
    fireEvent.change(screen.getByTestId('add-account-label'), { target: { value: 'codedev' } })
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await screen.findByTestId('add-account-sign-in-step')
    fireEvent.click(await screen.findByTestId('sign-in-method-claudeai'))
    await waitFor(() => expect(api.signInStart).toHaveBeenCalled())
    expect(storeIdentity()?.signedIn).toBeFalsy()
    mainSignsIn('codedev@example.test')
    fireEvent.click(await screen.findByTestId('sign-in-done'))
    fireEvent.click(await screen.findByTestId('add-account-finish'))
    await settle()
    expect(storeIdentity()).toMatchObject({ signedIn: true, email: 'codedev@example.test' })
  })

  it('reads at the moment of success, before the user does anything with the result', async () => {
    const api = await signInSheetFor()
    const before = api.list.mock.calls.length
    mainSignsIn('codedev@example.test')
    await screen.findByTestId('sign-in-success')
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThan(before))
    expect(storeIdentity()).toMatchObject({ signedIn: true })
  })

  it('the sign-in sheet closed with Esc after success shows the account signed in', async () => {
    await signInSheetFor()
    mainSignsIn('codedev@example.test')
    await screen.findByTestId('sign-in-success')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await settle()
    expect(storeIdentity()).toMatchObject({ signedIn: true })
  })

  it('the sign-in sheet closed with Done shows the account signed in (the control)', async () => {
    await signInSheetFor()
    mainSignsIn('codedev@example.test')
    fireEvent.click(await screen.findByTestId('sign-in-done'))
    await settle()
    expect(storeIdentity()).toMatchObject({ signedIn: true })
  })

  it('reads nothing at a sign-in that did not finish, and a read that fails leaves the view as it was', async () => {
    const api = await signInSheetFor()
    const before = api.list.mock.calls.length
    act(() => { for (const cb of listeners) cb({ sessionId: 's1', accountId: 'acc_new', agent: 'claude', phase: { kind: 'cancelled' } }) })
    await settle()
    expect(api.list.mock.calls.length).toBe(before)
    api.list.mockRejectedValueOnce(new Error('main went away'))
    mainSignsIn('codedev@example.test')
    await settle()
    expect(storeIdentity()?.signedIn).toBe(false)
  })
})
