import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { graphKeyForRoot } from '../../src/main/codeGraph'
import { createSourceRegistry, keyForSource, type WorldSource } from '../../src/main/world/sources'
import { SOURCES_READ_FAILED_MESSAGE, WorldReadError, worldFileName } from '../../src/main/world/worldStore'
import { windowMessage } from '../../src/main/world/windowError'
import * as fsp from 'node:fs/promises'

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), readFile: vi.fn(actual.readFile) }
})

let dir: string
let clock: number
let present: Set<string>
const deps = () => ({ exists: async (p: string) => present.has(p), now: () => ++clock })
const reg = () => createSourceRegistry(dir, deps())
const sourcesFile = () => join(dir, 'world', 'sources.json')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'world-sources-'))
  clock = 100
  present = new Set(['/a', '/b', '/c', '/g'])
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('source registry', () => {
  it('upsert then list newest first', async () => {
    const r = reg()
    await r.upsert({ kind: 'project', root: '/a' })
    await r.upsert({ kind: 'folder', root: '/b' }, 'Bee')
    const list = await r.list()
    expect(list.map((e) => e.title)).toEqual(['Bee', 'a'])
    expect(list[0].key).toBe(graphKeyForRoot('/b'))
    expect(list[0].missing).toBeUndefined()
  })

  // F-R2 (WP5, fix I1/I3): on Linux the key keeps the folder's case, so `~/app` and `~/App` are two worlds and an upsert of
  // one never replaces the other; Windows and macOS fold case, so there the two spellings are one folder and one entry.
  it('F-R2: two sibling folders that differ only in case are two entries on Linux, one where case folds', async () => {
    const real = process.platform
    try {
      for (const [platform, want] of [['linux', 2], ['darwin', 1], ['win32', 1]] as const) {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true })
        await rm(join(dir, 'world'), { recursive: true, force: true })
        present = new Set(['/home/me/app', '/home/me/App'])
        const r = reg()
        await r.upsert({ kind: 'folder', root: '/home/me/app' }, 'lower')
        await r.upsert({ kind: 'folder', root: '/home/me/App' }, 'upper')
        const list = await r.list()
        expect(list, platform).toHaveLength(want)
        if (want === 2) {
          expect(list.map((e) => [e.title, e.source.kind === 'design' ? '' : e.source.root])).toEqual([['upper', '/home/me/App'], ['lower', '/home/me/app']])
          expect(new Set(list.map((e) => e.key)).size).toBe(2)
        }
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  it('same root twice → one entry, lastOpened updated', async () => {
    const r = reg()
    const first = await r.upsert({ kind: 'project', root: '/a' }, 'Alpha')
    const second = await r.upsert({ kind: 'project', root: '/a' })
    expect(await r.list()).toHaveLength(1)
    expect(second.lastOpened).toBeGreaterThan(first.lastOpened)
    expect(second.title).toBe('Alpha')
    expect((await r.get(first.key))?.lastOpened).toBe(second.lastOpened)
  })

  it('missing root flagged missing: true', async () => {
    const r = reg()
    const e = await r.upsert({ kind: 'folder', root: '/gone' })
    expect(e.missing).toBe(true)
    expect((await r.get(e.key))?.missing).toBe(true)
    expect((await r.list())[0].missing).toBe(true)
    expect(await readFile(sourcesFile(), 'utf8')).not.toContain('missing')
    present.add('/gone')
    expect((await r.get(e.key))?.missing).toBeUndefined()
  })

  it('design entries are missing when their world file is absent', async () => {
    const r = reg()
    const e = await r.upsert({ kind: 'design', id: 'x1', title: 'Shop' })
    expect(e.key).toBe('design:x1')
    expect(e.title).toBe('Shop')
    expect(e.missing).toBe(true)
    present.add(join(dir, 'world', worldFileName('design:x1')))
    expect((await r.get('design:x1'))?.missing).toBeUndefined()
  })

  it('remove deletes the entry only (never files)', async () => {
    const r = reg()
    const e = await r.upsert({ kind: 'project', root: '/a' })
    await r.upsert({ kind: 'project', root: '/b' })
    const marker = join(dir, 'world', 'keep.json')
    await writeFile(marker, '{}')
    await r.remove(e.key)
    await r.remove('nope')
    expect((await r.list()).map((x) => x.title)).toEqual(['b'])
    expect(await r.get(e.key)).toBeNull()
    expect(await readFile(marker, 'utf8')).toBe('{}')
  })

  it('touch bumps lastOpened and moves the world to the front; an unknown key is null', async () => {
    const r = reg()
    const a = await r.upsert({ kind: 'project', root: '/a' }, 'Alpha')
    await r.upsert({ kind: 'folder', root: '/b' })
    expect((await r.list()).map((e) => e.title)).toEqual(['b', 'Alpha'])
    const touched = await r.touch(a.key)
    expect(touched?.lastOpened).toBeGreaterThan(a.lastOpened)
    expect(touched?.title).toBe('Alpha')
    expect(touched?.source).toEqual(a.source)
    expect((await r.list()).map((e) => e.title)).toEqual(['Alpha', 'b'])
    expect((await r.get(a.key))?.lastOpened).toBe(touched?.lastOpened)
    expect(await r.touch('nope')).toBeNull()
  })

  const backups = async (): Promise<string[]> => (await readdir(join(dir, 'world'))).filter((n) => n.endsWith('.bad')).sort()

  it('a sources.json that is not a JSON list → empty list + a timestamped .bad backup that never overwrites an earlier one (F21)', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(sourcesFile(), '{not json')
    const r = createSourceRegistry(dir, { ...deps(), now: () => Date.UTC(2026, 10, 23, 9, 30, 0, 5) })
    expect(await r.list()).toEqual([])
    expect(await backups()).toEqual(['sources.json.2026-11-23T09-30-00-005Z-1.bad'])
    await writeFile(sourcesFile(), '"str"')
    expect(await r.list()).toEqual([])
    // the same millisecond still gets its own name
    expect(await backups()).toEqual(['sources.json.2026-11-23T09-30-00-005Z-1.bad', 'sources.json.2026-11-23T09-30-00-005Z-2.bad'])
    expect(await readFile(join(dir, 'world', 'sources.json.2026-11-23T09-30-00-005Z-1.bad'), 'utf8')).toBe('{not json')
    // a list whose entries are all unreadable is a list: nothing is moved aside
    await writeFile(sourcesFile(), JSON.stringify([{ key: 1 }]))
    expect(await r.list()).toEqual([])
    expect(await backups()).toHaveLength(2)
    expect(JSON.parse(await readFile(sourcesFile(), 'utf8'))).toEqual([{ key: 1 }])
  })

  it('one malformed entry is left out of the list, the rest kept (M06)', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    const base = { key: 'k', title: 't', lastOpened: 1 }
    const good = { key: 'g', title: 'Good', lastOpened: 5, source: { kind: 'folder', root: '/a' } }
    const bad = [null, 'x', { kind: 'nope' }, { kind: 'project', root: 1 }, { kind: 'git', url: 'u', root: 'r', ref: 3 }, { kind: 'design', id: 'i', title: 1 }]
    for (const source of bad) {
      await writeFile(sourcesFile(), JSON.stringify([{ ...base, source }, good]))
      expect((await reg().list()).map((e) => e.key)).toEqual(['g'])
      expect(await reg().get('g')).toMatchObject({ title: 'Good' })
      expect(await reg().get('k')).toBeNull()
    }
    for (const entry of [null, 7, 'x', [], { ...good, key: 3 }, { ...good, title: null }, { ...good, lastOpened: '1' }]) {
      await writeFile(sourcesFile(), JSON.stringify([good, entry]))
      expect((await reg().list()).map((e) => e.key)).toEqual(['g'])
    }
    expect(await backups()).toEqual([])
  })

  it('logs the places of the entries it leaves out, never what they say, once per change', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const good = { key: 'g', title: 'Good', lastOpened: 5, source: { kind: 'folder', root: '/a' } }
      const hidden = { key: 'private-key-name', title: 'Private title', lastOpened: 1, source: { kind: 'cloud', where: '/home/someone' } }
      await writeFile(sourcesFile(), JSON.stringify([good, hidden, null]))
      const r = reg()
      await r.list()
      await r.list()
      await r.get('g')
      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0][0])
      expect(line).toBe('[world sources] entries this version cannot read were left out of the list: #1, #2')
      for (const word of ['private', 'Private', 'cloud', 'someone', 'Good']) expect(line).not.toContain(word)
      await writeFile(sourcesFile(), JSON.stringify([null, good]))
      await r.list()
      expect(warn).toHaveBeenLastCalledWith('[world sources] entries this version cannot read were left out of the list: #0')
      await writeFile(sourcesFile(), JSON.stringify([good]))
      await r.list()
      await writeFile(sourcesFile(), JSON.stringify([null, good]))
      await r.list()
      // a clean read in between resets it, so the same skip is logged again
      expect(warn).toHaveBeenCalledTimes(3)
    } finally {
      warn.mockRestore()
    }
  })

  it('an entry this version cannot read stays in the file through every save, until its key is written or removed', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    const newer = { key: graphKeyForRoot('/b'), title: 'From a newer build', lastOpened: 9, source: { kind: 'cloud', id: 'c1' } }
    const junk = { nokey: true }
    await writeFile(sourcesFile(), JSON.stringify([newer, junk, 'loose']))
    const r = reg()
    const a = await r.upsert({ kind: 'project', root: '/a' })
    const onDisk = async (): Promise<unknown[]> => JSON.parse(await readFile(sourcesFile(), 'utf8')) as unknown[]
    expect(await onDisk()).toEqual([newer, junk, 'loose', { key: a.key, title: 'a', lastOpened: a.lastOpened, source: { kind: 'project', root: '/a' } }])
    await r.touch(a.key)
    await r.setLogin(a.key, 'machine')
    expect((await onDisk()).slice(0, 3)).toEqual([newer, junk, 'loose'])
    expect((await r.list()).map((e) => e.key)).toEqual([a.key])
    // removing a key nobody has changes nothing
    await r.remove('nope')
    expect(await onDisk()).toHaveLength(4)
    // writing the same key replaces the unreadable entry
    const b = await r.upsert({ kind: 'folder', root: '/b' })
    expect((await onDisk()).map((e) => (typeof e === 'object' && e !== null ? (e as { key?: unknown }).key : e))).toEqual([undefined, 'loose', a.key, b.key])
    // and removing a key drops an unreadable entry that has it too
    const plain = { key: a.key, title: 'a', lastOpened: 1, source: { kind: 'project', root: '/a' } }
    await writeFile(sourcesFile(), JSON.stringify([newer, plain]))
    await r.remove(newer.key)
    expect(await onDisk()).toEqual([plain])
  })

  it('a registry written by this build today still loads unchanged (current-format fixture)', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    const fixture = [
      { key: graphKeyForRoot('/a'), source: { kind: 'project', root: '/a' }, title: 'a', lastOpened: 1 },
      { key: graphKeyForRoot('/b'), source: { kind: 'folder', root: '/b', linkedDesign: 'design:d1' }, title: 'Bee', lastOpened: 2 },
      { key: graphKeyForRoot('/g'), source: { kind: 'git', url: 'https://h/x/y.git', ref: 'main', root: '/g', login: 'machine' }, title: 'y', lastOpened: 3 },
      { key: 'design:d1', source: { kind: 'design', id: 'd1', title: 'Plan', linkedRoot: '/b' }, title: 'Plan', lastOpened: 4 }
    ]
    const text = JSON.stringify(fixture)
    await writeFile(sourcesFile(), text)
    present.add(join(dir, 'world', worldFileName('design:d1')))
    const r = reg()
    expect(await r.list()).toEqual([...fixture].reverse())
    await r.remove('nope')
    expect(await readFile(sourcesFile(), 'utf8')).toBe(text)
    await r.touch('design:d1')
    expect(JSON.parse(await readFile(sourcesFile(), 'utf8'))).toEqual([...fixture.slice(0, 3), { ...fixture[3], lastOpened: 101 }])
    expect(await backups()).toEqual([])
  })

  it('a git entry may remember how it was opened (machine or token); any other login reads as token and hides nothing', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    const base = { key: 'k', title: 't', lastOpened: 1 }
    for (const login of ['machine', 'token'] as const) {
      await writeFile(sourcesFile(), JSON.stringify([{ ...base, source: { kind: 'git', url: 'https://h/r.git', root: '/g', login } }]))
      expect((await reg().list()).map((e) => e.source)).toEqual([{ kind: 'git', url: 'https://h/r.git', root: '/g', login }])
    }
    for (const login of ['other', 1, null]) {
      const other = { key: 'k2', title: 'f', lastOpened: 2, source: { kind: 'folder', root: '/a' } }
      await writeFile(sourcesFile(), JSON.stringify([{ ...base, source: { kind: 'git', url: 'https://h/r.git', root: '/g', login } }, other]))
      const list = await reg().list()
      // the whole list still shows; the unknown value is read conservatively, so it never updates unasked
      expect(list.map((e) => e.key)).toEqual(['k2', 'k'])
      expect(list[1].source).toEqual({ kind: 'git', url: 'https://h/r.git', root: '/g', login: 'token' })
      expect(await reg().get('k')).toMatchObject({ source: { login: 'token' } })
      await expect(readdir(join(dir, 'world'))).resolves.not.toContain('sources.json.bad')
    }
    const r = reg()
    const e = await r.upsert({ kind: 'git', url: 'https://h/r.git', root: '/g', login: 'machine' })
    expect(e.source).toEqual({ kind: 'git', url: 'https://h/r.git', root: '/g', login: 'machine' })
    expect((await r.list())[0].source).toEqual({ kind: 'git', url: 'https://h/r.git', root: '/g', login: 'machine' })
  })

  it("an unknown login survives a save of another entry unchanged on disk, yet reads as 'token'", async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    const stored = { key: 'k', title: 't', lastOpened: 1, source: { kind: 'git', url: 'https://h/r.git', root: '/g', login: 'future-mode' } }
    const other = { key: 'k2', title: 'f', lastOpened: 2, source: { kind: 'folder', root: '/a' } }
    await writeFile(sourcesFile(), JSON.stringify([stored, other]))
    const r = reg()
    expect(await r.touch('k2')).toMatchObject({ key: 'k2', lastOpened: 101 })
    const onDisk = JSON.parse(await readFile(sourcesFile(), 'utf8')) as { key: string }[]
    expect(onDisk.find((e) => e.key === 'k')).toEqual(stored)
    expect((await r.get('k'))?.source).toEqual({ kind: 'git', url: 'https://h/r.git', root: '/g', login: 'token' })
    expect((await r.list()).find((e) => e.key === 'k')?.source).toMatchObject({ login: 'token' })
  })

  it('setLogin changes only how a git world was opened and keeps its place in the recent list', async () => {
    const r = reg()
    const g = await r.upsert({ kind: 'git', url: 'https://h/r.git', ref: 'main', root: '/g' }, 'Repo')
    const a = await r.upsert({ kind: 'folder', root: '/a' })
    const out = await r.setLogin(g.key, 'token')
    expect(out).toEqual({ ...g, source: { ...g.source, login: 'token' } })
    const list = await r.list()
    expect(list.map((e) => e.key)).toEqual([a.key, g.key])
    expect(list[1]).toEqual({ key: g.key, title: 'Repo', lastOpened: g.lastOpened, source: { kind: 'git', url: 'https://h/r.git', ref: 'main', root: '/g', login: 'token' } })
    expect(list[0]).toEqual(a)
    // not a git world, or not registered: nothing changes
    expect(await r.setLogin(a.key, 'machine')).toBeNull()
    expect(await r.setLogin('nope', 'machine')).toBeNull()
    expect(await r.list()).toEqual(list)
  })

  it('a broken list that cannot be moved aside is refused, not read as empty, so no save writes over it; other read errors throw path-free (M9)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await mkdir(join(dir, 'world'), { recursive: true })
      await writeFile(sourcesFile(), 'x')
      vi.mocked(fsp.rename).mockRejectedValueOnce(new Error('refused'))
      const r = reg()
      const unparsed = await r.list().catch((e: unknown) => e)
      expect(unparsed).toMatchObject({ name: 'WorldReadError', code: 'SOURCES_READ_FAILED', message: SOURCES_READ_FAILED_MESSAGE })
      // M-new-1: the fixed words reach the window as they are, never as WORLD_CALL_FAILED.
      expect(windowMessage(unparsed)).toBe(SOURCES_READ_FAILED_MESSAGE)
      // M5: the list of worlds has its own words, never those for a world's saved map.
      expect(SOURCES_READ_FAILED_MESSAGE).toBe("Lumopolis couldn't read your recent worlds. Try again in a moment.")
      expect(warn).toHaveBeenCalledWith('[world sources] the list of worlds does not parse and could not be moved aside')
      expect(await readFile(sourcesFile(), 'utf8')).toBe('x')
      expect(await backups()).toEqual([])
      // the next look moves it aside and the list starts empty
      expect(await r.list()).toEqual([])
      expect(await backups()).toHaveLength(1)
      await rm(sourcesFile(), { force: true })
      await mkdir(sourcesFile())
      const err = await reg().list().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(WorldReadError)
      expect(err).toMatchObject({ code: 'SOURCES_READ_FAILED', message: SOURCES_READ_FAILED_MESSAGE })
      expect(windowMessage(err)).toBe(SOURCES_READ_FAILED_MESSAGE)
      expect(JSON.stringify(err) + String((err as Error).message)).not.toContain(dir)
      expect(warn.mock.calls[1][0]).toMatch(/^\[world sources\] the list of worlds could not be read: Error: EISDIR/)
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps linkedDesign when upserted without one, replaces it when given one', async () => {
    const r = reg()
    await r.upsert({ kind: 'folder', root: '/a', linkedDesign: 'design:d1' })
    expect((await r.upsert({ kind: 'folder', root: '/a' })).source).toMatchObject({ linkedDesign: 'design:d1' })
    expect((await r.upsert({ kind: 'folder', root: '/a', linkedDesign: 'design:d2' })).source).toMatchObject({ linkedDesign: 'design:d2' })
    expect((await r.upsert({ kind: 'project', root: '/b' })).source).toEqual({ kind: 'project', root: '/b' })
    const donor = { key: graphKeyForRoot('/c'), title: 'c', lastOpened: 1, source: { kind: 'design', id: 'z', title: 'z' } }
    await writeFile(sourcesFile(), JSON.stringify([donor]))
    const git: WorldSource = { kind: 'git', url: 'https://h/x/y.git', root: '/c' }
    expect((await r.upsert(git)).source).toEqual(git)
  })

  it('titles default sensibly', async () => {
    const r = reg()
    expect((await r.upsert({ kind: 'git', url: 'https://h/x/repo.git/', root: '/g' })).title).toBe('repo')
    expect((await r.upsert({ kind: 'project', root: '/' })).title).toBe('/')
    expect((await r.upsert({ kind: 'git', url: '/', root: '/g2' })).title).toBe('/')
  })

  it('serialises concurrent upserts and survives a failed write', async () => {
    const r = reg()
    await Promise.all([r.upsert({ kind: 'project', root: '/a' }), r.upsert({ kind: 'project', root: '/b' }), r.upsert({ kind: 'project', root: '/c' })])
    expect(await r.list()).toHaveLength(3)
    vi.mocked(fsp.rename).mockRejectedValueOnce(new Error('disk full'))
    await expect(r.upsert({ kind: 'project', root: '/a' })).rejects.toThrow('disk full')
    expect((await readdir(join(dir, 'world'))).filter((n) => n.endsWith('.tmp'))).toEqual([])
    await expect(r.upsert({ kind: 'project', root: '/a' })).resolves.toBeTruthy()
  })

  // On Windows a rename onto sources.json fails with EPERM while anything reads it (the recent list
  // reloads exactly when a world opens); a refused touch kept a remembered repository from updating.
  const busy = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: busy`), { code })

  it('a touch whose rename is refused for a moment by a reader is tried again and lands', async () => {
    const r = reg()
    const a = await r.upsert({ kind: 'git', url: 'https://h/x/y.git', root: '/g' })
    vi.mocked(fsp.rename).mockRejectedValueOnce(busy('EPERM')).mockRejectedValueOnce(busy('EBUSY'))
    const touched = await r.touch(a.key)
    expect(touched?.lastOpened).toBeGreaterThan(a.lastOpened)
    expect((await r.get(a.key))?.lastOpened).toBe(touched?.lastOpened)
    expect((await readdir(join(dir, 'world'))).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  // On Windows a rename onto a file this registry is still reading fails (EPERM), so a read and a write of the same
  // registry never overlap: a list or get waits for the write before it, and a write for the read before it.
  it('a write never renames onto the file while a list or get of the same registry is reading it', async () => {
    const r = reg()
    const a = await r.upsert({ kind: 'git', url: 'https://h/x/y.git', root: '/g' })
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    for (const read of [() => r.list(), () => r.get(a.key)]) {
      let release!: () => void
      const held = new Promise<void>((res) => { release = res })
      vi.mocked(fsp.readFile).mockImplementationOnce((async (...args: Parameters<typeof actual.readFile>) => {
        await held
        return actual.readFile(...args)
      }) as typeof actual.readFile)
      vi.mocked(fsp.rename).mockClear()
      vi.mocked(fsp.readFile).mockClear()
      const reading = read()
      const touching = r.touch(a.key)
      for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res))
      // the write has not even read the file yet: it waits for the held read, so it cannot rename under it
      expect(fsp.readFile).toHaveBeenCalledTimes(1)
      expect(fsp.rename).not.toHaveBeenCalled()
      release()
      await reading
      expect((await touching)?.key).toBe(a.key)
      expect(fsp.rename).toHaveBeenCalledTimes(1)
    }
    // and a read asked while a write is renaming waits for it, so it sees the new entry
    const touched = r.touch(a.key)
    const seen = await r.get(a.key)
    expect(seen?.lastOpened).toBe((await touched)?.lastOpened)
  })

  it('a read that a locked file refuses (EBUSY, EACCES, EPERM) is tried again and lands (F18)', async () => {
    const waits: number[] = []
    const r = createSourceRegistry(dir, { ...deps(), sleep: async (ms: number) => { waits.push(ms) } })
    const a = await r.upsert({ kind: 'project', root: '/a' })
    vi.mocked(fsp.readFile).mockRejectedValueOnce(busy('EBUSY')).mockRejectedValueOnce(busy('EACCES')).mockRejectedValueOnce(busy('EPERM'))
    expect((await r.list()).map((e) => e.key)).toEqual([a.key])
    expect(waits).toEqual([100, 200, 300])
  })

  it('a read refused on every try throws after about a second, and a missing file is never waited on', async () => {
    const waits: number[] = []
    const r = createSourceRegistry(dir, { ...deps(), sleep: async (ms: number) => { waits.push(ms) } })
    await r.upsert({ kind: 'project', root: '/a' })
    vi.mocked(fsp.readFile).mockRejectedValue(busy('EBUSY'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(r.list()).rejects.toMatchObject({ code: 'SOURCES_READ_FAILED', message: SOURCES_READ_FAILED_MESSAGE })
      expect(warn.mock.calls[0][0]).toMatch(/could not be read: .*EBUSY/)
    } finally {
      warn.mockRestore()
      vi.mocked(fsp.readFile).mockReset()
      vi.mocked(fsp.readFile).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile)
    }
    expect(waits).toEqual([100, 200, 300, 400])
    waits.length = 0
    await rm(sourcesFile())
    expect(await r.list()).toEqual([])
    expect(waits).toEqual([])
  })

  it('a rename refused on every try gives up after the last one and leaves no temp file', async () => {
    const waits: number[] = []
    const r = createSourceRegistry(dir, { ...deps(), sleep: async (ms: number) => { waits.push(ms) } })
    const a = await r.upsert({ kind: 'project', root: '/a' })
    vi.mocked(fsp.rename).mockRejectedValue(busy('EACCES'))
    try {
      await expect(r.touch(a.key)).rejects.toThrow('EACCES')
    } finally {
      vi.mocked(fsp.rename).mockReset()
      vi.mocked(fsp.rename).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename)
    }
    expect(waits).toEqual([100, 200, 300, 400])
    expect((await readdir(join(dir, 'world'))).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect((await r.get(a.key))?.lastOpened).toBe(a.lastOpened)
  })
})

describe('source registry and git user-info', () => {
  // Built from parts so no scanner reads a real sign-in in the test source.
  const userinfo = 'u' + ':' + 'p'
  const signed = `https://${userinfo}@host.example/team/repo.git`

  it('stores and shows an https clone URL without its user-info', async () => {
    const r = reg()
    const e = await r.upsert({ kind: 'git', url: signed, root: '/g' })
    expect(e.source).toEqual({ kind: 'git', url: 'https://host.example/team/repo.git', root: '/g' })
    expect(e.title).toBe('repo')
    expect(await readFile(sourcesFile(), 'utf8')).not.toContain(userinfo)
    expect((await r.list())[0].source).toEqual(e.source)
    // A bare user name (no secret part) is user-info too; ssh and git@ forms keep their user, which is no secret.
    expect((await r.upsert({ kind: 'git', url: 'https://someone@host.example/r', root: '/g' })).source).toMatchObject({ url: 'https://host.example/r' })
    expect((await r.upsert({ kind: 'git', url: 'ssh://git@host.example/r', root: '/g' })).source).toMatchObject({ url: 'ssh://git@host.example/r' })
    expect((await r.upsert({ kind: 'git', url: 'git@host.example:r.git', root: '/g' })).source).toMatchObject({ url: 'git@host.example:r.git' })
  })

  it('an entry stored before the strip is cleaned on every read', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    const legacy = { key: graphKeyForRoot('/g'), title: 'repo', lastOpened: 5, source: { kind: 'git', url: signed, root: '/g' } }
    await writeFile(sourcesFile(), JSON.stringify([legacy]))
    const r = reg()
    expect((await r.list())[0].source).toEqual({ kind: 'git', url: 'https://host.example/team/repo.git', root: '/g' })
    expect((await r.get(legacy.key))?.source).toMatchObject({ url: 'https://host.example/team/repo.git' })
    expect((await r.touch(legacy.key))?.source).toMatchObject({ url: 'https://host.example/team/repo.git' })
  })
})

describe('keyForSource', () => {
  it('table', () => {
    const cases: Array<[WorldSource, string]> = [
      [{ kind: 'project', root: '/a' }, graphKeyForRoot('/a')],
      [{ kind: 'folder', root: '/b' }, graphKeyForRoot('/b')],
      [{ kind: 'git', url: 'https://h/r.git', root: '/c' }, graphKeyForRoot('/c')],
      [{ kind: 'design', id: 'abc', title: 'T' }, 'design:abc']
    ]
    for (const [s, k] of cases) expect(keyForSource(s)).toBe(k)
  })
})
