import { describe, it, expect } from 'vitest'
const { rewriteMessagesBody, compactToolText } = await import('../../src/main/headroomProxy/wireCompress')

const BIG = Array.from({ length: 120 }, (_, i) => `line number ${i} with some content to make it long enough`).join('\n')

function realisticBody(toolContent: unknown = BIG) {
  return JSON.stringify({
    model: 'claude-x',
    system: [{ type: 'text', text: 'You are Claude.', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'do stuff' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning here' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: toolContent, cache_control: { type: 'ephemeral' } }] },
    ],
  })
}

describe('rewriteMessagesBody', () => {
  it('compresses a big tool_result and leaves everything else byte-identical', () => {
    const orig = realisticBody()
    const r = rewriteMessagesBody(orig)
    expect(r.changed).toBe(true)
    const before = JSON.parse(orig), after = JSON.parse(r.body)
    // untouched surfaces
    expect(after.system).toEqual(before.system)
    expect(after.tools).toEqual(before.tools)
    expect(after.messages[0]).toEqual(before.messages[0])
    expect(after.messages[1]).toEqual(before.messages[1]) // thinking + tool_use untouched
    // tool_result compressed, cache_control preserved
    const tr = after.messages[2].content[0]
    expect(tr.cache_control).toEqual({ type: 'ephemeral' })
    expect(tr.content.length).toBeLessThan(BIG.length)
    expect(tr.content).toContain('retrieve_full')
    // stash captured for reversibility
    expect(r.stashes).toHaveLength(1)
    expect(r.stashes[0].original).toBe(BIG)
    expect(tr.content).toContain(r.stashes[0].token)
  })

  it('is deterministic — identical bytes across runs (cache-safety prerequisite)', () => {
    const b = realisticBody()
    expect(rewriteMessagesBody(b).body).toBe(rewriteMessagesBody(b).body)
  })

  it('compresses tool_result whose content is an array of text blocks', () => {
    const r = rewriteMessagesBody(realisticBody([{ type: 'text', text: BIG }]))
    expect(r.changed).toBe(true)
    const tr = JSON.parse(r.body).messages[2].content[0]
    expect(tr.content[0].text).toContain('retrieve_full')
  })

  it('leaves small tool_results untouched', () => {
    const orig = realisticBody('tiny output')
    const r = rewriteMessagesBody(orig)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(orig)
  })

  it('passes through non-JSON and non-messages bodies unchanged', () => {
    expect(rewriteMessagesBody('not json').body).toBe('not json')
    expect(rewriteMessagesBody('not json').changed).toBe(false)
    const noMsgs = JSON.stringify({ messages: 'nope' })
    expect(rewriteMessagesBody(noMsgs).body).toBe(noMsgs)
  })

  it('compresses image blocks via the injected compressor and is fail-open if it throws', () => {
    const imgBody = JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(5000) } }] }] })
    const shrink = () => ({ data: 'B'.repeat(500), mediaType: 'image/jpeg', changed: true })
    const r = rewriteMessagesBody(imgBody, { compressImage: shrink })
    expect(r.changed).toBe(true)
    const src = JSON.parse(r.body).messages[0].content[0].source
    expect(src.data).toBe('B'.repeat(500))
    expect(src.media_type).toBe('image/jpeg')
    expect(r.stats.images).toBe(1)
    // fail-open: a throwing image compressor must not corrupt the request
    const boom = () => { throw new Error('bad image') }
    const r2 = rewriteMessagesBody(imgBody, { compressImage: boom })
    expect(r2.body).toBe(imgBody)
  })

  it('fails open (no compression) when the body would not round-trip losslessly — e.g. an integer > 2^53', () => {
    // Hand-built raw JSON containing 2^53+1, which JS numbers cannot represent exactly.
    const raw = '{"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":' + JSON.stringify(BIG) + '}]}],"meta":{"id":9007199254740993}}'
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false) // guard trips: reserialize yields ...992 !== raw's ...993
    expect(r.body).toBe(raw) // untouched — no silent corruption
  })

  it('compactToolText produces a deterministic content-hash token', () => {
    const a = compactToolText(BIG), b = compactToolText(BIG)
    expect(a.stash!.token).toBe(b.stash!.token)
    expect(a.stash!.token).toMatch(/^hr_[a-f0-9]{16}$/)
  })
})
