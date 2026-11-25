import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { WorldEntry } from '../../../src/shared/world/types'
import { useOpenWorld, REPO_UPDATE_UNREACHABLE } from '../../../src/renderer/src/components/World/useOpenWorld'

type Res<T> = { success: true; data: T } | { success: false; error: string }
const ok = <T,>(data: T): Res<T> => ({ success: true, data })
const fail = (error: string): Res<never> => ({ success: false, error })

const gitEntry = (login?: 'machine' | 'token', key = 'kg'): WorldEntry =>
  ({ key, source: { kind: 'git', url: 'https://github.com/o/r.git', root: 'C:/data/r', ...(login ? { login } : {}) }, title: 'r', lastOpened: 1 })
const NEEDS = { needsLogin: { host: 'github.com', helper: true, message: 'Sign in please.' } }

let api: Record<string, ReturnType<typeof vi.fn>>
function setup(touched: WorldEntry | null, update: unknown = ok({ changed: false })) {
  api = {
    worldSourcesList: vi.fn(async () => ok<WorldEntry[]>([])),
    worldTouchSource: vi.fn(async () => ok<WorldEntry | null>(touched)),
    worldUpdateSource: vi.fn(async () => update),
  }
  ;(window as any).termpolis = api
}
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() }) }
type Hook = { result: { current: ReturnType<typeof useOpenWorld> } }
const openIt = async (r: Hook, key = 'kg') => {
  act(() => r.result.current.open({ kind: 'root', root: 'C:/data/r', key }))
  await settle()
}
beforeEach(() => vi.clearAllMocks())
afterEach(() => { delete (window as any).termpolis })

describe('useOpenWorld repository updates', () => {
  it('opening a remembered machine repo updates it in the background once', async () => {
    setup(gitEntry('machine'))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    expect(api.worldUpdateSource).toHaveBeenCalledTimes(1)
    expect(api.worldUpdateSource).toHaveBeenCalledWith('kg')
    expect(r.result.current.repoUpdate).toBeNull()
    expect(r.result.current.repoChanged).toBe(0)
  })

  it('an entry with no recorded login also asks main once (main decides)', async () => {
    setup(gitEntry())
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    expect(api.worldUpdateSource).toHaveBeenCalledTimes(1)
  })

  it('opening a remembered token repo runs no update and shows nothing', async () => {
    setup(gitEntry('token'))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    expect(api.worldUpdateSource).not.toHaveBeenCalled()
    expect(r.result.current.repoUpdate).toBeNull()
  })

  it('a folder or an unknown key runs no update', async () => {
    setup({ key: 'kf', source: { kind: 'folder', root: 'C:/x' }, title: 'x', lastOpened: 1 })
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    expect(api.worldUpdateSource).not.toHaveBeenCalled()
    api.worldTouchSource.mockResolvedValueOnce(fail('disk'))
    await openIt(r)
    expect(api.worldUpdateSource).not.toHaveBeenCalled()
    api.worldTouchSource.mockResolvedValueOnce(ok(null))
    await openIt(r)
    expect(api.worldUpdateSource).not.toHaveBeenCalled()
  })

  it('a changed update recompiles the world', async () => {
    setup(gitEntry('machine'), ok({ changed: true }))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    expect(r.result.current.repoChanged).toBe(1)
  })

  it('a skipped update changes nothing', async () => {
    setup(gitEntry('machine'), ok({ skipped: true }))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    expect(r.result.current.repoChanged).toBe(0)
    expect(r.result.current.repoUpdate).toBeNull()
  })

  it('a failed background update keeps the saved world and shows no error', async () => {
    setup(gitEntry('machine'), fail('boom'))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    expect(r.result.current.repoUpdate).toBeNull()
    expect(r.result.current.repoError).toBeNull()
    api.worldUpdateSource.mockRejectedValueOnce(new Error('down'))
    await openIt(r)
    expect(r.result.current.repoUpdate).toBeNull()
    expect(r.result.current.repoError).toBeNull()
  })

  it('a background needsLogin sets repoUpdate, and Sign in retries interactively and clears it on success', async () => {
    setup(gitEntry('machine'), ok(NEEDS))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    expect(r.result.current.repoUpdate).toEqual({ key: 'kg', host: 'github.com', helper: true, message: 'Sign in please.', notFound: false })
    api.worldUpdateSource.mockResolvedValueOnce(ok({ changed: true }))
    act(() => r.result.current.signIn())
    expect(r.result.current.repoBusy).toBe(true)
    await settle()
    expect(api.worldUpdateSource).toHaveBeenLastCalledWith('kg', { mode: 'machine' })
    expect(r.result.current.repoUpdate).toBeNull()
    expect(r.result.current.repoBusy).toBe(false)
    expect(r.result.current.repoChanged).toBe(1)
  })

  it('a second needsLogin after Sign in keeps the notice and does not retry on its own', async () => {
    setup(gitEntry('machine'), ok(NEEDS))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    act(() => r.result.current.signIn())
    await settle()
    expect(api.worldUpdateSource).toHaveBeenCalledTimes(2)
    expect(r.result.current.repoUpdate).not.toBeNull()
    expect(r.result.current.repoBusy).toBe(false)
  })

  it('useToken retries with the token, clears the notice on an unchanged success, and keeps no copy', async () => {
    setup(gitEntry('machine'), ok(NEEDS))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    api.worldUpdateSource.mockResolvedValueOnce(ok({ changed: false }))
    act(() => r.result.current.useToken('ghp_x'))
    await settle()
    expect(api.worldUpdateSource).toHaveBeenLastCalledWith('kg', { mode: 'token', value: 'ghp_x' })
    expect(r.result.current.repoUpdate).toBeNull()
    expect(r.result.current.repoChanged).toBe(0)
    expect(JSON.stringify(r.result.current)).not.toContain('ghp_x')
  })

  it('a rejected token comes back as repoError and the notice stays', async () => {
    setup(gitEntry('machine'), ok(NEEDS))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    api.worldUpdateSource.mockResolvedValueOnce(fail('That token did not open it.'))
    act(() => r.result.current.useToken('ghp_x'))
    await settle()
    expect(r.result.current.repoError).toBe('That token did not open it.')
    expect(r.result.current.repoUpdate).not.toBeNull()
    expect(JSON.stringify(r.result.current)).not.toContain('ghp_x')
    api.worldUpdateSource.mockRejectedValueOnce(new Error('down'))
    act(() => r.result.current.useToken('ghp_y'))
    await settle()
    expect(r.result.current.repoError).toBe(REPO_UPDATE_UNREACHABLE)
    api.worldUpdateSource.mockResolvedValueOnce(ok(NEEDS))
    act(() => r.result.current.useToken('ghp_z'))
    await settle()
    expect(r.result.current.repoError).toBe('Sign in please.')
  })

  it('does nothing when there is no notice to act on', async () => {
    setup(null)
    const r = renderHook(() => useOpenWorld(''))
    act(() => r.result.current.signIn())
    act(() => r.result.current.useToken('ghp_x'))
    await settle()
    expect(api.worldUpdateSource).not.toHaveBeenCalled()
  })

  it('does not start a second retry while one is running', async () => {
    setup(gitEntry('machine'), ok(NEEDS))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    let release!: (v: unknown) => void
    api.worldUpdateSource.mockImplementationOnce(() => new Promise((res) => { release = res }))
    act(() => r.result.current.signIn())
    act(() => r.result.current.signIn())
    act(() => r.result.current.useToken('ghp_x'))
    expect(api.worldUpdateSource).toHaveBeenCalledTimes(2)
    await act(async () => { release(ok({ changed: false })) })
    expect(r.result.current.repoBusy).toBe(false)
  })

  it('dismiss clears the notice; opening another world clears it too', async () => {
    setup(gitEntry('machine'), ok(NEEDS))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    act(() => r.result.current.dismissRepoUpdate())
    expect(r.result.current.repoUpdate).toBeNull()
    await openIt(r)
    expect(r.result.current.repoUpdate).not.toBeNull()
    act(() => r.result.current.goHome())
    expect(r.result.current.repoUpdate).toBeNull()
  })

  it('an answer for a world that is no longer open is dropped', async () => {
    setup(gitEntry('machine'))
    let release!: (v: unknown) => void
    api.worldUpdateSource.mockImplementationOnce(() => new Promise((res) => { release = res }))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    act(() => r.result.current.goHome())
    await act(async () => { release(ok(NEEDS)) })
    expect(r.result.current.repoUpdate).toBeNull()
    // The same for an interactive retry that finishes after the person left.
    api.worldUpdateSource.mockResolvedValueOnce(ok(NEEDS))
    await openIt(r)
    let late!: (v: unknown) => void
    api.worldUpdateSource.mockImplementationOnce(() => new Promise((res) => { late = res }))
    act(() => r.result.current.signIn())
    act(() => r.result.current.goHome())
    await act(async () => { late(ok({ changed: true })) })
    expect(r.result.current.repoChanged).toBe(0)
  })

  it('a retry that fails after the person left, or after the hook unmounted, shows nothing', async () => {
    setup(gitEntry('machine'), ok(NEEDS))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    let bad!: (e: unknown) => void
    api.worldUpdateSource.mockImplementationOnce(() => new Promise((_res, rej) => { bad = rej }))
    act(() => r.result.current.signIn())
    act(() => r.result.current.goHome())
    await act(async () => { bad(new Error('down')) })
    expect(r.result.current.repoError).toBeNull()
    await openIt(r)
    let gone!: (e: unknown) => void
    api.worldUpdateSource.mockImplementationOnce(() => new Promise((_res, rej) => { gone = rej }))
    act(() => r.result.current.signIn())
    r.unmount()
    await act(async () => { gone(new Error('down')) })
    expect(api.worldUpdateSource).toHaveBeenCalledTimes(4)
  })

  describe('a world change that is not an open() drops the repo state', () => {
    const asked = (seq = 1) => ({ req: { folder: 'C:/x', seq } as { folder: string; seq: number } | undefined })
    const mountWith = () => renderHook(({ req }: { req?: { folder: string; seq: number } }) => useOpenWorld('', req), { initialProps: { req: undefined } as { req?: { folder: string; seq: number } } })

    it('a pending needsLogin for A shows no notice over a requested world', async () => {
      setup(gitEntry('machine'))
      let release!: (v: unknown) => void
      api.worldUpdateSource.mockImplementationOnce(() => new Promise((res) => { release = res }))
      const r = mountWith()
      await openIt(r)
      r.rerender(asked())
      await settle()
      await act(async () => { release(ok(NEEDS)) })
      expect(r.result.current.repoUpdate).toBeNull()
    })

    it('a pending changed update for A does not recompile the requested world', async () => {
      setup(gitEntry('machine'))
      let release!: (v: unknown) => void
      api.worldUpdateSource.mockImplementationOnce(() => new Promise((res) => { release = res }))
      const r = mountWith()
      await openIt(r)
      r.rerender(asked())
      await settle()
      await act(async () => { release(ok({ changed: true })) })
      expect(r.result.current.repoChanged).toBe(0)
    })

    it('an existing notice for A disappears on a request-driven switch', async () => {
      setup(gitEntry('machine'), ok(NEEDS))
      const r = mountWith()
      await openIt(r)
      expect(r.result.current.repoUpdate).not.toBeNull()
      r.rerender(asked())
      await settle()
      expect(r.result.current.repoUpdate).toBeNull()
    })

    it('a cd that moves a following pane drops it too', async () => {
      setup(gitEntry('machine'), ok(NEEDS))
      const r = renderHook(({ root }: { root: string }) => useOpenWorld(root), { initialProps: { root: 'C:/a' } })
      act(() => r.result.current.open({ kind: 'root', root: 'C:/a', key: 'kg', follow: true }))
      await settle()
      expect(r.result.current.repoUpdate).not.toBeNull()
      r.rerender({ root: 'C:/b' })
      await settle()
      expect(r.result.current.repoUpdate).toBeNull()
    })
  })

  it('clearRepoError forgets the last retry message', async () => {
    setup(gitEntry('machine'), ok(NEEDS))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    api.worldUpdateSource.mockResolvedValueOnce(fail('nope'))
    act(() => r.result.current.signIn())
    await settle()
    expect(r.result.current.repoError).toBe('nope')
    act(() => r.result.current.clearRepoError())
    expect(r.result.current.repoError).toBeNull()
  })

  it('an answer after the hook unmounts is dropped', async () => {
    setup(gitEntry('machine'))
    let release!: (v: unknown) => void
    api.worldUpdateSource.mockImplementationOnce(() => new Promise((res) => { release = res }))
    const r = renderHook(() => useOpenWorld(''))
    await openIt(r)
    r.unmount()
    await act(async () => { release(ok({ changed: true })) })
    expect(api.worldUpdateSource).toHaveBeenCalledTimes(1)
  })
})

// A touch that could not be saved (main could not write the registry: a file held open, a full disk) only loses
// "last opened". The background update still runs from the entry the pane already shows, so a lapsed login
// still shows "Sign in needed" (caveat 4, round 1).
describe('useOpenWorld when marking the world opened fails', () => {
  const shown = async (entries: WorldEntry[], update: unknown) => {
    setup(null, update)
    api.worldSourcesList.mockResolvedValue(ok(entries))
    const r = renderHook(() => useOpenWorld(''))
    await settle()
    return r
  }

  it('a failed touch still updates the shown repository, so "Sign in needed" appears', async () => {
    const r = await shown([gitEntry('machine')], ok(NEEDS))
    api.worldTouchSource.mockResolvedValueOnce(fail('Could not save the world list.'))
    await openIt(r)
    expect(api.worldUpdateSource).toHaveBeenCalledTimes(1)
    expect(api.worldUpdateSource).toHaveBeenCalledWith('kg')
    expect(r.result.current.repoUpdate).toEqual({ key: 'kg', host: 'github.com', helper: true, message: 'Sign in please.', notFound: false })
  })

  it('a touch whose call itself fails does the same', async () => {
    const r = await shown([gitEntry(undefined, 'k2'), gitEntry()], ok(NEEDS))
    api.worldTouchSource.mockRejectedValueOnce(new Error('ipc gone'))
    await openIt(r)
    expect(api.worldUpdateSource).toHaveBeenCalledTimes(1)
    expect(api.worldUpdateSource).toHaveBeenCalledWith('kg')
    expect(r.result.current.repoUpdate).not.toBeNull()
  })

  it('a list that cannot be read leaves nothing shown, so a failed touch updates nothing', async () => {
    setup(null, ok(NEEDS))
    api.worldSourcesList.mockRejectedValue(new Error('ipc gone'))
    const r = renderHook(() => useOpenWorld(''))
    await settle()
    api.worldTouchSource.mockResolvedValueOnce(fail('x'))
    await openIt(r)
    expect(r.result.current.entries).toEqual([])
    expect(api.worldUpdateSource).not.toHaveBeenCalled()
  })

  it('a failed touch for a token repository, or one the pane does not show, updates nothing', async () => {
    const r = await shown([gitEntry('token')], ok(NEEDS))
    api.worldTouchSource.mockResolvedValueOnce(fail('x'))
    await openIt(r)
    api.worldTouchSource.mockResolvedValueOnce(fail('x'))
    await openIt(r, 'other')
    expect(api.worldUpdateSource).not.toHaveBeenCalled()
    expect(r.result.current.repoUpdate).toBeNull()
  })
})
