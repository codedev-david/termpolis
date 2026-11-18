import { describe, expect, it } from 'vitest'
import { parseAnswerMarkdown, parseInline } from '../../src/shared/world/answerMarkdown'

describe('answer markdown (film bug 3)', () => {
  it('a list of bold names becomes list items with strong text, not literal stars', () => {
    expect(parseAnswerMarkdown('Main parts:\n- **TerminalPane** draws a terminal.\n- **Store** keeps state [E1].')).toEqual([
      { type: 'p', lines: [[{ t: 'text', v: 'Main parts:' }]] },
      {
        type: 'ul',
        items: [
          [{ t: 'b', c: [{ t: 'text', v: 'TerminalPane' }] }, { t: 'text', v: ' draws a terminal.' }],
          [{ t: 'b', c: [{ t: 'text', v: 'Store' }] }, { t: 'text', v: ' keeps state ' }, { t: 'marker', v: 'E1' }, { t: 'text', v: '.' }]
        ]
      }
    ])
  })

  it('numbered lists, * and + bullets, and a blank line splitting paragraphs', () => {
    expect(parseAnswerMarkdown('1. one\n2) two\n\n* a\n+ b\n\nEnd.')).toEqual([
      { type: 'ol', items: [[{ t: 'text', v: 'one' }], [{ t: 'text', v: 'two' }]] },
      { type: 'ul', items: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]] },
      { type: 'p', lines: [[{ t: 'text', v: 'End.' }]] }
    ])
  })

  it('a list kind change starts a new list; an indented line continues the item; a plain line after a list starts a paragraph', () => {
    expect(parseAnswerMarkdown('- a\n  more\n1. b\nAfter')).toEqual([
      { type: 'ul', items: [[{ t: 'text', v: 'a' }, { t: 'text', v: ' ' }, { t: 'text', v: 'more' }]] },
      { type: 'ol', items: [[{ t: 'text', v: 'b' }]] },
      { type: 'p', lines: [[{ t: 'text', v: 'After' }]] }
    ])
  })

  it('single newlines in a paragraph are separate lines; a heading is a bold line', () => {
    expect(parseAnswerMarkdown('## How it works\nline one\nline two')).toEqual([
      { type: 'p', lines: [[{ t: 'b', c: [{ t: 'text', v: 'How it works' }] }], [{ t: 'text', v: 'line one' }], [{ t: 'text', v: 'line two' }]] }
    ])
  })

  it('italic with * or _, inline code, and __bold__', () => {
    expect(parseInline('an *aside*, a _note_, `run()` and __this__')).toEqual([
      { t: 'text', v: 'an ' },
      { t: 'i', c: [{ t: 'text', v: 'aside' }] },
      { t: 'text', v: ', a ' },
      { t: 'i', c: [{ t: 'text', v: 'note' }] },
      { t: 'text', v: ', ' },
      { t: 'code', v: 'run()' },
      { t: 'text', v: ' and ' },
      { t: 'b', c: [{ t: 'text', v: 'this' }] }
    ])
  })

  it('snake_case names, a lone star, unclosed bold and stars inside code stay as they are', () => {
    expect(parseInline('snake_case_name 2 * 3 **open `a**b`')).toEqual([
      { t: 'text', v: 'snake_case_name 2 * 3 **open ' },
      { t: 'code', v: 'a**b' }
    ])
  })

  it('a marker inside bold is still a marker', () => {
    expect(parseInline('**Store [E2]**')).toEqual([{ t: 'b', c: [{ t: 'text', v: 'Store ' }, { t: 'marker', v: 'E2' }] }])
  })

  it('HTML is only ever text', () => {
    expect(parseAnswerMarkdown('<img src=x onerror=alert(1)> hi')).toEqual([{ type: 'p', lines: [[{ t: 'text', v: '<img src=x onerror=alert(1)> hi' }]] }])
  })

  it('empty text and blank lines give no blocks', () => {
    expect(parseAnswerMarkdown('')).toEqual([])
    expect(parseAnswerMarkdown('\n\n  \n')).toEqual([])
  })
})
