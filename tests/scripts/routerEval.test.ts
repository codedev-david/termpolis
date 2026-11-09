import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { promptText, familyOf, TurnCollector, readTranscript } from '../../scripts/routerEval/transcripts'
import {
  tierOf, confusion, direction, percentile, rng, stratified, csvCell, toCsv, parseCsv, asLabel,
} from '../../scripts/routerEval/metrics'

const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', sessionId: 's1', uuid: `u${Math.random()}`, timestamp: '2026-11-09T10:00:00Z', message: { content }, ...extra })
const asst = (id: string, blocks: Array<{ type: string }>, out: number, model = 'claude-opus-5-5', extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', sessionId: 's1', message: { id, model, content: blocks, usage: { output_tokens: out } }, ...extra })

describe('promptText', () => {
  it('keeps what a person typed and drops everything else', () => {
    expect(promptText('fix the test')).toBe('fix the test')
    expect(promptText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(promptText('<system-reminder>x</system-reminder>\n  hello ')).toBe('hello')
    expect(promptText([{ type: 'tool_result', content: 'x' }])).toBeNull()
    expect(promptText('<command-name>/clear</command-name>')).toBeNull()
    expect(promptText('<local-command-stdout>x</local-command-stdout>')).toBeNull()
    expect(promptText('Caveat: the messages below')).toBeNull()
    expect(promptText('[Request interrupted by user]')).toBeNull()
    expect(promptText('<system-reminder>only</system-reminder>')).toBeNull()
    expect(promptText(42)).toBeNull()
    expect(promptText('a < b is true')).toBe('a < b is true')
  })

  it('names the model family', () => {
    expect(familyOf('claude-opus-5-5')).toBe('opus')
    expect(familyOf('claude-sonnet-5-5')).toBe('sonnet')
    expect(familyOf('claude-haiku-5-5')).toBe('haiku')
    expect(familyOf('<synthetic>')).toBeNull()
    expect(familyOf(undefined)).toBeNull()
  })
})

describe('TurnCollector', () => {
  it('folds a transcript into turns with their tool calls, tokens and model', () => {
    const c = new TurnCollector()
    for (const l of [
      '', 'not json', '{broken',
      user('first prompt', { uuid: 'a' }),
      asst('m1', [{ type: 'thinking' }], 100),
      asst('m1', [{ type: 'tool_use' }], 100), // same message, split per block: tokens once
      user([{ type: 'tool_result' }]),
      asst('m2', [{ type: 'tool_use' }, { type: 'tool_use' }, { type: 'text' }], 50),
      asst('m3', [], 10, 'claude-haiku-5-5'),
      asst('sc', [{ type: 'tool_use' }], 999, 'claude-opus-5-5', { isSidechain: true }),
      user('meta', { isMeta: true }),
      user('summary', { isCompactSummary: true }),
      user('second prompt', { uuid: 'b' }),
      asst('m4', [], 0, '<synthetic>'),
      asst('m5', 'not an array' as never, Number.NaN, '<synthetic>'),
    ]) c.line(l)
    c.close()
    c.close()
    expect(c.turns.map((t) => [t.prompt, t.position, t.toolCalls, t.outTokens, t.model])).toEqual([
      ['first prompt', 0, 3, 160, 'opus'],
      ['second prompt', 1, 0, 0, null],
    ])
    expect(c.turns[0].id).toMatch(/^[0-9a-f]{12}$/)
    expect(c.turns[0].id).not.toBe(c.turns[1].id)
  })

  it('ignores an assistant line before any prompt, and fills missing fields', () => {
    const c = new TurnCollector()
    c.line(asst('m', [{ type: 'tool_use' }], 5))
    c.line(JSON.stringify({ type: 'user', message: { content: 'p' } }))
    c.line(JSON.stringify({ type: 'assistant' }))
    c.close()
    expect(c.turns).toEqual([expect.objectContaining({ prompt: 'p', sessionId: '', ts: '', toolCalls: 0, outTokens: 0, model: null })])
  })

  it('readTranscript streams a file, and a missing one gives nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 're-'))
    try {
      const f = path.join(dir, 's.jsonl')
      fs.writeFileSync(f, [user('hello'), asst('m', [{ type: 'tool_use' }], 7)].join('\r\n') + '\r\n')
      expect((await readTranscript(f)).map((t) => [t.prompt, t.toolCalls, t.outTokens])).toEqual([['hello', 1, 7]])
      expect(await readTranscript(path.join(dir, 'missing.jsonl'))).toEqual([])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('metrics', () => {
  it('tiers a turn by what it took', () => {
    expect(tierOf({ toolCalls: 0, outTokens: 100 })).toBe('light')
    expect(tierOf({ toolCalls: 3, outTokens: 100 })).toBe('medium')
    expect(tierOf({ toolCalls: 1, outTokens: 2000 })).toBe('medium')
    expect(tierOf({ toolCalls: 15, outTokens: 0 })).toBe('heavy')
    expect(tierOf({ toolCalls: 0, outTokens: 12000 })).toBe('heavy')
  })

  it('confusion, recall and direction', () => {
    const c = confusion([['haiku', 'haiku'], ['haiku', 'opus'], ['opus', 'sonnet'], ['keep', 'keep']])
    expect(c).toMatchObject({ n: 4, correct: 2, accuracy: 0.5 })
    expect(c.matrix.haiku.opus).toBe(1)
    expect(c.recall).toEqual({ keep: 1, haiku: 0.5, sonnet: 0, opus: 0 })
    expect(confusion([]).accuracy).toBe(0)
    expect(direction([['opus', 'haiku'], ['haiku', 'sonnet'], ['sonnet', 'sonnet'], ['keep', 'opus'], ['opus', 'keep']]))
      .toEqual({ n: 3, under: 1, over: 1 })
  })

  it('percentile', () => {
    expect(percentile([], 50)).toBe(0)
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3)
    expect(percentile([5, 1, 3, 2, 4], 100)).toBe(5)
    expect(percentile([5, 1], 0)).toBe(1)
  })

  it('a seeded sample is the same every time and spreads over the groups', () => {
    const r1 = rng(3), r2 = rng(3)
    expect([r1(), r1()]).toEqual([r2(), r2()])
    const items = [...Array(10).keys()].map((i) => ({ i, g: i < 8 ? 'a' : 'b' }))
    const s = stratified(items, (x) => x.g, 4, 1)
    expect(s).toHaveLength(4)
    expect(s.filter((x) => x.g === 'b')).toHaveLength(2)
    expect(stratified(items, (x) => x.g, 4, 1)).toEqual(s)
    expect(stratified(items, (x) => x.g, 50)).toHaveLength(10)
    expect(stratified([], () => 'a', 3)).toEqual([])
  })

  it('writes and reads CSV, quotes and line breaks included', () => {
    expect(csvCell('a')).toBe('a')
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"')
    expect(csvCell(null)).toBe('')
    const text = '\uFEFF' + toCsv(['id', 'prompt', 'your_label'], [{ id: 1, prompt: 'x, "y"\r\nz', your_label: '' }, { id: 2, prompt: 'p' }])
    expect(parseCsv(text)).toEqual([{ id: '1', prompt: 'x, "y"\r\nz', your_label: '' }, { id: '2', prompt: 'p', your_label: '' }])
    expect(parseCsv('a,b\n1,2')).toEqual([{ a: '1', b: '2' }])
    expect(parseCsv('a,b\r\n\r\n1')).toEqual([{ a: '1', b: '' }])
    expect(parseCsv('')).toEqual([])
  })

  it('asLabel', () => {
    expect(asLabel(' Opus ')).toBe('opus')
    expect(asLabel('gpt')).toBeNull()
    expect(asLabel(undefined)).toBeNull()
  })
})
