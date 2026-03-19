import { describe, it, expect } from 'vitest'
import { stripAnsi, generateFilename } from '../../src/renderer/src/lib/exportTerminal'

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[0m')).toBe('red text')
  })

  it('removes cursor movement codes', () => {
    expect(stripAnsi('\x1b[2J\x1b[Hhello')).toBe('hello')
  })

  it('preserves plain text', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })

  it('removes OSC sequences with BEL terminator', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text')
  })

  it('removes OSC sequences with ST terminator', () => {
    expect(stripAnsi('\x1b]0;title\x1b\\text')).toBe('text')
  })
})

describe('generateFilename', () => {
  it('generates filename with terminal name and timestamp', () => {
    const name = generateFilename('My Terminal')
    expect(name).toMatch(/^My_Terminal_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.txt$/)
  })

  it('sanitizes special characters in terminal name', () => {
    const name = generateFilename('Terminal <1>/test')
    expect(name).not.toMatch(/[<>/]/)
    expect(name).toMatch(/\.txt$/)
  })
})
