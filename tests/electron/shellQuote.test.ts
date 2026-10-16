import { describe, it, expect } from 'vitest'
import { psQuote, shQuote } from '../../src/shared/shellQuote'

describe('psQuote', () => {
  it('wraps text in a PowerShell single-quoted literal', () => {
    expect(psQuote('C:\\Users\\me\\.termpolis-conductor-task.md')).toBe("'C:\\Users\\me\\.termpolis-conductor-task.md'")
  })

  it('doubles a single quote, and each typographic quote PowerShell also reads as one', () => {
    expect(psQuote("C:\\Users\\O'Brien")).toBe("'C:\\Users\\O''Brien'")
    for (const q of ['\u2018', '\u2019', '\u201a', '\u201b']) {
      expect(psQuote(`a${q}b`)).toBe(`'a${q}${q}b'`)
    }
  })

  it('leaves $, a backtick and double quotes alone, since nothing expands inside the literal', () => {
    expect(psQuote('$env:USERPROFILE `n "x"')).toBe('\'$env:USERPROFILE `n "x"\'')
  })
})

describe('shQuote', () => {
  it('wraps text in a POSIX single-quoted string', () => {
    expect(shQuote('/home/me/.termpolis-conductor-task.md')).toBe("'/home/me/.termpolis-conductor-task.md'")
  })

  it('closes the quote around an apostrophe, escapes it and reopens', () => {
    expect(shQuote("/home/o'brien")).toBe("'/home/o'\\''brien'")
  })

  it('leaves $, a backtick and double quotes literal', () => {
    expect(shQuote('$HOME `id` "x"')).toBe('\'$HOME `id` "x"\'')
  })
})
