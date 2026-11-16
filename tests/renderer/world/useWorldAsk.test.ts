import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useWorldAsk } from '../../../src/renderer/src/components/World/useWorldAsk'
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
    expect(result.current.history).toEqual([{ q: 'What is this?', a: 'Hello' }])
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
    expect(result.current.history).toHaveLength(2)
  })

  it('new question while thinking → worldAskCancel(prev) and viewer.cancelActions()', async () => {
    const v = makeViewer()
    const d = deferred<Res>()
    ask.mockImplementationOnce(() => d.promise)
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    act(() => { result.current.ask('first') })
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
    act(() => { result.current.ask('first') })
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
    act(() => { result.current.ask('q') })
    await act(async () => { result.current.cancel() })
    expect(result.current.state).toBe('idle')
  })

  it('unmount cancels a running ask and drops its result', async () => {
    const d = deferred<Res>()
    ask.mockImplementationOnce(() => d.promise)
    const { result, unmount } = renderHook(() => useWorldAsk(makeViewer() as never, 'r'))
    act(() => { result.current.ask('q') })
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
    ask.mockRejectedValueOnce(new Error('kaput'))
    await act(async () => { result.current.ask('b') })
    expect(result.current.error).toBe('kaput')
    ask.mockRejectedValueOnce('str')
    await act(async () => { result.current.ask('c') })
    expect(result.current.error).toBe('str')
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
    act(() => { result.current.ask('first') })
    await act(async () => { result.current.ask('second') })
    await act(async () => { reject(new Error('late boom')) })
    expect(result.current.state).toBe('answered')
    expect(result.current.error).toBeNull()
  })

  it('dismiss clears the answer and error and goes idle', async () => {
    const v = makeViewer()
    const { result } = renderHook(() => useWorldAsk(v as never, 'r'))
    await act(async () => { result.current.ask('q') })
    act(() => { result.current.dismiss() })
    expect(result.current.state).toBe('idle')
    expect(result.current.answer).toBeNull()
  })

  it('exposes the cited labels of the answer', async () => {
    ask.mockImplementationOnce(async (req: AskRequest) => okRes(req.askId, 'x [E1]', { cited: { E1: { kind: 'file', ref: 'a.ts' } } }))
    const { result } = renderHook(() => useWorldAsk(makeViewer() as never, 'r'))
    await act(async () => { result.current.ask('q') })
    expect(result.current.cited).toEqual({ E1: { kind: 'file', ref: 'a.ts' } })
  })
})
