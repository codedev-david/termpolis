import type { CustomKeybinding } from '../types'

export interface KeybindingMap {
  copy: string
  copyForMessage: string
  copyAsCodeBlock: string
  paste: string
  historySearch: string
  terminalSearch: string
  newTerminal: string
  closeTerminal: string
  nextTerminal: string
  prevTerminal: string
  toggleAutocomplete: string
  toggleSidebar: string
  toggleGrid: string
  // Per-agent launch shortcuts — map to the first three AI profiles, which are
  // always the built-in Claude / Codex / Gemini defaults.
  launchAgent1: string
  launchAgent2: string
  launchAgent3: string
}

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  // The three copy hotkeys are RESERVED (see RESERVED_COPY_ACTIONS): always
  // these fixed combos, never remappable, never overridable by a custom binding.
  copy: 'Ctrl+Shift+C',
  copyForMessage: 'Ctrl+Shift+K',
  copyAsCodeBlock: 'Ctrl+Shift+Q',
  paste: 'Ctrl+Shift+V',
  historySearch: 'Ctrl+Shift+H',
  terminalSearch: 'Ctrl+Shift+F',
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
}

export const KEYBINDING_LABELS: Record<keyof KeybindingMap, string> = {
  copy: 'Copy',
  copyForMessage: 'Copy for Teams/Slack',
  copyAsCodeBlock: 'Copy as Code Block',
  paste: 'Paste',
  historySearch: 'Search History',
  terminalSearch: 'Find in Terminal',
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
}

/**
 * The three copy actions whose combos are RESERVED. They are always pinned to
 * their fixed defaults (Ctrl+Shift+C / K / Q): the settings UI renders them
 * read-only, the store refuses to remap them, and findKeybindingConflict reports
 * any custom binding that tries to claim one — so a custom hotkey can never
 * shadow or override them. Copy must Just Work, everywhere, always.
 */
export const RESERVED_COPY_ACTIONS = ['copy', 'copyForMessage', 'copyAsCodeBlock'] as const

export type ReservedCopyAction = (typeof RESERVED_COPY_ACTIONS)[number]

/** True when `action` is one of the reserved copy actions. */
export function isReservedAction(action: string): action is ReservedCopyAction {
  return (RESERVED_COPY_ACTIONS as readonly string[]).includes(action)
}

/**
 * Merge a (possibly partial / persisted) keybinding map over the defaults, then
 * FORCE every reserved copy action back to its fixed default. Persisted state
 * from an older build — e.g. `copyAsCodeBlock: 'Ctrl+Shift+M'` — must never
 * override a reserved combo on upgrade. This is the single choke point for that
 * guarantee; call it wherever keybindings are hydrated from disk.
 */
export function withReservedDefaults(partial?: Partial<KeybindingMap> | null): KeybindingMap {
  const merged: KeybindingMap = { ...DEFAULT_KEYBINDINGS, ...(partial ?? {}) }
  for (const action of RESERVED_COPY_ACTIONS) {
    merged[action] = DEFAULT_KEYBINDINGS[action]
  }
  return merged
}

/** Human-readable label for a built-in keybinding action. */
export function describeBinding(action: keyof KeybindingMap): string {
  return KEYBINDING_LABELS[action]
}

// Normalize a combo so "Ctrl+Shift+C" and "Shift+Ctrl+C" compare equal.
function normalizeCombo(combo: string): string {
  return combo.toLowerCase().split('+').sort().join('+')
}

// The reserved copy combos, normalized, for O(1) "is this combo reserved?" checks.
const RESERVED_COMBOS: ReadonlySet<string> = new Set(
  RESERVED_COPY_ACTIONS.map(action => normalizeCombo(DEFAULT_KEYBINDINGS[action])),
)

/**
 * True when `combo` is one of the three reserved copy combos (Ctrl+Shift+C / K /
 * Q), compared order-insensitively. A custom keybinding on a reserved combo can
 * never be created (the settings UI rejects it) and never fires (matchCustomKeybinding
 * skips it) — reserved copy Just Works, everywhere, always.
 */
export function isReservedCombo(combo: string): boolean {
  if (!combo) return false
  return RESERVED_COMBOS.has(normalizeCombo(combo))
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

// The three per-agent launch bindings, in slot order. Slot i maps to the i-th
// AI profile (the built-in Claude/Codex/Gemini always lead the list).
const LAUNCH_AGENT_SLOTS: (keyof KeybindingMap)[] = ['launchAgent1', 'launchAgent2', 'launchAgent3']

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
    if (!cb.combo) continue
    // A reserved copy combo can never be overridden by a custom binding, even a
    // stale/imported one — skip it so reserved copy always wins.
    if (isReservedCombo(cb.combo)) continue
    if (customComboHasModifier(cb.combo) && matchesKeybinding(e, cb.combo)) return cb
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
  if (!binding) return false // unset/undefined binding never matches (defensive)
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
