// v1.55.0 Task 11: retrieve_full can return part of a result (grep or lines).
import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))
const { executeTool } = await import('../../src/main/mcpServer')
import { readFileSync } from 'node:fs'
import type { McpToolHandlers } from '../../src/main/mcpServer'
import { retrieveFull } from '../../src/main/headroom/compressToolResult'
import { ccrPut, ccrStash, resetCcr } from '../../src/main/headroom/ccrStore'
import { elisionState, loadElisionState, recentByClass, recordElision, resetElisionLedger } from '../../src/main/headroom/elisionLedger'
import { resetProxyLedger, summarizeProxySavings } from '../../src/main/headroomProxy/proxyLedger'
import { resetLedger, summarizeSavings } from '../../src/main/headroom/savingsLedger'
import { sliceResult, lineMatcher, parseLineRange, wantsSlice, GREP_PATTERN_CAP, SLICE_MAX_LINES } from '../../src/main/headroom/retrieveSlice'
import type { ElisionMeta } from '../../src/main/headroom/elisionMeta'

const handlers = () => ({ retrieveFull } as unknown as McpToolHandlers)
const meta = (over: Partial<ElisionMeta> = {}): ElisionMeta => ({ kind: 'compact', tool: 'Read', chars: 5000, view: 1100, model: 'claude-x', ...over })
const KEY = 'compact|Read|4-10k'
const TEXT = Array.from({ length: 30 }, (_, i) => `line ${i + 1}${i + 1 === 12 ? ' ERROR: disk full' : ''}`).join('\n')

beforeEach(() => { resetCcr(); resetElisionLedger(); resetProxyLedger(); resetLedger() })

describe('sliceResult', () => {
  it('grep returns matches with line numbers and two lines of context', () => {
    expect(sliceResult(TEXT, { grep: 'error' })).toBe([
      '[1 matching line of 30]', '10-line 10', '11-line 11', '12:line 12 ERROR: disk full', '13-line 13', '14-line 14',
    ].join('\n'))
    // Matches close together share their context; apart, a -- separates them.
    const two = sliceResult(TEXT, { grep: '/line 5|line 7|line 25/' }).split('\n')
    expect(two[0]).toBe('[3 matching lines of 30]')
    expect(two).toContain('5:line 5')
    expect(two).toContain('25:line 25')
    expect(two.filter((l) => l === '--')).toHaveLength(1)
    expect(two.filter((l) => l.startsWith('4-'))).toHaveLength(1)
  })

  it('lines returns the exact slice, and grep within it', () => {
    expect(sliceResult(TEXT, { lines: '2-4' })).toBe('[lines 2-4 of 30]\n2:line 2\n3:line 3\n4:line 4')
    expect(sliceResult(TEXT, { lines: '29-' })).toBe('[lines 29-30 of 30]\n29:line 29\n30:line 30')
    expect(sliceResult(TEXT, { lines: '7' })).toBe('[lines 7-7 of 30]\n7:line 7')
    expect(sliceResult(TEXT, { lines: '11-12', grep: 'disk' })).toBe('[1 matching line of 30]\n11-line 11\n12:line 12 ERROR: disk full')
    expect(sliceResult(TEXT, { lines: '1-5', grep: 'disk' })).toContain('No line matches "disk" in lines 1-5 of 30')
    expect(sliceResult(TEXT, { lines: 'top' })).toContain('Could not read lines "top"')
    expect(sliceResult(TEXT, { lines: '40-50' })).toContain('The result has 30 lines')
  })

  it('a slashed pattern is literal alternatives, never a regex, and a long pattern is cut', () => {
    expect(lineMatcher('/disk|quota/')('Quota exceeded')).toBe(true)
    expect(lineMatcher('/disk|quota/')('memory low')).toBe(false)
    expect(lineMatcher('/^line$/')('line')).toBe(false)
    // A backtracking pattern is plain text: answered at once, matching only itself.
    const t0 = Date.now()
    expect(lineMatcher('/(a+)+$/')('a'.repeat(50_000) + '!')).toBe(false)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(lineMatcher('/(a+)+$/')('see (a+)+$ here')).toBe(true)
    expect(lineMatcher('/a(b/')('x /a(b/ y')).toBe(true)
    expect(lineMatcher('/a(b/')('ab')).toBe(false)
    expect(lineMatcher('/DISK/')('disk full')).toBe(true)
    expect(lineMatcher('x'.repeat(GREP_PATTERN_CAP + 50))('x'.repeat(GREP_PATTERN_CAP))).toBe(true)
  })

  it('caps one answer and says how to ask for the rest', () => {
    const big = Array.from({ length: SLICE_MAX_LINES + 20 }, (_, i) => `r${i + 1}`).join('\n')
    const out = sliceResult(big, { lines: '1-' }).split('\n')
    expect(out).toHaveLength(SLICE_MAX_LINES + 2)
    expect(out[out.length - 1]).toBe(`[… 20 more lines: ask for lines ${SLICE_MAX_LINES + 1}-${SLICE_MAX_LINES + 20}]`)
  })

  it('reads ranges and asks safely', () => {
    expect(parseLineRange('0-3', 10)).toEqual({ from: 1, to: 3 })
    expect(parseLineRange('5-2', 10)).toBeNull()
    expect(parseLineRange('3-99', 10)).toEqual({ from: 3, to: 10 })
    expect(wantsSlice(undefined)).toBe(false)
    expect(wantsSlice({ grep: '  ', lines: 7 })).toBe(false)
    expect(wantsSlice({ lines: '1-2' })).toBe(true)
  })
})

describe('retrieve_full with grep or lines', () => {
  it('neither given returns the whole result, as before', async () => {
    const token = ccrStash({ hits: [1, 2] })
    expect(await executeTool('retrieve_full', { token }, handlers())).toEqual({ hits: [1, 2] })
  })

  it('returns only the part, from text or a stashed object', async () => {
    const token = ccrStash(TEXT)
    expect(await executeTool('retrieve_full', { token, lines: '2-3' }, handlers())).toBe('[lines 2-3 of 30]\n2:line 2\n3:line 3')
    const obj = ccrStash({ a: 1, b: 'needle' })
    expect(await executeTool('retrieve_full', { token: obj, grep: 'needle' }, handlers())).toContain(':  "b": "needle"')
    expect(summarizeSavings().session.retrieves).toBe(2)
  })

  it('the ledger records a partial redemption with its size, and the whole read still counts after it', async () => {
    recordElision('hr_part', meta())
    ccrPut('hr_part', TEXT, 'proxy', meta())
    const part = await retrieveFull('hr_part', { grep: 'disk' }) as string
    expect(elisionState().partial).toEqual({ [KEY]: { asks: 1, chars: part.length } })
    expect(elisionState().classes[KEY].redeemed).toBe(0)
    expect(recentByClass().get(KEY)?.redeemed).toBe(0)
    expect(summarizeProxySavings().session.givebackTokens).toBeGreaterThan(0)
    await retrieveFull('hr_part')
    expect(elisionState().classes[KEY].redeemed).toBe(1)
    expect(summarizeProxySavings().session.retrieves).toBe(2)
  })

  it('a part of a token with no class is not counted, and the counts survive a save and load', async () => {
    ccrPut('hr_noclass', TEXT, 'proxy')
    await retrieveFull('hr_noclass', { lines: '1' })
    expect(elisionState()).toEqual({ classes: {}, legacyRedeemed: 0 })
    loadElisionState({ classes: {}, legacyRedeemed: 0, partial: { [KEY]: { asks: 2, chars: 90 }, 'not a key': { asks: 1 }, [`${KEY}x`]: 5 } })
    expect(elisionState().partial).toEqual({ [KEY]: { asks: 2, chars: 90 } })
    loadElisionState({ classes: {}, partial: [] })
    expect(elisionState().partial).toBeUndefined()
  })

  it('the tool says so in one short sentence', () => {
    // The tool list is not exported; its source is the contract every agent reads.
    const src = readFileSync('src/main/mcpServer.ts', 'utf8')
    const block = src.slice(src.indexOf("name: 'retrieve_full'"), src.indexOf("required: ['token']", src.indexOf("name: 'retrieve_full'")))
    expect(block).toContain('Optional grep or lines (e.g. 120-180) returns only part.')
    expect(block).toMatch(/grep: \{ type: 'string'/)
    expect(block).toMatch(/lines: \{ type: 'string'/)
  })
})
