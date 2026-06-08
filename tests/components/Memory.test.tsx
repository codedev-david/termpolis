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
    memorySyncStatus: vi.fn().mockResolvedValue({ success: true, data: { syncing: false, dir: null, deviceId: 'dev01', devices: 0, count: 42 } }),
    memorySetSyncDir: vi.fn().mockResolvedValue({ success: true, data: { syncing: false, dir: null, deviceId: 'dev01', devices: 0, count: 42 } }),
    memoryChooseSyncDir: vi.fn().mockResolvedValue({ success: true, data: { syncing: true, dir: '/Users/me/Dropbox/termpolis-memory', deviceId: 'dev01', devices: 2, count: 42 } }),
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

  it('shows the cross-machine sync section, off by default', async () => {
    renderPanel()
    await waitFor(() => expect(api.memorySyncStatus).toHaveBeenCalled())
    expect(screen.getByText(/Sync across machines/i)).toBeInTheDocument()
    expect(screen.getByTestId('memory-sync-choose')).toBeInTheDocument()
  })

  it('choosing a synced folder enables sync and shows the device count', async () => {
    renderPanel()
    await waitFor(() => expect(api.memorySyncStatus).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('memory-sync-choose'))
    await waitFor(() => expect(api.memoryChooseSyncDir).toHaveBeenCalled())
    expect(await screen.findByText(/2 devices sharing this brain/i)).toBeInTheDocument()
    expect(screen.getByTestId('memory-sync-off')).toBeInTheDocument()
  })

  it('turning sync off calls set-sync-dir(null)', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: { syncing: true, dir: '/Dropbox/mem', deviceId: 'dev01', devices: 2, count: 42 } })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId('memory-sync-off')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('memory-sync-off'))
    await waitFor(() => expect(api.memorySetSyncDir).toHaveBeenCalledWith(null))
    expect(await screen.findByText(/Sync turned off/i)).toBeInTheDocument()
  })

  it('reports an error when enabling sync fails', async () => {
    api.memoryChooseSyncDir.mockResolvedValueOnce({ success: false, error: 'no folder picked' })
    renderPanel()
    await waitFor(() => expect(api.memorySyncStatus).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('memory-sync-choose'))
    expect(await screen.findByText('no folder picked')).toBeInTheDocument()
  })
})
