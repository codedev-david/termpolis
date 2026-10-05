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

  it('exempts agent_exec, whose result the CLI parses as JSON', () => {
    // A compacted result swaps the long `output` for a retrieve_full token, and the text that
    // reaches `termpolis-cli exec` is then no longer the JSON it parses.
    expect(EXEMPT_TOOLS).toContain('agent_exec')
    expect(route('agent_exec', { ok: true, output: 'x'.repeat(50_000) })).toBe('exempt')
    expect(isExempt('mcp__termpolis__agent_exec')).toBe(true)
  })

  it('exempts linked_machines, whose answer is a whole agent run on another machine', () => {
    // Compacted, the answer would hide behind a retrieve_full token that expires, and the advice
    // for an expired token, re-run the tool, would run the remote agent again.
    expect(EXEMPT_TOOLS).toContain('linked_machines')
    expect(route('linked_machines', { jobId: 'a-b', status: 'done', output: 'x'.repeat(50_000) })).toBe('exempt')
    expect(isExempt('mcp__termpolis__linked_machines')).toBe(true)
  })
})
