// v1.55.0 Task 9: which pane a Claude session's first prompt belongs to, so the header can offer
// that pane a better-fitting model. Hand-started sessions are found by the pane id the memory hook
// read from TERMPOLIS_TERMINAL_ID; sessions Termpolis started by their --session-id.
import { describe, it, expect, beforeEach } from 'vitest'
import { _resetTerminalAccountsForTest, firstPromptTerminal, noteTerminalSession } from '../../src/main/accountsIpc'
import { emitFirstPrompt, onFirstPrompt } from '../../src/main/primerSessionGuard'

const panes = new Set(['t1', 't2'])
const exists = (id: string): boolean => panes.has(id)

describe('firstPromptTerminal', () => {
  beforeEach(() => _resetTerminalAccountsForTest())

  it('hand-started sessions get the chip via the hook prompt: the pane the hook named wins', () => {
    expect(firstPromptTerminal('never-seen', 't2', exists)).toBe('t2')
  })

  it('a session Termpolis started is found by its session id', () => {
    noteTerminalSession('t1', 'sess-a')
    expect(firstPromptTerminal('sess-a', undefined, exists)).toBe('t1')
  })

  it('a named pane that is gone falls back to the session id, and nothing matches nothing', () => {
    noteTerminalSession('t1', 'sess-a')
    expect(firstPromptTerminal('sess-a', 'closed-pane', exists)).toBe('t1')
    expect(firstPromptTerminal('sess-b', 'closed-pane', exists)).toBeUndefined()
    expect(firstPromptTerminal('', undefined, exists)).toBeUndefined()
  })

  it('a session whose pane has closed finds no pane', () => {
    noteTerminalSession('gone', 'sess-c')
    expect(firstPromptTerminal('sess-c', undefined, exists)).toBeUndefined()
  })

  it('the first-prompt event carries the pane the hook named', () => {
    const seen: Array<string | undefined> = []
    const off = onFirstPrompt((_s, _p, _c, terminalId) => { seen.push(terminalId) })
    emitFirstPrompt('s', 'q', undefined, 't1')
    emitFirstPrompt('s2', 'q', undefined)
    off()
    expect(seen).toEqual(['t1', undefined])
  })
})
