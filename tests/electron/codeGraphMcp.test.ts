import { describe, it, expect, vi, afterEach } from 'vitest'
import { executeTool, type McpToolHandlers } from '../../src/main/mcpServer'
import { indexFileContent, rebuildEdges, codeExplore, codeImpact, _resetCodeGraphForTests } from '../../src/main/codeGraph'

afterEach(() => _resetCodeGraphForTests())

describe('code_* MCP dispatch', () => {
  it('routes each code tool to its handler with the right args', async () => {
    const codeExploreH = vi.fn().mockReturnValue({ symbol: { name: 'x' } })
    const codeCallers = vi.fn().mockReturnValue([])
    const codeCallees = vi.fn().mockReturnValue([])
    const codeImpactH = vi.fn().mockReturnValue([])
    const codeSearch = vi.fn().mockReturnValue([])
    const handlers = { codeExplore: codeExploreH, codeCallers, codeCallees, codeImpact: codeImpactH, codeSearch } as unknown as McpToolHandlers

    await executeTool('code_explore', { query: 'memoryWrite' }, handlers)
    expect(codeExploreH).toHaveBeenCalledWith({ query: 'memoryWrite' })
    await executeTool('code_callers', { name: 'beta' }, handlers)
    expect(codeCallers).toHaveBeenCalledWith({ name: 'beta' })
    await executeTool('code_callees', { name: 'alpha' }, handlers)
    expect(codeCallees).toHaveBeenCalledWith({ name: 'alpha' })
    await executeTool('code_impact', { name: 'beta' }, handlers)
    expect(codeImpactH).toHaveBeenCalledWith({ name: 'beta' })
    await executeTool('code_search', { query: 'mem', limit: 10 }, handlers)
    expect(codeSearch).toHaveBeenCalledWith({ query: 'mem', limit: 10 })
  })
})

describe('code graph — the wired handler path over a real index', () => {
  const src = 'export function alpha() {\n  return beta()\n}\nexport function beta() { return 1 }\nexport function gamma() { return alpha() }'
  it('code_explore returns source + callees; code_impact returns the blast radius', () => {
    indexFileContent('a.ts', src)
    rebuildEdges()
    const res = codeExplore('alpha', () => src) // the exact call index.ts codeExplore handler makes
    expect(res?.symbol.name).toBe('alpha')
    expect(res?.source).toContain('return beta()')
    expect(res?.callees.map((s) => s.name)).toContain('beta')
    expect(codeImpact('beta').map((s) => s.name).sort()).toEqual(['alpha', 'gamma'])
  })
})
