import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import type { AskRequest, AskResult, WorldDoc, WorldEntry, WorldUpdatedEvent } from '../../../src/shared/world/types'
import type { WorldViewerOptions } from '../../../src/renderer/src/world/engine'
import { minimal } from './helpers'

// The Ask bar mounted inside the pane, wired the way App wires it. The engine is real except the WebGL
// probe and the WebGL viewer; the microphone hook is stubbed (it is not what these tests are about).
const h = vi.hoisted(() => ({ viewers: [] as any[] }))
vi.mock('../../../src/renderer/src/world/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/renderer/src/world/engine')>()
  return {
    ...real,
    hasWebGL: () => true,
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
vi.mock('../../../src/renderer/src/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ status: 'idle', errorMsg: null, notice: null, toggle: () => undefined, cancel: () => undefined }),
}))

import { WorldView } from '../../../src/renderer/src/components/World'
import type { WorldViewProps } from '../../../src/renderer/src/components/World'
import type { WorldAskLink } from '../../../src/renderer/src/components/World/WorldView'
import { WorldAsk } from '../../../src/renderer/src/components/World/WorldAsk'

type Res<T> = { success: true; data: T } | { success: false; error: string }
const ok = <T,>(data: T): Res<T> => ({ success: true, data })
const answered = (askId: string): Res<AskResult> => ok({
  askId, ok: true, answer: { text: 'It is the app [E1].', sentences: [{ text: 'It is the app [E1].', actions: [0], sep: '' }], actions: [{ type: 'reset' }], evidence: [], dropped: 0, unsupported: [], uncited: false }, summary: 's', cited: {},
} as AskResult)

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const speech = { speak: vi.fn(), cancel: vi.fn() }
let speakAnswers = false

function bridge(over: Record<string, unknown> = {}) {
  const updated = new Set<(e: WorldUpdatedEvent) => void>()
  const api = {
    gitFindRoot: vi.fn(async (cwd: string) => ok<string | null>(cwd)),
    worldSourcesList: vi.fn(async () => ok<WorldEntry[]>([])),
    worldGet: vi.fn(async (_root: string): Promise<Res<WorldDoc | null>> => ok(minimal())),
    worldCompile: vi.fn(async (): Promise<Res<WorldDoc>> => ok(minimal())),
    worldRelayout: vi.fn(async (): Promise<Res<WorldDoc>> => ok(minimal())),
    onWorldProgress: vi.fn(() => () => undefined),
    onWorldUpdated: vi.fn((cb: (e: WorldUpdatedEvent) => void) => { updated.add(cb); return () => { updated.delete(cb) } }),
    worldAsk: vi.fn(async (req: AskRequest): Promise<Res<AskResult>> => answered(req.askId)),
    worldAskCancel: vi.fn(async () => ok(true)),
    worldSettingsGet: vi.fn(async () => ok({ worldLabelling: true, worldSpeakAnswers: speakAnswers })),
    ...over,
  }
  ;(window as any).termpolis = api
  return { api, updated: async (e: WorldUpdatedEvent) => { await act(async () => { for (const cb of updated) cb(e) }) } }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const viewer = () => h.viewers[h.viewers.length - 1]
const input = () => screen.getByPlaceholderText('Ask about this project…') as HTMLInputElement
const esc = () => fireEvent.keyDown(input(), { key: 'Escape' })
/** The slot exactly as App passes it. */
const slot: NonNullable<WorldViewProps['askSlot']> = (v, d, r, link) => <WorldAsk viewer={v} doc={d} root={r ?? ''} link={link} />

async function mount(root = '/repo') {
  const onClose = vi.fn()
  const view = render(<WorldView root={root} onClose={onClose} askSlot={slot} />)
  await settle()
  return { ...view, onClose }
}
async function askQ(q = 'What is this?') {
  fireEvent.change(input(), { target: { value: q } })
  fireEvent.keyDown(input(), { key: 'Enter' })
  await settle()
}

beforeEach(() => {
  h.viewers.length = 0
  speakAnswers = false
  speech.speak.mockClear(); speech.cancel.mockClear()
  Object.defineProperty(window, 'speechSynthesis', { value: speech, configurable: true, writable: true })
  ;(window as any).SpeechSynthesisUtterance = class {
    text: string
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(t: string) { this.text = t }
  }
})
afterEach(() => {
  cleanup()
  delete (window as any).termpolis
  delete (window as any).speechSynthesis
  delete (window as any).SpeechSynthesisUtterance
})

describe('Ask bar inside the Lumopolis pane', () => {
  /** The slot's height as the page lays it out (jsdom lays nothing out): `px` for the ask slot, 0 elsewhere. */
  function slotHeight(px: { v: number }): void {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'world-ask-slot' ? px.v : 0
    })
  }

  it('keeps the strip the ask bar covers out of the fit, from its measured height, and follows it as it changes', async () => {
    const seen: Array<() => void> = []
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { seen.push(cb) }
      observe(): void {}
      disconnect(): void { disconnect() }
    })
    const px = { v: 126 }
    slotHeight(px)
    try {
      bridge()
      const view = await mount()
      // 126 tall, 16 above the bottom, 8 clear of the city.
      expect(viewer().setBottomReserve).toHaveBeenLastCalledWith(150)
      px.v = 170 // its chips wrapped, or an answer opened
      act(() => { for (const cb of seen) cb() })
      expect(viewer().setBottomReserve).toHaveBeenLastCalledWith(194)
      view.unmount()
      expect(disconnect).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })

  it('reads the height once where there is no ResizeObserver', async () => {
    const had = 'ResizeObserver' in globalThis
    const saved = (globalThis as any).ResizeObserver
    delete (globalThis as any).ResizeObserver
    slotHeight({ v: 100 })
    try {
      bridge()
      await mount()
      expect(viewer().setBottomReserve).toHaveBeenLastCalledWith(124)
    } finally {
      if (had) (globalThis as any).ResizeObserver = saved
      vi.restoreAllMocks()
    }
  })

  it('a terminal in a subfolder asks about the git root the world was drawn for', async () => {
    const b = bridge({ gitFindRoot: vi.fn(async () => ok<string | null>('/repo')) })
    await mount('/repo/src/main')
    expect(b.api.worldGet).toHaveBeenCalledWith('/repo')
    await askQ()
    expect(b.api.worldAsk).toHaveBeenCalledTimes(1)
    expect((b.api.worldAsk.mock.calls[0][0] as AskRequest).root).toBe('/repo')
  })

  it('the bar stays off until the project root is known', async () => {
    bridge({ gitFindRoot: vi.fn(() => new Promise(() => undefined)) })
    await mount('/repo/src')
    expect(input()).toBeDisabled()
  })

  it('Esc in the ask input while thinking cancels the ask and leaves the camera alone; the next Esc resets it', async () => {
    const b = bridge({ worldAsk: vi.fn(() => new Promise(() => undefined)) })
    const { onClose } = await mount()
    await askQ()
    expect(screen.getByTestId('world-ask-status').textContent).toBe('Thinking…')
    const askId = (b.api.worldAsk.mock.calls[0][0] as AskRequest).askId
    esc()
    expect(b.api.worldAskCancel).toHaveBeenCalledWith(askId)
    expect(screen.getByTestId('world-ask-status').textContent).toBe('')
    expect(screen.queryByTestId('world-ask-thinking')).toBeNull()
    expect(viewer().resetView).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // Nothing left to stop: Esc is the pane's again (reset, then close).
    esc()
    expect(viewer().resetView).toHaveBeenCalledTimes(1)
    esc()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Esc in the ask input while an answer is read aloud stops the speech and leaves the camera alone', async () => {
    speakAnswers = true
    bridge()
    const { onClose } = await mount()
    await askQ()
    expect(speech.speak).toHaveBeenCalledTimes(1)
    speech.cancel.mockClear()
    esc()
    expect(speech.cancel).toHaveBeenCalled()
    expect(viewer().resetView).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a world update mid-tour waits: the tour and the speech go on, and the new world loads once the answer is over', async () => {
    speakAnswers = true
    const first = minimal()
    const second = { ...minimal(), generatedAt: first.generatedAt + 1 }
    const b = bridge({ worldGet: vi.fn().mockResolvedValueOnce(ok(first)).mockResolvedValue(ok(second)) })
    await mount()
    const v = viewer()
    const tour = deferred<undefined>()
    v.play.mockImplementationOnce(() => tour.promise)
    await askQ()
    expect(v.play).toHaveBeenCalledWith([{ type: 'reset' }])
    expect(v.load).toHaveBeenCalledTimes(1)
    speech.cancel.mockClear()
    const cancelsBefore = v.cancelActions.mock.calls.length

    await b.updated({ root: '/repo', projectKey: first.projectKey })
    await settle()
    expect(b.api.worldGet).toHaveBeenCalledTimes(2)
    expect(v.load).toHaveBeenCalledTimes(1)
    expect(v.cancelActions).toHaveBeenCalledTimes(cancelsBefore)
    expect(speech.cancel).not.toHaveBeenCalled()

    // The tour ends; the answer is still being read, so the world still waits.
    await act(async () => { tour.resolve(undefined) })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(1)
    const u = speech.speak.mock.calls[0][0] as { onend: () => void }
    act(() => { u.onend() })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(2)
    expect(v.load).toHaveBeenLastCalledWith(second, { animateFrom: v.load.mock.calls[0][0] })
  })

  // WP4b fix round 1, M6: a status-only world stops nothing, so it need not wait for the answer; one that comes after an
  // ordinary world held back waits with it (it is the newer one, and loads as an ordinary world then).
  it('a status-only world mid-tour loads at once as statusOnly; behind a held world it waits and loads as an ordinary one', async () => {
    speakAnswers = true
    const first = minimal()
    const tested = { ...minimal(), generatedAt: first.generatedAt + 1 }
    const grown = { ...minimal(), generatedAt: first.generatedAt + 2 }
    const retested = { ...minimal(), generatedAt: first.generatedAt + 3 }
    const b = bridge({ worldGet: vi.fn().mockResolvedValueOnce(ok(first)).mockResolvedValueOnce(ok(tested)).mockResolvedValueOnce(ok(grown)).mockResolvedValue(ok(retested)) })
    await mount()
    const v = viewer()
    const tour = deferred<undefined>()
    v.play.mockImplementationOnce(() => tour.promise)
    await askQ()
    speech.cancel.mockClear()
    const cancelsBefore = v.cancelActions.mock.calls.length
    await b.updated({ root: '/repo', projectKey: first.projectKey, statusOnly: true })
    await settle()
    expect(v.load).toHaveBeenLastCalledWith(tested, { animateFrom: v.load.mock.calls[0][0], statusOnly: true })
    expect(v.cancelActions).toHaveBeenCalledTimes(cancelsBefore)
    expect(speech.cancel).not.toHaveBeenCalled()
    // An ordinary world waits for the answer, and a status-only one after it waits with it.
    await b.updated({ root: '/repo', projectKey: first.projectKey })
    await settle()
    await b.updated({ root: '/repo', projectKey: first.projectKey, statusOnly: true })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(2)
    await act(async () => { tour.resolve(undefined) })
    const u = speech.speak.mock.calls[0][0] as { onend: () => void }
    act(() => { u.onend() })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(3)
    expect(v.load).toHaveBeenLastCalledWith(retested, { animateFrom: tested })
  })

  // WP4b fix round 2, N1: the flag is the host's word; what the pane fetched may be newer. A world whose parts changed
  // between the push and the fetch (a watcher recompile landed) stops the tour, so it waits for the answer.
  it('a status-only push whose fetched world has changed parts waits for the answer, and then loads as an ordinary world', async () => {
    speakAnswers = true
    const first = minimal()
    const moved = { ...minimal(), generatedAt: first.generatedAt + 1, layout: { ...first.layout, round: 1 } }
    const b = bridge({ worldGet: vi.fn().mockResolvedValueOnce(ok(first)).mockResolvedValue(ok(moved)) })
    await mount()
    const v = viewer()
    const tour = deferred<undefined>()
    v.play.mockImplementationOnce(() => tour.promise)
    await askQ()
    await b.updated({ root: '/repo', projectKey: first.projectKey, statusOnly: true })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(1)
    await act(async () => { tour.resolve(undefined) })
    const u = speech.speak.mock.calls[0][0] as { onend: () => void }
    act(() => { u.onend() })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(2)
    expect(v.load).toHaveBeenLastCalledWith(moved, { animateFrom: v.load.mock.calls[0][0] })
  })

  it('with no answer under way a world update loads at once', async () => {
    const first = minimal()
    const second = { ...minimal(), generatedAt: first.generatedAt + 1 }
    const b = bridge({ worldGet: vi.fn().mockResolvedValueOnce(ok(first)).mockResolvedValue(ok(second)) })
    await mount()
    await b.updated({ root: '/repo', projectKey: first.projectKey })
    await settle()
    expect(viewer().load).toHaveBeenLastCalledWith(second, { animateFrom: viewer().load.mock.calls[0][0] })
  })

  it('a world held for one project is dropped when the project changes', async () => {
    const first = minimal()
    const held = { ...minimal(), generatedAt: first.generatedAt + 1 }
    const other = { ...minimal(), projectKey: 'other', generatedAt: first.generatedAt + 2 }
    let repoGets = 0
    const worldGet = vi.fn(async (root: string): Promise<Res<WorldDoc | null>> => ok(root === '/other' ? other : ++repoGets > 1 ? held : first))
    const b = bridge({ worldGet })
    const view = await mount()
    const v = viewer()
    const tour = deferred<undefined>()
    v.play.mockImplementationOnce(() => tour.promise)
    await askQ()
    await b.updated({ root: '/repo', projectKey: first.projectKey })
    await settle()
    expect(repoGets).toBe(2)
    view.rerender(<WorldView root="/other" onClose={view.onClose} askSlot={slot} />)
    await settle()
    expect(v.load).toHaveBeenLastCalledWith(other)
    await act(async () => { tour.resolve(undefined) })
    await settle()
    expect(v.load).toHaveBeenLastCalledWith(other)
    expect(v.load).not.toHaveBeenCalledWith(held)
  })

  it('closing the pane with a world held loads nothing afterwards', async () => {
    const first = minimal()
    const held = { ...minimal(), generatedAt: first.generatedAt + 1 }
    const b = bridge({ worldGet: vi.fn().mockResolvedValueOnce(ok(first)).mockResolvedValue(ok(held)) })
    const view = await mount()
    const v = viewer()
    v.play.mockImplementationOnce(() => new Promise(() => undefined))
    await askQ()
    await b.updated({ root: '/repo', projectKey: first.projectKey })
    await settle()
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    view.unmount()
    await settle()
    expect(v.load).toHaveBeenCalledTimes(1)
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('an Ask made on a first map (fix round 2, R1)', () => {
  const first = (): WorldDoc => ({ ...minimal(), provisional: true })
  const full = (): WorldDoc => ({ ...minimal(), generatedAt: minimal().generatedAt + 1 })
  const askIdOf = (b: { api: { worldAsk: ReturnType<typeof vi.fn> } }, n = 0): string => (b.api.worldAsk.mock.calls[n][0] as AskRequest).askId
  /** The answer's tour played on the viewer after it loaded `doc`, and on nothing before. */
  const playedAfterLoad = (v: any, doc: WorldDoc): void => {
    const loads = v.load.mock.calls as Array<[WorldDoc]>
    const at = loads.findIndex(([d]) => d === doc)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(v.play).toHaveBeenCalled()
    expect(v.play.mock.invocationCallOrder[0]).toBeGreaterThan(v.load.mock.invocationCallOrder[at])
  }
  const reading = () => screen.queryByTestId('world-notice')
  const exportOn = () => screen.queryByTestId('world-export') !== null

  it('a remounted pane shows the complete world the moment it is saved, while the answer is awaited, and plays the answer on it', async () => {
    const f = first()
    const c = full()
    const reply = deferred<Res<AskResult>>()
    const b = bridge({ worldGet: vi.fn(async () => ok(f)), worldAsk: vi.fn(() => reply.promise) })
    await mount()
    const v = viewer()
    expect(v.load).toHaveBeenLastCalledWith(f)
    expect(b.api.worldCompile).not.toHaveBeenCalled()
    expect(reading()).toHaveTextContent(/Still reading/)
    expect(exportOn()).toBe(false)
    await askQ()
    expect(screen.getByTestId('world-ask-status').textContent).toBe('Thinking…')
    b.api.worldGet.mockResolvedValue(ok(c))
    await b.updated({ root: '/repo', projectKey: c.projectKey })
    await settle()
    // Shown at once, though the answer is still awaited: the note and the disabled Export go with the first map.
    expect(v.load).toHaveBeenLastCalledWith(c, { animateFrom: f })
    expect(reading()).toBeNull()
    expect(exportOn()).toBe(true)
    expect(v.play).not.toHaveBeenCalled()
    await act(async () => { reply.resolve(answered(askIdOf(b))) })
    await settle()
    playedAfterLoad(v, c)
    expect(v.load).toHaveBeenCalledTimes(2)
  })

  it('an answer that comes before the saved world is pushed loads the complete world first, then plays on it', async () => {
    const f = first()
    const c = full()
    const reply = deferred<Res<AskResult>>()
    const b = bridge({ worldGet: vi.fn(async () => ok(f)), worldAsk: vi.fn(() => reply.promise) })
    await mount()
    const v = viewer()
    await askQ()
    b.api.worldGet.mockResolvedValue(ok(c))
    await act(async () => { reply.resolve(answered(askIdOf(b))) })
    await settle()
    expect(v.load).toHaveBeenLastCalledWith(c, { animateFrom: f })
    playedAfterLoad(v, c)
    expect(reading()).toBeNull()
    expect(exportOn()).toBe(true)
    // The push that follows brings the same world: nothing loads again.
    await b.updated({ root: '/repo', projectKey: c.projectKey })
    await settle()
    expect(v.load).toHaveBeenCalledTimes(2)
  })

  it('a second pane, opened on the first map while the first pane compiles, shows the complete world at once and plays its answer on it', async () => {
    const f = first()
    const c = full()
    const compile = deferred<Res<WorldDoc>>()
    const reply = deferred<Res<AskResult>>()
    const b = bridge({ worldGet: vi.fn(async () => ok<WorldDoc | null>(null)), worldCompile: vi.fn(() => compile.promise), worldAsk: vi.fn(() => reply.promise) })
    // The first pane starts the compile; its first map is pushed.
    render(<WorldView root="/repo" onClose={vi.fn()} askSlot={slot} />)
    await settle()
    expect(b.api.worldCompile).toHaveBeenCalledTimes(1)
    const one = h.viewers[0]
    b.api.worldGet.mockResolvedValue(ok(f))
    await b.updated({ root: '/repo', projectKey: f.projectKey })
    await settle()
    expect(one.load).toHaveBeenLastCalledWith(f)
    // The second pane opens on that first map, and is asked.
    render(<WorldView root="/repo" onClose={vi.fn()} askSlot={slot} />)
    await settle()
    const two = h.viewers[1]
    expect(two.load).toHaveBeenLastCalledWith(f)
    const box = screen.getAllByPlaceholderText('Ask about this project…')[1]
    fireEvent.change(box, { target: { value: 'What is this?' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await settle()
    expect(b.api.worldAsk).toHaveBeenCalledTimes(1)
    // The compile ends: the first pane shows its world, and the push reaches the second while its answer is awaited.
    b.api.worldGet.mockResolvedValue(ok(c))
    await act(async () => { compile.resolve(ok(c)) })
    await b.updated({ root: '/repo', projectKey: c.projectKey })
    await settle()
    expect(one.load).toHaveBeenLastCalledWith(c, { animateFrom: f })
    expect(two.load).toHaveBeenLastCalledWith(c, { animateFrom: f })
    expect(screen.queryAllByTestId('world-notice')).toHaveLength(0)
    expect(two.play).not.toHaveBeenCalled()
    await act(async () => { reply.resolve(answered(askIdOf(b))) })
    await settle()
    playedAfterLoad(two, c)
    expect(one.play).not.toHaveBeenCalled()
  })

  it('a project mapped from the home opens on its first map and shows the complete world at once while it is asked', async () => {
    const saved = minimal()
    const f = { ...first(), projectKey: 'mapped' }
    const c = { ...full(), projectKey: 'mapped' }
    const reply = deferred<Res<AskResult>>()
    const entry = { key: 'mapped', source: { kind: 'project', root: '/repo' }, title: 'repo', lastOpened: 1 } as WorldEntry
    const b = bridge({ worldGet: vi.fn(async () => ok<WorldDoc | null>(saved)), worldMapProject: vi.fn(async () => ok(entry)), worldAsk: vi.fn(() => reply.promise) })
    await mount()
    const v = viewer()
    const worlds = screen.getByRole('combobox', { name: 'Worlds' }) as HTMLSelectElement
    fireEvent.change(worlds, { target: { value: [...worlds.options].find((o) => o.textContent === 'Home')?.value } })
    await settle()
    expect(screen.getByTestId('world-home')).toBeInTheDocument()
    // Map this project: main starts the compile and draws its first map, which the pane opens on.
    b.api.worldGet.mockResolvedValue(ok(f))
    fireEvent.click(screen.getByRole('button', { name: /^Map this project/ }))
    await settle()
    expect(b.api.worldMapProject).toHaveBeenCalledWith('/repo')
    expect(v.load).toHaveBeenLastCalledWith(f)
    expect(b.api.worldCompile).not.toHaveBeenCalled()
    await askQ()
    b.api.worldGet.mockResolvedValue(ok(c))
    await b.updated({ root: '/repo', projectKey: 'mapped' })
    await settle()
    expect(v.load).toHaveBeenLastCalledWith(c, { animateFrom: f })
    expect(reading()).toBeNull()
    expect(v.play).not.toHaveBeenCalled()
    await act(async () => { reply.resolve(answered(askIdOf(b))) })
    await settle()
    playedAfterLoad(v, c)
  })

  it('the pane answers false to a tour waiting on a world it no longer shows: another root opened, or the pane closed (fix round 3, N4, N5)', async () => {
    for (const end of ['moved', 'closed', 'closed-while-shown', 'here'] as const) {
      const f = first()
      const c = full()
      const got = deferred<Res<WorldDoc | null>>()
      let gets = 0
      bridge({ worldGet: vi.fn((root: string) => (root === '/other' ? Promise.resolve(ok(full())) : ++gets === 1 ? Promise.resolve(ok(f)) : got.promise)) })
      let link: WorldAskLink | undefined
      const grab: NonNullable<WorldViewProps['askSlot']> = (_v, _d, _r, l) => { link = l; return null }
      const onClose = vi.fn()
      const view = render(<WorldView root="/repo" onClose={onClose} askSlot={grab} />)
      await settle()
      const v = viewer()
      expect(v.load).toHaveBeenLastCalledWith(f)
      const waiting = (link as WorldAskLink).whenComplete?.() as Promise<boolean>
      let answer: boolean | undefined
      void waiting.then((a) => { answer = a })
      await settle()
      expect(gets).toBe(2)
      if (end === 'moved') {
        // The pane renders the new root first: the box's own root change comes in a later effect.
        view.rerender(<WorldView root="/other" onClose={onClose} askSlot={grab} />)
        await settle()
      }
      if (end === 'closed') view.unmount()
      if (end === 'closed-while-shown') {
        // The complete world arrives, and the pane closes before it renders it: its waiter is let go on unmount.
        // Inside one act the pane's render of it waits for the scope to end, so the unmount comes first.
        await act(async () => {
          got.resolve(ok(c))
          for (let i = 0; i < 4; i++) await Promise.resolve()
          expect(answer).toBeUndefined()
          view.unmount()
        })
        await settle()
        expect(v.load).toHaveBeenCalledTimes(1)
      } else {
        await act(async () => { got.resolve(ok(c)) })
        await settle()
      }
      expect(answer).toBe(end === 'here')
      // The other root's own world loads; /repo's complete world, come too late, does not.
      if (end === 'moved') expect((v.load.mock.calls as Array<[WorldDoc]>).some(([d]) => d === c)).toBe(false)
      if (end === 'here') expect(v.load).toHaveBeenLastCalledWith(c, { animateFrom: f })
      cleanup()
      h.viewers.length = 0
    }
  })

  it('an answer plays on the first map when no complete world can be had, and not at all when the pane moved on or a newer question came', async () => {
    for (const end of ['provisional', 'failed', 'thrown', 'moved', 'newer'] as const) {
      const f = first()
      const replies = [deferred<Res<AskResult>>(), deferred<Res<AskResult>>()]
      const got = deferred<Res<WorldDoc | null>>()
      let gets = 0
      const b = bridge({
        worldGet: vi.fn((root: string) => (root === '/other' ? Promise.resolve(ok(full())) : ++gets === 1 ? Promise.resolve(ok(f)) : got.promise)),
        worldAsk: vi.fn(() => replies[b.api.worldAsk.mock.calls.length - 1].promise),
      })
      const view = await mount()
      const v = viewer()
      await askQ()
      await act(async () => { replies[0].resolve(answered(askIdOf(b))) })
      await settle()
      expect(gets).toBe(2) // the pane looks for the complete world
      expect(v.play).not.toHaveBeenCalled()
      if (end === 'moved') {
        view.rerender(<WorldView root="/other" onClose={view.onClose} askSlot={slot} />)
        await settle()
      }
      if (end === 'newer') {
        fireEvent.change(input(), { target: { value: 'And this?' } })
        fireEvent.keyDown(input(), { key: 'Enter' })
        await settle()
      }
      await act(async () => {
        if (end === 'thrown') got.reject(new Error('down'))
        else if (end === 'failed') got.resolve({ success: false, error: 'host down' })
        else got.resolve(ok(end === 'provisional' ? first() : full()))
      })
      await settle()
      if (end === 'provisional' || end === 'failed' || end === 'thrown') {
        expect(v.play).toHaveBeenCalledTimes(1)
        expect(v.load).toHaveBeenCalledTimes(1)
      } else {
        // Another world, or another question: the older answer's tour never plays.
        expect(v.play).not.toHaveBeenCalled()
      }
      view.unmount()
      cleanup()
      h.viewers.length = 0
    }
  })
})
