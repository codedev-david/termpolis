import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup, within } from '@testing-library/react'
import type { WorldDoc, WorldEntry, WorldProgressEvent, WorldUpdatedEvent } from '../../../src/shared/world/types'
import type { WorldSelection, WorldViewerOptions } from '../../../src/renderer/src/world/engine'
import { buildingCard, edgeCard } from '../../../src/renderer/src/world/engine'
import { minimal } from './helpers'

// The engine is real except the two things jsdom cannot do: a WebGL probe and a WebGL viewer.
const h = vi.hoisted(() => ({ webgl: true, viewers: [] as any[] }))
vi.mock('../../../src/renderer/src/world/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/renderer/src/world/engine')>()
  return {
    ...real,
    hasWebGL: () => h.webgl,
    createWorldViewer: vi.fn((host: HTMLElement, opts: WorldViewerOptions) => {
      const selectCbs = new Set<(s: WorldSelection | null) => void>()
      const v = {
        host, opts,
        load: vi.fn(), setLayers: vi.fn(), setTheme: vi.fn(), setRightReserve: vi.fn(), setBottomReserve: vi.fn(), setCardReserve: vi.fn(),
        apply: vi.fn(async () => undefined), play: vi.fn(async () => undefined), cancelActions: vi.fn(),
        on: vi.fn((ev: string, cb: (s: WorldSelection | null) => void) => {
          if (ev !== 'select') return () => undefined
          selectCbs.add(cb)
          return () => { selectCbs.delete(cb) }
        }),
        emitSelect: (s: WorldSelection | null) => { for (const cb of selectCbs) cb(s) },
        selectListeners: () => selectCbs.size,
        getSelection: vi.fn(() => []), cameraRegion: vi.fn(() => []), resetView: vi.fn(), setPaused: vi.fn(), dispose: vi.fn(),
        screenPoint: vi.fn((id: string) => (id === 'b1' ? { x: 1, y: 2 } : null)),
        linePoints: vi.fn((id: string) => (id === 'e1' ? [{ x: 3, y: 4 }] : [])),
        pickAt: vi.fn((x: number) => (x === 1 ? { kind: 'node', id: 'b1' } : null)),
        drawn: vi.fn(() => ({ layers: real.DEFAULT_LAYERS, processShells: 0, conduits: 4 })),
        cameraState: vi.fn((): { pos: number[]; target: number[] } | null => ({ pos: [1, 2, 3], target: [4, 5, 6] })),
        setCamera: vi.fn(async () => undefined),
      }
      h.viewers.push(v)
      return v
    }),
  }
})

import { WorldView } from '../../../src/renderer/src/components/World'
import { useTerminalStore } from '../../../src/renderer/src/store/terminalStore'
import { focusables } from '../../../src/renderer/src/hooks/useFocusTrap'

type Res<T> = { success: true; data: T } | { success: false; error: string }
const ok = <T,>(data: T): Res<T> => ({ success: true, data })
const fail = (error: string): Res<never> => ({ success: false, error })

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function bridge(over: Record<string, unknown> = {}) {
  const progress = new Set<(e: WorldProgressEvent) => void>()
  const updated = new Set<(e: WorldUpdatedEvent) => void>()
  const api = {
    gitFindRoot: vi.fn(async (cwd: string) => ok<string | null>(cwd)),
    worldSourcesList: vi.fn(async () => ok<WorldEntry[]>([])),
    worldGet: vi.fn(async (_root: string): Promise<Res<WorldDoc | null>> => ok(minimal())),
    worldCompile: vi.fn(async (_root: string): Promise<Res<WorldDoc>> => ok(minimal())),
    worldMapProject: vi.fn(async (root: string) => ok({ key: root, source: { kind: 'project', root }, title: root, lastOpened: 1 } as WorldEntry)),
    worldRelayout: vi.fn(async (_root: string): Promise<Res<WorldDoc>> => ok(minimal())),
    onWorldProgress: vi.fn((cb: (e: WorldProgressEvent) => void) => { progress.add(cb); return () => { progress.delete(cb) } }),
    onWorldUpdated: vi.fn((cb: (e: WorldUpdatedEvent) => void) => { updated.add(cb); return () => { updated.delete(cb) } }),
    ...over,
  }
  ;(window as any).termpolis = api
  return {
    api,
    progress: (e: WorldProgressEvent) => act(() => { for (const cb of progress) cb(e) }),
    updated: async (e: WorldUpdatedEvent) => { await act(async () => { for (const cb of updated) cb(e) }) },
    listeners: () => progress.size + updated.size,
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}
const viewer = () => h.viewers[h.viewers.length - 1]
const dialog = () => screen.getByRole('region', { name: 'Lumopolis' })
const esc = (target: Element = dialog()) => fireEvent.keyDown(target, { key: 'Escape' })

async function mount(props: Partial<{ root: string; onClose: () => void; askSlot: (v: unknown) => React.ReactNode }> = {}) {
  const onClose = props.onClose ?? vi.fn()
  const utils = render(<WorldView root={props.root ?? '/repo'} onClose={onClose} askSlot={props.askSlot as never} />)
  await settle()
  return { ...utils, onClose }
}

beforeEach(() => {
  h.webgl = true
  h.viewers.length = 0
  localStorage.clear()
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
})

describe('WorldView', () => {
  it('shows "Mapping your project…" with progress while worldGet returns null and progress events arrive', async () => {
    const compile = deferred<Res<WorldDoc>>()
    const b = bridge({ worldGet: vi.fn(async () => ok(null)), worldCompile: vi.fn(() => compile.promise) })
    await mount()
    expect(dialog()).toBeInTheDocument()
    expect(screen.getByText('Mapping your project…')).toBeInTheDocument()
    expect(screen.getByTestId('world-progress-text')).toHaveTextContent('Starting…')
    expect(b.api.worldCompile).toHaveBeenCalledWith('/repo')

    b.progress({ root: '/repo', projectKey: 'k', stage: 'layout', pct: 40 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    expect(screen.getByTestId('world-progress-text')).toHaveTextContent('40% · layout')
    // Someone else's compile is not ours.
    b.progress({ root: '/other', projectKey: 'other', stage: 'labels', pct: 90 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    // The bar stays within 0..100.
    b.progress({ root: '/repo', projectKey: 'k', stage: 'done', pct: 140 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    b.progress({ root: '/repo', projectKey: 'k', stage: 'start', pct: -3 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')

    const doc = minimal()
    await act(async () => { compile.resolve(ok(doc)) })
    await settle()
    expect(screen.queryByTestId('world-empty')).toBeNull()
    expect(viewer().load).toHaveBeenLastCalledWith(doc)
  })

  it('mounts viewer and loads doc on world:updated', async () => {
    const first = minimal()
    const second = { ...minimal(), generatedAt: 2 }
    const b = bridge({ worldGet: vi.fn().mockResolvedValueOnce(ok(first)).mockResolvedValue(ok(second)) })
    await mount()
    const { createWorldViewer } = await import('../../../src/renderer/src/world/engine')
    expect(createWorldViewer).toHaveBeenCalledTimes(1)
    expect((createWorldViewer as unknown as { mock: { calls: [HTMLElement, WorldViewerOptions][] } }).mock.calls[0][1].rightReserve).toBe(108) // the legend chip's footprint: the default pane is narrow
    expect(viewer().host).toBe(screen.getByTestId('world-canvas-host'))
    expect(viewer().load).toHaveBeenLastCalledWith(first)

    // Another project's update is ignored.
    await b.updated({ root: '/other', projectKey: 'other' })
    expect(b.api.worldGet).toHaveBeenCalledTimes(1)
    // Ours, by root.
    await b.updated({ root: '/repo', projectKey: 'x' })
    await settle()
    expect(b.api.worldGet).toHaveBeenLastCalledWith('/repo')
    expect(viewer().load).toHaveBeenLastCalledWith(second, { animateFrom: first }) // the same project: it grows from the last one
    // Ours, by project key (a watcher names the repo by another spelling).
    await b.updated({ root: 'C:/elsewhere', projectKey: first.projectKey })
    await settle()
    expect(b.api.worldGet).toHaveBeenCalledTimes(3)
  })

  it('an update whose fetch fails, comes back empty or arrives for an old root changes nothing', async () => {
    const later = deferred<Res<WorldDoc | null>>()
    const b = bridge()
    const { rerender, onClose } = await mount()
    const loads = viewer().load.mock.calls.length
    b.api.worldGet.mockResolvedValueOnce(fail('gone'))
    await b.updated({ root: '/repo', projectKey: 'k' })
    b.api.worldGet.mockResolvedValueOnce(ok(null))
    await b.updated({ root: '/repo', projectKey: 'k' })
    b.api.worldGet.mockRejectedValueOnce(new Error('ipc down'))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(viewer().load).toHaveBeenCalledTimes(loads)

    // The fetch resolves after the pane moved to another project: dropped.
    b.api.worldGet.mockReturnValueOnce(later.promise)
    await b.updated({ root: '/repo', projectKey: 'k' })
    const next = deferred<Res<WorldDoc | null>>()
    b.api.worldGet.mockReturnValueOnce(next.promise)
    rerender(<WorldView root="/next" onClose={onClose} />)
    await settle()
    await act(async () => { later.resolve(ok({ ...minimal(), projectKey: 'stale' })) })
    await settle()
    expect(viewer().load.mock.calls.some((c: [WorldDoc]) => c[0].projectKey === 'stale')).toBe(false)

    // With no project at all, a matching project key has no root to fetch from.
    rerender(<WorldView root="" onClose={onClose} />)
    await settle()
    const calls = b.api.worldGet.mock.calls.length
    await b.updated({ root: '/x', projectKey: '3f9a1c0e7b2d4a68' })
    expect(b.api.worldGet).toHaveBeenCalledTimes(calls)
  })

  const withPlan = (): WorldDoc => {
    const d = minimal()
    d.layers.plan.push(
      { id: 'pA', title: 'Alpha plan', summary: [], buildings: [], edges: [] },
      { id: 'design:p', title: 'Linked design', summary: [], buildings: [], edges: [], reconcile: { matched: {}, missing: [], extra: [], changed: [], planAt: 1 } }
    )
    return d
  }

  it('the selector lists every plan proposal and defaults to the linked design', async () => {
    bridge({ worldGet: vi.fn(async () => ok(withPlan())) })
    const askSlot = vi.fn(() => <span>ask</span>)
    await mount({ askSlot })
    const sel = screen.getByTestId('world-proposal') as HTMLSelectElement
    expect([...sel.options].map((o) => o.textContent)).toEqual(['No proposal', 'Alpha plan', 'Linked design'])
    expect(sel.value).toBe('design:p')
    expect(viewer().setLayers).toHaveBeenCalledWith({ proposal: 'design:p' })
    expect(askSlot).toHaveBeenLastCalledWith(viewer(), expect.anything(), '/repo', expect.anything(), 'design:p')
  })

  it('choosing "No proposal" hides the wireframes, outlines and fades; choosing a proposal shows them', async () => {
    bridge({ worldGet: vi.fn(async () => ok(withPlan())) })
    const askSlot = vi.fn(() => <span>ask</span>)
    await mount({ askSlot })
    const sel = screen.getByTestId('world-proposal')
    fireEvent.change(sel, { target: { value: '' } })
    expect(viewer().setLayers).toHaveBeenLastCalledWith({ proposal: null })
    expect(askSlot).toHaveBeenLastCalledWith(viewer(), expect.anything(), '/repo', expect.anything(), null)
    fireEvent.change(sel, { target: { value: 'pA' } })
    expect(viewer().setLayers).toHaveBeenLastCalledWith({ proposal: 'pA' })
    expect(askSlot).toHaveBeenLastCalledWith(viewer(), expect.anything(), '/repo', expect.anything(), 'pA')
  })

  it('has no selector for a world with no proposals, and keeps the pick null', async () => {
    bridge()
    await mount()
    expect(screen.queryByTestId('world-proposal')).toBeNull()
    expect(viewer().setLayers).toHaveBeenCalledWith({ proposal: null })
  })

  it('toolbar toggles call viewer.setLayers with the right partial', async () => {
    bridge()
    await mount()
    const v = viewer()
    const press = (key: string) => fireEvent.click(screen.getByTestId(`world-layer-${key}`))
    expect(screen.getByTestId('world-layer-labels')).toHaveAttribute('aria-pressed', 'false')
    press('labels')
    expect(v.setLayers).toHaveBeenLastCalledWith({ labels: 'tech' })
    expect(screen.getByTestId('world-layer-labels')).toHaveAttribute('aria-pressed', 'true')
    press('labels')
    expect(v.setLayers).toHaveBeenLastCalledWith({ labels: 'jobs' })
    press('processes')
    expect(v.setLayers).toHaveBeenLastCalledWith({ processes: true })
    press('processes')
    expect(v.setLayers).toHaveBeenLastCalledWith({ processes: false })
    press('allLineLabels')
    expect(v.setLayers).toHaveBeenLastCalledWith({ allLineLabels: true })
    press('allLineLabels')
    expect(v.setLayers).toHaveBeenLastCalledWith({ allLineLabels: false })
    expect(screen.getByTestId('world-layer-planned')).toHaveAttribute('aria-pressed', 'true')
    press('planned')
    expect(v.setLayers).toHaveBeenLastCalledWith({ planned: false })
    press('planned')
    expect(v.setLayers).toHaveBeenLastCalledWith({ planned: true })
  })

  it('theme select calls setTheme', async () => {
    bridge()
    await mount()
    const select = screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['Neon', 'Blueprint', 'Glass'])
    fireEvent.change(select, { target: { value: 'blueprint' } })
    expect(viewer().setTheme).toHaveBeenCalledWith('blueprint')
    expect(select.value).toBe('blueprint')
  })

  it('tours menu lists doc.tours and plays the chosen one', async () => {
    bridge()
    await mount()
    const doc = minimal()
    const select = screen.getByRole('combobox', { name: 'Tours' }) as HTMLSelectElement
    expect(select.disabled).toBe(false)
    expect([...select.options].map((o) => o.textContent)).toEqual(['Take a tour…', 'First look'])
    fireEvent.change(select, { target: { value: 't1' } })
    expect(viewer().play).toHaveBeenCalledWith([{ type: 'tour', steps: doc.tours[0].steps }])
    // The placeholder plays nothing.
    fireEvent.change(select, { target: { value: '' } })
    expect(viewer().play).toHaveBeenCalledTimes(1)
  })

  it('a world with no tours shows a disabled tours menu', async () => {
    bridge({ worldGet: vi.fn(async () => ok({ ...minimal(), tours: [] })) })
    await mount()
    const select = screen.getByRole('combobox', { name: 'Tours' }) as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(select.options[0].textContent).toBe('No tours yet')
  })

  it('Esc resets; second Esc closes', async () => {
    bridge()
    const { onClose } = await mount()
    esc()
    expect(viewer().resetView).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    esc()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Esc after a selection, a card, a tour or a drag resets again before it closes', async () => {
    bridge()
    const { onClose } = await mount()
    const v = viewer()
    esc() // reset: the next Esc would close
    act(() => v.emitSelect({ kind: 'building', id: 'b1' }))
    esc() // a selection since: reset again
    expect(onClose).not.toHaveBeenCalled()
    act(() => v.emitSelect(null)) // a cleared selection is no new activity
    esc()
    expect(onClose).toHaveBeenCalledTimes(1)

    act(() => v.opts.renderCard('<p class="tour-caption">The app talks</p>'))
    expect(screen.getByTestId('world-card')).toHaveTextContent('The app talks')
    // A card the viewer opened another way takes clicks at once (fix wave M1).
    expect(screen.getByTestId('world-card').style.pointerEvents).toBe('')
    esc() // a card is open: it clears, the pane stays
    expect(screen.queryByTestId('world-card')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => v.opts.renderCard(null))
    esc()
    expect(onClose).toHaveBeenCalledTimes(2)
    // A card a map click opened lets clicks through to the map at first (film bug 6).
    act(() => v.opts.renderCard('<p>Clicked</p>', true))
    expect(screen.getByTestId('world-card').style.pointerEvents).toBe('none')
    act(() => v.opts.renderCard(null))

    fireEvent.pointerDown(screen.getByTestId('world-canvas-host')) // dragging the map
    esc()
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.change(screen.getByRole('combobox', { name: 'Tours' }), { target: { value: 't1' } })
    esc()
    expect(onClose).toHaveBeenCalledTimes(2)
    esc()
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('Esc closes the re-layout question first, ignores other keys and Esc from outside the pane', async () => {
    bridge()
    const { onClose } = await mount()
    fireEvent.keyDown(dialog(), { key: 'Enter' })
    expect(viewer().resetView).not.toHaveBeenCalled()
    // A dialog opened on top of the pane (the command palette) keeps its own Esc.
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    outside.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    outside.remove()
    // Esc with focus nowhere in particular (a terminal beside the pane has it) is left alone.
    const lone = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(lone)
    expect(lone.defaultPrevented).toBe(false)
    expect(viewer().resetView).not.toHaveBeenCalled()
    esc()
    expect(viewer().resetView).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('world-relayout'))
    expect(screen.getByRole('alertdialog', { name: 'Confirm re-layout' })).toBeInTheDocument()
    esc(screen.getByTestId('world-relayout-cancel'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    esc()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opening the pane asks any dictating terminal to stop', async () => {
    bridge()
    const heard = vi.fn()
    window.addEventListener('termpolis:stopDictation', heard)
    try {
      await mount()
      expect(heard).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('termpolis:stopDictation', heard)
    }
  })

  it('no WebGL → renders renderFallback(doc) list', async () => {
    h.webgl = false
    bridge()
    const askSlot = vi.fn(() => <span>ask</span>)
    const { onClose } = await mount({ askSlot })
    const { createWorldViewer } = await import('../../../src/renderer/src/world/engine')
    expect(createWorldViewer).not.toHaveBeenCalled()
    expect(screen.queryByTestId('world-canvas-host')).toBeNull()
    const list = screen.getByTestId('world-fallback')
    expect(list.querySelector('section.world-fallback')).not.toBeNull()
    expect(list.querySelector('[data-kind="building"][data-id="b1"]')).toHaveTextContent('Desktop app')
    expect(askSlot).toHaveBeenLastCalledWith(null, expect.objectContaining({ buildings: expect.any(Array) }), '/repo', expect.objectContaining({ onEscape: expect.any(Function), setBusy: expect.any(Function) }), null)
    const doc = minimal()

    // Clicking a building or a connection opens its card from the doc.
    const textOf = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent as string }
    fireEvent.click(list.querySelector('[data-id="b1"]') as Element)
    expect(screen.getByTestId('world-card')).toHaveTextContent(textOf(buildingCard(doc, 'b1')))
    fireEvent.click(list.querySelector('[data-kind="edge"]') as Element)
    expect(screen.getByTestId('world-card')).toHaveTextContent(textOf(edgeCard(doc, 'e1')))
    // A link inside the card opens that part.
    fireEvent.click(screen.getByTestId('world-card').querySelector('[data-node]') as Element)
    expect(screen.getByTestId('world-card')).toHaveTextContent('What it does')
    expect(screen.getByTestId('world-card')).toHaveTextContent('Desktop app')
    // A district closes the card; a heading is no item.
    fireEvent.click(list.querySelector('[data-kind="district"] h3') as Element)
    expect(screen.queryByTestId('world-card')).toBeNull()
    fireEvent.click(list.querySelector('h2') as Element)
    expect(screen.queryByTestId('world-card')).toBeNull()
    // An unknown id shows no card.
    fireEvent.click(list.querySelector('[data-id="b1"]') as Element)
    const link = screen.getByTestId('world-card').querySelector('[data-node]') as Element
    link.setAttribute('data-node', 'nope')
    fireEvent.click(link)
    expect(screen.queryByTestId('world-card')).toBeNull()

    // Toolbar actions have no viewer to drive, and do not throw.
    fireEvent.click(list.querySelector('[data-id="b1"]') as Element)
    fireEvent.change(screen.getByRole('combobox', { name: 'Tours' }), { target: { value: 't1' } })
    expect(screen.queryByTestId('world-card')).toBeNull()
    fireEvent.click(screen.getByTestId('world-layer-processes'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'glass' } })
    fireEvent.click(screen.getByTestId('world-reset'))
    fireEvent.click(list.querySelector('[data-id="b1"]') as Element)
    fireEvent.click(screen.getByTestId('world-card-close'))
    expect(screen.queryByTestId('world-card')).toBeNull()
    esc()
    esc()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('is a region beside the terminals, not a modal dialog, and takes the focus on open', async () => {
    // The palette and hotkey wiring that opens it is covered in AppWorld.test.tsx.
    bridge()
    await mount()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(dialog()).not.toHaveAttribute('aria-modal')
    expect(document.activeElement).toBe(dialog())
  })

  it('leaves Tab alone, and gives the focus back to its opener on close', async () => {
    bridge()
    const opener = document.createElement('button')
    opener.textContent = 'globe'
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = await mount()
    const list = focusables(dialog())
    const last = list[list.length - 1]
    last.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    last.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false) // no trap: Tab may leave the pane for the terminals
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('gives the focus to the active terminal on close when nothing opened it', async () => {
    bridge()
    const host = document.createElement('div')
    host.setAttribute('data-terminal-id', 't-1')
    const input = document.createElement('textarea')
    host.appendChild(input)
    document.body.appendChild(host)
    useTerminalStore.setState({ activeTerminalId: 't-1' })
    ;(document.activeElement as HTMLElement | null)?.blur()
    const { unmount } = await mount()
    unmount()
    expect(document.activeElement).toBe(input)
    // With no active terminal either, the focus is simply not moved.
    useTerminalStore.setState({ activeTerminalId: null })
    const again = await mount()
    expect(() => again.unmount()).not.toThrow()
    host.remove()
    useTerminalStore.setState({ activeTerminalId: null })
  })

  it('takes the focus back when a focused child closes and the browser drops it to the body', async () => {
    bridge()
    const { onClose } = await mount()
    const relayout = screen.getByTestId('world-relayout')
    relayout.focus()
    fireEvent.click(relayout)
    const cancel = screen.getByTestId('world-relayout-cancel')
    cancel.focus()
    fireEvent.click(cancel) // the question closes and its focused button is gone
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    // The next render of the pane puts the focus back on it, so Esc is still the pane's.
    fireEvent.click(screen.getByTestId('world-relayout'))
    fireEvent.click(screen.getByTestId('world-relayout-cancel'))
    expect(document.activeElement).toBe(dialog())
    esc()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not take the focus back once it has gone to something outside the pane', async () => {
    bridge()
    await mount()
    screen.getByTestId('world-relayout').focus()
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    fireEvent.click(screen.getByTestId('world-relayout'))
    fireEvent.click(screen.getByTestId('world-relayout-cancel')) // a second render: still not taken back
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('keeps the legend a chip in a narrow pane and an expanded strip in a wide one, and tells the viewer', async () => {
    bridge()
    const narrow = await mount()
    expect(screen.getByTestId('world-legend-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(viewer().setRightReserve).toHaveBeenLastCalledWith(108)
    // Opened by choice in a narrow pane it covers the map: the fit keeps its chip-sized strip.
    fireEvent.click(screen.getByTestId('world-legend-toggle'))
    expect(screen.getByTestId('world-legend-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(viewer().setRightReserve).toHaveBeenLastCalledWith(108)
    narrow.unmount()
    bridge()
    render(<WorldView root="/repo" width={800} onClose={vi.fn()} />)
    await screen.findByTestId('world-legend')
    expect(screen.getByTestId('world-legend-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(viewer().setRightReserve).toHaveBeenLastCalledWith(244)
    fireEvent.click(screen.getByTestId('world-legend-toggle'))
    expect(viewer().setRightReserve).toHaveBeenLastCalledWith(108)
  })

  it('takes its width from the width prop', async () => {
    const get = deferred<Res<WorldDoc | null>>()
    bridge({ worldGet: vi.fn(() => get.promise) })
    render(<WorldView root="/repo" width={512} onClose={vi.fn()} />)
    expect(dialog()).toHaveStyle({ width: '512px' })
  })

  it('drops a re-layout answer for a project the pane has left, and one that lands after close', async () => {
    const run = deferred<Res<WorldDoc>>()
    const b = bridge({ worldRelayout: vi.fn(() => run.promise) })
    const { rerender, onClose } = await mount()
    fireEvent.click(screen.getByTestId('world-relayout'))
    fireEvent.click(screen.getByTestId('world-relayout-go'))
    expect(b.api.worldRelayout).toHaveBeenCalledWith('/repo')
    rerender(<WorldView root="/next" onClose={onClose} />)
    await settle()
    expect(b.api.worldGet).toHaveBeenLastCalledWith('/next')
    const loads = viewer().load.mock.calls.length
    await act(async () => { run.resolve(ok({ ...minimal(), projectKey: 'stale', generatedAt: 77 })) })
    await settle()
    expect(viewer().load).toHaveBeenCalledTimes(loads)
    expect(screen.queryByTestId('world-notice')).toBeNull()

    // A failure for the old project is not shown on the new one either.
    const broken = deferred<Res<WorldDoc>>()
    b.api.worldRelayout.mockReturnValueOnce(broken.promise)
    fireEvent.click(screen.getByTestId('world-relayout'))
    fireEvent.click(screen.getByTestId('world-relayout-go'))
    expect(b.api.worldRelayout).toHaveBeenLastCalledWith('/next')
    rerender(<WorldView root="/third" onClose={onClose} />)
    await settle()
    await act(async () => { broken.reject(new Error('late')) })
    await settle()
    expect(screen.queryByTestId('world-notice')).toBeNull()

    // An answer after the pane closed sets nothing.
    const late = deferred<Res<WorldDoc>>()
    b.api.worldRelayout.mockReturnValueOnce(late.promise)
    fireEvent.click(screen.getByTestId('world-relayout'))
    fireEvent.click(screen.getByTestId('world-relayout-go'))
    const v = viewer()
    const before = v.load.mock.calls.length
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    cleanup()
    await act(async () => { late.resolve(ok({ ...minimal(), generatedAt: 123 })) })
    expect(v.load).toHaveBeenCalledTimes(before)
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  describe('the open card is kept out of the close-ups', () => {
    /** The card's box as the page lays it out (jsdom lays nothing out): `box` for the card, 0 elsewhere. */
    function cardBox(box: { w: number; h: number }): void {
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-card' ? box.w : 0
      })
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-card' ? box.h : 0
      })
    }

    it('from its measured box, following it as it opens, changes size, shows another part and closes', async () => {
      const seen: Array<() => void> = []
      const disconnect = vi.fn()
      vi.stubGlobal('ResizeObserver', class {
        constructor(cb: () => void) { seen.push(cb) }
        observe(): void {}
        disconnect(): void { disconnect() }
      })
      const box = { w: 330, h: 225 }
      cardBox(box)
      try {
        bridge()
        const view = await mount()
        const v = viewer()
        expect(v.setCardReserve).toHaveBeenLastCalledWith(0, 0)
        act(() => v.opts.renderCard(buildingCard(minimal(), 'b1')))
        // 330 x 225, 12 from the corner, 8 clear of the city, in 8 px steps.
        expect(v.setCardReserve).toHaveBeenLastCalledWith(352, 248)
        const calls = v.setCardReserve.mock.calls.length
        box.h = 226 // a pixel's change in its content: the camera stays
        act(() => { for (const cb of seen) cb() })
        expect(v.setCardReserve).toHaveBeenCalledTimes(calls)
        box.h = 300 // a section opened in it
        act(() => { for (const cb of seen) cb() })
        expect(v.setCardReserve).toHaveBeenLastCalledWith(352, 320)
        box.h = 180 // another part's card, shorter
        act(() => v.opts.renderCard(edgeCard(minimal(), 'e1')))
        expect(v.setCardReserve).toHaveBeenLastCalledWith(352, 200)
        fireEvent.click(screen.getByTestId('world-card-close'))
        expect(v.setCardReserve).toHaveBeenLastCalledWith(0, 0)
        expect(disconnect).toHaveBeenCalled()
        view.unmount()
      } finally {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
      }
    })

    it('caps a card in a narrow pane from the measured stage, and follows the stage as it widens', async () => {
      const seen: Array<() => void> = []
      vi.stubGlobal('ResizeObserver', class {
        constructor(cb: () => void) { seen.push(cb) }
        observe(): void {}
        disconnect(): void {}
      })
      const stage = { w: 416, h: 586 }
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-stage' ? stage.w : 0
      })
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-stage' ? stage.h : 0
      })
      cardBox({ w: 330, h: 300 })
      try {
        bridge()
        await mount()
        act(() => viewer().opts.renderCard(buildingCard(minimal(), 'b1')))
        // No ask bar here: 586 - 264 = 322 for the card's reserve, 320 on a step, less 20.
        expect(screen.getByTestId('world-card').style.maxHeight).toBe('min(300px, calc(100% - 110px))')
        stage.w = 1000
        act(() => { for (const cb of seen) cb() })
        expect(screen.getByTestId('world-card').style.maxHeight).toBe('calc(100% - 110px)')
      } finally {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
      }
    })

    it('reads the box once where there is no ResizeObserver', async () => {
      const had = 'ResizeObserver' in globalThis
      const saved = (globalThis as any).ResizeObserver
      delete (globalThis as any).ResizeObserver
      cardBox({ w: 330, h: 100 })
      try {
        bridge()
        await mount()
        act(() => viewer().opts.renderCard(buildingCard(minimal(), 'b1')))
        expect(viewer().setCardReserve).toHaveBeenLastCalledWith(352, 120)
      } finally {
        if (had) (globalThis as any).ResizeObserver = saved
        vi.restoreAllMocks()
      }
    })
  })

  it('losing the project folder clears the map and its card and shows the home', async () => {
    bridge()
    const { rerender, onClose } = await mount()
    act(() => viewer().opts.renderCard(buildingCard(minimal(), 'b1')))
    expect(screen.getByTestId('world-card')).toBeInTheDocument()
    expect(screen.getByTestId('world-canvas-host')).toHaveStyle({ visibility: 'visible' })
    expect(screen.getByTestId('world-relayout')).not.toBeDisabled()
    rerender(<WorldView root="" onClose={onClose} />)
    await settle()
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    expect(screen.queryByTestId('world-card')).toBeNull()
    expect(screen.getByTestId('world-canvas-host')).toHaveStyle({ visibility: 'hidden' })
    expect(screen.getByTestId('world-relayout')).toBeDisabled()
  })

  it('a cd inside the same repository refetches nothing and keeps the open card', async () => {
    const b = bridge({ gitFindRoot: vi.fn(async () => ok('/repo')) })
    const { rerender, onClose } = await mount({ root: '/repo/src' })
    expect(b.api.worldGet).toHaveBeenCalledTimes(1)
    act(() => viewer().opts.renderCard(buildingCard(minimal(), 'b1')))
    rerender(<WorldView root="/repo/src/deep" onClose={onClose} />)
    expect(screen.queryByTestId('world-loading')).toBeNull()
    await settle()
    expect(b.api.gitFindRoot).toHaveBeenLastCalledWith('/repo/src/deep')
    expect(b.api.worldGet).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('world-card')).toBeInTheDocument()
    expect(viewer().load).toHaveBeenCalledTimes(1)
  })

  it('loads the same world once: a push of an unchanged doc does not reload the viewer', async () => {
    const b = bridge()
    await mount()
    const v = viewer()
    expect(v.load).toHaveBeenCalledTimes(1)
    // The compile's own world:updated push brings back the same doc (a new object, same stamp).
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(b.api.worldGet).toHaveBeenCalledTimes(2)
    expect(v.load).toHaveBeenCalledTimes(1)
    // A newer compile loads.
    const newer = { ...minimal(), generatedAt: 5 }
    b.api.worldGet.mockResolvedValueOnce(ok(newer))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    // It grows from the world the viewer held (R25: animateFrom only within one project).
    expect(v.load).toHaveBeenLastCalledWith(newer, { animateFrom: v.load.mock.calls[0][0] })
    // So does another project with the same stamp, drawn fresh: nothing to grow from.
    const other = { ...minimal(), projectKey: 'other', generatedAt: 5 }
    b.api.worldGet.mockResolvedValueOnce(ok(other))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(v.load).toHaveBeenLastCalledWith(other)
    expect(v.load).toHaveBeenCalledTimes(3)
  })

  it('a newer world of the same project loads over the one shown and opens nothing itself: the viewer keeps the view (film bug 6)', async () => {
    const b = bridge()
    await mount()
    const v = viewer()
    // Nothing selected: the newer world just loads.
    b.api.worldGet.mockResolvedValueOnce(ok({ ...minimal(), generatedAt: 2 }))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(2)
    expect(v.apply).not.toHaveBeenCalled()
    // A part is open: the labelled follow-up's world loads over it, and no card is opened again (that
    // would fly the camera back to the part).
    v.getSelection.mockReturnValue(['b1'])
    const before = v.load.mock.calls[1][0]
    b.api.worldGet.mockResolvedValueOnce(ok({ ...minimal(), generatedAt: 3 }))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(3)
    expect(v.load).toHaveBeenLastCalledWith(expect.objectContaining({ generatedAt: 3 }), { animateFrom: before })
    expect(v.apply).not.toHaveBeenCalled()
    // Another project's world loads on its own.
    b.api.worldGet.mockResolvedValueOnce(ok({ ...minimal(), projectKey: 'other', generatedAt: 4 }))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(4)
    expect(v.load).toHaveBeenLastCalledWith(expect.objectContaining({ projectKey: 'other' }))
    expect(v.apply).not.toHaveBeenCalled()
  })

  it('in 2D a newer world rebuilds the open card, closes it when its part is gone, and leaves a closed card closed', async () => {
    h.webgl = false
    const b = bridge()
    await mount()
    const list = screen.getByTestId('world-fallback')
    const renamed = (name: string): WorldDoc => {
      const d = minimal()
      return { ...d, generatedAt: d.generatedAt + 1, buildings: d.buildings.map((x) => (x.id === 'b1' ? { ...x, name } : x)) }
    }
    // A closed card stays closed.
    b.api.worldGet.mockResolvedValueOnce(ok(renamed('Before')))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(screen.queryByTestId('world-card')).toBeNull()
    // The open card follows the newer world.
    fireEvent.click(screen.getByTestId('world-fallback').querySelector('[data-id="b1"]') as Element)
    expect(screen.getByTestId('world-card')).toHaveTextContent('Before')
    b.api.worldGet.mockResolvedValueOnce(ok({ ...renamed('Labelled desk'), generatedAt: 50 }))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(screen.getByTestId('world-card')).toHaveTextContent('Labelled desk')
    // Closed by the user, it stays closed when a newer world arrives.
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByTestId('world-card')).toBeNull()
    b.api.worldGet.mockResolvedValueOnce(ok({ ...renamed('Again'), generatedAt: 55 }))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(screen.queryByTestId('world-card')).toBeNull()
    fireEvent.click(screen.getByTestId('world-fallback').querySelector('[data-id="b1"]') as Element)
    expect(screen.getByTestId('world-card')).toHaveTextContent('Again')
    // Its part gone: the card closes.
    const gone = minimal()
    b.api.worldGet.mockResolvedValueOnce(ok({ ...gone, generatedAt: 60, buildings: gone.buildings.filter((x) => x.id !== 'b1') }))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(screen.queryByTestId('world-card')).toBeNull()
    expect(list).toBeTruthy()
  })

  it('Re-layout asks for confirmation then calls worldRelayout', async () => {
    const relaid = { ...minimal(), generatedAt: 99 }
    const run = deferred<Res<WorldDoc>>()
    const b = bridge({ worldRelayout: vi.fn(() => run.promise) })
    await mount()
    fireEvent.click(screen.getByTestId('world-relayout'))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Continue?')
    fireEvent.click(screen.getByTestId('world-relayout-cancel'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(b.api.worldRelayout).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('world-relayout'))
    fireEvent.click(screen.getByTestId('world-relayout-go'))
    expect(b.api.worldRelayout).toHaveBeenCalledWith('/repo')
    expect(screen.getByTestId('world-notice')).toHaveTextContent('Re-laying out…')
    expect(screen.getByTestId('world-relayout')).toBeDisabled()
    await act(async () => { run.resolve(ok(relaid)) })
    await settle()
    expect(viewer().load).toHaveBeenLastCalledWith(relaid, { animateFrom: viewer().load.mock.calls[0][0] })
    expect(screen.queryByTestId('world-notice')).toBeNull()

    b.api.worldRelayout.mockResolvedValueOnce(fail('host crashed'))
    fireEvent.click(screen.getByTestId('world-relayout'))
    fireEvent.click(screen.getByTestId('world-relayout-go'))
    await settle()
    expect(screen.getByTestId('world-notice')).toHaveTextContent('Re-layout failed: host crashed')
    b.api.worldRelayout.mockRejectedValueOnce(new Error('ipc down'))
    fireEvent.click(screen.getByTestId('world-relayout'))
    fireEvent.click(screen.getByTestId('world-relayout-go'))
    await settle()
    expect(screen.getByTestId('world-notice')).toHaveTextContent('Re-layout failed: ipc down')
  })

  it('opens cards from the viewer, and card links and close drive the viewer', async () => {
    bridge()
    const askSlot = vi.fn(() => <span>ask here</span>)
    await mount({ askSlot })
    const v = viewer()
    expect(screen.getByTestId('world-ask-slot')).toHaveTextContent('ask here')
    expect(askSlot).toHaveBeenLastCalledWith(v, expect.objectContaining({ buildings: expect.any(Array) }), '/repo', expect.objectContaining({ onEscape: expect.any(Function), setBusy: expect.any(Function) }), null)
    act(() => v.opts.renderCard(buildingCard(minimal(), 'b1')))
    const card = screen.getByTestId('world-card')
    fireEvent.click(card.querySelector('[data-edge]') as Element)
    expect(v.apply).toHaveBeenLastCalledWith({ type: 'openCard', id: 'e1' })
    fireEvent.click(card.querySelector('[data-node]') as Element)
    expect(v.apply).toHaveBeenLastCalledWith({ type: 'openCard', id: expect.any(String) })
    fireEvent.click(screen.getByTestId('world-card-close'))
    expect(screen.queryByTestId('world-card')).toBeNull()
    expect(v.resetView).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('world-reset'))
    expect(v.resetView).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByTestId('world-close'))
  })

  it('the close button closes, and unmounting disposes the viewer and drops every listener', async () => {
    const b = bridge()
    const { onClose, unmount } = await mount()
    fireEvent.click(screen.getByTestId('world-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    const v = viewer()
    expect(v.selectListeners()).toBe(1)
    unmount()
    expect(v.dispose).toHaveBeenCalled()
    expect(v.selectListeners()).toBe(0)
    expect(b.listeners()).toBe(0)
  })

  describe('the e2e probe (window.__termpolis_world)', () => {
    const probe = () => (window as any).__termpolis_world
    afterEach(() => {
      delete (window as any).termpolisTestFlags
      delete (window as any).__termpolis_world
    })

    it('is not there without the test flag', async () => {
      bridge()
      await mount()
      expect(viewer()).toBeTruthy()
      expect(probe()).toBeUndefined()
    })

    it('under the flag, answers from the viewer while it is up and goes with it', async () => {
      ;(window as any).termpolisTestFlags = { worldProbe: true }
      bridge()
      const { unmount } = await mount()
      expect(probe().screenPoint('b1')).toEqual({ x: 1, y: 2 })
      expect(probe().screenPoint('zz')).toBeNull()
      expect(probe().linePoints('e1')).toEqual([{ x: 3, y: 4 }])
      expect(probe().pickAt(1, 2)).toEqual({ kind: 'node', id: 'b1' })
      expect(probe().pickAt(9, 9)).toBeNull()
      expect(probe().cameraState()).toEqual({ pos: [1, 2, 3], target: [4, 5, 6] })
      expect(probe().position('b1')).toEqual(minimal().layout.positions.b1)
      expect(probe().position('zz')).toBeNull()
      await probe().apply({ type: 'focus', ids: ['a'] })
      expect(viewer().apply).toHaveBeenCalledWith({ type: 'focus', ids: ['a'] })
      expect(probe().drawn()).toEqual({ layers: expect.objectContaining({ processes: false }), processShells: 0, conduits: 4 })
      unmount()
      expect(probe()).toBeUndefined()
    })

    it('leaves a probe that a later pane put up', async () => {
      ;(window as any).termpolisTestFlags = { worldProbe: true }
      bridge()
      const { unmount } = await mount()
      const other = { screenPoint: () => null, drawn: () => null }
      ;(window as any).__termpolis_world = other
      unmount()
      expect(probe()).toBe(other)
    })

    it('has no positions before the world arrives', async () => {
      ;(window as any).termpolisTestFlags = { worldProbe: true }
      const get = deferred<Res<WorldDoc | null>>()
      bridge({ worldGet: vi.fn(() => get.promise) })
      await mount()
      expect(probe().position('b1')).toBeNull()
      await act(async () => { get.resolve(ok(minimal())) })
      await settle()
      expect(probe().position('b1')).toEqual(minimal().layout.positions.b1)
    })

    it('is not there without WebGL (no viewer)', async () => {
      ;(window as any).termpolisTestFlags = { worldProbe: true }
      h.webgl = false
      bridge()
      await mount()
      expect(probe()).toBeUndefined()
    })
  })

  it('names the project after its folder, before and after the doc arrives (never the hashed project key)', async () => {
    const get = deferred<Res<WorldDoc | null>>()
    bridge({ worldGet: vi.fn(() => get.promise), gitFindRoot: vi.fn(async () => ok('C:\\code\\my-app\\')) })
    await mount({ root: 'C:\\code\\my-app\\src' })
    expect(screen.getByTestId('world-project')).toHaveTextContent('my-app')
    expect(screen.getByTestId('world-loading')).toHaveTextContent('Opening Lumopolis…')
    await act(async () => { get.resolve(ok(minimal())) })
    await settle()
    // The doc's projectKey is a sha1 slice (3f9a1c0e7b2d4a68): a person reads the folder name.
    expect(screen.getByTestId('world-project')).toHaveTextContent('my-app')
    expect(screen.getByTestId('world-project')).not.toHaveTextContent('3f9a1c0e7b2d4a68')
  })

  it('a project mapped from the terminal joins the recent worlds at once (film bug 10)', async () => {
    const entry: WorldEntry = { key: 'k', source: { kind: 'project', root: '/repo' }, title: 'repo', lastOpened: 1 } as WorldEntry
    const lists = [ok<WorldEntry[]>([]), ok<WorldEntry[]>([entry])]
    const b = bridge({
      worldGet: vi.fn(async () => ok(null)),
      worldMapProject: vi.fn(async () => ok(entry)),
      worldSourcesList: vi.fn(async () => lists.shift() ?? ok([entry]))
    })
    await mount()
    expect(b.api.worldMapProject).toHaveBeenCalledWith('/repo')
    const worlds = screen.getByRole('combobox', { name: 'Worlds' }) as HTMLSelectElement
    expect([...worlds.options].map((o) => o.textContent)).toContain('repo')
    fireEvent.change(worlds, { target: { value: [...worlds.options].find((o) => o.textContent === 'Home')?.value } })
    await settle()
    expect(screen.queryByText(/No worlds yet/)).toBeNull()
    expect(screen.getByRole('list', { name: 'Recent worlds' })).toHaveTextContent('repo')
  })

  it('a world already saved, a failed compile, a refused or failing registration and a world the user picked register nothing more', async () => {
    let b = bridge({ worldMapProject: vi.fn(async () => ok({})) })
    await mount()
    expect(b.api.worldMapProject).not.toHaveBeenCalled() // the world was there already
    cleanup()
    b = bridge({ worldGet: vi.fn(async () => ok(null)), worldCompile: vi.fn(async () => fail('no source files found')), worldMapProject: vi.fn(async () => ok({})) })
    await mount()
    expect(b.api.worldMapProject).not.toHaveBeenCalled()
    cleanup()
    b = bridge({ worldGet: vi.fn(async () => ok(null)), worldMapProject: vi.fn(async () => fail("That folder doesn't look like a project.")) })
    await mount()
    expect(b.api.worldMapProject).toHaveBeenCalledTimes(1)
    expect(b.api.worldSourcesList).toHaveBeenCalledTimes(1) // nothing new to list
    expect(screen.queryByRole('alert')).toBeNull() // and nothing to tell: the world is shown
    cleanup()
    b = bridge({ worldGet: vi.fn(async () => ok(null)), worldMapProject: vi.fn(async () => { throw new Error('ipc') }) })
    await mount()
    expect(screen.queryByRole('alert')).toBeNull()
    cleanup()
    // A world opened from the list is registered already: mapping it registers nothing.
    const other: WorldEntry = { key: 'o', source: { kind: 'folder', root: '/other' }, title: 'other', lastOpened: 1 } as WorldEntry
    b = bridge({ worldGet: vi.fn(async (root: string) => ok(root === '/other' ? null : minimal())), worldMapProject: vi.fn(async () => ok({})), worldSourcesList: vi.fn(async () => ok([other])), worldTouchSource: vi.fn(async () => ok(other)) })
    await mount()
    fireEvent.change(screen.getByRole('combobox', { name: 'Worlds' }), { target: { value: 'o' } })
    await settle()
    expect(b.api.worldCompile).toHaveBeenCalledWith('/other')
    expect(b.api.worldMapProject).not.toHaveBeenCalled()
  })

  it('without a project folder it shows the home and asks main for no world', async () => {
    const b = bridge()
    await mount({ root: '' })
    expect(screen.getByRole('heading', { name: 'Lumopolis' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Map this project/ })).toBeDisabled()
    expect(b.api.worldSourcesList).toHaveBeenCalled()
    expect(screen.queryByTestId('world-project')).toBeNull()
    expect(screen.getByTestId('world-relayout')).toBeDisabled()
    expect(b.api.gitFindRoot).not.toHaveBeenCalled()
    expect(b.api.worldGet).not.toHaveBeenCalled()
  })

  it('maps the git root of the folder, or the folder itself when there is no repository', async () => {
    let b = bridge({ gitFindRoot: vi.fn(async () => ok('/repo')) })
    await mount({ root: '/repo/src/deep' })
    expect(b.api.worldGet).toHaveBeenCalledWith('/repo')
    cleanup()
    b = bridge({ gitFindRoot: vi.fn(async () => ok(null)) })
    await mount({ root: '/loose' })
    expect(b.api.worldGet).toHaveBeenCalledWith('/loose')
    cleanup()
    b = bridge({ gitFindRoot: vi.fn(async () => fail('git missing')) })
    await mount({ root: '/loose2' })
    expect(b.api.worldGet).toHaveBeenCalledWith('/loose2')
    cleanup()
    b = bridge({ gitFindRoot: vi.fn(async () => { throw new Error('ipc') }) })
    await mount({ root: '/loose3' })
    expect(b.api.worldGet).toHaveBeenCalledWith('/loose3')
  })

  it('a root lookup that lands after unmount is dropped', async () => {
    for (const settleWith of ['resolve', 'reject'] as const) {
      const find = deferred<Res<string | null>>()
      const b = bridge({ gitFindRoot: vi.fn(() => find.promise) })
      const { unmount } = await mount()
      unmount()
      await act(async () => { if (settleWith === 'resolve') find.resolve(ok('/repo')); else find.reject(new Error('x')) })
      expect(b.api.worldGet).not.toHaveBeenCalled()
    }
  })

  it('shows a load failure with a retry that asks again', async () => {
    const b = bridge({ worldGet: vi.fn().mockResolvedValueOnce(fail('host down')).mockResolvedValue(ok(minimal())) })
    await mount()
    expect(screen.getByTestId('world-error')).toHaveTextContent('host down')
    fireEvent.click(screen.getByTestId('world-retry'))
    await settle()
    expect(b.api.worldGet).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('world-error')).toBeNull()
    expect(viewer().load).toHaveBeenCalled()
  })

  it('a compile failure and a thrown load are shown as errors', async () => {
    bridge({ worldGet: vi.fn(async () => ok(null)), worldCompile: vi.fn(async () => fail('no source files found')) })
    await mount()
    expect(screen.getByTestId('world-error')).toHaveTextContent('no source files found')
    cleanup()
    bridge({ worldGet: vi.fn(async () => { throw new Error('boom') }) })
    await mount()
    expect(screen.getByTestId('world-error')).toHaveTextContent('boom')
    cleanup()
    bridge({ worldGet: vi.fn(() => Promise.reject('odd')) })
    await mount()
    expect(screen.getByTestId('world-error')).toHaveTextContent('odd')
  })

  it('answers that land after unmount are dropped (get, compile, failure)', async () => {
    const get = deferred<Res<WorldDoc | null>>()
    let b = bridge({ worldGet: vi.fn(() => get.promise) })
    let r = await mount()
    r.unmount()
    await act(async () => { get.resolve(ok(null)) })
    expect(b.api.worldCompile).not.toHaveBeenCalled()

    const compile = deferred<Res<WorldDoc>>()
    b = bridge({ worldGet: vi.fn(async () => ok(null)), worldCompile: vi.fn(() => compile.promise) })
    r = await mount()
    expect(b.api.worldCompile).toHaveBeenCalled()
    r.unmount()
    await act(async () => { compile.resolve(ok(minimal())) })

    const broken = deferred<Res<WorldDoc | null>>()
    bridge({ worldGet: vi.fn(() => broken.promise) })
    r = await mount()
    r.unmount()
    await act(async () => { broken.reject(new Error('late')) })
    await waitFor(() => expect(screen.queryByTestId('world-error')).toBeNull())
  })
})

describe('WorldView labelling cost line', () => {
  const withTokens = (labelTokens?: number) => ({ ...minimal(), ...(labelTokens === undefined ? {} : { labelTokens }) })
  const settings = (worldLabelling: boolean) => vi.fn(async () => ok({ worldLabelling, worldSpeakAnswers: false }))

  it('names the cost of the last update, small, in the toolbar', async () => {
    bridge({ worldGet: vi.fn(async () => ok(withTokens(42_040))), worldSettingsGet: settings(true) })
    await mount()
    expect(screen.getByTestId('world-label-cost')).toHaveTextContent('Describing parts: about 42.0k tokens on the last update')
  })

  it('says cached at 0', async () => {
    bridge({ worldGet: vi.fn(async () => ok(withTokens(0))), worldSettingsGet: settings(true) })
    await mount()
    expect(screen.getByTestId('world-label-cost')).toHaveTextContent('Describing parts: cached, no tokens')
  })

  it('shows nothing while labelling is off or for an older world, and stays on when settings cannot be read', async () => {
    bridge({ worldGet: vi.fn(async () => ok(withTokens(500))), worldSettingsGet: settings(false) })
    const off = await mount()
    expect(screen.queryByTestId('world-label-cost')).toBeNull()
    off.unmount()
    bridge({ worldGet: vi.fn(async () => ok(withTokens())), worldSettingsGet: settings(true) })
    const old = await mount()
    expect(screen.queryByTestId('world-label-cost')).toBeNull()
    old.unmount()
    bridge({ worldGet: vi.fn(async () => ok(withTokens(500))), worldSettingsGet: vi.fn(async () => fail('no')) })
    const failed = await mount()
    expect(screen.getByTestId('world-label-cost')).toBeInTheDocument()
    failed.unmount()
    bridge({ worldGet: vi.fn(async () => ok(withTokens(500))), worldSettingsGet: vi.fn(async () => { throw new Error('down') }) })
    await mount()
    expect(screen.getByTestId('world-label-cost')).toBeInTheDocument()
  })
})

describe('WorldView layout (visual fidelity)', () => {
  it('is a flex column in the theme background from the first render, toolbar in flow above the map', async () => {
    const get = deferred<Res<WorldDoc | null>>()
    bridge({ worldGet: vi.fn(() => get.promise) })
    render(<WorldView root="/repo" onClose={vi.fn()} />)
    // Before the world loads: opaque Neon background, in the flow beside the terminals.
    expect(dialog()).toHaveStyle({ position: 'relative', width: '480px', background: '#03050a' })
    expect(dialog().style.zIndex).toBe('')
    expect(dialog()).not.toHaveClass('animate-fadeIn')
    expect(screen.getByTestId('world-loading')).toBeInTheDocument()
    const toolbar = screen.getByRole('toolbar', { name: 'Lumopolis controls' })
    expect(toolbar).toHaveStyle({ position: 'relative', background: '#252526' })
    expect(toolbar.nextElementSibling).toBe(screen.getByTestId('world-stage'))
    await act(async () => { get.resolve(ok(minimal())) })
    await settle()
    fireEvent.change(screen.getByTestId('world-theme'), { target: { value: 'blueprint' } })
    expect(dialog()).toHaveStyle({ background: '#061a33' })
  })

  it('pauses the viewer while the home or the loading screen covers the map', async () => {
    const get = deferred<Res<WorldDoc | null>>()
    bridge({ worldGet: vi.fn(() => get.promise) })
    const { rerender } = render(<WorldView root="/repo" onClose={vi.fn()} />)
    await settle()
    expect(viewer().setPaused).toHaveBeenLastCalledWith(true) // loading
    await act(async () => { get.resolve(ok(minimal())) })
    await settle()
    expect(viewer().setPaused).toHaveBeenLastCalledWith(false)
    rerender(<WorldView root="" onClose={vi.fn()} />)
    await settle()
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    expect(viewer().setPaused).toHaveBeenLastCalledWith(true)
  })

  it('shows the legend over the map once a world is drawn, with the processes layer passed on', async () => {
    bridge()
    await mount()
    expect(screen.getByTestId('world-legend')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('world-legend-toggle')) // a narrow pane starts it as a chip
    expect(screen.queryByTestId('world-legend-process')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Processes' }))
    expect(screen.getAllByTestId('world-legend-process').length).toBeGreaterThan(0)
  })

  it('has no legend in the 2D list or on the home', async () => {
    h.webgl = false
    bridge()
    await mount()
    expect(screen.getByTestId('world-fallback')).toBeInTheDocument()
    expect(screen.queryByTestId('world-legend')).toBeNull()
    cleanup()
    h.webgl = true
    bridge()
    await mount({ root: '' })
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    expect(screen.queryByTestId('world-legend')).toBeNull()
  })
})

describe('WorldView card actions', () => {
  const infer = (): WorldDoc => {
    const d = minimal()
    d.buildings[0].how = [{ text: 'Guessed role', state: 'inferred', evidence: [{ kind: 'file', ref: 'src/a.ts:3' }] }]
    return d
  }
  const open = async (doc: WorldDoc, extra: Record<string, unknown> = {}) => {
    const b = bridge({ worldGet: vi.fn(async () => ok(doc)), ...extra })
    await mount()
    act(() => viewer().opts.renderCard(buildingCard(doc, 'b1')))
    return b
  }

  it('a chip opens its glossary card and lights every building and line that uses it (3D)', async () => {
    await open(infer())
    fireEvent.click(screen.getByTestId('world-card').querySelector('[data-tech]') as Element)
    const calls = viewer().apply.mock.calls.map((c: unknown[]) => c[0] as { type: string; id?: string; ids?: string[] })
    expect(calls[0]).toMatchObject({ type: 'openCard' })
    expect(calls[0].id?.startsWith('tech:')).toBe(true)
    expect(calls[1].type).toBe('highlight')
    expect((calls[1].ids as string[]).length).toBeGreaterThan(0)
  })

  it('a chip opens the glossary card in the 2D list too', async () => {
    h.webgl = false
    const doc = infer()
    bridge({ worldGet: vi.fn(async () => ok(doc)) })
    await mount()
    fireEvent.click(screen.getByTestId('world-fallback').querySelector('[data-id="b1"]') as Element)
    const chip = screen.getByTestId('world-card').querySelector('[data-tech]') as Element
    const term = chip.getAttribute('data-tech') as string
    fireEvent.click(chip)
    expect(screen.getByTestId('world-card').querySelector('h3')?.textContent?.toLowerCase()).toContain(term.toLowerCase())
  })

  it('Confirm stores the claim and the pane shows the doc that comes back', async () => {
    const doc = infer()
    const returned = infer()
    returned.generatedAt = doc.generatedAt + 1
    returned.buildings[0].claims = [{ text: 'Guessed role', state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] }]
    const worldAnnotate = vi.fn(async () => ok(returned))
    await open(doc, { worldAnnotate })
    fireEvent.click(screen.getByTestId('world-card').querySelector('[data-confirm="b1|0"]') as Element)
    await settle()
    expect(worldAnnotate).toHaveBeenCalledWith(doc.projectKey, 'b1', 'Guessed role')
    expect(viewer().load).toHaveBeenLastCalledWith(returned, expect.anything())
  })

  it('Confirm that fails, by an answer or a throw, says so and keeps the doc', async () => {
    const worldAnnotate = vi.fn().mockResolvedValueOnce(fail('No part with that id.')).mockRejectedValueOnce(new Error('boom'))
    await open(infer(), { worldAnnotate })
    fireEvent.click(screen.getByTestId('world-card').querySelector('[data-confirm="b1|0"]') as Element)
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't confirm: No part with that id.")
    fireEvent.click(screen.getByTestId('world-card').querySelector('[data-confirm="b1|0"]') as Element)
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't confirm: boom")
  })

  it('an evidence button shows what it points at under the card, and closing the card or the evidence clears it', async () => {
    await open(infer())
    fireEvent.click(screen.getByTestId('world-card').querySelector('.claim .ev') as Element)
    expect(screen.getByTestId('evidence-view')).toHaveTextContent('file src/a.ts:3')
    fireEvent.click(screen.getByRole('button', { name: 'Close evidence' }))
    expect(screen.queryByTestId('evidence-view')).toBeNull()
    fireEvent.click(screen.getByTestId('world-card').querySelector('.claim .ev') as Element)
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByTestId('evidence-view')).toBeNull()
  })

  it('the card Edit button saves service names through world:annotate and shows the doc that comes back; a failure says so', async () => {
    const doc = infer()
    const returned = infer()
    returned.generatedAt = doc.generatedAt + 1
    const worldAnnotate = vi.fn().mockResolvedValueOnce(ok(returned)).mockResolvedValueOnce(fail('nope')).mockRejectedValueOnce(new Error('boom'))
    await open(doc, { worldAnnotate })
    const save = (text: string) => {
      fireEvent.click(screen.getByTestId('world-card').querySelector('[data-runtime-edit="b1"]') as Element)
      fireEvent.change(screen.getByLabelText(/Service names/), { target: { value: text } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    }
    save('orders-api, db')
    await settle()
    expect(worldAnnotate).toHaveBeenLastCalledWith(doc.projectKey, 'b1', 'runtime:orders-api,db')
    expect(viewer().load).toHaveBeenLastCalledWith(returned, expect.anything())
    save('x')
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't save the service names: nope")
    save('y')
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't save the service names: boom")
  })

  it('Confirm on an inferred claim that reads as service names saves nothing and points to Edit', async () => {
    const doc = infer()
    doc.buildings[0].how[0].text = 'runtime:a,b'
    const worldAnnotate = vi.fn()
    await open(doc, { worldAnnotate })
    fireEvent.click(screen.getByTestId('world-card').querySelector('[data-confirm="b1|0"]') as Element)
    await settle()
    expect(worldAnnotate).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Use Edit on the Service names line')
  })

  it('service names saved after the pane closed change nothing and do not throw', async () => {
    const late = deferred<Res<WorldDoc>>()
    const late2 = deferred<Res<WorldDoc>>()
    const worldAnnotate = vi.fn().mockReturnValueOnce(late.promise).mockReturnValueOnce(late2.promise)
    await open(infer(), { worldAnnotate })
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByTestId('world-card').querySelector('[data-runtime-edit="b1"]') as Element)
      fireEvent.change(screen.getByLabelText(/Service names/), { target: { value: `late${i}` } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    }
    cleanup()
    late.resolve(ok(infer()))
    late2.reject(new Error('late'))
    await settle()
    expect(worldAnnotate).toHaveBeenCalledTimes(2)
  })

  it('a Confirm answered after the pane closed changes nothing and does not throw', async () => {
    const late = deferred<Res<WorldDoc>>()
    const late2 = deferred<Res<WorldDoc>>()
    const worldAnnotate = vi.fn().mockReturnValueOnce(late.promise).mockReturnValueOnce(late2.promise)
    await open(infer(), { worldAnnotate })
    fireEvent.click(screen.getByTestId('world-card').querySelector('[data-confirm="b1|0"]') as Element)
    fireEvent.click(screen.getByTestId('world-card').querySelector('[data-confirm="b1|0"]') as Element)
    cleanup()
    late.resolve(ok(infer()))
    late2.reject(new Error('late'))
    await settle()
    expect(worldAnnotate).toHaveBeenCalledTimes(2)
  })
})


describe('WorldView 2D map switch and bookmarks', () => {
  const cam = { pos: [1, 2, 3], target: [4, 5, 6] }
  const card = () => screen.queryByTestId('world-card')
  const openMenu = () => fireEvent.click(screen.getByTestId('world-bookmarks'))
  const saveAs = (name: string) => {
    fireEvent.change(screen.getByTestId('world-bookmark-name'), { target: { value: name } })
    fireEvent.click(screen.getByTestId('world-bookmark-save'))
  }
  const keyOf = () => 'termpolis.world.bookmarks.' + minimal().projectKey

  it("the 2D map list ends above the ask bar laid over the pane's foot", async () => {
    const seen: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { seen.push(cb) }
      observe(): void {}
      disconnect(): void {}
    })
    const ask = { h: 0 }
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'world-ask-slot' ? ask.h : 0
    })
    try {
      bridge()
      await mount({ askSlot: () => <span>ask</span> })
      fireEvent.click(screen.getByTestId('world-map2d'))
      const list = screen.getByTestId('world-fallback')
      expect(list.style.bottom).toBe('0px') // no bar measured yet
      ask.h = 120 // the chips and the box
      act(() => { for (const cb of seen) cb() })
      // The bar: 120 tall, 16 off the bottom, 8 clear.
      expect(list.style.bottom).toBe('144px')
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })

  it('the 2D map switch shows the fallback with WebGL present, and is remembered', async () => {
    bridge()
    const askSlot = vi.fn(() => <span>ask</span>)
    await mount({ askSlot })
    const sw = screen.getByTestId('world-map2d')
    expect(sw).toHaveAttribute('role', 'switch')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByTestId('world-fallback')).toBeNull()
    expect(screen.getByTestId('world-legend')).toBeInTheDocument()
    fireEvent.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'true')
    const list = screen.getByTestId('world-fallback')
    expect(list.querySelector('svg[role="img"] rect[data-kind="building"]')).not.toBeNull()
    expect(screen.getByTestId('world-canvas-host').style.visibility).toBe('hidden')
    expect(viewer().setPaused).toHaveBeenLastCalledWith(true)
    expect(screen.queryByTestId('world-legend')).toBeNull()
    expect(askSlot).toHaveBeenLastCalledWith(null, expect.anything(), '/repo', expect.anything(), null)
    expect(localStorage.getItem('termpolis.world.map2d')).toBe('1')
    // A click on the map opens the card from the doc, not through the viewer.
    fireEvent.click(list.querySelector('svg rect[data-id="b1"]') as Element)
    expect(card()).toHaveTextContent('Desktop app')
    expect(viewer().apply).not.toHaveBeenCalled()
    // The district shape closes the card.
    fireEvent.click(list.querySelector('svg polygon[data-kind="district"]') as Element)
    expect(card()).toBeNull()
    fireEvent.click(list.querySelector('svg rect[data-id="b1"]') as Element)
    expect(card()).not.toBeNull()
    // Switching it off brings the 3D city back and clears the card.
    fireEvent.click(sw)
    expect(screen.queryByTestId('world-fallback')).toBeNull()
    expect(card()).toBeNull()
    expect(screen.getByTestId('world-canvas-host').style.visibility).toBe('visible')
    expect(viewer().setPaused).toHaveBeenLastCalledWith(false)
    expect(localStorage.getItem('termpolis.world.map2d')).toBe('0')
    expect(askSlot).toHaveBeenLastCalledWith(viewer(), expect.anything(), '/repo', expect.anything(), null)
  })

  it('starts in 2D when it was left on, and still switches when storage is blocked', async () => {
    localStorage.setItem('termpolis.world.map2d', '1')
    bridge()
    await mount()
    expect(screen.getByTestId('world-map2d')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('world-fallback')).toBeInTheDocument()
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      cleanup()
      bridge()
      await mount()
      expect(screen.getByTestId('world-map2d')).toHaveAttribute('aria-checked', 'false')
      fireEvent.click(screen.getByTestId('world-map2d'))
      expect(screen.getByTestId('world-fallback')).toBeInTheDocument()
    } finally {
      get.mockRestore()
      set.mockRestore()
    }
  })

  it('in the 2D map with a viewer a newer world rebuilds the open card, and a tour does not use the viewer', async () => {
    const b = bridge()
    await mount()
    fireEvent.click(screen.getByTestId('world-map2d'))
    const list = screen.getByTestId('world-fallback')
    fireEvent.click(list.querySelector('svg rect[data-id="b1"]') as Element)
    const d = minimal()
    b.api.worldGet.mockResolvedValueOnce(ok({ ...d, generatedAt: d.generatedAt + 1, buildings: d.buildings.map((x) => (x.id === 'b1' ? { ...x, name: 'Renamed desk' } : x)) }))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(card()).toHaveTextContent('Renamed desk')
    const tours = screen.getByTestId('world-tours') as HTMLSelectElement
    if (tours.options.length > 1) {
      fireEvent.change(tours, { target: { value: tours.options[1].value } })
      expect(viewer().play).not.toHaveBeenCalled()
    }
  })

  it('the 2D heading shows the project display name, not the hashed key', async () => {
    h.webgl = false
    bridge({ gitFindRoot: vi.fn(async () => ok('C:\\code\\my-app')) })
    await mount({ root: 'C:\\code\\my-app' })
    const list = screen.getByTestId('world-fallback')
    expect(list.querySelector('h2')).toHaveTextContent('my-app')
    expect(list.innerHTML).not.toContain(minimal().projectKey)
    expect(list.querySelector('svg')).toHaveAttribute('aria-label', 'Map of my-app')
  })

  it('saves a view with the camera and the open part, lists it newest first, and keeps it per project', async () => {
    bridge()
    await mount()
    openMenu()
    expect(screen.getByText('No saved views yet')).toBeInTheDocument()
    expect(screen.getByTestId('world-bookmark-save')).toBeDisabled() // no name yet
    viewer().getSelection.mockReturnValue(['b1'])
    saveAs('  Home view ')
    expect(JSON.parse(localStorage.getItem(keyOf()) as string)).toEqual([{ name: 'Home view', camera: cam, selection: ['b1'] }])
    expect(screen.getByTestId('world-bookmark-name')).toHaveValue('')
    fireEvent.change(screen.getByTestId('world-bookmark-name'), { target: { value: '   ' } })
    fireEvent.keyDown(screen.getByTestId('world-bookmark-name'), { key: 'Enter' }) // blank: nothing
    expect(screen.getAllByTestId('world-bookmark-go')).toHaveLength(1)
    fireEvent.change(screen.getByTestId('world-bookmark-name'), { target: { value: 'Second' } })
    fireEvent.keyDown(screen.getByTestId('world-bookmark-name'), { key: 'a' }) // not Enter: nothing yet
    expect(screen.getAllByTestId('world-bookmark-go')).toHaveLength(1)
    fireEvent.keyDown(screen.getByTestId('world-bookmark-name'), { key: 'Enter' })
    expect(screen.getAllByTestId('world-bookmark-go').map((x) => x.textContent)).toEqual(['Second', 'Home view'])
    // Another visit finds them again.
    cleanup()
    bridge()
    await mount()
    openMenu()
    expect(screen.getAllByTestId('world-bookmark-go').map((x) => x.textContent)).toEqual(['Second', 'Home view'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove Second' }))
    expect(screen.getAllByTestId('world-bookmark-go').map((x) => x.textContent)).toEqual(['Home view'])
    // The menu closes on a second click of its button.
    openMenu()
    expect(screen.queryByTestId('world-bookmarks-menu')).toBeNull()
  })

  it('does not save when the viewer has no camera', async () => {
    bridge()
    await mount()
    viewer().cameraState.mockReturnValue(null)
    openMenu()
    saveAs('Nope')
    expect(screen.getByText('No saved views yet')).toBeInTheDocument()
  })

  it('choosing a bookmark calls setCamera(camera, false) and restores its selection; an id no longer in the world is skipped', async () => {
    localStorage.setItem(keyOf(), JSON.stringify([
      { name: 'Open b1', camera: cam, selection: ['gone', 'b1'] },
      { name: 'Empty', camera: cam, selection: ['gone'] },
    ]))
    bridge()
    await mount()
    viewer().getSelection.mockReturnValue(['b1'])
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Open b1' }))
    await settle()
    expect(viewer().apply).toHaveBeenCalledWith({ type: 'openCard', id: 'b1' })
    expect(viewer().setCamera).toHaveBeenLastCalledWith(cam, false)
    expect(viewer().resetView).not.toHaveBeenCalled()
    expect(screen.queryByTestId('world-bookmarks-menu')).toBeNull()
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }))
    expect(viewer().apply).toHaveBeenCalledTimes(1)
    expect(viewer().resetView).toHaveBeenCalledTimes(1)
    expect(viewer().setCamera).toHaveBeenLastCalledWith(cam, false)
  })

  it('a drag, a click, the wheel, Esc or another selection during the flight leaves the camera where it is', async () => {
    localStorage.setItem(keyOf(), JSON.stringify([{ name: 'Open b1', camera: cam, selection: ['b1'] }]))
    bridge()
    await mount()
    const host = screen.getByTestId('world-canvas-host')
    const cut: Array<[string, () => void]> = [
      ['pointerdown', () => fireEvent.pointerDown(host)],
      ['wheel', () => fireEvent.wheel(host)],
      ['Esc', () => esc()],
      ['another pick', () => viewer().getSelection.mockReturnValue(['b2'])],
    ]
    for (const [, interrupt] of cut) {
      viewer().getSelection.mockReturnValue(['b1'])
      const flight = deferred<undefined>()
      viewer().apply.mockReturnValueOnce(flight.promise)
      viewer().setCamera.mockClear()
      openMenu()
      fireEvent.click(screen.getByRole('button', { name: 'Open b1' }))
      interrupt()
      await act(async () => { flight.resolve(undefined) })
      await settle()
      expect(viewer().setCamera).not.toHaveBeenCalled()
    }
  })

  it('a switch to another world during the flight leaves the camera alone', async () => {
    localStorage.setItem(keyOf(), JSON.stringify([{ name: 'Open b1', camera: cam, selection: ['b1'] }]))
    const b = bridge()
    const { rerender, onClose } = await mount()
    viewer().getSelection.mockReturnValue(['b1'])
    const flight = deferred<undefined>()
    viewer().apply.mockReturnValueOnce(flight.promise)
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Open b1' }))
    b.api.worldGet.mockResolvedValue(ok({ ...minimal(), projectKey: 'another-world' }))
    rerender(<WorldView root="/next" onClose={onClose} />)
    await settle()
    await act(async () => { flight.resolve(undefined) })
    await settle()
    expect(viewer().setCamera).not.toHaveBeenCalled()
  })

  it('finds a line, a district and an outside part in the world', async () => {
    const d = minimal()
    for (const id of [d.edges[0].id, d.districts[0].id, d.externals[0].id]) {
      localStorage.setItem(keyOf(), JSON.stringify([{ name: 'K', camera: cam, selection: [id] }]))
      bridge()
      await mount()
      openMenu()
      fireEvent.click(screen.getByRole('button', { name: 'K' }))
      expect(viewer().apply).toHaveBeenCalledWith({ type: 'openCard', id })
      cleanup()
    }
  })

  it('without WebGL a view cannot be saved or gone to, and removing one still works', async () => {
    h.webgl = false
    localStorage.setItem(keyOf(), JSON.stringify([{ name: 'Old', camera: cam, selection: [] }]))
    bridge()
    await mount()
    openMenu()
    fireEvent.change(screen.getByTestId('world-bookmark-name'), { target: { value: 'New' } })
    expect(screen.getByTestId('world-bookmark-save')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Old' })) // nothing to fly to: no throw
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Old' }))
    expect(screen.getByText('No saved views yet')).toBeInTheDocument()
  })
})

// A folder asked for from outside the pane: a terminal's globe, the `lumopolis` command, the file tree.
describe('WorldView asked for a folder', () => {
  it('opens the asked folder\'s project, not the active terminal\'s, registers it, and stays on it through a cd', async () => {
    const b = bridge({ gitFindRoot: vi.fn(async (cwd: string) => ok(cwd.startsWith('/other') ? '/other' : '/repo')), worldGet: vi.fn(async () => ok(null)) })
    const onClose = vi.fn()
    const utils = render(<WorldView root="/repo/src" onClose={onClose} request={{ folder: '/other/pkg', seq: 1 }} />)
    await settle()
    expect(b.api.gitFindRoot).toHaveBeenCalledWith('/other/pkg')
    expect(b.api.worldCompile).toHaveBeenCalledWith('/other')
    expect(b.api.worldMapProject).toHaveBeenCalledWith('/other')
    utils.rerender(<WorldView root="/repo/lib" onClose={onClose} request={{ folder: '/other/pkg', seq: 1 }} />)
    await settle()
    expect(b.api.gitFindRoot).not.toHaveBeenCalledWith('/repo/lib')
  })

  it('a request while open moves the pane to that project and brings the pane forward', async () => {
    const b = bridge({ gitFindRoot: vi.fn(async (cwd: string) => ok(cwd.startsWith('/other') ? '/other' : '/repo')) })
    const onClose = vi.fn()
    const utils = render(<WorldView root="/repo" onClose={onClose} />)
    await settle()
    expect(b.api.worldGet).toHaveBeenLastCalledWith('/repo')
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    utils.rerender(<WorldView root="/repo" onClose={onClose} request={{ folder: '/other/a', seq: 1 }} />)
    await settle()
    expect(b.api.worldGet).toHaveBeenLastCalledWith('/other')
    expect(document.activeElement).toBe(dialog())
    outside.focus()
    utils.rerender(<WorldView root="/repo" onClose={onClose} request={{ folder: '/other/a', seq: 2 }} />)
    await settle()
    expect(document.activeElement).toBe(dialog()) // the same folder again: forward, nothing reloaded
    expect(b.api.worldGet).toHaveBeenCalledTimes(2)
    utils.rerender(<WorldView root="/repo" onClose={onClose} />) // the request dropped: the pane stays where it is
    await settle()
    expect(b.api.worldGet).toHaveBeenCalledTimes(2)
    outside.remove()
  })

  it('opening the pane saves that Lumopolis has been opened and tells the sidebar', async () => {
    const set = vi.fn(async () => ok({}))
    bridge({ worldSettingsSet: set })
    const onOpened = vi.fn()
    window.addEventListener('termpolis:worldOpened', onOpened)
    await mount()
    window.removeEventListener('termpolis:worldOpened', onOpened)
    expect(set).toHaveBeenCalledWith({ worldOpened: true })
    expect(onOpened).toHaveBeenCalledTimes(1)
    cleanup()
    bridge({ worldSettingsSet: vi.fn(async () => { throw new Error('disk') }) })
    await mount() // a save that fails is not the user's problem: the pane opens all the same
    expect(dialog()).toBeInTheDocument()
  })
})

describe('WorldView export', () => {
  const MB = 1024 * 1024
  const PNG = 'data:image/png;base64,iVBORw0KGgo='
  const exportApi = (over: Record<string, unknown> = {}) => ({
    worldExportInfo: vi.fn(async () => ok({
      title: 'repo', savedAt: 1, smartDefault: true, buildings: 1, lines: 1, smartBytes: 37 * MB, keywordBytes: MB, smartAvailable: true, proposals: [],
    })),
    worldExport: vi.fn(async () => ok({ path: 'C:\\Users\\me\\Documents\\repo.html', bytes: 37 * MB })),
    worldExportCancel: vi.fn(async () => ok(true)),
    onWorldExportProgress: vi.fn(() => () => undefined),
    worldDocument: vi.fn(async () => ok({ path: '/home/me/repo documentation.html', bytes: 90_000 })),
    worldShowFile: vi.fn(async () => ok(true)),
    worldOpenFile: vi.fn(async () => ok(true)),
    ...over,
  })
  type ExportReq = { kind: 'world' | 'document'; seq: number }
  async function mountWith(props: { root?: string; exportRequest?: ExportReq } = {}) {
    const utils = render(<WorldView root={props.root ?? '/repo'} onClose={vi.fn()} exportRequest={props.exportRequest} />)
    await settle()
    return {
      ...utils,
      again: async (p: { root?: string; exportRequest?: ExportReq }) => {
        utils.rerender(<WorldView root={p.root ?? '/repo'} onClose={vi.fn()} exportRequest={p.exportRequest} />)
        await settle()
      },
    }
  }
  const openMenu = (item: 'world' | 'document') => {
    fireEvent.click(screen.getByTestId('world-export'))
    fireEvent.click(screen.getByTestId(`world-export-${item}`))
  }
  /** The viewer's canvas, as the real engine puts it in the host. */
  const canvas = (toDataURL: () => string) => {
    const c = document.createElement('canvas')
    c.toDataURL = vi.fn(toDataURL) as never
    screen.getByTestId('world-canvas-host').appendChild(c)
    return c
  }
  const pictureBox = () => screen.getByLabelText('Include the city picture') as HTMLInputElement
  /** One animation frame: the pane reads the canvas inside the frame after the click, then opens the dialog. */
  const nextFrame = () => act(() => new Promise<void>((r) => { requestAnimationFrame(() => r()) }))

  it('the home has no Export button', async () => {
    bridge(exportApi())
    await mountWith({ root: '' })
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    expect(screen.queryByTestId('world-export')).toBeNull()
  })

  it('Export waits for the world; its menu opens the export dialog for this world, and Esc closes the dialog before anything else', async () => {
    const get = deferred<Res<WorldDoc | null>>()
    const b = bridge(exportApi({ worldGet: vi.fn(() => get.promise) }))
    await mountWith()
    expect(screen.queryByTestId('world-export')).toBeNull()
    await act(async () => { get.resolve(ok(minimal())) })
    await settle()
    openMenu('world')
    await settle()
    expect(screen.getByTestId('world-export-dialog')).toBeInTheDocument()
    expect(b.api.worldExportInfo).toHaveBeenCalledWith({ root: '/repo', designKey: undefined })
    esc()
    expect(screen.queryByTestId('world-export-dialog')).toBeNull()
    expect(viewer().resetView).not.toHaveBeenCalled()
  })

  it('the export dialog says which saved map it uses while a compile runs', async () => {
    const b = bridge(exportApi())
    await mountWith()
    b.progress({ root: '/repo', projectKey: 'k', stage: 'labelling', pct: 65 })
    openMenu('world')
    await settle()
    expect(screen.getByTestId('world-export-saved-at')).toHaveTextContent(/; Lumopolis is still describing its parts\.$/)
    esc()
    // Any other stage is an update of the map, not a description of its parts.
    b.progress({ root: '/repo', projectKey: 'k', stage: 'layout', pct: 80 })
    openMenu('world')
    await settle()
    expect(screen.getByTestId('world-export-saved-at')).toHaveTextContent(/; Lumopolis is still updating it\.$/)
    esc()
    b.progress({ root: '/repo', projectKey: 'k', stage: 'layout', pct: 100 })
    openMenu('world')
    await settle()
    expect(screen.queryByTestId('world-export-saved-at')).toBeNull()
  })

  it('a finished export raises the toast in the notice slot; its buttons show and open the file, and Dismiss clears it', async () => {
    const b = bridge(exportApi())
    await mountWith()
    openMenu('world')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }))
    await settle()
    expect(screen.queryByTestId('world-export-dialog')).toBeNull()
    const notice = screen.getByTestId('world-notice')
    expect(notice).toHaveTextContent('Exported repo.html (37 MB)')
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    expect(b.api.worldShowFile).toHaveBeenCalledWith('C:\\Users\\me\\Documents\\repo.html')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(b.api.worldOpenFile).toHaveBeenCalledWith('C:\\Users\\me\\Documents\\repo.html')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('world-notice')).toBeNull()
  })

  it('a later notice takes the slot from the toast', async () => {
    bridge(exportApi({ worldRelayout: vi.fn(async () => fail('disk full')) }))
    await mountWith()
    openMenu('world')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }))
    await settle()
    expect(screen.getByTestId('world-notice')).toHaveTextContent('Exported repo.html')
    fireEvent.click(screen.getByTestId('world-relayout'))
    fireEvent.click(screen.getByTestId('world-relayout-go'))
    await settle()
    expect(screen.getByTestId('world-notice')).toHaveTextContent('disk full')
    expect(screen.queryByTestId('world-export-toast')).toBeNull()
  })

  it('closing the pane mid-export cancels it, and the late file raises nothing', async () => {
    const run = deferred<Res<{ path: string; bytes: number }>>()
    const b = bridge(exportApi({ worldExport: vi.fn(() => run.promise) }))
    const m = await mountWith()
    openMenu('world')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }))
    m.unmount()
    expect(b.api.worldExportCancel).toHaveBeenCalledTimes(1)
    await act(async () => { run.resolve(ok({ path: '/x/repo.html', bytes: MB })) })
    expect(screen.queryByTestId('world-notice')).toBeNull()
  })

  it('the documentation dialog takes the city picture from the viewer canvas, titled with the project name', async () => {
    const b = bridge(exportApi())
    await mountWith()
    const c = canvas(() => PNG)
    openMenu('document')
    // WebGL clears the canvas once a frame is shown: nothing is read, and no dialog opens, until the next frame.
    expect(c.toDataURL).not.toHaveBeenCalled()
    expect(screen.queryByTestId('world-document-dialog')).toBeNull()
    await nextFrame()
    expect(c.toDataURL).toHaveBeenCalledWith('image/png')
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('repo')
    expect(pictureBox().disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save…' }))
    expect(b.api.worldDocument).toHaveBeenCalledWith({ root: '/repo', designKey: undefined, title: 'repo', picturePng: PNG, documentId: expect.any(String) })
    await settle()
    expect(screen.queryByTestId('world-document-dialog')).toBeNull()
    expect(screen.getByTestId('world-notice')).toHaveTextContent('Exported repo documentation.html (0.1 MB)')
  })

  it('Esc closes the documentation dialog', async () => {
    bridge(exportApi())
    await mountWith()
    openMenu('document')
    esc()
    expect(screen.queryByTestId('world-document-dialog')).toBeNull()
    expect(viewer().resetView).not.toHaveBeenCalled()
  })

  it('no canvas, a canvas that refuses, or the 2D map: no picture, and the checkbox says why', async () => {
    bridge(exportApi())
    await mountWith()
    openMenu('document')
    expect(pictureBox().disabled).toBe(true)
    esc()
    const c = canvas(() => { throw new Error('tainted') })
    openMenu('document')
    await nextFrame()
    expect(c.toDataURL).toHaveBeenCalled()
    expect(pictureBox().disabled).toBe(true)
    esc()
    const fine = vi.fn(() => PNG)
    c.toDataURL = fine as never
    fireEvent.click(screen.getByTestId('world-map2d'))
    openMenu('document')
    expect(fine).not.toHaveBeenCalled()
    expect(pictureBox().disabled).toBe(true)
  })

  it('without WebGL there is no picture', async () => {
    h.webgl = false
    bridge(exportApi())
    await mountWith()
    openMenu('document')
    expect(pictureBox().disabled).toBe(true)
    expect(screen.getByTestId('world-document-no-picture')).toBeInTheDocument()
  })

  it('an export request opens its dialog once the world is there, even when the pane mounts with it; each new seq opens again', async () => {
    const get = deferred<Res<WorldDoc | null>>()
    const b = bridge(exportApi({ worldGet: vi.fn(() => get.promise) }))
    const m = await mountWith({ exportRequest: { kind: 'document', seq: 1 } })
    expect(screen.queryByTestId('world-document-dialog')).toBeNull()
    await act(async () => { get.resolve(ok(minimal())) })
    await settle()
    expect(screen.getByTestId('world-document-dialog')).toBeInTheDocument()
    // The same request again (a re-render) opens nothing new.
    esc()
    await m.again({ exportRequest: { kind: 'document', seq: 1 } })
    expect(screen.queryByTestId('world-document-dialog')).toBeNull()
    await m.again({ exportRequest: { kind: 'world', seq: 2 } })
    expect(screen.getByTestId('world-export-dialog')).toBeInTheDocument()
    expect(b.api.worldExportInfo).toHaveBeenCalledTimes(1)
    // A request with nothing in it changes nothing.
    await m.again({})
    expect(screen.getByTestId('world-export-dialog')).toBeInTheDocument()
  })

  it('an export request on the home says to open a world first', async () => {
    bridge(exportApi())
    await mountWith({ root: '', exportRequest: { kind: 'world', seq: 1 } })
    expect(screen.getByTestId('world-notice')).toHaveTextContent('Open a world to export it.')
    expect(screen.queryByTestId('world-export-dialog')).toBeNull()
  })

  it('a picture frame still to come is dropped when the pane closes or the world changes', async () => {
    bridge(exportApi())
    const m = await mountWith()
    const c = canvas(() => PNG)
    openMenu('document')
    await m.again({ root: '/other' })
    await nextFrame()
    expect(c.toDataURL).not.toHaveBeenCalled()
    expect(screen.queryByTestId('world-document-dialog')).toBeNull()
    const c2 = canvas(() => PNG)
    openMenu('document')
    m.unmount()
    await new Promise<void>((r) => { requestAnimationFrame(() => r()) })
    expect(c2.toDataURL).not.toHaveBeenCalled()
  })

  it('asking twice before the frame takes one picture and opens one dialog', async () => {
    bridge(exportApi())
    await mountWith()
    const c = canvas(() => PNG)
    openMenu('document')
    openMenu('document')
    await nextFrame()
    expect(c.toDataURL).toHaveBeenCalledTimes(1)
    expect(screen.getAllByTestId('world-document-dialog')).toHaveLength(1)
  })

  it('while a dialog is open Export is off, and a palette ask neither opens another dialog nor cuts the running export short', async () => {
    const run = deferred<Res<{ path: string; bytes: number }>>()
    const b = bridge(exportApi({ worldExport: vi.fn(() => run.promise) }))
    const m = await mountWith()
    expect(screen.getByTestId('world-export')).toBeEnabled()
    openMenu('world')
    await settle()
    expect(screen.getByTestId('world-export')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }))
    await settle()
    const cancel = within(screen.getByTestId('world-export-dialog')).getByRole('button', { name: 'Cancel' })
    cancel.focus()
    await m.again({ exportRequest: { kind: 'document', seq: 1 } })
    expect(screen.getByTestId('world-export-dialog')).toBeInTheDocument()
    // The dropped ask leaves the focus where the person had it.
    expect(document.activeElement).toBe(cancel)
    expect(screen.queryByTestId('world-document-dialog')).toBeNull()
    expect(b.api.worldExportCancel).not.toHaveBeenCalled()
    await act(async () => { run.resolve(ok({ path: 'C:/Users/me/Documents/repo.html', bytes: MB })) })
    await settle()
    expect(screen.getByTestId('world-export-toast')).toBeInTheDocument()
    expect(screen.getByTestId('world-export')).toBeEnabled()
    // The ask that came while the export ran was dropped: nothing opens once it is done.
    expect(screen.queryByTestId('world-document-dialog')).toBeNull()
    // The documentation dialog turns Export off too.
    openMenu('document')
    expect(screen.getByTestId('world-document-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('world-export')).toBeDisabled()
  })

  it('the Export menu is a group of buttons; Esc closes only the menu, and the next Esc reaches the map', async () => {
    bridge(exportApi())
    const onClose = vi.fn()
    render(<WorldView root="/repo" onClose={onClose} />)
    await settle()
    const btn = screen.getByTestId('world-export')
    expect(btn).toHaveAttribute('aria-haspopup', 'true')
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('group', { name: 'Export' })
    expect(within(menu).getAllByRole('button').map((x) => x.textContent)).toEqual(['Interactive world (HTML)…', 'Documentation (HTML)…'])
    expect(screen.queryByRole('menu')).toBeNull()
    // Another key leaves it open.
    fireEvent.keyDown(btn, { key: 'Tab' })
    expect(screen.getByTestId('world-export-menu')).toBeInTheDocument()
    esc(btn)
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
    expect(viewer().resetView).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // From one of its items, too.
    fireEvent.click(btn)
    esc(screen.getByTestId('world-export-document'))
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
    expect(viewer().resetView).not.toHaveBeenCalled()
    expect(screen.queryByTestId('world-document-dialog')).toBeNull()
    // With the menu closed, Esc does what it always did.
    esc(btn)
    expect(viewer().resetView).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a click outside the Export menu closes it; a click inside does not', async () => {
    bridge(exportApi())
    await mountWith()
    fireEvent.click(screen.getByTestId('world-export'))
    fireEvent.mouseDown(screen.getByTestId('world-export-menu'))
    expect(screen.getByTestId('world-export-menu')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByTestId('world-canvas-host'))
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
    expect(screen.getByTestId('world-export')).toHaveAttribute('aria-expanded', 'false')
    // Closed, a click anywhere changes nothing.
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
  })

  it('a palette ask that opens a dialog closes the Export menu under it', async () => {
    bridge(exportApi())
    const m = await mountWith()
    fireEvent.click(screen.getByTestId('world-export'))
    expect(screen.getByTestId('world-export-menu')).toBeInTheDocument()
    await m.again({ exportRequest: { kind: 'world', seq: 1 } })
    expect(screen.getByTestId('world-export-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
    esc()
    expect(screen.getByTestId('world-export')).toHaveAttribute('aria-expanded', 'false')
  })

  it('a palette ask is dropped when the world fails to load, so a world that loads later opens nothing', async () => {
    const b = bridge(exportApi({ worldGet: vi.fn(async () => fail('The saved map is damaged.')) }))
    await mountWith({ exportRequest: { kind: 'document', seq: 1 } })
    expect(screen.getByText(/The saved map is damaged/)).toBeInTheDocument()
    b.api.worldGet.mockResolvedValue(ok(minimal()))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(screen.getByTestId('world-export')).toBeInTheDocument()
    expect(screen.queryByTestId('world-document-dialog')).toBeNull()
  })

  it('a palette ask made while one world loads is dropped when another world is opened before it is there', async () => {
    const slow = deferred<Res<WorldDoc | null>>()
    const b = bridge(exportApi({ worldGet: vi.fn((root: string) => (root === '/a' ? slow.promise : Promise.resolve(ok(minimal())))) }))
    const m = await mountWith({ root: '/a', exportRequest: { kind: 'world', seq: 1 } })
    await m.again({ root: '/b', exportRequest: { kind: 'world', seq: 1 } })
    await act(async () => { slow.resolve(ok(minimal())) })
    await settle()
    expect(screen.getByTestId('world-export')).toBeInTheDocument() // B is there
    expect(screen.queryByTestId('world-export-dialog')).toBeNull()
    expect(b.api.worldExportInfo).not.toHaveBeenCalled()
    // A new ask on B opens B's dialog.
    await m.again({ root: '/b', exportRequest: { kind: 'world', seq: 2 } })
    expect(screen.getByTestId('world-export-dialog')).toBeInTheDocument()
  })

  it('a palette ask made before the folder resolves is dropped when another world is opened, and kept through its own load', async () => {
    const find = deferred<Res<string | null>>()
    const b = bridge(exportApi({ gitFindRoot: vi.fn((cwd: string) => (cwd === '/a/sub' ? find.promise : Promise.resolve(ok<string | null>(cwd)))) }))
    const m = render(<WorldView root="/a/sub" onClose={vi.fn()} exportRequest={{ kind: 'world', seq: 1 }} />)
    await settle()
    m.rerender(<WorldView root="/b" onClose={vi.fn()} exportRequest={{ kind: 'world', seq: 1 }} />)
    await settle()
    expect(screen.getByTestId('world-export')).toBeInTheDocument()
    expect(screen.queryByTestId('world-export-dialog')).toBeNull()
    expect(b.api.worldExportInfo).not.toHaveBeenCalled()
    m.unmount()
    // The same ask with no switch: the root resolves, the world loads, the dialog opens.
    const find2 = deferred<Res<string | null>>()
    bridge(exportApi({ gitFindRoot: vi.fn(() => find2.promise) }))
    render(<WorldView root="/a/sub" onClose={vi.fn()} exportRequest={{ kind: 'world', seq: 1 }} />)
    await settle()
    await act(async () => { find2.resolve(ok('/a')) })
    await settle()
    expect(screen.getByTestId('world-export-dialog')).toBeInTheDocument()
  })

  it('a first compile that throws or fails leaves no run going: a world that loads after says nothing of one', async () => {
    for (const end of ['throw', 'fail'] as const) {
      const compile = deferred<Res<WorldDoc>>()
      const b = bridge(exportApi({ worldGet: vi.fn(async () => ok(null)), worldCompile: vi.fn(() => compile.promise) }))
      const m = await mountWith()
      b.progress({ root: '/repo', projectKey: 'k', stage: 'labelling', pct: 65 })
      await act(async () => { if (end === 'throw') compile.reject(new Error('down')); else compile.resolve(fail('no source files found')) })
      await settle()
      expect(screen.queryByTestId('world-export')).toBeNull()
      b.api.worldGet.mockResolvedValue(ok(minimal()))
      await b.updated({ root: '/repo', projectKey: 'k' })
      await settle()
      openMenu('world')
      await settle()
      expect(screen.getByTestId('world-export-dialog')).toBeInTheDocument()
      expect(screen.queryByTestId('world-export-saved-at')).toBeNull()
      m.unmount()
    }
  })

  it("the export dialog's low-description note follows Describe parts with AI", async () => {
    const info = vi.fn(async () => ok({ title: 'repo', savedAt: 1, smartDefault: false, buildings: 0.1, lines: 0.1, smartBytes: 37 * MB, keywordBytes: MB, smartAvailable: true, proposals: [] }))
    for (const on of [true, false]) {
      bridge(exportApi({ worldExportInfo: info, worldSettingsGet: vi.fn(async () => ok({ worldLabelling: on, worldSpeakAnswers: false })) }))
      const m = await mountWith()
      openMenu('world')
      await settle()
      expect(screen.getByTestId('world-export-note')).toHaveTextContent(on ? /Press Re-layout to have Lumopolis describe them/ : /Turn on Describe parts with AI in Settings/)
      m.unmount()
    }
  })

  it("until Describe parts with AI is known, the low-description note names no step; a setting that can't be read stays unknown", async () => {
    const info = vi.fn(async () => ok({ title: 'repo', savedAt: 1, smartDefault: false, buildings: 0.1, lines: 0.1, smartBytes: 37 * MB, keywordBytes: MB, smartAvailable: true, proposals: [] }))
    const only = "Most parts aren't described yet, so smart Ask would mostly match file names."
    let answer!: (v: unknown) => void
    bridge(exportApi({ worldExportInfo: info, worldSettingsGet: vi.fn(() => new Promise((res) => { answer = res })) }))
    const m = await mountWith()
    openMenu('world')
    await settle()
    expect(screen.getByTestId('world-export-note').textContent).toBe(only)
    answer(ok({ worldLabelling: true, worldSpeakAnswers: false }))
    await settle()
    expect(screen.getByTestId('world-export-note')).toHaveTextContent(/Press Re-layout to have Lumopolis describe them/)
    m.unmount()
    bridge(exportApi({ worldExportInfo: info, worldSettingsGet: vi.fn(async () => fail('no')) }))
    await mountWith()
    openMenu('world')
    await settle()
    expect(screen.getByTestId('world-export-note').textContent).toBe(only)
  })

  it('a saved world ends the run that made it: the export dialog no longer says a compile is running', async () => {
    const b = bridge(exportApi())
    await mountWith()
    b.progress({ root: '/repo', projectKey: 'k', stage: 'boundaries', pct: 40 })
    await b.updated({ root: '/repo', projectKey: 'k' })
    openMenu('world')
    await settle()
    expect(screen.queryByTestId('world-export-saved-at')).toBeNull()
    esc()
    // A saved world for another folder leaves this one's run alone.
    b.progress({ root: '/repo', projectKey: 'k', stage: 'boundaries', pct: 40 })
    await b.updated({ root: '/other', projectKey: 'other' })
    openMenu('world')
    await settle()
    expect(screen.getByTestId('world-export-saved-at')).toBeInTheDocument()
  })

  it('moving to another world closes an open dialog and the toast', async () => {
    bridge(exportApi())
    const m = await mountWith()
    openMenu('world')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }))
    await settle()
    expect(screen.getByTestId('world-export-toast')).toBeInTheDocument()
    openMenu('document')
    expect(screen.getByTestId('world-document-dialog')).toBeInTheDocument()
    await m.again({ root: '/other' })
    expect(screen.queryByTestId('world-document-dialog')).toBeNull()
    expect(screen.queryByTestId('world-export-toast')).toBeNull()
  })
})
