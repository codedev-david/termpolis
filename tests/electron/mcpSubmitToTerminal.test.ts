import { describe, it, expect, vi } from 'vitest'
import { executeTool, submitToTerminal, SUBMIT_READY_TIMEOUT_MS, type McpToolHandlers, type SubmitClock } from '../../src/main/mcpServer'
import { screenOf } from '../../src/shared/terminalScreen'
import { inputBoxRow } from '../../src/shared/agentStatusDetector'
import fixtures from '../fixtures/agentScreens.json'
import wide from '../fixtures/agentScreensWide.json'
import long from '../fixtures/longPromptScreens.json'
import input from '../fixtures/agentScreensInput.json'
import typed from '../fixtures/agentScreensTyped.json'
import held from '../fixtures/agentScreensHeld.json'
import cleared from '../fixtures/agentScreensCleared.json'
import cursorScreens from '../fixtures/agentScreensCursor.json'

// write_to_terminal with `submit` (GitHub #36 item 4), against a fake terminal: a screen script that
// changes as time passes and as the tool types, and a clock that only moves when the tool sleeps.

const E = '\x1b'
const RULE = '─'.repeat(80)
/** What submit clears a box that holds something else with: twenty Ctrl+U to a write. */
const CLEAR = '\u0015'.repeat(20)
/** A screen as ConPTY would send it: home, clear, then each row at its own position. */
const frame = (rows: string[], title = ''): string =>
  `${E}]0;${title}\x07${E}[H${E}[2J` + rows.map((r, i) => `${E}[${i + 1};1H${r}`).join('')
const idle = (inBox = ''): string => frame(['Claude Code', '', RULE, `❯ ${inBox}`, RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
const busy = (): string => frame(['Claude Code', '❯ the task', '✢ Doing…', RULE, '❯ ', RULE, '  esc to interrupt'], '◐ Claude Code')

interface FakeTerminal {
  handlers: McpToolHandlers
  clock: SubmitClock
  writes: string[]
  times: number[]
}

/** `screenAt(ms, typed, times)` says what the terminal shows at a moment, given everything typed so
 *  far and when each piece was. `size` is the PTY's, which main reports through terminalSize. */
function fakeTerminal(screenAt: (ms: number, typed: string[], times: number[]) => string, name = 'Claude (Build)', size?: { cols: number; rows: number }): FakeTerminal {
  let now = 0
  const writes: string[] = []
  const times: number[] = []
  const handlers = {
    listTerminals: () => [{ id: 't1', name, shellType: 'powershell', cwd: '/p' }],
    readOutput: vi.fn((_id: string, _lines: number) => screenAt(now, writes, times)),
    writeToTerminal: vi.fn((_id: string, text: string) => {
      writes.push(text)
      times.push(now)
    }),
    ...(size ? { terminalSize: vi.fn(() => size) } : {}),
  } as unknown as McpToolHandlers
  const clock: SubmitClock = { now: () => now, sleep: async (ms) => { now += ms } }
  return { handlers, clock, writes, times }
}

describe('submitToTerminal', () => {
  it('waits for the agent to be ready, types the text without its CR, settles, then presses Enter alone', async () => {
    // Busy for the first 20 s (a Codex loading its MCP servers), then at its prompt.
    const t = fakeTerminal((ms, typed) => {
      if (typed.includes('\r')) return busy()
      if (ms < 20_000) return busy()
      return idle(typed.join(''))
    })
    const res = await submitToTerminal(t.handlers, 't1', 'Build the login page. Task ID: abc\r\n', t.clock)
    expect(res).toEqual({ submitted: true, waitedMs: 21_000 })
    expect(t.writes).toEqual(['Build the login page. Task ID: abc', '\r'])
    // Nothing typed until it was ready twice in a row; then the text, a pause, and the Enter.
    expect(t.times[0]).toBe(21_000)
    expect(t.times[1] - t.times[0]).toBeGreaterThanOrEqual(150)
  })

  it('needs two ready reads in a row: a screen that flickers to its prompt for one frame isn\'t ready', async () => {
    let reads = 0
    const t = fakeTerminal((_ms, typed) => {
      reads++
      if (typed.includes('\r')) return busy()
      return reads === 1 || reads >= 3 ? (reads === 2 ? busy() : idle(typed.join(''))) : busy()
    })
    const res = await submitToTerminal(t.handlers, 't1', 'go', t.clock)
    expect(res.submitted).toBe(true)
    expect(t.times[0]).toBeGreaterThanOrEqual(2000)
  })

  it('presses Enter once more when the first one left the text in the input, and reports success', async () => {
    const t = fakeTerminal((_ms, typed) => {
      const enters = typed.filter((w) => w === '\r').length
      if (enters >= 2) return busy()
      return idle(typed.filter((w) => w !== '\r').join(''))
    })
    const res = await submitToTerminal(t.handlers, 't1', 'Write the docs', t.clock)
    expect(res).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['Write the docs', '\r', '\r'])
  })

  it('reports it when the text is still in the input after the second Enter', async () => {
    const t = fakeTerminal((_ms, typed) => idle(typed.filter((w) => w !== '\r').join('')))
    const res = await submitToTerminal(t.handlers, 't1', 'Write the docs', t.clock)
    expect(res.submitted).toBe(false)
    expect(res.error).toMatch(/still in the agent's input after Enter was pressed twice/)
    expect(t.writes).toEqual(['Write the docs', '\r', '\r'])
  })

  it('counts a long paste the agent collapsed into a placeholder as still in the input', async () => {
    const long = 'x'.repeat(3000)
    const t = fakeTerminal((_ms, typed) => {
      const enters = typed.filter((w) => w === '\r').length
      if (enters >= 2) return busy()
      return idle(typed.length > 0 ? '[Pasted text #1 +40 lines]' : '')
    })
    const res = await submitToTerminal(t.handlers, 't1', long, t.clock)
    expect(res.submitted).toBe(true)
    expect(t.writes).toEqual([long, '\r', '\r'])
    // Shown at the first look and the same at the second, half a second in; then a long prompt gets
    // a longer pause before its Enter, at most 2 s.
    expect(t.times[1] - t.times[0]).toBe(500 + 2000)
  })

  it('takes a prompt the agent answered between two looks: back at its prompt, the text gone, its answer above', async () => {
    // A slash command, or a reply so fast that its busy line came and went unseen.
    const answered = frame(['Claude Code', '❯ /compact', '  ⎿  Compacted', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? answered : idle(typed.join(''))))
    const res = await submitToTerminal(t.handlers, 't1', '/compact', t.clock)
    expect(res).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['/compact', '\r'])
  })

  it('counts an input emptied with nothing new above it as not taken, presses no second Enter, and returns the screen', async () => {
    const t = fakeTerminal((_ms, typed) => idle(typed.includes('\r') ? '' : typed.join('')))
    const res = await submitToTerminal(t.handlers, 't1', '/compact', t.clock)
    expect(res.submitted).toBe(false)
    expect(res.error).toMatch(/neither started working nor went back to its prompt with the text taken.*read_output/)
    expect(res.screen).toContain('⏵⏵ bypass permissions on')
    expect(t.writes).toEqual(['/compact', '\r'])
  })

  // GitHub #36: a Claude Code just started draws its input box before it handles keys. The text
  // showed up there 1-2 s later, the Enter pressed before that became a new line in it, and the
  // prompt sat unsent while the conductor was told it had been taken.
  it('presses Enter only once the agent shows the text, which an agent just started does late', async () => {
    const t = fakeTerminal((ms, typed, times) => {
      const shownAt = times[0] + 2500
      // An Enter before the text is shown is lost in it.
      if (typed.some((w, i) => w === '\r' && times[i] >= shownAt)) return busy()
      return idle(typed.length > 0 && ms >= shownAt ? typed[0] : '')
    })
    const res = await submitToTerminal(t.handlers, 't1', 'Write the docs. Task ID: t-1', t.clock)
    expect(res).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
    expect(t.times[1] - t.times[0]).toBeGreaterThanOrEqual(2500)
  })

  it('reports a text the agent never showed, presses no Enter on it, and returns the screen', async () => {
    const t = fakeTerminal(() => idle())
    const res = await submitToTerminal(t.handlers, 't1', 'Write the docs', t.clock)
    expect(res.submitted).toBe(false)
    expect(res.error).toMatch(/never showed the text/)
    expect(res.screen).toBe(['Claude Code', '', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on'].join('\n'))
    expect(t.writes).toEqual(['Write the docs'])
  })

  it('reads a prompt of several lines by its end: one whose Enter never takes is reported, with the screen', async () => {
    // The box shows the text a line to a row; flattened onto one row, it never matched the first.
    const text = 'Task ID: t-1\nWrite the docs for the API.'
    const t = fakeTerminal((_ms, typed) => frame(['Claude Code', '', RULE, ...(typed.length ? ['❯ Task ID: t-1', '  Write the docs for the API.'] : ['❯ ']), RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code'))
    const res = await submitToTerminal(t.handlers, 't1', text, t.clock)
    expect(res.submitted).toBe(false)
    expect(res.error).toMatch(/still in the agent's input after Enter was pressed twice/)
    expect(res.screen).toContain('  Write the docs for the API.')
    expect(t.writes).toEqual([text, '\r', '\r'])
  })

  it("waits for the box to show a short text that the footer holds too: the box's empty until it does", async () => {
    // "on" is in "bypass permissions on" under the box from the start.
    const t = fakeTerminal((ms, typed, times) => {
      if (typed.includes('\r')) return busy()
      return idle(typed.length > 0 && ms >= times[0] + 2500 ? typed[0] : '')
    })
    expect((await submitToTerminal(t.handlers, 't1', 'on', t.clock)).submitted).toBe(true)
    expect(t.times[1] - t.times[0]).toBeGreaterThanOrEqual(2500)
  })

  it('reads a long prompt that wraps in the box by its first row', async () => {
    const long = 'Build the login page with a form, validation, an error state and a test for each of them. Task ID: t-9'
    const t = fakeTerminal((_ms, typed) => {
      if (typed.includes('\r')) return busy()
      const text = typed.join('')
      const rows = text ? [`❯ ${text.slice(0, 78)}`, `  ${text.slice(78)}`] : ['❯ ']
      return frame(['Claude Code', '', RULE, ...rows, RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
    })
    expect(await submitToTerminal(t.handlers, 't1', long, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([long, '\r'])
  })

  // Sent again after a submit whose Enter didn't take, the text went in after the copy still there,
  // and the agent got the prompt twice in one.
  it('presses only Enter when the text is still in the input from a call before', async () => {
    const text = 'Task ID: t-1. Write the API docs in docs/api.md.'
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : idle(text)))
    expect(await submitToTerminal(t.handlers, 't1', text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
  })

  it('presses no Enter on a prompt typed behind another stuck in an input that Ctrl+U does not clear: the agent would take both as one', async () => {
    const stuck = 'You are working in C:\\work\\portal. Build the login page. Task ID: t-1'
    const text = 'You are working in C:\\work\\portal. Write the docs. Task ID: t-2'
    // The box wraps what it holds onto a second row, indented, as Claude Code's does.
    const box = (inBox: string) => frame(['Claude Code', '', RULE, `❯ ${inBox.slice(0, 78)}`, `  ${inBox.slice(78)}`, RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : box(stuck + typed.filter((w) => w !== CLEAR).join(''))))
    const res = await submitToTerminal(t.handlers, 't1', text, t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/already held other text, which clearing it didn't remove.*Enter was not pressed/) })
    expect(res.screen).toContain('Build the login page')
    expect(t.writes).toEqual([CLEAR, CLEAR, text])
  })

  it('clears a paste placeholder in the input before it types a long prompt: that could be any text', async () => {
    const long = 'y'.repeat(3000)
    const t = fakeTerminal((_ms, typed) => {
      if (typed.includes('\r')) return busy()
      if (typed.some((w) => w !== CLEAR)) return idle('[Pasted text #2 +40 lines]')
      return idle(typed.length ? '' : '[Pasted text #1 +40 lines]')
    })
    expect((await submitToTerminal(t.handlers, 't1', long, t.clock)).submitted).toBe(true)
    expect(t.writes).toEqual([CLEAR, long, '\r'])
  })

  it('presses only Enter for a prompt still in the input over several rows, as a long one wraps', async () => {
    const text = 'Build the login page with a form, validation, an error state and a test for each of them. Task ID: t-9'
    const box = (inBox: string) => frame(['Claude Code', '', RULE, `❯ ${inBox.slice(0, 78)}`, `  ${inBox.slice(78)}`, RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : box(text)))
    expect((await submitToTerminal(t.handlers, 't1', text, t.clock)).submitted).toBe(true)
    expect(t.writes).toEqual(['\r'])
  })

  it('starts the wait over when the agent goes busy between two ready reads', async () => {
    // Ready, busy, ready, ready: ready twice in a row only at 3 s.
    let reads = 0
    const t = fakeTerminal((_ms, typed) => {
      if (typed.length) return typed.includes('\r') ? busy() : idle(typed.join(''))
      return ++reads === 2 ? busy() : idle()
    })
    expect((await submitToTerminal(t.handlers, 't1', 'go', t.clock)).submitted).toBe(true)
    expect(t.times[0]).toBe(3000)
  })

  it('counts the prompt as taken once the agent works on it, though its box still shows the text', async () => {
    const t = fakeTerminal((_ms, typed) => {
      const text = typed.filter((w) => w !== '\r').join('')
      return typed.includes('\r') ? frame(['Claude Code', '✢ Doing…', RULE, `❯ ${text}`, RULE, '  esc to interrupt'], '◐ Claude Code') : idle(text)
    })
    expect(await submitToTerminal(t.handlers, 't1', 'Write the docs', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['Write the docs', '\r'])
  })

  it('gives the agent seconds to take the prompt before it presses Enter again', async () => {
    // To work 1.5 s after the Enter: a second one then would be a new line in its next prompt.
    const t = fakeTerminal((ms, typed, times) => {
      const enter = typed.indexOf('\r')
      if (enter >= 0 && ms >= times[enter] + 1500) return busy()
      return idle(typed.filter((w) => w !== '\r').join(''))
    })
    expect((await submitToTerminal(t.handlers, 't1', 'Write the docs', t.clock)).submitted).toBe(true)
    expect(t.writes).toEqual(['Write the docs', '\r'])
  })

  it("takes a prompt Codex answered between two looks: its composer empty again, its placeholder in it, the answer above", async () => {
    const t = fakeTerminal((_ms, typed) => {
      const text = typed.filter((w) => w !== '\r').join('')
      const rows = typed.includes('\r') ? [`› ${text}`, '', '• Done.', '', '› Ask a follow-up question'] : [`› ${text || 'Ask Codex to do anything'}`]
      return frame(['>_ OpenAI Codex', '', ...rows, '', '  gpt-5.6-sol medium · ~/p'])
    }, 'Codex (Docs)')
    expect(await submitToTerminal(t.handlers, 't1', 'Write the docs', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['Write the docs', '\r'])
  })

  it('counts a box holding something else after the Enter, the agent idle, as not taken: no second Enter, and the screen', async () => {
    // Neither at work nor at its empty box: what the agent did with the prompt can't be told.
    const t = fakeTerminal((_ms, typed) => {
      const text = typed.filter((w) => w !== '\r').join('')
      const rows = typed.includes('\r') ? [`› ${text}`, '', '• Done.', '', '› Explain why the docs failed'] : [`› ${text}`]
      return frame(['>_ OpenAI Codex', '', ...rows, '', '  gpt-5.6-sol medium · ~/p'])
    }, 'Codex (Docs)')
    const res = await submitToTerminal(t.handlers, 't1', 'Write the docs', t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/neither started working nor went back to its prompt/) })
    expect(res.screen).toContain('› Explain why the docs failed')
    expect(t.writes).toEqual(['Write the docs', '\r'])
  })

  it('presses no Enter on a text that starts with a new line, which the agent never showed', async () => {
    const t = fakeTerminal(() => idle())
    const res = await submitToTerminal(t.handlers, 't1', '\nWrite the docs', t.clock)
    expect(res.error).toMatch(/never showed the text/)
    expect(t.writes).toEqual(['\nWrite the docs'])
  })

  it('sends a task typed over a suggestion the box showed, which no Ctrl+U deletes and typing replaced', async () => {
    // Claude Code can show a prompt it suggests in its box, gone at the first key: no other text.
    const t = fakeTerminal((_ms, typed) => {
      if (typed.includes('\r')) return busy()
      const keys = typed.filter((w) => w !== CLEAR)
      return idle(keys.length ? keys.join('') : 'run the tests again')
    })
    expect(await submitToTerminal(t.handlers, 't1', 'Write the docs. Task ID: t-1', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, CLEAR, 'Write the docs. Task ID: t-1', '\r'])
  })

  it('presses Enter alone when given only a CR', async () => {
    const t = fakeTerminal((_ms, typed) => (typed.length ? busy() : idle()))
    const res = await submitToTerminal(t.handlers, 't1', '\r', t.clock)
    expect(res.submitted).toBe(true)
    expect(t.writes).toEqual(['\r'])
  })

  it('gives up after about three minutes of an agent that never got ready, typing nothing', async () => {
    const t = fakeTerminal(() => busy())
    const res = await submitToTerminal(t.handlers, 't1', 'task', t.clock)
    expect(res.submitted).toBe(false)
    expect(res.waitedMs).toBe(SUBMIT_READY_TIMEOUT_MS)
    expect(res.error).toMatch(/not ready for input after 180 s \(working: Doing…\)/)
    expect(res.screen).toContain('esc to interrupt')
    expect(t.writes).toEqual([])
  })

  it('stops at once on a blocked agent: a dead CLI doesn\'t get ready by waiting', async () => {
    const t = fakeTerminal(() => frame(['🎉 Update ran successfully! Please restart Codex.', 'PS C:\\p> ']), 'Codex (Docs)')
    const res = await submitToTerminal(t.handlers, 't1', 'task', t.clock)
    expect(res).toEqual({
      submitted: false,
      waitedMs: 0,
      error: 'The agent is blocked: Codex self-updated — needs restart to resume.',
      screen: '🎉 Update ran successfully! Please restart Codex.\nPS C:\\p>',
    })
    expect(t.writes).toEqual([])
  })

  it('reports a terminal that has no output as not one to type into, after thirty seconds', async () => {
    const t = fakeTerminal(() => '')
    const res = await submitToTerminal(t.handlers, 'nope', 'task', t.clock)
    expect(res.submitted).toBe(false)
    expect(res.waitedMs).toBe(30_000)
    expect(res.error).toMatch(/shows no output: it was closed, or it is not an ID create_terminal returned/)
  })

  it('waits out a shell that takes a while to print its first prompt', async () => {
    const t = fakeTerminal((ms, typed) => (ms < 12_000 ? '' : typed.includes('\r') ? busy() : idle(typed.join(''))))
    expect(await submitToTerminal(t.handlers, 't1', 'go', t.clock)).toEqual({ submitted: true, waitedMs: 13_000 })
  })

  it('reads only the input box\'s own rows: a short text that is also a word in the footer was still sent', async () => {
    // "on" is in "bypass permissions on" under the box. Once the box is empty and the prompt is in
    // the transcript, the prompt went.
    const answered = frame(['Claude Code', '❯ on', '', '● On.', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? answered : idle(typed.join(''))))
    expect(await submitToTerminal(t.handlers, 't1', 'on', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
  })

  it('reports a terminal that went away while it waited, and one that went away after the Enter', async () => {
    const closing = fakeTerminal((ms) => (ms < 5000 ? busy() : ''))
    expect((await submitToTerminal(closing.handlers, 't1', 'task', closing.clock)).error).toBe('Terminal t1 was closed.')
    const gone = fakeTerminal((_ms, typed) => (typed.includes('\r') ? '' : idle(typed.join(''))))
    const res = await submitToTerminal(gone.handlers, 't1', 'task', gone.clock)
    expect(res).toEqual({ submitted: false, waitedMs: 1000, error: 'Terminal t1 was closed.' })
  })

  it('submits into the real Codex screen once it is ready, and not while it loads', async () => {
    // Real Codex 0.153.4 output: loading (an Enter would only queue the prompt), then ready, and
    // then what is typed drawn in its composer, the row of "› Ask Codex to do anything".
    const t = fakeTerminal((ms, typed) => {
      if (typed.includes('\r')) return fixtures.codex.queued
      if (typed.length) return `${fixtures.codex.ready}${E}[22;1H${E}[2K› ${typed[0]}`
      return ms < 30_000 ? fixtures.codex.mcpStarting : fixtures.codex.ready
    }, 'Codex (Docs)')
    const res = await submitToTerminal(t.handlers, 't1', 'Reply with only the word OK and nothing else.', t.clock)
    expect(res).toEqual({ submitted: true, waitedMs: 31_000 })
  })

  it('submits into a plain shell, and sees the command leave its prompt line', async () => {
    const banner = ['Windows PowerShell', 'Copyright (C) Microsoft Corporation. All rights reserved.', '',
      'Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows', '']
    const t = fakeTerminal((_ms, typed) => {
      const line = typed.filter((w) => w !== '\r').join('')
      return typed.includes('\r') ? frame([...banner, `PS C:\\p> ${line}`, 'hi', 'PS C:\\p> ']) : frame([...banner, `PS C:\\p> ${line}`])
    }, 'Shell')
    const res = await submitToTerminal(t.handlers, 't1', 'echo hi', t.clock)
    expect(res).toEqual({ submitted: true, waitedMs: 1000 })
  })

  it('reports a screen that went blank after the Enter: neither at work nor at its prompt, so no second Enter', async () => {
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? `${E}[2J` : idle(typed.join(''))))
    const res = await submitToTerminal(t.handlers, 't1', 'go', t.clock)
    expect(res).toMatchObject({ submitted: false, screen: '' })
    expect(t.writes).toEqual(['go', '\r'])
  })

  it('reports a limit that shows once Enter was pressed, the text still in the box, and presses no second Enter', async () => {
    const limited = frame(['Claude Code', '', RULE, '❯ Write the docs', RULE, '  You\'ve hit your weekly limit · resets 4pm (UTC)'], '✳ Claude Code')
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? limited : idle(typed.join(''))))
    const res = await submitToTerminal(t.handlers, 't1', 'Write the docs', t.clock)
    expect(res).toMatchObject({ submitted: false, error: 'Enter was pressed, and the agent is blocked: usage limit reached (resets 4pm (UTC)).' })
    expect(t.writes).toEqual(['Write the docs', '\r'])
  })

  it('presses no second Enter on a shell that kept a long command on its line and reads as anything but idle', async () => {
    const banner = ['Windows PowerShell', 'Copyright (C) Microsoft Corporation. All rights reserved.', '',
      'Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows', '']
    const command = 'Write-Output "a long command line"'
    const t = fakeTerminal((_ms, typed) => frame([...banner, `PS C:\\p> ${typed.filter((w) => w !== '\r').join('')}`]), 'Shell')
    const res = await submitToTerminal(t.handlers, 't1', command, t.clock)
    expect(res.error).toMatch(/neither started working nor went back to its prompt/)
    expect(t.writes).toEqual([command, '\r'])
  })

  it('presses no second Enter on a dialog the prompt opened: an Enter there would pick one of its options', async () => {
    const dialog = frame(['Claude Code', '❯ /model', '', RULE, '  Select model', '  ❯ 1. Default', '    2. Opus', '', '  Enter to confirm · Esc to cancel'], '✳ Claude Code')
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? dialog : idle(typed.join(''))))
    const res = await submitToTerminal(t.handlers, 't1', '/model', t.clock)
    expect(res.submitted).toBe(false)
    expect(res.screen).toContain('Enter to confirm · Esc to cancel')
    expect(t.writes).toEqual(['/model', '\r'])
  })

  it('names only the status when the agent gave no summary at the timeout', async () => {
    let reads = 0
    const t = fakeTerminal(() => (++reads === 1 ? busy() : frame(['ok'])))
    const res = await submitToTerminal(t.handlers, 't1', 'task', t.clock)
    expect(res.error).toBe('The agent was not ready for input after 180 s (working). Check it with read_output.')
  })

  it('works out a terminal\'s name when listTerminals fails', async () => {
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : idle(typed.join(''))))
    ;(t.handlers as { listTerminals: () => unknown }).listTerminals = () => { throw new Error('session unreadable') }
    expect((await submitToTerminal(t.handlers, 't1', 'go', t.clock)).submitted).toBe(true)
  })

  const banner = ['Windows PowerShell', 'Copyright (C) Microsoft Corporation. All rights reserved.', '',
    'Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows', '']

  it('counts a command a shell kept on its line after Enter as not taken', async () => {
    const t = fakeTerminal((_ms, typed) => frame([...banner, `PS C:\\p> ${typed.filter((w) => w !== '\r').join('')}`]), 'Shell')
    const res = await submitToTerminal(t.handlers, 't1', 'echo hi', t.clock)
    expect(res.submitted).toBe(false)
    expect(t.writes).toEqual(['echo hi', '\r', '\r'])
  })

  it('reads a Codex-named terminal by Codex\'s rules: a choice it asks for is no prompt to type at', async () => {
    const t = fakeTerminal(() => frame([...banner, 'Select an option:', '  1. Yes', '  2. No', 'Press enter to confirm', '> ']), 'Codex (Docs)')
    const res = await submitToTerminal(t.handlers, 't1', 'task', t.clock)
    expect(res.submitted).toBe(false)
    expect(res.error).toMatch(/\(waiting_for_input: Press enter to confirm\)/)
    expect(t.writes).toEqual([])
  })

  // A conductor's parallel tool calls: both waited for the same ready screen, both typed, and the
  // agent got "Task A...Task B..." as one prompt while both calls reported it submitted.
  it('submits two calls to one terminal one after the other, each as a prompt of its own', async () => {
    let now = 0
    let box = ''
    let busyUntil = -1
    const received: string[] = []
    const writes: string[] = []
    // An agent that shows what is typed, takes it on Enter, and works on it for 5 s.
    const handlers = {
      listTerminals: () => [{ id: 't1', name: 'Claude (Build)', shellType: 'powershell', cwd: '/p' }],
      readOutput: () => (now < busyUntil ? busy() : idle(box)),
      writeToTerminal: (_id: string, text: string) => {
        writes.push(text)
        if (text !== '\r') box += text
        else if (box) {
          received.push(box)
          box = ''
          busyUntil = now + 5000
        }
      },
    } as unknown as McpToolHandlers
    const clock: SubmitClock = { now: () => now, sleep: async (ms) => { now += ms } }
    const results = await Promise.all([
      submitToTerminal(handlers, 't1', 'Task A: build the login page.', clock),
      submitToTerminal(handlers, 't1', 'Task B: write the docs.', clock),
    ])
    expect(received).toEqual(['Task A: build the login page.', 'Task B: write the docs.'])
    expect(writes).toEqual(['Task A: build the login page.', '\r', 'Task B: write the docs.', '\r'])
    expect(results.map((r) => r.submitted)).toEqual([true, true])
  })

  it('lets the next submit to a terminal go ahead after one that failed with an error', async () => {
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : idle(typed.join(''))))
    const read = t.handlers.readOutput as unknown as ReturnType<typeof vi.fn>
    read.mockImplementationOnce(() => { throw new Error('buffer gone') })
    const [failed, next] = await Promise.allSettled([
      submitToTerminal(t.handlers, 't1', 'first', t.clock),
      submitToTerminal(t.handlers, 't1', 'second', t.clock),
    ])
    expect(failed).toMatchObject({ status: 'rejected', reason: { message: 'buffer gone' } })
    expect(next).toMatchObject({ status: 'fulfilled', value: { submitted: true } })
    expect(t.writes).toEqual(['second', '\r'])
  })

  it('reports a terminal that went away while it waited for the text to show', async () => {
    const t = fakeTerminal((_ms, typed) => (typed.length ? '' : idle()))
    expect(await submitToTerminal(t.handlers, 't1', 'Write the docs', t.clock)).toEqual({ submitted: false, waitedMs: 1000, error: 'Terminal t1 was closed.' })
    expect(t.writes).toEqual(['Write the docs'])
  })

  it('submits to another terminal meanwhile: one agent that never gets ready holds up no other', async () => {
    let now = 0
    const typed = new Map<string, string>()
    const typedAt = new Map<string, number>()
    const handlers = {
      listTerminals: () => [],
      readOutput: (id: string) => (id === 'stuck' || (typed.get(id) ?? '').endsWith('\r') ? busy() : idle(typed.get(id) ?? '')),
      writeToTerminal: (id: string, text: string) => {
        typed.set(id, (typed.get(id) ?? '') + text)
        if (!typedAt.has(id)) typedAt.set(id, now)
      },
    } as unknown as McpToolHandlers
    const clock: SubmitClock = { now: () => now, sleep: async (ms) => { now += ms } }
    const [stuck, other] = await Promise.all([submitToTerminal(handlers, 'stuck', 'one', clock), submitToTerminal(handlers, 'b', 'two', clock)])
    expect(stuck.submitted).toBe(false)
    expect(other.submitted).toBe(true)
    // Long before the stuck one gave up, three minutes in.
    expect(typedAt.get('b')).toBeLessThan(10_000)
  })

  // A conductor that died, or a client whose tool call timed out, is gone; a submit still waiting
  // for its agent typed the task in later anyway, and a retry got it typed twice.
  it('stops once its call is abandoned, typing nothing more', async () => {
    const abandoned = new AbortController()
    const t = fakeTerminal((ms, typed) => (ms < 5000 ? busy() : typed.includes('\r') ? busy() : idle(typed.join(''))))
    const clock: SubmitClock = { now: t.clock.now, sleep: async (ms) => { await t.clock.sleep(ms); if (t.clock.now() >= 3000) abandoned.abort() } }
    const res = await submitToTerminal(t.handlers, 't1', 'Write the docs', clock, abandoned.signal)
    expect(res).toEqual({ submitted: false, waitedMs: 3000, error: 'The call was abandoned before the agent was ready, so nothing was typed.' })
    expect(t.writes).toEqual([])
  })

  it('presses no Enter for a call abandoned after its text was typed', async () => {
    const abandoned = new AbortController()
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : idle(typed.join(''))))
    const clock: SubmitClock = { now: t.clock.now, sleep: async (ms) => { await t.clock.sleep(ms); if (t.clock.now() > 1000) abandoned.abort() } }
    const res = await submitToTerminal(t.handlers, 't1', 'Write the docs', clock, abandoned.signal)
    expect(res).toEqual({ submitted: false, waitedMs: 1000, error: 'The call was abandoned before Enter was pressed.' })
    expect(t.writes).toEqual(['Write the docs'])
  })
})

// A terminal shown in a pane is the pane's size, and Claude Code and agy draw their bottom rows with
// relative moves: replayed at the size the stream reaches, these real screens read wrong both ways
// (GitHub #36). main knows the PTY's size, and submit reads each screen at it.
describe('submitToTerminal at the PTY\'s own size', () => {
  const screens = Object.entries(wide.screens)
  const agent = (name: string): string => (name.startsWith('claude') ? 'Claude (Build)' : name.startsWith('codex') ? 'Codex (Docs)' : 'Gemini (Docs)')

  it.each(screens.filter(([, s]) => s.truth === 'idle'))('types into %s on its first ready read', async (name, s) => {
    const t = fakeTerminal(() => s.raw, agent(name), { cols: s.cols, rows: s.rows })
    await submitToTerminal(t.handlers, 't1', 'Reply with the single word YES.', t.clock)
    expect(t.writes[0]).toBe('Reply with the single word YES.')
    expect(t.times[0]).toBe(1000)
    expect(t.handlers.terminalSize).toHaveBeenCalledWith('t1')
  })

  it('types nothing into a Codex still loading at 120x30, which the size its output reaches read as idle', async () => {
    const s = wide.screens['codex-120x30-model-loading']
    const t = fakeTerminal(() => s.raw, 'Codex (Docs)', { cols: s.cols, rows: s.rows })
    const res = await submitToTerminal(t.handlers, 't1', 'Reply with the single word YES.', t.clock)
    expect(res.submitted).toBe(false)
    expect(res.error).toMatch(/not ready for input after 180 s \(working/)
    expect(t.writes).toEqual([])
  })

  it('reports Codex\'s update menu at 160x40 at once, which the size its output reaches read as starting', async () => {
    const s = wide.screens['codex-160x40-update-menu']
    const t = fakeTerminal(() => s.raw, 'Codex (Docs)', { cols: s.cols, rows: s.rows })
    expect(await submitToTerminal(t.handlers, 't1', 'task', t.clock)).toMatchObject({
      submitted: false,
      waitedMs: 0,
      error: 'The agent is blocked: waiting on a menu: Codex offers to update itself.',
      screen: expect.stringContaining('3. Skip until next version'),
    })
  })

  it('reads at the size the output reaches when main has no size for the terminal', async () => {
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : idle(typed.join(''))))
    ;(t.handlers as { terminalSize?: () => null }).terminalSize = () => null
    expect(await submitToTerminal(t.handlers, 't1', 'go', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
  })
})

// A prompt that made the box taller than the bottom rows read as never shown: submit typed the task
// and pressed no Enter, and the screen then read as thinking, so sending it again waited 3 minutes
// for nothing (GitHub #36). Real windows, read at the PTY's size, from the moment the text showed.
describe('submitToTerminal with a long prompt', () => {
  it.each([
    ['codex-80x24-long-prompt-shown', 'Codex (Docs)', fixtures.codex.ready],
    ['claude-80x24-long-prompt-shown', 'Claude (Build)', fixtures.claude.doneIdle],
    ['claude-160x40-tall-prompt-shown', 'Claude (Build)', wide.screens['claude-160x40-idle-after-turn'].raw],
  ] as const)('presses Enter once %s shows the text', async (name, agent, before) => {
    const s = long.screens[name]
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : typed.length ? s.raw : before), agent, { cols: s.cols, rows: s.rows })
    expect(await submitToTerminal(t.handlers, 't1', s.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([s.text, '\r'])
  })

  it('presses only Enter for a prompt with a blank line in it that is still in the input', async () => {
    // Sent again, it went in after the copy still there, and Claude got the prompt twice in one.
    const s = long.screens['claude-80x24-paragraphs-stuck']
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : s.raw), 'Claude (Build)', { cols: s.cols, rows: s.rows })
    expect(await submitToTerminal(t.handlers, 't1', s.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
  })

  it("presses only Enter for one still in Codex's composer, which has no rule under it", async () => {
    const text = 'Write the docs.\n\nKeep them short. Task ID: t-1'
    const stuck = frame(['>_ OpenAI Codex', '', '› Write the docs.', '', '  Keep them short. Task ID: t-1', '', '  gpt-5.6-sol medium · ~/p'])
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : stuck), 'Codex (Docs)')
    expect(await submitToTerminal(t.handlers, 't1', text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
  })

  it('clears one that only starts the text in the box before it types the text, and sends only that', async () => {
    const stuck = frame(['Claude Code', '', RULE, '❯ Write the docs.', '', '  Then the tests.', RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
    const t = fakeTerminal((_ms, typed) => {
      if (typed.includes('\r')) return busy()
      if (typed.some((w) => w !== CLEAR)) return idle('Write the docs.')
      return typed.length ? idle() : stuck
    })
    expect(await submitToTerminal(t.handlers, 't1', 'Write the docs.', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, 'Write the docs.', '\r'])
  })

  // R2-3: still in the box from a call before, a prompt longer than the bottom rows was typed again.
  it.each([['claude-80x24-long-prompt-shown'], ['claude-160x40-tall-prompt-shown']] as const)('presses only Enter for %s, still in the box', async (name) => {
    const s = long.screens[name]
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : s.raw), 'Claude (Build)', { cols: s.cols, rows: s.rows })
    expect(await submitToTerminal(t.handlers, 't1', s.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
  })
})

// The real screens of tests/fixtures/agentScreensInput.json: a task whose first line is "1. ...",
// and tasks taller than the box, as Claude Code, Codex and agy drew them at the size they were
// drawn. Submit read what was typed by the box's rows: it typed each, pressed no Enter, and sent
// again it typed a second copy behind the first or waited 3 minutes (GitHub #36, R2-1 and R2-2).
// It reads the box empty and the agent at work now, at any size. Before the task is typed: an empty
// box at the same size; after the Enter: the agent at work.
describe('submitToTerminal with a task the box shows only part of, or that starts "1. "', () => {
  const NAMES: Record<string, string> = { claude: 'Claude (Build)', codex: 'Codex (Docs)', agy: 'Gemini (Docs)' }
  function emptyBox(agent: string, cols: number): string {
    const rule = '─'.repeat(cols)
    if (agent === 'codex') return frame(['>_ OpenAI Codex', '', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~\\p'])
    if (agent === 'agy') return frame(['Antigravity CLI', '', rule, '>', rule, '? for shortcuts'])
    return frame(['Claude Code', '', rule, '❯ Try "fix lint errors"', rule, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
  }
  const working = (cols: number): string => frame(['Claude Code', '✢ Doing…', '─'.repeat(cols), '❯ ', '─'.repeat(cols), '  esc to interrupt'], '◐ Claude Code')
  const shots = Object.entries(input.screens).filter(([name]) => !name.endsWith('-paste-stuck'))

  it.each(shots)('presses Enter once %s shows the task', async (_name, s) => {
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? working(s.cols) : typed.length ? s.raw : emptyBox(s.agent, s.cols)), NAMES[s.agent], { cols: s.cols, rows: s.rows })
    expect(await submitToTerminal(t.handlers, 't1', s.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([s.text, '\r'])
  })

  it.each(shots)('presses only Enter when %s still holds the task from a call before', async (_name, s) => {
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? working(s.cols) : s.raw), NAMES[s.agent], { cols: s.cols, rows: s.rows })
    expect(await submitToTerminal(t.handlers, 't1', s.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
  })

  it("presses only Enter for a long paste still in Codex's composer: its placeholder gives the text's length", async () => {
    const s = input.screens['codex-80x24-paste-stuck']
    expect(screenOf(s.raw, s).lines().join('\n')).toContain(`› [Pasted Content ${s.text.length} chars]`)
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? working(s.cols) : s.raw), 'Codex (Docs)', s)
    expect(await submitToTerminal(t.handlers, 't1', s.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
  })

  /** Codex's composer holding `held` until Ctrl+U clears it, then `typed` once the text is typed. */
  const composerOf = (held: string, typed: string, rows: string[] = []) => (_ms: number, w: string[]) => {
    const composer = (pastes: string) => frame(['>_ OpenAI Codex', '', ...rows, `› ${pastes || 'Ask Codex to do anything'}`, '', '  gpt-5.6-sol medium · ~\\p'])
    if (w.includes('\r')) return working(80)
    if (w.some((x) => x !== CLEAR)) return composer(typed)
    return composer(w.length ? '' : held)
  }

  it("clears Codex's placeholder for a paste of another length, which is another text, before it types the task", async () => {
    const s = input.screens['codex-80x24-paste-stuck']
    const other = 'w'.repeat(2000)
    // Typed behind the first, Codex shows the second paste after it, and Enter would send both.
    const t = fakeTerminal(composerOf('[Pasted Content 1246 chars]', '[Pasted Content 2000 chars]'), 'Codex (Docs)', s)
    expect(await submitToTerminal(t.handlers, 't1', other, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, other, '\r'])
  })

  // A live run that typed the paste twice left Codex's composer at "[Pasted Content 1246 chars]
  // [Pasted Content 1246 chars] #2" (codex.exe numbers a second paste of a length). Enter alone sent
  // both, and typed a third time, so did Enter after it.
  it("clears two copies of a paste in Codex's composer before it types it once", async () => {
    const s = input.screens['codex-80x24-paste-stuck']
    const t = fakeTerminal(composerOf('[Pasted Content 1246 chars][Pasted Content 1246 chars] #2', '[Pasted Content 1246 chars]', ['■ Conversation interrupted', '']), 'Codex (Docs)', { cols: 120, rows: 24 })
    expect(await submitToTerminal(t.handlers, 't1', s.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, s.text, '\r'])
  })

  // Codex counts the code points it kept, and the ones it may drop are only symbols: a letter in any
  // script is kept. Allowed to drop letters too, a paste of 1,150 read as this one of 1,200, a hundred
  // of them CJK, and only Enter was pressed: Codex sent the other paste.
  it("clears Codex's placeholder for a paste shorter by letters it never drops before it types this one", async () => {
    const text = `${'w'.repeat(1100)}${'中'.repeat(100)}`
    expect([...text]).toHaveLength(1200)
    const t = fakeTerminal(composerOf('[Pasted Content 1150 chars]', '[Pasted Content 1200 chars]'), 'Codex (Docs)', { cols: 80, rows: 24 })
    expect(await submitToTerminal(t.handlers, 't1', text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, text, '\r'])
  })

  // agy keeps its box short: at 80x12 a task of short lines shows only its last six, 54 letters and
  // digits. Looked for by more of its end than that, the task never showed, and was never sent.
  it('presses Enter on a task of short lines whose last six are all agy shows of it at 80x12', async () => {
    const ready = typed.screens['agy-80x12-tall16-ready']
    const shown = typed.screens['agy-80x12-tall16-shown']
    const box = screenOf(shown.raw, shown).lines().join('\n')
    expect(box).toContain('↑ 10 more lines')
    expect(box).not.toContain('10. no tools')
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? working(80) : w.length ? shown.raw : ready.raw), 'Gemini (Docs)', shown)
    expect(await submitToTerminal(t.handlers, 't1', shown.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([shown.text, '\r'])
  })

  it("presses only Enter for Codex's numbered placeholder of the paste, alone in its composer", async () => {
    const s = input.screens['codex-80x24-paste-stuck']
    const one = `${s.raw}${E}[22;1H${E}[2K› [Pasted Content 1246 chars] #2`
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? working(s.cols) : one), 'Codex (Docs)', s)
    expect(await submitToTerminal(t.handlers, 't1', s.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
  })

  it("clears Claude Code's placeholder for a long paste, which could be any text, and types the paste again", async () => {
    // The real screens of a live run: the first write of the keys showed nothing for two seconds,
    // the second cleared the box, and the paste typed again showed as a placeholder of its own.
    const at = (moment: string) => cleared.screens[`claude-80x24-paste-${moment}` as 'claude-80x24-paste-held']
    const text = at('typed').text!
    expect(at('held').text).toBe(text)
    const t = fakeTerminal((ms, w, times) => {
      if (w.includes('\r')) return working(80)
      if (w.some((x) => x !== CLEAR)) return at('typed').raw
      return w.length >= 2 || (w.length && ms >= times[0] + 2000) ? at('cleared').raw : at('held').raw
    }, 'Claude (Build)', { cols: 80, rows: 24 })
    expect(await submitToTerminal(t.handlers, 't1', text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, text, '\r'])
  })

  it("clears Claude Code's placeholder that a write of the keys shows no change on for longer than it waits, with one more write", async () => {
    const at = (moment: string) => cleared.screens[`claude-80x24-paste-${moment}` as 'claude-80x24-paste-held']
    const text = at('typed').text!
    const t = fakeTerminal((_ms, w) => {
      if (w.includes('\r')) return working(80)
      if (w.some((x) => x !== CLEAR)) return at('typed').raw
      return w.length >= 2 ? at('cleared').raw : at(w.length ? 'cleared-once' : 'held').raw
    }, 'Claude (Build)', { cols: 80, rows: 24 })
    expect(await submitToTerminal(t.handlers, 't1', text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, CLEAR, text, '\r'])
  })

  // A Claude Code just started draws its box, placeholder and all, before it reads keys: the task
  // showed a second or two after it was typed, and an Enter pressed before became a new line in it.
  it('waits out a Claude Code just started, whose box shows its placeholder for seconds after the task is typed', async () => {
    const shown = input.screens['claude-80x24-numbered']
    const t = fakeTerminal((ms, typed, times) => {
      if (typed.includes('\r')) return working(80)
      return typed.length > 0 && ms >= times[0] + 2500 ? shown.raw : fixtures.claude.startupIdle
    }, 'Claude (Build)', { cols: 80, rows: 24 })
    expect(await submitToTerminal(t.handlers, 't1', shown.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([shown.text, '\r'])
    expect(t.times[1] - t.times[0]).toBeGreaterThanOrEqual(2500)
  })

  // swarm-end-to-end's mock worker draws no rule under its box, and what is typed wraps onto the
  // screen's last row at its first column: read as Codex's footer, that row's end of the task was
  // never found, and the task never sent.
  it("reads a box with no rule under it down to the screen's last row: a row right under the text is the text", async () => {
    const text = 'You are in D:\\a\\termpolis\\termpolis. Implement the feature. Task ID: 3f2b8c1e-4d5a-4b7e-9c2f-1a2b3c4d5e6f'
    const rule = '─'.repeat(60)
    const t = fakeTerminal((_ms, typed) => {
      if (typed.includes('\r')) return frame(['Claude Code v1.0.0 (mock)', '', rule, `❯ ${text.slice(0, 78)}`, text.slice(78), '✢ Working… (esc to interrupt)'])
      return frame(['Claude Code v1.0.0 (mock)', '', rule, ...(typed.length ? [`❯ ${text.slice(0, 78)}`, text.slice(78)] : ['❯ '])])
    })
    expect(await submitToTerminal(t.handlers, 't1', text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([text, '\r'])
  })

  it('reports a plain shell whose screen went blank after the Enter, with nothing to tell the command was taken', async () => {
    const banner = ['Windows PowerShell', 'Copyright (C) Microsoft Corporation. All rights reserved.', '', 'Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows', '']
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? `${E}[2J` : frame([...banner, `PS C:\\p> ${typed.join('')}`])), 'Shell')
    const res = await submitToTerminal(t.handlers, 't1', 'cls', t.clock)
    expect(res).toMatchObject({ submitted: false, screen: '' })
    expect(t.writes).toEqual(['cls', '\r'])
  })

  // R2-2: a Codex whose composer held a task naming its menus read as waiting on a menu, and submit
  // refused it every time.
  it("sends a task still in Codex's composer that names Codex's menus: it is no menu", async () => {
    const text = 'Handle Codex\'s "Approaching rate limits" prompt: pick "Keep current model".'
    const stuck = frame(['>_ OpenAI Codex', '', '• Ready.', '', `› ${text}`, '', '  gpt-5.6-sol medium · ~\\p'])
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? working(80) : stuck), 'Codex (Docs)')
    expect(await submitToTerminal(t.handlers, 't1', text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
  })
})

// R3-1: under ConPTY, Codex 0.153.4 and agy 1.4.2 drop the punctuation and the symbols a text is
// typed with (— ✓ → … ’ “ ” €; agy emoji too) and keep its letters and digits. Read by its last 24
// characters, a task ending "DASH — nothing else." never showed: no Enter was pressed, and sent again
// as STEP 5 says, it went in behind the first copy. The real screens of agentScreensTyped.json.
describe('submitToTerminal and the characters an agent drops as they are typed', () => {
  const NAMES = { codex: 'Codex (Docs)', agy: 'Gemini (Docs)' } as const

  it.each(['codex', 'agy'] as const)('presses Enter once %s shows the task without its dash', async (agent) => {
    const ready = typed.screens[`${agent}-80x24-dash-ready`]
    const shown = typed.screens[`${agent}-80x24-dash-shown`]
    expect(screenOf(shown.raw, shown).lines().join('\n')).toContain('Reply with the single word DASH  nothing else.')
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? busy() : w.length ? shown.raw : ready.raw), NAMES[agent], shown)
    expect(await submitToTerminal(t.handlers, 't1', shown.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([shown.text, '\r'])
  })

  it.each(['codex', 'agy'] as const)('presses only Enter when %s still holds it without its dash, from a call before', async (agent) => {
    const shown = typed.screens[`${agent}-80x24-dash-shown`]
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? busy() : shown.raw), NAMES[agent], shown)
    expect(await submitToTerminal(t.handlers, 't1', shown.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
  })

  // A paste of 1,113 code points ending " — ✓ → 😀 done": Codex counts what it kept, 1,110.
  const paste = typed.screens['codex-80x24-paste-dropped']
  const shownAs = (count: number): string => `${paste.raw}${E}[22;1H${E}[2K› [Pasted Content ${count} chars]`

  it.each([
    ['the count Codex showed, without the three it dropped', 1110],
    ['every character kept', 1113],
    ['every character above ASCII dropped that is no letter or digit, the emoji too', 1109],
  ])("presses only Enter for Codex's placeholder of the paste counted with %s", async (_name, count) => {
    expect([...paste.text]).toHaveLength(1113)
    expect(screenOf(paste.raw, paste).lines()[21]).toBe('› [Pasted Content 1110 chars]')
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? busy() : shownAs(count)), 'Codex (Docs)', paste)
    expect(await submitToTerminal(t.handlers, 't1', paste.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
  })

  it.each([
    // Counted in UTF-16 units, the emoji is two: 1,114 is another text's count.
    ['more characters than the text has', 1114],
    ['fewer than it has letters, digits and ASCII', 1108],
  ])("clears Codex's placeholder for one of %s before it types the paste", async (_name, count) => {
    const t = fakeTerminal((_ms, w) => {
      if (w.includes('\r')) return busy()
      if (w.some((x) => x !== CLEAR)) return shownAs(1110)
      return w.length ? `${paste.raw}${E}[22;1H${E}[2K› Ask Codex to do anything` : shownAs(count)
    }, 'Codex (Docs)', paste)
    expect(await submitToTerminal(t.handlers, 't1', paste.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, paste.text, '\r'])
  })

  it('presses no Enter on a text of no letters or digits when the agent then shows no input', async () => {
    // Such a text has no end to look for, so any box read as showing it; and a screen with no box,
    // a panel the agent opened at the key, read so too, and Enter was pressed into that.
    const t = fakeTerminal((_ms, w) => (w.length ? frame(['Claude Code', '', '  ! for bash mode    / for commands    @ for file paths', '  esc to go back']) : idle()))
    const res = await submitToTerminal(t.handlers, 't1', '—', t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/^The agent never showed the text in its input, so Enter was not pressed/) })
    expect(t.writes).toEqual(['—'])
  })

  it("waits for the text, not the hint an empty box shows, though the hint ends the way the text does", async () => {
    // Claude Code's 'Try "fix lint errors"' holds this text's end; read as the text typed, Enter went
    // in before the agent, still starting, had shown it.
    const t = fakeTerminal((ms, w, times) => {
      if (w.includes('\r')) return busy()
      return idle(w.length && ms >= times[0] + 1000 ? 'fix lint errors' : 'Try "fix lint errors"')
    })
    expect(await submitToTerminal(t.handlers, 't1', 'fix lint errors', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.times[1] - t.times[0]).toBeGreaterThanOrEqual(1000)
  })
})

// R3-3: text already in the box, a prompt an earlier call typed and never sent, or one a person
// typed. Read by the text's end alone, another prompt that ended the same got only an Enter, which
// sent the old one, and any other text had this one typed behind it, the two going as one prompt;
// either way the call said submitted. Only a box that shows nothing but this text's end gets Enter
// alone. Anything else in it is cleared before the text is typed; where clearing leaves it as it was,
// no Enter is pressed once the text is typed behind it.
describe('submitToTerminal and a box that already holds other text', () => {
  const A = 'Write the unit tests for src/auth.ts. When you are done, update your task with swarm_update_task.'
  const B = 'Fix the lint errors in src/api.ts. When you are done, update your task with swarm_update_task.'
  /** Claude Code's box rows for `text`, wrapped at 76 columns, the rest indented under the ❯. */
  const boxRows = (text: string): string[] => {
    const rows: string[] = []
    for (let i = 0; i < text.length; i += 76) rows.push(text.slice(i, i + 76))
    return rows.length ? [`❯ ${rows[0]}`, ...rows.slice(1).map((r) => `  ${r}`)] : ['❯ ']
  }
  /** A Claude Code whose box starts out holding `held`, and which sends what it holds on Enter. Its
   *  Ctrl+U deletes back to the line's start, or the line break before it; with `clears` false, nothing. */
  function holding(held: string, clears = true) {
    let box = held
    const sent: string[] = []
    const t = fakeTerminal(() => (sent.length ? busy() : frame(['Claude Code', '', RULE, ...boxRows(box), RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')))
    const write = t.handlers.writeToTerminal
    ;(t.handlers as { writeToTerminal: McpToolHandlers['writeToTerminal'] }).writeToTerminal = (id, text) => {
      write(id, text)
      if (text === '\r') {
        if (box) sent.push(box)
        box = ''
        return
      }
      for (const ch of text) {
        if (ch !== '\u0015') box += ch
        else if (clears) box = box.endsWith('\n') ? box.slice(0, -1) : box.slice(0, box.lastIndexOf('\n') + 1)
      }
    }
    return { ...t, sent }
  }

  it('clears a prompt in the box that ends like this one, and sends only this one', async () => {
    const t = holding(A)
    expect(await submitToTerminal(t.handlers, 't1', B, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, B, '\r'])
    expect(t.sent).toEqual([B])
  })

  it('types a prompt behind one that ends like it, in a box Ctrl+U does not clear, sends neither, and says so', async () => {
    // One row of it, as a hint is, for all the clear can tell: typed over, and in sight in front.
    const one = 'Fix the docs. When you are done, update your task with swarm_update_task.'
    const t = holding(one, false)
    const res = await submitToTerminal(t.handlers, 't1', B, t.clock)
    expect(res).toMatchObject({ submitted: false, error: "The agent's input already held other text, which clearing it didn't remove, and the text went in with it, so Enter was not pressed: the agent would have taken the two as one prompt. Check it with read_output." })
    expect(res.screen).toContain('Fix the docs.')
    expect(t.writes).toEqual([CLEAR, CLEAR, B])
    expect(t.sent).toEqual([])
    // Two rows of it, which no hint takes: nothing typed (N3).
    const u = holding(A, false)
    expect(await submitToTerminal(u.handlers, 't1', B, u.clock)).toMatchObject({ submitted: false, error: "The agent's input held other text, which clearing it didn't remove, so nothing was typed. Check it with read_output." })
    expect(u.writes).toEqual([CLEAR, CLEAR])
    expect(u.sent).toEqual([])
  })

  // The letters and digits are what is compared: read by its letters alone, task-202 was task-101
  // still in the box, only Enter was pressed, and the agent got task-101.
  it('clears a task in the box that differs from this one only in its digits, and sends only this one', async () => {
    const t = holding('Fix the lint errors in src/api.ts. Task ID: task-101')
    expect(await submitToTerminal(t.handlers, 't1', 'Fix the lint errors in src/api.ts. Task ID: task-202', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.sent).toEqual(['Fix the lint errors in src/api.ts. Task ID: task-202'])
  })

  it('clears a box that holds only a little of the end of the text, and sends one copy of it', async () => {
    const t = holding('Task ID: t-1')
    expect(await submitToTerminal(t.handlers, 't1', 'Write the API docs. Task ID: t-1', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, 'Write the API docs. Task ID: t-1', '\r'])
    expect(t.sent).toEqual(['Write the API docs. Task ID: t-1'])
  })

  it('waits for the box to settle before it reads what is in front: agy draws a long paste in pieces', async () => {
    // A look mid-draw can end where the text ends, with the rows above it not drawn yet. Read
    // then, the stuck copy in front of it went unseen. This agy's Ctrl+U deletes nothing.
    const text = 'Write the API docs for every route. Task ID: t-1'
    const stuck = 'Fix the lint errors in src/api.ts first.'
    const agyBox = (rows: string[]) => frame(['Antigravity CLI', '', RULE, ...rows, RULE, '? for shortcuts'])
    const t = fakeTerminal((ms, w, times) => {
      if (w.includes('\r')) return busy()
      const typedAt = w.findIndex((x) => x !== CLEAR)
      if (typedAt < 0) return agyBox([`> ${stuck}`])
      // At first only the new text's last row is drawn; the box's first row follows a look later.
      return ms < times[typedAt] + 500 ? agyBox(['> ', `  ${text}`]) : agyBox([`> ${stuck}`, `  ${text}`])
    }, 'Gemini (Docs)')
    expect(await submitToTerminal(t.handlers, 't1', text, t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/already held other text/) })
    expect(t.writes).toEqual([CLEAR, CLEAR, text])
  })

  it('presses Enter on a long paste only once agy has drawn all of it, though a half-drawn box ends the same', async () => {
    // agy draws a long paste over seconds (1,930 characters in 3.4 s on the live runs). This task's
    // filler ends every sentence the way the task ends, so a box drawn through any sentence ended
    // with the text's last 24 letters, and read then, the box's state was a guess.
    const s = input.screens['agy-50x15-tall']
    const sentences = s.text.split(/(?<=\.) /)
    expect(sentences.filter((x) => x.endsWith('asks for nothing and needs no action.')).length).toBeGreaterThan(3)
    // Its rows as agy wraps them, 76 columns, indented under the >.
    const rows = (text: string): string[] => {
      const out: string[] = []
      for (let i = 0; i < text.length; i += 76) out.push(`${i === 0 ? '>' : ' '} ${text.slice(i, i + 76)}`)
      return out.length ? out : ['>']
    }
    const draw = (n: number) => frame(['Antigravity CLI', '', RULE, ...rows(sentences.slice(0, n).join(' ')), RULE, '? for shortcuts'])
    const t = fakeTerminal((ms, typed, times) => {
      if (typed.includes('\r')) return busy()
      if (!typed.length) return draw(0)
      // A sentence more every 250 ms, its last row the end of one each time.
      return draw(Math.min(sentences.length, 1 + Math.floor((ms - times[0]) / 250)))
    }, 'Gemini (Docs)', { cols: 80, rows: 24 })
    expect(await submitToTerminal(t.handlers, 't1', s.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    // All of it drawn at (sentences - 1) quarter seconds, the same again a look later, then the pause.
    expect(t.times[1] - t.times[0]).toBeGreaterThanOrEqual((sentences.length - 1) * 250 + 250)
  })

  it('presses only Enter for its own text, the box showing nothing else', async () => {
    const t = holding(B)
    expect(await submitToTerminal(t.handlers, 't1', B, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
    expect(t.sent).toEqual([B])
  })

  it('types nothing behind an old prompt of many lines that Ctrl+U does not clear, which the task would push out of sight', async () => {
    // At 80x17: an old prompt of ten lines. Typed behind its last, the task's seven took the box past
    // the screen's top, the old prompt's first line with it; with more lines, the whole old prompt.
    const old = Array.from({ length: 10 }, (_, i) => `Old line ${i + 1}.`)
    const text = ['Fix the lint errors.', ...Array.from({ length: 6 }, (_, i) => `${i + 2}. no tools`)].join('\n')
    const ready = frame(['Claude Code', '', RULE, `❯ ${old[0]}`, ...old.slice(1).map((r) => `  ${r}`), RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? busy() : ready), 'Claude (Build)', { cols: 80, rows: 17 })
    const res = await submitToTerminal(t.handlers, 't1', text, t.clock)
    expect(res).toMatchObject({ submitted: false, error: "The agent's input held other text, which clearing it didn't remove, so nothing was typed. Check it with read_output." })
    expect(res.screen).toContain('Old line 10.')
    expect(t.writes).toEqual([CLEAR, CLEAR])
  })

  // R4-2: a task taller than what the box shows, typed behind a prompt left there. agy shows "↑ N more
  // lines" over the task's end, and Claude Code's box grows past the screen's top: what was in front
  // went out of sight with the task's start, and an Enter sent the two as one prompt. The prompt is
  // cleared first, and the task's end is then all there is in front of nothing.
  const emptyOf = { 'Gemini (Docs)': cleared.screens['agy-80x24-cleared'].raw, 'Claude (Build)': frame(['Claude Code', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code') }
  it.each([
    ['agy', 'agy-80x24-held-ready', 'agy-80x24-held-long', 'Gemini (Docs)'],
    ['Claude Code', 'claude-80x17-held-ready', 'claude-80x17-held-tall', 'Claude (Build)'],
  ] as const)("clears the prompt left in %s's box before a task taller than the box, which then shows only the task's end", async (_agent, readyName, typedName, name) => {
    const ready = held.screens[readyName]
    const after = held.screens[typedName]
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? busy() : w.some((x) => x !== CLEAR) ? after.raw : w.length ? emptyOf[name] : ready.raw), name, ready)
    // What was left there, and the task's start, are out of sight once the task is typed.
    const rows = screenOf(after.raw, after).lines().join('\n')
    expect(rows).not.toContain(after.text.split('\n')[0].slice(0, 30))
    expect(screenOf(ready.raw, ready).lines().join('\n')).toContain('ALPHA')
    expect(await submitToTerminal(t.handlers, 't1', after.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, after.text, '\r'])
  })

  it("presses Enter on a paste typed again over Claude Code's own placeholder for it that Ctrl+U left there: it expands into one copy", async () => {
    // Claude Code's footer says so: "paste again to expand". The copy is taller than the screen.
    const ready = held.screens['claude-80x24-pasted-ready']
    const after = held.screens['claude-80x24-pasted-again']
    expect(screenOf(ready.raw, ready).lines().join('\n')).toContain('paste again to expand')
    expect(after.text).toBe(ready.text)
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? busy() : w.some((x) => x !== CLEAR) ? after.raw : ready.raw), 'Claude (Build)', ready)
    expect(await submitToTerminal(t.handlers, 't1', after.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, CLEAR, after.text, '\r'])
  })

  /** Claude Code at 80x17 with `rows` in its box, the rule and the footer under it: all the box shows. */
  const tallBox = (rows: string[]) => frame([...rows.slice(-15).map((r) => `  ${r}`), RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
  const rowsOf = (text: string) => Array.from({ length: Math.ceil(text.length / 76) }, (_, i) => text.slice(i * 76, i * 76 + 76))

  it('clears a prompt left there before a tall task that repeats its own start further on, and sends the task alone', async () => {
    const text = Array.from({ length: 40 }, () => 'Write the docs for every route now. ').join('')
    const t = holding('Fix the lint errors first.')
    expect(await submitToTerminal(t.handlers, 't1', text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, text, '\r'])
    expect(t.sent).toEqual([text])
  })

  it("clears something typed in front of Claude Code's placeholder before it types the paste again", async () => {
    const paste = held.screens['claude-80x24-pasted-ready'].text
    const ready = frame(['Claude Code', '', RULE, '❯ Fix it first. [Pasted text #1 +30 lines]', RULE, '  paste again to expand'], '✳ Claude Code')
    const t = fakeTerminal((_ms, w) => {
      if (w.includes('\r')) return busy()
      if (w.some((x) => x !== CLEAR)) return tallBox(paste.split('\n'))
      return w.length ? frame(['Claude Code', '', RULE, '❯ ', RULE, '  paste again to expand'], '✳ Claude Code') : ready
    }, 'Claude (Build)', { cols: 80, rows: 17 })
    expect(await submitToTerminal(t.handlers, 't1', paste, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, paste, '\r'])
  })

  it("presses no Enter on another paste typed behind Claude Code's placeholder that Ctrl+U left there: it adds a placeholder of its own", async () => {
    const ready = held.screens['claude-80x24-pasted-other-ready']
    const after = held.screens['claude-80x24-pasted-other']
    expect(after.text).not.toBe(ready.text)
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? busy() : w.some((x) => x !== CLEAR) ? after.raw : ready.raw), 'Claude (Build)', ready)
    expect(await submitToTerminal(t.handlers, 't1', after.text, t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/already held other text/) })
    expect(t.writes).toEqual([CLEAR, CLEAR, after.text])
  })

  it("clears Claude Code's placeholder for another paste on the real screens, then types the task and sends it alone", async () => {
    const at = (moment: string) => cleared.screens[`claude-80x24-pasteother-${moment}` as 'claude-80x24-pasteother-held']
    const text = at('typed').text!
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? busy() : w.some((x) => x !== CLEAR) ? at('typed').raw : w.length ? at('cleared').raw : at('held').raw), 'Claude (Build)', { cols: 80, rows: 24 })
    expect(screenOf(at('held').raw, { cols: 80, rows: 24 }).lines().join('\n')).toContain('[Pasted text #3 +30 lines]')
    expect(await submitToTerminal(t.handlers, 't1', text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, text, '\r'])
  })
})

// The review of fix/swarm154 (S0-1, S0-2, W0-1): refused behind what the box held, the task could
// never be sent. The conductor was told to clear the input with Ctrl+U, which no conductor model can
// send through write_to_terminal (Haiku spelled it out, Sonnet and Opus sent nothing), and sent
// again, the box showing only the task's end read as the task typed before: Enter alone sent the two
// as one prompt. Submit clears the box itself now, with the keys every agent deletes a line with.
describe('submitToTerminal and a box it clears before it types', () => {
  const ALPHA = 'Reply with the single word ALPHA. Do not run any tools for this, please.'
  const tall = (word: string, lines = 20) => [`Reply with the single word ${word} and nothing else.`, ...Array.from({ length: lines - 1 }, (_, i) => `${i + 2}. no tools`)].join('\n')
  /** An agent at 80x17 whose box starts out holding `held`, kept the way the agents keep it: a key
   *  goes in at the cursor, `back` characters from the end to start with; Ctrl+U deletes back from
   *  the cursor to the start of the line (a paste's placeholder with it), or the line break before a
   *  line's start; Enter sends what the box holds, the agent works for 2 s, then is back at its box
   *  with its answer above. `glyph` and `draw` are the agent's: Claude Code's ❯, or agy's >, whose
   *  box shows the last eight rows under "↑ N more lines". `hint` is what the box shows empty. With
   *  `swallows`, an Enter empties the box and the agent does nothing with what it held. */
  function agentHolding(held: string, opts: { agent?: 'claude' | 'agy'; hint?: string; keysPerWrite?: number; swallows?: boolean; back?: number } = {}) {
    const agent = opts.agent ?? 'claude'
    let box = held
    let cursor = held.length - (opts.back ?? 0)
    const sent: string[] = []
    let sentAt = -Infinity
    const rows = (): string[] => {
      const glyph = agent === 'agy' ? '>' : '❯'
      if (box === '') return [`${glyph} ${opts.hint ?? ''}`]
      const out: string[] = []
      for (const line of box.split('\n')) for (let i = 0; i === 0 || i < line.length; i += 76) out.push(`${out.length === 0 ? glyph : ' '} ${line.slice(i, i + 76)}`)
      if (agent === 'agy' && out.length > 8) return [`> ↑ ${out.length - 8} more lines`, ...out.slice(-8)]
      return out
    }
    const answers = () => sent.map((_, i) => `● Done ${i + 1}.`)
    const t = fakeTerminal((ms) => {
      if (ms < sentAt + 2000) return busy()
      if (agent === 'agy') return frame(['Antigravity CLI', ...answers(), '', RULE, ...rows(), RULE, '? for shortcuts'].slice(-17))
      return frame(['Claude Code', ...answers(), '', RULE, ...rows(), RULE, '  ⏵⏵ bypass permissions on'].slice(-17), '✳ Claude Code')
    }, agent === 'agy' ? 'Gemini (Docs)' : 'Claude (Build)', { cols: 80, rows: 17 })
    const write = t.handlers.writeToTerminal
    ;(t.handlers as { writeToTerminal: McpToolHandlers['writeToTerminal'] }).writeToTerminal = (id, text) => {
      write(id, text)
      if (text === '\r') {
        if (box && !opts.swallows) {
          sent.push(box)
          sentAt = t.clock.now()
        }
        box = ''
        cursor = 0
        return
      }
      let keys = 0
      for (const ch of text) {
        if (ch !== '\u0015') {
          box = box.slice(0, cursor) + ch + box.slice(cursor)
          cursor++
        } else if (keys++ < (opts.keysPerWrite ?? Infinity)) {
          const start = cursor === 0 ? 0 : box[cursor - 1] === '\n' ? cursor - 1 : box.lastIndexOf('\n', cursor - 1) + 1
          box = box.slice(0, start) + box.slice(cursor)
          cursor = start
        }
      }
    }
    return { ...t, sent, box: () => box }
  }

  it('clears a prompt left in the box, twenty Ctrl+U to a write, and sends a task taller than the box alone', async () => {
    const t = agentHolding(ALPHA)
    const task = tall('TALL')
    expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, task, '\r'])
    expect(t.sent).toEqual([task])
  })

  it('never sends what was in the box with the task, though the conductor sends the task again', async () => {
    // As STEP 5 said after a refusal: the same text again. The box then showed only the task's end,
    // read as the task typed before, and Enter alone sent the prompt in front with it.
    const t = agentHolding(ALPHA)
    const task = tall('TALL')
    await submitToTerminal(t.handlers, 't1', task, t.clock)
    await submitToTerminal(t.handlers, 't1', task, t.clock)
    expect(t.sent.length).toBeGreaterThan(0)
    expect(t.sent.filter((p) => p !== task)).toEqual([])
  })

  it('waits for the box to settle after the keys: a look mid-redraw that shows it empty is no clear', async () => {
    // The box held two lines; redrawn after the keys, one look caught it empty before the line the
    // keys left was drawn again. Typed then, the task went in behind that line.
    const t = fakeTerminal((ms, w, times) => {
      if (w.includes('\r')) return busy()
      const keys = w.filter((x) => x === CLEAR).length
      if (w.some((x) => x !== CLEAR)) return idle(keys >= 2 ? 'Write the docs. Task ID: t-1' : `Fix the lint errors first.Write the docs. Task ID: t-1`)
      if (keys === 0) return frame(['Claude Code', '', RULE, '❯ Fix the lint errors first.', '  Then run the tests.', RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
      if (keys === 1) return idle(ms < times[0] + 300 ? '' : 'Fix the lint errors first.')
      return idle()
    })
    expect(await submitToTerminal(t.handlers, 't1', 'Write the docs. Task ID: t-1', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, CLEAR, 'Write the docs. Task ID: t-1', '\r'])
  })

  it('clears a box of many lines with as many writes as it takes, looking after each', async () => {
    // Two Ctrl+U a line, a line's text and the line break before it: 40 lines take four writes.
    const t = agentHolding(tall('OLD', 40))
    const task = 'Write the docs. Task ID: t-1'
    expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, CLEAR, CLEAR, CLEAR, task, '\r'])
    expect(t.sent).toEqual([task])
  })

  it("clears Claude Code's placeholder for another paste before it types: the two went as one prompt (S0-3)", async () => {
    const t = agentHolding('[Pasted text #1 +30 lines]')
    const task = tall('OTHER', 26)
    expect(task.length).toBeLessThan(800)
    expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toMatchObject({ submitted: true })
    expect(t.sent).toEqual([task])
  })

  it("clears agy's placeholder for a paste before it types: it is no Claude Code's (W0-4)", async () => {
    const t = agentHolding('[Pasted text #1 +20 lines]', { agent: 'agy' })
    const task = tall('OMEGA')
    expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toMatchObject({ submitted: true })
    expect(t.writes[0]).toBe(CLEAR)
    expect(t.sent).toEqual([task])
  })

  it('clears a box that holds the end of the text and no more than a few of its letters, and types the text', async () => {
    // 18 letters and digits of its end: too few to be this text's (SUBMIT_END_CHARS). Read as the
    // text typed before, only Enter was pressed, and the agent got what the box held.
    const t = agentHolding('the API docs. Task ID: t-1')
    const task = 'Write the API docs. Task ID: t-1'
    expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toMatchObject({ submitted: true })
    expect(t.sent).toEqual([task])
  })

  it('presses only Enter for its own text still in the box from a call before, clearing nothing', async () => {
    const task = tall('TALL')
    const t = agentHolding(task)
    expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
    expect(t.sent).toEqual([task])
  })

  it('types a task over what no Ctrl+U deletes, a hint the box shows, once two writes in a row left it as it was', async () => {
    // A box that reads as holding something, though it holds nothing: the first key typed replaces it.
    for (const task of ['Write the docs. Task ID: t-1', tall('TALL')]) {
      const t = agentHolding('', { hint: 'run the tests again' })
      expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toMatchObject({ submitted: true })
      expect(t.writes).toEqual([CLEAR, CLEAR, task, '\r'])
      expect(t.sent).toEqual([task])
    }
  })

  it('types nothing into a box that never settles after the keys, though some looks catch it empty', async () => {
    // Drawn again every look, now empty, now holding a line: no look says it was cleared.
    const t = fakeTerminal((ms, w) => (w.length && Math.floor(ms / 250) % 2 === 0 ? idle() : idle('Then run the tests.')), 'Claude (Build)')
    const res = await submitToTerminal(t.handlers, 't1', 'Write the docs. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/held more than one call clears, so nothing was typed/) })
    expect(t.writes.every((w) => w === CLEAR)).toBe(true)
  })

  it('reads what an Enter did against the box as it was cleared, not as it held what was there', async () => {
    // The box held a prompt taller than the screen, over the transcript; cleared, the transcript
    // shows. An Enter that only emptied the box left nothing new above it: no prompt taken, though
    // the screen above the box differs from the one before the clear.
    const t = agentHolding(tall('OLD', 20), { swallows: true })
    const res = await submitToTerminal(t.handlers, 't1', 'Write the docs. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/neither started working nor went back to its prompt with the text taken/) })
    expect(t.writes).toEqual([CLEAR, CLEAR, 'Write the docs. Task ID: t-1', '\r'])
  })

  it('types nothing when the box holds more than one call clears, and clears the rest when it is sent again', async () => {
    // A box that a write deletes only a line of: still changing after the last write the call sends.
    const t = agentHolding(tall('OLD', 14), { keysPerWrite: 1 })
    const task = tall('TALL')
    const first = await submitToTerminal(t.handlers, 't1', task, t.clock)
    expect(first).toMatchObject({ submitted: false, error: expect.stringMatching(/^The agent's input held more than one call clears, so nothing was typed\. Send the text again/) })
    expect(t.writes.every((w) => w === CLEAR)).toBe(true)
    expect(t.sent).toEqual([])
    let res = first
    for (let tries = 0; tries < 5 && !res.submitted; tries++) res = await submitToTerminal(t.handlers, 't1', task, t.clock)
    expect(res).toMatchObject({ submitted: true })
    expect(t.sent).toEqual([task])
  })

  const SCREENS = cleared.screens as Record<string, { agent: string; cols: number; rows: number; text?: string; raw: string }>
  it.each(['claude', 'claude-full', 'agy', 'codex'])('clears the prompt %s holds on the real screens, then types the task into its empty box and sends it', async (agent) => {
    const at = (moment: string) => SCREENS[`${agent}-80x24-${moment}`]
    const task = at('cleared-tall').text!
    const t = fakeTerminal((_ms, w) => {
      if (w.includes('\r')) return busy()
      // The box empties only for the keys: typed into without them, it shows nothing new.
      if (w[0] !== CLEAR) return at('held').raw
      return w.includes(task) ? at('cleared-tall').raw : at('cleared').raw
    }, { claude: 'Claude (Build)', 'claude-full': 'Claude (Build)', agy: 'Gemini (Docs)', codex: 'Codex (Docs)' }[agent], { cols: 80, rows: 24 })
    expect(screenOf(at('held').raw, { cols: 80, rows: 24 }).lines().join('\n')).toContain('ALPHA')
    expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, task, '\r'])
  })

  it('types nothing when the agent leaves its input while the box is cleared', async () => {
    // A dialog it opened, a limit, an exit, work it started (a key it read as Enter): no box to type
    // into, the box under a busy line none either, and nothing typed.
    for (const [after, error] of [
      [frame(['PS C:\\p> ']), /^The agent's input held other text, and the agent stopped showing its input while it was cleared, so nothing was typed\./],
      [input.rateLimitMenu.raw, /^The agent is blocked: usage limit reached\./],
      [busy(), /^The agent's input held other text, and the agent stopped showing its input while it was cleared, so nothing was typed\./],
    ] as const) {
      const t = fakeTerminal((_ms, w) => (w.length ? after : idle(ALPHA)), 'Claude (Build)', { cols: 80, rows: 24 })
      const res = await submitToTerminal(t.handlers, 't1', 'Write the docs. Task ID: t-1', t.clock)
      expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(error) })
      expect(t.writes).toEqual([CLEAR])
    }
  })

  it('types nothing when the agent exits while the box is cleared, though its last frame shows its box, emptied', async () => {
    // Its shell's prompt is reported under the frame: the agent run_command started is gone, and the
    // box it left is no input of an agent's.
    const REPORT = `${E}]9;9;C:\\p\x07`
    let out = `${REPORT}PS C:\\p> `
    let now = 0
    const writes: string[] = []
    const handlers = {
      listTerminals: () => [],
      runCommand: (_id: string, command: string) => { out += `${command}\r\n` },
      readOutput: () => out,
      outputOffset: () => out.length,
      terminalSize: () => ({ cols: 80, rows: 24 }),
      writeToTerminal: (_id: string, text: string) => {
        writes.push(text)
        if (text === CLEAR) out += `${idle()}${E}[7;1HResume this session with: claude --resume 1234${E}[8;1H${REPORT}PS C:\\p> `
      },
      closeTerminal: vi.fn(),
    } as unknown as McpToolHandlers
    const clock: SubmitClock = { now: () => now, sleep: async (ms) => { now += ms } }
    await executeTool('run_command', { terminalId: 'exits-1', command: 'claude --dangerously-skip-permissions' }, handlers)
    out += idle(ALPHA)
    const res = await submitToTerminal(handlers, 'exits-1', 'Write the docs. Task ID: t-1', clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/^The agent's input held other text, and the agent stopped showing its input while it was cleared, so nothing was typed\./) })
    expect(res.screen).toContain('Resume this session with')
    expect(writes).toEqual([CLEAR])
  })

  it('sends a box of as many lines as ten writes clear, and types nothing into one that holds more, after ten', async () => {
    // Two Ctrl+U a line: a hundred lines take ten writes, all one call sends; a hundred and one, one more.
    const t = agentHolding(tall('OLD', 100))
    const task = 'Write the docs. Task ID: t-1'
    expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toMatchObject({ submitted: true })
    expect(t.writes).toEqual([...Array.from({ length: 10 }, () => CLEAR), task, '\r'])
    expect(t.sent).toEqual([task])
    const u = agentHolding(tall('OLD', 101))
    expect(await submitToTerminal(u.handlers, 't1', task, u.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/^The agent's input held more than one call clears, so nothing was typed/) })
    expect(u.writes).toEqual(Array.from({ length: 10 }, () => CLEAR))
    expect(u.box()).toBe('Reply with the single word OLD and nothing else.')
  })

  it('presses only Enter for a call with no text, though the box holds something: what the conductor typed there', async () => {
    // An Enter alone is how a conductor sends what it typed without submit. Cleared first, it was lost.
    const t = agentHolding(ALPHA)
    expect(await submitToTerminal(t.handlers, 't1', '', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
    expect(t.sent).toEqual([ALPHA])
  })

  it('types nothing for a call abandoned while the box is cleared, nor into a terminal closed meanwhile', async () => {
    const abandoned = new AbortController()
    const a = fakeTerminal((_ms, w) => (w.length ? idle() : idle(ALPHA)))
    const write = a.handlers.writeToTerminal
    ;(a.handlers as { writeToTerminal: McpToolHandlers['writeToTerminal'] }).writeToTerminal = (id, text) => {
      write(id, text)
      abandoned.abort()
    }
    expect(await submitToTerminal(a.handlers, 't1', 'Write the docs. Task ID: t-1', a.clock, abandoned.signal)).toMatchObject({ submitted: false, error: 'The call was abandoned before the text was typed.' })
    expect(a.writes).toEqual([CLEAR])
    // Abandoned between two writes of the keys: no more of them.
    const between = new AbortController()
    const b = fakeTerminal((_ms, w) => idle(w.length ? 'run the tests again' : ALPHA))
    const writeB = b.handlers.writeToTerminal
    ;(b.handlers as { writeToTerminal: McpToolHandlers['writeToTerminal'] }).writeToTerminal = (id, text) => {
      writeB(id, text)
      if (b.writes.length === 2) between.abort()
    }
    expect(await submitToTerminal(b.handlers, 't1', 'Write the docs. Task ID: t-1', b.clock, between.signal)).toMatchObject({ submitted: false, error: 'The call was abandoned before the text was typed.' })
    expect(b.writes).toEqual([CLEAR, CLEAR])
    const c = fakeTerminal((_ms, w) => (w.length ? '' : idle(ALPHA)))
    expect(await submitToTerminal(c.handlers, 't1', 'Write the docs. Task ID: t-1', c.clock)).toMatchObject({ submitted: false, error: 'Terminal t1 was closed.' })
    expect(c.writes).toEqual([CLEAR])
  })

  // N1, W1-1: a person moved the cursor back into what the box held. Ctrl+U deletes only back from
  // the cursor, so what was behind it stays, the next two writes change nothing, and the task is
  // typed in front of it. Only what was in front of the task was looked for: Enter was pressed, and
  // the agent got the two as one prompt.
  const HELD_BEHIND = /^The agent's input already held other text, which clearing it didn't remove, and the text went in with it, so Enter was not pressed/
  const CURSOR = cursorScreens.screens as Record<string, { agent: string; cols: number; rows: number; text: string; raw: string }>
  it.each([
    ['claude', 'cursor'],
    ['claude', 'cursortall'],
    ['agy', 'cursor'],
    ['agy', 'cursortall'],
    ['codex', 'cursor'],
    ['codex', 'cursortall'],
  ])('presses no Enter on a task typed in front of what %s kept behind the cursor, on the real screens (%s)', async (agent, step) => {
    const at = (moment: string) => CURSOR[`${agent}-80x24-${step}-${moment}`]
    const task = at('typed').text
    // The box after a write is what the first left: the next two change nothing.
    const t = fakeTerminal((_ms, w) => {
      if (w.includes('\r')) return busy()
      if (w.includes(task)) return at('typed').raw
      return w.length ? at('cleared').raw : at('held').raw
    }, { claude: 'Claude (Build)', agy: 'Gemini (Docs)', codex: 'Codex (Docs)' }[agent], { cols: 80, rows: 24 })
    expect(screenOf(at('cleared').raw, { cols: 80, rows: 24 }).lines().join('\n')).toContain('. Do not run any tools for this, please.')
    const res = await submitToTerminal(t.handlers, 't1', task, t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(HELD_BEHIND) })
    expect(res.screen).toContain('Do not run any tools for')
    expect(t.writes).toEqual([CLEAR, CLEAR, CLEAR, task])
  })

  it('presses no Enter on a task typed in front of what was behind the cursor, wherever in the held line it was', async () => {
    for (const back of [10, ALPHA.length]) {
      const t = agentHolding(ALPHA, { back })
      const task = 'Reply with the single word CURSOR.'
      expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(HELD_BEHIND) })
      expect(t.sent).toEqual([])
      expect(t.box()).toBe(`${task}${ALPHA.slice(-back)}`)
    }
  })

  it('presses no Enter on a task typed in front of what was behind the cursor, though that ends the way the task does', async () => {
    // A conductor ends every task the same way, so what Ctrl+U left can end with this task's end.
    const ending = ' When you are done, update your task with swarm_update_task.'
    const t = agentHolding(`Write the unit tests for src/auth.ts.${ending}`, { back: ending.length })
    const task = `Fix the lint errors in src/api.ts.${ending}`
    expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(HELD_BEHIND) })
    expect(t.sent).toEqual([])
    expect(t.box()).toBe(`${task}${ending}`)
  })

  it("presses no Enter on a task the agent shows as its placeholder for a paste, with what was behind the cursor after it", async () => {
    // A paste Claude Code collapses: the text's end never shows, only what Ctrl+U left, behind it.
    const left = '. Do not run any tools for this, please.'
    const task = tall('TALL', 30)
    const t = fakeTerminal((_ms, w) => {
      if (w.includes('\r')) return busy()
      if (w.includes(task)) return idle(`[Pasted text #1 +29 lines]${left}`)
      return idle(w.length ? left : ALPHA)
    }, 'Claude (Build)', { cols: 80, rows: 24 })
    expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(HELD_BEHIND) })
    expect(t.writes).toEqual([CLEAR, CLEAR, CLEAR, task])
  })

  // N3: "two writes left it as it was" was read off the rows in sight. A text taller than the screen
  // whose rows look alike (log lines, a list) looks the same after a write deleted ten lines of it,
  // and was typed behind as a hint: with a task taller than the box, what was left is out of sight
  // in front of it, and the two went as one prompt. A hint is one row.
  const CLEARED_NOTHING = /^The agent's input held other text, which clearing it didn't remove, so nothing was typed\. Check it with read_output\.$/
  it('types nothing into a box of rows that look the same after each write: a text taller than the screen they shortened', async () => {
    const t = agentHolding(Array.from({ length: 60 }, () => 'no tools').join('\n'))
    const res = await submitToTerminal(t.handlers, 't1', tall('TALL'), t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(CLEARED_NOTHING) })
    expect(res.screen).toContain('no tools')
    expect(t.writes).toEqual([CLEAR, CLEAR])
    expect(t.sent).toEqual([])
  })

  it("types over one row Ctrl+U doesn't delete in Codex's composer, though the composer has a blank row under it", async () => {
    const codex = (inBox: string) => frame(['>_ OpenAI Codex (v0.153.4)', '', `› ${inBox}`, '', '  gpt-5.6-sol medium · ~\\p'])
    const t = fakeTerminal((_ms, w) => {
      if (w.includes('\r')) return busy()
      const typed = w.filter((x) => x !== CLEAR).join('')
      return codex(typed || 'Summarize the recent commits')
    }, 'Codex (Docs)', { cols: 80, rows: 24 })
    expect(await submitToTerminal(t.handlers, 't1', 'Write the docs. Task ID: t-1', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, CLEAR, 'Write the docs. Task ID: t-1', '\r'])
  })

  it('types nothing into a box whose lines behind the cursor no write deletes, a person having moved it up into them', async () => {
    // Ctrl+U deletes the cursor's line back to its start, the line breaks and lines before: the lines
    // after it stay, on more than one row.
    const held = 'Fix the lint errors first.\nThen run the tests.\nThen write the docs.'
    const t = agentHolding(held, { back: 'run the tests.\nThen write the docs.'.length })
    const res = await submitToTerminal(t.handlers, 't1', 'Write the API docs. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(CLEARED_NOTHING) })
    expect(t.writes).toEqual([CLEAR, CLEAR, CLEAR])
    expect(t.box()).toBe('run the tests.\nThen write the docs.')
  })

  it('still sends a task alone that clearing let go in front of nothing: a hint the text replaced, or the text the box held', async () => {
    // What is behind the text's end is looked at only in a box clearing left something in: here the
    // hint, gone at the first key, and a paste Claude Code collapsed, with nothing after it.
    const task = tall('TALL', 30)
    const t = fakeTerminal((_ms, w) => {
      if (w.includes('\r')) return busy()
      if (w.includes(task)) return idle('[Pasted text #1 +29 lines]')
      return idle('run the tests again')
    }, 'Claude (Build)', { cols: 80, rows: 24 })
    expect(await submitToTerminal(t.handlers, 't1', task, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([CLEAR, CLEAR, task, '\r'])
  })
})

// R3-4: an agent that exited, or never started, leaves its terminal at its shell's prompt, which read
// as ready for the task: it was typed there and Enter pressed, PowerShell ran it as a command, and
// the conductor was told it was sent.
describe('write_to_terminal submit into a terminal whose agent is gone', () => {
  const banner = ['Windows PowerShell', 'Copyright (C) Microsoft Corporation. All rights reserved.', '']
  /** A PowerShell terminal: what is typed at its prompt runs when Enter is pressed. The agent that
   *  `run_command` starts exits at once when `exits`, and draws its input box otherwise. */
  function shellTerminal(exits: boolean) {
    const lines = [...banner]
    let line = ''
    let agentUp = false
    const ran: string[] = []
    const writes: string[] = []
    const handlers = {
      listTerminals: () => [],
      runCommand: vi.fn((_id: string, command: string) => {
        lines.push(`PS C:\\p> ${command}`)
        if (/^claude\b/.test(command) && exits) lines.push('Invalid API key · Please run /login')
        else if (/^claude\b/.test(command)) agentUp = true
        else lines.push('ok')
      }),
      readOutput: () => (agentUp ? (line.endsWith('\r') ? busy() : idle(line)) : frame([...lines, `PS C:\\p> ${line}`])),
      writeToTerminal: (_id: string, text: string) => {
        writes.push(text)
        if (agentUp) line += text
        else if (text === '\r') {
          ran.push(line)
          lines.push(`PS C:\\p> ${line}`, `${line.split(' ')[0]} : The term '${line.split(' ')[0]}' is not recognized as the name of a cmdlet`)
          line = ''
        } else line += text
      },
      closeTerminal: vi.fn(),
    } as unknown as McpToolHandlers
    return { handlers, ran, writes }
  }
  async function submit(handlers: McpToolHandlers, terminalId: string, text: string) {
    vi.useFakeTimers()
    try {
      const pending = executeTool('write_to_terminal', { terminalId, text, submit: true }, handlers)
      await vi.advanceTimersByTimeAsync(20_000)
      return (await pending) as { submitted: boolean; error?: string; screen?: string }
    } finally {
      vi.useRealTimers()
    }
  }

  it('types nothing at the shell prompt of a terminal that run_command started an agent in', async () => {
    const t = shellTerminal(true)
    await executeTool('run_command', { terminalId: 'gone-1', command: 'claude --dangerously-skip-permissions' }, t.handlers)
    const res = await submit(t.handlers, 'gone-1', 'You are working in C:\\p. Run npm test and fix what fails. Task ID: t-1')
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/^The terminal is at its shell's prompt, not at the agent's input, so nothing was typed/) })
    expect(res.screen).toContain('Invalid API key')
    expect(t.writes).toEqual([])
    expect(t.ran).toEqual([])
  })

  // R4-1: Claude Code and agy leave their last frame, box and all, on screen when they exit, with the
  // shell's prompt under it. That box read as the agent's: the task was typed at the prompt, and the
  // next run_command went onto the same line, so the agent never started again.
  it.each([
    ['PowerShell', `${E}]9;9;C:\\p\x07`, 'PS C:\\p> '],
    ['bash', `${E}]7;file://host/home/u/p\x07`, 'u@host:~/p$ '],
  ])("types nothing under the last frame of an agent that exited to %s's prompt", async (_shell, report, prompt) => {
    let raw = `${report}${prompt}`
    const writes: string[] = []
    const handlers = {
      listTerminals: () => [],
      runCommand: vi.fn((_id: string, command: string) => { raw += `${command}\r\n${idle()}` }),
      readOutput: () => raw,
      writeToTerminal: (_id: string, text: string) => { writes.push(text); raw += text },
      closeTerminal: vi.fn(),
    } as unknown as McpToolHandlers
    await executeTool('run_command', { terminalId: 'exit-1', command: 'claude --dangerously-skip-permissions' }, handlers)
    raw += `${E}[7;1HResume this session with: claude --resume 1234${E}[8;1H${report}${prompt}`

    const res = await submit(handlers, 'exit-1', 'You are working in C:\\p. Run npm test and fix what fails. Task ID: t-1')
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/^The terminal is at its shell's prompt, not at the agent's input, so nothing was typed/) })
    expect(writes).toEqual([])
  })

  it('still types into an agent drawn after the prompt it was started from', async () => {
    let line = ''
    const writes: string[] = []
    const handlers = {
      listTerminals: () => [],
      runCommand: vi.fn(),
      readOutput: () => `${E}]9;9;C:\\p\x07PS C:\\p> claude --dangerously-skip-permissions\r\n` + (line.endsWith('\r') ? busy() : idle(line)),
      writeToTerminal: (_id: string, text: string) => { writes.push(text); line += text },
      closeTerminal: vi.fn(),
    } as unknown as McpToolHandlers
    await executeTool('run_command', { terminalId: 'up-2', command: 'claude --dangerously-skip-permissions' }, handlers)
    expect(await submit(handlers, 'up-2', 'Write the docs. Task ID: t-1')).toEqual({ submitted: true, waitedMs: 1000 })
    expect(writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
  })

  // An agent prints an OSC 7501 query of its own as it starts, which is no prompt report: read as
  // one, the agent's screen before it went missing, and a live agent was refused.
  it("still types into an agent whose output carries its own OSC 7501 after its box", async () => {
    let line = ''
    const writes: string[] = []
    const handlers = {
      listTerminals: () => [],
      runCommand: vi.fn(),
      readOutput: () => `${E}]9;9;C:\\p\x07PS C:\\p> claude --dangerously-skip-permissions\r\n` + (line.endsWith('\r') ? busy() : idle(line)) + `${E}]7501;?\x07${E}[?25h`,
      writeToTerminal: (_id: string, text: string) => { writes.push(text); line += text },
      closeTerminal: vi.fn(),
    } as unknown as McpToolHandlers
    await executeTool('run_command', { terminalId: 'up-3', command: 'claude --dangerously-skip-permissions' }, handlers)
    expect(await submit(handlers, 'up-3', 'Write the docs. Task ID: t-1')).toEqual({ submitted: true, waitedMs: 1000 })
    expect(writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
  })

  it('still types into a plain shell that reports its folder at each prompt', async () => {
    const report = `${E}]9;9;C:\\p\x07`
    // A command run before: a banner and a bare prompt alone read as a shell still starting.
    const lines = [...banner, 'PS C:\\p> dir', 'ok']
    let line = ''
    const writes: string[] = []
    const handlers = {
      listTerminals: () => [],
      runCommand: vi.fn(),
      readOutput: () => report + frame([...lines, `PS C:\\p> ${line}`]),
      writeToTerminal: (_id: string, text: string) => {
        writes.push(text)
        if (text === '\r') {
          lines.push(`PS C:\\p> ${line}`, 'hi')
          line = ''
        } else line += text
      },
      closeTerminal: vi.fn(),
    } as unknown as McpToolHandlers
    expect((await submit(handlers, 'plain-1', 'echo hi')).submitted).toBe(true)
    expect(writes).toEqual(['echo hi', '\r'])
  })

  it('types into the agent once run_command has it up', async () => {
    const t = shellTerminal(false)
    await executeTool('run_command', { terminalId: 'up-1', command: 'claude --dangerously-skip-permissions' }, t.handlers)
    expect(await submit(t.handlers, 'up-1', 'Write the docs. Task ID: t-1')).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
  })

  it('still types into a shell whose last command was no agent, and into one closed and gone', async () => {
    const t = shellTerminal(true)
    await executeTool('run_command', { terminalId: 'sh-1', command: 'claude --dangerously-skip-permissions' }, t.handlers)
    await executeTool('run_command', { terminalId: 'sh-1', command: 'dir' }, t.handlers)
    expect((await submit(t.handlers, 'sh-1', 'echo hi')).submitted).toBe(true)
    expect(t.ran).toEqual(['echo hi'])

    const u = shellTerminal(true)
    await executeTool('run_command', { terminalId: 'sh-2', command: 'codex -a never -s workspace-write' }, u.handlers)
    await executeTool('close_terminal', { terminalId: 'sh-2' }, u.handlers)
    expect((await submit(u.handlers, 'sh-2', 'echo hi')).submitted).toBe(true)
    expect(u.ran).toEqual(['echo hi'])
  })
})

// The output since run_command started the agent, from where main says the command was typed
// (outputOffset): an agent exited only once its shell printed a prompt after that, and its input is
// one drawn after that. Read off the whole screen, the last frame an exited agent leaves, box and
// all, read as its input: right after run_command started it again, submit refused as if it had
// exited (the conductor then typed the command into the agent starting), and after a resize, whose
// repaint draws that frame after the prompt, typed the task at the shell's prompt.
describe('write_to_terminal submit and the output since run_command started the agent', () => {
  const REPORT = `${E}]9;9;C:\\p\x07`
  const PROMPT = `${REPORT}PS C:\\p> `
  const CLAUDE = 'claude --dangerously-skip-permissions'
  const box = (inBox = '') => idle(inBox)
  /** The last frame Claude Code leaves when it exits, and its shell's prompt under it. */
  const exited = (prompt = PROMPT) => `${box()}${E}[7;1HResume this session with: claude --resume 1234${E}[8;1H${prompt}`
  /** A terminal as main keeps it: what it printed (the last `window` characters of it), whose end
   *  outputOffset reports. run_command's command is echoed at once (`echo`), as at a prompt; `at`
   *  prints more at a moment of the submit's clock, and `agentAt` starts drawing an agent then, which
   *  shows what is typed, empties its box on Ctrl+U and works on Enter. */
  function terminal(size = { cols: 80, rows: 24 }, echo = true, window = Infinity) {
    let now = 0
    let out = ''
    let agent = false
    let inBox = ''
    const later: { at: number; text: string; agent: boolean }[] = []
    const writes: string[] = []
    const times: number[] = []
    const sync = () => {
      later.sort((a, b) => a.at - b.at)
      while (later.length > 0 && later[0].at <= now) {
        const next = later.shift()!
        out += next.text
        if (next.agent) agent = true
      }
    }
    const handlers = {
      listTerminals: () => [],
      runCommand: vi.fn((_id: string, command: string) => { if (echo) out += `${command}\r\n` }),
      readOutput: () => { sync(); return Number.isFinite(window) ? out.slice(-window) : out },
      outputOffset: () => { sync(); return out.length },
      terminalSize: () => size,
      writeToTerminal: (_id: string, text: string) => {
        writes.push(text)
        times.push(now)
        if (!agent) out += text // at the shell's prompt: echoed there
        else if (text === '\r') out += busy()
        else out += box((inBox = text === CLEAR ? '' : inBox + text))
      },
      closeTerminal: vi.fn(),
    } as unknown as McpToolHandlers
    const clock: SubmitClock = { now: () => now, sleep: async (ms) => { now += ms } }
    return {
      handlers, clock, writes, times,
      print: (text: string) => { out += text },
      at: (ms: number, text: string) => { later.push({ at: ms, text, agent: false }) },
      agentAt: (ms: number, frame = box()) => { later.push({ at: ms, text: frame, agent: true }) },
    }
  }
  const run = (t: { handlers: McpToolHandlers }, terminalId: string, command = CLAUDE) => executeTool('run_command', { terminalId, command }, t.handlers)

  it('waits for an agent run_command starts again to draw its input, and types into that, not the frame the old one left', async () => {
    const t = terminal()
    t.print(PROMPT)
    await run(t, 'again-1')
    t.print(exited())
    await run(t, 'again-1')
    // Claude Code draws its box 2.5 s later; until then the old one sits above the echoed command.
    t.agentAt(2500)
    const res = await submitToTerminal(t.handlers, 'again-1', 'Write the docs. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: true })
    expect(t.writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
    expect(t.times[0]).toBeGreaterThanOrEqual(2500)
  })

  it('types nothing at the prompt an agent exited to, though a resize painted its last frame again after it', async () => {
    const t = terminal({ cols: 100, rows: 30 })
    t.print(PROMPT)
    await run(t, 'resized-1')
    t.print(exited())
    // ConPTY on a resize: the new size, then the whole screen painted again, the old box and all.
    const rows = ['Claude Code', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on', 'Resume this session with: claude --resume 1234', 'PS C:\\p> ']
    t.print(`${E}[?25l${E}[8;30;100t${E}[H${rows.map((r) => `${r}${E}[K`).join('\r\n')}${E}[?25h`)
    expect(screenOf(`${PROMPT}${exited()}`).lines().join('\n')).toContain('❯')
    const res = await submitToTerminal(t.handlers, 'resized-1', 'Run npm test and fix what fails. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/^The terminal is at its shell's prompt, not at the agent's input, so nothing was typed/) })
    expect(t.writes).toEqual([])
  })

  it('types nothing at the prompt an agent exited to, though a resize that shrank the screen painted its frame again with no size reported', async () => {
    // ConPTY reports the new size only when the screen grows; a shrink is a repaint from the top left.
    const t = terminal({ cols: 80, rows: 24 })
    t.print(PROMPT)
    await run(t, 'shrunk-1')
    t.print(exited())
    const rows = ['Claude Code', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on', 'Resume this session with: claude --resume 1234', 'PS C:\\p> ']
    t.print(`${E}[?25l${E}[H${rows.map((r) => `${r}${E}[K`).join('\r\n')}${E}[?25h`)
    expect(await submitToTerminal(t.handlers, 'shrunk-1', 'Run npm test. Task ID: t-1', t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/^The terminal is at its shell's prompt/) })
    expect(t.writes).toEqual([])
  })

  it('types nothing at the prompt of an agent that printed more since run_command than main keeps', async () => {
    // The mark, and the prompts the shell printed before it, are gone from the window: what is left is
    // all the agent's, and the prompt it exited to is no shell's first.
    const t = terminal({ cols: 80, rows: 24 }, true, 32_768)
    t.print(PROMPT)
    await run(t, 'long-1')
    t.print(Array.from({ length: 450 }, (_, i) => `● Step ${i}: read docs/file-${i}.md and wrote a line about it, nothing more.\r\n`).join(''))
    t.print(exited())
    const res = await submitToTerminal(t.handlers, 'long-1', 'Run npm test. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/^The terminal is at its shell's prompt/) })
    expect(t.writes).toEqual([])
  })

  it('reports a menu an agent opens with at once, though it has drawn no input yet', async () => {
    // Codex's update offer, drawn after run_command: a stop, which waiting doesn't end.
    const s = wide.screens['codex-160x40-update-menu']
    const t = terminal({ cols: s.cols, rows: s.rows })
    t.print(PROMPT)
    await run(t, 'menu-1', 'codex -a never -s workspace-write -c check_for_update_on_startup=false')
    t.print(s.raw)
    expect(await submitToTerminal(t.handlers, 'menu-1', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: false, waitedMs: 0, error: expect.stringMatching(/^The agent is blocked: /) })
    expect(t.writes).toEqual([])
  })

  it('waits for an agent started again, not stopped by the limit the old one hit, which is still on the screen', async () => {
    const t = terminal()
    t.print(PROMPT)
    await run(t, 'limit-1')
    t.print(frame(['Claude Code', '❯ Build the page', "  ⎿  You've hit your session limit · resets 3pm", '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code'))
    t.print(`${E}[9;1HResume this session with: claude --resume 1234${E}[10;1H${PROMPT}`)
    await run(t, 'limit-1')
    t.agentAt(2500)
    const res = await submitToTerminal(t.handlers, 'limit-1', 'Write the docs. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: true })
    expect(t.times[0]).toBeGreaterThanOrEqual(2500)
  })

  it('types nothing into an agent started again that exited at once, its old frame still on the screen', async () => {
    const t = terminal()
    t.print(PROMPT)
    await run(t, 'again-2')
    t.print(exited())
    await run(t, 'again-2')
    t.print(`Invalid API key · Please run /login\r\n${PROMPT}`)
    const res = await submitToTerminal(t.handlers, 'again-2', 'Write the docs. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/^The terminal is at its shell's prompt/) })
    expect(res.waitedMs).toBe(1000)
    expect(t.writes).toEqual([])
  })

  // create_terminal and run_command a moment apart: a cold Windows PowerShell takes seconds to print
  // its first prompt, so the command is typed before it, and the shell prints that prompt after the
  // command, then runs it. That prompt is no agent gone, though nothing on the screen is an agent yet.
  // What a profile can print first: past 100 characters, a bare prompt reads as a shell at rest.
  const slowProfile = 'posh-git, PSReadLine and Terminal-Icons are ready. Good morning!\r\nLast sign-in: Saturday 17 October 2026, on this PC.\r\n'
  const longPrompt = 'PS C:\\Users\\TermpolisUserx\\repos\\portal> '
  it.each([
    ['one report', `${slowProfile}${REPORT}${longPrompt}`],
    ['two, a prompt of its own reporting the folder too', `${slowProfile}${REPORT}${E}]9;9;C:\\Users\\TermpolisUserx\\repos\\portal\x07${longPrompt}`],
  ])("waits out a shell that prints its first prompt after run_command typed the agent's command (%s)", async (how, first) => {
    const t = terminal({ cols: 80, rows: 24 }, false)
    await run(t, `early-1-${how.length}`)
    t.at(500, first)
    // The command shows at the prompt 2 s later (PSReadLine's first start), the agent 2 s after that.
    t.at(2500, `${CLAUDE}\r\n`)
    t.agentAt(4500)
    const res = await submitToTerminal(t.handlers, `early-1-${how.length}`, 'Write the docs. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: true })
    expect(t.times[0]).toBeGreaterThanOrEqual(4500)
  })

  it('types nothing into an agent that exited at once after the shell printed its first prompt late', async () => {
    const t = terminal({ cols: 80, rows: 24 }, false)
    await run(t, 'early-2')
    t.at(500, PROMPT)
    t.at(1000, `${CLAUDE}\r\nclaude : The term 'claude' is not recognized as the name of a cmdlet\r\n${PROMPT}`)
    const res = await submitToTerminal(t.handlers, 'early-2', 'Write the docs. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/^The terminal is at its shell's prompt/) })
    expect(t.writes).toEqual([])
  })

  // Where the shell reports no prompts (zsh, fish, a bash PROMPT_COMMAND of the user's own, the
  // integration off), an input box drawn before run_command started the agent is still not its input.
  it('waits for an agent started again in a shell that reports no prompts, and types into it once it draws', async () => {
    const t = terminal()
    t.print('PS C:\\p> ')
    await run(t, 'quiet-1')
    t.print(exited('PS C:\\p> '))
    await run(t, 'quiet-1')
    t.agentAt(2500)
    const res = await submitToTerminal(t.handlers, 'quiet-1', 'Write the docs. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: true })
    expect(t.times[0]).toBeGreaterThanOrEqual(2500)
  })

  it('says the agent is starting when one started again never draws its input there', async () => {
    const t = terminal()
    t.print('PS C:\\p> ')
    await run(t, 'quiet-2')
    t.print(exited('PS C:\\p> '))
    await run(t, 'quiet-2')
    const res = await submitToTerminal(t.handlers, 'quiet-2', 'Write the docs. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/^The agent was not ready for input after 180 s \(starting: /) })
    expect(t.writes).toEqual([])
  })

  // S7, S13: drawn alone on a blank screen of the size its output reaches, an agent's screen at
  // another size shows no box (idle Claude Code at 160x40 read as nothing), so the agent started
  // never showed its input, or its shell's late first prompt read as one it exited to.
  const boxAtReach = (raw: string) => {
    const rows = screenOf(raw).lines()
    while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
    return inputBoxRow(rows)
  }
  const wideIdle = Object.entries(wide.screens).filter(([, s]) => s.truth === 'idle' && boxAtReach(s.raw) < 0)
  it.each(wideIdle)("types into %s once run_command has it up, reading the output since at the PTY's size", async (name, s) => {
    expect(wideIdle.length).toBeGreaterThanOrEqual(4)
    // Its shell at its prompt when the command was typed, or printing its first prompt after it.
    for (const late of [false, true]) {
      const t = terminal({ cols: s.cols, rows: s.rows }, !late)
      if (!late) t.print(PROMPT)
      await run(t, `wide-${name}-${late}`)
      if (late) t.print(`${PROMPT}${CLAUDE}\r\n`)
      t.print(s.raw)
      await submitToTerminal(t.handlers, `wide-${name}-${late}`, 'Write the docs. Task ID: t-1', t.clock)
      expect({ late, typed: t.writes[0] }).toEqual({ late, typed: 'Write the docs. Task ID: t-1' })
      expect(t.times[0]).toBe(1000)
    }
  })

  it('reads every terminal from its own run_command: a mark is per terminal, and close_terminal forgets it', async () => {
    const t = terminal()
    t.print(PROMPT)
    await run(t, 'own-1')
    t.print(exited())
    await executeTool('close_terminal', { terminalId: 'own-1' }, t.handlers)
    // Gone from the agents, the terminal is a shell again: a command typed at its prompt runs.
    expect((await submitToTerminal(t.handlers, 'own-1', 'echo hi', t.clock)).error).not.toMatch(/shell's prompt/)
  })

  // The review of fix/swarm154 (W0-2, S0-4): a prompt the shell printed after the mark, with nothing
  // after it that draws a box up to a repaint, read as the agent gone. The prompt the command was typed
  // at can come after the mark too, with the command after it: typed while the shell still printed the
  // prompt before, or into a cold shell whose output main has let go of in part. A fullscreen agent
  // paints every frame from the top left, so a live one was refused at its shell's prompt.
  it('types into an agent whose shell printed the prompt the command was typed at after the mark', async () => {
    const t = terminal({ cols: 80, rows: 24 }, false)
    t.print(`${PROMPT}cd C:\\p\r\n`)
    await run(t, 'ahead-1')
    t.print(`${PROMPT}${CLAUDE}\r\n`)
    t.agentAt(0)
    expect(await submitToTerminal(t.handlers, 'ahead-1', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: true })
    expect(t.writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
  })

  it.each(['1049', '1047', '47'])('types into a fullscreen agent a person started again by hand once the one run_command started exited (alternate screen %s)', async (mode) => {
    // No run_command, so no mark and no command to look for: the agent is on the alternate screen it
    // switched to after the prompt it was typed at, which only a program still running keeps. Each
    // of the three ways to switch to it (1049 a terminal's own programs use; 1047 and 47 older ones).
    const t = terminal({ cols: 80, rows: 24 }, true)
    t.print(PROMPT)
    await run(t, `byhand-1-${mode}`)
    t.print(`${E}[?1049h${box()}${E}[?1049l${E}[2;1HResume this session with: claude --resume 1234\r\n${PROMPT}claude\r\n${E}[?${mode}h${E}[2J`)
    t.agentAt(0)
    expect(await submitToTerminal(t.handlers, `byhand-1-${mode}`, 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: true })
    expect(t.writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
  })

  it('types into an agent a person started again by hand, which cleared the screen and drew its box with no repaint from the top left', async () => {
    // "claude" alone, as a person types it, is no command of run_command's; the agent's box drawn after
    // the prompt it was typed at, before any repaint, is: the shell is not at its prompt.
    const t = terminal({ cols: 80, rows: 24 }, true)
    t.print(PROMPT)
    await run(t, 'byhand-3')
    t.print(exited())
    const rows = ['Claude Code', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on']
    t.agentAt(0, `claude\r\n${E}[2J${rows.map((r, i) => `${E}[${i + 1};1H${r}`).join('')}`)
    expect(await submitToTerminal(t.handlers, 'byhand-3', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: true })
    expect(t.writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
  })

  it('types nothing once a fullscreen agent started by hand has left its screen, before its shell prints the prompt', async () => {
    // Back on the main screen, the frame of the agent before it still there: the agent is gone, and
    // what is typed now goes to the shell.
    const t = terminal({ cols: 80, rows: 24 }, true)
    t.print(PROMPT)
    await run(t, 'byhand-2')
    t.print(`${box()}${E}[7;1HResume this session with: claude --resume 1234${E}[8;1H${PROMPT}claude\r\n${E}[?1049h${E}[2J${box()}${E}[?1049l${E}[10;1HResume this session with: claude --resume 5678\r\n`)
    expect(await submitToTerminal(t.handlers, 'byhand-2', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/^The terminal is at its shell's prompt/) })
    expect(t.writes).toEqual([])
  })

  it('types into an agent whose command, typed as given, puts its flags in another order than main would', async () => {
    // A terminal the conductor didn't create gets the command as given (index.ts runCommand).
    const command = 'claude --model haiku --dangerously-skip-permissions'
    const t = terminal({ cols: 80, rows: 24 }, false)
    t.print(`${PROMPT}cd C:\\p\r\n`)
    await run(t, 'asgiven-1', command)
    t.print(`${PROMPT}${command}\r\n`)
    t.agentAt(0)
    expect(await submitToTerminal(t.handlers, 'asgiven-1', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: true })
  })

  it('still types nothing at the prompt a fullscreen agent exited to, though a resize painted the main screen again', async () => {
    const t = terminal({ cols: 80, rows: 24 }, true)
    t.print(PROMPT)
    await run(t, 'fullexit-1')
    t.print(`${E}[?1049h${box()}${E}[?1049l${E}[2;1HResume this session with: claude --resume 1234\r\n${PROMPT}`)
    const rows = [`PS C:\\p> ${CLAUDE}`, 'Resume this session with: claude --resume 1234', 'PS C:\\p> ']
    t.print(`${E}[?25l${E}[H${rows.map((r) => `${r}${E}[K`).join('\r\n')}${E}[?25h`)
    expect(await submitToTerminal(t.handlers, 'fullexit-1', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/^The terminal is at its shell's prompt/) })
    expect(t.writes).toEqual([])
  })

  it('types into an agent whose command the shell showed after the prompt on two rows, wrapped where a space was', async () => {
    // A row drops the space it wraps at, so the command is told by its letters and digits. One main
    // types as given (sanitizeAgentCommand leaves it as it is).
    const dir = 'work-on-the-parser-modules'
    const prompt = `${E}]9;9;C:\\${dir}\x07PS C:\\${dir}> `
    const command = 'claude --dangerously-skip-permissions --model haiku'
    const echo = screenOf(`${prompt}${command}`, { cols: 80, rows: 24 }).lines()
    expect(echo.slice(0, 2)).toEqual([`PS C:\\${dir}> claude --dangerously-skip-permissions --model`, 'haiku'])
    const t = terminal({ cols: 80, rows: 24 }, false)
    t.print(`${prompt}cd C:\\${dir}\r\n`)
    await run(t, 'wrapped-1', command)
    t.print(`${prompt}${command}\r\n`)
    t.agentAt(0)
    expect(await submitToTerminal(t.handlers, 'wrapped-1', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: true })
    expect(t.writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
  })

  it('types into an agent run_command started twice, the second command sitting in its box', async () => {
    // Typed into the agent, not a shell: what the command shows in is its input, which it has drawn
    // since. Only a command on a row under the box is the screen from before the agent started.
    const t = terminal({ cols: 80, rows: 24 }, false)
    t.print(`${PROMPT}${CLAUDE}\r\n`)
    await run(t, 'twice-1')
    t.agentAt(0)
    await run(t, 'twice-1')
    t.print(box(CLAUDE))
    const res = await submitToTerminal(t.handlers, 'twice-1', 'Write the docs. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: true })
    expect(res.waitedMs).toBe(1000)
    expect(t.writes).toEqual([CLEAR, 'Write the docs. Task ID: t-1', '\r'])
  })

  it('types into an agent that left its fullscreen view for the main screen and drew its input there, the prompt it was typed at after the mark', async () => {
    // That prompt, read up to the switch to the agent's screen, shows the command: it is the one the
    // agent was typed at, not one it exited to, whatever the agent's screen did after.
    const t = terminal({ cols: 80, rows: 24 }, false)
    t.print(`${PROMPT}cd C:\\p\r\n`)
    await run(t, 'altleft-1')
    const rows = ['', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on']
    t.print(`${PROMPT}${CLAUDE}\r\n${E}[?1049h${E}[2J${box()}${E}[?1049l`)
    t.agentAt(0, rows.map((r, i) => `${E}[${i + 3};1H${r}`).join(''))
    expect(await submitToTerminal(t.handlers, 'altleft-1', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
  })

  it('types into an agent of a terminal the conductor created, whose command main typed in full, when the prompt came after the mark', async () => {
    // run_command's "claude", rewritten by main (sanitizeAgentCommand): what the shell shows is that.
    const t = terminal({ cols: 80, rows: 24 }, false)
    t.print(`${PROMPT}cd C:\\p\r\n`)
    await run(t, 'rewritten-1', 'claude')
    t.print(`${PROMPT}${CLAUDE}\r\n`)
    t.agentAt(0)
    expect(await submitToTerminal(t.handlers, 'rewritten-1', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: true })
  })

  it.each([
    ['a clear of the screen', `${E}[2J`],
    ['the alternate screen', `${E}[?1049h`],
  ])('types into an agent that wipes the screen with %s before it paints, when the prompt came after the mark', async (_how, wipe) => {
    const t = terminal({ cols: 80, rows: 24 }, false)
    t.print(`${PROMPT}cd C:\\p\r\n`)
    await run(t, `wipe-${wipe.length}`)
    t.print(`${PROMPT}${CLAUDE}\r\n${wipe}${E}[5;1H`)
    t.agentAt(0)
    expect(await submitToTerminal(t.handlers, `wipe-${wipe.length}`, 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: true })
  })

  it('types into a fullscreen agent whose shell printed that prompt after the mark, though it clears the screen before it paints', async () => {
    // As live, Claude Code in its fullscreen view: the alternate screen and a clear come before its
    // first ESC[H, and drawn with them, the command shown after the prompt was wiped.
    const t = terminal({ cols: 80, rows: 24 }, false)
    t.print(`${PROMPT}Start-Sleep -Milliseconds 2500\r\n`)
    await run(t, 'ahead-3')
    t.print(`${PROMPT}${E}[?25l${E}[93mclaude ${E}[90m--dangerously-skip-permissions\r\n${E}[?25h${E}]0;claude\x07${E}[?1049h${E}[2J${E}[?1000h`)
    t.agentAt(0)
    expect(await submitToTerminal(t.handlers, 'ahead-3', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: true })
    expect(t.writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
  })

  it("types into an agent whose cold shell printed its first prompt after the command, once main let go of what came before", async () => {
    const before = `${slowProfile}${PROMPT}${CLAUDE}\r\n`
    // At the first looks the window has let go of the first 20 characters: no telling the prompt
    // was the shell's first.
    const t = terminal({ cols: 80, rows: 24 }, false, before.length + box().length - 20)
    await run(t, 'cold-slid-1')
    t.print(before)
    t.agentAt(0)
    expect(await submitToTerminal(t.handlers, 'cold-slid-1', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: true })
    expect(t.writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
  })

  it('still types nothing at the prompt an agent exited to after it showed its command at the prompt before', async () => {
    // The prompt it exited to has nothing after it: the agent is gone, whatever came before.
    const t = terminal({ cols: 80, rows: 24 }, false)
    t.print(`${PROMPT}cd C:\\p\r\n`)
    await run(t, 'ahead-2')
    t.print(`${PROMPT}${CLAUDE}\r\n${box()}${E}[7;1HResume this session with: claude --resume 1234${E}[8;1H${PROMPT}`)
    expect(await submitToTerminal(t.handlers, 'ahead-2', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/^The terminal is at its shell's prompt/) })
    expect(t.writes).toEqual([])
  })

  it("still types nothing at the prompt of a folder named for the agent, which a command of the agent's name alone can't be told from", async () => {
    // run_command's "claude" alone: its letters are the folder's in the prompt the agent exited to.
    const prompt = `${E}]9;9;C:\\work\\claude\x07PS C:\\work\\claude> `
    const t = terminal({ cols: 80, rows: 24 }, false)
    t.print(`${prompt}cd C:\\work\\claude\r\n`)
    await run(t, 'named-1', 'claude')
    t.print(`${prompt}claude\r\n${box()}${E}[7;1HResume this session with: claude --resume 1234${E}[8;1H${prompt}`)
    expect(await submitToTerminal(t.handlers, 'named-1', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/^The terminal is at its shell's prompt/) })
  })

  it('types nothing at the prompt a Codex exited to, though it drew its box after a prompt reported since run_command', async () => {
    // Codex draws its composer with no repaint from the top left before it: read after the first
    // prompt since the mark, the box it drew there hid the prompt it exited to.
    const CODEX = 'codex -a never -s workspace-write -c check_for_update_on_startup=false'
    const t = terminal({ cols: 80, rows: 24 }, false)
    t.print(`${PROMPT}cd C:\\p\r\n`)
    await run(t, 'codex-two-1', CODEX)
    t.print(`${PROMPT}${CODEX}\r\n>_ OpenAI Codex\r\n\r\n› Ask Codex to do anything\r\n\r\n  gpt-5.6-sol medium · ~\\p\r\n`)
    t.print(`Token usage: total=1200\r\n${PROMPT}`)
    expect(await submitToTerminal(t.handlers, 'codex-two-1', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/^The terminal is at its shell's prompt/) })
    expect(t.writes).toEqual([])
  })

  it('types into an agent started again after the one before printed more than main keeps', async () => {
    const t = terminal({ cols: 80, rows: 24 }, true, 32_768)
    t.print(PROMPT)
    await run(t, 'slid-2')
    t.print(Array.from({ length: 450 }, (_, i) => `● Step ${i}: read docs/file-${i}.md and wrote a line about it, nothing more.\r\n`).join(''))
    t.print(exited())
    await run(t, 'slid-2')
    t.agentAt(2500)
    expect(await submitToTerminal(t.handlers, 'slid-2', 'Write the docs. Task ID: t-1', t.clock)).toMatchObject({ submitted: true })
    expect(t.times[0]).toBeGreaterThanOrEqual(2500)
  })

  // W0-3: a resize while the agent started again loads. ConPTY paints the screen again: the frame the
  // agent before it left, box and all, and under it the prompt with the command typed at it. Read as
  // the new agent's input, the task was typed while it was still loading.
  it("waits for an agent run_command starts again, though a resize painted the old one's frame over the command", async () => {
    const t = terminal({ cols: 80, rows: 24 })
    t.print(PROMPT)
    await run(t, 'repaint-1')
    t.print(exited())
    await run(t, 'repaint-1')
    const rows = ['Claude Code', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on', 'Resume this session with: claude --resume 1234', `PS C:\\p> ${CLAUDE}`]
    t.print(`${E}[?25l${E}[H${rows.map((r) => `${r}${E}[K`).join('\r\n')}${E}[?25h`)
    t.agentAt(2500)
    const res = await submitToTerminal(t.handlers, 'repaint-1', 'Write the docs. Task ID: t-1', t.clock)
    expect(res).toMatchObject({ submitted: true })
    expect(t.times[0]).toBeGreaterThanOrEqual(2500)
  })
})

// R3-2, R3-6 and the conditions no test pinned (R3-7), on real screens and on the layouts they
// stand for.
describe('submitToTerminal and what the screen around the box says', () => {
  it('types into an idle Claude Code whose last answer quotes its busy hint, and sends it', async () => {
    // Read as at work, the call waited 3 minutes and typed nothing.
    const s = typed.screens['claude-80x24-esc-quoted']
    const shown = `${s.raw}${E}[18;1H${E}[2K> Reply with the single word TWO.`
    expect(screenOf(shown, s).lines()[17]).toBe('> Reply with the single word TWO.')
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? busy() : w.length ? shown : s.raw), 'Claude (Build)', s)
    expect(await submitToTerminal(t.handlers, 't1', 'Reply with the single word TWO.', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
  })

  it("presses Enter once a task taller than the screen shows in Claude Code's box under a status line of four rows", async () => {
    const ready = typed.screens['claude-80x17-statusline4-ready']
    const tall = typed.screens['claude-80x17-statusline4-tall']
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? busy() : w.length ? tall.raw : ready.raw), 'Claude (Build)', tall)
    expect(await submitToTerminal(t.handlers, 't1', tall.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([tall.text, '\r'])
  })

  it("returns the screen's last 15 rows with a submit that failed", async () => {
    const rows = [...Array.from({ length: 20 }, (_, i) => `● line ${i}`), RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on']
    const t = fakeTerminal(() => frame(rows, '✳ Claude Code'))
    const res = await submitToTerminal(t.handlers, 't1', 'Write the docs', t.clock)
    expect(res.screen?.split('\n')).toEqual([...rows.slice(9, 21), '❯', ...rows.slice(22)])
  })

  it("reads a box with no rule under it whose task wraps onto three rows, the last of them the task's end", async () => {
    // swarm-end-to-end's mock worker: read as Codex's footer, the last row was dropped, and the end
    // of the task, on it, was never found.
    const text = 'You are in D:\\a\\termpolis\\termpolis. Implement the feature, then write its unit tests, its docs and a changelog entry for it. Task ID: 3f2b8c1e-4d5a-4b7e-9c2f-1a2b3c4d5e6f'
    const r60 = '─'.repeat(60)
    const rows = [`❯ ${text.slice(0, 78)}`, text.slice(78, 158), text.slice(158)]
    expect(text.slice(158).replace(/[^\p{L}\p{N}]/gu, '').length).toBeGreaterThanOrEqual(10)
    const t = fakeTerminal((_ms, w) => {
      if (w.includes('\r')) return frame(['Claude Code v1.0.0 (mock)', '', r60, ...rows, '✢ Working… (esc to interrupt)'])
      return frame(['Claude Code v1.0.0 (mock)', '', r60, ...(w.length ? rows : ['❯ '])])
    })
    expect(await submitToTerminal(t.handlers, 't1', text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
  })
})

describe('write_to_terminal', () => {
  it('stays raw without submit: the text exactly as sent, in one write, at once', async () => {
    const handlers = { writeToTerminal: vi.fn(), readOutput: vi.fn(), listTerminals: vi.fn() } as unknown as McpToolHandlers
    for (const text of ['raw\r', 'two\r\nlines\r', '\x1b[B', '', 'no enter']) {
      expect(await executeTool('write_to_terminal', { terminalId: 't1', text }, handlers)).toEqual({ success: true })
      expect(handlers.writeToTerminal).toHaveBeenLastCalledWith('t1', text)
    }
    expect(handlers.writeToTerminal).toHaveBeenCalledTimes(5)
    expect(handlers.readOutput).not.toHaveBeenCalled()
  })

  it('takes only a real true as submit', async () => {
    const handlers = { writeToTerminal: vi.fn(), readOutput: vi.fn(), listTerminals: vi.fn() } as unknown as McpToolHandlers
    for (const submit of ['true', 1, false, null]) {
      expect(await executeTool('write_to_terminal', { terminalId: 't1', text: 'x\r', submit }, handlers)).toEqual({ success: true })
    }
    expect(handlers.readOutput).not.toHaveBeenCalled()
  })

  it('with submit: true waits and submits, and returns { submitted, waitedMs }', async () => {
    vi.useFakeTimers()
    try {
      let typed = ''
      const handlers = {
        listTerminals: () => [],
        readOutput: () => (typed.endsWith('\r') ? busy() : idle(typed)),
        writeToTerminal: (_id: string, text: string) => { typed += text },
      } as unknown as McpToolHandlers
      const pending = executeTool('write_to_terminal', { terminalId: 't1', text: 'hello\r', submit: true }, handlers)
      await vi.advanceTimersByTimeAsync(5000)
      expect(await pending).toEqual({ submitted: true, waitedMs: 1000 })
      expect(typed).toBe('hello\r')
    } finally {
      vi.useRealTimers()
    }
  })

  it('the dispatch of the tools no other suite calls through executeTool hands each its arguments', async () => {
    // Not write_to_terminal, but the same switch: these arms had no test reaching them.
    const handlers = {
      memoryCorrect: vi.fn().mockReturnValue('corrected'),
      gatewayListTools: vi.fn().mockResolvedValue(['srv/tool']),
      gatewayCall: vi.fn().mockResolvedValue('called'),
      agentExec: vi.fn().mockResolvedValue('ran'),
      savingsReceipt: vi.fn().mockReturnValue('receipt'),
      recallBench: vi.fn().mockResolvedValue('bench'),
    } as unknown as McpToolHandlers
    expect(await executeTool('memory_correct', { id: 'm1', kind: 'amend', reason: 'r', replacement: 'x', extra: 1 }, handlers)).toBe('corrected')
    expect(handlers.memoryCorrect).toHaveBeenCalledWith({ id: 'm1', kind: 'amend', reason: 'r', replacement: 'x' })
    expect(await executeTool('gateway_list_tools', {}, handlers)).toEqual(['srv/tool'])
    expect(await executeTool('gateway_call', { tool: 'srv/tool', arguments: { a: 1 } }, handlers)).toBe('called')
    expect(handlers.gatewayCall).toHaveBeenCalledWith({ tool: 'srv/tool', arguments: { a: 1 } })
    expect(await executeTool('agent_exec', { prompt: 'p', agent: 'codex', model: 'm', cwd: '/c', write: true, timeoutMs: 5 }, handlers)).toBe('ran')
    expect(handlers.agentExec).toHaveBeenCalledWith({ prompt: 'p', agent: 'codex', model: 'm', cwd: '/c', write: true, timeoutMs: 5 })
    expect(await executeTool('savings_receipt', { format: 'json', verify: 'v' }, handlers)).toBe('receipt')
    expect(handlers.savingsReceipt).toHaveBeenCalledWith({ format: 'json', verify: 'v' })
    expect(await executeTool('recall_bench', { project: 'p', limit: 3, save: false }, handlers)).toBe('bench')
    expect(handlers.recallBench).toHaveBeenCalledWith({ project: 'p', limit: 3, save: false })
  })

  it('treats a missing text as empty: an Enter on its own', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const handlers = {
        listTerminals: () => [],
        readOutput: () => (writes.length ? busy() : idle()),
        writeToTerminal: (_id: string, text: string) => { writes.push(text) },
      } as unknown as McpToolHandlers
      const pending = executeTool('write_to_terminal', { terminalId: 't1', submit: true }, handlers)
      await vi.advanceTimersByTimeAsync(5000)
      expect((await pending as { submitted: boolean }).submitted).toBe(true)
      expect(writes).toEqual(['\r'])
    } finally {
      vi.useRealTimers()
    }
  })
})
