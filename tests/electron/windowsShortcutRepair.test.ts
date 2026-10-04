// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import {
  repairWindowsShortcuts,
  isShortcutDamaged,
  defaultShortcutPaths,
  taskbarPinPath,
  parseRegBinary,
  pinRecordNames,
  readTaskbarPinRecord,
  restoreVanishedTaskbarPin,
  TASKBAND_KEY,
  MAX_LNK_STRING,
  SAFE_DESCRIPTION_LIMIT,
  type ShortcutLinkDetails,
  type ShortcutRepairDeps,
  type PinRestoreDeps,
} from '../../src/main/windowsShortcutRepair'

// Regression cover for the recurring generic-taskbar-icon bug. package.json's
// description used to be 288 chars; electron-builder writes it into the .lnk
// StringData block, whose fields are bounded at MAX_PATH (260). The overflow
// corrupted the NEXT fields — WORKING_DIR and ICON_LOCATION — leaving an
// unresolvable icon path ("olis.exe"), so Windows drew a generic icon. Because the
// app declares a matching AppUserModelID, Windows takes the taskbar icon from the
// SHORTCUT, so the window icon set in main could never override it.

const EXE = 'C:\\Users\\dev\\AppData\\Local\\Programs\\termpolis\\Termpolis.exe'
const EXE_DIR = 'C:\\Users\\dev\\AppData\\Local\\Programs\\termpolis'
const AUMID = 'com.termpolis.app'
const LNK = 'C:\\Users\\dev\\AppData\\Roaming\\...\\TaskBar\\Termpolis.lnk'

const healthyDetails: ShortcutLinkDetails = {
  target: EXE,
  cwd: EXE_DIR,
  icon: EXE,
  iconIndex: 0,
  appUserModelId: AUMID,
  description: 'Secure AI-assisted development terminal.',
}

function makeDeps(over: Partial<ShortcutRepairDeps> = {}): ShortcutRepairDeps {
  return {
    platform: 'win32',
    exePath: EXE,
    exeDir: EXE_DIR,
    appUserModelId: AUMID,
    description: 'Secure AI-assisted development terminal.',
    candidatePaths: [LNK],
    fileExists: () => true,
    readShortcutLink: () => ({ ...healthyDetails }),
    writeShortcutLink: () => true,
    ...over,
  }
}

describe('isShortcutDamaged', () => {
  const expected = { exePath: EXE, appUserModelId: AUMID }
  const onDisk = (p: string) => p === EXE

  it('accepts a fully intact shortcut', () => {
    expect(isShortcutDamaged(healthyDetails, expected, onDisk)).toBe(false)
  })

  it('flags a shortcut with NO icon recorded', () => {
    expect(isShortcutDamaged({ ...healthyDetails, icon: undefined }, expected, onDisk)).toBe(true)
  })

  it('flags the real corruption signature — an icon path that is not on disk', () => {
    // This is verbatim what the overflow left behind: a truncated tail of the exe name.
    expect(isShortcutDamaged({ ...healthyDetails, icon: 'olis.exe' }, expected, onDisk)).toBe(true)
  })

  it('flags a description at the limit, BEFORE it corrupts the next write', () => {
    const details = { ...healthyDetails, description: 'x'.repeat(MAX_LNK_STRING) }
    expect(isShortcutDamaged(details, expected, onDisk)).toBe(true)
  })

  it('allows a description just under the limit', () => {
    const details = { ...healthyDetails, description: 'x'.repeat(MAX_LNK_STRING - 1) }
    expect(isShortcutDamaged(details, expected, onDisk)).toBe(false)
  })

  it('treats a missing description as fine, not as zero-length damage', () => {
    expect(isShortcutDamaged({ ...healthyDetails, description: undefined }, expected, onDisk)).toBe(false)
  })

  it('flags a target pointing at a different install', () => {
    const details = { ...healthyDetails, target: 'C:\\Old\\Termpolis.exe' }
    expect(isShortcutDamaged(details, expected, onDisk)).toBe(true)
  })

  it('compares the target case-insensitively, as Windows does', () => {
    const details = { ...healthyDetails, target: EXE.toUpperCase() }
    expect(isShortcutDamaged(details, expected, onDisk)).toBe(false)
  })

  it('flags an AUMID mismatch — the taskbar button would not merge with the pin', () => {
    const details = { ...healthyDetails, appUserModelId: 'com.other.app' }
    expect(isShortcutDamaged(details, expected, onDisk)).toBe(true)
  })
})

describe('repairWindowsShortcuts', () => {
  it('does nothing at all off Windows', () => {
    const write = vi.fn()
    const read = vi.fn()
    const res = repairWindowsShortcuts(makeDeps({ platform: 'darwin', writeShortcutLink: write, readShortcutLink: read }))
    expect(res).toEqual({ repaired: [], healthy: [], failed: [] })
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('skips shortcut paths that do not exist', () => {
    const read = vi.fn()
    const res = repairWindowsShortcuts(makeDeps({ fileExists: () => false, readShortcutLink: read }))
    expect(res.repaired).toEqual([])
    expect(res.healthy).toEqual([])
    expect(res.failed).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('leaves a healthy shortcut untouched', () => {
    const write = vi.fn()
    const res = repairWindowsShortcuts(makeDeps({ writeShortcutLink: write }))
    expect(res.healthy).toEqual([LNK])
    expect(res.repaired).toEqual([])
    expect(write).not.toHaveBeenCalled()
  })

  it('rewrites a shortcut whose icon path is the corrupted truncation', () => {
    const write = vi.fn().mockReturnValue(true)
    const res = repairWindowsShortcuts(makeDeps({
      readShortcutLink: () => ({ ...healthyDetails, icon: 'olis.exe' }),
      fileExists: (p) => p !== 'olis.exe',
      writeShortcutLink: write,
    }))
    expect(res.repaired).toEqual([LNK])
    expect(write).toHaveBeenCalledWith(LNK, 'update', expect.objectContaining({
      target: EXE,
      cwd: EXE_DIR,
      icon: EXE,
      iconIndex: 0,
      appUserModelId: AUMID,
    }))
  })

  it('writes a SHORT description — leaving the long one would re-corrupt the .lnk', () => {
    const write = vi.fn().mockReturnValue(true)
    repairWindowsShortcuts(makeDeps({
      description: 'y'.repeat(400),
      readShortcutLink: () => ({ ...healthyDetails, icon: undefined }),
      writeShortcutLink: write,
    }))
    const written = write.mock.calls[0][2] as ShortcutLinkDetails
    expect(written.description!.length).toBe(SAFE_DESCRIPTION_LIMIT)
    expect(written.description!.length).toBeLessThan(MAX_LNK_STRING)
  })

  it('records a shortcut it cannot READ as failed, without throwing', () => {
    const res = repairWindowsShortcuts(makeDeps({
      readShortcutLink: () => { throw new Error('access denied') },
    }))
    expect(res.failed).toEqual([LNK])
    expect(res.repaired).toEqual([])
  })

  it('records a shortcut it cannot WRITE as failed, without throwing', () => {
    const res = repairWindowsShortcuts(makeDeps({
      readShortcutLink: () => ({ ...healthyDetails, icon: undefined }),
      writeShortcutLink: () => { throw new Error('locked') },
    }))
    expect(res.failed).toEqual([LNK])
    expect(res.repaired).toEqual([])
  })

  it('treats a false return from writeShortcutLink as a failure', () => {
    const res = repairWindowsShortcuts(makeDeps({
      readShortcutLink: () => ({ ...healthyDetails, icon: undefined }),
      writeShortcutLink: () => false,
    }))
    expect(res.failed).toEqual([LNK])
    expect(res.repaired).toEqual([])
  })

  it('logs each repair when a logger is supplied', () => {
    const log = vi.fn()
    repairWindowsShortcuts(makeDeps({
      readShortcutLink: () => ({ ...healthyDetails, icon: undefined }),
      log,
    }))
    expect(log).toHaveBeenCalledWith(expect.stringContaining(LNK))
  })

  it('keeps going after one shortcut fails, so a locked pin cannot block the rest', () => {
    const good = 'C:\\good\\Termpolis.lnk'
    const bad = 'C:\\bad\\Termpolis.lnk'
    const res = repairWindowsShortcuts(makeDeps({
      candidatePaths: [bad, good],
      readShortcutLink: (p) => {
        if (p === bad) throw new Error('locked')
        return { ...healthyDetails, icon: undefined }
      },
    }))
    expect(res.failed).toEqual([bad])
    expect(res.repaired).toEqual([good])
  })
})

describe('defaultShortcutPaths', () => {
  const join = (...parts: string[]) => parts.join('\\')

  it('covers the start menu, the PINNED TASKBAR entry, and the desktop', () => {
    const paths = defaultShortcutPaths({ APPDATA: 'C:\\AppData', USERPROFILE: 'C:\\User' }, join)
    expect(paths).toEqual([
      'C:\\AppData\\Microsoft\\Windows\\Start Menu\\Programs\\Termpolis.lnk',
      'C:\\AppData\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\\Termpolis.lnk',
      'C:\\User\\Desktop\\Termpolis.lnk',
    ])
  })

  it('includes the pinned taskbar path — the one no installer ever rewrites', () => {
    const paths = defaultShortcutPaths({ APPDATA: 'C:\\AppData', USERPROFILE: 'C:\\User' }, join)
    expect(paths.some(p => p.includes('User Pinned\\TaskBar'))).toBe(true)
  })

  it('omits paths whose environment variable is unset', () => {
    expect(defaultShortcutPaths({}, join)).toEqual([])
    expect(defaultShortcutPaths({ USERPROFILE: 'C:\\User' }, join)).toEqual(['C:\\User\\Desktop\\Termpolis.lnk'])
  })

  it('honours a custom shortcut name', () => {
    const paths = defaultShortcutPaths({ USERPROFILE: 'C:\\User' }, join, 'Custom')
    expect(paths).toEqual(['C:\\User\\Desktop\\Custom.lnk'])
  })
})

describe('taskbarPinPath', () => {
  const join = (...parts: string[]) => parts.join('\\')

  it('is the shortcut under User Pinned\\TaskBar in APPDATA', () => {
    expect(taskbarPinPath({ APPDATA: 'C:\\AppData' }, join)).toBe(
      'C:\\AppData\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\\Termpolis.lnk',
    )
  })

  it('is null without APPDATA', () => {
    expect(taskbarPinPath({}, join)).toBeNull()
  })

  it('honours a custom shortcut name', () => {
    expect(taskbarPinPath({ APPDATA: 'C:\\AppData' }, join, 'Custom')).toMatch(/\\TaskBar\\Custom\.lnk$/)
  })
})

// The v1.49.1 quarantine. Defender removed the unsigned build's Termpolis.exe AND every shortcut
// pointing at it, the pinned taskbar one included. Reinstalling writes the Start-menu and desktop
// shortcuts again but never the pinned one, so Explorer kept a pin whose shortcut was gone and drew
// it with no icon, and the running window (same AppUserModelID) merged into that blank pin.

/**
 * A stand-in for Explorer's Taskband `Favorites` value. Each pin's file name sits in it as UTF-16LE
 * inside a shell item ID list, at whatever offset the bytes before it leave: odd as often as even.
 */
function pinRecord(names: string[], pad = 3): Buffer {
  const parts: Buffer[] = []
  for (const name of names) parts.push(Buffer.alloc(pad, 0x42), Buffer.from(name, 'utf16le'), Buffer.alloc(2))
  return Buffer.concat(parts)
}

/** What `reg query <key> /v <value>` prints for a REG_BINARY value. */
const regOutput = (line: string) =>
  `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Taskband\r\n${line}\r\n\r\n`

describe('parseRegBinary', () => {
  it('decodes the hex reg.exe prints for a REG_BINARY value', () => {
    expect(parseRegBinary(regOutput('    Favorites    REG_BINARY    00A4FF10'), 'Favorites')).toEqual(
      Buffer.from([0x00, 0xa4, 0xff, 0x10]),
    )
  })

  it('matches the value name case-insensitively, as the registry does', () => {
    expect(parseRegBinary(regOutput('    Favorites    REG_BINARY    01'), 'favorites')).toEqual(Buffer.from([1]))
  })

  it('reads an empty REG_BINARY (reg.exe leaves only trailing spaces) as an empty record', () => {
    expect(parseRegBinary(regOutput('    Favorites    REG_BINARY    '), 'Favorites')).toEqual(Buffer.alloc(0))
  })

  it('reads an empty REG_BINARY whose trailing spaces were trimmed away the same way', () => {
    expect(parseRegBinary(regOutput('    Favorites    REG_BINARY'), 'Favorites')).toEqual(Buffer.alloc(0))
  })

  it('does not mistake a value whose name merely starts the same for the one asked about', () => {
    expect(parseRegBinary(regOutput('    FavoritesResolve    REG_BINARY    0102'), 'Favorites')).toBeNull()
  })

  it('returns null when reg.exe printed nothing (the value does not exist)', () => {
    expect(parseRegBinary('', 'Favorites')).toBeNull()
  })

  it('returns null for a value that is not REG_BINARY', () => {
    expect(parseRegBinary(regOutput('    Favorites    REG_SZ    hello'), 'Favorites')).toBeNull()
  })

  it('rejects odd-length hex rather than guessing at a truncated byte', () => {
    expect(parseRegBinary(regOutput('    Favorites    REG_BINARY    ABC'), 'Favorites')).toBeNull()
  })
})

describe('pinRecordNames', () => {
  it('finds a pinned file name stored at an even byte offset', () => {
    expect(pinRecordNames(pinRecord(['Termpolis.lnk'], 2), 'Termpolis.lnk')).toBe(true)
  })

  it('finds one stored at an ODD byte offset, where a plain UTF-16 decode misses it', () => {
    const record = pinRecord(['Termpolis.lnk'], 3)
    expect(record.toString('utf16le')).not.toContain('Termpolis.lnk')
    expect(pinRecordNames(record, 'Termpolis.lnk')).toBe(true)
  })

  it('matches case-insensitively, as NTFS file names do', () => {
    expect(pinRecordNames(pinRecord(['TERMPOLIS.LNK']), 'Termpolis.lnk')).toBe(true)
  })

  it('is false when only other apps are pinned', () => {
    expect(pinRecordNames(pinRecord(['Firefox.lnk', 'Slack.lnk']), 'Termpolis.lnk')).toBe(false)
  })

  it('is false for an empty record', () => {
    expect(pinRecordNames(Buffer.alloc(0), 'Termpolis.lnk')).toBe(false)
  })
})

describe('readTaskbarPinRecord', () => {
  it("asks reg.exe, by its absolute System32 path, for the Taskband key's Favorites value", async () => {
    const run = vi.fn(async () => ({ stdout: regOutput('    Favorites    REG_BINARY    0102') }))
    const record = await readTaskbarPinRecord(run, { SystemRoot: 'D:\\Win' })
    expect(run).toHaveBeenCalledWith('D:\\Win\\System32\\reg.exe', ['query', TASKBAND_KEY, '/v', 'Favorites'])
    expect(record).toEqual(Buffer.from([1, 2]))
  })

  it('falls back to windir, then C:\\Windows, for the System32 root', async () => {
    const run = vi.fn(async () => ({ stdout: '' }))
    await readTaskbarPinRecord(run, { windir: 'E:\\Win' })
    await readTaskbarPinRecord(run, {})
    expect(run.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      'E:\\Win\\System32\\reg.exe',
      'C:\\Windows\\System32\\reg.exe',
    ])
  })

  it("reads the System32 root from this process's environment by default", async () => {
    const run = vi.fn(async () => ({ stdout: '' }))
    await readTaskbarPinRecord(run)
    expect((run.mock.calls[0] as unknown[])[0]).toMatch(/[\\/]System32[\\/]reg\.exe$/)
  })

  it('returns null when reg.exe fails (nothing has ever been pinned)', async () => {
    const run = async () => ({ stdout: '', error: { message: 'exit 1' } })
    expect(await readTaskbarPinRecord(run, {})).toBeNull()
  })

  it('returns null instead of rejecting when the runner itself rejects', async () => {
    const run = async () => { throw new Error('proc host down') }
    expect(await readTaskbarPinRecord(run, {})).toBeNull()
  })
})

describe('restoreVanishedTaskbarPin', () => {
  const PIN = 'C:\\Users\\dev\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\\Termpolis.lnk'

  function pinDeps(over: Partial<PinRestoreDeps> = {}): PinRestoreDeps {
    return {
      platform: 'win32',
      exePath: EXE,
      exeDir: EXE_DIR,
      appUserModelId: AUMID,
      description: 'Secure AI-assisted development terminal.',
      pinPath: PIN,
      // The exe is installed; the pinned shortcut is the thing that is gone.
      fileExists: (p) => p === EXE,
      readPinRecord: async () => pinRecord(['Windows PowerShell.lnk', 'Termpolis.lnk', 'Firefox.lnk']),
      writeShortcutLink: () => true,
      ...over,
    }
  }

  it('puts back a pin Explorer still lists but whose shortcut is gone', async () => {
    const write = vi.fn().mockReturnValue(true)
    expect(await restoreVanishedTaskbarPin(pinDeps({ writeShortcutLink: write }))).toBe('restored')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(PIN, 'create', {
      target: EXE,
      cwd: EXE_DIR,
      icon: EXE,
      iconIndex: 0,
      appUserModelId: AUMID,
      description: 'Secure AI-assisted development terminal.',
    })
  })

  it('leaves an existing pin to repairWindowsShortcuts, without reading the registry', async () => {
    const read = vi.fn(async () => pinRecord(['Termpolis.lnk']))
    const write = vi.fn()
    const outcome = await restoreVanishedTaskbarPin(pinDeps({ fileExists: () => true, readPinRecord: read, writeShortcutLink: write }))
    expect(outcome).toBe('present')
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('does not re-pin an app the user unpinned: unpinning drops it from the record too', async () => {
    const write = vi.fn()
    const outcome = await restoreVanishedTaskbarPin(pinDeps({
      readPinRecord: async () => pinRecord(['Firefox.lnk', 'Slack.lnk']),
      writeShortcutLink: write,
    }))
    expect(outcome).toBe('not-pinned')
    expect(write).not.toHaveBeenCalled()
  })

  it('does nothing when the pin record cannot be read', async () => {
    const write = vi.fn()
    expect(await restoreVanishedTaskbarPin(pinDeps({ readPinRecord: async () => null, writeShortcutLink: write }))).toBe('not-pinned')
    expect(write).not.toHaveBeenCalled()
  })

  it('does nothing at all off Windows', async () => {
    const read = vi.fn(async () => null)
    const write = vi.fn()
    const outcome = await restoreVanishedTaskbarPin(pinDeps({ platform: 'darwin', readPinRecord: read, writeShortcutLink: write }))
    expect(outcome).toBe('skipped')
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('does nothing without a pin path (APPDATA unset)', async () => {
    const read = vi.fn(async () => null)
    expect(await restoreVanishedTaskbarPin(pinDeps({ pinPath: null, readPinRecord: read }))).toBe('skipped')
    expect(read).not.toHaveBeenCalled()
  })

  it('writes a SHORT description, as the repair does', async () => {
    const write = vi.fn().mockReturnValue(true)
    await restoreVanishedTaskbarPin(pinDeps({ description: 'y'.repeat(400), writeShortcutLink: write }))
    const written = write.mock.calls[0][2] as ShortcutLinkDetails
    expect(written.description!.length).toBe(SAFE_DESCRIPTION_LIMIT)
  })

  it('reports failed when the shortcut cannot be written', async () => {
    expect(await restoreVanishedTaskbarPin(pinDeps({ writeShortcutLink: () => false }))).toBe('failed')
  })

  it('never rejects: a write that throws is reported as failed', async () => {
    const outcome = await restoreVanishedTaskbarPin(pinDeps({ writeShortcutLink: () => { throw new Error('locked') } }))
    expect(outcome).toBe('failed')
  })

  it('never rejects: a pin-record read that rejects is reported as failed', async () => {
    const outcome = await restoreVanishedTaskbarPin(pinDeps({ readPinRecord: async () => { throw new Error('reg.exe gone') } }))
    expect(outcome).toBe('failed')
  })

  it('logs the restore when a logger is supplied', async () => {
    const log = vi.fn()
    await restoreVanishedTaskbarPin(pinDeps({ log }))
    expect(log).toHaveBeenCalledWith(expect.stringContaining(PIN))
  })
})
