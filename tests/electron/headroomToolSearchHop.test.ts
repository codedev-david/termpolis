import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as http from 'http'
import * as zlib from 'zlib'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProxyResultMsg } from '../../src/main/headroomProxy/proxySupervisor'
const { parseTurnShapeFromSse, decodeBody } = await import('../../src/main/headroomProxy/usageParse')
const { createProxyServer, resultFrame } = await import('../../src/main/headroomProxy/proxyMain')
const { rewriteMessagesBody } = await import('../../src/main/headroomProxy/wireCompress')
const {
  recordProxyResult, summarizeProxySavings, resetProxyLedger, resetProxyCounters, loadProxyBase,
  saveProxyTotalsToDisk, loadProxyBaseFromDisk,
} = await import('../../src/main/headroomProxy/proxyLedger')
const { armState } = await import('../../src/main/headroom/armLedger')
const { resetCcr } = await import('../../src/main/headroom/ccrStore')
const { resetDepthCurveAll } = await import('../../src/main/headroom/sessionDepth')

/**
 * R1 criterion 9. Claude Code runs with ENABLE_TOOL_SEARCH, so retrieve_full is usually a deferred
 * tool and a conversation's first ask arrives as TWO turns: one that calls ToolSearch to load the
 * tool, then the retrieve_full turn. The pair is ONE ask and both turns are charged; a ToolSearch
 * that loads any other tool is not an ask and costs the elision nothing; a ToolSearch that loads
 * retrieve_full and is not followed by a retrieve_full call is no ask either.
 */

type Call = { name: string; fragments?: string[]; kind?: 'tool_use' | 'server_tool_use' }
type Item = Call | { text: string } | 'think'

const search = (query: string, name = 'ToolSearch'): Call => ({ name, fragments: [JSON.stringify({ query, max_results: 1 })] })
const call = (name: string): Call => ({ name, fragments: ['{"token":"hr_0123456789abcdef"}'] })
const READ = call('Read')
const RETRIEVE = call('mcp__termpolis__retrieve_full')

function stream(items: Item[], usage = { input: 6, read: 52_000, create: 300, output: 90 }): string {
  const parts: string[] = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_01', role: 'assistant', content: [], usage: { input_tokens: usage.input, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.create, output_tokens: 1 } } })}\n`,
  ]
  items.forEach((it, i) => {
    if (it === 'think') {
      parts.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } })}\n`)
    } else if ('text' in it) {
      parts.push(
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })}\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: it.text } })}\n`,
      )
    } else {
      parts.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: it.kind ?? 'tool_use', id: `toolu_${i}`, name: it.name, input: {} } })}\n`)
      for (const f of it.fragments ?? []) parts.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: f } })}\n`)
    }
    parts.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: i })}\n`)
  })
  parts.push(
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: usage.output } })}\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n',
  )
  return parts.join('\n')
}

describe('parseTurnShapeFromSse: the ToolSearch hop, golden streams', () => {
  it('a ToolSearch that selects retrieve_full is a hop, and not a retrieval turn itself', () => {
    expect(parseTurnShapeFromSse(stream([search('select:mcp__termpolis__retrieve_full')]))).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false, hop: true })
  })

  it('sees the plugin namespace, the bare name and a keyword query', () => {
    for (const q of ['select:mcp__plugin_termpolis_termpolis__retrieve_full', 'select:retrieve_full', 'retrieve_full headroom', '+termpolis retrieve_full']) {
      expect(parseTurnShapeFromSse(stream([search(q)])).hop).toBe(true)
    }
  })

  it('assembles a query that arrives in pieces, even when the name is split across them', () => {
    const pieces = ['', '{"query":"sel', 'ect:mcp__termpolis__retri', 'eve_full","max_res', 'ults":1}']
    expect(parseTurnShapeFromSse(stream([{ name: 'ToolSearch', fragments: pieces }])).hop).toBe(true)
  })

  it('a ToolSearch that loads any other tool is not a hop', () => {
    for (const q of ['select:mcp__termpolis__read_output', 'select:Read,Grep', 'notebook jupyter', 'select:retrieve_full_all', 'select:mcp__x__retrieve_fullish', '']) {
      expect(parseTurnShapeFromSse(stream([search(q)]))).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false })
    }
  })

  it('names retrieve_full among several tools it loads: still a hop', () => {
    expect(parseTurnShapeFromSse(stream([search('select:mcp__termpolis__read_output,mcp__termpolis__retrieve_full')])).hop).toBe(true)
  })

  it('two ToolSearch calls, one of them for retrieve_full, make a hop turn', () => {
    expect(parseTurnShapeFromSse(stream([search('select:Read'), search('select:retrieve_full')]))).toEqual({ toolCalls: 2, retrieveCalls: 0, pure: false, hop: true })
  })

  it('a turn that does anything else besides is work the session wanted anyway: not a hop', () => {
    expect(parseTurnShapeFromSse(stream([search('select:retrieve_full'), READ]))).toEqual({ toolCalls: 2, retrieveCalls: 0, pure: false })
    expect(parseTurnShapeFromSse(stream([READ, search('select:retrieve_full')]))).toEqual({ toolCalls: 2, retrieveCalls: 0, pure: false })
    expect(parseTurnShapeFromSse(stream([search('select:retrieve_full'), RETRIEVE]))).toEqual({ toolCalls: 2, retrieveCalls: 1, pure: false })
  })

  it('thinking and text around the call do not change the verdict', () => {
    expect(parseTurnShapeFromSse(stream(['think', { text: 'I need the rest of that.' }, search('select:retrieve_full')])).hop).toBe(true)
  })

  it('only a tool_use named ToolSearch is a hop: a server-side search block with that name is not', () => {
    const shape = parseTurnShapeFromSse(stream([{ ...search('select:retrieve_full'), kind: 'server_tool_use' }]))
    expect(shape).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false })
  })

  it('a mention of retrieve_full in text or in another block\'s input is not a hop', () => {
    expect(parseTurnShapeFromSse(stream([{ text: 'select:mcp__termpolis__retrieve_full' }, search('select:Read')])).hop).toBeUndefined()
    // The Read block (index 0) streams input naming retrieve_full; the ToolSearch (index 1) selects Read.
    expect(parseTurnShapeFromSse(stream([{ name: 'Read', fragments: ['{"x":"retrieve_full"}'] }, search('select:Read')])).hop).toBeUndefined()
  })

  it('a stream cut before the query arrives shows no hop: the query is the only evidence', () => {
    const full = stream([search('select:mcp__termpolis__retrieve_full')])
    const cut = full.slice(0, full.indexOf('event: content_block_delta'))
    expect(parseTurnShapeFromSse(cut)).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false })
  })

  it('reads no more than the first 2,048 characters of a query', () => {
    const pad = 'x'.repeat(2100)
    expect(parseTurnShapeFromSse(stream([{ name: 'ToolSearch', fragments: [`{"query":"select:retrieve_full ${pad}`] }])).hop).toBe(true)
    expect(parseTurnShapeFromSse(stream([{ name: 'ToolSearch', fragments: [`{"query":"${pad} select:retrieve_full"}`] }])).hop).toBeUndefined()
  })

  it('follows at most 16 ToolSearch calls in one answer, and still counts every call', () => {
    const many: Item[] = Array.from({ length: 20 }, (_, i) => search(i === 17 ? 'select:retrieve_full' : 'select:Read'))
    const shape = parseTurnShapeFromSse(stream(many))
    expect(shape.toolCalls).toBe(20)
    expect(shape.hop).toBeUndefined() // the one that names it is past the limit
    const early: Item[] = Array.from({ length: 20 }, (_, i) => search(i === 3 ? 'select:retrieve_full' : 'select:Read'))
    expect(parseTurnShapeFromSse(stream(early)).hop).toBe(true)
  })

  it('skips what the prefilter lets through that is not a block start or a block delta, once a ToolSearch call has started', () => {
    // A line can carry the words without being the event: a ping that quotes them, a bare string, a null.
    const lines = stream([search('select:retrieve_full')]).split('\n')
    const at = lines.findIndex((l) => l.includes('content_block_start')) + 1 // right after the ToolSearch block started
    lines.splice(at, 0,
      'data: {"type":"ping","note":"input_json_delta"}',
      'data: "content_block_start"',
      'data: null',
      'data: 42',
    )
    expect(parseTurnShapeFromSse(lines.join('\n'))).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false, hop: true })
  })

  it('skips an input delta of the wrong shape once a ToolSearch call has started, and still reads the good ones', () => {
    const lines = stream([search('select:retrieve_full')]).split('\n')
    const at = lines.findIndex((l) => l.includes('content_block_start')) + 1
    lines.splice(at, 0,
      'data: {"type":"content_block_delta","index":"0","delta":{"type":"input_json_delta","partial_json":"zzz"}}', // index is not a number
      'data: {"type":"content_block_delta","index":0,"delta":null}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","note":"input_json_delta"}}', // not an input delta
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":7}}', // not text
      'data: {"type":"content_block_delta","index":9,"delta":{"type":"input_json_delta","partial_json":"retrieve_full"}}', // a block that is not a ToolSearch call
    )
    expect(parseTurnShapeFromSse(lines.join('\n')).hop).toBe(true)
  })

  it('attributes each delta to the block it belongs to: a stray delta for another index is no evidence', () => {
    const lines = stream([search('select:Read')]).split('\n')
    const at = lines.findIndex((l) => l.includes('content_block_start')) + 1
    lines.splice(at, 0, 'data: {"type":"content_block_delta","index":9,"delta":{"type":"input_json_delta","partial_json":"retrieve_full"}}')
    expect(parseTurnShapeFromSse(lines.join('\n'))).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false })
  })

  it('does not count a ToolSearch call whose block has no numeric index: the query cannot be attributed to it', () => {
    const noIndex = stream([search('select:retrieve_full')]).replace(/"index":\d+,/g, '')
    expect(parseTurnShapeFromSse(noIndex)).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false })
  })

  it('reads a deflate-encoded body, as it reads gzip and brotli', () => {
    const s = stream([search('select:retrieve_full')])
    expect(parseTurnShapeFromSse(decodeBody(zlib.deflateSync(Buffer.from(s)), 'deflate')).hop).toBe(true)
    expect(parseTurnShapeFromSse(decodeBody(zlib.brotliCompressSync(Buffer.from(s)), 'br')).hop).toBe(true)
    // and a body that claims an encoding it does not have falls back to the text it is
    expect(decodeBody(Buffer.from('plain'), 'gzip')).toBe('plain')
  })

  it('reads a gzip-decoded body exactly like the plain one', () => {
    const s = stream([search('select:mcp__termpolis__retrieve_full')])
    const decoded = decodeBody(zlib.gzipSync(Buffer.from(s)), 'gzip')
    expect(parseTurnShapeFromSse(decoded)).toEqual(parseTurnShapeFromSse(s))
    expect(parseTurnShapeFromSse(decoded).hop).toBe(true)
  })

  it('tolerates CRLF line endings and garbled lines between good ones', () => {
    const s = stream([search('select:retrieve_full')]).replace(/\n/g, '\r\n')
    expect(parseTurnShapeFromSse(s).hop).toBe(true)
    const noisy = stream([search('select:retrieve_full')]).split('\n')
    noisy.splice(4, 0, 'data: {not json', 'data: {"type":"content_block_delta","index":0,"delta":null}', 'data: {"type":"content_block_delta","index":"0","delta":{"type":"input_json_delta","partial_json":"zzz"}}', 'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":7}}')
    expect(parseTurnShapeFromSse(noisy.join('\n')).hop).toBe(true)
  })

  it('a retrieval turn is not a hop and a hop is not a retrieval turn', () => {
    const r = parseTurnShapeFromSse(stream([RETRIEVE]))
    expect(r).toEqual({ toolCalls: 1, retrieveCalls: 1, pure: true })
    const h = parseTurnShapeFromSse(stream([search('select:retrieve_full')]))
    expect(h.pure).toBe(false)
  })
})

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

describe('parseTurnShapeFromSse: the ToolSearch hop, property', () => {
  it('never throws on 1,000 seeded random fragments built from the hop\'s own vocabulary, and a hop is never pure', () => {
    const next = rng(0x7001)
    const pieces = [
      'data:', ' {', '"type"', ':', '"content_block_start"', '"content_block_delta"', ',', '"content_block"', '{', '}', '"tool_use"',
      '"name"', '"ToolSearch"', '"retrieve_full"', '"delta"', '"input_json_delta"', '"partial_json"', '"select:retrieve_full"', '[', ']',
      'null', '\n', '\r\n', 'event: x', '"index"', '0', '1', '"0"',
    ]
    for (let n = 0; n < 1000; n++) {
      let s = ''
      const parts = 1 + Math.floor(next() * 60)
      for (let i = 0; i < parts; i++) s += pieces[Math.floor(next() * pieces.length)]
      let shape: ReturnType<typeof parseTurnShapeFromSse> | undefined
      expect(() => { shape = parseTurnShapeFromSse(s) }).not.toThrow()
      expect(shape?.pure).toBe((shape?.toolCalls ?? 0) > 0 && shape?.retrieveCalls === shape?.toolCalls)
      if (shape?.hop) {
        expect(shape.pure).toBe(false)
        expect(shape.toolCalls).toBeGreaterThan(0)
        expect(shape.retrieveCalls).toBe(0)
      }
    }
  })

  it('never throws on 1,000 seeded random streams of real events, and agrees with a plain recount', () => {
    const next = rng(0x7002)
    const queries = ['select:retrieve_full', 'select:Read', 'retrieve_full', '', 'select:mcp__termpolis__retrieve_full,Grep']
    const names = ['ToolSearch', 'Read', 'mcp__termpolis__retrieve_full', 'Bash']
    for (let n = 0; n < 1000; n++) {
      const items: Item[] = []
      const k = Math.floor(next() * 4)
      for (let i = 0; i < k; i++) {
        const name = names[Math.floor(next() * names.length)]
        items.push(name === 'ToolSearch' ? search(queries[Math.floor(next() * queries.length)]) : call(name))
      }
      const shape = parseTurnShapeFromSse(stream(items))
      const calls = items.filter((i): i is Call => typeof i === 'object' && 'name' in i)
      const searches = calls.filter((c) => c.name === 'ToolSearch')
      const loads = searches.some((c) => /retrieve_full/.test(c.fragments?.[0] ?? ''))
      const retrieves = calls.filter((c) => c.name.endsWith('retrieve_full')).length
      expect(shape.toolCalls).toBe(calls.length)
      expect(shape.retrieveCalls).toBe(retrieves)
      expect(!!shape.hop).toBe(calls.length > 0 && searches.length === calls.length && loads)
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// The ledger: one ask, two turns, both charged.

const usage = (read: number, out: number, create = 500, input = 10) =>
  ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: create, output_tokens: out })

type Turn = { toolCalls: number; retrieveCalls: number; pure: boolean; hop?: true }
const HOP: Turn = { toolCalls: 1, retrieveCalls: 0, pure: false, hop: true }
const PURE: Turn = { toolCalls: 1, retrieveCalls: 1, pure: true }
const MIXED: Turn = { toolCalls: 2, retrieveCalls: 1, pure: false }
const WORK: Turn = { toolCalls: 1, retrieveCalls: 0, pure: false }
const TEXT: Turn = { toolCalls: 0, retrieveCalls: 0, pure: false }

function msg(u: ReturnType<typeof usage>, turn: Turn | undefined, conv: number | undefined, extra: { status?: number; arm?: string; cluster?: number } = {}): ProxyResultMsg {
  const stats: Record<string, unknown> = { trBlocks: 0, trOrigChars: 0, trCompChars: 0, images: 0, imgOrigBytes: 0, imgCompBytes: 0 }
  if (conv !== undefined) stats.convKey = conv
  if (extra.arm) { stats.arm = extra.arm; stats.armCluster = extra.cluster ?? 0 }
  const m: Record<string, unknown> = { kind: 'result', changed: false, stashes: [], status: extra.status ?? 200, stats, usage: u }
  if (turn) m.turn = turn
  return m as unknown as ProxyResultMsg
}

/** The charge written out from the spec rather than imported: 0.1 x cache_read + 5 x output. */
const charge = (read: number, out: number): number => 0.1 * read + 5 * out

let dir: string
beforeEach(() => { resetProxyLedger(); resetCcr(); resetDepthCurveAll(); dir = mkdtempSync(join(tmpdir(), 'tp-hop-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('the ledger charges the pair: ToolSearch hop then retrieve_full', () => {
  it('a hop followed by a pure retrieval turn of the same conversation is ONE ask with BOTH turns charged', () => {
    recordProxyResult(msg(usage(52_000, 90), HOP, 111))
    recordProxyResult(msg(usage(52_500, 140), PURE, 111))
    const s = summarizeProxySavings().session
    expect(s.retrievalTurns).toBe(1)
    expect(s.retrievalHops).toBe(1)
    expect(s.retrievalTurnUnits).toBeCloseTo(charge(52_000, 90) + charge(52_500, 140), 6)
    expect(s.retrievalTurnUnits).toBeCloseTo(5_650 + 5_950, 6)
  })

  it('the hop alone charges nothing yet, and counts no ask', () => {
    recordProxyResult(msg(usage(52_000, 90), HOP, 111))
    const s = summarizeProxySavings().session
    expect(s.retrievalTurns).toBe(0)
    expect(s.retrievalHops).toBe(0)
    expect(s.retrievalTurnUnits).toBe(0)
  })

  it('a hop never followed by retrieve_full counts no ask, whatever comes next in that conversation', () => {
    for (const next of [MIXED, WORK, TEXT, undefined]) {
      resetProxyLedger()
      recordProxyResult(msg(usage(52_000, 90), HOP, 111))
      recordProxyResult(msg(usage(53_000, 400), next, 111))
      // A retrieve_full turn that arrives later must not pick up the dropped hop.
      recordProxyResult(msg(usage(54_000, 120), PURE, 111))
      const s = summarizeProxySavings().session
      expect(s.retrievalHops).toBe(0)
      expect(s.retrievalTurns).toBe(1)
      expect(s.retrievalTurnUnits).toBeCloseTo(charge(54_000, 120), 6)
    }
  })

  it('a hop followed by another hop charges only the second one, and only when an ask follows it', () => {
    recordProxyResult(msg(usage(50_000, 80), HOP, 7))
    recordProxyResult(msg(usage(51_000, 100), HOP, 7))
    recordProxyResult(msg(usage(52_000, 120), PURE, 7))
    const s = summarizeProxySavings().session
    expect(s.retrievalHops).toBe(1)
    expect(s.retrievalTurnUnits).toBeCloseTo(charge(51_000, 100) + charge(52_000, 120), 6)
  })

  it('does not pair across conversations: another conversation\'s retrieval turn leaves the hop waiting', () => {
    recordProxyResult(msg(usage(52_000, 90), HOP, 111))
    recordProxyResult(msg(usage(40_000, 70), PURE, 222)) // somebody else
    let s = summarizeProxySavings().session
    expect(s.retrievalHops).toBe(0)
    expect(s.retrievalTurnUnits).toBeCloseTo(charge(40_000, 70), 6)
    recordProxyResult(msg(usage(52_500, 140), PURE, 111))
    s = summarizeProxySavings().session
    expect(s.retrievalHops).toBe(1)
    expect(s.retrievalTurns).toBe(2)
    expect(s.retrievalTurnUnits).toBeCloseTo(charge(40_000, 70) + charge(52_000, 90) + charge(52_500, 140), 6)
  })

  it('two conversations\' pairs interleave without crossing', () => {
    recordProxyResult(msg(usage(10_000, 10), HOP, 1))
    recordProxyResult(msg(usage(20_000, 20), HOP, 2))
    recordProxyResult(msg(usage(21_000, 30), PURE, 2))
    recordProxyResult(msg(usage(11_000, 40), PURE, 1))
    const s = summarizeProxySavings().session
    expect(s.retrievalHops).toBe(2)
    expect(s.retrievalTurns).toBe(2)
    expect(s.retrievalTurnUnits).toBeCloseTo(charge(10_000, 10) + charge(20_000, 20) + charge(21_000, 30) + charge(11_000, 40), 6)
  })

  it('without a conversation key nothing can be paired, so the hop is never charged and the ask is charged alone', () => {
    for (const key of [undefined, 0, -3, Number.NaN, '5' as unknown as number]) {
      resetProxyLedger()
      recordProxyResult(msg(usage(52_000, 90), HOP, key))
      recordProxyResult(msg(usage(52_500, 140), PURE, key))
      const s = summarizeProxySavings().session
      expect(s.retrievalHops).toBe(0)
      expect(s.retrievalTurns).toBe(1)
      expect(s.retrievalTurnUnits).toBeCloseTo(charge(52_500, 140), 6)
    }
  })

  it('a refused request neither sets nor settles a hop', () => {
    recordProxyResult(msg(usage(52_000, 90), HOP, 111, { status: 529 }))
    recordProxyResult(msg(usage(52_500, 140), PURE, 111))
    expect(summarizeProxySavings().session.retrievalHops).toBe(0)
    resetProxyLedger()
    recordProxyResult(msg(usage(52_000, 90), HOP, 111))
    recordProxyResult(msg(usage(0, 0), TEXT, 111, { status: 429 })) // the refused retry between the two
    recordProxyResult(msg(usage(52_500, 140), PURE, 111))
    const s = summarizeProxySavings().session
    expect(s.retrievalHops).toBe(1)
    expect(s.retrievalTurnUnits).toBeCloseTo(charge(52_000, 90) + charge(52_500, 140), 6)
  })

  it('a hop with a missing usage block is remembered at zero cost and still counts as the pair\'s first turn', () => {
    const hop = msg(usage(0, 0), HOP, 9) as unknown as Record<string, unknown>
    delete hop.usage
    recordProxyResult(hop as unknown as ProxyResultMsg)
    recordProxyResult(msg(usage(52_500, 140), PURE, 9))
    const s = summarizeProxySavings().session
    expect(s.retrievalHops).toBe(1)
    expect(s.retrievalTurnUnits).toBeCloseTo(charge(52_500, 140), 6)
  })

  it('remembers at most 256 waiting hops: the oldest are forgotten, the newest still pair', () => {
    for (let k = 1; k <= 300; k++) recordProxyResult(msg(usage(1_000, 1), HOP, k))
    recordProxyResult(msg(usage(2_000, 2), PURE, 1)) // evicted
    recordProxyResult(msg(usage(2_000, 2), PURE, 300)) // kept
    const s = summarizeProxySavings().session
    expect(s.retrievalHops).toBe(1)
    expect(s.retrievalTurns).toBe(2)
  })

  it('a refreshed hop moves to the back of the line: re-hopping a conversation keeps it from being the next evicted', () => {
    // Each key's hop costs a different amount (100 + 5 x key), so WHICH hop paired shows in the units.
    for (let k = 1; k <= 256; k++) recordProxyResult(msg(usage(1_000, k), HOP, k))
    recordProxyResult(msg(usage(1_000, 1), HOP, 1)) // key 1 again: refreshed, now the newest
    recordProxyResult(msg(usage(1_000, 999), HOP, 999)) // one more: the oldest (key 2) goes, not key 1
    recordProxyResult(msg(usage(2_000, 2), PURE, 1)) // pairs with key 1's refreshed hop: 105 + 210
    recordProxyResult(msg(usage(2_000, 2), PURE, 2)) // key 2's was evicted: its own 210 only
    const s = summarizeProxySavings().session
    expect(s.retrievalHops).toBe(1)
    expect(s.retrievalTurnUnits).toBeCloseTo(charge(1_000, 1) + charge(2_000, 2) + charge(2_000, 2), 6)
  })

  it('zeroing the counters forgets the waiting hops', () => {
    recordProxyResult(msg(usage(52_000, 90), HOP, 111))
    resetProxyCounters()
    recordProxyResult(msg(usage(52_500, 140), PURE, 111))
    expect(summarizeProxySavings().session.retrievalHops).toBe(0)
    resetProxyLedger()
    recordProxyResult(msg(usage(52_000, 90), HOP, 111))
    resetProxyLedger()
    recordProxyResult(msg(usage(52_500, 140), PURE, 111))
    expect(summarizeProxySavings().session.retrievalHops).toBe(0)
  })

  it('the totals survive a save and a load, and a file from before the hop loads with zeros', () => {
    recordProxyResult(msg(usage(52_000, 90), HOP, 111))
    recordProxyResult(msg(usage(52_500, 140), PURE, 111))
    saveProxyTotalsToDisk(dir)
    resetProxyLedger()
    loadProxyBaseFromDisk(dir)
    const t = summarizeProxySavings().cumulative
    expect(t.retrievalHops).toBe(1)
    expect(t.retrievalTurns).toBe(1)
    expect(t.retrievalTurnUnits).toBeCloseTo(11_600, 6)
    // A v1.54-shaped file: none of the newer counters.
    resetProxyLedger()
    loadProxyBase({ requests: 5, retrieves: 2 })
    const old = summarizeProxySavings().cumulative
    expect(old.retrievalHops).toBe(0)
    // And one damaged in the new field reads as zero rather than turning every later sum to NaN.
    loadProxyBase({ retrievalHops: 'x' as unknown as number })
    recordProxyResult(msg(usage(1_000, 1), PURE, 3))
    expect(Number.isFinite(summarizeProxySavings().cumulative.retrievalHops)).toBe(true)
  })
})

describe('the arm ledger sees the hop as part of the ask, not as work', () => {
  const lateMsg = (u: ReturnType<typeof usage>, turn: Turn, conv: number) => msg(u, turn, conv, { arm: 'late', cluster: 3 })

  it('moves the hop out of the work column once its ask arrives, and adds its turn units', () => {
    recordProxyResult(lateMsg(usage(52_000, 90), HOP, 111))
    let c = armState().late[3]
    expect(c).toMatchObject({ requests: 1, work: 1, turns: 0, turnUnits: 0 })
    recordProxyResult(lateMsg(usage(52_500, 140), PURE, 111))
    c = armState().late[3]
    expect(c.requests).toBe(2)
    expect(c.work).toBe(0)
    expect(c.turns).toBe(2)
    expect(c.turnUnits).toBeCloseTo(charge(52_000, 90) + charge(52_500, 140), 6)
    // units: input 10 + cache read 0.1x + cache write 1.25x on 500 + output 5x, for both requests.
    expect(c.units).toBeCloseTo((10 + 5_200 + 625 + 450) + (10 + 5_250 + 625 + 700), 6)
  })

  it('leaves a hop that no ask followed as ordinary work', () => {
    recordProxyResult(lateMsg(usage(52_000, 90), HOP, 111))
    recordProxyResult(lateMsg(usage(53_000, 400), WORK, 111))
    const c = armState().late[3]
    expect(c).toMatchObject({ requests: 2, work: 2, turns: 0, turnUnits: 0 })
  })

  it('files the hop in the same group the pair was recorded in, for the holdout and the kill switch too', () => {
    recordProxyResult(msg(usage(52_000, 90), HOP, 5, { arm: 'holdout', cluster: 7 }))
    recordProxyResult(msg(usage(52_500, 140), PURE, 5, { arm: 'holdout', cluster: 7 }))
    expect(armState().holdout[7]).toMatchObject({ requests: 2, work: 0, turns: 2 })
    recordProxyResult(msg(usage(52_000, 90), HOP, 6, { arm: 'legacy' }))
    recordProxyResult(msg(usage(52_500, 140), PURE, 6, { arm: 'legacy' }))
    expect(armState().legacy).toMatchObject({ requests: 2, work: 0, turns: 2 })
  })

  it('never takes the work count below zero when the ledger was zeroed in between', () => {
    recordProxyResult(lateMsg(usage(52_000, 90), HOP, 111))
    resetProxyCounters()
    recordProxyResult(lateMsg(usage(52_500, 140), PURE, 111))
    const c = armState().late[3]
    expect(c.work).toBeGreaterThanOrEqual(0)
    expect(c.turns).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------
// End to end: the real proxy server reads the request and the answer, resultFrame carries them to the
// ledger, and the pair is charged. A deferred retrieve_full is the shape the app forces.

describe('through the real proxy server and the result frame', () => {
  let answer = ''
  let results: Array<Parameters<typeof resultFrame>[0]> = []
  let stub: http.Server, proxy: http.Server, proxyPort: number

  beforeEach(async () => {
    results = []
    stub = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(answer) })
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
    proxy = createProxyServer({
      upstreamHost: '127.0.0.1', upstreamPort: (stub.address() as { port: number }).port, useHttps: false,
      onResult: (r) => results.push(r),
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
    proxyPort = (proxy.address() as { port: number }).port
  })
  afterEach(() => { stub.close(); proxy.close() })

  function post(body: unknown): Promise<void> {
    const s = JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) } }, (res) => { res.resume(); res.on('end', () => resolve()) })
      req.on('error', reject); req.write(s); req.end()
    })
  }
  const first = { role: 'user', content: 'Please find out why the build is red and fix it, then tell me what you changed in src/main.' }
  const toolSearchTool = { name: 'ToolSearch', description: 'load deferred tools', input_schema: { type: 'object' } }
  const retrieveTool = { name: 'mcp__termpolis__retrieve_full', description: 'expand', input_schema: { type: 'object' } }

  it('charges both turns of a first ask and tallies the request that could ask', async () => {
    answer = stream([search('select:mcp__termpolis__retrieve_full')], { input: 10, read: 52_000, create: 500, output: 90 })
    await post({ model: 'claude-opus-5-5', tools: [toolSearchTool], messages: [first] })
    answer = stream([RETRIEVE], { input: 10, read: 52_500, create: 500, output: 140 })
    await post({
      model: 'claude-opus-5-5', tools: [toolSearchTool, retrieveTool],
      messages: [first, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_0', name: 'ToolSearch', input: { query: 'select:mcp__termpolis__retrieve_full' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'loaded' }] }],
    })
    expect(results).toHaveLength(2)
    expect(results[0].turn).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false, hop: true })
    expect(results[1].turn).toEqual({ toolCalls: 1, retrieveCalls: 1, pure: true })
    // Both requests are one conversation: they carry the same key.
    expect(results[0].stats.convKey).toBeGreaterThan(0)
    expect(results[1].stats.convKey).toBe(results[0].stats.convKey)
    for (const r of results) recordProxyResult(resultFrame(r) as unknown as ProxyResultMsg)
    const s = summarizeProxySavings().session
    expect(s.retrievalTurns).toBe(1)
    expect(s.retrievalHops).toBe(1)
    expect(s.retrievalTurnUnits).toBeCloseTo(5_650 + 5_950, 6)
  })

  it('charges nothing for a ToolSearch that loads another tool', async () => {
    answer = stream([search('select:mcp__termpolis__read_output')], { input: 10, read: 52_000, create: 500, output: 90 })
    await post({ model: 'claude-opus-5-5', tools: [toolSearchTool], messages: [first] })
    answer = stream([RETRIEVE], { input: 10, read: 52_500, create: 500, output: 140 })
    await post({ model: 'claude-opus-5-5', tools: [toolSearchTool, retrieveTool], messages: [first, { role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }] })
    for (const r of results) recordProxyResult(resultFrame(r) as unknown as ProxyResultMsg)
    const s = summarizeProxySavings().session
    expect(s.retrievalHops).toBe(0)
    expect(s.retrievalTurnUnits).toBeCloseTo(5_950, 6)
  })

  it('pairs under the kill switch too: this process runs the default (legacy) policy, and the key is there anyway', async () => {
    answer = stream([search('select:retrieve_full')])
    await post({ model: 'm', tools: [toolSearchTool], messages: [first] })
    expect(results[0].stats.arm).toBe('legacy')
    expect(results[0].stats.convKey).toBeGreaterThan(0)
  })

  it('a first message with no text has no conversation key, so nothing about it can be paired', async () => {
    answer = stream([search('select:retrieve_full')])
    await post({ model: 'm', tools: [toolSearchTool], messages: [{ role: 'user', content: [] }] })
    expect(results[0].stats.convKey).toBe(0)
  })

  it('the frame the child posts carries every field the ledger reads, and nothing is dropped on the way', async () => {
    answer = stream([search('select:retrieve_full')], { input: 10, read: 52_000, create: 500, output: 90 })
    await post({ model: 'm', tools: [toolSearchTool], messages: [first] })
    const r = results[0]
    expect(resultFrame(r)).toEqual({ kind: 'result', changed: r.changed, stats: r.stats, usage: r.usage, turn: r.turn, stashes: r.stashes, status: r.status })
    expect(resultFrame(r).turn).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false, hop: true })
    expect(resultFrame(r).usage).toEqual({ input_tokens: 10, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 500, output_tokens: 90 })
  })
})

// ---------------------------------------------------------------------------------------------------
// R1 criterion 10: the ledger knows whether a request could ask.

describe('whether the request could ask for elided text back', () => {
  const tool = (name: string): Record<string, unknown> => ({ name, description: 'x', input_schema: { type: 'object' } })
  const body = (tools: unknown): string => JSON.stringify({ model: 'm', ...(tools === undefined ? {} : { tools }), messages: [{ role: 'user', content: 'Please look into the failing build.' }] })
  const offer = (tools: unknown): string => rewriteMessagesBody(body(tools)).stats.retrieveOffer

  it('direct: retrieve_full is in the tools list, under any of its names', () => {
    for (const name of ['retrieve_full', 'mcp__termpolis__retrieve_full', 'mcp__plugin_termpolis_termpolis__retrieve_full']) {
      expect(offer([tool('Read'), tool(name)]), name).toBe('direct')
      expect(offer([tool('ToolSearch'), tool(name)]), `${name} beside a ToolSearch tool`).toBe('direct')
    }
  })

  it('deferred: no retrieve_full, but a ToolSearch tool to load it through', () => {
    expect(offer([tool('Read'), tool('ToolSearch')])).toBe('deferred')
    expect(offer([tool('mcp__x__ToolSearch')])).toBe('deferred')
  })

  it('absent: neither, an empty list, no list, or a list that is not one', () => {
    expect(offer([tool('Read'), tool('Bash')])).toBe('absent')
    expect(offer([])).toBe('absent')
    expect(offer(undefined)).toBe('absent')
    expect(offer('tools')).toBe('absent')
    expect(offer({ name: 'retrieve_full' })).toBe('absent')
  })

  it('does not take a name that merely contains the words for the real one', () => {
    for (const name of ['not_retrieve_full', 'retrieve_full_all', 'mcp__x__retrieve_fullish', 'Retrieve_Full', 'ToolSearch2', 'toolsearch', 'MyToolSearch']) {
      expect(offer([tool(name)]), name).toBe('absent')
    }
  })

  it('survives tools that are not objects, have no name or a name that is not a string', () => {
    expect(offer([null, 7, 'retrieve_full', [], { description: 'no name' }, { name: 5 }, tool('ToolSearch')])).toBe('deferred')
    expect(offer([null, undefined, 3])).toBe('absent')
  })

  it('is unknown for a body that was not read as a Messages request', () => {
    expect(rewriteMessagesBody('{not json').stats.retrieveOffer).toBe('unknown')
    expect(rewriteMessagesBody(JSON.stringify({ model: 'm' })).stats.retrieveOffer).toBe('unknown')
  })

  it('is measured even when the body is left alone because it does not round-trip', () => {
    // A number past 2^53 makes the rewriter decline to touch the body; what was offered is still true.
    const raw = '{"model":"m","big":12345678901234567890,"tools":[{"name":"ToolSearch"}],"messages":[{"role":"user","content":"hello there"}]}'
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
    expect(r.stats.retrieveOffer).toBe('deferred')
  })

  it('changes no byte of what is forwarded: the messages come out the same whatever the tools list says', () => {
    const big = Array.from({ length: 700 }, (_, i) => `row ${i}: the quick brown fox ${i * 31} jumps over the lazy dog`).join('\n')
    const messages = [
      { role: 'user', content: 'Please read the log and summarise it.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat build.log' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: big }] },
    ]
    const variants = [undefined, [], [tool('Read')], [tool('ToolSearch')], [tool('mcp__termpolis__retrieve_full')], [tool('ToolSearch'), tool('mcp__termpolis__retrieve_full')]]
    const outs = variants.map((tools) => rewriteMessagesBody(JSON.stringify({ model: 'm', ...(tools === undefined ? {} : { tools }), messages })))
    for (const o of outs) expect(o.changed).toBe(true)
    const messagesOf = (o: { body: string }): unknown => (JSON.parse(o.body) as { messages: unknown }).messages
    for (const o of outs) expect(messagesOf(o)).toEqual(messagesOf(outs[0]))
    expect(outs.map((o) => o.stats.retrieveOffer)).toEqual(['absent', 'absent', 'absent', 'deferred', 'direct', 'direct'])
    // And the tools the client sent ride through untouched.
    expect((JSON.parse(outs[5].body) as { tools: unknown }).tools).toEqual(variants[5])
  })
})

describe('the ledger tallies what each request could do, and an old file loads as zeros', () => {
  const tool = (name: string): Record<string, unknown> => ({ name, description: 'x', input_schema: { type: 'object' } })
  // `null` is a response whose shape was not read (a child older than the field); undefined takes the default.
  const withOffer = (offer: string | undefined, status = 200, turn: Turn | null = WORK): ProxyResultMsg => {
    const m = msg(usage(1_000, 10), turn ?? undefined, undefined, { status }) as unknown as { stats: Record<string, unknown> }
    if (offer !== undefined) m.stats.retrieveOffer = offer
    return m as unknown as ProxyResultMsg
  }

  it('counts each completed response under direct, deferred or absent, and the rest under none of them', () => {
    for (const o of ['direct', 'direct', 'direct', 'deferred', 'deferred', 'absent']) recordProxyResult(withOffer(o))
    recordProxyResult(withOffer('unknown'))
    recordProxyResult(withOffer(undefined))
    recordProxyResult(withOffer('direct', 529)) // refused: tells nothing about whether it could ask
    recordProxyResult(withOffer('banana'))
    const s = summarizeProxySavings().session
    expect(s.offerDirect).toBe(3)
    expect(s.offerDeferred).toBe(2)
    expect(s.offerAbsent).toBe(1)
    expect(s.turnRequests).toBe(10) // every response whose shape was read, whatever it could do
  })

  it('does not count a response whose shape was not read', () => {
    recordProxyResult(withOffer('direct', 200, null))
    expect(summarizeProxySavings().session.offerDirect).toBe(0)
  })

  it('keeps the tallies across a save and a load, and sums them with the base', () => {
    recordProxyResult(withOffer('direct'))
    recordProxyResult(withOffer('absent'))
    saveProxyTotalsToDisk(dir)
    resetProxyLedger()
    loadProxyBaseFromDisk(dir)
    recordProxyResult(withOffer('deferred'))
    const t = summarizeProxySavings()
    expect(t.session).toMatchObject({ offerDirect: 0, offerDeferred: 1, offerAbsent: 0 })
    expect(t.cumulative).toMatchObject({ offerDirect: 1, offerDeferred: 1, offerAbsent: 1 })
  })

  it('loads a file from before them as zeros, and a damaged one the same', () => {
    loadProxyBase({ requests: 40, retrieves: 3, turnRequests: 40 })
    expect(summarizeProxySavings().cumulative).toMatchObject({ offerDirect: 0, offerDeferred: 0, offerAbsent: 0, retrievalHops: 0 })
    loadProxyBase({ offerDirect: 'x', offerDeferred: -4, offerAbsent: Number.NaN, retrievalHops: null } as unknown as Record<string, number>)
    expect(summarizeProxySavings().cumulative).toMatchObject({ offerDirect: 0, offerDeferred: 0, offerAbsent: 0, retrievalHops: 0 })
  })

  it('reaches the ledger from a real request through the proxy: a deferred first ask, then a direct one', async () => {
    const results: Array<Parameters<typeof resultFrame>[0]> = []
    const stub = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(stream([search('select:retrieve_full')])) }) })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
    const proxy = createProxyServer({ upstreamHost: '127.0.0.1', upstreamPort: (stub.address() as { port: number }).port, useHttps: false, onResult: (r) => results.push(r) })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
    const port = (proxy.address() as { port: number }).port
    const post = (b: unknown): Promise<void> => new Promise((resolve, reject) => {
      const s = JSON.stringify(b)
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) } }, (res) => { res.resume(); res.on('end', () => resolve()) })
      req.on('error', reject); req.write(s); req.end()
    })
    const first = { role: 'user', content: 'Please look into the failing build and tell me what you find.' }
    try {
      await post({ model: 'm', tools: [tool('ToolSearch')], messages: [first] })
      await post({ model: 'm', tools: [tool('ToolSearch'), tool('mcp__termpolis__retrieve_full')], messages: [first] })
      await post({ model: 'm', tools: [tool('Read')], messages: [first] })
    } finally { stub.close(); proxy.close() }
    expect(results.map((r) => r.stats.retrieveOffer)).toEqual(['deferred', 'direct', 'absent'])
    for (const r of results) recordProxyResult(resultFrame(r))
    expect(summarizeProxySavings().session).toMatchObject({ offerDirect: 1, offerDeferred: 1, offerAbsent: 1 })
  })
})
