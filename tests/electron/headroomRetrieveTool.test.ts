import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))
const { executeTool } = await import('../../src/main/mcpServer')
import type { McpToolHandlers } from '../../src/main/mcpServer'
import { retrieveFull } from '../../src/main/headroom/compressToolResult'
import { ccrStash, ccrPut, resetCcr, CCR_MAX_ENTRIES } from '../../src/main/headroom/ccrStore'
import { resetLedger, summarizeSavings } from '../../src/main/headroom/savingsLedger'
import { resetProxyLedger, summarizeProxySavings } from '../../src/main/headroomProxy/proxyLedger'

// The app wires handlers.retrieveFull to the real headroom retrieveFull (index.ts).
const handlers = () => ({ retrieveFull } as unknown as McpToolHandlers)

describe('retrieve_full tool', () => {
  beforeEach(() => { resetCcr(); resetLedger() })

  it('returns the stashed original for a known token', async () => {
    const original = { hits: [1, 2, 3] }
    const token = ccrStash(original)
    expect(await executeTool('retrieve_full', { token }, handlers())).toEqual(original)
  })

  it('charges an MCP-origin give-back to the TOOL ledger', async () => {
    const token = ccrStash({ big: 'x'.repeat(1000) })
    await executeTool('retrieve_full', { token }, handlers())
    const s = summarizeSavings().session
    expect(s.givebackTokens).toBeGreaterThan(0)
    expect(s.retrieves).toBe(1)
    expect(s.netSaved).toBe(0) // gross savings are untouched by a reversal
  })

  it('charges a PROXY-origin give-back to the PROXY ledger, not the tool one', async () => {
    // The wire proxy issues nearly every token an agent actually redeems. Billing those to the
    // tool ledger is what drove the receipt to -4,600,801 against a real +450,150,158 saved.
    resetProxyLedger()
    ccrPut('hr_proxyorigin', { big: 'y'.repeat(1000) }, 'proxy')
    await executeTool('retrieve_full', { token: 'hr_proxyorigin' }, handlers())
    expect(summarizeSavings().session.givebackTokens).toBe(0)
    const p = summarizeProxySavings().session
    expect(p.givebackTokens).toBeGreaterThan(0)
    expect(p.retrieves).toBe(1)
  })

  it('returns a clear expired message for an unknown token (never throws)', async () => {
    const out = await executeTool('retrieve_full', { token: 'hr_gone' }, handlers()) as { error: string }
    expect(out.error).toBe('expired')
  })

  it('charges a give-back ONCE per token, however many times it is redeemed', async () => {
    // A give-back reverses one compression event. Agents re-read a token freely — a retry after a
    // failed turn, a second reference to the same result — and billing each of those made the
    // receipt read pessimistically low against savings that were never given back.
    const token = ccrStash({ big: 'x'.repeat(1000) })
    await executeTool('retrieve_full', { token }, handlers())
    const once = summarizeSavings().session.givebackTokens
    await executeTool('retrieve_full', { token }, handlers())
    await executeTool('retrieve_full', { token }, handlers())
    expect(summarizeSavings().session.givebackTokens).toBe(once)
    expect(summarizeSavings().session.retrieves).toBe(1)
  })

  it('charges each DISTINCT token its own give-back', async () => {
    const a = ccrStash({ big: 'a'.repeat(1000) })
    const b = ccrStash({ big: 'b'.repeat(2000) })
    await executeTool('retrieve_full', { token: a }, handlers())
    const afterA = summarizeSavings().session.givebackTokens
    await executeTool('retrieve_full', { token: b }, handlers())
    expect(summarizeSavings().session.givebackTokens).toBeGreaterThan(afterA)
    expect(summarizeSavings().session.retrieves).toBe(2)
  })

  it('charges a repeated PROXY give-back once too', async () => {
    resetProxyLedger()
    ccrPut('hr_proxyrepeat', { big: 'y'.repeat(1000) }, 'proxy')
    await executeTool('retrieve_full', { token: 'hr_proxyrepeat' }, handlers())
    const once = summarizeProxySavings().session.givebackTokens
    await executeTool('retrieve_full', { token: 'hr_proxyrepeat' }, handlers())
    expect(summarizeProxySavings().session.givebackTokens).toBe(once)
    expect(summarizeProxySavings().session.retrieves).toBe(1)
  })

  it('books a real miss on the LEDGER only when content was actually destroyed', async () => {
    // Overfill the memory tier with no durable tier behind it (no ccr dir in this suite), so the
    // LRU has to drop a record that exists nowhere else. That is the one event in this store
    // that genuinely breaks a retrieve_full promise, and the only one the alarm should fire on.
    const doomed = ccrStash({ v: 'the only copy' })
    for (let i = 0; i <= CCR_MAX_ENTRIES; i++) ccrStash({ filler: i })
    expect(await retrieveFull(doomed)).toMatchObject({ error: 'expired' })
    expect(summarizeSavings().session.retrieveMisses).toBe(1)
    expect(summarizeSavings().session.retrieveUnknownTokens).toBe(0)
  })

  it('does NOT raise the alarm for a well-shaped token it has no record of holding', async () => {
    // hr_ + 16 hex is the shape this app mints, but tokens ARE content hashes, so a typo of a
    // real token lands in the same space. Reading shape as proof of issuance is what reported
    // four destroyed elisions when nothing had been destroyed.
    await retrieveFull('hr_0123456789abcdef')
    expect(summarizeSavings().session.retrieveMisses).toBe(0)
    expect(summarizeSavings().session.retrieveUnknownTokens).toBe(1)
    expect(summarizeSavings().session.retrieveBadTokens).toBe(0)
  })

  it('does not raise the alarm for a token shape it never issued', async () => {
    await retrieveFull('hr_madeUpByTheModel')
    expect(summarizeSavings().session.retrieveMisses).toBe(0)
    expect(summarizeSavings().session.retrieveUnknownTokens).toBe(0)
    expect(summarizeSavings().session.retrieveBadTokens).toBe(1)
  })

  it('waits for a stash still crossing the process boundary instead of booking a miss', async () => {
    // OBSERVED 2026-09-09: a redemption booked a miss at 22:37:20.889Z for a token whose file
    // landed at 22:37:20.891Z — it lost to its own stash by two milliseconds. The proxy commits
    // originals from the CHILD process over parentPort while retrieve_full arrives on a loopback
    // socket into MAIN: two queues with no ordering between them. Answering the first lookup is
    // how a token that was never lost gets reported as lost content forever.
    const token = 'hr_' + 'ab'.repeat(8)
    setTimeout(() => ccrPut(token, { late: true }, 'proxy'), 40)
    expect(await retrieveFull(token)).toEqual({ late: true })
    expect(summarizeSavings().session.retrieveMisses).toBe(0)
    expect(summarizeSavings().session.retrieveUnknownTokens).toBe(0)
  })
})
