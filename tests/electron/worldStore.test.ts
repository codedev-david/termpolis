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
    districts: [{ id: 'd-a', name: 'a', subtitle: '', hue: 0, members: ['b-a'] }],
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
        members: ['src/a.ts']
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
})
