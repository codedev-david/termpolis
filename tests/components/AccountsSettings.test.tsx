import React from 'react'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import { AccountsSettings, HOOK_CHECK } from '../../src/renderer/src/components/SettingsPane/AccountsSettings'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

const HOME = 'C:\\Users\\me'

function row(over: Partial<AccountRowView> = {}): AccountRowView {
  return {
    id: 'acc_00000000000b', agent: 'claude', label: 'codedev', email: 'b@example.test', profile: `${HOME}\\.claude-codedev`,
    folder: `${HOME}\\.claude-codedev`, isDefault: false, autoOffer: true, order: 1, connect: true, origin: 'adopted',
    folderExists: true, shares: ['projects'], lastEmail: 'b@example.test', connection: { server: true, hook: true, allow: true },
    bypassReady: true, terminals: 0, recopyAvailable: false, ...over,
  }
}

const MAIN = row({ id: 'acc_00000000000a', label: 'personal', email: 'a@example.test', profile: null, folder: `${HOME}\\.claude`, isDefault: true, order: 0, lastEmail: 'a@example.test', shares: [] })
const B = row()

function view(over: Partial<AccountsView> = {}): AccountsView {
  return {
    accounts: [MAIN, B], preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false,
    drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: HOME, ...over,
  }
}

function bridge(initial: AccountsView = view(), over: Record<string, unknown> = {}) {
  const ok = <T,>(data: T) => ({ success: true, data })
  const accounts = {
    list: vi.fn(async () => ok(initial)),
    pickFolder: vi.fn(),
    add: vi.fn(),
    update: vi.fn(async () => ok(B)),
    move: vi.fn(async () => ok(initial)),
    remove: vi.fn(async () => ok({ changes: [{ agent: 'claude', file: `${HOME}\\.claude-codedev\\.claude.json`, action: 'remove', what: 'MCP server' }] })),
    setConnect: vi.fn(async () => ok({ changes: [], account: B })),
    stripCopied: vi.fn(async () => ok({ changes: [{ agent: 'claude', file: 's.json', action: 'remove', what: 'Memory hook', error: 'EBUSY' }] })),
    recopy: vi.fn(async () => ok({ copied: ['settings.json'], leftOut: ['env', 'apiKeyHelper'], changes: [{ agent: 'claude', file: 's.json', action: 'add', what: 'Tool permissions' }], account: B })),
    setPreferred: vi.fn(async () => ok(initial)),
    setChooser: vi.fn(async () => ok(initial)),
    hideAdvice: vi.fn(async () => ok(initial)),
    importPreview: vi.fn(),
    import: vi.fn(),
    check: vi.fn(async () => ok(B)),
    noteLimit: vi.fn(),
    clearLimit: vi.fn(async () => ok(B)),
    ...over,
  }
  ;(window as any).accounts = accounts
  // A shell that speaks once a moment after each subscription, so the launch sequence's wait
  // settles on quiet (150 ms) as at a real prompt, not on its 4 s ceiling.
  let lastTerminal = ''
  const termpolis = {
    getAvailableShells: vi.fn(async () => ok([{ type: 'powershell', name: 'PowerShell', executable: 'powershell.exe' }])),
    clipboardWriteText: vi.fn(async () => ({ success: true })),
    createTerminal: vi.fn(async (id: string) => { lastTerminal = id; return { success: true } }),
    writeToTerminal: vi.fn(),
    onTerminalData: vi.fn((cb: (id: string, data: string) => void) => {
      const timer = setTimeout(() => cb(lastTerminal, 'PS C:\\Users\\me> '), 5)
      return () => clearTimeout(timer)
    }),
    readTerminalBuffer: vi.fn(async () => ok({ output: '', length: 0, nextOffset: 77 })),
  }
  ;(window as any).termpolis = termpolis
  return { accounts, termpolis }
}

async function renderLoaded() {
  render(<AccountsSettings />)
  await screen.findByTestId('accounts-card-claude')
}

beforeEach(() => {
  useTerminalStore.setState({ defaultShell: 'powershell', terminals: [], activeTerminalId: null, accountsView: null, signInSheet: null, addAccountSheet: null, accountsByHand: {}, showSettings: true })
})

afterEach(() => {
  vi.useRealTimers()
  delete (window as any).accounts
  delete (window as any).termpolis
})

describe('AccountsSettings: reading the accounts', () => {
  it('says the build has no accounts bridge', () => {
    ;(window as any).termpolis = { getAvailableShells: vi.fn(async () => ({ success: true, data: [] })) }
    render(<AccountsSettings />)
    expect(screen.getByTestId('accounts-unavailable')).toBeInTheDocument()
  })

  it('says it is reading until main answers, then shows a card per agent', async () => {
    let resolve!: (v: unknown) => void
    bridge(view(), { list: vi.fn(() => new Promise((r) => { resolve = r })) })
    render(<AccountsSettings />)
    expect(screen.getByTestId('accounts-loading')).toBeInTheDocument()
    await act(async () => { resolve({ success: true, data: view() }) })
    for (const agent of ['claude', 'codex', 'agy']) expect(screen.getByTestId(`accounts-card-${agent}`)).toBeInTheDocument()
  })

  it('shows a failure that isn\'t an Error by its text', async () => {
    bridge(view(), { list: vi.fn(async () => { throw 'a bare string' }) })
    render(<AccountsSettings />)
    expect(await screen.findByTestId('accounts-load-error')).toHaveTextContent('a bare string')
  })

  it('shows why the accounts couldn\'t be read, and tries again', async () => {
    const { accounts } = bridge(view(), {
      list: vi.fn().mockResolvedValueOnce({ success: false, error: 'agent-accounts.json is not valid JSON' }).mockRejectedValueOnce(new Error('IPC gone')).mockResolvedValue({ success: true, data: view() }),
    })
    render(<AccountsSettings />)
    const err = await screen.findByTestId('accounts-load-error')
    expect(err).toHaveTextContent('not valid JSON')
    fireEvent.click(within(err).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByTestId('accounts-load-error')).toHaveTextContent('IPC gone'))
    fireEvent.click(within(screen.getByTestId('accounts-load-error')).getByRole('button', { name: 'Try again' }))
    await screen.findByTestId('accounts-card-claude')
    expect(accounts.list).toHaveBeenCalledTimes(3)
  })

  it('shows empty cards, the agy text and Add for a user with no accounts (D13)', async () => {
    bridge(view({ accounts: [] }))
    await renderLoaded()
    expect(screen.getByTestId('accounts-empty-claude')).toHaveTextContent('uses your main profile')
    expect(screen.getByTestId('accounts-empty-agy')).toHaveTextContent('No accounts yet.')
    expect(screen.getByTestId('accounts-agy-text')).toHaveTextContent('one Google sign-in for your whole computer user')
    expect(document.querySelector('[data-testid^="account-default-"]')).toBeNull()
    expect(screen.queryByTestId('accounts-import-banner')).toBeNull()
    for (const agent of ['claude', 'codex', 'agy']) expect(screen.getByTestId(`accounts-add-${agent}`)).toBeInTheDocument()
  })
})

describe('AccountsSettings: a card', () => {
  it('shows the colour, name, email, status, and the folder and shares under Advanced', async () => {
    const C = row({ id: 'acc_00000000000c', label: 'one', color: '#112233' })
    bridge(view({ accounts: [MAIN, B, C] }))
    await renderLoaded()
    const r = screen.getByTestId(`account-row-${B.id}`)
    expect(screen.getByTestId(`account-label-${B.id}`)).toHaveTextContent('codedev')
    expect(screen.getByTestId(`account-email-line-${B.id}`).textContent).toBe('b@example.test')
    expect(screen.getByTestId(`account-badge-${B.id}`)).toHaveTextContent('last signed in as b@example.test')
    expect(screen.getByTestId(`account-advanced-${B.id}`)).toHaveTextContent('~\\.claude-codedev')
    expect(screen.getByTestId(`account-advanced-${B.id}`)).toHaveTextContent('Shares projects with your main profile')
    expect(screen.getByTestId(`account-advanced-${MAIN.id}`)).toHaveTextContent('~\\.claude (main profile)')
    // Its avatar takes its colour and initial; one with none takes the agent's.
    expect(screen.getByTestId('account-row-acc_00000000000c').querySelector('[aria-hidden="true"]')).toHaveStyle({ backgroundColor: '#112233' })
    expect(r.querySelector('[aria-hidden="true"]')).toHaveTextContent('C')
    expect(r.querySelector('[aria-hidden="true"]')).toHaveStyle({ backgroundColor: '#D97706' })
    expect(screen.getByTestId(`account-row-${MAIN.id}`).querySelector('[aria-hidden="true"]')).toHaveTextContent('P')
    // The main profile is connected through Agent Integration: no Connect of its own.
    expect(screen.queryByTestId(`account-connect-${MAIN.id}`)).toBeNull()
    expect(screen.queryByTestId(`account-disconnect-${MAIN.id}`)).toBeNull()
  })

  // R16: a swarm worker runs Claude Code with --dangerously-skip-permissions, whose warning a profile
  // that never accepted it opens instead, and Termpolis never answers it.
  it('says which Claude Code profiles can\'t take over swarm workers until bypass mode is accepted there once', async () => {
    const codex = row({ id: 'acc_00000000000c', agent: 'codex', label: 'cx', bypassReady: false })
    bridge(view({ accounts: [MAIN, row({ bypassReady: false }), codex, row({ id: 'acc_00000000000d', label: 'gone', folderExists: false, bypassReady: false })] }))
    await renderLoaded()
    expect(screen.getByTestId(`account-bypass-${B.id}`).textContent).toBe('Can\'t take over swarm workers until you accept bypass mode in it once.')
    expect(screen.queryByTestId(`account-bypass-${MAIN.id}`)).toBeNull()
    expect(screen.queryByTestId(`account-bypass-${codex.id}`)).toBeNull()
    expect(screen.queryByTestId('account-bypass-acc_00000000000d')).toBeNull()
  })

  it('moves an account up or down, never past either end', async () => {
    const { accounts } = bridge()
    await renderLoaded()
    expect((screen.getByTestId(`account-up-${MAIN.id}`) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId(`account-down-${B.id}`) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId(`account-down-${MAIN.id}`))
    await waitFor(() => expect(accounts.move).toHaveBeenCalledWith(MAIN.id, 1))
    fireEvent.click(screen.getByTestId(`account-up-${B.id}`))
    await waitFor(() => expect(accounts.move).toHaveBeenCalledWith(B.id, -1))
  })

  it('asks the agent who is signed in now, and says why it couldn\'t', async () => {
    const { accounts } = bridge(view(), { check: vi.fn().mockResolvedValueOnce({ success: true, data: B }).mockResolvedValueOnce({ success: false, error: 'A Termpolis terminal is running on codedev' }) })
    await renderLoaded()
    fireEvent.click(screen.getByTestId(`account-check-${B.id}`))
    await waitFor(() => expect(accounts.check).toHaveBeenCalledWith(B.id))
    fireEvent.click(screen.getByTestId(`account-check-${B.id}`))
    expect(await screen.findByTestId('accounts-error')).toHaveTextContent('A Termpolis terminal is running on codedev')
  })

  it('connects and disconnects a profile, and needs Agent Integration on to connect', async () => {
    const off = row({ id: 'acc_00000000000d', label: 'work', connect: false, autoOffer: false })
    const { accounts } = bridge(view({ accounts: [MAIN, B, off] }))
    await renderLoaded()
    expect(screen.getByTestId(`account-not-connected-${off.id}`)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`account-disconnect-${B.id}`))
    await waitFor(() => expect(accounts.setConnect).toHaveBeenCalledWith(B.id, false))
    expect(await screen.findByTestId('accounts-changes')).toHaveTextContent('Nothing needed to change.')
    fireEvent.click(screen.getByTestId(`account-connect-${off.id}`))
    await waitFor(() => expect(accounts.setConnect).toHaveBeenCalledWith(off.id, true))
  })

  it('can\'t connect while Agent Integration is off, and says so', async () => {
    const off = row({ id: 'acc_00000000000d', label: 'work', connect: false })
    bridge(view({ accounts: [MAIN, off], integrationConnected: false }))
    await renderLoaded()
    expect(screen.getByTestId('accounts-integration-off')).toBeInTheDocument()
    const btn = screen.getByTestId(`account-connect-${off.id}`) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toBe('Turn on Agent Integration first')
  })

  it('offers to take out the Termpolis entries a copied settings.json carries into an unconnected profile (R17)', async () => {
    const work = row({ id: 'acc_00000000000d', label: 'work', connect: false, connection: { server: false, hook: true, allow: false } })
    const clean = row({ id: 'acc_00000000000e', label: 'clean', connect: false, connection: { server: false, hook: false, allow: false } })
    const codexRow = row({ id: 'acc_00000000000f', agent: 'codex', label: 'cx', connect: false, connection: { server: false, hook: true, allow: false } })
    const { accounts } = bridge(view({ accounts: [MAIN, work, clean, codexRow] }))
    await renderLoaded()
    expect(screen.queryByTestId(`account-copied-entries-${clean.id}`)).toBeNull()
    expect(screen.queryByTestId(`account-copied-entries-${codexRow.id}`)).toBeNull()
    expect(screen.getByTestId(`account-copied-entries-${work.id}`)).toHaveTextContent('isn\'t connected')
    fireEvent.click(screen.getByTestId(`account-strip-${work.id}`))
    await waitFor(() => expect(accounts.stripCopied).toHaveBeenCalledWith(work.id))
    expect(await screen.findByTestId('accounts-changes')).toHaveTextContent('remove Memory hook s.json: EBUSY')
  })

  it('turns offering automatically off and on', async () => {
    const { accounts } = bridge()
    await renderLoaded()
    fireEvent.click(screen.getByTestId(`account-auto-offer-${B.id}`))
    await waitFor(() => expect(accounts.update).toHaveBeenCalledWith(B.id, { autoOffer: false }))
  })

  it('renames an account in place: Enter keeps the new name, Esc or leaving the field doesn\'t', async () => {
    const { accounts } = bridge()
    await renderLoaded()
    fireEvent.click(screen.getByTestId(`account-label-${B.id}`))
    const field = screen.getByTestId(`account-edit-label-${B.id}`) as HTMLInputElement
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: ' codedev2 ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(accounts.update).toHaveBeenCalledWith(B.id, { label: 'codedev2' }))
    await waitFor(() => expect(screen.queryByTestId(`account-edit-label-${B.id}`)).toBeNull())
    // Esc, a blur, an unchanged name or an empty one: nothing is saved.
    accounts.update.mockClear()
    fireEvent.click(screen.getByTestId(`account-label-${B.id}`))
    fireEvent.change(screen.getByTestId(`account-edit-label-${B.id}`), { target: { value: 'other' } })
    fireEvent.keyDown(screen.getByTestId(`account-edit-label-${B.id}`), { key: 'Escape' })
    expect(screen.queryByTestId(`account-edit-label-${B.id}`)).toBeNull()
    fireEvent.click(screen.getByTestId(`account-label-${B.id}`))
    fireEvent.blur(screen.getByTestId(`account-edit-label-${B.id}`))
    expect(screen.queryByTestId(`account-edit-label-${B.id}`)).toBeNull()
    for (const value of ['codedev', '   ']) {
      fireEvent.click(screen.getByTestId(`account-label-${B.id}`))
      fireEvent.change(screen.getByTestId(`account-edit-label-${B.id}`), { target: { value } })
      fireEvent.keyDown(screen.getByTestId(`account-edit-label-${B.id}`), { key: 'Enter' })
      expect(screen.queryByTestId(`account-edit-label-${B.id}`)).toBeNull()
    }
    // Other keys are the field's own.
    fireEvent.click(screen.getByTestId(`account-label-${B.id}`))
    fireEvent.keyDown(screen.getByTestId(`account-edit-label-${B.id}`), { key: 'a' })
    expect(screen.getByTestId(`account-edit-label-${B.id}`)).toBeInTheDocument()
    expect(accounts.update).not.toHaveBeenCalled()
  })

  it('changes the email an account should sign in with, under Advanced', async () => {
    const { accounts } = bridge()
    await renderLoaded()
    expect(screen.getByTestId(`account-advanced-${B.id}`)).toHaveTextContent('The email it should sign in with: b@example.test')
    fireEvent.click(screen.getByTestId(`account-edit-${B.id}`))
    expect((screen.getByTestId(`account-edit-email-${B.id}`) as HTMLInputElement).value).toBe('b@example.test')
    fireEvent.change(screen.getByTestId(`account-edit-email-${B.id}`), { target: { value: '' } })
    fireEvent.click(screen.getByTestId(`account-edit-save-${B.id}`))
    await waitFor(() => expect(accounts.update).toHaveBeenCalledWith(B.id, { email: '' }))
    await waitFor(() => expect(screen.queryByTestId(`account-edit-form-${B.id}`)).toBeNull())
    fireEvent.click(screen.getByTestId(`account-edit-${MAIN.id}`))
    expect(screen.getByTestId(`account-edit-form-${MAIN.id}`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId(`account-edit-form-${MAIN.id}`)).toBeNull()
    // An agy account's is its Google email; one with none starts empty.
    const g = row({ id: 'acc_000000000009', agent: 'agy', label: 'g', email: undefined, profile: null, folder: null, folderExists: false })
    ;(window as any).accounts.list.mockResolvedValue({ success: true, data: view({ accounts: [g] }) })
    fireEvent.click(screen.getByTestId(`account-auto-offer-${B.id}`))
    await screen.findByTestId(`account-row-${g.id}`)
    expect(screen.getByTestId(`account-advanced-${g.id}`)).toHaveTextContent('Its Google email: none given')
    fireEvent.click(screen.getByTestId(`account-edit-${g.id}`))
    expect((screen.getByTestId(`account-edit-email-${g.id}`) as HTMLInputElement).value).toBe('')
  })

  it('shows the email and plan the CLI reports, and the terminals on it now, which it focuses', async () => {
    const signed = row({ identity: { email: 'b2@example.test', signedIn: true, plan: 'Max', checkedAt: 1, source: 'auth-status' } })
    bridge(view({ accounts: [MAIN, signed] }))
    const t = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `T ${id}`, color: '', shellType: 'powershell' as const, cwd: '/r', fontSize: 13, theme: 'dark', fontFamily: 'mono', agentCommand: 'claude', agentAccountId: B.id, ...over })
    useTerminalStore.setState({ terminals: [t('t1'), t('t2', { hidden: true }), t('t3'), t('t4', { agentAccountId: MAIN.id }), t('c', { isConductor: true })], accountsByHand: { t3: true } })
    await renderLoaded()
    expect(screen.getByTestId(`account-email-line-${B.id}`).textContent).toBe('b2@example.test · Max')
    // Changed by hand, hidden or the conductor's: not listed as on it.
    expect(screen.getByTestId(`account-terminals-${B.id}`)).toHaveTextContent('On it now:T t1')
    expect(screen.getByTestId(`account-terminals-${MAIN.id}`)).toHaveTextContent('On it now:T t4')
    fireEvent.click(screen.getByTestId('account-terminal-t1'))
    expect(useTerminalStore.getState().activeTerminalId).toBe('t1')
    expect(useTerminalStore.getState().showSettings).toBe(false)
  })

  it('shows no plan for an account its CLI says is signed out, and no email line with none', async () => {
    const out = row({ email: undefined, lastEmail: null, identity: { email: null, signedIn: false, plan: 'Max', checkedAt: 1, source: 'auth-status' } })
    bridge(view({ accounts: [MAIN, out] }))
    await renderLoaded()
    expect(screen.queryByTestId(`account-email-line-${B.id}`)).toBeNull()
  })

  it('draws a name with no letter in it as ?', async () => {
    bridge(view({ accounts: [MAIN, row({ label: ' ' })] }))
    await renderLoaded()
    expect(screen.getByTestId(`account-row-${B.id}`).querySelector('[aria-hidden="true"]')).toHaveTextContent('?')
  })

  it("names its account on every control of a card, so a screen reader hears which one when there are several", async () => {
    bridge(view({ accounts: [MAIN, B, row({ id: 'acc_000000000003', label: 'contoso', email: null, lastEmail: null, limit: { seenAt: 1, resetsAt: null, text: 'x', scope: 'account' }, recopyAvailable: true, connect: false })] }))
    await renderLoaded()
    const named = (testid: string, name: string): void => expect(screen.getByTestId(testid), testid).toHaveAccessibleName(name)
    named(`account-sign-in-${MAIN.id}`, 'Sign in again, personal')
    named(`account-sign-in-${B.id}`, 'Sign in again, codedev')
    named('account-sign-in-acc_000000000003', 'Sign in, contoso')
    named(`account-check-${B.id}`, 'Check codedev')
    named(`account-disconnect-${B.id}`, 'Disconnect codedev')
    named('account-connect-acc_000000000003', 'Connect contoso')
    named('account-mark-available-acc_000000000003', 'Mark contoso available')
    named('account-recopy-acc_000000000003', 'Re-copy contoso from the main profile')
    named(`account-remove-${B.id}`, 'Remove codedev')
    named(`account-auto-offer-${B.id}`, 'Offer codedev automatically when another account runs out')
    fireEvent.click(screen.getByTestId(`account-remove-${B.id}`))
    expect(screen.getByTestId(`account-remove-${B.id}`)).toHaveAttribute('aria-expanded', 'true')
  })

  it("says the main profile stays connected through Agent Integration when it is forgotten (it has no entries of Termpolis's to take out)", async () => {
    bridge()
    await renderLoaded()
    fireEvent.click(screen.getByTestId(`account-remove-${MAIN.id}`))
    const said = screen.getByTestId(`account-remove-confirm-${MAIN.id}`).textContent ?? ''
    expect(said).toContain('Termpolis forgets personal')
    expect(said).toContain('Your main profile stays connected through Agent Integration')
    expect(said).not.toContain('takes its entries out')
  })

  it('removes an account after saying what stays, and keeps it on "Keep it"', async () => {
    const { accounts } = bridge()
    await renderLoaded()
    fireEvent.click(screen.getByTestId(`account-remove-${B.id}`))
    expect(screen.getByTestId(`account-remove-confirm-${B.id}`)).toHaveTextContent('The folder, its sign-in and its links stay.')
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByTestId(`account-remove-confirm-${B.id}`)).toBeNull()
    fireEvent.click(screen.getByTestId(`account-remove-${B.id}`))
    fireEvent.click(screen.getByTestId(`account-remove-${B.id}`))
    expect(screen.queryByTestId(`account-remove-confirm-${B.id}`)).toBeNull()
    fireEvent.click(screen.getByTestId(`account-remove-${B.id}`))
    fireEvent.click(screen.getByTestId(`account-remove-yes-${B.id}`))
    await waitFor(() => expect(accounts.remove).toHaveBeenCalledWith(B.id))
    expect(await screen.findByTestId('accounts-changes')).toHaveTextContent('remove MCP server')
  })

  it('says removing an agy label leaves agy\'s own sign-in alone', async () => {
    const g = row({ id: 'acc_000000000009', agent: 'agy', label: 'g', email: 'g@example.test', profile: null, folder: null, folderExists: false, connection: null })
    bridge(view({ accounts: [g] }))
    await renderLoaded()
    expect(screen.getByTestId(`account-badge-${g.id}`)).toHaveTextContent('g@example.test')
    // Nothing to sign in, check or connect: agy keeps one sign-in per computer user.
    for (const what of ['sign-in', 'check', 'connect', 'disconnect']) expect(screen.queryByTestId(`account-${what}-${g.id}`)).toBeNull()
    fireEvent.click(screen.getByTestId(`account-remove-${g.id}`))
    expect(screen.getByTestId(`account-remove-confirm-${g.id}`)).toHaveTextContent('agy\'s own sign-in stays as it is')
  })

  it('re-copies a profile whose main settings changed, after saying what it replaces', async () => {
    const copied = row({ recopyAvailable: true })
    const unconnected = row({ id: 'acc_00000000000c', label: 'side', connect: false, recopyAvailable: true })
    const { accounts } = bridge(view({ accounts: [MAIN, copied, unconnected] }))
    await renderLoaded()
    expect(screen.queryByTestId(`account-recopy-${MAIN.id}`)).toBeNull()
    fireEvent.click(screen.getByTestId(`account-recopy-${unconnected.id}`))
    expect(screen.getByTestId(`account-recopy-confirm-${unconnected.id}`)).not.toHaveTextContent('connects it again')
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByTestId(`account-recopy-confirm-${unconnected.id}`)).toBeNull()
    fireEvent.click(screen.getByTestId(`account-recopy-${B.id}`))
    expect(screen.getByTestId(`account-recopy-confirm-${B.id}`)).toHaveTextContent('leaving out anything that can hold a key or a token, and connects it again')
    fireEvent.click(screen.getByTestId(`account-recopy-yes-${B.id}`))
    await waitFor(() => expect(accounts.recopy).toHaveBeenCalledWith(B.id))
    expect(await screen.findByTestId('accounts-left-out')).toHaveTextContent('env, apiKeyHelper')
    expect(screen.getByTestId('accounts-changes')).toHaveTextContent('add Tool permissions')
    // The next action clears what the last one said.
    fireEvent.click(screen.getByTestId(`account-check-${B.id}`))
    await waitFor(() => expect(screen.queryByTestId('accounts-left-out')).toBeNull())
  })

  it('marks a limited account available', async () => {
    const limited = row({ limit: { seenAt: 1, resetsAt: null, text: 'You\'ve hit your weekly limit', scope: 'account', window: 'weekly' } })
    const { accounts } = bridge(view({ accounts: [MAIN, limited] }))
    await renderLoaded()
    expect(screen.getByTestId(`account-badge-${B.id}`)).toHaveTextContent('out of usage')
    fireEvent.click(screen.getByTestId(`account-mark-available-${B.id}`))
    await waitFor(() => expect(accounts.clearLimit).toHaveBeenCalledWith(B.id))
  })

  it('has no sign-in, check or connect for a profile whose folder is gone', async () => {
    const gone = row({ folderExists: false })
    bridge(view({ accounts: [MAIN, gone] }))
    await renderLoaded()
    expect(screen.getByTestId(`account-badge-${B.id}`)).toHaveTextContent('folder missing')
    for (const what of ['sign-in', 'check', 'connect', 'disconnect']) expect(screen.queryByTestId(`account-${what}-${B.id}`)).toBeNull()
  })
})

describe('AccountsSettings: a section', () => {
  it('says which account new terminals start on, and makes another one the default', async () => {
    const gone = row({ id: 'acc_00000000000d', label: 'gone', folderExists: false })
    const { accounts } = bridge(view({ preferred: { claude: B.id }, accounts: [MAIN, B, gone] }))
    await renderLoaded()
    expect(screen.getByTestId(`account-default-${B.id}`)).toHaveTextContent('Default for new terminals')
    expect(screen.queryByTestId(`account-make-default-${B.id}`)).toBeNull()
    // One with no folder can't be.
    expect((screen.getByTestId(`account-make-default-${gone.id}`) as HTMLButtonElement).disabled).toBe(true)
    // The main profile is the default by having none.
    fireEvent.click(screen.getByTestId(`account-make-default-${MAIN.id}`))
    await waitFor(() => expect(accounts.setPreferred).toHaveBeenCalledWith('claude', null))
  })

  it('takes the main profile as the default when none is set, and sets another', async () => {
    const { accounts } = bridge()
    await renderLoaded()
    expect(screen.getByTestId(`account-default-${MAIN.id}`)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`account-make-default-${B.id}`))
    await waitFor(() => expect(accounts.setPreferred).toHaveBeenCalledWith('claude', B.id))
  })

  it('has no default for agy, whose one sign-in every agy terminal runs on', async () => {
    const g = row({ id: 'acc_000000000009', agent: 'agy', label: 'g', email: 'g@example.test', profile: null, folder: null, folderExists: false, connection: null })
    bridge(view({ accounts: [g] }))
    await renderLoaded()
    expect(screen.queryByTestId(`account-default-${g.id}`)).toBeNull()
    expect(screen.queryByTestId(`account-make-default-${g.id}`)).toBeNull()
  })

  it('opens the Add account wizard for its agent', async () => {
    bridge()
    await renderLoaded()
    fireEvent.click(screen.getByTestId('accounts-add-codex'))
    expect(useTerminalStore.getState().addAccountSheet).toEqual({ agent: 'codex' })
    fireEvent.click(screen.getByTestId('accounts-add-agy'))
    expect(useTerminalStore.getState().addAccountSheet).toEqual({ agent: 'agy' })
  })

  it('shows an account the wizard added, from the store, without reading them again', async () => {
    const { accounts } = bridge()
    await renderLoaded()
    const calls = accounts.list.mock.calls.length
    act(() => useTerminalStore.getState().setAccountsView(view({ accounts: [MAIN, B, row({ id: 'acc_00000000000e', label: 'fresh' })] })))
    expect(await screen.findByTestId('account-row-acc_00000000000e')).toHaveTextContent('fresh')
    expect(accounts.list.mock.calls.length).toBe(calls)
  })

  it('turns the chooser off', async () => {
    const { accounts } = bridge()
    await renderLoaded()
    expect((screen.getByTestId('accounts-chooser') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByTestId('accounts-chooser'))
    await waitFor(() => expect(accounts.setChooser).toHaveBeenCalledWith(false))
  })
})

describe('AccountsSettings: importing ~/.claude/accounts.sh', () => {
  const preview = {
    rows: [
      { key: 'personal', label: 'personal', email: 'a@example.test', profile: null, autoOffer: true, order: 0, registered: true, folderExists: true, shares: [] },
      { key: 'codedev', label: 'codedev', email: 'b@example.test', profile: `${HOME}\\.claude-codedev`, autoOffer: true, order: 1, registered: false, folderExists: true, shares: ['projects'] },
      { key: 'work', label: 'work', profile: `${HOME}\\.claude-work`, autoOffer: false, order: 2, registered: false, folderExists: false, shares: [] },
    ],
    refused: ['ACCOUNT_DIR[evil] holds $, ` or \\, so it was skipped'],
  }

  it('previews the file, connects only what is offered automatically by default (D14), and imports the rows picked', async () => {
    const { accounts } = bridge(view({ importAvailable: true }), {
      importPreview: vi.fn(async () => ({ success: true, data: preview })),
      import: vi.fn(async () => ({ success: true, data: { added: 2, changes: [{ agent: 'claude', file: 'c.json', action: 'add', what: 'MCP server' }], view: view() } })),
    })
    await renderLoaded()
    expect(screen.getByTestId('accounts-import-banner')).toHaveTextContent('~/.claude/accounts.sh lists your Claude Code accounts')
    fireEvent.click(screen.getByTestId('accounts-import'))
    const panel = await screen.findByTestId('accounts-import-panel')
    expect(panel).toHaveTextContent('never changes it')
    // The banner gives way to the preview.
    expect(screen.queryByTestId('accounts-import-banner')).toBeNull()
    expect((screen.getByTestId('accounts-import-pick-personal') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByTestId('accounts-import-row-personal')).toHaveTextContent('main profile')
    expect(screen.getByTestId('accounts-import-row-personal')).toHaveTextContent('already added')
    expect(screen.getByTestId('accounts-import-row-codedev')).toHaveTextContent('~\\.claude-codedev')
    expect(screen.getByTestId('accounts-import-row-work')).toHaveTextContent('folder missing')
    expect(screen.getByTestId('accounts-import-row-work')).toHaveTextContent('not offered automatically')
    expect((screen.getByTestId('accounts-import-connect-codedev') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('accounts-import-connect-work') as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByTestId('accounts-import-connect-personal')).toBeNull()
    expect(screen.getByTestId('accounts-import-refused')).toHaveTextContent('ACCOUNT_DIR[evil]')
    fireEvent.click(screen.getByTestId('accounts-import-connect-work'))
    fireEvent.click(screen.getByTestId('accounts-import-pick-codedev'))
    fireEvent.click(screen.getByTestId('accounts-import-pick-codedev'))
    fireEvent.click(screen.getByTestId('accounts-import-go'))
    await waitFor(() => expect(accounts.import).toHaveBeenCalledWith(['work', 'codedev'], { personal: true, codedev: true, work: true }))
    await waitFor(() => expect(screen.queryByTestId('accounts-import-panel')).toBeNull())
    expect(await screen.findByTestId('accounts-changes')).toHaveTextContent('add MCP server')
  })

  it('connects nothing by default while Agent Integration is off, and can be cancelled', async () => {
    const { accounts } = bridge(view({ importAvailable: true, integrationConnected: false }), {
      importPreview: vi.fn(async () => ({ success: true, data: preview })),
    })
    await renderLoaded()
    fireEvent.click(screen.getByTestId('accounts-import'))
    await screen.findByTestId('accounts-import-panel')
    const c = screen.getByTestId('accounts-import-connect-codedev') as HTMLInputElement
    expect(c.checked).toBe(false)
    expect(c.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('accounts-import-pick-codedev'))
    fireEvent.click(screen.getByTestId('accounts-import-pick-work'))
    expect((screen.getByTestId('accounts-import-go') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('accounts-import-cancel'))
    expect(screen.queryByTestId('accounts-import-panel')).toBeNull()
    expect(accounts.import).not.toHaveBeenCalled()
  })

  it('says why the file couldn\'t be previewed or imported', async () => {
    bridge(view({ importAvailable: true }), {
      importPreview: vi.fn().mockResolvedValueOnce({ success: false, error: '~/.claude/accounts.sh doesn\'t exist' }).mockResolvedValueOnce({ success: true, data: { rows: [preview.rows[1]], refused: [] } }),
      import: vi.fn(async () => ({ success: false, error: 'agent-accounts.json could not be saved' })),
    })
    await renderLoaded()
    fireEvent.click(screen.getByTestId('accounts-import'))
    expect(await screen.findByTestId('accounts-error')).toHaveTextContent('doesn\'t exist')
    fireEvent.click(screen.getByTestId('accounts-import'))
    await screen.findByTestId('accounts-import-panel')
    expect(screen.queryByTestId('accounts-import-refused')).toBeNull()
    fireEvent.click(screen.getByTestId('accounts-import-go'))
    expect(await screen.findByTestId('accounts-error')).toHaveTextContent('could not be saved')
    expect(screen.getByTestId('accounts-import-panel')).toBeInTheDocument()
  })
})

describe('AccountsSettings: the notices', () => {
  it('lists what accounts.sh and Termpolis disagree on', async () => {
    bridge(view({ drift: ['side isn\'t in accounts.sh, so your status line counts its sessions as personal.'] }))
    await renderLoaded()
    expect(screen.getByTestId('accounts-drift')).toHaveTextContent('side isn\'t in accounts.sh')
  })

  it('shows the StopFailure-hook advice with the check to copy, and hides it for good', async () => {
    const { accounts, termpolis } = bridge(view({ advice: { stopFailureHooks: [{ label: 'personal', command: 'bash ~/.claude/hooks/auth-failover.sh' }, { label: 'codedev', command: 'x' }], authOverrides: [] } }))
    await renderLoaded()
    const card = screen.getByTestId('accounts-hook-advice')
    expect(card).toHaveTextContent('bash ~/.claude/hooks/auth-failover.sh')
    expect(card).toHaveTextContent('in personal, codedev')
    expect(card).toHaveTextContent(HOOK_CHECK)
    fireEvent.click(screen.getByTestId('accounts-hook-copy'))
    await waitFor(() => expect(termpolis.clipboardWriteText).toHaveBeenCalledWith(HOOK_CHECK))
    expect(await within(card).findByText('Copied')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('accounts-hook-hide'))
    await waitFor(() => expect(accounts.hideAdvice).toHaveBeenCalledWith('hookAdvice'))
  })

  it('says nothing was copied when the clipboard throws, and hides advice the user dismissed', async () => {
    const hooks = { stopFailureHooks: [{ label: 'personal', command: 'x' }], authOverrides: ['ANTHROPIC_API_KEY (Termpolis\'s environment)'] }
    const { termpolis } = bridge(view({ advice: hooks }))
    termpolis.clipboardWriteText.mockRejectedValueOnce(new Error('gone'))
    await renderLoaded()
    fireEvent.click(screen.getByTestId('accounts-hook-copy'))
    await waitFor(() => expect(termpolis.clipboardWriteText).toHaveBeenCalled())
    expect(screen.queryByText('Copied')).toBeNull()
    expect(screen.getByTestId('accounts-auth-advice')).toHaveTextContent('ANTHROPIC_API_KEY')
  })

  it('names the settings that outrank a profile\'s sign-in, by name only, and hides them for good', async () => {
    const { accounts } = bridge(view({ advice: { stopFailureHooks: [], authOverrides: ['CLAUDE_CODE_OAUTH_TOKEN (codedev\'s settings.json)'] } }))
    await renderLoaded()
    expect(screen.getByTestId('accounts-auth-advice')).toHaveTextContent('CLAUDE_CODE_OAUTH_TOKEN (codedev\'s settings.json)')
    fireEvent.click(screen.getByTestId('accounts-auth-hide'))
    await waitFor(() => expect(accounts.hideAdvice).toHaveBeenCalledWith('authEnvAdvice'))
  })

  it('shows no dismissed notice', async () => {
    bridge(view({ hidden: { hookAdvice: true, authEnvAdvice: true }, advice: { stopFailureHooks: [{ label: 'personal', command: 'x' }], authOverrides: ['x'] } }))
    await renderLoaded()
    expect(screen.queryByTestId('accounts-hook-advice')).toBeNull()
    expect(screen.queryByTestId('accounts-auth-advice')).toBeNull()
  })
})

describe('AccountsSettings: signing in', () => {
  it('opens the sign-in sheet for the account, never a terminal: Sign in, or Sign in again once it has one', async () => {
    const { termpolis } = bridge(view({ accounts: [MAIN, row({ lastEmail: null })] }))
    await renderLoaded()
    fireEvent.click(screen.getByTestId(`account-sign-in-${B.id}`))
    expect(screen.getByTestId(`account-sign-in-${B.id}`).textContent).toBe('Sign in')
    expect(useTerminalStore.getState().signInSheet).toEqual({ accountId: B.id })
    expect(screen.getByTestId(`account-sign-in-${MAIN.id}`).textContent).toBe('Sign in again')
    expect(termpolis.createTerminal).not.toHaveBeenCalled()
  })

  it('offers no sign-in for an agy label, whose one sign-in its switch moves', async () => {
    const g = row({ id: 'acc_00000000000g', agent: 'agy', label: 'google', profile: null, folder: null, isDefault: false, connection: null, shares: [], lastEmail: null })
    bridge(view({ accounts: [MAIN, B, g] }))
    await renderLoaded()
    expect(screen.queryByTestId(`account-sign-in-${g.id}`)).toBeNull()
  })

  it('shows the accounts as a sign-in left them, without reading them again', async () => {
    const { accounts } = bridge()
    await renderLoaded()
    const calls = accounts.list.mock.calls.length
    act(() => useTerminalStore.getState().setAccountsView(view({ accounts: [MAIN, row({ label: 'renamed' })] })))
    expect(await screen.findByTestId(`account-label-${B.id}`)).toHaveTextContent('renamed')
    expect(accounts.list.mock.calls.length).toBe(calls)
  })
})
