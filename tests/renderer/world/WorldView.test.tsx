import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup, within } from '@testing-library/react'
import type { WorldDoc, WorldEntry, WorldProgressEvent, WorldUpdatedEvent } from '../../../src/shared/world/types'
import type { WorldSelection, WorldViewerOptions } from '../../../src/renderer/src/world/engine'
import { buildingCard, edgeCard } from '../../../src/renderer/src/world/engine'
import { minimal, rich } from './helpers'

// The engine is real except the two things jsdom cannot do: a WebGL probe and a WebGL viewer.
const h = vi.hoisted(() => ({ webgl: true, software: false, viewers: [] as any[], perf: null as Record<string, unknown> | null }))
vi.mock('../../../src/renderer/src/world/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/renderer/src/world/engine')>()
  return {
    ...real,
    hasWebGL: () => h.webgl,
    createWorldViewer: vi.fn((host: HTMLElement, opts: WorldViewerOptions) => {
      const selectCbs = new Set<(s: WorldSelection | null) => void>()
      const v = {
        host, opts,
        load: vi.fn(), setLayers: vi.fn(), setTheme: vi.fn(), setRightReserve: vi.fn(), setBottomReserve: vi.fn(), setCardReserve: vi.fn(), setPanels: vi.fn(), setLabelScale: vi.fn(),
        apply: vi.fn(async () => undefined), play: vi.fn(async () => undefined), cancelActions: vi.fn(),
        on: vi.fn((ev: string, cb: (s: WorldSelection | null) => void) => {
          if (ev !== 'select') return () => undefined
          selectCbs.add(cb)
          return () => { selectCbs.delete(cb) }
        }),
        emitSelect: (s: WorldSelection | null) => { for (const cb of selectCbs) cb(s) },
        selectListeners: () => selectCbs.size,
        getSelection: vi.fn(() => []), cameraRegion: vi.fn(() => []), resetView: vi.fn(), setPaused: vi.fn(), requestFrame: vi.fn(), setTitle: vi.fn(), dispose: vi.fn(),
        screenPoint: vi.fn((id: string) => (id === 'b1' ? { x: 1, y: 2 } : null)),
        linePoints: vi.fn((id: string) => (id === 'e1' ? [{ x: 3, y: 4 }] : [])),
        pickAt: vi.fn((x: number) => (x === 1 ? { kind: 'node', id: 'b1' } : null)),
        drawn: vi.fn(() => ({ layers: real.DEFAULT_LAYERS, processShells: 0, conduits: 4, software: h.software, ...(h.perf ? { perf: h.perf } : {}) })),
        perf: vi.fn(() => h.perf),
        perfBegin: vi.fn(), perfEnd: vi.fn(() => ({ frames: 3, p50: 16, p95: 18, p99: 18, worst: 18 })),
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
import { GRAPHICS_FLAT, GRAPHICS_LOST, GRAPHICS_WATCHDOG } from '../../../src/renderer/src/components/World/WorldView'
import { CONFIRM_FAILED, NAMES_FAILED, RELAYOUT_FAILED, UI_FAILED } from '../../../src/renderer/src/components/World/worldTargets'
import { savedByNewerNotice } from '../../../src/renderer/src/components/World/worldNotes'
import { FOLDER_EMPTY_MESSAGE, FOLDER_UNREADABLE_MESSAGE } from '../../../src/shared/world/types'
import { FRAME_RATE_EVENT } from '../../../src/renderer/src/components/World/worldOpen'

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
/** What the 2D map hands the ask box (A11Y Y2): a player of its own, never the viewer. */
const player2d = {
  asymmetricMatch: (p: unknown) => p !== null && typeof p === 'object' && typeof (p as { cameraRegion?: unknown }).cameraRegion === 'function' && !('resetView' in p),
  toString: () => 'the 2D map player',
  toAsymmetricMatcher: () => 'the 2D map player',
}
type Player = { apply: (a: unknown) => Promise<void>; play: (s: unknown[]) => Promise<void>; cancelActions: () => void; getSelection: () => string[]; cameraRegion: () => string[] }

async function mount(props: Partial<{ root: string; onClose: () => void; askSlot: (v: unknown) => React.ReactNode }> = {}) {
  const onClose = props.onClose ?? vi.fn()
  const utils = render(<WorldView root={props.root ?? '/repo'} onClose={onClose} askSlot={props.askSlot as never} />)
  await settle()
  return { ...utils, onClose }
}

beforeEach(() => {
  h.webgl = true
  h.software = false
  h.viewers.length = 0
  h.perf = null
  localStorage.clear()
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
})

describe('WorldView', () => {
  // WP4b F-R6: a person can stop the first mapping; they are back on the home, with nothing said against them.
  it("Stop mapping stops the compile of that folder and goes to the home; the stopped run's answer and push change nothing", async () => {
    for (const cancel of ['answers', 'throws'] as const) {
      const compile = deferred<Res<WorldDoc>>()
      const b = bridge({
        worldGet: vi.fn(async () => ok(null)),
        worldCompile: vi.fn(() => compile.promise),
        worldCompileCancel: vi.fn(async () => { if (cancel === 'throws') throw new Error('ipc'); return ok(true) }),
      })
      await mount()
      fireEvent.click(screen.getByTestId('world-mapping-cancel'))
      await settle()
      expect(b.api.worldCompileCancel).toHaveBeenCalledWith('/repo')
      expect(screen.getByTestId('world-home')).toBeInTheDocument()
      expect(screen.queryByTestId('world-mapping')).toBeNull()
      await act(async () => compile.resolve(fail('Lumopolis stopped mapping this project.')))
      await b.updated({ root: '/repo', projectKey: 'k', error: 'Lumopolis stopped mapping this project.' })
      await settle()
      expect(screen.getByTestId('world-home')).toBeInTheDocument()
      expect(screen.queryByTestId('world-empty')).toBeNull()
      expect(b.api.worldCompile).toHaveBeenCalledTimes(1)
      cleanup()
    }
  })

  // WP4b F-R9: a folder with nothing to map says why, and the person goes on from there.
  it('a folder with nothing to map: Choose another folder opens the picker on the home, once, and opens what is picked', async () => {
    const picked: WorldEntry = { key: 'k-p', source: { kind: 'folder', root: '/picked' }, title: 'picked', lastOpened: 1 } as WorldEntry
    const b = bridge({
      worldGet: vi.fn(async () => ok(null)),
      worldCompile: vi.fn(async (root: string) => (root === '/repo' ? fail(FOLDER_EMPTY_MESSAGE) : ok(minimal()))),
      worldOpenFolder: vi.fn(async () => ok(picked)),
    })
    await mount()
    await settle()
    expect(screen.getByTestId('world-error')).toHaveTextContent(FOLDER_EMPTY_MESSAGE)
    expect(screen.getByRole('alert').textContent).toBe(FOLDER_EMPTY_MESSAGE)
    expect(screen.queryByTestId('world-retry')).toBeNull()
    const lists = b.api.worldSourcesList.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Choose another folder' }))
    await settle()
    expect(b.api.worldOpenFolder).toHaveBeenCalledTimes(1)
    expect(b.api.worldCompile).toHaveBeenLastCalledWith('/picked')
    expect(b.api.worldSourcesList.mock.calls.length).toBeGreaterThan(lists)
    // Home again later: the picker does not open by itself a second time.
    fireEvent.change(screen.getByTestId('world-switcher'), { target: { value: '__home' } })
    await settle()
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    expect(b.api.worldOpenFolder).toHaveBeenCalledTimes(1)
  })

  it('a folder the picker refuses is said on the home; Back to Home goes home and opens no picker', async () => {
    const b = bridge({
      worldGet: vi.fn(async () => ok(null)),
      worldCompile: vi.fn(async () => fail(FOLDER_UNREADABLE_MESSAGE)),
      worldOpenFolder: vi.fn(async () => fail("Lumopolis can't map your home folder.")),
    })
    await mount()
    await settle()
    expect(screen.getByTestId('world-retry')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Choose another folder' }))
    await settle()
    expect(within(screen.getByTestId('world-home')).getByRole('alert')).toHaveTextContent("Lumopolis can't map your home folder.")
    cleanup()
    const c = bridge({ worldGet: vi.fn(async () => ok(null)), worldCompile: vi.fn(async () => fail(FOLDER_EMPTY_MESSAGE)), worldOpenFolder: vi.fn(async () => ok(null)) })
    await mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Home' }))
    await settle()
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    expect(c.api.worldOpenFolder).not.toHaveBeenCalled()
  })

  it('shows "Mapping your project…" with progress while worldGet returns null and progress events arrive', async () => {
    const compile = deferred<Res<WorldDoc>>()
    const b = bridge({ worldGet: vi.fn(async () => ok(null)), worldCompile: vi.fn(() => compile.promise) })
    await mount()
    expect(dialog()).toBeInTheDocument()
    expect(screen.getByText('Mapping your project…')).toBeInTheDocument()
    expect(screen.getByTestId('world-progress-text')).toHaveTextContent('Starting…')
    // A screen reader hears the stage as it starts, never each percent (A11Y Y5).
    const stage = (): HTMLElement => screen.getByTestId('world-progress-stage')
    expect(stage()).toHaveAttribute('role', 'status')
    expect(stage()).toHaveTextContent(/^Mapping started$/)
    expect(b.api.worldCompile).toHaveBeenCalledWith('/repo')

    b.progress({ root: '/repo', projectKey: 'k', stage: 'layout', pct: 40 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    expect(screen.getByTestId('world-progress-text')).toHaveTextContent('40% · layout')
    expect(stage()).toHaveTextContent(/^Mapping: layout$/)
    // A read's twentieth of a point moves the bar itself; the text and the reader keep the whole percent (fix round 3).
    b.progress({ root: '/repo', projectKey: 'k', stage: 'boundaries', pct: 12.35 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '12')
    expect(screen.getByRole('progressbar').firstElementChild).toHaveStyle({ width: '12.35%' })
    expect(screen.getByTestId('world-progress-text')).toHaveTextContent('12% · boundaries')
    b.progress({ root: '/repo', projectKey: 'k', stage: 'layout', pct: 40 })
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

  it('the 2D list ends above the ask bar, so none of it scrolls under the bar', async () => {
    h.webgl = false
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'world-ask-slot' ? 40 : 0
    })
    try {
      bridge()
      await mount({ askSlot: () => <span>ask</span> })
      const list = screen.getByTestId('world-fallback')
      expect(list.style.bottom).toBe('64px') // 40 + 16 + 8
      expect(list.style.top).toBe('0px')
    } finally {
      vi.restoreAllMocks()
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
    // The list is dark, so its scrollbar is drawn dark too, not as a light bar in a dark pane (F7).
    expect((list.style as CSSStyleDeclaration & { colorScheme?: string }).colorScheme).toBe('dark')
    expect(list.querySelector('[data-kind="building"][data-id="b1"]')).toHaveTextContent('Desktop app')
    expect(askSlot).toHaveBeenLastCalledWith(player2d, expect.objectContaining({ buildings: expect.any(Array) }), '/repo', expect.objectContaining({ onEscape: expect.any(Function), setBusy: expect.any(Function) }), null)
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
    fireEvent.click(list.querySelector('h3 > [data-kind="district"]') as Element)
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
    // A tour steps through the 2D map instead (Y2).
    fireEvent.change(screen.getByRole('combobox', { name: 'Tours' }), { target: { value: 't1' } })
    expect(screen.getByTestId('world-card')).toHaveTextContent('The app talks to its memory.Stop 1 of 1')
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
    expect(viewer().setRightReserve).toHaveBeenLastCalledWith(108, undefined)
    // Opened by choice in a narrow pane it covers the map: the fit keeps its chip-sized strip.
    fireEvent.click(screen.getByTestId('world-legend-toggle'))
    expect(screen.getByTestId('world-legend-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(viewer().setRightReserve).toHaveBeenLastCalledWith(108, undefined)
    narrow.unmount()
    bridge()
    render(<WorldView root="/repo" width={800} onClose={vi.fn()} />)
    await screen.findByTestId('world-legend')
    expect(screen.getByTestId('world-legend-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(viewer().setRightReserve).toHaveBeenLastCalledWith(244, 600)
    fireEvent.click(screen.getByTestId('world-legend-toggle'))
    expect(viewer().setRightReserve).toHaveBeenLastCalledWith(108, undefined)
    cleanup()
    // The pane at 1366x768 dragged to 640: opened by choice its strip is kept, and the camera is told from what
    // width (under three times the strip, so without it the camera dropped the strip and the city ran under it).
    bridge()
    render(<WorldView root="/repo" width={640} onClose={vi.fn()} />)
    await screen.findByTestId('world-legend')
    expect(screen.getByTestId('world-legend-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(viewer().setRightReserve).toHaveBeenLastCalledWith(108, undefined)
    fireEvent.click(screen.getByTestId('world-legend-toggle'))
    expect(viewer().setRightReserve).toHaveBeenLastCalledWith(244, 600)
  })

  it('takes its width from the width prop', async () => {
    const get = deferred<Res<WorldDoc | null>>()
    bridge({ worldGet: vi.fn(() => get.promise) })
    render(<WorldView root="/repo" width={512} onClose={vi.fn()} />)
    expect(dialog()).toHaveStyle({ width: '512px' })
  })

  it('caps a toolbar menu to the map under it, so a long one scrolls with every control in reach (A11Y Y8)', async () => {
    const stage = { h: 0 }
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'world-stage' ? stage.h : 0
    })
    try {
      bridge()
      const { unmount } = render(<WorldView root="/repo" width={400} onClose={vi.fn()} />)
      await screen.findByTestId('world-legend')
      fireEvent.click(screen.getByTestId('world-more'))
      // Unmeasured (no layout yet): no cap.
      expect(screen.getByTestId('world-more-menu').style.maxHeight).toBe('')
      expect(screen.getByTestId('world-more-menu').style.overflowY).toBe('auto')
      unmount()
      stage.h = 300
      bridge()
      render(<WorldView root="/repo" width={400} onClose={vi.fn()} askSlot={() => <input aria-label="ask" />} />)
      await screen.findByTestId('world-legend')
      fireEvent.click(screen.getByTestId('world-bookmarks'))
      expect(screen.getByTestId('world-bookmarks-menu').style.maxHeight).toBe('288px')
      expect(screen.getByTestId('world-bookmarks-menu').style.overflowY).toBe('auto')
      fireEvent.click(screen.getByTestId('world-more'))
      expect(screen.getByTestId('world-more-menu').style.maxHeight).toBe('288px')
      // The ask bar is capped to the map as well.
      expect(screen.getByTestId('world-ask-slot').style.maxHeight).toBe('calc(100% - 24px)')
      expect(screen.getByTestId('world-ask-slot').style.overflowY).toBe('auto')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it("folds its toolbar's secondary controls into More in a pane under the fold, judged in its own pixels", async () => {
    bridge()
    const { unmount } = render(<WorldView root="/repo" width={400} onClose={vi.fn()} />)
    await screen.findByTestId('world-legend')
    expect(screen.getByTestId('world-more')).toBeInTheDocument()
    expect(screen.queryByTestId('world-relayout')).toBeNull()
    unmount()
    bridge()
    render(<WorldView root="/repo" width={480} onClose={vi.fn()} />)
    await screen.findByTestId('world-legend')
    expect(screen.queryByTestId('world-more')).toBeNull()
    expect(screen.getByTestId('world-relayout')).toBeInTheDocument()
  })

  it('lies over the terminals where it is told to, at the left it is given', async () => {
    const get = deferred<Res<WorldDoc | null>>()
    bridge({ worldGet: vi.fn(() => get.promise) })
    render(<WorldView root="/repo" width={600} overlay={{ left: 240 }} onClose={vi.fn()} />)
    expect(dialog()).toHaveStyle({ position: 'absolute', left: '240px', width: '600px', zIndex: '30' })
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
        // No ask bar here: 586 - 176 = 410 for the card's reserve, 408 on a step, less 20.
        expect(screen.getByTestId('world-card').style.maxHeight).toBe('min(388px, calc(100% - 110px))')
        stage.w = 1000
        act(() => { for (const cb of seen) cb() })
        expect(screen.getByTestId('world-card').style.maxHeight).toBe('calc(100% - 110px)')
      } finally {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
      }
    })

    it('in a narrow pane gives the card the height its first heading and two items need, past the city\'s share but not its least room', async () => {
      const seen: Array<() => void> = []
      vi.stubGlobal('ResizeObserver', class {
        constructor(cb: () => void) { seen.push(cb) }
        observe(): void {}
        disconnect(): void {}
      })
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-stage' ? 416 : 0
      })
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-stage' ? 586 : 0
      })
      cardBox({ w: 330, h: 300 })
      const item = { bottom: 396 }
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const id = (this as HTMLElement).dataset.testid
        const [top, bottom] = id === 'world-card' ? [0, 300] : id === 'world-card-body' ? [12, 290] : [0, item.bottom]
        return { top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect
      })
      try {
        bridge()
        await mount()
        act(() => viewer().opts.renderCard(buildingCard(minimal(), 'b1')))
        // Its items end 396 px down: with the 24 px fade and the 10 px under the body it needs 430, more than the
        // share's 388, and the city keeps its least room (586 - 120 = 466, 464 on a step, less 20 = 444).
        expect(screen.getByTestId('world-card').style.maxHeight).toBe('min(430px, calc(100% - 110px))')
        item.bottom = 900
        act(() => { for (const cb of seen) cb() })
        expect(screen.getByTestId('world-card').style.maxHeight).toBe('min(444px, calc(100% - 110px))')
        // A card that needs less is held at the share, as before.
        item.bottom = 100
        act(() => { for (const cb of seen) cb() })
        expect(screen.getByTestId('world-card').style.maxHeight).toBe('min(388px, calc(100% - 110px))')
      } finally {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
      }
    })

    it('in a pane too narrow for both, puts the legend away while the card is open, and keeps a measured ask bar clear', async () => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-stage' ? 180 : 0
      })
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-stage' ? 900 : 0
      })
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-ask-slot' ? 160 : this.dataset.testid === 'world-card' ? 300 : 0
      })
      try {
        bridge()
        await mount({ askSlot: () => <input aria-label="ask" /> })
        // The ask bar's reserve: 160 + 16 + 8 = 184, and the legend's top gap of 12.
        expect(screen.getByTestId('world-legend').style.maxHeight).toBe('calc(100% - 196px)')
        act(() => viewer().opts.renderCard(buildingCard(minimal(), 'b1')))
        expect(screen.queryByTestId('world-legend')).toBeNull()
        fireEvent.click(screen.getByTestId('world-card-close'))
        expect(screen.getByTestId('world-legend')).toBeTruthy()
      } finally {
        vi.restoreAllMocks()
      }
    })

    it('in a wide pane stops the card above the ask bar, which an answer makes taller', async () => {
      const ask = { h: 40 }
      const seen: Array<() => void> = []
      vi.stubGlobal('ResizeObserver', class {
        constructor(cb: () => void) { seen.push(cb) }
        observe(): void {}
        disconnect(): void {}
      })
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-stage' ? 1000 : 0
      })
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-stage' ? 800 : 0
      })
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-ask-slot' ? ask.h : 0
      })
      try {
        bridge()
        await mount({ askSlot: () => <input aria-label="ask" /> })
        act(() => viewer().opts.renderCard(buildingCard(minimal(), 'b1')))
        // 800 - (40 + 16 + 8) - 12 - 8.
        expect(screen.getByTestId('world-card').style.maxHeight).toBe('min(716px, calc(100% - 110px))')
        ask.h = 300
        act(() => { for (const cb of seen) cb() })
        expect(screen.getByTestId('world-card').style.maxHeight).toBe('min(456px, calc(100% - 110px))')
      } finally {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
      }
    })

    it('puts the notice slot in the free area: beside the legend and an open card, and above the ask bar under a card in a narrow pane (fix round 1, I4)', async () => {
      const stage = { w: 1000, h: 800 }
      const seen: Array<() => void> = []
      vi.stubGlobal('ResizeObserver', class {
        constructor(cb: () => void) { seen.push(cb) }
        observe(): void {}
        disconnect(): void {}
      })
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-stage' ? stage.w : 0
      })
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-stage' ? stage.h : 0
      })
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'world-ask-slot' ? 40 : this.dataset.testid === 'world-card' ? 300 : 0
      })
      const slot = (): HTMLElement => {
        let el = screen.getByTestId('world-notice') as HTMLElement
        while (el.style.zIndex !== '4') el = el.parentElement as HTMLElement
        return el
      }
      try {
        bridge({ worldGet: vi.fn(async () => ok({ ...minimal(), filesCapped: 20000 })) })
        await mount({ askSlot: () => <input aria-label="ask" /> })
        // Wide, no card: across the top, between the left edge and the legend.
        expect(slot().style.top).toBe('12px')
        expect(slot().style.bottom).toBe('')
        const wide = parseFloat(slot().style.left)
        expect(wide).toBeGreaterThan(12)
        expect(wide).toBeLessThan(500)
        // A card opens: the slot moves right of it, still at the top.
        act(() => viewer().opts.renderCard(buildingCard(minimal(), 'b1')))
        expect(slot().style.top).toBe('12px')
        expect(parseFloat(slot().style.left)).toBeGreaterThan(wide)
        // A narrow pane has no room beside the card: the slot sits above the ask bar, under the card.
        stage.w = 416
        act(() => { for (const cb of seen) cb() })
        expect(slot().style.top).toBe('')
        expect(slot().style.bottom).toBe('64px')
        expect(slot().style.left).toBe('208px')
        expect(slot().style.maxWidth).toBe('392px')
      } finally {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
      }
    })

    it('centres the notice slot in the pane until the stage is measured', async () => {
      bridge({ worldGet: vi.fn(async () => ok({ ...minimal(), filesCapped: 20000 })) })
      await mount()
      let el = screen.getByTestId('world-notice') as HTMLElement
      while (el.style.zIndex !== '4') el = el.parentElement as HTMLElement
      expect(el.style.left).toBe('50%')
      expect(el.style.top).toBe('12px')
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

  it('another world or the home stops what the viewer is playing, so a tour cannot caption over the home (T4)', async () => {
    bridge()
    const { rerender, onClose } = await mount()
    fireEvent.change(screen.getByTestId('world-tours'), { target: { value: 't1' } })
    expect(viewer().play).toHaveBeenCalledTimes(1)
    expect(viewer().cancelActions).not.toHaveBeenCalled()
    rerender(<WorldView root="/other" onClose={onClose} />)
    await settle()
    expect(viewer().cancelActions).toHaveBeenCalledTimes(1)
    rerender(<WorldView root="" onClose={onClose} />)
    await settle()
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    expect(viewer().cancelActions).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('world-card')).toBeNull()
    // Without WebGL there is no viewer to stop: the home still comes up.
    cleanup()
    h.webgl = false
    bridge()
    const flat = await mount()
    flat.rerender(<WorldView root="" onClose={flat.onClose} />)
    await settle()
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
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

  // WP4b fix round 1, M6: CI's late answer changes test status only. Its push says so, and the viewer is told to restyle
  // the parts in place (statusOnly), so a tour or flight under way goes on and no "N changed" toast shows.
  it('a status-only push loads its world as statusOnly; the next ordinary push loads as before', async () => {
    const b = bridge()
    await mount()
    const v = viewer()
    const first = v.load.mock.calls[0][0]
    const tested = { ...minimal(), generatedAt: 2 }
    b.api.worldGet.mockResolvedValueOnce(ok(tested))
    await b.updated({ root: '/repo', projectKey: 'k', statusOnly: true })
    await settle()
    expect(v.load).toHaveBeenLastCalledWith(tested, { animateFrom: first, statusOnly: true })
    expect(v.cancelActions).not.toHaveBeenCalled()
    const grown = { ...minimal(), generatedAt: 3 }
    b.api.worldGet.mockResolvedValueOnce(ok(grown))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(v.load).toHaveBeenLastCalledWith(grown, { animateFrom: tested })
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

  it('a world of a capped folder walk says it shows only the first files, and the note goes when the world is not capped', async () => {
    const b = bridge({ worldGet: vi.fn(async () => ok({ ...minimal(), filesCapped: 20000 })) })
    await mount()
    expect(screen.getByTestId('world-notice')).toHaveTextContent('Showing the first 20,000 files in this folder.')
    b.api.worldGet.mockResolvedValueOnce(ok({ ...minimal(), generatedAt: 61 }))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(screen.queryByTestId('world-notice')).toBeNull()
  })

  it('the files note stays through a Re-layout of the same world, and counts files skipped for unreadable names', async () => {
    const doc = { ...minimal(), filesCapped: 1234, filesUnreadable: 2 }
    const note = "Showing the first 1,234 files in this folder. 2 files were skipped because their names can't be read."
    const run = deferred<Res<WorldDoc>>()
    bridge({ worldGet: vi.fn(async () => ok(doc)), worldRelayout: vi.fn(() => run.promise) })
    await mount()
    expect(screen.getByTestId('world-notice')).toHaveTextContent(note)
    fireEvent.click(screen.getByTestId('world-relayout'))
    fireEvent.click(screen.getByTestId('world-relayout-go'))
    expect(screen.getByTestId('world-notice')).toHaveTextContent('Re-laying out…')
    await act(async () => { run.resolve(ok({ ...doc, generatedAt: 70 })) })
    await settle()
    expect(screen.getByTestId('world-notice')).toHaveTextContent(note)
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
    // M3: main's answer is a whole sentence and shows alone; a call that threw shows the pane's own sentence for it.
    expect(screen.getByTestId('world-notice')).toHaveTextContent(/^host crashed$/)
    b.api.worldRelayout.mockRejectedValueOnce(new Error('ipc down'))
    fireEvent.click(screen.getByTestId('world-relayout'))
    fireEvent.click(screen.getByTestId('world-relayout-go'))
    await settle()
    expect(screen.getByTestId('world-notice')).toHaveTextContent(/^Lumopolis couldn't redo the layout\. Try again\.$/)
    expect(RELAYOUT_FAILED).toBe("Lumopolis couldn't redo the layout. Try again.")
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
      expect(probe().drawn()).toEqual({ layers: expect.objectContaining({ processes: false }), processShells: 0, conduits: 4, software: false })
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

    it('is not there before the world arrives, nor while another world loads, so it never answers for the world left', async () => {
      ;(window as any).termpolisTestFlags = { worldProbe: true }
      const get = deferred<Res<WorldDoc | null>>()
      const b = bridge({ worldGet: vi.fn(() => get.promise) })
      const { rerender, onClose } = await mount()
      expect(viewer()).toBeTruthy()
      expect(probe()).toBeUndefined()
      await act(async () => { get.resolve(ok(minimal())) })
      await settle()
      expect(probe().position('b1')).toEqual(minimal().layout.positions.b1)

      // Another folder: the viewer still holds the first world, paused under the loading screen. No probe answers for it.
      const next = deferred<Res<WorldDoc | null>>()
      b.api.worldGet.mockReturnValueOnce(next.promise)
      rerender(<WorldView root="/next" onClose={onClose} />)
      await settle()
      expect(probe()).toBeUndefined()
      const other: WorldDoc = { ...minimal(), projectKey: 'next', layout: { ...minimal().layout, positions: { b1: [7, 0, 7] } } }
      await act(async () => { next.resolve(ok(other)) })
      await settle()
      expect(viewer().load).toHaveBeenLastCalledWith(other)
      expect(probe().position('b1')).toEqual([7, 0, 7])
    })

    it('is not there without WebGL (no viewer)', async () => {
      ;(window as any).termpolisTestFlags = { worldProbe: true }
      h.webgl = false
      bridge()
      await mount()
      expect(probe()).toBeUndefined()
    })
  })

  describe('frame times (look plan Task 1)', () => {
    const perf = () => (window as any).__worldPerf
    const readout = () => screen.queryByTestId('world-frame-rate')
    const at = (p50: number, p95: number, frames = 120, tier = 'high') =>
      ({ tier, auto: true, frames, p50, p95, p99: p95, worst: p95, drops: 0, firstFrameMs: 40, resizeWorstMs: 0 })
    afterEach(() => {
      delete (window as any).termpolisTestFlags
      delete (window as any).__worldPerf
      vi.useRealTimers()
    })

    it('a staged first-frame slowdown reaches the viewer only under the probe flag, read from the window when asked', async () => {
      bridge()
      const a = await mount()
      expect(viewer().opts).not.toHaveProperty('firstFrameSlowdown')
      a.unmount()
      ;(window as any).termpolisTestFlags = { worldProbe: true }
      bridge()
      await mount()
      const slow = viewer().opts.firstFrameSlowdown as () => number
      expect(slow()).toBe(1)
      ;(window as any).__worldFirstFrameSlowdown = 2
      try {
        expect(slow()).toBe(2)
      } finally {
        delete (window as any).__worldFirstFrameSlowdown
      }
    })

    it('__worldPerf exists only with the probe flag', async () => {
      bridge()
      const a = await mount()
      expect(viewer()).toBeTruthy()
      expect(perf()).toBeUndefined()
      a.unmount()
      ;(window as any).termpolisTestFlags = { worldProbe: true }
      bridge()
      const { unmount } = await mount()
      perf().begin()
      expect(viewer().perfBegin).toHaveBeenCalledTimes(1)
      expect(perf().end()).toEqual({ frames: 3, p50: 16, p95: 18, p99: 18, worst: 18 })
      expect(viewer().perfEnd).toHaveBeenCalledTimes(1)
      unmount()
      expect(perf()).toBeUndefined()
      // A hook a later pane put up stays.
      const b = await mount()
      const other = { begin: () => undefined, end: () => null }
      ;(window as any).__worldPerf = other
      b.unmount()
      expect(perf()).toBe(other)
    })

    it('the readout shows fps, p95 and tier only when Show frame rate is on', async () => {
      h.perf = at(16.7, 20.46)
      bridge({ worldSettingsGet: vi.fn(async () => ok({ worldLabelling: true, showFrameRate: false })) })
      await mount()
      expect(readout()).toBeNull()
      // Settings flips it on: the open map shows it at once, from the viewer's frame times.
      act(() => { window.dispatchEvent(new CustomEvent(FRAME_RATE_EVENT, { detail: true })) })
      expect(readout()).toHaveTextContent('60 fps · 20.5 ms · high')
      expect(readout()).toHaveAttribute('aria-hidden', 'true')
      // It follows the frame times as they change.
      h.perf = at(11.4, 12, 600, 'low')
      await waitFor(() => expect(readout()).toHaveTextContent('88 fps · 12.0 ms · low'), { timeout: 2000 })
      // No counted frames yet: no number to show.
      h.perf = at(0, 0, 0, 'flat')
      await waitFor(() => expect(readout()).toHaveTextContent('-- fps · -- ms · flat'), { timeout: 2000 })
      // Anything but a literal true turns it off.
      act(() => { window.dispatchEvent(new CustomEvent(FRAME_RATE_EVENT, { detail: 'yes' })) })
      expect(readout()).toBeNull()
    })

    it('reads Show frame rate from the stored settings, and never shows over the 2D map', async () => {
      h.perf = at(16.7, 17)
      bridge({ worldSettingsGet: vi.fn(async () => ok({ worldLabelling: true, showFrameRate: true })) })
      const a = await mount()
      expect(readout()).toHaveTextContent('60 fps · 17.0 ms · high')
      a.unmount()
      h.webgl = false
      bridge({ worldSettingsGet: vi.fn(async () => ok({ worldLabelling: true, showFrameRate: true })) })
      await mount()
      expect(readout()).toBeNull()
    })

    it('reads only the frame times, and stops reading once the setting goes off or the pane closes', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      h.perf = at(16.7, 17)
      bridge({ worldSettingsGet: vi.fn(async () => ok({ worldLabelling: true, showFrameRate: true })) })
      const m = await mount()
      expect(readout()).toHaveTextContent('60 fps · 17.0 ms · high')
      // The light read: never the whole drawn() count.
      const drawnReads = viewer().drawn.mock.calls.length
      const reads = () => viewer().perf.mock.calls.length
      let before = reads()
      act(() => { vi.advanceTimersByTime(1500) })
      expect(reads()).toBeGreaterThanOrEqual(before + 3)
      expect(viewer().drawn.mock.calls.length).toBe(drawnReads)
      // Turned off in Settings: the timer stops.
      act(() => { window.dispatchEvent(new CustomEvent(FRAME_RATE_EVENT, { detail: false })) })
      expect(readout()).toBeNull()
      before = reads()
      act(() => { vi.advanceTimersByTime(5000) })
      expect(reads()).toBe(before)
      // On again, then the pane closes: the timer stops with it.
      act(() => { window.dispatchEvent(new CustomEvent(FRAME_RATE_EVENT, { detail: true })) })
      expect(readout()).toHaveTextContent('60 fps · 17.0 ms · high')
      const v = viewer()
      m.unmount()
      before = v.perf.mock.calls.length
      act(() => { vi.advanceTimersByTime(5000) })
      expect(v.perf.mock.calls.length).toBe(before)
    })

    it('does not read while the window is hidden or the map is still loading, and reads at once when it can be seen', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      let shownCb: ((s: boolean) => void) | null = null
      ;(window as any).windowControls = { onShown: vi.fn((cb: (s: boolean) => void) => { shownCb = cb; return () => undefined }) }
      try {
        h.perf = at(16.7, 17)
        const get = deferred<Res<WorldDoc | null>>()
        bridge({ worldGet: vi.fn(() => get.promise), worldSettingsGet: vi.fn(async () => ok({ worldLabelling: true, showFrameRate: true })) })
        await mount()
        // The loading screen covers the map: no reads, nothing shown.
        expect(viewer()).toBeTruthy()
        act(() => { vi.advanceTimersByTime(2000) })
        expect(viewer().perf).not.toHaveBeenCalled()
        expect(readout()).toBeNull()
        await act(async () => { get.resolve(ok(minimal())) })
        await settle()
        expect(readout()).toHaveTextContent('60 fps · 17.0 ms · high')
        // Minimised: the line goes and the timer stops.
        act(() => { (shownCb as (s: boolean) => void)(false) })
        expect(readout()).toBeNull()
        const before = viewer().perf.mock.calls.length
        act(() => { vi.advanceTimersByTime(5000) })
        expect(viewer().perf.mock.calls.length).toBe(before)
        // Shown again: read at once.
        act(() => { (shownCb as (s: boolean) => void)(true) })
        expect(viewer().perf.mock.calls.length).toBe(before + 1)
        expect(readout()).toHaveTextContent('60 fps · 17.0 ms · high')
      } finally {
        delete (window as any).windowControls
      }
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

  it('the home: a list main could not read says so, and a dialog up makes the toolbar inert until it closes (F-R12, F-R13)', async () => {
    bridge({ worldSourcesList: vi.fn(async () => fail('disk')) })
    await mount({ root: '' })
    expect(screen.getByTestId('world-list-error')).toHaveTextContent("Lumopolis couldn't load your recent worlds.")
    expect(screen.queryByText(/No worlds yet/)).toBeNull()
    const bar = screen.getByRole('toolbar')
    expect(bar.inert).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /^Open a git repository/ }))
    expect(bar.inert).toBe(true)
    fireEvent.click(within(screen.getByTestId('world-clone')).getByRole('button', { name: 'Cancel' }))
    expect(bar.inert).toBe(false)
  })

  it('a world picked in the switcher while Map this project is still on its way stays open (F-R4)', async () => {
    const entry: WorldEntry = { key: 'k-o', source: { kind: 'folder', root: '/other' }, title: 'other', lastOpened: 1 } as WorldEntry
    const mapped = deferred<Res<WorldEntry>>()
    const b = bridge({
      worldSourcesList: vi.fn(async () => ok([entry])),
      worldMapProject: vi.fn(() => mapped.promise),
      worldTouchSource: vi.fn(async () => ok(entry)),
      worldUpdateSource: vi.fn(async () => ok({ changed: false })),
    })
    await mount()
    const worlds = () => screen.getByRole('combobox', { name: 'Worlds' }) as HTMLSelectElement
    fireEvent.change(worlds(), { target: { value: '__home' } })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Map this project/ }))
    await settle()
    expect(b.api.worldMapProject).toHaveBeenCalledWith('/repo')
    fireEvent.change(worlds(), { target: { value: 'k-o' } })
    await settle()
    expect(screen.getByTestId('world-project')).toHaveTextContent('other')
    await act(async () => { mapped.resolve(ok({ key: 'k-r', source: { kind: 'project', root: '/repo' }, title: 'repo', lastOpened: 1 } as WorldEntry)) })
    await settle()
    expect(screen.getByTestId('world-project')).toHaveTextContent('other')
    expect(screen.getByTestId('world-project')).not.toHaveTextContent('repo')
  })

  it('Map this project that finishes while the clone dialog is up leaves the dialog and the pane where they are (F-R4)', async () => {
    const mapped = deferred<Res<WorldEntry>>()
    const b = bridge({ worldSourcesList: vi.fn(async () => ok([])), worldMapProject: vi.fn(() => mapped.promise) })
    await mount()
    fireEvent.change(screen.getByRole('combobox', { name: 'Worlds' }), { target: { value: '__home' } })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Map this project/ }))
    await settle()
    expect(b.api.worldMapProject).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Open a git repository/ }))
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://x.dev/a' } })
    await act(async () => { mapped.resolve(ok({ key: 'k-r', source: { kind: 'project', root: '/repo' }, title: 'repo', lastOpened: 1 } as WorldEntry)) })
    await settle()
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    expect(screen.getByLabelText('Repository URL')).toHaveValue('https://x.dev/a')
  })

  it('Map this project that finishes while the folder picker is up does not stop the folder chosen after it from opening (F-R4)', async () => {
    const mapped = deferred<Res<WorldEntry>>()
    const picked = deferred<Res<WorldEntry | null>>()
    const folder: WorldEntry = { key: 'k-p', source: { kind: 'folder', root: '/picked' }, title: 'picked', lastOpened: 1 } as WorldEntry
    bridge({
      worldSourcesList: vi.fn(async () => ok([])),
      worldMapProject: vi.fn(() => mapped.promise),
      worldOpenFolder: vi.fn(() => picked.promise),
      worldTouchSource: vi.fn(async () => ok(folder)),
    })
    await mount()
    fireEvent.change(screen.getByRole('combobox', { name: 'Worlds' }), { target: { value: '__home' } })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Map this project/ }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Open a folder/ }))
    await act(async () => { mapped.resolve(ok({ key: 'k-r', source: { kind: 'project', root: '/repo' }, title: 'repo', lastOpened: 1 } as WorldEntry)) })
    await settle()
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    await act(async () => { picked.resolve(ok(folder)) })
    await settle()
    expect(screen.queryByTestId('world-home')).toBeNull()
    expect(screen.getByTestId('world-project')).toHaveTextContent('picked')
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
    // Read out as it shows (A11Y Y5): the failure and its reason, not the Try again under them.
    expect(screen.getByRole('alert')).toHaveTextContent(/^Lumopolis could not map this project\.host down$/)
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
    // #65: a call that throws (no answer from main) shows fixed words, never the throw's own text; M3: "could not map this
    // project" says it, with Try again, and no second "couldn't do that" under it.
    expect(screen.getByTestId('world-empty')).toHaveTextContent('Lumopolis could not map this project.')
    expect(screen.getByTestId('world-empty')).not.toHaveTextContent(/boom|couldn't do that/)
    expect(screen.queryByTestId('world-error')).toBeNull()
    expect(screen.getByTestId('world-retry')).toBeInTheDocument()
    cleanup()
    bridge({ worldGet: vi.fn(() => Promise.reject('odd')) })
    await mount()
    expect(screen.getByTestId('world-empty')).toHaveTextContent('Lumopolis could not map this project.')
    expect(screen.queryByTestId('world-error')).toBeNull()
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

  // M3: one sentence of the pane's own for a confirmation that was not saved, by an answer or a throw; only a world a newer
  // Termpolis saved is named as the reason, since Try again would not help there.
  it('Confirm that fails, by an answer or a throw, says so in one sentence and keeps the doc', async () => {
    const worldAnnotate = vi.fn()
      .mockResolvedValueOnce(fail('No part with that id.'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(fail(savedByNewerNotice()))
    // Main refuses an annotate only over a world a newer Termpolis saved, which the pane already says in its files note.
    await open({ ...infer(), savedByNewer: true }, { worldAnnotate })
    expect(screen.getByTestId('world-notice').textContent).toBe(savedByNewerNotice())
    for (const want of [CONFIRM_FAILED, CONFIRM_FAILED, savedByNewerNotice()]) {
      fireEvent.click(screen.getByTestId('world-card').querySelector('[data-confirm="b1|0"]') as Element)
      await settle()
      expect(screen.getByTestId('world-notice').textContent).toBe(want)
    }
    expect(CONFIRM_FAILED).toBe("Lumopolis couldn't save your confirmation. Try again.")
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
    expect(screen.getByTestId('world-notice').textContent).toBe(NAMES_FAILED)
    save('y')
    await settle()
    expect(screen.getByTestId('world-notice').textContent).toBe(NAMES_FAILED)
    expect(NAMES_FAILED).toBe("Lumopolis couldn't save the service names. Try again.")
  })

  // U4: a Confirm or a service-names save that comes back after another world opened must not draw
  // its world, or its failure, over the world now open.
  describe('an answer from world:annotate after another world opened (U4)', () => {
    const loaded = (): unknown[] => h.viewers.flatMap((v) => v.load.mock.calls.map((c: unknown[]) => c[0]))
    const late = async (settleAnnotations: (confirm: ReturnType<typeof deferred<Res<WorldDoc>>>, names: ReturnType<typeof deferred<Res<WorldDoc>>>, returned: WorldDoc) => void) => {
      const doc = infer()
      const other = minimal()
      other.projectKey = 'other'
      const returned = infer()
      returned.generatedAt = doc.generatedAt + 1
      const confirm = deferred<Res<WorldDoc>>()
      const names = deferred<Res<WorldDoc>>()
      const worldAnnotate = vi.fn().mockReturnValueOnce(confirm.promise).mockReturnValueOnce(names.promise)
      bridge({ worldGet: vi.fn(async (root: string) => ok(root === '/next' ? other : doc)), worldAnnotate })
      const { rerender, onClose } = await mount()
      act(() => viewer().opts.renderCard(buildingCard(doc, 'b1')))
      fireEvent.click(screen.getByTestId('world-card').querySelector('[data-confirm="b1|0"]') as Element)
      fireEvent.click(screen.getByTestId('world-card').querySelector('[data-runtime-edit="b1"]') as Element)
      fireEvent.change(screen.getByLabelText(/Service names/), { target: { value: 'orders-api' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(worldAnnotate).toHaveBeenCalledTimes(2)
      rerender(<WorldView root="/next" onClose={onClose} />)
      await settle()
      expect(loaded()).toContain(other)
      await act(async () => { settleAnnotations(confirm, names, returned) })
      await settle()
      expect(loaded()).not.toContain(returned)
      expect(screen.queryByTestId('world-notice')).toBeNull()
    }

    it('a Confirm that worked and a save that threw leave the new world as it is', async () => {
      await late((confirm, names, returned) => { confirm.resolve(ok(returned)); names.reject(new Error('boom')) })
    })

    it('a Confirm that threw and a save that worked leave the new world as it is', async () => {
      await late((confirm, names, returned) => { confirm.reject(new Error('boom')); names.resolve(ok(returned)) })
    })

    it('answers that report a failure say nothing over the new world', async () => {
      await late((confirm, names) => { confirm.resolve(fail('No part with that id.')); names.resolve(fail('nope')) })
    })
  })

  it('Confirm on an inferred claim that reads as service names saves nothing and points to Edit', async () => {
    const doc = infer()
    doc.buildings[0].how[0].text = 'runtime:a,b'
    const worldAnnotate = vi.fn()
    await open(doc, { worldAnnotate })
    fireEvent.click(screen.getByTestId('world-card').querySelector('[data-confirm="b1|0"]') as Element)
    await settle()
    expect(worldAnnotate).not.toHaveBeenCalled()
    expect(screen.getByTestId('world-notice')).toHaveTextContent('Use Edit on the Service names line')
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
    expect(askSlot).toHaveBeenLastCalledWith(player2d, expect.anything(), '/repo', expect.anything(), null)
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

  const textOf = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent as string }
  /** The card's body, the tour's nav, what the pane says, and which items of the 2D map are lit. */
  const body = () => within(card() as HTMLElement).getByRole('region', { name: 'Details' })
  const said = () => screen.getByTestId('world-tour-said').textContent
  const lit = () => [...screen.getByTestId('world-fallback').querySelectorAll('[data-lit]')].map((e) => `${e.tagName.toLowerCase()}:${e.getAttribute('data-id')}`).sort()
  const tourDoc = (): WorldDoc => {
    const doc = minimal()
    doc.tours = [{ id: 't1', title: 'First', steps: [{ ids: ['b1'], caption: 'Start here.' }, { ids: ['gone'], caption: 'Not on the map.' }, { ids: ['d1'], caption: 'Then <this>.' }] }]
    // Another district, whose building a stop on d1 leaves unlit.
    doc.districts.push({ ...doc.districts[0], id: 'd2', name: 'Elsewhere' })
    doc.buildings.push({ ...doc.buildings[1], id: 'b9', districtId: 'd2', name: 'Far part' })
    return doc
  }

  it('a tour picked on the 2D map shows one stop at a time, its parts lit and the stop said, with or without a viewer (Y2, T5)', async () => {
    for (const gl of [true, false]) {
      cleanup()
      h.webgl = gl
      bridge({ worldGet: vi.fn(async () => ok(tourDoc())) })
      await mount()
      if (gl) fireEvent.click(screen.getByTestId('world-map2d'))
      fireEvent.change(screen.getByTestId('world-tours'), { target: { value: 't1' } })
      // The stop not on the map is skipped, as on the 3D map: two stops.
      expect(body().querySelector('.tour-caption')).toHaveTextContent('Start here.')
      // Named by the tour's title (A11Y fix round 1).
      const nav = within(card() as HTMLElement).getByRole('navigation', { name: 'Tour: First' })
      expect(nav).toHaveTextContent('Stop 1 of 2')
      expect(said()).toBe('Stop 1 of 2: Start here.')
      // Said once, by the pane: the card's body is no live region meanwhile.
      expect(body().getAttribute('aria-live')).toBe('off')
      expect(lit()).toEqual(['button:b1', 'rect:b1'])
      const back = within(nav).getByRole('button', { name: 'Back' })
      const next = within(nav).getByRole('button', { name: 'Next' })
      expect(back.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(back) // at the first stop: stays
      expect(said()).toBe('Stop 1 of 2: Start here.')
      fireEvent.click(next)
      expect(within(card() as HTMLElement).getByRole('navigation', { name: 'Tour: First' })).toHaveTextContent('Stop 2 of 2')
      // A district stop lights the district and its buildings; the caption is text, never markup.
      expect(body().querySelector('.tour-caption')?.textContent).toBe('Then <this>.')
      expect(said()).toBe('Stop 2 of 2: Then <this>.')
      expect(lit()).toEqual(['button:b1', 'button:b2', 'button:d1', 'polygon:d1', 'rect:b1', 'rect:b2'])
      expect(within(card() as HTMLElement).getByRole('button', { name: 'Next' }).getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(within(card() as HTMLElement).getByRole('button', { name: 'Next' })) // at the last stop: stays
      expect(said()).toBe('Stop 2 of 2: Then <this>.')
      fireEvent.click(within(card() as HTMLElement).getByRole('button', { name: 'Back' }))
      expect(said()).toBe('Stop 1 of 2: Start here.')
      fireEvent.click(within(card() as HTMLElement).getByRole('button', { name: 'End tour' }))
      expect(card()).toBeNull()
      expect(said()).toBe('')
      expect(lit()).toEqual([])
      if (gl) expect(viewer().play).not.toHaveBeenCalled()
    }
  })

  it('a 2D tour ends on Esc, the card close, a part, a district, leaving the 2D map and a world with other parts; one with no stop on the map shows nothing (Y2)', async () => {
    h.webgl = false
    let doc = tourDoc()
    const b = bridge({ worldGet: vi.fn(async () => ok(doc)) })
    await mount()
    const start = (): void => {
      fireEvent.change(screen.getByTestId('world-tours'), { target: { value: 't1' } })
      expect(said()).toBe('Stop 1 of 2: Start here.')
    }
    const ended = (): void => {
      expect(said()).toBe('')
      expect(lit()).toEqual([])
      expect(screen.queryByRole('navigation', { name: /^Tour/ })).toBeNull()
    }
    start(); esc(); ended(); expect(card()).toBeNull()
    start(); fireEvent.click(screen.getByRole('button', { name: 'Close details' })); ended(); expect(card()).toBeNull()
    start()
    fireEvent.click(screen.getByTestId('world-fallback').querySelector('button[data-id="b2"]') as Element)
    ended()
    expect(body().textContent).toBe(textOf(buildingCard(doc, 'b2')))
    expect(body().getAttribute('aria-live')).toBe('polite')
    start()
    fireEvent.click(screen.getByTestId('world-fallback').querySelector('button[data-kind="district"]') as Element)
    ended(); expect(card()).toBeNull()
    // A world with the same parts (a status change) keeps the tour; one with other parts ends it.
    start()
    doc = tourDoc()
    await b.updated({ root: '/repo', projectKey: doc.projectKey })
    await settle()
    expect(said()).toBe('Stop 1 of 2: Start here.')
    doc = tourDoc()
    doc.buildings.push({ ...doc.buildings[1], id: 'b3', name: 'New part' })
    await b.updated({ root: '/repo', projectKey: doc.projectKey })
    await settle()
    expect(screen.getByTestId('world-fallback').querySelector('button[data-id="b3"]')).not.toBeNull()
    ended(); expect(card()).toBeNull()
    // A tour whose stops are all off the map shows nothing.
    doc = tourDoc()
    doc.tours = [{ id: 't1', title: 'Gone', steps: [{ ids: ['gone'], caption: 'Nowhere.' }] }]
    await b.updated({ root: '/repo', projectKey: doc.projectKey })
    await settle()
    fireEvent.change(screen.getByTestId('world-tours'), { target: { value: 't1' } })
    expect(card()).toBeNull()
    expect(said()).toBe('')
  })

  it('a 2D tour ends when the 3D map comes back: switched to, the graphics restored, or WebGL found later (Y2)', async () => {
    bridge({ worldGet: vi.fn(async () => ok(tourDoc())) })
    await mount()
    fireEvent.click(screen.getByTestId('world-map2d'))
    fireEvent.change(screen.getByTestId('world-tours'), { target: { value: 't1' } })
    expect(said()).toBe('Stop 1 of 2: Start here.')
    fireEvent.click(screen.getByTestId('world-map2d'))
    expect(card()).toBeNull()
    expect(said()).toBe('')
    act(() => { viewer().opts.onGraphics('lost') })
    expect(screen.getByTestId('world-fallback')).toBeTruthy()
    fireEvent.change(screen.getByTestId('world-tours'), { target: { value: 't1' } })
    expect(said()).toBe('Stop 1 of 2: Start here.')
    act(() => { viewer().opts.onGraphics('restored') })
    expect(screen.queryByTestId('world-fallback')).toBeNull()
    expect(card()).toBeNull()
    expect(said()).toBe('')
    // WebGL found after the pane opened without it.
    cleanup()
    h.webgl = false
    bridge({ worldGet: vi.fn(async () => ok(tourDoc())) })
    await mount()
    fireEvent.change(screen.getByTestId('world-tours'), { target: { value: 't1' } })
    expect(said()).toBe('Stop 1 of 2: Start here.')
    h.webgl = true
    act(() => { window.dispatchEvent(new Event('focus')) })
    await settle()
    expect(screen.queryByTestId('world-fallback')).toBeNull()
    expect(card()).toBeNull()
    expect(said()).toBe('')
  })

  it('the 3D map tour stop is said once by the pane, the card body quiet meanwhile; the 2D map does not say it (T5)', async () => {
    bridge()
    await mount()
    expect(said()).toBe('')
    act(() => { viewer().opts.renderCard('<p class="tour-caption">A.</p>') })
    act(() => { viewer().opts.onTourStop({ n: 1, of: 3, caption: 'A.' }) })
    expect(said()).toBe('Stop 1 of 3: A.')
    expect(body().getAttribute('aria-live')).toBe('off')
    act(() => { viewer().opts.onTourStop(null) })
    expect(said()).toBe('')
    expect(body().getAttribute('aria-live')).toBe('polite')
    act(() => { viewer().opts.onTourStop({ n: 2, of: 3, caption: 'B.' }) })
    fireEvent.click(screen.getByTestId('world-map2d'))
    expect(said()).toBe('')
  })

  it('a 3D tour stop is forgotten when the 2D map takes over, so graphics that come back never say a stale stop (A11Y fix round 1)', async () => {
    bridge()
    await mount()
    act(() => { viewer().opts.onTourStop({ n: 2, of: 3, caption: 'B.' }) })
    expect(said()).toBe('Stop 2 of 3: B.')
    act(() => { viewer().opts.onGraphics('lost') })
    expect(said()).toBe('')
    act(() => { viewer().opts.onGraphics('restored') })
    expect(said()).toBe('')
  })

  it('the ask box plays an answer on the 2D map: cards, lit parts, a tour, a reset; a question carries the open part and the whole map (Y2)', async () => {
    h.webgl = false
    // The next project is still being mapped: no world yet.
    bridge({ worldGet: vi.fn(async (root: string) => ok(root === '/repo' ? minimal() : null)), worldCompile: vi.fn(() => new Promise(() => undefined)) })
    const askSlot = vi.fn((_v: unknown) => <span>ask</span>)
    const { rerender, onClose } = await mount({ askSlot })
    // Before the world comes there is nothing to play on.
    expect(askSlot.mock.calls[0]).toEqual([null, null, null, expect.anything(), null])
    const p = askSlot.mock.lastCall?.[0] as Player
    expect(p).toEqual(player2d)
    expect(p.cameraRegion()).toEqual(['b1', 'b2', 'x1', 'e1'])
    expect(p.getSelection()).toEqual([])
    await act(async () => { await p.apply({ type: 'openCard', id: 'b1' }) })
    expect(body().textContent).toBe(textOf(buildingCard(minimal(), 'b1')))
    expect(p.getSelection()).toEqual(['b1'])
    p.cancelActions() // no tour under way: the card stays
    expect(card()).not.toBeNull()
    esc()
    expect(p.getSelection()).toEqual([]) // the card closed: nothing is selected
    await act(async () => { await p.apply({ type: 'highlight', ids: ['b2', 'nope'] }) })
    expect(lit()).toEqual(['button:b2', 'rect:b2'])
    await act(async () => { await p.apply({ type: 'focus', ids: ['b1'] }) })
    expect(lit()).toEqual(['button:b1', 'rect:b1'])
    await act(async () => { await p.apply({ type: 'flow', edgeIds: ['e1'] }) })
    expect(lit()).toEqual(['button:e1', 'line:e1'])
    await act(async () => { await p.apply({ type: 'openCard', id: 'tech:ipc' }) })
    expect(body()).toHaveTextContent('Inter-process communication')
    expect(lit()).toEqual(['button:e1', 'line:e1'])
    expect(p.getSelection()).toEqual([])
    await act(async () => { await p.apply({ type: 'reset' }) })
    expect(card()).toBeNull()
    expect(lit()).toEqual([])
    // A tour plays as the 2D map's own, and the first lit item of the list is scrolled into view.
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    try {
      await act(async () => { await p.play([{ type: 'tour', steps: [{ ids: ['b2'], caption: 'Asked.' }] }]) })
      expect(said()).toBe('Stop 1 of 1: Asked.')
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
      expect(scroll.mock.contexts.at(-1)).toBe(screen.getByTestId('world-fallback').querySelector('button[data-id="b2"]'))
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
    expect(p.getSelection()).toEqual([])
    // A highlight ends the tour, and what it lights stays lit.
    await act(async () => { await p.apply({ type: 'highlight', ids: ['b1'] }) })
    expect(card()).toBeNull()
    expect(said()).toBe('')
    expect(lit()).toEqual(['button:b1', 'rect:b1'])
    // A new question stops a tour under way.
    await act(async () => { await p.play([{ type: 'tour', steps: [{ ids: ['b2'], caption: 'Asked.' }] }]) })
    act(() => { p.cancelActions() })
    expect(card()).toBeNull()
    expect(lit()).toEqual([])
    // Fog and a drafted proposal have nothing to show on the 2D map.
    await act(async () => { await p.apply({ type: 'openCard', id: 'b1' }) })
    await act(async () => { await p.play([{ type: 'fog', ids: ['b1'] }, { type: 'draftProposal', proposal: {} }]) })
    expect(body().textContent).toBe(textOf(buildingCard(minimal(), 'b1')))
    // One player for the pane's life.
    expect(askSlot.mock.lastCall?.[0]).toBe(p)
    // A project with no world yet: a late answer to the last one does nothing.
    rerender(<WorldView root="/next" onClose={onClose} askSlot={askSlot as never} />)
    await settle()
    expect(screen.queryByTestId('world-fallback')).toBeNull()
    await act(async () => { await p.apply({ type: 'openCard', id: 'b1' }) })
    expect(card()).toBeNull()
  })

  it('switching to the 2D map stops what the viewer is playing, so a tour cannot caption over the map (T3)', async () => {
    bridge()
    await mount()
    fireEvent.change(screen.getByTestId('world-tours'), { target: { value: 't1' } })
    expect(viewer().play).toHaveBeenCalledTimes(1)
    expect(viewer().cancelActions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('world-map2d'))
    expect(viewer().cancelActions).toHaveBeenCalledTimes(1)
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

  // WP5 fix I5: the world comes back with the older keys of its root; their saved views are copied under the new key.
  it('a world opened under a new key shows the views saved under its older keys, and leaves them where they were', async () => {
    const oldKey = 'termpolis.world.bookmarks.k-old'
    localStorage.setItem(oldKey, JSON.stringify([{ name: 'From before', camera: cam, selection: ['b1'] }]))
    bridge({ worldGet: vi.fn(async () => ok({ ...minimal(), aliasKeys: ['k-old'] })) })
    await mount()
    openMenu()
    expect(screen.getAllByTestId('world-bookmark-go').map((x) => x.textContent)).toEqual(['From before'])
    expect(JSON.parse(localStorage.getItem(keyOf()) as string)).toEqual([{ name: 'From before', camera: cam, selection: ['b1'] }])
    expect(localStorage.getItem(oldKey)).not.toBeNull()
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

  it('a drag, a click, the wheel, Esc, another selection or the 2D map during the flight leaves the camera where it is', async () => {
    localStorage.setItem(keyOf(), JSON.stringify([{ name: 'Open b1', camera: cam, selection: ['b1'] }]))
    bridge()
    await mount()
    const host = screen.getByTestId('world-canvas-host')
    const cut: Array<[string, () => void]> = [
      ['pointerdown', () => fireEvent.pointerDown(host)],
      ['wheel', () => fireEvent.wheel(host)],
      ['Esc', () => esc()],
      ['another pick', () => viewer().getSelection.mockReturnValue(['b2'])],
      // Last: the 2D map has no camera to restore into.
      ['the 2D map', () => fireEvent.click(screen.getByTestId('world-map2d'))],
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

  it('a capped world\'s note gives the slot to the export toast and comes back when the toast is dismissed', async () => {
    bridge(exportApi({ worldGet: vi.fn(async () => ok({ ...minimal(), filesCapped: 20000 })) }))
    await mountWith()
    expect(screen.getByTestId('world-notice')).toHaveTextContent('Showing the first 20,000 files in this folder.')
    openMenu('world')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }))
    await settle()
    expect(screen.getByTestId('world-notice')).toHaveTextContent('Exported repo.html (37 MB)')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await settle()
    expect(screen.getByTestId('world-notice')).toHaveTextContent('Showing the first 20,000 files in this folder.')
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
    // The map draws only while something moves: a frame is asked for, so there is one to read.
    expect(viewer().requestFrame).toHaveBeenCalledTimes(1)
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
    expect(btn).not.toHaveAttribute('aria-haspopup')
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
    // From elsewhere in the pane (the map), too: the menu shuts and the camera stays.
    fireEvent.click(btn)
    esc(screen.getByTestId('world-canvas-host'))
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
    expect(viewer().resetView).not.toHaveBeenCalled()
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

  it('Re-layout is greyed while Export or Documentation is up, so its question never opens beside them (A11Y fix round 1, I1)', async () => {
    bridge(exportApi())
    const m = await mountWith()
    expect(screen.getByTestId('world-relayout')).toBeEnabled()
    for (const kind of ['world', 'document'] as const) {
      await m.again({ exportRequest: { kind, seq: kind === 'world' ? 1 : 2 } })
      expect(screen.getByTestId(`world-${kind === 'world' ? 'export' : 'document'}-dialog`)).toBeInTheDocument()
      expect(screen.getByTestId('world-relayout')).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.getByTestId('world-relayout')).toBeEnabled()
    }
  })

  it('a palette ask while the re-layout question is up is dropped: two dialogs of the pane are never up together (A11Y fix round 1, I1)', async () => {
    bridge(exportApi())
    const m = await mountWith()
    fireEvent.click(screen.getByTestId('world-relayout'))
    expect(screen.getByRole('alertdialog', { name: 'Confirm re-layout' })).toBeInTheDocument()
    await m.again({ exportRequest: { kind: 'world', seq: 1 } })
    expect(screen.queryByTestId('world-export-dialog')).toBeNull()
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
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

  it('a first map from the listing offers no Export, and an export asked for waits for the complete world (fix round 1, I1)', async () => {
    const first = { ...minimal(), provisional: true }
    const b = bridge(exportApi({ worldGet: vi.fn(async () => ok(first)) }))
    const m = await mountWith()
    expect(viewer().load).toHaveBeenLastCalledWith(first)
    expect(screen.queryByTestId('world-export')).toBeNull()
    await m.again({ exportRequest: { kind: 'world', seq: 1 } })
    expect(screen.queryByTestId('world-export-dialog')).toBeNull()
    expect(b.api.worldExportInfo).not.toHaveBeenCalled()
    b.api.worldGet.mockResolvedValue(ok(minimal()))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(screen.getByTestId('world-export')).toBeInTheDocument()
    expect(screen.getByTestId('world-export-dialog')).toBeInTheDocument()
  })

  it('a pane opened on a first map hears how its run ended: a failure shows the error and Try again (fix round 1, I2)', async () => {
    const first = { ...minimal(), provisional: true }
    const b = bridge(exportApi({ worldGet: vi.fn(async () => ok(first)) }))
    await mountWith()
    expect(b.api.worldCompile).not.toHaveBeenCalled()
    b.api.worldGet.mockResolvedValue(ok(null))
    // Another world's failure is not ours.
    await b.updated({ root: '/other', projectKey: 'other', error: 'disk full' })
    await settle()
    expect(screen.queryByTestId('world-error')).toBeNull()
    await b.updated({ root: '/repo', projectKey: 'k', error: 'disk full' })
    await settle()
    expect(screen.getByTestId('world-error')).toHaveTextContent('disk full')
    expect(screen.queryByTestId('world-export')).toBeNull()
    // Try again maps the project afresh.
    b.api.worldCompile.mockResolvedValue(ok(minimal()))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(b.api.worldCompile).toHaveBeenCalledWith('/repo')
    expect(screen.queryByTestId('world-error')).toBeNull()
    expect(screen.getByTestId('world-export')).toBeInTheDocument()
  })

  it('a failure pushed while a saved world is shown, or after one was saved, changes nothing (fix round 1, I2)', async () => {
    const saved = minimal()
    const b = bridge(exportApi({ worldGet: vi.fn(async () => ok(saved)) }))
    await mountWith()
    await b.updated({ root: '/repo', projectKey: 'k', error: 'store said no' })
    await settle()
    expect(screen.queryByTestId('world-error')).toBeNull()
    cleanup()
    // On a first map, but the world was saved by the time the pane asks: the pane shows it.
    const first = { ...minimal(), provisional: true }
    const c = bridge(exportApi({ worldGet: vi.fn(async () => ok(first)) }))
    await mountWith()
    c.api.worldGet.mockResolvedValue(ok(saved))
    await c.updated({ root: '/repo', projectKey: 'k', error: 'late' })
    await settle()
    expect(screen.queryByTestId('world-error')).toBeNull()
    expect(screen.getByTestId('world-export')).toBeInTheDocument()
    cleanup()
    // A get that fails as the failure lands still shows the failure.
    const d = bridge(exportApi({ worldGet: vi.fn(async () => ok(first)) }))
    await mountWith()
    d.api.worldGet.mockResolvedValue(fail('host down'))
    await d.updated({ root: '/repo', projectKey: 'k', error: 'compile stopped' })
    await settle()
    expect(screen.getByTestId('world-error')).toHaveTextContent('compile stopped')
  })

  it('a first map drawn while this pane compiles goes when the compile fails or throws (fix round 1, I2)', async () => {
    for (const end of ['fail', 'throw'] as const) {
      const compile = deferred<Res<WorldDoc>>()
      const b = bridge(exportApi({ worldGet: vi.fn(async () => ok(null)), worldCompile: vi.fn(() => compile.promise) }))
      const m = await mountWith()
      b.api.worldGet.mockResolvedValue(ok({ ...minimal(), provisional: true }))
      await b.updated({ root: '/repo', projectKey: 'k' })
      await settle()
      expect(screen.getByTestId('world-notice')).toBeInTheDocument()
      await act(async () => { if (end === 'throw') compile.reject(new Error('down')); else compile.resolve(fail('no source files found')) })
      await settle()
      if (end === 'throw') expect(screen.getByTestId('world-empty')).toHaveTextContent(/^Lumopolis could not map this project\.Try again$/)
      else expect(screen.getByTestId('world-error')).toHaveTextContent('no source files found')
      expect(screen.queryByTestId('world-notice')).toBeNull()
      m.unmount()
    }
  })

  it('a failure pushed for an earlier run changes nothing once Try again has started the next (fix round 2, m2)', async () => {
    const compiles = [deferred<Res<WorldDoc>>(), deferred<Res<WorldDoc>>()]
    const b = bridge(exportApi({ worldGet: vi.fn(async (): Promise<Res<WorldDoc | null>> => ok(null)), worldCompile: vi.fn(() => compiles[b.api.worldCompile.mock.calls.length - 1].promise) }))
    await mountWith()
    await act(async () => { compiles[0].resolve(fail('no source files found')) })
    await settle()
    expect(screen.getByTestId('world-error')).toHaveTextContent('no source files found')
    // The failed run's own push arrives, and its read is slow.
    const late = deferred<Res<WorldDoc | null>>()
    b.api.worldGet.mockReturnValueOnce(late.promise)
    await b.updated({ root: '/repo', projectKey: 'k', error: 'no source files found' })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(b.api.worldCompile).toHaveBeenCalledTimes(2)
    // The next run draws its first map; then the earlier read lands with it.
    const first = { ...minimal(), provisional: true }
    b.api.worldGet.mockResolvedValue(ok(first))
    await b.updated({ root: '/repo', projectKey: 'k' })
    await settle()
    expect(screen.getByTestId('world-notice')).toBeInTheDocument()
    await act(async () => { late.resolve(ok(first)) })
    await settle()
    expect(screen.queryByTestId('world-error')).toBeNull()
    expect(screen.getByTestId('world-notice')).toBeInTheDocument()
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

describe('WorldView on a big monitor', () => {
  const windowSize = (w: number, h: number): void => {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true })
  }
  afterEach(() => {
    windowSize(1024, 768)
    vi.restoreAllMocks()
  })

  it('draws its panels and labels bigger, and hands the viewer reserves in the map pixels', async () => {
    windowSize(3840, 2160)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'world-card' ? 330 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'world-card' ? 225 : this.dataset.testid === 'world-ask-slot' ? 40 : 0
    })
    bridge()
    render(<WorldView root="/repo" width={1600} onClose={vi.fn()} askSlot={() => <input aria-label="ask" />} />)
    await screen.findByTestId('world-legend')
    const v = viewer()
    expect(v.setLabelScale).toHaveBeenLastCalledWith(1.5)
    expect(screen.getByTestId('world-legend').style.zoom).toBe('1.5')
    expect(screen.getByRole('toolbar').style.zoom).toBe('1.5')
    expect(screen.getByTestId('world-ask-slot').style.zoom).toBe('1.5')
    expect(screen.getByTestId('world-canvas-host').style.zoom).toBe('')
    // 1600 / 1.5 = 1067 of the legend's own pixels: wide, so it opens and its strip is kept, zoomed.
    expect(screen.getByTestId('world-legend-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(v.setRightReserve).toHaveBeenLastCalledWith(366, 900)
    // The ask bar: (40 + 16 + 8) x 1.5.
    expect(v.setBottomReserve).toHaveBeenLastCalledWith(96)
    act(() => v.opts.renderCard(buildingCard(minimal(), 'b1')))
    expect(screen.getByTestId('world-card').style.zoom).toBe('1.5')
    expect(v.setCardReserve).toHaveBeenLastCalledWith(528, 372)
    fireEvent.click(screen.getByTestId('world-relayout'))
    expect(screen.getByTestId('world-relayout-confirm').style.zoom).toBe('1.5')
    act(() => { windowSize(1280, 800); window.dispatchEvent(new Event('resize')) })
    expect(v.setLabelScale).toHaveBeenLastCalledWith(1)
    expect(screen.getByTestId('world-legend').style.zoom).toBe('')
  })

  it('caps the card in its own pixels', async () => {
    windowSize(3840, 2160)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'world-stage' ? 480 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'world-stage' ? 879 : 0
    })
    bridge()
    render(<WorldView root="/repo" width={912} onClose={vi.fn()} />)
    await screen.findByTestId('world-legend')
    act(() => viewer().opts.renderCard(buildingCard(minimal(), 'b1')))
    // Scale 1.2 (912 / 760): the stage is 400 x 732.5 of the card's pixels: 732.5 less 30% is 512.5, 512 on a step, less 20.
    expect(screen.getByTestId('world-card').style.maxHeight).toBe('min(492px, calc(100% - 110px))')
  })

  it('tells the viewer which panels are over the map after every render, so one that moved is measured again', async () => {
    bridge()
    await mount()
    const v = viewer()
    const last = (): HTMLElement[] => v.setPanels.mock.calls[v.setPanels.mock.calls.length - 1][0]
    expect(last()).toContain(screen.getByTestId('world-legend'))
    expect(last()).not.toContain(screen.getByTestId('world-canvas-host'))
    const calls = v.setPanels.mock.calls.length
    const before = last()
    fireEvent.click(screen.getByTestId('world-legend-toggle')) // a render, the same panels: handed over again
    expect(v.setPanels.mock.calls.length).toBeGreaterThan(calls)
    expect(last()).toEqual(before)
    act(() => v.opts.renderCard(buildingCard(minimal(), 'b1')))
    expect(last()).toContain(screen.getByTestId('world-card'))
    // A toolbar popup hangs below the toolbar, outside its box: open, it is a panel of its own, so no name is
    // drawn under it (the More menu once lay over a district's name); shut, it is gone from the panels again.
    fireEvent.click(screen.getByTestId('world-export'))
    await waitFor(() => expect(last()).toContain(screen.getByTestId('world-export-menu')))
    fireEvent.click(screen.getByTestId('world-export'))
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
    await waitFor(() => expect(last().every((el) => el.isConnected)).toBe(true))
    // A change in the map's own labels (under the host) hands nothing over.
    const calls2 = v.setPanels.mock.calls.length
    screen.getByTestId('world-canvas-host').appendChild(document.createElement('div'))
    await new Promise((r) => setTimeout(r, 0))
    expect(v.setPanels.mock.calls.length).toBe(calls2)
  })
})

describe('WorldView WP2: lost graphics, WebGL found later, the keyboard on the 2D map, a hidden window', () => {
  const notice = () => screen.queryByTestId('world-notice')

  it('with no WebGL at all the card over the 2D map is solid (the page is composited in software); a GPU user who picks 2D keeps glass', async () => {
    h.webgl = false
    bridge()
    await mount()
    fireEvent.click(screen.getByTestId('world-fallback').querySelector('[data-id="b1"]') as Element)
    expect(screen.getByTestId('world-card')).toHaveAttribute('data-solid', '')
    cleanup()
    h.webgl = true
    bridge()
    await mount()
    fireEvent.click(screen.getByTestId('world-map2d'))
    fireEvent.click(screen.getByTestId('world-fallback').querySelector('[data-id="b1"]') as Element)
    expect(screen.getByTestId('world-card')).not.toHaveAttribute('data-solid')
  })

  it('a map drawn in software gets a solid card and legend, as the viewer says when made and when its graphics come back', async () => {
    h.software = true
    bridge()
    await mount()
    const v = viewer()
    act(() => v.opts.renderCard('<h3>Store</h3>'))
    expect(screen.getByTestId('world-card')).toHaveAttribute('data-solid', '')
    expect(screen.getByTestId('world-legend').style.backdropFilter).toBe('none')
    // The context comes back on a GPU: glass again.
    act(() => { v.opts.onGraphics('lost') })
    h.software = false
    act(() => { v.opts.onGraphics('restored') })
    act(() => v.opts.renderCard('<h3>Store</h3>'))
    expect(screen.getByTestId('world-card')).not.toHaveAttribute('data-solid')
    expect(screen.getByTestId('world-legend').style.backdropFilter).toBe('blur(10px)')
  })

  it('a 3D map that never draws a frame says so and shows the 2D map for good; the canvas host is the theme background (look spec 5.3)', async () => {
    bridge()
    await mount()
    const v = viewer()
    // Before any frame paints, the host shows the theme's background, never a white or blank box.
    expect(screen.getByTestId('world-canvas-host').style.background).toBe('var(--world-bg, #03050a)')
    act(() => { v.opts.onGraphics('watchdog') })
    await settle()
    expect(notice()).toHaveTextContent(GRAPHICS_WATCHDOG)
    expect(GRAPHICS_WATCHDOG).toBe('Lumopolis switched to the 2D map because this graphics card could not draw the 3D view.')
    expect(v.dispose).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('world-canvas-host')).toBeNull()
    expect(screen.getByTestId('world-fallback').querySelector('[data-id="b1"]')).not.toBeNull()
  })

  it('a first loss shows a notice until the graphics come back; a second shows the 2D map for good', async () => {
    bridge()
    const askSlot = vi.fn(() => <span>ask</span>)
    await mount({ askSlot })
    const v = viewer()
    expect(v.setTitle).toHaveBeenLastCalledWith('repo') // the canvas's text alternative names the project
    act(() => { v.opts.onGraphics('restored') }) // no notice up: nothing to take down
    expect(notice()).toBeNull()
    act(() => { v.opts.onGraphics('lost') })
    expect(notice()).toHaveTextContent(GRAPHICS_LOST)
    // While the graphics are away the 2D map shows in the 3D map's place, so a context that never comes back never
    // leaves a blank map: the 3D map is hidden and paused, the legend gone, and the ask works on the 2D map.
    expect(screen.getByTestId('world-fallback').querySelector('[data-id="b1"]')).not.toBeNull()
    expect(screen.getByTestId('world-canvas-host').style.visibility).toBe('hidden')
    expect(v.setPaused).toHaveBeenLastCalledWith(true)
    expect(askSlot).toHaveBeenLastCalledWith(player2d, expect.anything(), '/repo', expect.anything(), null)
    act(() => { v.opts.onGraphics('restored') })
    expect(notice()).toBeNull()
    // Back: the 3D map shows and draws again, without the 2D switch ever being touched.
    expect(screen.queryByTestId('world-fallback')).toBeNull()
    expect(screen.getByTestId('world-canvas-host').style.visibility).toBe('visible')
    expect(v.setPaused).toHaveBeenLastCalledWith(false)
    expect(screen.getByTestId('world-map2d')).toHaveAttribute('aria-checked', 'false')
    act(() => { v.opts.onGraphics('lost') })
    act(() => { v.opts.onGraphics('flat') })
    await settle()
    expect(notice()).toHaveTextContent(GRAPHICS_FLAT)
    expect(v.dispose).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('world-canvas-host')).toBeNull()
    expect(screen.getByTestId('world-fallback').querySelector('[data-id="b1"]')).not.toBeNull()
    expect(askSlot).toHaveBeenLastCalledWith(player2d, expect.anything(), '/repo', expect.anything(), null)
    // WebGL is not looked for again: these graphics are not trusted to stay.
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(h.viewers).toHaveLength(1)
  })

  it('a loss stops what plays and takes the 3D card; a 2D card opened meanwhile goes on the restore; the switch shows the 2D map (M2, N2)', async () => {
    bridge()
    await mount()
    const v = viewer()
    const sw = () => screen.getByTestId('world-map2d')
    act(() => v.opts.renderCard('<p class="tour-caption">The app talks</p>'))
    expect(screen.getByTestId('world-card')).toHaveTextContent('The app talks')
    act(() => { v.opts.onGraphics('lost') })
    expect(v.cancelActions).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('world-card')).toBeNull()
    // the 2D map is on show: the switch says so, and waits for the graphics
    expect(sw()).toHaveAttribute('aria-checked', 'true')
    expect(sw()).toBeDisabled()
    fireEvent.click(screen.getByTestId('world-fallback').querySelector('[data-id="b1"]') as Element)
    expect(screen.getByTestId('world-card')).toBeInTheDocument()
    act(() => { v.opts.onGraphics('restored') })
    expect(screen.queryByTestId('world-card')).toBeNull()
    expect(sw()).toHaveAttribute('aria-checked', 'false')
    expect(sw()).not.toBeDisabled()
    expect(localStorage.getItem('termpolis.world.map2d')).toBeNull() // the switch's own setting is untouched
  })

  it('with the 2D switch on, a loss and restore keep the 2D card (no 3D map was on show)', async () => {
    bridge()
    await mount()
    const v = viewer()
    fireEvent.click(screen.getByTestId('world-map2d'))
    fireEvent.click(screen.getByTestId('world-fallback').querySelector('[data-id="b1"]') as Element)
    expect(screen.getByTestId('world-card')).toBeInTheDocument()
    v.cancelActions.mockClear() // the switch to 2D cancelled once already (T3); the loss's own cancel is counted alone
    act(() => { v.opts.onGraphics('lost') })
    expect(v.cancelActions).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('world-card')).toBeInTheDocument()
    expect(screen.getByTestId('world-map2d')).toHaveAttribute('aria-checked', 'true')
    act(() => { v.opts.onGraphics('restored') })
    expect(screen.getByTestId('world-card')).toBeInTheDocument()
    expect(screen.getByTestId('world-map2d')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('world-map2d')).not.toBeDisabled()
  })

  it('WebGL missing at the start is looked for again when the window comes back, and the 3D map then loads the world', async () => {
    h.webgl = false
    bridge()
    await mount()
    expect(screen.getByTestId('world-fallback')).toBeInTheDocument()
    act(() => { window.dispatchEvent(new Event('focus')) }) // still missing
    expect(h.viewers).toHaveLength(0)
    h.webgl = true
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) }) // hidden: not looked for
    expect(h.viewers).toHaveLength(0)
    hidden.mockReturnValue('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()
    hidden.mockRestore()
    expect(h.viewers).toHaveLength(1)
    expect(viewer().load).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('world-fallback')).toBeNull()
  })

  it('Enter or Space on a 2D map item opens its card; elsewhere, or another key, keeps its default', async () => {
    h.webgl = false
    bridge()
    await mount()
    const list = screen.getByTestId('world-fallback')
    const textOf = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent as string }
    expect(fireEvent.keyDown(list.querySelector('[data-id="b1"]') as Element, { key: 'Enter' })).toBe(false)
    expect(dialog()).toHaveTextContent(textOf(buildingCard(minimal(), 'b1') as string).slice(0, 20))
    expect(fireEvent.keyDown(list.querySelector('[data-kind="edge"]') as Element, { key: ' ' })).toBe(false)
    expect(fireEvent.keyDown(list.querySelector('h2') as Element, { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(list.querySelector('[data-id="b1"]') as Element, { key: 'a' })).toBe(true)
  })

  it('the 2D map shows the plan as the layers say: planned parts dashed, gone with the planned layer off', async () => {
    h.webgl = false
    bridge({ worldGet: vi.fn(async () => ok(rich())) })
    await mount()
    const list = () => screen.getByTestId('world-fallback')
    expect(list().querySelector('rect[data-id="b4"]')?.getAttribute('fill')).toBe('none')
    fireEvent.click(screen.getByTestId('world-layer-planned'))
    expect(list().querySelector('[data-id="b4"]')).toBeNull()
  })

  it('a minimised or hidden window pauses the 3D map; shown again, it draws', async () => {
    let shown: ((s: boolean) => void) | null = null
    const off = vi.fn()
    ;(window as any).windowControls = { onShown: vi.fn((cb: (s: boolean) => void) => { shown = cb; return off }) }
    try {
      bridge()
      const m = await mount()
      expect(viewer().setPaused).toHaveBeenLastCalledWith(false)
      act(() => { (shown as (s: boolean) => void)(false) })
      expect(viewer().setPaused).toHaveBeenLastCalledWith(true)
      act(() => { (shown as (s: boolean) => void)(true) })
      expect(viewer().setPaused).toHaveBeenLastCalledWith(false)
      m.unmount()
      expect(off).toHaveBeenCalledTimes(1)
    } finally {
      delete (window as any).windowControls
    }
  })
})
