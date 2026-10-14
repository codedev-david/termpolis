// The memory indexer and the sessions headless runs leave behind. A job another computer ran here
// over Linked machines is skipped whole, and counted; the user's own sessions are ingested exactly
// as before, chunk hashes and all, so nothing already stored is re-deposited; a local headless
// run's memory primer is left out, so recalled memory is not stored a second time.
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  chunkTurns,
  ingestConversations,
  parseBySource,
  runConversationIngest,
  type ConversationSource,
  type IngestChunk,
  type IngestDeps,
  type IngestMemory,
} from '../../src/main/conversationIngest'
import { buildExecPrompt } from '../../src/main/headlessExec'
import { delegationHeader } from '../../src/shared/headlessPrompt'

const HEADER = delegationHeader('laptop', '/home/me/repos/app')
const PRIMER = ['Past conversations in app:', '- [claude · 2d ago] the parser lives in src/parse.ts'].join('\n')

/** A Claude Code session file: one user prompt, one answer. */
function claudeSession(id: string, prompt: string, answer: string): string {
  return [
    JSON.stringify({ type: 'user', sessionId: id, cwd: '/home/me/repos/app', timestamp: '2026-10-10T10:00:00.000Z', message: { role: 'user', content: prompt } }),
    JSON.stringify({ type: 'assistant', sessionId: id, timestamp: '2026-10-10T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } }),
  ].join('\n')
}

/** A Codex rollout: AGENTS.md instructions, then the environment, then the prompt and answer. */
function codexRollout(id: string, prompt: string, answer: string): string {
  const item = (role: string, text: string) =>
    JSON.stringify({ type: 'response_item', timestamp: '2026-10-10T10:00:00.000Z', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } })
  return [
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/home/me/repos/app' } }),
    item('developer', 'sandbox rules'),
    item('user', '# AGENTS.md instructions for /home/me/repos/app\n\n<INSTRUCTIONS>be brief</INSTRUCTIONS>'),
    item('user', '<environment_context>\n  <cwd>/home/me/repos/app</cwd>\n</environment_context>'),
    item('user', prompt),
    item('assistant', answer),
  ].join('\n')
}

/** ingestConversations over in-memory files, recording what it writes and what it reports. */
async function ingest(files: Record<string, { source: ConversationSource; content: string }>, over: Partial<IngestDeps> = {}) {
  const written: IngestChunk[] = []
  const delegated: string[][] = []
  const stats = await ingestConversations({
    sources: ['claude', 'codex'],
    listFiles: async (source) => Object.keys(files).filter((f) => files[f].source === source),
    readFile: async (f) => files[f].content,
    hasHash: () => false,
    write: async (chunk) => { written.push(chunk) },
    yield: async () => {},
    onDelegated: (hashes) => delegated.push(hashes),
    ...over,
  })
  return { stats, written, delegated }
}

/** The chunks an earlier version wrote for a file: the same parse and chunking, nothing left out. */
const oldChunks = (source: ConversationSource, content: string): IngestChunk[] => chunkTurns(parseBySource(source, content))

describe('delegated sessions', () => {
  it('skips a Claude job another computer ran here, with or without the primer, and counts it', async () => {
    const files = {
      'a.jsonl': { source: 'claude' as const, content: claudeSession('s-a', `${HEADER}\n\nReview the parser.`, 'Reviewed.') },
      'b.jsonl': { source: 'claude' as const, content: claudeSession('s-b', buildExecPrompt(`${HEADER}\n\nRun the tests.`, PRIMER), '3 failed.') },
    }
    const { stats, written, delegated } = await ingest(files)
    expect(written).toEqual([])
    expect(stats).toMatchObject({ filesScanned: 2, chunksWritten: 0, chunksSkipped: 0, delegatedSkipped: 2 })
    // What it reports is exactly what an earlier version stored, so the one-time pass can find it.
    expect(delegated).toEqual([oldChunks('claude', files['a.jsonl'].content).map((c) => c.hash), oldChunks('claude', files['b.jsonl'].content).map((c) => c.hash)])
  })

  it('skips a Codex job whose prompt sits behind the AGENTS.md and environment preambles', async () => {
    const content = codexRollout('r-1', buildExecPrompt(`${HEADER}\n\nImplement the parser.`, PRIMER), 'Committed abc123.')
    const { stats, written, delegated } = await ingest({ 'rollout-1.jsonl': { source: 'codex', content } })
    expect(written).toEqual([])
    expect(stats.delegatedSkipped).toBe(1)
    expect(delegated).toEqual([oldChunks('codex', content).map((c) => c.hash)])
  })

  it('reports every window of a long primer, so the whole session is found, not only the header', async () => {
    // A 4,500-character primer makes the opening turn longer than one 2,000-character chunk.
    const longPrimer = Array.from({ length: 80 }, (_, i) => `- [claude-history · ${i}d ago] fact number ${i} about the parser and the lexer`).join('\n')
    const content = claudeSession('s-long', buildExecPrompt(`${HEADER}\n\nReview it.`, longPrimer.slice(0, 4_500)), 'Reviewed.')
    const old = oldChunks('claude', content)
    expect(old.length).toBeGreaterThanOrEqual(4)
    const { delegated } = await ingest({ 'long.jsonl': { source: 'claude', content } })
    expect(delegated).toEqual([old.map((c) => c.hash)])
  })

  it('still skips a delegated session when nothing listens for it, or the listener throws', async () => {
    const files = { 'a.jsonl': { source: 'claude' as const, content: claudeSession('s-a', `${HEADER}\n\nGo.`, 'Done.') } }
    expect((await ingest(files, { onDelegated: undefined })).stats.delegatedSkipped).toBe(1)
    const thrown = await ingest(files, { onDelegated: () => { throw new Error('listener broke') } })
    expect(thrown.stats.delegatedSkipped).toBe(1)
    expect(thrown.written).toEqual([])
  })
})

describe("the user's own sessions", () => {
  it('are ingested exactly as before: the same chunks with the same hashes, and no delegated count', async () => {
    const claude = claudeSession('s-own', 'Why does the lexer drop the last token?', 'An off-by-one in the loop bound.')
    const codex = codexRollout('r-own', 'Add a test for the lexer.', 'Added tests/lexer.test.ts.')
    const { stats, written, delegated } = await ingest({
      'own.jsonl': { source: 'claude', content: claude },
      'rollout-own.jsonl': { source: 'codex', content: codex },
    })
    expect(written).toEqual([...oldChunks('claude', claude), ...oldChunks('codex', codex)])
    expect(stats).toEqual({ filesScanned: 2, chunksWritten: written.length, chunksSkipped: 0, truncated: false })
    expect(delegated).toEqual([])
  })

  it("leave a local headless run's memory primer out, so recalled memory is not stored again", async () => {
    const content = claudeSession('s-exec', buildExecPrompt('List the open TODOs.', PRIMER), 'Two TODOs.')
    const { stats, written } = await ingest({ 'exec.jsonl': { source: 'claude', content } })
    expect(stats.delegatedSkipped).toBeUndefined()
    expect(written.map((c) => c.text)).toEqual(['user: List the open TODOs.\n\nassistant: Two TODOs.'])
    expect(written.map((c) => c.text).join('\n')).not.toContain('Recalled from the shared Termpolis brain')
  })

  it('skip a session whose only turn was the primer', async () => {
    const onlyPrimer = JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: buildExecPrompt('', PRIMER) } })
    const { stats, written } = await ingest({ 'p.jsonl': { source: 'claude', content: onlyPrimer } })
    expect(written).toEqual([])
    expect(stats).toEqual({ filesScanned: 1, chunksWritten: 0, chunksSkipped: 0, truncated: false })
  })
})

describe('runConversationIngest', () => {
  it('hands the delegated sessions it skips on disk to onDelegated', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-delegated-'))
    try {
      const proj = path.join(root, '-home-me-repos-app')
      fs.mkdirSync(proj)
      const job = claudeSession('s-job', `${HEADER}\n\nReview it.`, 'Reviewed.')
      fs.writeFileSync(path.join(proj, 'job.jsonl'), job)
      fs.writeFileSync(path.join(proj, 'own.jsonl'), claudeSession('s-own', 'Fix the lexer.', 'Fixed.'))
      const writes: string[] = []
      const memory: IngestMemory = { hasHash: () => false, write: async (i) => { writes.push(i.content); return undefined } }
      const delegated: string[] = []
      const stats = await runConversationIngest(memory, { sources: ['claude'], roots: { claude: root }, onDelegated: (h) => delegated.push(...h) })
      expect(stats.delegatedSkipped).toBe(1)
      expect(delegated).toEqual(oldChunks('claude', job).map((c) => c.hash))
      expect(writes).toEqual(['user: Fix the lexer.\n\nassistant: Fixed.'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
