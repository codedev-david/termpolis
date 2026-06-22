import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

// Regression guard for the v1.15.9 "generic taskbar icon" bug.
//
// src/main/index.ts createWindow() builds the window icon from assets/ via
//   nativeImage.createFromPath(join(__dirname, '../../assets', iconFile))
// but build.files only listed "out/**/*", so assets/ never shipped INSIDE
// app.asar. nativeImage then returned an empty image and Windows fell back to
// the generic taskbar icon. These assertions tie the runtime icon path → the
// electron-builder files allowlist → the files that must exist on disk, so the
// three can never drift apart silently again.

const root = join(__dirname, '../..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

describe('packaging: window-icon assets are bundled', () => {
  it('build.files includes the assets directory (so it ships inside app.asar)', () => {
    expect(pkg.build.files).toContain('assets/**/*')
  })

  it('ships the exact icon files createWindow() loads at runtime', () => {
    // win32 -> assets/icon.ico, every other platform -> assets/logo-termpolis.png
    for (const rel of ['assets/icon.ico', 'assets/logo-termpolis.png']) {
      expect(existsSync(join(root, rel)), `${rel} is referenced by createWindow() and must exist`).toBe(true)
    }
  })

  it('build.win.icon points at a file that exists (the exe-embedded icon)', () => {
    expect(typeof pkg.build.win.icon).toBe('string')
    expect(existsSync(join(root, pkg.build.win.icon))).toBe(true)
  })
})
