import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))
const { executeTool } = await import('../../src/main/mcpServer')
import type { McpToolHandlers } from '../../src/main/mcpServer'
import { retrieveFull } from '../../src/main/headroom/compressToolResult'
import { ccrStash, ccrPut, resetCcr } from '../../src/main/headroom/ccrStore'
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
})
