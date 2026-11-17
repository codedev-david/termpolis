import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FORBIDDEN_FOLDER,
  confinedReader,
  folderKey,
  forbiddenFolder,
  isCloneRoot,
  isFolderEmpty,
  isInside,
  type DirLike
} from '../../src/main/world/folderSafety'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'world-folder-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('folderKey and isInside', () => {
  it('lowercases only where the file system ignores case', () => {
    const p = join(dir, 'Shop')
    expect(folderKey(p, true)).toBe(folderKey(p, false).toLowerCase())
    expect(folderKey(p, false)).toBe(p)
    expect(folderKey(p)).toBe(process.platform === 'win32' ? p.toLowerCase() : p)
  })

  it('is true for the folder itself and anything below it, false for a sibling, a parent or a look-alike prefix', () => {
    const a = join(dir, 'a')
    expect(isInside(a, a)).toBe(true)
    expect(isInside(a, join(a, 'b', 'c'))).toBe(true)
    expect(isInside(a, join(a, '..b'))).toBe(true)
    expect(isInside(a, join(dir, 'ab'))).toBe(false)
    expect(isInside(a, dir)).toBe(false)
    expect(isInside(a, join(dir, 'b'))).toBe(false)
    expect(isInside(join(dir, 'A'), join(dir, 'a', 'x'), true)).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('keeps case where the file system does', () => {
    expect(isInside(join(dir, 'A'), join(dir, 'a', 'x'), false)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('a folder on another drive is never inside', () => {
    expect(isInside('C:\\a', 'D:\\a')).toBe(false)
  })
})

describe('isCloneRoot', () => {
  it('is a folder under <userData>/world/repos, never the repos folder itself or anything else', () => {
    const ud = join(dir, 'ud')
    expect(isCloneRoot(ud, join(ud, 'world', 'repos', 'abc'))).toBe(true)
    expect(isCloneRoot(ud, join(ud, 'world', 'repos'))).toBe(false)
    expect(isCloneRoot(ud, join(ud, 'world'))).toBe(false)
    expect(isCloneRoot(ud, join(dir, 'code'))).toBe(false)
    expect(isCloneRoot(ud, join(ud, 'World', 'Repos', 'abc'), true)).toBe(true)
  })
})

describe('forbiddenFolder', () => {
  const home = (): string => join(dir, 'home', 'me')
  const ud = (): string => join(dir, 'ud')

  it('refuses a drive or file-system root', () => {
    expect(forbiddenFolder(parse(dir).root, { home: home() })).toBe(FORBIDDEN_FOLDER)
  })

  it('refuses the home folder and every folder above it, in any case on Windows', () => {
    expect(forbiddenFolder(home(), { home: home() })).toBe(FORBIDDEN_FOLDER)
    expect(forbiddenFolder(join(dir, 'home'), { home: home() })).toBe(FORBIDDEN_FOLDER)
    expect(forbiddenFolder(dir, { home: home() })).toBe(FORBIDDEN_FOLDER)
    expect(forbiddenFolder(join(dir, 'HOME', 'ME'), { home: home(), isWindows: true })).toBe(FORBIDDEN_FOLDER)
  })

  it('refuses Termpolis data and anything in it, only when the data folder is known', () => {
    expect(forbiddenFolder(ud(), { home: home(), userData: ud() })).toBe(FORBIDDEN_FOLDER)
    expect(forbiddenFolder(join(ud(), 'world', 'repos', 'abc'), { home: home(), userData: ud() })).toBe(FORBIDDEN_FOLDER)
    expect(forbiddenFolder(join(ud(), 'world'), { home: home() })).toBeNull()
  })

  it('allows a project folder inside the home or elsewhere', () => {
    expect(forbiddenFolder(join(home(), 'code', 'shop'), { home: home(), userData: ud() })).toBeNull()
    expect(forbiddenFolder(join(dir, 'work', 'shop'), { home: home(), userData: ud() })).toBeNull()
  })
})

describe('isFolderEmpty', () => {
  it('reads a real folder: empty, then not', async () => {
    expect(await isFolderEmpty(dir)).toBe(true)
    await writeFile(join(dir, 'a.txt'), 'x')
    expect(await isFolderEmpty(dir)).toBe(false)
  })

  it('reads one entry at most and always closes, even when closing fails', async () => {
    const read = vi.fn(async () => ({ name: 'a' }))
    const close = vi.fn(async () => { throw new Error('EBADF') })
    const open = vi.fn(async (): Promise<DirLike> => ({ read, close }))
    expect(await isFolderEmpty('/x', open)).toBe(false)
    expect(open).toHaveBeenCalledWith('/x')
    expect(read).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a read that fails still closes and rejects; a folder that cannot be opened rejects', async () => {
    const close = vi.fn(async () => undefined)
    const failing = async (): Promise<DirLike> => ({ read: async () => { throw new Error('EIO') }, close })
    await expect(isFolderEmpty('/x', failing)).rejects.toThrow('EIO')
    expect(close).toHaveBeenCalledTimes(1)
    await expect(isFolderEmpty(join(dir, 'missing'))).rejects.toThrow()
  })
})

describe('confinedReader', () => {
  it('reads a file inside the folder through its real path, and resolves the folder once', async () => {
    const root = join(dir, 'repo')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'A')
    const real = vi.fn(async (p: string) => p)
    const read = vi.fn(async (p: string) => `read:${p}`)
    const r = confinedReader(root, read, real)
    expect(await r(join(root, 'src', 'a.ts'))).toBe(`read:${join(root, 'src', 'a.ts')}`)
    await r(join(root, 'b.ts'))
    expect(real.mock.calls.filter(([p]) => p === root)).toHaveLength(1)
  })

  it('refuses a file whose real path leaves the folder (a committed link), without reading it', async () => {
    const root = join(dir, 'repo')
    const read = vi.fn(async () => 'secret')
    const linkTo = join(dir, 'elsewhere', 'x')
    const r = confinedReader(root, read, async (p) => (p.endsWith('link.ts') ? linkTo : p))
    await expect(r(join(root, 'link.ts'))).rejects.toThrow('outside the folder')
    await expect(r(join(root, '..', 'x'))).rejects.toThrow('outside the folder')
    expect(read).not.toHaveBeenCalled()
  })

  it('with the real file system: a missing file rejects, and a real link out of the folder is refused', async () => {
    const root = join(dir, 'repo')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'a.ts'), 'A')
    await writeFile(join(dir, 'outside.ts'), 'O')
    const read = vi.fn(async (p: string) => p)
    const r = confinedReader(root, read)
    expect(await r(join(root, 'a.ts'))).toMatch(/a\.ts$/)
    await expect(r(join(root, 'missing.ts'))).rejects.toThrow()
    let linked = true
    try {
      await symlink(join(dir, 'outside.ts'), join(root, 'link.ts'), 'file')
    } catch {
      linked = false // Windows without developer mode cannot make file links; the injected test covers it
    }
    if (linked) await expect(r(join(root, 'link.ts'))).rejects.toThrow('outside the folder')
  })
})
