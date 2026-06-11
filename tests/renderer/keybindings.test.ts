import { describe, it, expect } from 'vitest'
import { matchesKeybinding, eventToKeybinding, DEFAULT_KEYBINDINGS, KEYBINDING_LABELS, findKeybindingConflict, describeBinding, matchLaunchAgentSlot, matchCustomKeybinding, customComboHasModifier, isEditableTarget } from '../../src/renderer/src/lib/keybindings'
import type { CustomKeybinding } from '../../src/renderer/src/types'

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
  it('defaults to Ctrl+Shift+M', () => {
    expect(DEFAULT_KEYBINDINGS.copyAsCodeBlock).toBe('Ctrl+Shift+M')
  })

  it('has a Slack/Teams-flavored label', () => {
    expect(KEYBINDING_LABELS.copyAsCodeBlock).toMatch(/Slack/i)
    expect(KEYBINDING_LABELS.copyAsCodeBlock).toMatch(/Teams/i)
  })

  it('matches a real Ctrl+Shift+M event', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'M' }), 'Ctrl+Shift+M')).toBe(true)
  })

  it('every default has a label', () => {
    for (const k of Object.keys(DEFAULT_KEYBINDINGS)) {
      expect(KEYBINDING_LABELS[k as keyof typeof KEYBINDING_LABELS]).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// launchAgent1..4 bindings (per-agent launch shortcuts)
// ---------------------------------------------------------------------------

describe('launchAgent bindings', () => {
  it('default to Ctrl+1 through Ctrl+4', () => {
    expect(DEFAULT_KEYBINDINGS.launchAgent1).toBe('Ctrl+1')
    expect(DEFAULT_KEYBINDINGS.launchAgent2).toBe('Ctrl+2')
    expect(DEFAULT_KEYBINDINGS.launchAgent3).toBe('Ctrl+3')
    expect(DEFAULT_KEYBINDINGS.launchAgent4).toBe('Ctrl+4')
  })

  it('name the four default agents in their labels', () => {
    expect(KEYBINDING_LABELS.launchAgent1).toMatch(/Claude/i)
    expect(KEYBINDING_LABELS.launchAgent2).toMatch(/Codex/i)
    expect(KEYBINDING_LABELS.launchAgent3).toMatch(/Gemini/i)
    expect(KEYBINDING_LABELS.launchAgent4).toMatch(/Qwen/i)
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

  it('returns slot 3 for the launchAgent4 combo (Ctrl+4)', () => {
    expect(matchLaunchAgentSlot(key({ ctrlKey: true, key: '4' }), DEFAULT_KEYBINDINGS)).toBe(3)
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
