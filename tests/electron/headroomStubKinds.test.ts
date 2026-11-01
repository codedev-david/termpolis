import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DECAY_FIRST_THRESHOLD } from '../../src/main/headroomProxy/prefixDecay'
import { resetCcr } from '../../src/main/headroom/ccrStore'
import { resetDepthCurveAll } from '../../src/main/headroom/sessionDepth'
import { resetLedger } from '../../src/main/headroom/savingsLedger'
import type { ProxyResultMsg } from '../../src/main/headroomProxy/proxySupervisor'
const { classifyForwardedResults, emptyKinds } = await import('../../src/main/headroomProxy/forwardedKinds')
const { rewriteMessagesBody } = await import('../../src/main/headroomProxy/wireCompress')
const {
  recordProxyResult, summarizeProxySavings, resetProxyLedger, resetProxyCounters, loadProxyBase,
  saveProxyTotalsToDisk, loadProxyBaseFromDisk, currentProxyTotals,
} = await import('../../src/main/headroomProxy/proxyLedger')
const { summarizeUnifiedSavings } = await import('../../src/main/headroom/unifiedReceipt')

/**
 * R1 criterion 7, the ledger half: the per-request tally of what reached the model is summed and
 * persisted, so the next unexplained burst of stubs is a number in a file rather than something
 * one person happened to notice in one session.
 */

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `  const v${i} = compute(${i}) // a reasonably long source line`).join('\n')

function bodyOf(texts: string[], total?: number): string {
  const messages: unknown[] = []
  texts.forEach((t, i) => {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu${i}`, name: 'Read', input: {} }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: t }] })
  })
  while (total !== undefined && messages.length < total) messages.push({ role: 'user', content: 'filler' })
  return JSON.stringify({ messages })
}

const AGED = '[headroom] Aged out of this conversation\'s active context — call the retrieve_full tool with token "hr_0123456789abcdef" to expand it.'

function result(kinds?: Partial<ReturnType<typeof emptyKinds>>): ProxyResultMsg {
  return {
    kind: 'result', changed: false, status: 200, stashes: [],
    stats: { trBlocks: 0, trOrigChars: 0, trCompChars: 0, images: 0, imgOrigBytes: 0, imgCompBytes: 0, ...(kinds ? { kinds: { ...emptyKinds(), ...kinds } } : {}) },
    usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
  } as unknown as ProxyResultMsg
}

let dir: string
beforeEach(() => { resetProxyLedger(); resetCcr(); resetDepthCurveAll(); resetLedger(); dir = mkdtempSync(join(tmpdir(), 'tp-r1-kinds-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('the rewriter classifies what it forwards', () => {
  it('puts the tally of the forwarded body on the request stats', () => {
    const r = rewriteMessagesBody(bodyOf([lines(60), lines(60), 'short']))
    expect(r.stats.kinds).toEqual({ ...emptyKinds(), compact: 1, dedup: 1, plain: 1 })
    expect(r.stats.kinds).toEqual(classifyForwardedResults(r.body))
  })

  it('classifies a body it declined to change, so the denominator counts what the model saw', () => {
    // 2^53 + 1 does not survive JSON.parse then stringify, so the proxy forwards the client's bytes.
    const raw = bodyOf(['short', 'also short']).replace('{"messages"', '{"max_tokens":9007199254740993,"messages"')
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
    expect(r.stats.kinds).toEqual({ ...emptyKinds(), plain: 2 })
  })

  it('classifies a body whose only change was a thinking clamp as it stands', () => {
    const r = rewriteMessagesBody(bodyOf(['short']))
    expect(r.changed).toBe(false)
    expect(r.stats.kinds).toEqual({ ...emptyKinds(), plain: 1 })
  })

  it('leaves the tally at zero for a body it cannot read at all', () => {
    for (const raw of ['not json{', '{"messages":5}', JSON.stringify({ no: 'messages' })]) {
      expect(rewriteMessagesBody(raw).stats.kinds).toEqual(emptyKinds())
    }
    expect(rewriteMessagesBody(bodyOf(['x']), { maxBodyChars: 5 }).stats.kinds).toEqual(emptyKinds())
  })

  it('counts an aged-out stub in a short body as early, whatever put it there', () => {
    const r = rewriteMessagesBody(bodyOf([AGED, 'x']))
    expect(r.stats.kinds).toEqual({ ...emptyKinds(), plain: 1, aged: 1, agedEarly: 1 })
    expect(DECAY_FIRST_THRESHOLD).toBeGreaterThan(4) // the fixture really is shorter than the threshold
  })

  it('does not change a single forwarded byte', () => {
    const raw = bodyOf([lines(60), lines(60), 'short'])
    const a = rewriteMessagesBody(raw)
    expect(JSON.parse(a.body).messages).toHaveLength(6)
    expect(a.body).not.toContain('kinds')
    expect(rewriteMessagesBody(raw).body).toBe(a.body)
  })
})

describe('the proxy ledger keeps the tally', () => {
  it('sums it per request into the session and on top of the persisted baseline', () => {
    loadProxyBase({ stubPlain: 100, stubCompact: 40, stubAged: 2 })
    recordProxyResult(result({ plain: 3, compact: 2, dedup: 1 }))
    recordProxyResult(result({ plain: 1, diff: 4, aged: 1 }))
    const r = summarizeProxySavings()
    expect(r.session).toMatchObject({ stubPlain: 4, stubCompact: 2, stubDedup: 1, stubDiff: 4, stubAged: 1, stubAgedEarly: 0 })
    expect(r.cumulative).toMatchObject({ stubPlain: 104, stubCompact: 42, stubDedup: 1, stubDiff: 4, stubAged: 3, stubAgedEarly: 0 })
  })

  it('counts requests that carried an early aged-out stub apart from the stubs themselves', () => {
    recordProxyResult(result({ plain: 2, aged: 3, agedEarly: 3 })) // one request, three early stubs
    recordProxyResult(result({ plain: 2, aged: 1, agedEarly: 1 }))
    recordProxyResult(result({ plain: 5, aged: 4 })) //              aged-out stubs, but legitimately late
    const s = summarizeProxySavings().session
    expect(s.stubAgedEarly).toBe(4)
    expect(s.stubAgedEarlyRequests).toBe(2)
    expect(s.stubAged).toBe(8)
  })

  it('adds nothing for a request with no tally, as from a child that predates it', () => {
    recordProxyResult(result())
    const s = summarizeProxySavings().session
    expect(s.requests).toBe(1)
    for (const k of ['stubPlain', 'stubCompact', 'stubDedup', 'stubDiff', 'stubAged', 'stubAgedEarly', 'stubAgedEarlyRequests'] as const) expect(s[k]).toBe(0)
  })

  it('ignores a damaged tally rather than corrupting the sums', () => {
    for (const kinds of [null, 5, 'x', { plain: 'many', compact: -4, dedup: Number.NaN, diff: null, aged: {}, agedEarly: [] }]) {
      const m = result() as unknown as { stats: Record<string, unknown> }
      m.stats.kinds = kinds
      recordProxyResult(m as unknown as ProxyResultMsg)
    }
    const s = summarizeProxySavings().session
    for (const k of ['stubPlain', 'stubCompact', 'stubDedup', 'stubDiff', 'stubAged', 'stubAgedEarly', 'stubAgedEarlyRequests'] as const) expect(s[k]).toBe(0)
  })

  it('resetProxyCounters zeroes it with the rest of the lifetime meter', () => {
    loadProxyBase({ stubPlain: 9 })
    recordProxyResult(result({ plain: 1 }))
    resetProxyCounters()
    expect(summarizeProxySavings().cumulative.stubPlain).toBe(0)
  })
})

describe('the tally is persisted', () => {
  it('round-trips through proxy-totals.json', () => {
    recordProxyResult(result({ plain: 3, compact: 2, dedup: 1, diff: 1, aged: 2, agedEarly: 2 }))
    const before = currentProxyTotals()
    saveProxyTotalsToDisk(dir)
    resetProxyLedger()
    loadProxyBaseFromDisk(dir)
    const after = currentProxyTotals()
    for (const k of ['stubPlain', 'stubCompact', 'stubDedup', 'stubDiff', 'stubAged', 'stubAgedEarly', 'stubAgedEarlyRequests'] as const) expect(after[k]).toBe(before[k])
    expect(after.stubAgedEarlyRequests).toBe(1)
  })

  it('loads a v1.54 proxy-totals.json that has no tally as zeros', () => {
    writeFileSync(join(dir, 'proxy-totals.json'), JSON.stringify({ requests: 477_099, cacheReadTokens: 79_310_000_000, retrieves: 76_433 }), 'utf8')
    loadProxyBaseFromDisk(dir)
    const c = summarizeProxySavings().cumulative
    expect(c.requests).toBe(477_099)
    for (const k of ['stubPlain', 'stubCompact', 'stubDedup', 'stubDiff', 'stubAged', 'stubAgedEarly', 'stubAgedEarlyRequests'] as const) expect(c[k]).toBe(0)
  })

  it('reads a damaged value as zero', () => {
    for (const bad of ['7', null, -1, Number.NaN, {}, [], true]) {
      writeFileSync(join(dir, 'proxy-totals.json'), JSON.stringify({ stubPlain: bad, stubAged: bad, stubAgedEarlyRequests: bad }), 'utf8')
      resetProxyLedger()
      loadProxyBaseFromDisk(dir)
      const c = currentProxyTotals()
      expect([c.stubPlain, c.stubAged, c.stubAgedEarlyRequests]).toEqual([0, 0, 0])
    }
  })
})

describe('the receipt reports it', () => {
  it('exposes the tally as stubKinds for the session and for life', () => {
    loadProxyBase({ stubPlain: 10, stubCompact: 5, stubDedup: 2, stubDiff: 1, stubAged: 4, stubAgedEarly: 3, stubAgedEarlyRequests: 2 })
    recordProxyResult(result({ plain: 1, aged: 1, agedEarly: 1 }))
    const r = summarizeUnifiedSavings()
    expect(r.session.stubKinds).toEqual({ plain: 1, compact: 0, dedup: 0, diff: 0, aged: 1, agedEarly: 1, agedEarlyRequests: 1 })
    expect(r.cumulative.stubKinds).toEqual({ plain: 11, compact: 5, dedup: 2, diff: 1, aged: 5, agedEarly: 4, agedEarlyRequests: 3 })
  })
})
