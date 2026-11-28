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
        getSelection: vi.fn(() => []), cameraRegion: vi.fn(() => []), resetView: vi.fn(), setPaused: vi.fn(), requestFrame: vi.fn(), setTitle: vi.fn(), dispose: vi.fn(), setQuality: vi.fn(),
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
import { SIGNING_IN_MESSAGE } from '../../../src/renderer/src/components/World/CloneDialog'
import { UPDATING_MESSAGE } from '../../../src/renderer/src/components/World/SignInNeededNotice'
/** main's words (ipc.ts UPDATE_FAILED, gitSource.ts UNREACHABLE_MESSAGE), as the notice receives them. */
const UPDATE_FAILED = "Lumopolis couldn't update that repository. Try again."
const UNREACHABLE = "Lumopolis couldn't reach that repository. Check the address and your connection, then try again."

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
/** Whether an element or one around it is inert (jsdom keeps the property without acting on it: e2e proves the clicks). */
const inertUp = (el: Element): boolean => {
  for (let e: HTMLElement | null = el as HTMLElement; e; e = e.parentElement) if (e.inert) return true
  return false
}
/**
 * A dialog of the pane is up (A11Y fix round 1, I1): the toolbar, the map, the card and the Ask slot behind it are inert
 * under a scrim, the dialog and the pane itself are not; with no dialog up nothing in the pane is inert or dimmed.
 */
function expectModal(dialog: HTMLElement | null): void {
  const behind = [screen.getByRole('toolbar'), ...['world-canvas-host', 'world-card', 'world-ask-slot'].map((id) => screen.getByTestId(id))]
  for (const el of behind) expect(inertUp(el), el.dataset.testid ?? 'the toolbar').toBe(dialog !== null)
  expect(inertUp(screen.getByTestId('world-view'))).toBe(false)
  if (dialog === null) { expect(screen.queryByTestId('world-pane-scrim')).toBeNull(); return }
  expect(inertUp(dialog)).toBe(false)
  expect(screen.getByTestId('world-pane-scrim')).toHaveAttribute('aria-hidden', 'true')
}

beforeEach(() => {
  h.webgl = true
  h.viewers.length = 0
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
  delete (window as any).termpolis
})

describe('WorldView: the question before a design change removes a district with buildings in it (D3)', () => {
  const removals = [{ id: 'core', name: 'Core', buildings: 2 }]
  const QUESTION = "Remove Core and its 2 buildings? This can't be undone."
  const openDesign = async () => {
    bridge()
    const m = await mount('/repo')
    switchTo('design:d1')
    await settle()
    act(() => { viewer().opts.renderCard('<h2>Shop</h2>') })
    return m
  }
  const askIt = (m: Mounted): Promise<boolean> => {
    let p!: Promise<boolean>
    act(() => { p = (lastSlot(m)[3] as WorldAskLink).confirmRemoval!(removals) })
    return p
  }
  const question = () => screen.queryByRole('alertdialog', { name: QUESTION })

  it('the link asks in the pane, modal under the scrim; Remove answers yes and the pane is live again', async () => {
    const m = await openDesign()
    const answer = askIt(m)
    expect(question()).toHaveTextContent(QUESTION)
    expectModal(question())
    fireEvent.click(screen.getByTestId('world-remove-district-go'))
    await expect(answer).resolves.toBe(true)
    expect(question()).toBeNull()
    expectModal(null)
  })

  it('Cancel and Esc answer no', async () => {
    const m = await openDesign()
    const first = askIt(m)
    fireEvent.click(screen.getByTestId('world-remove-district-cancel'))
    await expect(first).resolves.toBe(false)
    const second = askIt(m)
    fireEvent.keyDown(screen.getByTestId('world-remove-district-cancel'), { key: 'Escape' })
    await expect(second).resolves.toBe(false)
    expect(question()).toBeNull()
  })

  it('a second question answers the first no; another world, the pane closing, or an ask after it closed answer no', async () => {
    const m = await openDesign()
    const first = askIt(m)
    const second = askIt(m)
    await expect(first).resolves.toBe(false)
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
    switchTo('kf')
    await settle()
    await expect(second).resolves.toBe(false)
    expect(question()).toBeNull()
    switchTo('design:d1')
    await settle()
    const third = askIt(m)
    const link = lastSlot(m)[3] as WorldAskLink
    m.unmount()
    await expect(third).resolves.toBe(false)
    await expect(link.confirmRemoval!(removals)).resolves.toBe(false)
  })

  // DSN Round 1, item 7: never two dialogs up together. A change held while Build it, Export or Documentation is open
  // waits; its question comes up once that dialog closes, and Esc on that dialog closes it without answering.
  it.each([
    ['Build it', () => fireEvent.click(screen.getByTestId('world-build-it-open')), () => screen.queryByRole('dialog', { name: 'Build it' })],
    ['Export', () => { fireEvent.click(screen.getByTestId('world-export')); fireEvent.click(screen.getByTestId('world-export-world')) }, () => screen.queryByTestId('world-export-dialog')],
    ['Documentation', () => { fireEvent.click(screen.getByTestId('world-export')); fireEvent.click(screen.getByTestId('world-export-document')) }, () => screen.queryByTestId('world-document-dialog')]
  ])('a question that comes while %s is open waits until it closes; Esc there does not answer it', async (_name, openIt, other) => {
    bridge(exportBits())
    const m = await mount('/repo')
    switchTo('design:d1')
    await settle()
    act(() => { viewer().opts.renderCard('<h2>Shop</h2>') })
    openIt()
    await settle()
    expect(other()).not.toBeNull()
    let answered: boolean | null = null
    const answer = askIt(m)
    void answer.then((yes) => { answered = yes })
    await settle()
    expect(question()).toBeNull()
    expect(screen.queryAllByRole('alertdialog')).toHaveLength(0)
    expectModal(other())
    fireEvent.keyDown(screen.getByRole('region', { name: 'Lumopolis' }), { key: 'Escape' })
    await settle()
    expect(other()).toBeNull()
    expect(answered).toBeNull()
    expect(question()).toHaveTextContent(QUESTION)
    expectModal(question())
    fireEvent.click(screen.getByTestId('world-remove-district-go'))
    await expect(answer).resolves.toBe(true)
  })

  it('the link takes a question down as a no when the box drops its change (DSN Round 1, item 8)', async () => {
    const m = await openDesign()
    const answer = askIt(m)
    expect(question()).not.toBeNull()
    act(() => { (lastSlot(m)[3] as WorldAskLink).dropRemoval!() })
    await expect(answer).resolves.toBe(false)
    expect(question()).toBeNull()
    expectModal(null)
    // With none up it does nothing.
    act(() => { (lastSlot(m)[3] as WorldAskLink).dropRemoval!() })
    expect(question()).toBeNull()
  })

  it('the link marks the design read-only when main refused the box for a newer Termpolis (DSN Round 1, item 6)', async () => {
    const m = await openDesign()
    const shown = viewer().load.mock.calls[viewer().load.mock.calls.length - 1][0]
    expect(shown.savedByNewer).not.toBe(true)
    act(() => { (lastSlot(m)[3] as WorldAskLink).readOnly!() })
    await settle()
    const marked = viewer().load.mock.calls[viewer().load.mock.calls.length - 1]
    expect(marked[0]).toEqual({ ...shown, savedByNewer: true })
    // Restyled in place: the parts are the ones the viewer holds.
    expect(marked[1]).toEqual(expect.objectContaining({ statusOnly: true }))
    const loads = viewer().load.mock.calls.length
    act(() => { (lastSlot(m)[3] as WorldAskLink).readOnly!() })
    await settle()
    expect(viewer().load.mock.calls.length).toBe(loads)
  })
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

  it('while Build it, Export, Documentation or the re-layout question is up, the pane behind it is inert under a scrim, and live again once it closes (A11Y fix round 1, I1)', async () => {
    bridge(exportBits())
    await mount('/repo')
    act(() => { viewer().opts.renderCard('<h2>Shop</h2>') })
    expectModal(null)
    // The re-layout question is the repository world's.
    fireEvent.click(screen.getByTestId('world-relayout'))
    expectModal(screen.getByRole('alertdialog', { name: 'Confirm re-layout' }))
    fireEvent.click(screen.getByTestId('world-relayout-cancel'))
    expectModal(null)
    switchTo('design:d1')
    await settle()
    act(() => { viewer().opts.renderCard('<h2>Shop</h2>') })
    fireEvent.click(screen.getByTestId('world-build-it-open'))
    expectModal(screen.getByRole('dialog', { name: 'Build it' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expectModal(null)
    for (const kind of ['world', 'document'] as const) {
      fireEvent.click(screen.getByTestId('world-export'))
      fireEvent.click(screen.getByTestId(`world-export-${kind}`))
      await settle()
      expectModal(screen.getByTestId(`world-${kind === 'world' ? 'export' : 'document'}-dialog`))
      // Re-layout is greyed too: a second dialog never opens beside this one.
      expect(screen.getByTestId('world-relayout')).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expectModal(null)
    }
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
  const gitBridge = (update: unknown, over: Record<string, unknown> = {}, entry: WorldEntry = GIT) => bridge({
    worldSourcesList: vi.fn(async () => ok<WorldEntry[]>([entry])),
    worldTouchSource: vi.fn(async () => ok<WorldEntry | null>(entry)),
    worldUpdateSource: vi.fn(async () => update),
    worldUpdateCancel: vi.fn(async () => ok(true)),
    ...over,
  })
  /** The next update answers only when the test says. */
  const hangNext = (api: Record<string, ReturnType<typeof vi.fn>>) => {
    let answer!: (v: unknown) => void
    api.worldUpdateSource.mockImplementationOnce(() => new Promise((res) => { answer = res }))
    return (v: unknown) => act(async () => { answer(v) })
  }
  const STOPPED = 'Lumopolis stopped updating this repository.'

  // WP4b F-R6: a Sign in or token try can be stopped; the notice then says it stopped.
  it('while a Sign in runs, Stop takes Dismiss\'s place and the focus; it stops that update once and says so', async () => {
    const api = gitBridge(ok(NEEDS))
    await openGit()
    const answer = hangNext(api)
    const signIn = screen.getByRole('button', { name: 'Sign in to GitHub' })
    signIn.focus()
    fireEvent.click(signIn)
    const notice = screen.getByTestId('world-sign-in-needed')
    expect(signIn).toBeDisabled()
    expect(within(notice).getByRole('button', { name: 'Use a token' })).toBeDisabled()
    expect(within(notice).queryByRole('button', { name: 'Dismiss' })).toBeNull()
    const stop = within(notice).getByRole('button', { name: 'Stop' })
    expect(stop).toHaveFocus()
    fireEvent.click(stop)
    expect(api.worldUpdateCancel).toHaveBeenCalledWith('kgit')
    const stopping = within(notice).getByRole('button', { name: 'Stopping…' })
    expect(stopping).toBeDisabled()
    fireEvent.click(stopping)
    expect(api.worldUpdateCancel).toHaveBeenCalledTimes(1)
    await answer(fail(STOPPED))
    await settle()
    expect(within(notice).getByRole('alert')).toHaveTextContent(STOPPED)
    expect(within(notice).getByRole('button', { name: 'Dismiss' })).toBeEnabled()
    // The focus Stop had goes back to the first choice.
    expect(screen.getByRole('button', { name: 'Sign in to GitHub' })).toHaveFocus()
  })

  // WP4b fix round 1, M5: a try says what it is doing, and Stop never drops the focus to the page.
  it('while a Sign in runs the notice says it is signing in; Try again says it is updating; a token try leaves the words to its dialog', async () => {
    const api = gitBridge(ok(NEEDS))
    await openGit()
    const answer = hangNext(api)
    const notice = screen.getByTestId('world-sign-in-needed')
    expect(within(notice).queryByTestId('world-sign-in-progress')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }))
    expect(within(notice).getByTestId('world-sign-in-progress')).toHaveTextContent(SIGNING_IN_MESSAGE)
    await answer(ok(NEEDS))
    await settle()
    expect(within(notice).queryByTestId('world-sign-in-progress')).toBeNull()
    // A token try: its dialog is up and the notice behind it says nothing more.
    fireEvent.click(screen.getByRole('button', { name: 'Use a token' }))
    const tok = hangNext(api)
    fireEvent.change(screen.getByTestId('world-repo-access-input'), { target: { value: 'ghp_x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this token' }))
    expect(screen.queryByTestId('world-sign-in-progress')).toBeNull()
    await tok(ok({ changed: false }))
    await settle()
  })

  it('Try again on a failed update says it is updating until the update answers', async () => {
    const api = gitBridge(fail(UNREACHABLE))
    await openGit()
    const answer = hangNext(api)
    const notice = screen.getByTestId('world-sign-in-needed')
    fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }))
    expect(within(notice).getByTestId('world-sign-in-progress')).toHaveTextContent(UPDATING_MESSAGE)
    await answer(fail(UNREACHABLE))
    await settle()
    expect(within(notice).queryByTestId('world-sign-in-progress')).toBeNull()
  })

  it('pressing Stop keeps the focus in the notice until the stop answers, then gives it to the first choice', async () => {
    for (const how of ['moved', 'tabbed'] as const) {
      const api = gitBridge(ok(NEEDS))
      await openGit()
      const answer = hangNext(api)
      const signIn = screen.getByRole('button', { name: 'Sign in to GitHub' })
      // moved: the pressed choice had the focus, so Stop took it; tabbed: the person moved to Stop themselves.
      if (how === 'moved') signIn.focus()
      fireEvent.click(signIn)
      const notice = screen.getByTestId('world-sign-in-needed')
      const stop = within(notice).getByRole('button', { name: 'Stop' })
      if (how === 'tabbed') stop.focus()
      expect(stop).toHaveFocus()
      fireEvent.click(stop)
      // Stopping… is grey: the notice holds the focus, so Tab and Esc still start from it, never from the page.
      expect(within(notice).getByRole('button', { name: 'Stopping…' })).toBeDisabled()
      expect(notice).toHaveFocus()
      expect(notice.tabIndex).toBe(-1)
      await answer(fail(STOPPED))
      await settle()
      expect(screen.getByRole('button', { name: 'Sign in to GitHub' }), how).toHaveFocus()
      cleanup()
    }
  })

  // WP4b fix round 2 (M5 note): the notice can hold the focus, so it is named by its own words for a screen reader.
  it('the notice is named by its words, so a screen reader says where the focus went', async () => {
    gitBridge(ok(NEEDS))
    await openGit()
    const notice = screen.getByTestId('world-sign-in-needed')
    const words = notice.querySelector('span') as HTMLSpanElement
    expect(words.id).not.toBe('')
    expect(notice).toHaveAttribute('aria-labelledby', words.id)
    expect(notice).toHaveAccessibleName(words.textContent as string)
    expect(screen.getByRole('status', { name: words.textContent as string })).toBe(notice)
  })

  it('a stop pressed while the focus is elsewhere leaves it there', async () => {
    const api = gitBridge(ok(NEEDS))
    await openGit()
    const answer = hangNext(api)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }))
    const map2d = screen.getByTestId('world-map2d')
    map2d.focus()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(map2d).toHaveFocus()
    await answer(fail(STOPPED))
    await settle()
    expect(map2d).toHaveFocus()
  })

  it('a try that ends while the focus is elsewhere leaves the focus where the person put it', async () => {
    const api = gitBridge(ok(NEEDS))
    await openGit()
    const answer = hangNext(api)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }))
    expect(screen.getByRole('button', { name: 'Stop' })).not.toHaveFocus()
    await answer(ok(NEEDS))
    await settle()
    expect(screen.getByRole('button', { name: 'Sign in to GitHub' })).not.toHaveFocus()
    // Stop took the focus, then the person moved it on: it stays there when the try ends.
    const again = hangNext(api)
    const signIn = screen.getByRole('button', { name: 'Sign in to GitHub' })
    signIn.focus()
    fireEvent.click(signIn)
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveFocus()
    const map2d = screen.getByTestId('world-map2d')
    map2d.focus()
    await again(ok(NEEDS))
    await settle()
    expect(map2d).toHaveFocus()
  })

  it('cancelling the token dialog, or Esc in it, while its token is tried stops that update', async () => {
    const api = gitBridge(ok(NEEDS))
    await openGit()
    for (const close of ['cancel', 'esc'] as const) {
      fireEvent.click(screen.getByRole('button', { name: 'Use a token' }))
      const answer = hangNext(api)
      fireEvent.change(screen.getByTestId('world-repo-access-input'), { target: { value: 'ghp_x' } })
      fireEvent.click(screen.getByRole('button', { name: 'Use this token' }))
      if (close === 'cancel') fireEvent.click(within(screen.getByTestId('world-repo-access')).getByRole('button', { name: 'Cancel' }))
      else fireEvent.keyDown(screen.getByTestId('world-repo-access-input'), { key: 'Escape' })
      expect(screen.queryByTestId('world-repo-access')).toBeNull()
      await answer(fail(STOPPED))
      await settle()
      expect(within(screen.getByTestId('world-sign-in-needed')).getByRole('alert')).toHaveTextContent(STOPPED)
    }
    expect(api.worldUpdateCancel).toHaveBeenCalledTimes(2)
    // Closing it with no try running stops nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Use a token' }))
    fireEvent.click(within(screen.getByTestId('world-repo-access')).getByRole('button', { name: 'Cancel' }))
    expect(api.worldUpdateCancel).toHaveBeenCalledTimes(2)
  })

  // WP4b F-R7: a background update that failed is said, with Try again; a token repository offers Update with a token.
  it('a failed background update says so in main\'s words over the saved copy, and Try again runs it again', async () => {
    const api = gitBridge(fail('Lumopolis could not reach github.com.'))
    await openGit()
    const notice = screen.getByTestId('world-sign-in-needed')
    expect(notice).toHaveTextContent("Lumopolis could not reach github.com. You're seeing the saved copy.")
    expect(within(notice).queryByRole('button', { name: /Sign in|Use a token/ })).toBeNull()
    api.worldUpdateSource.mockResolvedValueOnce(ok({ changed: true }))
    fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }))
    await settle()
    expect(api.worldUpdateSource).toHaveBeenLastCalledWith('kgit')
    expect(screen.queryByTestId('world-sign-in-needed')).toBeNull()
  })

  // WP4b fix round 1, M4: the Try again button carries the action, so the words never say "Try again." beside it.
  it('a failed update never says "Try again." beside the Try again button; words that say when or how to try again stay', async () => {
    const said = [
      [UPDATE_FAILED, "Lumopolis couldn't update that repository. You're seeing the saved copy."],
      [UNREACHABLE, `${UNREACHABLE} You're seeing the saved copy.`],
      ["Lumopolis couldn't save that repository. Try again in a moment.", "Lumopolis couldn't save that repository. Try again in a moment. You're seeing the saved copy."]
    ] as const
    for (const [error, words] of said) {
      gitBridge(fail(error))
      await openGit()
      const notice = screen.getByTestId('world-sign-in-needed')
      expect(notice.querySelector('span')?.textContent, error).toBe(words)
      expect(within(notice).getAllByRole('button').map((b) => b.textContent)).toEqual(['Try again', 'Dismiss'])
      cleanup()
    }
    // A Try again that fails again says so under the words, and that line does not say "Try again." beside the button
    // either; nor does one main could not be asked for.
    for (const again of [fail(UPDATE_FAILED), 'rejected'] as const) {
      const api = gitBridge(fail(UPDATE_FAILED))
      await openGit()
      const answer = hangNext(api)
      const notice = screen.getByTestId('world-sign-in-needed')
      fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }))
      if (again === 'rejected') await answer(Promise.reject(new Error('ipc')) as never)
      else await answer(again)
      await settle()
      expect(within(notice).getByRole('alert'), String(again)).toHaveTextContent(/^Lumopolis couldn't update that repository\.$/)
      expect(within(notice).getAllByRole('button').map((b) => b.textContent)).toEqual(['Try again', 'Dismiss'])
      cleanup()
    }
    // An update main could not be asked for (the bridge rejected) reads the same.
    gitBridge(ok(NEEDS), { worldUpdateSource: vi.fn(async () => { throw new Error('ipc') }) })
    await openGit()
    expect(screen.getByTestId('world-sign-in-needed').querySelector('span')?.textContent).toBe("Lumopolis couldn't update that repository. You're seeing the saved copy.")
  })

  it('a repository opened with a token offers Update with a token, which updates with the token given', async () => {
    const TOK: WorldEntry = { ...GIT, source: { ...GIT.source, login: 'token' } as WorldEntry['source'] }
    const api = gitBridge(ok({ changed: false }), {}, TOK)
    await openGit()
    expect(api.worldUpdateSource).not.toHaveBeenCalled()
    const notice = screen.getByTestId('world-sign-in-needed')
    expect(notice).toHaveTextContent("Lumopolis updates this repository only with a token you give it. You're seeing the saved copy.")
    fireEvent.click(within(notice).getByRole('button', { name: 'Update with a token' }))
    expect(within(screen.getByTestId('world-repo-access')).getByRole('button', { name: 'Make a token on GitHub' })).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('world-repo-access-input'), { target: { value: 'ghp_x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this token' }))
    await settle()
    expect(api.worldUpdateSource).toHaveBeenCalledWith('kgit', { mode: 'token', value: 'ghp_x' })
    expect(screen.queryByTestId('world-sign-in-needed')).toBeNull()
  })

  const openGit = async () => {
    await mount('')
    fireEvent.click(screen.getByRole('button', { name: 'Open rrepo' }))
    await settle()
  }

  it('while the token dialog is up, the pane behind it is inert under a scrim, the notice too, and live again once it closes (A11Y fix round 1, I1)', async () => {
    gitBridge(ok(NEEDS))
    await openGit()
    act(() => { viewer().opts.renderCard('<h2>Shop</h2>') })
    expectModal(null)
    expect(inertUp(screen.getByTestId('world-sign-in-needed'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Use a token' }))
    expectModal(screen.getByRole('dialog', { name: 'Use a token' }))
    expect(inertUp(screen.getByTestId('world-sign-in-needed'))).toBe(true)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Use a token' })).getByRole('button', { name: 'Cancel' }))
    expectModal(null)
    expect(inertUp(screen.getByTestId('world-sign-in-needed'))).toBe(false)
  })

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

  it('Dismiss gives way to Stop while a retry runs', async () => {
    const api = gitBridge(ok(NEEDS))
    await openGit()
    let release!: (v: unknown) => void
    api.worldUpdateSource.mockImplementationOnce(() => new Promise((res) => { release = res }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }))
    await settle()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
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
