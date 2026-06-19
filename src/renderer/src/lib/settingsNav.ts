// Lets a caller request which Settings tab should open next, race-free across
// the lazily-loaded SettingsPane. The caller sets the pending tab and THEN opens
// Settings (setShowSettings(true)); SettingsPane reads it in its initial state.
// This avoids the dispatch-before-mount race that an event-based approach hits
// when SettingsPane hasn't mounted (and attached its listener) yet.
//
// Lives in its own tiny module so importing it does NOT pull the heavy,
// lazy-loaded SettingsPane bundle into the caller (e.g. TerminalPane).
export type SettingsTab = 'general' | 'security' | 'voice' | 'keybindings' | 'agents' | 'shell'

let pending: SettingsTab | null = null

export function setPendingSettingsTab(tab: SettingsTab): void {
  pending = tab
}

// Returns the requested tab once and clears it, so a subsequent plain "open
// Settings" isn't hijacked to the previously-requested tab.
export function consumePendingSettingsTab(): SettingsTab | null {
  const t = pending
  pending = null
  return t
}
