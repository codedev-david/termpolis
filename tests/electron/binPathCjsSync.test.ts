// The anti-drift guard for git's path in the Commit Shield hook (#1).
//
// The hook runs in a plain `node` started by git, with Termpolis possibly closed, so it cannot load
// src/main/binPath.ts; src/mcp-adapter/binPath.cjs is its synchronous twin. Two copies of a security rule drift
// apart quietly, so this runs both on the same inputs (PATH shapes that must be skipped, the current folder, the
// install locations, links into the repository) and fails if they ever answer differently.
//
// If this test fails: DO NOT loosen it. Make binPath.cjs follow binPath.ts.
import { afterAll, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { binInside, commandOnPath, findGit, gitInstallCandidates, insideFolder } from '../../src/main/binPath'

type Env = Record<string, string | undefined>
interface Twin {
  FIXED_WIN_DIR: RegExp
  commandOnPathSync: (name: string, env: Env, platform: NodeJS.Platform, runnable: (f: string) => void, cwd?: string) => string | null
  gitInstallCandidates: (platform: NodeJS.Platform) => string[]
  findGitSync: (env: Env, platform: NodeJS.Platform, runnable: (f: string) => void, cwd?: string) => string | null
  insideFolder: (file: string, root: string) => boolean
  binInsideSync: (file: string, root: string, realpath: (p: string) => string) => boolean
  assertRunnableFileSync: (file: string) => void
  gitFor: (cwd: string, env?: Env, platform?: NodeJS.Platform) => string | null
}
const twin = createRequire(import.meta.url)('../../src/mcp-adapter/binPath.cjs') as Twin

const PLATFORMS: NodeJS.Platform[] = ['win32', 'linux', 'darwin']

/** The same disk for both: `files` exist and may be run, anything else throws. */
const disk = (files: string[]) => {
  const has = (f: string): boolean => files.includes(f)
  return {
    sync: (f: string): void => { if (!has(f)) throw new Error('ENOENT') },
    async: async (f: string): Promise<void> => { if (!has(f)) throw new Error('ENOENT') },
  }
}

const WIN_FILES = [
  'C:\\repo\\git.exe', 'C:\\repo\\tools\\git.exe', 'tools\\git.exe', '\\tools\\git.exe', 'C:tools\\git.exe', 'git.exe',
  'D:\\Git\\cmd\\git.exe', '\\\\server\\share\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe',
  'E:\\only.cmd\\git.cmd', 'F:\\x\\git',
]
const POSIX_FILES = ['/repo/git', '/repo/tools/git', 'tools/git', 'git', '/opt/git/bin/git', '/usr/bin/git', '/usr/local/bin/git']

const PATHS: Env[] = [
  {},
  { PATH: '' },
  { Path: 'D:\\Git\\cmd' }, // Windows' own spelling
  { PATH: 'tools;D:\\Git\\cmd' },
  { PATH: '.;;D:\\Git\\cmd' },
  { PATH: '\\tools;C:tools;D:\\Git\\cmd' },
  { PATH: 'C:\\repo;D:\\Git\\cmd' },
  { PATH: 'c:\\REPO\\;D:\\Git\\cmd' }, // the current folder, spelled another way
  { PATH: 'C:\\repo\\tools;D:\\Git\\cmd' }, // fixed, but inside the repository: found here, refused by binInside
  { PATH: '"D:\\Git\\cmd"' },
  { PATH: '\\\\server\\share;D:\\Git\\cmd' },
  { PATH: 'E:\\only.cmd;F:\\x' }, // no git.exe: the install locations answer
  { PATH: 'tools:/opt/git/bin' },
  { PATH: '.::/opt/git/bin' },
  { PATH: '/repo:/opt/git/bin' },
  { PATH: '/repo/:/opt/git/bin' },
  { PATH: '/repo/tools:/usr/local/bin' },
  { PATH: '/nowhere' },
]
const CWDS = [undefined, 'C:\\repo', '/repo']

describe('binPath.cjs answers exactly as binPath.ts', () => {
  it('the same install locations and the same fixed-folder rule', () => {
    for (const platform of PLATFORMS) expect(twin.gitInstallCandidates(platform)).toEqual(gitInstallCandidates(platform))
    expect(twin.gitInstallCandidates('freebsd')).toEqual(gitInstallCandidates('freebsd'))
    const ts = /\nconst FIXED_WIN_DIR = \/(.+)\/\r?\n/.exec(readFileSync(join(__dirname, '../../src/main/binPath.ts'), 'utf8'))
    expect(ts, 'binPath.ts still defines FIXED_WIN_DIR').not.toBeNull()
    expect(twin.FIXED_WIN_DIR.source).toBe(ts![1])
  })

  it('the same git found, or none, for every PATH shape, current folder and platform', async () => {
    let compared = 0
    for (const platform of PLATFORMS) {
      const d = disk(platform === 'win32' ? WIN_FILES : POSIX_FILES)
      for (const env of PATHS) {
        for (const cwd of CWDS) {
          const label = `${platform} ${JSON.stringify(env)} cwd=${cwd}`
          expect(twin.commandOnPathSync('git', env, platform, d.sync, cwd), label).toBe(await commandOnPath('git', env, platform, d.async, cwd))
          expect(twin.findGitSync(env, platform, d.sync, cwd), label).toBe(await findGit(env, platform, d.async, cwd))
          compared++
        }
      }
    }
    expect(compared).toBe(PLATFORMS.length * PATHS.length * CWDS.length)
    // And the cases that matter, spelled out: nothing relative, empty or in the current folder answers.
    const w = disk(WIN_FILES)
    expect(twin.findGitSync({ PATH: 'tools;.;;C:\\repo;D:\\Git\\cmd' }, 'win32', w.sync, 'C:\\repo')).toBe('D:\\Git\\cmd\\git.exe')
    expect(twin.findGitSync({ PATH: 'E:\\only.cmd' }, 'win32', w.sync)).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    const p = disk(POSIX_FILES)
    expect(twin.findGitSync({ PATH: 'tools:.::/repo:/opt/git/bin' }, 'linux', p.sync, '/repo')).toBe('/opt/git/bin/git')
    expect(twin.findGitSync({ PATH: '/nowhere' }, 'linux', disk([]).sync)).toBeNull()
  })

  it('the same inside-the-folder answer, as written and through links', async () => {
    const cases: [string, string][] = [
      ['C:\\repo\\tools\\git.exe', 'C:\\repo'], ['c:/REPO/tools/git.exe', 'C:\\repo\\'], ['C:\\repository\\git.exe', 'C:\\repo'],
      ['C:\\repo', 'C:\\repo'], ['/repo/tools/git', '/repo'], ['/repo2/git', '/repo'], ['/usr/bin/git', '/repo'],
      ['D:\\link\\git.exe', 'C:\\repo'], ['/link/git', '/repo'], ['/gone/git', '/repo'],
    ]
    const links: Record<string, string> = { 'D:\\link\\git.exe': 'C:\\repo\\bin\\git.exe', '/link/git': '/repo/bin/git' }
    const syncReal = (p: string): string => { if (p.startsWith('/gone')) throw new Error('ENOENT'); return links[p] ?? p }
    const asyncReal = async (p: string): Promise<string> => syncReal(p)
    for (const [file, root] of cases) {
      expect(twin.insideFolder(file, root), `${file} in ${root}`).toBe(insideFolder(file, root))
      expect(twin.binInsideSync(file, root, syncReal), `${file} in ${root}`).toBe(await binInside(file, root, asyncReal))
    }
    expect(twin.binInsideSync('D:\\link\\git.exe', 'C:\\repo', syncReal)).toBe(true)
    expect(twin.binInsideSync('/gone/git', '/repo', syncReal)).toBe(false)
  })
})

describe('binPath.cjs on the real disk', () => {
  const roots: string[] = []
  afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
  const win = process.platform === 'win32'
  const gitName = win ? 'git.exe' : 'git'

  it('assertRunnableFileSync: a program passes; a folder, or a missing file, throws', () => {
    expect(() => twin.assertRunnableFileSync(process.execPath)).not.toThrow()
    const root = mkdtempSync(join(tmpdir(), 'tp-binpath-'))
    roots.push(root)
    mkdirSync(join(root, gitName))
    expect(() => twin.assertRunnableFileSync(join(root, gitName))).toThrow('not a file')
    expect(() => twin.assertRunnableFileSync(join(root, 'missing'))).toThrow()
  })

  it('gitFor refuses a git inside the folder it would run in, and answers null when there is none', () => {
    const root = mkdtempSync(join(tmpdir(), 'tp-binpath-'))
    roots.push(root)
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', gitName), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const env = { PATH: join(root, 'bin') }
    // Found on the (fixed) PATH, then refused: it lies inside the repository.
    expect(twin.findGitSync(env, process.platform, twin.assertRunnableFileSync, root)).toBe(join(root, 'bin', gitName))
    expect(twin.gitFor(root, env, process.platform)).toBeNull()
    // Outside it, the same git is the answer.
    const elsewhere = mkdtempSync(join(tmpdir(), 'tp-binpath-'))
    roots.push(elsewhere)
    expect(twin.gitFor(elsewhere, env, process.platform)).toBe(join(root, 'bin', gitName))
    // No PATH, and the other platform's install locations are not on this disk: no git at all.
    expect(twin.gitFor(elsewhere, { PATH: '' }, win ? 'linux' : 'win32')).toBeNull()
  })

  it('gitFor with no env or platform given uses this process: the git it finds is a full path', () => {
    const root = mkdtempSync(join(tmpdir(), 'tp-binpath-'))
    roots.push(root)
    const found = twin.gitFor(root)
    // Every machine this suite runs on has git (the CI images on all three systems, and a developer's checkout), so
    // none found is a failure, not a pass (M6).
    expect(found).not.toBeNull()
    expect(found).toMatch(win ? /^(?:[A-Za-z]:\\|\\\\)/ : /^\//)
  })
})
