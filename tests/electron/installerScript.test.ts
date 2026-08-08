import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

// Guard for the v1.16.2 "stale taskbar icon after update" fix. Termpolis updates
// rewrite the exe at the same path every release, and Windows' per-user icon cache
// can keep serving an OLD icon even though the new exe embeds the correct one
// (the v1.15.10 generic-icon fix called this cache caveat out). The NSIS installer
// now refreshes the icon cache on install via a customInstall hook. These assertions
// tie the electron-builder config to the on-disk script so the two can't drift.

const root = join(__dirname, '../..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

describe('packaging: shortcut description stays inside the Shell Link string limit', () => {
  // THE root cause of the recurring "generic taskbar icon" bug. electron-builder
  // passes package.json `description` to NSIS as the shortcut's description, which
  // lands in the .lnk StringData block. Each StringData field is bounded at MAX_PATH
  // (260 chars); an over-long description overruns it and CORRUPTS the fields written
  // straight after it — WORKING_DIR and, fatally, ICON_LOCATION.
  //
  // Measured with a 288-char description: IconLocation read back as "xe?,0" — an
  // unresolvable path, so Windows fell back to a generic icon. At 40 chars it read
  // back intact. Because the app also declares a matching AppUserModelID, Windows
  // resolves the taskbar icon from the SHORTCUT, so a corrupt IconLocation beats the
  // window icon set in main — which is why setting an AUMID + window icon (v1.15.10)
  // and refreshing the icon cache (v1.16.2) both failed to fix it.
  const MAX_LNK_STRING = 260

  it('keeps package.json description under the 260-char .lnk StringData limit', () => {
    expect(pkg.description.length).toBeLessThan(MAX_LNK_STRING)
  })

  it('leaves real headroom rather than sitting on the boundary', () => {
    // A description that creeps back to ~259 would be one word away from silently
    // corrupting every shortcut again, with no test failure to warn us.
    expect(pkg.description.length).toBeLessThanOrEqual(220)
  })
})

describe('packaging: NSIS installer refreshes the Windows icon cache', () => {
  it('references the custom NSIS include script from build.nsis.include', () => {
    expect(pkg.build.nsis.include).toBe('build/installer.nsh')
  })

  it('ships that include script on disk', () => {
    expect(existsSync(join(root, 'build/installer.nsh'))).toBe(true)
  })

  it('rebuilds the icon cache in a customInstall hook (ie4uinit -show)', () => {
    const nsh = readFileSync(join(root, 'build/installer.nsh'), 'utf8')
    expect(nsh).toMatch(/!macro\s+customInstall/)
    expect(nsh).toMatch(/ie4uinit\.exe.*-ClearIconCache/)
    expect(nsh).toMatch(/ie4uinit\.exe.*-show/)
    expect(nsh).toMatch(/!macroend/)
  })

  it('reaches the real System32 ie4uinit by bypassing WOW64 redirection', () => {
    // The NSIS installer is 32-bit; on 64-bit Windows $SYSDIR redirects to SysWOW64,
    // which has NO ie4uinit.exe, so the refresh would silently no-op. The script must
    // disable FS redirection (or use Sysnative) to hit the real System32 copy.
    const nsh = readFileSync(join(root, 'build/installer.nsh'), 'utf8')
    expect(nsh).toMatch(/DisableX64FSRedirection|Sysnative/)
  })
})
