import { describe, it, expect, beforeEach, afterEach } from 'vitest'
const { rewriteMessagesBody, setWireWindow } = await import('../../src/main/headroomProxy/wireCompress')

const lines = (n: number, tag = 'v'): string =>
  Array.from({ length: n }, (_, i) => `  const ${tag}${i} = compute(${i}) // a reasonably long source line`).join('\n')

/** One assistant tool_use block, exactly as it appears in re-sent history. */
function bodyWithToolUse(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    model: 'claude-x',
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu0', name, input }] }],
  })
}

const inputOf = (body: string): Record<string, unknown> =>
  JSON.parse(body).messages[0].content[0].input

/**
 * tool_use inputs are the agent's OWN authored intent, which it replays as a template on later
 * turns, so the proxy never rewrites one — any field, any size, any age (see TOOL_USE_VERBATIM in
 * wireCompress.ts). The walk only indexes the artifact fields as dedup keys for the tool_results
 * that follow; the regression block at the bottom of this file is where the rule came from.
 */
describe('rewriteMessagesBody — tool_use inputs', () => {
  it('never compresses a large NON-artifact field — a subagent prompt is replayed too', () => {
    const prompt = lines(400)
    const raw = bodyWithToolUse('Task', { description: 'go', prompt })
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
    const out = inputOf(r.body)
    expect(out.prompt).toBe(prompt)
    expect(out.description).toBe('go')
  })

  it('stashes nothing and leaves no marker — there is no compressed field to give back', () => {
    const r = rewriteMessagesBody(bodyWithToolUse('Task', { description: 'go', prompt: lines(400) }))
    expect(r.stashes).toEqual([])
    expect(r.body).not.toContain('[headroom]')
  })

  it('is BYTE-STABLE across turns — the same history rewrites identically (cache safety)', () => {
    const body = bodyWithToolUse('Task', { description: 'go', prompt: lines(400) })
    expect(rewriteMessagesBody(body).body).toBe(rewriteMessagesBody(body).body)
  })

  it('never touches a thinking block — its signature is cryptographically validated', () => {
    const raw = JSON.stringify({
      model: 'claude-x',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: lines(400, 'th'), signature: 'sig-abc123' },
          { type: 'tool_use', id: 'tu0', name: 'Task', input: { prompt: lines(400) } },
        ],
      }],
    })
    const parsed = JSON.parse(rewriteMessagesBody(raw).body)
    const [think, use] = parsed.messages[0].content
    expect(think.thinking).toBe(lines(400, 'th')) // untouched, byte for byte
    expect(think.signature).toBe('sig-abc123')
    expect(use.input.prompt).toBe(lines(400)) // ...and neither is the tool_use beside it
  })

  it('leaves short fields and non-strings exactly as they were', () => {
    const input = { command: 'ls -la', timeout: 5000, flag: true, nested: { a: 1 }, arr: [1, 2] }
    const r = rewriteMessagesBody(bodyWithToolUse('Bash', input))
    expect(r.changed).toBe(false)
    expect(inputOf(r.body)).toEqual(input)
  })

  it('refuses to truncate identifier-shaped keys even when they are long', () => {
    // A pathological path longer than the floor must still arrive intact, like every other
    // tool_use field — a truncated path would be actively misleading.
    const longPath = '/repo/' + 'nested/'.repeat(120) + 'file.ts'
    expect(longPath.length).toBeGreaterThan(400)
    const r = rewriteMessagesBody(bodyWithToolUse('Read', { file_path: longPath }))
    expect(r.changed).toBe(false)
    expect(inputOf(r.body).file_path).toBe(longPath)
  })

  it('collapses a file the agent WROTE and later READ — paid for once, not twice', () => {
    const content = lines(400)
    const raw = JSON.stringify({
      model: 'claude-x',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu0', name: 'Write', input: { file_path: '/a.ts', content } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content }] },
      ],
    })
    const parsed = JSON.parse(rewriteMessagesBody(raw).body)
    expect(parsed.messages[2].content[0].content).toContain('Identical to an earlier tool result')
  })

  it('fails open on a malformed tool_use rather than dropping the request', () => {
    for (const input of [null, 'a string', 42, ['an', 'array']]) {
      const raw = JSON.stringify({ model: 'm', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'W', input }] }] })
      expect(() => rewriteMessagesBody(raw)).not.toThrow()
      expect(rewriteMessagesBody(raw).changed).toBe(false)
    }
  })

  it('leaves the input byte-identical even when the tool_result that answers it IS compressed', () => {
    const input = { description: 'go', prompt: lines(400) }
    const output = lines(400, 'out')
    const raw = JSON.stringify({
      model: 'claude-x',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu0', name: 'Task', input }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu0', content: output }] },
      ],
    })
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(true)
    const parsed = JSON.parse(r.body)
    expect(JSON.stringify(parsed.messages[0].content[0].input)).toBe(JSON.stringify(input))
    expect((parsed.messages[1].content[0].content as string).length).toBeLessThan(output.length)
  })
})

describe('rewriteMessagesBody — tool_use accounting', () => {
  beforeEach(() => setWireWindow({ headLines: 12, tailLines: 6, maxChars: 1000 }))
  afterEach(() => setWireWindow({ headLines: 12, tailLines: 6, maxChars: 1000 }))

  it('books nothing for a tool_use — its counters stay 0 and nothing leaks into the tool_result ones', () => {
    // The tu* counters survive only for schema compatibility; a large field must not move them.
    const r = rewriteMessagesBody(bodyWithToolUse('Task', { description: 'go', prompt: lines(400) }))
    expect(r.stats.tuBlocks).toBe(0)
    expect(r.stats.tuOrigChars).toBe(0)
    expect(r.stats.tuCompChars).toBe(0)
    expect(r.stats.trBlocks).toBe(0)
    expect(r.stats.trOrigChars).toBe(0)
  })

  it('does not count sub-floor fields as origin bytes — no incompressible tare in the ratio', () => {
    const r = rewriteMessagesBody(bodyWithToolUse('Task', { description: 'echo hi' }))
    expect(r.stats.tuOrigChars).toBe(0)
  })

  it('does not count VERBATIM fields as origin bytes either — they are not compressible material', () => {
    const r = rewriteMessagesBody(bodyWithToolUse('Write', { file_path: '/a.ts', content: lines(400) }))
    expect(r.changed).toBe(false)
    expect(r.stats.tuOrigChars).toBe(0)
    expect(r.stats.tuBlocks).toBe(0)
  })
})

/**
 * REGRESSION (2026-08-25, field report): tool_use inputs are not merely "the agent's own output" —
 * they are the agent's own output that it COPIES FORWARD. A tool_result is observed data: the model
 * knows it did not author it, and calls retrieve_full when it needs the exact bytes. A tool_use input
 * is authored intent: the model treats its own prior Write/Edit/Bash input as the record of what it
 * meant, reproduces it verbatim on the next turn, and never suspects the bytes were altered
 * underneath it.
 *
 * So eliding those fields does not shrink history — it REWRITES it, and the elision marker becomes a
 * real artifact. Both of these are copied verbatim from one live session:
 *
 *   /usr/bin/bash: line 37: [headroom]: command not found
 *   File "apex3.py", line 8: SyntaxError: invalid character '…' (U+2026)
 *
 * The model re-emitted "… [20 lines elided] …" and the "[headroom] Full result cached" footer into a
 * real file and a real shell command. Every such turn is a red tool error, a retry off the same
 * poisoned history, and a retrieve_full round-trip — which is why the give-back ledger ran NEGATIVE.
 *
 * The fields that become real artifacts must therefore survive byte-for-byte. This costs ~1.7% of
 * measured savings (tool_use was 22.5M of 1.34B saved tokens) and removes the whole failure class.
 * The rule now covers every tool_use field, not just these — see headroomToolUseNeverRewritten.
 */
describe('rewriteMessagesBody — tool_use inputs the agent copies forward stay VERBATIM', () => {
  beforeEach(() => setWireWindow({ headLines: 12, tailLines: 6, maxChars: 1000 }))

  it('never elides a file body — the agent re-writes files it wrote', () => {
    const content = lines(400)
    const r = rewriteMessagesBody(bodyWithToolUse('Write', { file_path: '/repo/big.ts', content }))
    expect(inputOf(r.body).content).toBe(content)
  })

  it('never elides a shell command — the agent re-runs and adapts its own heredocs', () => {
    const command = `cat > /tmp/x.py <<'PY'\n${lines(400, 'c')}\nPY\npython /tmp/x.py`
    const r = rewriteMessagesBody(bodyWithToolUse('Bash', { command }))
    expect(inputOf(r.body).command).toBe(command)
  })

  it('never elides either side of an Edit — both are replayed into the file', () => {
    const oldS = lines(300, 'old')
    const newS = lines(300, 'new')
    const r = rewriteMessagesBody(bodyWithToolUse('Edit', { file_path: '/a.ts', old_string: oldS, new_string: newS }))
    const out = inputOf(r.body)
    expect(out.old_string).toBe(oldS)
    expect(out.new_string).toBe(newS)
  })

  it('never elides the built-in text_editor fields — a different name, the same file', () => {
    const body = lines(400, 'ft')
    const r = rewriteMessagesBody(bodyWithToolUse('str_replace_editor', { path: '/a.py', file_text: body }))
    expect(inputOf(r.body).file_text).toBe(body)
  })

  it('never elides an apply_patch diff — it is applied to the tree verbatim', () => {
    const patch = lines(400, 'p')
    const r = rewriteMessagesBody(bodyWithToolUse('apply_patch', { patch }))
    expect(inputOf(r.body).patch).toBe(patch)
  })

  it('never elides a notebook cell source', () => {
    const src = lines(400, 'nb')
    const r = rewriteMessagesBody(bodyWithToolUse('NotebookEdit', { notebook_path: '/n.ipynb', new_source: src }))
    expect(inputOf(r.body).new_source).toBe(src)
  })

  it('indexes a verbatim body ONCE even when the agent writes it twice', () => {
    // The verbatim field still feeds the dedup index (that is what keeps "wrote it, then read it"
    // collapsing). Indexing it twice would push a duplicate diff-base and change what every later
    // block compresses to — a cache-busting difference — so the second sighting is a no-op.
    const content = lines(400)
    const raw = JSON.stringify({
      model: 'claude-x',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'Write', input: { file_path: '/a.ts', content } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/b.ts', content } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
      ],
    })
    const parsed = JSON.parse(rewriteMessagesBody(raw).body)
    expect(parsed.messages[0].content[0].input.content).toBe(content) // both bodies verbatim
    expect(parsed.messages[1].content[0].input.content).toBe(content)
    expect(parsed.messages[2].content[0].content).toContain('Identical to an earlier tool result')
    expect(rewriteMessagesBody(raw).body).toBe(rewriteMessagesBody(raw).body) // still byte-stable
  })

  it('ignores a non-string verbatim field instead of tripping over it', () => {
    const r = rewriteMessagesBody(bodyWithToolUse('Edit', { file_path: '/a.ts', replace_all: true, new_string: 'x' }))
    expect(r.changed).toBe(false)
    expect(inputOf(r.body)).toEqual({ file_path: '/a.ts', replace_all: true, new_string: 'x' })
  })

  it('leaks NO elision marker or headroom footer into any artifact-bearing field', () => {
    const raw = JSON.stringify({
      model: 'claude-x',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't0', name: 'Write', input: { file_path: '/a.py', content: lines(400, 'w') } },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: lines(400, 'b') } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/a.py', old_string: lines(300, 'o'), new_string: lines(300, 'n') } },
        ],
      }],
    })
    for (const b of JSON.parse(rewriteMessagesBody(raw).body).messages[0].content) {
      for (const v of Object.values(b.input as Record<string, unknown>)) {
        if (typeof v !== 'string') continue
        expect(v).not.toContain('[headroom]')
        expect(v).not.toContain('elided')
        expect(v).not.toContain('…')
      }
    }
  })
})
