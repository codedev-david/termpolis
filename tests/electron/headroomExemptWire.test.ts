import { describe, it, expect } from 'vitest'
import { bareToolName, isExempt } from '../../src/main/headroom/router'
const { rewriteMessagesBody } = await import('../../src/main/headroomProxy/wireCompress')

/**
 * The memory exemption reaching the WIRE, not just the MCP layer.
 *
 * Termpolis promises that compression never costs memory: the brain ingests full text, and what
 * the model sees when it recalls is what the brain stored. `router.isExempt` enforced that at the
 * MCP layer, but the proxy compressed the same content anyway on its way upstream, because the
 * wire's tool name is namespaced (`mcp__termpolis__memory_search`) and the exemption list holds
 * bare names. The invariant held only in the sense that storage was intact; recall was not.
 */
describe('MCP namespace stripping', () => {
  it('reduces a namespaced wire name to the bare name the exemption list uses', () => {
    expect(bareToolName('mcp__termpolis__memory_write')).toBe('memory_write')
    expect(bareToolName('mcp__claude_ai_Gmail__get_message')).toBe('get_message')
  })

  it('leaves a bare name untouched — that is what the MCP layer already sees', () => {
    expect(bareToolName('memory_write')).toBe('memory_write')
    expect(bareToolName('Read')).toBe('Read')
    expect(bareToolName('')).toBe('')
  })

  it('does not mistake an ordinary name that merely contains a double underscore', () => {
    // Only the `mcp__` prefix marks a namespaced name. A tool called `do__thing` is its own name.
    expect(bareToolName('do__thing')).toBe('do__thing')
  })

  it('exempts memory and swarm surfaces in BOTH the bare and namespaced forms', () => {
    for (const t of ['memory_search', 'swarm_send_message', 'retrieve_full']) {
      expect(isExempt(t)).toBe(true)
      expect(isExempt(`mcp__termpolis__${t}`)).toBe(true)
    }
    expect(isExempt('Read')).toBe(false)
    expect(isExempt('mcp__termpolis__code_search')).toBe(false)
  })
})

const bulk = (tag: string): string =>
  Array.from({ length: 80 }, (_, i) => `${tag} line ${i} — a recalled fact long enough to be worth compressing`).join('\n')

const body = (toolName: string, text: string): string => JSON.stringify({
  model: 'claude-x',
  messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: toolName, input: { query: text } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: text }] },
  ],
})

describe('the wire honours the exemption', () => {
  it('compresses an ordinary tool the same as before — this is the control', () => {
    const text = bulk('read')
    const r = rewriteMessagesBody(body('Read', text))
    expect(r.changed).toBe(true)
    expect(r.body).not.toContain(text)
  })

  it('passes a recalled memory through byte-for-byte', () => {
    const text = bulk('memory')
    const r = rewriteMessagesBody(body('mcp__termpolis__memory_search', text))
    expect(r.changed).toBe(false)
    // Both halves: the tool_use input the agent sent AND the tool_result the brain returned.
    expect(JSON.parse(r.body).messages[0].content[0].input.query).toBe(text)
    expect(JSON.parse(r.body).messages[1].content[0].content).toBe(text)
  })

  it('passes swarm coordination through too — a truncated hand-off is a lost hand-off', () => {
    const text = bulk('swarm')
    const r = rewriteMessagesBody(body('mcp__termpolis__swarm_send_message', text))
    expect(r.changed).toBe(false)
    expect(JSON.parse(r.body).messages[1].content[0].content).toBe(text)
  })

  it('exempts the ARRAY form of tool_result as well as the string form', () => {
    const text = bulk('memory-array')
    const raw = JSON.stringify({
      model: 'claude-x',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'mcp__termpolis__memory_primer', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text }] }] },
      ],
    })
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false)
    expect(JSON.parse(r.body).messages[1].content[0].content[0].text).toBe(text)
  })
})
