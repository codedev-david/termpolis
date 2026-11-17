import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
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
        load: vi.fn(), setLayers: vi.fn(), setTheme: vi.fn(),
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
    expect((createWorldViewer as unknown as { mock: { calls: [HTMLElement, WorldViewerOptions][] } }).mock.calls[0][1].rightReserve).toBe(244) // the legend's strip
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
    esc() // a card is open: it clears, the pane stays
    expect(screen.queryByTestId('world-card')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => v.opts.renderCard(null))
    esc()
    expect(onClose).toHaveBeenCalledTimes(2)

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
    expect(askSlot).toHaveBeenLastCalledWith(null, expect.objectContaining({ buildings: expect.any(Array) }), '/repo', expect.objectContaining({ onEscape: expect.any(Function), setBusy: expect.any(Function) }))
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

  it('a newer world of the same project keeps the open part; another project does not', async () => {
    const b = bridge()
    await mount()
    const v = viewer()
    // Nothing selected: the newer world just loads.
    b.api.worldGet.mockResolvedValueOnce(ok({ ...minimal(), generatedAt: 2 }))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(2)
    expect(v.apply).not.toHaveBeenCalled()
    // A part is open: the labelled follow-up's world opens it again after the load.
    v.getSelection.mockReturnValue(['b1'])
    b.api.worldGet.mockResolvedValueOnce(ok({ ...minimal(), generatedAt: 3 }))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(3)
    expect(v.apply).toHaveBeenCalledTimes(1)
    expect(v.apply).toHaveBeenLastCalledWith({ type: 'openCard', id: 'b1' })
    expect(v.load.mock.invocationCallOrder[2]).toBeLessThan(v.apply.mock.invocationCallOrder[0])
    // Another project's world starts with nothing open.
    b.api.worldGet.mockResolvedValueOnce(ok({ ...minimal(), projectKey: 'other', generatedAt: 4 }))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(4)
    expect(v.apply).toHaveBeenCalledTimes(1)
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
    expect(askSlot).toHaveBeenLastCalledWith(v, expect.objectContaining({ buildings: expect.any(Array) }), '/repo', expect.objectContaining({ onEscape: expect.any(Function), setBusy: expect.any(Function) }))
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
