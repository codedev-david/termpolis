import { describe, it, expect } from 'vitest'
const { rewriteMessagesBody } = await import('../../src/main/headroomProxy/wireCompress')
const { STEERING_MARK, steeringDirective } = await import('../../src/main/headroom/outputSteering')

const TOOLS = [
  { name: 'Read', description: 'Read a file from disk.', input_schema: { type: 'object' } },
  { name: 'mcp__termpolis__memory_search', description: 'Search the shared memory brain.', input_schema: { type: 'object' } },
  { name: 'mcp__termpolis__memory_primer', description: 'Load the project primer.', input_schema: { type: 'object' } },
]

function body(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'claude-x',
    system: 'You are Claude.',
    tools: TOOLS,
    messages: [{ role: 'user', content: 'hi' }],
    ...over,
  })
}

describe('prefix head measurement', () => {
  it('measures the system prompt whether it arrives as a string or as blocks', () => {
    const asString = rewriteMessagesBody(body()).stats
    const asBlocks = rewriteMessagesBody(body({ system: [{ type: 'text', text: 'You are Claude.' }] })).stats
    expect(asString.sysChars).toBe('You are Claude.'.length)
    expect(asBlocks.sysChars).toBe(asString.sysChars)
  })

  it('separates the tool schemas Termpolis emits from everyone elses', () => {
    const s = rewriteMessagesBody(body()).stats
    expect(s.toolCount).toBe(3)
    expect(s.toolsChars).toBe(TOOLS.reduce((a, t) => a + JSON.stringify(t).length, 0))
    const ours = TOOLS.slice(1).reduce((a, t) => a + JSON.stringify(t).length, 0)
    expect(s.tpToolsChars).toBe(ours)
    expect(s.tpToolsChars).toBeLessThan(s.toolsChars)
  })

  it('detects steering from the directive the app actually injects, in every mode', () => {
    for (const mode of ['conservative', 'balanced', 'aggressive', 'max'] as const) {
      const sys = `You are Claude.\n\n${steeringDirective(mode)}`
      expect(rewriteMessagesBody(body({ system: sys })).stats.steered).toBe(true)
    }
    expect(rewriteMessagesBody(body()).stats.steered).toBe(false)
    expect(steeringDirective('balanced')).toContain(STEERING_MARK)
  })

  it('changes nothing on the wire — the head is read, never rewritten', () => {
    const raw = body({ system: `You are Claude.\n\n${steeringDirective('max')}` })
    const r = rewriteMessagesBody(raw)
    const before = JSON.parse(raw)
    const after = JSON.parse(r.body)
    expect(after.system).toEqual(before.system)
    expect(after.tools).toEqual(before.tools)
  })

  it('reports zeroes rather than guesses when there is no head to measure', () => {
    const s = rewriteMessagesBody(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })).stats
    expect(s.sysChars).toBe(0)
    expect(s.toolsChars).toBe(0)
    expect(s.toolCount).toBe(0)
    expect(s.tpToolsChars).toBe(0)
    expect(s.steered).toBe(false)
  })

  it('still measures a request it declines to compress', () => {
    // maxBodyChars forces the size bail-out; a body we refuse to touch is exactly the body whose
    // cost was previously invisible, so the head must still be counted... except that bail-out
    // happens before the parse. The parse-level fail-open is the one that must still measure.
    // An integer past 2^53 makes the body fail its round-trip equality check, so the compressor
    // returns the original bytes untouched. That request still cost money, so it still gets
    // measured — the head is an observation of what was sent, not a claim about what we saved.
    const raw = body().replace('"model":"claude-x"', '"model":"claude-x","n":9007199254740993')
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
    expect(r.stats.sysChars).toBeGreaterThan(0)
    expect(r.stats.toolCount).toBe(3)
  })
})

