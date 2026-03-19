import { describe, it, expect } from 'vitest'
import { TERMINAL_THEMES, getTheme, THEME_IDS } from '../../src/renderer/src/themes/terminalThemes'

describe('terminalThemes', () => {
  it('exports exactly 7 themes', () => {
    expect(THEME_IDS).toHaveLength(7)
  })

  it('every theme has required ITheme fields', () => {
    const requiredColors = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']

    for (const id of THEME_IDS) {
      const theme = getTheme(id)
      expect(theme.background).toBeTruthy()
      expect(theme.foreground).toBeTruthy()
      expect(theme.cursor).toBeTruthy()
      expect(theme.selectionBackground).toBeTruthy()
      for (const color of requiredColors) {
        expect(theme[color], `${id} missing ${color}`).toBeTruthy()
      }
    }
  })

  it('getTheme returns dark theme for unknown id', () => {
    const theme = getTheme('nonexistent')
    expect(theme.background).toBe('#1e1e1e')
  })

  it('each theme has a display name', () => {
    for (const id of THEME_IDS) {
      const meta = TERMINAL_THEMES[id]
      expect(meta.name).toBeTruthy()
    }
  })
})
