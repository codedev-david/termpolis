import { describe, it, expect, vi } from 'vitest'
import {
  repairWindowsShortcuts,
  isShortcutDamaged,
  defaultShortcutPaths,
  MAX_LNK_STRING,
  SAFE_DESCRIPTION_LIMIT,
  type ShortcutLinkDetails,
  type ShortcutRepairDeps,
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
