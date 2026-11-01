import { describe, it, expect } from 'vitest'
import * as zlib from 'zlib'
const { parseTurnShapeFromSse, parseUsageFromSse, decodeBody } = await import('../../src/main/headroomProxy/usageParse')

/**
 * R1 criterion 1. A "pure retrieval turn" is a response whose only tool calls are retrieve_full:
 * it exists to fetch text the proxy elided, and everything it costs is a cost of eliding. The
 * fixtures below are shaped like real Messages streams (message_start, content blocks, message_delta)
 * so the parser is held to the wire format, not to a convenient subset of it.
 */

type Block = { type: 'thinking' } | { type: 'text'; text: string } | { type: 'tool_use'; name: string } | { type: 'server_tool_use'; name: string } | { type: 'mcp_tool_use'; name: string }

function startEvent(index: number, b: Block): string {
  const content_block =
    b.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' }
      : b.type === 'text' ? { type: 'text', text: '' }
        : { type: b.type, id: `toolu_${index}`, name: b.name, input: {} }
  return `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block })}\n`
}

function delta(index: number, b: Block): string {
  const d =
    b.type === 'thinking' ? { type: 'thinking_delta', thinking: 'hmm' }
      : b.type === 'text' ? { type: 'text_delta', text: b.text }
        : { type: 'input_json_delta', partial_json: '{"token":"hr_0123456789abcdef"}' }
  return `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: d })}\n`
}

/** A complete response stream: usage up front, one start/delta/stop triple per block, usage at the end. */
function stream(blocks: Block[], usage = { input: 6, read: 170_000, create: 300, output: 137 }): string {
  const parts: string[] = [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: { id: 'msg_01', type: 'message', role: 'assistant', content: [], model: 'claude-opus-5-5', stop_reason: null, usage: { input_tokens: usage.input, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.create, output_tokens: 1 } },
    })}\n`,
  ]
  blocks.forEach((b, i) => {
    parts.push(startEvent(i, b), delta(i, b), `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: i })}\n`)
  })
  parts.push(
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output } })}\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n`,
  )
  return parts.join('\n')
}

const retrieve = (name = 'retrieve_full'): Block => ({ type: 'tool_use', name })
const read: Block = { type: 'tool_use', name: 'Read' }
const think: Block = { type: 'thinking' }
const say: Block = { type: 'text', text: 'Let me fetch that.' }

describe('parseTurnShapeFromSse — golden streams', () => {
  it('a single retrieve_full is a pure retrieval turn', () => {
    expect(parseTurnShapeFromSse(stream([retrieve()]))).toEqual({ toolCalls: 1, retrieveCalls: 1, pure: true })
  })

  it('two retrieve_full calls in one response are still one pure turn', () => {
    expect(parseTurnShapeFromSse(stream([retrieve(), retrieve()]))).toEqual({ toolCalls: 2, retrieveCalls: 2, pure: true })
  })

  it('retrieve_full alongside Read is a mixed turn, not a pure one', () => {
    expect(parseTurnShapeFromSse(stream([retrieve(), read]))).toEqual({ toolCalls: 2, retrieveCalls: 1, pure: false })
    expect(parseTurnShapeFromSse(stream([read, retrieve()]))).toEqual({ toolCalls: 2, retrieveCalls: 1, pure: false })
  })

  it('a text-only end_turn calls no tool at all', () => {
    expect(parseTurnShapeFromSse(stream([say]))).toEqual({ toolCalls: 0, retrieveCalls: 0, pure: false })
  })

  it('thinking and text around the call do not change the verdict', () => {
    expect(parseTurnShapeFromSse(stream([think, say, retrieve()]))).toEqual({ toolCalls: 1, retrieveCalls: 1, pure: true })
  })

  it('a Read on its own is a tool turn but not a retrieval turn', () => {
    expect(parseTurnShapeFromSse(stream([read]))).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false })
  })

  it('sees through the MCP namespace Claude Code puts on the tool name', () => {
    expect(parseTurnShapeFromSse(stream([retrieve('mcp__termpolis__retrieve_full')])).pure).toBe(true)
  })

  it('sees through the plugin namespace too', () => {
    expect(parseTurnShapeFromSse(stream([retrieve('mcp__plugin_termpolis_termpolis__retrieve_full')])).pure).toBe(true)
  })

  it('does not take a tool that merely mentions retrieve_full for the real one', () => {
    for (const name of ['not_retrieve_full', 'retrieve_full_all', 'mcp__x__retrieve_fullish', 'Retrieve_Full']) {
      expect(parseTurnShapeFromSse(stream([retrieve(name)]))).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false })
    }
  })

  it('a server-side tool call next to retrieve_full makes the turn mixed', () => {
    const s = stream([{ type: 'server_tool_use', name: 'web_search' }, retrieve()])
    expect(parseTurnShapeFromSse(s)).toEqual({ toolCalls: 2, retrieveCalls: 1, pure: false })
  })

  it('an MCP tool call made by the server is a tool call too, and never a retrieve_full whatever it is named', () => {
    // Only a client-side tool_use can be the retrieve_full this app answers; a server-run MCP call with the
    // same name is somebody else's tool, and a turn that also made one is not a turn that only fetched.
    expect(parseTurnShapeFromSse(stream([{ type: 'mcp_tool_use', name: 'retrieve_full' }]))).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false })
    expect(parseTurnShapeFromSse(stream([retrieve(), { type: 'mcp_tool_use', name: 'search' }]))).toEqual({ toolCalls: 2, retrieveCalls: 1, pure: false })
  })

  it('reads a gzip-decoded body exactly like the plain one', () => {
    const s = stream([retrieve('mcp__termpolis__retrieve_full')])
    const decoded = decodeBody(zlib.gzipSync(Buffer.from(s)), 'gzip')
    expect(parseTurnShapeFromSse(decoded)).toEqual(parseTurnShapeFromSse(s))
    expect(parseTurnShapeFromSse(decoded).pure).toBe(true)
  })

  it('tolerates CRLF line endings', () => {
    const s = stream([retrieve()]).replace(/\n/g, '\r\n')
    expect(parseTurnShapeFromSse(s).pure).toBe(true)
  })

  it('does not disturb the usage parse: both read the same stream independently', () => {
    const s = stream([retrieve()], { input: 6, read: 170_000, create: 300, output: 137 })
    expect(parseUsageFromSse(s)).toEqual({ input_tokens: 6, cache_read_input_tokens: 170_000, cache_creation_input_tokens: 300, output_tokens: 137 })
    expect(parseTurnShapeFromSse(s).pure).toBe(true)
  })
})

describe('parseTurnShapeFromSse — damaged streams', () => {
  it('a stream cut off after the call started still counts the call', () => {
    const full = stream([retrieve()])
    const cut = full.slice(0, full.indexOf('event: content_block_delta'))
    expect(parseTurnShapeFromSse(cut)).toEqual({ toolCalls: 1, retrieveCalls: 1, pure: true })
  })

  it('a stream cut off INSIDE the line that starts the call sees no call', () => {
    const full = stream([retrieve()])
    const at = full.indexOf('"input":{}') // mid-JSON of the content_block_start line
    expect(at).toBeGreaterThan(0)
    expect(parseTurnShapeFromSse(full.slice(0, at))).toEqual({ toolCalls: 0, retrieveCalls: 0, pure: false })
  })

  it('garbled lines between good ones are skipped, not fatal', () => {
    const good = stream([retrieve()]).split('\n')
    const noisy = [
      'data: {not json at all', 'data:', 'data: [DONE]', 'data: null', 'data: 42', 'data: [1,2,3]', 'data: "a string"',
      '\u0000\u0001\u0002 binary junk', 'event: ??', ': comment', 'data: {"type":"content_block_start","content_block":',
      'data: {"type":"content_block_start","content_block":null}', 'data: {"type":"content_block_start"}',
      'data: {"type":"content_block_start","content_block":"tool_use"}',
      'data: {"type":"content_block_start","content_block":{"type":5,"name":"retrieve_full"}}',
      'data: {"type":"content_block_delta","note":"content_block_start"}',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use"}}',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":7}}',
    ]
    const mixed = [...noisy.slice(0, 7), ...good.slice(0, 4), ...noisy.slice(7), ...good.slice(4)].join('\n')
    expect(mixed).toContain('"content_block":"tool_use"') // the new junk lines are really in the stream
    // The two nameless tool_use starts still count as tool calls (the model did call something),
    // and neither is retrieve_full, so the stream is mixed rather than pure.
    expect(parseTurnShapeFromSse(mixed)).toEqual({ toolCalls: 3, retrieveCalls: 1, pure: false })
  })

  it('an error body or an empty stream is not a retrieval turn', () => {
    expect(parseTurnShapeFromSse('')).toEqual({ toolCalls: 0, retrieveCalls: 0, pure: false })
    expect(parseTurnShapeFromSse('{"type":"error","error":{"type":"overloaded_error","message":"x"}}')).toEqual({ toolCalls: 0, retrieveCalls: 0, pure: false })
    expect(parseTurnShapeFromSse('event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n')).toEqual({ toolCalls: 0, retrieveCalls: 0, pure: false })
  })

  it('is total: a non-string never throws and is never pure', () => {
    for (const bad of [undefined, null, 0, 12, {}, [], true]) {
      expect(() => parseTurnShapeFromSse(bad as unknown as string)).not.toThrow()
      expect(parseTurnShapeFromSse(bad as unknown as string).pure).toBe(false)
    }
  })
})

/** mulberry32: a tiny seeded generator, so a failure here replays exactly. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('parseTurnShapeFromSse — property', () => {
  it('never throws on 1,000 seeded random byte strings, and none of them is a retrieval turn', () => {
    const next = rng(0x5eed1)
    for (let n = 0; n < 1000; n++) {
      const len = Math.floor(next() * 4096)
      const bytes = Buffer.alloc(len)
      for (let i = 0; i < len; i++) bytes[i] = Math.floor(next() * 256)
      // Both ways a body can reach the parser: decoded as utf8 (decodeBody's fallback) and as latin1.
      for (const text of [bytes.toString('utf8'), bytes.toString('latin1')]) {
        let shape: ReturnType<typeof parseTurnShapeFromSse> | undefined
        expect(() => { shape = parseTurnShapeFromSse(text) }).not.toThrow()
        expect(shape?.pure).toBe(false)
      }
    }
  })

  it('never throws on random JSON-shaped fragments either, and pure always means at least one call, every one retrieve_full', () => {
    const next = rng(0xc0ffee)
    const pieces = ['data:', ' {', '"type"', ':', '"content_block_start"', ',', '"content_block"', '{', '}', '"tool_use"', '"name"', '"retrieve_full"', '[', ']', 'null', '\n', '\r\n', 'event: x', '"index"', '0']
    for (let n = 0; n < 1000; n++) {
      let s = ''
      const parts = 1 + Math.floor(next() * 40)
      for (let i = 0; i < parts; i++) s += pieces[Math.floor(next() * pieces.length)]
      let shape: ReturnType<typeof parseTurnShapeFromSse> | undefined
      expect(() => { shape = parseTurnShapeFromSse(s) }).not.toThrow()
      // Whatever it found, the verdict must agree with its own counts; random fragments must never
      // be able to break that.
      expect(shape?.pure).toBe((shape?.toolCalls ?? 0) > 0 && shape?.retrieveCalls === shape?.toolCalls)
    }
  })
})
