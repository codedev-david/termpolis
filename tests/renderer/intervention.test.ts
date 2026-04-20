import { describe, it, expect, vi } from 'vitest'
import {
  buildCancelAction,
  buildInterruptAction,
  buildPauseAction,
  buildSteerAction,
  sendIntervention,
  CTRL_C,
  CTRL_D,
  ESC,
} from '../../src/renderer/src/lib/intervention'

describe('control-sequence constants', () => {
  it('CTRL_C is 0x03', () => {
    expect(CTRL_C.charCodeAt(0)).toBe(3)
  })
  it('CTRL_D is 0x04', () => {
    expect(CTRL_D.charCodeAt(0)).toBe(4)
  })
  it('ESC is 0x1B', () => {
    expect(ESC.charCodeAt(0)).toBe(0x1b)
  })
})

describe('buildPauseAction', () => {
  it('sends ESC', () => {
    const a = buildPauseAction()
    expect(a.kind).toBe('pause')
    expect(a.payload).toBe('\x1b')
    expect(a.label).toMatch(/Pause/)
  })
})

describe('buildCancelAction', () => {
  it('sends single Ctrl-C', () => {
    const a = buildCancelAction()
    expect(a.kind).toBe('cancel')
    expect(a.payload).toBe('\x03')
    expect(a.label).toMatch(/Cancel/)
  })
})

describe('buildInterruptAction', () => {
  it('sends double Ctrl-C', () => {
    const a = buildInterruptAction()
    expect(a.kind).toBe('interrupt')
    expect(a.payload).toBe('\x03\x03')
  })
})

describe('buildSteerAction', () => {
  it('appends newline so agent submits', () => {
    const a = buildSteerAction('use the other approach')
    expect(a.kind).toBe('steer')
    expect(a.payload).toBe('use the other approach\n')
  })

  it('preserves trailing newline without doubling', () => {
    const a = buildSteerAction('go faster\n')
    expect(a.payload).toBe('go faster\n')
  })

  it('trims leading/trailing whitespace', () => {
    const a = buildSteerAction('  do it  ')
    expect(a.payload).toBe('do it\n')
  })

  it('truncates label to 60 chars with ellipsis', () => {
    const long = 'a'.repeat(120)
    const a = buildSteerAction(long)
    expect(a.label.endsWith('…')).toBe(true)
    expect(a.label.length).toBeLessThan(80)
  })

  it('does not truncate short messages', () => {
    const a = buildSteerAction('short')
    expect(a.label).toBe('Steer: short')
  })

  it('rejects empty message', () => {
    expect(() => buildSteerAction('')).toThrow(/required/)
    expect(() => buildSteerAction('   ')).toThrow(/required/)
  })
})

describe('sendIntervention', () => {
  it('writes payload to writer and returns true on success', () => {
    const writer = { writeToTerminal: vi.fn() }
    const r = sendIntervention(writer, 'term-1', buildCancelAction())
    expect(r).toBe(true)
    expect(writer.writeToTerminal).toHaveBeenCalledWith('term-1', '\x03')
  })

  it('returns false when terminalId is empty', () => {
    const writer = { writeToTerminal: vi.fn() }
    expect(sendIntervention(writer, '', buildCancelAction())).toBe(false)
    expect(sendIntervention(writer, null, buildCancelAction())).toBe(false)
    expect(sendIntervention(writer, undefined, buildCancelAction())).toBe(false)
    expect(writer.writeToTerminal).not.toHaveBeenCalled()
  })

  it('returns false when writer is missing', () => {
    expect(sendIntervention(null as any, 'term-1', buildCancelAction())).toBe(false)
    expect(sendIntervention({} as any, 'term-1', buildCancelAction())).toBe(false)
  })

  it('writes the exact steer payload', () => {
    const writer = { writeToTerminal: vi.fn() }
    sendIntervention(writer, 'term-x', buildSteerAction('refactor it'))
    expect(writer.writeToTerminal).toHaveBeenCalledWith('term-x', 'refactor it\n')
  })
})
