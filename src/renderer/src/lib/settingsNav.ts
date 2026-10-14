// Lets a caller request which Settings tab should open next, race-free across
// the lazily-loaded SettingsPane. The caller sets the pending tab and THEN opens
// Settings (setShowSettings(true)); SettingsPane reads it in its initial state.
// This avoids the dispatch-before-mount race that an event-based approach hits
// when SettingsPane hasn't mounted (and attached its listener) yet.
//
// Settings that is open already never mounts again, so it can't read a request
// that way: requestSettingsTab then tells the mounted pane with an event as
// well, and the pane spends the request at once (useSettingsTab). A request is
// always spent where it lands, so a later plain "open Settings" isn't hijacked.
//
// Lives in its own tiny module so importing it does NOT pull the heavy,
// lazy-loaded SettingsPane bundle into the caller (e.g. TerminalPane).
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

export type SettingsTab = 'general' | 'memory' | 'security' | 'voice' | 'keybindings' | 'agents' | 'shell' | 'tokenSavings' | 'remote' | 'linked' | 'agentIntegration' | 'mcp' | 'processes'

/** Tells a mounted SettingsPane that a tab was requested. */
export const SETTINGS_TAB_REQUESTED = 'termpolis:settingsTabRequested'

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

/** Ask for `tab` whether Settings is open or not. Closed, the caller then opens it and it starts
 *  on `tab`. Open, it switches to `tab` now -- or, still loading, starts on it once it mounts. */
export function requestSettingsTab(tab: SettingsTab, settingsOpen: boolean): void {
  pending = tab
  if (settingsOpen) window.dispatchEvent(new Event(SETTINGS_TAB_REQUESTED))
}

/** SettingsPane's active tab: the one requested before it mounted, else General, and then any
 *  requested while it is open. */
export function useSettingsTab(): [SettingsTab, Dispatch<SetStateAction<SettingsTab>>] {
  const [tab, setTab] = useState<SettingsTab>(() => consumePendingSettingsTab() ?? 'general')
  useEffect(() => {
    const onRequest = (): void => {
      const next = consumePendingSettingsTab()
      if (next) setTab(next)
    }
    window.addEventListener(SETTINGS_TAB_REQUESTED, onRequest)
    return () => window.removeEventListener(SETTINGS_TAB_REQUESTED, onRequest)
  }, [])
  return [tab, setTab]
}
