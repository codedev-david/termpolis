import { describe, it, expect, vi } from 'vitest'
import { executeTool, type McpToolHandlers } from '../../src/main/mcpServer'

/**
 * test_coverage closes the last blind spot in the diff story: the ChangesPanel can already
 * paint coverage against a hunk, but the agent writing the code could not see it at all.
 * These cover the dispatch wiring — that the bounds reach the handler and the verdict comes
 * back whole.
 */
describe('test_coverage dispatch', () => {
  function withHandler(result: Record<string, unknown>) {
    const testCoverage = vi.fn().mockReturnValue(result)
    return { testCoverage, handlers: { testCoverage } as unknown as McpToolHandlers }
  }

  it('forwards the file and the optional hunk bounds', async () => {
    const { testCoverage, handlers } = withHandler({ file: 'a.ts', hasCoverage: true })
    await executeTool(
      'test_coverage',
      { file: 'a.ts', cwd: '/repo', startLine: 10, endLine: 20 },
      handlers,
    )
    expect(testCoverage).toHaveBeenCalledWith({
      file: 'a.ts', cwd: '/repo', startLine: 10, endLine: 20,
    })
  })

  it('asks about the whole file when no bounds are given', async () => {
    const { testCoverage, handlers } = withHandler({ file: 'a.ts', hasCoverage: true })
    await executeTool('test_coverage', { file: 'a.ts' }, handlers)
    expect(testCoverage).toHaveBeenCalledWith({
      file: 'a.ts', cwd: undefined, startLine: undefined, endLine: undefined,
    })
  })

  it('returns the verdict whole', async () => {
    const { handlers } = withHandler({
      file: 'a.ts', hasCoverage: true, covered: 3, total: 4, percent: 75,
      uncovered: [12], stale: false, source: '/repo/coverage/lcov.info',
    })
    expect(await executeTool('test_coverage', { file: 'a.ts' }, handlers))
      .toMatchObject({ percent: 75, uncovered: [12] })
  })

  it('passes "this repo has no coverage" through as an answer, not an error', async () => {
    // Most repositories have never produced an lcov file. That is the common case, and an
    // agent that reads it as a tool failure will retry instead of running the tests.
    const { handlers } = withHandler({
      file: 'a.ts', hasCoverage: false, hint: 'No coverage artifact found',
    })
    const res = await executeTool('test_coverage', { file: 'a.ts' }, handlers) as {
      hasCoverage: boolean; hint: string
    }
    expect(res.hasCoverage).toBe(false)
    expect(res.hint).toContain('No coverage artifact')
  })
})
