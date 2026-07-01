import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  parseClaudeTranscript,
  parseCodexRollout,
  parseGeminiSession,
  chunkTurns,
  parseBySource,
  ingestConversations,
  discoverTranscriptFiles,
  findLatestTranscriptFile,
  runConversationIngest,
  type IngestTurn,
  type IngestChunk,
  type IngestDeps,
  type IngestMemory,
} from '../../src/main/conversationIngest'

describe('parseClaudeTranscript', () => {
  const fixture = [
    '{"type":"user","timestamp":"2026-04-19T16:04:38.897Z","sessionId":"sess-1","cwd":"/repo","message":{"role":"user","content":"How does auth work?"}}',
    '{"type":"assistant","timestamp":"2026-04-19T16:04:40.000Z","sessionId":"sess-1","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Auth uses JWT middleware."},{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}',
    '{"type":"user","timestamp":"2026-04-19T16:05:00.000Z","sessionId":"sess-1","message":{"role":"user","content":[{"type":"tool_result","content":"file bytes"}]}}',
    '{"type":"user","isMeta":true,"timestamp":"2026-04-19T16:05:01.000Z","message":{"role":"user","content":"<local-command-caveat>noise</local-command-caveat>"}}',
    '{"type":"user","timestamp":"2026-04-19T16:05:02.000Z","message":{"role":"user","content":"<command-name>/clear</command-name>"}}',
    '{"type":"summary","summary":"unrelated"}',
    'not valid json at all',
  ].join('\n')

  it('extracts human + assistant turns, dropping tool/meta/command noise', () => {
    const turns = parseClaudeTranscript(fixture)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ role: 'user', text: 'How does auth work?', source: 'claude', sessionId: 'sess-1', cwd: '/repo' })
    expect(turns[1]).toMatchObject({ role: 'assistant', source: 'claude' })
    expect(turns[1].text).toContain('JWT middleware')
    expect(turns[0].ts).toBeGreaterThan(0)
  })

  it('joins multiple assistant text blocks and ignores thinking/tool_use', () => {
    const f = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"A."},{"type":"thinking","thinking":"x"},{"type":"text","text":"B."}]}}'
    const t = parseClaudeTranscript(f)
    expect(t).toHaveLength(1)
    expect(t[0].text).toBe('A.\nB.')
  })

  it('skips malformed lines without throwing and returns [] for junk', () => {
    expect(() => parseClaudeTranscript('not json\n{bad')).not.toThrow()
    expect(parseClaudeTranscript('not json')).toEqual([])
    expect(parseClaudeTranscript('')).toEqual([])
  })
})

describe('parseCodexRollout', () => {
  const fixture = [
    '{"timestamp":"2026-03-17T15:06:15.000Z","type":"session_meta","payload":{"id":"cx-1","cwd":"/repo","instructions":"huge system prompt"}}',
    '{"timestamp":"2026-03-17T15:06:20.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd=/repo</environment_context>"}]}}',
    '{"timestamp":"2026-03-17T15:06:21.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Add rate limiting"}]}}',
    '{"timestamp":"2026-03-17T15:06:25.000Z","type":"response_item","payload":{"type":"reasoning","content":[]}}',
    '{"timestamp":"2026-03-17T15:06:26.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Added a token bucket limiter."}]}}',
    '{"timestamp":"2026-03-17T15:06:27.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"injected harness rules"}]}}',
    '{"timestamp":"2026-03-17T15:06:28.000Z","type":"event_msg","payload":{"type":"task_started"}}',
  ].join('\n')

  it('keeps user+assistant messages, dropping meta/reasoning/developer/event + env preamble', () => {
    const turns = parseCodexRollout(fixture)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ role: 'user', text: 'Add rate limiting', source: 'codex', sessionId: 'cx-1', cwd: '/repo' })
    expect(turns[1]).toMatchObject({ role: 'assistant', text: 'Added a token bucket limiter.', source: 'codex' })
  })

  it('returns [] for empty / junk', () => {
    expect(parseCodexRollout('')).toEqual([])
    expect(parseCodexRollout('garbage')).toEqual([])
  })
})

describe('parseGeminiSession', () => {
  const fixture = JSON.stringify({
    sessionId: 'gem-1',
    projectHash: 'abc123',
    messages: [
      { id: 'm1', timestamp: '2026-03-24T03:49:18.794Z', type: 'user', content: [{ text: 'Explain the deploy script' }] },
      { id: 'm2', timestamp: '2026-03-24T03:49:20.000Z', type: 'gemini', content: 'It runs electron-builder.', thoughts: [{ subject: 'x' }], toolCalls: [] },
    ],
  })

  it('maps user/gemini roles and handles array-vs-string content', () => {
    const turns = parseGeminiSession(fixture)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ role: 'user', text: 'Explain the deploy script', source: 'gemini', sessionId: 'gem-1' })
    expect(turns[1]).toMatchObject({ role: 'assistant', text: 'It runs electron-builder.', source: 'gemini' })
  })

  it('returns [] for non-JSON or missing messages', () => {
    expect(parseGeminiSession('not json')).toEqual([])
    expect(parseGeminiSession('{"sessionId":"x"}')).toEqual([])
  })
})

describe('chunkTurns', () => {
  const turns: IngestTurn[] = [
    { role: 'user', text: 'first question', source: 'claude', sessionId: 's', ts: 1000 },
    { role: 'assistant', text: 'first answer', source: 'claude', sessionId: 's', ts: 2000 },
    { role: 'user', text: 'second question', source: 'claude', sessionId: 's', ts: 3000 },
  ]

  it('groups turns into one chunk when under the size budget', () => {
    const chunks = chunkTurns(turns, { maxChars: 10_000 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('user: first question')
    expect(chunks[0].text).toContain('assistant: first answer')
    expect(chunks[0].turnCount).toBe(3)
    expect(chunks[0].startTs).toBe(1000)
    expect(chunks[0].endTs).toBe(3000)
    expect(chunks[0].source).toBe('claude')
    expect(chunks[0].hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('splits into multiple chunks when over the size budget', () => {
    const chunks = chunkTurns(turns, { maxChars: 25 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('produces stable, content-derived hashes (idempotent ingest key)', () => {
    const a = chunkTurns(turns, { maxChars: 10_000 })[0].hash
    const b = chunkTurns(turns, { maxChars: 10_000 })[0].hash
    expect(a).toBe(b)
    // different content → different hash
    const c = chunkTurns([{ ...turns[0], text: 'changed' }], { maxChars: 10_000 })[0].hash
    expect(c).not.toBe(a)
  })

  it('windows a single oversized turn into multiple chunks', () => {
    const big: IngestTurn[] = [{ role: 'assistant', text: 'x'.repeat(5000), source: 'codex', ts: 1 }]
    const chunks = chunkTurns(big, { maxChars: 1000 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.text.length <= 1100)).toBe(true)
  })

  it('returns [] for no turns', () => {
    expect(chunkTurns([])).toEqual([])
  })
})

describe('parseBySource', () => {
  it('dispatches to the right parser; returns [] for qwen', () => {
    expect(parseBySource('claude', '{"type":"user","message":{"role":"user","content":"hi"}}')).toHaveLength(1)
    expect(
      parseBySource('codex', '{"type":"session_meta","payload":{"id":"x"}}\n{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"hey"}]}}'),
    ).toHaveLength(1)
    expect(parseBySource('gemini', JSON.stringify({ messages: [{ type: 'user', content: [{ text: 'g' }] }] }))).toHaveLength(1)
    expect(parseBySource('qwen', 'anything')).toEqual([])
  })
})

describe('ingestConversations', () => {
  const claudeContent =
    '{"type":"user","message":{"role":"user","content":"q1"}}\n' +
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"a1"}]}}'

  it('writes new chunks and skips already-seen hashes (idempotent)', async () => {
    const seen = new Set<string>()
    const written: IngestChunk[] = []
    const deps: IngestDeps = {
      sources: ['claude'],
      listFiles: async () => ['f1.jsonl'],
      readFile: async () => claudeContent,
      hasHash: (h) => seen.has(h),
      write: async (c) => { seen.add(c.hash); written.push(c) },
      chunkOptions: { maxChars: 10_000 },
    }
    const s1 = await ingestConversations(deps)
    expect(s1.filesScanned).toBe(1)
    expect(s1.chunksWritten).toBe(1)
    expect(s1.chunksSkipped).toBe(0)
    expect(written[0].source).toBe('claude')

    const s2 = await ingestConversations(deps) // identical content → all skipped
    expect(s2.chunksWritten).toBe(0)
    expect(s2.chunksSkipped).toBe(1)
  })

  it('tolerates listFiles/readFile errors and skips empty transcripts', async () => {
    const deps: IngestDeps = {
      sources: ['claude', 'codex', 'gemini'],
      listFiles: async (src) => {
        if (src === 'codex') throw new Error('list fail')
        return src === 'gemini' ? ['bad.json'] : ['ok.jsonl']
      },
      readFile: async (fp) => {
        if (fp === 'bad.json') throw new Error('read fail')
        return '{"type":"user","message":{"role":"user","content":"hi"}}'
      },
      hasHash: () => false,
      write: async () => {},
    }
    const s = await ingestConversations(deps)
    expect(s.filesScanned).toBe(1) // only claude ok.jsonl read successfully
    expect(s.chunksWritten).toBe(1)
  })

  it('counts a write failure as not-written', async () => {
    const deps: IngestDeps = {
      sources: ['claude'],
      listFiles: async () => ['f.jsonl'],
      readFile: async () => claudeContent,
      hasHash: () => false,
      write: async () => { throw new Error('disk full') },
    }
    expect((await ingestConversations(deps)).chunksWritten).toBe(0)
  })

  it('defaults to the three disk sources when none specified', async () => {
    const calledFor: string[] = []
    await ingestConversations({
      listFiles: async (src) => { calledFor.push(src); return [] },
      readFile: async () => '',
      hasHash: () => false,
      write: async () => {},
    })
    expect(calledFor.sort()).toEqual(['claude', 'codex', 'gemini'])
  })

  // Distinct per-file content → distinct hashes → one write each (no dedup),
  // so write/yield counts are predictable.
  const fileTurn = (fp: string): string =>
    `{"type":"user","message":{"role":"user","content":"hello ${fp}"}}`

  it('yields to the event loop between embeds so a bulk first-run cannot freeze the app', async () => {
    const yieldSpy = vi.fn(async () => {})
    const deps: IngestDeps = {
      sources: ['claude'],
      listFiles: async () => ['a.jsonl', 'b.jsonl', 'c.jsonl', 'd.jsonl'],
      readFile: async (fp) => fileTurn(fp),
      hasHash: () => false,
      write: async () => {},
      yield: yieldSpy,
    }
    const s = await ingestConversations(deps)
    expect(s.chunksWritten).toBe(4)
    expect(s.truncated).toBe(false)
    expect(yieldSpy).toHaveBeenCalledTimes(4) // yieldEvery defaults to 1
  })

  it('honors yieldEvery (one breather per N writes)', async () => {
    const yieldSpy = vi.fn(async () => {})
    const deps: IngestDeps = {
      sources: ['claude'],
      listFiles: async () => ['a.jsonl', 'b.jsonl', 'c.jsonl', 'd.jsonl', 'e.jsonl'],
      readFile: async (fp) => fileTurn(fp),
      hasHash: () => false,
      write: async () => {},
      yield: yieldSpy,
      yieldEvery: 2,
    }
    const s = await ingestConversations(deps)
    expect(s.chunksWritten).toBe(5)
    expect(yieldSpy).toHaveBeenCalledTimes(2) // writes 2 and 4
  })

  it('stops at maxChunks and reports truncated (backlog for the next pass)', async () => {
    const written: IngestChunk[] = []
    const deps: IngestDeps = {
      sources: ['claude'],
      listFiles: async () => ['a.jsonl', 'b.jsonl', 'c.jsonl', 'd.jsonl', 'e.jsonl'],
      readFile: async (fp) => fileTurn(fp),
      hasHash: () => false,
      write: async (c) => { written.push(c) },
      maxChunks: 3,
    }
    const s = await ingestConversations(deps)
    expect(s.chunksWritten).toBe(3)
    expect(s.truncated).toBe(true)
    expect(written).toHaveLength(3) // it really stopped — didn't embed the rest
  })

  it('uses the real setImmediate yield when none is injected', async () => {
    const deps: IngestDeps = {
      sources: ['claude'],
      listFiles: async () => ['a.jsonl'],
      readFile: async (fp) => fileTurn(fp),
      hasHash: () => false,
      write: async () => {},
    }
    const s = await ingestConversations(deps) // exercises the default yield path
    expect(s.chunksWritten).toBe(1)
    expect(s.truncated).toBe(false)
  })
})

describe('discoverTranscriptFiles', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-disc-'))
  })
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('finds claude *.jsonl recursively, ignoring other files', async () => {
    const proj = path.join(root, 'projA')
    fs.mkdirSync(proj)
    fs.writeFileSync(path.join(proj, 's1.jsonl'), 'x')
    fs.writeFileSync(path.join(proj, 'notes.txt'), 'x')
    const files = await discoverTranscriptFiles('claude', root)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/s1\.jsonl$/)
  })

  it('matches only codex rollout-*.jsonl', async () => {
    fs.writeFileSync(path.join(root, 'rollout-2026.jsonl'), 'x')
    fs.writeFileSync(path.join(root, 'history.jsonl'), 'x')
    const files = await discoverTranscriptFiles('codex', root)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/rollout-/)
  })

  it('matches only gemini session-*.json', async () => {
    const chats = path.join(root, 'proj', 'chats')
    fs.mkdirSync(chats, { recursive: true })
    fs.writeFileSync(path.join(chats, 'session-1.json'), 'x')
    fs.writeFileSync(path.join(chats, 'logs.json'), 'x')
    expect(await discoverTranscriptFiles('gemini', root)).toHaveLength(1)
  })

  it('returns [] for a missing root and for qwen', async () => {
    expect(await discoverTranscriptFiles('claude', path.join(root, 'nope'))).toEqual([])
    expect(await discoverTranscriptFiles('qwen', root)).toEqual([])
  })

  it('freshness filter (#2): returns only files modified at/after the cutoff', async () => {
    const proj = path.join(root, 'projF')
    fs.mkdirSync(proj)
    const oldF = path.join(proj, 'old.jsonl')
    const newF = path.join(proj, 'new.jsonl')
    fs.writeFileSync(oldF, 'x')
    fs.writeFileSync(newF, 'x')
    // Explicit absolute mtimes so the test doesn't depend on wall-clock timing.
    fs.utimesSync(oldF, new Date(1000_000), new Date(1000_000)) // mtimeMs = 1,000,000
    fs.utimesSync(newF, new Date(5000_000), new Date(5000_000)) // mtimeMs = 5,000,000
    const fresh = await discoverTranscriptFiles('claude', root, 3000_000) // cutoff between them
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).toMatch(/new\.jsonl$/)
    // No cutoff (default) returns BOTH — zero regression from the fast tier.
    expect(await discoverTranscriptFiles('claude', root)).toHaveLength(2)
  })
})

describe('findLatestTranscriptFile — newest matching session for solo-session learning', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-latest-'))
  })
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('finds the newest codex rollout across a nested YYYY/MM/DD layout (the real Codex bug)', async () => {
    const deep = path.join(root, '2026', '02', '05')
    fs.mkdirSync(deep, { recursive: true })
    const older = path.join(deep, 'rollout-a.jsonl')
    const newer = path.join(deep, 'rollout-b.jsonl')
    fs.writeFileSync(older, 'x')
    fs.writeFileSync(newer, 'x')
    fs.utimesSync(older, new Date(1000_000), new Date(1000_000))
    fs.utimesSync(newer, new Date(5000_000), new Date(5000_000))
    expect(await findLatestTranscriptFile('codex', root)).toBe(newer)
  })

  it('finds the newest gemini session-*.json under tmp/<proj>/chats, ignoring logs.json (the real Gemini bug)', async () => {
    const chats = path.join(root, 'proj', 'chats')
    fs.mkdirSync(chats, { recursive: true })
    const s1 = path.join(chats, 'session-1.json')
    const s2 = path.join(chats, 'session-2.json')
    fs.writeFileSync(s1, 'x')
    fs.writeFileSync(s2, 'x')
    fs.writeFileSync(path.join(chats, 'logs.json'), 'x') // wrong file — must be ignored
    fs.utimesSync(s1, new Date(1000_000), new Date(1000_000))
    fs.utimesSync(s2, new Date(9000_000), new Date(9000_000))
    expect(await findLatestTranscriptFile('gemini', root)).toBe(s2)
  })

  it('returns null for a missing root, for qwen, and when nothing matches the pattern', async () => {
    expect(await findLatestTranscriptFile('codex', path.join(root, 'nope'))).toBeNull()
    expect(await findLatestTranscriptFile('qwen', root)).toBeNull()
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x')
    expect(await findLatestTranscriptFile('gemini', root)).toBeNull()
  })
})

describe('runConversationIngest', () => {
  it('discovers on disk, dedups, and writes via the memory adapter', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-run-'))
    try {
      const proj = path.join(root, 'p')
      fs.mkdirSync(proj)
      fs.writeFileSync(path.join(proj, 's.jsonl'), '{"type":"user","message":{"role":"user","content":"hello world"}}')
      const seen = new Set<string>()
      const writes: Parameters<IngestMemory['write']>[0][] = []
      const memory: IngestMemory = {
        hasHash: (h) => seen.has(h),
        write: async (i) => { seen.add(i.hash); writes.push(i); return undefined },
      }
      const opts = { sources: ['claude'] as const, roots: { claude: root }, chunkOptions: { maxChars: 10_000 } }
      const stats = await runConversationIngest(memory, opts)
      expect(stats.chunksWritten).toBe(1)
      expect(writes[0].agentId).toBe('claude-history')
      expect(writes[0].source).toBe('claude')
      expect(writes[0].kind).toBe('message')

      const stats2 = await runConversationIngest(memory, opts) // idempotent re-run
      expect(stats2.chunksWritten).toBe(0)
      expect(stats2.chunksSkipped).toBe(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('BB6: links consecutive same-session chunks with a "follows" edge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-follows-'))
    try {
      const proj = path.join(root, 'p')
      fs.mkdirSync(proj)
      const a = 'alpha '.repeat(80) // ~480 chars → its own chunk at maxChars 500
      const b = 'bravo '.repeat(80)
      fs.writeFileSync(path.join(proj, 's.jsonl'),
        `{"sessionId":"sess-1","type":"user","message":{"role":"user","content":"${a}"}}\n` +
        `{"sessionId":"sess-1","type":"user","message":{"role":"user","content":"${b}"}}\n`)
      let n = 0
      const links: Array<[string, string, string, number]> = []
      const memory: IngestMemory = {
        hasHash: () => false,
        write: async () => ({ id: `id-${n++}` }),
        link: (from, to, relation, weight) => { links.push([from, to, relation, weight]) },
      }
      const stats = await runConversationIngest(memory, { sources: ['claude'] as const, roots: { claude: root }, chunkOptions: { maxChars: 500 } })
      expect(stats.chunksWritten).toBe(2)
      expect(links).toEqual([['id-0', 'id-1', 'follows', 1]]) // chunk 0 -> chunk 1, same session
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('BB6: does not link across different sessions, and no-ops without a link callback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-follows-x-'))
    try {
      const p1 = path.join(root, 'a'); const p2 = path.join(root, 'b')
      fs.mkdirSync(p1); fs.mkdirSync(p2)
      fs.writeFileSync(path.join(p1, 's.jsonl'), `{"sessionId":"sess-A","type":"user","message":{"role":"user","content":"one only chunk here"}}\n`)
      fs.writeFileSync(path.join(p2, 's.jsonl'), `{"sessionId":"sess-B","type":"user","message":{"role":"user","content":"another single chunk"}}\n`)
      let n = 0
      const links: unknown[] = []
      const memory: IngestMemory = {
        hasHash: () => false,
        write: async () => ({ id: `id-${n++}` }),
        link: (...args) => { links.push(args) },
      }
      await runConversationIngest(memory, { sources: ['claude'] as const, roots: { claude: root } })
      expect(links).toEqual([]) // one chunk per session → nothing to follow

      // And the linking path is fully optional — omitting `link` must not throw.
      const memNoLink: IngestMemory = { hasHash: () => false, write: async () => ({ id: 'x' }) }
      await expect(runConversationIngest(memNoLink, { sources: ['claude'] as const, roots: { claude: root } })).resolves.toBeDefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('tags writes with the project slug derived from the transcript cwd', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-proj-'))
    try {
      const proj = path.join(root, 'p')
      fs.mkdirSync(proj)
      fs.writeFileSync(path.join(proj, 's.jsonl'), '{"type":"user","cwd":"/repos/MyApp","message":{"role":"user","content":"hello world"}}')
      const writes: Parameters<IngestMemory['write']>[0][] = []
      const memory: IngestMemory = {
        hasHash: () => false,
        write: async (i) => { writes.push(i); return undefined },
      }
      await runConversationIngest(memory, { sources: ['claude'] as const, roots: { claude: root } })
      expect(writes).toHaveLength(1)
      expect(writes[0].project).toBe('/repos/MyApp') // raw cwd at the adapter; the store normalizes to a slug
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('project backfill for already-stored chunks', () => {
  it('reports skipped chunks with a cwd via patchProjects so legacy entries get tagged', async () => {
    const fixture = '{"type":"user","cwd":"/repos/legacy","message":{"role":"user","content":"older chat about the parser"}}'
    const patched: Array<{ hash: string; project: string }> = []
    const deps: IngestDeps = {
      sources: ['claude'],
      listFiles: async () => ['f1.jsonl'],
      readFile: async () => fixture,
      hasHash: () => true, // everything already stored
      write: async () => { throw new Error('should not write') },
      patchProjects: (ps) => { patched.push(...ps) },
    }
    const s = await ingestConversations(deps)
    expect(s.chunksSkipped).toBeGreaterThan(0)
    expect(s.chunksWritten).toBe(0)
    expect(patched.length).toBeGreaterThan(0)
    expect(patched[0].hash).toBeTruthy()
    expect(patched[0].project).toBe('/repos/legacy') // raw cwd; the store normalizes to a slug
  })
})
