// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * What the settings reader asks of the file system, pinned with the file calls replaced. The real-disk
 * suite (headroomShapingEnvReader.test.ts) cannot tell some of these apart: a folder fails to read
 * whether or not it is refused first, and a pipe or a device cannot be made on every platform. Here the
 * answers are given, so the boundary and the refusals are exact.
 */

const M = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}))
vi.mock('fs/promises', () => ({ stat: M.stat, readFile: M.readFile }))

import { readClaudeWindowSettings, SETTINGS_FILE_MAX_BYTES } from '../../src/main/headroom/shapingEnvReader'

const USER = process.platform === 'win32' ? 'C:\\Users\\someone\\.claude' : '/home/someone/.claude'
const NOTHING = { env: null, savedWindow: false }
const BODY = JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' } })

describe('the file calls the settings reader makes', () => {
  beforeEach(() => {
    M.stat.mockReset()
    M.readFile.mockReset()
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
    M.stat.mockResolvedValue({ isFile: () => true, size: SETTINGS_FILE_MAX_BYTES + 1 })
    expect(await readClaudeWindowSettings(USER)).toEqual(NOTHING)
    expect(M.readFile).not.toHaveBeenCalled()
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

  it('asks about the three files together, not one after another', async () => {
    const order: string[] = []
    M.stat.mockImplementation(async (file: string) => {
      order.push(`stat ${file}`)
      await Promise.resolve()
      return { isFile: () => true, size: 2 }
    })
    M.readFile.mockImplementation(async (file: string) => { order.push(`read ${file}`); return '{}' })
    const project = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo'
    await readClaudeWindowSettings(USER, project)
    // All three stats are issued before any read finishes the chain: the reads interleave.
    const firstRead = order.findIndex((o) => o.startsWith('read '))
    expect(order.slice(0, firstRead).filter((o) => o.startsWith('stat ')).length).toBe(3)
  })
})
