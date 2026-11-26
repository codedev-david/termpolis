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
  TERMINAL_TYPABLE_CHANNEL,
  READY_WAIT_MS,
  lumopolisTypable,
  type LumopolisTypingDeps,
  createLumopolisNonce,
  createOpenLimiter,
  askedAgain,
  shellOnly,
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

  it("refuses a folder of the shell's own on Windows (Git Bash, MSYS2 zsh or fish) with its own line, which says what to type instead (show)", async () => {
    const win = deps({ platform: 'win32', homedir: 'C:\\Users\\me' })
    expect(await resolveLumopolisOpen({ terminalId: 't1', payload: payload('/tmp'), cwd: '/c/Users/me' }, win)).toEqual({ success: false, error: shellOnly('/tmp'), show: true })
    expect(shellOnly('/usr')).toBe('lumopolis: /usr exists only inside this shell and has no Windows path, so it cannot be mapped. Use a folder on a drive, such as /c/Users.')
    // A rooted path elsewhere is a plain no-such-folder, and the forged-request refusals stay silent (no show).
    expect(await resolveLumopolisOpen({ terminalId: 't1', payload: payload('/nope') }, deps())).toMatchObject({ error: noSuchFolder('/nope') })
    expect(await resolveLumopolisOpen({ terminalId: 'x', payload: payload('/home/me/repo') }, deps())).not.toHaveProperty('show')
    expect(await resolveLumopolisOpen({ terminalId: 't1', payload: 'junk' }, deps())).not.toHaveProperty('show')
  })
})

describe('the open limiter (a program in the terminal knows the nonce, so it could ask over and over)', () => {
  it('calls the same folder from the same terminal within a few seconds a repeat, which opens nothing', () => {
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

  it('resolveLumopolisOpen applies it after the checks: a repeat and too many are both said (show), a repeat with the folder to open', async () => {
    let t = 0
    const limit = createOpenLimiter(() => t)
    const ask = (p: string) => resolveLumopolisOpen({ terminalId: 't1', payload: payload(p) }, deps(), limit)
    expect(await ask('/home/me/repo')).toEqual({ success: true, data: '/home/me/repo' })
    // Not silent: someone who closed the pane and typed it again at once gets a line with an Open button for the
    // folder, which opens only when they click it, so a program asking in a loop cannot keep reopening the pane.
    expect(await ask('/home/me/repo')).toEqual({ success: false, error: askedAgain('/home/me/repo'), show: true, folder: '/home/me/repo' })
    expect(askedAgain('/x')).toBe('lumopolis: /x was asked for a moment ago. Open brings it to the front.')
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
    expect(await h(null, { terminalId: 't1', payload: payload('repo'), cwd: root })).toEqual({ success: false, error: askedAgain(join(root, 'repo')), show: true, folder: join(root, 'repo') }) // the same folder again at once
  })

  it('keeps one limiter for the run, on the clock it is given', async () => {
    const handlers = new Map<string, (e: unknown, a?: unknown) => unknown>()
    let t = 0
    registerLumopolisIpc({ handle: (c, l) => handlers.set(c, l) }, deps({ now: () => t }))
    const h = handlers.get(TERMINAL_OPEN_CHANNEL) as (e: unknown, a?: unknown) => Promise<unknown>
    expect(await h(null, { terminalId: 't1', payload: payload('/home/me/repo') })).toMatchObject({ success: true })
    expect(await h(null, { terminalId: 't1', payload: payload('/home/me/repo') })).toMatchObject({ error: askedAgain('/home/me/repo'), folder: '/home/me/repo' })
    t += REPEAT_MS
    expect(await h(null, { terminalId: 't1', payload: payload('/home/me/repo') })).toMatchObject({ success: true })
  })
})

// #29. Whether typing lumopolis works in a terminal, for the sidebar hint's "or type lumopolis". bash, PowerShell, cmd and fish
// have it from what Termpolis started them with; zsh only once its ready mark came (a system zshenv that sets ZDOTDIR keeps
// Termpolis's .zshrc from running at all), so a zsh terminal is waited on until the mark or READY_WAIT_MS after it started.
describe('lumopolisTypable (#29)', () => {
  const ways: Record<string, 'defined' | 'reports' | 'none'> = { b: 'defined', z: 'reports', n: 'none' }
  const clocked = (over: Partial<LumopolisTypingDeps> = {}, startedAt = 0) => {
    let t = startedAt
    const slept: number[] = []
    const d: LumopolisTypingDeps = {
      way: (id) => (id in ways ? { way: ways[id], startedAt } : null),
      ready: () => false,
      now: () => t,
      sleep: async (ms) => { slept.push(ms); t += ms },
      ...over,
    }
    return { d, slept, now: () => t }
  }

  it('answers at once for a shell given it on start, and for one given none', async () => {
    const { d, slept } = clocked()
    expect(await lumopolisTypable({ terminalId: 'b' }, d)).toEqual({ success: true, data: true })
    expect(await lumopolisTypable({ terminalId: 'n' }, d)).toEqual({ success: true, data: false })
    expect(slept).toEqual([])
  })

  it('a zsh terminal is yes as soon as its ready mark is seen, before the wait is up', async () => {
    // eslint-disable-next-line prefer-const
    let c: ReturnType<typeof clocked>
    c = clocked({ ready: () => c.now() >= 750 })
    expect(await lumopolisTypable({ terminalId: 'z' }, c.d)).toEqual({ success: true, data: true })
    expect(c.now()).toBe(750)
    expect(c.slept.every((ms) => ms > 0 && ms <= 250)).toBe(true)
  })

  it('a zsh terminal with no mark is no once READY_WAIT_MS have passed since it started, and at once when they already have', async () => {
    const c = clocked()
    expect(await lumopolisTypable({ terminalId: 'z' }, c.d)).toEqual({ success: true, data: false })
    expect(c.now()).toBe(READY_WAIT_MS)
    const old = clocked()
    old.d.now = () => READY_WAIT_MS + 5
    expect(await lumopolisTypable({ terminalId: 'z' }, old.d)).toEqual({ success: true, data: false })
    expect(old.slept).toEqual([])
    // Asked long after a mark came: yes, with no wait.
    const marked = clocked({ ready: () => true })
    expect(await lumopolisTypable({ terminalId: 'z' }, marked.d)).toEqual({ success: true, data: true })
    expect(marked.slept).toEqual([])
  })

  it('stops waiting when the terminal closes, and refuses what names no terminal', async () => {
    // eslint-disable-next-line prefer-const
    let c: ReturnType<typeof clocked>
    c = clocked({ way: (id) => (id === 'z' && c.now() < 500 ? { way: 'reports', startedAt: 0 } : null) })
    expect(await lumopolisTypable({ terminalId: 'z' }, c.d)).toEqual({ success: false, error: NOT_A_TERMINAL })
    expect(c.now()).toBeLessThan(READY_WAIT_MS)
    for (const a of [undefined, null, 'z', {}, { terminalId: '' }, { terminalId: 7 }, { terminalId: 'gone' }]) {
      expect(await lumopolisTypable(a, c.d)).toEqual({ success: false, error: NOT_A_TERMINAL })
    }
  })

  it('is answered on world:terminal-typable, by the real clock when none is given', async () => {
    const handlers = new Map<string, (e: unknown, a?: unknown) => unknown>()
    // Started all but 120 ms of the wait ago, and no mark: no, after a real wait of about that long.
    const startedAt = Date.now() - READY_WAIT_MS + 120
    registerLumopolisIpc({ handle: (c, l) => handlers.set(c, l) }, {
      ...deps(),
      typing: { way: (id) => (id === 'z' ? { way: 'reports', startedAt } : null), ready: () => false },
    })
    const t0 = Date.now()
    expect(await handlers.get(TERMINAL_TYPABLE_CHANNEL)!(null, { terminalId: 'z' })).toEqual({ success: true, data: false })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100)
    // Without typing deps (a build or test that gives none) the channel is not registered.
    const bare = new Map<string, unknown>()
    registerLumopolisIpc({ handle: (c, l) => bare.set(c, l) }, deps())
    expect([...bare.keys()]).toEqual([TERMINAL_OPEN_CHANNEL])
  })
})
