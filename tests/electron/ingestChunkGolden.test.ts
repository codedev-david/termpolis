// What an existing transcript turns into must never change: a chunk hash is the idempotency key of the
// whole memory store, so one different cut re-stores and re-embeds every conversation. Two guards:
//   1. GOLDEN: fixed synthetic transcripts -> parse -> ownDialogue -> chunkTurns, digested and compared with
//      values taken from the v1.54.4 code (tests/fixtures/ingest-golden.json).
//   2. ORACLE: random inputs, new code vs a verbatim copy of the v1.54.4 code (tests/electron/_ingestOracle.ts).
// Both pass on the base commit and must keep passing: that is what "byte-identical" means here. The
// negative controls prove the digest can move (a test that cannot fail tests nothing).

import { describe, it, expect } from 'vitest'
import * as crypto from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { chunkTurns, parseBySource, parseClaudeTranscript, parseCodexRollout, type ChunkOptions, type IngestTurn } from '../../src/main/conversationIngest'
import { ownDialogue } from '../../src/shared/headlessPrompt'
import { claudeGolden, codexGolden, delegatedGolden, geminiGolden, GEMINI_GOLDEN_PATH, prose } from './_ingestGolden'
import { referenceChunkTurns, referenceParseClaude, referenceParseCodex } from './_ingestOracle'
import { mulberry32, TEXTS } from './_transcriptFixture'

type Digest = {
  parsedTurns: number
  ownTurns: number | null
  chunks: number | null
  hashes: string | null
  first: string | null
  last: string | null
  meta: string | null
  text: string | null
}

const GOLDEN: Record<string, Digest> = JSON.parse(readFileSync(join(__dirname, '../fixtures/ingest-golden.json'), 'utf8'))

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')

function digest(source: 'claude' | 'codex' | 'gemini', content: string, filePath: string | undefined, opts: ChunkOptions): Digest {
  const parsed = parseBySource(source, content, filePath)
  const own = ownDialogue(parsed)
  const chunks = own ? chunkTurns(own, opts) : null
  return {
    parsedTurns: parsed.length,
    ownTurns: own ? own.length : null,
    chunks: chunks ? chunks.length : null,
    hashes: chunks ? sha(chunks.map((c) => c.hash).join(',')) : null,
    first: chunks && chunks.length ? chunks[0].hash : null,
    last: chunks && chunks.length ? chunks[chunks.length - 1].hash : null,
    meta: chunks ? sha(JSON.stringify(chunks.map((c) => [c.source, c.sessionId, c.cwd, c.startTs, c.endTs, c.turnCount, c.text.length]))) : null,
    text: chunks ? sha(chunks.map((c) => c.text).join('\u0000')) : null,
  }
}

const VARIANTS: Array<[string, ChunkOptions]> = [
  ['default', {}],
  ['sealed', { sealedOnly: true }],
  ['small', { maxChars: 300 }],
]

const HINT =
  'A transcript now turns into different chunks than v1.54.4 made. Every conversation already in memory would be ' +
  'stored and embedded a second time under new hashes. If that is really intended, bump INGEST_FORMAT_VERSION ' +
  '(src/main/ingestWatermark.ts) and regenerate tests/fixtures/ingest-golden.json in the same commit.'

describe('golden chunk hashes (the idempotency contract)', () => {
  for (const [label, opts] of VARIANTS) {
    it(`claude, codex and gemini transcripts keep their chunk hashes (${label})`, () => {
      expect(digest('claude', claudeGolden(), undefined, opts), HINT).toEqual(GOLDEN[`claude/${label}`])
      expect(digest('codex', codexGolden(), undefined, opts), HINT).toEqual(GOLDEN[`codex/${label}`])
      expect(digest('gemini', geminiGolden(), GEMINI_GOLDEN_PATH, opts), HINT).toEqual(GOLDEN[`gemini/${label}`])
    })
  }

  it("another computer's job is still left out whole (no chunks at all)", () => {
    expect(digest('claude', delegatedGolden(), undefined, {})).toEqual(GOLDEN['delegated/default'])
    expect(GOLDEN['delegated/default'].chunks).toBeNull()
  })

  it('the fixture exercises what it claims: windows, a cwd switch, a stripped primer, sealed vs full', () => {
    const own = ownDialogue(parseClaudeTranscript(claudeGolden())) as IngestTurn[]
    const chunks = chunkTurns(own)
    expect(chunks.some((c) => c.cwd === '/repo-a')).toBe(true)
    expect(chunks.some((c) => c.cwd === '/repo-b')).toBe(true)
    expect(own[0].text).toBe('Please fix the build') // the <project-memory> block came off the first turn
    expect(chunks.filter((c) => c.turnCount === 1 && c.text.length === 2000).length).toBeGreaterThanOrEqual(2) // a 4,500-character turn is windowed
    expect(chunkTurns(own, { sealedOnly: true }).length).toBe(chunks.length - 1) // the trailing partial is dropped
  })

  // NEGATIVE CONTROL: the digest is sensitive. If it were not, the golden test above would pass for any code.
  it('control: one changed character, or one changed option, moves the digest', () => {
    const base = digest('claude', claudeGolden(), undefined, {})
    const edited = claudeGolden().replace('question 3: ', 'question 3! ')
    expect(edited).not.toBe(claudeGolden())
    expect(digest('claude', edited, undefined, {}).hashes).not.toBe(base.hashes)
    expect(digest('claude', claudeGolden(), undefined, { maxChars: 1999 }).hashes).not.toBe(base.hashes)
    expect(digest('claude', claudeGolden(), undefined, { sealedOnly: true }).hashes).not.toBe(base.hashes)
    expect(digest('gemini', geminiGolden(), '/home/u/.gemini/tmp/other/chats/session-1.json', {}).hashes).toBe(GOLDEN['gemini/default'].hashes) // cwd is not in the hash
  })
})

// ---- the oracle: the new code against a verbatim copy of the old, over random inputs -----------------

function randomTurns(seed: number): IngestTurn[] {
  const rnd = mulberry32(seed)
  const n = Math.floor(rnd() * 40)
  const turns: IngestTurn[] = []
  const cwds = ['/a', '/b', undefined]
  let cwd = cwds[Math.floor(rnd() * 3)]
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.15) cwd = cwds[Math.floor(rnd() * 3)]
    const len = rnd() < 0.1 ? 1_500 + Math.floor(rnd() * 5_000) : Math.floor(rnd() * 900)
    const text = rnd() < 0.5 ? TEXTS[Math.floor(rnd() * TEXTS.length)] : prose(len, i)
    turns.push({
      role: rnd() < 0.5 ? 'user' : 'assistant',
      text: rnd() < 0.05 ? '' : text,
      ts: rnd() < 0.8 ? 1_700_000_000_000 + i * 1000 : undefined,
      source: 'claude',
      sessionId: rnd() < 0.9 ? 'sess-r' : undefined,
      cwd,
    })
  }
  return turns
}

const OPTIONS: ChunkOptions[] = [{}, { sealedOnly: true }, { maxChars: 40 }, { maxChars: 120, sealedOnly: true }, { maxChars: 2000 }]

describe('chunkTurns equals the v1.54.4 chunker on random turn lists', () => {
  it('300 seeds x 5 option sets: same chunks, field for field', () => {
    let compared = 0
    let produced = 0
    for (let seed = 1; seed <= 300; seed++) {
      const turns = randomTurns(seed)
      for (const opts of OPTIONS) {
        const got = chunkTurns(turns, opts)
        expect(got, `seed ${seed} ${JSON.stringify(opts)}`).toEqual(referenceChunkTurns(turns, opts))
        compared++
        produced += got.length
      }
    }
    expect(compared).toBe(1500)
    expect(produced).toBeGreaterThan(5_000) // not a vacuous comparison of empty lists
  })

  it('control: a one-character change in the packing limit shows up (the comparison can fail)', () => {
    let seed = 1
    while (randomTurns(seed).filter((t) => t.text).length < 8) seed++
    const turns = randomTurns(seed)
    const ref = referenceChunkTurns(turns, { maxChars: 40 })
    expect(ref.length).toBeGreaterThan(3)
    expect(chunkTurns(turns, { maxChars: 41 })).not.toEqual(ref)
  })
})

// ---- random JSONL: the parsers against the old ones ---------------------------------------------------

function randomClaudeFile(seed: number): string {
  const rnd = mulberry32(seed)
  const out: string[] = []
  const n = 1 + Math.floor(rnd() * 30)
  for (let i = 0; i < n; i++) {
    const r = rnd()
    const text = TEXTS[Math.floor(rnd() * TEXTS.length)]
    const ts = new Date(Date.UTC(2026, 10, 3, 10, 0, i)).toISOString()
    const sid = rnd() < 0.5 ? { sessionId: `s${Math.floor(rnd() * 3)}` } : {}
    const cwd = rnd() < 0.4 ? { cwd: rnd() < 0.5 ? '/a' : '/b' } : {}
    let line: string
    if (r < 0.25) line = JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: ts, ...sid, ...cwd })
    else if (r < 0.45) line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', id: 'x' }] }, timestamp: ts, ...sid, ...cwd })
    else if (r < 0.52) line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] }, ...sid })
    else if (r < 0.58) line = JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: text }, ...sid })
    else if (r < 0.64) line = JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/x</command-name>' } })
    else if (r < 0.7) line = '{"type":"user","message":{"role":"user","content":"never closed'
    else if (r < 0.76) line = ''
    else if (r < 0.8) line = '   '
    else if (r < 0.85) line = JSON.stringify({ type: 'summary', summary: 's' })
    else if (r < 0.9) line = JSON.stringify([1, 2, 3])
    else if (r < 0.93) line = 'null'
    else line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts, ...sid, ...cwd })
    out.push(rnd() < 0.2 ? `${line}\r` : line)
  }
  return out.join('\n') + (rnd() < 0.5 ? '\n' : '')
}

function randomCodexFile(seed: number): string {
  const rnd = mulberry32(seed + 9_000)
  const out: string[] = []
  const n = 1 + Math.floor(rnd() * 20)
  for (let i = 0; i < n; i++) {
    const r = rnd()
    const text = rnd() < 0.2 ? '<environment_context>x</environment_context>' : TEXTS[Math.floor(rnd() * TEXTS.length)]
    const ts = new Date(Date.UTC(2026, 10, 3, 10, 0, i)).toISOString()
    if (r < 0.15) out.push(JSON.stringify({ type: 'session_meta', timestamp: ts, payload: { id: `c${i}`, cwd: '/r' } }))
    else if (r < 0.6) out.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'message', role: rnd() < 0.5 ? 'user' : 'assistant', content: [{ text }] } }))
    else if (r < 0.7) out.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'developer', content: text } }))
    else if (r < 0.8) out.push(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning' } }))
    else if (r < 0.9) out.push('not json at all')
    else out.push(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: text } }))
  }
  return out.join('\n')
}

describe('parseClaudeTranscript and parseCodexRollout equal the v1.54.4 parsers on random files', () => {
  it('300 random Claude files', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const file = randomClaudeFile(seed)
      expect(parseClaudeTranscript(file), `seed ${seed}`).toEqual(referenceParseClaude(file))
    }
  })

  it('300 random Codex files', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const file = randomCodexFile(seed)
      expect(parseCodexRollout(file), `seed ${seed}`).toEqual(referenceParseCodex(file))
    }
  })

  it('control: the random generator produces turns, noise and broken lines (a vacuous comparison would pass too)', () => {
    let withTurns = 0
    let withNoise = 0
    for (let seed = 1; seed <= 300; seed++) {
      const file = randomClaudeFile(seed)
      if (referenceParseClaude(file).length > 0) withTurns++
      if (file.includes('never closed') || file.includes('isMeta')) withNoise++
    }
    expect(withTurns).toBeGreaterThan(250)
    expect(withNoise).toBeGreaterThan(100)
  })
})
