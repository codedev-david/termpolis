import { describe, it, expect, vi } from 'vitest'
import { executeTool, type McpToolHandlers } from '../../src/main/mcpServer'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

// Covers the memory_selfcheck MCP dispatch (the metacognition tool, P1c). The
// handler itself is the mnemeCompetence store, unit-tested separately; here we
// prove the tool routes the domain through and returns the assessment.
describe('memory_selfcheck MCP tool', () => {
  it('dispatches to the memorySelfcheck handler with the domain', async () => {
    const memorySelfcheck = vi
      .fn()
      .mockReturnValue({ known: true, confidence: 0.9, attempts: 5, verdict: 'confident', summary: '' })
    const handlers = { memorySelfcheck } as unknown as McpToolHandlers
    const res = await executeTool('memory_selfcheck', { domain: 'termpolis' }, handlers)
    expect(memorySelfcheck).toHaveBeenCalledWith({ domain: 'termpolis' })
    expect(res).toMatchObject({ verdict: 'confident', confidence: 0.9 })
  })
})
