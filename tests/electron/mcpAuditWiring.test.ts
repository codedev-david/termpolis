// WP-E — agent-facing recall and context injection are audited at the MCP boundary (executeTool),
// with the query redacted. This is the "what did my memory recall / inject into an agent" trail.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { executeTool } from '../../src/main/mcpServer'
import { initMemoryAudit, readMemoryAudit, _resetMemoryAuditForTests } from '../../src/main/memoryAudit'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

// Minimal stub handlers — only the three agent-facing recall/inject tools are exercised.
const handlers = {
  memorySearch: async () => [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
  memoryPrimer: async () => ({ project: 'x', primer: 'p'.repeat(400) }),
  memoryRelated: async () => [{ id: 'r1' }],
} as unknown as Parameters<typeof executeTool>[2]

describe('MCP recall/inject audit (WP-E)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpaudit-'))
    _resetMemoryAuditForTests()
    initMemoryAudit(tmp)
  })
  afterEach(() => {
    _resetMemoryAuditForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('audits an agent-facing recall with a redacted query, count, and top ids', async () => {
    const secret = 'sk-' + 'a'.repeat(40)
    await executeTool('memory_search', { query: 'find ' + secret, agentId: 'agentZ' }, handlers)
    const rec = readMemoryAudit().find((e) => e.event === 'recall') as
      | { event: 'recall'; agentId?: string; query: string; results: number; topIds: string[] } | undefined
    expect(rec).toMatchObject({ event: 'recall', agentId: 'agentZ', results: 3 })
    expect(rec!.topIds).toEqual(['m1', 'm2', 'm3'])
    expect(rec!.query).not.toContain(secret) // redacted
  })

  it('audits primer injection with an approximate token count', async () => {
    await executeTool('memory_primer', { cwd: '/x' }, handlers)
    const inj = readMemoryAudit().find((e) => e.event === 'inject') as
      | { event: 'inject'; target: string; approxTokens: number } | undefined
    expect(inj).toMatchObject({ event: 'inject', target: 'primer' })
    expect(inj!.approxTokens).toBe(100) // 400 chars / 4
  })

  it('exposes the audit for inspection via the memory_audit tool (events + summary)', async () => {
    await executeTool('memory_search', { query: 'alpha', agentId: 'a' }, handlers)
    await executeTool('memory_primer', { cwd: '/x' }, handlers)
    const out = (await executeTool('memory_audit', { limit: 10 }, handlers)) as
      { events: Array<{ event: string }>; summary: Record<string, number> }
    expect(out.summary).toMatchObject({ recall: 1, inject: 1 })
    expect(out.events.map((e) => e.event).sort()).toEqual(['inject', 'recall'])
  })
})
