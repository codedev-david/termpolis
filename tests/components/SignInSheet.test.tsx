import React from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SignInSheet } from '../../src/renderer/src/components/Accounts/SignInSheet'
import { Sheet } from '../../src/renderer/src/components/Accounts/Sheet'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { SignInPhase, SignInState } from '../../src/shared/signInScreens'

function row(over: Partial<AccountRowView> = {}): AccountRowView {
  return {
    id: 'acc_b', agent: 'claude', label: 'codedev', email: 'b@example.test', profile: 'C:\\h\\.claude-codedev', folder: 'C:\\h\\.claude-codedev',
    isDefault: false, autoOffer: true, order: 1, connect: true, origin: 'created', folderExists: true, shares: [], lastEmail: null,
    connection: null, bypassReady: true, terminals: 0, recopyAvailable: false, ...over,
  }
}
const VIEW: AccountsView = { accounts: [row()], preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: 'C:\\h' }

let listener: ((s: SignInState) => void) | null
let accounts: Record<string, ReturnType<typeof vi.fn>>

function emit(phase: SignInPhase): void {
  act(() => listener!({ sessionId: 's1', accountId: 'acc_b', agent: 'claude', phase }))
}

beforeEach(() => {
  listener = null
  accounts = {
    list: vi.fn(async () => ({ success: true, data: VIEW })),
    signInStart: vi.fn(async () => ({ success: true, data: { sessionId: 's1' } })),
    signInInput: vi.fn(async () => ({ success: true, data: { ok: true } })),
    onSignInState: vi.fn((cb: (s: SignInState) => void) => { listener = cb; return () => { listener = null } }),
  }
  ;(window as any).accounts = accounts
  ;(window as any).termpolis = { clipboardWriteText: vi.fn(async () => ({ success: true })) }
  useTerminalStore.setState({ accountsView: VIEW, signInSheet: null })
})

afterEach(() => {
  cleanup()
  delete (window as any).accounts
  delete (window as any).termpolis
})

describe('SignInSheet', () => {
  it('shows nothing until it is opened', () => {
    render(<SignInSheet />)
    expect(screen.queryByTestId('sign-in-sheet')).toBeNull()
  })

  it('opens for the account, as a modal titled for it, with its methods first', () => {
    useTerminalStore.getState().openSignInSheet('acc_b')
    render(<SignInSheet />)
    const sheet = screen.getByRole('dialog', { name: 'Sign in to codedev · Claude Code' })
    expect(sheet).toHaveAttribute('aria-modal', 'true')
    expect(sheet).toHaveTextContent('b@example.test')
    // Its first choice holds the keyboard.
    expect(document.activeElement).toBe(screen.getByTestId('sign-in-method-claudeai'))
  })

  it('says so when the account went, and closes', () => {
    useTerminalStore.getState().openSignInSheet('acc_gone')
    render(<SignInSheet />)
    expect(screen.getByTestId('sign-in-gone')).toHaveTextContent('That account isn\'t registered any more.')
    fireEvent.click(screen.getByText('Close'))
    expect(useTerminalStore.getState().signInSheet).toBeNull()
  })

  it('says so too before the accounts were ever read', () => {
    useTerminalStore.setState({ accountsView: null })
    useTerminalStore.getState().openSignInSheet('acc_b')
    render(<SignInSheet />)
    expect(screen.getByTestId('sign-in-gone')).toBeInTheDocument()
  })

  it('closes on Esc and on its close button, ending the sign-in it started', async () => {
    useTerminalStore.getState().openSignInSheet('acc_b')
    const { rerender } = render(<SignInSheet />)
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-method-claudeai')) })
    fireEvent.keyDown(screen.getByTestId('sign-in-sheet'), { key: 'Escape' })
    expect(useTerminalStore.getState().signInSheet).toBeNull()
    rerender(<SignInSheet />)
    expect(accounts.signInInput).toHaveBeenCalledWith('s1', { kind: 'cancel' })
    useTerminalStore.getState().openSignInSheet('acc_b')
    rerender(<SignInSheet />)
    fireEvent.click(screen.getByTestId('sign-in-sheet-close'))
    expect(useTerminalStore.getState().signInSheet).toBeNull()
  })

  it('leaves keys other than Esc to the sheet', () => {
    useTerminalStore.getState().openSignInSheet('acc_b')
    render(<SignInSheet />)
    fireEvent.keyDown(screen.getByTestId('sign-in-sheet'), { key: 'a' })
    expect(useTerminalStore.getState().signInSheet).not.toBeNull()
  })

  it('reads the accounts again once it signed in, and closes on Done', async () => {
    useTerminalStore.getState().openSignInSheet('acc_b')
    render(<SignInSheet />)
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-method-claudeai')) })
    emit({ kind: 'success', email: 'b@example.test' })
    expect(screen.getByTestId('sign-in-done')).toHaveTextContent('Done')
    fireEvent.click(screen.getByTestId('sign-in-done'))
    expect(accounts.list).toHaveBeenCalled()
    expect(useTerminalStore.getState().signInSheet).toBeNull()
  })

  it('goes on with what asked for the sign-in, by itself, once it signed in', async () => {
    const then = vi.fn()
    useTerminalStore.getState().openSignInSheet('acc_b', then)
    render(<SignInSheet />)
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-method-claudeai')) })
    emit({ kind: 'success', email: 'b@example.test' })
    expect(then).toHaveBeenCalledTimes(1)
    expect(useTerminalStore.getState().signInSheet).toBeNull()
  })

  it('names what comes next on its button when the sign-in needs a word first', async () => {
    useTerminalStore.getState().openSignInSheet('acc_b', vi.fn())
    render(<SignInSheet />)
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-method-claudeai')) })
    emit({ kind: 'success', email: 'other@example.test' })
    expect(screen.getByTestId('sign-in-done')).toHaveTextContent('Switch to codedev')
  })

  it('cancels with Cancel before main gave the sign-in a session, and ends the session main then gives it', async () => {
    let release: (v: unknown) => void = () => undefined
    accounts.signInStart.mockReturnValueOnce(new Promise((r) => { release = r }))
    useTerminalStore.getState().openSignInSheet('acc_b')
    render(<SignInSheet />)
    fireEvent.click(screen.getByTestId('sign-in-method-claudeai'))
    fireEvent.click(screen.getByTestId('sign-in-cancel'))
    expect(useTerminalStore.getState().signInSheet).toBeNull()
    // Nothing to cancel yet ...
    expect(accounts.signInInput).not.toHaveBeenCalled()
    // ... and the session main starts after all is ended at once, not left to its timeout.
    await act(async () => { release({ success: true, data: { sessionId: 's1' } }) })
    expect(accounts.signInInput).toHaveBeenCalledTimes(1)
    expect(accounts.signInInput).toHaveBeenCalledWith('s1', { kind: 'cancel' })
  })
})

describe('Sheet: the keyboard stays in it', () => {
  function Host({ open, empty = false }: { open: boolean; empty?: boolean }) {
    return (
      <>
        <button data-testid="before">terminal</button>
        {open && (
          <Sheet title="T" icon="fa-x" testId="s" {...(empty ? {} : { onClose: () => undefined })}>
            {empty ? <p>nothing to press</p> : <><button data-testid="one">one</button><button disabled>off</button><button data-testid="two">two</button></>}
          </Sheet>
        )}
      </>
    )
  }

  it('goes round its controls with Tab and Shift+Tab, and gives the focus back when it closes', () => {
    const { rerender } = render(<Host open={false} />)
    screen.getByTestId('before').focus()
    rerender(<Host open />)
    const sheet = screen.getByTestId('s')
    // Its close button first, then its own controls, the disabled one skipped.
    expect(document.activeElement).toBe(screen.getByTestId('s-close'))
    fireEvent.keyDown(sheet, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByTestId('one'))
    fireEvent.keyDown(sheet, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByTestId('two'))
    fireEvent.keyDown(sheet, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByTestId('s-close'))
    fireEvent.keyDown(sheet, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('two'))
    fireEvent.keyDown(sheet, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('one'))
    screen.getByTestId('s-close').focus()
    fireEvent.keyDown(sheet, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('two'))
    // Focus somewhere outside its list (the sheet itself): Tab takes the first control.
    sheet.focus()
    fireEvent.keyDown(sheet, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByTestId('s-close'))
    fireEvent.keyDown(sheet, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('s-close'))
    rerender(<Host open={false} />)
    expect(document.activeElement).toBe(screen.getByTestId('before'))
  })

  it('holds the focus on itself when it has nothing to press, and can\'t be closed then', () => {
    render(<Host open empty />)
    const sheet = screen.getByTestId('s')
    expect(document.activeElement).toBe(sheet)
    fireEvent.keyDown(sheet, { key: 'Tab' })
    expect(document.activeElement).toBe(sheet)
    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(screen.getByTestId('s')).toBeInTheDocument()
    expect(screen.queryByTestId('s-close')).toBeNull()
  })

  it('gives the focus back to nothing that went away meanwhile', () => {
    // An element outside React's tree, as the terminal's own textarea is to the sheet.
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    const { rerender } = render(<Host open />)
    outside.remove()
    rerender(<Host open={false} />)
    expect(document.activeElement).not.toBe(outside)
  })
})
