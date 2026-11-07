import { describe, it, expect } from 'vitest'
import { detectAgentStatus, limitWords, stopKind } from '../../src/shared/agentStatusDetector'
import { screenOf } from '../../src/shared/terminalScreen'
import { limitKindOf } from '../../src/shared/accountLimits'
import limits from '../fixtures/agentScreensLimit.json'
import input from '../fixtures/agentScreensInput.json'

// The CLI's own words for the limit a screen shows (R15): what the usage-limit chooser shows, and
// what tells a model's limit from the whole account's. Read only once the detector said the screen
// shows a limit. Claude Code's screens are real captures (tests/fixtures); Codex's and agy's cells
// are built from the strings in their program files, as agentStatusLimits.test.ts builds them: no
// capture of either at a real limit exists.

const RULE = '─'.repeat(80)
const REPLY = '  ⎿  '
const CLAUDE_IDLE = ['', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)']
const CODEX_IDLE = ['', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~\\repos\\app']
const AGY_IDLE = ['', RULE, '> ', RULE, '  ? for shortcuts                                    Gemini 4 Argon · medium']

/** What the detector reads: a screen's rows joined. */
const text = (rows: string[]): string => rows.join('\n')
function realRows(raw: string, size: { cols: number; rows: number }): string[] {
  return screenOf(raw, size).lines()
}

describe('limitWords', () => {
  describe('on real Claude Code 2.1.304 screens', () => {
    const all = Object.entries(limits.captures)
      .filter(([name]) => !['after-todo', 'after-tool-search'].includes(name))
      .flatMap(([name, c]) => c.screens.map((s) => [name, s.cols, c.raw.slice(0, s.at), s] as const))
    it.each(all)('%s, at %i columns: the message, up to its zone', (_name, _cols, raw, size) => {
      const rows = realRows(raw, size)
      expect(stopKind(detectAgentStatus(text(rows), 'Claude', 'working', { screen: true }))).toBe('limit')
      expect(limitWords(text(rows))).toBe("You've hit your session limit · resets 8:10pm (America/New_York)")
    })

    it('reads the message heading its rate-limit menu', () => {
      const rows = realRows(input.rateLimitMenu.raw, input.rateLimitMenu)
      const menu = rows.slice(rows.findIndex((r) => r.startsWith('❯ /rate-limit-options')))
      const screen = ['❯ Build the login page.', `${REPLY}You've hit your weekly limit · resets Aug 1, 4pm (America/New_York)`, '', ...menu]
      expect(stopKind(detectAgentStatus(text(screen), 'Claude', 'working', { screen: true }))).toBe('limit')
      const words = limitWords(text(screen))
      expect(words).toBe("You've hit your weekly limit · resets Aug 1, 4pm (America/New_York)")
      expect(limitKindOf(words!)).toEqual({ scope: 'account', window: 'weekly' })
    })
  })

  it("reads a model's limit as the model's (R15)", () => {
    const words = limitWords(text(['❯ Plan the release.', `${REPLY}You've hit your Opus limit · resets Oct 24, 4pm (UTC)`, ...CLAUDE_IDLE]))
    expect(words).toBe("You've hit your Opus limit · resets Oct 24, 4pm (UTC)")
    expect(limitKindOf(words!)).toEqual({ scope: 'model', window: 'weekly', model: 'Opus' })
  })

  it('joins a zone a narrow screen broke across rows', () => {
    const words = limitWords(text(['❯ Plan it.', `${REPLY}You've hit your session limit · resets 8:10pm (America/New_Yo`, '     rk)', ...CLAUDE_IDLE]))
    expect(words).toBe("You've hit your session limit · resets 8:10pm (America/New_York)")
  })

  it('keeps a message that names no reset whole, the rows it wrapped onto too', () => {
    const words = limitWords(text(['❯ Plan it.', `${REPLY}You've hit your team's shared budget. /model to`, '     switch models.', ...CLAUDE_IDLE]))
    expect(words).toBe("You've hit your team's shared budget. /model to switch models.")
  })

  it("reads Claude Code waiting out its limit, which says only that, when no message is on screen", () => {
    const rows = ['● I will build the page.', '', '✻ Usage limit reached · continuing automatically at', '3pm · esc to cancel', '', RULE, '❯ ', RULE]
    expect(limitWords(text(rows))).toBe('Usage limit reached · continuing automatically at 3pm · esc to cancel')
  })

  it('prefers the message itself over the wait it chose', () => {
    const rows = ['❯ Build it.', `${REPLY}You've hit your weekly limit · resets Aug 1, 4pm (America/New_York)`, '', '✻ Usage limit reached · continuing automatically at Aug 1, 4pm · esc to cancel', '', RULE, '❯ ', RULE]
    expect(limitWords(text(rows))).toBe("You've hit your weekly limit · resets Aug 1, 4pm (America/New_York)")
  })

  it("reads Codex's error cell, wrapped as Codex wraps it", () => {
    const rows = ['› Fix the login test', '', '• I will fix the test.', '', '■ You\'ve hit your usage limit for gpt-5.6-sol. Switch to another model now, or', 'try again at 4:15 PM.', ...CODEX_IDLE]
    expect(stopKind(detectAgentStatus(text(rows), 'Codex', 'working', { screen: true }))).toBe('limit')
    const words = limitWords(text(rows))
    expect(words).toBe("You've hit your usage limit for gpt-5.6-sol. Switch to another model now, or try again at 4:15 PM.")
    expect(limitKindOf(words!)).toEqual({ scope: 'model', window: 'other', model: 'gpt-5.6-sol' })
  })

  it("reads Codex's popup in place of its composer by its title", () => {
    const rows = ['  Usage limit reached', '  Request a limit increase from your owner to continue using codex.', '  Request increase?', '', '› 1. Yes', '  2. No', '', '  Press enter to confirm or esc to go back']
    expect(stopKind(detectAgentStatus(text(rows), 'Codex', 'working', { screen: true }))).toBe('limit')
    expect(limitWords(text(rows))).toBe('Usage limit reached Request a limit increase from your owner to continue using codex. Request increase?')
  })

  it("reads agy's cell", () => {
    const rows = ['> Write the docs', '', '✕ You have exhausted your quota on this', 'model.', ...AGY_IDLE]
    expect(stopKind(detectAgentStatus(text(rows), 'Gemini', 'working', { screen: true }))).toBe('limit')
    const words = limitWords(text(rows))
    expect(words).toBe('You have exhausted your quota on this model.')
    expect(limitKindOf(words!)).toEqual({ scope: 'model', window: 'other' })
  })

  it('stops a cell at the next one, a rule or a blank row', () => {
    expect(limitWords(text(['■ You\'ve hit your usage limit. Try again at 4:15 PM.', '⚠ Falling back to HTTPS.', ...CODEX_IDLE])))
      .toBe("You've hit your usage limit. Try again at 4:15 PM.")
    expect(limitWords(text([`${REPLY}You've hit your limit`, RULE, '❯ ', RULE]))).toBe("You've hit your limit")
  })

  it('reads only the bottom of the screen, and gives null when no limit is there', () => {
    const old = [`${REPLY}You've hit your session limit · resets 3pm (UTC)`, ...Array.from({ length: 40 }, (_, i) => `● line ${i}`)]
    expect(limitWords(text(old))).toBeNull()
    expect(limitWords(text(['❯ hello', '● Hi.', ...CLAUDE_IDLE]))).toBeNull()
    expect(limitWords('')).toBeNull()
  })
})
