import { describe, it, expect } from 'vitest'
import {
  LATE_FLOOR_CHARS, ELISION_HOLDOUT_RATE, ARM_CLUSTERS, FLOOR_OVERRIDES, LEGACY_POLICY,
  isFirstSightPolicy, policyFor, effectiveFloor, armForBody, armOf,
} from '../../src/main/headroom/elisionPolicy'
import { assignArm, HOLDOUT_RATE } from '../../src/main/headroom/outputEconomy'

/** A small seeded generator, so the distribution cases are the same on every run and every machine. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const userText = (text: string): Record<string, unknown> => ({ messages: [{ role: 'user', content: text }] })

describe('the first-sight policy', () => {
  it('knows its two names and nothing else', () => {
    expect(isFirstSightPolicy('late')).toBe(true)
    expect(isFirstSightPolicy('legacy')).toBe(true)
    for (const bad of ['Late', 'LEGACY', '', 'off', null, undefined, 0, 1, {}, []]) expect(isFirstSightPolicy(bad)).toBe(false)
  })

  it('fixes the floor at 40,000 characters and the holdout at one conversation in ten', () => {
    expect(LATE_FLOOR_CHARS).toBe(40_000)
    expect(ELISION_HOLDOUT_RATE).toBe(0.1)
    expect(Object.isFrozen(FLOOR_OVERRIDES)).toBe(true)
    expect(FLOOR_OVERRIDES).toEqual({})
  })

  describe('policyFor', () => {
    it('late leaves every tool whole up to 40,000 characters, named or not', () => {
      const p = policyFor('late')
      expect(p.kind).toBe('late')
      for (const tool of [undefined, 'Read', 'Bash', 'Grep', 'Glob', 'PowerShell', 'WebFetch', 'WebSearch', 'mcp__claude_ai_Gmail__get_message', '']) {
        expect(p.floorFor(tool)).toBe(40_000)
      }
    })

    it('a tool name cannot reach into the prototype', () => {
      const p = policyFor('late', 'claude-x')
      for (const tool of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(p.floorFor(tool)).toBe(40_000)
      const q = policyFor('late', '__proto__', { byModel: {}, byTool: {} })
      expect(q.floorFor('Read')).toBe(40_000)
    })

    it('legacy adds no floor of its own: the tier decides', () => {
      const p = policyFor('legacy')
      expect(p.kind).toBe('legacy')
      expect(p.floorFor('Read')).toBe(0)
      expect(p.floorFor(undefined)).toBe(0)
      expect(LEGACY_POLICY.kind).toBe('legacy')
      expect(LEGACY_POLICY.floorFor('Bash')).toBe(0)
    })

    it('reads a per-tool, then a per-model override, and ignores both for legacy', () => {
      const overrides = { byTool: { Read: 20_000, Glob: 1_000 }, byModel: { 'claude-x': 30_000 } }
      expect(policyFor('late', 'claude-x', overrides).floorFor('Read')).toBe(20_000) // the tool wins
      expect(policyFor('late', 'claude-x', overrides).floorFor('Bash')).toBe(30_000) // then the model
      expect(policyFor('late', 'claude-y', overrides).floorFor('Bash')).toBe(40_000) // then the default
      expect(policyFor('late', undefined, overrides).floorFor('Glob')).toBe(1_000)
      expect(policyFor('late', undefined, overrides).floorFor(undefined)).toBe(40_000)
      expect(policyFor('legacy', 'claude-x', overrides).floorFor('Read')).toBe(0)
    })

    it('model names are matched exactly, and a model that is not a string is no model', () => {
      const overrides = { byModel: { 'claude-x': 30_000 } }
      expect(policyFor('late', 'Claude-X', overrides).floorFor('Read')).toBe(40_000)
      for (const m of [undefined, null, 7, {}, ['claude-x']]) expect(policyFor('late', m, overrides).floorFor('Read')).toBe(40_000)
    })

    it('an override that is not a usable floor is ignored rather than trusted', () => {
      for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, '5000', null, undefined, {}]) {
        const p = policyFor('late', 'claude-x', { byTool: { Read: bad as never }, byModel: { 'claude-x': bad as never } })
        expect(p.floorFor('Read')).toBe(40_000)
      }
      // Zero is a usable floor: it hands the decision back to the tier.
      expect(policyFor('late', undefined, { byTool: { Read: 0 } }).floorFor('Read')).toBe(0)
    })
  })

  describe('effectiveFloor', () => {
    it('is the larger of the tier floor and the policy floor: late never shortens more than the tier would', () => {
      expect(effectiveFloor(1_600, policyFor('late'), 'Read')).toBe(40_000) // Aggressive
      expect(effectiveFloor(6_000, policyFor('late'), 'Bash')).toBe(40_000) // Conservative
      expect(effectiveFloor(600, policyFor('late'), undefined)).toBe(40_000) // Maximum
      expect(effectiveFloor(50_000, policyFor('late'), 'Read')).toBe(50_000) // a tier above the policy keeps its own
      expect(effectiveFloor(1_600, policyFor('late', undefined, { byTool: { Read: 1_000 } }), 'Read')).toBe(1_600)
    })

    it('is exactly the tier floor under legacy', () => {
      for (const f of [600, 1_600, 3_200, 6_000]) expect(effectiveFloor(f, policyFor('legacy'), 'Read')).toBe(f)
      expect(effectiveFloor(1_600, LEGACY_POLICY, undefined)).toBe(1_600)
    })
  })
})

describe('armForBody', () => {
  const FIRST = 'Look at the failing test in the parser module and fix it without changing the public API.'

  it('answers late or holdout, nothing else', () => {
    for (let i = 0; i < 200; i++) expect(['late', 'holdout']).toContain(armForBody(userText(`${FIRST} ${i}`)))
  })

  it('is a pure function of the first user message: same text, same arm, every time', () => {
    const arm = armForBody(userText(FIRST))
    for (let i = 0; i < 50; i++) expect(armForBody(userText(FIRST))).toBe(arm)
  })

  // The copy says the assignment is kept "for as long as the conversation's first message stays the same", not
  // "for its whole length": a compaction summarizes the start of a conversation, so what leads the next request
  // may be a different message, and the arm is the one THAT message would have had on its own. This is the
  // behaviour the sentence describes, held in both directions.
  it('keeps a conversation on its arm while its first message stays, and chooses again from the new first message when that changes', () => {
    const summary = (i: number): string => `This session is being continued from a previous conversation that ran out of context. Summary ${i}: ${FIRST}`
    const turns = (first: string, n: number): Record<string, unknown> => ({
      messages: [{ role: 'user', content: first }, ...Array.from({ length: n }, (_, k) => ({ role: k % 2 ? 'user' : 'assistant', content: `turn ${k}` }))],
    })
    // Appending turns never moves it.
    for (let i = 0; i < 40; i++) {
      const first = `${FIRST} (${i})`
      const arm = armForBody(turns(first, 0))
      for (const n of [1, 5, 30, 120]) expect(armForBody(turns(first, n))).toBe(arm)
    }
    // A different first message is chosen on its own: the arm it gets is the one that message has alone, whatever
    // the conversation had before, and across many such conversations the change does move some of them.
    let moved = 0
    for (let i = 0; i < 200; i++) {
      const before = armForBody(turns(`${FIRST} (${i})`, 12))
      const after = armForBody(turns(summary(i), 12))
      expect(after).toBe(armForBody(userText(summary(i))))
      if (after !== before) moved++
    }
    expect(moved).toBeGreaterThan(0)
  })

  it('reads a body given as text the same as the parsed body', () => {
    for (let i = 0; i < 100; i++) {
      const body = userText(`${FIRST} ${i}`)
      expect(armForBody(JSON.stringify(body))).toBe(armForBody(body))
    }
  })

  it('does not change when the client changes how it writes the same first message', () => {
    // Claude Code sends a plain string on one turn and a block with a cache breakpoint on another;
    // an arm that moved with that would change the transform, and so the prompt cache, mid-conversation.
    let flips = 0
    for (let i = 0; i < 400; i++) {
      const t = `${FIRST} variant ${i}`
      const plain = armForBody({ messages: [{ role: 'user', content: t }] })
      const block = armForBody({ messages: [{ role: 'user', content: [{ type: 'text', text: t }] }] })
      const marked = armForBody({ messages: [{ role: 'user', content: [{ type: 'text', text: t, cache_control: { type: 'ephemeral' } }] }] })
      const split = armForBody({ messages: [{ role: 'user', content: [{ type: 'text', text: t.slice(0, 20) }, { type: 'text', text: t.slice(20) }] }] })
      const withImage = armForBody({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: t }] }] })
      if (new Set([plain, block, marked, split, withImage]).size !== 1) flips++
    }
    expect(flips).toBe(0)
  })

  it('ignores everything in the body except that message', () => {
    const base = { messages: [{ role: 'user', content: FIRST }] }
    const arm = armForBody(base)
    const grown = {
      model: 'claude-opus-4', system: [{ type: 'text', text: 'You are a coding agent. <steering mark>' }], tools: [{ name: 'Read' }],
      messages: [
        { role: 'user', content: FIRST },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(50_000) }] },
        { role: 'user', content: 'A completely different later message.' },
      ],
    }
    expect(armForBody(grown)).toBe(arm)
    expect(armForBody({ ...grown, model: 'another-model', system: 'other', tools: [] })).toBe(arm)
  })

  it('takes the first USER message, whatever precedes it', () => {
    const lead = { role: 'assistant', content: 'a prefill that is not the question' }
    expect(armForBody({ messages: [lead, { role: 'user', content: FIRST }] })).toBe(armForBody(userText(FIRST)))
    expect(armForBody({ messages: [lead, { role: 'user', content: FIRST }, { role: 'user', content: 'later' }] })).toBe(armForBody(userText(FIRST)))
  })

  it('has nothing to hash and so stays on the default arm, never in the holdout by accident', () => {
    const empty: unknown[] = [
      userText(''), { messages: [] }, { messages: [{ role: 'assistant', content: 'only the model spoke' }] },
      { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] },
      { messages: [{ role: 'user', content: [] }] }, { messages: [{ role: 'user' }] },
      { messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }] },
    ]
    for (const body of empty) expect(armForBody(body)).toBe('late')
  })

  it('never throws, whatever the body is', () => {
    const hostile = { get messages(): never { throw new Error('boom') } }
    const hostileMessage = { messages: [{ role: 'user', get content(): never { throw new Error('boom') } }] }
    const proxy = new Proxy({}, { get() { throw new Error('boom') } })
    const cases: unknown[] = [
      null, undefined, 5, true, 'not json', '{}', '{"messages":5}', '[]', '', [], {}, { messages: 5 }, { messages: 'x' },
      { messages: [null, 5, 'x', [], { role: 'user', content: 7 }, { role: 'user', content: [null, 3, { type: 'text' }, { type: 'text', text: 5 }, { text: 'no type' }] }] },
      hostile, hostileMessage, proxy,
    ]
    for (const body of cases) expect(() => armForBody(body)).not.toThrow()
    for (const body of cases) expect(['late', 'holdout']).toContain(armForBody(body))
  })

  describe('the arm reads a bounded sample of the first message, so its cost does not grow with it', () => {
    const SAMPLE = 1_024
    /** A first message of `total` characters whose first and last SAMPLE characters are fixed and whose middle is `middle`. */
    const withMiddle = (total: number, middle: string): string => {
      const head = 'H'.repeat(SAMPLE), tail = 'T'.repeat(SAMPLE)
      return head + (middle + 'm'.repeat(total)).slice(0, total - 2 * SAMPLE) + tail
    }

    it('does not look at the middle of a long first message: same length, head and tail, same arm and group', () => {
      let different = 0
      for (let i = 0; i < 300; i++) {
        const a = armOf(userText(withMiddle(5_000, `variant ${i} `)))
        const b = armOf(userText(withMiddle(5_000, `another ${i * 7 + 1} `)))
        if (a.arm !== b.arm || a.cluster !== b.cluster) different++
      }
      expect(different).toBe(0)
    })

    it('does look at the ends and the length: change the last character, the first, or the length, and the arm moves for some', () => {
      const moved = (make: (i: number) => [string, string]): number => {
        let n = 0
        for (let i = 0; i < 400; i++) {
          const [x, y] = make(i)
          const a = armOf(userText(x)), b = armOf(userText(y))
          if (a.arm !== b.arm || a.cluster !== b.cluster) n++
        }
        return n
      }
      const body = (i: number): string => `Task ${i}: ` + 'p'.repeat(6_000)
      expect(moved((i) => [body(i), body(i).slice(0, -1) + 'Z'])).toBeGreaterThan(300) // the last character
      expect(moved((i) => [body(i), 'Q' + body(i).slice(1)])).toBeGreaterThan(300) // the first
      // The length alone: the same first and last 1,024 characters, a middle one character longer.
      expect(moved((i) => [withMiddle(5_000 + i, 'same '), withMiddle(5_001 + i, 'same ')])).toBeGreaterThan(300)
    })

    it('keeps the distribution when a long shared reminder comes first and the task last, however long the reminder is', () => {
      const reminder = `<system-reminder>\n${'Contents of the project instructions file. '.repeat(5_000)}\n</system-reminder>\n\n` // about 215,000 characters
      expect(reminder.length).toBeGreaterThan(200_000)
      let held = 0
      const N = 4_000
      for (let i = 0; i < N; i++) if (armForBody(userText(`${reminder}Task ${String(i).padStart(5, '0')}: tidy up the build script.`)) === 'holdout') held++
      expect((held / N) * 100).toBeGreaterThan(8)
      expect((held / N) * 100).toBeLessThan(12)
    })

    it('hashes the whole of a first message short enough to be covered: every character counts up to 2,048', () => {
      for (const total of [10, 1_024, 1_500, 2_048]) {
        let moved = 0
        for (let i = 0; i < 300; i++) {
          const s = `${i}`.padStart(8, '0') + 'a'.repeat(total - 8)
          const mid = Math.floor(total / 2)
          const t = s.slice(0, mid) + (s[mid] === 'a' ? 'b' : 'a') + s.slice(mid + 1) // change one character in the middle
          const a = armOf(userText(s)), b = armOf(userText(t))
          if (a.arm !== b.arm || a.cluster !== b.cluster) moved++
        }
        expect(moved, `${total} characters`).toBeGreaterThan(200)
      }
    })

    it('is the same however the text is cut into blocks, including blocks that straddle the sample edges', () => {
      const text = 'x'.repeat(700) + 'MIDDLE-' + 'y'.repeat(3_000) + '-END'
      const whole = armOf({ messages: [{ role: 'user', content: text }] })
      for (const cuts of [[1], [1_023], [1_024], [1_025], [700, 2_000], [10, 1_030, 3_000], [text.length - 1], [text.length - 1_025, text.length - 1_023]]) {
        const blocks: Array<{ type: string; text: string }> = []
        let at = 0
        for (const c of [...cuts, text.length]) { blocks.push({ type: 'text', text: text.slice(at, c) }); at = c }
        expect(armOf({ messages: [{ role: 'user', content: blocks }] }), JSON.stringify(cuts)).toEqual(whole)
      }
    })

    it('costs the same on a first message of two million characters as on one of twenty thousand', () => {
      const small = { messages: [{ role: 'user', content: 'x'.repeat(20_000) }] }
      const huge = { messages: [{ role: 'user', content: 'x'.repeat(2_000_000) }] }
      for (let i = 0; i < 30; i++) { armOf(small); armOf(huge) } // warm both
      const best = (obj: unknown): number => {
        let b = Infinity
        for (let r = 0; r < 12; r++) {
          const t = process.hrtime.bigint()
          for (let i = 0; i < 20; i++) armOf(obj)
          const d = Number(process.hrtime.bigint() - t)
          if (d < b) b = d
        }
        return b
      }
      // Alternate so both see the same machine state. Hashing every character would make the second
      // about a hundred times the first (measured 3 ms against 0.3 ms per call at a tenth the size);
      // reading a bounded sample makes them equal. Five times is far past any noise and far short of that.
      const a1 = best(small), b1 = best(huge), a2 = best(small), b2 = best(huge)
      expect(Math.min(b1, b2)).toBeLessThanOrEqual(Math.min(a1, a2) * 5)
    })
  })

  describe('armOf: the arm and the group of conversations it falls in', () => {
    it('agrees with armForBody and puts every conversation in one of ARM_CLUSTERS groups', () => {
      expect(ARM_CLUSTERS).toBe(20)
      for (let i = 0; i < 500; i++) {
        const body = userText(`${FIRST} number ${i}`)
        const { arm, cluster } = armOf(body)
        expect(arm).toBe(armForBody(body))
        expect(Number.isInteger(cluster)).toBe(true)
        expect(cluster).toBeGreaterThanOrEqual(0)
        expect(cluster).toBeLessThan(ARM_CLUSTERS)
      }
    })

    it('is as pure as the arm: the same first message always falls in the same group', () => {
      for (let i = 0; i < 100; i++) {
        const body = userText(`${FIRST} ${i}`)
        expect(armOf(body)).toEqual(armOf(JSON.stringify(body)))
        expect(armOf(body)).toEqual(armOf(body))
      }
    })

    it('puts a conversation with nothing to hash in the default arm, group 0', () => {
      for (const body of [userText(''), { messages: [] }, null, 5, { get messages(): never { throw new Error('boom') } }]) {
        expect(armOf(body)).toEqual({ arm: 'late', cluster: 0, key: 0 })
      }
    })

    it('spreads each arm evenly over its groups, so a group is a random slice of the arm', () => {
      const counts = { late: new Array<number>(ARM_CLUSTERS).fill(0), holdout: new Array<number>(ARM_CLUSTERS).fill(0) }
      const N = 40_000
      for (let i = 0; i < N; i++) {
        const { arm, cluster } = armOf(userText(`Please review module ${i} and fix the failing test number ${i * 7}.`))
        counts[arm][cluster]++
      }
      for (const arm of ['late', 'holdout'] as const) {
        const total = counts[arm].reduce((a, b) => a + b, 0)
        const even = total / ARM_CLUSTERS
        for (const c of counts[arm]) {
          expect(c).toBeGreaterThan(even * 0.7)
          expect(c).toBeLessThan(even * 1.3)
        }
      }
    })
  })

  describe('over many conversations', () => {
    const holdoutShare = (texts: string[]): number => {
      let n = 0
      for (const t of texts) if (armForBody(userText(t)) === 'holdout') n++
      return (n / texts.length) * 100
    }
    const N = 20_000

    it('holds out 10% +/- 1.5 points of short first messages that differ by a counter', () => {
      const share = holdoutShare(Array.from({ length: N }, (_, i) => `Please review module ${i} and fix the failing test number ${i * 7}.`))
      expect(share).toBeGreaterThan(8.5)
      expect(share).toBeLessThan(11.5)
    })

    it('holds out 10% +/- 1.5 points when a long shared reminder comes first and the task last', () => {
      // The shape of a real first message: project instructions, then the prompt.
      const reminder = `<system-reminder>\n${'Contents of the project instructions file. '.repeat(60)}\n</system-reminder>\n\n`
      const share = holdoutShare(Array.from({ length: N }, (_, i) => `${reminder}Task ${String(i).padStart(5, '0')}: tidy up the build script.`))
      expect(share).toBeGreaterThan(8.5)
      expect(share).toBeLessThan(11.5)
    })

    it('holds out 10% +/- 1.5 points of prompts made of random words', () => {
      const rnd = seeded(20261101)
      const words = ['refactor', 'audit', 'module', 'parser', 'cache', 'fix', 'build', 'test', 'deploy', 'review', 'add', 'remove', 'rename', 'update', 'investigate', 'the', 'a', 'in', 'of']
      const texts = Array.from({ length: N }, () => Array.from({ length: 4 + Math.floor(rnd() * 12) }, () => words[Math.floor(rnd() * words.length)]).join(' '))
      const share = holdoutShare(texts)
      expect(share).toBeGreaterThan(8.5)
      expect(share).toBeLessThan(11.5)
    })

    it('is not the output-steering experiment in disguise: the two holdouts overlap by chance only', () => {
      // The same hash for both would put a conversation in both holdouts or neither, and the two
      // experiments could not be read apart. Independent 10% draws overlap in about 1% of conversations.
      expect(HOLDOUT_RATE).toBe(ELISION_HOLDOUT_RATE)
      let both = 0
      for (let i = 0; i < N; i++) {
        const t = `Please review module ${i} and fix the failing test number ${i * 7}.`
        if (armForBody(userText(t)) === 'holdout' && assignArm(t) === 'holdout') both++
      }
      const share = (both / N) * 100
      expect(share).toBeGreaterThan(0.4)
      expect(share).toBeLessThan(1.8)
    })
  })
})

/**
 * The arm is pinned, not only bounded. A holdout share inside 10% +/- 1.5 points is satisfied by any
 * good hash, so a changed salt, a different slice of the message or a hash that also read the system
 * prompt would pass every distribution test above while moving conversations between the arms. That
 * has a price: a conversation that changes arm in flight rewrites its cached prefix once, and the
 * persisted per-arm ledger would mix two partitions, which is the comparison's whole instrument.
 * These vectors were computed from the shipped function; changing one is a decision to re-partition.
 */
describe('armOf is pinned', () => {
  const GOLDEN: Array<[string, string, 'late' | 'holdout', number, number]> = [
    ['a', 'a', 'holdout', 10, 216939230],
    ['hello', 'hello', 'holdout', 14, 309901836],
    ['a sentence', 'Please fix the failing test in src/main/index.ts', 'late', 11, 2695996405],
    ['continue', 'continue', 'late', 9, 2309817492],
    ['2049 x', 'x'.repeat(2049), 'late', 13, 3078410575],
    ['golden-vector-0', 'golden-vector-0', 'holdout', 13, 280641147],
    ['golden-vector-1', 'golden-vector-1', 'late', 12, 2933833596],
    ['golden-vector-2', 'golden-vector-2', 'late', 17, 3734568669],
    ['golden-vector-3', 'golden-vector-3', 'late', 7, 1802377660],
    ['golden-vector-4', 'golden-vector-4', 'late', 14, 3180615464],
    ['golden-vector-5', 'golden-vector-5', 'holdout', 2, 57828297],
    ['golden-vector-6', 'golden-vector-6', 'late', 14, 3252450338],
    ['golden-vector-7', 'golden-vector-7', 'late', 4, 1256340161],
    ['golden-vector-8', 'golden-vector-8', 'late', 1, 759616036],
    ['golden-vector-9', 'golden-vector-9', 'late', 0, 482083290],
    ['non-ASCII', 'Prüfe die Tests — 日本語 ✓ 🙂', 'late', 2, 885121896],
    ['several lines', 'line one\nline two\n\nline four', 'holdout', 5, 125041616],
    ['6,000 characters', 'ab'.repeat(3000), 'late', 7, 1862429421],
  ]

  it.each(GOLDEN)('pins %s to its arm, group and key, however the client writes the message', (_label, text, arm, cluster, key) => {
    expect(armOf(userText(text))).toEqual({ arm, cluster, key })
    expect(armForBody(userText(text))).toBe(arm)
    // The same text as one block, and cut in two: the same conversation.
    expect(armOf({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] })).toEqual({ arm, cluster, key })
    const cut = Math.floor(text.length / 2)
    expect(armOf({ messages: [{ role: 'user', content: [{ type: 'text', text: text.slice(0, cut) }, { type: 'text', text: text.slice(cut) }] }] })).toEqual({ arm, cluster, key })
  })

  it('reads the first message and nothing else, over 300 different conversations', () => {
    for (let i = 0; i < 300; i++) {
      const first = `Conversation ${i}: please look into why module ${i * 13} fails its ${i % 7} case, then summarise.`
      const base = armOf(userText(first))
      const grown = {
        messages: [
          { role: 'user', content: first },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `src/${i}.ts` } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `later text ${i}` }] },
          { role: 'user', content: `a later user message ${i}` },
        ],
        system: [{ type: 'text', text: `You are agent ${i}. ⁣termpolis-steer⁣` }],
        tools: [{ name: `tool_${i}`, description: 'x', input_schema: { type: 'object' } }],
        model: `model-${i % 5}`,
        thinking: { type: 'enabled', budget_tokens: 1024 + i },
        metadata: { user_id: `user-${i}` },
        max_tokens: 1000 + i,
      }
      expect(armOf(grown), first).toEqual(base)
      expect(armOf(JSON.stringify(grown)), first).toEqual(base)
    }
  })

  it('names the conversation: the key is the same on every turn and different between conversations', () => {
    const keys = new Set<number>()
    for (let i = 0; i < 500; i++) {
      const k = armOf(userText(`Conversation number ${i} about the build`)).key
      expect(k).toBeGreaterThan(0)
      expect(Number.isInteger(k)).toBe(true)
      expect(k).toBeLessThan(2 ** 32)
      keys.add(k)
    }
    // 32 bits: a handful of collisions in 500 would be a broken hash, not bad luck.
    expect(keys.size).toBeGreaterThanOrEqual(499)
  })

  it('and the arm and the group are read off that same key', () => {
    for (let i = 0; i < 300; i++) {
      const { arm, cluster, key } = armOf(userText(`Please handle ticket ${i}.`))
      const p = key / 2 ** 32
      expect(arm).toBe(p < ELISION_HOLDOUT_RATE ? 'holdout' : 'late')
      const within = p < ELISION_HOLDOUT_RATE ? p / ELISION_HOLDOUT_RATE : (p - ELISION_HOLDOUT_RATE) / (1 - ELISION_HOLDOUT_RATE)
      expect(cluster).toBe(Math.min(ARM_CLUSTERS - 1, Math.floor(within * ARM_CLUSTERS)))
    }
  })
})
