// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { CodeGraphPanel } from '../../src/renderer/src/components/Memory/CodeGraphPanel'

type Api = Record<string, ReturnType<typeof vi.fn>>

function setApi(overrides: Partial<Api> = {}): Api {
  const sym = (name: string) => ({ id: `a#${name}@1`, name, kind: 'function', file: '/repo/a.ts', startLine: 1, endLine: 5, lang: 'ts' })
  const api: Api = {
    codeGraphStats: vi.fn().mockResolvedValue({ success: true, data: { files: 10, symbols: 42, edges: 99 } }),
    codeGraphSearch: vi.fn().mockResolvedValue({ success: true, data: [sym('foo')] }),
    codeGraphExplore: vi.fn().mockResolvedValue({
      success: true,
      data: { symbol: sym('foo'), source: 'function foo() { return bar() }', callers: [{ name: 'caller1' }], callees: [{ name: 'bar' }] },
    }),
    codeGraphImpact: vi.fn().mockResolvedValue({ success: true, data: [{ name: 'x' }, { name: 'y' }] }),
    codeGraphBuild: vi.fn().mockResolvedValue({ success: true, data: { files: 12, symbols: 50, edges: 120 } }),
    gitFindRoot: vi.fn().mockResolvedValue({ success: true, data: '/repo' }),
    ...overrides,
  }
  ;(window as unknown as { termpolis: Api }).termpolis = api
  return api
}

describe('CodeGraphPanel', () => {
  it('shows graph stats on mount', async () => {
    setApi()
    render(<CodeGraphPanel cwd="/repo/sub" />)
    await waitFor(() => expect(screen.getByTestId('code-graph-stats').textContent).toContain('42 symbols'))
  })

  it('searches, then explores a symbol — source, callers, callees, blast radius', async () => {
    const api = setApi()
    render(<CodeGraphPanel cwd="/repo/sub" />)
    fireEvent.change(screen.getByTestId('code-graph-search'), { target: { value: 'foo' } })
    fireEvent.click(screen.getByTestId('code-graph-search-btn'))
    await waitFor(() => screen.getByTestId('cg-sym-foo'))
    fireEvent.click(screen.getByTestId('cg-sym-foo'))
    await waitFor(() => screen.getByTestId('code-graph-detail'))
    expect(screen.getByTestId('code-graph-impact').textContent).toContain('2')
    expect(screen.getByTestId('code-graph-source').textContent).toContain('return bar()')
    expect(screen.getByTestId('code-graph-detail').textContent).toContain('bar') // callee
    expect(screen.getByTestId('code-graph-detail').textContent).toContain('caller1') // caller
    expect(api.codeGraphExplore).toHaveBeenCalledWith('foo')
    expect(api.codeGraphImpact).toHaveBeenCalledWith('foo')
  })

  it('rebuild resolves the git root from the cwd and re-indexes', async () => {
    const api = setApi()
    render(<CodeGraphPanel cwd="/repo/sub" />)
    fireEvent.click(screen.getByTestId('code-graph-rebuild'))
    await waitFor(() => expect(screen.getByTestId('code-graph-status').textContent).toContain('Indexed 50 symbols'))
    expect(api.gitFindRoot).toHaveBeenCalledWith('/repo/sub')
    expect(api.codeGraphBuild).toHaveBeenCalledWith('/repo')
  })

  it('shows an empty state when the graph has no symbols yet', async () => {
    setApi({ codeGraphStats: vi.fn().mockResolvedValue({ success: true, data: { files: 0, symbols: 0, edges: 0 } }) })
    render(<CodeGraphPanel cwd="/repo" />)
    await waitFor(() => screen.getByTestId('code-graph-empty'))
  })

  it('rebuild outside a git repo prompts to open one, and does not build', async () => {
    const api = setApi({ gitFindRoot: vi.fn().mockResolvedValue({ success: false }) })
    render(<CodeGraphPanel cwd="/tmp/plain" />)
    fireEvent.click(screen.getByTestId('code-graph-rebuild'))
    await waitFor(() => expect(screen.getByTestId('code-graph-status').textContent).toContain('git repo'))
    expect(api.codeGraphBuild).not.toHaveBeenCalled()
  })
})
