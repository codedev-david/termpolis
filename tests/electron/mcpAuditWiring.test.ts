// WP-E — agent-facing recall and context injection are audited at the MCP boundary (executeTool),
// with the query redacted. This is the "what did my memory recall / inject into an agent" trail.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { executeTool, executeToolForWorkflow, initAuditLog } from '../../src/main/mcpServer'
import { initMemoryAudit, readMemoryAudit, _resetMemoryAuditForTests } from '../../src/main/memoryAudit'
import { offMainFiles } from '../../src/main/offMainFiles'

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

  it('audits an agent-facing recall with who asked, how many it found and the top ids, but not what it asked', async () => {
    // 1.55.0: the query is the beginning of whatever the agent (or, with the prompt-time hook, the user) just
    // typed. It used to be kept, redacted; the audit now keeps no query text at all, so there is nothing to redact.
    const secret = 'sk-' + 'a'.repeat(40)
    await executeTool('memory_search', { query: 'find ' + secret + ' in the billing module', agentId: 'agentZ' }, handlers)
    await offMainFiles.idle()
    const rec = readMemoryAudit().find((e) => e.event === 'recall') as
      | { event: 'recall'; agentId?: string; results: number; topIds: string[] } | undefined
    expect(rec).toMatchObject({ event: 'recall', agentId: 'agentZ', results: 3 })
    expect(rec!.topIds).toEqual(['m1', 'm2', 'm3'])
    expect(rec).not.toHaveProperty('query')
    const onDisk = fs.readFileSync(path.join(tmp, 'memory-audit.jsonl'), 'utf8')
    expect(onDisk).not.toContain(secret)
    expect(onDisk).not.toContain('billing')
  })

  // PRIVACY.md and the documentation say a recall records "the ids of the top few": five at most, however many it found.
  it.each([
    ['memory_search', { query: 'q', agentId: 'agentZ' }],
    ['memory_related', { id: 'seed' }],
  ])('%s records the ids of the top five it found and no more', async (tool, args) => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `r${i + 1}` }))
    const wide = { memorySearch: async () => many, memoryRelated: async () => many } as unknown as Parameters<typeof executeTool>[2]
    await executeTool(tool, args, wide)
    await offMainFiles.idle()
    const rec = readMemoryAudit().find((e) => e.event === 'recall') as { event: 'recall'; results: number; topIds: string[] } | undefined
    expect(rec!.results).toBe(8)
    expect(rec!.topIds).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])
  })

  it('audits primer injection with an approximate token count', async () => {
    await executeTool('memory_primer', { cwd: '/x' }, handlers)
    await offMainFiles.idle()
    const inj = readMemoryAudit().find((e) => e.event === 'inject') as
      | { event: 'inject'; target: string; approxTokens: number } | undefined
    expect(inj).toMatchObject({ event: 'inject', target: 'primer' })
    expect(inj!.approxTokens).toBe(100) // 400 chars / 4
  })

  // The bug 1.55.0 fixes: the store's process wrote its audit file, but the events an agent causes (a recall, an
  // injected primer) are raised in the main process, whose copy of the audit was never started, so memory_audit
  // listed the host's writes and nothing an agent did. Here main starts its own side, the host's file is one
  // written by "another process", and the tool shows both.
  it('shows what agents did in main beside what the memory host wrote, through memory_audit', async () => {
    _resetMemoryAuditForTests()
    fs.writeFileSync(path.join(tmp, 'memory-audit.jsonl'), JSON.stringify({ ts: 1, event: 'write', id: 'w1', kind: 'fact', preview: 'stored by the host' }) + '\n')
    initMemoryAudit(tmp, 'main')
    await executeTool('memory_search', { query: 'where is the billing code', agentId: 'codex' }, handlers)
    await executeTool('memory_primer', { cwd: '/x' }, handlers)
    const out = (await executeTool('memory_audit', { limit: 10 }, handlers)) as
      { events: Array<{ event: string; agentId?: string }>; summary: Record<string, number> }
    expect(out.summary).toEqual({ write: 1, recall: 1, inject: 1 })
    expect(out.events.map((e) => e.event).sort()).toEqual(['inject', 'recall', 'write'])
    expect(out.events.find((e) => e.event === 'recall')).toMatchObject({ agentId: 'codex' })
    expect(JSON.stringify(out)).not.toContain('billing') // and no query text came back out of it
    expect(fs.existsSync(path.join(tmp, 'memory-audit-main.jsonl'))).toBe(true)
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

describe("a workflow step's tool call", () => {
  it("is audited as an agent's is: the recall trail, and an mcp-audit.log line marked via workflow", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpaudit-wf-'))
    _resetMemoryAuditForTests()
    initMemoryAudit(tmp)
    initAuditLog(tmp)
    try {
      await executeToolForWorkflow('memory_search', { query: 'alpha', agentId: 'wf' }, handlers)
      await offMainFiles.idle()
      expect(readMemoryAudit().find((e) => e.event === 'recall')).toMatchObject({ agentId: 'wf', results: 3 })
      // The audit stream writes asynchronously.
      await vi.waitFor(() => {
        const lines = fs.readFileSync(path.join(tmp, 'mcp-audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        expect(lines).toContainEqual(expect.objectContaining({ method: 'tools/call', tool: 'memory_search', status: 'ok', via: 'workflow' }))
      })
    } finally {
      _resetMemoryAuditForTests()
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* the audit stream may still hold it */ }
    }
  })
})
