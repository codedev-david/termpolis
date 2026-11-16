import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { graphKeyForRoot } from '../../src/main/codeGraph'
import { createSourceRegistry, keyForSource, type WorldSource } from '../../src/main/world/sources'
import { worldFileName } from '../../src/main/world/worldStore'
import * as fsp from 'node:fs/promises'

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
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

  it('corrupt sources.json → empty list + .bad backup', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(sourcesFile(), '{not json')
    const r = reg()
    expect(await r.list()).toEqual([])
    expect(await readdir(join(dir, 'world'))).toContain('sources.json.bad')
    await writeFile(sourcesFile(), JSON.stringify([{ key: 1 }]))
    expect(await r.list()).toEqual([])
    await writeFile(sourcesFile(), '"str"')
    expect(await r.list()).toEqual([])
  })

  it('rejects entries with a bad source shape', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    const base = { key: 'k', title: 't', lastOpened: 1 }
    const bad = [null, 'x', { kind: 'nope' }, { kind: 'project', root: 1 }, { kind: 'git', url: 'u', root: 'r', ref: 3 }, { kind: 'design', id: 'i', title: 1 }]
    for (const source of bad) {
      await writeFile(sourcesFile(), JSON.stringify([{ ...base, source }]))
      expect(await reg().list()).toEqual([])
    }
    await writeFile(sourcesFile(), JSON.stringify([null]))
    expect(await reg().list()).toEqual([])
  })

  it('a bad backup rename still reads as empty; other read errors throw', async () => {
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(sourcesFile(), 'x')
    await mkdir(`${sourcesFile()}.bad`)
    await writeFile(join(`${sourcesFile()}.bad`, 'f'), '1')
    expect(await reg().list()).toEqual([])
    await rm(sourcesFile(), { force: true })
    await mkdir(sourcesFile())
    await expect(reg().list()).rejects.toThrow()
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
