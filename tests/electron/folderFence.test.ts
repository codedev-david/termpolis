import { describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  FOLDER_NETWORK,
  FOLDER_NOT_FOUND,
  FOLDER_OUTSIDE_FENCE,
  fenceFolder,
  isInsideFence,
  isNetworkOrDevicePath,
  isOnAllowedDrive,
  isWithin,
  realHome,
} from '../../src/main/remoteBridge/folderFence'

/** A Windows desktop: home on C:, a projects drive D:, and links that lead
 *  where the map says. Paths not in the map do not exist. */
function windowsDesktop(links: Record<string, string> = {}) {
  const real = (p: string): string => {
    const key = p.toLowerCase().replace(/\//g, '\\')
    for (const [from, to] of Object.entries(links)) {
      const f = from.toLowerCase()
      if (key === f || key.startsWith(f + '\\')) return to + p.slice(from.length)
    }
    return p
  }
  const exists = ['c:\\users\\dev', 'c:\\users\\dev\\repo', 'c:\\windows', 'd:\\projects', 'd:\\', 'c:\\', 'c:\\users\\dev\\link']
  return {
    home: 'C:\\Users\\dev',
    platform: 'win32' as const,
    systemDrive: 'C:',
    realpath: async (p: string): Promise<string> => {
      const r = real(p)
      if (!exists.includes(r.toLowerCase())) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return r
    },
  }
}

describe('isWithin', () => {
  it('compares Windows paths without regard to case or slash direction', () => {
    expect(isWithin('c:/USERS/dev/repo', 'C:\\Users\\dev', 'win32')).toBe(true)
    expect(isWithin('C:\\Users\\dev', 'c:\\users\\DEV', 'win32')).toBe(true)
  })

  it('does not count a sibling that shares a prefix', () => {
    expect(isWithin('C:\\Users\\devil', 'C:\\Users\\dev', 'win32')).toBe(false)
    expect(isWithin('/home/devil', '/home/dev', 'linux')).toBe(false)
  })

  it('is case-sensitive on POSIX', () => {
    expect(isWithin('/home/Dev/x', '/home/dev', 'linux')).toBe(false)
    expect(isWithin('/home/dev/x', '/home/dev', 'linux')).toBe(true)
  })

  it('accepts a parent that already ends in a separator', () => {
    expect(isWithin('D:\\work', 'D:\\', 'win32')).toBe(true)
    expect(isWithin('/x', '/', 'linux')).toBe(true)
  })
})

describe('isOnAllowedDrive', () => {
  it('allows any Windows drive but the system one', () => {
    expect(isOnAllowedDrive('D:\\', { platform: 'win32', systemDrive: 'C:' })).toBe(true)
    expect(isOnAllowedDrive('d:/x', { platform: 'win32', systemDrive: 'C:' })).toBe(true)
    expect(isOnAllowedDrive('C:\\Windows', { platform: 'win32', systemDrive: 'C:' })).toBe(false)
    expect(isOnAllowedDrive('D:', { platform: 'win32', systemDrive: 'd' })).toBe(false)
  })

  it('refuses a path with no drive letter, and every path on POSIX', () => {
    expect(isOnAllowedDrive('\\rooted', { platform: 'win32', systemDrive: 'C:' })).toBe(false)
    expect(isOnAllowedDrive('Dx\\', { platform: 'win32', systemDrive: 'C:' })).toBe(false)
    expect(isOnAllowedDrive('/mnt/data', { platform: 'linux' })).toBe(false)
    expect(isOnAllowedDrive('D:\\', { platform: 'darwin' })).toBe(false)
  })

  it('reads the system drive from Windows when none is given, and C: when Windows says nothing usable', () => {
    const saved = process.env.SystemDrive
    try {
      process.env.SystemDrive = 'E:'
      expect(isOnAllowedDrive('E:\\x', { platform: 'win32' })).toBe(false)
      expect(isOnAllowedDrive('C:\\x', { platform: 'win32' })).toBe(true)
      process.env.SystemDrive = 'nonsense'
      expect(isOnAllowedDrive('C:\\x', { platform: 'win32' })).toBe(false)
      delete process.env.SystemDrive
      expect(isOnAllowedDrive('C:\\x', { platform: 'win32' })).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.SystemDrive
      else process.env.SystemDrive = saved
    }
  })

  it('defaults to this machine\'s platform', () => {
    expect(isOnAllowedDrive('/')).toBe(false)
  })
})

describe('isInsideFence', () => {
  const win = { platform: 'win32' as const, systemDrive: 'C:' }
  it('is home and below, or another drive, never a network path', () => {
    expect(isInsideFence('C:\\Users\\dev\\repo', 'C:\\Users\\dev', win)).toBe(true)
    expect(isInsideFence('D:\\projects', 'C:\\Users\\dev', win)).toBe(true)
    expect(isInsideFence('C:\\Windows', 'C:\\Users\\dev', win)).toBe(false)
    expect(isInsideFence('\\\\host\\share', 'C:\\Users\\dev', win)).toBe(false)
    expect(isInsideFence('/etc', '/home/dev', { platform: 'linux' })).toBe(false)
    expect(isInsideFence('/home/dev/x', '/home/dev', { platform: 'linux' })).toBe(true)
  })

  it('defaults to this machine\'s platform', () => {
    expect(isInsideFence(join('a', 'b'), 'a')).toBe(true)
  })
})

describe('isNetworkOrDevicePath', () => {
  it.each([
    ['\\\\host\\share', true],
    ['//host/share', true],
    ['\\\\?\\C:\\', true],
    ['C:\\x', false],
    ['/x', false],
  ])('%j is %s', (p, expected) => {
    expect(isNetworkOrDevicePath(p)).toBe(expected)
  })
})

describe('realHome', () => {
  it('is the real home folder, or the plain one when it cannot be resolved', async () => {
    expect(await realHome({ home: '/h', realpath: async () => '/real/h' })).toBe('/real/h')
    expect(await realHome({ home: '/h', realpath: async () => { throw new Error('gone') } })).toBe('/h')
  })

  it('defaults to this machine\'s home and real path', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tp-fence-')))
    try {
      expect(await realHome({ home: dir })).toBe(dir)
      expect(typeof (await realHome())).toBe('string')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('fenceFolder', () => {
  it('accepts a folder under home and answers its real path', async () => {
    expect(await fenceFolder('C:\\Users\\dev\\repo', windowsDesktop())).toEqual({ ok: true, path: 'C:\\Users\\dev\\repo' })
  })

  it('takes a relative folder from home', async () => {
    // resolve() is the host's: only meaningful against a home of the host's form.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tp-fence-rel-')))
    try {
      expect(await fenceFolder('.', { home: dir })).toEqual({ ok: true, path: dir })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts another drive, as the picker offers it', async () => {
    expect(await fenceFolder('D:\\projects', windowsDesktop())).toEqual({ ok: true, path: 'D:\\projects' })
  })

  it('refuses the system drive outside home, whatever the case', async () => {
    expect(await fenceFolder('c:\\WINDOWS', windowsDesktop())).toEqual({ ok: false, reason: FOLDER_OUTSIDE_FENCE })
    expect(await fenceFolder('C:\\', windowsDesktop())).toEqual({ ok: false, reason: FOLDER_OUTSIDE_FENCE })
  })

  it('refuses a link under home that leads out of the fence', async () => {
    const desk = windowsDesktop({ 'C:\\Users\\dev\\link': 'C:\\Windows' })
    expect(await fenceFolder('C:\\Users\\dev\\link', desk)).toEqual({ ok: false, reason: FOLDER_OUTSIDE_FENCE })
  })

  it('refuses a network path before touching the filesystem, and a link that leads to one', async () => {
    let touched = false
    const desk = { ...windowsDesktop(), realpath: async (p: string) => { touched = true; return p } }
    expect(await fenceFolder('\\\\host\\share', desk)).toEqual({ ok: false, reason: FOLDER_NETWORK })
    expect(touched).toBe(false)
    const toShare = { ...windowsDesktop(), realpath: async (p: string) => (p === 'C:\\Users\\dev' ? p : '\\\\host\\share') }
    expect(await fenceFolder('C:\\Users\\dev\\mapped', toShare)).toEqual({ ok: false, reason: FOLDER_NETWORK })
  })

  it('reads the paths of a POSIX desktop by POSIX rules', async () => {
    const posixDesk = { home: '/home/dev', platform: 'linux' as const, realpath: async (p: string) => p }
    expect(await fenceFolder('repo', posixDesk)).toEqual({ ok: true, path: '/home/dev/repo' })
    expect(await fenceFolder('/home/dev/../../etc', posixDesk)).toEqual({ ok: false, reason: FOLDER_OUTSIDE_FENCE })
  })

  it('refuses a folder that does not exist', async () => {
    expect(await fenceFolder('C:\\Users\\dev\\nope', windowsDesktop())).toEqual({ ok: false, reason: FOLDER_NOT_FOUND })
  })

  it('resolves `..` on the real filesystem before judging', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'tp-fence-home-')))
    try {
      const out = await fenceFolder(join(home, '..'), { home, platform: process.platform, systemDrive: home.slice(0, 2) })
      expect(out).toEqual({ ok: false, reason: FOLDER_OUTSIDE_FENCE })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
