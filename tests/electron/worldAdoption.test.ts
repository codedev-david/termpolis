import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorldDoc } from '../../src/shared/world/types'
import { adoptWorldAliases, type WorldAdoptionDeps } from '../../src/main/world/worldAdoption'
import { createSourceRegistry, keyForSource, type WorldEntry, type WorldSource } from '../../src/main/world/sources'
import { createWorldStore, worldFileName } from '../../src/main/world/worldStore'

// WP5 (X02): on Linux a world's key now keeps its folder's case; the world saved under the old, lowercased key and its
// recent-list line follow it the first time it opens, copied and never moved.

const NEW = 'k-new'
const OLD = 'k-old'
const doc = (projectKey: string, extra: Partial<WorldDoc> = {}): WorldDoc =>
  ({ projectKey, title: 'Repo', items: [], edges: [], ...extra }) as unknown as WorldDoc
const entry = (key: string, source: WorldSource, title = 'Repo', lastOpened = 1): WorldEntry => ({ key, source, title, lastOpened })

function fakes(over: { docs?: Record<string, WorldDoc>; entries?: WorldEntry[] } = {}) {
  const docs: Record<string, WorldDoc> = { ...(over.docs ?? {}) }
  let entries = [...(over.entries ?? [])]
  const deps = {
    store: {
      load: vi.fn(async (k: string) => docs[k] ?? null),
      save: vi.fn(async (d: WorldDoc) => { docs[d.projectKey] = d }),
    },
    hasWorld: vi.fn(async (k: string) => k in docs),
    registry: {
      list: vi.fn(async () => entries),
      upsert: vi.fn(async (s: WorldSource, title?: string) => {
        const e = entry(NEW, s, title ?? 'x', 99)
        entries = [...entries.filter((x) => x.key !== NEW), e]
        return e
      }),
      remove: vi.fn(async (k: string) => { entries = entries.filter((x) => x.key !== k) }),
    },
    keyOf: vi.fn((s: WorldSource) => (s.kind === 'design' ? `design:${s.id}` : s.root === '/home/me/Repo' ? NEW : 'k-elsewhere')),
  } satisfies WorldAdoptionDeps
  return { deps, docs, entries: () => entries }
}

const folder: WorldSource = { kind: 'folder', root: '/home/me/Repo' }

describe('adoptWorldAliases', () => {
  it('copies the world saved under the older key to the new key, and leaves the older one where it was', async () => {
    const { deps, docs } = fakes({ docs: { [OLD]: doc(OLD, { title: 'Hand title' } as Partial<WorldDoc>) } })
    expect(await adoptWorldAliases(NEW, ['', NEW, OLD, OLD], deps)).toEqual({ world: OLD, entries: [] })
    expect(docs[NEW]).toEqual(doc(NEW, { title: 'Hand title' } as Partial<WorldDoc>))
    expect(docs[OLD].projectKey).toBe(OLD)
  })

  it('takes the first older key that has a world, skipping one that cannot be read', async () => {
    const { deps, docs } = fakes({ docs: { second: doc('second') } })
    deps.store.load.mockImplementation(async (k: string) => {
      if (k === 'broken') throw new Error('EACCES')
      return docs[k] ?? null
    })
    expect((await adoptWorldAliases(NEW, ['none', 'broken', 'second', 'third'], deps)).world).toBe('second')
    expect(docs[NEW].projectKey).toBe(NEW)
  })

  it('never overwrites a world the new key already has, even one saved while it read', async () => {
    const first = fakes({ docs: { [NEW]: doc(NEW, { title: 'newer' } as Partial<WorldDoc>), [OLD]: doc(OLD) } })
    expect(await adoptWorldAliases(NEW, [OLD], first.deps)).toEqual({ entries: [] })
    expect(first.deps.store.load).not.toHaveBeenCalled()
    expect(first.deps.store.save).not.toHaveBeenCalled()

    const raced = fakes({ docs: { [OLD]: doc(OLD) } })
    raced.deps.hasWorld.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    expect(await adoptWorldAliases(NEW, [OLD], raced.deps)).toEqual({ entries: [] })
    expect(raced.deps.store.save).not.toHaveBeenCalled()
  })

  it('does nothing without a key or an older key, and never throws when a write fails', async () => {
    const { deps } = fakes({ docs: { [OLD]: doc(OLD) } })
    expect(await adoptWorldAliases('', [OLD], deps)).toEqual({ entries: [] })
    expect(await adoptWorldAliases(NEW, [NEW, ''], deps)).toEqual({ entries: [] })
    expect(deps.hasWorld).not.toHaveBeenCalled()
    deps.store.save.mockRejectedValueOnce(new Error('ENOSPC'))
    deps.registry.list.mockRejectedValueOnce(new Error('EACCES'))
    expect(await adoptWorldAliases(NEW, [OLD], deps)).toEqual({ entries: [] })
  })

  it('moves the recent-list line of this folder from the older key to the new one, keeping its title', async () => {
    const design: WorldSource = { kind: 'design', id: 'd1', title: 'Shop' }
    const { deps, entries } = fakes({
      entries: [
        entry(OLD, folder, 'My repo'),
        entry('k-old-2', { kind: 'folder', root: '/home/me/repo' }, 'Lower twin'), // another folder: stays
        entry('design:d1', design, 'Shop'),
        entry('k-other', { kind: 'folder', root: '/home/me/Repo' }), // not an older key of this root: stays
      ],
    })
    deps.keyOf.mockImplementation((s: WorldSource) => (s.kind === 'design' ? 'design:d1' : s.root === '/home/me/Repo' ? NEW : 'k-old-2'))
    const got = await adoptWorldAliases(NEW, [OLD, 'k-old-2', 'design:d1'], deps)
    expect(got.entries).toEqual([OLD])
    expect(deps.registry.upsert).toHaveBeenCalledWith(folder, 'My repo')
    expect(entries().map((e) => e.key).sort()).toEqual(['design:d1', 'k-old-2', 'k-other', NEW].sort())
  })

  it('only removes the older line when the new key has its own already, and upserts once for two older lines', async () => {
    const has = fakes({ entries: [entry(NEW, folder, 'Newer'), entry(OLD, folder, 'Older')] })
    expect((await adoptWorldAliases(NEW, [OLD], has.deps)).entries).toEqual([OLD])
    expect(has.deps.registry.upsert).not.toHaveBeenCalled()
    expect(has.entries().map((e) => e.title)).toEqual(['Newer'])

    const two = fakes({ entries: [entry(OLD, folder, 'A'), entry('k-old-b', folder, 'B')] })
    expect((await adoptWorldAliases(NEW, [OLD, 'k-old-b'], two.deps)).entries).toEqual([OLD, 'k-old-b'])
    expect(two.deps.registry.upsert).toHaveBeenCalledTimes(1)
    expect(two.entries().map((e) => e.title)).toEqual(['A'])
  })

  it('works on the real world store and source registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'world-adopt-'))
    try {
      const store = createWorldStore(dir)
      const registry = createSourceRegistry(dir, { exists: async () => true, now: () => 5 })
      const root = join(dir, 'Repo')
      const real: WorldSource = { kind: 'folder', root }
      const newKey = keyForSource(real)
      const oldKey = 'key-from-an-older-build'
      // The recent list and the world as an older build left them, under its key for this folder.
      await mkdir(join(dir, 'world'), { recursive: true })
      await writeFile(join(dir, 'world', 'sources.json'), JSON.stringify([entry(oldKey, real, 'Saved title')]))
      await store.save(doc(oldKey))
      const loadAny = async (k: string): Promise<WorldDoc | null> =>
        readFile(join(dir, 'world', worldFileName(k)), 'utf8').then((t) => JSON.parse(t) as WorldDoc, () => null)
      const deps: WorldAdoptionDeps = {
        store: { load: loadAny, save: (d) => store.save(d) },
        hasWorld: async (k) => (await readdir(join(dir, 'world'))).includes(worldFileName(k)),
        registry,
        keyOf: keyForSource,
      }
      expect(await adoptWorldAliases(newKey, [oldKey], deps)).toEqual({ world: oldKey, entries: [oldKey] })
      expect((await loadAny(newKey))?.projectKey).toBe(newKey)
      expect((await loadAny(oldKey))?.projectKey).toBe(oldKey)
      expect((await registry.list()).map((e) => [e.key, e.title])).toEqual([[newKey, 'Saved title']])
      // Every open after the first finds nothing left to do.
      expect(await adoptWorldAliases(newKey, [oldKey], deps)).toEqual({ entries: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
