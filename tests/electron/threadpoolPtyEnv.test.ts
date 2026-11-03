/**
 * The environment a terminal starts with has no UV_THREADPOOL_SIZE unless the USER set one
 * (1.54.5 hotfix, merge SEAM 8: lane G sets the variable for main, and main starts the shells).
 *
 * WHY. Lane G needs libuv's pool to be 16 threads and not 4, and the only way to get that is the variable. Left in
 * process.env, it would be inherited by everything Termpolis starts afterwards: every shell, every agent CLI
 * (Claude Code, Codex and Gemini are Node programs and would run with a pool size nobody asked for). A user's
 * shell must see no variable the user never set, so threadpoolEnv.ts starts the pool itself and puts the
 * environment back before any child can exist (see its header). This file counts what that comes to at the
 * place that matters most: the `env` option terminalManager hands to node-pty's spawn().
 *
 * Every case has its control, so a green result means the check can fail: the same spawn with the variable
 * left in place (what the merge looked like before the fix) hands the shell a 16; the user's own values reach
 * the shell untouched; the caller's explicit environment is the caller's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockPty = {
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  pid: 4242,
}

vi.mock('node-pty', () => ({ spawn: vi.fn(() => mockPty) }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' } }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as any
  return { ...actual, existsSync: vi.fn(() => true), writeFileSync: vi.fn() }
})
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal() as any
  return { ...actual, homedir: () => '/home/testuser' }
})
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as any
  return { ...actual, execSync: vi.fn() }
})
vi.mock('../../src/main/shellAlone', () => ({ shellAlone: vi.fn(async () => true) }))

const KEY = 'UV_THREADPOOL_SIZE'
type SpawnedEnv = Record<string, string | undefined>
type Host = { getBuiltinModule?: unknown }

const saved = {
  size: process.env[KEY],
  kill: process.env.TERMPOLIS_NO_GOVERNOR,
  builtin: (process as unknown as Host).getBuiltinModule,
}

beforeEach(() => {
  vi.resetModules()
  // The unit suite runs with the governor's kill switch on (tests/setup.ts). These cases are about the switch being
  // OFF, which is what every real user has, so each one starts from a process that has never heard of the variable.
  delete process.env.TERMPOLIS_NO_GOVERNOR
  delete process.env[KEY]
})
afterEach(() => {
  if (saved.size === undefined) delete process.env[KEY]; else process.env[KEY] = saved.size
  if (saved.kill === undefined) delete process.env.TERMPOLIS_NO_GOVERNOR; else process.env.TERMPOLIS_NO_GOVERNOR = saved.kill
  ;(process as unknown as Host).getBuiltinModule = saved.builtin
  vi.resetModules()
})

/** index.ts's first import (or not), then terminalManager, in one module registry; spawn one shell and return the
 *  environment node-pty was given. */
async function spawnedEnv(opts: { loadThreadpoolEnv?: boolean; extraEnv?: Record<string, string> } = {}): Promise<{ env: SpawnedEnv; spawns: number }> {
  if (opts.loadThreadpoolEnv ?? true) await import('../../src/main/threadpoolEnv')
  const pty = await import('node-pty')
  const { spawnTerminal } = await import('../../src/main/terminalManager')
  vi.mocked(pty.spawn).mockClear()
  spawnTerminal('t-threadpool', '/bin/bash', '/tmp', vi.fn(), undefined, opts.extraEnv)
  const calls = vi.mocked(pty.spawn).mock.calls
  return { env: (calls[0]?.[2] as { env: SpawnedEnv }).env, spawns: calls.length }
}

describe('a terminal never sees the thread-pool default Termpolis sets for itself', () => {
  it('start-up as a user has it (variable unset), real pool start: the shell has no UV_THREADPOOL_SIZE and the rest of the environment is passed on', async () => {
    process.env.TP_PTY_ENV_PROBE = 'passes-through'
    try {
      const { env, spawns } = await spawnedEnv()
      expect(spawns).toBe(1)
      expect(KEY in env).toBe(false)
      expect(env.TP_PTY_ENV_PROBE).toBe('passes-through')
    } finally {
      delete process.env.TP_PTY_ENV_PROBE
    }
  })

  it('the pool really was started with the default (so the release is not an accident of doing nothing)', async () => {
    const m = await import('../../src/main/threadpoolEnv')
    expect(m.threadpoolEnvState).toEqual({ applied: true, started: true, original: undefined })
  })

  it('CONTROL: with the variable left in process.env, as the merged lane G alone would have done, the shell DOES inherit 16', async () => {
    process.env[KEY] = '16'
    const { env } = await spawnedEnv({ loadThreadpoolEnv: false })
    expect(env[KEY]).toBe('16')
  })

  it('the pool could not be started on the spot (no process.getBuiltinModule): still none in the shell (default pool, as today)', async () => {
    ;(process as unknown as Host).getBuiltinModule = undefined
    const { env } = await spawnedEnv()
    expect(KEY in env).toBe(false)
  })

  it('the stat itself failed: still none in the shell', async () => {
    ;(process as unknown as Host).getBuiltinModule = () => ({ stat: () => { throw new Error('boom') } })
    const { env } = await spawnedEnv()
    expect(KEY in env).toBe(false)
  })

  it('the user had the empty string: the shell gets the empty string back, not a missing variable and not a 16', async () => {
    process.env[KEY] = ''
    const { env } = await spawnedEnv()
    expect(env[KEY]).toBe('')
  })

  it.each(['8', '16', '64'])("control: a value the USER set (%s) reaches the shell untouched (the user's own 16 is not Termpolis's default)", async (value) => {
    process.env[KEY] = value
    const { env } = await spawnedEnv()
    expect(env[KEY]).toBe(value)
  })

  it('the kill switch (TERMPOLIS_NO_GOVERNOR=1) means nothing was set: none in the shell', async () => {
    process.env.TERMPOLIS_NO_GOVERNOR = '1'
    const { env } = await spawnedEnv()
    expect(KEY in env).toBe(false)
  })

  it("an environment a caller asks for explicitly is the caller's: UV_THREADPOOL_SIZE in extraEnv reaches the shell", async () => {
    const { env } = await spawnedEnv({ extraEnv: { [KEY]: '4' } })
    expect(env[KEY]).toBe('4')
  })
})
