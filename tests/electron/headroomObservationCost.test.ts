import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { rewriteMessagesBody } from '../../src/main/headroomProxy/wireCompress'
import { parseUsageFromSse, parseTurnShapeFromSse } from '../../src/main/headroomProxy/usageParse'
import { loadElisionState, elisionState, resetElisionLedger } from '../../src/main/headroom/elisionLedger'
import { ELISION_KINDS, TOOL_CLASSES, SIZE_BANDS, makeMeta, stampModel } from '../../src/main/headroom/elisionMeta'

/**
 * R1 only OBSERVES. Nothing it adds may change what the model is sent, slow a request down, or
 * cost the main thread more than a counter bump. Each claim of "no impact" is a test here, so a
 * later change that breaks one fails the suite instead of someone's afternoon.
 *
 *   quality  forwarded bytes do not depend on the tally (the tally is stubbed out and 300 seeded
 *            bodies come back byte for byte the same)
 *   speed    the tally is a small fraction of the rewrite it rides in; the second pass over a
 *            response is no dearer than the first that was already there; the request body is
 *            parsed once, as before
 *   size     a stash's metadata and the ledger's file are bounded
 *
 * The timing tests are RELATIVE: both sides run in this process, best of several runs, with a
 * bound far wider than what was measured, so a loaded machine slows both and cannot flake them.
 */

// A switch the tests flip: with it on, the tally is replaced by an empty one, which is what the
// rewriter was before the tally existed.
const gate = vi.hoisted(() => ({ off: false }))
vi.mock('../../src/main/headroomProxy/forwardedKinds', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/headroomProxy/forwardedKinds')>()
  return { ...real, classifyMessages: (m: readonly unknown[]) => (gate.off ? real.emptyKinds() : real.classifyMessages(m)) }
})
const real = await vi.importActual<typeof import('../../src/main/headroomProxy/forwardedKinds')>('../../src/main/headroomProxy/forwardedKinds')

function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}

const TOOLS = ['Read', 'Bash', 'Grep', 'Glob', 'PowerShell', 'WebFetch'] as const
type Tool = (typeof TOOLS)[number]
const LINE: Record<Tool, (i: number) => string> = {
  Read: (i) => `  export const sym${i} = compute(${i}) // a representative source line with real length`,
  Bash: (i) => `2026-08-09T12:00:${String(i % 60).padStart(2, '0')}Z [info] task ${i} completed in ${i * 3}ms (worker ${i % 8})`,
  Grep: (i) => `src/main/file${i % 40}.ts:${i}:  const value${i} = lookup(${i})`,
  Glob: (i) => `src/main/dir${i % 9}/file${i}.ts`,
  PowerShell: (i) => `VERBOSE: step ${i} of the build finished, ${i * 7} files touched`,
  WebFetch: (i) => `<div class="row"><span>item ${i}</span><a href="/x/${i}">link ${i}</a></div>`,
}
const INPUT: Record<Tool, Record<string, unknown>> = {
  Read: { file_path: 'src/main/example.ts' }, Bash: { command: 'rg compute src' }, Grep: { pattern: 'compute' },
  Glob: { pattern: '**/*.ts' }, PowerShell: { command: 'Get-Content log.txt' }, WebFetch: { url: 'https://example.com/page' },
}
const SIZES = [300, 900, 2_000, 3_500, 8_000, 16_000, 45_000]
const REMINDER = '\n\n<system-reminder>\nThe task tools have not been used recently. Consider using them.\n</system-reminder>'

function textOf(tool: Tool, chars: number, salt: number): string {
  const line = LINE[tool]
  const out: string[] = []
  for (let n = 0, i = salt * 1000; n < chars; i++) { const l = line(i); out.push(l); n += l.length + 1 }
  return out.join('\n')
}

/** A conversation shaped like agent work: results of every kind and size, repeats, near-repeats,
 *  harness reminders, and (from `pairs` >= 64) long enough to reach prefix decay. */
function conversation(seed: number, pairs: number): string {
  const r = prng(seed)
  const messages: unknown[] = [{ role: 'user', content: [{ type: 'text', text: 'Please look into the failing build.' }] }]
  const seen: string[] = []
  for (let p = 0; p < pairs; p++) {
    const tool = TOOLS[Math.floor(r() * TOOLS.length)]
    let text: string
    const roll = r()
    if (roll < 0.1 && seen.length > 0) text = seen[Math.floor(r() * seen.length)] // an exact repeat
    else if (roll < 0.15 && seen.length > 0) text = seen[Math.floor(r() * seen.length)].replace(/\d/, '9') // a near-repeat
    else text = textOf(tool, SIZES[Math.floor(r() * SIZES.length)], p + 1)
    seen.push(text)
    if (r() < 0.15) text += REMINDER
    const id = `toolu_${seed}_${p}`
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input: INPUT[tool] }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] })
  }
  return JSON.stringify({ model: 'claude-opus-5-5', system: 'You are a coding agent.', messages })
}

/** The fastest of `runs` runs of each, taken alternately so both see the same machine state. */
function bestOf(a: () => void, b: () => void, runs: number): [number, number] {
  let ba = Infinity
  let bb = Infinity
  for (let i = 0; i < runs; i++) {
    let t = performance.now(); a(); ba = Math.min(ba, performance.now() - t)
    t = performance.now(); b(); bb = Math.min(bb, performance.now() - t)
  }
  return [ba, bb]
}

describe('quality: the model is sent exactly what it was sent without the tally', () => {
  it('300 seeded conversations come back byte for byte the same with the tally stubbed out', () => {
    let tallied = 0
    for (let seed = 1; seed <= 300; seed++) {
      // Every 25th is long enough for prefix decay (128 messages), the rest are the usual sizes.
      const raw = conversation(seed, seed % 25 === 0 ? 70 : 3 + (seed % 14))
      gate.off = false
      const on = rewriteMessagesBody(raw)
      gate.off = true
      const off = rewriteMessagesBody(raw)
      gate.off = false
      expect(on.body === off.body).toBe(true)
      expect(on.changed).toBe(off.changed)
      expect(on.stashes).toEqual(off.stashes)
      expect({ ...on.stats, kinds: null }).toEqual({ ...off.stats, kinds: null })
      if (on.stats.kinds.plain + on.stats.kinds.compact + on.stats.kinds.dedup + on.stats.kinds.diff + on.stats.kinds.aged > 0) tallied++
      expect(Object.values(off.stats.kinds).every((n) => n === 0)).toBe(true) // the stub really was in force
    }
    expect(tallied).toBeGreaterThan(250) // and the tally really was counting when it was not
  })

  it('the tally never reaches the bytes: no tally field or count is in a forwarded body', () => {
    const on = rewriteMessagesBody(conversation(7, 12))
    expect(on.changed).toBe(true)
    expect(on.body).not.toContain('kinds')
    expect(on.body).not.toContain('agedEarly')
  })
})

describe('speed: the tally in the request path', () => {
  it('costs a small fraction of the rewrite it rides in, on a body of several megabytes', () => {
    const raw = conversation(11, 140)
    expect(raw.length).toBeGreaterThan(1_500_000)
    const forwarded = JSON.parse(rewriteMessagesBody(raw).body).messages as unknown[]
    for (let i = 0; i < 3; i++) { rewriteMessagesBody(raw); real.classifyMessages(forwarded) } // warm both
    const [rewrite, tally] = bestOf(() => rewriteMessagesBody(raw), () => real.classifyMessages(forwarded), 6)
    // Measured at about a tenth of one percent (0.1 ms against 100 ms on 2 MB). A quarter is the
    // line past which the tally would deserve a second look, and no load moves it that far.
    expect(tally).toBeLessThanOrEqual(rewrite * 0.25)
  })

  it('and on a body nothing was elided from, which is the most text it can ever have to scan', () => {
    const raw = conversation(11, 140)
    const everything = JSON.parse(raw).messages as unknown[]
    for (let i = 0; i < 3; i++) { rewriteMessagesBody(raw); real.classifyMessages(everything) }
    const [rewrite, tally] = bestOf(() => rewriteMessagesBody(raw), () => real.classifyMessages(everything), 6)
    // Measured at about 0.3% (0.4 ms against 130 ms): one substring search per result, no copy.
    expect(tally).toBeLessThanOrEqual(rewrite * 0.25)
  })

  it('reads the messages the rewriter already parsed: it adds no JSON.parse of any size', () => {
    const raw = conversation(13, 40)
    const parses = (tallyOff: boolean): { calls: number; chars: number; whole: number } => {
      gate.off = tallyOff
      const spy = vi.spyOn(JSON, 'parse')
      try {
        rewriteMessagesBody(raw)
        const args = spy.mock.calls.map(([s]) => (typeof s === 'string' ? s.length : 0))
        return { calls: args.length, chars: args.reduce((n, c) => n + c, 0), whole: args.filter((c) => c >= raw.length * 0.9).length }
      } finally { spy.mockRestore(); gate.off = false }
    }
    const withTally = parses(false)
    expect(withTally).toEqual(parses(true))
    expect(withTally.whole).toBe(1) // the one parse of the request body the rewriter has always done
  })

  it('wireCompress reaches the tally through the parsed messages, never the string entry that parses again', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'headroomProxy', 'wireCompress.ts'), 'utf8')
    expect(src).toContain('classifyMessages(')
    expect(src).not.toMatch(/classifyForwardedResults\s*\(/) // it may re-export the string entry, never call it
  })
})

function sse(deltas: number, retrieves: number): string {
  const ev = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  let s = ev('message_start', { message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: 3, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 800, output_tokens: 1 } } })
  s += ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
  for (let i = 0; i < deltas; i++) s += ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'consider the next step carefully ' } })
  s += ev('content_block_stop', { index: 0 })
  for (let k = 1; k <= retrieves; k++) {
    s += ev('content_block_start', { index: k, content_block: { type: 'tool_use', id: `toolu_${k}`, name: 'mcp__termpolis__retrieve_full', input: {} } })
    s += ev('content_block_delta', { index: k, delta: { type: 'input_json_delta', partial_json: '{"token":"hr_0123456789abcdef"}' } })
    s += ev('content_block_stop', { index: k })
  }
  s += ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3_000 } })
  return s + ev('message_stop', {})
}

describe('speed: the second pass over a response', () => {
  it('parses only the lines that start a block, where the usage pass parses every line', () => {
    const stream = sse(4_000, 2)
    const spy = vi.spyOn(JSON, 'parse')
    try {
      parseUsageFromSse(stream)
      const usageParses = spy.mock.calls.length
      spy.mockClear()
      expect(parseTurnShapeFromSse(stream)).toEqual({ toolCalls: 2, retrieveCalls: 2, pure: true })
      // The thinking block and the two retrieve_full calls, each announced once; the 4,000 deltas
      // between them are skipped on a substring test before any parse.
      expect(spy.mock.calls.length).toBe(3)
      expect(usageParses).toBeGreaterThan(4_000)
    } finally { spy.mockRestore() }
  })

  it('takes no longer than the usage pass that was already there, on a long answer', () => {
    const stream = sse(4_000, 2)
    expect(stream.length).toBeGreaterThan(500_000)
    for (let i = 0; i < 3; i++) { parseUsageFromSse(stream); parseTurnShapeFromSse(stream) } // warm both
    const [usage, turn] = bestOf(() => parseUsageFromSse(stream), () => parseTurnShapeFromSse(stream), 9)
    // Measured at a quarter to a half of it (about 1 ms against 3 ms on 600 KB of thinking). The
    // bound is as wide as a relative bound can be; the test above is what pins the mechanism.
    expect(turn).toBeLessThanOrEqual(usage)
  })
})

describe('size: what the ledger adds is bounded', () => {
  it('a stash carries a small, fixed-size meta however long the names are', () => {
    const stashes = [{ token: 'hr_0123456789abcdef', original: 'x', meta: makeMeta('compact', 'T'.repeat(5_000), 987_654_321, 987_654_321) }]
    stampModel(stashes, 'M'.repeat(5_000))
    expect(JSON.stringify(stashes[0].meta).length).toBeLessThan(300)
  })

  it('the ledger file stays small with every class the vocabulary allows at its largest counts', () => {
    const classes: Record<string, unknown> = {}
    for (const k of ELISION_KINDS) for (const t of TOOL_CLASSES) for (const b of SIZE_BANDS) {
      classes[`${k}|${t}|${b}`] = { elided: 9_999_999_999, redeemed: 9_999_999_999, chars: 99_999_999_999_999, view: 99_999_999_999_999 }
    }
    resetElisionLedger()
    loadElisionState({ classes, legacyRedeemed: 9_999_999_999 })
    const size = JSON.stringify(elisionState()).length
    expect(Object.keys(elisionState().classes)).toHaveLength(ELISION_KINDS.length * TOOL_CLASSES.length * SIZE_BANDS.length)
    expect(size).toBeLessThan(32_768) // one small synchronous write, in the flush that already writes the totals
    resetElisionLedger()
  })
})
