import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import type { AskRequest, AskResult, WorldDoc, WorldUpdatedEvent } from '../../../src/shared/world/types'
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
vi.mock('../../../src/renderer/src/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ status: 'idle', errorMsg: null, toggle: () => undefined }),
}))

import { WorldView } from '../../../src/renderer/src/components/World'
import type { WorldViewProps } from '../../../src/renderer/src/components/World'
import { WorldAsk } from '../../../src/renderer/src/components/World/WorldAsk'

type Res<T> = { success: true; data: T } | { success: false; error: string }
const ok = <T,>(data: T): Res<T> => ({ success: true, data })
const answered = (askId: string): Res<AskResult> => ok({
  askId, ok: true, answer: { text: 'It is the app [E1].', actions: [{ type: 'reset' }], evidence: [], dropped: 0 }, summary: 's', cited: {},
} as AskResult)

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const speech = { speak: vi.fn(), cancel: vi.fn() }
let speakAnswers = false

function bridge(over: Record<string, unknown> = {}) {
  const updated = new Set<(e: WorldUpdatedEvent) => void>()
  const api = {
    gitFindRoot: vi.fn(async (cwd: string) => ok<string | null>(cwd)),
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
    expect(screen.getByRole('status')).toHaveTextContent('Thinking')
    const askId = (b.api.worldAsk.mock.calls[0][0] as AskRequest).askId
    esc()
    expect(b.api.worldAskCancel).toHaveBeenCalledWith(askId)
    expect(screen.queryByRole('status')).toBeNull()
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
    expect(v.load).toHaveBeenLastCalledWith(second)
  })

  it('with no answer under way a world update loads at once', async () => {
    const first = minimal()
    const second = { ...minimal(), generatedAt: first.generatedAt + 1 }
    const b = bridge({ worldGet: vi.fn().mockResolvedValueOnce(ok(first)).mockResolvedValue(ok(second)) })
    await mount()
    await b.updated({ root: '/repo', projectKey: first.projectKey })
    await settle()
    expect(viewer().load).toHaveBeenLastCalledWith(second)
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
