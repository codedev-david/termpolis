import { describe, expect, it, vi } from 'vitest'
import { ANNOTATE_FAILED, DESIGN_FAILED, SETTINGS_FAILED, SETTINGS_LOAD_FAILED, registerWorldIpc, type WorldAsker, type WorldDesigner, type WorldIpcClient } from '../../src/main/world/ipc'
import { DESIGN_CHANGED, DESIGN_NOT_FOUND, DESIGN_REPLACED, DESIGN_SAVE_FAILED, DesignFailure } from '../../src/main/world/designer'
import { NO_PART } from '../../src/main/world/annotations'
import type { WorldDoc, WorldProgressEvent, WorldUpdatedEvent } from '../../src/shared/world/types'
import type { WorldSettings, WorldSettingsStore } from '../../src/main/world/worldSettings'
import { shownAsIs, shownError, WORLD_CALL_FAILED } from '../../src/main/world/windowError'
import { WORLD_SAVE_FAILED, WORLD_SAVED_BY_NEWER } from '../../src/main/world/worldStore'

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

function setup(win: () => Win | null | undefined = () => null, settings = fakeSettings(), asker?: WorldAsker, designer?: WorldDesigner) {
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
    annotate: vi.fn(async () => DOC),
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
  const off = registerWorldIpc(ipc, client, win, settings, asker, designer)
  const invoke = (ch: string, args?: unknown) => (handlers.get(ch) as (e: unknown, a?: unknown) => Promise<unknown>)({}, args)
  return { handlers, client, off, invoke, progress, updated, settings }
}

describe('registerWorldIpc', () => {
  it('registers world:get, world:compile, world:relayout the annotation and the settings pair', () => {
    expect([...setup().handlers.keys()]).toEqual(['world:get', 'world:compile', 'world:compile-cancel', 'world:relayout', 'world:annotate', 'world:settings-get', 'world:settings-set'])
  })

  it('world:settings-get answers the stored settings', async () => {
    const { invoke } = setup()
    expect(await invoke('world:settings-get')).toEqual({ success: true, data: { worldLabelling: true } })
  })

  it('world:settings-get answers only once the settings file has loaded, never the defaults before it', async () => {
    const settings = fakeSettings()
    let loaded!: () => void
    let fromFile = false
    settings.get.mockImplementation(() => ({ worldLabelling: true, worldOpened: fromFile }))
    const ready = vi.fn(() => new Promise<void>((r) => { loaded = () => { fromFile = true; r() } }))
    const { invoke } = setup(() => null, Object.assign(settings, { ready }))
    const answer = invoke('world:settings-get')
    await Promise.resolve()
    expect(settings.get).not.toHaveBeenCalled()
    loaded()
    expect(await answer).toEqual({ success: true, data: { worldLabelling: true, worldOpened: true } })
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('world:settings-get answers an error when loading the settings fails', async () => {
    const settings = Object.assign(fakeSettings(), { ready: vi.fn(async () => { throw new Error('disk gone') }) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // #65: the raw reason goes to the log only; the window gets fixed words.
      // M4: a read that failed says it could not load them, never that a setting could not change.
      expect(await setup(() => null, settings).invoke('world:settings-get')).toEqual({ success: false, error: SETTINGS_LOAD_FAILED })
      expect(warn).toHaveBeenCalledWith('[world] the Lumopolis settings failed:', expect.objectContaining({ message: 'disk gone' }))
    } finally {
      warn.mockRestore()
    }
    expect(SETTINGS_FAILED).toBe("Lumopolis couldn't change that setting. Try again.")
    expect(SETTINGS_LOAD_FAILED).toBe("Lumopolis couldn't load its settings. Try again.")
  })

  it('#65: world:settings-set answers fixed words when saving the change fails, and logs why', async () => {
    const settings = fakeSettings()
    settings.set.mockImplementationOnce(() => { throw new Error('EPERM C:/Users/x/settings.json') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await setup(() => null, settings).invoke('world:settings-set', { worldLabelling: false })).toEqual({ success: false, error: SETTINGS_FAILED })
      expect(warn).toHaveBeenCalledWith('[world] the Lumopolis settings failed:', expect.objectContaining({ message: 'EPERM C:/Users/x/settings.json' }))
    } finally {
      warn.mockRestore()
    }
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

  it('world:settings-set allowlists worldCiResults: a boolean passes, anything else is dropped', async () => {
    const { invoke, settings } = setup()
    await invoke('world:settings-set', { worldCiResults: true })
    expect(settings.set).toHaveBeenLastCalledWith({ worldCiResults: true })
    await invoke('world:settings-set', { worldCiResults: 'yes' })
    expect(settings.set).toHaveBeenLastCalledWith({})
  })

  it('world:settings-set allowlists worldAgent: a known agent passes, anything else is dropped', async () => {
    const { invoke, settings } = setup()
    await invoke('world:settings-set', { worldAgent: 'codex' })
    expect(settings.set).toHaveBeenLastCalledWith({ worldAgent: 'codex' })
    await invoke('world:settings-set', { worldAgent: 'llama' })
    expect(settings.set).toHaveBeenLastCalledWith({})
  })

  it('world:settings-set allowlists the Lumopolis UI flags worldOpened and worldHintDismissed', async () => {
    const { invoke, settings } = setup()
    await invoke('world:settings-set', { worldOpened: true, worldHintDismissed: false })
    expect(settings.set).toHaveBeenLastCalledWith({ worldOpened: true, worldHintDismissed: false })
    await invoke('world:settings-set', { worldOpened: 'yes', worldHintDismissed: 1 })
    expect(settings.set).toHaveBeenLastCalledWith({})
  })

  it('world:settings-set allowlists Show frame rate (showFrameRate) as a boolean', async () => {
    const { invoke, settings } = setup()
    await invoke('world:settings-set', { showFrameRate: true })
    expect(settings.set).toHaveBeenLastCalledWith({ showFrameRate: true })
    await invoke('world:settings-set', { showFrameRate: 'yes' })
    expect(settings.set).toHaveBeenLastCalledWith({})
  })

  it('world:settings-set allowlists the Quality menu (quality) as auto or a tier', async () => {
    const { invoke, settings } = setup()
    for (const q of ['auto', 'high', 'low', 'flat']) {
      await invoke('world:settings-set', { quality: q })
      expect(settings.set).toHaveBeenLastCalledWith({ quality: q })
    }
    await invoke('world:settings-set', { quality: 'ultra' })
    expect(settings.set).toHaveBeenLastCalledWith({})
    await invoke('world:settings-set', { quality: true })
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await invoke('world:settings-get')).toEqual({ success: false, error: SETTINGS_LOAD_FAILED })
      expect(await invoke('world:settings-set', { worldLabelling: true })).toEqual({ success: false, error: SETTINGS_FAILED })
      settings.get.mockImplementation(() => {
        throw 'odd get'
      })
      settings.set.mockImplementation(() => {
        throw new Error('read only')
      })
      expect(await invoke('world:settings-get')).toEqual({ success: false, error: SETTINGS_LOAD_FAILED })
      expect(await invoke('world:settings-set', { worldLabelling: true })).toEqual({ success: false, error: SETTINGS_FAILED })
      expect(warn).toHaveBeenCalledWith('[world] the Lumopolis settings failed:', 'odd get')
    } finally {
      warn.mockRestore()
    }
  })

  // WP4b F-R6: Stop mapping.
  it('world:compile-cancel stops the mapping of that root and answers whether one ran; a client without it answers false', async () => {
    const { invoke, client } = setup()
    expect(await invoke('world:compile-cancel', { root: 'C:/repo' })).toEqual({ success: true, data: false })
    const cancelCompile = vi.fn(async (root: string) => root === 'C:/repo')
    Object.assign(client, { cancelCompile })
    expect(await invoke('world:compile-cancel', { root: 'C:/repo' })).toEqual({ success: true, data: true })
    expect(await invoke('world:compile-cancel', { root: 'C:/other' })).toEqual({ success: true, data: false })
    expect(cancelCompile.mock.calls).toEqual([['C:/repo'], ['C:/other']])
    expect(await invoke('world:compile-cancel', {})).toEqual({ success: false, error: 'root required' })
  })

  it('handlers return ok() shapes', async () => {
    const { invoke, client } = setup()
    expect(await invoke('world:get', { root: 'C:/repo' })).toEqual({ success: true, data: DOC })
    expect(await invoke('world:get', { root: 'C:/none' })).toEqual({ success: true, data: null })
    // The pane's get may be answered with the first map drawn from the listing (fix round 1, I1).
    expect(client.get).toHaveBeenCalledWith('C:/repo', { provisional: true })
    expect(await invoke('world:compile', { root: 'C:/repo' })).toEqual({ success: true, data: DOC })
    expect(await invoke('world:relayout', { root: 'C:/repo' })).toEqual({ success: true, data: DOC })
    expect(client.relayout).toHaveBeenCalledWith('C:/repo')
  })

  it('opening a world warms the asker (its memory primer) for that root, without waiting on it; a throwing warm is ignored (WPA)', async () => {
    const warm = vi.fn()
    const asker: WorldAsker = { ask: vi.fn(), cancel: vi.fn(), warm }
    const { invoke } = setup(() => null, fakeSettings(), asker)
    expect(await invoke('world:get', { root: 'C:/repo' })).toEqual({ success: true, data: DOC })
    expect(warm).toHaveBeenCalledWith('C:/repo')
    warm.mockImplementation(() => { throw new Error('no memory') })
    expect(await invoke('world:get', { root: 'C:/repo' })).toEqual({ success: true, data: DOC })
    expect(await invoke('world:get', {})).toEqual({ success: false, error: 'root required' })
    expect(warm).toHaveBeenCalledTimes(2)
  })

  it('opening a world readies its annotations first (WPA fix M2): the read waits for prepare, and a failing prepare is ignored', async () => {
    const order: string[] = []
    const prepare = vi.fn(async () => { order.push('prepare') })
    const asker: WorldAsker = { ask: vi.fn(), cancel: vi.fn(), prepare }
    const { invoke, client } = setup(() => null, fakeSettings(), asker)
    ;(client.get as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('get'); return DOC })
    expect(await invoke('world:get', { root: 'C:/repo' })).toEqual({ success: true, data: DOC })
    expect(prepare).toHaveBeenCalledWith('C:/repo')
    expect(order).toEqual(['prepare', 'get'])
    prepare.mockRejectedValueOnce(new Error('disk'))
    expect(await invoke('world:get', { root: 'C:/repo' })).toEqual({ success: true, data: DOC })
  })

  it('WP5 fix I5: the older keys prepare adopted from go back with the world, never with no world nor when there are none', async () => {
    const prepare = vi.fn(async (): Promise<string[] | void> => ['k-old'])
    const asker: WorldAsker = { ask: vi.fn(), cancel: vi.fn(), prepare }
    const { invoke, client } = setup(() => null, fakeSettings(), asker)
    ;(client.get as ReturnType<typeof vi.fn>).mockResolvedValue(DOC)
    expect(await invoke('world:get', { root: 'C:/repo' })).toEqual({ success: true, data: { ...DOC, aliasKeys: ['k-old'] } })
    prepare.mockResolvedValueOnce([])
    expect(await invoke('world:get', { root: 'C:/repo' })).toEqual({ success: true, data: DOC })
    ;(client.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    expect(await invoke('world:get', { root: 'C:/repo' })).toEqual({ success: true, data: null })
  })

  it('handlers return err() shapes for a missing root or a failure', async () => {
    const { invoke, client } = setup()
    for (const args of [undefined, null, 'C:/repo', {}, { root: '   ' }, { root: 5 }]) {
      expect(await invoke('world:get', args)).toEqual({ success: false, error: 'root required' })
    }
    expect(client.get).not.toHaveBeenCalled()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await invoke('world:compile', { root: 'C:/bad' })).toEqual({ success: false, error: WORLD_CALL_FAILED })
      expect(await invoke('world:compile', { root: 'C:/odd' })).toEqual({ success: false, error: WORLD_CALL_FAILED })
      expect(warn.mock.calls.map((c) => c[1])).toEqual([new Error('graph missing'), 'odd failure'])
    } finally {
      warn.mockRestore()
    }
  })

  describe('a failure main meets before the host call is logged and shown as fixed text (WP3 round 3)', () => {
    // As git's own failure in headOf reads: the command line names the project folder.
    const gitFailed = (): Error => Object.assign(new Error('Command failed: git -C C:\\Users\\someone\\private-repo rev-parse HEAD'), { code: 128, cmd: 'git' })
    for (const channel of ['world:get', 'world:compile', 'world:relayout'] as const) {
      const fn = channel === 'world:get' ? 'get' : channel === 'world:compile' ? 'compile' : 'relayout'

      it(`${channel}: an unmarked error goes out as WORLD_CALL_FAILED, with no path, and the log gets it as it was`, async () => {
        const { invoke, client } = setup()
        const raw = gitFailed()
        vi.mocked(client[fn]).mockRejectedValueOnce(raw)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        try {
          const res = (await invoke(channel, { root: 'C:/repo' })) as { success: boolean; error: string }
          expect(res).toEqual({ success: false, error: WORLD_CALL_FAILED })
          expect(res.error).not.toContain('someone')
          expect(warn).toHaveBeenCalledTimes(1)
          expect(warn.mock.calls[0][1]).toBe(raw)
        } finally {
          warn.mockRestore()
        }
      })

      it(`${channel}: a host failure and main's own fixed text go out as they are, with nothing logged`, async () => {
        const { invoke, client } = setup()
        const host = shownAsIs(Object.assign(new Error("Lumopolis couldn't save this world's map. Try again in a moment."), { name: 'WorldSaveError', code: 'WORLD_SAVE_FAILED' }))
        vi.mocked(client[fn]).mockRejectedValueOnce(host).mockRejectedValueOnce(shownError('Lumopolis host is shut down'))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        try {
          expect(await invoke(channel, { root: 'C:/repo' })).toEqual({ success: false, error: host.message })
          expect(await invoke(channel, { root: 'C:/repo' })).toEqual({ success: false, error: 'Lumopolis host is shut down' })
          expect(warn).not.toHaveBeenCalled()
        } finally {
          warn.mockRestore()
        }
      })
    }
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

  it('world:ask passes a safe model on and drops an unsafe one', async () => {
    const asker = fakeAsker()
    const s = setup(undefined, undefined, asker)
    await s.invoke('world:ask', { ...GOOD, model: 'gpt-5.5-mini' })
    expect(asker.ask).toHaveBeenLastCalledWith({ ...GOOD, model: 'gpt-5.5-mini' })
    await s.invoke('world:ask', { ...GOOD, model: 'x; rm' })
    expect(asker.ask).toHaveBeenLastCalledWith(GOOD)
  })

  it('world:ask passes a short proposalId on and drops any other', async () => {
    const asker = fakeAsker()
    const s = setup(undefined, undefined, asker)
    await s.invoke('world:ask', { ...GOOD, proposalId: 'p1' })
    expect(asker.ask).toHaveBeenLastCalledWith({ ...GOOD, proposalId: 'p1' })
    for (const bad of ['', 'x'.repeat(129), 7, null]) {
      await s.invoke('world:ask', { ...GOOD, proposalId: bad })
      expect(asker.ask).toHaveBeenLastCalledWith(GOOD)
    }
    await s.invoke('world:ask', { ...GOOD, proposalId: 'x'.repeat(128) })
    expect(asker.ask).toHaveBeenLastCalledWith({ ...GOOD, proposalId: 'x'.repeat(128) })
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

  it('world:ask cleans the question first (U9): control characters but tab go, and the limit counts what is left', async () => {
    const asker = fakeAsker()
    const s = setup(undefined, undefined, asker)
    await s.invoke('world:ask', { ...GOOD, question: ' Why\u0000 is\tit\u001b slow?\n' })
    expect(asker.ask).toHaveBeenLastCalledWith({ ...GOOD, question: 'Why is\tit slow?' })
    expect(await s.invoke('world:ask', { ...GOOD, question: 'x'.repeat(4000) + '\u0007'.repeat(10) })).toMatchObject({ success: true })
    expect(await s.invoke('world:ask', { ...GOOD, question: '\u0000\u0007' })).toEqual({ success: false, error: 'question required (up to 4000 characters)' })
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

describe('registerWorldIpc design handlers', () => {
  const draftResult = { key: 'design:d1', doc: DOC, text: 'A plan.' }
  const refineResult = { doc: DOC, text: 'Done.', applied: 1, skipped: 0, summary: 'Q: x, A: Done.' }
  const fakeDesigner = () =>
    ({ draft: vi.fn(async () => draftResult), refine: vi.fn(async () => refineResult), confirm: vi.fn(async () => refineResult) }) as unknown as WorldDesigner & {
      draft: ReturnType<typeof vi.fn>
      refine: ReturnType<typeof vi.fn>
      confirm: ReturnType<typeof vi.fn>
    }
  const withDesigner = (d: WorldDesigner) => setup(undefined, undefined, undefined, d)

  it('registers the design handlers only when a designer is passed, after the rest', () => {
    expect([...setup().handlers.keys()]).not.toContain('world:design-draft')
    expect([...withDesigner(fakeDesigner()).handlers.keys()].slice(-4)).toEqual(['world:design-draft', 'world:design-refine', 'world:design-cancel', 'world:design-confirm'])
  })

  it('world:design-confirm makes the change a refine held for a yes, by design key (D3)', async () => {
    const d = fakeDesigner()
    const s = withDesigner(d)
    expect(await s.invoke('world:design-confirm', { key: 'design:d1', id: 'c7' })).toEqual({ success: true, data: refineResult })
    expect(d.confirm).toHaveBeenCalledWith('design:d1', 'c7')
    // DSN Round 1, item 2: a yes with no id, or one that is not a string, matches no held change, so the designer refuses it.
    await s.invoke('world:design-confirm', { key: 'design:d1' })
    expect(d.confirm).toHaveBeenLastCalledWith('design:d1', '')
    await s.invoke('world:design-confirm', { key: 'design:d1', id: 7 })
    expect(d.confirm).toHaveBeenLastCalledWith('design:d1', '')
    d.confirm.mockClear()
    for (const args of [undefined, 'design:d1', {}, { key: 'C:/repo' }, { key: 'design:..' }, { key: 'draft:t1' }, { key: 7 }]) {
      expect(await s.invoke('world:design-confirm', args)).toEqual({ success: false, error: 'design key required' })
    }
    expect(d.confirm).not.toHaveBeenCalled()
    d.confirm.mockRejectedValueOnce(new DesignFailure(DESIGN_REPLACED))
    expect(await s.invoke('world:design-confirm', { key: 'design:d1' })).toEqual({ success: false, error: DESIGN_REPLACED })
    d.confirm.mockRejectedValueOnce(new DesignFailure(DESIGN_CHANGED))
    expect(await s.invoke('world:design-confirm', { key: 'design:d1' })).toEqual({ success: false, error: DESIGN_CHANGED })
    d.confirm.mockRejectedValueOnce(new Error('EIO C:/Users/me'))
    expect(await s.invoke('world:design-confirm', { key: 'design:d1' })).toEqual({ success: false, error: DESIGN_FAILED })
  })

  it('world:design-draft passes the description through', async () => {
    const d = fakeDesigner()
    expect(await withDesigner(d).invoke('world:design-draft', { description: 'A shop' })).toEqual({ success: true, data: draftResult })
    expect(d.draft).toHaveBeenCalledWith('A shop', undefined, undefined)
  })

  it('world:design-draft and world:design-refine pass a safe model on and drop an unsafe one', async () => {
    const d = fakeDesigner()
    const s = withDesigner(d)
    await s.invoke('world:design-draft', { description: 'A shop', cancelKey: 'draft:t1', model: 'gpt-5.5-mini' })
    expect(d.draft).toHaveBeenLastCalledWith('A shop', 'draft:t1', 'gpt-5.5-mini')
    await s.invoke('world:design-draft', { description: 'A shop', model: 'x; rm' })
    expect(d.draft).toHaveBeenLastCalledWith('A shop', undefined, undefined)
    await s.invoke('world:design-refine', { key: 'design:d1', message: 'm', model: 'opus' })
    expect(d.refine).toHaveBeenLastCalledWith('design:d1', 'm', '', 'opus')
    await s.invoke('world:design-refine', { key: 'design:d1', message: 'm', model: '--bad' })
    expect(d.refine).toHaveBeenLastCalledWith('design:d1', 'm', '', undefined)
  })

  it.each([undefined, 'A shop', {}, { description: '' }, { description: '   ' }, { description: 7 }, { description: 'x'.repeat(4001) }])(
    'world:design-draft rejects %j',
    async (args) => {
      const d = fakeDesigner()
      expect(await withDesigner(d).invoke('world:design-draft', args)).toEqual({ success: false, error: 'description required (up to 4000 characters)' })
      expect(d.draft).not.toHaveBeenCalled()
    }
  )

  it('world:design-refine passes key, message and summary through; summary defaults to empty', async () => {
    const d = fakeDesigner()
    const s = withDesigner(d)
    expect(await s.invoke('world:design-refine', { key: 'design:d1', message: 'Add a cache', summary: 'Q: a' })).toEqual({ success: true, data: refineResult })
    expect(d.refine).toHaveBeenCalledWith('design:d1', 'Add a cache', 'Q: a', undefined)
    await s.invoke('world:design-refine', { key: 'design:d1', message: 'x'.repeat(4000) })
    expect(d.refine).toHaveBeenLastCalledWith('design:d1', 'x'.repeat(4000), '', undefined)
    // The design change comes from the same field, so it is cleaned the same way (U9).
    await s.invoke('world:design-refine', { key: 'design:d1', message: ' Add\u0000 a\tcache\n' })
    expect(d.refine).toHaveBeenLastCalledWith('design:d1', 'Add a\tcache', '', undefined)
  })

  it.each([
    [undefined, 'design request required'],
    ['design:d1', 'design request required'],
    [{ message: 'm' }, 'design key required'],
    [{ key: 'C:/repo', message: 'm' }, 'design key required'],
    [{ key: 7, message: 'm' }, 'design key required'],
    [{ key: 'design:..', message: 'm' }, 'design key required'],
    [{ key: 'design:a/b', message: 'm' }, 'design key required'],
    [{ key: 'design:d1' }, 'message required (up to 4000 characters)'],
    [{ key: 'design:d1', message: ' ' }, 'message required (up to 4000 characters)'],
    [{ key: 'design:d1', message: 'x'.repeat(4001) }, 'message required (up to 4000 characters)'],
    [{ key: 'design:d1', message: 'm', summary: 3 }, 'summary must be a string']
  ])('world:design-refine rejects %j', async (args, error) => {
    const d = fakeDesigner()
    expect(await withDesigner(d).invoke('world:design-refine', args)).toEqual({ success: false, error })
    expect(d.refine).not.toHaveBeenCalled()
  })

  it('shows a designer failure as it is and hides anything else', async () => {
    const d = fakeDesigner()
    const s = withDesigner(d)
    d.draft.mockRejectedValueOnce(new DesignFailure(DESIGN_NOT_FOUND))
    expect(await s.invoke('world:design-draft', { description: 'A shop' })).toEqual({ success: false, error: DESIGN_NOT_FOUND })
    d.draft.mockRejectedValueOnce(new Error('spawn ENOENT C:/Users/me/tool.exe'))
    expect(await s.invoke('world:design-draft', { description: 'A shop' })).toEqual({ success: false, error: DESIGN_FAILED })
    d.refine.mockRejectedValueOnce(new DesignFailure(DESIGN_SAVE_FAILED))
    expect(await s.invoke('world:design-refine', { key: 'design:d1', message: 'm' })).toEqual({ success: false, error: DESIGN_SAVE_FAILED })
    d.refine.mockRejectedValueOnce('odd')
    expect(await s.invoke('world:design-refine', { key: 'design:d1', message: 'm' })).toEqual({ success: false, error: DESIGN_FAILED })
  })
})

describe('world:annotate', () => {
  const annotated = (s: ReturnType<typeof setup>) => s.client as unknown as { annotate: ReturnType<typeof vi.fn> }

  it('stores a verified claim with person evidence and answers the doc', async () => {
    const s = setup()
    expect(await s.invoke('world:annotate', { key: 'k', itemId: 'b1', text: '  Keeps the DB out of the UI  ' })).toEqual({ success: true, data: DOC })
    expect(annotated(s).annotate).toHaveBeenCalledWith('k', 'b1', {
      text: 'Keeps the DB out of the UI', state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }]
    })
  })

  it('answers "No part with that id." for an unknown id, and a plain line for an unknown world', async () => {
    const s = setup()
    annotated(s).annotate.mockRejectedValueOnce(new Error('No part with that id.'))
    expect(await s.invoke('world:annotate', { key: 'k', itemId: 'nope', text: 'x' })).toEqual({ success: false, error: 'No part with that id.' })
    annotated(s).annotate.mockRejectedValueOnce(new Error('No world with that key.'))
    expect(await s.invoke('world:annotate', { key: 'zz', itemId: 'b1', text: 'x' })).toEqual({ success: false, error: 'No world with that key.' })
  })

  it('never shows a raw failure: any other failure reads as a reason after the pane prefix "Couldn\'t confirm:"', async () => {
    const s = setup()
    annotated(s).annotate.mockRejectedValueOnce(new Error('EACCES: C:\secret\path'))
    expect(await s.invoke('world:annotate', { key: 'k', itemId: 'b1', text: 'x' })).toEqual({ success: false, error: ANNOTATE_FAILED })
    annotated(s).annotate.mockRejectedValueOnce('odd')
    expect(await s.invoke('world:annotate', { key: 'k', itemId: 'b1', text: 'x' })).toEqual({ success: false, error: ANNOTATE_FAILED })
    // A coded save failure from the host is still one Try again answers: the same fixed reason.
    annotated(s).annotate.mockRejectedValueOnce(Object.assign(shownError(WORLD_SAVE_FAILED), { code: 'WORLD_SAVE_FAILED' }))
    expect(await s.invoke('world:annotate', { key: 'k', itemId: 'b1', text: 'x' })).toEqual({ success: false, error: ANNOTATE_FAILED })
    expect(ANNOTATE_FAILED).toBe("Lumopolis couldn't save it just now. Try again.")
  })

  it('#65: a world a newer Termpolis saved says so (by its code), since trying again would not help', async () => {
    const s = setup()
    annotated(s).annotate.mockRejectedValueOnce(Object.assign(shownError('the host words'), { code: 'WORLD_SAVED_BY_NEWER' }))
    expect(await s.invoke('world:annotate', { key: 'k', itemId: 'b1', text: 'x' })).toEqual({ success: false, error: WORLD_SAVED_BY_NEWER })
    // The code alone is not enough: an error main never marked fit to show (it did not come from the host) is fixed text.
    annotated(s).annotate.mockRejectedValueOnce(Object.assign(new Error('raw'), { code: 'WORLD_SAVED_BY_NEWER' }))
    expect(await s.invoke('world:annotate', { key: 'k', itemId: 'b1', text: 'x' })).toEqual({ success: false, error: ANNOTATE_FAILED })
  })

  describe('a design key goes to the designer, which writes the design under its lock (D1)', () => {
    const designerWith = (annotate: ReturnType<typeof vi.fn>) => {
      const designer = { draft: vi.fn(), refine: vi.fn(), cancel: vi.fn(), confirm: vi.fn(), annotate } as unknown as WorldDesigner
      return setup(undefined, undefined, undefined, designer)
    }

    it('stores the verified claim through the designer and never through the world host', async () => {
      const annotate = vi.fn(async () => DOC)
      const s = designerWith(annotate)
      expect(await s.invoke('world:annotate', { key: 'design:d1', itemId: 'b1', text: ' Takes orders ' })).toEqual({ success: true, data: DOC })
      expect(annotate).toHaveBeenCalledWith('design:d1', 'b1', { text: 'Takes orders', state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] })
      expect(annotated(s).annotate).not.toHaveBeenCalled()
      // A project world still goes to the host.
      await s.invoke('world:annotate', { key: 'k', itemId: 'b1', text: 'x' })
      expect(annotated(s).annotate).toHaveBeenCalledTimes(1)
    })

    it.each([
      [new DesignFailure(NO_PART), NO_PART],
      [new DesignFailure(WORLD_SAVED_BY_NEWER), WORLD_SAVED_BY_NEWER],
      [new DesignFailure(DESIGN_NOT_FOUND), 'No world with that key.'],
      [new DesignFailure(DESIGN_SAVE_FAILED), ANNOTATE_FAILED],
      [new Error('No part with that id.'), ANNOTATE_FAILED],
      ['odd', ANNOTATE_FAILED]
    ])('answers the designer refusal %s as the pane reads it', async (e, error) => {
      const s = designerWith(vi.fn(async () => { throw e }))
      expect(await s.invoke('world:annotate', { key: 'design:d1', itemId: 'b1', text: 'x' })).toEqual({ success: false, error })
    })
  })

  it('rejects a missing key, a non-string id, and blank or non-string text', async () => {
    const s = setup()
    for (const args of [undefined, {}, { key: '', itemId: 'b', text: 'x' }, { key: 'k', itemId: 3, text: 'x' }, { key: 'k', itemId: 'b', text: '   ' }, { key: 'k', itemId: 'b', text: 7 }]) {
      expect(await s.invoke('world:annotate', args)).toEqual({ success: false, error: 'key, itemId and text required' })
    }
    expect(annotated(s).annotate).not.toHaveBeenCalled()
  })
})
