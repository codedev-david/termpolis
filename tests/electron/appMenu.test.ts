import { describe, it, expect, vi } from 'vitest'
import { applicationMenuTemplate, installApplicationMenu, globalHotkeys } from '../../src/main/appMenu'

describe('applicationMenuTemplate', () => {
  // On mac the edit-role menu is the ONLY thing that makes Cmd+C/V/X/A/Z and Cmd+Q work in native
  // inputs. Without it a Mac user cannot paste an API key or quit with Cmd+Q.
  it('macOS gets app + edit + window role menus', () => {
    const tmpl = applicationMenuTemplate('darwin')
    expect(tmpl).not.toBeNull()
    expect(tmpl!.map((m) => m.role)).toEqual(['appMenu', 'editMenu', 'windowMenu'])
  })

  it('Windows and Linux get NO menu — they draw their own title bar', () => {
    expect(applicationMenuTemplate('win32')).toBeNull()
    expect(applicationMenuTemplate('linux')).toBeNull()
  })
})

describe('installApplicationMenu', () => {
  const makeMenu = () => ({ buildFromTemplate: vi.fn((t) => ({ built: t })), setApplicationMenu: vi.fn() })

  // The exact failure the macOS CI runner hit: on darwin the install path BUILDS a menu, so it calls
  // buildFromTemplate. Running only on Windows, nothing ever exercised this — a mock without the
  // method threw during whenReady and cascaded into 44 unrelated failures. This test runs everywhere.
  it('macOS builds the role menu and installs it', () => {
    const menu = makeMenu()
    installApplicationMenu(menu, 'darwin')
    expect(menu.buildFromTemplate).toHaveBeenCalledWith([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    expect(menu.setApplicationMenu).toHaveBeenCalledWith({ built: expect.anything() })
  })

  it('Windows/Linux install a null menu and never build one', () => {
    for (const p of ['win32', 'linux']) {
      const menu = makeMenu()
      installApplicationMenu(menu, p)
      expect(menu.buildFromTemplate).not.toHaveBeenCalled()
      expect(menu.setApplicationMenu).toHaveBeenCalledWith(null)
    }
  })
})

describe('globalHotkeys', () => {
  // Super maps to Cmd on macOS, so Super+Shift+T would hijack Cmd+Shift+T (reopen-tab) from every
  // other app. Mac must use a different, non-system combo.
  it('macOS avoids the Cmd+Shift combos that belong to other apps', () => {
    const hk = globalHotkeys('darwin')
    expect(hk.newTerminal).toBe('Control+Alt+T')
    expect(hk.toggleSwarm).toBe('Control+Alt+S')
    expect(hk.newTerminal).not.toContain('Super')
    expect(hk.toggleSwarm).not.toContain('Super')
  })

  it('Windows and Linux keep Win+Shift+T / Win+Shift+S', () => {
    for (const p of ['win32', 'linux']) {
      const hk = globalHotkeys(p)
      expect(hk.newTerminal).toBe('Super+Shift+T')
      expect(hk.toggleSwarm).toBe('Super+Shift+S')
    }
  })
})
