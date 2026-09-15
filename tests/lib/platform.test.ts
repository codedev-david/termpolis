import { describe, it, expect, afterEach } from 'vitest'
import { primaryModifier, isMac, hostPlatform, hostHomedir, __setPlatformForTests, __setHomedirForTests } from '../../src/renderer/src/lib/platform'

afterEach(() => {
  __setPlatformForTests(null)
  __setHomedirForTests(null)
})

// A keyboard event carries four independent modifier booleans; only ctrl and meta matter here.
const ev = (mods: { ctrl?: boolean; meta?: boolean } = {}) => ({
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
})

describe('primaryModifier — the copy/paste/shortcut modifier per platform', () => {
  it('on Windows, Ctrl is the modifier and the Win (meta) key is not', () => {
    __setPlatformForTests('win32')
    expect(primaryModifier(ev({ ctrl: true }))).toBe(true)
    expect(primaryModifier(ev({ meta: true }))).toBe(false)
    expect(primaryModifier(ev())).toBe(false)
  })

  it('on Linux, Ctrl is the modifier', () => {
    __setPlatformForTests('linux')
    expect(primaryModifier(ev({ ctrl: true }))).toBe(true)
    expect(primaryModifier(ev({ meta: true }))).toBe(false)
  })

  // The bug this whole file exists for. On macOS Ctrl+C is SIGINT — it must NOT read as the copy
  // modifier, or the terminal swallows the interrupt and a runaway process cannot be stopped.
  it('on macOS, Cmd is the modifier and Ctrl is NOT — so Ctrl+C falls through to the shell', () => {
    __setPlatformForTests('darwin')
    expect(primaryModifier(ev({ meta: true }))).toBe(true)   // Cmd+C copies
    expect(primaryModifier(ev({ ctrl: true }))).toBe(false)  // Ctrl+C is SIGINT, must fall through
  })

  // Cmd+Ctrl+C is ambiguous; resolve it AWAY from copy so a held Ctrl always preserves the interrupt.
  it('on macOS, Cmd+Ctrl together does NOT trigger the modifier (interrupt wins)', () => {
    __setPlatformForTests('darwin')
    expect(primaryModifier(ev({ meta: true, ctrl: true }))).toBe(false)
  })
})

describe('platform detection', () => {
  it('reads the forced platform', () => {
    __setPlatformForTests('darwin')
    expect(isMac()).toBe(true)
    expect(hostPlatform()).toBe('darwin')
    __setPlatformForTests('win32')
    expect(isMac()).toBe(false)
  })

  it('degrades to a non-mac, empty platform when the bridge is absent', () => {
    __setPlatformForTests(null) // fall back to the live window, which has no termpolis in this test
    expect(isMac()).toBe(false)
    expect(hostPlatform()).toBe('')
  })
})

// The home directory is carried on the same synchronous payload as the platform because a
// Git Bash prompt reports `~/repos/x` and the renderer has no `process` to resolve it with.
// Without it normalizeShellPath left the tilde verbatim, the store held a path git could not
// chdir to, and the terminal-tab git mark reported "not a repository" inside a dirty repo.
describe('home directory — the expansion target for a shell-reported `~`', () => {
  it('reads the forced home directory', () => {
    __setHomedirForTests('C:\\Users\\dev')
    expect(hostHomedir()).toBe('C:\\Users\\dev')
  })

  // Empty is not a cosmetic default: normalizeShellPath reads an absent homedir as "leave the
  // tilde alone", so an unknown home degrades to the old behaviour instead of resolving `~`
  // against a guessed root and handing git a path that does not exist.
  it('degrades to an empty string when the bridge is absent, so `~` is left alone', () => {
    __setHomedirForTests(null) // fall back to the live window, which has no termpolis in this test
    expect(hostHomedir()).toBe('')
  })

  // The bridge can be present and still predate this field — an older main process, or a
  // renderer reloaded against a stale preload.
  it('degrades to an empty string when the bridge omits homedir', () => {
    __setHomedirForTests(null)
    const w = window as unknown as { termpolis?: unknown }
    w.termpolis = { platformInfo: { platform: 'win32', windowsPty: null } }
    try {
      expect(hostHomedir()).toBe('')
    } finally {
      delete w.termpolis
    }
  })
})
