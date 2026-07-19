import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))
const { executeTool } = await import('../../src/main/mcpServer')
import type { McpToolHandlers } from '../../src/main/mcpServer'
import { retrieveFull } from '../../src/main/headroom/compressToolResult'
import { ccrStash, resetCcr } from '../../src/main/headroom/ccrStore'
import { resetLedger, summarizeSavings } from '../../src/main/headroom/savingsLedger'

// The app wires handlers.retrieveFull to the real headroom retrieveFull (index.ts).
const handlers = () => ({ retrieveFull } as unknown as McpToolHandlers)

describe('retrieve_full tool', () => {
  beforeEach(() => { resetCcr(); resetLedger() })

  it('returns the stashed original for a known token', async () => {
    const original = { hits: [1, 2, 3] }
    const token = ccrStash(original)
    expect(await executeTool('retrieve_full', { token }, handlers())).toEqual(original)
  })

  it('records the give-back as a negative saving (honest net)', async () => {
    const token = ccrStash({ big: 'x'.repeat(1000) })
    await executeTool('retrieve_full', { token }, handlers())
    expect(summarizeSavings().session.netSaved).toBeLessThan(0)
  })

  it('returns a clear expired message for an unknown token (never throws)', async () => {
    const out = await executeTool('retrieve_full', { token: 'hr_gone' }, handlers()) as { error: string }
    expect(out.error).toBe('expired')
  })
})
