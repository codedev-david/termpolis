import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BAD_ACCESS, BUILD_PROMPT, CLONE_FAILED, FOLDER_FAILED, NOT_A_PROJECT, NOT_EMPTY, NOT_PICKED, SOURCES_FAILED, UPDATE_FAILED, registerWorldIpc,
  type WorldDesigner, type WorldIpcClient, type WorldSourcesDeps
} from '../../src/main/world/ipc'
import { DESIGN_NOT_FOUND } from '../../src/main/world/designer'
import { FORBIDDEN_FOLDER } from '../../src/main/world/folderSafety'
import { taskPromptArg } from '../../src/shared/taskRouter'
import { BAD_REF_MESSAGE, BAD_URL_MESSAGE } from '../../src/shared/world/gitUrl'
import { AUTH_MESSAGE, NOT_FOUND_MESSAGE, STILL_NOT_FOUND_MESSAGE, cloneKey } from '../../src/main/world/gitSource'
import { TOKEN_REJECTED_MESSAGE } from '../../src/shared/world/repoAccess'
import { createSourceRegistry } from '../../src/main/world/sources'
import type { WorldDoc, WorldEntry, WorldSource } from '../../src/shared/world/types'
import type { WorldSettingsStore } from '../../src/main/world/worldSettings'

const DOC = { projectKey: 'design:d1', version: 1 } as unknown as WorldDoc
const entryOf = (source: WorldSource, title = 't'): WorldEntry => ({ key: source.kind === 'design' ? `design:${source.id}` : `k-${source.root}`, source, title, lastOpened: 1 })

function setup(over: Partial<WorldSourcesDeps> = {}, designer?: WorldDesigner, clientOver: Partial<WorldIpcClient> = {}) {
  const handlers = new Map<string, (e: unknown, args?: unknown) => unknown>()
  const ipc = { handle: vi.fn((ch: string, fn: (e: unknown, args?: unknown) => unknown) => { handlers.set(ch, fn) }) }
  const client = {
    get: vi.fn(), compile: vi.fn(), relayout: vi.fn(), applySettings: vi.fn(),
    onProgress: () => () => undefined, onUpdated: () => () => undefined, ...clientOver
  } as unknown as WorldIpcClient
  const settings = { get: vi.fn(), set: vi.fn() } as unknown as WorldSettingsStore
  const registry = {
    list: vi.fn(async () => [entryOf({ kind: 'folder', root: 'C:/a' })]),
    upsert: vi.fn(async (s: WorldSource, title?: string) => entryOf(s, title)),
    remove: vi.fn(async () => undefined),
    touch: vi.fn(async (key: string) => (key === 'kf' ? { ...entryOf({ kind: 'folder', root: 'C:/f' }), lastOpened: 9 } : null)),
    get: vi.fn(async (key: string) => (key === 'design:d1' ? entryOf({ kind: 'design', id: 'd1', title: 'Shop' }, 'Shop') : null)),
    setLogin: vi.fn(async () => null)
  }
  const deps: WorldSourcesDeps = {
    registry,
    designs: { load: vi.fn(async (key: string) => (key === 'design:d1' ? DOC : null)) },
    pickFolder: vi.fn(async () => 'C:/picked'),
    isEmpty: vi.fn(async () => true),
    clone: vi.fn(async () => ({ ok: true as const, root: 'C:/ud/world/repos/abc' })),
    updateSource: vi.fn(async () => ({ ok: true as const, changed: true })),
    cancelClone: vi.fn(async () => true),
    homeDir: 'C:/Users/me',
    userDataDir: 'C:/ud',
    isProject: vi.fn(async () => true),
    ...over
  }
  registerWorldIpc(ipc, client, () => null, settings, undefined, designer, deps)
  const invoke = (ch: string, args?: unknown) => (handlers.get(ch) as (e: unknown, a?: unknown) => Promise<unknown>)({}, args)
  return { handlers, invoke, deps, registry }
}

describe('registerWorldIpc sources handlers', () => {
  it('registers the source handlers only when sources are passed', () => {
    const keys = [...setup().handlers.keys()]
    for (const ch of ['world:sources-list', 'world:map-project', 'world:open-folder', 'world:pick-folder', 'world:clone', 'world:clone-cancel', 'world:remove-source', 'world:touch-source', 'world:update-source', 'world:design-get', 'world:build-it']) {
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

  it('world:map-project registers only a folder that looks like a project, or one already in the home', async () => {
    const s = setup({ isProject: vi.fn(async () => false) })
    expect(await s.invoke('world:map-project', { root: 'C:/plain' })).toEqual({ success: false, error: NOT_A_PROJECT })
    expect(s.deps.isProject).toHaveBeenCalledWith('C:/plain')
    expect(s.registry.upsert).not.toHaveBeenCalled()
    expect(await s.invoke('world:map-project', { root: 'C:/a' })).toEqual({ success: true, data: entryOf({ kind: 'project', root: 'C:/a' }) })
    ;(s.deps.isProject as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:map-project', { root: 'C:/plain' })).toEqual({ success: false, error: SOURCES_FAILED })
    // Without an isProject dep the real check looks for a project marker in the folder.
    const tmp = await mkdtemp(join(tmpdir(), 'world-map-'))
    try {
      await mkdir(join(tmp, 'proj'))
      await writeFile(join(tmp, 'proj', 'package.json'), '{}')
      await mkdir(join(tmp, 'plain'))
      const real = setup({ isProject: undefined })
      expect(await real.invoke('world:map-project', { root: join(tmp, 'proj') })).toMatchObject({ success: true })
      expect(await real.invoke('world:map-project', { root: join(tmp, 'plain') })).toEqual({ success: false, error: NOT_A_PROJECT })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('world:map-project refuses a drive, the home folder or Termpolis data, and so does every handler for a link to one', async () => {
    const drive = parse(process.cwd()).root
    for (const root of [drive, 'C:/Users/me', 'C:/Users', 'C:/ud/world/repos/abc']) {
      const s = setup()
      expect(await s.invoke('world:map-project', { root })).toEqual({ success: false, error: FORBIDDEN_FOLDER })
      expect(s.deps.isProject).not.toHaveBeenCalled()
      expect(s.registry.upsert).not.toHaveBeenCalled()
    }
    const link = 'C:/elsewhere/link'
    const realpath = vi.fn(async (p: string) => (p === link ? 'C:/Users/me' : p))
    const s = setup({ realpath, pickFolder: vi.fn(async () => link) })
    expect(await s.invoke('world:map-project', { root: link })).toEqual({ success: false, error: FORBIDDEN_FOLDER })
    expect(await s.invoke('world:open-folder')).toEqual({ success: false, error: FORBIDDEN_FOLDER })
    expect(await s.invoke('world:pick-folder')).toEqual({ success: false, error: FORBIDDEN_FOLDER })
    expect(await s.invoke('world:build-it', { key: 'design:d1', root: link, agent: 'claude' })).toEqual({ success: false, error: FORBIDDEN_FOLDER })
    expect(realpath).toHaveBeenCalledWith(link)
    expect(s.registry.upsert).not.toHaveBeenCalled()
  })

  it('world:map-project refuses a clone root under userData, even one the home lists as a git source: a clone is never re-registered as a project', async () => {
    const root = 'C:/ud/world/repos/abc'
    const s = setup()
    s.registry.list.mockResolvedValue([entryOf({ kind: 'git', url: 'https://example.com/a/shop.git', root })])
    expect(await s.invoke('world:map-project', { root })).toEqual({ success: false, error: FORBIDDEN_FOLDER })
    expect(await s.invoke('world:map-project', { root: `${root}/src` })).toEqual({ success: false, error: FORBIDDEN_FOLDER })
    expect(s.deps.isProject).not.toHaveBeenCalled()
    expect(s.registry.upsert).not.toHaveBeenCalled()
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

  it('world:remove-source also cancels the labelling calls still waiting for a slot (caveat 4)', async () => {
    const cancelLabelling = vi.fn()
    const s = setup({}, undefined, { cancelLabelling })
    expect(await s.invoke('world:remove-source', { key: 'k-C:/a' })).toEqual({ success: true, data: true })
    expect(cancelLabelling).toHaveBeenCalledWith('k-C:/a')
    // A remove that failed keeps the world, and its labelling.
    s.registry.remove.mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:remove-source', { key: 'k2' })).toEqual({ success: false, error: SOURCES_FAILED })
    expect(cancelLabelling).toHaveBeenCalledTimes(1)
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

  it('a touch that fails is written to the app log by its error code alone, never its message or the key', async () => {
    const s = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      s.registry.touch.mockRejectedValueOnce(Object.assign(new Error('EPERM: operation not permitted, rename C:/Users/someone/world/sources.json'), { code: 'EPERM' }))
      expect(await s.invoke('world:touch-source', { key: 'kf' })).toEqual({ success: false, error: SOURCES_FAILED })
      s.registry.touch.mockRejectedValueOnce(new Error('disk'))
      await s.invoke('world:touch-source', { key: 'kf' })
      s.registry.touch.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'not a code, with C:/a/path' }))
      await s.invoke('world:touch-source', { key: 'kf' })
      s.registry.touch.mockRejectedValueOnce('a plain string')
      await s.invoke('world:touch-source', { key: 'kf' })
      expect(warn.mock.calls).toEqual([
        ['[world] marking a world opened failed:', 'EPERM'],
        ['[world] marking a world opened failed:', 'unknown'],
        ['[world] marking a world opened failed:', 'unknown'],
        ['[world] marking a world opened failed:', 'unknown'],
      ])
    } finally {
      warn.mockRestore()
    }
  })

  it('world:clone refuses an access of any other shape before git runs, and never repeats its value', async () => {
    const s = setup()
    const v = 'neutral-value-5'
    const bad = [
      null, 'machine', 7, [], { mode: 'none' }, { mode: 'machine', extra: 1 }, { mode: 'token' }, { mode: 'token', value: 7 },
      { mode: 'token', value: v, extra: 1 }, { value: v }, { mode: 'machine', value: v }
    ]
    for (const access of bad) {
      const res = await s.invoke('world:clone', { url: 'https://example.com/r', access })
      expect(res).toEqual({ success: false, error: BAD_ACCESS })
      expect(JSON.stringify(res)).not.toContain(v)
    }
    expect(s.deps.clone).not.toHaveBeenCalled()
    // a known access is passed on exactly, with nothing else on it
    await s.invoke('world:clone', { url: 'https://example.com/r', access: { mode: 'machine' } })
    expect(s.deps.clone).toHaveBeenLastCalledWith('https://example.com/r', undefined, { mode: 'machine' })
    await s.invoke('world:clone', { url: 'https://example.com/r', ref: 'dev', access: { mode: 'token', value: v } })
    expect(s.deps.clone).toHaveBeenLastCalledWith('https://example.com/r', 'dev', { mode: 'token', value: v })
  })

  it('a needsLogin clone answers ok with the actions data and saves nothing', async () => {
    const s = setup()
    const needs = { ok: false as const, error: 'raw', needsLogin: { host: 'github.com', helper: true } }
    ;(s.deps.clone as ReturnType<typeof vi.fn>).mockResolvedValueOnce(needs)
    expect(await s.invoke('world:clone', { url: 'https://github.com/a/b.git' }))
      .toEqual({ success: true, data: { needsLogin: { host: 'github.com', helper: true, message: AUTH_MESSAGE } } })
    ;(s.deps.clone as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...needs, needsLogin: { host: 'github.com', helper: false } })
    expect(await s.invoke('world:clone', { url: 'https://github.com/a/b.git', access: { mode: 'machine' } }))
      .toEqual({ success: true, data: { needsLogin: { host: 'github.com', helper: false, message: AUTH_MESSAGE } } })
    ;(s.deps.clone as ReturnType<typeof vi.fn>).mockResolvedValueOnce(needs)
    expect(await s.invoke('world:clone', { url: 'https://github.com/a/b.git', access: { mode: 'token', value: 'neutral-value-6' } }))
      .toEqual({ success: true, data: { needsLogin: { host: 'github.com', helper: true, message: TOKEN_REJECTED_MESSAGE } } })
    expect(s.registry.upsert).not.toHaveBeenCalled()
  })

  it('F-R8: a not-found a git server sent to a clone with no login keeps its own words and the notFound mark', async () => {
    const s = setup()
    const notFound = { ok: false as const, error: NOT_FOUND_MESSAGE, detail: 'remote: Repository not found.', needsLogin: { host: 'gitlab.com', helper: false, notFound: true as const } }
    ;(s.deps.clone as ReturnType<typeof vi.fn>).mockResolvedValueOnce(notFound)
    expect(await s.invoke('world:clone', { url: 'https://gitlab.com/a/b.git' }))
      .toEqual({ success: true, data: { needsLogin: { host: 'gitlab.com', helper: false, notFound: true, message: NOT_FOUND_MESSAGE } } })
    expect(s.registry.upsert).not.toHaveBeenCalled()
  })

  it('M2: still not found after a sign-in or a token says to check the address, with the sign-in choices as the second choice', async () => {
    const s = setup()
    const still = { ok: false as const, error: STILL_NOT_FOUND_MESSAGE, needsLogin: { host: 'github.com', helper: true, stillNotFound: true as const } }
    const want = { success: true, data: { needsLogin: { host: 'github.com', helper: true, notFound: true, message: STILL_NOT_FOUND_MESSAGE } } }
    ;(s.deps.clone as ReturnType<typeof vi.fn>).mockResolvedValueOnce(still)
    expect(await s.invoke('world:clone', { url: 'https://github.com/a/b.git', access: { mode: 'machine' } })).toEqual(want)
    ;(s.deps.clone as ReturnType<typeof vi.fn>).mockResolvedValueOnce(still)
    expect(await s.invoke('world:clone', { url: 'https://github.com/a/b.git', access: { mode: 'token', value: 'neutral-value-10' } })).toEqual(want)
    expect(s.registry.upsert).not.toHaveBeenCalled()
  })

  it('a machine clone is remembered as machine, a token clone as token, and the token is never in the saved entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'world-ipc-login-'))
    try {
      const registry = createSourceRegistry(dir, { exists: async () => true, now: () => 1 })
      const v = 'neutral-value-7'
      const s = setup({ registry, clone: vi.fn(async (url: string) => ({ ok: true as const, root: url.includes('m.git') ? 'C:/ud/world/repos/m' : 'C:/ud/world/repos/t' })) })
      const none = await s.invoke('world:clone', { url: 'https://example.com/n.git' }) as { data: WorldEntry }
      expect(none.data.source).not.toHaveProperty('login')
      const m = await s.invoke('world:clone', { url: 'https://example.com/m.git', access: { mode: 'machine' } }) as { data: WorldEntry }
      expect(m.data.source).toEqual({ kind: 'git', url: 'https://example.com/m.git', root: 'C:/ud/world/repos/m', login: 'machine' })
      const t = await s.invoke('world:clone', { url: 'https://example.com/t.git', ref: 'dev', access: { mode: 'token', value: v } }) as { data: WorldEntry }
      expect(t.data.source).toEqual({ kind: 'git', url: 'https://example.com/t.git', ref: 'dev', root: 'C:/ud/world/repos/t', login: 'token' })
      const file = await readFile(join(dir, 'world', 'sources.json'), 'utf8')
      expect(JSON.stringify(file)).not.toContain(v)
      expect(file).not.toContain(v)
      expect(JSON.stringify(t)).not.toContain(v)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an update of a repository opened from a URL with a user reaches the folder it was cloned into', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'world-ipc-user-'))
    try {
      const registry = createSourceRegistry(dir, { exists: async () => true, now: () => 1 })
      const folderOf = (url: string, ref?: string): string => `C:/ud/world/repos/${cloneKey(url, ref)}`
      const updated: string[] = []
      const s = setup({
        registry,
        clone: vi.fn(async (url: string, ref?: string) => ({ ok: true as const, root: folderOf(url, ref) })),
        updateSource: vi.fn(async (url: string, ref?: string) => {
          updated.push(folderOf(url, ref))
          return { ok: true as const, changed: true }
        })
      })
      for (const ref of [undefined, 'main']) {
        const opened = (await s.invoke('world:clone', { url: 'https://me@github.com/a/b.git', ...(ref ? { ref } : {}), access: { mode: 'machine' } })) as { data: WorldEntry }
        const source = opened.data.source as Extract<WorldSource, { kind: 'git' }>
        // the saved URL has no user in it, and still names the folder the clone went to
        expect(source.url).toBe('https://github.com/a/b.git')
        expect(await s.invoke('world:update-source', { key: opened.data.key })).toEqual({ success: true, data: { changed: true } })
        expect(updated[updated.length - 1]).toBe(source.root)
      }
      expect(updated).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  const gitEntry = (login?: 'machine' | 'token'): WorldEntry => ({
    key: 'kg', title: 'r', lastOpened: 1,
    source: { kind: 'git', url: 'https://github.com/a/b.git', ref: 'main', root: 'C:/ud/world/repos/g', ...(login ? { login } : {}) }
  })
  const withEntry = (entry: WorldEntry | null) => {
    const s = setup()
    s.registry.get.mockImplementation(async (key: string) => (key === 'kg' ? entry : null))
    return s
  }

  it('update-source never runs git for a token entry without a token', async () => {
    const s = withEntry(gitEntry('token'))
    expect(await s.invoke('world:update-source', { key: 'kg' })).toEqual({ success: true, data: { skipped: true } })
    expect(s.deps.updateSource).not.toHaveBeenCalled()
    // with the token it runs, and the token travels only as the call argument
    expect(await s.invoke('world:update-source', { key: 'kg', access: { mode: 'token', value: 'neutral-value-8' } }))
      .toEqual({ success: true, data: { changed: true } })
    expect(s.deps.updateSource).toHaveBeenCalledWith('https://github.com/a/b.git', 'main', 'token', { mode: 'token', value: 'neutral-value-8' })
    expect(s.registry.setLogin).toHaveBeenLastCalledWith('kg', 'token')
    expect(s.registry.upsert).not.toHaveBeenCalled()
    expect(JSON.stringify(s.registry.setLogin.mock.calls)).not.toContain('neutral-value-8')
  })

  it('update-source runs a remembered machine entry in background mode', async () => {
    const s = withEntry(gitEntry('machine'))
    ;(s.deps.updateSource as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, changed: false })
    expect(await s.invoke('world:update-source', { key: 'kg' })).toEqual({ success: true, data: { changed: false } })
    expect(s.deps.updateSource).toHaveBeenCalledWith('https://github.com/a/b.git', 'main', 'machine')
    expect((s.deps.updateSource as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(3)
    // nothing new to remember without an access
    expect(s.registry.upsert).not.toHaveBeenCalled()
    expect(s.registry.setLogin).not.toHaveBeenCalled()
  })

  it('update-source: an entry opened with no sign-in runs plain; asking with machine remembers machine', async () => {
    const s = withEntry(gitEntry())
    expect(await s.invoke('world:update-source', { key: 'kg' })).toEqual({ success: true, data: { changed: true } })
    expect(s.deps.updateSource).toHaveBeenLastCalledWith('https://github.com/a/b.git', 'main', undefined)
    expect(await s.invoke('world:update-source', { key: 'kg', access: { mode: 'machine' } })).toEqual({ success: true, data: { changed: true } })
    expect(s.deps.updateSource).toHaveBeenLastCalledWith('https://github.com/a/b.git', 'main', undefined, { mode: 'machine' })
    expect(s.registry.setLogin).toHaveBeenLastCalledWith('kg', 'machine')
    // a failed save of how it was opened does not fail the update that worked
    s.registry.setLogin.mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:update-source', { key: 'kg', access: { mode: 'machine' } })).toEqual({ success: true, data: { changed: true } })
  })

  it('update-source skips what is not a git world and refuses a bad key or access', async () => {
    const s = withEntry(gitEntry())
    expect(await s.invoke('world:update-source', { key: 'design:d1' })).toEqual({ success: true, data: { skipped: true } })
    expect(await s.invoke('world:update-source', { key: 'gone' })).toEqual({ success: true, data: { skipped: true } })
    for (const bad of [undefined, {}, { key: '' }, { key: 7 }, { key: 'x'.repeat(201) }]) {
      expect(await s.invoke('world:update-source', bad)).toEqual({ success: false, error: 'key required' })
    }
    for (const access of [{ mode: 'none' }, { mode: 'token', value: 'neutral-value-9', more: 1 }, 'machine']) {
      const res = await s.invoke('world:update-source', { key: 'kg', access })
      expect(res).toEqual({ success: false, error: BAD_ACCESS })
      expect(JSON.stringify(res)).not.toContain('neutral-value-9')
    }
    expect(s.deps.updateSource).not.toHaveBeenCalled()
    s.registry.get.mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:update-source', { key: 'kg' })).toEqual({ success: false, error: SOURCES_FAILED })
  })

  it('a background failure that needs a sign-in answers needsLogin', async () => {
    const s = withEntry(gitEntry('machine'))
    const needs = { ok: false as const, error: 'raw', needsLogin: { host: 'github.com', helper: true } }
    ;(s.deps.updateSource as ReturnType<typeof vi.fn>).mockResolvedValueOnce(needs)
    expect(await s.invoke('world:update-source', { key: 'kg' }))
      .toEqual({ success: true, data: { needsLogin: { host: 'github.com', helper: true, message: AUTH_MESSAGE } } })
    ;(s.deps.updateSource as ReturnType<typeof vi.fn>).mockResolvedValueOnce(needs)
    expect(await s.invoke('world:update-source', { key: 'kg', access: { mode: 'token', value: 'neutral-value-10' } }))
      .toEqual({ success: true, data: { needsLogin: { host: 'github.com', helper: true, message: TOKEN_REJECTED_MESSAGE } } })
    // F-R8: a background update a git server answered "not found" never asks for a sign-in: the address may be gone.
    ;(s.deps.updateSource as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: NOT_FOUND_MESSAGE, needsLogin: { host: 'github.com', helper: true, notFound: true } })
    expect(await s.invoke('world:update-source', { key: 'kg' })).toEqual({ success: false, error: NOT_FOUND_MESSAGE })
    // M2: an update still not found with the login it was given says to check the address, and may be signed in again.
    ;(s.deps.updateSource as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: STILL_NOT_FOUND_MESSAGE, needsLogin: { host: 'github.com', helper: true, stillNotFound: true } })
    expect(await s.invoke('world:update-source', { key: 'kg' }))
      .toEqual({ success: true, data: { needsLogin: { host: 'github.com', helper: true, notFound: true, message: STILL_NOT_FOUND_MESSAGE } } })
    // any other failure keeps its own message, and a host that throws is a fixed one
    ;(s.deps.updateSource as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'Lumopolis could not reach it.' })
    expect(await s.invoke('world:update-source', { key: 'kg' })).toEqual({ success: false, error: 'Lumopolis could not reach it.' })
    ;(s.deps.updateSource as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('token update needs a token'))
    expect(await s.invoke('world:update-source', { key: 'kg' })).toEqual({ success: false, error: UPDATE_FAILED })
    expect(s.registry.upsert).not.toHaveBeenCalled()
    expect(s.registry.setLogin).not.toHaveBeenCalled()
  })

  it('an update that came with a sign-in keeps the recent order (a real registry)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'world-ipc-order-'))
    try {
      let clock = 100
      const registry = createSourceRegistry(dir, { exists: async () => true, now: () => ++clock })
      const s = setup({ registry })
      const g = await registry.upsert({ kind: 'git', url: 'https://example.com/g.git', root: 'C:/ud/world/repos/g' })
      const f = await registry.upsert({ kind: 'folder', root: 'C:/f' })
      expect(await s.invoke('world:update-source', { key: g.key, access: { mode: 'token', value: 'neutral-value-11' } }))
        .toEqual({ success: true, data: { changed: true } })
      const list = await registry.list()
      expect(list.map((e) => e.key)).toEqual([f.key, g.key])
      expect(list[1]).toEqual({ ...g, source: { ...g.source, login: 'token' } })
      const saved = await readFile(join(dir, 'world', 'sources.json'), 'utf8')
      expect(saved).not.toContain('neutral-value-11')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
  /** A setup where the user already chose GOOD.root in the folder dialog. */
  async function picked(over: Partial<WorldSourcesDeps> = {}) {
    const s = setup({ pickFolder: vi.fn(async () => GOOD.root), ...over })
    await s.invoke('world:pick-folder')
    return s
  }

  it('links the design to the folder and answers the folder, the title and the first prompt', async () => {
    const s = await picked()
    const prompt = 'Read the Lumopolis design first: call gateway_call with tool lumopolis/world_read and arguments {designKey: design:d1}. Then build the app it describes in this folder. Design title: Shop.'
    expect(BUILD_PROMPT('Shop', 'design:d1')).toBe(prompt)
    expect(await s.invoke('world:build-it', GOOD)).toEqual({ success: true, data: { root: 'C:/build/shop', key: 'design:d1', title: 'Shop', prompt } })
    expect(s.registry.upsert).toHaveBeenCalledWith({ kind: 'folder', root: 'C:/build/shop', linkedDesign: 'design:d1' })
  })

  it('the first prompt passes the launcher unchanged, whatever the title holds', () => {
    for (const title of ['Shop', 'Pet "shop" (beta) $HOME %PATH% `x` \\ !', 'a\u0000b\nc\u2028d\u201cq\u201d', '   ', 'x'.repeat(400)]) {
      const prompt = BUILD_PROMPT(title, 'design:d1')
      expect(taskPromptArg(prompt)).toBe(` "${prompt}"`)
      expect(prompt.length).toBeLessThan(500)
    }
    expect(BUILD_PROMPT('   ', 'design:d1')).toMatch(/Design title: untitled\.$/)
    expect(BUILD_PROMPT('Pet "shop" (beta)', 'design:d1')).toMatch(/Design title: Pet shop beta\.$/)
    expect(BUILD_PROMPT('x'.repeat(400), 'design:d1')).toMatch(/Design title: x{80}\.$/)
  })

  it('starts watching the folder, so the world follows the build; a watch failure does not fail Build it', async () => {
    const watch = vi.fn(() => true)
    const s = await picked({ watch })
    await s.invoke('world:build-it', GOOD)
    expect(watch).toHaveBeenCalledWith('C:/build/shop')
    watch.mockImplementationOnce(() => { throw new Error('EMFILE') })
    expect((await s.invoke('world:build-it', GOOD) as { success: boolean }).success).toBe(true)
  })

  it('removing the folder world stops the watch Build it started, and only that one', async () => {
    const unwatch = vi.fn()
    const s = await picked({ watch: vi.fn(() => true), unwatch })
    await s.invoke('world:build-it', GOOD)
    await s.invoke('world:remove-source', { key: 'k-C:/a' })
    expect(unwatch).not.toHaveBeenCalled()
    await s.invoke('world:remove-source', { key: 'k-C:/build/shop' })
    expect(unwatch).toHaveBeenCalledWith('C:/build/shop')
    await s.invoke('world:remove-source', { key: 'k-C:/build/shop' })
    expect(unwatch).toHaveBeenCalledTimes(1)
  })

  it('a folder that was already watched keeps its watch on remove; a failing unwatch still removes', async () => {
    const unwatch = vi.fn(() => { throw new Error('gone') })
    const s = await picked({ watch: vi.fn(() => false), unwatch })
    await s.invoke('world:build-it', GOOD)
    expect(await s.invoke('world:remove-source', { key: 'k-C:/build/shop' })).toEqual({ success: true, data: true })
    expect(unwatch).not.toHaveBeenCalled()
    const t = await picked({ watch: vi.fn(() => true), unwatch })
    await t.invoke('world:build-it', GOOD)
    expect(await t.invoke('world:remove-source', { key: 'k-C:/build/shop' })).toEqual({ success: true, data: true })
    expect(unwatch).toHaveBeenCalledWith('C:/build/shop')
  })

  it('refuses a folder that is not empty unless the user confirmed it', async () => {
    const s = await picked({ isEmpty: vi.fn(async () => false) })
    expect(await s.invoke('world:build-it', GOOD)).toEqual({ success: false, error: NOT_EMPTY })
    expect(s.registry.upsert).not.toHaveBeenCalled()
    expect((await s.invoke('world:build-it', { ...GOOD, confirmNonEmpty: true }) as { success: boolean }).success).toBe(true)
  })

  it('refuses a folder the dialog did not return, unless it is already a world in the home', async () => {
    const s = setup()
    expect(await s.invoke('world:build-it', GOOD)).toEqual({ success: false, error: NOT_PICKED })
    expect(s.registry.upsert).not.toHaveBeenCalled()
    // The registry holds C:/a: a world already in the home may be built in.
    expect((await s.invoke('world:build-it', { ...GOOD, root: 'C:/a' }) as { success: boolean }).success).toBe(true)
    s.registry.list.mockResolvedValueOnce([entryOf({ kind: 'design', id: 'd1', title: 'Shop' })])
    expect(await s.invoke('world:build-it', GOOD)).toEqual({ success: false, error: NOT_PICKED })
    s.registry.list.mockRejectedValueOnce(new Error('disk'))
    expect(await s.invoke('world:build-it', GOOD)).toEqual({ success: false, error: SOURCES_FAILED })
  })

  it('refuses a drive root, the home folder or above it, and Termpolis data, in Build it, pick-folder and open-folder', async () => {
    const drive = parse(process.cwd()).root
    for (const root of [drive, 'C:/Users/me', 'C:/Users', 'C:/ud', 'C:/ud/world/repos/abc']) {
      const s = setup({ pickFolder: vi.fn(async () => root) })
      expect(await s.invoke('world:pick-folder')).toEqual({ success: false, error: FORBIDDEN_FOLDER })
      expect(await s.invoke('world:open-folder')).toEqual({ success: false, error: FORBIDDEN_FOLDER })
      expect(await s.invoke('world:build-it', { ...GOOD, root })).toEqual({ success: false, error: FORBIDDEN_FOLDER })
      expect(s.registry.upsert).not.toHaveBeenCalled()
      expect(s.deps.isEmpty).not.toHaveBeenCalled()
    }
    const real = setup({ homeDir: homedir(), pickFolder: vi.fn(async () => homedir()) })
    expect(await real.invoke('world:pick-folder')).toEqual({ success: false, error: FORBIDDEN_FOLDER })
    const inHome = setup({ pickFolder: vi.fn(async () => 'C:/Users/me/code/shop') })
    expect(await inHome.invoke('world:pick-folder')).toEqual({ success: true, data: { root: 'C:/Users/me/code/shop', empty: true } })
  })

  it.each([
    [undefined, DESIGN_NOT_FOUND],
    [{ ...GOOD, key: 'C:/x' }, DESIGN_NOT_FOUND],
    [{ ...GOOD, key: `design:${'x'.repeat(200)}` }, DESIGN_NOT_FOUND],
    [{ ...GOOD, root: 'rel' }, 'root required'],
    [{ ...GOOD, root: 7 }, 'root required'],
    [{ ...GOOD, agent: '' }, 'agent required'],
    [{ ...GOOD, agent: 'rm -rf' }, 'agent required'],
    [{ ...GOOD, confirmNonEmpty: 'yes' }, 'confirmNonEmpty must be a boolean']
  ])('refuses %j', async (args, error) => {
    const s = await picked()
    expect(await s.invoke('world:build-it', args)).toEqual({ success: false, error })
    expect(s.registry.upsert).not.toHaveBeenCalled()
  })

  it('a design that is not registered is not found; an unreadable folder or a failed save are fixed messages', async () => {
    const s = await picked()
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
    expect(d.draft).toHaveBeenCalledWith('A shop', 'draft:t1', undefined)
    expect(await s.invoke('world:design-draft', { description: 'A shop', cancelKey: 'design:x' })).toEqual({ success: false, error: 'cancelKey must be draft:<id>' })
    expect(d.draft).toHaveBeenCalledTimes(1)
  })
})
