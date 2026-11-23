// WPA item 4: one folder, one key, however the path is spelled.
import { describe, it, expect, vi } from 'vitest'
import * as crypto from 'crypto'
import {
  canonicalProjectPath, projectKeyOf, legacyProjectKeyOf, projectKeyAliases, expandShortPath, hasShortPart,
} from '../../src/main/projectKey'

const sha = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)

describe('canonicalProjectPath', () => {
  it('a Windows path, its Git Bash spelling, other case, doubled and trailing separators: one spelling', () => {
    const forms = [
      'C:\\Users\\David\\repos\\termpolis',
      'c:/users/david/repos/termpolis',
      '/c/Users/David/repos/termpolis',
      '/C/Users/David/repos/termpolis/',
      '/cygdrive/c/Users/David/repos/termpolis',
      'C:\\Users\\David\\\\repos\\termpolis\\\\',
      '  C:/Users/DAVID/Repos/Termpolis  ',
    ]
    for (const f of forms) expect(canonicalProjectPath(f, 'win32')).toBe('c:/users/david/repos/termpolis')
  })
  it('the Git Bash drive is only read as a drive on Windows', () => {
    expect(canonicalProjectPath('/c/Users/x', 'linux')).toBe('/c/users/x')
    expect(canonicalProjectPath('/c/Users/x', 'darwin')).toBe('/c/users/x')
  })
  it('a one-letter folder that is not first, or a longer first folder, is left alone', () => {
    expect(canonicalProjectPath('/repo/c/x', 'win32')).toBe('/repo/c/x')
    expect(canonicalProjectPath('/cc/x', 'win32')).toBe('/cc/x')
  })
  it('a one-letter root folder (`/r`, or a bare `/c`) keeps the spelling, and so the key, it had before WPA', () => {
    expect(canonicalProjectPath('/r', 'win32')).toBe('/r')
    expect(canonicalProjectPath('/c/', 'win32')).toBe('/c')
    expect(projectKeyOf('/r', 'win32')).toBe(legacyProjectKeyOf('/r'))
  })
  it('a UNC share keeps its leading pair of separators', () => {
    expect(canonicalProjectPath('\\\\server\\share\\repo', 'win32')).toBe('//server/share/repo')
  })
  it('a bare name, a bare drive, empty and non-text are not paths', () => {
    expect(canonicalProjectPath('termpolis', 'win32')).toBe('')
    expect(canonicalProjectPath('C:\\', 'win32')).toBe('')
    expect(canonicalProjectPath('   ', 'win32')).toBe('')
    expect(canonicalProjectPath(undefined as unknown as string, 'win32')).toBe('')
  })
  it('defaults to this platform', () => {
    expect(canonicalProjectPath('/repo/a')).toBe('/repo/a')
  })
})

describe('projectKeyOf', () => {
  it('every spelling of one folder gives one key', () => {
    const keys = new Set(['C:\\R\\termpolis', '/c/R/termpolis', 'c:/r/termpolis/', 'C:\\R\\\\termpolis'].map((f) => projectKeyOf(f, 'win32')))
    expect(keys.size).toBe(1)
  })
  it('a key written before WPA from a Windows path is unchanged (no stored note changes key)', () => {
    expect(projectKeyOf('C:\\Users\\DavidEngelhart\\repos\\termpolis', 'win32')).toBe(sha('c:/users/davidengelhart/repos/termpolis'))
    expect(projectKeyOf('/home/me/repo', 'linux')).toBe(sha('/home/me/repo'))
    expect(projectKeyOf('/home/me/repo')).toBe(legacyProjectKeyOf('/home/me/repo'))
  })
  it('two folders with one name never share a key; a bare name has none', () => {
    expect(projectKeyOf('/work/acme/api', 'linux')).not.toBe(projectKeyOf('/work/globex/api', 'linux'))
    expect(projectKeyOf('api', 'linux')).toBeUndefined()
  })
})

describe('legacyProjectKeyOf and projectKeyAliases', () => {
  it('the legacy key is the old hash of this exact spelling', () => {
    expect(legacyProjectKeyOf('/c/Users/X/repo')).toBe(sha('/c/users/x/repo'))
    expect(legacyProjectKeyOf('repo')).toBeUndefined()
  })
  it('a Windows path also matches notes written from Git Bash', () => {
    const a = projectKeyAliases('C:\\Users\\X\\repo', 'win32')
    expect(a).toEqual([sha('c:/users/x/repo'), sha('/c/users/x/repo')])
  })
  it('a Git Bash path matches the canonical key and its own old key', () => {
    expect(projectKeyAliases('/c/Users/X/repo', 'win32')).toEqual([sha('c:/users/x/repo'), sha('/c/users/x/repo')])
  })
  it('doubled separators: the old key of that spelling is kept as an alias', () => {
    expect(projectKeyAliases('/home/x//repo', 'linux')).toEqual([sha('/home/x/repo'), sha('/home/x//repo')])
  })
  it('on Linux a plain path has one key, and a bare name none', () => {
    expect(projectKeyAliases('/home/x/repo', 'linux')).toEqual([sha('/home/x/repo')])
    expect(projectKeyAliases('repo', 'linux')).toEqual([])
  })
  it('a drive root folder path keeps its alias', () => {
    expect(projectKeyAliases('D:\\repo', 'win32')).toEqual([sha('d:/repo'), sha('/d/repo')])
  })
  it('defaults to this platform', () => {
    expect(projectKeyAliases('/repo/a')[0]).toBe(projectKeyOf('/repo/a'))
  })
})

describe('expandShortPath (8.3 names)', () => {
  it('resolves a path with a short part to its long form, once', async () => {
    const realpath = vi.fn(async () => 'C:\\Users\\DavidEngelhart\\repos\\t')
    expect(await expandShortPath('C:\\Users\\DAVIDE~1\\repos\\t', 'win32', realpath)).toBe('C:\\Users\\DavidEngelhart\\repos\\t')
    expect(realpath).toHaveBeenCalledTimes(1)
    expect(projectKeyOf(await expandShortPath('C:\\Users\\DAVIDE~1\\repos\\t', 'win32', realpath), 'win32'))
      .toBe(projectKeyOf('C:\\Users\\DavidEngelhart\\repos\\t', 'win32'))
  })
  it('a path with no short part, another platform, or non-text is never resolved', async () => {
    const realpath = vi.fn(async () => 'x')
    expect(await expandShortPath('C:\\Users\\David\\repos', 'win32', realpath)).toBe('C:\\Users\\David\\repos')
    expect(await expandShortPath('/home/a~1/x', 'linux', realpath)).toBe('/home/a~1/x')
    expect(await expandShortPath(5 as unknown as string, 'win32', realpath)).toBe(5)
    expect(realpath).not.toHaveBeenCalled()
  })
  it('a path that cannot be resolved, or an empty answer, comes back as it was', async () => {
    expect(await expandShortPath('C:\\NOPE~1\\x', 'win32', async () => { throw new Error('ENOENT') })).toBe('C:\\NOPE~1\\x')
    expect(await expandShortPath('C:\\NOPE~1\\x', 'win32', async () => '')).toBe('C:\\NOPE~1\\x')
  })
  it('hasShortPart: only a Windows path with a short-looking part', () => {
    expect(hasShortPart('C:\\Users\\DAVIDE~1\\x', 'win32')).toBe(true)
    expect(hasShortPart('C:\\Users\\David\\x', 'win32')).toBe(false)
    expect(hasShortPart('C:\\Users\\DAVIDE~1\\x', 'linux')).toBe(false)
    expect(hasShortPart(7, 'win32')).toBe(false)
    expect(typeof hasShortPart('/x')).toBe('boolean')
  })
  it('defaults: the real realpath on this platform never throws', async () => {
    const out = await expandShortPath('C:\\DOES-NOT~1\\EXIST~2')
    expect(typeof out).toBe('string')
  })
})
