import { describe, it, expect } from 'vitest'
import { matchesKeybinding, eventToKeybinding, DEFAULT_KEYBINDINGS, KEYBINDING_LABELS } from '../../src/renderer/src/lib/keybindings'

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
