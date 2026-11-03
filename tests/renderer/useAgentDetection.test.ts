import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// The conversation parse of an agent terminal runs once per CONVERSATION_PARSE_INTERVAL (10) chunks of output. A pane that
// batches its chunks into passes (1.54.5, plan package P9) tells the hook how many chunks a call stands for, so the
// parse stays "once per ten chunks" however they are batched, and never runs more than once per call.
//
// Counters: how many times the conversation parser ran. NEGATIVE CONTROL in this file: calling once per chunk (the
// default, the 1.54.4 call shape) is exactly one parse per ten calls.

const AGENT = { name: 'Claude Code', icon: 'i', color: '#fff' }

const mocks = vi.hoisted(() => ({
  parseConversation: vi.fn((..._a: unknown[]) => [] as unknown[]),
  detectAgent: vi.fn((..._a: unknown[]) => null as unknown),
  state: { conversations: [] as Array<{ terminalId: string; turns: unknown[] }>, addConversationTurn: vi.fn() },
}))

vi.mock('../../src/renderer/src/lib/conversationParser', () => ({ parseConversation: mocks.parseConversation }))
vi.mock('../../src/renderer/src/lib/agentDetector', () => ({ detectAgent: mocks.detectAgent }))
vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(vi.fn(), { getState: () => mocks.state }),
}))

import { useAgentDetection } from '../../src/renderer/src/hooks/useAgentDetection'

/** A hook whose agent is already detected: the detecting call itself counts as chunk 1 of the conversation count. */
function detected() {
  const hook = renderHook(() => useAgentDetection())
  act(() => { hook.result.current.processAgentDetection('Claude Code banner', 20, 't', 'T') })
  expect(hook.result.current.agentDetectedRef.current).toBe(true)
  mocks.parseConversation.mockClear()
  return hook
}

describe('useAgentDetection: the conversation parse cadence', () => {
  beforeEach(() => {
    mocks.parseConversation.mockReset()
    mocks.parseConversation.mockReturnValue([])
    mocks.detectAgent.mockReset()
    mocks.detectAgent.mockReturnValue(AGENT)
    mocks.state.conversations = []
    mocks.state.addConversationTurn.mockClear()
  })

  it('one call per chunk (the default): a parse on every 10th chunk, as in 1.54.4', () => {
    const hook = detected() // chunk 1
    for (let i = 0; i < 8; i++) hook.result.current.processAgentDetection('x', 1, 't', 'T') // chunks 2..9
    expect(mocks.parseConversation).toHaveBeenCalledTimes(0)
    hook.result.current.processAgentDetection('x', 1, 't', 'T') // chunk 10
    expect(mocks.parseConversation).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 10; i++) hook.result.current.processAgentDetection('x', 1, 't', 'T') // chunks 11..20
    expect(mocks.parseConversation).toHaveBeenCalledTimes(2)
  })

  it('NEGATIVE CONTROL: 1,000 chunks, one call each, is 100 parses (the base; a call that stood for a batch would not be)', () => {
    const hook = detected()
    for (let i = 0; i < 1000; i++) hook.result.current.processAgentDetection('x', 1, 't', 'T')
    expect(mocks.parseConversation).toHaveBeenCalledTimes(100)
  })

  it('the same 1,000 chunks in passes of 31: a parse at most once per pass, and 31 chunks always cross a multiple of ten', () => {
    const hook = detected()
    let calls = 0
    for (let sent = 0; sent < 1000; sent += 31) {
      hook.result.current.processAgentDetection('x', 31, 't', 'T', Math.min(31, 1000 - sent))
      calls++
    }
    expect(calls).toBe(33)
    expect(mocks.parseConversation).toHaveBeenCalledTimes(calls) // 33 parses for 1,000 chunks (the base: 100)
  })

  it('a call for fewer chunks than the interval parses only when it crosses a multiple of ten', () => {
    const hook = detected() // count is 1
    hook.result.current.processAgentDetection('x', 3, 't', 'T', 3) // 4
    hook.result.current.processAgentDetection('x', 3, 't', 'T', 3) // 7
    expect(mocks.parseConversation).toHaveBeenCalledTimes(0)
    hook.result.current.processAgentDetection('x', 3, 't', 'T', 3) // 10: crossed
    expect(mocks.parseConversation).toHaveBeenCalledTimes(1)
    hook.result.current.processAgentDetection('x', 3, 't', 'T', 3) // 13
    expect(mocks.parseConversation).toHaveBeenCalledTimes(1)
  })

  it('a huge pass crosses many multiples but parses once (the parse reads the text it is given, not the count)', () => {
    const hook = detected()
    hook.result.current.processAgentDetection('x', 5000, 't', 'T', 500)
    expect(mocks.parseConversation).toHaveBeenCalledTimes(1)
  })

  it('new turns are still added the way they always were (the store is told of turns beyond what it holds)', () => {
    const hook = detected()
    mocks.parseConversation.mockReturnValueOnce([{ n: 1 }, { n: 2 }])
    mocks.state.conversations = [{ terminalId: 't', turns: [{ n: 1 }] }]
    hook.result.current.processAgentDetection('x', 10, 't', 'T', 10)
    expect(mocks.state.addConversationTurn).toHaveBeenCalledTimes(1)
    expect(mocks.state.addConversationTurn).toHaveBeenCalledWith('t', 'T', 'Claude Code', { n: 2 })
  })

  it('does not count chunks before an agent is detected, and scans only the first 2 KB of output for one', () => {
    mocks.detectAgent.mockReturnValue(null)
    const hook = renderHook(() => useAgentDetection())
    hook.result.current.processAgentDetection('nothing', 1000, 't', 'T', 30)
    hook.result.current.processAgentDetection('nothing', 1100, 't', 'T', 30) // 2,100 bytes seen: scanning stops
    expect(mocks.detectAgent).toHaveBeenCalledTimes(2)
    hook.result.current.processAgentDetection('nothing', 10, 't', 'T')
    expect(mocks.detectAgent).toHaveBeenCalledTimes(2)
    expect(mocks.parseConversation).not.toHaveBeenCalled()
  })
})
