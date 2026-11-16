import { describe, expect, it, vi } from 'vitest'
import {
  BUILD_PROMPT, CLONE_FAILED, FOLDER_FAILED, NOT_EMPTY, SOURCES_FAILED, registerWorldIpc,
  type WorldDesigner, type WorldIpcClient, type WorldSourcesDeps
} from '../../src/main/world/ipc'
import { DESIGN_NOT_FOUND } from '../../src/main/world/designer'
import { BAD_REF_MESSAGE, BAD_URL_MESSAGE } from '../../src/shared/world/gitUrl'
import type { WorldDoc, WorldEntry, WorldSource } from '../../src/shared/world/types'
import type { WorldSettingsStore } from '../../src/main/world/worldSettings'

const DOC = { projectKey: 'design:d1', version: 1 } as unknown as WorldDoc
const entryOf = (source: WorldSource, title = 't'): WorldEntry => ({ key: source.kind === 'design' ? `design:${source.id}` : `k-${source.root}`, source, title, lastOpened: 1 })

function setup(over: Partial<WorldSourcesDeps> = {}, designer?: WorldDesigner) {
  const handlers = new Map<string, (e: unknown, args?: unknown) => unknown>()
  const ipc = { handle: vi.fn((ch: string, fn: (e: unknown, args?: unknown) => unknown) => { handlers.set(ch, fn) }) }
  const client = {
    get: vi.fn(), compile: vi.fn(), relayout: vi.fn(), applySettings: vi.fn(),
    onProgress: () => () => undefined, onUpdated: () => () => undefined
  } as unknown as WorldIpcClient
  const settings = { get: vi.fn(), set: vi.fn() } as unknown as WorldSettingsStore
  const registry = {
    list: vi.fn(async () => [entryOf({ kind: 'folder', root: 'C:/a' })]),
    upsert: vi.fn(async (s: WorldSource, title?: string) => entryOf(s, title)),
    remove: vi.fn(async () => undefined),
    touch: vi.fn(async (key: string) => (key === 'kf' ? { ...entryOf({ kind: 'folder', root: 'C:/f' }), lastOpened: 9 } : null)),
    get: vi.fn(async (key: string) => (key === 'design:d1' ? entryOf({ kind: 'design', id: 'd1', title: 'Shop' }, 'Shop') : null))
  }
  const deps: WorldSourcesDeps = {
    registry,
    designs: { load: vi.fn(async (key: string) => (key === 'design:d1' ? DOC : null)) },
    pickFolder: vi.fn(async () => 'C:/picked'),
    isEmpty: vi.fn(async () => true),
    clone: vi.fn(async () => ({ ok: true as const, root: 'C:/ud/world/repos/abc' })),
    cancelClone: vi.fn(async () => true),
    ...over
  }
  registerWorldIpc(ipc, client, () => null, settings, undefined, designer, deps)
  const invoke = (ch: string, args?: unknown) => (handlers.get(ch) as (e: unknown, a?: unknown) => Promise<unknown>)({}, args)
  return { handlers, invoke, deps, registry }
}

describe('registerWorldIpc sources handlers', () => {
  it('registers the source handlers only when sources are passed', () => {
    const keys = [...setup().handlers.keys()]
    for (const ch of ['world:sources-list', 'world:map-project', 'world:open-folder', 'world:pick-folder', 'world:clone', 'world:clone-cancel', 'world:remove-source', 'world:touch-source', 'world:design-get', 'world:build-it']) {
      expect(keys).toContain(ch)
    }
  })

  it('world:sources-list answers the registry list; a failure is a fixed message', async () => {
    const s = setup()
    expect(await s.invoke('world:sources-list')).toEqual({ success: true, data: [entryOf({ kind: 'folder', root: 'C:/a' })] })
    s.registry.list.mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:sources-list')).toEqual({ success: false, error: SOURCES_FAILED })
  })

  it('world:map-project registers the project root; a relative or missing root is refused', async () => {
    const s = setup()
    expect(await s.invoke('world:map-project', { root: 'C:/repo' })).toEqual({ success: true, data: entryOf({ kind: 'project', root: 'C:/repo' }) })
    expect(s.registry.upsert).toHaveBeenCalledWith({ kind: 'project', root: 'C:/repo' })
    for (const bad of [undefined, {}, { root: 'rel/x' }, { root: 7 }]) {
      expect(await s.invoke('world:map-project', bad)).toEqual({ success: false, error: 'root required' })
    }
    s.registry.upsert.mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:map-project', { root: 'C:/repo' })).toEqual({ success: false, error: SOURCES_FAILED })
  })

  it('world:open-folder asks the native dialog, registers the folder, and answers null on cancel', async () => {
    const s = setup()
    expect(await s.invoke('world:open-folder')).toEqual({ success: true, data: entryOf({ kind: 'folder', root: 'C:/picked' }) })
    expect(s.registry.upsert).toHaveBeenCalledWith({ kind: 'folder', root: 'C:/picked' })
    ;(s.deps.pickFolder as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    expect(await s.invoke('world:open-folder')).toEqual({ success: true, data: null })
    ;(s.deps.pickFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no window'))
    expect(await s.invoke('world:open-folder')).toEqual({ success: false, error: FOLDER_FAILED })
  })

  it('world:pick-folder answers the folder and whether it is empty, and registers nothing', async () => {
    const s = setup()
    expect(await s.invoke('world:pick-folder')).toEqual({ success: true, data: { root: 'C:/picked', empty: true } })
    ;(s.deps.isEmpty as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    expect(await s.invoke('world:pick-folder')).toEqual({ success: true, data: { root: 'C:/picked', empty: false } })
    ;(s.deps.pickFolder as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    expect(await s.invoke('world:pick-folder')).toEqual({ success: true, data: null })
    ;(s.deps.isEmpty as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('EACCES'))
    expect(await s.invoke('world:pick-folder')).toEqual({ success: false, error: FOLDER_FAILED })
    expect(s.registry.upsert).not.toHaveBeenCalled()
  })

  it('world:clone clones, then registers a git source with its url and branch', async () => {
    const s = setup()
    const root = 'C:/ud/world/repos/abc'
    expect(await s.invoke('world:clone', { url: 'https://example.com/a/shop.git', ref: 'main' }))
      .toEqual({ success: true, data: entryOf({ kind: 'git', url: 'https://example.com/a/shop.git', ref: 'main', root }) })
    expect(s.deps.clone).toHaveBeenCalledWith('https://example.com/a/shop.git', 'main')
    await s.invoke('world:clone', { url: 'git@example.com:a/shop.git' })
    expect(s.deps.clone).toHaveBeenLastCalledWith('git@example.com:a/shop.git', undefined)
    expect(s.registry.upsert).toHaveBeenLastCalledWith({ kind: 'git', url: 'git@example.com:a/shop.git', root })
  })

  it('world:clone refuses a bad url or branch before git runs, and passes the clone failure on', async () => {
    const s = setup()
    for (const bad of [undefined, {}, { url: '--upload-pack=x' }, { url: 'file:///etc' }, { url: 7 }]) {
      expect(await s.invoke('world:clone', bad)).toEqual({ success: false, error: BAD_URL_MESSAGE })
    }
    for (const ref of ['-x', 'a..b', 7, 'a b']) {
      expect(await s.invoke('world:clone', { url: 'https://example.com/r', ref })).toEqual({ success: false, error: BAD_REF_MESSAGE })
    }
    expect(s.deps.clone).not.toHaveBeenCalled()
    ;(s.deps.clone as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'Cancelled' })
    expect(await s.invoke('world:clone', { url: 'https://example.com/r' })).toEqual({ success: false, error: 'Cancelled' })
    ;(s.deps.clone as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('host gone'))
    expect(await s.invoke('world:clone', { url: 'https://example.com/r' })).toEqual({ success: false, error: CLONE_FAILED })
    expect(s.registry.upsert).not.toHaveBeenCalled()
    s.registry.upsert.mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:clone', { url: 'https://example.com/r' })).toEqual({ success: false, error: SOURCES_FAILED })
  })

  it('world:clone-cancel stops the clone for the same url and branch', async () => {
    const s = setup()
    expect(await s.invoke('world:clone-cancel', { url: 'https://example.com/r', ref: 'dev' })).toEqual({ success: true, data: true })
    expect(s.deps.cancelClone).toHaveBeenCalledWith('https://example.com/r', 'dev')
    expect(await s.invoke('world:clone-cancel', { url: 'nope' })).toEqual({ success: false, error: BAD_URL_MESSAGE })
    expect(await s.invoke('world:clone-cancel', { url: 'https://example.com/r', ref: '-f' })).toEqual({ success: false, error: BAD_REF_MESSAGE })
    ;(s.deps.cancelClone as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('host gone'))
    expect(await s.invoke('world:clone-cancel', { url: 'https://example.com/r' })).toEqual({ success: true, data: false })
  })

  it('world:remove-source removes the entry by key', async () => {
    const s = setup()
    expect(await s.invoke('world:remove-source', { key: 'design:d1' })).toEqual({ success: true, data: true })
    expect(s.registry.remove).toHaveBeenCalledWith('design:d1')
    for (const bad of [undefined, {}, { key: '' }, { key: 7 }, { key: 'x'.repeat(201) }]) {
      expect(await s.invoke('world:remove-source', bad)).toEqual({ success: false, error: 'key required' })
    }
    s.registry.remove.mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:remove-source', { key: 'k' })).toEqual({ success: false, error: SOURCES_FAILED })
  })

  it('world:touch-source marks a world opened now and answers it (null for an unknown key)', async () => {
    const s = setup()
    expect(await s.invoke('world:touch-source', { key: 'kf' })).toEqual({ success: true, data: { ...entryOf({ kind: 'folder', root: 'C:/f' }), lastOpened: 9 } })
    expect(s.registry.touch).toHaveBeenCalledWith('kf')
    expect(await s.invoke('world:touch-source', { key: 'gone' })).toEqual({ success: true, data: null })
    for (const bad of [undefined, {}, { key: '' }, { key: 7 }, { key: 'x'.repeat(201) }]) {
      expect(await s.invoke('world:touch-source', bad)).toEqual({ success: false, error: 'key required' })
    }
    s.registry.touch.mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:touch-source', { key: 'kf' })).toEqual({ success: false, error: SOURCES_FAILED })
  })

  it('world:design-get answers the stored design; an unknown, bad or unreadable key is not found', async () => {
    const s = setup()
    expect(await s.invoke('world:design-get', { key: 'design:d1' })).toEqual({ success: true, data: DOC })
    expect(await s.invoke('world:design-get', { key: 'design:zz' })).toEqual({ success: false, error: DESIGN_NOT_FOUND })
    for (const bad of [undefined, { key: 'C:/repo' }, { key: 'design:..' }]) {
      expect(await s.invoke('world:design-get', bad)).toEqual({ success: false, error: DESIGN_NOT_FOUND })
    }
    ;(s.deps.designs.load as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:design-get', { key: 'design:d1' })).toEqual({ success: false, error: DESIGN_NOT_FOUND })
  })
})

describe('registerWorldIpc world:build-it', () => {
  const GOOD = { key: 'design:d1', root: 'C:/build/shop', agent: 'claude' }

  it('links the design to the folder and answers the folder, the title and the first prompt', async () => {
    const s = setup()
    const prompt = 'Build the app described by the Lumopolis design "Shop". Read it with gateway_call server "lumopolis", tool "world_read" (designKey "design:d1"). Work in this folder.'
    expect(BUILD_PROMPT('Shop', 'design:d1')).toBe(prompt)
    expect(await s.invoke('world:build-it', GOOD)).toEqual({ success: true, data: { root: 'C:/build/shop', key: 'design:d1', title: 'Shop', prompt } })
    expect(s.registry.upsert).toHaveBeenCalledWith({ kind: 'folder', root: 'C:/build/shop', linkedDesign: 'design:d1' })
  })

  it('starts watching the folder, so the world follows the build; a watch failure does not fail Build it', async () => {
    const watch = vi.fn()
    const s = setup({ watch })
    await s.invoke('world:build-it', GOOD)
    expect(watch).toHaveBeenCalledWith('C:/build/shop')
    watch.mockImplementationOnce(() => { throw new Error('EMFILE') })
    expect((await s.invoke('world:build-it', GOOD) as { success: boolean }).success).toBe(true)
  })

  it('refuses a folder that is not empty unless the user confirmed it', async () => {
    const s = setup({ isEmpty: vi.fn(async () => false) })
    expect(await s.invoke('world:build-it', GOOD)).toEqual({ success: false, error: NOT_EMPTY })
    expect(s.registry.upsert).not.toHaveBeenCalled()
    expect((await s.invoke('world:build-it', { ...GOOD, confirmNonEmpty: true }) as { success: boolean }).success).toBe(true)
  })

  it.each([
    [undefined, DESIGN_NOT_FOUND],
    [{ ...GOOD, key: 'C:/x' }, DESIGN_NOT_FOUND],
    [{ ...GOOD, root: 'rel' }, 'root required'],
    [{ ...GOOD, root: 7 }, 'root required'],
    [{ ...GOOD, agent: '' }, 'agent required'],
    [{ ...GOOD, agent: 'rm -rf' }, 'agent required'],
    [{ ...GOOD, confirmNonEmpty: 'yes' }, 'confirmNonEmpty must be a boolean']
  ])('refuses %j', async (args, error) => {
    const s = setup()
    expect(await s.invoke('world:build-it', args)).toEqual({ success: false, error })
    expect(s.registry.upsert).not.toHaveBeenCalled()
  })

  it('a design that is not registered is not found; an unreadable folder or a failed save are fixed messages', async () => {
    const s = setup()
    expect(await s.invoke('world:build-it', { ...GOOD, key: 'design:gone' })).toEqual({ success: false, error: DESIGN_NOT_FOUND })
    s.registry.get.mockResolvedValueOnce(entryOf({ kind: 'folder', root: 'C:/a' }))
    expect(await s.invoke('world:build-it', GOOD)).toEqual({ success: false, error: DESIGN_NOT_FOUND })
    s.registry.get.mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:build-it', GOOD)).toEqual({ success: false, error: SOURCES_FAILED })
    ;(s.deps.isEmpty as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ENOENT'))
    expect(await s.invoke('world:build-it', GOOD)).toEqual({ success: false, error: FOLDER_FAILED })
    s.registry.upsert.mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:build-it', GOOD)).toEqual({ success: false, error: SOURCES_FAILED })
  })
})

describe('registerWorldIpc design cancel and draft cancel key', () => {
  const fake = () => ({
    draft: vi.fn(async () => ({ key: 'design:d1', doc: DOC, text: '' })),
    refine: vi.fn(),
    cancel: vi.fn(() => true)
  }) as unknown as WorldDesigner & { draft: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }

  it('world:design-cancel stops a draft (draft:<token>) or a refine (design:<id>)', async () => {
    const d = fake()
    const s = setup({}, d)
    expect(await s.invoke('world:design-cancel', { key: 'draft:t-1' })).toEqual({ success: true, data: true })
    expect(await s.invoke('world:design-cancel', { key: 'design:d1' })).toEqual({ success: true, data: true })
    expect(d.cancel).toHaveBeenCalledWith('draft:t-1')
    expect(d.cancel).toHaveBeenCalledWith('design:d1')
    for (const bad of [undefined, { key: 'C:/x' }, { key: 'draft:..' }, { key: 7 }]) {
      expect(await s.invoke('world:design-cancel', bad)).toEqual({ success: false, error: 'design key required' })
    }
  })

  it('world:design-draft passes a draft cancel key through, and refuses any other', async () => {
    const d = fake()
    const s = setup({}, d)
    await s.invoke('world:design-draft', { description: 'A shop', cancelKey: 'draft:t1' })
    expect(d.draft).toHaveBeenCalledWith('A shop', 'draft:t1')
    expect(await s.invoke('world:design-draft', { description: 'A shop', cancelKey: 'design:x' })).toEqual({ success: false, error: 'cancelKey must be draft:<id>' })
    expect(d.draft).toHaveBeenCalledTimes(1)
  })
})
