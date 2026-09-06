import { describe, it, expect } from 'vitest'
import { matchesKeybinding, eventToKeybinding, DEFAULT_KEYBINDINGS, KEYBINDING_LABELS, findKeybindingConflict, describeBinding, matchLaunchAgentSlot, matchCustomKeybinding, customComboHasModifier, isEditableTarget, RESERVED_COPY_ACTIONS, isReservedAction, isReservedCombo, withReservedDefaults } from '../../src/renderer/src/lib/keybindings'
import type { CustomKeybinding } from '../../src/renderer/src/types'
import { DEFAULT_VOICE_SETTINGS } from '../../src/renderer/src/lib/voice/voiceTypes'

function key(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  } as KeyboardEvent
}

// ---------------------------------------------------------------------------
// matchesKeybinding
// ---------------------------------------------------------------------------

describe('matchesKeybinding', () => {
  it('matches Ctrl+Shift+C', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'c' }), 'Ctrl+Shift+C')).toBe(true)
  })

  it('returns false when Shift is required but missing', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, shiftKey: false, key: 'c' }), 'Ctrl+Shift+C')).toBe(false)
  })

  it('returns false when Ctrl is required but missing', () => {
    expect(matchesKeybinding(key({ ctrlKey: false, shiftKey: true, key: 'c' }), 'Ctrl+Shift+C')).toBe(false)
  })

  it('returns false when wrong key is pressed', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'x' }), 'Ctrl+Shift+C')).toBe(false)
  })

  it('matches Tab special key', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, key: 'Tab' }), 'Ctrl+Tab')).toBe(true)
  })

  it('returns false for Tab when wrong key', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, key: 't' }), 'Ctrl+Tab')).toBe(false)
  })

  it('matches Space special key', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, key: ' ' }), 'Ctrl+Space')).toBe(true)
  })

  it('matches Enter special key', () => {
    expect(matchesKeybinding(key({ key: 'Enter' }), 'Enter')).toBe(true)
  })

  it('matches Escape special key', () => {
    expect(matchesKeybinding(key({ key: 'Escape' }), 'Escape')).toBe(true)
  })

  it('accepts metaKey as equivalent to ctrlKey (Mac behavior)', () => {
    expect(matchesKeybinding(key({ metaKey: true, shiftKey: true, key: 'c' }), 'Ctrl+Shift+C')).toBe(true)
  })

  it('returns false when extra modifier altKey is pressed but binding has no Alt', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, shiftKey: true, altKey: true, key: 'c' }), 'Ctrl+Shift+C')).toBe(false)
  })

  it('matches case-insensitively (binding lowercase, key uppercase)', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'H' }), 'ctrl+shift+h')).toBe(true)
  })

  it('matches a no-modifier binding', () => {
    expect(matchesKeybinding(key({ key: 'b' }), 'b')).toBe(true)
  })

  it('returns false for no-modifier binding when Ctrl is held', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, key: 'b' }), 'b')).toBe(false)
  })

  it('returns false (never throws) for an unset/empty binding', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, key: 'f' }), '')).toBe(false)
    expect(matchesKeybinding(key({ ctrlKey: true, key: 'f' }), undefined as unknown as string)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// terminalSearch binding (in-terminal find bar)
// ---------------------------------------------------------------------------

describe('terminalSearch binding', () => {
  it('defaults to Ctrl+Shift+F', () => {
    expect(DEFAULT_KEYBINDINGS.terminalSearch).toBe('Ctrl+Shift+F')
  })

  it('has a find-flavored label', () => {
    expect(KEYBINDING_LABELS.terminalSearch).toMatch(/find|search/i)
  })

  it('matches a real Ctrl+Shift+F event', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'F' }), DEFAULT_KEYBINDINGS.terminalSearch)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// eventToKeybinding
// ---------------------------------------------------------------------------

describe('eventToKeybinding', () => {
  it('converts Ctrl+Shift+C event to "Ctrl+Shift+C"', () => {
    expect(eventToKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'c' }))).toBe('Ctrl+Shift+C')
  })

  it('returns empty string for modifier-only event (key=Control)', () => {
    expect(eventToKeybinding(key({ ctrlKey: true, key: 'Control' }))).toBe('')
  })

  it('returns empty string for Shift-only event (key=Shift)', () => {
    expect(eventToKeybinding(key({ shiftKey: true, key: 'Shift' }))).toBe('')
  })

  it('returns empty string for Alt-only event (key=Alt)', () => {
    expect(eventToKeybinding(key({ altKey: true, key: 'Alt' }))).toBe('')
  })

  it('returns empty string for Meta-only event (key=Meta)', () => {
    expect(eventToKeybinding(key({ metaKey: true, key: 'Meta' }))).toBe('')
  })

  it('converts Ctrl+Space (key=" ") to "Ctrl+Space"', () => {
    expect(eventToKeybinding(key({ ctrlKey: true, key: ' ' }))).toBe('Ctrl+Space')
  })

  it('includes Alt in output string', () => {
    expect(eventToKeybinding(key({ ctrlKey: true, altKey: true, key: 'a' }))).toBe('Ctrl+Alt+A')
  })

  it('uppercases single-char keys', () => {
    expect(eventToKeybinding(key({ key: 'g' }))).toBe('G')
  })

  it('preserves multi-char key names (Tab)', () => {
    expect(eventToKeybinding(key({ ctrlKey: true, key: 'Tab' }))).toBe('Ctrl+Tab')
  })

  it('preserves multi-char key names (Enter)', () => {
    expect(eventToKeybinding(key({ key: 'Enter' }))).toBe('Enter')
  })

  it('preserves multi-char key names (ArrowUp)', () => {
    expect(eventToKeybinding(key({ key: 'ArrowUp' }))).toBe('ArrowUp')
  })

  it('metaKey produces Ctrl+ prefix', () => {
    expect(eventToKeybinding(key({ metaKey: true, key: 'z' }))).toBe('Ctrl+Z')
  })
})

// ---------------------------------------------------------------------------
// copyAsCodeBlock binding (added v1.11.43)
// ---------------------------------------------------------------------------

describe('copyAsCodeBlock binding', () => {
  it('defaults to the reserved Ctrl+Shift+Q', () => {
    expect(DEFAULT_KEYBINDINGS.copyAsCodeBlock).toBe('Ctrl+Shift+Q')
  })

  it('has a code-block label', () => {
    expect(KEYBINDING_LABELS.copyAsCodeBlock).toMatch(/code block/i)
  })

  it('matches a real Ctrl+Shift+Q event', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'Q' }), 'Ctrl+Shift+Q')).toBe(true)
  })

  it('every default has a label', () => {
    for (const k of Object.keys(DEFAULT_KEYBINDINGS)) {
      expect(KEYBINDING_LABELS[k as keyof typeof KEYBINDING_LABELS]).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// copyForMessage binding (Copy for Teams/Slack) — added v1.30.3
// ---------------------------------------------------------------------------

describe('copyForMessage binding (Teams/Slack)', () => {
  it('defaults to the reserved Ctrl+Shift+K', () => {
    expect(DEFAULT_KEYBINDINGS.copyForMessage).toBe('Ctrl+Shift+K')
  })

  it('has a Teams/Slack label', () => {
    expect(KEYBINDING_LABELS.copyForMessage).toMatch(/Teams/i)
    expect(KEYBINDING_LABELS.copyForMessage).toMatch(/Slack/i)
  })

  it('matches a real Ctrl+Shift+K event', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'K' }), 'Ctrl+Shift+K')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Reserved copy actions — the three copy hotkeys are fixed defaults that a
// custom keybinding can never claim or override. (v1.30.3)
// ---------------------------------------------------------------------------

describe('reserved copy actions', () => {
  it('reserves copy, copyForMessage and copyAsCodeBlock', () => {
    expect([...RESERVED_COPY_ACTIONS].sort()).toEqual(['copy', 'copyAsCodeBlock', 'copyForMessage'])
  })

  it('isReservedAction is true for the three copy actions and false otherwise', () => {
    expect(isReservedAction('copy')).toBe(true)
    expect(isReservedAction('copyForMessage')).toBe(true)
    expect(isReservedAction('copyAsCodeBlock')).toBe(true)
    expect(isReservedAction('paste')).toBe(false)
    expect(isReservedAction('toggleSidebar')).toBe(false)
  })

  it('pins the reserved combos to Ctrl+Shift+C / K / Q', () => {
    expect(DEFAULT_KEYBINDINGS.copy).toBe('Ctrl+Shift+C')
    expect(DEFAULT_KEYBINDINGS.copyForMessage).toBe('Ctrl+Shift+K')
    expect(DEFAULT_KEYBINDINGS.copyAsCodeBlock).toBe('Ctrl+Shift+Q')
  })

  it('a custom keybinding cannot claim a reserved copy combo', () => {
    expect(findKeybindingConflict('Ctrl+Shift+K', DEFAULT_KEYBINDINGS, [])).toBe('Copy for Teams/Slack')
    expect(findKeybindingConflict('Ctrl+Shift+Q', DEFAULT_KEYBINDINGS, [])).toBe('Copy as Code Block')
  })

  it('isReservedCombo recognises the three reserved combos, order-insensitively', () => {
    expect(isReservedCombo('Ctrl+Shift+C')).toBe(true)
    expect(isReservedCombo('Ctrl+Shift+K')).toBe(true)
    expect(isReservedCombo('Ctrl+Shift+Q')).toBe(true)
    // normalization: modifier order must not matter
    expect(isReservedCombo('Shift+Ctrl+C')).toBe(true)
  })

  it('isReservedCombo is false for non-reserved and empty combos', () => {
    expect(isReservedCombo('Ctrl+Shift+V')).toBe(false)
    expect(isReservedCombo('Ctrl+C')).toBe(false)
    expect(isReservedCombo('Ctrl+Alt+C')).toBe(false)
    expect(isReservedCombo('')).toBe(false)
  })
})

describe('withReservedDefaults', () => {
  it('forces reserved copy combos back to their defaults, even against stale persisted values', () => {
    // Simulate an upgrade from a build where copyAsCodeBlock was Ctrl+Shift+M and
    // a user had somehow remapped copy — both must snap back to the reserved combos.
    const persisted = { copy: 'Ctrl+X', copyForMessage: 'Ctrl+Y', copyAsCodeBlock: 'Ctrl+Shift+M' }
    const kb = withReservedDefaults(persisted)
    expect(kb.copy).toBe('Ctrl+Shift+C')
    expect(kb.copyForMessage).toBe('Ctrl+Shift+K')
    expect(kb.copyAsCodeBlock).toBe('Ctrl+Shift+Q')
  })

  it('preserves non-reserved persisted overrides', () => {
    const kb = withReservedDefaults({ toggleSidebar: 'Ctrl+Alt+B', newTerminal: 'Ctrl+Alt+T' })
    expect(kb.toggleSidebar).toBe('Ctrl+Alt+B')
    expect(kb.newTerminal).toBe('Ctrl+Alt+T')
  })

  it('returns the full defaults for null/undefined input', () => {
    expect(withReservedDefaults(null)).toEqual(DEFAULT_KEYBINDINGS)
    expect(withReservedDefaults(undefined)).toEqual(DEFAULT_KEYBINDINGS)
  })
})

// ---------------------------------------------------------------------------
// launchAgent1..4 bindings (per-agent launch shortcuts)
// ---------------------------------------------------------------------------

describe('launchAgent bindings', () => {
  it('default to Ctrl+1 through Ctrl+3', () => {
    expect(DEFAULT_KEYBINDINGS.launchAgent1).toBe('Ctrl+1')
    expect(DEFAULT_KEYBINDINGS.launchAgent2).toBe('Ctrl+2')
    expect(DEFAULT_KEYBINDINGS.launchAgent3).toBe('Ctrl+3')
  })

  it('name the three default agents in their labels', () => {
    expect(KEYBINDING_LABELS.launchAgent1).toMatch(/Claude/i)
    expect(KEYBINDING_LABELS.launchAgent2).toMatch(/Codex/i)
    expect(KEYBINDING_LABELS.launchAgent3).toMatch(/Gemini/i)
  })

  it('Ctrl+1 default actually matches a real Ctrl+1 event (digit survives the matcher)', () => {
    // Regression guard: Ctrl+Shift+1 would arrive as key "!" and never match,
    // which is exactly why the defaults use Ctrl+<digit> with no Shift.
    expect(matchesKeybinding(key({ ctrlKey: true, key: '1' }), DEFAULT_KEYBINDINGS.launchAgent1)).toBe(true)
    expect(matchesKeybinding(key({ ctrlKey: true, shiftKey: true, key: '1' }), DEFAULT_KEYBINDINGS.launchAgent1)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// describeBinding
// ---------------------------------------------------------------------------

describe('describeBinding', () => {
  it('returns the human label for a built-in action', () => {
    expect(describeBinding('copy')).toBe(KEYBINDING_LABELS.copy)
    expect(describeBinding('launchAgent1')).toBe(KEYBINDING_LABELS.launchAgent1)
  })
})

// ---------------------------------------------------------------------------
// findKeybindingConflict
// ---------------------------------------------------------------------------

describe('findKeybindingConflict', () => {
  const custom: CustomKeybinding[] = [
    { id: 'c1', label: 'Git Status', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: true },
  ]

  it('returns null when the combo is free', () => {
    expect(findKeybindingConflict('Ctrl+Alt+Z', DEFAULT_KEYBINDINGS, custom)).toBeNull()
  })

  it('detects a clash with a built-in binding and returns its label', () => {
    expect(findKeybindingConflict('Ctrl+Shift+C', DEFAULT_KEYBINDINGS, custom)).toBe(KEYBINDING_LABELS.copy)
  })

  it('detects a clash with another custom binding and returns its label', () => {
    expect(findKeybindingConflict('Ctrl+Alt+G', DEFAULT_KEYBINDINGS, custom)).toBe('Git Status')
  })

  it('ignores the binding being edited (exclude.action)', () => {
    // Re-recording "copy" to its own current value is not a conflict with itself.
    expect(findKeybindingConflict('Ctrl+Shift+C', DEFAULT_KEYBINDINGS, custom, { action: 'copy' })).toBeNull()
  })

  it('ignores the custom binding being edited (exclude.customId)', () => {
    expect(findKeybindingConflict('Ctrl+Alt+G', DEFAULT_KEYBINDINGS, custom, { customId: 'c1' })).toBeNull()
  })

  it('is order-insensitive across modifiers', () => {
    expect(findKeybindingConflict('Shift+Ctrl+C', DEFAULT_KEYBINDINGS, custom)).toBe(KEYBINDING_LABELS.copy)
  })

  it('treats an empty combo as no conflict', () => {
    expect(findKeybindingConflict('', DEFAULT_KEYBINDINGS, custom)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// matchLaunchAgentSlot — maps a key event to a launch-agent slot index (0..3)
// ---------------------------------------------------------------------------

describe('matchLaunchAgentSlot', () => {
  it('returns slot 0 for the launchAgent1 combo (Ctrl+1)', () => {
    expect(matchLaunchAgentSlot(key({ ctrlKey: true, key: '1' }), DEFAULT_KEYBINDINGS)).toBe(0)
  })

  it('returns null for the retired launchAgent4 combo (Ctrl+4)', () => {
    expect(matchLaunchAgentSlot(key({ ctrlKey: true, key: '4' }), DEFAULT_KEYBINDINGS)).toBeNull()
  })

  it('returns null when no launch slot matches', () => {
    expect(matchLaunchAgentSlot(key({ ctrlKey: true, key: '9' }), DEFAULT_KEYBINDINGS)).toBeNull()
    expect(matchLaunchAgentSlot(key({ key: 'a' }), DEFAULT_KEYBINDINGS)).toBeNull()
  })

  it('follows a rebound launch combo', () => {
    const kb = { ...DEFAULT_KEYBINDINGS, launchAgent2: 'Ctrl+Alt+X' }
    expect(matchLaunchAgentSlot(key({ ctrlKey: true, altKey: true, key: 'x' }), kb)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// matchCustomKeybinding — finds the custom macro whose combo matches
// ---------------------------------------------------------------------------

describe('matchCustomKeybinding', () => {
  const custom: CustomKeybinding[] = [
    { id: 'c1', label: 'Git Status', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: true },
    { id: 'c2', label: 'Clear', combo: 'Ctrl+Alt+L', text: 'clear', runOnSend: true },
  ]

  it('returns the matching custom binding', () => {
    expect(matchCustomKeybinding(key({ ctrlKey: true, altKey: true, key: 'l' }), custom)?.id).toBe('c2')
  })

  it('never matches a custom binding parked on a reserved copy combo', () => {
    // Defense in depth: even if a custom binding somehow carries a reserved combo
    // (stale import, hand-edited store), it must never fire — the reserved copy
    // action owns Ctrl+Shift+C / K / Q and can never be overridden.
    const shadowing: CustomKeybinding[] = [
      { id: 'x1', label: 'Evil Copy', combo: 'Ctrl+Shift+C', text: 'rm -rf', runOnSend: true },
      { id: 'x2', label: 'Evil Teams', combo: 'Ctrl+Shift+K', text: 'nope', runOnSend: true },
      { id: 'x3', label: 'Evil Block', combo: 'Ctrl+Shift+Q', text: 'nope', runOnSend: true },
    ]
    expect(matchCustomKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'C' }), shadowing)).toBeNull()
    expect(matchCustomKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'K' }), shadowing)).toBeNull()
    expect(matchCustomKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'Q' }), shadowing)).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(matchCustomKeybinding(key({ ctrlKey: true, key: 'z' }), custom)).toBeNull()
  })

  it('skips custom bindings with an empty combo', () => {
    const blank: CustomKeybinding[] = [{ id: 'b', label: 'Blank', combo: '', text: 'x', runOnSend: false }]
    expect(matchCustomKeybinding(key({ key: '' }), blank)).toBeNull()
  })

  it('ignores a modifier-less custom combo so it cannot hijack a bare keypress', () => {
    const bad: CustomKeybinding[] = [{ id: 'g', label: 'Bad', combo: 'G', text: 'boom', runOnSend: true }]
    expect(matchCustomKeybinding(key({ key: 'g' }), bad)).toBeNull()
  })

  it('ignores a Shift-only custom combo (Shift is not enough)', () => {
    const bad: CustomKeybinding[] = [{ id: 's', label: 'Bad', combo: 'Shift+G', text: 'boom', runOnSend: true }]
    expect(matchCustomKeybinding(key({ shiftKey: true, key: 'g' }), bad)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// customComboHasModifier — custom macros must use Ctrl or Alt
// ---------------------------------------------------------------------------

describe('customComboHasModifier', () => {
  it('is false for a bare key or Shift-only', () => {
    expect(customComboHasModifier('G')).toBe(false)
    expect(customComboHasModifier('Shift+G')).toBe(false)
  })

  it('is true when Ctrl or Alt is present', () => {
    expect(customComboHasModifier('Ctrl+G')).toBe(true)
    expect(customComboHasModifier('Alt+G')).toBe(true)
    expect(customComboHasModifier('Ctrl+Alt+G')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isEditableTarget — guard so app shortcuts don't fire while typing in a field
// ---------------------------------------------------------------------------

describe('isEditableTarget', () => {
  it('is true for INPUT, TEXTAREA, and contentEditable elements', () => {
    expect(isEditableTarget({ tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'TEXTAREA', isContentEditable: false } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true)
  })

  it('is false for non-editable elements and null', () => {
    expect(isEditableTarget({ tagName: 'BUTTON', isContentEditable: false } as unknown as EventTarget)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Collision guard.
//
// Every default here is a Ctrl+Shift+<letter>, and the supply of those is small
// and already heavily spoken for -- by other defaults, by shortcuts hardcoded in
// App.tsx that never went through this map, and by voice push-to-talk, which
// lives in voiceTypes.ts and is the one nobody remembers. Adding `viewLogs` in
// v1.39.1 nearly took Ctrl+Shift+L, which would have silently broken dictation
// for anyone who had it enabled: both handlers fire, neither knows about the
// other, and nothing anywhere would have failed.
//
// So the guard is asserted rather than remembered. If a future default collides
// with anything already claimed, this test names both sides.
// ---------------------------------------------------------------------------

describe('default keybindings do not collide', () => {
  /** Shortcuts hardcoded in App.tsx's window keydown handler (`primaryMod && e.shiftKey
   *  && e.key === X`). They bypass this map entirely, so the map cannot see them --
   *  which is exactly why they have to be written down somewhere that runs. */
  const APP_TSX_HARDCODED: Record<string, string> = {
    'Ctrl+Shift+I': 'insights panel',
    'Ctrl+Shift+E': 'efficiency panel',
    'Ctrl+Shift+A': 'agent activity panel',
    'Ctrl+Shift+B': 'budget panel',
    'Ctrl+Shift+D': 'dashboard',
    'Ctrl+Shift+Y': 'redundancy panel',
    'Ctrl+Shift+M': 'memory panel',
    'Ctrl+Shift+P': 'prompt templates',
    'Ctrl+Shift+S': 'swarm dashboard',
  }

  it('assigns every action a distinct combo', () => {
    const seen = new Map<string, string>()
    for (const [action, combo] of Object.entries(DEFAULT_KEYBINDINGS)) {
      const prior = seen.get(combo)
      expect(prior, `${action} and ${prior} both default to ${combo}`).toBeUndefined()
      seen.set(combo, action)
    }
  })

  it('avoids every shortcut hardcoded in App.tsx', () => {
    for (const [action, combo] of Object.entries(DEFAULT_KEYBINDINGS)) {
      expect(
        APP_TSX_HARDCODED[combo],
        `${action} defaults to ${combo}, which App.tsx already uses for the ${APP_TSX_HARDCODED[combo]}`,
      ).toBeUndefined()
    }
  })

  it('avoids the voice push-to-talk key', () => {
    for (const [action, combo] of Object.entries(DEFAULT_KEYBINDINGS)) {
      expect(
        combo,
        `${action} defaults to the voice push-to-talk combo`,
      ).not.toBe(DEFAULT_VOICE_SETTINGS.pushToTalkKey)
    }
  })

  it('labels exactly the actions it binds', () => {
    expect(Object.keys(KEYBINDING_LABELS).sort()).toEqual(Object.keys(DEFAULT_KEYBINDINGS).sort())
    for (const label of Object.values(KEYBINDING_LABELS)) expect(label.trim()).not.toBe('')
  })

  it('binds the two actions v1.39.1 added', () => {
    expect(DEFAULT_KEYBINDINGS.viewLogs).toBe('Ctrl+Shift+O')
    expect(DEFAULT_KEYBINDINGS.clearTerminal).toBe('Ctrl+Shift+X')
  })
})
