import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  GIT_MISS_TTL_MS,
  assertRunnable,
  assertRunnableFile,
  binInside,
  binInsideFolder,
  commandOnPath,
  createBinResolver,
  findGit,
  forgetGitBin,
  gitInstallCandidates,
  insideFolder,
  resolveGitBin
} from '../../src/main/binPath'

const found = (files: string[]) =>
  vi.fn(async (f: string) => {
    if (!files.includes(f)) throw new Error('ENOENT')
  })

describe('commandOnPath', () => {
  it('returns the full path of gh.exe in a fixed Windows PATH folder, skipping relative, drive-relative and current folders', async () => {
    const access = found(['C:\\Tools\\gh.exe', 'C:\\Repo\\gh.exe', 'D:\\Win\\gh.com'])
    const Path = '"";rel\\bin;.;\\tools;C:tools;;C:\\Repo\\;D:\\Win;"C:\\Tools"'
    expect(await commandOnPath('gh', { Path }, 'win32', access, 'c:\\repo')).toBe('C:\\Tools\\gh.exe')
    expect(access.mock.calls.map((c) => c[0])).toEqual(['D:\\Win\\gh.exe', 'C:\\Tools\\gh.exe'])
    // A share counts as fixed; with no cwd given, every fixed folder is tried.
    expect(await commandOnPath('gh', { PATH: '\\\\srv\\bin' }, 'win32', found(['\\\\srv\\bin\\gh.exe']))).toBe('\\\\srv\\bin\\gh.exe')
    expect(await commandOnPath('gh', { PATH: 'C:\\Repo' }, 'win32', access)).toBe('C:\\Repo\\gh.exe')
  })

  it('refuses a gh.cmd, gh.bat or gh.com on Windows: only gh.exe runs without a shell', async () => {
    const access = found(['C:\\Tools\\gh.cmd', 'C:\\Tools\\gh.bat', 'C:\\Tools\\gh.com', 'C:\\Tools\\gh'])
    expect(await commandOnPath('gh', { PATH: 'C:\\Tools' }, 'win32', access)).toBeNull()
    expect(access.mock.calls.map((c) => c[0])).toEqual(['C:\\Tools\\gh.exe'])
  })

  it('returns the full path of gh in a POSIX PATH folder, skipping relative entries and the current folder', async () => {
    const access = found(['/usr/local/bin/gh', '/home/me/repo/gh', 'bin/gh', 'gh'])
    expect(await commandOnPath('gh', { PATH: '/usr/bin:./bin:.::bin:/home/me/repo/:/usr/local/bin' }, 'linux', access, '/home/me/repo')).toBe('/usr/local/bin/gh')
    expect(access.mock.calls.map((c) => c[0])).toEqual(['/usr/bin/gh', '/usr/local/bin/gh'])
    expect(await commandOnPath('gh', { PATH: '/usr/bin' }, 'darwin', found([]))).toBeNull()
    expect(await commandOnPath('gh', {}, 'linux', found(['/gh']))).toBeNull()
  })
})

describe('assertRunnable', () => {
  const X_OK = 1
  it('passes a regular file the process may run, checking the execute bit', async () => {
    const access = vi.fn(async () => undefined)
    await expect(assertRunnable('/usr/bin/gh', { stat: async () => ({ isFile: () => true }), access }, X_OK)).resolves.toBeUndefined()
    expect(access).toHaveBeenCalledWith('/usr/bin/gh', X_OK)
  })

  it('throws for a folder, a file without the execute bit, or nothing there', async () => {
    const access = vi.fn(async () => undefined)
    await expect(assertRunnable('/x/gh.exe', { stat: async () => ({ isFile: () => false }), access }, X_OK)).rejects.toThrow('not a file')
    expect(access).not.toHaveBeenCalled()
    const denied = async (): Promise<never> => {
      throw new Error('EACCES')
    }
    await expect(assertRunnable('/x/gh', { stat: async () => ({ isFile: () => true }), access: denied }, X_OK)).rejects.toThrow('EACCES')
    const missing = async (): Promise<never> => {
      throw new Error('ENOENT')
    }
    await expect(assertRunnable('/x/gh', { stat: missing, access }, X_OK)).rejects.toThrow('ENOENT')
  })
})

describe('findGit', () => {
  it('takes git.exe from a fixed PATH folder first, never one in the current folder or a relative entry', async () => {
    const repo = 'C:\\work\\cloned'
    const access = found([repo + '\\git.exe', '.\\git.exe', 'D:\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe'])
    expect(await findGit({ Path: `.;${repo};D:\\Git\\cmd` }, 'win32', access, repo)).toBe('D:\\Git\\cmd\\git.exe')
    expect(access.mock.calls.map((c) => c[0])).toEqual(['D:\\Git\\cmd\\git.exe'])
  })

  it('falls back to the install locations, in order, when PATH has no git', async () => {
    const win = found(['C:\\Program Files\\Git\\bin\\git.exe'])
    expect(await findGit({ Path: 'C:\\Windows' }, 'win32', win)).toBe('C:\\Program Files\\Git\\bin\\git.exe')
    expect(win.mock.calls.map((c) => c[0])).toEqual(['C:\\Windows\\git.exe', ...gitInstallCandidates('win32')])
    expect(await findGit({}, 'darwin', found(['/opt/homebrew/bin/git']))).toBe('/opt/homebrew/bin/git')
  })

  it('is null, never the bare name, when git is nowhere', async () => {
    expect(await findGit({ PATH: '/usr/bin' }, 'linux', found(['git']))).toBeNull()
    expect(await findGit({}, 'win32', found(['git.exe']))).toBeNull()
  })

  it('has one candidate list per platform, all absolute git binaries', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
      const list = gitInstallCandidates(platform)
      expect(list.length).toBeGreaterThan(0)
      for (const f of list) expect(f).toMatch(platform === 'win32' ? /^[A-Z]:\\.*\\git\.exe$/ : /^\/.*\/git$/)
    }
  })
})

describe('insideFolder and binInside', () => {
  it('compares case-blind with either slash, and a sibling with a longer name is not inside', () => {
    expect(insideFolder('C:\\Repo\\git.exe', 'c:/repo')).toBe(true)
    expect(insideFolder('/repo/tools/git', '/repo/')).toBe(true)
    expect(insideFolder('/repo-tools/git', '/repo')).toBe(false)
    expect(insideFolder('/repo', '/repo')).toBe(false)
  })

  it('follows links on both sides, and compares as written when a path cannot be resolved', async () => {
    const realpath = vi.fn(async (p: string) => {
      if (p === '/elsewhere/git') return '/repo/bin/git'
      if (p === '/gone') throw new Error('ENOENT')
      return p
    })
    expect(await binInside('/repo/git', '/repo', realpath)).toBe(true)
    expect(realpath).not.toHaveBeenCalled()
    expect(await binInside('/elsewhere/git', '/repo', realpath)).toBe(true)
    expect(await binInside('/usr/bin/git', '/gone', realpath)).toBe(false)
  })

  it('binInsideFolder follows a real link into the folder on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'binpath-'))
    try {
      const repo = join(dir, 'repo')
      await mkdir(join(repo, 'tools'), { recursive: true })
      await writeFile(join(repo, 'tools', 'git.exe'), '')
      expect(await binInsideFolder(join(repo, 'tools', 'git.exe'), repo)).toBe(true)
      expect(await binInsideFolder(join(dir, 'other', 'git.exe'), repo)).toBe(false)
      // A junction (Windows) or symlink outside the repository that points into it.
      let linked = true
      try {
        await symlink(join(repo, 'tools'), join(dir, 'link'), 'junction')
      } catch {
        linked = false
      }
      if (linked) expect(await binInsideFolder(join(dir, 'link', 'git.exe'), repo)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('createBinResolver', () => {
  it('looks once, shares one look between concurrent callers, and keeps a found path until forget()', async () => {
    const find = vi.fn(async () => '/usr/bin/git')
    const r = createBinResolver(find, () => 0, GIT_MISS_TTL_MS)
    expect(await Promise.all([r.get(), r.get()])).toEqual(['/usr/bin/git', '/usr/bin/git'])
    expect(await r.get()).toBe('/usr/bin/git')
    expect(find).toHaveBeenCalledTimes(1)
    r.forget()
    await r.get()
    expect(find).toHaveBeenCalledTimes(2)
  })

  it('believes a miss for the TTL only, so installing git shows up within a minute', async () => {
    const clock = { t: 0 }
    const find = vi.fn(async (): Promise<string | null> => null)
    const r = createBinResolver(find, () => clock.t, GIT_MISS_TTL_MS)
    expect(await r.get()).toBeNull()
    clock.t = GIT_MISS_TTL_MS - 1
    expect(await r.get()).toBeNull()
    expect(find).toHaveBeenCalledTimes(1)
    clock.t = GIT_MISS_TTL_MS
    find.mockResolvedValueOnce('/usr/bin/git')
    expect(await r.get()).toBe('/usr/bin/git')
    expect(find).toHaveBeenCalledTimes(2)
    expect(GIT_MISS_TTL_MS).toBe(60_000)
  })

  it('a look that throws reads as not installed', async () => {
    const r = createBinResolver(async () => {
      throw new Error('EPERM')
    }, () => 0, GIT_MISS_TTL_MS)
    expect(await r.get()).toBeNull()
  })
})

describe("this process's git", () => {
  it('resolveGitBin answers an absolute path or null, never the bare name; assertRunnableFile checks the real disk', async () => {
    forgetGitBin()
    const bin = await resolveGitBin()
    if (bin !== null) {
      expect(bin).toMatch(/[\\/]git(\.exe)?$/i)
      expect(bin).not.toBe('git')
      await expect(assertRunnableFile(bin)).resolves.toBeUndefined()
    }
    await expect(assertRunnableFile(join(tmpdir(), 'no-such-git-here'))).rejects.toThrow()
    await expect(assertRunnableFile(tmpdir())).rejects.toThrow('not a file')
  })
})
