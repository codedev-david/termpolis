import { describe, it, expect } from 'vitest'
import { reflowSoftWraps, formatAsCodeBlock, formatAsPlainText, stripAnsi } from '../../src/renderer/src/lib/exportTerminal'

describe('reflowSoftWraps', () => {
  it('joins lines that exactly fill the terminal width (treated as soft-wrap)', () => {
    const cols = 20
    const physical = 'a'.repeat(20) + '\n' + 'b'.repeat(6)
    expect(reflowSoftWraps(physical, cols)).toBe('a'.repeat(20) + 'b'.repeat(6))
  })

  it('preserves logical newlines (lines shorter than cols)', () => {
    const cols = 20
    const text = 'short\nline\nhere'
    expect(reflowSoftWraps(text, cols)).toBe('short\nline\nhere')
  })

  it('handles a mix of soft and hard wraps', () => {
    const cols = 20
    // First physical line: 20 chars (soft wrap), continuation, hard newline,
    // then another short line.
    const physical = 'a'.repeat(20) + '\n' + 'rest!' + '\n' + 'next'
    expect(reflowSoftWraps(physical, cols)).toBe('a'.repeat(20) + 'rest!\nnext')
  })

  it('returns input untouched when cols is invalid or below threshold', () => {
    expect(reflowSoftWraps('abc\ndef', 0)).toBe('abc\ndef')
    expect(reflowSoftWraps('abc\ndef', 5)).toBe('abc\ndef') // < 20 threshold
    expect(reflowSoftWraps('abc\ndef', 19)).toBe('abc\ndef')
  })

  it('preserves trailing buffer when input ends mid-soft-wrap', () => {
    const cols = 20
    const physical = 'a'.repeat(20) + '\n' + 'tail'
    expect(reflowSoftWraps(physical, cols)).toBe('a'.repeat(20) + 'tail')
  })
})

describe('formatAsCodeBlock', () => {
  it('strips ANSI, reflows soft-wraps, and wraps in triple backticks', () => {
    const cols = 20
    const ansi = '\x1b[31m' + 'a'.repeat(20) + '\x1b[0m\nrest'
    const out = formatAsCodeBlock(ansi, cols)
    expect(out).toBe('```\n' + 'a'.repeat(20) + 'rest\n```')
  })

  it('trims leading/trailing blank lines inside the fence', () => {
    const cols = 80
    const text = '\n\nhello\n\n'
    const out = formatAsCodeBlock(text, cols)
    expect(out).toBe('```\nhello\n```')
  })

  it('strips trailing whitespace per line (xterm padding)', () => {
    const cols = 80
    const text = 'hello   \nworld\t\t'
    const out = formatAsCodeBlock(text, cols)
    expect(out).toBe('```\nhello\nworld\n```')
  })

  it('handles empty input gracefully', () => {
    expect(formatAsCodeBlock('', 80)).toBe('```\n\n```')
  })
})

describe('formatAsPlainText', () => {
  it('strips ANSI and reflows without fencing', () => {
    const cols = 80
    const text = '\x1b[32mhello world\x1b[0m'
    expect(formatAsPlainText(text, cols)).toBe('hello world')
  })

  it('does not produce backticks', () => {
    const out = formatAsPlainText('a\nb', 80)
    expect(out).not.toContain('```')
  })
})

describe('stripAnsi (sanity)', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\x1b[31mfoo\x1b[0m')).toBe('foo')
  })
  it('removes OSC sequences with BEL terminator', () => {
    expect(stripAnsi('\x1b]0;title\x07hi')).toBe('hi')
  })
})
