import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorldDoc } from '../../src/shared/world/types'
import { createWorldStore, LABEL_MAX_AGE_MS, pruneLabelCache, WORLD_READ_FAILED, WORLD_SAVED_BY_NEWER, WorldReadError, WorldSavedByNewerError, worldFileName } from '../../src/main/world/worldStore'
import { STAGE_CACHE_VERSION } from '../../src/main/world/stageCache'
import { edgeId } from '../../src/main/world/group'

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

const OLD_TCP = 'A network connection on a numbered port'
/** A world an older compiler saved: TCP on a part, and on the port line it found in the code to the next part. */
function portWorld(): WorldDoc {
  const saved = doc()
  const a = saved.buildings[0]
  saved.buildings = [{ ...a, techLabel: 'TCP' }, { ...a, id: 'b-b', name: 'b', members: ['src/b.ts'] }]
  saved.districts = [{ ...saved.districts[0], members: ['b-a', 'b-b'] }]
  saved.layout = { seed: 1, positions: { ...saved.layout.positions, 'b-b': [2, 0, 2] } }
  saved.edges = [
    {
      id: edgeId({ from: 'b-a', to: 'b-b' }), from: 'b-a', to: 'b-b', cargo: '', label: 'port data', how: [], why: [], tech: ['TCP'], rate: '', twoWay: false,
      claims: [{ text: 'Seen in code', state: 'observed', evidence: [{ kind: 'file', ref: 'src/a.ts:1' }] }]
    }
  ]
  saved.glossary = { TCP: OLD_TCP }
  return saved
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

  it('a saved world with an "other" floor still loads, the floor as it was (WP-LOOK Task 8)', async () => {
    const files = Array.from({ length: 15 }, (_, i) => `src/a/f${String(i).padStart(2, '0')}.ts`)
    const floors = [...files.slice(0, 11).map((m) => ({ name: m.slice(6, -3), tech: [], members: [m] })), { name: 'other', tech: [], members: files.slice(11) }]
    const saved = doc()
    saved.buildings[0] = { ...saved.buildings[0], members: files, floors }
    const store = createWorldStore(dir)
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'demo.json'), JSON.stringify(saved))
    expect(await store.load('demo')).toEqual(saved)
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
  })

  it('a saved world with TCP on a port part loads with Message port; a model\'s TCP with no port line is kept (WP-LOOK Task 9, review I-1)', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'demo.json'), JSON.stringify(portWorld()))
    const loaded = await createWorldStore(dir).load('demo')
    expect(loaded?.buildings.map((b) => b.techLabel)).toEqual(['Message port', 'TS'])
    expect(loaded?.edges[0].tech).toEqual(['Message port'])
    expect(loaded?.glossary).toEqual({ 'Message port': 'Messages passed over a channel between two parts of the app' })
    // The same TCP with no port line to show where it came from is a model's word, and stays.
    const own = doc()
    own.buildings[0] = { ...own.buildings[0], techLabel: 'TCP' }
    own.glossary = { TCP: OLD_TCP }
    await writeFile(join(dir, 'world', 'demo.json'), JSON.stringify(own))
    expect(await createWorldStore(dir).load('demo')).toEqual(own)
  })

  it('a TCP only a plan proposal uses keeps its definition through a load, a save and a load (review M-6)', async () => {
    const saved = doc()
    saved.layers = { plan: [{ id: 'plan', title: 'Relay', summary: [], buildings: [{ ...saved.buildings[0], id: 'p-relay', status: 'proposed', stack: ['TCP'] }], edges: [] }] }
    saved.layout = { seed: 1, positions: { ...saved.layout.positions, 'p-relay': [3, 0, 3] } }
    saved.glossary = { TCP: OLD_TCP }
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'demo.json'), JSON.stringify(saved))
    const store = createWorldStore(dir)
    const loaded = (await store.load('demo')) as WorldDoc
    expect(loaded).toEqual(saved)
    await store.save(loaded)
    expect(await createWorldStore(dir).load('demo')).toEqual(saved)
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
  })

  it('corrupt file → load null + a timestamped, numbered .bad backup; earlier backups are kept (F21)', async () => {
    let clock = Date.UTC(2026, 10, 23, 9, 30, 0, 5)
    const store = createWorldStore(dir, { now: () => clock })
    const world = join(dir, 'world')
    await mkdir(world, { recursive: true })
    await writeFile(join(world, 'demo.json'), '{ not json')
    await writeFile(join(world, 'demo.json.bad'), 'older bad copy')
    expect(await store.load('demo')).toBeNull()
    expect((await readdir(world)).sort()).toEqual(['demo.json.2026-11-23T09-30-00-005Z-1.bad', 'demo.json.bad'])
    expect(await readFile(join(world, 'demo.json.bad'), 'utf8')).toBe('older bad copy')
    expect(await readFile(join(world, 'demo.json.2026-11-23T09-30-00-005Z-1.bad'), 'utf8')).toBe('{ not json')

    // Valid JSON that fails validateWorld is treated the same way, and a second corruption never overwrites the first.
    await writeFile(join(world, 'demo.json'), JSON.stringify({ ...doc(), layout: 'x' }))
    expect(await store.load('demo')).toBeNull()
    await writeFile(join(world, 'demo.json'), '[]')
    clock += 1000
    expect(await store.load('demo')).toBeNull()
    expect((await readdir(world)).sort()).toEqual([
      'demo.json.2026-11-23T09-30-00-005Z-1.bad', 'demo.json.2026-11-23T09-30-00-005Z-2.bad', 'demo.json.2026-11-23T09-30-01-005Z-3.bad', 'demo.json.bad'
    ])
    expect(JSON.parse(await readFile(join(world, 'demo.json.2026-11-23T09-30-00-005Z-2.bad'), 'utf8')).layout).toBe('x')
  })

  it('keeps only the five newest numbered backups of a file; the old fixed-name .bad and other files are never touched', async () => {
    let clock = Date.UTC(2026, 0, 1)
    const store = createWorldStore(dir, { now: () => clock })
    const world = join(dir, 'world')
    await mkdir(world, { recursive: true })
    const others = ['demo.json.bad.txt', 'demo.json.notastamp.bad', 'other.json.bad', 'demo.json.stages.json', 'demox.json.2026-01-01T00-00-00-000Z-1.bad', 'demo.json.bad']
    for (const name of others) await writeFile(join(world, name), name)
    for (let i = 0; i < 6; i++) {
      await writeFile(join(world, 'demo.json'), `broken ${i}`)
      expect(await store.load('demo')).toBeNull()
      clock += 60_000
    }
    const left = (await readdir(world)).sort()
    expect(left.filter((n) => !others.includes(n))).toEqual([
      'demo.json.2026-01-01T00-01-00-000Z-2.bad', 'demo.json.2026-01-01T00-02-00-000Z-3.bad', 'demo.json.2026-01-01T00-03-00-000Z-4.bad',
      'demo.json.2026-01-01T00-04-00-000Z-5.bad', 'demo.json.2026-01-01T00-05-00-000Z-6.bad'
    ])
    for (const name of others) expect(await readFile(join(world, name), 'utf8')).toBe(name)
    expect(await readFile(join(world, 'demo.json.2026-01-01T00-05-00-000Z-6.bad'), 'utf8')).toBe('broken 5')
  })

  it('a corrupt file that cannot be moved aside is refused by load and save alike, and its bytes stay as they were (round 2)', async () => {
    const lines: string[] = []
    let refuse = true
    const realRename = (await import('node:fs/promises')).rename
    const store = createWorldStore(dir, {
      sleep: async () => undefined,
      log: (m) => lines.push(m),
      now: () => Date.UTC(2026, 10, 23, 1, 2, 3, 4),
      rename: async (from, to) => {
        if (refuse) throw Object.assign(new Error('refused'), { code: 'EPERM' })
        return realRename(from, to)
      }
    })
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'demo.json'), 'garbage')
    const err = await store.load('demo').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorldReadError)
    expect(err).toMatchObject({ code: 'WORLD_READ_FAILED', message: WORLD_READ_FAILED })
    expect(lines).toEqual(['[world store] the stored world demo.json does not read and could not be moved aside, so nothing is saved over it'])
    // a compile's save after the failed load is refused too, and nothing is written
    await expect(store.save(doc())).rejects.toMatchObject({ code: 'WORLD_READ_FAILED' })
    // as is a save from a store that never loaded it
    await expect(createWorldStore(dir, { sleep: async () => undefined, log: () => undefined, rename: async () => { throw new Error('refused') } }).save(doc()))
      .rejects.toBeInstanceOf(WorldReadError)
    expect(await readFile(join(dir, 'world', 'demo.json'), 'utf8')).toBe('garbage')
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
    // once the file can be moved aside, the next save moves it and writes the world
    refuse = false
    await store.save(doc())
    expect(JSON.parse(await readFile(join(dir, 'world', 'demo.json'), 'utf8'))).toEqual(doc())
    expect(await readFile(join(dir, 'world', 'demo.json.2026-11-23T01-02-03-004Z-1.bad'), 'utf8')).toBe('garbage')
  })

  it('a save after a load that refused looks at the file again rather than trusting what an earlier load saw', async () => {
    const store = createWorldStore(dir, { sleep: async () => undefined, log: () => undefined })
    await store.save(doc())
    expect(await store.load('demo')).toEqual(doc())
    // the file turns into a folder: the load refuses, and so does the save after it
    await rm(join(dir, 'world', 'demo.json'))
    await mkdir(join(dir, 'world', 'demo.json'))
    await expect(store.load('demo')).rejects.toBeInstanceOf(WorldReadError)
    await expect(store.save(doc())).rejects.toBeInstanceOf(WorldReadError)
    expect(await readdir(join(dir, 'world', 'demo.json'))).toEqual([])
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
    // refused on every try: it gives up after about a second and the caller gets the plain read error (F-R11)
    waits.length = 0
    refusals = ['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY']
    await expect(store.load('demo')).rejects.toThrow(WORLD_READ_FAILED)
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
    // the file is left as it was, not moved aside, and an untouched copy of it is in the backups
    const text = JSON.stringify(stored)
    const names = (await readdir(join(dir, 'world'))).sort()
    expect(names).toHaveLength(2)
    expect(names[1]).toMatch(/^demo\.json\.\d{4}-.*Z-1\.bad$/)
    expect(await readFile(join(dir, 'world', 'demo.json'), 'utf8')).toBe(text)
    expect(await readFile(join(dir, 'world', names[1]), 'utf8')).toBe(text)
  })

  it('a load that leaves items out backs the file up once per content, so a later save never loses them (I1)', async () => {
    const at = Date.UTC(2026, 10, 23, 1, 2, 3, 4)
    const store = createWorldStore(dir, { now: () => at, log: () => undefined })
    const bad = { text: 'kept in the backup', state: 'nonsense', evidence: [] }
    const stored = { ...doc(), buildings: [{ ...doc().buildings[0], why: [bad] }] }
    const text = JSON.stringify(stored)
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'demo.json'), text)
    const loaded = await store.load('demo')
    expect(loaded?.buildings[0].why).toEqual([])
    // loading the same file again, in this store or another, makes no second backup
    await store.load('demo')
    await createWorldStore(dir, { now: () => at + 1, log: () => undefined }).load('demo')
    await store.save(loaded as WorldDoc)
    const backup = join(dir, 'world', 'demo.json.2026-11-23T01-02-03-004Z-1.bad')
    expect((await readdir(join(dir, 'world'))).sort()).toEqual(['demo.json', 'demo.json.2026-11-23T01-02-03-004Z-1.bad'])
    expect(await readFile(backup, 'utf8')).toBe(text)
    expect(await readFile(backup, 'utf8')).toContain('kept in the backup')
    expect(JSON.parse(await readFile(join(dir, 'world', 'demo.json'), 'utf8')).buildings[0].why).toEqual([])
  })

  it('a load that leaves items out but cannot back the file up fails closed with the fixed error, and nothing is written', async () => {
    const lines: string[] = []
    const text = JSON.stringify({ ...doc(), tours: [7] })
    // the store's read sees the world; the file itself is gone by the time the backup copies it
    const store = createWorldStore(dir, { log: (m) => lines.push(m), readFile: (async () => text) as never })
    const err = await store.load('demo').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorldReadError)
    expect((err as WorldReadError).message).toBe(WORLD_READ_FAILED)
    expect(lines[1]).toBe('[world store] the stored world demo.json left items out and could not be backed up first')
    await expect(readdir(join(dir, 'world'))).rejects.toMatchObject({ code: 'ENOENT' })
    // a save loads first, and is refused the same way
    await expect(store.save(doc())).rejects.toBeInstanceOf(WorldReadError)
    await expect(readdir(join(dir, 'world'))).rejects.toMatchObject({ code: 'ENOENT' })
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

  describe('a save while a load is still backing up or moving aside the same world (WP3 round 3, M1)', () => {
    const realRename = async (from: string, to: string): Promise<void> => rename(from, to)
    /** A store whose move-aside rename of the world file waits until `release` settles it; any other rename goes through. */
    function gated(): { store: ReturnType<typeof createWorldStore>; order: string[]; release: (fail?: boolean) => void } {
      const order: string[] = []
      let open: (fail: boolean) => void = () => undefined
      const gate = new Promise<boolean>((r) => { open = r })
      let moveFails = false
      const store = createWorldStore(dir, {
        sleep: async () => undefined,
        log: () => undefined,
        rename: async (from, to) => {
          if (from.endsWith('.tmp')) { order.push('save written'); return realRename(from, to) }
          order.push('move aside started')
          if (await gate || moveFails) throw Object.assign(new Error('refused'), { code: 'EIO' })
          await realRename(from, to)
          order.push('moved aside')
        }
      })
      return { store, order, release: (fail = false) => { moveFails = fail; open(fail) } }
    }
    const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

    it('the save waits for the move-aside, then writes; the broken file is in a backup, never written over', async () => {
      await mkdir(join(dir, 'world'), { recursive: true })
      await writeFile(join(dir, 'world', 'demo.json'), 'garbage')
      const { store, order, release } = gated()
      const loaded = store.load('demo')
      await vi.waitFor(() => expect(order).toEqual(['move aside started']))
      const saved = store.save(doc())
      await tick()
      expect(order).toEqual(['move aside started']) // the save has written nothing yet
      expect(await readFile(join(dir, 'world', 'demo.json'), 'utf8')).toBe('garbage')
      release()
      expect(await loaded).toBeNull()
      await saved
      expect(order).toEqual(['move aside started', 'moved aside', 'save written'])
      expect(JSON.parse(await readFile(join(dir, 'world', 'demo.json'), 'utf8'))).toEqual(doc())
      const backups = (await readdir(join(dir, 'world'))).filter((f) => f !== 'demo.json')
      expect(backups).toHaveLength(1)
      expect(await readFile(join(dir, 'world', backups[0]), 'utf8')).toBe('garbage')
    })

    it('a move-aside that fails refuses the waiting save too, and the bytes stay as they were', async () => {
      await mkdir(join(dir, 'world'), { recursive: true })
      await writeFile(join(dir, 'world', 'demo.json'), 'garbage')
      const { store, order, release } = gated()
      const loaded = store.load('demo').catch((e: unknown) => e)
      await vi.waitFor(() => expect(order).toEqual(['move aside started']))
      const saved = store.save(doc()).catch((e: unknown) => e)
      await tick()
      release(true)
      expect(await loaded).toBeInstanceOf(WorldReadError)
      expect(await saved).toBeInstanceOf(WorldReadError) // its own load tried the move again, and was refused
      expect(order).toEqual(['move aside started', 'move aside started'])
      expect(await readFile(join(dir, 'world', 'demo.json'), 'utf8')).toBe('garbage')
      expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
    })

    it('two loads of one broken file at once: the second waits and finds it moved aside, neither is refused', async () => {
      await mkdir(join(dir, 'world'), { recursive: true })
      await writeFile(join(dir, 'world', 'demo.json'), 'garbage')
      const { store, order, release } = gated()
      const first = store.load('demo')
      const second = store.load('demo')
      await vi.waitFor(() => expect(order).toEqual(['move aside started']))
      await tick()
      expect(order).toEqual(['move aside started']) // the second load waits: it never starts a rename of its own
      release()
      expect(await first).toBeNull()
      expect(await second).toBeNull()
      expect(order).toEqual(['move aside started', 'moved aside'])
      expect((await readdir(join(dir, 'world'))).filter((f) => f !== 'demo.json')).toHaveLength(1)
    })

    it('a world with items left out is handed out only after its backup, so a save at once still finds the original backed up', async () => {
      await mkdir(join(dir, 'world'), { recursive: true })
      const stored = { ...doc(), tours: [7] }
      await writeFile(join(dir, 'world', 'demo.json'), JSON.stringify(stored))
      const store = createWorldStore(dir, { log: () => undefined })
      const [loaded] = await Promise.all([store.load('demo'), store.save({ ...doc(), generatedAt: 9 })])
      expect(loaded?.tours).toEqual([])
      expect(JSON.parse(await readFile(join(dir, 'world', 'demo.json'), 'utf8')).generatedAt).toBe(9)
      const backups = (await readdir(join(dir, 'world'))).filter((f) => f !== 'demo.json')
      expect(backups).toHaveLength(1)
      expect(JSON.parse(await readFile(join(dir, 'world', backups[0]), 'utf8'))).toEqual(stored)
    })
  })

  it('a failed rename removes the temp file and rethrows', async () => {
    const refused = Object.assign(new Error('refused'), { code: 'EINVAL' })
    const store = createWorldStore(dir, { sleep: async () => undefined, rename: async () => { throw refused } })
    await expect(store.save(doc())).rejects.toBe(refused)
    expect(await readdir(join(dir, 'world'))).toEqual([])
  })

  it('a read error other than a missing file is not swallowed: the caller gets a fixed, path-free error and the log the raw one (F-R11)', async () => {
    const lines: string[] = []
    const store = createWorldStore(dir, { log: (m) => lines.push(m) })
    await mkdir(join(dir, 'world', 'demo.json'), { recursive: true })
    const err = await store.load('demo').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(WorldReadError)
    expect(err).toMatchObject({ name: 'WorldReadError', code: 'WORLD_READ_FAILED', message: "Lumopolis couldn't read this world's saved map. Try again in a moment." })
    const shown = `${String(err)} ${(err as Error).message}`
    expect(shown).not.toContain(dir)
    expect(shown).not.toContain('demo.json')
    expect(shown).not.toMatch(/E[A-Z]{3,}/)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[world store\] the stored world demo\.json could not be read: Error: E[A-Z]+/)
    // the file is left where it is
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
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

  it('a newer world, and this version\'s own copy of it, are shown with the new words too (review M-8)', async () => {
    const store = createWorldStore(dir)
    await mkdir(join(dir, 'world'), { recursive: true })
    const text = JSON.stringify({ ...portWorld(), version: 2 })
    await writeFile(file(), text)
    const shown = await store.load('demo')
    expect([shown?.savedByNewer, shown?.buildings[0].techLabel, shown?.edges[0].tech]).toEqual([true, 'Message port', ['Message port']])
    await store.save({ ...portWorld(), generatedAt: 5, savedByNewer: true })
    const own = await store.load('demo')
    expect([own?.generatedAt, own?.savedByNewer, own?.buildings[0].techLabel, own?.edges[0].tech]).toEqual([5, true, 'Message port', ['Message port']])
    expect(await readFile(file(), 'utf8')).toBe(text)
  })

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

  it("a world a newer Termpolis saved is refused in the signed-off words, which the pane's note shares (copy row B7)", () => {
    expect(WORLD_SAVED_BY_NEWER).toBe('This world was saved by a newer Termpolis, so this version shows a copy and leaves the saved one as it is. Update Termpolis to save changes to it.')
    expect(new WorldSavedByNewerError().message).toBe(WORLD_SAVED_BY_NEWER)
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

  it('a save whose look at the file fails for another reason refuses with the fixed error, writes nothing, and is not remembered (M1)', async () => {
    const lines: string[] = []
    const store = createWorldStore(dir, { sleep: async () => undefined, log: (m) => lines.push(m) })
    await mkdir(file(), { recursive: true })
    await writeFile(join(file(), 'keep'), 'x')
    const err = await store.save(doc()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorldReadError)
    expect((err as WorldReadError).message).toBe(WORLD_READ_FAILED)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[world store\] the stored world demo\.json could not be read before a save: Error: EISDIR/)
    expect(await readdir(file())).toEqual(['keep'])
    await rm(file(), { recursive: true })
    await store.save(doc())
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(doc())
  })

  it('a newer world held by another program through every retry is never saved over (M1)', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    const text = JSON.stringify(newer())
    await writeFile(file(), text)
    const held = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
    const store = createWorldStore(dir, { sleep: async () => undefined, log: () => undefined, readFile: (async () => { throw held }) as never })
    await expect(store.save(doc())).rejects.toBeInstanceOf(WorldReadError)
    expect(await readFile(file(), 'utf8')).toBe(text)
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

describe('a save looks at the file again just before it puts its copy in place (DSN Round 1, item 4)', () => {
  const file = (): string => join(dir, 'world', 'demo.json')

  it('a newer world written after the last load is not written over: the doc is marked and the temp file removed', async () => {
    const store = createWorldStore(dir)
    await store.save(doc())
    const text = JSON.stringify({ ...doc(), version: 2, generatedAt: 9 })
    await writeFile(file(), text)
    const mine = { ...doc(), generatedAt: 3 }
    await store.save(mine)
    expect(mine.savedByNewer).toBe(true)
    expect(await readFile(file(), 'utf8')).toBe(text)
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
    // From then on the store knows: the file stays the newer one's, and it is what a load shows (DSN R2, F2: the refused
    // copy is not kept in memory, so no change this version could not save turns up later in the session).
    expect(await store.load('demo')).toMatchObject({ generatedAt: 9, savedByNewer: true })
    await store.save({ ...doc(), generatedAt: 4 })
    expect(await readFile(file(), 'utf8')).toBe(text)
  })

  it('a file that cannot be read just before the rename is not written over, and the save is refused', async () => {
    let fail = false
    const log = vi.fn()
    const store = createWorldStore(dir, {
      sleep: async () => undefined, log,
      readFile: (async (f: string, enc: 'utf8') => { if (fail) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return readFile(f, enc) }) as never
    })
    await store.save(doc())
    const before = await readFile(file(), 'utf8')
    // Changed since the save (DSN R2, F4: an unchanged file is not read again).
    const later = new Date(Date.now() + 60_000)
    await utimes(file(), later, later)
    fail = true
    await expect(store.save({ ...doc(), generatedAt: 5 })).rejects.toBeInstanceOf(WorldReadError)
    expect(await readFile(file(), 'utf8')).toBe(before)
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not be read before a save'))
    // Refused, it forgets what the disk held: the next save loads first, and with the file readable again it writes.
    fail = false
    await store.save({ ...doc(), generatedAt: 6 })
    expect(JSON.parse(await readFile(file(), 'utf8')).generatedAt).toBe(6)
  })

  it('a file removed since the last load is written again', async () => {
    const store = createWorldStore(dir)
    await store.save(doc())
    await rm(file())
    await store.save({ ...doc(), generatedAt: 7 })
    expect(JSON.parse(await readFile(file(), 'utf8')).generatedAt).toBe(7)
  })

  describe('only a file changed since this store last read or wrote it is read again (DSN R2, F4)', () => {
    /** Each read of the world file. */
    const counting = (reads: string[]) => (async (f: string, enc: 'utf8') => { reads.push(f); return readFile(f, enc) }) as never
    const newer = (): string => JSON.stringify({ ...doc(), version: 99 })

    it('a recompile of a project world whose file is unchanged reads nothing', async () => {
      const reads: string[] = []
      const store = createWorldStore(dir, { readFile: counting(reads) })
      await store.save(doc())
      reads.length = 0
      await store.save({ ...doc(), generatedAt: 2 })
      await store.save({ ...doc(), generatedAt: 3 })
      expect(reads.filter((f) => f === file())).toEqual([])
      expect(JSON.parse(await readFile(file(), 'utf8')).generatedAt).toBe(3)
      // Nor after a load: the load saw the file as it is.
      expect(await store.load('demo')).toMatchObject({ generatedAt: 3 })
      reads.length = 0
      await store.save({ ...doc(), generatedAt: 4 })
      expect(reads).toEqual([])
      // A file another writer changed is what a load then sees: the save after that load reads nothing more either.
      await writeFile(file(), JSON.stringify({ ...doc(), generatedAt: 12345 }))
      expect(await store.load('demo')).toMatchObject({ generatedAt: 12345 })
      reads.length = 0
      await store.save({ ...doc(), generatedAt: 6 })
      expect(reads).toEqual([])
      expect(JSON.parse(await readFile(file(), 'utf8')).generatedAt).toBe(6)
    })

    it('a changed modified time is read, and a newer world there is kept', async () => {
      // Every size the same, so only the time tells.
      const store = createWorldStore(dir, { stat: (async (f: string) => ({ size: 0, mtimeMs: (await stat(f)).mtimeMs })) as never })
      await store.save(doc())
      await writeFile(file(), newer())
      const later = new Date(Date.now() + 60_000)
      await utimes(file(), later, later)
      const mine = { ...doc(), generatedAt: 5 }
      await store.save(mine)
      expect(mine.savedByNewer).toBe(true)
      expect(await readFile(file(), 'utf8')).toBe(newer())
    })

    it('a changed size is read though the modified time is the same, and a newer world there is kept', async () => {
      const store = createWorldStore(dir, { stat: (async (f: string) => ({ size: (await stat(f)).size, mtimeMs: 0 })) as never })
      await store.save(doc())
      await writeFile(file(), newer())
      const mine = { ...doc(), generatedAt: 5 }
      await store.save(mine)
      expect(mine.savedByNewer).toBe(true)
      expect(await readFile(file(), 'utf8')).toBe(newer())
    })

    it('a file whose details cannot be looked up is read, and a newer world there is kept', async () => {
      let fail = false
      const store = createWorldStore(dir, { stat: (async (f: string) => { if (fail && f === file()) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return stat(f) }) as never })
      await store.save(doc())
      fail = true
      await writeFile(file(), newer())
      const mine = { ...doc(), generatedAt: 5 }
      await store.save(mine)
      expect(mine.savedByNewer).toBe(true)
      expect(await readFile(file(), 'utf8')).toBe(newer())
    })

    it('a temp copy whose details cannot be looked up leaves the next save to read the file', async () => {
      const reads: string[] = []
      const store = createWorldStore(dir, { readFile: counting(reads), stat: (async (f: string) => { if (f.endsWith('.tmp')) throw new Error('EPERM'); return stat(f) }) as never })
      await store.save(doc())
      reads.length = 0
      await store.save({ ...doc(), generatedAt: 2 })
      expect(reads).toEqual([file()])
    })
  })
})
