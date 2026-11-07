import { describe, it, expect, afterEach, vi } from 'vitest'
import { switchEnabled, SWITCH_FIT_FLOOR, SWITCH_OUTPUT_CHUNKS, SWITCH_RESIZE_ORDER, SWITCH_RESIZE_TELL_FIRST } from '../../src/renderer/src/lib/paneSwitches'

// The kill switches of the 1.54.5 typing fixes: '0' turns a fix off, nothing else does.
describe('switchEnabled', () => {
  afterEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('names the two switches', () => {
    expect(SWITCH_OUTPUT_CHUNKS).toBe('termpolis.outputChunks')
    expect(SWITCH_RESIZE_ORDER).toBe('termpolis.resizeOrder')
  })

  it('is on when nothing was ever set', () => {
    expect(switchEnabled(SWITCH_OUTPUT_CHUNKS)).toBe(true)
    expect(switchEnabled(SWITCH_RESIZE_ORDER)).toBe(true)
  })

  it("is off only for '0', and each switch is its own", () => {
    window.localStorage.setItem(SWITCH_RESIZE_ORDER, '0')
    expect(switchEnabled(SWITCH_RESIZE_ORDER)).toBe(false)
    expect(switchEnabled(SWITCH_OUTPUT_CHUNKS)).toBe(true)
  })

  it.each(['1', 'true', 'off', '', 'no', '00'])('stays on for %j (a switch is turned off on purpose, with a 0)', (value) => {
    window.localStorage.setItem(SWITCH_OUTPUT_CHUNKS, value)
    expect(switchEnabled(SWITCH_OUTPUT_CHUNKS)).toBe(true)
  })

  it('termpolis.fitFloor is its own switch: off only for 0, and off leaves the resize order on', () => {
    expect(SWITCH_FIT_FLOOR).toBe('termpolis.fitFloor')
    expect(switchEnabled(SWITCH_FIT_FLOOR)).toBe(true)
    localStorage.setItem(SWITCH_FIT_FLOOR, '0')
    expect(switchEnabled(SWITCH_FIT_FLOOR)).toBe(false)
    expect(switchEnabled(SWITCH_RESIZE_ORDER)).toBe(true)
  })

  it('termpolis.resizeTellFirst (RZ2-1) is its own switch: off only for 0, and off leaves the resize order and the floor on', () => {
    expect(SWITCH_RESIZE_TELL_FIRST).toBe('termpolis.resizeTellFirst')
    expect(switchEnabled(SWITCH_RESIZE_TELL_FIRST)).toBe(true)
    localStorage.setItem(SWITCH_RESIZE_TELL_FIRST, '0')
    expect(switchEnabled(SWITCH_RESIZE_TELL_FIRST)).toBe(false)
    expect(switchEnabled(SWITCH_RESIZE_ORDER)).toBe(true)
    expect(switchEnabled(SWITCH_FIT_FLOOR)).toBe(true)
  })

  it('NEGATIVE CONTROL: storage that cannot be read leaves the fix ON, it never switches one off by accident', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError: storage is blocked') })
    expect(switchEnabled(SWITCH_OUTPUT_CHUNKS)).toBe(true)
    expect(switchEnabled(SWITCH_RESIZE_ORDER)).toBe(true)
  })
})
