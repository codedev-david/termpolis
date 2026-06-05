import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { McpToolHandlers } from '../../src/main/mcpServer'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryList,
  memoryHasHash,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { runConversationIngest } from '../../src/main/conversationIngest'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const { executeTool } = await import('../../src/main/mcpServer')

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mem-'))
  _resetForTests()
  initSwarmMemory(tmpDir)
  _setEmbeddingsAvailable(false) // keyword mode → deterministic, no model needed
})
afterEach(() => {
  _resetForTests()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// The memory_* tools only touch the memory handlers; one server instance backs
// all four agents (Claude/Codex/Gemini/Qwen), so a write by one is visible to
// every other — that's what "shared brain" means, proven through the exact
// dispatch path the agents use.
const handlers = (): McpToolHandlers => ({ memoryWrite, memorySearch, memoryList } as unknown as McpToolHandlers)

describe('MCP shared brain — the dispatch path all four agents use', () => {
  it('one agent writes via memory_write; another retrieves it via memory_search', async () => {
    await executeTool('memory_write', { agentId: 'claude', kind: 'message', content: 'auth uses JWT middleware' }, handlers())
    const results = await executeTool('memory_search', { query: 'authentication middleware' }, handlers())
    expect(Array.isArray(results)).toBe(true)
    expect(results.some((r: { content: string }) => r.content.includes('JWT'))).toBe(true)
  })

  it('memory_list returns recent entries through the tool layer', async () => {
    await executeTool('memory_write', { agentId: 'codex', kind: 'note', content: 'a recorded decision' }, handlers())
    const list = await executeTool('memory_list', { limit: 10 }, handlers())
    expect(list.length).toBe(1)
    expect(list[0].agentId).toBe('codex')
  })

  it('ingested transcript chunks are retrievable via memory_search (ingest → MCP)', async () => {
    const proj = path.join(tmpDir, 'proj')
    fs.mkdirSync(proj)
    fs.writeFileSync(
      path.join(proj, 's.jsonl'),
      '{"type":"user","message":{"role":"user","content":"please implement rate limit on the public api"}}',
    )
    await runConversationIngest(
      { hasHash: memoryHasHash, write: memoryWrite },
      { sources: ['claude'], roots: { claude: proj }, chunkOptions: { maxChars: 5000 } },
    )
    const results = await executeTool('memory_search', { query: 'rate limit' }, handlers())
    expect(results.some((r: { content: string }) => r.content.includes('rate limit'))).toBe(true)
  })

  it('throws on an unknown tool', async () => {
    await expect(executeTool('bogus_tool', {}, handlers())).rejects.toThrow(/Unknown tool/)
  })
})
