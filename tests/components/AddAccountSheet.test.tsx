// Add account (src/renderer/src/components/Accounts/AddAccountSheet.tsx, the in-app account UI
// §2.5): the wizard in a sheet. 1 Name and colour (email, Offer automatically, Connect with what it
// writes; the folder, shares and copy under Advanced); 2 Sign in, the sheet's own steps inline
// (SignInFlow, here a stand-in), or Skip for now; 3 Done, with the email it signed in as. agy: a
// name, a colour and its Google email, then Done. Main is the preload's mock.
import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { AddAccountResult, AccountRowView, AccountsView } from '../../src/shared/agentAccounts'

vi.mock('../../src/renderer/src/components/Accounts/SignInFlow', () => ({
  SignInFlow: (p: { account: { id: string }; doneLabel?: string; onDone: (email: string | null) => void; onCancel: () => void }) => (
    <div data-testid="flow" data-account={p.account.id} data-done-label={p.doneLabel}>
      <button type="button" onClick={() => p.onDone('w@example.test')}>flow-done</button>
      <button type="button" onClick={() => p.onCancel()}>flow-cancel</button>
    </div>
  ),
}))

import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { AddAccountSheet, CONNECT_DATA_LINE } from '../../src/renderer/src/components/Accounts/AddAccountSheet'

const HOME = 'C:\\Users\\me'

function accountRow(over: Partial<AccountRowView> = {}): AccountRowView {
  return {
    id: 'acc_000000000001', agent: 'claude', label: 'work', profile: `${HOME}\\.claude-work`, folder: `${HOME}\\.claude-work`,
    isDefault: false, autoOffer: true, order: 1, connect: false, origin: 'created', folderExists: true, shares: [],
    lastEmail: null, connection: null, bypassReady: false, terminals: 0, recopyAvailable: false, ...over,
  }
}

function view(over: Partial<AccountsView> = {}): AccountsView {
  return {
    accounts: [], preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
    advice: { stopFailureHooks: [], authOverrides: [] }, home: HOME, ...over,
  }
}

function result(over: Partial<AddAccountResult> = {}): AddAccountResult {
  return { account: accountRow(), leftOut: [], copied: [], changes: [], ...over }
}

function bridge(over: Record<string, unknown> = {}) {
  const accounts = {
    add: vi.fn(async () => ({ success: true, data: result() })),
    pickFolder: vi.fn(async () => ({ success: true, data: { folder: '~\\.claude-old', isDefault: false, shares: ['projects'], exists: true } })),
    list: vi.fn(async () => ({ success: true, data: view({ accounts: [accountRow()] }) })),
    ...over,
  }
  ;(window as any).accounts = accounts
  ;(window as any).termpolis = { clipboardWriteText: vi.fn(async () => ({ success: true })) }
  return accounts
}

function open(agent: 'claude' | 'codex' | 'agy' = 'claude', v: AccountsView | null = view()) {
  useTerminalStore.setState({ accountsView: v, addAccountSheet: { agent } })
  return render(<AddAccountSheet />)
}

const box = (id: string) => screen.getByTestId(id) as HTMLInputElement
const type = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } })
const st = useTerminalStore.getState

beforeEach(() => {
  useTerminalStore.setState({ addAccountSheet: null, signInSheet: null })
})

afterEach(() => {
  delete (window as any).accounts
  delete (window as any).termpolis
})

describe('when the wizard shows', () => {
  it('shows nothing until it is opened', () => {
    bridge()
    useTerminalStore.setState({ addAccountSheet: null, accountsView: view() })
    const { container } = render(<AddAccountSheet />)
    expect(container.innerHTML).toBe('')
  })

  it('says it can\'t add before the accounts were read, or in a build with no accounts', () => {
    bridge()
    const { unmount } = open('claude', null)
    expect(screen.getByTestId('add-account-unavailable')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Close'))
    expect(st().addAccountSheet).toBeNull()
    unmount()
    delete (window as any).accounts
    open('codex')
    expect(screen.getByTestId('add-account-unavailable')).toBeInTheDocument()
  })
})

describe('step 1, name and colour: a Claude Code account in a new folder', () => {
  it('names the folder from the label, shares the default subfolders, copies, and connects only when offered (R17)', async () => {
    const api = bridge()
    open()
    expect(document.getElementById('add-account-title')).toHaveTextContent('Add a Claude Code account')
    expect(screen.getByTestId('add-account-folder')).toHaveTextContent('~\\.claude-…')
    type('add-account-label', 'Side Project')
    expect(screen.getByTestId('add-account-folder')).toHaveTextContent('~\\.claude-side-project')
    for (const name of ['projects', 'commands', 'skills', 'agents']) expect(box(`add-account-share-${name}`).checked).toBe(true)
    for (const name of ['plugins', 'hooks']) expect(box(`add-account-share-${name}`).checked).toBe(false)
    expect(box('add-account-copy').checked).toBe(true)
    expect(box('add-account-auto-offer').checked).toBe(true)
    expect(box('add-account-connect-box').checked).toBe(true)
    expect(screen.getByTestId('add-account-connect')).toHaveTextContent(CONNECT_DATA_LINE)
    // Learning is not gated by the tick (design 10, PRIVACY.md): the line says so rather than imply it is.
    expect(CONNECT_DATA_LINE).toContain('Learning reads the conversations of every registered account, connected or not.')
    expect(screen.getByTestId('add-account-writes')).toHaveTextContent('.claude.json')
    // Not offered automatically: Connect follows, until ticked by hand.
    fireEvent.click(box('add-account-auto-offer'))
    expect(box('add-account-connect-box').checked).toBe(false)
    fireEvent.click(box('add-account-connect-box'))
    expect(box('add-account-connect-box').checked).toBe(true)
    fireEvent.click(box('add-account-auto-offer'))
    fireEvent.click(box('add-account-auto-offer'))
    expect(box('add-account-connect-box').checked).toBe(true)
    fireEvent.click(box('add-account-share-plugins'))
    fireEvent.click(box('add-account-share-agents'))
    fireEvent.click(box('add-account-copy'))
    type('add-account-email', ' s@example.test ')
    expect(screen.getByTestId('add-account-submit')).toHaveTextContent('Add and sign in')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await waitFor(() => expect(api.add).toHaveBeenCalled())
    expect(api.add).toHaveBeenCalledWith({
      agent: 'claude', label: 'Side Project', email: 's@example.test', autoOffer: false, color: '#D97706', folder: 'new',
      share: ['projects', 'commands', 'skills', 'plugins'], copy: false, connect: true,
    })
    // The chips, the menu and Settings read the new account at once.
    expect(await screen.findByTestId('add-account-sign-in-step')).toBeInTheDocument()
    expect(api.list).toHaveBeenCalled()
    expect(st().accountsView?.accounts.map((r) => r.id)).toEqual(['acc_000000000001'])
  })

  it('picks a colour: the first one the agent\'s accounts don\'t have yet, or the user\'s', async () => {
    const api = bridge()
    open('claude', view({ accounts: [accountRow({ id: 'a', color: undefined }), accountRow({ id: 'b', color: '#10b981' })] }))
    const radios = screen.getAllByTestId('add-account-color')
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.getAttribute('aria-label'))).toEqual(['#4285F4'])
    fireEvent.click(radios.find((r) => r.getAttribute('aria-label') === '#c678dd')!)
    expect(screen.getByRole('radio', { name: '#c678dd' })).toHaveAttribute('aria-checked', 'true')
    type('add-account-label', 'ok')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await waitFor(() => expect(api.add).toHaveBeenCalled())
    expect(api.add.mock.calls[0][0]).toMatchObject({ color: '#c678dd' })
  })

  it('warns when the conversations folder isn\'t shared', () => {
    bridge()
    open()
    expect(screen.queryByTestId('add-account-projects-warning')).toBeNull()
    fireEvent.click(box('add-account-share-projects'))
    expect(screen.getByTestId('add-account-projects-warning')).toHaveTextContent('won\'t follow this account')
  })

  it('refuses a name that gives no folder, and an email that isn\'t plain, before asking main', () => {
    const api = bridge()
    open()
    const submit = screen.getByTestId('add-account-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    type('add-account-label', '!!!')
    expect(screen.getByTestId('add-account-slug-error')).toHaveTextContent('Use letters or digits')
    expect(submit.disabled).toBe(true)
    type('add-account-label', 'ok')
    expect(submit.disabled).toBe(false)
    type('add-account-email', 'not an address')
    expect(screen.getByTestId('add-account-email-error')).toBeInTheDocument()
    expect(submit.disabled).toBe(true)
    expect(api.add).not.toHaveBeenCalled()
  })

  it('says why main refused, and leaves the form as it was', async () => {
    bridge({ add: vi.fn(async () => ({ success: false, error: 'Claude Code already has an account named ok' })) })
    open()
    type('add-account-label', 'ok')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    expect(await screen.findByTestId('add-account-error')).toHaveTextContent('already has an account named ok')
    expect((screen.getByTestId('add-account-label') as HTMLInputElement).value).toBe('ok')
  })

  it('reports a bridge that throws, an Error or not', async () => {
    bridge({ add: vi.fn().mockRejectedValueOnce(new Error('IPC gone')).mockRejectedValueOnce('a bare string') })
    open()
    type('add-account-label', 'ok')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    expect(await screen.findByTestId('add-account-error')).toHaveTextContent('IPC gone')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await waitFor(() => expect(screen.getByTestId('add-account-error')).toHaveTextContent('a bare string'))
  })

  it('can\'t be closed while it adds, and says so on its button', async () => {
    let finish!: (v: unknown) => void
    bridge({ add: vi.fn(() => new Promise((resolve) => { finish = resolve })) })
    open()
    type('add-account-label', 'ok')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    expect(screen.getByTestId('add-account-submit')).toHaveTextContent('Adding…')
    // The sheet's own close button is gone too.
    expect(screen.queryByTestId('add-account-close')).toBeNull()
    fireEvent.keyDown(screen.getByTestId('add-account'), { key: 'Escape' })
    expect(st().addAccountSheet).not.toBeNull()
    await act(async () => { finish({ success: false, error: 'x' }) })
    expect(screen.getByTestId('add-account-submit')).toHaveTextContent('Add and sign in')
  })

  it('names the new folder with the home folder\'s own separator on macOS and Linux', () => {
    bridge()
    open('claude', view({ home: '/home/me' }))
    type('add-account-label', 'side')
    expect(screen.getByTestId('add-account-folder')).toHaveTextContent('~/.claude-side')
  })

  it('can\'t connect while Agent Integration is off, and says so', async () => {
    const api = bridge()
    open('claude', view({ integrationConnected: false }))
    expect(box('add-account-connect-box').checked).toBe(false)
    expect(box('add-account-connect-box').disabled).toBe(true)
    expect(screen.getByTestId('add-account-connect-off')).toHaveTextContent('Turn on Agent Integration first')
    type('add-account-label', 'ok')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await waitFor(() => expect(api.add).toHaveBeenCalled())
    expect(api.add.mock.calls[0][0]).toMatchObject({ connect: false })
  })

  it('cancels without asking main', () => {
    const api = bridge()
    open()
    fireEvent.click(screen.getByTestId('add-account-cancel'))
    expect(st().addAccountSheet).toBeNull()
    expect(api.add).not.toHaveBeenCalled()
  })
})

describe('step 1, Advanced: an existing folder', () => {
  it('adopts the folder main\'s own dialog picked, and shows what it shares', async () => {
    const api = bridge()
    open()
    type('add-account-label', 'old')
    const choose = screen.getByTestId('add-account-choose') as HTMLButtonElement
    expect(choose.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('add-account-existing'))
    // No share or copy for a folder that already exists.
    expect(screen.queryByTestId('add-account-share')).toBeNull()
    expect((screen.getByTestId('add-account-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(choose)
    expect(await screen.findByTestId('add-account-picked')).toHaveTextContent('~\\.claude-old · shares projects with your main profile')
    expect(api.pickFolder).toHaveBeenCalledWith('claude')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await waitFor(() => expect(api.add).toHaveBeenCalled())
    expect(api.add.mock.calls[0][0]).toMatchObject({ agent: 'claude', label: 'old', folder: 'existing' })
  })

  it('goes back to a new folder, sharing and copying again', () => {
    bridge()
    open()
    fireEvent.click(screen.getByTestId('add-account-existing'))
    expect(screen.queryByTestId('add-account-share')).toBeNull()
    fireEvent.click(screen.getByTestId('add-account-new'))
    expect(screen.getByTestId('add-account-share')).toBeInTheDocument()
    expect((screen.getByTestId('add-account-choose') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows why a picked folder can\'t be a profile, and the main profile as such', async () => {
    const pick = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { folder: '~', error: 'your home folder itself can\'t be a profile' } })
      .mockResolvedValueOnce({ success: true, data: { folder: '~\\.claude', isDefault: true, shares: [], exists: true } })
      .mockResolvedValueOnce({ success: true, data: { folder: null } })
      .mockResolvedValueOnce({ success: false, error: 'no window' })
      .mockRejectedValueOnce('a bare string')
    bridge({ pickFolder: pick })
    open()
    type('add-account-label', 'x')
    fireEvent.click(screen.getByTestId('add-account-existing'))
    fireEvent.click(screen.getByTestId('add-account-choose'))
    expect(await screen.findByTestId('add-account-picked')).toHaveTextContent('~: your home folder itself can\'t be a profile')
    expect((screen.getByTestId('add-account-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('add-account-choose'))
    await waitFor(() => expect(screen.getByTestId('add-account-picked')).toHaveTextContent('~\\.claude (your main profile)'))
    expect((screen.getByTestId('add-account-submit') as HTMLButtonElement).disabled).toBe(false)
    // A cancelled dialog forgets the pick.
    fireEvent.click(screen.getByTestId('add-account-choose'))
    await waitFor(() => expect(screen.queryByTestId('add-account-picked')).toBeNull())
    fireEvent.click(screen.getByTestId('add-account-choose'))
    expect(await screen.findByTestId('add-account-error')).toHaveTextContent('no window')
    fireEvent.click(screen.getByTestId('add-account-choose'))
    await waitFor(() => expect(screen.getByTestId('add-account-error')).toHaveTextContent('a bare string'))
  })
})

describe('Codex and agy', () => {
  it('shares Codex\'s sessions, copies config.toml, and warns when sessions aren\'t shared', () => {
    bridge()
    open('codex')
    expect(screen.getByTestId('add-account-folder')).toHaveTextContent('~\\.codex-…')
    expect(box('add-account-share-sessions').checked).toBe(true)
    expect(screen.getByText('Start from a copy of my config.toml')).toBeInTheDocument()
    fireEvent.click(box('add-account-share-sessions'))
    expect(screen.getByTestId('add-account-sessions-warning')).toBeInTheDocument()
    expect(screen.getByTestId('add-account-writes')).toHaveTextContent('config.toml')
  })

  it('keeps an agy account to a name, a colour and a Google email: no folder, nothing to connect, no sign-in step', async () => {
    const api = bridge({ add: vi.fn(async () => ({ success: true, data: result({ account: accountRow({ agent: 'agy', label: 'g', profile: null, folder: null, folderExists: false }) }) })) })
    open('agy')
    expect(screen.queryByTestId('add-account-folder')).toBeNull()
    expect(screen.queryByTestId('add-account-connect')).toBeNull()
    expect(screen.getByText(/one Google sign-in for your whole computer user/)).toBeInTheDocument()
    type('add-account-label', 'g')
    type('add-account-email', 'g@example.test')
    expect(screen.getByTestId('add-account-submit')).toHaveTextContent(/^Add$/)
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await waitFor(() => expect(api.add).toHaveBeenCalledWith({ agent: 'agy', label: 'g', email: 'g@example.test', autoOffer: true, color: '#4285F4' }))
    const done = await screen.findByTestId('add-account-done')
    expect(screen.getByTestId('add-account-done-headline').textContent).toBe('Added g.')
    expect(done).toHaveTextContent('Switching Gemini CLI to it signs agy in as it, for every Gemini terminal.')
    expect(screen.queryByTestId('add-account-sign-in-step')).toBeNull()
    expect(screen.queryByTestId('add-account-advanced-done')).toBeNull()
  })
})

describe('step 2, sign in, and step 3, done', () => {
  async function toSignIn(data: AddAccountResult = result()) {
    bridge({ add: vi.fn(async () => ({ success: true, data })) })
    open()
    type('add-account-label', 'work')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    return screen.findByTestId('add-account-sign-in-step')
  }

  it('signs the new account in, inline, then says who it signed in as', async () => {
    await toSignIn()
    expect(screen.getByTestId('flow')).toHaveAttribute('data-account', 'acc_000000000001')
    expect(screen.getByTestId('flow')).toHaveAttribute('data-done-label', 'Next')
    fireEvent.click(screen.getByText('flow-done'))
    expect(screen.getByTestId('add-account-done-headline').textContent).toBe('work is signed in as w@example.test.')
    fireEvent.click(screen.getByTestId('add-account-finish'))
    expect(st().addAccountSheet).toBeNull()
  })

  it('goes on unsigned when the sign-in is cancelled or skipped, saying where to sign it in later', async () => {
    await toSignIn()
    fireEvent.click(screen.getByText('flow-cancel'))
    expect(screen.getByTestId('add-account-done-headline').textContent).toBe('Added work. It isn\'t signed in yet.')
    expect(screen.getByTestId('add-account-done')).toHaveTextContent('Sign it in from its card in Settings ▸ Accounts')
  })

  it('skips the sign-in for now', async () => {
    await toSignIn()
    fireEvent.click(screen.getByTestId('add-account-skip'))
    expect(screen.getByTestId('add-account-done-headline').textContent).toBe('Added work. It isn\'t signed in yet.')
    expect(screen.queryByTestId('flow')).toBeNull()
  })

  it('lists the notes, the folder, the copy, what was left out, the writes, and the accounts.sh lines with Copy', async () => {
    await toSignIn(result({
      notes: ['Your main Claude Code profile is listed too, as main.'],
      copied: ['settings.json', 'CLAUDE.md'],
      leftOut: ['env', 'apiKeyHelper'],
      changes: [
        { agent: 'claude', file: `${HOME}\\.claude-work\\.claude.json`, action: 'add', what: 'MCP server' },
        { agent: 'claude', file: `${HOME}\\.claude-work\\settings.json`, action: 'skipped', what: 'Tool permissions', error: 'EACCES' },
      ],
      accountsShLines: ['ACCOUNTS=(personal work)   # add work', '  [work]=""   # in ACCOUNT_EMAIL'],
    }))
    fireEvent.click(screen.getByTestId('add-account-skip'))
    expect(screen.getByTestId('add-account-advanced-done')).toHaveTextContent('~\\.claude-work')
    expect(screen.getByTestId('add-account-note')).toHaveTextContent('listed too, as main')
    expect(screen.getByTestId('add-account-copied')).toHaveTextContent('settings.json, CLAUDE.md')
    expect(screen.getByTestId('add-account-left-out')).toHaveTextContent('env, apiKeyHelper')
    expect(screen.getByTestId('add-account-changes')).toHaveTextContent('skipped Tool permissions: EACCES')
    fireEvent.click(screen.getByTestId('add-account-copy-lines'))
    await waitFor(() => expect((window as any).termpolis.clipboardWriteText).toHaveBeenCalledWith('ACCOUNTS=(personal work)   # add work\n  [work]=""   # in ACCOUNT_EMAIL'))
    expect(await screen.findByText('Copied')).toBeInTheDocument()
  })

  it('shows Advanced for what was made even without a folder, and nothing of it with nothing made', async () => {
    await toSignIn(result({ account: accountRow({ folder: null }), copied: ['settings.json'] }))
    fireEvent.click(screen.getByTestId('add-account-skip'))
    expect(screen.getByTestId('add-account-advanced-done')).toHaveTextContent('Copied: settings.json')
  })

  it('says nothing was copied when the clipboard refuses or throws', async () => {
    await toSignIn(result({ accountsShLines: ['x'] }))
    ;(window as any).termpolis = { clipboardWriteText: vi.fn().mockResolvedValueOnce({ success: false, error: 'no' }).mockRejectedValueOnce(new Error('gone')) }
    fireEvent.click(screen.getByTestId('add-account-skip'))
    fireEvent.click(screen.getByTestId('add-account-copy-lines'))
    await waitFor(() => expect((window as any).termpolis.clipboardWriteText).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('add-account-copy-lines'))
    await waitFor(() => expect((window as any).termpolis.clipboardWriteText).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Copied')).toBeNull()
  })
})

describe('the wizard by keyboard alone', () => {
  /** What a browser does: nothing inside a closed <details> but its summary takes the focus. */
  function browserFocus(): () => void {
    const original = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (this: HTMLElement, ...args: []) {
      const details = this.closest('details')
      if (details && !details.open && !(this.tagName === 'SUMMARY' && this.parentElement === details)) return
      return original.apply(this, args)
    }
    return () => { HTMLElement.prototype.focus = original }
  }
  const nameOf = (el: Element | null): string => (el ? (el as HTMLElement).getAttribute('data-testid') ?? el.tagName.toLowerCase() : 'null')

  it('reaches the Advanced toggle, Add and Cancel with Tab, though the closed Advanced hides its controls', () => {
    const restore = browserFocus()
    try {
      bridge()
      open('claude')
      type('add-account-label', 'codedev')
      const seen: string[] = []
      const stops: Array<Element | null> = []
      for (let i = 0; i < 40; i++) {
        fireEvent.keyDown(document.activeElement ?? screen.getByRole('dialog'), { key: 'Tab' })
        seen.push(nameOf(document.activeElement))
        stops.push(document.activeElement)
      }
      expect(seen).toContain('summary')
      expect(seen).toContain('add-account-submit')
      expect(seen).toContain('add-account-cancel')
      // Not one stop is stuck: the same control never takes Tab twice in a row.
      expect(stops.some((el, i) => i > 0 && el === stops[i - 1])).toBe(false)
    } finally {
      restore()
    }
  })
})
