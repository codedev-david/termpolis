import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import type { BuildItResult, WorldDoc, WorldEntry, WorldProgressEvent } from '../../../src/shared/world/types'
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
        load: vi.fn(), setLayers: vi.fn(), setTheme: vi.fn(), setRightReserve: vi.fn(), setBottomReserve: vi.fn(), setCardReserve: vi.fn(), setPanels: vi.fn(), setLabelScale: vi.fn(),
        apply: vi.fn(async () => undefined), play: vi.fn(async () => undefined), cancelActions: vi.fn(),
        on: vi.fn(() => () => undefined),
        getSelection: vi.fn(() => []), cameraRegion: vi.fn(() => []), resetView: vi.fn(), setPaused: vi.fn(), requestFrame: vi.fn(), setTitle: vi.fn(), dispose: vi.fn(),
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
import { UI_FAILED } from '../../../src/renderer/src/components/World/worldTargets'

type Res<T> = { success: true; data: T } | { success: false; error: string }
const ok = <T,>(data: T): Res<T> => ({ success: true, data })
const fail = (error: string): Res<never> => ({ success: false, error })

const FOLDER: WorldEntry = { key: 'kf', source: { kind: 'folder', root: 'C:/work/shop' }, title: 'shop', lastOpened: 1 }
const DESIGN: WorldEntry = { key: 'design:d1', source: { kind: 'design', id: 'd1', title: 'Pet shop' }, title: 'Pet shop', lastOpened: 2 }
const designDoc = (generatedAt = 5): WorldDoc => ({ ...minimal(), projectKey: 'design:d1', generatedAt })
const BUILT: BuildItResult = { root: 'C:/build/pets', key: 'design:d1', title: 'Pet shop', prompt: 'Build the app.' }

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
/** What the Export button needs from the bridge. */
const exportBits = () => ({
  worldExportInfo: vi.fn(async () => ok({ title: 'Pet shop', savedAt: 1, smartDefault: false, buildings: 1, lines: 1, smartBytes: 1024, keywordBytes: 1024, smartAvailable: true, proposals: [] })),
  worldExport: vi.fn(() => new Promise(() => undefined)),
  worldExportCancel: vi.fn(async () => ok(true)),
  onWorldExportProgress: vi.fn(() => () => undefined),
})
/** Main's compile progress, pushed by hand. */
const progressHub = () => {
  const cbs = new Set<(e: WorldProgressEvent) => void>()
  return {
    on: vi.fn((cb: (e: WorldProgressEvent) => void) => { cbs.add(cb); return () => { cbs.delete(cb) } }),
    emit: (e: WorldProgressEvent) => act(() => { for (const cb of cbs) cb(e) }),
  }
}

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
    worldTouchSource: vi.fn(async (_key: string) => ok<WorldEntry | null>(null)),
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

  // F-R3: choosing the world already open must not leave "Opening Lumopolis…" up for good.
  it('choosing the world already open in the switcher still draws it', async () => {
    const api = bridge()
    await mount('/repo')
    switchTo('kf')
    await settle()
    expect(screen.getByTestId('world-project')).toHaveTextContent('shop')
    const loads = viewer().load.mock.calls.length
    switchTo('kf')
    await settle()
    expect(screen.queryByTestId('world-loading')).toBeNull()
    expect(screen.queryByTestId('world-empty')).toBeNull()
    expect(screen.getByTestId('world-project')).toHaveTextContent('shop')
    expect(viewer().load.mock.calls.length).toBeGreaterThanOrEqual(loads)
    expect(api.worldGet).toHaveBeenLastCalledWith('C:/work/shop')
  })

  it('choosing the terminal folder itself from the switcher opens it as chosen, without following the terminal', async () => {
    const HERE: WorldEntry = { key: 'kr', source: { kind: 'folder', root: '/repo' }, title: 'repo', lastOpened: 3 }
    const api = bridge({ worldSourcesList: vi.fn(async () => ok<WorldEntry[]>([HERE, FOLDER])) })
    const m = await mount('/repo')
    expect(api.gitFindRoot).toHaveBeenCalledTimes(1)
    switchTo('kr')
    await settle()
    expect(api.gitFindRoot).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('world-loading')).toBeNull()
    expect(api.worldGet).toHaveBeenLastCalledWith('/repo')
    await m.rerender('/elsewhere')
    expect(api.worldGet).toHaveBeenLastCalledWith('/repo')
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

  // A clone lives in a folder named by a hash: the toolbar and the flat map name it by its saved title.
  it('a cloned repository is named by its title, in the toolbar and in the flat map', async () => {
    const CLONE: WorldEntry = { key: 'kc', source: { kind: 'git', url: 'https://github.com/o/shop.git', root: 'C:/ud/world/repos/0123456789abcdef', login: 'machine' }, title: 'o/shop', lastOpened: 4 }
    for (const webgl of [true, false]) {
      h.webgl = webgl
      bridge({
        worldSourcesList: vi.fn(async () => ok<WorldEntry[]>([CLONE])),
        worldTouchSource: vi.fn(async () => ok<WorldEntry | null>(CLONE)),
        worldUpdateSource: vi.fn(async () => ok({ changed: false })),
      })
      const m = await mount('')
      fireEvent.click(screen.getByRole('button', { name: 'Open o/shop' }))
      await settle()
      expect(screen.getByTestId('world-project')).toHaveTextContent('o/shop')
      expect(screen.getByTestId('world-project')).not.toHaveTextContent('0123456789abcdef')
      if (!webgl) {
        expect(screen.getByTestId('world-fallback')).toHaveTextContent('o/shop')
        expect(screen.getByTestId('world-fallback')).not.toHaveTextContent('0123456789abcdef')
      }
      m.unmount()
    }
  })

  it('a folder that is no repository in the list keeps its folder name', async () => {
    const OTHER: WorldEntry = { key: 'ko', source: { kind: 'git', url: 'https://github.com/o/x.git', root: 'C:/ud/world/repos/ffff', login: 'machine' }, title: 'o/x', lastOpened: 4 }
    bridge({ worldSourcesList: vi.fn(async () => ok<WorldEntry[]>([OTHER, FOLDER])) })
    await mount('')
    fireEvent.click(screen.getByRole('button', { name: 'Open shop' }))
    await settle()
    expect(screen.getByTestId('world-project')).toHaveTextContent('shop')
    expect(screen.getByTestId('world-project')).not.toHaveTextContent('o/x')
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
    expect(screen.getByTestId('world-empty')).toHaveTextContent('Lumopolis could not map this project.')
    expect(screen.getByTestId('world-empty')).not.toHaveTextContent(/bridge down|couldn't do that/)
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

  it('a design exports by its key, not by a folder', async () => {
    const MB = 1024 * 1024
    const api = bridge({
      worldExportInfo: vi.fn(async () => ({ success: true, data: { title: 'Pet shop', savedAt: 1, smartDefault: false, buildings: 1, lines: 1, smartBytes: 37 * MB, keywordBytes: MB, smartAvailable: true, proposals: [] } })),
      onWorldExportProgress: vi.fn(() => () => undefined),
      worldDocument: vi.fn(async () => ({ success: true, data: { cancelled: true } })),
    })
    await mount('/repo')
    switchTo('design:d1')
    await settle()
    fireEvent.click(screen.getByTestId('world-export'))
    fireEvent.click(screen.getByTestId('world-export-world'))
    await settle()
    expect(api.worldExportInfo).toHaveBeenCalledWith({ root: undefined, designKey: 'design:d1' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByTestId('world-export'))
    fireEvent.click(screen.getByTestId('world-export-document'))
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Pet shop')
    fireEvent.click(screen.getByRole('button', { name: 'Save…' }))
    expect(api.worldDocument).toHaveBeenCalledWith(expect.objectContaining({ root: undefined, designKey: 'design:d1', title: 'Pet shop' }))
  })

  it('Esc closes the Build it dialog first, and Cancel closes it too', async () => {
    bridge()
    await mount('/repo')
    switchTo('design:d1')
    await settle()
    fireEvent.click(screen.getByTestId('world-build-it-open'))
    fireEvent.keyDown(screen.getByRole('region', { name: 'Lumopolis' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Build it' })).toBeNull()
    expect(viewer().resetView).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('world-build-it-open'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Build it' })).toBeNull()
  })

  it('Build it and Export turn each other off while either dialog is open', async () => {
    bridge(exportBits())
    await mount('/repo')
    switchTo('design:d1')
    await settle()
    const exportBtn = () => screen.getByTestId('world-export')
    const buildBtn = () => screen.getByTestId('world-build-it-open')
    expect(exportBtn()).toBeEnabled()
    expect(buildBtn()).toBeEnabled()
    fireEvent.click(buildBtn())
    expect(screen.getByRole('dialog', { name: 'Build it' })).toBeInTheDocument()
    expect(exportBtn()).toBeDisabled()
    fireEvent.click(exportBtn())
    expect(screen.queryByTestId('world-export-menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(exportBtn()).toBeEnabled()
    fireEvent.click(exportBtn())
    fireEvent.click(screen.getByTestId('world-export-world'))
    await settle()
    expect(screen.getByTestId('world-export-dialog')).toBeInTheDocument()
    expect(buildBtn()).toBeDisabled()
    fireEvent.click(buildBtn())
    expect(screen.queryByRole('dialog', { name: 'Build it' })).toBeNull()
    expect(screen.getByTestId('world-export-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(buildBtn()).toBeEnabled()
  })

  it('Build it takes over from a documentation dialog still waiting for its picture', async () => {
    bridge(exportBits())
    await mount('/repo')
    switchTo('design:d1')
    await settle()
    const c = document.createElement('canvas')
    c.toDataURL = vi.fn(() => 'data:image/png;base64,AA') as never
    screen.getByTestId('world-canvas-host').appendChild(c)
    fireEvent.click(screen.getByTestId('world-export'))
    fireEvent.click(screen.getByTestId('world-export-document'))
    fireEvent.click(screen.getByTestId('world-build-it-open'))
    await act(() => new Promise<void>((r) => { requestAnimationFrame(() => r()) }))
    expect(c.toDataURL).not.toHaveBeenCalled()
    expect(screen.queryByTestId('world-document-dialog')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Build it' })).toBeInTheDocument()
  })

  it('without a Build it launcher a design shows no Build it button', async () => {
    bridge()
    await mount('/repo', { buildIt: false })
    switchTo('design:d1')
    await settle()
    expect(screen.getByTestId('world-project')).toHaveTextContent('Pet shop')
    expect(screen.queryByTestId('world-build-it-open')).toBeNull()
  })

  it('opening a recent world from the home or the switcher marks it opened now: newest first, "just now"', async () => {
    // A registry that behaves like main's: touch sets lastOpened to now, the list is newest first.
    const DAY = 86_400_000
    const now = Date.now()
    let reg: WorldEntry[] = [{ ...DESIGN, lastOpened: now - 2 * DAY }, { ...FOLDER, lastOpened: now - 3 * DAY }]
    const touch = vi.fn(async (key: string) => {
      reg = reg.map((e) => (e.key === key ? { ...e, lastOpened: Date.now() } : e))
      return ok(reg.find((e) => e.key === key) ?? null)
    })
    const api = bridge({
      worldSourcesList: vi.fn(async () => ok([...reg].sort((a, b) => b.lastOpened - a.lastOpened))),
      worldTouchSource: touch,
    })
    await mount('')
    const order = () => screen.getAllByTestId(/^world-recent-/).map((li) => li.getAttribute('data-testid'))
    expect(order()).toEqual(['world-recent-design:d1', 'world-recent-kf'])
    expect(within(screen.getByTestId('world-recent-kf')).getByText('3 days ago')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open shop' }))
    await settle()
    expect(touch).toHaveBeenCalledWith('kf')
    expect(api.worldGet).toHaveBeenCalledWith('C:/work/shop')
    switchTo('__home')
    await settle()
    expect(order()).toEqual(['world-recent-kf', 'world-recent-design:d1'])
    expect(within(screen.getByTestId('world-recent-kf')).getByText('just now')).toBeInTheDocument()
    // The switcher opens the design: it is touched too and moves back to the front.
    switchTo('design:d1')
    await settle()
    expect(touch).toHaveBeenLastCalledWith('design:d1')
    switchTo('__home')
    await settle()
    expect(order()).toEqual(['world-recent-design:d1', 'world-recent-kf'])
  })

  it('a touch that fails or throws still opens the world', async () => {
    const api = bridge({ worldTouchSource: vi.fn(async () => fail('disk')) })
    await mount('')
    fireEvent.click(screen.getByRole('button', { name: 'Open shop' }))
    await settle()
    expect(api.worldGet).toHaveBeenCalledWith('C:/work/shop')
    cleanup()
    const api2 = bridge({ worldTouchSource: vi.fn(async () => { throw new Error('down') }) })
    await mount('')
    fireEvent.click(screen.getByRole('button', { name: 'Open Pet shop' }))
    await settle()
    expect(api2.worldDesignGet).toHaveBeenCalledWith('design:d1')
  })

  it('a failed or thrown recent-worlds list says it could not be read, never a false "No worlds yet" (F-R12)', async () => {
    bridge({ worldSourcesList: vi.fn(async () => fail('nope')) })
    await mount('')
    expect(screen.getByTestId('world-list-error')).toHaveTextContent("Lumopolis couldn't load your recent worlds.")
    expect(screen.queryByText(/No worlds yet/)).toBeNull()
    expect(screen.queryByText('nope')).toBeNull()
    cleanup()
    bridge({ worldSourcesList: vi.fn(async () => { throw new Error('down') }) })
    await mount('')
    expect(screen.getByTestId('world-list-error')).toBeInTheDocument()
    expect(screen.queryByText(/No worlds yet/)).toBeNull()
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

describe('WorldView sign in needed', () => {
  const GIT: WorldEntry = { key: 'kgit', source: { kind: 'git', url: 'https://github.com/o/r.git', root: 'C:/data/r', login: 'machine' }, title: 'rrepo', lastOpened: 3 }
  const NEEDS = { needsLogin: { host: 'github.com', helper: true, message: 'Sign in please.' } }
  const gitBridge = (update: unknown, over: Record<string, unknown> = {}) => bridge({
    worldSourcesList: vi.fn(async () => ok<WorldEntry[]>([GIT])),
    worldTouchSource: vi.fn(async () => ok<WorldEntry | null>(GIT)),
    worldUpdateSource: vi.fn(async () => update),
    ...over,
  })
  const openGit = async () => {
    await mount('')
    fireEvent.click(screen.getByRole('button', { name: 'Open rrepo' }))
    await settle()
  }

  it('shows the notice with its three actions, and Dismiss hides it', async () => {
    gitBridge(ok(NEEDS))
    await openGit()
    const notice = screen.getByTestId('world-sign-in-needed')
    expect(notice).toHaveTextContent("This repository needs you to sign in before Lumopolis can update it. You're seeing the saved copy.")
    expect(within(notice).getByRole('button', { name: 'Sign in to GitHub' })).not.toHaveClass('underline')
    expect(within(notice).getByRole('button', { name: 'Use a token' })).not.toHaveClass('underline')
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('world-sign-in-needed')).toBeNull()
  })

  // R4: a saved repository the host no longer finds says so in main's words; Sign in and Use a token stay, as links, in
  // case the account lost access, and a Sign in that still finds nothing says the sign-in words under it.
  it('a saved repository that is not found any more says so, with Sign in and Use a token as links', async () => {
    const GONE = "Lumopolis couldn't find this repository any more. It may have moved or been deleted, or this account lost access."
    const STILL = "Lumopolis still couldn't find that repository after signing in. Check the address, and that this account can see it."
    const api = gitBridge(ok({ needsLogin: { host: 'github.com', helper: true, notFound: true, message: GONE } }))
    await openGit()
    const notice = screen.getByTestId('world-sign-in-needed')
    expect(notice).toHaveTextContent(GONE)
    expect(notice).not.toHaveTextContent('needs you to sign in')
    const signIn = within(notice).getByRole('button', { name: 'Sign in to GitHub' })
    expect(signIn).toHaveClass('underline')
    expect(within(notice).getByRole('button', { name: 'Use a token' })).toHaveClass('underline')
    expect(within(notice).getByRole('button', { name: 'Dismiss' })).not.toHaveClass('underline')
    api.worldUpdateSource.mockResolvedValueOnce(ok({ needsLogin: { host: 'github.com', helper: true, notFound: true, message: STILL } }))
    fireEvent.click(signIn)
    await settle()
    expect(api.worldUpdateSource).toHaveBeenLastCalledWith('kgit', { mode: 'machine' })
    const after = screen.getByTestId('world-sign-in-needed')
    expect(within(after).getByRole('alert')).toHaveTextContent(STILL)
    // The notice still says why it is there, and its choices stay links.
    expect(after).toHaveTextContent(GONE)
    expect(within(after).getByRole('button', { name: 'Sign in to GitHub' })).toHaveClass('underline')
  })

  it('a Sign in over a sign-in notice that then finds nothing keeps its own words and says why under it', async () => {
    const api = gitBridge(ok(NEEDS))
    await openGit()
    api.worldUpdateSource.mockResolvedValueOnce(ok({ needsLogin: { host: 'github.com', helper: true, notFound: true, message: 'Still not there.' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }))
    await settle()
    const after = screen.getByTestId('world-sign-in-needed')
    expect(after).toHaveTextContent("This repository needs you to sign in before Lumopolis can update it.")
    expect(within(after).getByRole('alert')).toHaveTextContent('Still not there.')
    expect(within(after).getByRole('button', { name: 'Sign in to GitHub' })).not.toHaveClass('underline')
  })

  it('shows no notice when the update works, and recompiles when something changed', async () => {
    const api = gitBridge(ok({ changed: true }))
    await openGit()
    expect(screen.queryByTestId('world-sign-in-needed')).toBeNull()
    expect(api.worldCompile).toHaveBeenCalledWith('C:/data/r')
  })

  it('a recompile that fails after a changed update leaves the saved world showing', async () => {
    const api = gitBridge(ok({ changed: true }), { worldCompile: vi.fn(async () => { throw new Error('down') }) })
    await openGit()
    expect(api.worldCompile).toHaveBeenCalledWith('C:/data/r')
    expect(screen.getByTestId('world-view')).toBeInTheDocument()
  })

  // U8: a recompile after a repository update that fails says so, over the saved map, and can be tried again.
  it('a recompile that throws after a changed update says so with the compile error, and Try again maps it again', async () => {
    const api = gitBridge(ok({ changed: true }), { worldCompile: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(ok(minimal())) })
    await openGit()
    const failed = screen.getByTestId('world-recompile-error')
    // M3: the thrown call adds no second "couldn't do that" after it.
    expect(failed.textContent).toBe('Lumopolis could not map this project.Try again')
    expect(screen.queryByTestId('world-empty')).toBeNull()
    fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }))
    expect(screen.queryByTestId('world-recompile-error')).toBeNull()
    await settle()
    expect(api.worldCompile).toHaveBeenCalledTimes(2)
    expect(api.worldCompile).toHaveBeenLastCalledWith('C:/data/r')
    expect(screen.queryByTestId('world-recompile-error')).toBeNull()
  })

  it('a recompile that answers with a failure says what main said', async () => {
    gitBridge(ok({ changed: true }), { worldCompile: vi.fn(async () => fail('The disk is full.')) })
    await openGit()
    expect(screen.getByTestId('world-recompile-error')).toHaveTextContent('The disk is full.')
  })

  it('a recompile that fails after another world opened says nothing over that world', async () => {
    const compile = deferred<Res<WorldDoc>>()
    gitBridge(ok({ changed: true }), {
      worldSourcesList: vi.fn(async () => ok<WorldEntry[]>([GIT, FOLDER])),
      worldCompile: vi.fn(() => compile.promise),
    })
    await openGit()
    switchTo('kf')
    await settle()
    expect(screen.getByTestId('world-project')).toHaveTextContent('shop')
    await act(async () => { compile.resolve(fail('down')) })
    await settle()
    expect(screen.queryByTestId('world-recompile-error')).toBeNull()
  })

  it('a recompile that throws after another world opened says nothing over that world', async () => {
    const compile = deferred<Res<WorldDoc>>()
    gitBridge(ok({ changed: true }), {
      worldSourcesList: vi.fn(async () => ok<WorldEntry[]>([GIT, FOLDER])),
      worldCompile: vi.fn(() => compile.promise),
    })
    await openGit()
    switchTo('kf')
    await settle()
    await act(async () => { compile.reject(new Error('down')) })
    await settle()
    expect(screen.queryByTestId('world-recompile-error')).toBeNull()
  })

  it('a recompile after a repository update that fails leaves no run going for the export dialog', async () => {
    const compile = deferred<Res<WorldDoc>>()
    const p = progressHub()
    gitBridge(ok({ changed: true }), { worldCompile: vi.fn(() => compile.promise), onWorldProgress: p.on, ...exportBits() })
    await openGit()
    p.emit({ root: 'C:/data/r', projectKey: 'k', stage: 'labelling', pct: 65 })
    await act(async () => { compile.reject(new Error('down')) })
    await settle()
    fireEvent.click(screen.getByTestId('world-export'))
    fireEvent.click(screen.getByTestId('world-export-world'))
    await settle()
    expect(screen.getByTestId('world-export-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('world-export-saved-at')).toBeNull()
  })

  it('a recompile that settles after another world opened leaves that world\'s run alone', async () => {
    const compile = deferred<Res<WorldDoc>>()
    const p = progressHub()
    gitBridge(ok({ changed: true }), {
      worldSourcesList: vi.fn(async () => ok<WorldEntry[]>([GIT, FOLDER])),
      worldCompile: vi.fn(() => compile.promise),
      onWorldProgress: p.on,
      ...exportBits(),
    })
    await openGit()
    switchTo('kf')
    await settle()
    expect(screen.getByTestId('world-project')).toHaveTextContent('shop')
    p.emit({ root: 'C:/work/shop', projectKey: 'k', stage: 'boundaries', pct: 40 })
    await act(async () => { compile.resolve(ok(minimal())) })
    await settle()
    fireEvent.click(screen.getByTestId('world-export'))
    fireEvent.click(screen.getByTestId('world-export-world'))
    await settle()
    expect(screen.getByTestId('world-export-saved-at')).toBeInTheDocument()
  })

  it('Sign in retries interactively and the notice goes away', async () => {
    const api = gitBridge(ok(NEEDS))
    await openGit()
    api.worldUpdateSource.mockResolvedValueOnce(ok({ changed: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }))
    await settle()
    expect(api.worldUpdateSource).toHaveBeenLastCalledWith('kgit', { mode: 'machine' })
    expect(screen.queryByTestId('world-sign-in-needed')).toBeNull()
  })

  it('without a helper there is no Sign in, and Use a token opens the dialog; a token retries, a refusal keeps it open', async () => {
    const api = gitBridge(ok({ needsLogin: { host: 'gitlab.example.com', helper: false, message: 'Sign in please.' } }))
    await openGit()
    expect(screen.queryByRole('button', { name: /^Sign in/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Use a token' }))
    const send = async (value: string) => {
      fireEvent.change(screen.getByTestId('world-repo-access-input'), { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: 'Use this token' }))
      await settle()
    }
    api.worldUpdateSource.mockResolvedValueOnce(fail('That token did not open it.'))
    await send('ghp_x')
    expect(api.worldUpdateSource).toHaveBeenLastCalledWith('kgit', { mode: 'token', value: 'ghp_x' })
    expect(within(screen.getByTestId('world-repo-access')).getByRole('alert')).toHaveTextContent('That token did not open it.')
    api.worldUpdateSource.mockResolvedValueOnce(ok({ changed: false }))
    await send('ghp_y')
    expect(screen.queryByTestId('world-repo-access')).toBeNull()
    expect(screen.queryByTestId('world-sign-in-needed')).toBeNull()
  })

  // WP-SRC N1: a failed token try is said once, in the token dialog the person is in; the notice under it says nothing
  // and takes no focus or clicks while the dialog is up.
  it('a failed token try from the notice is announced once, in the token dialog', async () => {
    const api = gitBridge(ok(NEEDS))
    await openGit()
    fireEvent.click(screen.getByRole('button', { name: 'Use a token' }))
    api.worldUpdateSource.mockResolvedValueOnce(fail('That token did not open it.'))
    fireEvent.change(screen.getByTestId('world-repo-access-input'), { target: { value: 'ghp_x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this token' }))
    await settle()
    const said = screen.getAllByRole('alert').filter((a) => a.textContent === 'That token did not open it.')
    expect(said).toHaveLength(1)
    expect(screen.getByTestId('world-repo-access').contains(said[0])).toBe(true)
    const notice = screen.getByTestId('world-sign-in-needed')
    expect(within(notice).queryByRole('alert')).toBeNull()
    expect(notice.closest('[inert]') ?? (notice as HTMLElement & { inert?: boolean }).inert).toBeTruthy()
    // Closed, the notice is live again, and says nothing of the token the person backed out of.
    fireEvent.click(within(screen.getByTestId('world-repo-access')).getByRole('button', { name: 'Cancel' }))
    expect((screen.getByTestId('world-sign-in-needed') as HTMLElement & { inert?: boolean }).inert).toBeFalsy()
  })

  // WP-SRC N2: Tab stays in the token dialog opened from the notice, as it does on the home.
  it('Tab and Shift+Tab stay in the token dialog opened from the notice', async () => {
    gitBridge(ok(NEEDS))
    await openGit()
    fireEvent.click(screen.getByRole('button', { name: 'Use a token' }))
    const dialog = screen.getByTestId('world-repo-access')
    const field = screen.getByTestId('world-repo-access-input')
    field.focus()
    fireEvent.keyDown(field, { key: 'Tab' })
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    // from the first control, Shift+Tab goes round to the last one in the dialog, not out to the pane
    const first = within(dialog).getByRole('button', { name: 'Make a token on GitHub' })
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Use this token' }))
  })

  it('cancelling the token dialog leaves the notice', async () => {
    gitBridge(ok(NEEDS))
    await openGit()
    fireEvent.click(screen.getByRole('button', { name: 'Use a token' }))
    fireEvent.click(within(screen.getByTestId('world-repo-access')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('world-repo-access')).toBeNull()
    expect(screen.getByTestId('world-sign-in-needed')).toBeInTheDocument()
  })

  it('a dismissed notice does not bring the token dialog back later', async () => {
    gitBridge(ok(NEEDS))
    await openGit()
    fireEvent.click(screen.getByRole('button', { name: 'Use a token' }))
    fireEvent.click(within(screen.getByTestId('world-sign-in-needed')).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('world-repo-access')).toBeNull()
    switchTo('__home')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Open rrepo' }))
    await settle()
    expect(screen.getByTestId('world-sign-in-needed')).toBeInTheDocument()
    expect(screen.queryByTestId('world-repo-access')).toBeNull()
  })

  it('a failed Sign in says why in the notice, and Use a token starts without that message', async () => {
    const api = gitBridge(ok(NEEDS))
    await openGit()
    api.worldUpdateSource.mockResolvedValueOnce(fail('Sign in was closed.'))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }))
    await settle()
    expect(within(screen.getByTestId('world-sign-in-needed')).getByRole('alert')).toHaveTextContent('Sign in was closed.')
    fireEvent.click(screen.getByRole('button', { name: 'Use a token' }))
    expect(screen.queryByText('Sign in was closed.')).toBeNull()
  })

  it('Dismiss is disabled while a retry runs', async () => {
    const api = gitBridge(ok(NEEDS))
    await openGit()
    let release!: (v: unknown) => void
    api.worldUpdateSource.mockImplementationOnce(() => new Promise((res) => { release = res }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }))
    await settle()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled()
    await act(async () => { release(ok({ changed: false })) })
    expect(screen.queryByTestId('world-sign-in-needed')).toBeNull()
  })

  it('the sign in notice and the re-layout notice both show', async () => {
    gitBridge(ok(NEEDS), { worldRelayout: vi.fn(() => new Promise(() => undefined)) })
    await openGit()
    fireEvent.click(screen.getByTestId('world-relayout'))
    fireEvent.click(await screen.findByTestId('world-relayout-go'))
    expect(screen.getByTestId('world-sign-in-needed')).toBeInTheDocument()
    expect(screen.getByTestId('world-notice')).toBeInTheDocument()
  })

  it('the token field takes the focus, and Esc closes the token dialog before anything else', async () => {
    gitBridge(ok(NEEDS))
    await openGit()
    fireEvent.click(screen.getByRole('button', { name: 'Use a token' }))
    const field = screen.getByTestId('world-repo-access-input')
    expect(field).toHaveFocus()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByTestId('world-repo-access')).toBeNull()
    expect(screen.getByTestId('world-sign-in-needed')).toBeInTheDocument()
    expect(screen.getByTestId('world-view')).toBeInTheDocument()
  })
})

describe('WorldView: Esc in a home dialog', () => {
  const NEEDS = { needsLogin: { host: 'github.com', helper: false, message: 'That repository needs you to sign in.' } }
  const homeView = async (over: Record<string, unknown> = {}) => {
    const api = bridge({
      worldClone: vi.fn(() => new Promise(() => undefined)),
      worldCloneCancel: vi.fn(async () => ok(true)),
      worldDesignDraft: vi.fn(() => new Promise(() => undefined)),
      worldDesignCancel: vi.fn(async () => ok(true)),
      ...over,
    })
    const onClose = vi.fn()
    render(<WorldView root="" onClose={onClose} askSlot={() => <span />} />)
    await settle()
    return { api, onClose }
  }
  const esc = (el: Element) => fireEvent.keyDown(el, { key: 'Escape' })
  const choice = (name: RegExp) => screen.getByRole('button', { name })

  it('closes the clone or design dialog and only it, wherever the focus is in the pane: the pane stays open', async () => {
    const { onClose } = await homeView()
    // One Esc on the home arms the pane's close; a dialog opened after it takes the next Esc and disarms it.
    esc(screen.getByTestId('world-home'))
    fireEvent.click(choice(/^Open a git repository/))
    // The focus still on the choice behind the scrim: that Esc is the dialog's too.
    esc(choice(/^Open a git repository/))
    expect(screen.queryByTestId('world-clone')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(choice(/^Design something new/))
    esc(screen.getByLabelText('Describe the app you want'))
    expect(screen.queryByTestId('world-design-start')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // With no dialog left, Esc does what it did: the first resets, the second closes the pane.
    esc(screen.getByTestId('world-home'))
    expect(onClose).not.toHaveBeenCalled()
    esc(screen.getByTestId('world-home'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stops a clone or a draft under way and keeps its dialog, as Cancel does', async () => {
    const { api, onClose } = await homeView()
    fireEvent.click(choice(/^Open a git repository/))
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    expect(screen.getByRole('progressbar', { name: 'Cloning' })).toBeInTheDocument()
    esc(screen.getByLabelText('Repository URL'))
    expect(api.worldCloneCancel).toHaveBeenCalledWith('https://x.dev/a.git', undefined)
    expect(screen.getByTestId('world-clone')).toBeInTheDocument()
    // The dialog says it is stopping until the stopped clone answers (WP4b F-R5); a second Esc closes it.
    expect(within(screen.getByTestId('world-clone')).getByRole('status')).toHaveTextContent('Stopping the clone')
    esc(screen.getByLabelText('Repository URL'))
    expect(screen.queryByTestId('world-clone')).toBeNull()
    fireEvent.click(choice(/^Design something new/))
    fireEvent.change(screen.getByLabelText('Describe the app you want'), { target: { value: 'A pet shop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Design it' }))
    await settle()
    expect(api.worldDesignDraft).toHaveBeenCalled()
    esc(screen.getByLabelText('Describe the app you want'))
    expect(api.worldDesignCancel).toHaveBeenCalled()
    expect(screen.getByTestId('world-design-start')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('in the token dialog over the clone dialog, closes only the token dialog', async () => {
    const { onClose } = await homeView({ worldClone: vi.fn(async () => ok(NEEDS)) })
    fireEvent.click(choice(/^Open a git repository/))
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://github.com/o/r.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await settle()
    fireEvent.click(screen.getByTestId('world-clone-use-token'))
    esc(screen.getByTestId('world-repo-access-input'))
    expect(screen.queryByTestId('world-repo-access')).toBeNull()
    expect(screen.getByTestId('world-clone')).toBeInTheDocument()
    esc(screen.getByLabelText('Repository URL'))
    expect(screen.queryByTestId('world-clone')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('an Esc in a world opened from a dialog is the world\'s again', async () => {
    const entry: WorldEntry = { key: 'kc', source: { kind: 'git', url: 'https://x.dev/a.git', root: 'C:/data/a' }, title: 'a', lastOpened: 4 }
    await homeView({
      worldClone: vi.fn(async () => ok(entry)),
      worldTouchSource: vi.fn(async () => ok<WorldEntry | null>(entry)),
      worldUpdateSource: vi.fn(async () => ok({ changed: false })),
    })
    fireEvent.click(choice(/^Open a git repository/))
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await settle()
    expect(screen.queryByTestId('world-home')).toBeNull()
    esc(screen.getByTestId('world-view'))
    expect(viewer().resetView).toHaveBeenCalled()
  })
})
