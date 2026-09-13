import { describe, it, expect } from 'vitest'
import {
  applyPrefixDecay, DECAY_FIRST_THRESHOLD, DECAY_MIN_CHARS,
} from '../../src/main/headroomProxy/prefixDecay'

/**
 * Decay guarded only on the naming keys. It had no TOOL_USE_VERBATIM check and no isExempt check,
 * so a Write `content`, a Bash `command`, an Edit `old_string` or an apply_patch `patch` old enough
 * to age out was replaced wholesale by a 134-char stub — the replay-poisoning class the live
 * compressor was deliberately changed to avoid in v1.36 (wireCompress.ts:412-420). It shipped ON by
 * default with no test covering any of it.
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

describe('prefix decay — must not rewrite the agent\'s own artifacts', () => {
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

  it('still ages out a bulk field that is neither a name, an artifact, nor exempt', () => {
    const prompt = big('prompt')
    const { input, counts } = decay([
      { type: 'tool_use', id: 'a', name: 'SomeUnlistedTool', input: { prompt } },
    ])
    expect(field(input[0], 'prompt')).toContain('Aged out')
    expect(counts.tuBlocks).toBe(1)
    expect(counts.tuOrigChars).toBe(prompt.length)
    // ...and bills to the tool_use bucket, not the tool_result one.
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

  it('keeps filePath and file whole — PATH_KEYS claimed they were already skipped', () => {
    const filePath = big('/a/very/long/generated/path')
    const { input } = decay([
      { type: 'tool_use', id: 'a', name: 'SomeUnlistedTool', input: { filePath, file: big('/b/f') } },
    ])
    expect(field(input[0], 'filePath')).toBe(filePath)
  })
})
