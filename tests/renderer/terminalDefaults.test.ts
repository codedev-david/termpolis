import { describe, it, expect, beforeEach } from 'vitest'
import {
  FACTORY_TERMINAL_DEFAULTS,
  getTerminalDefaults,
  setTerminalDefaults,
  resetTerminalDefaults,
  clampFontSize,
  isAgentNameFromFolderEnabled,
  setAgentNameFromFolderEnabled,
  agentTerminalName,
} from '../../src/renderer/src/lib/terminalDefaults'

const DEFAULTS_KEY = 'termpolis.terminal.defaults'

beforeEach(() => {
  localStorage.clear()
})

describe('getTerminalDefaults / setTerminalDefaults', () => {
  it('returns the factory values when nothing is saved', () => {
    expect(getTerminalDefaults()).toEqual(FACTORY_TERMINAL_DEFAULTS)
  })

  it('overlays saved preferences and persists merges across calls', () => {
    setTerminalDefaults({ theme: 'nord' })
    expect(getTerminalDefaults()).toEqual({ ...FACTORY_TERMINAL_DEFAULTS, theme: 'nord' })
    setTerminalDefaults({ fontSize: 18 })
    // Earlier patch survives the later one (merge, not replace).
    expect(getTerminalDefaults()).toEqual({ ...FACTORY_TERMINAL_DEFAULTS, theme: 'nord', fontSize: 18 })
  })

  it('clamps and rounds the font size on read and write', () => {
    setTerminalDefaults({ fontSize: 99 })
    expect(getTerminalDefaults().fontSize).toBe(32)
    setTerminalDefaults({ fontSize: 3 })
    expect(getTerminalDefaults().fontSize).toBe(8)
    setTerminalDefaults({ fontSize: 13.6 })
    expect(getTerminalDefaults().fontSize).toBe(14)
  })

  it('falls back to factory values for corrupt or partial saved data', () => {
    localStorage.setItem(DEFAULTS_KEY, 'not json{{{')
    expect(getTerminalDefaults()).toEqual(FACTORY_TERMINAL_DEFAULTS)
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify({ fontSize: 'huge', theme: 7, fontFamily: '' }))
    expect(getTerminalDefaults()).toEqual(FACTORY_TERMINAL_DEFAULTS)
  })

  it('resetTerminalDefaults returns to factory values', () => {
    setTerminalDefaults({ theme: 'light', fontSize: 20 })
    resetTerminalDefaults()
    expect(getTerminalDefaults()).toEqual(FACTORY_TERMINAL_DEFAULTS)
  })

  it('clampFontSize handles non-finite input', () => {
    expect(clampFontSize(NaN)).toBe(FACTORY_TERMINAL_DEFAULTS.fontSize)
    expect(clampFontSize(Infinity)).toBe(FACTORY_TERMINAL_DEFAULTS.fontSize)
  })
})

describe('agent terminal naming from launch folder', () => {
  it('is OFF by default and toggles via the setter', () => {
    expect(isAgentNameFromFolderEnabled()).toBe(false)
    setAgentNameFromFolderEnabled(true)
    expect(isAgentNameFromFolderEnabled()).toBe(true)
    setAgentNameFromFolderEnabled(false)
    expect(isAgentNameFromFolderEnabled()).toBe(false)
  })

  it('keeps the profile name while the option is off', () => {
    expect(agentTerminalName('Claude Code', 'C:\\repos\\termpolis')).toBe('Claude Code')
  })

  it('uses the launch folder name when the option is on (windows + unix, trailing slashes)', () => {
    setAgentNameFromFolderEnabled(true)
    expect(agentTerminalName('Claude Code', 'C:\\repos\\termpolis')).toBe('termpolis')
    expect(agentTerminalName('Gemini CLI', '/home/david/projects/acme/')).toBe('acme')
  })

  it('falls back to the profile name for empty cwd or bare drive roots', () => {
    setAgentNameFromFolderEnabled(true)
    expect(agentTerminalName('Claude Code', '')).toBe('Claude Code')
    expect(agentTerminalName('Claude Code', 'C:\\')).toBe('Claude Code')
    expect(agentTerminalName('Claude Code', '/')).toBe('Claude Code')
  })
})
