// The headline promise, proven with the REAL model: one agent writes a fact,
// a DIFFERENT agent recalls it from a paraphrase (no keyword overlap) — through
// the exact MCP dispatch path (`executeTool`) every agent uses. Keyword search
// could never pass these: the query shares no salient words with the answer, so
// a hit means real semantic embeddings are working end-to-end.
//
// Gated on the real bge model (dev cache OR CI package-verify's resources/models
// — see _modelFixture). This is what un-gates semantic recall in CI.
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
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { _resetEmbedderForTests, isEmbedderReady } from '../../src/main/localEmbedder'
import { hasBundledModel } from './_modelFixture'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))
const { executeTool } = await import('../../src/main/mcpServer')

// One server instance backs all four agents (Claude/Codex/Gemini/Qwen); these
// handlers are the same the live server dispatches to.
const handlers = (): McpToolHandlers => ({ memoryWrite, memorySearch, memoryList } as unknown as McpToolHandlers)

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-semantic-'))
  _resetForTests()
  _resetEmbedderForTests() // no injected backend → loads the real model
  _setEmbeddingsAvailable(null) // probe the real embedder (do NOT force keyword mode)
  initSwarmMemory(tmp)
})
afterEach(() => {
  _resetForTests()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe.skipIf(!hasBundledModel)('shared brain — real-model cross-agent SEMANTIC recall', () => {
  it('agent B recalls agent A\'s decision from a paraphrase with no shared keywords', async () => {
    // Agent A (claude) records a throttling decision...
    await executeTool(
      'memory_write',
      { agentId: 'claude', kind: 'decision', content: 'We throttle the public REST API to 100 requests per minute per IP using a token-bucket algorithm.' },
      handlers(),
    )
    // ...plus a semantically-distant distractor so a hit can't be coincidence.
    await executeTool(
      'memory_write',
      { agentId: 'claude', kind: 'note', content: 'The mobile onboarding screens use a teal and charcoal colour palette with rounded cards.' },
      handlers(),
    )

    // Agent B (codex) asks a paraphrased question — almost no overlapping words
    // with the stored decision ("throttle/token-bucket/requests" vs "stop/
    // hammering/endpoints/often").
    const results = await executeTool(
      'memory_search',
      { query: 'how do we stop clients from hammering our endpoints too often?', limit: 3 },
      handlers(),
    )

    expect(isEmbedderReady()).toBe(true) // real model actually loaded
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
    // The throttling decision must rank first, above the colour-palette note.
    expect(results[0].content).toMatch(/throttle|token-bucket|100 requests/i)
    const contents: string[] = results.map((r: { content: string }) => r.content)
    const throttleRank = contents.findIndex((c) => /throttle|token-bucket/i.test(c))
    const colourRank = contents.findIndex((c) => /colour palette/i.test(c))
    if (colourRank !== -1) expect(throttleRank).toBeLessThan(colourRank)
  }, 60_000)

  it('memory_write embeds entries with the real 384-dim model', async () => {
    const written = await executeTool(
      'memory_write',
      { agentId: 'gemini', kind: 'fact', content: 'The Postgres connection pool max size is 20.' },
      handlers(),
    )
    expect(written.embedding).toBeTruthy()
    expect(Array.isArray(written.embedding)).toBe(true)
    expect(written.embedding.length).toBe(384)
  }, 60_000)

  it('recall survives a restart — durable JSONL reload keeps the shared brain', async () => {
    await executeTool(
      'memory_write',
      { agentId: 'claude', kind: 'fact', content: 'Database migrations live in db/migrations and run automatically on boot.' },
      handlers(),
    )
    // Simulate an app restart: drop in-RAM state, reload from the same JSONL.
    _resetEmbedderForTests()
    _setEmbeddingsAvailable(null)
    initSwarmMemory(tmp) // re-reads tmp/swarm-memory.jsonl

    const results = await executeTool(
      'memory_search',
      { query: 'where are the schema change scripts kept?', limit: 3 },
      handlers(),
    )
    expect(results.some((r: { content: string }) => /db\/migrations/i.test(r.content))).toBe(true)
  }, 60_000)
})
