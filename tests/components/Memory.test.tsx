import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Memory } from '../../src/renderer/src/components/Memory/Memory'

type Api = Record<string, ReturnType<typeof vi.fn>>
let api: Api

beforeEach(() => {
  api = {
    memoryStats: vi.fn().mockResolvedValue({ success: true, data: { count: 42, capacity: 50000 } }),
    memorySearch: vi.fn().mockResolvedValue({ success: true, data: [] }),
    memoryIngestConversations: vi.fn().mockResolvedValue({ success: true, data: { filesScanned: 3, chunksWritten: 5, chunksSkipped: 1 } }),
    memoryIngestCode: vi.fn().mockResolvedValue({ success: true, data: { filesScanned: 10, filesSkipped: 2, chunksWritten: 20, chunksSkipped: 0 } }),
    memoryBuildPrimer: vi.fn().mockResolvedValue({ success: true, data: 'PRIMER TEXT' }),
    memorySyncStatus: vi.fn().mockResolvedValue({ success: true, data: { syncing: false, dir: null, deviceId: 'dev01', devices: 0, count: 42, encrypted: false, locked: false } }),
    memorySetSyncDir: vi.fn().mockResolvedValue({ success: true, data: { syncing: false, dir: null, deviceId: 'dev01', devices: 0, count: 42, encrypted: false, locked: false } }),
    memoryChooseSyncDir: vi.fn().mockResolvedValue({ success: true, data: { syncing: true, dir: '/Users/me/Dropbox/termpolis-memory', deviceId: 'dev01', devices: 2, count: 42, encrypted: false, locked: false } }),
    memorySetSyncPassphrase: vi.fn().mockResolvedValue({ success: true, data: { syncing: true, dir: '/d', deviceId: 'dev01', devices: 1, count: 42, encrypted: true, locked: false } }),
    memoryDisableSyncEncryption: vi.fn().mockResolvedValue({ success: true, data: { syncing: true, dir: '/d', deviceId: 'dev01', devices: 1, count: 42, encrypted: false, locked: false } }),
    memoryStartNewKey: vi.fn().mockResolvedValue({ success: true, data: { syncing: false, dir: null, deviceId: 'dev01', devices: 0, count: 3, encrypted: true, locked: true, ownLocked: false, lockReason: null } }),
    writeToTerminal: vi.fn(),
  }
  ;(window as unknown as { termpolis: Api }).termpolis = api
})

function renderPanel(over: Partial<{ activeTerminalId: string | null; activeCwd: string; onClose: () => void }> = {}) {
  const onClose = over.onClose ?? vi.fn()
  render(
    <Memory
      onClose={onClose}
      activeTerminalId={over.activeTerminalId === undefined ? 't1' : over.activeTerminalId}
      activeCwd={over.activeCwd === undefined ? '/repo' : over.activeCwd}
    />,
  )
  return { onClose }
}

describe('Memory panel', () => {
  it('renders header and loads stats on mount', async () => {
    renderPanel()
    expect(screen.getByText('Memory')).toBeInTheDocument()
    await waitFor(() => expect(api.memoryStats).toHaveBeenCalled())
    expect(await screen.findByText('42')).toBeInTheDocument()
    expect(screen.getByText(/50,000 hot/)).toBeInTheDocument()
  })

  it('stays on "Loading…" when stats fail to load', async () => {
    api.memoryStats.mockResolvedValueOnce({ success: false, error: 'nope' })
    renderPanel()
    await waitFor(() => expect(api.memoryStats).toHaveBeenCalled())
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('calls onClose from the close button', async () => {
    const { onClose } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /close memory panel/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('search is disabled until a query is typed, then shows results', async () => {
    api.memorySearch.mockResolvedValueOnce({ success: true, data: [{ id: 'm1', kind: 'note', source: 'claude', content: 'auth uses JWT', score: 0.9 }] })
    renderPanel()
    const search = screen.getByRole('button', { name: 'Search' })
    expect(search).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Memory query'), { target: { value: 'auth' } })
    expect(search).not.toBeDisabled()
    fireEvent.click(search)
    await waitFor(() => expect(api.memorySearch).toHaveBeenCalledWith({ query: 'auth', limit: 10 }))
    expect(await screen.findByText('auth uses JWT')).toBeInTheDocument()
    expect(screen.getByText('1 result')).toBeInTheDocument()
  })

  it('Enter in the query box triggers search', async () => {
    renderPanel()
    fireEvent.change(screen.getByLabelText('Memory query'), { target: { value: 'rate limit' } })
    fireEvent.keyDown(screen.getByLabelText('Memory query'), { key: 'Enter' })
    await waitFor(() => expect(api.memorySearch).toHaveBeenCalled())
  })

  it('reports a failed search', async () => {
    api.memorySearch.mockResolvedValueOnce({ success: false, error: 'boom' })
    renderPanel()
    fireEvent.change(screen.getByLabelText('Memory query'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('Search failed')).toBeInTheDocument()
  })

  it('inject primer: warns when no query', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Inject primer' }))
    expect(await screen.findByText(/Type what you are working on/)).toBeInTheDocument()
    expect(api.memoryBuildPrimer).not.toHaveBeenCalled()
  })

  it('inject primer: warns when no active terminal', async () => {
    renderPanel({ activeTerminalId: null })
    fireEvent.change(screen.getByLabelText('Memory query'), { target: { value: 'auth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Inject primer' }))
    expect(await screen.findByText(/No active terminal/)).toBeInTheDocument()
    expect(api.memoryBuildPrimer).not.toHaveBeenCalled()
  })

  it('inject primer: injects into the active terminal on success', async () => {
    renderPanel({ activeTerminalId: 't9' })
    fireEvent.change(screen.getByLabelText('Memory query'), { target: { value: 'auth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Inject primer' }))
    await waitFor(() => expect(api.memoryBuildPrimer).toHaveBeenCalledWith('auth'))
    expect(api.writeToTerminal).toHaveBeenCalledTimes(1)
    expect(api.writeToTerminal.mock.calls[0][0]).toBe('t9')
    expect(api.writeToTerminal.mock.calls[0][1]).toContain('PRIMER TEXT')
    expect(api.writeToTerminal.mock.calls[0][1].startsWith('\x1b[200~')).toBe(true) // bracketed-paste wrapped
    expect(await screen.findByText(/Primer injected/)).toBeInTheDocument()
  })

  it('inject primer: handles no relevant memory', async () => {
    api.memoryBuildPrimer.mockResolvedValueOnce({ success: true, data: null })
    renderPanel()
    fireEvent.change(screen.getByLabelText('Memory query'), { target: { value: 'nothing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Inject primer' }))
    expect(await screen.findByText(/No relevant memory/)).toBeInTheDocument()
    expect(api.writeToTerminal).not.toHaveBeenCalled()
  })

  it('indexes past conversations and refreshes stats', async () => {
    renderPanel()
    await waitFor(() => expect(api.memoryStats).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /Index past conversations/i }))
    expect(await screen.findByText(/\+5 new chunks/)).toBeInTheDocument()
    await waitFor(() => expect(api.memoryStats).toHaveBeenCalledTimes(2))
  })

  it('surfaces an ingest failure', async () => {
    api.memoryIngestConversations.mockResolvedValueOnce({ success: false, error: 'disk full' })
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Index past conversations/i }))
    expect(await screen.findByText('disk full')).toBeInTheDocument()
  })

  it('index-this-repo is disabled without a cwd, enabled with one', async () => {
    const { onClose: _ } = renderPanel({ activeCwd: '' })
    expect(screen.getByRole('button', { name: /Index this repo/i })).toBeDisabled()
  })

  it('indexes the active repo when a cwd is present', async () => {
    renderPanel({ activeCwd: '/work/app' })
    fireEvent.click(screen.getByRole('button', { name: /Index this repo/i }))
    await waitFor(() => expect(api.memoryIngestCode).toHaveBeenCalledWith('/work/app'))
    expect(await screen.findByText(/\+20 chunks from 10 files/)).toBeInTheDocument()
  })

  // Decision 5: v1 sync can lock or overwrite a brain, so it can no longer be turned ON from here (main
  // refuses it too). The section says so, and offers nothing that would call a sync channel.
  it('shows cross-machine sync as unavailable, with no way to turn it on', async () => {
    renderPanel()
    await waitFor(() => expect(api.memorySyncStatus).toHaveBeenCalled())
    expect(screen.getByText(/Sync across machines/i)).toBeInTheDocument()
    expect(screen.getByTestId('memory-sync-unavailable')).toHaveTextContent(/Unavailable in this version/)
    expect(screen.queryByTestId('memory-sync-choose')).not.toBeInTheDocument()
    expect(screen.queryByTestId('memory-sync-passphrase')).not.toBeInTheDocument()
    expect(screen.queryByTestId('memory-sync-disable-enc')).not.toBeInTheDocument()
    expect(api.memoryChooseSyncDir).not.toHaveBeenCalled()
    expect(api.memorySetSyncPassphrase).not.toHaveBeenCalled()
    expect(api.memoryDisableSyncEncryption).not.toHaveBeenCalled()
  })

  it('a sync session still running can be turned off — and nothing else about it is offered', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: { syncing: true, dir: '/Dropbox/mem', deviceId: 'dev01', devices: 2, count: 42, encrypted: true, locked: true } })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId('memory-sync-off')).toBeInTheDocument())
    expect(screen.getByText(/2 devices sharing this brain/i)).toBeInTheDocument()
    expect(screen.queryByTestId('memory-sync-passphrase')).not.toBeInTheDocument()
    expect(screen.queryByTestId('memory-sync-disable-enc')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('memory-sync-off'))
    await waitFor(() => expect(api.memorySetSyncDir).toHaveBeenCalledWith(null))
    expect(await screen.findByText(/this computer's own memory is back, exactly as it was/i)).toBeInTheDocument()
  })
})

// Decisions 1-2: a LOCKED brain is shown, with the reason and what would bring it back, and the only
// way past it is the user's own two-step "Start a new memory key".
describe('Memory panel — LOCKED', () => {
  const LOCKED = { syncing: false, dir: null, deviceId: 'dev01', devices: 0, count: 0, encrypted: false, locked: true, ownLocked: true }

  it.each([
    ['keychain-unavailable', /OS keychain that protects this computer's memory key isn't available/],
    ['key-unreadable', /couldn't unwrap its memory key/],
    ['key-invalid', /memory key file on this computer is damaged/],
    ['key-mismatch', /doesn't match the memories on disk/],
  ])('says why when the reason is %s', async (lockReason, copy) => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: { ...LOCKED, lockReason } })
    renderPanel()
    const banner = await screen.findByTestId('memory-locked')
    expect(banner).toHaveTextContent(/Memory is locked — nothing new is being saved/)
    expect(banner).toHaveTextContent(copy)
  })

  it('falls back to a plain explanation for a reason it does not know', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: { ...LOCKED, lockReason: null } })
    renderPanel()
    expect(await screen.findByTestId('memory-locked')).toHaveTextContent(/can't open your memories with the key on this computer/)
  })

  it('shows no banner when memory is not locked', async () => {
    renderPanel()
    await waitFor(() => expect(api.memorySyncStatus).toHaveBeenCalled())
    expect(screen.queryByTestId('memory-locked')).not.toBeInTheDocument()
  })

  it('Start a new memory key asks first — saying older memories stay on disk — and only then acts', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: { ...LOCKED, lockReason: 'key-unreadable' } })
    renderPanel()
    fireEvent.click(await screen.findByTestId('memory-new-key'))
    expect(api.memoryStartNewKey).not.toHaveBeenCalled()
    expect(screen.getByTestId('memory-locked')).toHaveTextContent(/Older memories stay on disk, unreadable until the old key works again/)
    expect(screen.getByTestId('memory-locked')).toHaveTextContent(/Nothing is deleted/)

    fireEvent.click(screen.getByTestId('memory-new-key-confirm'))
    await waitFor(() => expect(api.memoryStartNewKey).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/New memory key started/)).toBeInTheDocument()
    expect(screen.queryByTestId('memory-locked')).not.toBeInTheDocument()
    await waitFor(() => expect(api.memoryStats).toHaveBeenCalledTimes(2))
  })

  it('Cancel backs out without doing anything', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: { ...LOCKED, lockReason: 'key-mismatch' } })
    renderPanel()
    fireEvent.click(await screen.findByTestId('memory-new-key'))
    fireEvent.click(screen.getByTestId('memory-new-key-cancel'))
    expect(screen.getByTestId('memory-new-key')).toBeInTheDocument()
    expect(api.memoryStartNewKey).not.toHaveBeenCalled()
  })

  it('a refusal keeps the banner up and says why', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: { ...LOCKED, lockReason: 'keychain-unavailable' } })
    api.memoryStartNewKey.mockResolvedValueOnce({ success: false, error: "This computer has no OS keychain to protect a new memory key, so one can't be started." })
    renderPanel()
    fireEvent.click(await screen.findByTestId('memory-new-key'))
    fireEvent.click(screen.getByTestId('memory-new-key-confirm'))
    expect(await screen.findByText(/no OS keychain to protect a new memory key/)).toBeInTheDocument()
    expect(screen.getByTestId('memory-locked')).toBeInTheDocument()
  })

  it('a refusal with no reason still says something', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: { ...LOCKED, lockReason: 'key-invalid' } })
    api.memoryStartNewKey.mockResolvedValueOnce({ success: false })
    renderPanel()
    fireEvent.click(await screen.findByTestId('memory-new-key'))
    fireEvent.click(screen.getByTestId('memory-new-key-confirm'))
    expect(await screen.findByText('Could not start a new memory key.')).toBeInTheDocument()
  })
})
