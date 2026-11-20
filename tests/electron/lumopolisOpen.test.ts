import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  NEEDS_FULL_PATH,
  NOT_A_REQUEST,
  OPEN_LIMIT,
  REPEAT_MS,
  TOO_MANY,
  NOT_A_TERMINAL,
  TERMINAL_OPEN_CHANNEL,
  createLumopolisNonce,
  createOpenLimiter,
  gitBashOnly,
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

  it('refuses a relative folder without a terminal folder, saying so to the person (show)', async () => {
    expect(await resolveLumopolisOpen({ terminalId: 't1', payload: payload('sub') }, deps())).toEqual({ success: false, error: NEEDS_FULL_PATH, show: true })
  })

  it('refuses a missing folder and a file, naming the folder as the shell printed it (show)', async () => {
    expect(await resolveLumopolisOpen({ terminalId: 't1', payload: payload('/home/me/gone') }, deps())).toEqual({ success: false, error: noSuchFolder('/home/me/gone'), show: true })
    expect(noSuchFolder('/x')).toBe('lumopolis: no such folder: /x')
  })

  it("refuses a Git Bash-only folder on Windows with its own line, which says what to type instead (show)", async () => {
    const win = deps({ platform: 'win32', homedir: 'C:\\Users\\me' })
    expect(await resolveLumopolisOpen({ terminalId: 't1', payload: payload('/tmp'), cwd: '/c/Users/me' }, win)).toEqual({ success: false, error: gitBashOnly('/tmp'), show: true })
    expect(gitBashOnly('/usr')).toBe('lumopolis: /usr exists only inside Git Bash, so it cannot be mapped. Use a folder on a drive, such as /c/Users.')
    // A rooted path elsewhere is a plain no-such-folder, and the forged-request refusals stay silent (no show).
    expect(await resolveLumopolisOpen({ terminalId: 't1', payload: payload('/nope') }, deps())).toMatchObject({ error: noSuchFolder('/nope') })
    expect(await resolveLumopolisOpen({ terminalId: 'x', payload: payload('/home/me/repo') }, deps())).not.toHaveProperty('show')
    expect(await resolveLumopolisOpen({ terminalId: 't1', payload: 'junk' }, deps())).not.toHaveProperty('show')
  })
})

describe('the open limiter (a program in the terminal knows the nonce, so it could ask over and over)', () => {
  it('drops the same folder from the same terminal within a few seconds, silently', () => {
    let t = 1000
    const limit = createOpenLimiter(() => t)
    expect(limit('t1', '/a')).toBe('ok')
    t += REPEAT_MS - 1
    expect(limit('t1', '/a')).toBe('repeat')
    expect(limit('t2', '/a')).toBe('ok') // another terminal is its own
    expect(limit('t1', '/b')).toBe('ok') // another folder is a new ask
    t += 1
    expect(limit('t1', '/b')).toBe('repeat')
    t += REPEAT_MS
    expect(limit('t1', '/a')).toBe('ok')
  })

  it(`allows ${OPEN_LIMIT} opens a minute per terminal, then refuses until the oldest is a minute old`, () => {
    let t = 0
    const limit = createOpenLimiter(() => t)
    for (let i = 0; i < OPEN_LIMIT; i++) { expect(limit('t1', `/f${i}`)).toBe('ok'); t += 1000 }
    expect(limit('t1', '/more')).toBe('busy')
    expect(limit('t2', '/more')).toBe('ok')
    t = 60_000 // the first open (at 0) is now a minute old
    expect(limit('t1', '/more')).toBe('ok')
    expect(limit('t1', '/again')).toBe('busy')
  })

  it('uses the clock by default', () => {
    const limit = createOpenLimiter()
    expect(limit('t1', '/a')).toBe('ok')
    expect(limit('t1', '/a')).toBe('repeat')
  })

  it('resolveLumopolisOpen applies it after the checks: a repeat is dropped silently, too many is said (show)', async () => {
    let t = 0
    const limit = createOpenLimiter(() => t)
    const ask = (p: string) => resolveLumopolisOpen({ terminalId: 't1', payload: payload(p) }, deps(), limit)
    expect(await ask('/home/me/repo')).toEqual({ success: true, data: '/home/me/repo' })
    expect(await ask('/home/me/repo')).toEqual({ success: false, error: 'repeat' })
    expect(await ask('/home/me/gone')).toMatchObject({ error: noSuchFolder('/home/me/gone') }) // refused: not counted
    for (let i = 1; i < OPEN_LIMIT; i++) { t += REPEAT_MS; expect(await ask(i % 2 ? '/home/me/repo/sub' : '/home/me/repo')).toMatchObject({ success: true }) }
    t += REPEAT_MS
    expect(await ask('/home/me/repo/sub')).toEqual({ success: false, error: TOO_MANY, show: true })
    expect(TOO_MANY).toBe('lumopolis: too many requests from this terminal. Try again in a minute.')
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
    expect(await h(null, { terminalId: 't1', payload: payload(join(root, 'file.txt')) })).toEqual({ success: false, error: noSuchFolder(join(root, 'file.txt')), show: true })
    expect(await h(null, { terminalId: 't1', payload: payload('repo'), cwd: root })).toEqual({ success: false, error: 'repeat' }) // the same folder again at once
  })

  it('keeps one limiter for the run, on the clock it is given', async () => {
    const handlers = new Map<string, (e: unknown, a?: unknown) => unknown>()
    let t = 0
    registerLumopolisIpc({ handle: (c, l) => handlers.set(c, l) }, deps({ now: () => t }))
    const h = handlers.get(TERMINAL_OPEN_CHANNEL) as (e: unknown, a?: unknown) => Promise<unknown>
    expect(await h(null, { terminalId: 't1', payload: payload('/home/me/repo') })).toMatchObject({ success: true })
    expect(await h(null, { terminalId: 't1', payload: payload('/home/me/repo') })).toMatchObject({ error: 'repeat' })
    t += REPEAT_MS
    expect(await h(null, { terminalId: 't1', payload: payload('/home/me/repo') })).toMatchObject({ success: true })
  })
})
