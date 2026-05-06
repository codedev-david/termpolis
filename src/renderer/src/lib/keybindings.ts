export interface KeybindingMap {
  copy: string
  copyAsCodeBlock: string
  paste: string
  historySearch: string
  newTerminal: string
  closeTerminal: string
  nextTerminal: string
  prevTerminal: string
  toggleAutocomplete: string
  toggleSidebar: string
  toggleGrid: string
}

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  copy: 'Ctrl+Shift+C',
  copyAsCodeBlock: 'Ctrl+Shift+M',
  paste: 'Ctrl+Shift+V',
  historySearch: 'Ctrl+Shift+H',
  newTerminal: 'Ctrl+Shift+T',
  closeTerminal: 'Ctrl+Shift+W',
  nextTerminal: 'Ctrl+Tab',
  prevTerminal: 'Ctrl+Shift+Tab',
  toggleAutocomplete: 'Ctrl+Space',
  toggleSidebar: 'Ctrl+B',
  toggleGrid: 'Ctrl+Shift+G',
}

export const KEYBINDING_LABELS: Record<keyof KeybindingMap, string> = {
  copy: 'Copy',
  copyAsCodeBlock: 'Copy as Code Block (Slack/Teams)',
  paste: 'Paste',
  historySearch: 'Search History',
  newTerminal: 'New Terminal',
  closeTerminal: 'Close Terminal',
  nextTerminal: 'Next Terminal',
  prevTerminal: 'Previous Terminal',
  toggleAutocomplete: 'Trigger Autocomplete',
  toggleSidebar: 'Toggle Sidebar',
  toggleGrid: 'Toggle Split View',
}

// Check if a KeyboardEvent matches a keybinding string like "Ctrl+Shift+H"
export function matchesKeybinding(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const needCtrl = parts.includes('ctrl')
  const needShift = parts.includes('shift')
  const needAlt = parts.includes('alt')

  if (needCtrl !== (e.ctrlKey || e.metaKey)) return false
  if (needShift !== e.shiftKey) return false
  if (needAlt !== e.altKey) return false

  // Handle special key names
  if (key === 'tab') return e.key === 'Tab'
  if (key === 'space') return e.key === ' '
  if (key === 'enter') return e.key === 'Enter'
  if (key === 'escape') return e.key === 'Escape'

  return e.key.toLowerCase() === key
}

// Convert a KeyboardEvent to a keybinding string
export function eventToKeybinding(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')

  let key = e.key
  if (key === ' ') key = 'Space'
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return '' // modifier only
  parts.push(key.length === 1 ? key.toUpperCase() : key)
  return parts.join('+')
}
