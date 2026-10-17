import { describe, it, expect, vi } from 'vitest'
import { executeTool, submitToTerminal, SUBMIT_READY_TIMEOUT_MS, type McpToolHandlers, type SubmitClock } from '../../src/main/mcpServer'
import fixtures from '../fixtures/agentScreens.json'
import wide from '../fixtures/agentScreensWide.json'

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
    // Shown at the first look, a quarter second in; then a long prompt gets a longer pause before
    // its Enter, at most 2 s.
    expect(t.times[1] - t.times[0]).toBe(250 + 2000)
  })

  it('takes a prompt the agent consumed while staying at its prompt (a slash command, a fast reply)', async () => {
    // It showed the text, and once Enter was pressed its input is empty again.
    const t = fakeTerminal((_ms, typed) => idle(typed.includes('\r') ? '' : typed.join('')))
    const res = await submitToTerminal(t.handlers, 't1', '/compact', t.clock)
    expect(res).toEqual({ submitted: true, waitedMs: 1000 })
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

  it('reports a text the agent never showed, and presses no Enter on it', async () => {
    const t = fakeTerminal(() => idle())
    const res = await submitToTerminal(t.handlers, 't1', 'Write the docs', t.clock)
    expect(res.submitted).toBe(false)
    expect(res.error).toMatch(/never showed the text/)
    expect(t.writes).toEqual(['Write the docs'])
  })

  it('reads a prompt of several lines by its first: one whose Enter never takes is reported', async () => {
    // The box shows the text a line to a row; flattened onto one row, it never matched the first.
    const text = 'Task ID: t-1\nWrite the docs for the API.'
    const t = fakeTerminal((_ms, typed) => frame(['Claude Code', '', RULE, ...(typed.length ? ['❯ Task ID: t-1', '  Write the docs for the API.'] : ['❯ ']), RULE, '  ⏵⏵ bypass permissions on'], '✳ Claude Code'))
    const res = await submitToTerminal(t.handlers, 't1', text, t.clock)
    expect(res.submitted).toBe(false)
    expect(res.error).toMatch(/still in the agent's input after Enter was pressed twice/)
    expect(t.writes).toEqual([text, '\r', '\r'])
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

  it('types a prompt that only starts like the one stuck in the input: the conductor\'s prompts all do', async () => {
    const stuck = 'You are working in C:\\work\\portal. Build the login page. Task ID: t-1'
    const text = 'You are working in C:\\work\\portal. Write the docs. Task ID: t-2'
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : idle(stuck + typed.join(''))))
    expect((await submitToTerminal(t.handlers, 't1', text, t.clock)).submitted).toBe(true)
    expect(t.writes).toEqual([text, '\r'])
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

  it('reads the input by the start of the text, not its first letters: a suggestion that starts the same is none of it', async () => {
    // Codex fills its empty composer with a suggestion once it took the prompt.
    const t = fakeTerminal((_ms, typed) => {
      const text = typed.filter((w) => w !== '\r').join('')
      const rows = typed.includes('\r') ? [`› ${text}`, '', '• Done.', '', '› Write tests for @filename'] : [`› ${text}`]
      return frame(['>_ OpenAI Codex', '', ...rows, '', '  gpt-5.6-sol medium · ~/p'])
    }, 'Codex (Docs)')
    expect(await submitToTerminal(t.handlers, 't1', 'Write the docs', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['Write the docs', '\r'])
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
    expect(t.writes).toEqual([])
  })

  it('stops at once on a blocked agent: a dead CLI doesn\'t get ready by waiting', async () => {
    const t = fakeTerminal(() => frame(['🎉 Update ran successfully! Please restart Codex.', 'PS C:\\p> ']), 'Codex (Docs)')
    const res = await submitToTerminal(t.handlers, 't1', 'task', t.clock)
    expect(res).toEqual({ submitted: false, waitedMs: 0, error: 'The agent is blocked: Codex self-updated — needs restart to resume.' })
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

  it('reads only the input box\'s own row: a short text that is also a word in the footer was still sent', async () => {
    // "on" is in "bypass permissions on" under the box. Once the box is empty, the prompt went.
    const t = fakeTerminal((_ms, typed) => idle(typed.includes('\r') ? '' : typed.join('')))
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

  it('counts a screen that went blank after the Enter as taken', async () => {
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? `${E}[2J` : idle(typed.join(''))))
    expect((await submitToTerminal(t.handlers, 't1', 'go', t.clock)).submitted).toBe(true)
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
    expect(await submitToTerminal(t.handlers, 't1', 'task', t.clock)).toEqual({
      submitted: false,
      waitedMs: 0,
      error: 'The agent is blocked: waiting on a menu: Codex offers to update itself.',
    })
  })

  it('reads at the size the output reaches when main has no size for the terminal', async () => {
    const t = fakeTerminal((_ms, typed) => (typed.includes('\r') ? busy() : idle(typed.join(''))))
    ;(t.handlers as { terminalSize?: () => null }).terminalSize = () => null
    expect(await submitToTerminal(t.handlers, 't1', 'go', t.clock)).toEqual({ submitted: true, waitedMs: 1000 })
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
