import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import type { BuildItResult, WorldDoc, WorldEntry } from '../../../src/shared/world/types'
import type { WorldViewerOptions } from '../../../src/renderer/src/world/engine'
import { minimal } from './helpers'

// The engine is real except the two things jsdom cannot do: a WebGL probe and a WebGL viewer.
const h = vi.hoisted(() => ({ webgl: true, viewers: [] as any[] }))
vi.mock('../../../src/renderer/src/world/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/renderer/src/world/engine')>()
  return {
    ...real,
    hasWebGL: () => h.webgl,
    createWorldViewer: vi.fn((host: HTMLElement, opts: WorldViewerOptions) => {
      const v = {
        host, opts,
        load: vi.fn(), setLayers: vi.fn(), setTheme: vi.fn(),
        apply: vi.fn(async () => undefined), play: vi.fn(async () => undefined), cancelActions: vi.fn(),
        on: vi.fn(() => () => undefined),
        getSelection: vi.fn(() => []), cameraRegion: vi.fn(() => []), resetView: vi.fn(), dispose: vi.fn(),
        screenPoint: vi.fn(() => null),
        drawn: vi.fn(() => ({ layers: real.DEFAULT_LAYERS, processShells: 0, conduits: 0 })),
      }
      h.viewers.push(v)
      return v
    }),
  }
})

import { WorldView } from '../../../src/renderer/src/components/World'
import type { WorldAskLink } from '../../../src/renderer/src/components/World/WorldView'

type Res<T> = { success: true; data: T } | { success: false; error: string }
const ok = <T,>(data: T): Res<T> => ({ success: true, data })
const fail = (error: string): Res<never> => ({ success: false, error })

const FOLDER: WorldEntry = { key: 'kf', source: { kind: 'folder', root: 'C:/work/shop' }, title: 'shop', lastOpened: 1 }
const DESIGN: WorldEntry = { key: 'design:d1', source: { kind: 'design', id: 'd1', title: 'Pet shop' }, title: 'Pet shop', lastOpened: 2 }
const designDoc = (generatedAt = 5): WorldDoc => ({ ...minimal(), projectKey: 'design:d1', generatedAt })
const BUILT: BuildItResult = { root: 'C:/build/pets', key: 'design:d1', title: 'Pet shop', prompt: 'Build the app.' }

function bridge(over: Record<string, unknown> = {}) {
  const api = {
    gitFindRoot: vi.fn(async (cwd: string) => ok<string | null>(cwd)),
    worldSourcesList: vi.fn(async () => ok<WorldEntry[]>([FOLDER, DESIGN])),
    worldGet: vi.fn(async (_root: string): Promise<Res<WorldDoc | null>> => ok(minimal())),
    worldCompile: vi.fn(async (_root: string): Promise<Res<WorldDoc>> => ok(minimal())),
    worldRelayout: vi.fn(async (_root: string): Promise<Res<WorldDoc>> => ok(minimal())),
    worldDesignGet: vi.fn(async (_key: string): Promise<Res<WorldDoc>> => ok(designDoc())),
    worldPickFolder: vi.fn(async () => ok({ root: 'C:/build/pets', empty: true })),
    worldBuildIt: vi.fn(async () => ok(BUILT)),
    onWorldProgress: vi.fn(() => () => undefined),
    onWorldUpdated: vi.fn(() => () => undefined),
    ...over,
  }
  ;(window as any).termpolis = api
  return api
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}
const viewer = () => h.viewers[h.viewers.length - 1]
const switchTo = (value: string) => fireEvent.change(screen.getByRole('combobox', { name: 'Worlds' }), { target: { value } })

interface Mounted { slot: ReturnType<typeof vi.fn>; launch: ReturnType<typeof vi.fn>; rerender: (root: string) => Promise<void>; unmount: () => void }
async function mount(root = '/repo', opts: { buildIt?: boolean } = {}): Promise<Mounted> {
  const slot = vi.fn((_v: unknown, _d: unknown, _k: string | null, _l: WorldAskLink) => <span data-testid="ask-here" />)
  const launch = vi.fn()
  const buildIt = opts.buildIt === false ? undefined : { agents: [{ id: 'claude', name: 'Claude Code' }], defaultAgent: 'claude', launch }
  const el = (r: string) => <WorldView root={r} onClose={() => undefined} askSlot={slot} buildIt={buildIt} />
  const utils = render(el(root))
  await settle()
  return { slot, launch, rerender: async (r) => { utils.rerender(el(r)); await settle() }, unmount: utils.unmount }
}
const lastSlot = (m: Mounted) => m.slot.mock.calls[m.slot.mock.calls.length - 1]

beforeEach(() => {
  h.webgl = true
  h.viewers.length = 0
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
  delete (window as any).termpolis
})

describe('WorldView sources', () => {
  it('a recent folder opens as it is (no git root lookup) and stops following the terminal', async () => {
    const api = bridge()
    const m = await mount('')
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    expect(screen.queryByTestId('world-ask-slot')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open shop' }))
    await settle()
    expect(api.gitFindRoot).not.toHaveBeenCalled()
    expect(api.worldGet).toHaveBeenCalledWith('C:/work/shop')
    expect(screen.getByTestId('world-project')).toHaveTextContent('shop')
    expect(lastSlot(m)[2]).toBe('C:/work/shop')
    // The terminal moving on leaves the chosen world alone.
    await m.rerender('/elsewhere')
    expect(api.worldGet).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('world-home')).toBeNull()
  })

  it('switcher opens chosen world', async () => {
    const api = bridge()
    await mount('/repo')
    expect(api.worldGet).toHaveBeenLastCalledWith('/repo')
    switchTo('kf')
    await settle()
    expect(api.worldGet).toHaveBeenLastCalledWith('C:/work/shop')
    switchTo('__home')
    await settle()
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    expect(screen.getByTestId('world-relayout')).toBeDisabled()
  })

  it('Map this project follows the active terminal again', async () => {
    const api = bridge({ worldMapProject: vi.fn(async () => ok(FOLDER)) })
    const m = await mount('/repo')
    switchTo('__home')
    await settle()
    await m.rerender('/other')
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Map this project/ }))
    await settle()
    expect(api.worldGet).toHaveBeenLastCalledWith('/other')
    await m.rerender('/third')
    expect(api.worldGet).toHaveBeenLastCalledWith('/third')
    await m.rerender('')
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
  })

  it('a design opens through world:design-get with the planned layer on and its title', async () => {
    const api = bridge()
    const m = await mount('/repo')
    switchTo('design:d1')
    await settle()
    expect(api.worldDesignGet).toHaveBeenCalledWith('design:d1')
    expect(viewer().setLayers).toHaveBeenCalledWith({ planned: true })
    expect(screen.getByTestId('world-layer-planned')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('world-project')).toHaveTextContent('Pet shop')
    expect(viewer().load).toHaveBeenLastCalledWith(designDoc())
    expect(lastSlot(m)[2]).toBe('design:d1')
    expect(screen.getByTestId('world-relayout')).toBeDisabled()
    // A change made through the ask bar is drawn growing from the design shown.
    const link = lastSlot(m)[3]
    act(() => link.setDoc(designDoc(9)))
    await settle()
    expect(viewer().load).toHaveBeenLastCalledWith(designDoc(9), { animateFrom: designDoc() })
  })

  it('a design missing from the recent worlds is called Design', async () => {
    bridge({ worldSourcesList: vi.fn(async () => ok([{ ...DESIGN, key: 'design:d1' }])) })
    await mount('/repo')
    ;(window as any).termpolis.worldSourcesList = vi.fn(async () => ok([]))
    switchTo('design:d1')
    await settle()
    expect(screen.getByTestId('world-project')).toHaveTextContent('Design')
  })

  it('a design that fails to load shows why, and a thrown load its message', async () => {
    bridge({ worldDesignGet: vi.fn(async () => fail('That design is gone.')) })
    await mount('/repo')
    switchTo('design:d1')
    await settle()
    expect(screen.getByTestId('world-error')).toHaveTextContent('That design is gone.')
    cleanup()
    bridge({ worldDesignGet: vi.fn(async () => { throw new Error('bridge down') }) })
    await mount('/repo')
    switchTo('design:d1')
    await settle()
    expect(screen.getByTestId('world-error')).toHaveTextContent('bridge down')
  })

  it('a design load that lands after the pane moved on is dropped', async () => {
    let resolveGet!: (r: Res<WorldDoc>) => void
    let rejectGet!: (e: unknown) => void
    const api = bridge({
      worldDesignGet: vi.fn()
        .mockImplementationOnce(() => new Promise((res) => { resolveGet = res }))
        .mockImplementationOnce(() => new Promise((_res, rej) => { rejectGet = rej })),
    })
    await mount('/repo')
    switchTo('design:d1')
    await settle()
    switchTo('__home')
    await settle()
    await act(async () => { resolveGet(ok(designDoc())) })
    switchTo('design:d1')
    await settle()
    switchTo('__home')
    await settle()
    await act(async () => { rejectGet(new Error('late')) })
    await settle()
    expect(api.worldDesignGet).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    expect(screen.queryByTestId('world-error')).toBeNull()
  })

  it('Build it links the design, launches the agent and switches to the folder with the plan on', async () => {
    const api = bridge()
    const m = await mount('/repo')
    expect(screen.queryByTestId('world-build-it-open')).toBeNull()
    switchTo('design:d1')
    await settle()
    fireEvent.click(screen.getByTestId('world-build-it-open'))
    expect(screen.getByRole('dialog', { name: 'Build it' })).toHaveTextContent('Pet shop')
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await settle()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Build it' })).getByRole('button', { name: 'Build it' }))
    await settle()
    expect(api.worldBuildIt).toHaveBeenCalledWith({ key: 'design:d1', root: 'C:/build/pets', agent: 'claude' })
    expect(m.launch).toHaveBeenCalledWith(BUILT, 'claude')
    expect(screen.queryByRole('dialog', { name: 'Build it' })).toBeNull()
    expect(api.worldGet).toHaveBeenLastCalledWith('C:/build/pets')
    expect(screen.getByTestId('world-layer-planned')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('world-project')).toHaveTextContent('pets')
  })

  it('Esc closes the Build it dialog first, and Cancel closes it too', async () => {
    bridge()
    await mount('/repo')
    switchTo('design:d1')
    await settle()
    fireEvent.click(screen.getByTestId('world-build-it-open'))
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Lumopolis' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Build it' })).toBeNull()
    expect(viewer().resetView).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('world-build-it-open'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Build it' })).toBeNull()
  })

  it('without a Build it launcher a design shows no Build it button', async () => {
    bridge()
    await mount('/repo', { buildIt: false })
    switchTo('design:d1')
    await settle()
    expect(screen.getByTestId('world-project')).toHaveTextContent('Pet shop')
    expect(screen.queryByTestId('world-build-it-open')).toBeNull()
  })

  it('a failed or thrown recent-worlds list leaves the list empty', async () => {
    bridge({ worldSourcesList: vi.fn(async () => fail('nope')) })
    await mount('')
    expect(screen.getByText(/No worlds yet/)).toBeInTheDocument()
    cleanup()
    bridge({ worldSourcesList: vi.fn(async () => { throw new Error('down') }) })
    await mount('')
    expect(screen.getByText(/No worlds yet/)).toBeInTheDocument()
  })

  it('a list or a design change that lands after unmount is dropped', async () => {
    let resolveList!: (r: Res<WorldEntry[]>) => void
    bridge({ worldSourcesList: vi.fn(() => new Promise((res) => { resolveList = res })) })
    const m = await mount('/repo')
    const link = lastSlot(m)[3]
    m.unmount()
    await act(async () => { resolveList(ok([FOLDER])) })
    act(() => link.setDoc(designDoc()))
    expect(screen.queryByTestId('world-view')).toBeNull()
  })
})
