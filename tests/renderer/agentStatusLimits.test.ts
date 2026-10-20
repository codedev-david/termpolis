import { describe, it, expect, vi } from 'vitest'
import { detectAgentStatus, isLimitOrMenu, menuAnswer } from '../../src/shared/agentStatusDetector'
import { screenOf } from '../../src/shared/terminalScreen'
import { buildConductorPrompt } from '../../src/renderer/src/lib/conductorPrompt'
import { noteWorkerStatus } from '../../src/renderer/src/lib/swarmStopReports'
import fixtures from '../fixtures/agentScreens.json'
import wide from '../fixtures/agentScreensWide.json'
import input from '../fixtures/agentScreensInput.json'
import cleared from '../fixtures/agentScreensCleared.json'

// GitHub #36 item 5: a worker its plan's usage limit stopped, or one waiting on a menu, reads as
// blocked, with a summary, and the conductor is told. Only what a CLI draws in its own rows counts:
// in place of its input box (a menu, a dialog), under it, Claude Code's status line, and the limit
// message a CLI ends its turn with, in the cell only it draws there. Never the same words in a
// worker's answer, or in a file or a log it shows: a false report closes a healthy worker. A missed
// one leaves it waiting, as 1.53 did.

const E = '\x1b'
const RULE = '─'.repeat(80)
/** What Claude Code draws in front of a reply, a tool's output and its limit message included
 *  (claude.exe's MessageResponse): an indent, its ⎿, a space and a no-break space. Every reply here
 *  had two plain spaces, and none of the real ones was read (BEH-1). */
const REPLY = '  ⎿ \u00a0'

/** A screen as the agent draws it at 80x24: rows at their positions, ConPTY style. */
function drawn(rows: string[]): string {
  return `${E}[H${E}[2J` + rows.map((r, i) => `${E}[${i + 1};1H${r.replace(/ /g, `${E}[1C`)}`).join('')
}
function onScreen(rows: string[], agent = 'Codex', title = '') {
  const screen = screenOf(drawn(rows))
  return detectAgentStatus(screen.lines().join('\n'), agent, 'working', { screen: true, title })
}
/** A real capture's rows, as the screen draws them. */
function rowsOf(raw: string, size: { cols: number; rows: number }): string[] {
  const rows = screenOf(raw, size).lines()
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
  return rows
}
function onRealScreen(raw: string, size: { cols: number; rows: number }, agent = '') {
  const screen = screenOf(raw, size)
  return detectAgentStatus(screen.lines().join('\n'), agent, 'working', { screen: true, title: screen.title })
}

// The bottom of each agent's screen, as the real sessions in tests/fixtures/agentScreens.json show it.
const CODEX_IDLE = ['', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~\\repos\\app']
const CODEX_BUSY = ['', '• Working (12s • esc to interrupt)', '', '', ...CODEX_IDLE.slice(1)]
const CLAUDE_IDLE = ['', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)']
const AGY_IDLE = ['', RULE, '> ', RULE, '  ? for shortcuts                                    Gemini 4 Argon · medium']

/** Claude Code 2.1.302's /rate-limit-options menu as it drew it (tests/fixtures/agentScreensInput.json),
 *  from the command's echo down: a rule, "What do you want to do?", its options, its keys. */
const MENU = (() => {
  const rows = rowsOf(input.rateLimitMenu.raw, input.rateLimitMenu)
  return rows.slice(rows.findIndex((r) => r.startsWith('❯ /rate-limit-options')))
})()
/** Codex 0.153.4's popups, their strings from codex.exe, laid out as it lays out its update offer. */
const CODEX_KEYS = '  Press enter to confirm or esc to go back'
const SWITCH_POPUP = [
  '  Approaching rate limits',
  '  Switch to gpt-5.6-luna for lower credit usage?',
  '',
  '› 1. Switch to gpt-5.6-luna   Uses fewer credits for upcoming turns.',
  '  2. Keep current model',
  '  3. Keep current model (never show again)',
  '',
  CODEX_KEYS,
]

describe("Claude Code's rate-limit menu, which it opens by itself at a limit", () => {
  it('draws the menu the tests build on, from the real capture', () => {
    expect(MENU).toEqual(expect.arrayContaining(['  What do you want to do?', '  ❯ 1. Stop and wait for limit to reset', '  Enter to confirm · Esc to cancel']))
  })

  // claude.exe 2.1.302 submits /rate-limit-options by itself under the limit message, for a
  // subscriber below Max 20x whose limit came with a reset time: the message heads the menu, the
  // command's echo between them. It read as thinking, and nothing was reported (R2-1).
  it.each([
    ['a session limit', 'You\'ve hit your session limit · resets 3pm (America/New_York)', 'usage limit reached (resets 3pm (America/New_York))'],
    ['the weekly limit', 'You\'ve hit your weekly limit · resets Oct 20, 9am (UTC) · progress saved', 'usage limit reached (resets Oct 20, 9am (UTC))'],
    ['the plain limit', 'You\'ve hit your limit · resets 3pm (America/New_York)', 'usage limit reached (resets 3pm (America/New_York))'],
    ['a model\'s limit', 'You\'ve hit your Opus limit · resets at 5pm (UTC)', 'usage limit reached (resets 5pm (UTC))'],
    ['a team budget, with what to do', 'You\'ve hit your team\'s shared budget. /model to switch models.', 'usage limit reached'],
    ['being out of usage credits', 'You\'re out of usage credits. /model to switch models.', 'usage limit reached'],
    ['being out of usage credits until they reset', 'You\'re out of usage credits · resets 3pm (America/New_York)', 'usage limit reached (resets 3pm (America/New_York))'],
  ])('reads %s heading the menu as the limit, and when it lifts', (_name, message, summary) => {
    const rows = ['❯ Build the login page. Task ID: t1', `${REPLY}${message}`, '', ...MENU]
    const result = onScreen(rows, 'Claude', '✳ Claude Code')
    expect(result).toEqual({ status: 'blocked', summary })
    expect(isLimitOrMenu(result)).toBe(true)
  })

  it('reads a limit message the screen wrapped onto a second row', () => {
    const rows = ['❯ Build the page', `${REPLY}You've hit your session limit · resets 3pm`, '     (America/New_York)', '', ...MENU]
    expect(onScreen(rows, 'Claude')).toEqual({ status: 'blocked', summary: 'usage limit reached (resets 3pm)' })
  })

  // It is shown only for a limit. Read as a menu, an Esc closed it and left the worker limited, and
  // its task, sent again, went to a worker that couldn't do it.
  it('reads the menu as the limit with no limit message heading it, as the real capture shows it', () => {
    const result = onRealScreen(input.rateLimitMenu.raw, input.rateLimitMenu, 'Claude')
    expect(result).toEqual({ status: 'blocked', summary: 'usage limit reached' })
    expect(menuAnswer(result.summary)).toBeNull()
  })

  it("takes when the limit lifts from the menu's own option when no message heads it", () => {
    const rows = MENU.map((r) => r.replace('Stop and wait for limit to reset', 'Wait here, then continue automatically at 3pm'))
    expect(onScreen(rows, 'Claude')).toEqual({ status: 'blocked', summary: 'usage limit reached (resets 3pm)' })
  })

  it('takes no reset time from an answer above the menu that quotes a limit: only the row right above its echo heads it', () => {
    const rows = ['● The docs say "You\'ve hit your session limit · resets 3pm" when it runs out.', '', '❯ Build the page', `${REPLY}Done`, '', ...MENU]
    expect(onScreen(rows, 'Claude')).toEqual({ status: 'blocked', summary: 'usage limit reached' })
  })

  it('reads the menu drawn at the top of the screen, nothing above its rule', () => {
    expect(onScreen(MENU.slice(MENU.findIndex((r) => /^─/.test(r))), 'Claude')).toEqual({ status: 'blocked', summary: 'usage limit reached' })
  })

  it('is no limit menu without its own options, or without its keys under it', () => {
    const other = ['❯ /config', '', RULE, '  What do you want to do?', '', '  ❯ 1. Open settings', '    2. Leave', '', '  Enter to confirm · Esc to cancel']
    expect(isLimitOrMenu(onScreen([`${REPLY}You've hit your session limit · resets 3pm`, '', ...other], 'Claude'))).toBe(false)
    expect(isLimitOrMenu(onScreen([`${REPLY}You've hit your session limit · resets 3pm`, '', ...MENU.slice(0, -1)], 'Claude'))).toBe(false)
  })
})

describe('Claude Code waiting out a limit, on its own rows', () => {
  // claude.exe 2.1.302: "Usage limit reached · continuing automatically {when} · esc to cancel".
  it.each([
    ['on its status line, while its footer says esc to cancel', ['● I will build the page.', '', '✻ Usage limit reached · continuing automatically at 3pm · esc to cancel', '', RULE, '❯ ', RULE, '  esc to cancel'], 'usage limit reached (resets 3pm)'],
    ['again, on its status line', ['● Built the first half.', '', '✶ Usage limit reached again · continuing automatically shortly · esc to cancel', '', RULE, '❯ ', RULE], 'usage limit reached'],
    ['on a status line a narrow screen wrapped', ['● Built the first half.', '', '✻ Usage limit reached · continuing automatically at', '3pm · esc to cancel', '', RULE, '❯ ', RULE], 'usage limit reached (resets 3pm)'],
    ['while it waits, on its status line', ['● Built the first half.', '', '✻ Continuing automatically at 4:00 PM · esc to cancel', '', RULE, '❯ ', RULE], 'usage limit reached (resets 4:00 PM)'],
    ['in its footer, under its box', ['● OK', ...CLAUDE_IDLE, '          You\'ve hit your weekly limit · resets 4pm (America/New_York)'], 'usage limit reached (resets 4pm (America/New_York))'],
  ])('reads it %s', (_name, rows, summary) => {
    expect(onScreen(rows, 'Claude', '◐ Claude Code')).toEqual({ status: 'blocked', summary })
  })

  it("reads no limit in its footer's warning that one is near, or its notice that fast mode ran out", () => {
    const screen = screenOf(fixtures.claude.usageWarning)
    expect(screen.lines().join('\n')).toContain('You\'ve used 82% of your weekly limit · resets 4pm (America/New_York)')
    expect(detectAgentStatus(screen.lines().join('\n'), 'Claude', 'working', { screen: true, title: screen.title }).status).toBe('idle')
    expect(onScreen(['● OK', ...CLAUDE_IDLE, '  You\'ve hit your fast limit · resets in 4h 59m'], 'Claude').status).toBe('idle')
  })

  it('reads the words in an answer right above the box as the answer: the status line starts with its spinner', () => {
    const rows = ['● Turned the wait on. It shows:', '  Usage limit reached · continuing automatically at 3pm', ...CLAUDE_IDLE]
    expect(onScreen(rows, 'Claude').status).toBe('idle')
  })
})

describe("Codex's prompts in place of its composer", () => {
  // codex.exe 0.153.4 ("workspace-usage-nudge"): two prompts it opens for a workspace (R2-3).
  it.each([
    ['its workspace out of credits', ['  You\'ve reached your workspace credit limit', '  Your workspace is out of credits. Ask your workspace owner to add more.', '  Notify owner?', '', '› 1. Yes', '  2. No', '', CODEX_KEYS]],
    ['its limit, to ask the owner for more', ['  Usage limit reached', '  Request a limit increase from your owner to continue using codex.', '  Request increase?', '', '› 1. Yes', '  2. No', '', CODEX_KEYS]],
  ])('reads the prompt for %s as the limit', (_name, popup) => {
    const result = onScreen(['• Edited src/app.ts (+4 -1)', '', ...popup])
    expect(result).toEqual({ status: 'blocked', summary: 'usage limit reached' })
  })

  it('reads its offer of a cheaper model as a menu, and names the option to pick', () => {
    const result = onScreen(['• Edited src/app.ts (+4 -1)', '', ...SWITCH_POPUP])
    expect(result).toEqual({ status: 'blocked', summary: 'waiting on a menu: Codex asks whether to switch to a model that uses fewer credits' })
    expect(menuAnswer(result.summary)).toBe('"Keep current model" is the second option (Down, then Enter: \\u001b[B\\r)')
  })

  it('reads it with the cursor moved to another option', () => {
    const popup = SWITCH_POPUP.map((r) => r.replace(/^› 1\./, '  1.').replace(/^ {2}2\./, '› 2.'))
    expect(onScreen(popup).summary).toBe('waiting on a menu: Codex asks whether to switch to a model that uses fewer credits')
  })

  it.each([
    ['at 80x24', fixtures.codex.updateMenu, undefined],
    ['at 160x40', wide.screens['codex-160x40-update-menu'].raw, { cols: 160, rows: 40 }],
  ] as const)('reads its offer to update itself, as a real session showed it, %s', (_name, raw, size) => {
    const screen = size ? screenOf(raw, size) : screenOf(raw)
    const result = detectAgentStatus(screen.lines().join('\n'), 'Codex', 'starting', { screen: true, title: screen.title })
    expect(result).toEqual({ status: 'blocked', summary: 'waiting on a menu: Codex offers to update itself' })
    expect(menuAnswer(result.summary)).toBe('"Skip until next version" is the third option (Down, Down, then Enter: \\u001b[B\\u001b[B\\r)')
  })

  it('is no menu without its keys under it, or with a row of the transcript inside it', () => {
    expect(isLimitOrMenu(onScreen(SWITCH_POPUP.slice(0, -1)))).toBe(false)
    const split = [...SWITCH_POPUP.slice(0, 2), '• Ran the tests', ...SWITCH_POPUP.slice(2)]
    expect(isLimitOrMenu(onScreen(split))).toBe(false)
  })

  it("is no menu without Codex's cursor on an option: an answer quoting the popup, its keys and all", () => {
    const quoted = ['• It asks:', ...SWITCH_POPUP.map((r) => r.replace(/^›/, ' '))]
    expect(isLimitOrMenu(onScreen(quoted))).toBe(false)
  })
})

describe("Gemini CLI's quota dialog, in place of its input", () => {
  // Gemini CLI 0.59.0's ProQuotaDialog as its bundle lays it out (interactiveCli-*.js): a round
  // frame with a padding of one, the message, a margin of one each side of the options. A Google
  // login gets a line and an option more: 15 rows, the limit line 14 rows up from its footer.
  function quotaDialog(model: string, googleLogin: boolean): string[] {
    const message = [`Usage limit reached for ${model}.`, 'Access resets at 5:00 PM.', '/stats model for usage details', '/model to switch models.', ...(googleLogin ? ['/auth to switch to API key.'] : [])]
    const options = ['● 1. Switch to gemini-2.5-flash', ...(googleLogin ? ['  2. Upgrade for higher limits'] : []), `  ${googleLogin ? 3 : 2}. Stop`]
    const inner = ['', ...message, '', '', ...options, '', '']
    return ['╭' + '─'.repeat(78) + '╮', ...inner.map((r) => '│ ' + r.padEnd(76) + ' │'), '╰' + '─'.repeat(78) + '╯']
  }
  it.each([
    ['an API key, a Flash model', 'gemini-2.5-flash', false, 13],
    ['an API key, a Pro model', 'all Pro models', false, 13],
    ['a Google login, a Flash model', 'gemini-2.5-flash', true, 15],
    ['a Google login, a Pro model', 'all Pro models', true, 15],
  ])('reads it for %s, however tall it is', (_name, model, googleLogin, height) => {
    const dialog = quotaDialog(model, googleLogin)
    expect(dialog).toHaveLength(height)
    const rows = [...dialog, '~\\repos\\app   no sandbox (see /docs)   gemini-2.5-pro (98% context left)']
    const screen = [...Array<string>(24 - rows.length).fill('some earlier output'), ...rows]
    expect(onScreen(screen, 'Gemini')).toEqual({ status: 'blocked', summary: 'usage limit reached (resets 5:00 PM)' })
  })

  it('reads it when it spans a wide screen', () => {
    const row = (s: string) => `│ ${s.padEnd(156)} │`
    const frame = ['╭' + '─'.repeat(158) + '╮', row(''), row('Usage limit reached for gemini-2.5-pro.'), row('Access resets at 5:00 PM.'),
      row('/stats model for usage details'), row('/model to switch models.'), '╰' + '─'.repeat(158) + '╯']
    const screen = screenOf(frame.map((r, i) => `${E}[${i + 1};1H${r}`).join(''), { cols: 160, rows: 40 })
    expect(detectAgentStatus(screen.lines().join('\n'), 'Gemini', 'working', { screen: true })).toEqual({ status: 'blocked', summary: 'usage limit reached (resets 5:00 PM)' })
  })
})

// R3-1: a CLI that ends its turn on its plan's limit prints the message as the last thing above its
// input box, the box back under it, in a cell only that CLI draws there: Codex's error cell at the
// start of a row, agy's ✕ cell, Claude Code's ⎿ reply right under the prompt it stopped (no menu
// opens on Max 20x, an API key or a Team plan). Each read as an idle worker: no report went out, and
// the bridge told the conductor the worker may be done (GitHub #36 item 5).
describe('the limit message a CLI ends its turn with, right above its input box', () => {
  it.each([
    ["Codex's 5-hour limit", 'Codex', ['› Fix the login test', '', '• I will fix the test.', '', '■ You\'ve hit your usage limit. Upgrade to Plus to continue using Codex', '(https://chatgpt.com/explore/plus), or try again at 3:04 PM.', ...CODEX_IDLE], 'usage limit reached (resets 3:04 PM)'],
    ["Codex's limit for one model", 'Codex', ['› Fix the login test', '', '■ You\'ve hit your usage limit for gpt-5.6-sol. Switch to another model now, or', 'try again at 4:15 PM.', ...CODEX_IDLE], 'usage limit reached (resets 4:15 PM)'],
    ["agy's quota", 'Gemini', ['> Write the docs', '', '✕ You have exhausted your quota on this model.', ...AGY_IDLE], 'usage limit reached'],
    ["Claude Code's session limit, under the prompt it stopped", 'Claude', ['❯ Build the page', `${REPLY}You've hit your session limit · resets 3pm (America/New_York)`, ...CLAUDE_IDLE], 'usage limit reached (resets 3pm (America/New_York))'],
    ["Claude Code's weekly limit, under a prompt of two rows", 'Claude', ['> Build the page, with a form, validation and a test for each of', '  them.', `${REPLY}You've hit your weekly limit · resets Oct 20, 9am (UTC)`, ...CLAUDE_IDLE], 'usage limit reached (resets Oct 20, 9am (UTC))'],
    // A narrow screen wraps the reply's end onto a row of its own, indented under the reply's text:
    // read with it, its reset whole (R4-2: cut at the row's end, it read "resets 3pm").
    ["Claude Code's session limit, its reply wrapped onto a second row", 'Claude', ['❯ Build the page', `${REPLY}You've hit your session limit · resets 3pm`, '     (America/New_York)', ...CLAUDE_IDLE], 'usage limit reached (resets 3pm (America/New_York))'],
    // Two plain spaces after its ⎿, as other rows of Claude Code's are drawn.
    ["Claude Code's session limit, two plain spaces after its ⎿", 'Claude', ['❯ Build the page', '  ⎿  You\'ve hit your session limit · resets 3pm (America/New_York)', ...CLAUDE_IDLE], 'usage limit reached (resets 3pm (America/New_York))'],
  ])('%s: blocked, and the conductor told once to check it', async (name, agent, rows, summary) => {
    const result = onScreen(rows, agent)
    expect(result).toEqual({ status: 'blocked', summary })
    const sendMessage = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).swarmAPI = { sendMessage, getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }) }
    for (let i = 0; i < 3; i++) await noteWorkerStatus({ terminalId: `limit ${name}`, agentName: agent, role: 'Build' }, result)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][3]).toContain(`is blocked: ${summary}. Check its screen with read_output first`)
  })

  // claude.exe 2.1.302 to 2.1.304 draw a reply's ⎿ in MessageResponse, the limit reply's too, a
  // no-break space after it, and the screen keeps it: the real capture of Claude Code 2.1.303, drawn
  // as far as the ⎿ row it showed under its spinner.
  it("draws a reply's ⎿ as the real capture does: a space and a no-break space after it", () => {
    const real = cleared.screens['claude-80x24-pasteother-held']
    const tip = real.raw.indexOf('\r\n', real.raw.indexOf('Tip: '))
    expect(rowsOf(real.raw.slice(0, tip), real).filter((row) => row.includes('⎿'))).toEqual([`${REPLY}Tip: You can control how big a workflow is just by prompting. Ask for a`])
  })

  it('reads one a narrow screen wrapped over three rows', () => {
    const rows = ['› Fix the login test', '', '■ You\'ve hit your usage limit. Upgrade to Plus', 'to continue using Codex (https://chatgpt.com/explore', '/plus), or try again at 3:04 PM.', ...CODEX_IDLE]
    expect(onScreen(rows)).toEqual({ status: 'blocked', summary: 'usage limit reached (resets 3:04 PM)' })
  })

  // R4-2: a narrow screen, a worker's pane in a split, wraps the message as each CLI wraps it, and
  // each cell was read only as far as its first row (agy's, below 46 columns), its first two
  // (Claude Code's reply, below about 36) or five (Codex's, below 30): no report went out, and the
  // worker read as idle. The reply's reset was cut where the screen wrapped it. Drawn at the width.
  describe('wrapped by a narrow screen', () => {
    const rule = (cols: number) => '─'.repeat(cols)
    const at = (cols: number, rows: string[], agent: string) => {
      const screen = screenOf(drawn(rows), { cols, rows: 24 })
      return detectAgentStatus(screen.lines().join('\n'), agent, 'working', { screen: true, title: '' })
    }
    const claudeIdle = (cols: number) => ['', rule(cols), '❯ ', rule(cols), '  ⏵⏵ bypass permissions on'.slice(0, cols)]
    const agyIdle = (cols: number) => ['', rule(cols), '> ', rule(cols), '? for shortcuts']
    const codexIdle = ['', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium']

    it.each([
      // Its continuation at column 0, as Codex wraps its cells (codex-60x20-interrupted-idle).
      ['agy at 40 columns', 40, ['✕ You have exhausted your quota on this', 'model.']],
      // Or under its text: no real capture shows which.
      ['agy at 40 columns, wrapped under its text', 40, ['✕ You have exhausted your quota on this', '  model.']],
      ['agy at 22 columns', 22, ['✕ You have exhausted', 'your quota on this', 'model.']],
    ])('%s', (_name, cols, cell) => {
      expect(at(cols, ['> Write the docs', '', ...cell, ...agyIdle(cols)], 'Gemini')).toEqual({ status: 'blocked', summary: 'usage limit reached' })
    })

    const CLAUDE_NARROW: Array<[string, number, string[], string]> = [
      ['on 2 rows, at 50 columns', 50, [`${REPLY}You've hit your session limit · resets 3pm`, '     (America/New_York)'], 'usage limit reached (resets 3pm (America/New_York))'],
      ['on 2 rows, its reset cut, at 46 columns', 46, [`${REPLY}You've hit your weekly limit · resets Oct`, '     20, 9am (UTC)'], 'usage limit reached (resets Oct 20, 9am (UTC))'],
      ['on 3 rows, at 30 columns', 30, [`${REPLY}You've hit your session`, '     limit · resets 3pm', '     (America/New_York)'], 'usage limit reached (resets 3pm (America/New_York))'],
      ['on 4 rows, its ⎿ row cut before "limit", at 20 columns', 20, [`${REPLY}You've hit your`, '     weekly limit ·', '     resets Oct 20,', '     9am (UTC)'], 'usage limit reached (resets Oct 20, 9am (UTC))'],
    ]
    it.each(CLAUDE_NARROW)("Claude Code's reply %s", (_name, cols, reply, summary) => {
      expect(at(cols, ['❯ Build the page', ...reply, ...claudeIdle(cols)], 'Claude')).toEqual({ status: 'blocked', summary })
    })

    it("Codex's cell on 6 rows, at 29 columns", () => {
      const cell = ['■ You\'ve hit your usage', 'limit. Upgrade to Plus to', 'continue using Codex', '(https://chatgpt.com/explore/', 'plus), or try again at 3:04', 'PM.']
      expect(at(29, ['› Fix the login test', '', ...cell, ...codexIdle], 'Codex')).toEqual({ status: 'blocked', summary: 'usage limit reached (resets 3:04 PM)' })
    })

    // R4-3: Codex's "try again at" read across the row it wraps at, as its cell's other words are.
    it("Codex's reset split after \"try again\"", () => {
      const cell = ['■ You\'ve hit your usage limit. Upgrade to Plus to continue', 'using Codex (https://chatgpt.com/explore/plus), or try again', 'at 3:04 PM.']
      expect(at(60, ['› Fix the login test', '', ...cell, ...codexIdle], 'Codex')).toEqual({ status: 'blocked', summary: 'usage limit reached (resets 3:04 PM)' })
    })

    // BEH-2: under the limit message, in the reply's own column, claude.exe's su() draws dim rows of
    // its own: a note of the server's on the limit, "Press ⏎ to continue after reset", a checkpoint,
    // the hint for the account (its lP table, one on every claude.ai login with no menu: Max 20x, a
    // Team plan) and, since 2.1.304, an offer of usage credits. Read with the message, they cost it
    // its reset ("usage limit reached"), or ran into it ("resets 3pm /upgrade to increase your usage
    // limit"). Each is drawn here at 80 columns and at the narrow widths above.
    describe('with the rows Claude Code draws under the message', () => {
      /** `text` wrapped to `width` as Ink wraps it (wrap-ansi): at its spaces, a word longer than the
       *  width broken. */
      const wrapTo = (width: number, text: string): string[] => {
        const rows: string[] = []
        let row: string | null = null
        for (let word of text.split(' ')) {
          if (row !== null && row.length + 1 + word.length <= width) {
            row += ` ${word}`
            continue
          }
          if (row !== null) rows.push(row)
          for (; word.length > width; word = word.slice(width)) rows.push(word.slice(0, width))
          row = word
        }
        return [...rows, row ?? '']
      }
      /** Claude Code's reply as it lays it out at `cols` columns: 5 cells for its ⎿, then each of
       *  `pieces` from a row of its own, wrapped to the rest of the row. */
      const replyAt = (cols: number, pieces: string[]): string[] =>
        pieces.flatMap((piece) => wrapTo(cols - 5, piece)).map((row, i) => `${i === 0 ? REPLY : '     '}${row}`)

      it('lays a reply out as the narrow screens above draw it', () => {
        for (const [, cols, rows] of CLAUDE_NARROW) expect(replyAt(cols, [rows.map((row) => row.slice(5)).join(' ')])).toEqual(rows)
      })

      // A time zone short enough to keep whole at 20 columns. claude.exe puts one after every reset
      // time it prints there (zT(time, true)).
      const SESSION = "You've hit your session limit · resets 3pm (Europe/London)"
      const FABLE = "You've hit your Fable limit · resets Oct 21, 3pm (Europe/London)"
      const SPEND = "You've hit your monthly spend limit · your session limit resets 3pm (Europe/London)"
      const ROWS_UNDER: Array<[string, string[], string]> = [
        ['its options opening', [SESSION, 'Opening your options…'], '3pm (Europe/London)'],
        ['the spend limit hint', [SPEND, '/usage-credits to adjust your monthly spend limit.'], '3pm (Europe/London)'],
        ['the usage credits hint', [SESSION, '/usage-credits to finish what you’re working on.'], '3pm (Europe/London)'],
        ['the API login hint', [SESSION, '/login to switch to an API usage-billed account.'], '3pm (Europe/London)'],
        ["the hint that the admin can turn on extra usage", [SESSION, 'Your admin can enable extra usage at https://claude.ai/admin-settings/usage.'], '3pm (Europe/London)'],
        ['the hint to ask the admin', [SESSION, '/usage-credits to request more usage from your admin.'], '3pm (Europe/London)'],
        ['the upgrade hint', [SESSION, '/upgrade to increase your usage limit.'], '3pm (Europe/London)'],
        ['the upgrade or usage credits hint', [SESSION, '/upgrade or /usage-credits to finish what you’re working on.'], '3pm (Europe/London)'],
        ['its key to go on after the reset', [SESSION, 'Press ⏎ to continue after reset'], '3pm (Europe/London)'],
        ['a checkpoint under that key', [SESSION, 'Press ⏎ to continue after reset', '✔ checkpointed — see ~/.claude/checkpoints/4f1c', "  or /rewind to undo this turn's file edits"], '3pm (Europe/London)'],
        ['its offer of usage credits', [FABLE, 'Usage credits are at least 20% off · 3 days left · /usage-credits'], 'Oct 21, 3pm (Europe/London)'],
        ['its other offer', [FABLE, 'Buy usage credits and get at least 20% extra · 3 days left · /usage-credits'], 'Oct 21, 3pm (Europe/London)'],
        ["a note of the server's, which names a reset of its own", [SESSION, 'Your session limit resets every five hours.'], '3pm (Europe/London)'],
      ]
      it.each([80, 50, 46, 30, 20].flatMap((cols) => ROWS_UNDER.map(([name, pieces, reset]) => [name, cols, pieces, reset] as const)))(
        "reads the reset in Claude Code's message, not %s under it, at %i columns",
        (_name, cols, pieces, reset) => {
          expect(at(cols, ['❯ Build the page', ...replyAt(cols, [...pieces]), ...claudeIdle(cols)], 'Claude')).toEqual({ status: 'blocked', summary: `usage limit reached (resets ${reset})` })
        },
      )

      // Resets as long as claude.exe prints them (M-3: one cut at 16 characters passed every test): a
      // date past the year's end with its year, and the system's own name for its time zone, which on
      // the US west coast is America/Los_Angeles and runs to 32 characters. A name longer than the row
      // is broken where the row ends, and read whole: a time zone has no space in it.
      const LONG_RESETS = ['Oct 24, 4:30pm (America/Los_Angeles)', 'Jan 2, 2027, 11:30pm (America/Argentina/Buenos_Aires)', '11:30pm (America/Argentina/ComodRivadavia)']
      it.each([80, 46, 30, 20].flatMap((cols) => LONG_RESETS.map((reset) => [reset, cols] as const)))('reads the whole reset "%s" at %i columns', (reset, cols) => {
        const rows = ['❯ Build the page', ...replyAt(cols, [`You've hit your weekly limit · resets ${reset}`, '/upgrade to increase your usage limit.']), ...claudeIdle(cols)]
        expect(at(cols, rows, 'Claude')).toEqual({ status: 'blocked', summary: `usage limit reached (resets ${reset})` })
      })

      // A reset that isn't in that form is no reset Claude Code printed: it is read as no time, not
      // as the time and the hint under it.
      it('reads no time from a reset without its time zone, the rows under it never taken for one', () => {
        const rows = ['❯ Build the page', ...replyAt(80, ["You've hit your session limit · resets 3pm", '/upgrade to increase your usage limit.']), ...CLAUDE_IDLE]
        expect(onScreen(rows, 'Claude')).toEqual({ status: 'blocked', summary: 'usage limit reached' })
        // A message with no reset, as the org's spend limit has none, and a row under it whose words
        // only end in "resets".
        const spent = ['❯ Build the page', ...replyAt(80, ["You've hit your org's monthly spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage", 'Usage presets for your team (beta) are in /config.']), ...CLAUDE_IDLE]
        expect(onScreen(spent, 'Claude')).toEqual({ status: 'blocked', summary: 'usage limit reached' })
      })
    })
  })
})

describe('what is no usage limit or menu', () => {
  // The same words where the CLI's own cell isn't, or isn't the last thing it shows: an answer, a
  // tool's output, a prompt sent after it, or an agent still at work on its prompt.
  it.each([
    ["Gemini CLI's message, in its history", 'Gemini', ['✕ Usage limit reached for gemini-2.5-pro.', '  Access resets at 5:00 PM.', '  /stats model for usage details', ...AGY_IDLE]],
    ["Claude Code's, in a tool's output under the prompt", 'Claude', ['❯ Build the page', '● Bash(cat docs/limits.md)', `${REPLY}You've hit your session limit · resets 3pm (America/New_York)`, ...CLAUDE_IDLE]],
    ["Claude Code's, under a prompt it then answered", 'Claude', ['❯ Build the page', `${REPLY}You've hit your session limit · resets 3pm`, '', '❯ Go on', '', '● Built the page.', ...CLAUDE_IDLE]],
    ["Claude Code's, under an answer", 'Claude', ['● The banner says:', `${REPLY}You've hit your session limit · resets 3pm`, ...CLAUDE_IDLE]],
    ["Claude Code's words on a row of a prompt it was sent, no ⎿ in front", 'Claude', ['❯ The worker printed this, read it:', '  You\'ve hit your session limit · resets 3pm', ...CLAUDE_IDLE]],
    ["Codex's, indented in an answer", 'Codex', ['• The CLI printed:', '', '  ■ You\'ve hit your usage limit. Upgrade to Plus to continue using Codex', ...CODEX_IDLE]],
    ["agy's, quoted in an answer", 'Gemini', ['> Why did it stop?', '', '  It printed ✕ You have exhausted your quota on this model.', ...AGY_IDLE]],
    ["Codex's, still at work on the prompt it was sent", 'Codex', ['■ You\'ve hit your usage limit. Try again at 4:15 PM.', ...CODEX_BUSY]],
    ["Codex's, a cell of another kind right under it", 'Codex', ['■ You\'ve hit your usage limit. Try again at 4:15 PM.', '⚠ Falling back from WebSockets to HTTPS transport.', ...CODEX_IDLE]],
    ["Codex's words in the middle of a long cell, no blank row above them", 'Codex', ['• The log ends with:', '■ You\'ve hit your usage limit. Try again at 4:15 PM.', '  and then', '  the session', '  closed', '  itself.', ...CODEX_IDLE]],
    // R4-3: a ⎿ row of its own between the prompt and the reply, a hook's, leaves the reply no longer
    // right under the prompt: it can be a hook's own words, so it is read as nothing.
    ["Claude Code's reply under a hook's row under the prompt", 'Claude', ['❯ Build the page', '  ⎿  UserPromptSubmit hook succeeded', `${REPLY}You've hit your session limit · resets 3pm (America/New_York)`, ...CLAUDE_IDLE]],
    // The rows a reply wrapped onto, its ⎿ row and the prompt gone off the screen's top.
    ["Claude Code's reply's wrapped end, its ⎿ row scrolled off the top", 'Claude', ['     limit · resets 3pm', '     (America/New_York)', ...CLAUDE_IDLE]],
    // Only rows indented under the reply's text are the reply's: one under it indented less is not.
    ["Claude Code's reply with a row under it indented less than its text", 'Claude', ['❯ Build the page', `${REPLY}You've hit your session limit · resets 3pm`, '  (America/New_York)', ...CLAUDE_IDLE]],
    // A wrapped reply is read from its ⎿ row: one that starts some other way is no limit.
    ["Claude Code's reply wrapped onto rows that name a limit, its ⎿ row not starting with it", 'Claude', ['❯ Build the page', `${REPLY}The banner now reads:`, '     You\'ve hit your session limit · resets 3pm', ...CLAUDE_IDLE]],
  ])('%s', (_name, agent, rows) => {
    expect(isLimitOrMenu(onScreen(rows, agent))).toBe(false)
  })

  it('reads no limit in a prompt Claude Code is still at work on, whose last row is its limit reply', () => {
    const rows = ['❯ Take over from the worker that stopped with:', `${REPLY}You've hit your session limit · resets 3pm`, '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt']
    expect(onScreen(rows, 'Claude', '◐ Claude Code').status).toBe('working')
  })

  // Each read as a menu on any agent, anywhere in the bottom rows (R2-2): the worker was reported
  // blocked, submit refused to type into it, and the conductor was told to give its task away.
  it.each([
    ['Claude showing rg output with the pattern line', 'Claude', ['● Bash(rg -n "Approaching rate limits" src)', `${REPLY}src/shared/agentStatusDetector.ts:338:    pattern: /Approaching rate limits[\\s\\S]*Keep current model/,`, ...CLAUDE_IDLE]],
    ['Claude summarizing the docs', 'Claude', ['● The docs name Codex\'s menus ("Approaching rate limits … Keep current model") and', '  its update offer ("Update available! 0.1 -> 0.2 … Skip until next version").', ...CLAUDE_IDLE]],
    ["agy answering a question about Codex's prompt", 'Gemini', ['> What does Codex show near its limit?', '', '  It shows "Approaching rate limits" and offers', '  2. Keep current model', ...AGY_IDLE]],
    ['Codex with a task naming both in its composer', 'Codex', ['• Ready.', '', '› Handle Codex\'s "Approaching rate limits" prompt: pick "Keep current model", and on', '  "Update available! 0.153.4 -> 0.163.0" pick "Skip until next version".', '', '  gpt-5.6-sol medium · ~\\repos\\app']],
    ['Codex busy, its answer quoting the popup', 'Codex', ['• It asks:', '  Approaching rate limits', '  2. Keep current model', ...CODEX_BUSY]],
  ])('%s', (_name, agent, rows) => {
    const result = onScreen(rows, agent)
    expect(result.status).not.toBe('blocked')
  })

  // What a worker shows while it works on a user's repo, above its input box (GitHub #36): its own
  // words, a diff, docs, a log, grep hits, a message bridged from another worker.
  it.each([
    ['Codex describing its work', 'Codex', ['• I added the banner. It now reads You\'ve hit your monthly limit when the', '  account is over quota, and links to the billing page.'], CODEX_IDLE],
    ['a diff of JSX while Codex works', 'Codex', ['• Edited src/components/QuotaBanner.tsx (+3 -1)', '    12 -      <p>Limit reached</p>', '    12 +      <p>You\'ve hit your monthly limit</p>'], CODEX_BUSY],
    ['markdown docs', 'Codex', ['• Updated docs/billing.md:', '  ## Limits', '  - Free plan: You\'ve hit your free plan limit after 100 requests.'], CODEX_IDLE],
    ['a log tail', 'Codex', ['• Ran tail -n 3 logs/api.log', '  └ 2026-10-16T12:00:01Z WARN Usage limit reached for org-42.', '    2026-10-16T12:00:02Z INFO retry scheduled'], CODEX_IDLE],
    ['grep output', 'Codex', ['• Ran rg -n "hit your" src', '  └ src/quota.ts:12:   message: You\'ve hit your weekly limit · resets Monday'], CODEX_IDLE],
    ['a Claude worker reading a message bridged from Codex', 'Claude', ['● termpolis - swarm_read_messages (MCP)(terminalId: "t-9")', `${REPLY}[{"from":"Codex","content":"[Codex] You've hit your usage limit. Upgrade`, '     to Plus to continue using Codex"}]'], CLAUDE_IDLE],
    ['a file of copy Claude printed, the last thing it shows', 'Claude', ['● Bash(cat src/copy/quota.txt)', `${REPLY}You've hit your monthly limit.`, '     Upgrade to keep going.'], CLAUDE_IDLE],
    ['the monthly spend copy with words after it', 'Claude', ['● Bash(cat src/copy/spend.txt)', `${REPLY}You've hit your monthly spend limit. Contact billing@example.com.`], CLAUDE_IDLE],
    ['the copy a Claude worker wrote, quoted on a row of its own', 'Claude', ['● I changed the quota banner. It now reads:', '', '  You\'ve hit your monthly limit.'], CLAUDE_IDLE],
    ["an agy answer quoting agy's message", 'Gemini', ['> Explain the quota error in the logs', '', '  The log shows the CLI stopped with:', '', '  You have exhausted your quota on this model.'], AGY_IDLE],
    ['an answer about an expired session', 'Claude', ['● The login fails because the session has expired before the refresh token', '  is used. I moved the refresh ahead of the request.'], CLAUDE_IDLE],
    ['Codex history about a restart', 'Codex', ['• Updated README.md: after editing config.toml, restart the agent to apply it.'], CODEX_IDLE],
  ])('%s', (_name, agent, transcript, bottom) => {
    expect(onScreen([...transcript, ...bottom], agent).status).not.toBe('blocked')
  })

  // A raw tail can't tell a CLI's own message from the same words in its transcript.
  it.each([
    ["Claude Code's limit", 'You\'ve hit your session limit · resets 3pm (America/New_York)'],
    ["Codex's limit", '■ You\'ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:04 PM.'],
    ["Codex's menu", 'Approaching rate limits\nSwitch to gpt-5.6-luna for lower credit usage?\n› 1. Switch to gpt-5.6-luna\n  2. Keep current model\n  Press enter to confirm or esc to go back'],
    ['a phrase quoted in code', 'throw new Error("You\'ve hit your usage limit. Upgrade to Plus")'],
  ])('%s in a raw tail', (_name, text) => {
    const result = detectAgentStatus('some earlier output\n'.repeat(5) + text + '\n', 'Codex', 'working')
    expect(isLimitOrMenu(result)).toBe(false)
  })

  it('a raw tail still reads a CLI that needs restarting, which is no limit or menu', () => {
    const result = detectAgentStatus('some earlier output\n'.repeat(5) + 'Update ran successfully! Please restart Codex.\n', 'Codex')
    expect(result.status).toBe('blocked')
    expect(isLimitOrMenu(result)).toBe(false)
    expect(isLimitOrMenu({ status: 'idle', summary: 'usage limit reached' })).toBe(false)
  })

  it("the conductor's own prompt, rule on limits and all", () => {
    const prompt = buildConductorPrompt({ taskDescription: 'Ship it', installedAgents: { claude: true, codex: true, gemini: true }, projectCwd: '/p' })
    expect(prompt).toContain('blocked by a usage limit')
    expect(prompt).toContain('waiting on a menu')
    for (let at = 0; at < prompt.length; at += 1000) {
      expect(isLimitOrMenu(detectAgentStatus(prompt.slice(at, at + 1500), 'Claude', 'working'))).toBe(false)
    }
  })

  it('names no answer for a summary that is no menu it knows', () => {
    expect(menuAnswer('waiting on a menu: something new')).toBeNull()
    expect(menuAnswer('usage limit reached')).toBeNull()
    expect(menuAnswer('waiting on a menu: constructor')).toBeNull()
  })

  // Each told the conductor to close a healthy worker under round 2's rules, and a mutant that
  // made them so went unseen (R2-3): a limit's words in a tool's output, a limit the worker went on
  // past with a prompt or an answer.
  it.each([
    ['a doc Claude printed, its answer under it', 'Claude', ['● Bash(cat docs/limits.md)', `${REPLY}You've hit your usage limit. Contact sales to raise it.`, '', ...CLAUDE_IDLE]],
    ['a limit Codex was sent a prompt past', 'Codex', ['■ You\'ve hit your usage limit. Try again at 4:15 PM.', '', '› Fix the login test', '', ...CODEX_IDLE]],
    ['a limit Codex answered past', 'Codex', ['■ You\'ve hit your usage limit. Try again at 4:15 PM.', '', '• Retried after the reset; the login test passes now.', '', ...CODEX_IDLE]],
  ])('%s', (_name, agent, rows) => {
    expect(onScreen(rows, agent).status).not.toBe('blocked')
  })

  // R3-2 and R3-7: each layout condition of the menus and popups, taken out alone, went unseen by
  // every test. Each of these screens has the words in place but one of them off.
  const MENU_ROWS = MENU.slice(3)
  it.each([
    ["the rate-limit menu's words printed at a shell, no rule above them", 'Claude', ['PS C:\\repo> type notes.txt', ...MENU_ROWS, 'PS C:\\repo>'], 'idle'],
    ["the menu's title in the middle of a row", 'Claude', [RULE, '  Claude asks: What do you want to do?', '', '  ❯ 1. Stop and wait for limit to reset', '', '  Enter to confirm · Esc to cancel'], 'thinking'],
    ['the menu left above what the shell printed once the worker exited, its keys far from the bottom', 'Claude', [...MENU.slice(0, 3), ...MENU_ROWS, '', 'PS C:\\repo> claude --version', '2.1.302 (Claude Code)', 'PS C:\\repo>'], 'idle'],
    ["the menu's rows above Claude Code's input box, its keys in the footer", 'Claude', [RULE, ...MENU_ROWS.slice(0, 3), RULE, '❯ ', RULE, '  Enter to confirm · Esc to cancel'], 'idle'],
    ["Codex's rate-limit popup without the option it is told by", 'Codex', SWITCH_POPUP.map((r) => r.replace('2. Keep current model', '2. Ask me later')).filter((r) => !r.includes('never show again')), 'waiting_for_input'],
    ["the popup's title in the middle of a row", 'Codex', ['  Note: Approaching rate limits soon', '', '› 1. Switch to gpt-5.6-luna', '  2. Keep current model', '', CODEX_KEYS], 'waiting_for_input'],
    ['a limit under the box, more rows down than a footer has', 'Claude', ['● OK', ...CLAUDE_IDLE.slice(0, 4), '  a', '  b', '  c', '  d', '  You\'ve hit your weekly limit · resets 4pm (UTC)'], 'idle'],
    ["Claude Code's wait for a limit, rows above the box among its answers", 'Claude', ['✻ Usage limit reached · continuing automatically at 3pm · esc to cancel', '', '● Then I went on with the next file.', '', '● All done.', ...CLAUDE_IDLE.slice(0, 4)], 'idle'],
  ])('%s', (_name, agent, rows, status) => {
    expect(onScreen(rows, agent).status).toBe(status)
  })

  it("is no menu in a raw tail, in Codex's own layout", () => {
    const tail = `${SWITCH_POPUP.join('\n')}\n`
    expect(detectAgentStatus('earlier output\n'.repeat(4) + tail, 'Codex', 'working').status).toBe('waiting_for_input')
  })

  it('is no quota dialog: a box at the bottom with other words in it, as Codex draws its header before its composer', () => {
    const header = ['╭──────────────────────────────────────────────────╮', '│ >_ OpenAI Codex (v0.153.4)                       │', '│ model:     loading   /model to change            │', '╰──────────────────────────────────────────────────╯']
    expect(isLimitOrMenu(onScreen(header))).toBe(false)
  })
})
