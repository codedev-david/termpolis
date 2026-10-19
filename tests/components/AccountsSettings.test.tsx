import React from 'react'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { AccountRowView, AccountsView, SignInProgress } from '../../src/shared/agentAccounts'
import { AccountsSettings, HOOK_CHECK } from '../../src/renderer/src/components/SettingsPane/AccountsSettings'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

const HOME = 'C:\\Users\\me'

function row(over: Partial<AccountRowView> = {}): AccountRowView {
  return {
    id: 'acc_00000000000b', agent: 'claude', label: 'codedev', email: 'b@example.test', profile: `${HOME}\\.claude-codedev`,
    folder: `${HOME}\\.claude-codedev`, isDefault: false, autoOffer: true, order: 1, connect: true, origin: 'adopted',
    folderExists: true, shares: ['projects'], lastEmail: 'b@example.test', connection: { server: true, hook: true, allow: true },
    bypassReady: true, terminals: 0, ...over,
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

type Progress = (p: SignInProgress) => void

function bridge(initial: AccountsView = view(), over: Record<string, unknown> = {}) {
  let progress: Progress = () => undefined
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
    setPreferred: vi.fn(async () => ok(initial)),
    setChooser: vi.fn(async () => ok(initial)),
    hideAdvice: vi.fn(async () => ok(initial)),
    importPreview: vi.fn(),
    import: vi.fn(),
    check: vi.fn(async () => ok(B)),
    signInLine: vi.fn(async (req: { method?: string }) => ok({ line: `export CLAUDE_CONFIG_DIR='x' && claude auth login --${req.method}`, warning: 'Close any Claude Code window outside Termpolis first.', name: 'Sign in · Claude Code · codedev' })),
    watchSignIn: vi.fn(async () => ok({ watching: true })),
    stopSignIn: vi.fn(),
    noteLimit: vi.fn(),
    clearLimit: vi.fn(async () => ok(B)),
    onSignInProgress: vi.fn((cb: Progress) => { progress = cb; return () => { progress = () => undefined } }),
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
  return { accounts, termpolis, progress: (p: SignInProgress) => progress(p) }
}

async function renderLoaded() {
  render(<AccountsSettings />)
  await screen.findByTestId('accounts-card-claude')
}

beforeEach(() => {
  useTerminalStore.setState({ defaultShell: 'powershell', terminals: [], activeTerminalId: null })
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
    expect(screen.queryByTestId('accounts-preferred-claude')).toBeNull()
    expect(screen.queryByTestId('accounts-import')).toBeNull()
  })
})

describe('AccountsSettings: a row', () => {
  it('shows the label, email, state, folder, shares and terminals', async () => {
    bridge(view({ accounts: [MAIN, row({ terminals: 2 }), row({ id: 'acc_00000000000c', label: 'one', terminals: 1, color: '#112233' })] }))
    await renderLoaded()
    const r = screen.getByTestId(`account-row-${B.id}`)
    expect(r).toHaveTextContent('codedev')
    expect(r).toHaveTextContent('b@example.test')
    expect(screen.getByTestId(`account-badge-${B.id}`)).toHaveTextContent('last signed in as b@example.test')
    expect(r).toHaveTextContent('~\\.claude-codedev')
    expect(r).toHaveTextContent('Shares projects with your main profile')
    expect(r).toHaveTextContent('2 terminals on it')
    expect(screen.getByTestId('account-row-acc_00000000000c')).toHaveTextContent('1 terminal on it')
    expect(screen.getByTestId(`account-row-${MAIN.id}`)).toHaveTextContent('~\\.claude (main profile)')
    // The main profile is connected through Agent Integration: no Connect of its own.
    expect(screen.queryByTestId(`account-connect-${MAIN.id}`)).toBeNull()
    expect(screen.queryByTestId(`account-disconnect-${MAIN.id}`)).toBeNull()
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

  it('renames an account and changes its email', async () => {
    const { accounts } = bridge()
    await renderLoaded()
    fireEvent.click(screen.getByTestId(`account-edit-${B.id}`))
    fireEvent.change(screen.getByTestId(`account-edit-label-${B.id}`), { target: { value: 'codedev2' } })
    fireEvent.change(screen.getByTestId(`account-edit-email-${B.id}`), { target: { value: '' } })
    fireEvent.click(screen.getByTestId(`account-edit-save-${B.id}`))
    await waitFor(() => expect(accounts.update).toHaveBeenCalledWith(B.id, { label: 'codedev2', email: '' }))
    await waitFor(() => expect(screen.queryByTestId(`account-edit-form-${B.id}`)).toBeNull())
    // The Rename button opens and closes the form.
    fireEvent.click(screen.getByTestId(`account-edit-${MAIN.id}`))
    expect(screen.getByTestId(`account-edit-form-${MAIN.id}`)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`account-edit-${MAIN.id}`))
    expect(screen.queryByTestId(`account-edit-form-${MAIN.id}`)).toBeNull()
    // An account with no email starts with an empty one.
    const g = row({ id: 'acc_000000000009', agent: 'agy', label: 'g', email: undefined, profile: null, folder: null, folderExists: false })
    ;(window as any).accounts.list.mockResolvedValue({ success: true, data: view({ accounts: [g] }) })
    fireEvent.click(screen.getByTestId(`account-auto-offer-${B.id}`))
    await screen.findByTestId(`account-row-${g.id}`)
    fireEvent.click(screen.getByTestId(`account-edit-${g.id}`))
    expect((screen.getByTestId(`account-edit-email-${g.id}`) as HTMLInputElement).value).toBe('')
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

describe('AccountsSettings: the card', () => {
  it('sets the account new terminals launch on, and back to the main profile', async () => {
    const { accounts } = bridge(view({ preferred: { claude: B.id } }))
    await renderLoaded()
    const select = screen.getByTestId('accounts-preferred-claude') as HTMLSelectElement
    expect(select.value).toBe(B.id)
    // The main profile is the empty choice, not listed twice.
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['the main profile', 'codedev'])
    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() => expect(accounts.setPreferred).toHaveBeenCalledWith('claude', null))
    fireEvent.change(select, { target: { value: B.id } })
    await waitFor(() => expect(accounts.setPreferred).toHaveBeenCalledWith('claude', B.id))
  })

  it('opens and closes the Add dialog, re-reading the accounts once one is added', async () => {
    const { accounts } = bridge(view(), { add: vi.fn(async () => ({ success: true, data: { account: B, leftOut: [], copied: [], changes: [] } })) })
    await renderLoaded()
    fireEvent.click(screen.getByTestId('accounts-add-codex'))
    expect(screen.getByTestId('add-account-dialog')).toHaveTextContent('Add a Codex account')
    fireEvent.click(screen.getByTestId('add-account-cancel'))
    expect(screen.queryByTestId('add-account-dialog')).toBeNull()
    fireEvent.click(screen.getByTestId('accounts-add-agy'))
    fireEvent.change(screen.getByTestId('add-account-label'), { target: { value: 'g' } })
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await screen.findByTestId('add-account-done')
    expect(accounts.list).toHaveBeenCalledTimes(2)
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
    fireEvent.click(screen.getByTestId('accounts-import'))
    const panel = await screen.findByTestId('accounts-import-panel')
    expect(panel).toHaveTextContent('never changes it')
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

describe('AccountsSettings: signing in (R29)', () => {
  it('builds the line for the user\'s shell, shows the warning, then opens a terminal and types it', async () => {
    const { accounts, termpolis } = bridge()
    await renderLoaded()
    await waitFor(() => expect(termpolis.getAvailableShells).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId(`account-sign-in-${B.id}`))
    const panel = await screen.findByTestId('account-sign-in-panel')
    await waitFor(() => expect(accounts.signInLine).toHaveBeenCalledWith({ accountId: B.id, shellType: 'powershell', method: 'claudeai' }))
    expect(await within(panel).findByTestId('account-sign-in-warning')).toHaveTextContent('outside Termpolis')
    // Another method rebuilds the line.
    fireEvent.click(screen.getByTestId('account-sign-in-method-console'))
    await waitFor(() => expect(screen.getByTestId('account-sign-in-line')).toHaveTextContent('--console'))
    fireEvent.click(screen.getByTestId('account-sign-in-go'))
    await waitFor(() => expect(accounts.watchSignIn).toHaveBeenCalled())
    const id = termpolis.createTerminal.mock.calls[0][0]
    expect(termpolis.createTerminal).toHaveBeenCalledWith(id, 'powershell', HOME)
    expect(termpolis.writeToTerminal).toHaveBeenLastCalledWith(id, 'export CLAUDE_CONFIG_DIR=\'x\' && claude auth login --console\r')
    expect(accounts.watchSignIn).toHaveBeenCalledWith(B.id, id, 77)
    const t = useTerminalStore.getState().terminals.find((x) => x.id === id)
    expect(t).toMatchObject({ name: 'Sign in · Claude Code · codedev', cwd: HOME, shellType: 'powershell', color: '#D97706' })
    expect(t?.agentCommand).toBeUndefined()
  })

  it('offers Codex its device-code sign-in', async () => {
    const cx = row({ id: 'acc_00000000000f', agent: 'codex', label: 'cx' })
    const { accounts } = bridge(view({ accounts: [cx] }))
    await renderLoaded()
    await waitFor(() => expect((window as any).termpolis.getAvailableShells).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId(`account-sign-in-${cx.id}`))
    await screen.findByTestId('account-sign-in-panel')
    expect(screen.getByTestId('account-sign-in-panel')).toHaveTextContent('use this if the browser can\'t reach this computer')
    fireEvent.click(screen.getByTestId('account-sign-in-method-device'))
    await waitFor(() => expect(accounts.signInLine).toHaveBeenLastCalledWith({ accountId: cx.id, shellType: 'powershell', method: 'device' }))
  })

  it('says why a sign-in can\'t start: no shell, a line main won\'t build, a shell that won\'t open', async () => {
    const { termpolis, accounts } = bridge()
    termpolis.getAvailableShells.mockResolvedValueOnce({ success: true, data: [] })
    useTerminalStore.setState({ defaultShell: 'zsh' })
    await renderLoaded()
    await waitFor(() => expect(termpolis.getAvailableShells).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId(`account-sign-in-${B.id}`))
    expect(await screen.findByTestId('account-sign-in-error')).toHaveTextContent('no shell Termpolis can type a sign-in into')
    expect((screen.getByTestId('account-sign-in-go') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('account-sign-in-cancel'))
    expect(screen.queryByTestId('account-sign-in-panel')).toBeNull()
    expect(accounts.signInLine).not.toHaveBeenCalled()
  })

  it('reports a refused line and a terminal that won\'t open', async () => {
    const { termpolis, accounts } = bridge()
    accounts.signInLine.mockResolvedValueOnce({ success: false, error: 'Termpolis won\'t type that line: cmd would expand a % or ! in the line' })
    await renderLoaded()
    await waitFor(() => expect(termpolis.getAvailableShells).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId(`account-sign-in-${B.id}`))
    expect(await screen.findByTestId('account-sign-in-error')).toHaveTextContent('cmd would expand')
    termpolis.createTerminal.mockResolvedValueOnce({ success: false, error: 'No shell available' })
    fireEvent.click(screen.getByTestId('account-sign-in-method-sso'))
    await screen.findByTestId('account-sign-in-warning')
    fireEvent.click(screen.getByTestId('account-sign-in-go'))
    expect(await screen.findByTestId('account-sign-in-error')).toHaveTextContent('Couldn\'t open the sign-in terminal: No shell available')
    expect(termpolis.writeToTerminal).not.toHaveBeenCalled()
  })

  it('marks from the start when the terminal\'s output can\'t be read', async () => {
    const { termpolis, accounts } = bridge()
    termpolis.readTerminalBuffer.mockResolvedValueOnce({ success: false, error: 'no buffer' })
    await renderLoaded()
    await waitFor(() => expect(termpolis.getAvailableShells).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId(`account-sign-in-${B.id}`))
    await screen.findByTestId('account-sign-in-warning')
    fireEvent.click(screen.getByTestId('account-sign-in-go'))
    await waitFor(() => expect(accounts.watchSignIn).toHaveBeenCalledWith(B.id, expect.any(String), 0))
    termpolis.readTerminalBuffer.mockRejectedValueOnce(new Error('gone'))
    fireEvent.click(screen.getByTestId(`account-sign-in-${B.id}`))
    await screen.findByTestId('account-sign-in-warning')
    fireEvent.click(screen.getByTestId('account-sign-in-go'))
    await waitFor(() => expect(accounts.watchSignIn).toHaveBeenCalledTimes(2))
    expect(accounts.watchSignIn.mock.calls[1][2]).toBe(0)
  })

  it('shows the profile\'s new email as it lands, and re-reads the accounts when the sign-in is done', async () => {
    const { accounts, progress } = bridge()
    await renderLoaded()
    act(() => progress({ accountId: B.id, email: 'c@example.test', done: false }))
    expect(screen.getByTestId(`account-badge-${B.id}`)).toHaveTextContent('signed in to c@example.test instead!')
    expect(accounts.list).toHaveBeenCalledTimes(1)
    await act(async () => progress({ accountId: B.id, email: 'b@example.test', done: true }))
    expect(accounts.list).toHaveBeenCalledTimes(2)
  })

  it('ignores a shell list it can\'t read, or that main refused', async () => {
    const { termpolis } = bridge()
    termpolis.getAvailableShells.mockRejectedValueOnce(new Error('gone'))
    await renderLoaded()
    fireEvent.click(screen.getByTestId(`account-sign-in-${B.id}`))
    expect(await screen.findByTestId('account-sign-in-error')).toHaveTextContent('no shell')
  })

  it('keeps no shells from a list main answered with an error', async () => {
    const { termpolis } = bridge()
    termpolis.getAvailableShells.mockResolvedValueOnce({ success: false, error: 'detect failed' } as never)
    await renderLoaded()
    await waitFor(() => expect(termpolis.getAvailableShells).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId(`account-sign-in-${B.id}`))
    expect(await screen.findByTestId('account-sign-in-error')).toHaveTextContent('no shell')
  })

  it('drops a shell list that arrives after the tab closed', async () => {
    const { termpolis } = bridge()
    let answer!: (v: unknown) => void
    termpolis.getAvailableShells.mockImplementationOnce(() => new Promise((r) => { answer = r }) as never)
    const { unmount } = render(<AccountsSettings />)
    await screen.findByTestId('accounts-card-claude')
    unmount()
    await act(async () => { answer({ success: true, data: [{ type: 'powershell', name: 'PowerShell', executable: 'p' }] }) })
    expect(termpolis.getAvailableShells).toHaveBeenCalledTimes(1)
  })
})
