import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProxyResultMsg } from '../../src/main/headroomProxy/proxySupervisor'
import { offMainFiles } from '../../src/main/offMainFiles'
const { rewriteMessagesBody, charsAskedBack, collectToolUseHints } = await import('../../src/main/headroomProxy/wireCompress')
const {
  recordProxyResult, summarizeProxySavings, resetProxyLedger, saveProxyTotalsToDisk, loadProxyBaseFromDisk, loadProxyBase,
} = await import('../../src/main/headroomProxy/proxyLedger')
const { summarizeUnifiedSavings } = await import('../../src/main/headroom/unifiedReceipt')
const { billBreakdown } = await import('../../src/main/headroom/effectiveUnits')
const { buildPayload, signReceipt, renderReceiptMarkdown, verifyReceipt } = await import('../../src/main/headroom/receiptArtifact')
const { resetCcr } = await import('../../src/main/headroom/ccrStore')
const { resetDepthCurveAll } = await import('../../src/main/headroom/sessionDepth')
const { resetLedger } = await import('../../src/main/headroom/savingsLedger')

/**
 * The headline used to credit an elided token for every request that re-sent its stub, including a stub
 * whose text the model had asked straight back: the fetched text then sat in the prefix at full size and
 * the elision saved nothing, yet it kept earning. A request now reports how many of the characters its
 * stubs removed belong to tokens its own conversation has fetched with retrieve_full, and the ledger
 * withdraws that credit. Measurement only: the forwarded bytes are not touched.
 */

const FIRST = 'Please look into the failing build and tell me what you find in the log.'
const log = (tag: string): string => Array.from({ length: 90 }, (_, i) => `${tag} step ${i}: compiled module ${i * 7} in ${i * 13} ms with 0 errors`).join('\n')

type Msg = { role: string; content: unknown }
const ask = (id: string, command: string): Msg => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] })
const answer = (id: string, text: string): Msg => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] })
const fetchBack = (id: string, token: string, name = 'mcp__termpolis__retrieve_full', input: unknown = { token }): Msg =>
  ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] })
const body = (messages: Msg[]): string => JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: FIRST }, ...messages] })

/** The token the rewriter gave a result: found by shortening it on its own. */
function tokenOf(text: string): string {
  const r = rewriteMessagesBody(body([ask('t0', 'cat a'), answer('t0', text)]))
  expect(r.stashes).toHaveLength(1)
  return r.stashes[0].token
}

describe('askedBackChars on a request', () => {
  it('is nothing when the conversation has fetched nothing back', () => {
    const r = rewriteMessagesBody(body([ask('t1', 'cat build.log'), answer('t1', log('A'))]))
    expect(r.stats.askedBackChars).toBe(0)
    expect(r.stashes).toHaveLength(1)
  })

  it('counts what a stub removed once its text has been fetched back: original minus the view', () => {
    const text = log('A')
    const token = tokenOf(text)
    const r = rewriteMessagesBody(body([
      ask('t1', 'cat a'), answer('t1', text),
      fetchBack('f1', token), answer('f1', text),
    ]))
    const meta = r.stashes[0].meta!
    expect(r.stashes).toHaveLength(1)
    expect(meta.chars).toBe(text.length)
    expect(r.stats.askedBackChars).toBe(meta.chars - meta.view)
    expect(r.stats.askedBackChars).toBeGreaterThan(0)
  })

  it('does not count a stub whose text was not fetched: another token, or a token the body only mentions', () => {
    const a = log('A'), b = log('B')
    const tokenA = tokenOf(a)
    const r = rewriteMessagesBody(body([
      ask('t1', 'cat a'), answer('t1', a),
      ask('t2', 'cat b'), answer('t2', b),
      fetchBack('f1', tokenA), answer('f1', a),
    ]))
    expect(r.stashes).toHaveLength(2)
    const metaA = r.stashes.find((s) => s.token === tokenA)!.meta!
    expect(r.stats.askedBackChars).toBe(metaA.chars - metaA.view) // A only, not B
    // A token named only in a user's words, or in another tool's input, is not a fetch.
    const mention = rewriteMessagesBody(JSON.stringify({ model: 'm', messages: [
      { role: 'user', content: `${FIRST} retrieve_full ${tokenA}` },
      ask('t1', `echo ${tokenA}`), answer('t1', a),
    ] }))
    expect(mention.stats.askedBackChars).toBe(0)
  })

  it('counts a token once however many stubs name it: the text came back once', () => {
    const text = log('A')
    const token = tokenOf(text)
    // The same result read three times in one request: the second and third collapse to references to the first.
    const r = rewriteMessagesBody(body([
      ask('t1', 'cat a'), answer('t1', text),
      ask('t2', 'cat a'), answer('t2', text),
      ask('t3', 'cat a'), answer('t3', text),
      fetchBack('f1', token), answer('f1', text),
    ]))
    expect(r.stashes.length).toBeGreaterThanOrEqual(2)
    expect(new Set(r.stashes.map((s) => s.token))).toEqual(new Set([token]))
    const first = r.stashes[0].meta!
    expect(r.stats.askedBackChars).toBe(first.chars - first.view)
  })

  it('sees the retrieve_full call under each of its names and under none of the look-alikes', () => {
    const text = log('A')
    const token = tokenOf(text)
    const run = (name: string, input?: unknown): number => rewriteMessagesBody(body([
      ask('t1', 'cat a'), answer('t1', text), fetchBack('f1', token, name, input), answer('f1', text),
    ])).stats.askedBackChars
    for (const name of ['retrieve_full', 'mcp__termpolis__retrieve_full', 'mcp__plugin_termpolis_termpolis__retrieve_full']) expect(run(name), name).toBeGreaterThan(0)
    for (const name of ['not_retrieve_full', 'retrieve_full_all', 'mcp__x__retrieve_fullish', 'Retrieve_Full', 'Read']) expect(run(name), name).toBe(0)
  })

  it('reads a call it cannot make sense of as no fetch: no token, a token that is not text, no input at all', () => {
    const text = log('A')
    const token = tokenOf(text)
    for (const input of [null, {}, { token: 7 }, { token: null }, { tok: token }, 'hr_x', [token]]) {
      const r = rewriteMessagesBody(body([ask('t1', 'cat a'), answer('t1', text), fetchBack('f1', token, 'retrieve_full', input), answer('f1', text)]))
      expect(r.stats.askedBackChars, JSON.stringify(input)).toBe(0)
    }
    // A call with no input key at all.
    const bare: Msg = { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'retrieve_full' }] }
    expect(rewriteMessagesBody(body([ask('t1', 'cat a'), answer('t1', text), bare, answer('f1', text)])).stats.askedBackChars).toBe(0)
  })

  it('changes not one byte of what is forwarded for the stub: it is only measured', () => {
    const text = log('A')
    const token = tokenOf(text)
    const plain = rewriteMessagesBody(body([ask('t1', 'cat a'), answer('t1', text)]))
    const fetched = rewriteMessagesBody(body([ask('t1', 'cat a'), answer('t1', text), fetchBack('f1', token), answer('f1', text)]))
    const stubOf = (b: string): unknown => (JSON.parse(b) as { messages: Array<{ content: Array<{ content?: unknown }> }> }).messages[2].content[0].content
    expect(stubOf(fetched.body)).toBe(stubOf(plain.body))
    // And the floor evidence the controller reads is the same: the same text was shortened by the same amount.
    expect(fetched.stats.trOrigChars).toBe(plain.stats.trOrigChars)
    expect(fetched.stats.trCompChars).toBe(plain.stats.trCompChars)
    expect(fetched.stats.trBlocks).toBe(plain.stats.trBlocks)
  })

  it('collects the tokens in the pass that already reads every tool_use, and nothing else', () => {
    const retrieved = new Set<string>()
    const hints = collectToolUseHints([
      { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }] },
      { content: [{ type: 'tool_use', id: 'b', name: 'retrieve_full', input: { token: 'hr_0000000000000001' } }] },
      { content: [{ type: 'tool_use', id: 'c', name: 'mcp__termpolis__retrieve_full', input: { token: 'hr_0000000000000002' } }] },
      { content: 'not blocks' }, { content: [null, 5, { type: 'text' }] }, null as never,
    ], retrieved)
    expect([...retrieved].sort()).toEqual(['hr_0000000000000001', 'hr_0000000000000002'])
    expect([...hints.keys()].sort()).toEqual(['a', 'b', 'c'])
    // Without a set to fill it behaves as it always did.
    expect(collectToolUseHints([{ content: [{ type: 'tool_use', id: 'a', name: 'retrieve_full', input: { token: 'hr_0000000000000001' } }] }]).size).toBe(1)
  })
})

describe('charsAskedBack, for the stubs a request makes of every kind', () => {
  const meta = (kind: 'compact' | 'dedup' | 'diff' | 'decay', chars: number, view: number) => ({ kind, chars, view })
  const entry = (token: string, m?: { kind: 'compact' | 'dedup' | 'diff' | 'decay'; chars: number; view: number }) => ({ token, original: 'x', ...(m ? { meta: m } : {}) })

  it('counts compact, dedup, diff and decay stubs alike', () => {
    const stashes = [entry('a', meta('compact', 6000, 1100)), entry('b', meta('dedup', 6000, 150)), entry('c', meta('diff', 9000, 700)), entry('d', meta('decay', 4000, 140))]
    expect(charsAskedBack(stashes, new Set(['a', 'b', 'c', 'd']))).toBe(4900 + 5850 + 8300 + 3860)
    expect(charsAskedBack(stashes, new Set(['d']))).toBe(3860)
  })

  it('counts a token once, ignores a stash with no metadata, and never goes negative', () => {
    const stashes = [entry('a', meta('compact', 6000, 1100)), entry('a', meta('dedup', 6000, 150)), entry('n'), entry('x', meta('compact', 100, 900))]
    expect(charsAskedBack(stashes, new Set(['a', 'n', 'x']))).toBe(4900)
  })

  it('is nothing when nothing was fetched', () => {
    expect(charsAskedBack([entry('a', meta('compact', 6000, 1100))], new Set())).toBe(0)
    expect(charsAskedBack([], new Set(['a']))).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------
// The ledger and the receipt.

const usage = (read: number, out: number) => ({ input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 500, output_tokens: out })
const result = (stats: Record<string, number>): ProxyResultMsg => ({
  kind: 'result', changed: true, stashes: [], status: 200, usage: usage(100_000, 100), turn: { toolCalls: 0, retrieveCalls: 0, pure: false },
  stats: { trBlocks: 1, images: 0, imgOrigBytes: 0, imgCompBytes: 0, ...stats },
} as unknown as ProxyResultMsg)

let dir: string
beforeEach(() => { resetProxyLedger(); resetCcr(); resetDepthCurveAll(); resetLedger(); dir = mkdtempSync(join(tmpdir(), 'tp-askedback-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('the ledger withdraws the credit', () => {
  it('counts the tokens a request kept off the wire that its conversation had fetched back', () => {
    // 20,000 chars shortened to 4,000 (4,000 tokens credited); 12,000 chars of that belonged to fetched stubs.
    recordProxyResult(result({ trOrigChars: 20_000, trCompChars: 4_000, askedBackChars: 12_000 }))
    const s = summarizeProxySavings().session
    expect(s.textSavedTokens).toBe(4_000)
    expect(s.askedBackTokens).toBe(3_000)
  })

  it('never withdraws more than the request was credited with', () => {
    recordProxyResult(result({ trOrigChars: 20_000, trCompChars: 16_000, askedBackChars: 90_000 }))
    const s = summarizeProxySavings().session
    expect(s.textSavedTokens).toBe(1_000)
    expect(s.askedBackTokens).toBe(1_000)
  })

  it('withdraws nothing from a request that fetched nothing, or a result from a child that predates the field', () => {
    recordProxyResult(result({ trOrigChars: 20_000, trCompChars: 4_000, askedBackChars: 0 }))
    recordProxyResult(result({ trOrigChars: 20_000, trCompChars: 4_000 }))
    recordProxyResult(result({ trOrigChars: 20_000, trCompChars: 4_000, askedBackChars: Number.NaN }))
    recordProxyResult(result({ trOrigChars: 20_000, trCompChars: 4_000, askedBackChars: -5 }))
    expect(summarizeProxySavings().session.askedBackTokens).toBe(0)
  })

  it('sums over requests, and keeps the lifetime figure across a save and a load', async () => {
    recordProxyResult(result({ trOrigChars: 20_000, trCompChars: 4_000, askedBackChars: 4_000 }))
    recordProxyResult(result({ trOrigChars: 20_000, trCompChars: 4_000, askedBackChars: 8_000 }))
    expect(summarizeProxySavings().session.askedBackTokens).toBe(3_000)
    saveProxyTotalsToDisk(dir)
    await offMainFiles.idle()
    resetProxyLedger()
    loadProxyBaseFromDisk(dir)
    recordProxyResult(result({ trOrigChars: 20_000, trCompChars: 4_000, askedBackChars: 4_000 }))
    const t = summarizeProxySavings()
    expect(t.session.askedBackTokens).toBe(1_000)
    expect(t.cumulative.askedBackTokens).toBe(4_000)
  })

  it('loads a file from before it as zero, and a damaged one as zero', () => {
    loadProxyBase({ requests: 40, textSavedTokens: 1000 })
    expect(summarizeProxySavings().cumulative.askedBackTokens).toBe(0)
    loadProxyBase({ askedBackTokens: 'x' as unknown as number })
    expect(summarizeProxySavings().cumulative.askedBackTokens).toBe(0)
    loadProxyBase({ askedBackTokens: -3 })
    expect(summarizeProxySavings().cumulative.askedBackTokens).toBe(0)
  })
})

describe('the receipt nets it out of the headline', () => {
  it('takes it from the net saved tokens, shows it, and prices the headline by the hand-computed formula', () => {
    recordProxyResult(result({ trOrigChars: 40_000, trCompChars: 8_000, askedBackChars: 16_000 })) // 8,000 credited, 4,000 asked back
    const u = summarizeUnifiedSavings().cumulative
    expect(u.grossSavedTokens).toBe(8_000)
    expect(u.askedBackTokens).toBe(4_000)
    expect(u.netSavedTokens).toBe(8_000 - 0 - 4_000)
    expect(u.turnRequests).toBe(1)
    // billed units avoided = net saved tokens x the blended price of a prefix token - the retrieval turns.
    const input = 10, read = 100_000, write = 500, out = 100
    const total = 0.1 * read + 1.25 * write + 1 * input + 5 * out
    const weight = (0.1 * read + 1.25 * write) / (read + write)
    expect(u.bill.total).toBeCloseTo(total, 6)
    expect(u.bill.grossAvoided).toBeCloseTo(4_000 * weight, 6)
    expect(u.bill.avoided).toBeCloseTo(4_000 * weight, 6)
    expect(u.bill.avoided).toBeCloseTo(billBreakdown({ cacheReadTokens: read, cacheCreationTokens: write, inputTokens: input, outputTokens: out }, 4_000).avoided, 6)
  })

  it('adds the give-back and the asked-back credit: both are out of the net, once each', () => {
    recordProxyResult(result({ trOrigChars: 40_000, trCompChars: 8_000, askedBackChars: 16_000 }))
    const u = summarizeUnifiedSavings().cumulative
    expect(u.netSavedTokens).toBe(u.grossSavedTokens - u.givebackTokens - u.askedBackTokens)
  })

  it('leaves a result that was never asked back at the full credit', () => {
    recordProxyResult(result({ trOrigChars: 40_000, trCompChars: 8_000 }))
    const u = summarizeUnifiedSavings().cumulative
    expect(u.askedBackTokens).toBe(0)
    expect(u.netSavedTokens).toBe(8_000)
  })

  // The exported receipt prints the same net figure, from the same ledger. Its payload carries the gross and the
  // give-back but not the credit, so gross less give-back is NOT the figure when text was asked back, and the
  // receipt says what its figure is net of. Run here from a real ledger, not from totals written by hand.
  it('carries the same net figure into the exported receipt, which is net of the asked-back credit the payload does not itemise', () => {
    recordProxyResult(result({ trOrigChars: 40_000, trCompChars: 8_000, askedBackChars: 16_000 })) // 8,000 saved, 4,000 asked back
    const u = summarizeUnifiedSavings().cumulative
    expect(u.askedBackTokens).toBe(4_000)
    const receipt = signReceipt(buildPayload(u, { installHash: 'abcdef0123456789', now: 1_700_000_000_000 }), 'k')
    const p = receipt.payload
    expect(p.grossSavedTokens - p.givebackTokens).toBe(8_000) // what the payload itemises
    expect(p.netSavedTokens).toBe(4_000) // what it signs: the credit is out of it
    expect(p.netSavedTokens).toBe(p.grossSavedTokens - p.givebackTokens - u.askedBackTokens)
    expect(verifyReceipt(receipt).consistent).toBe(true)
    const md = renderReceiptMarkdown(receipt)
    expect(md).toContain('| Saved (net of give-back and text asked back) | **4,000** (')
    expect(md).toContain('The saved figure already has the give-back and the credit for text already asked back taken out')
  })
})
