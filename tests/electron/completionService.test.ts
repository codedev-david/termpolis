import { describe, it, expect, vi, beforeEach } from 'vitest'
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

const { listPathEntries, listEnvVars } = await import('../../src/main/completionService')

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
  })
})
