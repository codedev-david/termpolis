// @vitest-environment node
//
// SW3-3: David's own wrapper (~/.claude/claude-run.sh) restarts Claude Code in place on another profile after a /switch-account,
// typed in Claude's own box, which the keys main sees do not always spell out (Claude draws completions itself). It prints one line
// first, and main's output buffer keeps the fact (a latch), since the line itself leaves the 32 KB window within moments of the
// resumed conversation redrawing.
import { describe, it, expect } from 'vitest'
import { appendOutput, takeRestarted } from '../../src/main/terminalOutputBuffer'
import type { OutputBuffers } from '../../src/main/terminalOutputBuffer'

const BANNER = 'Switching this terminal to work: starting Claude again on its profile and resuming the conversation...'
const mark = (): OutputBuffers => new Map()

describe('the restart banner of ~/.claude/claude-run.sh (SW3-3)', () => {
  it('is latched when it is printed, and given up once', () => {
    const b = mark()
    appendOutput(b, 't1', `\r\n${BANNER}\r\n`)
    expect(takeRestarted(b, 't1')).toBe(true)
    expect(takeRestarted(b, 't1')).toBe(false)
  })

  it('is latched whichever account it names, and wherever it sits in a chunk', () => {
    for (const name of ['personal', 'codedev', 'work']) {
      const b = mark()
      appendOutput(b, 't1', `some output\r\nSwitching this terminal to ${name}: starting Claude again on its profile and resuming...\r\nmore`)
      expect(takeRestarted(b, 't1')).toBe(true)
    }
  })

  // Wherever the chunks part, the line is latched once, by the chunk that completes its mark and never by a seam read twice.
  const MARK_END = BANNER.indexOf(': starting Claude again on its profile') + ': starting Claude again on its profile'.length
  it.each([...Array(BANNER.length - 1).keys()].map((k) => k + 1))('is latched when a chunk ends %i characters into it', (cut) => {
    const b = mark()
    appendOutput(b, 't1', `before\r\n${BANNER.slice(0, cut)}`)
    const early = takeRestarted(b, 't1')
    expect(early).toBe(cut >= MARK_END)
    appendOutput(b, 't1', `${BANNER.slice(cut)}\r\nafter`)
    expect(takeRestarted(b, 't1')).toBe(!early)
  })

  it('is latched when it arrives a character at a time', () => {
    const b = mark()
    for (const ch of BANNER) appendOutput(b, 't1', ch)
    expect(takeRestarted(b, 't1')).toBe(true)
  })

  it('is latched across three chunks, the middle one too short to hold the mark', () => {
    const b = mark()
    appendOutput(b, 't1', 'Switching this terminal to work: sta')
    appendOutput(b, 't1', 'rting Claude a')
    appendOutput(b, 't1', 'gain on its profile')
    expect(takeRestarted(b, 't1')).toBe(true)
  })

  it('is not latched by other output, a half of it, or the words in another order', () => {
    const b = mark()
    appendOutput(b, 't1', 'Switching this terminal to work\r\n')
    appendOutput(b, 't1', 'starting Claude again on its profile\r\n')
    appendOutput(b, 't1', ': starting Claude again on its own\r\n')
    appendOutput(b, 't1', 'x'.repeat(100_000))
    expect(takeRestarted(b, 't1')).toBe(false)
    expect(takeRestarted(b, 'nobody')).toBe(false)
  })

  it('stays latched after the window let the banner go', () => {
    const b = mark()
    appendOutput(b, 't1', `${BANNER}\r\n`)
    for (let i = 0; i < 40; i++) appendOutput(b, 't1', 'y'.repeat(2000))
    expect(takeRestarted(b, 't1')).toBe(true)
  })

  it('is latched again by the next banner once given up', () => {
    const b = mark()
    appendOutput(b, 't1', BANNER)
    expect(takeRestarted(b, 't1')).toBe(true)
    appendOutput(b, 't1', `\r\n${BANNER}`)
    expect(takeRestarted(b, 't1')).toBe(true)
  })

  it('is kept apart per terminal', () => {
    const b = mark()
    appendOutput(b, 't1', BANNER)
    appendOutput(b, 't2', 'nothing')
    expect(takeRestarted(b, 't2')).toBe(false)
    expect(takeRestarted(b, 't1')).toBe(true)
  })

  // CH4-4: the line is the wrapper's only at a line start, with the account it names. Its own source, shown by cat or grep, and a
  // sentence quoting it are not a restart.
  it('is not latched by a cat or grep of claude-run.sh, or by a sentence that quotes the line', () => {
    const src = '    echo "Switching this terminal to $account: starting Claude again on its profile and resuming the conversation..."'
    for (const shown of [`${src}\r\n`, `claude-run.sh:77:${src}\r\n`, `\r\nThe wrapper says Switching this terminal to work: starting Claude again on its profile\r\n`]) {
      const b = mark()
      appendOutput(b, 't1', `$ cat ~/.claude/claude-run.sh\r\n${shown}`)
      expect(takeRestarted(b, 't1')).toBe(false)
    }
    const b = mark()
    for (const ch of `claude-run.sh:77:${src}\r\n`) appendOutput(b, 't1', ch)
    expect(takeRestarted(b, 't1')).toBe(false)
  })

  it('is latched after the colour and cursor codes a line can start with, and for an account named by its e-mail', () => {
    for (const lead of ['\x1b[?25h\x1b[0m', '\x1b]0;bash\x07', '\x1b[2K\x1b[1G']) {
      const b = mark()
      appendOutput(b, 't1', `\r\n${lead}Switching this terminal to someone.else@example.com: starting Claude again on its profile and resuming the conversation...`)
      expect(takeRestarted(b, 't1')).toBe(true)
    }
    const b = mark()
    appendOutput(b, 't1', 'output\r\n\x1b[0mSwitching this terminal to wo')
    appendOutput(b, 't1', 'rk: starting Claude again on its profile')
    expect(takeRestarted(b, 't1')).toBe(true)
  })
})
