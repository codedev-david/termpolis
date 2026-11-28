// The sidebar's labelled Lumopolis entry: it opens the pane, wears a New badge until the first open, and
// shows the one-time hint until it is dismissed or Lumopolis is opened. Both flags live in worldSettings.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { LUMOPOLIS_HINT, LUMOPOLIS_HINT_UNTYPED, LumopolisSidebarEntry } from '../../../src/renderer/src/components/World/LumopolisSidebarEntry'
import { useTerminalStore } from '../../../src/renderer/src/store/terminalStore'
import { LUMOPOLIS_READY_EVENT, OPEN_WORLD_EVENT, WORLD_OPENED_EVENT } from '../../../src/renderer/src/components/World/worldOpen'

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

// #29. "or type lumopolis" is said only where typing it works: main answers for the active terminal (a zsh whose Termpolis
// .zshrc never ran, because a system zshenv set ZDOTDIR, has no lumopolis). With no terminal yet, or while main has not
// answered, or when it cannot say, the whole hint shows: every shell Termpolis integrates has the command.
describe('LumopolisSidebarEntry and the active terminal (#29)', () => {
  let typable: ReturnType<typeof vi.fn>
  beforeEach(() => {
    typable = vi.fn(async (id: string) => ({ success: true, data: id !== 'zsh-bare' }))
    ;(window as unknown as { termpolis: Record<string, unknown> }).termpolis.worldTerminalTypable = typable
    useTerminalStore.setState({ activeTerminalId: null })
  })

  it('drops "or type lumopolis" for an active terminal that cannot take it, keeps it for one that can, and asks once each', async () => {
    expect(LUMOPOLIS_HINT_UNTYPED).toBe('Lumopolis: see any project as a 3D city. Open it here, or click the globe on a terminal.')
    useTerminalStore.setState({ activeTerminalId: 'zsh-bare' })
    await mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByTestId('sidebar-lumopolis-hint')).toHaveTextContent(LUMOPOLIS_HINT_UNTYPED)
    expect(screen.getByTestId('sidebar-lumopolis-hint').textContent).not.toContain('type lumopolis')
    await act(async () => { useTerminalStore.setState({ activeTerminalId: 'bash-1' }); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByTestId('sidebar-lumopolis-hint')).toHaveTextContent(LUMOPOLIS_HINT)
    await act(async () => { useTerminalStore.setState({ activeTerminalId: 'zsh-bare' }); await Promise.resolve() })
    expect(screen.getByTestId('sidebar-lumopolis-hint')).toHaveTextContent(LUMOPOLIS_HINT_UNTYPED)
    expect(typable.mock.calls.map((c) => c[0])).toEqual(['zsh-bare', 'bash-1'])
  })

  it('keeps the whole hint while main is still answering and when it cannot say, and asks nothing with no terminal or no hint', async () => {
    let answer: (v: unknown) => void = () => undefined
    typable.mockReturnValueOnce(new Promise((r) => { answer = r }))
    useTerminalStore.setState({ activeTerminalId: 'slow' })
    const a = await mount()
    expect(screen.getByTestId('sidebar-lumopolis-hint')).toHaveTextContent(LUMOPOLIS_HINT)
    await act(async () => { answer({ success: false, error: 'That is not a Termpolis terminal.' }) })
    expect(screen.getByTestId('sidebar-lumopolis-hint')).toHaveTextContent(LUMOPOLIS_HINT)
    a.unmount()
    typable.mockRejectedValueOnce(new Error('gone'))
    useTerminalStore.setState({ activeTerminalId: 'broken' })
    const b = await mount()
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('sidebar-lumopolis-hint')).toHaveTextContent(LUMOPOLIS_HINT)
    b.unmount()
    typable.mockClear()
    useTerminalStore.setState({ activeTerminalId: null })
    const c = await mount()
    expect(typable).not.toHaveBeenCalled()
    c.unmount()
    get.mockResolvedValueOnce({ success: true, data: settings({ worldOpened: true }) })
    useTerminalStore.setState({ activeTerminalId: 'zsh-bare' })
    await mount()
    await act(async () => { await Promise.resolve() })
    expect(typable).not.toHaveBeenCalled()
  })

  // A zsh whose .zshrc takes longer than main waits (a plugin manager's first run) is answered no, then prints the ready mark
  // at its first prompt: the no is asked again then, once per mark, and only while it is a no and the hint shows (holdb-review M3).
  it('asks again about a terminal it was told no for when that terminal prints the ready mark, and about no other', async () => {
    const ready = (id: string): void => { window.dispatchEvent(new CustomEvent(LUMOPOLIS_READY_EVENT, { detail: id })) }
    typable.mockResolvedValueOnce({ success: true, data: false })
    useTerminalStore.setState({ activeTerminalId: 'zsh-slow' })
    await mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByTestId('sidebar-lumopolis-hint')).toHaveTextContent(LUMOPOLIS_HINT_UNTYPED)
    await act(async () => { ready('bash-1'); ready('never-asked'); await Promise.resolve(); await Promise.resolve() })
    expect(typable.mock.calls.map((c) => c[0])).toEqual(['zsh-slow'])
    await act(async () => { ready('zsh-slow'); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByTestId('sidebar-lumopolis-hint')).toHaveTextContent(LUMOPOLIS_HINT)
    await act(async () => { ready('zsh-slow'); await Promise.resolve(); await Promise.resolve() })
    expect(typable.mock.calls.map((c) => c[0])).toEqual(['zsh-slow', 'zsh-slow'])
  })

  // holdb-codex-review round 2: the only ready mark lands after main has answered no but before that answer reaches the sidebar.
  // The mark asks again, and the answer asked after the mark wins over the one asked before it, whichever lands last.
  it('asks again on a ready mark that lands while an answer is on its way, and keeps the answer asked after the mark', async () => {
    const ready = (id: string): void => { window.dispatchEvent(new CustomEvent(LUMOPOLIS_READY_EVENT, { detail: id })) }
    let first: (v: unknown) => void = () => undefined
    typable.mockReturnValueOnce(new Promise((r) => { first = r }))
    typable.mockResolvedValueOnce({ success: true, data: true })
    useTerminalStore.setState({ activeTerminalId: 'zsh-slow' })
    await mount()
    expect(typable.mock.calls.map((c) => c[0])).toEqual(['zsh-slow'])
    await act(async () => { ready('zsh-slow'); await Promise.resolve(); await Promise.resolve() })
    expect(typable.mock.calls.map((c) => c[0])).toEqual(['zsh-slow', 'zsh-slow'])
    await act(async () => { first({ success: true, data: false }); await Promise.resolve() })
    expect(screen.getByTestId('sidebar-lumopolis-hint')).toHaveTextContent(LUMOPOLIS_HINT)
    // The answer kept is the yes: a later mark asks nothing more.
    await act(async () => { ready('zsh-slow'); await Promise.resolve(); await Promise.resolve() })
    expect(typable).toHaveBeenCalledTimes(2)
  })

  it('asks nothing on a ready mark once the hint is gone', async () => {
    typable.mockResolvedValue({ success: true, data: false })
    useTerminalStore.setState({ activeTerminalId: 'zsh-slow' })
    await mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    fireEvent.click(screen.getByTestId('sidebar-lumopolis-hint-dismiss'))
    await act(async () => { window.dispatchEvent(new CustomEvent(LUMOPOLIS_READY_EVENT, { detail: 'zsh-slow' })); await Promise.resolve() })
    expect(typable).toHaveBeenCalledTimes(1)
  })

  it('an answer that lands after the sidebar is gone is dropped', async () => {
    let answer: (v: unknown) => void = () => undefined
    typable.mockReturnValueOnce(new Promise((r) => { answer = r }))
    useTerminalStore.setState({ activeTerminalId: 'late' })
    const a = await mount()
    a.unmount()
    await act(async () => { answer({ success: true, data: false }) })
    expect(screen.queryByTestId('sidebar-lumopolis-hint')).toBeNull()
  })
})
