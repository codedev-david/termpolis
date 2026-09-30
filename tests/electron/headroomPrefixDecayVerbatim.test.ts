import { describe, it, expect } from 'vitest'
import {
  applyPrefixDecay, DECAY_FIRST_THRESHOLD, DECAY_MIN_CHARS,
} from '../../src/main/headroomProxy/prefixDecay'

/**
 * Decay never rewrites a tool_use input, at any age. It once guarded only on the naming keys, so a
 * Write `content`, a Bash `command` or an apply_patch `patch` old enough to age out became a
 * 134-char stub that the model then replayed. Decay now has no tool_use branch at all: only
 * tool_result text ages out.
 */
const big = (tag: string): string => `${tag}:` + 'x'.repeat(DECAY_MIN_CHARS * 2)

/** Twice the first threshold, so the cutoff lands well past index 0. */
const DEEP = DECAY_FIRST_THRESHOLD * 2

const decay = (blocks: Array<Record<string, unknown>>): {
  input: Array<Record<string, unknown>>
  counts: ReturnType<typeof applyPrefixDecay>
} => {
  const messages: Array<{ content?: unknown }> = Array.from({ length: DEEP }, () => ({
    content: [{ type: 'text', text: 'filler' }],
  }))
  messages[0] = { content: blocks }
  const counts = applyPrefixDecay(messages, [])
  return { input: messages[0].content as Array<Record<string, unknown>>, counts }
}

const field = (b: Record<string, unknown>, k: string): string =>
  (b.input as Record<string, string>)[k]

describe('prefix decay — must not rewrite any tool_use input', () => {
  it('leaves every TOOL_USE_VERBATIM field byte-identical', () => {
    const content = big('body'); const command = big('cmd')
    const oldS = big('old'); const newS = big('new'); const patch = big('diff')
    const { input, counts } = decay([
      { type: 'tool_use', id: 'a', name: 'Write', input: { file_path: '/x.ts', content } },
      { type: 'tool_use', id: 'b', name: 'Bash', input: { command } },
      { type: 'tool_use', id: 'c', name: 'Edit', input: { file_path: '/y.ts', old_string: oldS, new_string: newS } },
      { type: 'tool_use', id: 'd', name: 'apply_patch', input: { patch } },
    ])
    expect(field(input[0], 'content')).toBe(content)
    expect(field(input[1], 'command')).toBe(command)
    expect(field(input[2], 'old_string')).toBe(oldS)
    expect(field(input[2], 'new_string')).toBe(newS)
    expect(field(input[3], 'patch')).toBe(patch)
    expect(counts.tuBlocks).toBe(0)
  })

  it('never touches an exempt tool, at any age', () => {
    // memory_*/swarm_* carry the brain's own full-fidelity record. Invariant I1: the memory layer
    // always ingests complete text, so aging it out would corrupt what the app learns from.
    const text = big('memory')
    const { input, counts } = decay([
      { type: 'tool_use', id: 'a', name: 'memory_write', input: { text } },
      { type: 'tool_use', id: 'b', name: 'swarm_send_message', input: { message: big('swarm') } },
      { type: 'tool_use', id: 'c', name: 'mcp__termpolis__memory_write', input: { text } },
    ])
    expect(field(input[0], 'text')).toBe(text)
    expect(field(input[2], 'text')).toBe(text)
    expect(counts.tuBlocks).toBe(0)
  })

  it('never ages out a bulk field that is neither a name, an artifact, nor exempt', () => {
    const prompt = big('prompt')
    const { input, counts } = decay([
      { type: 'tool_use', id: 'a', name: 'SomeUnlistedTool', input: { prompt } },
    ])
    expect(field(input[0], 'prompt')).toBe(prompt)
    expect(counts.tuBlocks).toBe(0)
    expect(counts.tuOrigChars).toBe(0)
    expect(counts.tuCompChars).toBe(0)
    // ...and nothing is billed to the tool_result bucket in its place.
    expect(counts.blocks).toBe(0)
    expect(counts.origChars).toBe(0)
  })

  it('bills tool_result bytes to the tool_result bucket and nothing else', () => {
    const { counts } = decay([{ type: 'tool_result', tool_use_id: 'a', content: big('out') }])
    expect(counts.blocks).toBe(1)
    expect(counts.origChars).toBeGreaterThan(counts.compChars)
    expect(counts.tuBlocks).toBe(0)
    expect(counts.tuOrigChars).toBe(0)
  })

  it('leaks no elision marker into any artifact-bearing field', () => {
    const { input } = decay([
      { type: 'tool_use', id: 'a', name: 'Write', input: { file_path: '/x.ts', content: big('body') } },
      { type: 'tool_use', id: 'b', name: 'Bash', input: { command: big('cmd') } },
    ])
    for (const b of input) {
      for (const v of Object.values(b.input as Record<string, unknown>)) {
        if (typeof v !== 'string') continue
        expect(v).not.toContain('[headroom]')
        expect(v).not.toContain('Aged out')
        expect(v).not.toContain('…')
      }
    }
  })

  it('keeps long filePath and file values whole', () => {
    const filePath = big('/a/very/long/generated/path')
    const file = big('/b/f')
    const { input } = decay([
      { type: 'tool_use', id: 'a', name: 'SomeUnlistedTool', input: { filePath, file } },
    ])
    expect(field(input[0], 'filePath')).toBe(filePath)
    expect(field(input[0], 'file')).toBe(file)
  })
})
