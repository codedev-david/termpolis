// @vitest-environment node
// The IPC behind Settings > Memory > "Claude Code's saved notes". A fake ipc records the handlers; the
// settings and the removal are fakes too, so what is under test is the handlers' own rules: which values
// count, the order of the removal, and that a failure comes back as the app's usual error envelope.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTES_IPC, registerClaudeNotesIpc, type NotesIpcDeps, type NotesIpcLike } from '../../src/main/claudeNotesIpc'
import type { NotesStatus } from '../../src/main/claudeNotesIngest'

const STATUS: NotesStatus = { notes: 3, chunks: 5, projects: 2, lastAt: 1700000000000, noProject: 1, secretsRedacted: 0, pending: 0 }

let handlers: Map<string, (event: unknown, input?: unknown) => unknown>
let state: { index: boolean; share: boolean; connected: boolean; locked: boolean }
let calls: string[]
let d: NotesIpcDeps

beforeEach(() => {
  handlers = new Map()
  state = { index: true, share: false, connected: true, locked: false }
  calls = []
  const ipc: NotesIpcLike = { handle: (channel, fn) => { handlers.set(channel, fn) } }
  d = {
    index: { get: () => state.index, set: (on) => { calls.push(`index:${on}`); state.index = on } },
    share: { get: () => state.share, set: (on) => { calls.push(`share:${on}`); state.share = on } },
    connected: () => state.connected,
    locked: async () => state.locked,
    status: () => STATUS,
    remove: vi.fn(async () => { calls.push('remove'); return { removed: 5, failed: 0 } }),
    passSoon: vi.fn(() => { calls.push('pass') }),
  }
  registerClaudeNotesIpc(ipc, d)
})

const call = (channel: string, input?: unknown): Promise<any> => Promise.resolve(handlers.get(channel)!(undefined, input))

describe('Claude Code\'s saved notes: the settings IPC', () => {
  it('registers exactly three channels', () => {
    expect([...handlers.keys()].sort()).toEqual(['memory:get-notes-settings', 'memory:remove-imported-notes', 'memory:set-notes-settings'])
    expect(NOTES_IPC).toEqual({ get: 'memory:get-notes-settings', set: 'memory:set-notes-settings', remove: 'memory:remove-imported-notes' })
  })

  it('get answers with both switches, whether the agents are connected, and what was imported', async () => {
    expect(await call(NOTES_IPC.get)).toEqual({
      success: true,
      data: { indexClaudeNotes: true, shareNotesAcrossProjects: false, connected: true, locked: false, status: STATUS },
    })
    state.connected = false
    expect((await call(NOTES_IPC.get)).data.connected).toBe(false)
  })

  // Memory locked (its key cannot be opened) pauses the import and every removal. The panel has to be able to say so, or a switch
  // turned on does nothing and "Nothing imported yet" gives no reason.
  it('every answer that carries the settings says whether memory is locked', async () => {
    state.locked = true
    expect((await call(NOTES_IPC.get)).data.locked).toBe(true)
    expect((await call(NOTES_IPC.set, { shareNotesAcrossProjects: true })).data.locked).toBe(true)
    expect((await call(NOTES_IPC.remove)).data.settings.locked).toBe(true)
    state.locked = false
    expect((await call(NOTES_IPC.get)).data.locked).toBe(false)
  })

  it('a lock that cannot be read is not reported as locked, and does not fail the answer', async () => {
    d.locked = async () => { throw new Error('host down') }
    const res = await call(NOTES_IPC.get)
    expect(res.success).toBe(true)
    expect(res.data.locked).toBe(false)
  })

  it('set changes the switch it is given and answers with the new state', async () => {
    const res = await call(NOTES_IPC.set, { shareNotesAcrossProjects: true })
    expect(res.data).toMatchObject({ indexClaudeNotes: true, shareNotesAcrossProjects: true })
    expect(calls).toEqual(['share:true'])
    const both = await call(NOTES_IPC.set, { indexClaudeNotes: false, shareNotesAcrossProjects: false })
    expect(both.data).toMatchObject({ indexClaudeNotes: false, shareNotesAcrossProjects: false })
  })

  it('set counts only real booleans: a string, a number or a missing key changes nothing', async () => {
    for (const input of [{ indexClaudeNotes: 'false' }, { indexClaudeNotes: 0 }, { shareNotesAcrossProjects: 'true' }, { shareNotesAcrossProjects: 1 }, {}, null, undefined, 'x', [], 7]) {
      state.index = true
      state.share = false
      calls.length = 0
      const res = await call(NOTES_IPC.set, input)
      expect(res.success).toBe(true)
      expect(calls).toEqual([])
      expect(state).toMatchObject({ index: true, share: false })
    }
  })

  it('turning the notes on starts a pass at once; turning something else on or off does not', async () => {
    state.index = false
    await call(NOTES_IPC.set, { indexClaudeNotes: true })
    expect(d.passSoon).toHaveBeenCalledTimes(1)
    await call(NOTES_IPC.set, { indexClaudeNotes: true }) // already on
    await call(NOTES_IPC.set, { shareNotesAcrossProjects: true })
    await call(NOTES_IPC.set, { indexClaudeNotes: false })
    expect(d.passSoon).toHaveBeenCalledTimes(1)
  })

  it('remove turns the notes off first, then removes, and answers with what it did and the new state', async () => {
    const res = await call(NOTES_IPC.remove)
    expect(calls).toEqual(['index:false', 'remove']) // off before the first delete, or a pass could bring them straight back
    expect(res).toEqual({
      success: true,
      data: { removed: 5, failed: 0, settings: { indexClaudeNotes: false, shareNotesAcrossProjects: false, connected: true, locked: false, status: STATUS } },
    })
  })

  it('remove keeps the switch off even when some could not be removed', async () => {
    d.remove = vi.fn(async () => ({ removed: 2, failed: 3 }))
    registerClaudeNotesIpc({ handle: (c, fn) => { handlers.set(c, fn) } }, d)
    const res = await call(NOTES_IPC.remove)
    expect(res.data).toMatchObject({ removed: 2, failed: 3 })
    expect(state.index).toBe(false)
  })

  // The settings module refuses to say a switch was changed when it could not save it (it throws). Both channels have to
  // pass that on as an error, or the panel would show a choice that was never kept.
  it('set answers a switch that could not be saved with the error, and the panel is left with the state main holds', async () => {
    d.index.set = () => { throw new Error('The setting could not be saved') }
    const res = await call(NOTES_IPC.set, { indexClaudeNotes: false })
    expect(res).toEqual({ success: false, error: 'The setting could not be saved' })
    expect(d.passSoon).not.toHaveBeenCalled()
  })

  it('remove stops before it removes anything when the switch cannot be turned off and kept off', async () => {
    d.index.set = () => { throw new Error('The setting could not be saved') }
    const res = await call(NOTES_IPC.remove)
    expect(res).toEqual({ success: false, error: 'The setting could not be saved' })
    expect(d.remove).not.toHaveBeenCalled() // the import would only bring them back at the next start
  })

  it('every channel answers a failure with the error envelope, never by throwing', async () => {
    d.status = () => { throw new Error('manifest unreadable') }
    registerClaudeNotesIpc({ handle: (c, fn) => { handlers.set(c, fn) } }, d)
    expect(await call(NOTES_IPC.get)).toEqual({ success: false, error: 'manifest unreadable' })
    expect(await call(NOTES_IPC.set, { shareNotesAcrossProjects: true })).toEqual({ success: false, error: 'manifest unreadable' })

    d.index = { get: () => true, set: () => { throw 'store gone' } }
    registerClaudeNotesIpc({ handle: (c, fn) => { handlers.set(c, fn) } }, d)
    expect(await call(NOTES_IPC.remove)).toEqual({ success: false, error: 'store gone' })
  })
})
