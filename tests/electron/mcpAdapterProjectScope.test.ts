// F31 — curated agent memory_write defaulted to UNSCOPED (project only set if the model
// remembered to pass it), so high-value decisions missed current-directory recall. The
// stdio adapter now defaults `project` to its own cwd (= the terminal's directory) for
// memory_write when the agent omits it. Search/primer are intentionally left alone.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { applyDefaultProjectScope } = require('../../src/mcp-adapter/stdio-adapter.cjs')

describe('F31: adapter defaults a curated write to the terminal cwd', () => {
  it('injects project=cwd for memory_write when omitted', () => {
    const req = { method: 'tools/call', params: { name: 'memory_write', arguments: { content: 'we chose Postgres' } } }
    applyDefaultProjectScope(req, '/repos/foo')
    expect(req.params.arguments.project).toBe('/repos/foo')
  })

  it('does not override an explicit project the agent supplied', () => {
    const req = { method: 'tools/call', params: { name: 'memory_write', arguments: { content: 'x', project: '/repos/bar' } } }
    applyDefaultProjectScope(req, '/repos/foo')
    expect(req.params.arguments.project).toBe('/repos/bar')
  })

  it('does NOT default memory_search (would narrow a global search)', () => {
    const req = { method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'q' } } }
    applyDefaultProjectScope(req, '/repos/foo')
    expect(req.params.arguments.project).toBeUndefined()
  })

  it('is a no-op for non-tool-call requests', () => {
    const req = { method: 'tools/list', id: 1 }
    expect(() => applyDefaultProjectScope(req, '/repos/foo')).not.toThrow()
  })
})
