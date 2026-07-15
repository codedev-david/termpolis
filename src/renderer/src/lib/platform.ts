// Which OS is the renderer running on, and — the part that actually matters for keyboard handling —
// which modifier key means "copy/paste/app-shortcut" here.
//
// On Windows and Linux that modifier is Ctrl. On macOS it is Cmd (the meta key), and Ctrl is
// reserved: Ctrl+C is SIGINT, Ctrl+V is readline quoted-insert. A handler that treats Ctrl as the
// copy modifier on mac SWALLOWS the interrupt — you cannot stop a runaway process from a Termpolis
// terminal on a Mac. That is the single worst defect an emulator can have, and it is why this lives
// in one place instead of `e.ctrlKey || e.metaKey` scattered across the renderer.
//
// platform comes from the main process (process.platform) over the sync preload bridge, so it is the
// real host platform, not navigator.platform sniffing.
import type { PlatformInfo } from '../types'

let cached: string | null = null

/** Test seam: force the platform. Pass null to fall back to the live bridge value again. */
export function __setPlatformForTests(platform: string | null): void {
  cached = platform
}

/** The host's process.platform ('darwin' | 'win32' | 'linux' | ...). Empty string if unknown. */
export function hostPlatform(): string {
  if (cached !== null) return cached
  try {
    const info = (window as { termpolis?: { platformInfo?: PlatformInfo } }).termpolis?.platformInfo
    return info?.platform ?? ''
  } catch {
    return ''
  }
}

/** Running on macOS? */
export function isMac(): boolean {
  return hostPlatform() === 'darwin'
}

/**
 * Did this keyboard event press the platform's PRIMARY modifier — Cmd on macOS, Ctrl elsewhere?
 *
 * The negation is load-bearing on mac: Cmd+C copies, but Ctrl+C must fall through to the shell as
 * SIGINT, so the Ctrl press must NOT read as the primary modifier. Symmetrically on Windows/Linux a
 * stray Win-key press must not read as Ctrl.
 */
export function primaryModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac() ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey)
}
