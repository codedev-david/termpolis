import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorldDoc } from '../../src/shared/world/types'
import { createWorldStore, LABEL_MAX_AGE_MS, pruneLabelCache, worldFileName } from '../../src/main/world/worldStore'
import { STAGE_CACHE_VERSION } from '../../src/main/world/stageCache'

function doc(projectKey = 'demo'): WorldDoc {
  return {
    version: 1,
    projectKey,
    generatedAt: 1,
    sourceRevision: { head: 'abc', dirty: false },
    districts: [{ id: 'd-a', name: 'a', subtitle: '', hue: 0, members: ['b-a'], nameState: 'observed' }],
    buildings: [
      {
        id: 'b-a',
        districtId: 'd-a',
        name: 'a',
        techLabel: 'TS',
        process: '',
        floors: [],
        stack: [],
        how: [],
        why: [],
        status: 'gap',
        members: ['src/a.ts'],
        claims: [],
        nameState: 'observed'
      }
    ],
    edges: [],
    externals: [],
    glossary: {},
    cargo: {},
    processes: {},
    tours: [],
    layout: { seed: 1, positions: { 'd-a': [0, 0, 0], 'b-a': [1, 0, 1] } },
    runtimeNames: {},
    layers: { plan: [] }
  }
}

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'world-store-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('worldStore', () => {
  it('store round-trip', async () => {
    const store = createWorldStore(dir)
    expect(await store.load('demo')).toBeNull()
    await store.save(doc())
    expect(await store.load('demo')).toEqual(doc())
    // Overwrite in place, and no temp files are left behind.
    const next = { ...doc(), generatedAt: 2 }
    await store.save(next)
    expect(await store.load('demo')).toEqual(next)
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
  })

  it('corrupt file → load null + a timestamped .bad backup; earlier backups are kept (F21)', async () => {
    let clock = Date.UTC(2026, 10, 23, 9, 30, 0, 5)
    const store = createWorldStore(dir, { now: () => clock })
    const world = join(dir, 'world')
    await mkdir(world, { recursive: true })
    await writeFile(join(world, 'demo.json'), '{ not json')
    await writeFile(join(world, 'demo.json.bad'), 'older bad copy')
    expect(await store.load('demo')).toBeNull()
    expect((await readdir(world)).sort()).toEqual(['demo.json.2026-11-23T09-30-00-005Z.bad', 'demo.json.bad'])
    expect(await readFile(join(world, 'demo.json.bad'), 'utf8')).toBe('older bad copy')
    expect(await readFile(join(world, 'demo.json.2026-11-23T09-30-00-005Z.bad'), 'utf8')).toBe('{ not json')

    // Valid JSON that fails validateWorld is treated the same way, and a second corruption never overwrites the first.
    await writeFile(join(world, 'demo.json'), JSON.stringify({ ...doc(), layout: 'x' }))
    expect(await store.load('demo')).toBeNull()
    await writeFile(join(world, 'demo.json'), '[]')
    clock += 1000
    expect(await store.load('demo')).toBeNull()
    expect((await readdir(world)).sort()).toEqual([
      'demo.json.2026-11-23T09-30-00-005Z-1.bad', 'demo.json.2026-11-23T09-30-00-005Z.bad', 'demo.json.2026-11-23T09-30-01-005Z.bad', 'demo.json.bad'
    ])
    expect(JSON.parse(await readFile(join(world, 'demo.json.2026-11-23T09-30-00-005Z-1.bad'), 'utf8')).layout).toBe('x')
  })

  it('keeps only the five newest backups of a file; an old fixed-name .bad counts as the oldest, other files are never touched', async () => {
    let clock = Date.UTC(2026, 0, 1)
    const store = createWorldStore(dir, { now: () => clock })
    const world = join(dir, 'world')
    await mkdir(world, { recursive: true })
    const others = ['demo.json.bad.txt', 'demo.json.notastamp.bad', 'other.json.bad', 'demo.json.stages.json', 'demox.json.2026-01-01T00-00-00-000Z.bad']
    for (const name of ['demo.json.bad', ...others]) await writeFile(join(world, name), name)
    for (let i = 0; i < 6; i++) {
      await writeFile(join(world, 'demo.json'), `broken ${i}`)
      expect(await store.load('demo')).toBeNull()
      clock += 60_000
    }
    const left = (await readdir(world)).sort()
    expect(left.filter((n) => !others.includes(n))).toEqual([
      'demo.json.2026-01-01T00-01-00-000Z.bad', 'demo.json.2026-01-01T00-02-00-000Z.bad', 'demo.json.2026-01-01T00-03-00-000Z.bad',
      'demo.json.2026-01-01T00-04-00-000Z.bad', 'demo.json.2026-01-01T00-05-00-000Z.bad'
    ])
    for (const name of others) expect(left).toContain(name)
    expect(await readFile(join(world, 'demo.json.2026-01-01T00-05-00-000Z.bad'), 'utf8')).toBe('broken 5')
  })

  it('a corrupt file whose backup cannot be written still loads as null and stays where it was', async () => {
    const store = createWorldStore(dir, { rename: async () => { throw Object.assign(new Error('refused'), { code: 'EINVAL' }) } })
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'demo.json'), 'garbage')
    expect(await store.load('demo')).toBeNull()
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
  })

  it('a world that a locked file refuses for a moment (EBUSY, EACCES, EPERM) is read again and loads (F18)', async () => {
    const waits: number[] = []
    const real = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile
    let refusals = ['EBUSY', 'EACCES', 'EPERM']
    const read = (async (...args: Parameters<typeof real>) => {
      const code = refusals.shift()
      if (code) throw Object.assign(new Error(`${code}: locked`), { code })
      return real(...args)
    }) as typeof real
    const store = createWorldStore(dir, { readFile: read, sleep: async (ms) => { waits.push(ms) } })
    refusals = []
    await store.save(doc())
    refusals = ['EBUSY', 'EACCES', 'EPERM']
    expect(await store.load('demo')).toEqual(doc())
    expect(waits).toEqual([100, 200, 300])
    // refused on every try: it gives up after about a second and the error reaches the caller, as before
    waits.length = 0
    refusals = ['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY']
    await expect(store.load('demo')).rejects.toThrow('EBUSY')
    expect(waits).toEqual([100, 200, 300, 400])
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
  })

  it('a rename a locked file refuses for a moment is tried again and the save lands', async () => {
    const waits: number[] = []
    let refusals = ['EPERM', 'EBUSY']
    const store = createWorldStore(dir, {
      sleep: async (ms) => { waits.push(ms) },
      rename: async (from, to) => {
        const code = refusals.shift()
        if (code) throw Object.assign(new Error(code), { code })
        return rename(from, to)
      }
    })
    await store.save(doc())
    expect(await store.load('demo')).toEqual(doc())
    expect(waits).toEqual([100, 200])
    refusals = []
  })

  it('a stored world with one bad claim or tour step loads without it, the rest exactly as stored, and logs only kinds and places (C14)', async () => {
    const lines: string[] = []
    const store = createWorldStore(dir, { log: (m) => lines.push(m) })
    const good = { text: 'Serves the API', state: 'observed', evidence: [{ kind: 'file', ref: 'src/a.ts' }] }
    const bad = { text: 'PRIVATE-TEXT', state: 'nonsense', evidence: [{ kind: 'file', ref: 'src/secret-place.ts' }] }
    const stored = {
      ...doc(),
      buildings: [{ ...doc().buildings[0], how: [good], why: [bad, good] }],
      tours: [
        { id: 't1', title: 'Walk', steps: [{ ids: ['b-a'], caption: 'Start' }, { ids: ['gone'], caption: 'PRIVATE-CAPTION' }] },
        { id: 't2', title: 'PRIVATE-TOUR', steps: [{ ids: ['nowhere'], caption: 'x' }] }
      ]
    }
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'demo.json'), JSON.stringify(stored))
    const loaded = await store.load('demo')
    expect(loaded).toEqual({
      ...stored,
      buildings: [{ ...stored.buildings[0], why: [good] }],
      tours: [{ id: 't1', title: 'Walk', steps: [{ ids: ['b-a'], caption: 'Start' }] }]
    })
    expect(lines).toEqual(['[world store] a stored world loaded without its bad items: claim #0, tour step #1, tour step #0, tour #1'])
    expect(lines[0]).not.toMatch(/PRIVATE|secret|demo|Walk/)
    // the file is left as it was, not moved aside
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
    expect(JSON.parse(await readFile(join(dir, 'world', 'demo.json'), 'utf8'))).toEqual(stored)
  })

  it('logs dropped items to the console when no log is given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const store = createWorldStore(dir)
      await mkdir(join(dir, 'world'), { recursive: true })
      await writeFile(join(dir, 'world', 'demo.json'), JSON.stringify({ ...doc(), tours: [7] }))
      expect((await store.load('demo'))?.tours).toEqual([])
      expect(warn).toHaveBeenCalledWith('[world store] a stored world loaded without its bad items: tour #0')
    } finally {
      warn.mockRestore()
    }
  })

  it('an older version with no migration still fails as before; a version that is not a whole number is broken too', async () => {
    const store = createWorldStore(dir)
    await mkdir(join(dir, 'world'), { recursive: true })
    for (const version of [0, 1.5, '2', null]) {
      await writeFile(join(dir, 'world', 'demo.json'), JSON.stringify({ ...doc(), version }))
      expect(await store.load('demo')).toBeNull()
      expect(await readdir(join(dir, 'world'))).not.toContain('demo.json')
    }
  })

  it('sanitises the key into the file name and rejects empty or dot keys', async () => {
    expect(worldFileName('a/b\\c:d e')).toBe('a_b_c_d_e.json')
    expect(worldFileName('ok.Key-1_2')).toBe('ok.Key-1_2.json')
    for (const bad of ['', '.', '..']) expect(() => worldFileName(bad)).toThrow(/project key/)
    const store = createWorldStore(dir)
    await store.save(doc('C:/repos/x'))
    expect(await readdir(join(dir, 'world'))).toEqual(['C__repos_x.json'])
    expect((await store.load('C:/repos/x'))?.projectKey).toBe('C:/repos/x')
    await expect(store.load('..')).rejects.toThrow(/project key/)
    await expect(store.save(doc(''))).rejects.toThrow(/project key/)
  })

  it('a failed rename removes the temp file and rethrows', async () => {
    const store = createWorldStore(dir, { sleep: async () => undefined })
    // The target is a non-empty directory, so the rename onto it fails on every platform.
    await mkdir(join(dir, 'world', 'demo.json'), { recursive: true })
    await writeFile(join(dir, 'world', 'demo.json', 'keep'), 'x')
    await expect(store.save(doc())).rejects.toThrow()
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
  })

  it('a read error other than a missing file is not swallowed', async () => {
    const store = createWorldStore(dir)
    await mkdir(join(dir, 'world', 'demo.json'), { recursive: true })
    await expect(store.load('demo')).rejects.toThrow()
  })

  it('label cache: miss, round-trip, sha-named files under world/label-cache, overwrite', async () => {
    const store = createWorldStore(dir)
    expect(await store.labelCache.get('k1')).toBeNull()
    await store.labelCache.set('k1', '{"name":"Api"}')
    await store.labelCache.set('../../escape', 'v2')
    expect(await store.labelCache.get('k1')).toBe('{"name":"Api"}')
    expect(await store.labelCache.get('../../escape')).toBe('v2')
    const files = (await readdir(join(dir, 'world', 'label-cache'))).sort()
    expect(files).toHaveLength(2)
    for (const f of files) expect(f).toMatch(/^[0-9a-f]{64}\.txt$/)
    await store.labelCache.set('k1', 'newer')
    expect(await store.labelCache.get('k1')).toBe('newer')
    expect(await readdir(join(dir, 'world', 'label-cache'))).toHaveLength(2)
  })

  it('label cache: entries written by this build today still read back (current-format fixture)', async () => {
    const { createHash } = await import('node:crypto')
    const cache = join(dir, 'world', 'label-cache')
    await mkdir(cache, { recursive: true })
    const name = `${createHash('sha256').update('prompt-hash-1').digest('hex')}.txt`
    await writeFile(join(cache, name), '{"name":"Api","subtitle":"serves"}')
    expect(await createWorldStore(dir).labelCache.get('prompt-hash-1')).toBe('{"name":"Api","subtitle":"serves"}')
  })

  it('label cache: a hit older than a day is marked used now; a fresh hit is left alone', async () => {
    const now = Date.UTC(2026, 10, 23)
    const store = createWorldStore(dir, { now: () => now })
    await store.labelCache.set('old', 'v1')
    await store.labelCache.set('fresh', 'v2')
    const files = await readdir(join(dir, 'world', 'label-cache'))
    const { createHash } = await import('node:crypto')
    const fileOf = (k: string): string => join(dir, 'world', 'label-cache', `${createHash('sha256').update(k).digest('hex')}.txt`)
    expect(files).toHaveLength(2)
    const twoDays = (now - 2 * 24 * 3600 * 1000) / 1000
    const hourAgo = (now - 3600 * 1000) / 1000
    await utimes(fileOf('old'), twoDays, twoDays)
    await utimes(fileOf('fresh'), hourAgo, hourAgo)
    expect(await store.labelCache.get('old')).toBe('v1')
    expect(await store.labelCache.get('fresh')).toBe('v2')
    expect(Math.round((await stat(fileOf('old'))).mtimeMs)).toBe(now)
    expect(Math.round((await stat(fileOf('fresh'))).mtimeMs)).toBe(hourAgo * 1000)
  })

  it('label cache: the first write of a run prunes old entries in the background, once (F22)', async () => {
    const now = Date.UTC(2026, 10, 23)
    const cache = join(dir, 'world', 'label-cache')
    await mkdir(cache, { recursive: true })
    const stale = (now - LABEL_MAX_AGE_MS - 1000) / 1000
    await writeFile(join(cache, 'a'.repeat(64) + '.txt'), 'old')
    await utimes(join(cache, 'a'.repeat(64) + '.txt'), stale, stale)
    const store = createWorldStore(dir, { now: () => now })
    await store.labelCache.set('k1', 'v')
    await vi.waitFor(async () => expect(await readdir(cache)).toHaveLength(1))
    await writeFile(join(cache, 'b'.repeat(64) + '.txt'), 'old')
    await utimes(join(cache, 'b'.repeat(64) + '.txt'), stale, stale)
    await store.labelCache.set('k2', 'v')
    await new Promise((r) => setTimeout(r, 50))
    expect(await readdir(cache)).toContain('b'.repeat(64) + '.txt')
  })

  it('label cache: an unwritable cache is a quiet miss', async () => {
    // A file where the cache folder should be: mkdir fails, set swallows it, get misses.
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'label-cache'), 'not a folder')
    const store = createWorldStore(dir)
    await expect(store.labelCache.set('k1', 'v')).resolves.toBeUndefined()
    expect(await store.labelCache.get('k1')).toBeNull()
  })
})

describe('pruneLabelCache', () => {
  const now = Date.UTC(2026, 10, 23)
  const ago = async (file: string, ms: number): Promise<void> => {
    await writeFile(file, 'x')
    await utimes(file, (now - ms) / 1000, (now - ms) / 1000)
  }

  it('removes entries unused for 90 days and temp files older than a day, then the least recently used beyond the cap', async () => {
    const cache = join(dir, 'c')
    await mkdir(cache, { recursive: true })
    const day = 24 * 3600 * 1000
    await ago(join(cache, 'stale.txt'), LABEL_MAX_AGE_MS + day)
    await ago(join(cache, 'new1.txt'), 1000)
    await ago(join(cache, 'new2.txt'), 2000)
    await ago(join(cache, 'new3.txt'), 3000)
    await ago(join(cache, 'left.tmp'), 2 * day)
    await ago(join(cache, 'writing.tmp'), 1000)
    await ago(join(cache, 'notes.md'), LABEL_MAX_AGE_MS + day)
    await mkdir(join(cache, 'folder.txt'))
    await mkdir(join(cache, 'folder.tmp'))
    // a link to nothing: listed, but it cannot be looked at, so it is left alone
    await symlink(join(dir, 'nowhere'), join(cache, 'dangling.txt'), 'junction')
    expect(await pruneLabelCache(cache, now, 2)).toBe(3)
    expect((await readdir(cache)).sort()).toEqual(['dangling.txt', 'folder.tmp', 'folder.txt', 'new1.txt', 'new2.txt', 'notes.md', 'writing.tmp'])
    // the default cap keeps everything that is fresh
    expect(await pruneLabelCache(cache, now)).toBe(0)
  })

  it('a missing cache folder prunes nothing', async () => {
    expect(await pruneLabelCache(join(dir, 'nope'), now)).toBe(0)
  })
})

describe('worldStore and a world written by a newer Termpolis (C13)', () => {
  const file = (): string => join(dir, 'world', 'demo.json')
  const newer = (): Record<string, unknown> => ({ ...doc(), version: 2, futureField: { kept: true } })

  it('opens it read-only: shows it marked savedByNewer, never moves it aside, never writes over it', async () => {
    const store = createWorldStore(dir)
    await mkdir(join(dir, 'world'), { recursive: true })
    const text = JSON.stringify(newer())
    await writeFile(file(), text)
    const shown = await store.load('demo')
    expect(shown).toEqual({ ...doc(), futureField: { kept: true }, version: 1, savedByNewer: true })
    // what this version compiles is kept in memory only, and the doc handed back says so
    const compiled: WorldDoc = { ...doc(), generatedAt: 5, savedByNewer: true }
    await store.save(compiled)
    expect(compiled.savedByNewer).toBe(true)
    expect(await readFile(file(), 'utf8')).toBe(text)
    expect(await store.load('demo')).toEqual({ ...doc(), generatedAt: 5, savedByNewer: true })
    // its stage cache is left alone too
    await store.saveStages?.('demo', { version: STAGE_CACHE_VERSION, files: {}, structureHash: 's' })
    expect((await readdir(join(dir, 'world'))).sort()).toEqual(['demo.json'])
    expect(await readFile(file(), 'utf8')).toBe(text)
  })

  it('the copy in memory is not changed by what a caller does to a loaded or saved doc', async () => {
    const store = createWorldStore(dir)
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(file(), JSON.stringify(newer()))
    await store.load('demo')
    const saved: WorldDoc = { ...doc(), generatedAt: 6 }
    await store.save(saved)
    saved.layout.positions = {}
    const first = await store.load('demo') as WorldDoc
    first.layout.positions = {}
    expect((await store.load('demo'))?.layout.positions).toEqual(doc().layout.positions)
  })

  it('a newer world this version cannot read loads as absent, stays on disk, and a compile is kept in memory', async () => {
    const store = createWorldStore(dir)
    await mkdir(join(dir, 'world'), { recursive: true })
    const text = JSON.stringify({ version: 3, everything: 'different' })
    await writeFile(file(), text)
    expect(await store.load('demo')).toBeNull()
    await store.save(doc())
    expect(await readFile(file(), 'utf8')).toBe(text)
    expect(await store.load('demo')).toEqual({ ...doc(), savedByNewer: true })
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
  })

  it('a save with no load before it reads the file once to tell', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    const text = JSON.stringify(newer())
    await writeFile(file(), text)
    const store = createWorldStore(dir)
    await store.save(doc())
    await store.save({ ...doc(), generatedAt: 9 })
    expect(await readFile(file(), 'utf8')).toBe(text)
    // a file of ours, or none, is written as always
    const other = createWorldStore(dir)
    await writeFile(join(dir, 'world', 'x.json'), JSON.stringify(doc('x')))
    await other.save({ ...doc('x'), generatedAt: 4 })
    expect(JSON.parse(await readFile(join(dir, 'world', 'x.json'), 'utf8')).generatedAt).toBe(4)
    await other.save(doc('y'))
    await other.save({ ...doc('y'), generatedAt: 3 })
    expect(JSON.parse(await readFile(join(dir, 'world', 'y.json'), 'utf8')).generatedAt).toBe(3)
  })

  it('a save whose look at the file fails for another reason is not remembered and writes as before', async () => {
    const store = createWorldStore(dir, { sleep: async () => undefined })
    await mkdir(file(), { recursive: true })
    await writeFile(join(file(), 'keep'), 'x')
    await expect(store.save(doc())).rejects.toThrow()
    await rm(file(), { recursive: true })
    await store.save(doc())
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(doc())
  })

  it('once the newer file is gone or replaced by one of ours, the copy in memory goes and the disk is used again', async () => {
    const store = createWorldStore(dir)
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(file(), JSON.stringify(newer()))
    await store.load('demo')
    await store.save({ ...doc(), generatedAt: 7 })
    await writeFile(file(), JSON.stringify({ ...doc(), generatedAt: 8 }))
    expect(await store.load('demo')).toEqual({ ...doc(), generatedAt: 8 })
    await store.save({ ...doc(), generatedAt: 10 })
    expect(JSON.parse(await readFile(file(), 'utf8')).generatedAt).toBe(10)
    await writeFile(file(), JSON.stringify(newer()))
    await store.load('demo')
    await rm(file())
    expect(await store.load('demo')).toBeNull()
    await store.save(doc())
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(doc())
  })

  it('the savedByNewer mark is never written to disk', async () => {
    const store = createWorldStore(dir)
    await store.save({ ...doc(), savedByNewer: true })
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(doc())
    expect(await store.load('demo')).toEqual(doc())
  })
})

describe('worldStore and worlds stored today (current-format fixtures)', () => {
  it('a full world as this build saves it, every optional field included, loads exactly as stored', async () => {
    const claim = { text: 'Handles requests', state: 'verified', evidence: [{ kind: 'test', ref: 'tests/a.test.ts', excerpt: 'it works' }] }
    const fixture = {
      ...doc(),
      districts: [{ id: 'd-a', name: 'a', subtitle: 'core', hue: 120, members: ['b-a', 'b-b'], nameState: 'inferred' }],
      buildings: [
        { ...doc().buildings[0], how: [claim], why: [claim], claims: [claim], nameState: 'inferred',
          growth: { start: 'folder', seed: 'src', folder: 'src', merged: 2, mergedFiles: 3, folded: 0, cap: 40, reached: 3, inFolder: 3 } },
        { ...doc().buildings[0], id: 'b-b', name: 'b', status: 'verified', members: ['src/b.ts'] }
      ],
      edges: [{ id: 'e1', from: 'b-a', to: 'b-b', cargo: 'json', label: 'calls', rate: '', twoWay: false, twoWayStated: true, tech: ['ts'], how: [claim], why: [], claims: [] }],
      externals: [{ id: 'x1', name: 'Claude', kind: 'agent', fog: false }],
      glossary: { ts: 'TypeScript' },
      cargo: { json: { shape: 'cube', color: '#fff', label: 'JSON' } },
      processes: { main: { label: 'Main', color: '#000' } },
      tours: [{ id: 't1', title: 'Walk', steps: [{ ids: ['b-a', 'e1'], caption: 'Start here' }] }],
      layout: { seed: 3, round: 2, positions: { 'd-a': [0, 0, 0], 'b-a': [1, 0, 1], 'b-b': [2, 0, 2] } },
      runtimeNames: { api: ['b-a'] },
      layers: { plan: [{ id: 'p1', title: 'Plan', summary: [claim], buildings: [], edges: [], removes: [] }] },
      labelTokens: 1200,
      runtimeHandSet: ['api'],
      filesCapped: 5000,
      nestedCapped: 3000,
      filesUnreadable: 2,
      filesRead: 900,
      filesListed: 1000
    }
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'demo.json'), JSON.stringify(fixture))
    const lines: string[] = []
    expect(await createWorldStore(dir, { log: (m) => lines.push(m) }).load('demo')).toEqual(fixture)
    expect(lines).toEqual([])
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
  })

  it('a world saved before claims and name states existed still loads, filled in as before', async () => {
    const { claims: _c, nameState: _n, ...building } = doc().buildings[0]
    const { nameState: _d, ...district } = doc().districts[0]
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'demo.json'), JSON.stringify({ ...doc(), buildings: [building], districts: [district] }))
    expect(await createWorldStore(dir).load('demo')).toEqual(doc())
  })
})

describe('worldStore stage cache', () => {
  const cache = {
    version: STAGE_CACHE_VERSION,
    files: { 'src/a.ts': { hash: 'h', boundaries: [{ kind: 'ipc' as const, key: 'k', side: 'provide' as const, file: 'src/a.ts', line: 2 }], imports: ['./b'] } },
    structureHash: 's'
  }
  it('round-trips beside the world as <world file>.stages.json; a missing or wrong-shape file loads as null', async () => {
    const store = createWorldStore(dir)
    expect(await store.loadStages?.('C:/repos/x')).toBeNull()
    await store.saveStages?.('C:/repos/x', cache)
    expect(await store.loadStages?.('C:/repos/x')).toEqual(cache)
    const files = await readdir(join(dir, 'world'))
    expect(files).toEqual([`${worldFileName('C:/repos/x')}.stages.json`])
    await writeFile(join(dir, 'world', files[0]), JSON.stringify({ version: STAGE_CACHE_VERSION, files: [], structureHash: 's' }))
    expect(await store.loadStages?.('C:/repos/x')).toBeNull()
    await writeFile(join(dir, 'world', files[0]), '{torn')
    expect(await store.loadStages?.('C:/repos/x')).toBeNull()
  })

  it('a stage cache that cannot be written is dropped quietly', async () => {
    await writeFile(join(dir, 'world'), 'not a folder')
    const store = createWorldStore(dir)
    await expect(store.saveStages?.('demo', cache)).resolves.toBeUndefined()
    expect(await store.loadStages?.('demo')).toBeNull()
  })
})
