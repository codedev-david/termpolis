import { describe, it, expect } from 'vitest'
import { sanitizeDeviceLabel, MAX_DEVICE_LABEL } from '../../src/main/remoteBridge/deviceLabel'

// Control characters are written as escapes throughout. A literal one in the
// source is invisible in a diff, and a test whose input silently lost its ESC
// asserts nothing at all.
const ESC = ''
const DEL = ''

describe('sanitizeDeviceLabel', () => {
  it('leaves an ordinary label alone', () => {
    expect(sanitizeDeviceLabel('Kitchen iPhone')).toBe('Kitchen iPhone')
  })

  it('strips an escape sequence rather than escaping it', () => {
    // The label is echoed into the device list beside a live terminal, and it
    // crosses the relay as text the phone chose. An ESC that survived is a way
    // to redraw a pane the label has no business touching.
    expect(sanitizeDeviceLabel(`${ESC}[2JPhone`)).toBe('[2JPhone')
  })

  it('drops every C0 control character', () => {
    const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('')
    expect(sanitizeDeviceLabel(`a${controls}b`)).toBe('ab')
  })

  it('drops DEL, which sits above the C0 range', () => {
    // `c > ''` alone would wave this through: 0x7f is greater than 0x1f.
    expect(sanitizeDeviceLabel(`a${DEL}b`)).toBe('ab')
  })

  it('keeps the space that ends the control range', () => {
    // 0x20 is the first printable character. An off-by-one here would collapse
    // every multi-word label into one word.
    expect(sanitizeDeviceLabel('two words')).toBe('two words')
  })

  it('trims the outside without touching the inside', () => {
    expect(sanitizeDeviceLabel('  Kitchen  iPhone  ')).toBe('Kitchen  iPhone')
  })

  it('caps a long label', () => {
    const long = 'x'.repeat(MAX_DEVICE_LABEL + 40)
    expect(sanitizeDeviceLabel(long)).toHaveLength(MAX_DEVICE_LABEL)
  })

  it('trims again after capping', () => {
    // The cut can land mid-space. Without the second trim the stored label ends
    // in whitespace the device list renders as a ragged right edge.
    const cut = `${'x'.repeat(MAX_DEVICE_LABEL - 1)}  tail`
    expect(sanitizeDeviceLabel(cut)).toBe('x'.repeat(MAX_DEVICE_LABEL - 1))
  })

  it('keeps an astral character whole', () => {
    // Iterating the string yields the surrogate PAIR, so the character is
    // compared as one unit and sorts well above the control range. Filtering
    // code units instead would cut an emoji in half and leave a lone surrogate.
    expect(sanitizeDeviceLabel('Phone 📱')).toBe('Phone 📱')
  })

  it('counts an astral character by its code units when capping', () => {
    // `slice` works on code units, so the cap bounds length rather than glyphs.
    // Asserted rather than left implicit: the point of the cap is that no label
    // can be unboundedly long, not that it holds exactly N glyphs.
    const emoji = '📱'.repeat(MAX_DEVICE_LABEL)
    expect(sanitizeDeviceLabel(emoji).length).toBe(MAX_DEVICE_LABEL)
  })

  it('answers with an empty string for anything that is not a string', () => {
    // The phone's hello is parsed JSON. `label` can be a number, an object, or
    // absent entirely, and none of those may reach `.trim()`.
    expect(sanitizeDeviceLabel(undefined)).toBe('')
    expect(sanitizeDeviceLabel(null)).toBe('')
    expect(sanitizeDeviceLabel(42)).toBe('')
    expect(sanitizeDeviceLabel({ label: 'Phone' })).toBe('')
    expect(sanitizeDeviceLabel(['Phone'])).toBe('')
  })

  it('answers with an empty string for a label that was only controls', () => {
    // The caller falls back to a default name on empty. It must get an empty
    // string to do that, not a run of invisible characters that renders blank
    // and compares unequal to everything.
    expect(sanitizeDeviceLabel(`${ESC}${DEL}`)).toBe('')
    expect(sanitizeDeviceLabel('   ')).toBe('')
  })
})
