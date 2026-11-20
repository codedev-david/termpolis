import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  NEEDS_FULL_PATH,
  NOT_A_REQUEST,
  NOT_A_TERMINAL,
  TERMINAL_OPEN_CHANNEL,
  createLumopolisNonce,
  folderOf,
  lumopolisNonce,
  noSuchFolder,
  registerLumopolisIpc,
  resolveLumopolisOpen,
  type LumopolisOpenDeps,
} from '../../src/main/world/lumopolisOpen'
import { LUMOPOLIS_MAX_PAYLOAD } from '../../src/shared/world/lumopolisCommand'

const N = 'aaaabbbbccccddddeeeeffff00001111'
const payload = (p: string, nonce = N): string => `lumopolis;${nonce};${p}`

const dirs = new Set(['/home/me/repo', '/home/me/repo/sub', 'C:\\Users\\me\\repo', 'C:\\'])
const deps = (over: Partial<LumopolisOpenDeps> = {}): LumopolisOpenDeps => ({
  nonce: N,
  hasTerminal: (id) => id === 't1',
  isDirectory: async (p) => dirs.has(p),
  platform: 'linux',
  homedir: '/home/me',
  ...over,
})

describe('the run nonce', () => {
  it('is 32 hex characters, random per call, and one value for the whole run', () => {
    expect(createLumopolisNonce()).toMatch(/^[0-9a-f]{32}$/)
    expect(createLumopolisNonce()).not.toBe(createLumopolisNonce())
    expect(lumopolisNonce()).toMatch(/^[0-9a-f]{32}$/)
    expect(lumopolisNonce()).toBe(lumopolisNonce())
  })
})

describe('folderOf', () => {
  it('keeps an absolute POSIX folder, collapsing .. and expanding ~', () => {
    expect(folderOf('/home/me/repo/sub/..', null, 'linux', '/home/me')).toBe('/home/me/repo')
    expect(folderOf('~/repo', null, 'linux', '/home/me')).toBe('/home/me/repo')
  })

  it('reads every Windows dialect a shell prints', () => {
    expect(folderOf('/c/Users/me/repo', null, 'win32', 'C:\\Users\\me')).toBe('C:\\Users\\me\\repo')
    expect(folderOf('C:/Users/me/repo/', null, 'win32', 'C:\\Users\\me')).toBe('C:\\Users\\me\\repo')
    expect(folderOf('C:\\Users\\me\\repo\\sub\\..', null, 'win32', 'C:\\Users\\me')).toBe('C:\\Users\\me\\repo')
    expect(folderOf('\\\\server\\share\\x', null, 'win32', 'C:\\Users\\me')).toBe('\\\\server\\share\\x')
  })

  it('resolves a relative folder against the terminal folder, and refuses one with no terminal folder', () => {
    expect(folderOf('sub', '/home/me/repo', 'linux', '/home/me')).toBe('/home/me/repo/sub')
    expect(folderOf('..\\repo', '/c/Users/me/x', 'win32', 'C:\\Users\\me')).toBe('C:\\Users\\me\\repo')
    expect(folderOf('sub', null, 'linux', '/home/me')).toBeNull()
    expect(folderOf('sub', 'relative/too', 'linux', '/home/me')).toBeNull()
  })

  it('refuses a rooted path the platform cannot open', () => {
    expect(folderOf('/usr/bin', 'C:\\Users\\me', 'win32', 'C:\\Users\\me')).toBeNull()
  })
})

describe('resolveLumopolisOpen', () => {
  it('answers the folder of a valid request', async () => {
    expect(await resolveLumopolisOpen({ terminalId: 't1', payload: payload('/home/me/repo') }, deps())).toEqual({ success: true, data: '/home/me/repo' })
    expect(await resolveLumopolisOpen({ terminalId: 't1', payload: payload('sub'), cwd: '/home/me/repo' }, deps())).toEqual({ success: true, data: '/home/me/repo/sub' })
  })

  it('refuses a request from no terminal, or one Termpolis did not start', async () => {
    expect(await resolveLumopolisOpen(undefined, deps())).toEqual({ success: false, error: NOT_A_TERMINAL })
    expect(await resolveLumopolisOpen({ payload: payload('/home/me/repo') }, deps())).toEqual({ success: false, error: NOT_A_TERMINAL })
    expect(await resolveLumopolisOpen({ terminalId: 'stranger', payload: payload('/home/me/repo') }, deps())).toEqual({ success: false, error: NOT_A_TERMINAL })
  })

  it('refuses a malformed, over-long or wrong-nonce payload', async () => {
    const isDirectory = vi.fn(async () => true)
    for (const p of ['junk', payload('/home/me/repo', 'ffffffffffffffffffffffffffffffff'), payload('/' + 'a'.repeat(LUMOPOLIS_MAX_PAYLOAD))]) {
      expect(await resolveLumopolisOpen({ terminalId: 't1', payload: p }, deps({ isDirectory }))).toEqual({ success: false, error: NOT_A_REQUEST })
    }
    expect(isDirectory).not.toHaveBeenCalled()
  })

  it('refuses a relative folder without a terminal folder', async () => {
    expect(await resolveLumopolisOpen({ terminalId: 't1', payload: payload('sub') }, deps())).toEqual({ success: false, error: NEEDS_FULL_PATH })
  })

  it('refuses a missing folder and a file, naming the folder as the shell printed it', async () => {
    expect(await resolveLumopolisOpen({ terminalId: 't1', payload: payload('/home/me/gone') }, deps())).toEqual({ success: false, error: noSuchFolder('/home/me/gone') })
    expect(noSuchFolder('/x')).toBe('lumopolis: no such folder: /x')
  })
})

describe('registerLumopolisIpc on a real file system', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumopolis-open-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('answers on world:terminal-open: a directory opens, a file does not', async () => {
    mkdirSync(join(root, 'repo'))
    writeFileSync(join(root, 'file.txt'), 'x')
    const handlers = new Map<string, (e: unknown, a?: unknown) => unknown>()
    const { stat } = await import('fs/promises')
    registerLumopolisIpc({ handle: (c, l) => handlers.set(c, l) }, deps({
      platform: process.platform,
      isDirectory: (p) => stat(p).then((s) => s.isDirectory(), () => false),
    }))
    const h = handlers.get(TERMINAL_OPEN_CHANNEL) as (e: unknown, a?: unknown) => Promise<unknown>
    expect(await h(null, { terminalId: 't1', payload: payload(join(root, 'repo')) })).toEqual({ success: true, data: join(root, 'repo') })
    expect(await h(null, { terminalId: 't1', payload: payload(join(root, 'file.txt')) })).toEqual({ success: false, error: noSuchFolder(join(root, 'file.txt')) })
    expect(await h(null, { terminalId: 't1', payload: payload('repo'), cwd: root })).toEqual({ success: true, data: join(root, 'repo') })
  })
})
