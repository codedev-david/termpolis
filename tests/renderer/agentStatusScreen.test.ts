import { describe, it, expect } from 'vitest'
import { detectAgentStatus, emptyInputBox, inputBoxRow, inputBoxRows, isBusyOnScreen, type AgentStatus } from '../../src/shared/agentStatusDetector'
import { screenOf } from '../../src/shared/terminalScreen'
import fixtures from '../fixtures/agentScreens.json'
import long from '../fixtures/longPromptScreens.json'
import input from '../fixtures/agentScreensInput.json'

// The status detector on a rendered screen (GitHub #36 item 4): what write_to_terminal's `submit`
// waits on, and the swarm bridge reads. The fixtures are real ConPTY output of Claude Code 2.1.302,
// Codex 0.153.4 and agy 1.4.0, captured at a hidden terminal's 80x24 (see the file's _about).

const NAMES = { claude: 'Claude', codex: 'Codex', agy: 'Gemini' } as const

function onScreen(agent: keyof typeof NAMES, moment: string, previous: AgentStatus = 'working') {
  const raw = (fixtures[agent] as Record<string, string>)[moment]
  const screen = screenOf(raw)
  return detectAgentStatus(screen.lines().join('\n'), NAMES[agent], previous, { screen: true, title: screen.title })
}

describe('detectAgentStatus on a real screen', () => {
  it.each([
    ['claude', 'startupIdle'],
    ['claude', 'doneIdle'],
    ['codex', 'ready'],
    ['codex', 'interruptedIdle'],
    ['agy', 'idle'],
    ['agy', 'doneIdle'],
  ] as const)('%s %s: idle, ready for a prompt', (agent, moment) => {
    expect(onScreen(agent, moment)).toEqual({ status: 'idle', summary: 'Waiting at prompt' })
  })

  it.each([
    ['claude', 'busy', 'Doing…'],
    ['codex', 'loading', 'Working...'],
    ['codex', 'mcpStarting', 'Starting MCP servers (1/2): codex_apps'],
    ['codex', 'queued', 'Queued follow-up inputs'],
    ['agy', 'busy', 'Generating...'],
  ] as const)('%s %s: working, with its status line as the summary', (agent, moment, summary) => {
    expect(onScreen(agent, moment)).toEqual({ status: 'working', summary })
  })

  it('reads Codex as working while it reconnects, the 12,000 chars before that line included', () => {
    expect(onScreen('codex', 'busyLate').status).toBe('working')
  })

  it('reads agy with a prompt typed but not sent as idle: still at its prompt', () => {
    expect(onScreen('agy', 'typed').status).toBe('idle')
  })

  it('reads a folder-trust dialog as waiting for input, not as a ready prompt', () => {
    expect(onScreen('agy', 'trust').status).toBe('waiting_for_input')
  })

  it('the same screens read as a raw tail say thinking or starting, which is why submit reads the screen', () => {
    // Before #36 every caller read the raw tail, and no busy or idle screen above came out right.
    for (const moment of ['ready', 'interruptedIdle'] as const) {
      const raw = fixtures.codex[moment]
      expect(detectAgentStatus(raw.slice(-3000), 'Codex', 'working').status).not.toBe('idle')
    }
    expect(detectAgentStatus(fixtures.claude.doneIdle.slice(-3000), 'Claude', 'working').status).not.toBe('idle')
  })

  it('keeps reading a worker the terminal name does not identify: workers the conductor starts are often unnamed', () => {
    const screen = screenOf(fixtures.codex.ready)
    expect(detectAgentStatus(screen.lines().join('\n'), '', 'starting', { screen: true, title: screen.title }).status).toBe('idle')
  })
})

// A long prompt typed into the box made it taller than the bottom rows, where the box was looked
// for: an idle agent with a task in its input read as thinking, and submit pressed no Enter on the
// task it had typed (GitHub #36). Real screens, read at the PTY's size.
describe('detectAgentStatus with a long prompt in the box', () => {
  it.each(Object.entries(long.screens))('%s: at its prompt, idle', (_name, s) => {
    const screen = screenOf(s.raw, { cols: s.cols, rows: s.rows })
    expect(detectAgentStatus(screen.lines().join('\n'), s.agent, 'working', { screen: true, title: screen.title }))
      .toEqual({ status: 'idle', summary: 'Waiting at prompt' })
  })
})

// A task whose first line is "1. ..." read as a menu's cursor on all three agents, and a task taller
// than the box read as no box at all: an idle worker with its task in its input read as thinking,
// so a second submit waited 3 minutes for nothing (GitHub #36, R2-1 and R2-2). The real screens of
// tests/fixtures/agentScreensInput.json, read at the PTY's size.
describe('detectAgentStatus with a task in the box that starts "1. ", or is taller than the box', () => {
  const rows = (s: { raw: string; cols: number; rows: number }): string[] => {
    const lines = screenOf(s.raw, { cols: s.cols, rows: s.rows }).lines()
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    return lines
  }

  it.each(Object.entries(input.screens))('%s: at its prompt, idle, its input not empty', (_name, s) => {
    const screen = screenOf(s.raw, { cols: s.cols, rows: s.rows })
    expect(detectAgentStatus(screen.lines().join('\n'), '', 'working', { screen: true, title: screen.title }))
      .toEqual({ status: 'idle', summary: 'Waiting at prompt' })
    expect(inputBoxRow(rows(s))).toBeGreaterThanOrEqual(0)
    expect(emptyInputBox(rows(s))).toBe(false)
  })

  it('reads the numbered rows as the box: the first of them is where it starts', () => {
    for (const name of ['claude-80x24-numbered', 'agy-80x24-numbered', 'codex-80x24-numbered'] as const) {
      const box = inputBoxRows(rows(input.screens[name]))
      expect(box?.[0]).toMatch(/^[>›]\s1\. Reply with the single word ONE\.$/)
      expect(box?.join('\n')).toContain('2. Run no tools.')
    }
  })

  it("reads Codex's composer without its footer, which it draws under a blank row, and a row right under the text as the text", () => {
    expect(inputBoxRows(['› Write the docs', '', '  gpt-5.6-sol medium · ~'])).toEqual(['› Write the docs', ''])
    expect(inputBoxRows(['› Write the docs', '  and the tests', '', '  gpt-5.6-sol medium · ~'])).toEqual(['› Write the docs', '  and the tests', ''])
    expect(inputBoxRows(['─'.repeat(60), '❯ You are in D:\\a\\project. Implement the', 'feature. Task ID: t-1'])).toEqual(['❯ You are in D:\\a\\project. Implement the', 'feature. Task ID: t-1'])
    expect(inputBoxRows(['› Write the docs'])).toEqual(['› Write the docs'])
    expect(inputBoxRows(['no box'])).toBeNull()
  })

  it("reads Claude Code's box taller than the screen from the screen's top down to its closing rule", () => {
    const lines = rows(input.screens['claude-80x17-tall'])
    expect(inputBoxRow(lines)).toBe(0)
    const box = inputBoxRows(lines)!
    expect(box[box.length - 1].trim()).toBe('16. no tools')
    expect(box).not.toContain(expect.stringMatching(/bypass permissions/))
  })
})

describe('detectAgentStatus on a screen: the rules', () => {
  const rule = '─'.repeat(80)
  const detect = (rows: string[], title = '', previous: AgentStatus = 'working') =>
    detectAgentStatus(rows.join('\n'), 'Claude', previous, { screen: true, title })

  it('a spinner in the window title is work in progress, even when the footer says nothing', () => {
    expect(detect([rule, '❯ ', rule], '⠙ my-project').status).toBe('working')
    expect(detect([rule, '❯ ', rule], '◑ Claude Code').status).toBe('working')
    expect(detect([rule, '❯ ', rule], '✳ Claude Code').status).toBe('idle')
  })

  it('reads "esc to interrupt" and "esc to cancel" only on the bottom rows, not in history scrolled up', () => {
    const history = ['• Working (3s • esc to interrupt)', ...Array<string>(14).fill('old transcript line')]
    expect(detect([...history, rule, '❯ ', rule]).status).toBe('idle')
    expect(detect(['history', rule, '> ', rule, 'esc to cancel']).status).toBe('working')
  })

  it('takes the lowest prompt row as the input box: history repeats each prompt the same way', () => {
    const rows = [rule, '❯ first prompt', rule, '● reply', rule, '❯ ', rule, '  ⏵⏵ bypass permissions on']
    expect(inputBoxRow(rows)).toBe(5)
  })

  it('finds an older Claude Code\'s boxed prompt, and Codex\'s › with only its own rows under it', () => {
    expect(inputBoxRow(['╭──────╮', '│ > ', '╰──────╯'])).toBe(1)
    expect(inputBoxRow(['transcript', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~'])).toBe(1)
    expect(inputBoxRow(['› far up', 'a', 'b', 'c', 'd', 'e', 'f'])).toBe(-1)
  })

  it("finds Codex's composer however many rows its text takes, and never a prompt in its history", () => {
    const typed = ['› Write the docs for every route, with an example request and the errors each', ...Array<string>(6).fill('  one returns, and a note on its rate limit.')]
    expect(inputBoxRow(['• Done.', '', ...typed, '', '  gpt-5.6-sol medium · ~'])).toBe(2)
    // In its history a prompt has its answer under it, at the start of a row.
    expect(inputBoxRow(['› Fix the test', '', '• Fixed it.', 'PS C:\\p> '])).toBe(-1)
  })

  it('reads a box whose top went off the screen by the rows of it that are left', () => {
    const rows = ['│ model: gpt-5.6-sol medium', '╰' + '─'.repeat(40) + '╯', '', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~']
    expect(detectAgentStatus(rows.join('\n'), 'Codex', 'working', { screen: true })).toEqual({ status: 'idle', summary: 'Waiting at prompt' })
  })

  it('reads a dialog at the bottom whole, but never on into another box above it', () => {
    const side = '─'.repeat(40)
    // A box in history, with a busy line long gone; under it the end of one whose top isn't drawn.
    const history = ['╭' + side + '╮', '│ • Working (3s • esc to interrupt)', '╰' + side + '╯', ...Array<string>(6).fill('old line')]
    const rows = [...history, ...Array<string>(8).fill('│ the rest of a box'), '╰' + side + '╯', rule, '❯ ', rule]
    expect(detect(rows).status).toBe('idle')
  })

  it("is no input box when the cursor sits on a numbered menu option, the menu's keys under it", () => {
    expect(inputBoxRow([rule, '❯ 1. Yes, I trust this folder', '  2. No, exit', '', '  Enter to confirm · Esc to cancel'])).toBe(-1)
    expect(inputBoxRow(['  Update available!', '› 1. Update now', '  2. Skip', '', '  Press enter to continue'])).toBe(-1)
    expect(inputBoxRow(['  Approaching rate limits', '› 1. Switch to gpt-5.6-luna', '  2. Keep current model', '', '  Press enter to confirm or esc to go back'])).toBe(-1)
    expect(detect(['Pick one', '› 1. Update now', '  2. Skip', '  Press enter to continue']).status).not.toBe('idle')
  })

  it('reads a numbered row with no menu keys under it as the box: a task typed into it', () => {
    expect(inputBoxRow([rule, '❯ 1. Write the docs.', '  2. Run the tests.', rule])).toBe(1)
    expect(inputBoxRow(['• Done.', '', '› 1. Write the docs.', '  2. Run the tests.', '', '  gpt-5.6-sol medium · ~'])).toBe(2)
    // The keys must start a row: a task that mentions them is still a task.
    expect(inputBoxRow(['› 1. Run the installer. It says Press enter to continue.', '', '  gpt-5.6-sol medium · ~'])).toBe(0)
  })

  it("is no tall box for a dialog under a rule, or a transcript's rows above one", () => {
    // Claude Code's own dialogs draw a rule over their options and keys.
    expect(inputBoxRow(['  ⎿  long tool output', '     more of it', rule, '  Do you want to proceed?', '  ❯ 1. Yes', '  Esc to cancel'])).toBe(-1)
    expect(inputBoxRow(['  indented', rule, '  ❯ 1. Yes', '  Enter to confirm · Esc to cancel'])).toBe(-1)
    // An answer at the start of a row is the transcript, and a rule with nothing above it no box.
    expect(inputBoxRow(['● The answer', '  goes on here', rule, '  ⏵⏵ bypass permissions on'])).toBe(-1)
    expect(inputBoxRow([rule, '  ⏵⏵ bypass permissions on'])).toBe(-1)
    expect(inputBoxRow(['  a', '  b', rule, '  1', '  2', '  3', '  4', '  5'])).toBe(-1)
  })

  it('reads an empty box by its glyph and the placeholder each CLI shows in it', () => {
    const empty = (rows: string[]) => emptyInputBox(rows)
    expect(empty([rule, '❯ ', rule])).toBe(true)
    expect(empty([rule, '❯ Try "how does src/main/index.ts work?"', rule, '  ⏵⏵ bypass permissions on'])).toBe(true)
    expect(empty(['› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~'])).toBe(true)
    expect(empty(['› Ask a follow-up question', '', '  gpt-5.6-sol medium · ~'])).toBe(true)
    expect(empty([rule, '>', rule, '? for shortcuts'])).toBe(true)
    expect(empty([rule, '❯ Try harder', rule])).toBe(false)
    expect(empty([rule, '❯ Write the docs', rule])).toBe(false)
    expect(empty([rule, '❯ Write the docs', '  and the tests', rule])).toBe(false)
    expect(empty(['no box here'])).toBe(false)
  })

  it('reads the empty boxes of the real sessions as empty, and one with a prompt typed as not', () => {
    const lines = (raw: string) => screenOf(raw).lines().filter((_r, i, all) => all.slice(i).some((x) => x.trim() !== ''))
    for (const raw of [fixtures.claude.startupIdle, fixtures.claude.doneIdle, fixtures.codex.ready, fixtures.agy.idle, fixtures.agy.doneIdle]) {
      expect(emptyInputBox(lines(raw))).toBe(true)
    }
    expect(emptyInputBox(lines(fixtures.agy.typed))).toBe(false)
  })

  it('reads an agent at work by its busy line or the spinner in its title, and one at its prompt as not', () => {
    const lines = (raw: string) => screenOf(raw).lines()
    expect(isBusyOnScreen(lines(fixtures.claude.busy), '')).toBe(true)
    expect(isBusyOnScreen(lines(fixtures.agy.busy), '')).toBe(true)
    expect(isBusyOnScreen(lines(fixtures.codex.queued), '')).toBe(true)
    expect(isBusyOnScreen(lines(fixtures.claude.doneIdle), '✳ Claude Code')).toBe(false)
    expect(isBusyOnScreen(lines(fixtures.claude.doneIdle), '◐ Claude Code')).toBe(true)
  })

  it('reads a screen with no agent on it as text: a shell prompt is idle', () => {
    expect(detect(['PS C:\\project> ']).status).toBe('idle')
    expect(detect(['some output', '$ ']).status).toBe('idle')
  })

  it('names the status line it found, without the "(… esc to interrupt)" part', () => {
    expect(detect(['• Working (2m 09s • esc to interrupt)', '› ']).summary).toBe('Working')
    expect(detect(['plain', 'esc to interrupt']).summary).toBe('Working...')
  })

  it('ignores blank rows under the screen\'s content', () => {
    expect(detect([rule, '❯ ', rule, '', '', '']).status).toBe('idle')
  })

  it('reads a blocked agent off the screen before anything else', () => {
    const rows = ['🎉 Update ran successfully! Please restart Codex.', 'PS C:\\project> ']
    expect(detectAgentStatus(rows.join('\n'), 'Codex', 'working', { screen: true, title: '⠙ x' }))
      .toEqual({ status: 'blocked', summary: 'Codex self-updated — needs restart to resume' })
  })

  it('works without a title', () => {
    expect(detectAgentStatus([rule, '❯ ', rule].join('\n'), 'Claude', 'working', { screen: true }).status).toBe('idle')
  })
})

describe('detectAgentStatus on a raw tail', () => {
  it('reads a ConPTY cursor-forward as the space it stands for', () => {
    // "Do you trust the contents of this directory?" as Codex sends it on Windows.
    const raw = 'x'.repeat(40) + '\nDo\x1b[1Cyou\x1b[Ctrust\x1b[1Cthe\x1b[1Ccontents\x1b[1Cof\x1b[1Cthis\x1b[1Cdirectory?\n'
    expect(detectAgentStatus(raw, 'Codex').status).toBe('waiting_for_input')
  })
})
