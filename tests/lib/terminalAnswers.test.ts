import { describe, it, expect } from 'vitest'
import { isTerminalAnswer } from '../../src/shared/terminalAnswers'

describe('isTerminalAnswer (SW5-2)', () => {
  it.each([
    ['a cursor position report', '\x1b[12;1R'],
    ['an extended cursor position report', '\x1b[?12;1;1R'],
    ['primary device attributes', '\x1b[?62;22c'],
    ['secondary device attributes', '\x1b[>0;276;0c'],
    ['a status report', '\x1b[0n'],
    ['a mode report', '\x1b[?2004;2$y'],
    ['a window size report', '\x1b[8;24;80t'],
    ['an OSC colour answer ended by BEL', '\x1b]11;rgb:0000/0000/0000\x07'],
    ['an OSC colour answer ended by ST', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'],
    ['a DCS reply', '\x1bP1$r0m\x1b\\'],
    ['several answers in one write', '\x1b[12;1R\x1b[?62;22c'],
  ])('lets %s through', (_why, data) => {
    expect(isTerminalAnswer(data)).toBe(true)
  })

  it.each([
    ['a printable key', 'a'],
    ['a typed line', 'claude\r'],
    ['an answer with a key stuck to it', '\x1b[12;1Ra'],
    ['a key before an answer', 'a\x1b[12;1R'],
    ['a paste', '\x1b[200~text\x1b[201~'],
    ['a lone paste marker', '\x1b[201~'],
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['an X10 mouse report', '\x1b[M !!'],
    ['an SGR mouse report', '\x1b[<0;10;5M'],
    ['a cursor key', '\x1b[A'],
    ['an SS3 key', '\x1bOR'],
    ['Esc', '\x1b'],
    ['Alt+]', '\x1b]'],
    ['an unterminated OSC', '\x1b]11;rgb:0000/0000/0000'],
    ['an empty write', ''],
    ['no string', 42],
  ])('holds %s', (_why, data) => {
    expect(isTerminalAnswer(data)).toBe(false)
  })
})
