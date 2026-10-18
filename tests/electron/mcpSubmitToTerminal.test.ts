import { describe, it, expect, vi } from 'vitest'
import { executeTool, submitToTerminal, SUBMIT_READY_TIMEOUT_MS, type McpToolHandlers, type SubmitClock } from '../../src/main/mcpServer'
import { screenOf } from '../../src/shared/terminalScreen'
import fixtures from '../fixtures/agentScreens.json'
import wide from '../fixtures/agentScreensWide.json'
import long from '../fixtures/longPromptScreens.json'
import input from '../fixtures/agentScreensInput.json'
import typed from '../fixtures/agentScreensTyped.json'

// write_to_terminal with `submit` (GitHub #36 item 4), against a fake terminal: a screen script that
// changes as time passes and as the tool types, and a clock that only moves when the tool sleeps.

const E = '\x1b'
const RULE = '─'.repeat(80)
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

  it('presses no Enter on a prompt typed behind another stuck in the input: the agent would take both as one', async () => {
    const stuck = 'You are working in C:\\work\\portal. Build the login page. Task ID: t-1'
    const text = 'You are working in C:\\work\\portal. Write the docs. Task ID: t-2'
    // The box wraps what it holds onto a second row, indented, as Claude Code's does.
    const box = (inBox: string) => frame(['Claude Code', '', RULE, `❯ ${inBox.slice(0, 78)}`, `  ${inBox.slice(78)}`, RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : box(stuck + typed.join(''))))
    const res = await submitToTerminal(t.handlers, 't1', text, t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/already held other text.*Enter was not pressed/) })
    expect(res.screen).toContain('Build the login page')
    expect(t.writes).toEqual([text])
  })

  it('types a long prompt again when the input shows a paste placeholder: that could be any text', async () => {
    const long = 'y'.repeat(3000)
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : idle('[Pasted text #1 +40 lines]')))
    expect((await submitToTerminal(t.handlers, 't1', long, t.clock)).submitted).toBe(true)
    expect(t.writes).toEqual([long, '\r'])
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

  it('sends a task typed over a suggestion the box showed, which typing replaced', async () => {
    // Claude Code can show a prompt it suggests in its box, gone at the first key: no other text.
    const t = fakeTerminal((_ms, typed) => {
      if (typed.includes('\r')) return busy()
      return idle(typed.length ? typed.join('') : 'run the tests again')
    })
    expect(await submitToTerminal(t.handlers, 't1', 'Write the docs. Task ID: t-1', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['Write the docs. Task ID: t-1', '\r'])
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

  it('types one that only starts the text in the box, and presses no Enter behind what was there', async () => {
    const stuck = frame(['Claude Code', '', RULE, '❯ Write the docs.', '', '  Then the tests.', RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : typed.length ? frame(['Claude Code', '', RULE, '❯ Write the docs.', '', '  Then the tests.Write the docs.', RULE], '✳ Claude Code') : stuck))
    expect(await submitToTerminal(t.handlers, 't1', 'Write the docs.', t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/already held other text/) })
    expect(t.writes).toEqual(['Write the docs.'])
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

  it("types a task over Codex's placeholder for a paste of another length, which is another text, and presses no Enter behind it", async () => {
    const s = input.screens['codex-80x24-paste-stuck']
    const other = 'w'.repeat(2000)
    // Codex shows the second paste behind the first, and Enter would send both.
    const both = `${s.raw}${E}[22;1H${E}[2K› [Pasted Content 1246 chars][Pasted Content 2000 chars]`
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? working(s.cols) : typed.length ? both : s.raw), 'Codex (Docs)', s)
    expect(await submitToTerminal(t.handlers, 't1', other, t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/already held other text/) })
    expect(t.writes).toEqual([other])
  })

  // A live run that typed the paste twice left Codex's composer at "[Pasted Content 1246 chars]
  // [Pasted Content 1246 chars] #2" (codex.exe numbers a second paste of a length). Enter alone sent
  // both, and typed a third time, so did Enter after it.
  it("presses no Enter on a paste typed behind two copies of it in Codex's composer", async () => {
    const s = input.screens['codex-80x24-paste-stuck']
    const composer = (pastes: string) => frame(['>_ OpenAI Codex', '', '■ Conversation interrupted', '', `› ${pastes}`, '', '  gpt-5.6-sol medium · ~\\p'])
    const two = '[Pasted Content 1246 chars][Pasted Content 1246 chars] #2'
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? working(120) : composer(typed.length ? `${two}[Pasted Content 1246 chars] #3` : two)), 'Codex (Docs)', { cols: 120, rows: 24 })
    expect(await submitToTerminal(t.handlers, 't1', s.text, t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/already held other text/) })
    expect(t.writes).toEqual([s.text])
  })

  it("presses only Enter for Codex's numbered placeholder of the paste, alone in its composer", async () => {
    const s = input.screens['codex-80x24-paste-stuck']
    const one = `${s.raw}${E}[22;1H${E}[2K› [Pasted Content 1246 chars] #2`
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? working(s.cols) : one), 'Codex (Docs)', s)
    expect(await submitToTerminal(t.handlers, 't1', s.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['\r'])
  })

  it("types a long paste again over Claude Code's placeholder, which could be any text: Claude Code expands it", async () => {
    // "paste again to expand": the same text pasted over its placeholder shows whole, once.
    const stuck = input.screens['claude-80x24-paste-stuck']
    const expanded = input.screens['claude-80x24-paste-expanded']
    expect(stuck.text).toBe(expanded.text)
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? working(80) : typed.length ? expanded.raw : stuck.raw), 'Claude (Build)', { cols: 80, rows: 24 })
    expect(await submitToTerminal(t.handlers, 't1', stuck.text, t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual([stuck.text, '\r'])
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
  ])("types the paste over Codex's placeholder for one of %s, and presses no Enter behind it", async (_name, count) => {
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? busy() : w.length ? `${shownAs(count)}[Pasted Content 1110 chars]` : shownAs(count)), 'Codex (Docs)', paste)
    expect((await submitToTerminal(t.handlers, 't1', paste.text, t.clock)).submitted).toBe(false)
    expect(t.writes).toEqual([paste.text])
  })
})

// R3-3: text already in the box, a prompt an earlier call typed and never sent, or one a person
// typed. Read by the text's end alone, another prompt that ended the same got only an Enter, which
// sent the old one, and any other text had this one typed behind it, the two going as one prompt;
// either way the call said submitted. Only a box that shows nothing but this text's end gets Enter
// alone, and no Enter is pressed once the text is typed behind something.
describe('submitToTerminal and a box that already holds other text', () => {
  const A = 'Write the unit tests for src/auth.ts. When you are done, update your task with swarm_update_task.'
  const B = 'Fix the lint errors in src/api.ts. When you are done, update your task with swarm_update_task.'
  /** Claude Code's box rows for `text`, wrapped at 76 columns, the rest indented under the ❯. */
  const boxRows = (text: string): string[] => {
    const rows: string[] = []
    for (let i = 0; i < text.length; i += 76) rows.push(text.slice(i, i + 76))
    return rows.length ? [`❯ ${rows[0]}`, ...rows.slice(1).map((r) => `  ${r}`)] : ['❯ ']
  }
  /** A Claude Code whose box starts out holding `held`, and which sends what it holds on Enter. */
  function holding(held: string) {
    let box = held
    const sent: string[] = []
    const t = fakeTerminal(() => (sent.length ? busy() : frame(['Claude Code', '', RULE, ...boxRows(box), RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')))
    const write = t.handlers.writeToTerminal
    ;(t.handlers as { writeToTerminal: McpToolHandlers['writeToTerminal'] }).writeToTerminal = (id, text) => {
      write(id, text)
      if (text !== '\r') box += text
      else if (box) {
        sent.push(box)
        box = ''
      }
    }
    return { ...t, sent }
  }

  it('types a prompt that ends like the one in the box, sends neither, and says so', async () => {
    const t = holding(A)
    const res = await submitToTerminal(t.handlers, 't1', B, t.clock)
    expect(res).toMatchObject({ submitted: false, error: "The agent's input already held other text, and the text went in behind it, so Enter was not pressed: the agent would have taken the two as one prompt. Check it with read_output." })
    expect(res.screen).toContain('Write the unit tests for src/auth.ts.')
    expect(t.writes).toEqual([B])
    expect(t.sent).toEqual([])
  })

  it('types the text when the box holds only a little of its end: no copy of it', async () => {
    const t = holding('Task ID: t-1')
    expect((await submitToTerminal(t.handlers, 't1', 'Write the API docs. Task ID: t-1', t.clock)).submitted).toBe(false)
    expect(t.writes).toEqual(['Write the API docs. Task ID: t-1'])
    expect(t.sent).toEqual([])
  })

  it('waits for the box to settle before it reads what is in front: agy draws a long paste in pieces', async () => {
    // A look mid-draw can end where the text ends, with the rows above it not drawn yet. Read
    // then, the stuck copy in front of it went unseen.
    const text = 'Write the API docs for every route. Task ID: t-1'
    const stuck = 'Fix the lint errors in src/api.ts first.'
    const agyBox = (rows: string[]) => frame(['Antigravity CLI', '', RULE, ...rows, RULE, '? for shortcuts'])
    const t = fakeTerminal((ms, typed, times) => {
      if (typed.includes('\r')) return busy()
      if (!typed.length) return agyBox([`> ${stuck}`])
      // At first only the new text's last row is drawn; the box's first row follows a look later.
      return ms < times[0] + 500 ? agyBox(['> ', `  ${text}`]) : agyBox([`> ${stuck}`, `  ${text}`])
    }, 'Gemini (Docs)')
    expect(await submitToTerminal(t.handlers, 't1', text, t.clock)).toMatchObject({ submitted: false, error: expect.stringMatching(/already held other text/) })
    expect(t.writes).toEqual([text])
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

  it('reads text in front of the task in a box taller than the screen, where only its end is left in sight', async () => {
    // At 80x17: an old prompt of ten lines, the task's seven typed behind its last. The box's top
    // and the old prompt's first line went off the screen.
    const old = Array.from({ length: 10 }, (_, i) => `Old line ${i + 1}.`)
    const lines = ['Fix the lint errors.', ...Array.from({ length: 6 }, (_, i) => `${i + 2}. no tools`)]
    const text = lines.join('\n')
    const ready = frame(['Claude Code', '', RULE, `❯ ${old[0]}`, ...old.slice(1).map((r) => `  ${r}`), RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
    const inBox = [...old.slice(1, 9), `${old[9]}${lines[0]}`, ...lines.slice(1)].map((r) => `  ${r}`)
    const tall = frame([...inBox, RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code')
    const t = fakeTerminal((_ms, w) => (w.includes('\r') ? busy() : w.length ? tall : ready), 'Claude (Build)', { cols: 80, rows: 17 })
    expect(screenOf(tall, { cols: 80, rows: 17 }).lines()).toHaveLength(17)
    const res = await submitToTerminal(t.handlers, 't1', text, t.clock)
    expect(res).toMatchObject({ submitted: false, error: expect.stringMatching(/already held other text/) })
    expect(t.writes).toEqual([text])
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
