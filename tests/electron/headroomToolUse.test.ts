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
 * tool_use inputs are the agent's OWN output: every file body it wrote, every Edit's
 * old_string/new_string, every heredoc it ran. Until now the wire compressor walked straight past
 * them, so that content rode in the cached prefix at full size and was re-read on every later turn.
 * Generation cost is unavoidable (billed at 5x the moment it is produced); the re-read cost was not.
 */
describe('rewriteMessagesBody — tool_use inputs', () => {
  it('compresses a large file body written via Write', () => {
    const content = lines(400)
    const r = rewriteMessagesBody(bodyWithToolUse('Write', { file_path: '/repo/big.ts', content }))
    expect(r.changed).toBe(true)
    const out = inputOf(r.body)
    expect((out.content as string).length).toBeLessThan(content.length)
    expect(out.file_path).toBe('/repo/big.ts') // identifier survives verbatim
  })

  it('stashes the TRUE original so retrieve_full gives the file back', () => {
    const content = lines(400)
    const r = rewriteMessagesBody(bodyWithToolUse('Write', { file_path: '/repo/big.ts', content }))
    const token = /token "(hr_[a-z0-9]+)"/.exec(inputOf(r.body).content as string)?.[1]
    expect(token).toBeTruthy()
    expect(r.stashes.find((s) => s.token === token)?.original).toBe(content)
  })

  it('compresses BOTH sides of an Edit, which is where the real bulk is', () => {
    const oldS = lines(300, 'old')
    const newS = lines(300, 'new')
    const r = rewriteMessagesBody(bodyWithToolUse('Edit', { file_path: '/a.ts', old_string: oldS, new_string: newS }))
    expect(r.changed).toBe(true)
    const out = inputOf(r.body)
    expect((out.old_string as string).length).toBeLessThan(oldS.length)
    expect((out.new_string as string).length).toBeLessThan(newS.length)
  })

  it('is BYTE-STABLE across turns — the same history compresses identically (cache safety)', () => {
    const body = bodyWithToolUse('Write', { file_path: '/a.ts', content: lines(400) })
    expect(rewriteMessagesBody(body).body).toBe(rewriteMessagesBody(body).body)
  })

  it('never touches a thinking block — its signature is cryptographically validated', () => {
    const raw = JSON.stringify({
      model: 'claude-x',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: lines(400, 'th'), signature: 'sig-abc123' },
          { type: 'tool_use', id: 'tu0', name: 'Write', input: { content: lines(400) } },
        ],
      }],
    })
    const parsed = JSON.parse(rewriteMessagesBody(raw).body)
    const [think, use] = parsed.messages[0].content
    expect(think.thinking).toBe(lines(400, 'th')) // untouched, byte for byte
    expect(think.signature).toBe('sig-abc123')
    expect((use.input.content as string).length).toBeLessThan(lines(400).length) // ...but tool_use still compressed
  })

  it('leaves short fields and non-strings exactly as they were', () => {
    const input = { command: 'ls -la', timeout: 5000, flag: true, nested: { a: 1 }, arr: [1, 2] }
    const r = rewriteMessagesBody(bodyWithToolUse('Bash', input))
    expect(r.changed).toBe(false)
    expect(inputOf(r.body)).toEqual(input)
  })

  it('refuses to truncate identifier-shaped keys even when they are long', () => {
    // A pathological path longer than the floor must still arrive intact — a truncated path is
    // actively misleading, unlike an elided file body which is merely shorter.
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

  it('keeps the input JSON schema-valid — compressed fields are still strings', () => {
    const r = rewriteMessagesBody(bodyWithToolUse('Write', { file_path: '/a.ts', content: lines(400) }))
    expect(typeof inputOf(r.body).content).toBe('string')
    expect(() => JSON.parse(r.body)).not.toThrow()
  })
})

describe('rewriteMessagesBody — tool_use accounting', () => {
  beforeEach(() => setWireWindow({ headLines: 12, tailLines: 6, maxChars: 1000 }))
  afterEach(() => setWireWindow({ headLines: 12, tailLines: 6, maxChars: 1000 }))

  it('bills tool_use to its OWN counters, never to the tool_result ones', () => {
    // Blending them would hide which surface is actually earning, which is exactly the kind of
    // flattering single number this release exists to get rid of.
    const r = rewriteMessagesBody(bodyWithToolUse('Write', { file_path: '/a.ts', content: lines(400) }))
    expect(r.stats.tuBlocks).toBe(1)
    expect(r.stats.tuCompChars).toBeLessThan(r.stats.tuOrigChars)
    expect(r.stats.trBlocks).toBe(0)
    expect(r.stats.trOrigChars).toBe(0)
  })

  it('does not count sub-floor fields as origin bytes — no incompressible tare in the ratio', () => {
    const r = rewriteMessagesBody(bodyWithToolUse('Bash', { command: 'echo hi' }))
    expect(r.stats.tuOrigChars).toBe(0)
  })
})
