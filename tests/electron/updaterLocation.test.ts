// The macOS location check and the one-time Move to Applications offer. Everything Electron would do
// arrives injected, so every path runs here on any OS — with real files, never fs mocks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import {
  bundlePathFromExe,
  detectUpdateBlocker,
  readOnlyBlockerFor,
  updateBlockerHint,
  readUpdaterPrefs,
  writeUpdaterPrefs,
  shouldOfferMoveToApplications,
  offerMoveToApplications,
  MOVE_OFFER_DIALOG,
  MOVE_FAILED_DIALOG,
  type MoveOfferDeps,
  type UpdateBlocker,
} from '../../src/main/updaterLocation'

const EXE = '/Applications/Termpolis.app/Contents/MacOS/Termpolis'
const DMG_EXE = '/Volumes/Termpolis 1.49.0-arm64/Termpolis.app/Contents/MacOS/Termpolis'
const TRANSLOCATED_EXE =
  '/private/var/folders/xy/abc123/T/AppTranslocation/0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0/d/Termpolis.app/Contents/MacOS/Termpolis'

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: failed, access`), { code })
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termpolis-updater-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('bundlePathFromExe', () => {
  it('finds the .app bundle a macOS executable lives in', () => {
    expect(bundlePathFromExe(EXE)).toBe('/Applications/Termpolis.app')
    expect(bundlePathFromExe(DMG_EXE)).toBe('/Volumes/Termpolis 1.49.0-arm64/Termpolis.app')
  })

  it('is null for anything that is not a bundle executable', () => {
    expect(bundlePathFromExe('C:\\Program Files\\Termpolis\\Termpolis.exe')).toBeNull()
    expect(bundlePathFromExe('/opt/Termpolis/termpolis')).toBeNull()
    expect(bundlePathFromExe('/Applications/Termpolis.app/Contents/MacOS/')).toBeNull()
    expect(bundlePathFromExe('/Applications/Termpolis.app/Contents/MacOS/sub/Termpolis')).toBeNull()
  })
})

describe('detectUpdateBlocker', () => {
  it.each(['win32', 'linux'] as const)('is never a blocker on %s, and probes nothing', async (platform) => {
    const probe = vi.fn(async () => {})
    expect(await detectUpdateBlocker({ platform, exePath: DMG_EXE, probe })).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('is not a blocker when there is no bundle to go on', async () => {
    const probe = vi.fn(async () => {})
    expect(await detectUpdateBlocker({ platform: 'darwin', exePath: '/usr/local/bin/termpolis', probe })).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('knows App Translocation from the path alone', async () => {
    const probe = vi.fn(async () => {})
    expect(await detectUpdateBlocker({ platform: 'darwin', exePath: TRANSLOCATED_EXE, probe })).toBe('translocated')
    expect(probe).not.toHaveBeenCalled()
  })

  it("probes the bundle's parent, which an install has to write to", async () => {
    const probe = vi.fn(async () => {})
    expect(await detectUpdateBlocker({ platform: 'darwin', exePath: EXE, probe })).toBeNull()
    expect(probe).toHaveBeenCalledWith('/Applications')
  })

  it('calls a read-only disk under /Volumes the disk image, and any other read-only disk read-only', async () => {
    const probe = vi.fn(async () => {
      throw errno('EROFS')
    })
    expect(await detectUpdateBlocker({ platform: 'darwin', exePath: DMG_EXE, probe })).toBe('disk-image')
    expect(probe).toHaveBeenCalledWith('/Volumes/Termpolis 1.49.0-arm64')
    const exe = '/Users/x/Mounted/Termpolis.app/Contents/MacOS/Termpolis'
    expect(await detectUpdateBlocker({ platform: 'darwin', exePath: exe, probe })).toBe('read-only')
  })

  it('lets a writable external drive update', async () => {
    const probe = vi.fn(async () => {})
    expect(await detectUpdateBlocker({ platform: 'darwin', exePath: DMG_EXE, probe })).toBeNull()
  })

  it.each(['EACCES', 'EPERM'])('calls %s no permission', async (code) => {
    const probe = async () => {
      throw errno(code)
    }
    expect(await detectUpdateBlocker({ platform: 'darwin', exePath: EXE, probe })).toBe('no-permission')
  })

  it.each([errno('ENOENT'), errno('EIO'), new Error('no code'), 'a string', undefined, null])(
    'never switches updates off on a guess (%s)',
    async (reason) => {
      const probe = () => Promise.reject(reason)
      expect(await detectUpdateBlocker({ platform: 'darwin', exePath: EXE, probe })).toBeNull()
    },
  )

  it('probes the real disk by default', async () => {
    const root = dir.replace(/\\/g, '/')
    const writable = `${root}/Termpolis.app/Contents/MacOS/Termpolis`
    expect(await detectUpdateBlocker({ platform: 'darwin', exePath: writable })).toBeNull()
    // Nowhere to write is ENOENT, not a read-only disk.
    const missing = `${root}/missing/Termpolis.app/Contents/MacOS/Termpolis`
    expect(await detectUpdateBlocker({ platform: 'darwin', exePath: missing })).toBeNull()
  })
})

describe('readOnlyBlockerFor', () => {
  it('says which read-only place a bundle is in, as far as its path tells', () => {
    expect(readOnlyBlockerFor(bundlePathFromExe(TRANSLOCATED_EXE))).toBe('translocated')
    expect(readOnlyBlockerFor(bundlePathFromExe(DMG_EXE))).toBe('disk-image')
    expect(readOnlyBlockerFor('/Applications/Termpolis.app')).toBe('read-only')
    expect(readOnlyBlockerFor(null)).toBe('read-only')
  })
})

describe('updateBlockerHint', () => {
  const blockers: UpdateBlocker[] = ['disk-image', 'translocated', 'read-only', 'no-permission']

  it('has its own plain hint for every blocker', () => {
    const hints = blockers.map(updateBlockerHint)
    expect(new Set(hints).size).toBe(blockers.length)
    for (const hint of hints) expect(hint).toMatch(/can't update itself/)
  })

  it('sends the user to Applications only where that fixes it', () => {
    for (const blocker of ['disk-image', 'translocated', 'read-only'] as const) {
      expect(updateBlockerHint(blocker)).toMatch(/into your Applications folder and open it from there/)
    }
    // A standard account can't write to /Applications either.
    expect(updateBlockerHint('no-permission')).not.toMatch(/Applications/)
    expect(updateBlockerHint('no-permission')).toMatch(/administrator/)
  })
})

describe('readUpdaterPrefs / writeUpdaterPrefs', () => {
  it('round-trips every answer, creating the folder it lives in', () => {
    const file = join(dir, 'nested', 'updater-prefs.json')
    for (const moveOffer of ['declined', 'moved', 'failed'] as const) {
      expect(writeUpdaterPrefs(file, { moveOffer })).toBe(true)
      expect(readUpdaterPrefs(file)).toEqual({ moveOffer })
    }
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ moveOffer: 'failed' })
  })

  it('reads a missing file as no prefs', () => {
    expect(readUpdaterPrefs(join(dir, 'absent.json'))).toEqual({})
  })

  it.each(['{', '', 'null', '42', '"declined"', '[]', '{"moveOffer":"maybe"}', '{"moveOffer":1}', '{"other":true}'])(
    'reads %s as no prefs',
    (content) => {
      const file = join(dir, 'updater-prefs.json')
      writeFileSync(file, content)
      expect(readUpdaterPrefs(file)).toEqual({})
    },
  )

  it('keeps only what it knows', () => {
    const file = join(dir, 'updater-prefs.json')
    writeFileSync(file, JSON.stringify({ moveOffer: 'declined', other: true }))
    expect(readUpdaterPrefs(file)).toEqual({ moveOffer: 'declined' })
  })

  it("says so when the disk won't take them", () => {
    const blocker = join(dir, 'a-file')
    writeFileSync(blocker, 'x')
    expect(writeUpdaterPrefs(join(blocker, 'updater-prefs.json'), { moveOffer: 'declined' })).toBe(false)
  })
})

describe('shouldOfferMoveToApplications', () => {
  it('offers on macOS, outside Applications, until it has been answered once', () => {
    expect(shouldOfferMoveToApplications({ platform: 'darwin', inApplicationsFolder: false, prefs: {} })).toBe(true)
    expect(shouldOfferMoveToApplications({ platform: 'darwin', inApplicationsFolder: true, prefs: {} })).toBe(false)
    for (const moveOffer of ['declined', 'moved', 'failed'] as const) {
      expect(shouldOfferMoveToApplications({ platform: 'darwin', inApplicationsFolder: false, prefs: { moveOffer } })).toBe(
        false,
      )
    }
  })

  it.each(['win32', 'linux'] as const)('never offers on %s', (platform) => {
    expect(shouldOfferMoveToApplications({ platform, inApplicationsFolder: false, prefs: {} })).toBe(false)
  })
})

describe('MOVE_OFFER_DIALOG', () => {
  it('moves only on an explicit choice: Return picks Move, Escape and closing pick Not now', () => {
    expect(MOVE_OFFER_DIALOG.buttons[MOVE_OFFER_DIALOG.defaultId!]).toBe('Move to Applications')
    expect(MOVE_OFFER_DIALOG.buttons[MOVE_OFFER_DIALOG.cancelId!]).toBe('Not now')
    expect(MOVE_OFFER_DIALOG.detail).toMatch(/won't be asked again/)
    expect(MOVE_OFFER_DIALOG.detail).toMatch(/restarts Termpolis/)
  })
})

describe('offerMoveToApplications', () => {
  let order: string[]
  let prefsPath: string

  beforeEach(() => {
    order = []
    prefsPath = join(dir, 'updater-prefs.json')
  })

  function deps(overrides: Partial<MoveOfferDeps> = {}): MoveOfferDeps {
    return {
      platform: 'darwin',
      prefsPath,
      isInApplicationsFolder: vi.fn(() => false),
      moveToApplicationsFolder: vi.fn(() => {
        order.push(`move with prefs ${JSON.stringify(readUpdaterPrefs(prefsPath))}`)
        return true
      }),
      showMessageBox: vi.fn(async () => ({ response: 0 })),
      setQuitBypass: vi.fn((armed: boolean) => {
        order.push(`bypass ${armed}`)
      }),
      log: vi.fn(),
      ...overrides,
    }
  }

  it.each(['win32', 'linux'] as const)('never offers on %s', async (platform) => {
    const d = deps({ platform })
    expect(await offerMoveToApplications(d)).toBe('not-offered')
    expect(d.isInApplicationsFolder).not.toHaveBeenCalled()
    expect(d.showMessageBox).not.toHaveBeenCalled()
  })

  it("doesn't offer where Electron can't tell where the app is", async () => {
    const d = deps({ isInApplicationsFolder: undefined })
    expect(await offerMoveToApplications(d)).toBe('not-offered')
    expect(d.showMessageBox).not.toHaveBeenCalled()
  })

  it("doesn't offer when asking where the app is throws", async () => {
    const d = deps({
      isInApplicationsFolder: () => {
        throw new Error('NSWorkspace went away')
      },
    })
    expect(await offerMoveToApplications(d)).toBe('not-offered')
    expect(d.showMessageBox).not.toHaveBeenCalled()
  })

  it("doesn't offer to an app already in Applications", async () => {
    const d = deps({ isInApplicationsFolder: () => true })
    expect(await offerMoveToApplications(d)).toBe('not-offered')
    expect(d.showMessageBox).not.toHaveBeenCalled()
    expect(existsSync(prefsPath)).toBe(false)
  })

  it.each(['declined', 'moved', 'failed'] as const)('never asks again once the answer was %s', async (moveOffer) => {
    writeUpdaterPrefs(prefsPath, { moveOffer })
    const d = deps()
    expect(await offerMoveToApplications(d)).toBe('not-offered')
    expect(d.showMessageBox).not.toHaveBeenCalled()
  })

  it('asks again next launch when the dialog never showed', async () => {
    const d = deps({ showMessageBox: vi.fn(async () => Promise.reject(new Error('no window server'))) })
    expect(await offerMoveToApplications(d)).toBe('not-offered')
    expect(d.moveToApplicationsFolder).not.toHaveBeenCalled()
    expect(readUpdaterPrefs(prefsPath)).toEqual({})
  })

  it('remembers "Not now" and never nags', async () => {
    const d = deps({ showMessageBox: vi.fn(async () => ({ response: 1 })) })
    expect(await offerMoveToApplications(d)).toBe('declined')
    expect(d.showMessageBox).toHaveBeenCalledWith(MOVE_OFFER_DIALOG)
    expect(d.moveToApplicationsFolder).not.toHaveBeenCalled()
    expect(d.setQuitBypass).not.toHaveBeenCalled()
    expect(readUpdaterPrefs(prefsPath)).toEqual({ moveOffer: 'declined' })

    const next = deps()
    expect(await offerMoveToApplications(next)).toBe('not-offered')
    expect(next.showMessageBox).not.toHaveBeenCalled()
  })

  it('saves the answer and arms the close-guard bypass BEFORE a move that quits from inside the call', async () => {
    const d = deps()
    expect(await offerMoveToApplications(d)).toBe('moved')
    expect(order).toEqual(['bypass true', 'move with prefs {"moveOffer":"moved"}'])
    expect(d.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('takes a cancelled administrator prompt as "Not now", and disarms the bypass', async () => {
    const d = deps({ moveToApplicationsFolder: vi.fn(() => false) })
    expect(await offerMoveToApplications(d)).toBe('declined')
    expect(vi.mocked(d.setQuitBypass).mock.calls).toEqual([[true], [false]])
    expect(readUpdaterPrefs(prefsPath)).toEqual({ moveOffer: 'declined' })
    expect(d.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('tells the user how to move it by hand when the move fails, and logs why without their name', async () => {
    const d = deps({
      moveToApplicationsFolder: vi.fn(() => {
        throw new Error(`Failed to copy ${homedir()}/Downloads/Termpolis.app to /Applications/Termpolis.app`)
      }),
    })
    expect(await offerMoveToApplications(d)).toBe('failed')
    expect(vi.mocked(d.setQuitBypass).mock.calls).toEqual([[true], [false]])
    expect(readUpdaterPrefs(prefsPath)).toEqual({ moveOffer: 'failed' })
    expect(d.showMessageBox).toHaveBeenLastCalledWith(MOVE_FAILED_DIALOG)
    expect(d.log).toHaveBeenCalledWith(
      '[updater] Move to Applications failed: Failed to copy ~/Downloads/Termpolis.app to /Applications/Termpolis.app',
    )
  })

  it('survives a failed move that throws a non-Error, with no logger and no warning dialog', async () => {
    const showMessageBox = vi
      .fn<MoveOfferDeps['showMessageBox']>()
      .mockResolvedValueOnce({ response: 0 })
      .mockRejectedValueOnce(new Error('window closed'))
    const d = deps({
      showMessageBox,
      log: undefined,
      moveToApplicationsFolder: () => {
        throw 'copy failed'
      },
    })
    expect(await offerMoveToApplications(d)).toBe('failed')
    expect(showMessageBox).toHaveBeenCalledTimes(2)
    expect(readUpdaterPrefs(prefsPath)).toEqual({ moveOffer: 'failed' })
  })

  it("logs a non-Error failure's text", async () => {
    const d = deps({
      moveToApplicationsFolder: () => {
        throw 'copy failed'
      },
    })
    expect(await offerMoveToApplications(d)).toBe('failed')
    expect(d.log).toHaveBeenCalledWith('[updater] Move to Applications failed: copy failed')
  })

  it("still answers when the prefs can't be saved (the offer then returns next launch)", async () => {
    const blocker = join(dir, 'a-file')
    writeFileSync(blocker, 'x')
    const d = deps({ prefsPath: join(blocker, 'updater-prefs.json'), showMessageBox: vi.fn(async () => ({ response: 1 })) })
    expect(await offerMoveToApplications(d)).toBe('declined')
  })
})
