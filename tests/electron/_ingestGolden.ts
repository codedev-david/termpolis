// Deterministic, synthetic transcripts for the conversation-ingest tests. Nothing here is real data and
// nothing is random: the same call always returns the same text, so the golden hashes in
// ingestChunkGolden.test.ts mean something. Secret-looking samples (there are none) would use the repeat trick.

import {
  assistantLine,
  BROKEN_LINE,
  delegated,
  lines,
  metaLine,
  noiseLine,
  primed,
  summaryLine,
  toolCallLine,
  toolResultLine,
  userBlocksLine,
  userLine,
} from './_transcriptFixture'

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']

/** `n` characters of plain words, the same for the same (n, salt). */
export function prose(n: number, salt = 0): string {
  let out = ''
  for (let i = 0; out.length < n; i++) out += `${WORDS[(i * 7 + salt) % WORDS.length]} `
  return out.slice(0, n).trimEnd().padEnd(n, '.')
}

const at = (second: number): { timestamp: string } => ({ timestamp: new Date(Date.UTC(2026, 10, 3, 10, 0, second)).toISOString() })

/** A Claude Code session that exercises every rule the parser and the chunker have. */
export function claudeGolden(): string {
  const body: string[] = [
    summaryLine(),
    userLine(primed('Please fix the build'), { sessionId: 'sess-g1', cwd: '/repo-a', ...at(1) }),
    assistantLine('Looking at the build now.'),
    metaLine(),
    noiseLine(),
    toolCallLine(),
    toolResultLine(),
    BROKEN_LINE,
    userBlocksLine('A second ask, sent as blocks'),
    assistantLine('Done with the first part.'),
    userLine('Now in the other repo', { sessionId: 'sess-g1', cwd: '/repo-b', ...at(9) }),
    assistantLine(prose(4_500, 1)), // longer than one chunk: it is cut into windows
    userLine('日本語のテキスト and ünïcödé and 🎉🚀 emoji', { sessionId: 'sess-g1', cwd: '/repo-b', ...at(12) }),
    assistantLine('é'.repeat(900)),
  ]
  for (let i = 0; i < 14; i++) {
    body.push(userLine(`question ${i}: ${prose(260, i)}`, { sessionId: 'sess-g1', cwd: '/repo-b', ...at(20 + i) }))
    body.push(assistantLine(`answer ${i}: ${prose(430, i + 3)}`))
  }
  // Some of the lines end \r\n, and the last has no newline at all.
  const text = body.map((l, i) => (i % 5 === 2 ? `${l}\r` : l)).join('\n')
  return text
}

/** Another computer's job: the opening prompt carries the Linked-machines header. */
export function delegatedGolden(): string {
  return lines(userLine(delegated('Review the parser.'), { sessionId: 'sess-d1' }), assistantLine('Reviewed.'))
}

/** A Codex rollout. */
export function codexGolden(): string {
  const item = (role: string, text: string, second: number): string =>
    JSON.stringify({ type: 'response_item', timestamp: at(second).timestamp, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } })
  return lines(
    JSON.stringify({ type: 'session_meta', timestamp: at(0).timestamp, payload: { id: 'codex-g1', cwd: '/repo-c' } }),
    item('developer', 'harness instructions that are not dialogue', 1),
    item('user', '<environment_context>cwd: /repo-c</environment_context>', 2),
    item('user', 'Add a retry to the uploader', 3),
    item('assistant', prose(900, 2), 4),
    JSON.stringify({ type: 'event_msg', timestamp: at(5).timestamp, payload: { type: 'agent_reasoning', text: 'thinking' } }),
    item('user', 'Thanks, and the tests?', 6),
    item('assistant', prose(2_300, 5), 7),
  )
}

/** A Gemini session file (one JSON document). The path decides the cwd: `<root>/.gemini/tmp/<proj>/chats/session-1.json`. */
export const GEMINI_GOLDEN_PATH = '/home/u/.gemini/tmp/proj-g/chats/session-1.json'
export function geminiGolden(): string {
  return JSON.stringify({
    sessionId: 'gem-g1',
    messages: [
      { type: 'user', content: 'Explain the retry policy', timestamp: at(1).timestamp },
      { type: 'gemini', content: prose(1_800, 4), timestamp: at(2).timestamp },
      { type: 'info', content: 'not dialogue' },
      { type: 'user', content: [{ text: 'and the backoff?' }, 'plain string part'], timestamp: at(3).timestamp },
      { type: 'gemini', content: prose(2_600, 6), timestamp: at(4).timestamp },
    ],
  })
}
