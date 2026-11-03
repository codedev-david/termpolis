import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

const mockReaddirSync = vi.fn()
const mockStatSync = vi.fn()
const mockRealpathSync = vi.fn()
const mockAccessSync = vi.fn()

// The service reads on the thread pool (fs.promises), and every call here is answered by the same fakes the
// synchronous names used to be, so each test body keeps saying what the file system holds. A fake that throws makes the
// promise reject, as the real call would. The synchronous names are counted: the service must not use them.
const syncCalls: string[] = []
const answer = (name: string, fake: (...a: any[]) => any) => async (...args: any[]) => fake(...args)
const noSync = (name: string) => () => { syncCalls.push(name); throw new Error(name + ' on the main thread') }
vi.mock('fs', () => {
  const promises = {
    readdir: answer('readdir', (...a) => mockReaddirSync(...a)),
    stat: answer('stat', (...a) => mockStatSync(...a)),
    realpath: answer('realpath', (...a) => mockRealpathSync(...a)),
    access: answer('access', (...a) => mockAccessSync(...a)),
  }
  const sync = {
    readdirSync: noSync('readdirSync'), statSync: noSync('statSync'), accessSync: noSync('accessSync'),
    realpathSync: Object.assign(noSync('realpathSync'), { native: noSync('realpathSync.native') }),
  }
  return { ...sync, promises, constants: { X_OK: 1 }, default: { ...sync, promises, constants: { X_OK: 1 } } }
})
vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const { listPathEntries, listEnvVars, listPathCommands, resetPathCommandsCache, resetSafeRootsCache } = await import('../../src/main/completionService')

const home = homedir()
const safePath = join(home, 'test-project')

/** Minimal Dirent stand-in. listPathEntries takes each entry's kind from the directory read
 *  itself (withFileTypes) instead of paying a statSync per entry. */
const dirent = (name: string, kind: 'file' | 'dir' | 'link' = 'file'): unknown => ({
  name,
  isDirectory: () => kind === 'dir',
  isSymbolicLink: () => kind === 'link',
})

describe('completionService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRealpathSync.mockImplementation((p: any) => String(p))
  })

  describe('listPathEntries', () => {
    it('returns files and dirs for paths under home directory', async () => {
      mockReaddirSync.mockReturnValue([dirent('file.txt'), dirent('subdir', 'dir')])
      const result = await listPathEntries(safePath)
      expect(result).toContainEqual({ name: 'file.txt', isDir: false })
      expect(result).toContainEqual({ name: 'subdir', isDir: true })
      expect(result).toHaveLength(2)
    })

    it('blocks absolute paths outside home and cwd', async () => {
      // realpathSync resolves the path to /etc/passwd — outside home
      mockRealpathSync.mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes('etc')) return '/etc/passwd'
        return s
      })
      const result = await listPathEntries('/etc/passwd')
      expect(result).toEqual([])
      // readdirSync should never be called — path rejected before reading
      expect(mockReaddirSync).not.toHaveBeenCalled()
    })

    it('blocks symlink-based traversal (symlink resolves outside home)', async () => {
      // Simulates: ~/innocent-link is a symlink to /etc/shadow
      mockRealpathSync.mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes('innocent-link')) return '/etc/shadow'
        return s
      })
      const result = await listPathEntries(join(home, 'innocent-link'))
      expect(result).toEqual([])
      expect(mockReaddirSync).not.toHaveBeenCalled()
    })

    it('blocks dot-dot traversal that resolves outside safe roots', async () => {
      // realpathSync resolves ../../ to a path outside home
      mockRealpathSync.mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes('..')) return '/var/secrets'
        return s
      })
      const result = await listPathEntries(join(home, 'project', '..', '..', '..'))
      expect(result).toEqual([])
      expect(mockReaddirSync).not.toHaveBeenCalled()
    })

    it('allows paths under cwd even if cwd is outside home', async () => {
      // On some systems cwd may not be under home (e.g. /opt/project)
      const cwd = process.cwd()
      const cwdSubpath = join(cwd, 'src')
      mockReaddirSync.mockReturnValue([dirent('index.ts')])
      const result = await listPathEntries(cwdSubpath)
      expect(result).toContainEqual({ name: 'index.ts', isDir: false })
    })

    it('returns empty array when realpathSync throws (non-existent path)', async () => {
      mockRealpathSync.mockImplementation((p: any) => {
        if (String(p) === '/nonexistent') throw new Error('ENOENT')
        return String(p)
      })
      const result = await listPathEntries('/nonexistent')
      expect(result).toEqual([])
    })
  })

  describe('listEnvVars', () => {
    const originalEnv = process.env

    beforeEach(() => {
      // Inject known dangerous vars into process.env for this test
      process.env = {
        ...originalEnv,
        AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        GITHUB_TOKEN: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        DATABASE_URL: 'postgres://admin:secret@prod-db:5432/main',
        ANTHROPIC_API_KEY: 'sk-ant-api-EXAMPLE',
        OPENAI_API_KEY: 'sk-EXAMPLE',
        STRIPE_SECRET_KEY: 'sk_live_EXAMPLE',
        // These should still be returned
        PATH: '/usr/bin:/bin',
        HOME: '/home/testuser',
        SHELL: '/bin/bash',
        EDITOR: 'vim',
      }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('returns safe environment variables', () => {
      const result = listEnvVars()
      expect(result.PATH).toBe('/usr/bin:/bin')
      expect(result.HOME).toBe('/home/testuser')
      expect(result.SHELL).toBe('/bin/bash')
      expect(result.EDITOR).toBe('vim')
    })

    it('filters out cloud credentials', () => {
      const result = listEnvVars()
      expect(result).not.toHaveProperty('AWS_ACCESS_KEY_ID')
      expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
      expect(result).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(result).not.toHaveProperty('OPENAI_API_KEY')
    })

    it('filters out tokens and secrets', () => {
      const result = listEnvVars()
      expect(result).not.toHaveProperty('GITHUB_TOKEN')
      expect(result).not.toHaveProperty('DATABASE_URL')
      expect(result).not.toHaveProperty('STRIPE_SECRET_KEY')
    })

    it('only returns keys from the allowlist, nothing else', () => {
      const result = listEnvVars()
      const allowedKeys = new Set([
        'PATH', 'Path', 'SHELL', 'TERM', 'HOME', 'USERPROFILE', 'USER', 'USERNAME',
        'LANG', 'LC_ALL', 'EDITOR', 'VISUAL', 'PAGER',
        'PWD', 'OLDPWD', 'HOSTNAME', 'COMPUTERNAME',
        'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
        'TMPDIR', 'TEMP', 'TMP',
        'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
        'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
      ])
      for (const key of Object.keys(result)) {
        expect(allowedKeys.has(key)).toBe(true)
      }
    })

    it('returns empty object when no safe vars are set', () => {
      const originalEnv2 = process.env
      process.env = {}
      try {
        const result = listEnvVars()
        expect(result).toEqual({})
      } finally {
        process.env = originalEnv2
      }
    })
  })

  describe('listPathEntries — additional edge cases', () => {
    it('returns [] when readdirSync throws', async () => {
      mockReaddirSync.mockImplementation(() => { throw new Error('EPERM') })
      const result = await listPathEntries(safePath)
      expect(result).toEqual([])
    })

    it('marks entries as isDir true or false from the directory entry itself', async () => {
      mockReaddirSync.mockReturnValue([dirent('file.txt'), dirent('subdir', 'dir'), dirent('link')])
      const result = await listPathEntries(safePath)
      expect(result).toContainEqual({ name: 'file.txt', isDir: false })
      expect(result).toContainEqual({ name: 'subdir', isDir: true })
      expect(result).toContainEqual({ name: 'link', isDir: false })
    })

    it('returns isDir: false when a single entry cannot be classified', async () => {
      mockReaddirSync.mockReturnValue([dirent('good.txt'), dirent('bad-entry', 'link')])
      mockStatSync.mockImplementation((p: any) => {
        if (String(p).includes('bad-entry')) throw new Error('EACCES')
        return { isDirectory: () => false }
      })
      const result = await listPathEntries(safePath)
      expect(result).toContainEqual({ name: 'good.txt', isDir: false })
      expect(result).toContainEqual({ name: 'bad-entry', isDir: false })
    })
  })

  // getSafeRoots used to realpathSync BOTH homedir() and process.cwd() on every single call, and
  // isPathAllowed added a third realpathSync for the target — three synchronous resolutions on the
  // thread that pumps every PTY, behind an IPC channel that fires per keystroke/Tab.
  describe('safe-roots caching', () => {
    beforeEach(() => {
      resetSafeRootsCache()
    })

    it('resolves home and cwd ONCE, not on every call', async () => {
      mockReaddirSync.mockReturnValue([dirent('a.txt')])
      await listPathEntries(safePath)
      vi.clearAllMocks()
      // Everything after the first call must resolve ONLY the path the user typed: home and cwd
      // cannot change while the process runs.
      await listPathEntries(safePath)
      expect(mockRealpathSync).toHaveBeenCalledTimes(1)
      expect(mockRealpathSync).toHaveBeenCalledWith(safePath)
    })

    // Caching freezes this decision for the life of the process, so it is worth pinning: a cwd
    // outside home becomes a SECOND root. The repo lives under home on this box, so the branch is
    // only reachable with a stand-in cwd.
    it('adds cwd as a second root when the process runs outside the home directory', async () => {
      const outside = process.platform === 'win32' ? 'D:\\srv\\app' : '/srv/app'
      const spy = vi.spyOn(process, 'cwd').mockReturnValue(outside)
      try {
        resetSafeRootsCache()
        mockReaddirSync.mockReturnValue([dirent('deploy.sh')])
        expect(await listPathEntries(join(outside, 'bin'))).toEqual([{ name: 'deploy.sh', isDir: false }])
      } finally {
        spy.mockRestore()
        resetSafeRootsCache() // never leak a fake cwd into a cache that outlives the test
      }
    })

    it('resetSafeRootsCache forces the roots to be resolved again', async () => {
      mockReaddirSync.mockReturnValue([dirent('a.txt')])
      await listPathEntries(safePath)
      resetSafeRootsCache()
      vi.clearAllMocks()
      await listPathEntries(safePath)
      expect(mockRealpathSync.mock.calls.length).toBeGreaterThan(1)
    })

    it('still blocks a path outside the roots once the roots are cached', async () => {
      mockReaddirSync.mockReturnValue([dirent('a.txt')])
      await listPathEntries(safePath) // populate the cache
      mockRealpathSync.mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('etc') ? '/etc/passwd' : s
      })
      expect(await listPathEntries('/etc/passwd')).toEqual([])
    })
  })

  describe('listPathEntries — entry kinds come from the directory read', () => {
    it('asks readdirSync for file types instead of stat-ing every entry', async () => {
      mockReaddirSync.mockReturnValue([dirent('a.txt'), dirent('b', 'dir')])
      const result = await listPathEntries(safePath)
      expect(mockReaddirSync).toHaveBeenCalledWith(safePath, { withFileTypes: true })
      expect(mockStatSync).not.toHaveBeenCalled()
      expect(result).toEqual([{ name: 'a.txt', isDir: false }, { name: 'b', isDir: true }])
    })

    it('still stats a SYMLINK — a Dirent reports "symlink", not what it points at', async () => {
      mockReaddirSync.mockReturnValue([dirent('link-to-dir', 'link')])
      mockStatSync.mockReturnValue({ isDirectory: () => true })
      expect(await listPathEntries(safePath)).toEqual([{ name: 'link-to-dir', isDir: true }])
      expect(mockStatSync).toHaveBeenCalledWith(join(safePath, 'link-to-dir'))
    })
  })
})

describe('listPathCommands', () => {
  let originalPlatform: string
  let originalPATH: string | undefined
  let originalPathAlt: string | undefined

  beforeEach(() => {
    mockReaddirSync.mockReset()
    mockStatSync.mockReset()
    mockRealpathSync.mockReset()
    mockAccessSync.mockReset()
    mockRealpathSync.mockImplementation((p: any) => String(p))
    resetPathCommandsCache()
    originalPlatform = process.platform
    originalPATH = process.env.PATH
    originalPathAlt = process.env.Path
    // Force linux-like platform so non-Windows branch is exercised
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    process.env.PATH = originalPATH
    if (originalPathAlt !== undefined) {
      process.env.Path = originalPathAlt
    } else {
      delete process.env.Path
    }
    vi.restoreAllMocks()
  })

  it('returns sorted list of PATH commands on non-Windows', async () => {
    process.env.PATH = '/usr/bin'
    mockReaddirSync.mockReturnValue(['zebra', 'alpha', 'middle'])
    mockAccessSync.mockImplementation(() => undefined)
    const result = await listPathCommands()
    expect(result).toEqual(['alpha', 'middle', 'zebra'])
  })

  it('deduplicates commands that appear in multiple PATH dirs', async () => {
    process.env.PATH = '/usr/bin:/usr/local/bin'
    mockReaddirSync.mockReturnValue(['git', 'node'])
    mockAccessSync.mockImplementation(() => undefined)
    const result = await listPathCommands()
    expect(result.filter((x: string) => x === 'git')).toHaveLength(1)
    expect(result.filter((x: string) => x === 'node')).toHaveLength(1)
  })

  it('on non-Windows skips non-executable files (accessSync throws)', async () => {
    process.env.PATH = '/usr/bin'
    mockReaddirSync.mockReturnValue(['runnable', 'not-runnable'])
    mockAccessSync.mockImplementation((p: any) => {
      if (String(p).includes('not-runnable')) throw new Error('EACCES')
    })
    const result = await listPathCommands()
    expect(result).toContain('runnable')
    expect(result).not.toContain('not-runnable')
  })

  it('asks for the commands twice at once (two panes opening): ONE scan serves both, and the next ask after it uses the cache', async () => {
    process.env.PATH = '/usr/bin'
    mockReaddirSync.mockReturnValue(['git', 'node'])
    mockAccessSync.mockImplementation(() => undefined)
    const [a, b] = await Promise.all([listPathCommands(), listPathCommands()])
    expect(a).toEqual(b)
    expect(a).toContain('git')
    expect(mockReaddirSync).toHaveBeenCalledTimes(1) // one scan of the folder, not two
    await listPathCommands()
    expect(mockReaddirSync).toHaveBeenCalledTimes(1) // and the answer is kept
  })

  it('a scan that fails is forgotten, so the next ask scans again (nothing stays stuck)', async () => {
    process.env.PATH = '/usr/bin'
    mockAccessSync.mockImplementation(() => undefined)
    mockReaddirSync.mockImplementationOnce(() => { throw new Error('EIO') }) // a folder that cannot be listed counts as empty
    expect(await listPathCommands()).toEqual([])
    mockReaddirSync.mockReturnValue(['git'])
    resetPathCommandsCache() // the empty answer was kept for the TTL; a restart forgets it
    expect(await listPathCommands()).toContain('git')
  })

  it('returns cached result on second call within TTL', async () => {
    process.env.PATH = '/usr/bin'
    mockReaddirSync.mockReturnValue(['git'])
    mockAccessSync.mockImplementation(() => undefined)
    await listPathCommands() // first call — populates cache
    mockReaddirSync.mockReturnValue(['totally-different'])
    const second = await listPathCommands() // second call — should use cache
    expect(second).toContain('git')
    expect(second).not.toContain('totally-different')
    expect(mockReaddirSync).toHaveBeenCalledTimes(1)
  })

  it('cache expires after TTL and returns fresh results', async () => {
    process.env.PATH = '/usr/bin'
    mockReaddirSync.mockReturnValue(['git'])
    mockAccessSync.mockImplementation(() => undefined)

    let fakeNow = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)

    await listPathCommands() // first call at t=1_000_000

    // Advance time beyond 5-minute TTL
    fakeNow += 6 * 60 * 1000
    mockReaddirSync.mockReturnValue(['fresh-command'])

    const second = await listPathCommands()
    expect(second).toContain('fresh-command')
    expect(second).not.toContain('git')
  })

  it('returns [] when PATH is empty and all dirs are unreadable', async () => {
    process.env.PATH = ''
    delete process.env.Path
    mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT') })
    const result = await listPathCommands()
    expect(result).toEqual([])
  })

  it('falls back to process.env.Path (Windows-style, capitalised) when PATH is undefined', async () => {
    delete process.env.PATH
    process.env.Path = '/c/Program Files/Git/cmd'
    mockReaddirSync.mockReturnValue(['some-binary'])
    mockAccessSync.mockImplementation(() => undefined)
    const result = await listPathCommands()
    expect(result).toContain('some-binary')
  })

  it('on Windows splits PATH by ;', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.PATH = 'C:\\Windows;C:\\Tools'
    mockReaddirSync.mockImplementation((dir: any) => {
      if (String(dir) === 'C:\\Windows') return ['cmd.exe']
      if (String(dir) === 'C:\\Tools') return ['rg.exe']
      return []
    })
    const result = await listPathCommands()
    expect(result).toContain('cmd')
    expect(result).toContain('rg')
  })

  it('on Windows recognises .exe / .cmd / .bat / .ps1 / .com but ignores .txt', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.PATH = 'C:\\Tools'
    mockReaddirSync.mockReturnValue([
      'good.exe', 'shim.cmd', 'old.bat', 'profile.ps1', 'legacy.com', 'readme.txt',
    ])
    const result = await listPathCommands()
    expect(result).toContain('good')
    expect(result).toContain('shim')
    expect(result).toContain('old')
    expect(result).toContain('profile')
    expect(result).toContain('legacy')
    expect(result).not.toContain('readme')
  })

  it('on Windows deduplicates case-insensitive base names', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.PATH = 'C:\\A;C:\\B'
    mockReaddirSync.mockImplementation((dir: any) => {
      if (String(dir) === 'C:\\A') return ['Git.exe']
      if (String(dir) === 'C:\\B') return ['git.cmd']
      return []
    })
    const result = await listPathCommands()
    // Only one of the two should appear (first wins)
    expect(result.filter((x: string) => x.toLowerCase() === 'git')).toHaveLength(1)
  })
})
