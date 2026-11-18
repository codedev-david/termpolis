import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FORBIDDEN_FOLDER,
  confinedReader,
  folderKey,
  forbiddenFolder,
  forbiddenFolderReal,
  isCloneRoot,
  isFolderEmpty,
  isInside,
  isProjectFolder,
  type DirLike,
  type NamedDirLike
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

describe('forbiddenFolderReal', () => {
  it('a junction to the home folder is the home folder', async () => {
    const home = join(dir, 'home')
    await mkdir(join(home, 'code'), { recursive: true })
    const link = join(dir, 'link')
    await symlink(home, link, 'junction')
    expect(await forbiddenFolderReal(link, { home })).toBe(FORBIDDEN_FOLDER)
    // A project inside the home, reached through the link, stays allowed, as it is when named directly.
    expect(await forbiddenFolderReal(join(link, 'code'), { home })).toBeNull()
    expect(await forbiddenFolderReal(join(dir, 'nowhere'), { home })).toBeNull() // unresolvable: judged as written
  })

  it('resolves 8.3 short names, and the home and data folders too', async () => {
    const names: Record<string, string> = { 'C:/USERS~1/ME': 'C:/Users/me', 'C:/home-link': 'D:/me', 'C:/ud-link': 'D:/ud' }
    const real = vi.fn(async (p: string) => {
      if (p in names) return names[p]
      throw new Error('ENOENT')
    })
    expect(await forbiddenFolderReal('C:/USERS~1/ME', { home: 'C:/Users/me', isWindows: true }, real)).toBe(FORBIDDEN_FOLDER)
    expect(await forbiddenFolderReal('D:/me', { home: 'C:/home-link', isWindows: true }, real)).toBe(FORBIDDEN_FOLDER)
    expect(await forbiddenFolderReal('D:/ud/world', { home: 'C:/Users/me', userData: 'C:/ud-link', isWindows: true }, real)).toBe(FORBIDDEN_FOLDER)
    expect(await forbiddenFolderReal('D:/code/shop', { home: 'C:/home-link', userData: 'C:/ud-link', isWindows: true }, real)).toBeNull()
    // A refusal on the path as written needs no file system at all.
    real.mockClear()
    expect(await forbiddenFolderReal('C:/Users/me', { home: 'C:/Users/me', isWindows: true }, real)).toBe(FORBIDDEN_FOLDER)
    expect(real).not.toHaveBeenCalled()
  })
})

describe('isProjectFolder', () => {
  it('finds a project marker; a plain, empty or missing folder is not a project', async () => {
    const make = async (name: string, entry?: [string, 'file' | 'dir']): Promise<string> => {
      const p = join(dir, name)
      await mkdir(p)
      if (entry?.[1] === 'file') await writeFile(join(p, entry[0]), '')
      if (entry?.[1] === 'dir') await mkdir(join(p, entry[0]))
      return p
    }
    expect(await isProjectFolder(await make('node', ['package.json', 'file']))).toBe(true)
    expect(await isProjectFolder(await make('repo', ['.git', 'dir']))).toBe(true)
    expect(await isProjectFolder(await make('dotnet', ['Shop.SLN', 'file']))).toBe(true)
    expect(await isProjectFolder(await make('photos', ['cat.jpg', 'file']))).toBe(false)
    expect(await isProjectFolder(await make('empty'))).toBe(false)
    expect(await isProjectFolder(join(dir, 'missing'))).toBe(false)
  })

  it('reads at most the limit, treats a failed read as no project, and always closes', async () => {
    type Closable = NamedDirLike & { close: ReturnType<typeof vi.fn> }
    const dirOf = (names: string[], over: Partial<NamedDirLike> = {}): Closable => {
      let i = 0
      return { read: async () => (i < names.length ? { name: names[i++] } : null), close: vi.fn(async () => undefined), ...over } as Closable
    }
    const late = dirOf(['a', 'b', 'go.mod'])
    expect(await isProjectFolder('/x', async () => late, 2)).toBe(false)
    expect(late.close).toHaveBeenCalledTimes(1)
    expect(await isProjectFolder('/x', async () => dirOf(['a', 'b', 'go.mod']), 3)).toBe(true)
    const broken = dirOf([], { read: async () => { throw new Error('EIO') }, close: vi.fn(async () => { throw new Error('gone') }) })
    expect(await isProjectFolder('/x', async () => broken)).toBe(false)
    expect(broken.close).toHaveBeenCalledTimes(1)
  })
})
