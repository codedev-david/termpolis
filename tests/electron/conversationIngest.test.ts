import { describe, it, expect } from 'vitest'
import {
  parseClaudeTranscript,
  parseCodexRollout,
  parseGeminiSession,
  chunkTurns,
  type IngestTurn,
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
