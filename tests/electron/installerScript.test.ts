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
