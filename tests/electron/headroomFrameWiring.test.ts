import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as http from 'http'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProxyResultMsg, ProxyStashMsg } from '../../src/main/headroomProxy/proxySupervisor'
const { createProxyServer, resultFrame, stashFrame } = await import('../../src/main/headroomProxy/proxyMain')
const {
  recordProxyResult, recordProxyGiveback, summarizeProxySavings, resetProxyLedger, resetProxyCounters,
  saveProxyTotalsToDisk, loadProxyBaseFromDisk,
} = await import('../../src/main/headroomProxy/proxyLedger')
const { elisionState, recentByClass, recordElision, recordRedemption } = await import('../../src/main/headroom/elisionLedger')
const { ccrPut, ccrMarkRedeemed, resetCcr } = await import('../../src/main/headroom/ccrStore')
const { resetDepthCurveAll } = await import('../../src/main/headroom/sessionDepth')
const { armState } = await import('../../src/main/headroom/armLedger')
const { makeMeta } = await import('../../src/main/headroom/elisionMeta')

/**
 * What the proxy child posts to the main process is built by two small functions, and what the main
 * process does with it is two small calls. This file holds the whole hop: a request goes through the
 * real server, the frames are built from what it reported, the main side's own handlers consume them,
 * and what the ledgers hold afterwards is compared with what the request did. A field dropped from
 * either frame, or a handler that stops passing the metadata on, fails here and not in the ledger a
 * month later, where it would read as zero.
 */

const FIRST = 'Please look into the failing build and tell me what you find in the log.'
const BIG = Array.from({ length: 90 }, (_, i) => `build step ${i}: compiled module ${i * 7} in ${i * 13} ms with 0 errors`).join('\n')

function sseAnswer(toolName: string | null): string {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":50000,"cache_creation_input_tokens":400}}}',
    '',
    ...(toolName === null ? [] : [
      'event: content_block_start',
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"${toolName}","input":{}}}`,
      '',
    ]),
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":137}}',
    '',
  ].join('\n')
}

let answer = ''
let stub: http.Server, proxy: http.Server, proxyPort: number
let results: Array<Parameters<typeof resultFrame>[0]> = []
let stashes: Array<Parameters<typeof stashFrame>[0]> = []
let dir: string

beforeEach(async () => {
  resetProxyLedger(); resetCcr(); resetDepthCurveAll()
  dir = mkdtempSync(join(tmpdir(), 'tp-frame-'))
  results = []; stashes = []
  stub = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(answer) }) })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
  proxy = createProxyServer({
    upstreamHost: '127.0.0.1', upstreamPort: (stub.address() as { port: number }).port, useHttps: false,
    onResult: (r) => results.push(r), onStash: (s) => stashes.push(s),
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
  proxyPort = (proxy.address() as { port: number }).port
})
afterEach(() => { stub.close(); proxy.close(); rmSync(dir, { recursive: true, force: true }) })

function post(body: unknown): Promise<void> {
  const s = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) } }, (res) => { res.resume(); res.on('end', () => resolve()) })
    req.on('error', reject); req.write(s); req.end()
  })
}

/** A conversation whose one tool result is long enough to be shortened at first sight. */
const withBigResult = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'claude-opus-5-5',
  tools: [{ name: 'ToolSearch', description: 'x', input_schema: { type: 'object' } }],
  messages: [
    { role: 'user', content: FIRST },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_0', name: 'Bash', input: { command: 'cat build.log' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: BIG }] },
  ],
  ...extra,
})

/** What the main process does with a frame: index.ts hands a stash frame to ccrPut and a result frame to the ledger. */
const mainReceives = (m: ProxyStashMsg | ProxyResultMsg): void => {
  if (m.kind === 'stash') for (const st of m.stashes) ccrPut(st.token, st.original, 'proxy', st.meta)
  else recordProxyResult(m)
}

describe('the frames carry every field the ledgers read', () => {
  it('a request that shortens a result and is answered by a retrieval turn reaches every ledger', async () => {
    answer = sseAnswer('mcp__termpolis__retrieve_full')
    await post(withBigResult())
    expect(results).toHaveLength(1)
    expect(stashes).toHaveLength(1)
    expect(stashes[0]).toHaveLength(1)

    // The stash goes first, on the request path, and then the result.
    mainReceives(stashFrame(stashes[0]))
    mainReceives(resultFrame(results[0]))

    const s = summarizeProxySavings().session
    // the retrieval-turn charge: 0.1 x 50,000 read + 5 x 137 output
    expect(s.retrievalTurns).toBe(1)
    expect(s.retrievalTurnUnits).toBeCloseTo(5_000 + 685, 6)
    // the stub-kind tally: the one result was shortened at first sight
    expect(s.stubCompact).toBe(1)
    expect(s.stubPlain).toBe(0)
    // the savings stats
    expect(s.requests).toBe(1)
    expect(s.textOrigTokens).toBeGreaterThan(0)
    expect(s.textSavedTokens).toBeGreaterThan(0)
    // the arm ledger: one request, in the arm and group the rewriter reported
    const arm = results[0].stats.arm as 'late' | 'holdout' | 'legacy'
    expect(arm).toBe('legacy') // this process runs the default policy
    expect(armState().legacy).toMatchObject({ requests: 1, work: 0, turns: 1 })
    // the stash's class: one first-sight shortening of a Bash result between 4,000 and 10,000 characters
    expect(BIG.length).toBeGreaterThan(4_000)
    expect(BIG.length).toBeLessThan(10_000)
    expect(elisionState().classes['compact|Bash|4-10k']).toMatchObject({ elided: 1, redeemed: 0 })
  })

  it('the metadata survives the stash frame alone: the result never has to arrive', async () => {
    answer = sseAnswer(null)
    await post(withBigResult())
    mainReceives(stashFrame(stashes[0]))
    expect(elisionState().classes['compact|Bash|4-10k']).toMatchObject({ elided: 1 })
    expect(stashes[0][0].meta).toMatchObject({ kind: 'compact', tool: 'Bash', model: 'claude-opus-5-5' })
  })

  it('and survives the result frame alone, when the stash frame never arrived', async () => {
    answer = sseAnswer(null)
    await post(withBigResult())
    mainReceives(resultFrame(results[0])) // the backstop put carries the metadata too
    expect(elisionState().classes['compact|Bash|4-10k']).toMatchObject({ elided: 1 })
  })

  it('counts a redemption in the class the stash recorded, once, through the frames', async () => {
    answer = sseAnswer(null)
    await post(withBigResult())
    mainReceives(stashFrame(stashes[0]))
    mainReceives(resultFrame(results[0]))
    const token = stashes[0][0].token
    const meta = stashes[0][0].meta
    // retrieveFull's own bookkeeping, as compressToolResult does it.
    expect(ccrMarkRedeemed(token)).toBe(true)
    recordProxyGiveback(1500, { token, meta })
    expect(elisionState().classes['compact|Bash|4-10k']).toMatchObject({ elided: 1, redeemed: 1 })
    expect(summarizeProxySavings().session.retrieves).toBe(1)
    // The same content sent again on a later request is not a second elision.
    answer = sseAnswer(null)
    await post(withBigResult())
    mainReceives(stashFrame(stashes[1]))
    mainReceives(resultFrame(results[1]))
    expect(elisionState().classes['compact|Bash|4-10k']).toMatchObject({ elided: 1, redeemed: 1 })
  })

  it('every field of each frame is the one the request reported, nothing renamed, nothing dropped', async () => {
    answer = sseAnswer('Read')
    await post(withBigResult())
    const r = results[0]
    expect(resultFrame(r)).toStrictEqual({ kind: 'result', changed: r.changed, stats: r.stats, usage: r.usage, turn: r.turn, stashes: r.stashes, status: r.status })
    expect(stashFrame(stashes[0])).toStrictEqual({ kind: 'stash', stashes: stashes[0] })
    // Everything the ledger reads off a result is really in there.
    expect(Object.keys(resultFrame(r)).sort()).toEqual(['changed', 'kind', 'stashes', 'stats', 'status', 'turn', 'usage'])
    expect(resultFrame(r).turn).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false })
    expect(resultFrame(r).stats.kinds.compact).toBe(1)
    expect(resultFrame(r).stashes[0].meta).toBeDefined()
  })
})

describe('the elision ledger lives and dies with the proxy ledger', () => {
  const seed = (): void => {
    recordElision('hr_aaaaaaaaaaaaaaaa', makeMeta('compact', 'Read', 6000, 1100))
    recordElision('hr_bbbbbbbbbbbbbbbb', makeMeta('dedup', 'Bash', 3000, 200))
    recordRedemption('hr_aaaaaaaaaaaaaaaa', makeMeta('compact', 'Read', 6000, 1100))
    recordRedemption('hr_unknowntoken0000') // a redemption nothing recorded the class of
  }

  it('saving writes elision-ledger.json beside proxy-totals.json, and loading restores the classes and the legacy count', () => {
    seed()
    saveProxyTotalsToDisk(dir)
    expect(existsSync(join(dir, 'proxy-totals.json'))).toBe(true)
    expect(existsSync(join(dir, 'elision-ledger.json'))).toBe(true)
    const before = elisionState()
    resetProxyLedger()
    expect(elisionState().classes).toEqual({})
    loadProxyBaseFromDisk(dir)
    expect(elisionState()).toEqual(before)
    expect(elisionState().legacyRedeemed).toBe(1)
    expect(elisionState().classes['compact|Read|4-10k']).toMatchObject({ elided: 1, redeemed: 1 })
  })

  it('the arms ride in proxy-totals.json and come back with it', () => {
    answer = ''
    recordProxyResult({
      kind: 'result', changed: false, stashes: [], status: 200, turn: { toolCalls: 0, retrieveCalls: 0, pure: false },
      usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 10 },
      stats: { arm: 'holdout', armCluster: 4 },
    } as unknown as ProxyResultMsg)
    saveProxyTotalsToDisk(dir)
    const file = JSON.parse(readFileSync(join(dir, 'proxy-totals.json'), 'utf8')) as { arms: { holdout: Array<{ requests: number }> } }
    expect(file.arms.holdout[4].requests).toBe(1)
    resetProxyLedger()
    expect(armState().holdout[4].requests).toBe(0)
    loadProxyBaseFromDisk(dir)
    expect(armState().holdout[4].requests).toBe(1)
  })

  it('zeroing the counters empties the elision ledger and its window as well', () => {
    seed()
    expect(Object.keys(elisionState().classes)).toHaveLength(2)
    expect(recentByClass().size).toBe(2)
    resetProxyCounters()
    expect(elisionState()).toEqual({ classes: {}, legacyRedeemed: 0 })
    expect(recentByClass().size).toBe(0)
  })

  it('a result frame whose stashes carry metadata records the class when the stash frame never arrived', () => {
    const meta = makeMeta('compact', 'Grep', 12_000, 900)
    recordProxyResult({
      kind: 'result', changed: true, status: 200, turn: { toolCalls: 0, retrieveCalls: 0, pure: false },
      usage: { input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1, output_tokens: 1 },
      stats: {}, stashes: [{ token: 'hr_cccccccccccccccc', original: 'x'.repeat(12_000), meta }],
    } as unknown as ProxyResultMsg)
    expect(elisionState().classes['compact|Grep|10-40k']).toMatchObject({ elided: 1 })
  })

  it('a result frame whose stashes carry NO metadata records no class: a stash from before the ledger', () => {
    recordProxyResult({
      kind: 'result', changed: true, status: 200, turn: { toolCalls: 0, retrieveCalls: 0, pure: false },
      usage: { input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1, output_tokens: 1 },
      stats: {}, stashes: [{ token: 'hr_dddddddddddddddd', original: 'y'.repeat(3000) }],
    } as unknown as ProxyResultMsg)
    expect(elisionState().classes).toEqual({})
  })
})
