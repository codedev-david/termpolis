import { MAX_DEVICE_LABEL, sanitizeDeviceLabel } from '../src/wire/deviceLabel'

/**
 * The phone's copy of the desktop's sanitiser.
 *
 * Two labels reach this file. The one the user types when renaming a desktop,
 * and the one the DESKTOP sends in the sealed ack -- which is the interesting
 * one: it crosses the relay, it is drawn in a list, and the seal proves only
 * which desktop sent it, not that the desktop was careful about what it put in.
 *
 * `remoteMobileInterop.test.ts` holds this and the desktop's copy to the same
 * answers. This file pins what those answers are.
 */
describe('sanitizeDeviceLabel', () => {
  it('keeps an ordinary name as it is', () => {
    expect(sanitizeDeviceLabel('Workshop Linux box')).toBe('Workshop Linux box')
  })

  it('trims the ends', () => {
    expect(sanitizeDeviceLabel('  Workshop  ')).toBe('Workshop')
  })

  it('drops control characters rather than escaping them', () => {
    // Escaping would still put the bytes on screen. These are dropped because
    // the label is drawn beside live terminal output, where an escape sequence
    // is a way to redraw a pane the label has no business touching.
    expect(sanitizeDeviceLabel(`bell${String.fromCharCode(7)}ringer`)).toBe('bellringer')
    expect(sanitizeDeviceLabel(`two${String.fromCharCode(10)}lines`)).toBe('twolines')
    expect(sanitizeDeviceLabel(`car${String.fromCharCode(13)}riage`)).toBe('carriage')
    expect(sanitizeDeviceLabel(`del${String.fromCharCode(127)}ete`)).toBe('delete')
    expect(sanitizeDeviceLabel(`tab${String.fromCharCode(9)}bed`)).toBe('tabbed')
  })

  it('keeps astral characters whole', () => {
    // The filter walks code points, so a surrogate pair is one item and both of
    // its code units are well above the control range. Splitting one would put
    // a lone surrogate into a React text node.
    expect(sanitizeDeviceLabel('desk 🖥 top')).toBe('desk 🖥 top')
  })

  it('caps a long name, then trims what the cut left behind', () => {
    expect(sanitizeDeviceLabel('n'.repeat(500))).toBe('n'.repeat(MAX_DEVICE_LABEL))
    // Cutting mid-string can leave a trailing space, which would draw as a row
    // that looks mis-indented. Hence the second trim.
    expect(sanitizeDeviceLabel(`${'n'.repeat(63)} tail`)).toBe('n'.repeat(63))
  })

  it('answers with nothing for anything that is not a usable string', () => {
    // These arrive off a parsed JSON payload, so every one of them is reachable
    // from a desktop -- or a relay -- that sends something unexpected.
    expect(sanitizeDeviceLabel(undefined)).toBe('')
    expect(sanitizeDeviceLabel(null)).toBe('')
    expect(sanitizeDeviceLabel(42)).toBe('')
    expect(sanitizeDeviceLabel({})).toBe('')
    expect(sanitizeDeviceLabel([])).toBe('')
    expect(sanitizeDeviceLabel('   ')).toBe('')
    expect(sanitizeDeviceLabel(String.fromCharCode(7))).toBe('')
  })

  it('holds the limit where the desktop holds it', () => {
    expect(MAX_DEVICE_LABEL).toBe(64)
  })
})
