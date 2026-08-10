import { describe, it, expect, beforeEach } from 'vitest'
const { rewriteMessagesBody, setWireWindow } = await import('../../src/main/headroomProxy/wireCompress')

/**
 * THE cache-safety invariant, tested directly.
 *
 * Anthropic bills a re-sent prefix that matches the cache at a tenth of rate, and on this app's
 * measured traffic the prefix is ~68,000 tokens per request. That makes cache integrity worth
 * roughly ten times more than compression itself: a transform that saved 50% of tool text while
 * shifting one byte in the prefix each turn would LOSE money on every single request.
 *
 * The existing byte-stability tests compare a body against ITSELF, which cannot catch the failure
 * that actually matters — a transform whose output depends on how much history follows it (a
 * per-call counter for stash tokens, a dedup index that rewrites earlier blocks when a later
 * duplicate arrives, a diff base chosen from the whole body rather than from what precedes it).
 * These tests grow the conversation turn by turn and assert the compressed PREFIX never moves.
 */

const lines = (n: number, tag = 'v'): string =>
  Array.from({ length: n }, (_, i) => `  const ${tag}${i} = compute(${i}) // a reasonably long source line`).join('\n')

type Block = Record<string, unknown>
const toolResult = (id: string, text: string): Block => ({ type: 'tool_result', tool_use_id: id, content: text })
const toolUse = (id: string, input: Record<string, unknown>): Block =>
  ({ type: 'tool_use', id, name: 'Write', input })
const msg = (role: string, content: Block[]): Record<string, unknown> => ({ role, content })

const compressedMessages = (messages: Array<Record<string, unknown>>): unknown[] => {
  const r = rewriteMessagesBody(JSON.stringify({ model: 'claude-x', messages }))
  return JSON.parse(r.body).messages
}

/** Compress `turns`, then compress `turns` + `extra`, and return both views of the shared prefix. */
function prefixAfterGrowth(
  turns: Array<Record<string, unknown>>,
  extra: Array<Record<string, unknown>>,
): { before: string; after: string } {
  const before = compressedMessages(turns)
  const after = compressedMessages([...turns, ...extra])
  return {
    before: JSON.stringify(before),
    after: JSON.stringify(after.slice(0, turns.length)),
  }
}

describe('wire compression — cached prefix stability across turns', () => {
  beforeEach(() => setWireWindow({ headLines: 12, tailLines: 6, maxChars: 1000 }))

  it('leaves the whole compressed prefix byte-identical when a turn is appended', () => {
    const turns = [
      msg('assistant', [toolUse('a', { file_path: '/a.ts', content: lines(300, 'a') })]),
      msg('user', [toolResult('a', lines(300, 'r'))]),
      msg('assistant', [toolUse('b', { file_path: '/b.ts', content: lines(280, 'b') })]),
      msg('user', [toolResult('b', lines(260, 's'))]),
    ]
    const { before, after } = prefixAfterGrowth(turns, [
      msg('assistant', [toolUse('c', { file_path: '/c.ts', content: lines(400, 'c') })]),
      msg('user', [toolResult('c', lines(400, 't'))]),
    ])
    expect(after).toBe(before)
  })

  it('stays stable over TEN successive appends, not just one', () => {
    // A drift of one byte per turn is invisible in a single-step check and ruinous over a session.
    let turns: Array<Record<string, unknown>> = [msg('user', [toolResult('t0', lines(200, 'z'))])]
    let prefix = JSON.stringify(compressedMessages(turns))
    for (let i = 1; i <= 10; i++) {
      const grown = [...turns, msg('user', [toolResult(`t${i}`, lines(150 + i * 7, `q${i}`))])]
      const after = compressedMessages(grown)
      expect(JSON.stringify(after.slice(0, turns.length))).toBe(prefix)
      turns = grown
      prefix = JSON.stringify(after)
    }
  })

  it('does not rewrite the FIRST copy of a block when a duplicate arrives later', () => {
    // Dedup must always collapse the LATER occurrence. Collapsing the earlier one would rewrite
    // cached history the moment a file is re-read — the exact shape of an expensive bug.
    const body = lines(300, 'dup')
    const turns = [msg('user', [toolResult('d1', body)])]
    const { before, after } = prefixAfterGrowth(turns, [msg('user', [toolResult('d2', body)])])
    expect(after).toBe(before)
    const grown = compressedMessages([...turns, msg('user', [toolResult('d2', body)])]) as Array<{ content: Block[] }>
    expect(String(grown[1].content[0].content)).toContain('Identical to an earlier tool result')
  })

  it('does not rewrite an earlier block when a NEAR-duplicate of it arrives later', () => {
    // Diff encoding picks its base from blocks already seen, so a later patch can never reach
    // back and re-encode the base it was written against.
    const original = lines(300, 'e')
    const edited = original.replace('const e150', 'const e150_RENAMED')
    const turns = [msg('user', [toolResult('e1', original)])]
    const { before, after } = prefixAfterGrowth(turns, [msg('user', [toolResult('e2', edited)])])
    expect(after).toBe(before)
  })

  it('gives a repeated block the SAME stash token no matter how much history precedes it', () => {
    // Tokens are content hashes, not counters. A counter would mint a new token every turn and
    // silently invalidate the prefix on every request.
    const body = lines(400, 'tok')
    const tokenOf = (m: unknown[]): string | undefined => {
      const text = JSON.stringify(m)
      return /token \\"(hr_[a-z0-9]+)\\"/.exec(text)?.[1]
    }
    const early = tokenOf(compressedMessages([msg('user', [toolResult('x', body)])]))
    const late = tokenOf(
      compressedMessages([
        ...Array.from({ length: 6 }, (_, i) => msg('user', [toolResult(`pad${i}`, lines(120, `p${i}`))])),
        msg('user', [toolResult('x', body)]),
      ]).slice(6),
    )
    expect(early).toBeTruthy()
    expect(late).toBe(early)
  })

  it('keeps the prefix stable when a tool_use block is followed by a read of the same file', () => {
    // The write→read collapse is the one place tool_use and tool_result share an index, so it is
    // the likeliest place for a later block to disturb an earlier one.
    const content = lines(350, 'w')
    const turns = [msg('assistant', [toolUse('w1', { file_path: '/w.ts', content })])]
    const { before, after } = prefixAfterGrowth(turns, [msg('user', [toolResult('w1', content)])])
    expect(after).toBe(before)
  })

  it('holds the invariant at the max tier too', () => {
    setWireWindow({ headLines: 6, tailLines: 3, maxChars: 500 })
    const turns = [
      msg('user', [toolResult('m1', lines(200, 'm'))]),
      msg('assistant', [toolUse('m2', { file_path: '/m.ts', content: lines(200, 'n') })]),
    ]
    const { before, after } = prefixAfterGrowth(turns, [msg('user', [toolResult('m3', lines(300, 'o'))])])
    expect(after).toBe(before)
  })
})
