// Wave 2 batch C — ingest correctness: stale code chunks, dropped array-content user turns,
// and conversation-time backbone (follows) edges.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  memoryPruneCodePath,
  memoryLink,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'
import { ingestCode, type CodeIngestDeps } from '../../src/main/codeIngest'
import { parseClaudeTranscript } from '../../src/main/conversationIngest'

let userDir: string
beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-w2c-'))
  _resetForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  try { fs.rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('codeIngest-stale-chunks', () => {
  it('memoryPruneCodePath removes only the target file\'s code chunks', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'code-index', kind: 'note', source: 'code', content: '/repo/foo.ts:1-3\nold body', hash: 'c1' })
    await memoryWrite({ agentId: 'code-index', kind: 'note', source: 'code', content: '/repo/foo.ts:4-6\nmore old', hash: 'c2' })
    await memoryWrite({ agentId: 'code-index', kind: 'note', source: 'code', content: '/repo/bar.ts:1-3\nother file', hash: 'c3' })
    expect(memoryPruneCodePath('/repo/foo.ts')).toBe(2)
    expect(memoryList().some((e) => e.content.includes('old body'))).toBe(false)
    expect(memoryList().some((e) => e.content.includes('other file'))).toBe(true) // sibling file untouched
  })

  it('re-indexing prunes a changed file and skips an unchanged one', async () => {
    let content = 'alpha\nbravo\ncharlie\ndelta'
    const stored = new Set<string>()
    const pruned: string[] = []
    const deps: CodeIngestDeps = {
      listFiles: async () => ['/repo/a.ts'],
      readFile: async () => content,
      hasHash: (h) => stored.has(h),
      write: async (c) => { stored.add(c.hash) },
      prunePath: (_fp) => { pruned.push(_fp); stored.clear() }, // simulate: prune frees the file's hashes
      chunkOptions: { maxLines: 2 },
    }
    await ingestCode(deps)
    const afterFirst = pruned.length // first index prunes a no-op (nothing stored yet)
    await ingestCode(deps) // unchanged → no prune, all chunks skipped
    expect(pruned.length).toBe(afterFirst)
    content = 'NEW LINE\n' + content // edit shifts every chunk's line numbers → new hashes
    await ingestCode(deps)
    expect(pruned.length).toBe(afterFirst + 1) // the changed file was pruned before re-write
  })
})

describe('claude-array-content-user-turns-dropped', () => {
  it('keeps a user turn whose content is an array (image + text blocks)', () => {
    const line = JSON.stringify({
      sessionId: 's', type: 'user', timestamp: new Date(0).toISOString(),
      message: { role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'what does this diagram show?' }] },
    })
    const turns = parseClaudeTranscript(line)
    expect(turns.some((t) => t.text.includes('what does this diagram show'))).toBe(true)
  })

  it('still skips a pure tool_result array turn', () => {
    const line = JSON.stringify({
      sessionId: 's', type: 'user', timestamp: new Date(0).toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', content: 'some tool output' }] },
    })
    expect(parseClaudeTranscript(line).length).toBe(0)
  })
})

describe('ingest-follows-edges-ts-now', () => {
  it('memoryLink threads a conversation ts into the edge', () => {
    initSwarmMemory(userDir)
    const OLD = Date.UTC(2020, 0, 1)
    const edge = memoryLink({ from: 'a', to: 'b', relation: 'follows', ts: OLD })
    expect(edge?.ts).toBe(OLD)
  })
})
