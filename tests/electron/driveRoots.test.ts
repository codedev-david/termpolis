import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DRIVE_PROBE_TIMEOUT_MS,
  DRIVE_TIMEOUT_MEMORY_MS,
  DriveProber,
  listDriveRoots,
} from '../../src/main/remoteBridge/driveRoots'

// The prober's one filesystem call comes in as `stat`, so every drive a test
// needs -- present, absent, hung, waking up -- is a few lines of fake rather
// than hardware the CI box does not have. vi.mock('fs') would not reach it
// anyway: vitest externalises Node builtins.

type DriveAnswer = Promise<{ isDirectory(): boolean }>

const folder = { isDirectory: () => true }
const notAFolder = { isDirectory: () => false }
const absent = (): Promise<never> => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
/** A drive that never answers: a mapped share whose server is gone. */
const hung = (): Promise<never> => new Promise<never>(() => {})

/** A stat that knows C: and D:, and whatever else a test layers on top. */
function statFor(extra: Record<string, () => DriveAnswer> = {}) {
  return vi.fn(async (root: string): DriveAnswer => {
    if (root in extra) return extra[root]()
    if (root === 'C:\\' || root === 'D:\\') return folder
    return absent()
  })
}

const callsFor = (stat: { mock: { calls: unknown[][] } }, root: string): number =>
  stat.mock.calls.filter(([asked]) => asked === root).length

describe('DriveProber — which drives are there', () => {
  it('asks A: through Z: and offers the ones that answer, in letter order', async () => {
    const stat = statFor()
    const roots = await new DriveProber({ stat, platform: 'win32' }).roots()
    expect(roots).toEqual(['C:\\', 'D:\\'])
    // Every letter, as a drive ROOT (`X:\`, not the drive-relative `X:`).
    expect(stat.mock.calls.map(([root]) => root)).toEqual(
      Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter) => `${letter}:\\`),
    )
  })

  it('leaves out a root that answers but is not a folder', async () => {
    const stat = statFor({ 'E:\\': async () => notAFolder })
    expect(await new DriveProber({ stat, platform: 'win32' }).roots()).toEqual(['C:\\', 'D:\\'])
  })

  it.each(['linux', 'darwin'] as const)('offers / on %s and asks the disk nothing', async (platform) => {
    // POSIX has one root, and every volume is a folder under it.
    const stat = statFor()
    expect(await new DriveProber({ stat, platform }).roots()).toEqual(['/'])
    expect(stat).not.toHaveBeenCalled()
  })
})

describe('DriveProber — a drive that does not answer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops waiting for it after the timeout and offers the rest', async () => {
    const stat = statFor({ 'Z:\\': hung })
    const pending = new DriveProber({ stat, platform: 'win32' }).roots()
    await vi.advanceTimersByTimeAsync(DRIVE_PROBE_TIMEOUT_MS)
    await expect(pending).resolves.toEqual(['C:\\', 'D:\\'])
  })

  it('does not hold the listing for the full timeout when every drive answers', async () => {
    // The timeout is a ceiling, not a delay: a picker that always waited 1.5s
    // would make every open of home feel broken.
    const stat = statFor()
    await expect(new DriveProber({ stat, platform: 'win32' }).roots()).resolves.toEqual(['C:\\', 'D:\\'])
  })

  it('skips a drive that timed out, without waiting, until the memory lapses', async () => {
    const stat = statFor({ 'Z:\\': hung })
    const prober = new DriveProber({ stat, platform: 'win32' })
    const first = prober.roots()
    await vi.advanceTimersByTimeAsync(DRIVE_PROBE_TIMEOUT_MS)
    await first

    // No timers advanced: the second open must settle on its own, because a
    // remembered timeout is skipped rather than waited out again.
    await expect(prober.roots()).resolves.toEqual(['C:\\', 'D:\\'])
    expect(callsFor(stat, 'Z:\\')).toBe(1)
  })

  it('never asks again while the first ask is still out, even after the memory lapses', async () => {
    // Every hung stat pins one of libuv's four threadpool threads until the OS
    // gives up. Re-asking on each open would pin them all -- and with them the
    // bridge's DNS lookups and every other file read.
    const stat = statFor({ 'Z:\\': hung })
    const prober = new DriveProber({ stat, platform: 'win32' })
    const first = prober.roots()
    await vi.advanceTimersByTimeAsync(DRIVE_PROBE_TIMEOUT_MS)
    await first

    vi.advanceTimersByTime(DRIVE_TIMEOUT_MEMORY_MS)
    const again = prober.roots()
    await vi.advanceTimersByTimeAsync(DRIVE_PROBE_TIMEOUT_MS)
    await expect(again).resolves.toEqual(['C:\\', 'D:\\'])
    // Waited on again, but on the SAME ask -- never a second one.
    expect(callsFor(stat, 'Z:\\')).toBe(1)
  })

  it('asks afresh once the memory lapses and the first ask has given up', async () => {
    // A share that is down for good: its stat fails after the OS's own timeout.
    // Past the memory, the drive deserves a new question -- it may be back.
    let attempt = 0
    const stat = statFor({
      'Z:\\': () => {
        attempt += 1
        return attempt === 1
          ? new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ETIMEDOUT')), 5_000))
          : Promise.resolve(folder)
      },
    })
    const prober = new DriveProber({ stat, platform: 'win32' })
    const first = prober.roots()
    await vi.advanceTimersByTimeAsync(DRIVE_PROBE_TIMEOUT_MS)
    await expect(first).resolves.toEqual(['C:\\', 'D:\\'])

    await vi.advanceTimersByTimeAsync(DRIVE_TIMEOUT_MEMORY_MS)
    await expect(prober.roots()).resolves.toEqual(['C:\\', 'D:\\', 'Z:\\'])
    expect(callsFor(stat, 'Z:\\')).toBe(2)
  })

  it('offers a drive on the next open once its late answer arrives -- a NAS waking up', async () => {
    // A sleeping disk answers in seconds, not never. Once it HAS answered, the
    // 60s memory would only hide a drive that is plainly there.
    let attempt = 0
    const stat = statFor({
      'Z:\\': () => {
        attempt += 1
        return attempt === 1
          ? new Promise<{ isDirectory(): boolean }>((resolve) => setTimeout(() => resolve(folder), 3_000))
          : Promise.resolve(folder)
      },
    })
    const prober = new DriveProber({ stat, platform: 'win32' })
    const first = prober.roots()
    await vi.advanceTimersByTimeAsync(DRIVE_PROBE_TIMEOUT_MS)
    await expect(first).resolves.toEqual(['C:\\', 'D:\\'])

    await vi.advanceTimersByTimeAsync(3_000)
    await expect(prober.roots()).resolves.toEqual(['C:\\', 'D:\\', 'Z:\\'])
  })

  it('shares one ask between two opens that overlap', async () => {
    const stat = statFor({ 'Z:\\': hung })
    const prober = new DriveProber({ stat, platform: 'win32' })
    const one = prober.roots()
    const two = prober.roots()
    await vi.advanceTimersByTimeAsync(DRIVE_PROBE_TIMEOUT_MS)
    await expect(Promise.all([one, two])).resolves.toEqual([['C:\\', 'D:\\'], ['C:\\', 'D:\\']])
    expect(callsFor(stat, 'Z:\\')).toBe(1)
  })
})

describe('listDriveRoots — the bridge\'s own prober', () => {
  it('answers with this machine\'s drives', async () => {
    const roots = await listDriveRoots()
    if (process.platform === 'win32') {
      expect(roots).toContain(`${(process.env.SystemDrive ?? 'C:').toUpperCase()}\\`)
    } else {
      expect(roots).toEqual(['/'])
    }
  })
})
