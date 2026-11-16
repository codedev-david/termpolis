import { describe, expect, it, vi } from 'vitest'
import { registerWorldIpc, type WorldAsker, type WorldIpcClient } from '../../src/main/world/ipc'
import type { WorldDoc, WorldProgressEvent, WorldUpdatedEvent } from '../../src/shared/world/types'
import type { WorldSettings, WorldSettingsStore } from '../../src/main/world/worldSettings'

const DOC = { projectKey: 'k', version: 1 } as unknown as WorldDoc

type Win = { webContents: { send: (...a: unknown[]) => void } }

function fakeSettings(): WorldSettingsStore & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
  let current: WorldSettings = { worldLabelling: true }
  return {
    get: vi.fn(() => ({ ...current })),
    set: vi.fn((patch: Partial<WorldSettings>) => {
      current = { ...current, ...patch }
      return { ...current }
    })
  }
}

function setup(win: () => Win | null | undefined = () => null, settings = fakeSettings(), asker?: WorldAsker) {
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
    applySettings: vi.fn(),
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
  const off = registerWorldIpc(ipc, client, win, settings, asker)
  const invoke = (ch: string, args?: unknown) => (handlers.get(ch) as (e: unknown, a?: unknown) => Promise<unknown>)({}, args)
  return { handlers, client, off, invoke, progress, updated, settings }
}

describe('registerWorldIpc', () => {
  it('registers world:get, world:compile, world:relayout and the settings pair', () => {
    expect([...setup().handlers.keys()]).toEqual(['world:get', 'world:compile', 'world:relayout', 'world:settings-get', 'world:settings-set'])
  })

  it('world:settings-get answers the stored settings', async () => {
    const { invoke } = setup()
    expect(await invoke('world:settings-get')).toEqual({ success: true, data: { worldLabelling: true } })
  })

  it('world:settings-set applies only the allowlisted field and answers the new settings', async () => {
    const { invoke, settings } = setup()
    expect(await invoke('world:settings-set', { worldLabelling: false, evil: 'x' })).toEqual({ success: true, data: { worldLabelling: false } })
    expect(settings.set).toHaveBeenLastCalledWith({ worldLabelling: false })
    // A wrong type or an unknown field is dropped: set() runs with nothing to change.
    expect(await invoke('world:settings-set', { worldLabelling: 'no' })).toEqual({ success: true, data: { worldLabelling: false } })
    expect(settings.set).toHaveBeenLastCalledWith({})
  })

  it('world:settings-set allowlists worldSpeakAnswers alone or with worldLabelling', async () => {
    const { invoke, settings } = setup()
    await invoke('world:settings-set', { worldSpeakAnswers: true })
    expect(settings.set).toHaveBeenLastCalledWith({ worldSpeakAnswers: true })
    await invoke('world:settings-set', { worldSpeakAnswers: false, worldLabelling: false, evil: 1 })
    expect(settings.set).toHaveBeenLastCalledWith({ worldSpeakAnswers: false, worldLabelling: false })
    await invoke('world:settings-set', { worldSpeakAnswers: 'yes' })
    expect(settings.set).toHaveBeenLastCalledWith({})
  })

  it('world:settings-set hands the new setting to the live world host after storing it', async () => {
    const { invoke, settings, client } = setup()
    await invoke('world:settings-set', { worldLabelling: false })
    expect(client.applySettings).toHaveBeenCalledTimes(1)
    const stored = settings.set.mock.invocationCallOrder[0]
    expect((client.applySettings as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeGreaterThan(stored)
    // A refused patch, or a store that throws, tells the host nothing.
    await invoke('world:settings-set', 'nope')
    settings.set.mockImplementation(() => {
      throw new Error('disk gone')
    })
    await invoke('world:settings-set', { worldLabelling: true })
    expect(client.applySettings).toHaveBeenCalledTimes(1)
  })

  it('world:settings-set refuses a patch that is not an object', async () => {
    const { invoke, settings } = setup()
    for (const args of [undefined, null, 'off', 5, [true]]) {
      expect(await invoke('world:settings-set', args)).toEqual({ success: false, error: 'settings patch required' })
    }
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('the settings handlers answer err() when the store throws', async () => {
    const settings = fakeSettings()
    settings.get.mockImplementation(() => {
      throw new Error('disk gone')
    })
    settings.set.mockImplementation(() => {
      throw 'odd'
    })
    const { invoke } = setup(() => null, settings)
    expect(await invoke('world:settings-get')).toEqual({ success: false, error: 'disk gone' })
    expect(await invoke('world:settings-set', { worldLabelling: true })).toEqual({ success: false, error: 'odd' })
    settings.get.mockImplementation(() => {
      throw 'odd get'
    })
    settings.set.mockImplementation(() => {
      throw new Error('read only')
    })
    expect(await invoke('world:settings-get')).toEqual({ success: false, error: 'odd get' })
    expect(await invoke('world:settings-set', { worldLabelling: true })).toEqual({ success: false, error: 'read only' })
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

describe('registerWorldIpc ask handlers', () => {
  const GOOD = { askId: 'a1', root: 'C:/repo', question: 'What?', selection: ['b1'], cameraRegion: [], summary: 'S' }
  const result = { askId: 'a1', ok: true, answer: { text: 'x', actions: [], evidence: [], dropped: 0 }, summary: 'S2' }
  const fakeAsker = () => ({ ask: vi.fn(async () => result as never), cancel: vi.fn() }) as WorldAsker & { ask: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }

  it('registers the ask pair only when an asker is given', () => {
    expect([...setup().handlers.keys()]).not.toContain('world:ask')
    expect([...setup(undefined, undefined, fakeAsker()).handlers.keys()].slice(-2)).toEqual(['world:ask', 'world:ask-cancel'])
  })

  it('world:ask returns ok(AskResult) and defaults summary to an empty string', async () => {
    const asker = fakeAsker()
    const s = setup(undefined, undefined, asker)
    expect(await s.invoke('world:ask', GOOD)).toEqual({ success: true, data: result })
    expect(asker.ask).toHaveBeenCalledWith(GOOD)
    const { summary: _s, ...noSummary } = GOOD
    await s.invoke('world:ask', noSummary)
    expect(asker.ask).toHaveBeenLastCalledWith({ ...GOOD, summary: '' })
  })

  it.each([
    ['not an object', 'nope', 'ask request required'],
    ['missing args', undefined, 'ask request required'],
    ['empty askId', { ...GOOD, askId: ' ' }, 'askId required'],
    ['empty root', { ...GOOD, root: '' }, 'root required'],
    ['relative root', { ...GOOD, root: 'src/app' }, 'root required'],
    ['no question', { ...GOOD, question: 5 }, 'question required (up to 4000 characters)'],
    ['blank question', { ...GOOD, question: '  ' }, 'question required (up to 4000 characters)'],
    ['too long question', { ...GOOD, question: 'x'.repeat(4001) }, 'question required (up to 4000 characters)'],
    ['selection not strings', { ...GOOD, selection: [1] }, 'selection and cameraRegion must be string arrays'],
    ['camera not an array', { ...GOOD, cameraRegion: 'b' }, 'selection and cameraRegion must be string arrays'],
    ['summary not a string', { ...GOOD, summary: 3 }, 'summary must be a string']
  ])('world:ask rejects a bad shape: %s', async (_n, args, error) => {
    const asker = fakeAsker()
    expect(await setup(undefined, undefined, asker).invoke('world:ask', args)).toEqual({ success: false, error })
    expect(asker.ask).not.toHaveBeenCalled()
  })

  it('accepts a question of exactly 4000 characters', async () => {
    const asker = fakeAsker()
    expect(await setup(undefined, undefined, asker).invoke('world:ask', { ...GOOD, question: 'x'.repeat(4000) })).toMatchObject({ success: true })
  })

  it('world:ask turns a thrown asker into plain copy, never the raw error', async () => {
    const asker = fakeAsker()
    asker.ask.mockRejectedValueOnce(new Error('Lumopolis host call "get" timed out')).mockRejectedValueOnce('odd')
    const s = setup(undefined, undefined, asker)
    const copy = { success: false, error: "Lumopolis couldn't answer that question. Try again." }
    expect(await s.invoke('world:ask', GOOD)).toEqual(copy)
    expect(await s.invoke('world:ask', GOOD)).toEqual(copy)
  })

  it('world:ask takes an absolute root in either form', async () => {
    const asker = fakeAsker()
    const s = setup(undefined, undefined, asker)
    for (const root of ['C:\\repo', '/home/me/repo']) {
      expect(await s.invoke('world:ask', { ...GOOD, root })).toMatchObject({ success: true })
    }
  })

  it('world:ask-cancel cancels by askId and validates it', async () => {
    const asker = fakeAsker()
    const s = setup(undefined, undefined, asker)
    expect(await s.invoke('world:ask-cancel', { askId: 'a1' })).toEqual({ success: true, data: true })
    expect(asker.cancel).toHaveBeenCalledWith('a1')
    expect(await s.invoke('world:ask-cancel', { askId: '' })).toEqual({ success: false, error: 'askId required' })
    expect(await s.invoke('world:ask-cancel', 'a1')).toEqual({ success: false, error: 'askId required' })
    expect(await s.invoke('world:ask-cancel')).toEqual({ success: false, error: 'askId required' })
  })
})
