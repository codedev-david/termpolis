import { symlinkSync, type Dirent } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WALK_ENTRY_LIMIT, WALK_FILE_CAP, WALK_SKIP_DIRS, walkFolder } from '../../src/main/world/folderWalk'

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

describe('folderWalk: the files of a folder outside git', () => {
  it('caps at 20,000 files, reads at most 200,000 entries, and skips the dependency and build folders', () => {
    expect(WALK_FILE_CAP).toBe(20_000)
    expect(WALK_ENTRY_LIMIT).toBe(200_000)
    expect([...WALK_SKIP_DIRS].sort()).toEqual(
      ['.git', '.hg', '.next', '.svn', '.venv', '__pycache__', 'bower_components', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target', 'vendor', 'venv'].sort()
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
    expect(await walkFolder(dir, { keep: (rel) => !rel.endsWith('.md') })).toEqual({
      files: ['a.ts', 'b.ts', 'src/y.ts', 'src/deep/z.ts'],
      capped: false
    })
  })

  it('stops at the cap and says so; exactly the cap is not capped', async () => {
    for (const n of ['a', 'b', 'c']) await put(`${n}.ts`)
    expect(await walkFolder(dir, { keep: all, cap: 2 })).toEqual({ files: ['a.ts', 'b.ts'], capped: true })
    expect(await walkFolder(dir, { keep: all, cap: 3 })).toEqual({ files: ['a.ts', 'b.ts', 'c.ts'], capped: false })
    // Files keep refuses do not count toward the cap.
    expect(await walkFolder(dir, { keep: (rel) => rel !== 'a.ts', cap: 2 })).toEqual({ files: ['b.ts', 'c.ts'], capped: false })
  })

  it('stops after the entry limit, as capped, so a folder of millions of entries ends', async () => {
    for (const n of ['a', 'b', 'c', 'd']) await put(`${n}.ts`)
    expect(await walkFolder(dir, { keep: all, entryLimit: 2 })).toEqual({ files: ['a.ts', 'b.ts'], capped: true })
  })

  it('does not follow links, and an unreadable folder lists nothing', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'world-walk-out-'))
    try {
      await writeFile(join(outside, 'evil.ts'), 'x\n')
      await put('src/a.ts')
      symlinkSync(outside, join(dir, 'link'), 'junction')
      const listing = await walkFolder(dir, { keep: all })
      expect(listing).toEqual({ files: ['src/a.ts'], capped: false })
      const failing = async (d: string): Promise<Dirent[]> => {
        if (d.endsWith('src')) throw new Error('EACCES')
        return readdir(d, { withFileTypes: true })
      }
      expect(await walkFolder(dir, { keep: all, readdir: failing })).toEqual({ files: [], capped: false })
      expect(await walkFolder(join(dir, 'missing'), { keep: all })).toEqual({ files: [], capped: false })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
