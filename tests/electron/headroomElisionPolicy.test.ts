import { describe, it, expect } from 'vitest'
import {
  LATE_FLOOR_CHARS, ELISION_HOLDOUT_RATE, FLOOR_OVERRIDES, LEGACY_POLICY,
  isFirstSightPolicy, policyFor, effectiveFloor, armForBody,
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
