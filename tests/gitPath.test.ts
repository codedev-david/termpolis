import { describe, it, expect } from 'vitest'
import {
  gitBinaryNames,
  pathKey,
  splitPath,
  childPath,
  findGitDir,
  candidateGitDirs,
  ensureGitOnPath,
  type EnvLike,
} from './gitPath'

// A fake filesystem. Comparison is case-insensitive for the Windows cases
// because Windows paths are, and these tests run on Linux and macOS in CI too.
const fsWith = (...present: string[]) => {
  const set = new Set(present.map(p => p.toLowerCase()))
  return (p: string) => set.has(p.toLowerCase())
}
const none = () => false

describe('gitBinaryNames', () => {
  it('looks for the .cmd shim as well as the .exe on Windows', () => {
    // Some scoop/winget layouts ship only git.cmd; an exe-only probe walks past them.
    expect(gitBinaryNames('win32')).toEqual(['git.exe', 'git.cmd'])
  })

  it('looks for a bare `git` everywhere else', () => {
    expect(gitBinaryNames('linux')).toEqual(['git'])
    expect(gitBinaryNames('darwin')).toEqual(['git'])
  })
})

describe('pathKey', () => {
  it('finds PATH however the environment happens to spell it', () => {
    expect(pathKey({ PATH: '/usr/bin' })).toBe('PATH')
    expect(pathKey({ Path: 'C:\\Windows' })).toBe('Path') // the usual Windows spelling
    expect(pathKey({ path: '/usr/bin' })).toBe('path')
  })

  it('falls back to PATH when the environment has none at all', () => {
    expect(pathKey({})).toBe('PATH')
  })

  it('ignores keys that merely contain "path"', () => {
    expect(pathKey({ GIT_EXEC_PATH: '/x', PATHEXT: '.EXE' })).toBe('PATH')
  })
})

describe('splitPath', () => {
  it('splits on the separator for the TARGET platform, not the host', () => {
    expect(splitPath('C:\\a;C:\\b', 'win32')).toEqual(['C:\\a', 'C:\\b'])
    expect(splitPath('/a:/b', 'linux')).toEqual(['/a', '/b'])
  })

  it('drops empty entries, which a trailing separator leaves behind', () => {
    expect(splitPath('/a::/b:', 'linux')).toEqual(['/a', '/b'])
  })

  it('strips the quotes and padding Windows tolerates in PATH', () => {
    expect(splitPath('"C:\\Program Files\\Git\\cmd" ; C:\\b', 'win32'))
      .toEqual(['C:\\Program Files\\Git\\cmd', 'C:\\b'])
  })

  it('treats a missing PATH as empty rather than throwing', () => {
    expect(splitPath(undefined, 'win32')).toEqual([])
  })
})

describe('childPath', () => {
  it('uses the target platform separator so Windows paths survive a Linux runner', () => {
    expect(childPath('C:\\Git\\cmd', 'git.exe', 'win32')).toBe('C:\\Git\\cmd\\git.exe')
    expect(childPath('/usr/bin', 'git', 'linux')).toBe('/usr/bin/git')
  })

  it('does not double the separator when the directory already ends in one', () => {
    expect(childPath('C:\\Git\\cmd\\', 'git.exe', 'win32')).toBe('C:\\Git\\cmd\\git.exe')
    expect(childPath('/usr/bin/', 'git', 'linux')).toBe('/usr/bin/git')
    // A forward slash is a legal Windows separator and must not be doubled either.
    expect(childPath('C:/Git/cmd/', 'git.exe', 'win32')).toBe('C:/Git/cmd/git.exe')
  })
})

describe('findGitDir', () => {
  it('returns the first directory that actually holds a git', () => {
    const exists = fsWith('C:\\b\\git.exe')
    expect(findGitDir(['C:\\a', 'C:\\b', 'C:\\c'], 'win32', exists)).toBe('C:\\b')
  })

  it('accepts a .cmd shim when there is no .exe', () => {
    expect(findGitDir(['C:\\a'], 'win32', fsWith('C:\\a\\git.cmd'))).toBe('C:\\a')
  })

  it('returns null rather than a guess when nothing holds a git', () => {
    expect(findGitDir(['C:\\a', 'C:\\b'], 'win32', none)).toBeNull()
  })

  it('returns null for an empty candidate list', () => {
    expect(findGitDir([], 'linux', fsWith('/usr/bin/git'))).toBeNull()
  })
})

describe('candidateGitDirs', () => {
  it('trusts EXEPATH first, because it names the real install', () => {
    // Git for Windows exports this into every process it spawns. It is right
    // even when git was installed somewhere Program Files would never find.
    const dirs = candidateGitDirs({ EXEPATH: 'D:\\tools\\Git' }, 'win32')
    expect(dirs[0]).toBe('D:\\tools\\Git')
    expect(dirs).toContain('D:\\tools\\Git\\cmd')
    expect(dirs).toContain('D:\\tools\\Git\\bin')
  })

  it('climbs one level when the hint already points at bin/', () => {
    // This is the exact shape observed on the machine that motivated the fix:
    // EXEPATH=C:\Program Files\Git\bin while PATH had no git at all.
    const dirs = candidateGitDirs({ EXEPATH: 'C:\\Program Files\\Git\\bin' }, 'win32')
    expect(dirs).toContain('C:\\Program Files\\Git\\cmd')
  })

  it('climbs from GIT_EXEC_PATH, which points deep into libexec', () => {
    const dirs = candidateGitDirs(
      { GIT_EXEC_PATH: 'C:\\Program Files\\Git\\mingw64\\libexec\\git-core' },
      'win32',
    )
    expect(dirs).toContain('C:\\Program Files\\Git\\mingw64\\libexec\\git-core')
    expect(dirs).toContain('C:\\Program Files\\Git\\mingw64\\libexec\\cmd')
  })

  it('tolerates a trailing separator on the hint', () => {
    expect(candidateGitDirs({ EXEPATH: 'D:\\Git\\' }, 'win32')).toContain('D:\\Git\\cmd')
  })

  it('does not climb past a bare drive root', () => {
    expect(candidateGitDirs({ EXEPATH: 'C:' }, 'win32')).toContain('C:')
  })

  it('covers the standard install locations, cmd before bin', () => {
    const dirs = candidateGitDirs(
      {
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramW6432: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      },
      'win32',
    )
    expect(dirs).toContain('C:\\Program Files\\Git\\cmd')
    expect(dirs).toContain('C:\\Program Files (x86)\\Git\\bin')
    expect(dirs).toContain('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd')
    // cmd\git.exe is the launcher the installer puts on PATH for non-MSYS shells.
    expect(dirs.indexOf('C:\\Program Files\\Git\\cmd'))
      .toBeLessThan(dirs.indexOf('C:\\Program Files\\Git\\bin'))
  })

  it('never repeats a directory, however many hints point at it', () => {
    const dirs = candidateGitDirs(
      { EXEPATH: 'C:\\Program Files\\Git', ProgramFiles: 'C:\\Program Files', ProgramW6432: 'C:\\Program Files' },
      'win32',
    )
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  it('skips hints the environment does not define', () => {
    expect(candidateGitDirs({}, 'win32')).toEqual([])
  })

  it('offers the usual unix locations, including both Homebrew and MacPorts', () => {
    expect(candidateGitDirs({ EXEPATH: 'ignored-off-windows' }, 'darwin'))
      .toEqual(['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin'])
  })
})

describe('ensureGitOnPath', () => {
  it('leaves a working PATH completely alone', () => {
    // A shell that deliberately pinned a git version keeps the one it chose.
    const env: EnvLike = { PATH: 'C:\\pinned\\git\\cmd;C:\\Windows' }
    const before = env.PATH
    const res = ensureGitOnPath(env, 'win32', fsWith('C:\\pinned\\git\\cmd\\git.exe'))
    expect(res).toEqual({ status: 'already-resolvable', dir: 'C:\\pinned\\git\\cmd' })
    expect(env.PATH).toBe(before)
  })

  it('prepends the install it found when PATH has no git', () => {
    // The regression this whole module exists for.
    const env: EnvLike = {
      Path: 'C:\\Windows;C:\\Windows\\System32',
      EXEPATH: 'C:\\Program Files\\Git\\bin',
    }
    const res = ensureGitOnPath(env, 'win32', fsWith('C:\\Program Files\\Git\\cmd\\git.exe'))
    expect(res).toEqual({ status: 'prepended', dir: 'C:\\Program Files\\Git\\cmd' })
    expect(env.Path).toBe('C:\\Program Files\\Git\\cmd;C:\\Windows;C:\\Windows\\System32')
  })

  it('writes back to the key the environment actually used', () => {
    // Writing a new `PATH` beside an existing `Path` would change nothing.
    const env: EnvLike = { Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }
    ensureGitOnPath(env, 'win32', fsWith('C:\\Program Files\\Git\\cmd\\git.exe'))
    expect(Object.keys(env)).not.toContain('PATH')
    expect(env.Path).toContain('C:\\Program Files\\Git\\cmd')
  })

  it('sets PATH without a stray separator when there was no PATH at all', () => {
    const env: EnvLike = { ProgramFiles: 'C:\\Program Files' }
    const res = ensureGitOnPath(env, 'win32', fsWith('C:\\Program Files\\Git\\cmd\\git.exe'))
    expect(res.status).toBe('prepended')
    expect(env.PATH).toBe('C:\\Program Files\\Git\\cmd')
  })

  it('reports unresolved instead of inventing a path when git is genuinely absent', () => {
    const env: EnvLike = { PATH: '/usr/bin' }
    expect(ensureGitOnPath(env, 'linux', none)).toEqual({ status: 'unresolved', dir: null })
    expect(env.PATH).toBe('/usr/bin') // and does not corrupt PATH on the way out
  })

  it('works on unix too', () => {
    const env: EnvLike = { PATH: '/sbin' }
    const res = ensureGitOnPath(env, 'darwin', fsWith('/opt/homebrew/bin/git'))
    expect(res).toEqual({ status: 'prepended', dir: '/opt/homebrew/bin' })
    expect(env.PATH).toBe('/opt/homebrew/bin:/sbin')
  })

  it('defaults to the live process, and that process can find git', () => {
    // The end-to-end assertion: after setup.ts has run, this suite CAN spawn
    // git. If this fails, the four git-dependent test files are about to fail
    // too, and this says why in one line.
    expect(ensureGitOnPath().status).not.toBe('unresolved')
  })
})
