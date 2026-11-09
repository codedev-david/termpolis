// The hidden sign-in session's PTY (accountsIpc.spawnSignInPty, perf155 P14): on Windows with the pty host up it opens
// there, with a failed spawn turned into output plus an exit (the session has no throw to catch); otherwise node-pty
// in main, as before.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createRequire } from 'module'

const h = vi.hoisted(() => ({
  ready: vi.fn(() => true),
  hosted: vi.fn(() => ({ pid: 0, hosted: true })),
  spawn: vi.fn(() => ({ pid: 9, hosted: false })),
}))
vi.mock('../../src/main/ptyHostClient', () => ({ ptyHostReady: h.ready, spawnInPtyHost: h.hosted }))
// accountsIpc reaches node-pty through require(), which vi.mock does not see: the fake goes in require's own cache.
const req = createRequire(import.meta.url)
const ptyPath = req.resolve('node-pty')
const realPty = req.cache[ptyPath]
req.cache[ptyPath] = { id: ptyPath, filename: ptyPath, loaded: true, exports: { spawn: h.spawn } } as unknown as NodeJS.Module
afterAll(() => { if (realPty) req.cache[ptyPath] = realPty; else delete req.cache[ptyPath] })

const { spawnSignInPty } = await import('../../src/main/accountsIpc')
const OPTS = { name: 'xterm-256color', cols: 80, rows: 24, cwd: 'C:/', env: {} }

beforeEach(() => { h.ready.mockReset(); h.ready.mockReturnValue(true); h.hosted.mockClear(); h.spawn.mockClear() })

describe('spawnSignInPty', () => {
  it('Windows with the host up: opens in the host, a failed spawn reported as output and an exit', () => {
    const p = spawnSignInPty('claude.cmd', ['/login'], OPTS as any, 'win32')
    expect(p).toEqual({ pid: 0, hosted: true })
    expect(h.hosted).toHaveBeenCalledWith('claude.cmd', ['/login'], OPTS, { exitOnSpawnError: true })
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('Windows with the host down, or any other platform: node-pty here', () => {
    h.ready.mockReturnValue(false)
    expect(spawnSignInPty('claude.cmd', [], OPTS as any, 'win32')).toEqual({ pid: 9, hosted: false })
    h.ready.mockReturnValue(true)
    expect(spawnSignInPty('claude', 'x', OPTS as any, 'darwin')).toEqual({ pid: 9, hosted: false })
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(h.hosted).not.toHaveBeenCalled()
  })

  it('defaults to this process\'s platform', () => {
    spawnSignInPty('claude', [], OPTS as any)
    expect(process.platform === 'win32' ? h.hosted : h.spawn).toHaveBeenCalledTimes(1)
  })
})
