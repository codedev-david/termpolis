import { describe, it, expect } from 'vitest'
const { route, isExempt, EXEMPT_TOOLS } = await import('../../src/main/headroom/router')

describe('router', () => {
  it('exempts every memory_* tool', () => {
    for (const t of ['memory_search', 'memory_primer', 'memory_list', 'memory_related', 'memory_graph', 'memory_write'])
      expect(route(t, [{ a: 1 }])).toBe('exempt')
  })

  it('exempts swarm_*, control tools, and retrieve_full', () => {
    for (const t of ['swarm_list_tasks', 'create_terminal', 'run_command', 'write_to_terminal', 'list_terminals', 'retrieve_full'])
      expect(isExempt(t)).toBe(true)
  })

  it('routes code_search array results to the array compressor', () => {
    expect(route('code_search', [{ name: 'x' }])).toBe('array')
    expect(route('get_file_tree', [{ name: 'a', isDir: true }])).toBe('array')
  })

  it('routes object results to the object compressor', () => {
    expect(route('read_output', { output: 'x' })).toBe('object')
    expect(route('code_explore', { symbol: {}, source: '' })).toBe('object')
    expect(route('get_git_status', { status: '', branch: 'main', recentCommits: '' })).toBe('object')
  })

  it('exempts primitives and null (nothing to compress)', () => {
    expect(route('code_explore', null)).toBe('exempt')
    expect(route('read_output', 'plain')).toBe('exempt')
  })

  it('exposes the exempt list', () => {
    expect(EXEMPT_TOOLS).toContain('retrieve_full')
  })
})
