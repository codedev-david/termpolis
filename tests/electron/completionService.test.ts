import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

const mockReaddirSync = vi.fn()
const mockStatSync = vi.fn()
const mockRealpathSync = vi.fn()
const mockAccessSync = vi.fn()

vi.mock('fs', () => ({
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
  realpathSync: Object.assign(
    (...args: any[]) => mockRealpathSync(...args),
    { native: (...args: any[]) => mockRealpathSync(...args) }
  ),
  accessSync: (...args: any[]) => mockAccessSync(...args),
  constants: { X_OK: 1 },
  default: {
    readdirSync: (...args: any[]) => mockReaddirSync(...args),
    statSync: (...args: any[]) => mockStatSync(...args),
    realpathSync: Object.assign(
      (...args: any[]) => mockRealpathSync(...args),
      { native: (...args: any[]) => mockRealpathSync(...args) }
    ),
    accessSync: (...args: any[]) => mockAccessSync(...args),
    constants: { X_OK: 1 },
  },
}))
vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const { listPathEntries, listEnvVars, listPathCommands, resetPathCommandsCache } = await import('../../src/main/completionService')

const home = homedir()
const safePath = join(home, 'test-project')

describe('completionService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRealpathSync.mockImplementation((p: any) => String(p))
  })

  describe('listPathEntries', () => {
    it('returns files and dirs for paths under home directory', () => {
      mockReaddirSync.mockReturnValue(['file.txt', 'subdir'])
      mockStatSync.mockImplementation((p: any) => ({
        isDirectory: () => String(p).includes('subdir'),
      }))
      const result = listPathEntries(safePath)
      expect(result).toContainEqual({ name: 'file.txt', isDir: false })
      expect(result).toContainEqual({ name: 'subdir', isDir: true })
      expect(result).toHaveLength(2)
    })

    it('blocks absolute paths outside home and cwd', () => {
      // realpathSync resolves the path to /etc/passwd — outside home
      mockRealpathSync.mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes('etc')) return '/etc/passwd'
        return s
      })
      const result = listPathEntries('/etc/passwd')
      expect(result).toEqual([])
      // readdirSync should never be called — path rejected before reading
      expect(mockReaddirSync).not.toHaveBeenCalled()
    })

    it('blocks symlink-based traversal (symlink resolves outside home)', () => {
      // Simulates: ~/innocent-link is a symlink to /etc/shadow
      mockRealpathSync.mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes('innocent-link')) return '/etc/shadow'
        return s
      })
      const result = listPathEntries(join(home, 'innocent-link'))
      expect(result).toEqual([])
      expect(mockReaddirSync).not.toHaveBeenCalled()
    })

    it('blocks dot-dot traversal that resolves outside safe roots', () => {
      // realpathSync resolves ../../ to a path outside home
      mockRealpathSync.mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes('..')) return '/var/secrets'
        return s
      })
      const result = listPathEntries(join(home, 'project', '..', '..', '..'))
      expect(result).toEqual([])
      expect(mockReaddirSync).not.toHaveBeenCalled()
    })

    it('allows paths under cwd even if cwd is outside home', () => {
      // On some systems cwd may not be under home (e.g. /opt/project)
      const cwd = process.cwd()
      const cwdSubpath = join(cwd, 'src')
      mockReaddirSync.mockReturnValue(['index.ts'])
      mockStatSync.mockReturnValue({ isDirectory: () => false })
      const result = listPathEntries(cwdSubpath)
      expect(result).toContainEqual({ name: 'index.ts', isDir: false })
    })

    it('returns empty array when realpathSync throws (non-existent path)', () => {
      mockRealpathSync.mockImplementation((p: any) => {
        if (String(p) === '/nonexistent') throw new Error('ENOENT')
        return String(p)
      })
      const result = listPathEntries('/nonexistent')
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
    it('returns [] when readdirSync throws', () => {
      mockReaddirSync.mockImplementation(() => { throw new Error('EPERM') })
      const result = listPathEntries(safePath)
      expect(result).toEqual([])
    })

    it('marks entries as isDir true or false based on statSync', () => {
      mockReaddirSync.mockReturnValue(['file.txt', 'subdir', 'link'])
      mockStatSync.mockImplementation((p: any) => ({
        isDirectory: () => String(p).endsWith('subdir'),
      }))
      const result = listPathEntries(safePath)
      expect(result).toContainEqual({ name: 'file.txt', isDir: false })
      expect(result).toContainEqual({ name: 'subdir', isDir: true })
      expect(result).toContainEqual({ name: 'link', isDir: false })
    })

    it('returns isDir: false when statSync throws for a specific entry', () => {
      mockReaddirSync.mockReturnValue(['good.txt', 'bad-entry'])
      mockStatSync.mockImplementation((p: any) => {
        if (String(p).includes('bad-entry')) throw new Error('EACCES')
        return { isDirectory: () => false }
      })
      const result = listPathEntries(safePath)
      expect(result).toContainEqual({ name: 'good.txt', isDir: false })
      expect(result).toContainEqual({ name: 'bad-entry', isDir: false })
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

  it('returns sorted list of PATH commands on non-Windows', () => {
    process.env.PATH = '/usr/bin'
    mockReaddirSync.mockReturnValue(['zebra', 'alpha', 'middle'])
    mockAccessSync.mockImplementation(() => undefined)
    const result = listPathCommands()
    expect(result).toEqual(['alpha', 'middle', 'zebra'])
  })

  it('deduplicates commands that appear in multiple PATH dirs', () => {
    process.env.PATH = '/usr/bin:/usr/local/bin'
    mockReaddirSync.mockReturnValue(['git', 'node'])
    mockAccessSync.mockImplementation(() => undefined)
    const result = listPathCommands()
    expect(result.filter((x: string) => x === 'git')).toHaveLength(1)
    expect(result.filter((x: string) => x === 'node')).toHaveLength(1)
  })

  it('on non-Windows skips non-executable files (accessSync throws)', () => {
    process.env.PATH = '/usr/bin'
    mockReaddirSync.mockReturnValue(['runnable', 'not-runnable'])
    mockAccessSync.mockImplementation((p: any) => {
      if (String(p).includes('not-runnable')) throw new Error('EACCES')
    })
    const result = listPathCommands()
    expect(result).toContain('runnable')
    expect(result).not.toContain('not-runnable')
  })

  it('returns cached result on second call within TTL', () => {
    process.env.PATH = '/usr/bin'
    mockReaddirSync.mockReturnValue(['git'])
    mockAccessSync.mockImplementation(() => undefined)
    listPathCommands() // first call — populates cache
    mockReaddirSync.mockReturnValue(['totally-different'])
    const second = listPathCommands() // second call — should use cache
    expect(second).toContain('git')
    expect(second).not.toContain('totally-different')
    expect(mockReaddirSync).toHaveBeenCalledTimes(1)
  })

  it('cache expires after TTL and returns fresh results', () => {
    process.env.PATH = '/usr/bin'
    mockReaddirSync.mockReturnValue(['git'])
    mockAccessSync.mockImplementation(() => undefined)

    let fakeNow = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)

    listPathCommands() // first call at t=1_000_000

    // Advance time beyond 5-minute TTL
    fakeNow += 6 * 60 * 1000
    mockReaddirSync.mockReturnValue(['fresh-command'])

    const second = listPathCommands()
    expect(second).toContain('fresh-command')
    expect(second).not.toContain('git')
  })

  it('returns [] when PATH is empty and all dirs are unreadable', () => {
    process.env.PATH = ''
    delete process.env.Path
    mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT') })
    const result = listPathCommands()
    expect(result).toEqual([])
  })
})
