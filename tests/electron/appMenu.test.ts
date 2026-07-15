import { describe, it, expect } from 'vitest'
import { applicationMenuTemplate, globalHotkeys } from '../../src/main/appMenu'

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
