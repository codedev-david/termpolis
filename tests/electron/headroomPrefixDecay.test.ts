import { describe, it, expect } from 'vitest'
import {
  decayCutoff, applyPrefixDecay, breakEvenTurns, DECAY_FIRST_THRESHOLD, DECAY_MIN_CHARS,
} from '../../src/main/headroomProxy/prefixDecay'
const { rewriteMessagesBody } = await import('../../src/main/headroomProxy/wireCompress')

const lines = (n: number, tag = 'v'): string =>
  Array.from({ length: n }, (_, i) => `  const ${tag}${i} = compute(${i}) // a reasonably long source line`).join('\n')

/**
 * A conversation comfortably past the first decay threshold. Derived from the constant rather than
 * hard-coded: these fixtures were written at 80 for a threshold of 64, and silently stopped
 * decaying anything when the threshold moved to 128 — the assertions still ran, they just proved
 * nothing. Tying the size to the constant means raising the threshold again cannot quietly hollow
 * these tests out.
 */
const DECAY_DEEP = DECAY_FIRST_THRESHOLD + DECAY_FIRST_THRESHOLD / 4

const convo = (n: number, bodyLines = 40): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'assistant' : 'user',
    content: [i % 2 === 0
      ? { type: 'tool_use', id: `t${i}`, name: 'Write', input: { file_path: `/f${i}.ts`, content: lines(bodyLines, `a${i}`) } }
      : { type: 'tool_result', tool_use_id: `t${i - 1}`, content: lines(bodyLines, `r${i}`) }],
  }))

describe('prefix decay — cutoff arithmetic', () => {
  it('does nothing until the conversation is long enough to repay a cache break', () => {
    for (const n of [0, 1, 10, DECAY_FIRST_THRESHOLD - 1]) expect(decayCutoff(n)).toBe(0)
  })

  it('holds the cutoff CONSTANT between doubling boundaries', () => {
    // This is the whole design. A cutoff that crept forward by one message per turn would re-cut
    // the prefix on every single request — a cache break every turn, strictly worse than never
    // decaying at all. Between 128 and 255 messages the compressed prefix must not move.
    const inBand = Array.from({ length: DECAY_FIRST_THRESHOLD }, (_, i) => decayCutoff(DECAY_FIRST_THRESHOLD + i))
    expect(new Set(inBand).size).toBe(1)
    expect(inBand[0]).toBe(DECAY_FIRST_THRESHOLD / 2)
  })

  it('advances exactly once per doubling', () => {
    // Below the first threshold there is no cut at all: a break at 64 has only 64 turns of runway
    // against a ~44-turn break-even, which is too thin a margin to spend the cache on.
    expect(decayCutoff(64)).toBe(0)
    expect(decayCutoff(127)).toBe(0)
    expect(decayCutoff(128)).toBe(64)
    expect(decayCutoff(255)).toBe(64)
    expect(decayCutoff(256)).toBe(128)
    expect(decayCutoff(1024)).toBe(512)
  })

  it('breaks the cache a logarithmic number of times, not a linear one', () => {
    // 300 turns of conversation → a handful of breaks. Any other schedule and the arithmetic below
    // never gets a chance to pay off.
    const seen = new Set<number>()
    for (let n = 2; n <= 600; n++) seen.add(decayCutoff(n))
    seen.delete(0)
    expect(seen.size).toBeLessThanOrEqual(5)
  })

  it('never returns a cutoff past the conversation itself', () => {
    for (let n = 0; n <= 600; n++) expect(decayCutoff(n)).toBeLessThanOrEqual(n)
  })

  it('ignores garbage lengths instead of decaying an unknown amount', () => {
    for (const n of [NaN, Infinity, -5]) expect(decayCutoff(n)).toBe(0)
  })
})

describe('prefix decay — break-even arithmetic', () => {
  it('matches the measured numbers this feature was sized against', () => {
    // 68,000-token prefix, 20,000 tokens removed → ~39 more turns to repay the break.
    expect(Math.round(breakEvenTurns(68000, 20000))).toBe(39)
    // Remove a quarter as much and it takes four times as long. This spread is why the first cut
    // waits for 128 messages rather than 64: at 156 turns to repay, a 64-turn runway loses money.
    expect(Math.round(breakEvenTurns(68000, 5000))).toBe(156)
  })

  it('reports an impossible payoff rather than a tempting one when nothing is removed', () => {
    expect(breakEvenTurns(68000, 0)).toBe(Infinity)
    expect(breakEvenTurns(68000, NaN)).toBe(Infinity)
  })
})

describe('prefix decay — the transform', () => {
  it('ages out old bulk and leaves recent turns fully intact', () => {
    const messages = convo(DECAY_DEEP)
    const stashes: Array<{ token: string; original: string }> = []
    const counts = applyPrefixDecay(messages, stashes)
    expect(counts.blocks).toBeGreaterThan(0)
    expect(counts.compChars).toBeLessThan(counts.origChars)
    const oldBlock = (messages[1].content as Array<{ content: string }>)[0].content
    const recentBlock = (messages[DECAY_DEEP - 1].content as Array<{ content: string }>)[0].content
    expect(oldBlock).toContain('Aged out')
    expect(recentBlock).not.toContain('Aged out')
  })

  it('keeps every aged block recoverable through retrieve_full', () => {
    const messages = convo(DECAY_DEEP)
    const stashes: Array<{ token: string; original: string }> = []
    applyPrefixDecay(messages, stashes)
    const stub = (messages[1].content as Array<{ content: string }>)[0].content
    const token = /token "(hr_[a-z0-9]+)"/.exec(stub)?.[1]
    expect(token).toBeTruthy()
    expect(stashes.find((s) => s.token === token)?.original).toContain('const r1')
  })

  it('refuses to age out identifier fields — a stubbed path is misleading, a stubbed body is not', () => {
    const longPath = '/repo/' + 'nested/'.repeat(200) + 'file.ts'
    expect(longPath.length).toBeGreaterThan(DECAY_MIN_CHARS)
    const messages = convo(DECAY_DEEP)
    ;(messages[0].content as Array<{ input: Record<string, string> }>)[0].input.file_path = longPath
    applyPrefixDecay(messages, [])
    expect((messages[0].content as Array<{ input: Record<string, string> }>)[0].input.file_path).toBe(longPath)
  })

  it('leaves a thinking block alone at any age — its signature is cryptographically validated', () => {
    const messages = convo(DECAY_DEEP)
    messages[0].content = [{ type: 'thinking', thinking: lines(200, 'th'), signature: 'sig-xyz' }]
    applyPrefixDecay(messages, [])
    const think = (messages[0].content as Array<{ thinking: string; signature: string }>)[0]
    expect(think.thinking).toBe(lines(200, 'th'))
    expect(think.signature).toBe('sig-xyz')
  })

  it('skips blocks too small for the stub to be worth it', () => {
    const messages = convo(DECAY_DEEP, 2) // ~130 chars per block
    const counts = applyPrefixDecay(messages, [])
    expect(counts.blocks).toBe(0)
  })

  it('ages out the ARRAY form of tool_result too — the shape Claude Code actually sends', () => {
    // tool_result.content is a string in some clients and a [{type:'text'}] array in others.
    // Handling only the string form would silently exempt the majority of real traffic.
    const messages = convo(DECAY_DEEP)
    messages[1].content = [{ type: 'tool_result', tool_use_id: 't0', content: [
      { type: 'text', text: lines(60, 'arr') },
      { type: 'text', text: 'short' },
      { type: 'image', source: { data: 'x' } },
    ] }]
    const stashes: Array<{ token: string; original: string }> = []
    const counts = applyPrefixDecay(messages, stashes)
    const items = (messages[1].content as Array<{ content: Array<{ type: string; text?: string }> }>)[0].content
    expect(items[0].text).toContain('Aged out')
    expect(items[1].text).toBe('short') // below the floor, left alone
    expect(items[2].text).toBeUndefined() // an image block is not text and must not grow one
    expect(stashes.some((st) => st.original === lines(60, 'arr'))).toBe(true)
    expect(counts.blocks).toBeGreaterThan(0)
  })

  it('walks past malformed blocks instead of throwing mid-conversation', () => {
    const messages = convo(DECAY_DEEP)
    messages[2].content = [null, 'a string', 42, { type: 'tool_use', input: null }, { type: 'tool_use', input: ['x'] }] as never
    messages[3].content = 'not an array' as never
    expect(() => applyPrefixDecay(messages, [])).not.toThrow()
  })

  it('is idempotent — a second pass finds nothing left to age', () => {
    const messages = convo(DECAY_DEEP)
    applyPrefixDecay(messages, [])
    expect(applyPrefixDecay(messages, []).blocks).toBe(0)
  })
})

describe('prefix decay — wired into the compressor', () => {
  const body = (n: number): string => JSON.stringify({ model: 'claude-x', messages: convo(n) })

  it('stays OFF unless explicitly asked for', () => {
    const out = rewriteMessagesBody(body(DECAY_DEEP)).body
    expect(out).not.toContain('Aged out')
  })

  it('applies when asked, and bills what it removed', () => {
    const r = rewriteMessagesBody(body(DECAY_DEEP), { decay: true })
    expect(r.changed).toBe(true)
    expect(r.body).toContain('Aged out')
    expect(r.stats.trOrigChars).toBeGreaterThan(r.stats.trCompChars)
  })

  it('holds the prefix byte-stable WITHIN a band, and only re-cuts at the boundary', () => {
    // The one cost decay is allowed to incur is a break at a doubling boundary. Inside a band the
    // prefix must be identical turn over turn, or the feature loses money on every request.
    const at = (n: number): unknown[] => JSON.parse(rewriteMessagesBody(body(n), { decay: true }).body).messages
    const a = at(80)
    const b = at(100)
    expect(JSON.stringify(b.slice(0, 80))).toBe(JSON.stringify(a))
    // ...and crossing 128 is where it is permitted to move.
    const c = at(130)
    expect(JSON.stringify(c.slice(0, 80))).not.toBe(JSON.stringify(a))
  })
})
