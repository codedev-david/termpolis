// The sidebar's labelled Lumopolis entry: it opens the pane, wears a New badge until the first open, and
// shows the one-time hint until it is dismissed or Lumopolis is opened. Both flags live in worldSettings.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { LUMOPOLIS_HINT, LumopolisSidebarEntry } from '../../../src/renderer/src/components/World/LumopolisSidebarEntry'
import { OPEN_WORLD_EVENT, WORLD_OPENED_EVENT } from '../../../src/renderer/src/components/World/worldOpen'

const settings = (over: Partial<{ worldOpened: boolean; worldHintDismissed: boolean }> = {}) => ({
  worldLabelling: true, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude' as const,
  worldOpened: false, worldHintDismissed: false, ...over,
})

let get: ReturnType<typeof vi.fn>
let set: ReturnType<typeof vi.fn>
beforeEach(() => {
  get = vi.fn(async () => ({ success: true, data: settings() }))
  set = vi.fn(async () => ({ success: true, data: settings({ worldHintDismissed: true }) }))
  ;(window as unknown as { termpolis: unknown }).termpolis = { worldSettingsGet: get, worldSettingsSet: set }
})

const mount = async (): Promise<ReturnType<typeof render>> => {
  const view = render(<LumopolisSidebarEntry />)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return view
}

describe('LumopolisSidebarEntry', () => {
  it('is the globe and the word, and opens Lumopolis following the active terminal', async () => {
    await mount()
    const entry = screen.getByTestId('sidebar-lumopolis-entry')
    expect(entry).toHaveTextContent('Lumopolis')
    expect(entry.querySelector('.fa-earth-americas')).not.toBeNull()
    const onOpen = vi.fn()
    window.addEventListener(OPEN_WORLD_EVENT, onOpen)
    fireEvent.click(entry)
    window.removeEventListener(OPEN_WORLD_EVENT, onOpen)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toBeNull()
  })

  it('shows the New badge and the hint, word for word, until Lumopolis has been opened', async () => {
    await mount()
    expect(screen.getByTestId('sidebar-lumopolis-new')).toHaveTextContent('New')
    expect(screen.getByTestId('sidebar-lumopolis-hint')).toHaveTextContent(LUMOPOLIS_HINT)
    expect(LUMOPOLIS_HINT).toBe('Lumopolis: see any project as a 3D city. Open it here, click the globe on a terminal, or type lumopolis.')
    act(() => { window.dispatchEvent(new Event(WORLD_OPENED_EVENT)) })
    expect(screen.queryByTestId('sidebar-lumopolis-new')).toBeNull()
    expect(screen.queryByTestId('sidebar-lumopolis-hint')).toBeNull()
  })

  it('shows neither once Lumopolis has been opened before', async () => {
    get.mockResolvedValueOnce({ success: true, data: settings({ worldOpened: true }) })
    await mount()
    expect(screen.getByTestId('sidebar-lumopolis-entry')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-lumopolis-new')).toBeNull()
    expect(screen.queryByTestId('sidebar-lumopolis-hint')).toBeNull()
  })

  it('dismissing the hint saves it and keeps the badge; a dismissed hint never comes back', async () => {
    const first = await mount()
    fireEvent.click(screen.getByTestId('sidebar-lumopolis-hint-dismiss'))
    expect(screen.queryByTestId('sidebar-lumopolis-hint')).toBeNull()
    expect(screen.getByTestId('sidebar-lumopolis-new')).toBeInTheDocument()
    await act(async () => { await Promise.resolve() })
    expect(set).toHaveBeenCalledWith({ worldHintDismissed: true })
    first.unmount()
    get.mockResolvedValueOnce({ success: true, data: settings({ worldHintDismissed: true }) })
    await mount()
    expect(screen.getByTestId('sidebar-lumopolis-new')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-lumopolis-hint')).toBeNull()
  })

  it('shows no badge or hint until the settings answer, nor when they fail', async () => {
    get.mockResolvedValueOnce({ success: false, error: 'x' })
    const a = await mount()
    expect(screen.queryByTestId('sidebar-lumopolis-new')).toBeNull()
    a.unmount()
    get.mockRejectedValueOnce(new Error('gone'))
    await mount()
    expect(screen.queryByTestId('sidebar-lumopolis-hint')).toBeNull()
  })

  it('an open or a dismissal before the settings answer still hides what it should', async () => {
    let answer: (v: unknown) => void = () => undefined
    get.mockReturnValueOnce(new Promise((r) => { answer = r }))
    const a = render(<LumopolisSidebarEntry />)
    act(() => { window.dispatchEvent(new Event(WORLD_OPENED_EVENT)) })
    expect(screen.queryByTestId('sidebar-lumopolis-new')).toBeNull()
    a.unmount()
    await act(async () => { answer({ success: true, data: settings() }) }) // too late: unmounted, ignored
  })

  it('an open before the settings answer stays opened when the (stale) answer lands while mounted', async () => {
    let answer: (v: unknown) => void = () => undefined
    get.mockReturnValueOnce(new Promise((r) => { answer = r }))
    render(<LumopolisSidebarEntry />)
    act(() => { window.dispatchEvent(new Event(WORLD_OPENED_EVENT)) })
    await act(async () => { answer({ success: true, data: settings() }) }) // says never opened: read before the open
    expect(screen.queryByTestId('sidebar-lumopolis-new')).toBeNull()
    expect(screen.queryByTestId('sidebar-lumopolis-hint')).toBeNull()
  })

  it('a dismissal that cannot be saved still hides the hint', async () => {
    set.mockRejectedValueOnce(new Error('disk'))
    await mount()
    fireEvent.click(screen.getByTestId('sidebar-lumopolis-hint-dismiss'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByTestId('sidebar-lumopolis-hint')).toBeNull()
  })
})
