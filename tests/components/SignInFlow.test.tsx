import React from 'react'
import { render, screen, fireEvent, waitFor, act, cleanup, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SignInFlow } from '../../src/renderer/src/components/Accounts/SignInFlow'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { SignInPhase, SignInState } from '../../src/shared/signInScreens'

function row(over: Partial<AccountRowView> = {}): AccountRowView {
  return {
    id: 'acc_b', agent: 'claude', label: 'codedev', email: 'b@example.test', profile: 'C:\\h\\.claude-codedev', folder: 'C:\\h\\.claude-codedev',
    isDefault: false, autoOffer: true, order: 1, connect: true, origin: 'created', folderExists: true, shares: [], lastEmail: null,
    connection: null, bypassReady: true, terminals: 0, recopyAvailable: false, ...over,
  }
}
const B = row()
const A = row({ id: 'acc_a', label: 'personal', email: 'a@example.test', lastEmail: 'a@example.test' })
const VIEW: AccountsView = { accounts: [A, B], preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: 'C:\\h' }
const URL_ = 'https://claude.com/cai/oauth/authorize?code=true&state=x'

let listener: ((s: SignInState) => void) | null
let accounts: Record<string, ReturnType<typeof vi.fn>>
let clipboard: ReturnType<typeof vi.fn>

function emit(phase: SignInPhase, sessionId = 's1'): void {
  act(() => listener!({ sessionId, accountId: 'acc_b', agent: 'claude', phase }))
}

function flow(props: Partial<React.ComponentProps<typeof SignInFlow>> = {}) {
  const onDone = vi.fn()
  const onCancel = vi.fn()
  const r = render(<SignInFlow account={B} view={VIEW} onDone={onDone} onCancel={onCancel} {...props} />)
  return { onDone, onCancel, ...r }
}

/** Starts a sign-in with its agent's first method, and lets main's answer land. */
async function started(props: Partial<React.ComponentProps<typeof SignInFlow>> = {}) {
  const f = flow(props)
  const first = props.account?.agent === 'codex' ? 'browser' : 'claudeai'
  await act(async () => { fireEvent.click(screen.getByTestId(`sign-in-method-${first}`)) })
  return f
}

beforeEach(() => {
  listener = null
  accounts = {
    signInStart: vi.fn(async () => ({ success: true, data: { sessionId: 's1' } })),
    signInInput: vi.fn(async () => ({ success: true, data: { ok: true } })),
    onSignInState: vi.fn((cb: (s: SignInState) => void) => { listener = cb; return () => { listener = null } }),
  }
  ;(window as any).accounts = accounts
  clipboard = vi.fn(async () => ({ success: true }))
  ;(window as any).termpolis = { clipboardWriteText: clipboard }
})

afterEach(() => {
  cleanup()
  delete (window as any).accounts
  delete (window as any).termpolis
})

describe('SignInFlow: how to sign in', () => {
  it('offers Claude Code\'s methods, and starts the one clicked in main\'s hidden session', async () => {
    flow()
    expect(screen.getByText('How do you sign in to Claude Code?')).toBeInTheDocument()
    expect(screen.getByTestId('sign-in-method-claudeai')).toHaveTextContent('Claude subscription')
    expect(screen.getByTestId('sign-in-method-console')).toHaveTextContent('Anthropic Console')
    expect(screen.queryByTestId('sign-in-resign-warning')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-method-sso')) })
    expect(accounts.signInStart).toHaveBeenCalledWith({ accountId: 'acc_b', method: 'sso' })
    expect(screen.getByTestId('sign-in-waiting')).toHaveTextContent('Starting Claude Code\'s sign-in…')
  })

  it('offers Codex its browser sign-in and its code', () => {
    flow({ account: row({ agent: 'codex' }) })
    expect(screen.getByTestId('sign-in-method-browser')).toHaveTextContent('ChatGPT account')
    expect(screen.getByTestId('sign-in-method-device')).toHaveTextContent('Use this if the browser can\'t reach this computer')
  })

  it('warns before a profile that had a sign-in is signed in again (R29)', () => {
    flow({ account: row({ lastEmail: 'b@example.test', terminals: 2 }) })
    expect(screen.getByTestId('sign-in-resign-warning')).toHaveTextContent('Close the 2 Termpolis terminals on codedev first.')
  })

  it('starts at once with the method given, or for agy\'s switch, which has none', async () => {
    flow({ method: 'console' })
    await waitFor(() => expect(accounts.signInStart).toHaveBeenCalledWith({ accountId: 'acc_b', method: 'console' }))
    cleanup()
    flow({ account: row({ agent: 'agy', profile: null }), mode: 'agy-switch' })
    await waitFor(() => expect(accounts.signInStart).toHaveBeenLastCalledWith({ accountId: 'acc_b', mode: 'agy-switch' }))
    expect(screen.getByTestId('sign-in-waiting')).toHaveTextContent('Starting agy…')
  })

  it('says why a sign-in couldn\'t start, and tries again from where it was', async () => {
    accounts.signInStart.mockResolvedValueOnce({ success: false, error: 'Claude Code isn\'t installed where Termpolis can find it (not on PATH)' })
    const { onCancel } = await started()
    expect(screen.getByTestId('sign-in-failed-start')).toHaveTextContent('Termpolis couldn\'t start Claude Code\'s sign-in: Claude Code isn\'t installed')
    fireEvent.click(screen.getByTestId('sign-in-retry'))
    expect(screen.getByTestId('sign-in-methods')).toBeInTheDocument()
    accounts.signInStart.mockRejectedValueOnce(new Error('main went away'))
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-method-claudeai')) })
    expect(screen.getByTestId('sign-in-failed-start')).toHaveTextContent('main went away')
    fireEvent.click(screen.getByTestId('sign-in-close'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('tries agy\'s switch again at once: it has no method to go back to', async () => {
    accounts.signInStart.mockRejectedValueOnce('odd')
    flow({ account: row({ agent: 'agy', profile: null }), mode: 'agy-switch' })
    expect(await screen.findByTestId('sign-in-failed-start')).toHaveTextContent('odd')
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-retry')) })
    expect(accounts.signInStart).toHaveBeenCalledTimes(2)
  })
})

describe('SignInFlow: the CLI\'s steps', () => {
  it('takes a state that came before its session\'s id, and none of another session\'s', async () => {
    let release: (v: unknown) => void = () => undefined
    accounts.signInStart.mockReturnValueOnce(new Promise((r) => { release = r }))
    flow()
    fireEvent.click(screen.getByTestId('sign-in-method-claudeai'))
    emit({ kind: 'browser', url: URL_, canOpen: true, codeField: false })
    emit({ kind: 'error', message: 'not mine', details: [] }, 'other')
    await act(async () => { release({ success: true, data: { sessionId: 's1' } }) })
    expect(screen.getByTestId('sign-in-browser')).toBeInTheDocument()
    emit({ kind: 'error', message: 'still not mine', details: [] }, 'other')
    expect(screen.getByTestId('sign-in-browser')).toBeInTheDocument()
  })

  it('takes a first state that already ended it', async () => {
    let release: (v: unknown) => void = () => undefined
    accounts.signInStart.mockReturnValueOnce(new Promise((r) => { release = r }))
    flow()
    fireEvent.click(screen.getByTestId('sign-in-method-claudeai'))
    emit({ kind: 'error', message: 'refused at once', details: [] })
    await act(async () => { release({ success: true, data: { sessionId: 's1' } }) })
    expect(screen.getByTestId('sign-in-error')).toHaveTextContent('refused at once')
    // Ended already: no Cancel is sent for it when the flow goes.
    cleanup()
    expect(accounts.signInInput).not.toHaveBeenCalled()
  })

  it('shows the browser step: the address with Copy and Open again, and the code field', async () => {
    await started()
    emit({ kind: 'browser', url: URL_, canOpen: true, codeField: true })
    expect(within(screen.getByTestId('sign-in-browser')).getByText('Finish signing in in your browser.')).toBeInTheDocument()
    expect(screen.getByTestId('sign-in-live')).toHaveTextContent('Finish signing in in your browser.')
    expect(screen.getByTestId('sign-in-address')).toHaveTextContent(URL_)
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-copy-url')) })
    expect(clipboard).toHaveBeenCalledWith(URL_)
    expect(screen.getByTestId('sign-in-copy-url')).toHaveTextContent('Copied')
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-open')) })
    expect(accounts.signInInput).toHaveBeenCalledWith('s1', { kind: 'open' })
    expect(screen.getByText('If the page shows a code, paste it here.')).toBeInTheDocument()
    expect(screen.getByTestId('sign-in-waiting')).toHaveTextContent('Waiting for you to finish in the browser…')
  })

  it('keeps Open again off for an address that isn\'t the provider\'s page, and says a copy that failed', async () => {
    await started()
    emit({ kind: 'browser', url: 'https://elsewhere.test/x', canOpen: false, codeField: false })
    expect(screen.getByTestId('sign-in-open')).toBeDisabled()
    expect(screen.getByTestId('sign-in-open')).toHaveAttribute('title', 'Termpolis opens only the provider\'s own sign-in page.')
    expect(screen.queryByTestId('sign-in-field')).toBeNull()
    clipboard.mockResolvedValueOnce({ success: false })
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-copy-url')) })
    expect(screen.getByTestId('sign-in-copy-url')).toHaveTextContent('Copy')
    clipboard.mockRejectedValueOnce(new Error('no clipboard'))
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-copy-url')) })
    expect(screen.getByTestId('sign-in-copy-url')).toHaveTextContent('Copy')
    emit({ kind: 'browser', url: null, canOpen: false, codeField: false })
    expect(screen.queryByTestId('sign-in-address')).toBeNull()
  })

  it('sends a pasted code to main and clears the field at once: the code is held nowhere here', async () => {
    await started()
    emit({ kind: 'browser', url: URL_, canOpen: true, codeField: true })
    const input = screen.getByTestId('sign-in-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'abc-123' } })
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-submit')) })
    expect(accounts.signInInput).toHaveBeenCalledWith('s1', { kind: 'code', value: 'abc-123' })
    expect(input.value).toBe('')
    // An empty field sends nothing.
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-submit')) })
    expect(accounts.signInInput).toHaveBeenCalledTimes(1)
  })

  it('says why main refused a code, in its words', async () => {
    await started()
    emit({ kind: 'code-wanted', url: URL_, canOpen: true })
    expect(within(screen.getByTestId('sign-in-code-wanted')).getByText('Sign in in your browser, then paste the code.')).toBeInTheDocument()
    const input = screen.getByTestId('sign-in-input') as HTMLInputElement
    for (const [answer, words] of [
      [{ success: true, data: { ok: false, why: 'that doesn\'t look like a sign-in code' } }, 'that doesn\'t look like a sign-in code'],
      [{ success: false, error: 'main said no' }, 'main said no'],
    ] as const) {
      accounts.signInInput.mockResolvedValueOnce(answer)
      fireEvent.change(input, { target: { value: 'x y' } })
      await act(async () => { fireEvent.click(screen.getByTestId('sign-in-submit')) })
      expect(screen.getByTestId('sign-in-input-error')).toHaveTextContent(words)
    }
    accounts.signInInput.mockRejectedValueOnce(new Error('gone'))
    fireEvent.change(input, { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-submit')) })
    expect(screen.getByTestId('sign-in-input-error')).toHaveTextContent('gone')
  })

  it('shows Codex\'s device code large, with Copy code', async () => {
    await started({ account: row({ agent: 'codex' }) })
    emit({ kind: 'device-code', code: 'WXYZ-2345', url: 'https://auth.openai.com/codex/device', canOpen: true })
    expect(screen.getByTestId('sign-in-code')).toHaveTextContent('WXYZ-2345')
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-copy-code')) })
    expect(clipboard).toHaveBeenCalledWith('WXYZ-2345')
    expect(screen.getByTestId('sign-in-copy-code')).toHaveTextContent('Copied')
    expect(screen.getByText(/It expires in 15 minutes/)).toBeInTheDocument()
    emit({ kind: 'device-code', code: 'WXYZ-2345', url: null, canOpen: false })
    expect(screen.queryByText(/It expires in 15 minutes/)).toBeNull()
  })

  it('shows agy\'s question as buttons, and passes on the one clicked', async () => {
    await started()
    emit({ kind: 'choose', question: 'Select login method:', detail: ['Pick one.'], options: ['Continue with Google', 'Use a Google Cloud project'], selected: 1 })
    expect(screen.getByText('Pick one.')).toBeInTheDocument()
    expect(screen.getByTestId('sign-in-option-1')).toHaveAttribute('data-autofocus')
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-option-0')) })
    expect(accounts.signInInput).toHaveBeenCalledWith('s1', { kind: 'pick', index: 0, label: 'Continue with Google' })
  })

  it('takes a Google Cloud project as a value', async () => {
    await started()
    emit({ kind: 'text-wanted', label: 'Google Cloud project ID' })
    fireEvent.change(screen.getByTestId('sign-in-input'), { target: { value: 'my-proj' } })
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-submit')) })
    expect(accounts.signInInput).toHaveBeenCalledWith('s1', { kind: 'text', value: 'my-proj' })
    expect(screen.getByTestId('sign-in-submit')).toHaveTextContent('Continue')
  })

  it('says what it is doing meanwhile, and announces each step', async () => {
    await started()
    for (const [phase, words] of [
      [{ kind: 'signing-out' }, 'Signing agy out…'],
      [{ kind: 'working' }, 'Signing you in…'],
      [{ kind: 'confirming' }, 'Checking your sign-in…'],
      [{ kind: 'starting' }, 'Starting Claude Code\'s sign-in…'],
    ] as const) {
      emit(phase as SignInPhase)
      expect(screen.getByTestId('sign-in-waiting')).toHaveTextContent(words)
    }
    expect(screen.getByTestId('sign-in-live')).toHaveTextContent('Starting Claude Code\'s sign-in.')
  })
})

describe('SignInFlow: how it ends', () => {
  it('says who it signed in as, and Done hands that on', async () => {
    const { onDone } = await started()
    emit({ kind: 'success', email: 'b@example.test', plan: 'max' })
    expect(screen.getByTestId('sign-in-success')).toHaveTextContent('Signed in as b@example.test · max')
    expect(screen.queryByTestId('sign-in-warning')).toBeNull()
    expect(screen.queryByTestId('sign-in-cancel')).toBeNull()
    fireEvent.click(screen.getByTestId('sign-in-done'))
    expect(onDone).toHaveBeenCalledWith('b@example.test')
  })

  it('warns of a sign-in another account has, and of one not the account\'s, with Sign in again', async () => {
    const { onDone } = await started()
    emit({ kind: 'success', email: 'a@example.test' })
    expect(screen.getAllByTestId('sign-in-warning').map((w) => w.textContent)).toEqual([
      'a@example.test is personal\'s sign-in too: switching between codedev and personal changes nothing.',
      'codedev should sign in as b@example.test; it\'s signed in as a@example.test.',
    ])
    fireEvent.click(screen.getByTestId('sign-in-again'))
    expect(screen.getByTestId('sign-in-methods')).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('says Signed in with no email the CLI named', async () => {
    await started()
    emit({ kind: 'success', email: null })
    expect(screen.getByTestId('sign-in-success')).toHaveTextContent('Signed in')
  })

  it('goes on by itself when asked to and nothing needs saying, and waits when something does', async () => {
    const one = await started({ autoDone: true, doneLabel: 'Switch to codedev' })
    emit({ kind: 'success', email: 'b@example.test' })
    expect(one.onDone).toHaveBeenCalledWith('b@example.test')
    cleanup()
    const two = await started({ autoDone: true })
    emit({ kind: 'success', email: 'a@example.test' })
    expect(two.onDone).not.toHaveBeenCalled()
  })

  it('says a failure in the CLI\'s words, with its details on request, Try again and Close', async () => {
    const { onCancel } = await started()
    emit({ kind: 'error', message: 'Invalid code. Please make sure the full code was copied.', details: ['Paste code here > ••••'] })
    expect(screen.getByTestId('sign-in-error')).toHaveTextContent('Claude Code didn\'t sign in: Invalid code. Please make sure the full code was copied..')
    expect(screen.queryByTestId('sign-in-details')).toBeNull()
    fireEvent.click(screen.getByTestId('sign-in-show-details'))
    expect(screen.getByTestId('sign-in-details')).toHaveTextContent('Paste code here > ••••')
    fireEvent.click(screen.getByTestId('sign-in-show-details'))
    expect(screen.queryByTestId('sign-in-details')).toBeNull()
    fireEvent.click(screen.getByTestId('sign-in-retry'))
    expect(screen.getByTestId('sign-in-methods')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-method-claudeai')) })
    emit({ kind: 'error', message: 'The sign-in took longer than 10 minutes, so Termpolis stopped it.', details: [], timeout: true })
    expect(screen.getByTestId('sign-in-error')).toHaveTextContent(/^The sign-in took longer than 10 minutes, so Termpolis stopped it\./)
    expect(screen.queryByTestId('sign-in-show-details')).toBeNull()
    fireEvent.click(screen.getByTestId('sign-in-close'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('tries agy\'s switch again in place after a failure', async () => {
    flow({ account: row({ agent: 'agy', profile: null }), mode: 'agy-switch' })
    await waitFor(() => expect(accounts.signInStart).toHaveBeenCalledTimes(1))
    emit({ kind: 'error', message: 'Error: authentication interrupted.', details: [] })
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-retry')) })
    expect(accounts.signInStart).toHaveBeenCalledTimes(2)
  })

  it('shows a screen it can\'t read as it is, and lets the user type there once they say so', async () => {
    await started()
    emit({ kind: 'unknown', screen: ['Something new', '> '], typing: false })
    const pre = screen.getByTestId('sign-in-screen')
    expect(pre).toHaveTextContent('Something new')
    expect(pre).not.toHaveAttribute('role')
    fireEvent.keyDown(pre, { key: 'a' })
    expect(accounts.signInInput).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-type-here')) })
    expect(accounts.signInInput).toHaveBeenCalledWith('s1', { kind: 'live', on: true })
    emit({ kind: 'unknown', screen: ['Something new', '> '], typing: true })
    const live = screen.getByRole('textbox', { name: 'Type into Claude Code' })
    await act(async () => { fireEvent.keyDown(live, { key: 'Enter' }) })
    expect(accounts.signInInput).toHaveBeenLastCalledWith('s1', { kind: 'keys', data: '\r' })
    await act(async () => { fireEvent.keyDown(live, { key: 'Shift' }) })
    expect(accounts.signInInput).toHaveBeenCalledTimes(2)
  })

  it('says a sign-in was cancelled', async () => {
    await started()
    emit({ kind: 'cancelled' })
    expect(screen.getByTestId('sign-in-cancelled')).toHaveTextContent('The sign-in was cancelled.')
  })

  it('cancels its session with Cancel, and once only, quietly when main is gone', async () => {
    const { onCancel } = await started()
    emit({ kind: 'browser', url: URL_, canOpen: true, codeField: false })
    accounts.signInInput.mockRejectedValueOnce(new Error('gone'))
    await act(async () => { fireEvent.click(screen.getByTestId('sign-in-cancel')) })
    expect(accounts.signInInput).toHaveBeenCalledWith('s1', { kind: 'cancel' })
    expect(onCancel).toHaveBeenCalled()
    cleanup()
    expect(accounts.signInInput).toHaveBeenCalledTimes(1)
  })

  it('cancels a session still running when it goes away, quietly when main is gone too', async () => {
    accounts.signInInput.mockRejectedValue(new Error('gone'))
    await started()
    emit({ kind: 'working' })
    cleanup()
    expect(accounts.signInInput).toHaveBeenCalledWith('s1', { kind: 'cancel' })
  })

  it('has nothing to cancel before main gave it a session', () => {
    const { onCancel, unmount } = flow()
    unmount()
    expect(accounts.signInInput).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })
})
