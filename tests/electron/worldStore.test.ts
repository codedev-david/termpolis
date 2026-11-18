import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorldDoc } from '../../src/shared/world/types'
import { createWorldStore, worldFileName } from '../../src/main/world/worldStore'

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

  it('corrupt file → load null + .bad backup', async () => {
    const store = createWorldStore(dir)
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'demo.json'), '{ not json')
    await writeFile(join(dir, 'world', 'demo.json.bad'), 'older bad copy')
    expect(await store.load('demo')).toBeNull()
    expect(await readFile(join(dir, 'world', 'demo.json.bad'), 'utf8')).toBe('{ not json')
    expect(await readdir(join(dir, 'world'))).toEqual(['demo.json.bad'])

    // Valid JSON that fails validateWorld is treated the same way.
    await writeFile(join(dir, 'world', 'demo.json'), JSON.stringify({ ...doc(), version: 2 }))
    expect(await store.load('demo')).toBeNull()
    expect(JSON.parse(await readFile(join(dir, 'world', 'demo.json.bad'), 'utf8')).version).toBe(2)
  })

  it('a corrupt file whose backup cannot be written still loads as null', async () => {
    const store = createWorldStore(dir)
    await mkdir(join(dir, 'world', 'demo.json.bad'), { recursive: true })
    await writeFile(join(dir, 'world', 'demo.json.bad', 'keep'), 'x')
    await writeFile(join(dir, 'world', 'demo.json'), 'garbage')
    expect(await store.load('demo')).toBeNull()
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
    const store = createWorldStore(dir)
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

  it('label cache: an unwritable cache is a quiet miss', async () => {
    // A file where the cache folder should be: mkdir fails, set swallows it, get misses.
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'label-cache'), 'not a folder')
    const store = createWorldStore(dir)
    await expect(store.labelCache.set('k1', 'v')).resolves.toBeUndefined()
    expect(await store.labelCache.get('k1')).toBeNull()
  })
})

describe('worldStore stage cache', () => {
  const cache = {
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
    await writeFile(join(dir, 'world', files[0]), JSON.stringify({ files: [], structureHash: 's' }))
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
