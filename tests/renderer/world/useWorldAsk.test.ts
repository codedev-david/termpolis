import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useWorldAsk, ASK_UNREACHABLE, REFINE_UNREACHABLE, DESIGN_LEFT_AS_IT_WAS } from '../../../src/renderer/src/components/World/useWorldAsk'
import type { AskRequest, AskResult } from '../../../src/shared/world/types'

type Res = { success: true; data: AskResult } | { success: false; error: string }
const answerOf = (text: string, actions: unknown[] = []) => ({ text, sentences: [{ text, actions: actions.map((_, i) => i) }], actions, evidence: [], dropped: 0 })
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

  it('sends the proposal id on show with the question, and none when there is none', async () => {
    const v = makeViewer()
    const { result, rerender } = renderHook(({ id }: { id?: string }) => useWorldAsk(v as never, 'C:/repo', undefined, id), { initialProps: { id: 'p1' } as { id?: string } })
    await act(async () => { result.current.ask('one') })
    expect((ask.mock.calls[0][0] as AskRequest).proposalId).toBe('p1')
    rerender({ id: undefined })
    await act(async () => { result.current.ask('two') })
    expect('proposalId' in (ask.mock.calls[1][0] as AskRequest)).toBe(false)
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

  it('waits for the pane before the tour, and plays none when the pane answers that it moved on (fix round 3, N5)', async () => {
    for (const go of [true, undefined, false]) {
      const v = makeViewer()
      const ready = deferred<boolean | undefined>()
      const whenComplete = vi.fn(() => ready.promise as Promise<boolean | void>)
      const { result, unmount } = renderHook(() => useWorldAsk(v as never, 'r', undefined, undefined, whenComplete))
      await act(async () => { result.current.ask('q') })
      expect(whenComplete).toHaveBeenCalledTimes(1)
      expect(v.play).not.toHaveBeenCalled()
      await act(async () => { ready.resolve(go) })
      // The root this box was given is unchanged: only the pane's answer says whether it moved on.
      expect(v.play).toHaveBeenCalledTimes(go === false ? 0 : 1)
      expect(result.current.state).toBe('answered')
      unmount()
    }
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

  it('carries why an answer was made without the project memory, and clears it on the next ask, a dismissal and a root change (WPA)', async () => {
    const v = makeViewer()
    const { result, rerender } = renderHook(({ root }) => useWorldAsk(v as never, root), { initialProps: { root: 'A' } })
    expect(result.current.noMemory).toBeNull()
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'one', { noMemory: 'timeout' }))
    await act(async () => { result.current.ask('one') })
    expect(result.current.noMemory).toBe('timeout')
    await act(async () => { result.current.ask('two') })
    expect(result.current.noMemory).toBeNull()
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'three', { noMemory: 'locked' }))
    await act(async () => { result.current.ask('three') })
    expect(result.current.noMemory).toBe('locked')
    act(() => { result.current.dismiss() })
    expect(result.current.noMemory).toBeNull()
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'four', { noMemory: 'down' }))
    await act(async () => { result.current.ask('four') })
    expect(result.current.noMemory).toBe('down')
    rerender({ root: 'B' })
    expect(result.current.noMemory).toBeNull()
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
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'x [E1]', { cited: { E1: { kind: 'file', ref: 'a.ts', items: ['b1'] } } }))
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(result.current.cited).toEqual({ E1: { kind: 'file', ref: 'a.ts', items: ['b1'] } })
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
    expect(result.current.answer).toEqual({ text: 'Added Payments.', sentences: [{ text: 'Added Payments.', actions: [], sep: '' }], actions: [], evidence: [], dropped: 0, unsupported: [], uncited: false })
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

describe('useWorldAsk: a change that removes a district with buildings in it waits for a yes (D3)', () => {
  const removals = [{ id: 'core', name: 'Core', buildings: 2 }]
  const held = { success: true, data: { doc: { projectKey: 'design:d1', v: 'before' }, text: 'Removed Core.', applied: 0, skipped: 0, summary: 'sum:held', tokens: 900, confirm: { removals, id: 'c1' } } }
  const made = { success: true, data: { doc: { projectKey: 'design:d1', v: 'after' }, text: 'Removed Core.', applied: 1, skipped: 0, summary: 'sum:held', tokens: 0 } }
  const api = (over: Record<string, unknown> = {}) => {
    const t = { worldDesignRefine: vi.fn(async () => held), worldDesignConfirm: vi.fn(async () => made), worldDesignCancel: vi.fn(async () => ({ success: true, data: true })), ...over }
    ;(window as any).termpolis = t
    return t
  }

  it('asks the pane with the removals; a yes makes the change, draws it and counts the agent run once', async () => {
    const t = api()
    const onDesign = vi.fn()
    const ask = vi.fn(async () => true)
    const { result } = renderHook(() => useWorldAsk(null, 'design:d1', onDesign, undefined, undefined, ask))
    await act(async () => { result.current.ask('remove Core') })
    expect(ask).toHaveBeenCalledWith(removals)
    // The yes names the change it answers, so it never makes a newer one (DSN Round 1, item 2).
    expect(t.worldDesignConfirm).toHaveBeenCalledWith('design:d1', 'c1')
    expect(t.worldDesignCancel).not.toHaveBeenCalled()
    expect(onDesign).toHaveBeenCalledTimes(1)
    expect(onDesign).toHaveBeenCalledWith(made.data.doc)
    expect(result.current.state).toBe('answered')
    expect(result.current.answer?.text).toBe('Removed Core.')
    expect(result.current.cost).toEqual({ answer: 900, session: 900 })
    // The next change carries the summary the confirmed change returned.
    t.worldDesignRefine.mockResolvedValueOnce({ success: true, data: { ...made.data, summary: 'sum:2', tokens: 5 } } as never)
    await act(async () => { result.current.ask('next') })
    expect(t.worldDesignRefine).toHaveBeenLastCalledWith('design:d1', 'next', 'sum:held', undefined)
  })

  it('a no lets main drop the held change, draws nothing and says the design was left as it was', async () => {
    const t = api()
    const onDesign = vi.fn()
    const { result } = renderHook(() => useWorldAsk(null, 'design:d1', onDesign, undefined, undefined, async () => false))
    await act(async () => { result.current.ask('remove Core') })
    expect(t.worldDesignConfirm).not.toHaveBeenCalled()
    expect(t.worldDesignCancel).toHaveBeenCalledWith('design:d1')
    expect(onDesign).not.toHaveBeenCalled()
    expect(result.current.state).toBe('answered')
    expect(result.current.answer?.text).toBe(DESIGN_LEFT_AS_IT_WAS)
    expect(result.current.cost).toEqual({ answer: 900, session: 900 })
    // The summary is not moved on by a change that was not made.
    await act(async () => { result.current.ask('again') })
    expect(t.worldDesignRefine).toHaveBeenLastCalledWith('design:d1', 'again', '', undefined)
  })

  it('with no one to ask (the box on its own) the change is never made, and a cancel that fails is not shown', async () => {
    const t = api({ worldDesignCancel: vi.fn(async () => { throw new Error('gone') }) })
    const { result } = renderHook(() => useWorldAsk(null, 'design:d1'))
    await act(async () => { result.current.ask('remove Core') })
    expect(t.worldDesignConfirm).not.toHaveBeenCalled()
    expect(result.current.answer?.text).toBe(DESIGN_LEFT_AS_IT_WAS)
  })

  it('a change cancelled or replaced while the question is up is dropped, whatever the answer', async () => {
    const t = api()
    const d = deferred<boolean>()
    const onDesign = vi.fn()
    const { result } = renderHook(() => useWorldAsk(null, 'design:d1', onDesign, undefined, undefined, () => d.promise))
    await act(async () => { result.current.ask('remove Core') })
    expect(result.current.state).toBe('thinking')
    act(() => { result.current.cancel() })
    await act(async () => { d.resolve(true) })
    expect(t.worldDesignConfirm).not.toHaveBeenCalled()
    expect(onDesign).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
  })

  it("a yes whose change main then refuses shows main's reason, one that throws a fixed message, and a late one is dropped", async () => {
    const t = api({ worldDesignConfirm: vi.fn().mockResolvedValueOnce({ success: false, error: 'The design changed.' }).mockRejectedValueOnce(new Error('x')) })
    const { result } = renderHook(() => useWorldAsk(null, 'design:d1', undefined, undefined, undefined, async () => true))
    await act(async () => { result.current.ask('a') })
    expect(result.current.error).toBe('The design changed.')
    await act(async () => { result.current.ask('b') })
    expect(result.current.error).toBe(REFINE_UNREACHABLE)
    const late = deferred<typeof made>()
    t.worldDesignConfirm.mockImplementationOnce(() => late.promise)
    const onDesign = vi.fn()
    const r2 = renderHook(() => useWorldAsk(null, 'design:d1', onDesign, undefined, undefined, async () => true))
    await act(async () => { r2.result.current.ask('c') })
    act(() => { r2.result.current.cancel() })
    await act(async () => { late.resolve(made) })
    expect(onDesign).not.toHaveBeenCalled()
    expect(r2.result.current.state).toBe('idle')
  })

  it.each(['a newer ask', 'a cancel', 'another world'])('%s while the question is up takes the question down, as a no (DSN Round 1, item 8)', async (what) => {
    const t = api()
    const d = deferred<boolean>()
    const drop = vi.fn(() => d.resolve(false))
    const { result, rerender } = renderHook(({ key }) => useWorldAsk(null, key, undefined, undefined, undefined, () => d.promise, drop), { initialProps: { key: 'design:d1' } })
    await act(async () => { result.current.ask('remove Core') })
    expect(drop).not.toHaveBeenCalled()
    t.worldDesignRefine.mockResolvedValueOnce(made as never)
    await act(async () => {
      if (what === 'a newer ask') result.current.ask('rename the API')
      else if (what === 'a cancel') result.current.cancel()
      else rerender({ key: 'design:d2' })
    })
    expect(drop).toHaveBeenCalledTimes(1)
    expect(t.worldDesignConfirm).not.toHaveBeenCalled()
    // Once the question is down, another cancel asks the pane nothing more.
    act(() => { result.current.cancel() })
    expect(drop).toHaveBeenCalledTimes(1)
  })

  it('an ask with no question up asks the pane to take nothing down', async () => {
    api()
    const drop = vi.fn()
    const { result } = renderHook(() => useWorldAsk(null, 'design:d1', undefined, undefined, undefined, async () => false, drop))
    await act(async () => { result.current.ask('remove Core') })
    await act(async () => { result.current.ask('again') })
    act(() => { result.current.cancel() })
    expect(drop).not.toHaveBeenCalled()
  })
})

describe('useWorldAsk reveal', () => {
  const sentences = [{ text: 'One two.', actions: [0], sep: '' }, { text: 'Three four five six seven eight nine ten.', actions: [1], sep: ' ' }, { text: 'Last.', actions: [], sep: ' ' }]
  const actions = [{ type: 'focus', ids: ['b1'] }, { type: 'flow', edgeIds: ['e1'] }]
  const revealing = (askId: string, over: Record<string, unknown> = {}): Res => ({
    success: true,
    data: { askId, ok: true, answer: { text: 'One two. Three four five six seven eight nine ten. Last.', sentences, actions, evidence: [], dropped: 0, unsupported: [], uncited: false }, summary: 's', cited: {}, ...over } as AskResult
  })
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ask.mockImplementation(async (req: AskRequest) => revealing(req.askId))
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (window as any).matchMedia
  })

  it('reveals sentence 1 and plays focus b1, then after the reveal time sentence 2 and flow e1', async () => {
    const order: string[] = []
    const v = makeViewer()
    v.play.mockImplementation(async (steps: unknown[]) => { order.push(`play ${(steps[0] as { type: string }).type}`) })
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(result.current.revealed).toBe(1)
    expect(order).toEqual(['play focus'])
    expect(result.current.playing).toBe(true)
    await tick(599)
    expect(result.current.revealed).toBe(1)
    await tick(1)
    expect(result.current.revealed).toBe(2)
    expect(order).toEqual(['play focus', 'play flow'])
    // Sentence 2 has eight words: 560 ms is under the 600 ms floor, so the floor applies.
    await tick(600)
    expect(result.current.revealed).toBe(3)
    expect(order).toHaveLength(2)
    expect(result.current.playing).toBe(false)
  })

  it('a new question during the reveal stops it and plays nothing more from the old answer', async () => {
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(v.play).toHaveBeenCalledTimes(1)
    ask.mockImplementationOnce(() => new Promise(() => undefined))
    await act(async () => { result.current.ask('next') })
    expect(result.current.playing).toBe(false)
    await tick(5000)
    expect(v.play).toHaveBeenCalledTimes(1)
  })

  it('the viewer going mid-reveal (lost graphics, the 2D map) stops its steps and shows the rest of the text (M2)', async () => {
    const v = makeViewer()
    const { result, rerender } = renderHook(({ on }) => useWorldAsk(on as never, 'r'), { initialProps: { on: v as unknown } })
    await act(async () => { result.current.ask('q') })
    expect(v.play).toHaveBeenCalledTimes(1)
    expect(result.current.playing).toBe(true)
    rerender({ on: null })
    expect(result.current.playing).toBe(false)
    expect(result.current.revealed).toBe(3)
    await tick(5000)
    expect(v.play).toHaveBeenCalledTimes(1)
    // back again: nothing restarts by itself, and the same viewer is no change
    rerender({ on: v })
    rerender({ on: v })
    await tick(5000)
    expect(v.play).toHaveBeenCalledTimes(1)
    expect(result.current.revealed).toBe(3)
  })

  it('an answer that comes back after its viewer went shows whole and plays nothing on it (M2)', async () => {
    const v = makeViewer()
    let answer: (r: Res) => void = () => undefined
    ask.mockImplementationOnce(() => new Promise<Res>((res) => { answer = res }))
    const { result, rerender } = renderHook(({ on }) => useWorldAsk(on as never, 'r'), { initialProps: { on: v as unknown } })
    await act(async () => { result.current.ask('q') })
    expect(result.current.state).toBe('thinking')
    rerender({ on: null })
    await act(async () => { answer(revealing((ask.mock.calls[ask.mock.calls.length - 1][0] as AskRequest).askId)) })
    expect(result.current.state).toBe('answered')
    expect(result.current.revealed).toBe(3)
    expect(result.current.playing).toBe(false)
    await tick(5000)
    expect(v.play).not.toHaveBeenCalled()
    expect(v.apply).not.toHaveBeenCalled()
  })

  it('unmounting and dismissing clear the reveal', async () => {
    const v = makeViewer()
    const a = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { a.result.current.ask('q') })
    a.unmount()
    await tick(5000)
    expect(v.play).toHaveBeenCalledTimes(1)
    const b = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { b.result.current.ask('q') })
    act(() => { b.result.current.dismiss() })
    expect(b.result.current.playing).toBe(false)
    await tick(5000)
    expect(v.play).toHaveBeenCalledTimes(2)
  })

  it('reduced motion reveals every sentence with no wait', async () => {
    ;(window as any).matchMedia = vi.fn(() => ({ matches: true }))
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(result.current.revealed).toBe(1)
    await tick(0)
    expect(result.current.revealed).toBe(2)
    await tick(1)
    expect(result.current.revealed).toBe(3)
    expect(v.play).toHaveBeenCalledTimes(2)
  })

  it('a failing media query counts as full motion, and a plain one too', async () => {
    ;(window as any).matchMedia = vi.fn(() => { throw new Error('no') })
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    await tick(0)
    expect(result.current.revealed).toBe(1)
    ;(window as any).matchMedia = vi.fn(() => ({ matches: false }))
    await act(async () => { result.current.ask('q2') })
    await tick(0)
    expect(result.current.revealed).toBe(1)
  })

  it('replay replays the same schedule', async () => {
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    await tick(1200)
    expect(result.current.revealed).toBe(3)
    expect(v.play).toHaveBeenCalledTimes(2)
    act(() => { result.current.replay() })
    expect(result.current.revealed).toBe(1)
    expect(v.play).toHaveBeenCalledTimes(3)
    await tick(600)
    expect(result.current.revealed).toBe(2)
    expect(v.play).toHaveBeenCalledTimes(4)
    expect(v.play).toHaveBeenLastCalledWith([{ type: 'flow', edgeIds: ['e1'] }])
  })

  it('an answer with no sentences plays nothing and is not playing; a design reply is shown whole', async () => {
    ask.mockImplementationOnce(async (req: AskRequest) => revealing(req.askId, { answer: { text: '', sentences: [], actions: [], evidence: [], dropped: 0, unsupported: [], uncited: false } }))
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(v.play).not.toHaveBeenCalled()
    expect(result.current.playing).toBe(false)
    expect(result.current.revealed).toBe(0)
  })
})

describe('useWorldAsk: cancels, closes and view switches that land mid-flight (U3, U5, U6, U9)', () => {
  const sentences = [{ text: 'One two.', actions: [0], sep: '' }, { text: 'Three four.', actions: [1], sep: ' ' }, { text: 'Last.', actions: [], sep: ' ' }]
  const actions = [{ type: 'focus', ids: ['b1'] }, { type: 'flow', edgeIds: ['e1'] }]
  const touring = (askId: string): Res => ({
    success: true,
    data: { askId, ok: true, answer: { text: 'One two. Three four. Last.', sentences, actions, evidence: [], dropped: 0, unsupported: [], uncited: false }, summary: 's', cited: {} } as AskResult
  })
  /** A Lumopolis settings read that waits until the test lets it go (the model lookup before every request). */
  const slowSettings = () => {
    const gates: Array<() => void> = []
    ;(window as any).termpolis.worldSettingsGet = vi.fn(() => new Promise((r) => { gates.push(() => r({ success: true, data: { worldAgent: 'claude' } })) }))
    return { release: async (i: number) => { await act(async () => { gates[i]() }) } }
  }
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  afterEach(() => { vi.useRealTimers() })

  it('a question cancelled while its model is looked up never reaches main (U3)', async () => {
    const s = slowSettings()
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, 'C:/repo'))
    act(() => { result.current.ask('first') })
    act(() => { result.current.cancel() })
    await s.release(0)
    expect(ask).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
  })

  it('a question replaced while its model is looked up never reaches main; only the newer one does (U3)', async () => {
    const s = slowSettings()
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, 'C:/repo'))
    act(() => { result.current.ask('first') })
    act(() => { result.current.ask('second') })
    await s.release(0)
    expect(ask).not.toHaveBeenCalled()
    await s.release(1)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toMatchObject({ question: 'second' })
  })

  it('an older lookup that finishes after a newer question was sent sends nothing, so main never cancels the newer one (A1)', async () => {
    const s = slowSettings()
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, 'C:/repo'))
    act(() => { result.current.ask('first') })
    act(() => { result.current.ask('second') })
    await s.release(1)
    expect(ask).toHaveBeenCalledTimes(1)
    const newer = ask.mock.calls[0][0].askId
    await s.release(0)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toMatchObject({ question: 'second' })
    expect(cancel).not.toHaveBeenCalledWith(newer)
  })

  it('a question whose pane closed while its model was looked up never reaches main (A1)', async () => {
    const s = slowSettings()
    const { result, unmount } = renderHook(() => useWorldAsk(makeViewer() as never, 'C:/repo'))
    act(() => { result.current.ask('first') })
    unmount()
    await s.release(0)
    expect(ask).not.toHaveBeenCalled()
  })

  it('a question whose project changed while its model was looked up never reaches main (U3)', async () => {
    const s = slowSettings()
    const { result, rerender } = renderHook(({ root }) => useWorldAsk(makeViewer() as never, root), { initialProps: { root: 'C:/a' } })
    act(() => { result.current.ask('first') })
    rerender({ root: 'C:/b' })
    await s.release(0)
    expect(ask).not.toHaveBeenCalled()
  })

  it('a design change cancelled while its model is looked up is never sent (U3)', async () => {
    const refine = vi.fn()
    ;(window as any).termpolis = { worldDesignRefine: refine, worldDesignCancel: vi.fn(async () => true) }
    const s = slowSettings()
    const { result } = renderHook(() => useWorldAsk(null, 'design:d1'))
    act(() => { result.current.ask('add Payments') })
    act(() => { result.current.cancel() })
    await s.release(0)
    expect(refine).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
  })

  it('closing an answer whose tour is still flying stops the viewer and lets the pane go at once (U5)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ask.mockImplementation(async (req: AskRequest) => touring(req.askId))
    const v = makeViewer()
    v.play.mockImplementation(() => new Promise(() => undefined)) // a flight that never lands on its own
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(result.current.playing).toBe(true)
    v.cancelActions.mockClear()
    act(() => { result.current.dismiss() })
    expect(v.cancelActions).toHaveBeenCalledTimes(1)
    expect(result.current.playing).toBe(false)
    await tick(5000)
    expect(v.play).toHaveBeenCalledTimes(1)
  })

  it('closing an answer whose tour is over leaves the viewer alone (a tour the user started since is not stopped)', async () => {
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(result.current.playing).toBe(false)
    v.cancelActions.mockClear()
    act(() => { result.current.dismiss() })
    expect(v.cancelActions).not.toHaveBeenCalled()
  })

  it('switching to 2D mid-tour stops the old viewer, shows the whole answer and lets the pane go (U6)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ask.mockImplementation(async (req: AskRequest) => touring(req.askId))
    const v = makeViewer()
    v.play.mockImplementation(() => new Promise(() => undefined))
    const { result, rerender } = renderHook(({ viewer }) => useWorldAsk(viewer as never, 'r'), { initialProps: { viewer: v as ReturnType<typeof makeViewer> | null } })
    await act(async () => { result.current.ask('q') })
    expect(result.current.revealed).toBe(1)
    v.cancelActions.mockClear()
    rerender({ viewer: null })
    expect(v.cancelActions).toHaveBeenCalledTimes(1)
    expect(result.current.playing).toBe(false)
    expect(result.current.revealed).toBe(3)
    await tick(5000)
    expect(v.play).toHaveBeenCalledTimes(1)
  })

  it('a different viewer mid-tour stops the old one the same way; a viewer change with no tour running changes nothing (U6)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ask.mockImplementation(async (req: AskRequest) => touring(req.askId))
    const v = makeViewer()
    const w = makeViewer()
    v.play.mockImplementation(() => new Promise(() => undefined))
    const { result, rerender } = renderHook(({ viewer }) => useWorldAsk(viewer as never, 'r'), { initialProps: { viewer: v as ReturnType<typeof makeViewer> | null } })
    await act(async () => { result.current.ask('q') })
    v.cancelActions.mockClear()
    rerender({ viewer: w })
    expect(v.cancelActions).toHaveBeenCalledTimes(1)
    expect(result.current.revealed).toBe(3)
    expect(result.current.playing).toBe(false)
    rerender({ viewer: null })
    rerender({ viewer: v })
    expect(w.cancelActions).not.toHaveBeenCalled()
    expect(v.cancelActions).toHaveBeenCalledTimes(1)
  })

  it('an answer that lands after the switch to 2D is shown whole, with no tour on the viewer that was (U6)', async () => {
    const d = deferred<Res>()
    ask.mockImplementationOnce(() => d.promise)
    const v = makeViewer()
    const { result, rerender } = renderHook(({ viewer }) => useWorldAsk(viewer as never, 'r'), { initialProps: { viewer: v as ReturnType<typeof makeViewer> | null } })
    await act(async () => { result.current.ask('q') })
    rerender({ viewer: null })
    await act(async () => { d.resolve(touring(ask.mock.calls[0][0].askId)) })
    expect(result.current.state).toBe('answered')
    expect(result.current.revealed).toBe(3)
    expect(result.current.playing).toBe(false)
    expect(v.play).not.toHaveBeenCalled()
    expect(v.apply).not.toHaveBeenCalled()
  })

  it('ask says whether the question was taken: blank, too long or no viewer is refused and sends nothing (U9)', async () => {
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'C:/repo'))
    let took: boolean[] = []
    await act(async () => { took = [result.current.ask(' \u0000 '), result.current.ask('x'.repeat(4001))] })
    expect(took).toEqual([false, false])
    expect(ask).not.toHaveBeenCalled()
    const none = renderHook(() => useWorldAsk(null, 'C:/repo'))
    expect(none.result.current.ask('q')).toBe(false)
    await act(async () => { took = [result.current.ask(' Why\u0007 is\tit slow? ' + '\u0000'.repeat(10))] })
    expect(took).toEqual([true])
    expect(ask.mock.calls[0][0]).toMatchObject({ question: 'Why is\tit slow?' })
  })
})

describe('useWorldAsk: one stop for the answer tour, and its sentences played in turn (T4)', () => {
  const sentences = [{ text: 'One two.', actions: [0], sep: '' }, { text: 'Three four.', actions: [1], sep: ' ' }, { text: 'Last.', actions: [], sep: ' ' }]
  const actions = [{ type: 'tour', steps: [{ ids: ['b1'], caption: 'Here.' }] }, { type: 'flow', edgeIds: ['e1'] }]
  const touring = (askId: string): Res => ({
    success: true,
    data: { askId, ok: true, answer: { text: 'One two. Three four. Last.', sentences, actions, evidence: [], dropped: 0, unsupported: [], uncited: false }, summary: 's', cited: {} } as AskResult
  })
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ask.mockImplementation(async (req: AskRequest) => touring(req.askId))
  })
  afterEach(() => { vi.useRealTimers() })

  it("a sentence's actions start only once the sentence before has finished playing, never alongside it", async () => {
    const v = makeViewer()
    const first = deferred<undefined>()
    v.play.mockImplementationOnce(() => first.promise)
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(v.play).toHaveBeenCalledTimes(1)
    await tick(600)
    // The text keeps its reading pace; the second sentence's flow waits for the first sentence's tour.
    expect(result.current.revealed).toBe(2)
    expect(v.play).toHaveBeenCalledTimes(1)
    await act(async () => { first.resolve(undefined) })
    expect(v.play).toHaveBeenCalledTimes(2)
    expect(v.play.mock.calls[1][0]).toEqual([actions[1]])
    await tick(600)
    expect(result.current.revealed).toBe(3)
    expect(result.current.playing).toBe(false)
  })

  it('stop ends the reveal and the tour in the viewer, shows the whole answer, and nothing queued plays later', async () => {
    const v = makeViewer()
    const first = deferred<undefined>()
    v.play.mockImplementationOnce(() => first.promise)
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    await tick(600)
    v.cancelActions.mockClear()
    act(() => { result.current.stop() })
    expect(v.cancelActions).toHaveBeenCalledTimes(1)
    expect(result.current.playing).toBe(false)
    expect(result.current.revealed).toBe(3)
    expect(result.current.state).toBe('answered')
    await act(async () => { first.resolve(undefined) })
    await tick(5000)
    expect(v.play).toHaveBeenCalledTimes(1)
  })

  it('stop with no answer tour running leaves the viewer alone (a tour the person started is not theirs to stop)', async () => {
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    act(() => { result.current.stop() })
    await act(async () => { result.current.ask('q') })
    await tick(5000)
    expect(result.current.playing).toBe(false)
    v.cancelActions.mockClear()
    act(() => { result.current.stop() })
    expect(v.cancelActions).not.toHaveBeenCalled()
    expect(result.current.revealed).toBe(3)
  })

  it('unmounting mid-tour (the home) stops the tour in the viewer, and nothing queued plays later; with no tour it leaves the viewer alone', async () => {
    const v = makeViewer()
    const first = deferred<undefined>()
    v.play.mockImplementationOnce(() => first.promise)
    const a = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { a.result.current.ask('q') })
    await tick(600)
    v.cancelActions.mockClear()
    a.unmount()
    expect(v.cancelActions).toHaveBeenCalledTimes(1)
    await act(async () => { first.resolve(undefined) })
    await tick(5000)
    expect(v.play).toHaveBeenCalledTimes(1)
    const w = makeViewer()
    const b = renderHook(() => useWorldAsk(w as never, 'r'))
    b.unmount()
    expect(w.cancelActions).not.toHaveBeenCalled()
  })

  it('a different project mid-tour stops the tour in the viewer too', async () => {
    const v = makeViewer()
    v.play.mockImplementation(() => new Promise(() => undefined))
    const { result, rerender } = renderHook(({ root }) => useWorldAsk(v as never, root), { initialProps: { root: 'r' } })
    await act(async () => { result.current.ask('q') })
    v.cancelActions.mockClear()
    rerender({ root: 'r2' })
    expect(v.cancelActions).toHaveBeenCalledTimes(1)
    expect(result.current.playing).toBe(false)
    expect(result.current.answer).toBeNull()
  })
})
