import { describe, it, expect, beforeEach } from 'vitest'
import { useTerminalStore, MAX_CONVERSATION_TURNS } from './terminalStore'
import type { ConversationTurn } from '../lib/conversationParser'

const s = () => useTerminalStore.getState()

const addTurn = (terminalId: string, content: string): void =>
  s().addConversationTurn(terminalId, 'T', 'Claude Code', {
    role: 'assistant', content, timestamp: 1, terminalId, terminalName: 'T', agentName: 'Claude Code',
  } satisfies ConversationTurn)

beforeEach(() => {
  useTerminalStore.setState({
    conversations: [],
    terminals: [{ id: 't1' }, { id: 't2' }] as never,
    activeTerminalId: 't1',
    paneTree: null,
  })
})

describe('conversation retention', () => {
  it('drops a closed terminal\'s conversation, leaving the others alone', () => {
    addTurn('t1', 'hello')
    addTurn('t2', 'world')
    expect(s().conversations).toHaveLength(2)

    s().removeTerminal('t1')

    expect(s().conversations.map(c => c.terminalId)).toEqual(['t2'])
    expect(s().conversations[0].turns).toHaveLength(1)
  })

  it('caps turns per conversation at a rolling window that keeps the newest', () => {
    const overflow = MAX_CONVERSATION_TURNS + 50
    for (let i = 0; i < overflow; i++) addTurn('t1', `turn-${i}`)

    const turns = s().conversations[0].turns
    expect(turns).toHaveLength(MAX_CONVERSATION_TURNS)
    expect(turns[turns.length - 1].content).toBe(`turn-${overflow - 1}`)
    expect(turns[0].content).toBe(`turn-${overflow - MAX_CONVERSATION_TURNS}`)
  })

  it('keeps every turn while a conversation is under the cap', () => {
    addTurn('t1', 'a')
    addTurn('t1', 'b')
    expect(s().conversations[0].turns.map(t => t.content)).toEqual(['a', 'b'])
  })

  it('caps each terminal independently rather than across all conversations', () => {
    for (let i = 0; i < MAX_CONVERSATION_TURNS + 10; i++) addTurn('t1', `x-${i}`)
    addTurn('t2', 'only-one')

    expect(s().conversations.find(c => c.terminalId === 't1')!.turns).toHaveLength(MAX_CONVERSATION_TURNS)
    expect(s().conversations.find(c => c.terminalId === 't2')!.turns).toHaveLength(1)
  })

  it('clearConversations still evicts exactly one terminal on demand', () => {
    addTurn('t1', 'a')
    addTurn('t2', 'b')

    s().clearConversations('t1')

    expect(s().conversations.map(c => c.terminalId)).toEqual(['t2'])
  })

  it('removing a terminal with no conversation is a no-op', () => {
    addTurn('t1', 'a')
    s().removeTerminal('nope')
    expect(s().conversations.map(c => c.terminalId)).toEqual(['t1'])
  })
})
