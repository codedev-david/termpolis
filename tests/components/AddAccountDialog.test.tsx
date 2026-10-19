import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AddAccountResult, AccountRowView } from '../../src/shared/agentAccounts'
import { AddAccountDialog, CONNECT_DATA_LINE } from '../../src/renderer/src/components/Accounts/AddAccountDialog'

const HOME = 'C:\\Users\\me'

function accountRow(over: Partial<AccountRowView> = {}): AccountRowView {
  return {
    id: 'acc_000000000001', agent: 'claude', label: 'work', profile: `${HOME}\\.claude-work`, folder: `${HOME}\\.claude-work`,
    isDefault: false, autoOffer: true, order: 1, connect: false, origin: 'created', folderExists: true, shares: [],
    lastEmail: null, connection: null, bypassReady: false, terminals: 0, recopyAvailable: false, ...over,
  }
}

function result(over: Partial<AddAccountResult> = {}): AddAccountResult {
  return { account: accountRow(), leftOut: [], copied: [], changes: [], ...over }
}

function bridge(over: Record<string, unknown> = {}) {
  const accounts = {
    add: vi.fn(async () => ({ success: true, data: result() })),
    pickFolder: vi.fn(async () => ({ success: true, data: { folder: '~\\.claude-old', isDefault: false, shares: ['projects'], exists: true } })),
    ...over,
  }
  ;(window as any).accounts = accounts
  ;(window as any).termpolis = { clipboardWriteText: vi.fn(async () => ({ success: true })) }
  return accounts
}

function renderDialog(props: Partial<React.ComponentProps<typeof AddAccountDialog>> = {}) {
  const onClose = vi.fn()
  const onAdded = vi.fn()
  render(<AddAccountDialog api={(window as any).accounts} agent="claude" home={HOME} integrationConnected onClose={onClose} onAdded={onAdded} {...props} />)
  return { onClose, onAdded }
}

const box = (id: string) => screen.getByTestId(id) as HTMLInputElement
const type = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } })

afterEach(() => {
  delete (window as any).accounts
  delete (window as any).termpolis
})

describe('AddAccountDialog: a Claude Code account in a new folder', () => {
  it('names the folder from the label, shares the default subfolders, copies, and connects only when offered (R17)', async () => {
    const api = bridge()
    const { onAdded } = renderDialog()
    expect(screen.getByTestId('add-account-folder')).toHaveTextContent('~\\.claude-…')
    type('add-account-label', 'Side Project')
    expect(screen.getByTestId('add-account-folder')).toHaveTextContent('~\\.claude-side-project')
    for (const name of ['projects', 'commands', 'skills', 'agents']) expect(box(`add-account-share-${name}`).checked).toBe(true)
    for (const name of ['plugins', 'hooks']) expect(box(`add-account-share-${name}`).checked).toBe(false)
    expect(box('add-account-copy').checked).toBe(true)
    expect(box('add-account-auto-offer').checked).toBe(true)
    expect(box('add-account-connect-box').checked).toBe(true)
    expect(screen.getByTestId('add-account-connect')).toHaveTextContent(CONNECT_DATA_LINE)
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
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await waitFor(() => expect(api.add).toHaveBeenCalled())
    expect(api.add).toHaveBeenCalledWith({
      agent: 'claude', label: 'Side Project', email: 's@example.test', folder: 'new',
      share: ['projects', 'commands', 'skills', 'plugins'], copy: false, connect: true, autoOffer: false,
    })
    expect(await screen.findByTestId('add-account-done')).toHaveTextContent('Added work')
    expect(onAdded).toHaveBeenCalledWith(result())
  })

  it('warns when the conversations folder isn\'t shared', () => {
    bridge()
    renderDialog()
    expect(screen.queryByTestId('add-account-projects-warning')).toBeNull()
    fireEvent.click(box('add-account-share-projects'))
    expect(screen.getByTestId('add-account-projects-warning')).toHaveTextContent('won\'t follow this account')
  })

  it('refuses a name that gives no folder, and an email that isn\'t plain, before asking main', () => {
    const api = bridge()
    renderDialog()
    const submit = screen.getByTestId('add-account-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    type('add-account-label', '!!!')
    expect(screen.getByTestId('add-account-folder')).toHaveTextContent('Use letters or digits')
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
    renderDialog()
    type('add-account-label', 'ok')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    expect(await screen.findByTestId('add-account-error')).toHaveTextContent('already has an account named ok')
    expect((screen.getByTestId('add-account-label') as HTMLInputElement).value).toBe('ok')
  })

  it('reports a bridge that throws, an Error or not', async () => {
    bridge({ add: vi.fn().mockRejectedValueOnce(new Error('IPC gone')).mockRejectedValueOnce('a bare string') })
    renderDialog()
    type('add-account-label', 'ok')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    expect(await screen.findByTestId('add-account-error')).toHaveTextContent('IPC gone')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await waitFor(() => expect(screen.getByTestId('add-account-error')).toHaveTextContent('a bare string'))
  })

  it('names the new folder with the home folder\'s own separator on macOS and Linux', () => {
    bridge()
    renderDialog({ home: '/home/me' })
    type('add-account-label', 'side')
    expect(screen.getByTestId('add-account-folder')).toHaveTextContent('~/.claude-side')
  })

  it('can\'t connect while Agent Integration is off, and says so', async () => {
    const api = bridge()
    renderDialog({ integrationConnected: false })
    expect(box('add-account-connect-box').checked).toBe(false)
    expect(box('add-account-connect-box').disabled).toBe(true)
    expect(screen.getByTestId('add-account-connect-off')).toHaveTextContent('Turn on Agent Integration first')
    type('add-account-label', 'ok')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await waitFor(() => expect(api.add).toHaveBeenCalled())
    expect(api.add.mock.calls[0][0]).toMatchObject({ connect: false })
  })
})

describe('AddAccountDialog: an existing folder', () => {
  it('adopts the folder main\'s own dialog picked, and shows what it shares', async () => {
    const api = bridge()
    renderDialog()
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
    renderDialog()
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
    bridge({ pickFolder: pick })
    renderDialog()
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
  })
})

describe('AddAccountDialog: Codex and agy', () => {
  it('shares Codex\'s sessions, copies config.toml, and warns when sessions aren\'t shared', () => {
    bridge()
    renderDialog({ agent: 'codex' })
    expect(screen.getByTestId('add-account-folder')).toHaveTextContent('~\\.codex-…')
    expect(box('add-account-share-sessions').checked).toBe(true)
    expect(screen.getByText('Start from a copy of my config.toml')).toBeInTheDocument()
    fireEvent.click(box('add-account-share-sessions'))
    expect(screen.getByTestId('add-account-sessions-warning')).toBeInTheDocument()
    expect(screen.getByTestId('add-account-writes')).toHaveTextContent('config.toml')
  })

  it('keeps an agy account to a name and a Google email: no folder, nothing to connect', async () => {
    const api = bridge({ add: vi.fn(async () => ({ success: true, data: result({ account: accountRow({ agent: 'agy', label: 'g', profile: null, folder: null, folderExists: false }) }) })) })
    renderDialog({ agent: 'agy' })
    expect(screen.queryByTestId('add-account-folder')).toBeNull()
    expect(screen.queryByTestId('add-account-connect')).toBeNull()
    expect(screen.getByText(/one Google sign-in for your whole computer user/)).toBeInTheDocument()
    type('add-account-label', 'g')
    type('add-account-email', 'g@example.test')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await waitFor(() => expect(api.add).toHaveBeenCalledWith({ agent: 'agy', label: 'g', email: 'g@example.test', autoOffer: true }))
    const done = await screen.findByTestId('add-account-done')
    expect(done).not.toHaveTextContent('Sign in, in its row')
  })
})

describe('AddAccountDialog: what was made', () => {
  it('lists the notes, the copy, what was left out, the writes, and the accounts.sh lines with Copy', async () => {
    bridge({
      add: vi.fn(async () => ({
        success: true,
        data: result({
          notes: ['Your main Claude Code profile is listed too, as main.'],
          copied: ['settings.json', 'CLAUDE.md'],
          leftOut: ['env', 'apiKeyHelper'],
          changes: [
            { agent: 'claude', file: `${HOME}\\.claude-work\\.claude.json`, action: 'add', what: 'MCP server' },
            { agent: 'claude', file: `${HOME}\\.claude-work\\settings.json`, action: 'skipped', what: 'Tool permissions', error: 'EACCES' },
          ],
          accountsShLines: ['ACCOUNTS=(personal work)   # add work', '  [work]=""   # in ACCOUNT_EMAIL'],
        }),
      })),
    })
    const { onClose } = renderDialog()
    type('add-account-label', 'work')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    const done = await screen.findByTestId('add-account-done')
    expect(done).toHaveTextContent('~\\.claude-work')
    expect(screen.getByTestId('add-account-note')).toHaveTextContent('listed too, as main')
    expect(screen.getByTestId('add-account-copied')).toHaveTextContent('settings.json, CLAUDE.md')
    expect(screen.getByTestId('add-account-left-out')).toHaveTextContent('env, apiKeyHelper')
    expect(screen.getByTestId('add-account-changes')).toHaveTextContent('skipped Tool permissions: EACCES')
    expect(done).toHaveTextContent('Sign in, in its row')
    fireEvent.click(screen.getByTestId('add-account-copy-lines'))
    await waitFor(() => expect((window as any).termpolis.clipboardWriteText).toHaveBeenCalledWith('ACCOUNTS=(personal work)   # add work\n  [work]=""   # in ACCOUNT_EMAIL'))
    expect(await screen.findByText('Copied')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('add-account-close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('says nothing was copied when the clipboard refuses or throws', async () => {
    bridge({ add: vi.fn(async () => ({ success: true, data: result({ accountsShLines: ['x'] }) })) })
    ;(window as any).termpolis = { clipboardWriteText: vi.fn().mockResolvedValueOnce({ success: false, error: 'no' }).mockRejectedValueOnce(new Error('gone')) }
    renderDialog()
    type('add-account-label', 'work')
    fireEvent.click(screen.getByTestId('add-account-submit'))
    await screen.findByTestId('add-account-done')
    fireEvent.click(screen.getByTestId('add-account-copy-lines'))
    await waitFor(() => expect((window as any).termpolis.clipboardWriteText).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('add-account-copy-lines'))
    await waitFor(() => expect((window as any).termpolis.clipboardWriteText).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Copied')).toBeNull()
  })

  it('cancels without asking main', () => {
    const api = bridge()
    const { onClose } = renderDialog()
    fireEvent.click(screen.getByTestId('add-account-cancel'))
    expect(onClose).toHaveBeenCalled()
    expect(api.add).not.toHaveBeenCalled()
  })
})
