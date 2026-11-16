import { describe, expect, it, vi } from 'vitest'
import { registerWorldIpc, type WorldIpcClient } from '../../src/main/world/ipc'
import type { WorldDoc, WorldProgressEvent, WorldUpdatedEvent } from '../../src/shared/world/types'

const DOC = { projectKey: 'k', version: 1 } as unknown as WorldDoc

type Win = { webContents: { send: (...a: unknown[]) => void } }

function setup(win: () => Win | null | undefined = () => null) {
  const handlers = new Map<string, (e: unknown, args?: unknown) => unknown>()
  const ipc = {
    handle: vi.fn((ch: string, fn: (e: unknown, args?: unknown) => unknown) => {
      handlers.set(ch, fn)
    })
  }
  const progress = new Set<(e: WorldProgressEvent) => void>()
  const updated = new Set<(e: WorldUpdatedEvent) => void>()
  const client: WorldIpcClient = {
    get: vi.fn(async (root: string) => (root === 'C:/none' ? null : DOC)),
    compile: vi.fn(async (root: string) => {
      if (root === 'C:/bad') throw new Error('graph missing')
      if (root === 'C:/odd') throw 'odd failure'
      return DOC
    }),
    relayout: vi.fn(async () => DOC),
    onProgress: (cb) => {
      progress.add(cb)
      return () => {
        progress.delete(cb)
      }
    },
    onUpdated: (cb) => {
      updated.add(cb)
      return () => {
        updated.delete(cb)
      }
    }
  }
  const off = registerWorldIpc(ipc, client, win)
  const invoke = (ch: string, args?: unknown) => (handlers.get(ch) as (e: unknown, a?: unknown) => Promise<unknown>)({}, args)
  return { handlers, client, off, invoke, progress, updated }
}

describe('registerWorldIpc', () => {
  it('registers world:get, world:compile and world:relayout', () => {
    expect([...setup().handlers.keys()]).toEqual(['world:get', 'world:compile', 'world:relayout'])
  })

  it('handlers return ok() shapes', async () => {
    const { invoke, client } = setup()
    expect(await invoke('world:get', { root: 'C:/repo' })).toEqual({ success: true, data: DOC })
    expect(await invoke('world:get', { root: 'C:/none' })).toEqual({ success: true, data: null })
    expect(await invoke('world:compile', { root: 'C:/repo' })).toEqual({ success: true, data: DOC })
    expect(await invoke('world:relayout', { root: 'C:/repo' })).toEqual({ success: true, data: DOC })
    expect(client.relayout).toHaveBeenCalledWith('C:/repo')
  })

  it('handlers return err() shapes for a missing root or a failure', async () => {
    const { invoke, client } = setup()
    for (const args of [undefined, null, 'C:/repo', {}, { root: '   ' }, { root: 5 }]) {
      expect(await invoke('world:get', args)).toEqual({ success: false, error: 'root required' })
    }
    expect(client.get).not.toHaveBeenCalled()
    expect(await invoke('world:compile', { root: 'C:/bad' })).toEqual({ success: false, error: 'graph missing' })
    expect(await invoke('world:compile', { root: 'C:/odd' })).toEqual({ success: false, error: 'odd failure' })
  })

  it('forwards progress and updated to the window, survives no window or a dead one, and stops on off()', () => {
    const send = vi.fn()
    let current: Win | null = null
    const s = setup(() => current)
    const p: WorldProgressEvent = { root: 'C:/repo', projectKey: 'k', stage: 'layout', pct: 50 }
    const u: WorldUpdatedEvent = { root: 'C:/repo', projectKey: 'k' }
    for (const cb of s.progress) cb(p) // no window: nothing happens
    current = { webContents: { send } }
    for (const cb of s.progress) cb(p)
    for (const cb of s.updated) cb(u)
    expect(send.mock.calls).toEqual([
      ['world:progress', p],
      ['world:updated', u]
    ])
    send.mockImplementation(() => {
      throw new Error('Object has been destroyed')
    })
    expect(() => [...s.progress].forEach((cb) => cb(p))).not.toThrow()
    expect(() => [...s.updated].forEach((cb) => cb(u))).not.toThrow()
    s.off()
    expect(s.progress.size).toBe(0)
    expect(s.updated.size).toBe(0)
  })
})
