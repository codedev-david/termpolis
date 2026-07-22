import { describe, it, expect, beforeEach, afterEach } from 'vitest'
const { rewriteMessagesBody, compactToolText, setWireWindow, windowForMode } = await import('../../src/main/headroomProxy/wireCompress')

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

describe('rewriteMessagesBody — HTML reduction + per-body dedup', () => {
  const HTML =
    '<!doctype html><html><head><title>T</title><style>.a{b:c}</style><script>evil()</script></head><body>' +
    '<nav><a href="/">Home</a></nav><h1>Main Heading Here</h1>' +
    '<p>Paragraph with enough real words to be meaningful body content worth keeping.</p>'.repeat(6) +
    '<footer>Foot</footer></body></html>'

  function bodyWith(contents: string[]): string {
    return JSON.stringify({
      model: 'claude-x',
      messages: contents.map((c, i) => ({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: c }],
      })),
    })
  }

  it('reduces an HTML tool_result to text, reversibly', () => {
    const r = rewriteMessagesBody(bodyWith([HTML]))
    expect(r.changed).toBe(true)
    const text = JSON.parse(r.body).messages[0].content[0].content as string
    expect(text).not.toContain('evil()')
    expect(text).not.toContain('.a{b:c}')
    expect(text).toContain('Main Heading Here')
    expect(text).toContain('retrieve_full') // footer points back to the original
    expect(r.stashes.length).toBe(1)
    expect(r.stashes[0].original).toBe(HTML) // full original recoverable
  })

  it('is deterministic on HTML (cache-safe)', () => {
    const b = bodyWith([HTML])
    expect(rewriteMessagesBody(b).body).toBe(rewriteMessagesBody(b).body)
  })

  it('collapses an identical repeated tool_result to a one-line reference stub', () => {
    const dup = 'HEADER\n' + Array.from({ length: 30 }, (_, i) => `data row ${i} value here`).join('\n')
    const r = rewriteMessagesBody(bodyWith([dup, dup]))
    const after = JSON.parse(r.body)
    const first = after.messages[0].content[0].content as string
    const second = after.messages[1].content[0].content as string
    expect(second).toContain('Identical to an earlier tool result')
    expect(second.length).toBeLessThan(first.length)
    const token = (second.match(/hr_[a-f0-9]{16}/) || [])[0]
    expect(token).toBeTruthy()
    expect(r.stashes.some((s) => s.token === token && s.original === dup)).toBe(true) // reversible
  })

  it('per-body dedup is deterministic across turns', () => {
    const dup = Array.from({ length: 40 }, (_, i) => `line ${i} with content`).join('\n')
    const b = bodyWith([dup, dup, dup])
    expect(rewriteMessagesBody(b).body).toBe(rewriteMessagesBody(b).body)
  })

  it('does NOT dedup distinct tool_results', () => {
    const a = Array.from({ length: 40 }, (_, i) => `alpha row ${i} with padding text`).join('\n')
    const b = Array.from({ length: 40 }, (_, i) => `beta row ${i} with padding text`).join('\n')
    const after = JSON.parse(rewriteMessagesBody(bodyWith([a, b])).body)
    expect(after.messages[1].content[0].content as string).not.toContain('Identical to an earlier')
  })

  it('compresses an image nested inside a tool_result content array', () => {
    const bigImg = 'A'.repeat(5000)
    const body = JSON.stringify({
      model: 'claude-x',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [
                { type: 'text', text: 'see the screenshot' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigImg } },
              ],
            },
          ],
        },
      ],
    })
    const shrink = (d: string, mt: string) => ({ data: d.slice(0, 100), mediaType: mt, changed: true })
    const r = rewriteMessagesBody(body, { compressImage: shrink })
    expect(r.changed).toBe(true)
    expect(r.stats.images).toBe(1)
    const img = JSON.parse(r.body).messages[0].content[0].content[1]
    expect(img.source.data.length).toBeLessThan(bigImg.length)
  })
})

describe('wire window — mode-driven, validated, fail-safe (v1.30)', () => {
  // wireWindow is module state; force the aggressive default around every test so a window
  // change can never leak into the suites above (they assume the default).
  beforeEach(() => setWireWindow(windowForMode('aggressive')))
  afterEach(() => setWireWindow(windowForMode('aggressive')))

  it('windowForMode mirrors the config profiles and rejects unknown modes (no silent downgrade)', () => {
    expect(windowForMode('aggressive')).toEqual({ headLines: 12, tailLines: 6, maxChars: 1000 })
    expect(windowForMode('balanced')).toEqual({ headLines: 24, tailLines: 12, maxChars: 2000 })
    expect(windowForMode('conservative')).toEqual({ headLines: 40, tailLines: 20, maxChars: 4000 })
    expect(windowForMode('nonsense')).toBeNull()
    expect(windowForMode('')).toBeNull()
    expect(windowForMode('AGGRESSIVE')).toBeNull() // case-sensitive
  })

  it('default window is the aggressive profile — head 12 + tail 6, middle elided', () => {
    const out = compactToolText(BIG).text
    expect(out).toContain('line number 11 with')     // 12th head line kept
    expect(out).not.toContain('line number 12 with') // 13th line elided
    expect(out).toContain('line number 119 with')    // last tail line kept
    expect(out).toContain('lines elided')
  })

  it('setWireWindow makes compression follow the mode: aggressive << balanced << conservative', () => {
    setWireWindow(windowForMode('aggressive'));   const agg = compactToolText(BIG).text.length
    setWireWindow(windowForMode('balanced'));     const bal = compactToolText(BIG).text.length
    setWireWindow(windowForMode('conservative')); const con = compactToolText(BIG).text.length
    expect(agg).toBeLessThan(bal)
    expect(bal).toBeLessThan(con)
  })

  it('rejects every invalid window so a garbled message can never break or downgrade it', () => {
    const good = compactToolText(BIG).text // aggressive (from beforeEach)
    const bads: unknown[] = [
      null, undefined, {}, { headLines: -1, tailLines: 6, maxChars: 1000 },
      { headLines: 12, tailLines: 6, maxChars: 0 }, { headLines: NaN, tailLines: 6, maxChars: 1000 },
      { headLines: 12, tailLines: Infinity, maxChars: 1000 }, { headLines: 12, tailLines: -3, maxChars: 1000 },
    ]
    for (const bad of bads) {
      setWireWindow(bad as never)
      expect(compactToolText(BIG).text).toBe(good) // unchanged — still aggressive
    }
  })

  it('windowForMode(unknown) → setWireWindow(null) is a no-op (the proxy-child fail-safe path)', () => {
    setWireWindow(windowForMode('conservative'))
    const con = compactToolText(BIG).text
    setWireWindow(windowForMode('garbage')) // null → no-op → stays conservative
    expect(compactToolText(BIG).text).toBe(con)
  })

  it('floors fractional window values without breaking output', () => {
    setWireWindow({ headLines: 12.9, tailLines: 6.9, maxChars: 1000.9 })
    const r = compactToolText(BIG)
    expect(r.text.length).toBeLessThan(BIG.length)
    expect(r.text).toContain('lines elided')
  })

  it('stays deterministic after a window change (cache-safety prerequisite)', () => {
    setWireWindow(windowForMode('balanced'))
    expect(rewriteMessagesBody(realisticBody()).body).toBe(rewriteMessagesBody(realisticBody()).body)
    expect(compactToolText(BIG).text).toBe(compactToolText(BIG).text)
  })
})
