import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { foldsCase } from '../../src/main/projectKey'
import {
  FORBIDDEN_FOLDER,
  cloneConfinement,
  cloneReader,
  confinedReader,
  confinedTextReader,
  folderKey,
  forbiddenFolder,
  forbiddenFolderReal,
  isCloneRoot,
  isFolderEmpty,
  isInside,
  isProjectFolder,
  realConfinedFs,
  type ConfinedFs,
  type DirLike,
  type FileIdent,
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
    // WP5 X03: the one case rule project keys use (Windows and macOS fold case, Linux keeps it).
    expect(folderKey(p)).toBe(process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p)
    expect(folderKey(p) === p.toLowerCase()).toBe(foldsCase())
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

describe('confinedReader, once the read is done (Codex r4 M3, Opus R3-n1)', () => {
  it('refuses what it read when the real path of the file changed meanwhile (a folder on its path swapped for a link)', async () => {
    const root = join(dir, 'repo')
    const file = join(root, 'a.ts')
    let swapped = false
    const real = async (p: string): Promise<string> => (p === file && swapped ? join(dir, 'elsewhere', 'a.ts') : p)
    const read = vi.fn(async () => { swapped = true; return 'A' })
    await expect(confinedReader(root, read, real)(file)).rejects.toThrow('the file moved while it was read')
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('confinedTextReader', () => {
  const root = (): string => join(dir, 'repo')
  /** A file system where every path is its own real path and every file the same id, unless a test says otherwise. */
  const fakeFs = (over: Partial<ConfinedFs> = {}, handle: { text?: string; id?: FileIdent; close?: () => Promise<void> } = {}) => {
    const close = vi.fn(handle.close ?? (async () => undefined))
    const fs: ConfinedFs = {
      real: vi.fn(async (p: string) => p),
      open: vi.fn(async () => ({ stat: async () => handle.id ?? { dev: 1n, ino: 7n }, readText: async () => handle.text ?? 'TEXT', close })),
      lstat: vi.fn(async () => ({ dev: 1n, ino: 7n })),
      ...over,
    }
    return { fs, close }
  }

  it('reads a file inside the folder through the handle it opened, closes it, and resolves the folder once', async () => {
    const { fs, close } = fakeFs()
    const r = confinedTextReader(root(), fs)
    expect(await r(join(root(), 'a.ts'))).toBe('TEXT')
    expect(await r(join(root(), 'b.ts'))).toBe('TEXT')
    expect(close).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fs.real).mock.calls.filter(([p]) => p === root())).toHaveLength(1)
    expect(fs.lstat).toHaveBeenCalledWith(join(root(), 'a.ts'))
  })

  it('takes ids given as numbers as it takes bigints', async () => {
    const { fs } = fakeFs({ lstat: async () => ({ dev: 1, ino: 7 }) })
    expect(await confinedTextReader(root(), fs)(join(root(), 'a.ts'))).toBe('TEXT')
  })

  it('refuses a file whose real path is outside the folder before it opens it', async () => {
    const { fs } = fakeFs({ real: async (p) => (p.endsWith('link.ts') ? join(dir, 'elsewhere', 'x') : p) })
    await expect(confinedTextReader(root(), fs)(join(root(), 'link.ts'))).rejects.toThrow('outside the folder')
    expect(fs.open).not.toHaveBeenCalled()
  })

  it('refuses one whose real path left the folder once it was opened, and closes it', async () => {
    let calls = 0
    const { fs, close } = fakeFs({ real: async (p) => (p.endsWith('a.ts') && ++calls > 1 ? join(dir, 'elsewhere', 'a.ts') : p) })
    await expect(confinedTextReader(root(), fs)(join(root(), 'a.ts'))).rejects.toThrow('outside the folder')
    expect(fs.open).toHaveBeenCalledTimes(1)
    expect(fs.lstat).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('refuses one when the file at its real path is not the one it holds open: another file id, or another device', async () => {
    for (const id of [{ dev: 1n, ino: 8n }, { dev: 2n, ino: 7n }]) {
      const read = vi.fn(async () => 'TEXT')
      const close = vi.fn(async () => undefined)
      const fs: ConfinedFs = {
        real: async (p) => p,
        open: async () => ({ stat: async () => id, readText: read, close }),
        lstat: async () => ({ dev: 1n, ino: 7n }),
      }
      await expect(confinedTextReader(root(), fs)(join(root(), 'a.ts'))).rejects.toThrow('the file moved while it was opened')
      expect(read).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(1)
    }
  })

  it('a close that fails does not fail the read', async () => {
    const { fs, close } = fakeFs({}, { close: async () => { throw new Error('EIO') } })
    expect(await confinedTextReader(root(), fs)(join(root(), 'a.ts'))).toBe('TEXT')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('with the real file system: reads a file, rejects a missing one, refuses a real link out of the folder', async () => {
    await mkdir(join(root(), 'src'), { recursive: true })
    await writeFile(join(root(), 'src', 'a.ts'), 'A text')
    await writeFile(join(dir, 'outside.ts'), 'O')
    const r = confinedTextReader(root())
    expect(await r(join(root(), 'src', 'a.ts'))).toBe('A text')
    await expect(r(join(root(), 'missing.ts'))).rejects.toThrow()
    let linked = true
    try {
      await symlink(join(dir, 'outside.ts'), join(root(), 'link.ts'), 'file')
    } catch {
      linked = false // Windows without developer mode cannot make file links; the injected tests cover it
    }
    if (linked) await expect(r(join(root(), 'link.ts'))).rejects.toThrow('outside the folder')
  })

  it("the real file system's id of a path is the path's own: a link at its end is not followed", async () => {
    await mkdir(join(dir, 'target'), { recursive: true })
    await symlink(join(dir, 'target'), join(dir, 'link'), 'junction')
    const [own, target] = await Promise.all([realConfinedFs.lstat(join(dir, 'link')), realConfinedFs.lstat(join(dir, 'target'))])
    expect(own.ino === target.ino && own.dev === target.dev).toBe(false)
  })
})

describe('cloneConfinement (Opus R3-m3, R3-n2)', () => {
  const data = (): string => join(dir, 'data')
  const repos = (): string => join(data(), 'world', 'repos')
  const never = async (): Promise<string> => { throw new Error('real path not asked for') }

  it('a clone, or a folder in one, by its spelling: the clone folder, without asking for a real path', async () => {
    expect(await cloneConfinement(data(), join(repos(), 'c'), { real: never })).toBe(join(repos(), 'c'))
    expect(await cloneConfinement(data(), join(repos(), 'c', 'src', 'deep'), { real: never })).toBe(join(repos(), 'c'))
  })

  it.runIf(process.platform === 'win32')('a Git Bash spelling of a clone on Windows', async () => {
    const posix = `/${repos()[0].toLowerCase()}${repos().slice(2).replace(/\\/g, '/')}/c/src`
    expect(await cloneConfinement(data(), posix, { platform: 'win32', real: never })).toBe(join(repos(), 'c'))
  })

  it('a link to a clone, or into one: by the real paths, the clone folder', async () => {
    const real = async (p: string): Promise<string> => (p === join(dir, 'alias') ? join(repos(), 'c', 'src') : p)
    expect(await cloneConfinement(data(), join(dir, 'alias'), { real })).toBe(join(repos(), 'c'))
    // A data folder reached through a link: its real path holds the clone.
    const linkedData = join(dir, 'linkedData')
    const viaData = async (p: string): Promise<string> => (p === join(linkedData, 'world', 'repos') ? repos() : p)
    expect(await cloneConfinement(linkedData, join(repos(), 'c'), { real: viaData })).toBe(join(repos(), 'c'))
  })

  it('no clone: the repos folder itself, a folder outside it, or a real path that cannot be had', async () => {
    const real = async (p: string): Promise<string> => p
    expect(await cloneConfinement(data(), repos(), { real })).toBeNull()
    expect(await cloneConfinement(data(), join(dir, 'project'), { real })).toBeNull()
    expect(await cloneConfinement(data(), join(dir, 'alias'), { real: never })).toBeNull()
    expect(await cloneConfinement(data(), join(dir, 'alias'), { real: async (p) => (p === repos() ? p : Promise.reject(new Error('ENOENT'))) })).toBeNull()
    // A path the shell spelling cannot read is judged as written.
    expect(await cloneConfinement(data(), '', { real: never })).toBeNull()
  })

  it('with the real file system: a junction or symlink to a clone is confined to the clone', async () => {
    await mkdir(join(repos(), 'c', 'src'), { recursive: true })
    let linked = true
    try {
      await symlink(join(repos(), 'c'), join(dir, 'alias'), 'junction')
    } catch {
      linked = false
    }
    if (!linked) return
    const got = await cloneConfinement(data(), join(dir, 'alias', 'src'))
    expect(got && folderKey(got)).toBe(folderKey(await realpath(join(repos(), 'c'))))
    expect(await cloneConfinement(data(), join(dir, 'missing'))).toBeNull()
  })
})

describe('cloneReader', () => {
  it('confines the reads of a clone to it, and reads a folder that is no clone plainly', async () => {
    const data = join(dir, 'data')
    const clone = join(data, 'world', 'repos', 'c')
    await mkdir(clone, { recursive: true })
    await writeFile(join(clone, 'a.ts'), 'A')
    await writeFile(join(dir, 'outside.ts'), 'O')
    const read = vi.fn(async (p: string) => `read:${p}`)
    const inClone = cloneReader(data, clone, read)
    expect(await inClone(join(clone, 'a.ts'))).toMatch(/a\.ts$/)
    await expect(inClone(join(dir, 'outside.ts'))).rejects.toThrow('outside the folder')
    const plain = cloneReader(data, join(dir, 'project'), read)
    expect(await plain(join(dir, 'outside.ts'))).toBe(`read:${join(dir, 'outside.ts')}`)
    expect(await plain(join(dir, 'missing.ts'))).toBe(`read:${join(dir, 'missing.ts')}`)
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
