// F19 / F20 / F30 / F32 — project scoping: unique keys (no same-basename collision),
// Gemini cwd recovery, persisted backfill, and per-directory chunk splitting.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryPatchProjects,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { parseGeminiSession, parseClaudeTranscript, chunkTurns, type IngestTurn } from '../../src/main/conversationIngest'

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-proj-'))
  _resetForTests()
  initSwarmMemory(tmpDir)
  _setEmbeddingsAvailable(false)
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('F19: same-basename repos do not cross-contaminate', () => {
  it('scopes recall by the full-path key, not the bare basename', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'globex uses the X-Globex-Key header', project: '/work/globex/api' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'acme uses the X-Acme-Token header', project: '/work/acme/api' })
    const g = await memorySearch({ query: 'auth header key token', project: '/work/globex/api' })
    const a = await memorySearch({ query: 'auth header key token', project: '/work/acme/api' })
    expect(g.some((h) => h.content.includes('Globex'))).toBe(true)
    expect(g.some((h) => h.content.includes('Acme'))).toBe(false) // no leak from the other 'api' repo
    expect(a.some((h) => h.content.includes('Acme'))).toBe(true)
    expect(a.some((h) => h.content.includes('Globex'))).toBe(false)
  })

  it('a bare-name search still matches legacy slug entries', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a slug-scoped legacy note', project: 'myproj' })
    const hits = await memorySearch({ query: 'slug scoped legacy note', project: 'myproj' })
    expect(hits.some((h) => h.content.includes('slug-scoped'))).toBe(true)
  })
})

describe('F20: Gemini memories are project-scoped', () => {
  it('derives cwd from the on-disk path', () => {
    const content = JSON.stringify({ sessionId: 'g1', messages: [{ type: 'user', content: 'hello', timestamp: new Date(0).toISOString() }] })
    const turns = parseGeminiSession(content, '/home/u/.gemini/tmp/myproj/chats/session-1.json')
    expect(turns).toHaveLength(1)
    expect(turns[0].cwd).toContain('myproj')
  })

  it('prefers an explicit cwd field in the session JSON', () => {
    const content = JSON.stringify({ sessionId: 'g1', cwd: '/repo/real', messages: [{ type: 'gemini', content: 'hi', timestamp: new Date(0).toISOString() }] })
    const turns = parseGeminiSession(content, '/home/u/.gemini/tmp/x/chats/s.json')
    expect(turns[0].cwd).toBe('/repo/real')
  })
})

describe('F30: a project backfill persists across reload', () => {
  it('re-applies the patch on reload instead of losing it (RAM-only before)', async () => {
    const w = await memoryWrite({ agentId: 'claude-history', kind: 'message', content: 'a legacy chunk with no project', source: 'claude', hash: 'legacyhash1' })
    expect(w.project).toBeUndefined()
    expect(memoryPatchProjects([{ hash: 'legacyhash1', project: '/repos/foo' }])).toBe(1)
    // Relaunch simulation: reload from disk.
    _resetForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmpDir)
    const hits = await memorySearch({ query: 'legacy chunk project', project: '/repos/foo' })
    expect(hits.some((h) => h.content.includes('legacy chunk'))).toBe(true)
  })
})

describe('F32: sessions spanning directories are tagged per-directory', () => {
  it('chunkTurns splits chunks on a cwd change', () => {
    const turns: IngestTurn[] = [
      { role: 'user', text: 'work in foo', source: 'claude', sessionId: 's', cwd: '/repos/foo' },
      { role: 'assistant', text: 'ok foo', source: 'claude', sessionId: 's', cwd: '/repos/foo' },
      { role: 'user', text: 'now in bar', source: 'claude', sessionId: 's', cwd: '/repos/bar' },
    ]
    const cwds = chunkTurns(turns, { maxChars: 2000 }).map((c) => c.cwd)
    expect(cwds).toContain('/repos/foo')
    expect(cwds).toContain('/repos/bar')
  })

  it('the Claude parser records a cwd change mid-session (per-turn cwd)', () => {
    const transcript = [
      JSON.stringify({ sessionId: 's', cwd: '/repos/foo', type: 'user', timestamp: new Date(0).toISOString(), message: { role: 'user', content: 'a turn in foo' } }),
      JSON.stringify({ cwd: '/repos/bar', type: 'user', timestamp: new Date(0).toISOString(), message: { role: 'user', content: 'a turn in bar' } }),
    ].join('\n')
    const turns = parseClaudeTranscript(transcript)
    expect(turns.find((t) => t.text === 'a turn in foo')!.cwd).toBe('/repos/foo')
    expect(turns.find((t) => t.text === 'a turn in bar')!.cwd).toBe('/repos/bar')
  })
})
