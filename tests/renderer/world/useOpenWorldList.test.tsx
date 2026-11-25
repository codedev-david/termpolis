// useOpenWorld's recent-worlds list and its open tickets (WP-SRC, F-R12 and F-R4): a list main could not read
// says so instead of looking empty, only the newest answer is shown, and an action that started before the
// pane moved to another world can tell it is too late to open one.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { WorldEntry } from '../../../src/shared/world/types'
import { useOpenWorld } from '../../../src/renderer/src/components/World/useOpenWorld'
import type { WorldRequest } from '../../../src/renderer/src/components/World/useOpenWorld'

type Res<T> = { success: true; data: T } | { success: false; error: string }
const ok = <T,>(data: T): Res<T> => ({ success: true, data })
const fail = (error: string): Res<never> => ({ success: false, error })

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const entry = (key: string): WorldEntry => ({ key, source: { kind: 'folder', root: `C:/${key}` }, title: key, lastOpened: 1 })

let api: Record<string, ReturnType<typeof vi.fn>>
function setup(list: ReturnType<typeof vi.fn>) {
  api = {
    worldSourcesList: list,
    worldTouchSource: vi.fn(async () => ok<WorldEntry | null>(null)),
    worldUpdateSource: vi.fn(async () => ok({ changed: false })),
  }
  ;(window as any).termpolis = api
}
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() }) }
afterEach(() => { delete (window as any).termpolis })

describe('useOpenWorld recent worlds (F-R12)', () => {
  it('a list main could not read sets listError; Try again that reads it clears it', async () => {
    setup(vi.fn().mockResolvedValueOnce(fail('disk')).mockResolvedValueOnce(ok([entry('a')])))
    const r = renderHook(() => useOpenWorld(''))
    await settle()
    expect(r.result.current.listError).toBe(true)
    expect(r.result.current.entries).toEqual([])
    act(() => r.result.current.refresh())
    await settle()
    expect(r.result.current.listError).toBe(false)
    expect(r.result.current.entries).toEqual([entry('a')])
  })

  it('a list call that itself fails sets listError too, and keeps the list already shown', async () => {
    setup(vi.fn().mockResolvedValueOnce(ok([entry('a')])).mockRejectedValueOnce(new Error('gone')))
    const r = renderHook(() => useOpenWorld(''))
    await settle()
    expect(r.result.current.listError).toBe(false)
    act(() => r.result.current.refresh())
    await settle()
    expect(r.result.current.listError).toBe(true)
    expect(r.result.current.entries).toEqual([entry('a')])
  })

  it('only the newest list answer is shown: an older one that lands last is dropped, a failed one too', async () => {
    const first = deferred<Res<WorldEntry[]>>()
    const second = deferred<Res<WorldEntry[]>>()
    setup(vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise))
    const r = renderHook(() => useOpenWorld(''))
    act(() => r.result.current.refresh())
    second.resolve(ok([entry('new')]))
    await settle()
    expect(r.result.current.entries).toEqual([entry('new')])
    first.resolve(ok([entry('old')]))
    await settle()
    expect(r.result.current.entries).toEqual([entry('new')])
    // An older failure does not mark the newer list as unreadable.
    const third = deferred<Res<WorldEntry[]>>()
    const fourth = deferred<Res<WorldEntry[]>>()
    api.worldSourcesList.mockImplementationOnce(() => third.promise).mockImplementationOnce(() => fourth.promise)
    act(() => r.result.current.refresh())
    act(() => r.result.current.refresh())
    fourth.resolve(ok([entry('newest')]))
    await settle()
    third.reject(new Error('late'))
    await settle()
    expect(r.result.current.listError).toBe(false)
    expect(r.result.current.entries).toEqual([entry('newest')])
  })

  it('an answer after the hook unmounts is dropped', async () => {
    const d = deferred<Res<WorldEntry[]>>()
    setup(vi.fn().mockImplementationOnce(() => d.promise))
    const r = renderHook(() => useOpenWorld(''))
    r.unmount()
    d.resolve(fail('disk'))
    await settle()
    expect(r.result.current.listError).toBe(false)
  })
})

describe('useOpenWorld open tickets (F-R4)', () => {
  it('a ticket holds while the pane stays where it was, and lapses once it opens another world or goes home', async () => {
    setup(vi.fn(async () => ok<WorldEntry[]>([])))
    const r = renderHook(() => useOpenWorld(''))
    await settle()
    const t = r.result.current.ticket()
    expect(t()).toBe(true)
    act(() => r.result.current.open({ kind: 'root', root: 'C:/a', key: 'a' }))
    expect(t()).toBe(false)
    const u = r.result.current.ticket()
    act(() => r.result.current.goHome())
    expect(u()).toBe(false)
    await settle()
  })

  it('a request, or a cd that moves a following pane, lapses it too; a cd while the pane stays put does not', async () => {
    setup(vi.fn(async () => ok<WorldEntry[]>([])))
    const r = renderHook(({ root, request }: { root: string; request?: WorldRequest }) => useOpenWorld(root, request), {
      initialProps: { root: '' } as { root: string; request?: WorldRequest },
    })
    const t = r.result.current.ticket()
    r.rerender({ root: 'C:/b' })
    expect(t()).toBe(false)
    const u = r.result.current.ticket()
    r.rerender({ root: 'C:/b', request: { folder: 'C:/asked', seq: 1 } })
    expect(u()).toBe(false)
    const v = r.result.current.ticket()
    // No longer following: a cd leaves the pane on the asked folder, so a ticket from then still holds.
    r.rerender({ root: 'C:/c', request: { folder: 'C:/asked', seq: 1 } })
    expect(v()).toBe(true)
    await settle()
  })

  it('a newer ticket lapses every older one: only the action the person started last can open its world', async () => {
    setup(vi.fn(async () => ok<WorldEntry[]>([])))
    const r = renderHook(() => useOpenWorld(''))
    await settle()
    const older = r.result.current.ticket()
    const newer = r.result.current.ticket()
    expect(older()).toBe(false)
    expect(newer()).toBe(true)
  })

  it('a ticket lapses when the hook unmounts', async () => {
    setup(vi.fn(async () => ok<WorldEntry[]>([])))
    const r = renderHook(() => useOpenWorld(''))
    await settle()
    const t = r.result.current.ticket()
    r.unmount()
    expect(t()).toBe(false)
  })
})
