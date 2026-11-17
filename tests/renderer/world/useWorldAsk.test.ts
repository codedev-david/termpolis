import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useWorldAsk, ASK_UNREACHABLE, REFINE_UNREACHABLE } from '../../../src/renderer/src/components/World/useWorldAsk'
import type { AskRequest, AskResult } from '../../../src/shared/world/types'

type Res = { success: true; data: AskResult } | { success: false; error: string }
const answerOf = (text: string, actions: unknown[] = []) => ({ text, actions, evidence: [], dropped: 0 })
const okRes = (askId: string, text = 'Hello', over: Record<string, unknown> = {}): Res => ({
  success: true,
  data: { askId, ok: true, answer: answerOf(text, [{ type: 'reset' }]), summary: 'sum:' + text, cited: {}, ...over } as AskResult
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function makeViewer() {
  return {
    getSelection: vi.fn(() => ['b1']), cameraRegion: vi.fn(() => ['b1', 'e1']),
    play: vi.fn(async () => undefined), cancelActions: vi.fn(), apply: vi.fn(async () => undefined)
  }
}

let ask: ReturnType<typeof vi.fn>
let cancel: ReturnType<typeof vi.fn>
beforeEach(() => {
  ask = vi.fn(async (req: AskRequest) => okRes(req.askId))
  cancel = vi.fn(async () => ({ success: true, data: true }))
  ;(window as any).termpolis = { worldAsk: ask, worldAskCancel: cancel }
})
afterEach(() => { cleanup(); delete (window as any).termpolis })

describe('useWorldAsk', () => {
  it('submitting calls worldAsk with viewer.getSelection() and viewer.cameraRegion()', async () => {
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'C:/repo'))
    expect(result.current.state).toBe('idle')
    await act(async () => { result.current.ask('  What is this? ') })
    const req = ask.mock.calls[0][0] as AskRequest
    expect(req).toMatchObject({ root: 'C:/repo', question: 'What is this?', selection: ['b1'], cameraRegion: ['b1', 'e1'], summary: '' })
    expect(req.askId).toMatch(/\S/)
    expect(result.current.state).toBe('answered')
    expect(result.current.answer?.text).toBe('Hello')
  })

  it('sends the Default Models id of the Lumopolis agent; "auto" sends no model', async () => {
    localStorage.setItem('termpolis.agent.modelDefaults', JSON.stringify({ claude: 'opus' }))
    ;(window as any).termpolis.worldSettingsGet = vi.fn(async () => ({ success: true, data: { worldAgent: 'claude' } }))
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, 'r'))
    await act(async () => { result.current.ask('one') })
    expect(ask.mock.calls[0][0]).toMatchObject({ model: 'opus' })
    localStorage.setItem('termpolis.agent.modelDefaults', JSON.stringify({ claude: 'auto' }))
    await act(async () => { result.current.ask('two') })
    expect(ask.mock.calls[1][0]).not.toHaveProperty('model')
    localStorage.clear()
  })

  it('ignores a blank question and does nothing without a viewer', async () => {
    const v = makeViewer()
    const a = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { a.result.current.ask('   ') })
    const b = renderHook(() => useWorldAsk(null, 'r'))
    await act(async () => { b.result.current.ask('q') })
    expect(ask).not.toHaveBeenCalled()
    expect(a.result.current.state).toBe('idle')
  })

  it('answer actions are played via viewer.play', async () => {
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(v.play).toHaveBeenCalledWith([{ type: 'reset' }])
    expect(result.current.cited).toEqual({})
  })

  it('a play that rejects is swallowed', async () => {
    const v = makeViewer()
    v.play.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(result.current.state).toBe('answered')
  })

  it('keeps the latest summary and sends it with the next question; askIds are unique', async () => {
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('one') })
    await act(async () => { result.current.ask('two') })
    expect((ask.mock.calls[1][0] as AskRequest).summary).toBe('sum:Hello')
    expect(ask.mock.calls[0][0].askId).not.toBe(ask.mock.calls[1][0].askId)
  })

  it('new question while thinking → worldAskCancel(prev) and viewer.cancelActions()', async () => {
    const v = makeViewer()
    const d = deferred<Res>()
    ask.mockImplementationOnce(() => d.promise)
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('first') })
    expect(result.current.state).toBe('thinking')
    const firstId = ask.mock.calls[0][0].askId
    await act(async () => { result.current.ask('second') })
    expect(cancel).toHaveBeenCalledWith(firstId)
    expect(v.cancelActions).toHaveBeenCalled()
    await act(async () => { d.resolve(okRes(firstId, 'stale')) })
    expect(result.current.answer?.text).toBe('Hello')
  })

  it('late result for a cancelled askId is ignored', async () => {
    const v = makeViewer()
    const d = deferred<Res>()
    ask.mockImplementationOnce(() => d.promise)
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('first') })
    const id = ask.mock.calls[0][0].askId
    act(() => { result.current.cancel() })
    expect(result.current.state).toBe('idle')
    expect(cancel).toHaveBeenCalledWith(id)
    await act(async () => { d.resolve(okRes(id, 'late')) })
    expect(result.current.state).toBe('idle')
    expect(result.current.answer).toBeNull()
    expect(v.play).not.toHaveBeenCalled()
  })

  it('cancel while not thinking does not call worldAskCancel', () => {
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, 'r'))
    act(() => { result.current.cancel() })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('a rejected worldAskCancel is swallowed', async () => {
    cancel.mockRejectedValue(new Error('ipc'))
    const d = deferred<Res>()
    ask.mockImplementationOnce(() => d.promise)
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, 'r'))
    await act(async () => { result.current.ask('q') })
    await act(async () => { result.current.cancel() })
    expect(result.current.state).toBe('idle')
  })

  it('unmount cancels a running ask and drops its result', async () => {
    const d = deferred<Res>()
    ask.mockImplementationOnce(() => d.promise)
    const { result, unmount } = renderHook(() => useWorldAsk(makeViewer() as never, 'r'))
    await act(async () => { result.current.ask('q') })
    const id = ask.mock.calls[0][0].askId
    unmount()
    expect(cancel).toHaveBeenCalledWith(id)
    await act(async () => { d.resolve(okRes(id)) })
  })

  it('unmount with nothing running cancels nothing', () => {
    const { unmount } = renderHook(() => useWorldAsk(makeViewer() as never, 'r'))
    unmount()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('error shows message, retry re-asks the last question', async () => {
    const v = makeViewer()
    ask.mockResolvedValueOnce({ success: false, error: 'bridge down' })
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('why?') })
    expect(result.current.state).toBe('error')
    expect(result.current.error).toBe('bridge down')
    await act(async () => { result.current.retry() })
    expect(ask.mock.calls[1][0].question).toBe('why?')
    expect(result.current.state).toBe('answered')
    expect(result.current.error).toBeNull()
  })

  it('a not-ok result and a thrown ask are errors; retry before any ask does nothing', async () => {
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, 'r'))
    await act(async () => { result.current.retry() })
    expect(ask).not.toHaveBeenCalled()
    ask.mockImplementationOnce(async (req: AskRequest) => ({ success: true, data: { askId: req.askId, ok: false, error: 'not mapped' } }))
    await act(async () => { result.current.ask('a') })
    expect(result.current.error).toBe('not mapped')
    // A bridge that throws shows plain copy, never the raw error.
    ask.mockRejectedValueOnce(new Error('kaput'))
    await act(async () => { result.current.ask('b') })
    expect(result.current.error).toBe(ASK_UNREACHABLE)
    expect(ASK_UNREACHABLE).toContain('Lumopolis')
  })

  it('a cancelled result for the current ask goes back to idle', async () => {
    ask.mockImplementationOnce(async (req: AskRequest) => ({ success: true, data: { askId: req.askId, ok: false, error: 'cancelled', cancelled: true } }))
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(result.current.state).toBe('idle')
    expect(result.current.error).toBeNull()
  })

  it('a late failure of a superseded ask is ignored', async () => {
    let reject!: (e: unknown) => void
    ask.mockImplementationOnce(() => new Promise((_r, rej) => { reject = rej }))
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, 'r'))
    await act(async () => { result.current.ask('first') })
    await act(async () => { result.current.ask('second') })
    await act(async () => { reject(new Error('late boom')) })
    expect(result.current.state).toBe('answered')
    expect(result.current.error).toBeNull()
  })

  it('keeps the answer cost and a session total; a failed ask adds nothing; a root change resets it', async () => {
    const v = makeViewer()
    const { result, rerender } = renderHook(({ root }) => useWorldAsk(v as never, root), { initialProps: { root: 'A' } })
    expect(result.current.cost).toBeNull()
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'one', { tokens: 1000 }))
    await act(async () => { result.current.ask('one') })
    expect(result.current.cost).toEqual({ answer: 1000, session: 1000 })
    ask.mockImplementationOnce(async () => ({ success: false, error: 'no' }))
    await act(async () => { result.current.ask('bad') })
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'two', { tokens: 1000 }))
    await act(async () => { result.current.ask('two') })
    expect(result.current.cost).toEqual({ answer: 1000, session: 2000 })
    rerender({ root: 'B' })
    expect(result.current.cost).toBeNull()
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'three', { tokens: 300 }))
    await act(async () => { result.current.ask('three') })
    expect(result.current.cost).toEqual({ answer: 300, session: 300 })
  })

  it('a root change cancels the in-flight ask and resets summary, answer and state', async () => {
    const v = makeViewer()
    const { result, rerender } = renderHook(({ root }) => useWorldAsk(v as never, root), { initialProps: { root: 'A' } })
    await act(async () => { result.current.ask('one') })
    const d = deferred<Res>()
    ask.mockImplementationOnce(() => d.promise)
    await act(async () => { result.current.ask('two') })
    const id = ask.mock.calls[1][0].askId
    rerender({ root: 'B' })
    expect(cancel).toHaveBeenCalledWith(id)
    expect(result.current.state).toBe('idle')
    expect(result.current.answer).toBeNull()
    await act(async () => { d.resolve(okRes(id, 'stale')) })
    expect(result.current.answer).toBeNull()
    await act(async () => { result.current.ask('three') })
    expect((ask.mock.calls[2][0] as AskRequest).summary).toBe('')
    await act(async () => { result.current.retry() })
    expect(ask.mock.calls[3][0].question).toBe('three')
    rerender({ root: 'C' })
    await act(async () => { result.current.retry() })
    expect(ask).toHaveBeenCalledTimes(4)
  })

  it('dismiss clears the answer and error and goes idle', async () => {
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    act(() => { result.current.dismiss() })
    expect(result.current.state).toBe('idle')
    expect(result.current.answer).toBeNull()
  })

  it('asks nothing while the project root is not known yet', async () => {
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, ''))
    await act(async () => { result.current.ask('q') })
    expect(ask).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
  })

  it('playing is true while the answer tour runs, and replay plays it again', async () => {
    const v = makeViewer()
    const first = deferred<undefined>()
    const second = deferred<undefined>()
    v.play.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    expect(result.current.playing).toBe(false)
    await act(async () => { result.current.ask('q') })
    expect(result.current.playing).toBe(true)
    act(() => { result.current.replay() })
    expect(v.cancelActions).toHaveBeenCalledTimes(2)
    expect(v.play).toHaveBeenCalledTimes(2)
    // The first tour ending (cancelled by the replay) does not clear the replay's flag.
    await act(async () => { first.resolve(undefined) })
    expect(result.current.playing).toBe(true)
    await act(async () => { second.resolve(undefined) })
    expect(result.current.playing).toBe(false)
  })

  it('replay with no answer or no viewer does nothing; a root change clears playing', async () => {
    const v = makeViewer()
    const tour = deferred<undefined>()
    v.play.mockImplementationOnce(() => tour.promise)
    const { result, rerender } = renderHook(({ root, viewer }) => useWorldAsk(viewer as never, root), { initialProps: { root: 'A', viewer: v as unknown } })
    act(() => { result.current.replay() })
    expect(v.play).not.toHaveBeenCalled()
    await act(async () => { result.current.ask('q') })
    expect(result.current.playing).toBe(true)
    rerender({ root: 'B', viewer: v })
    expect(result.current.playing).toBe(false)
    await act(async () => { tour.resolve(undefined) })
    expect(result.current.playing).toBe(false)
    rerender({ root: 'B', viewer: null })
    act(() => { result.current.replay() })
    expect(v.play).toHaveBeenCalledTimes(1)
  })

  it('exposes the cited labels of the answer', async () => {
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'x [E1]', { cited: { E1: { kind: 'file', ref: 'a.ts' } } }))
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(result.current.cited).toEqual({ E1: { kind: 'file', ref: 'a.ts' } })
  })
})

describe('useWorldAsk on a design', () => {
  const refined = (text = 'Added Payments.', summary = 'sum:1') =>
    ({ success: true, data: { doc: { projectKey: 'design:d1' }, text, applied: 1, skipped: 0, summary } })

  it('a message changes the design: refine with the key, the running summary, the doc handed back', async () => {
    const refine = vi.fn(async () => refined())
    ;(window as any).termpolis = { worldDesignRefine: refine, worldDesignCancel: vi.fn() }
    const onDesign = vi.fn()
    // No viewer needed: a design can be changed from the 2D view.
    const { result } = renderHook(() => useWorldAsk(null, 'design:d1', onDesign))
    await act(async () => { result.current.ask(' add Payments ') })
    expect(refine).toHaveBeenCalledWith('design:d1', 'add Payments', '', undefined)
    expect(onDesign).toHaveBeenCalledWith({ projectKey: 'design:d1' })
    expect(result.current.state).toBe('answered')
    expect(result.current.answer).toEqual({ text: 'Added Payments.', actions: [], evidence: [], dropped: 0, unsupported: [], uncited: false })
    expect(result.current.cited).toEqual({})
    await act(async () => { result.current.ask('rename it') })
    expect(refine).toHaveBeenLastCalledWith('design:d1', 'rename it', 'sum:1', undefined)
  })

  it('a design change adds its tokens to the session', async () => {
    const refine = vi.fn(async () => ({ success: true, data: { ...refined().data, tokens: 800 } }))
    ;(window as any).termpolis = { worldDesignRefine: refine, worldDesignCancel: vi.fn() }
    const { result } = renderHook(() => useWorldAsk(null, 'design:d1'))
    await act(async () => { result.current.ask('one') })
    await act(async () => { result.current.ask('two') })
    expect(result.current.cost).toEqual({ answer: 800, session: 1600 })
  })

  it('works without an onDesign handler, and stops a running tour first when there is a viewer', async () => {
    ;(window as any).termpolis = { worldDesignRefine: vi.fn(async () => refined()), worldDesignCancel: vi.fn() }
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'design:d1'))
    await act(async () => { result.current.ask('more') })
    expect(v.cancelActions).toHaveBeenCalled()
    expect(v.play).not.toHaveBeenCalled()
    expect(result.current.state).toBe('answered')
  })

  it('Cancel stops the change by its design key and drops the late result', async () => {
    const d = deferred<ReturnType<typeof refined>>()
    const stop = vi.fn(async () => ({ success: true, data: true }))
    ;(window as any).termpolis = { worldDesignRefine: vi.fn(() => d.promise), worldDesignCancel: stop }
    const onDesign = vi.fn()
    const { result } = renderHook(() => useWorldAsk(null, 'design:d1', onDesign))
    act(() => { result.current.ask('add Payments') })
    expect(result.current.state).toBe('thinking')
    act(() => { result.current.cancel() })
    expect(stop).toHaveBeenCalledWith('design:d1')
    await act(async () => { d.resolve(refined()) })
    expect(onDesign).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
  })

  it('a refused change shows main\'s reason; a thrown one a fixed message', async () => {
    const refine = vi.fn().mockResolvedValueOnce({ success: false, error: 'The designer is busy.' }).mockRejectedValueOnce(new Error('x'))
    ;(window as any).termpolis = { worldDesignRefine: refine, worldDesignCancel: vi.fn() }
    const { result } = renderHook(() => useWorldAsk(null, 'design:d1'))
    await act(async () => { result.current.ask('a') })
    expect(result.current.error).toBe('The designer is busy.')
    await act(async () => { result.current.ask('b') })
    expect(result.current.state).toBe('error')
    expect(result.current.error).toBe(REFINE_UNREACHABLE)
  })
})
