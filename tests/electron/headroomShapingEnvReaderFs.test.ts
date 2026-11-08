// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * What the settings reader asks of the file system, pinned with the file calls replaced. The real-disk
 * suite (headroomShapingEnvReader.test.ts) cannot tell some of these apart: a folder fails to read
 * whether or not it is refused first, and a pipe or a device cannot be made on every platform. Here the
 * answers are given, so the boundary and the refusals are exact.
 */

const M = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  homedir: vi.fn(),
}))
vi.mock('fs/promises', () => ({ stat: M.stat, readFile: M.readFile }))
// The home folder a terminal falls back to is the system's, so it is given here rather than read off the machine.
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), homedir: M.homedir }))

import { readClaudeWindowSettings, SETTINGS_FILE_MAX_BYTES } from '../../src/main/headroom/shapingEnvReader'

const USER = process.platform === 'win32' ? 'C:\\Users\\someone\\.claude' : '/home/someone/.claude'
// Not the folder the user file is in: the home a terminal falls back to is another folder from Claude Code's own.
const HOME = process.platform === 'win32' ? 'C:\\Users\\fallback' : '/home/fallback'
const NOTHING = { env: null, savedWindow: false }
const BODY = JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' } })

describe('the file calls the settings reader makes', () => {
  beforeEach(() => {
    M.stat.mockReset()
    M.readFile.mockReset()
    M.homedir.mockReset()
    M.homedir.mockReturnValue(HOME)
  })

  it('reads a plain file of ordinary size', async () => {
    M.stat.mockResolvedValue({ isFile: () => true, size: BODY.length })
    M.readFile.mockResolvedValue(BODY)
    expect((await readClaudeWindowSettings(USER)).env).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' })
    expect(M.readFile).toHaveBeenCalledTimes(1)
    expect(M.readFile.mock.calls[0][1]).toBe('utf8')
  })

  it('reads a file of exactly the limit and refuses one a byte over', async () => {
    M.stat.mockResolvedValue({ isFile: () => true, size: SETTINGS_FILE_MAX_BYTES })
    M.readFile.mockResolvedValue(BODY)
    expect((await readClaudeWindowSettings(USER)).env).not.toBeNull()
    M.readFile.mockClear()
    M.stat.mockClear()
    M.stat.mockResolvedValue({ isFile: () => true, size: SETTINGS_FILE_MAX_BYTES + 1 })
    // Not decoded, and not a file that holds nothing: Claude Code would read it, this does not, so it cannot tell what
    // window it holds and the variable is left unset (the same answer as for a file that is locked).
    expect(await readClaudeWindowSettings(USER)).toEqual({ env: null, savedWindow: false, unreadable: true })
    expect(M.readFile).not.toHaveBeenCalled()
    // And it is not tried again: a file that large will not shrink in 50 ms, and the wait is in the launch's way.
    expect(M.stat).toHaveBeenCalledTimes(1)
  })

  it('never opens what is not a plain file: a pipe, a device, a folder', async () => {
    // Opening a pipe for reading waits for a writer that may never come; a launch must not wait on it.
    M.stat.mockResolvedValue({ isFile: () => false, size: 0 })
    expect(await readClaudeWindowSettings(USER)).toEqual(NOTHING)
    expect(M.readFile).not.toHaveBeenCalled()
  })

  it('counts a file that is not there as holding nothing, whichever way the system says so', async () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      M.stat.mockReset(); M.readFile.mockReset()
      M.stat.mockRejectedValue(Object.assign(new Error(code), { code }))
      expect(await readClaudeWindowSettings(USER), code).toEqual(NOTHING)
      expect(M.readFile).not.toHaveBeenCalled()
      expect(M.stat).toHaveBeenCalledTimes(1) // nothing there to wait for or try again
    }
    M.stat.mockReset(); M.readFile.mockReset()
    M.stat.mockResolvedValue({ isFile: () => true, size: 10 })
    M.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) // gone between the two calls
    expect(await readClaudeWindowSettings(USER)).toEqual(NOTHING)
    expect(M.readFile).toHaveBeenCalledTimes(1)
  })

  it('counts a file that is there but is not valid JSON as holding nothing, as Claude Code does', async () => {
    M.stat.mockResolvedValue({ isFile: () => true, size: 10 })
    for (const text of ['{ not json', '', '   ', '\u0000\u0001']) {
      M.readFile.mockResolvedValue(text)
      expect(await readClaudeWindowSettings(USER), JSON.stringify(text)).toEqual(NOTHING)
    }
    expect(M.stat).toHaveBeenCalledTimes(4) // one look each: a broken file is not retried
  })

  it('tries a file that is there but cannot be read once more, and uses it when the second try works', async () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'EIO']) {
      M.stat.mockReset(); M.readFile.mockReset()
      M.stat.mockResolvedValue({ isFile: () => true, size: 10 })
      M.readFile.mockRejectedValueOnce(Object.assign(new Error(code), { code })).mockResolvedValueOnce(BODY)
      expect(await readClaudeWindowSettings(USER), code).toEqual({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' }, savedWindow: false })
      expect(M.readFile).toHaveBeenCalledTimes(2)
    }
  })

  it('and when the stat itself is what fails the first time', async () => {
    M.stat.mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })).mockResolvedValue({ isFile: () => true, size: 10 })
    M.readFile.mockResolvedValue(BODY)
    expect(await readClaudeWindowSettings(USER)).toEqual({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' }, savedWindow: false })
  })

  it('counts a file that still cannot be read on the second try as holding a window it cannot see', async () => {
    M.stat.mockResolvedValue({ isFile: () => true, size: 10 })
    M.readFile.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
    expect(await readClaudeWindowSettings(USER)).toEqual({ env: null, savedWindow: false, unreadable: true })
    expect(M.readFile).toHaveBeenCalledTimes(2) // once, and once more: not a loop
    // An error with no code at all is also not a missing file.
    M.readFile.mockReset(); M.readFile.mockRejectedValue(new Error('something odd'))
    expect((await readClaudeWindowSettings(USER)).unreadable).toBe(true)
    M.stat.mockReset(); M.stat.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    expect((await readClaudeWindowSettings(USER)).unreadable).toBe(true)
  })

  // The retry waits RETRY_AFTER_MS, and the whole read is bounded by SETTINGS_READ_DEADLINE_MS, after which a
  // launch gives up and sets nothing. If the wait were as long as the bound, the retry could never finish in
  // time and a lock that clears in a moment would leave the window unset for that terminal; nothing else ties
  // the two numbers together. The wait is also run, on fake timers so the answer does not depend on load.
  it('waits a small part of the deadline before it tries again, so the second try always has time to answer', async () => {
    const { RETRY_AFTER_MS } = await import('../../src/main/headroom/shapingEnvReader')
    const { SETTINGS_READ_DEADLINE_MS } = await import('../../src/main/headroom/shapingEnv')
    expect(RETRY_AFTER_MS).toBeLessThan(SETTINGS_READ_DEADLINE_MS / 5)
  })

  it('a lock that clears within the wait lets the launch read the file: with no window of its own in it, the variable is set', async () => {
    const { resolveShapingEnv, SETTINGS_READ_DEADLINE_MS } = await import('../../src/main/headroom/shapingEnv')
    const { RETRY_AFTER_MS } = await import('../../src/main/headroom/shapingEnvReader')
    vi.useFakeTimers()
    try {
      M.stat.mockResolvedValue({ isFile: () => true, size: 10 })
      M.readFile.mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })).mockResolvedValue('{}')
      const pending = resolveShapingEnv({ contextCap: 300000 }, {}, () => readClaudeWindowSettings(USER))
      // Past the wait, well inside the deadline: the second try has run.
      await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS + 1)
      expect(await pending).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' })
      expect(M.readFile).toHaveBeenCalledTimes(2)
      expect(RETRY_AFTER_MS + 1).toBeLessThan(SETTINGS_READ_DEADLINE_MS)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('waits before the second try: a lock held for a few milliseconds is gone by then, and one tried again at once would still be there', async () => {
    const { resolveShapingEnv } = await import('../../src/main/headroom/shapingEnv')
    const { RETRY_AFTER_MS } = await import('../../src/main/headroom/shapingEnvReader')
    vi.useFakeTimers()
    try {
      const t0 = Date.now()
      M.stat.mockResolvedValue({ isFile: () => true, size: 10 })
      M.readFile.mockImplementation(async () => {
        if (Date.now() - t0 < 10) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        return '{}'
      })
      const pending = resolveShapingEnv({ contextCap: 300000 }, {}, () => readClaudeWindowSettings(USER))
      await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS + 1)
      expect(await pending).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' })
      expect(M.readFile).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('and that makes the variable stay unset, which is the whole point', async () => {
    const { resolveShapingEnv } = await import('../../src/main/headroom/shapingEnv')
    M.stat.mockResolvedValue({ isFile: () => true, size: 10 })
    M.readFile.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, () => readClaudeWindowSettings(USER))).toEqual({})
    // The same cap with a readable file that holds nothing is set.
    M.readFile.mockReset(); M.readFile.mockResolvedValue('{}')
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, () => readClaudeWindowSettings(USER))).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' })
  })

  it('an unreadable file does not stop the others being read, and a window in a readable one still counts', async () => {
    M.stat.mockImplementation(async () => ({ isFile: () => true, size: 10 }))
    M.readFile.mockImplementation(async (file: string) => {
      if (String(file).includes('someone')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) // the user file
      return BODY
    })
    const got = await readClaudeWindowSettings(USER, process.platform === 'win32' ? 'C:/proj' : '/proj')
    expect(got.unreadable).toBe(true)
    expect(got.env).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' })
  })

  it('asks about the three files together, not one after another, and about the folder in the same round', async () => {
    const order: string[] = []
    M.stat.mockImplementation(async (file: string) => {
      order.push(`stat ${file}`)
      await Promise.resolve()
      return { isFile: () => true, size: 2 }
    })
    M.readFile.mockImplementation(async (file: string) => { order.push(`read ${file}`); return '{}' })
    const project = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo'
    await readClaudeWindowSettings(USER, project, HOME)
    // All three file stats are issued before any read finishes the chain: the reads interleave. The folder's own stat
    // is one more of the same round, so a launch whose folder is there waits for nothing it did not wait for before.
    const firstRead = order.findIndex((o) => o.startsWith('read '))
    const before = order.slice(0, firstRead).filter((o) => o.startsWith('stat '))
    expect(before.length).toBe(4)
    expect(before).toContain(`stat ${project}`)
    // And when the folder is there, nothing is asked of the home folder.
    expect(order.some((o) => o.includes(HOME))).toBe(false)
  })
})

/**
 * The folder the terminal was asked to open in can be gone, and spawnTerminal then opens it in the home folder. Claude Code
 * reads the project files of the folder it runs in, so the home folder's two are read as well, and only then. Here the
 * folder answers as given, and the files under a folder that is gone are gone with it.
 */
describe('the folder the terminal was asked to open in', () => {
  const PROJECT = process.platform === 'win32' ? 'C:\\work\\gone' : '/work/gone'
  const WINDOW = JSON.stringify({ autoCompactWindow: 200000 })
  const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const under = (file: string, folder: string): boolean => String(file).startsWith(folder + (process.platform === 'win32' ? '\\' : '/'))
  const files = (): string[] => M.readFile.mock.calls.map((c) => String(c[0]))
  beforeEach(() => {
    M.stat.mockReset()
    M.readFile.mockReset()
    M.homedir.mockReset()
    M.homedir.mockReturnValue(HOME)
  })

  /** stat: the folder is there (not a plain file), gone, or refuses; every file is a plain one unless it is under a folder that is gone. */
  function folderIs(state: 'there' | 'gone' | 'refuses'): void {
    M.stat.mockImplementation(async (p: string) => {
      if (String(p) === PROJECT) {
        if (state === 'there') return { isFile: () => false, size: 0 }
        throw state === 'gone' ? enoent() : Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
      if (state !== 'there' && under(p, PROJECT)) throw enoent()
      return { isFile: () => true, size: 2 }
    })
  }
  /** The home folder's local file holds a window; every other file holds nothing. */
  function homeLocalHoldsAWindow(): void {
    M.readFile.mockImplementation(async (p: string) => (under(p, HOME) && String(p).endsWith('settings.local.json') ? WINDOW : '{}'))
  }

  it('is looked for in the home folder instead, when it is gone: the two project files there are read, and the window in one is seen', async () => {
    folderIs('gone'); homeLocalHoldsAWindow()
    expect(await readClaudeWindowSettings(USER, PROJECT, HOME)).toEqual({ env: null, savedWindow: true })
    const read = files().sort()
    expect(read).toHaveLength(3)
    expect(read.filter((f) => under(f, PROJECT))).toEqual([]) // nothing is read in a folder that is not there
    expect(read.filter((f) => f === USER + (process.platform === 'win32' ? '\\' : '/') + 'settings.json')).toHaveLength(1)
    expect(read.filter((f) => under(f, HOME)).map((f) => f.slice(HOME.length + 1).replace(/\\/g, '/')).sort()).toEqual(['.claude/settings.json', '.claude/settings.local.json'])
  })

  it('is not looked for there when it is there, and the home folder\'s files are then not touched at all', async () => {
    folderIs('there'); homeLocalHoldsAWindow()
    expect(await readClaudeWindowSettings(USER, PROJECT, HOME)).toEqual(NOTHING)
    expect(files().filter((f) => under(f, HOME))).toEqual([])
    expect(M.stat.mock.calls.map((c) => String(c[0])).filter((f) => under(f, HOME))).toEqual([])
  })

  it('counts a folder that cannot be looked at as gone, as spawnTerminal\'s own check does, whatever the reason', async () => {
    folderIs('refuses'); homeLocalHoldsAWindow()
    expect(await readClaudeWindowSettings(USER, PROJECT, HOME)).toEqual({ env: null, savedWindow: true })
  })

  it('reads nothing of a home that is not a usable folder, and does not fail on one', async () => {
    folderIs('gone'); homeLocalHoldsAWindow()
    for (const home of ['', 'relative/home', undefined as never, null as never, 7 as never]) {
      M.readFile.mockClear()
      expect(await readClaudeWindowSettings(USER, PROJECT, home === undefined ? '' : home)).toEqual(NOTHING)
      expect(files()).toHaveLength(1) // the user file, and no more
    }
  })

  it('leaves a folder that is not an absolute path alone: it asks the system nothing about it and reads nothing of the home folder for it', async () => {
    homeLocalHoldsAWindow()
    M.stat.mockImplementation(async () => ({ isFile: () => true, size: 2 }))
    for (const relative of ['relative/work', '', undefined]) {
      M.stat.mockClear(); M.readFile.mockClear()
      expect(await readClaudeWindowSettings(USER, relative, HOME)).toEqual(NOTHING)
      expect(files().filter((f) => under(f, HOME))).toEqual([])
      expect(M.stat).toHaveBeenCalledTimes(1) // the user file, and not a folder
    }
  })

  describe('and the home folder it falls back to, when none is handed in', () => {
    let before: string | undefined
    beforeEach(() => { before = process.env.TERMPOLIS_TEST_AGENT_HOME })
    afterEach(() => { if (before === undefined) delete process.env.TERMPOLIS_TEST_AGENT_HOME; else process.env.TERMPOLIS_TEST_AGENT_HOME = before })

    it('is the scratch home of a test run when there is one, and the system\'s is not asked at all', async () => {
      const scratch = process.platform === 'win32' ? 'C:\\scratch\\agent-home' : '/scratch/agent-home'
      process.env.TERMPOLIS_TEST_AGENT_HOME = scratch
      folderIs('gone'); M.readFile.mockImplementation(async (p: string) => (under(p, scratch) && String(p).endsWith('settings.local.json') ? WINDOW : '{}'))
      expect(await readClaudeWindowSettings(USER, PROJECT)).toEqual({ env: null, savedWindow: true })
      expect(files().filter((f) => under(f, scratch))).toHaveLength(2)
      expect(M.homedir).not.toHaveBeenCalled()
    })

    it('is that folder with the spaces around it taken off, as the rest of the app reads the same setting', async () => {
      const scratch = process.platform === 'win32' ? 'C:\\scratch\\agent-home' : '/scratch/agent-home'
      process.env.TERMPOLIS_TEST_AGENT_HOME = `  ${scratch} \t`
      folderIs('gone'); M.readFile.mockImplementation(async (p: string) => (under(p, scratch) && String(p).endsWith('settings.local.json') ? WINDOW : '{}'))
      expect(await readClaudeWindowSettings(USER, PROJECT)).toEqual({ env: null, savedWindow: true })
    })

    it('is no home at all when that one is set and blank, never the system\'s', async () => {
      process.env.TERMPOLIS_TEST_AGENT_HOME = '   '
      folderIs('gone'); homeLocalHoldsAWindow()
      expect(await readClaudeWindowSettings(USER, PROJECT)).toEqual(NOTHING)
      expect(files()).toHaveLength(1)
      expect(M.homedir).not.toHaveBeenCalled()
    })

    it('is the system\'s home folder when no test run is pointing it elsewhere', async () => {
      delete process.env.TERMPOLIS_TEST_AGENT_HOME
      folderIs('gone'); homeLocalHoldsAWindow()
      expect(await readClaudeWindowSettings(USER, PROJECT)).toEqual({ env: null, savedWindow: true })
      expect(M.homedir).toHaveBeenCalledTimes(1)
      expect(files().filter((f) => under(f, HOME))).toHaveLength(2)
    })

    it('is no home when the system cannot name one, and the read still finishes', async () => {
      delete process.env.TERMPOLIS_TEST_AGENT_HOME
      M.homedir.mockImplementation(() => { throw new Error('ERR_SYSTEM_ERROR') })
      folderIs('gone'); homeLocalHoldsAWindow()
      expect(await readClaudeWindowSettings(USER, PROJECT)).toEqual(NOTHING)
      expect(files()).toHaveLength(1)
    })
  })
})
