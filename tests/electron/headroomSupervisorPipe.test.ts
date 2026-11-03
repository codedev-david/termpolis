import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as http from 'http'
import { createProxyServer, resultFrame, stashFrame } from '../../src/main/headroomProxy/proxyMain'
import { setProxySpawner, onProxyResult, onProxyStash, startProxy, stopProxy, _resetProxyForTest } from '../../src/main/headroomProxy/proxySupervisor'
import { recordProxyResult, currentProxyTotals, resetProxyLedger } from '../../src/main/headroomProxy/proxyLedger'
import { ccrPut, resetCcr } from '../../src/main/headroom/ccrStore'
import { retrieveFull } from '../../src/main/headroom/compressToolResult'
import { elisionState, resetElisionLedger } from '../../src/main/headroom/elisionLedger'
import { summarizeUnifiedSavings } from '../../src/main/headroom/unifiedReceipt'
import { resetLedger } from '../../src/main/headroom/savingsLedger'
import { resetDepthCurveAll } from '../../src/main/headroom/sessionDepth'
import { setFirstSightPolicy } from '../../src/main/headroomProxy/wireCompress'

/**
 * The whole path a retrieval turn takes, with the one hop the other tests stand in for: the proxy child's server,
 * the frames it posts, the REAL supervisor's message dispatch (over a fake transport), the two callbacks index.ts
 * registers, the ledgers, the stash, retrieve_full and the receipt. headroomChildEntry holds the child's frames,
 * headroomFrameWiring holds what main does with a frame it is handed; neither sends a frame through the supervisor, so
 * a change there that rebuilt a message without its turn, its stats, its usage or its stash metadata would zero the
 * retrieval charge, the hop pairing, the stub tally or the classes of the elision ledger and nothing else would notice.
 *
 * Hand numbers (legacy policy, so a 36,000 character result is shortened on every tier; RF is the tool's full name):
 *   request 1  read 200,000  write 4,000  input 20  output 60   the answer asks ToolSearch for retrieve_full (a hop)
 *   request 2  read 204,000  write   600  input 12  output 140  the answer is a retrieve_full call alone (a retrieval turn)
 *   request 3  read 208,000  write 11,000 input 15  output 300  the answer is text; its request carries the result back
 *   a retrieval turn costs 0.1 x read + 5 x output units, and the hop is charged with the turn it led to:
 *   (0.1 x 200,000 + 5 x 60) + (0.1 x 204,000 + 5 x 140) = 20,300 + 21,100 = 41,400.
 */

const RF = 'mcp__termpolis__retrieve_full'
type Block = { tool?: { id: string; name: string; input: object }; text?: string }
const ev = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
function stream(o: { read: number; create: number; input: number; out: number; blocks: Block[] }): string {
  let s = ev('message_start', { message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: o.input, cache_read_input_tokens: o.read, cache_creation_input_tokens: o.create, output_tokens: 1 } } })
  o.blocks.forEach((b, i) => {
    if (b.tool) {
      s += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.tool.id, name: b.tool.name, input: {} } })
      s += ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.tool.input) } })
    } else {
      s += ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } })
      s += ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } })
    }
    s += ev('content_block_stop', { index: i })
  })
  return s + ev('message_delta', { delta: { stop_reason: o.blocks.some((b) => b.tool) ? 'tool_use' : 'end_turn' }, usage: { output_tokens: o.out } }) + ev('message_stop', {})
}
const search = (query: string): Block => ({ tool: { id: 'toolu_S', name: 'ToolSearch', input: { query } } })
const rf = (token: string): Block => ({ tool: { id: 'toolu_R', name: RF, input: { token } } })
const text = (t: string): Block => ({ text: t })

// The transport the supervisor spawns: a ready child whose messages are whatever the test's server posts.
let msgCb: (m: unknown) => void = () => undefined
function fakeSpawner(): unknown {
  return {
    postMessage: (m: { kind?: string; port?: number }) => { if (m?.kind === 'init') msgCb({ kind: 'ready', port: m.port }) },
    onMessage: (cb: (m: unknown) => void) => { msgCb = cb },
    onExit: () => undefined,
    kill: () => undefined,
    pid: 1,
  }
}

let upstream: http.Server
let proxy: http.Server
let proxyPort = 0
let reply = ''
let forwarded: string[] = []
let done: (() => void) | null = null

beforeAll(async () => {
  setFirstSightPolicy('legacy')
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { forwarded.push(Buffer.concat(chunks).toString('utf8')); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(reply) })
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
  const upPort = (upstream.address() as { port: number }).port
  // The child: posts frames as the entry does (the stash before the body leaves, the result after the answer).
  proxy = createProxyServer({
    upstreamHost: '127.0.0.1', upstreamPort: upPort, useHttps: false,
    onStash: (s) => msgCb(stashFrame(s)),
    onResult: (r) => { msgCb(resultFrame(r)); done?.() },
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
  proxyPort = (proxy.address() as { port: number }).port
})
afterAll(async () => {
  await new Promise<void>((r) => proxy.close(() => r()))
  await new Promise<void>((r) => upstream.close(() => r()))
})
beforeEach(() => {
  forwarded = []
  _resetProxyForTest(); setProxySpawner(fakeSpawner as never)
  resetProxyLedger(); resetCcr(); resetElisionLedger(); resetLedger(); resetDepthCurveAll()
  // The two registrations in index.ts, as they read there.
  onProxyResult((r) => { try { recordProxyResult(r) } catch { /* best effort */ } })
  onProxyStash((s) => { for (const st of s.stashes) { try { ccrPut(st.token, st.original, 'proxy', st.meta) } catch { /* best effort */ } } })
  startProxy({ port: 9999 })
})
afterEach(() => { stopProxy() })

const BIG = Array.from({ length: 600 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'abcdefghij'.repeat(5)}`).join('\n')
function post(messages: object[]): Promise<void> {
  return new Promise((resolve, reject) => {
    done = resolve
    const body = JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 100, stream: true, tools: [{ name: 'ToolSearch', description: 'd', input_schema: { type: 'object' } }, { name: 'Bash', description: 'd', input_schema: { type: 'object' } }], messages })
    const req = http.request({ hostname: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { res.on('data', () => undefined); res.on('end', () => undefined) })
    req.on('error', reject)
    req.end(body)
  })
}
const FIRST = { role: 'user', content: [{ type: 'text', text: 'dig into the build log' }] }
const bash = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_B', name: 'Bash', input: { command: 'cat log' } }] }
const bashRes = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: BIG }] }
const searchUse = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_S', name: 'ToolSearch', input: { query: 'select:mcp__termpolis__retrieve_full' } }] }
const searchRes = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_S', content: 'loaded' }] }

describe('child server -> real supervisor dispatch -> the callbacks index.ts installs -> ledgers -> retrieve_full -> receipt', () => {
  it('a hop, an ask and a redemption: every ledger moves by the hand numbers', async () => {
    // 1. An ordinary request is shortened; its answer asks to load retrieve_full.
    reply = stream({ read: 200_000, create: 4_000, input: 20, out: 60, blocks: [search('select:mcp__termpolis__retrieve_full')] })
    await post([FIRST, bash, bashRes])
    const t1 = currentProxyTotals()
    expect(t1.turnRequests).toBe(1) //                the shape of the turn arrived
    expect(t1.stubCompact).toBe(1) //                 the tally of the forwarded body arrived
    expect(t1.cacheReadTokens).toBe(200_000) //       the usage arrived
    expect(elisionState().classes['compact|Bash|10-40k']?.elided).toBe(1) // the stash and its metadata arrived (request-path frame)

    const fwd = JSON.parse(forwarded[0]) as { messages: Array<{ content: Array<{ type: string; content?: string }> }> }
    const stub = fwd.messages[2].content[0].content as string
    const token = /token "(hr_[0-9a-f]{16})"/.exec(stub)?.[1] as string
    expect(token).toBeTruthy()

    // 2. The request after the ToolSearch call; its answer is a retrieve_full call alone.
    reply = stream({ read: 204_000, create: 600, input: 12, out: 140, blocks: [rf(token)] })
    await post([FIRST, bash, bashRes, searchUse, searchRes])
    const t2 = currentProxyTotals()
    expect(t2.retrievalTurns).toBe(1) //              the turn and the conversation key arrived
    expect(t2.retrievalHops).toBe(1)
    expect(t2.retrievalTurnUnits).toBeCloseTo(0.1 * 200_000 + 5 * 60 + 0.1 * 204_000 + 5 * 140, 6) // 20,300 + 21,100

    // 3. The stash holds the original, and the redemption lands in the class it was filed under.
    expect(await retrieveFull(token)).toBe(BIG)
    expect(elisionState().classes['compact|Bash|10-40k']?.redeemed).toBe(1)
    expect(elisionState().legacyRedeemed).toBe(0)

    // 4. The request that carries the fetched text back: the asked-back characters are counted.
    reply = stream({ read: 208_000, create: 11_000, input: 15, out: 300, blocks: [text('found it')] })
    await post([FIRST, bash, bashRes, searchUse, searchRes, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_R', name: RF, input: { token } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_R', content: BIG }] }])
    const u = summarizeUnifiedSavings().cumulative
    expect(u.askedBackTokens).toBeGreaterThan(0)
    expect(u.retrievalTurns).toBe(1)
    expect(u.bill.retrievalTurnUnits).toBeCloseTo(41_400, 6)
    expect(u.stubKinds.compact).toBeGreaterThanOrEqual(3)
  }, 60_000)

  it('delivers a result frame to the registered callback whole: usage, turn, stats, status and the stash list', () => {
    const seen: Array<Record<string, unknown>> = []
    onProxyResult((r) => { seen.push(r as unknown as Record<string, unknown>) })
    const frame = {
      kind: 'result', changed: true, status: 200,
      usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
      turn: { toolCalls: 2, retrieveCalls: 1, pure: false },
      stats: { trBlocks: 1, convKey: 77, arm: 'late', kinds: { plain: 0, compact: 1, dedup: 0, diff: 0, aged: 0, agedEarly: 0 } },
      stashes: [],
    }
    msgCb(frame)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(frame)
    expect(seen[0].turn).toEqual({ toolCalls: 2, retrieveCalls: 1, pure: false })
    expect((seen[0].stats as { convKey: number; kinds: { compact: number } }).convKey).toBe(77)
    expect((seen[0].stats as { convKey: number; kinds: { compact: number } }).kinds.compact).toBe(1)
    expect(seen[0].usage).toEqual({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 })
  })

  it('delivers a stash frame to the registered callback whole: every entry with its metadata', () => {
    const seen: Array<{ stashes: Array<{ token: string; original: string; meta?: unknown }> }> = []
    onProxyStash((s) => { seen.push(s as never) })
    const meta = { kind: 'compact', tool: 'Bash', chars: 36_000, view: 2_100, policy: 'legacy', model: 'claude-opus-5-5' }
    msgCb({ kind: 'stash', stashes: [{ token: 'hr_0123456789abcdef', original: 'x'.repeat(40), meta }] })
    expect(seen).toHaveLength(1)
    expect(seen[0].stashes).toEqual([{ token: 'hr_0123456789abcdef', original: 'x'.repeat(40), meta }])
    expect(seen[0].stashes[0].meta).toEqual(meta)
  })

  // The result frame repeats the request's stash list. The stash frame is posted before the body leaves, and is
  // the one that matters; the result frame is the second chance if that one was lost, so an original the model
  // can be told to fetch is still there to hand back. Only the real dispatch can show that the second chance
  // reaches the ledger: the ledger's own tests hand it a result directly.
  it('keeps the originals a result frame carries when the stash frame ahead of it never arrived', async () => {
    const token = 'hr_1111111111111111'
    const original = 'the original text of a result the proxy shortened '.repeat(40)
    const meta = { kind: 'compact', tool: 'Read', chars: original.length, view: 800, policy: 'late' }
    msgCb({
      kind: 'result', changed: true, status: 200, turn: { toolCalls: 0, retrieveCalls: 0, pure: false },
      usage: { input_tokens: 1, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, output_tokens: 1 },
      stats: { trBlocks: 1, trOrigChars: original.length, trCompChars: 800 },
      stashes: [{ token, original, meta }],
    })
    expect(await retrieveFull(token)).toBe(original)
    // And the metadata rode with it: the redemption is filed under the class the stash was made in, not under none.
    const filed = Object.entries(elisionState().classes).filter(([key]) => key.startsWith('compact|Read'))
    expect(filed).toHaveLength(1)
    expect(filed[0][1].redeemed).toBe(1)
  })

  it('does not pass a frame on once no callback is registered, and does not throw into the transport when a callback does', () => {
    onProxyResult(null); onProxyStash(null)
    expect(() => { msgCb({ kind: 'result', usage: {} }); msgCb({ kind: 'stash', stashes: [] }) }).not.toThrow()
    onProxyResult(() => { throw new Error('a bad consumer') })
    onProxyStash(() => { throw new Error('a bad consumer') })
    expect(() => { msgCb({ kind: 'result', usage: {} }); msgCb({ kind: 'stash', stashes: [] }) }).not.toThrow()
  })
})
