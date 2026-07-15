// Application menu + global-hotkey accelerators, as PURE per-platform functions so the choices are
// unit-testable without booting Electron. index.ts does the actual Menu.setApplicationMenu /
// globalShortcut.register with what these return.
//
// Two macOS-specific facts drove this:
//
//   1. On macOS, the standard edit shortcuts (Cmd+C/V/X/A/Z) and Cmd+Q are delivered through the
//      NSMenu key equivalents, NOT by the renderer. `Menu.setApplicationMenu(null)` — which is right
//      on Windows/Linux, where the app draws its own title bar and wants no menu bar — leaves a Mac
//      with NO working copy/paste in any native input (Settings fields, the API-key box, the
//      Report-Problem box) and NO Cmd+Q. So mac gets a minimal role-based menu; the others get null.
//
//   2. Electron maps the `Super` accelerator to Cmd on macOS. Registering `Super+Shift+T` /
//      `Super+Shift+S` GLOBALLY there hijacks Cmd+Shift+T (reopen-closed-tab) and Cmd+Shift+S from
//      every other app while Termpolis runs. Mac needs a non-conflicting global combo.
import type { MenuItemConstructorOptions } from 'electron'

/**
 * The application-menu template for a platform, or null to install no menu.
 *
 * macOS: the app + edit + window role menus, so Cmd+Q and the standard edit shortcuts work in every
 * native input. Roles mean Electron supplies the correct labels and key equivalents per OS.
 * Windows/Linux: null — the app has a custom title bar and deliberately shows no menu bar (this is
 * the long-standing behaviour, preserved).
 */
export function applicationMenuTemplate(platform: string): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null
  return [
    { role: 'appMenu' },    // About / Services / Hide / Quit (Cmd+Q)
    { role: 'editMenu' },   // Undo / Redo / Cut / Copy / Paste / Select All — the whole point
    { role: 'windowMenu' }, // Minimize / Zoom / Close
  ]
}

/**
 * The GLOBAL (system-wide) hotkey accelerators for a platform.
 *
 * macOS uses Ctrl+Alt+T / Ctrl+Alt+S (Ctrl+Option), which are not standard system shortcuts, instead
 * of Super+Shift+* — because Super is Cmd there and Cmd+Shift+T/S belong to other apps. Windows/Linux
 * keep Super+Shift+T / Super+Shift+S (Win+Shift+*), the original bindings.
 */
export function globalHotkeys(platform: string): { newTerminal: string; toggleSwarm: string } {
  if (platform === 'darwin') {
    return { newTerminal: 'Control+Alt+T', toggleSwarm: 'Control+Alt+S' }
  }
  return { newTerminal: 'Super+Shift+T', toggleSwarm: 'Super+Shift+S' }
}
