import { symlinkSync, type Dirent } from 'node:fs'
import { mkdir, mkdtemp, opendir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WALK_ENTRY_LIMIT, WALK_FILE_CAP, WALK_SKIP_DIRS, walkFolder } from '../../src/main/world/folderWalk'
import { MAP_FILE_CAP, SKIP_DIRS } from '../../src/main/repoFileList'
import { parseRootIgnore } from '../../src/main/world/rootIgnore'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'world-walk-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const put = async (rel: string, text = 'x\n'): Promise<void> => {
  const parts = rel.split('/')
  await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true })
  await writeFile(join(dir, ...parts), text)
}
const all = (): boolean => true
const fileEnt = (name: string): Dirent => ({ name, isDirectory: () => false, isFile: () => true }) as unknown as Dirent

describe('folderWalk: the files of a folder outside git', () => {
  it('caps at the map cap (20,000 files), reads at most 200,000 entries, and skips the skip folders', () => {
    expect(WALK_FILE_CAP).toBe(20_000)
    expect(WALK_FILE_CAP).toBe(MAP_FILE_CAP)
    expect(WALK_ENTRY_LIMIT).toBe(200_000)
    expect(WALK_SKIP_DIRS).toBe(SKIP_DIRS)
    expect([...WALK_SKIP_DIRS].sort()).toEqual(
      ['.git', '.hg', '.next', '.svn', '.tox', '.venv', '__pycache__', 'bower_components', 'build', 'coverage', 'dist', 'node_modules', 'obj', 'out', 'target', 'vendor', 'venv'].sort()
    )
  })

  it('lists files breadth first, sorted, `/` separated, keeping only what keep accepts', async () => {
    await put('b.ts')
    await put('a.ts')
    await put('notes.md')
    await put('src/deep/z.ts')
    await put('src/y.ts')
    await put('node_modules/pkg/index.js')
    await put('.venv/lib/site.py')
    await put('src/__pycache__/m.py')
    await put('target/release/main.rs')
    await put('.tox/py311/lib/t.py')
    await put('app/obj/Debug/x.cs')
    expect(await walkFolder(dir, { keep: (rel) => !rel.endsWith('.md') })).toEqual({
      files: ['a.ts', 'b.ts', 'src/y.ts', 'src/deep/z.ts'],
      capped: false,
      unreadable: []
    })
  })

  it('skips a virtual environment by its pyvenv.cfg, whatever its name; a source folder called env stays', async () => {
    await put('env/pyvenv.cfg', 'home = /usr/bin\n')
    await put('env/lib/site.py')
    await put('tools/py311/pyvenv.cfg', 'home = /usr/bin\n')
    await put('tools/py311/lib/x.py')
    await put('src/env/config.ts')
    await put('main.py')
    expect((await walkFolder(dir, { keep: (rel) => !rel.endsWith('.cfg') })).files).toEqual(['main.py', 'src/env/config.ts'])
    // The folder mapped is itself a virtual environment: it is walked, as asked.
    await put('pyvenv.cfg', 'home = /usr/bin\n')
    expect((await walkFolder(dir, { keep: (rel) => !rel.endsWith('.cfg') })).files).toEqual(['main.py', 'src/env/config.ts'])
  })

  it('leaves out what the ignored matcher (the root .gitignore) names, folders and files', async () => {
    await put('a.ts')
    await put('gen/out.ts')
    await put('src/b.ts')
    await put('src/b.generated.ts')
    const ignored = parseRootIgnore('gen/\n*.generated.ts\n')
    expect((await walkFolder(dir, { keep: all, ignored })).files).toEqual(['a.ts', 'src/b.ts'])
  })

  it('sets apart file names it cannot read (U+FFFD) that keep accepts, and never enters such a folder', async () => {
    await put('a.ts')
    await put('src/q�.ts')
    await put('src/n�.md')
    await put('bad�/inner.ts')
    expect(await walkFolder(dir, { keep: (rel) => rel.endsWith('.ts') })).toEqual({ files: ['a.ts'], capped: false, unreadable: ['src/q�.ts'] })
  })

  it('stops at the cap and says so; exactly the cap is not capped', async () => {
    for (const n of ['a', 'b', 'c']) await put(`${n}.ts`)
    expect(await walkFolder(dir, { keep: all, cap: 2 })).toEqual({ files: ['a.ts', 'b.ts'], capped: true, unreadable: [] })
    expect(await walkFolder(dir, { keep: all, cap: 3 })).toEqual({ files: ['a.ts', 'b.ts', 'c.ts'], capped: false, unreadable: [] })
    // Files keep refuses do not count toward the cap.
    expect(await walkFolder(dir, { keep: (rel) => rel !== 'a.ts', cap: 2 })).toEqual({ files: ['b.ts', 'c.ts'], capped: false, unreadable: [] })
  })

  it('stops after the entry limit, as capped, so a folder of millions of entries ends: it keeps the first entries the folder lists, sorted', async () => {
    // The folder is streamed, so the entries inside the limit are the first ones the file system hands back: sorted on
    // NTFS, hash or creation order on ext4 and APFS. Scripted here in an unsorted order...
    const listed = ['d.ts', 'b.ts', 'c.ts', 'a.ts']
    async function* inOrder(): AsyncGenerator<Dirent> {
      for (const n of listed) yield fileEnt(n)
    }
    expect(await walkFolder(dir, { keep: all, entryLimit: 2, opendir: async () => inOrder() })).toEqual({ files: ['b.ts', 'd.ts'], capped: true, unreadable: [] })
    // ...and on the real disk, in whatever order this file system lists the folder.
    for (const n of ['a', 'b', 'c', 'd']) await put(`${n}.ts`)
    const osOrder: string[] = []
    for await (const ent of await opendir(dir)) osOrder.push(ent.name)
    expect(await walkFolder(dir, { keep: all, entryLimit: 2 })).toEqual({ files: osOrder.slice(0, 2).sort(), capped: true, unreadable: [] })
  })

  it('streams a folder: past the entry limit it reads no further entry of it', async () => {
    let pulled = 0
    async function* endless(): AsyncGenerator<Dirent> {
      for (;;) yield fileEnt(`f${String(++pulled).padStart(9, '0')}.ts`)
    }
    const got = await walkFolder(dir, { keep: all, entryLimit: 5, opendir: async () => endless() })
    expect(got.capped).toBe(true)
    expect(got.files).toEqual(['f000000001.ts', 'f000000002.ts', 'f000000003.ts', 'f000000004.ts', 'f000000005.ts'])
    expect(pulled).toBe(6)
  })

  it('does not follow links; an unreadable folder lists nothing, and one that fails midway keeps what it read', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'world-walk-out-'))
    try {
      await writeFile(join(outside, 'evil.ts'), 'x\n')
      await put('src/a.ts')
      symlinkSync(outside, join(dir, 'link'), 'junction')
      const listing = await walkFolder(dir, { keep: all })
      expect(listing).toEqual({ files: ['src/a.ts'], capped: false, unreadable: [] })
      const failing = async (d: string): Promise<AsyncIterable<Dirent>> => {
        if (d.endsWith('src')) throw new Error('EACCES')
        return opendir(d)
      }
      expect(await walkFolder(dir, { keep: all, opendir: failing })).toEqual({ files: [], capped: false, unreadable: [] })
      expect(await walkFolder(join(dir, 'missing'), { keep: all })).toEqual({ files: [], capped: false, unreadable: [] })
      async function* breaks(): AsyncGenerator<Dirent> {
        yield fileEnt('first.ts')
        throw new Error('EIO')
      }
      expect(await walkFolder(dir, { keep: all, opendir: async () => breaks() })).toEqual({ files: ['first.ts'], capped: false, unreadable: [] })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
