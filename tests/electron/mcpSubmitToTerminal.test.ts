import { describe, it, expect, vi } from 'vitest'
import { executeTool, submitToTerminal, SUBMIT_READY_TIMEOUT_MS, type McpToolHandlers, type SubmitClock } from '../../src/main/mcpServer'
import fixtures from '../fixtures/agentScreens.json'

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

/** `screenAt(ms, typed)` says what the terminal shows at a moment, given everything typed so far. */
function fakeTerminal(screenAt: (ms: number, typed: string[]) => string, name = 'Claude (Build)'): FakeTerminal {
  let now = 0
  const writes: string[] = []
  const times: number[] = []
  const handlers = {
    listTerminals: () => [{ id: 't1', name, shellType: 'powershell', cwd: '/p' }],
    readOutput: vi.fn((_id: string, _lines: number) => screenAt(now, writes)),
    writeToTerminal: vi.fn((_id: string, text: string) => {
      writes.push(text)
      times.push(now)
    }),
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
    // A long prompt gets a longer pause before its Enter, at most 2 s.
    expect(t.times[1] - t.times[0]).toBe(2000)
  })

  it('takes a prompt the agent consumed while staying at its prompt (a slash command, a fast reply)', async () => {
    const t = fakeTerminal(() => idle())
    const res = await submitToTerminal(t.handlers, 't1', '/compact', t.clock)
    expect(res).toEqual({ submitted: true, waitedMs: 1000 })
    expect(t.writes).toEqual(['/compact', '\r'])
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
    // Real Codex 0.153.4 output: loading (an Enter would only queue the prompt), then ready.
    const t = fakeTerminal((ms, typed) => {
      if (typed.includes('\r')) return fixtures.codex.queued
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
