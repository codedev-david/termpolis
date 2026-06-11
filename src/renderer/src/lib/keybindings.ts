import type { CustomKeybinding } from '../types'

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
  // Per-agent launch shortcuts — map to the first four AI profiles, which are
  // always the built-in Claude / Codex / Gemini / Qwen defaults.
  launchAgent1: string
  launchAgent2: string
  launchAgent3: string
  launchAgent4: string
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
  // Ctrl+<digit> (no Shift): Shift mutates the digit into a symbol in
  // KeyboardEvent.key (1 → "!"), which matchesKeybinding could never match.
  launchAgent1: 'Ctrl+1',
  launchAgent2: 'Ctrl+2',
  launchAgent3: 'Ctrl+3',
  launchAgent4: 'Ctrl+4',
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
  launchAgent1: 'Launch Claude Code',
  launchAgent2: 'Launch OpenAI Codex',
  launchAgent3: 'Launch Gemini CLI',
  launchAgent4: 'Launch Qwen Code',
}

/** Human-readable label for a built-in keybinding action. */
export function describeBinding(action: keyof KeybindingMap): string {
  return KEYBINDING_LABELS[action]
}

// Normalize a combo so "Ctrl+Shift+C" and "Shift+Ctrl+C" compare equal.
function normalizeCombo(combo: string): string {
  return combo.toLowerCase().split('+').sort().join('+')
}

/**
 * Detect whether `combo` is already assigned to another *configurable* binding
 * (a built-in KeybindingMap action or a user custom binding). Returns the label
 * of the conflicting binding, or null if the combo is free. The built-in app
 * shortcuts that are not part of KeybindingMap (Ctrl+K, Alt+1..9, etc.) are out
 * of scope — only user-configurable bindings are checked.
 */
export function findKeybindingConflict(
  combo: string,
  keybindings: KeybindingMap,
  customKeybindings: CustomKeybinding[] = [],
  exclude: { action?: keyof KeybindingMap; customId?: string } = {},
): string | null {
  if (!combo) return null
  const target = normalizeCombo(combo)
  for (const action of Object.keys(keybindings) as (keyof KeybindingMap)[]) {
    if (exclude.action === action) continue
    if (keybindings[action] && normalizeCombo(keybindings[action]) === target) {
      return KEYBINDING_LABELS[action]
    }
  }
  for (const cb of customKeybindings) {
    if (exclude.customId === cb.id) continue
    if (cb.combo && normalizeCombo(cb.combo) === target) {
      return cb.label || 'Custom shortcut'
    }
  }
  return null
}

// The four per-agent launch bindings, in slot order. Slot i maps to the i-th
// AI profile (the built-in Claude/Codex/Gemini/Qwen always lead the list).
const LAUNCH_AGENT_SLOTS: (keyof KeybindingMap)[] = ['launchAgent1', 'launchAgent2', 'launchAgent3', 'launchAgent4']

/** Slot index (0..3) of the launch-agent binding matching this event, else null. */
export function matchLaunchAgentSlot(e: KeyboardEvent, keybindings: KeybindingMap): number | null {
  for (let i = 0; i < LAUNCH_AGENT_SLOTS.length; i++) {
    if (matchesKeybinding(e, keybindings[LAUNCH_AGENT_SLOTS[i]])) return i
  }
  return null
}

/**
 * Whether a custom-macro combo carries a "real" modifier (Ctrl or Alt). Shift
 * alone doesn't count: a bare key — or Shift+key — would hijack ordinary typing
 * the moment a terminal is active, so such combos are rejected/ignored.
 */
export function customComboHasModifier(combo: string): boolean {
  const parts = combo.toLowerCase().split('+')
  return parts.includes('ctrl') || parts.includes('alt')
}

/** The custom binding whose combo matches this event, else null. */
export function matchCustomKeybinding(e: KeyboardEvent, customKeybindings: CustomKeybinding[]): CustomKeybinding | null {
  for (const cb of customKeybindings) {
    if (cb.combo && customComboHasModifier(cb.combo) && matchesKeybinding(e, cb.combo)) return cb
  }
  return null
}

/**
 * True when a key event targets an editable field (so global app shortcuts —
 * e.g. the Ctrl+1..4 launch keys — shouldn't fire and pop a dialog while the
 * user is typing in a settings input). The xterm terminal is handled upstream.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null
  if (!el || typeof el.tagName !== 'string') return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
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
