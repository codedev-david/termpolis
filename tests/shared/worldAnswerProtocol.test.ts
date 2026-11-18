import { describe, it, expect } from 'vitest'
import { ANSWER_PROTOCOL, HONESTY_RULE, MIN_SENTENCE_MS, REVEAL_MS_PER_WORD, answerText, parseAnswer, revealMs, sepOf } from '../../src/shared/world/answerProtocol'
import type { Evidence } from '../../src/shared/world/types'
import minDoc from './fixtures/world.min.json'

type Any = any
const doc: Any = minDoc
const bId: string = doc.buildings[0].id
const labels: Record<string, Evidence> = {}
const dId: string = doc.districts[0].id
const eId: string = doc.edges[0].id
const block = (json: string): string => '```world-actions\n' + json + '\n```'
const wrap = (actions: unknown): string => 'Answer text.\n' + block(JSON.stringify(actions))

describe('ANSWER_PROTOCOL', () => {
  it('carries the allowed steps and the evidence rule', () => {
    expect(ANSWER_PROTOCOL).toContain('Keep it under 150 words.')
    expect(ANSWER_PROTOCOL).toContain('{"type":"reset"}')
    expect(ANSWER_PROTOCOL).toContain('Cite evidence inline as [E<n>]')
  })
})

describe('parseAnswer', () => {
  it('extracts text before the block and the actions inside it', () => {
    const r = parseAnswer(wrap([{ type: 'focus', ids: [bId] }, { type: 'highlight', ids: [dId] },
      { type: 'flow', edgeIds: [eId] }, { type: 'openCard', id: eId }, { type: 'reset' }]), doc)
    expect(r.text).toBe('Answer text.')
    expect(r.actions).toEqual([{ type: 'focus', ids: [bId] }, { type: 'highlight', ids: [dId] },
      { type: 'flow', edgeIds: [eId] }, { type: 'openCard', id: eId }, { type: 'reset' }])
    expect(r.dropped).toBe(0)
  })

  it('no block → actions [] and full text', () => {
    const r = parseAnswer('  Just prose.  ', doc)
    expect(r).toEqual({ text: 'Just prose.', sentences: [{ text: 'Just prose.', actions: [], sep: '' }], actions: [], evidence: [], dropped: 0, unsupported: [], uncited: true })
  })

  it('malformed JSON → actions [], dropped 0, text intact', () => {
    const r = parseAnswer('Hello\n' + block('[{"type":'), doc)
    expect(r.text).toBe('Hello')
    expect(r.actions).toEqual([])
    expect(r.dropped).toBe(0)
  })

  it('a block whose JSON is not an array yields no actions', () => {
    const r = parseAnswer('Hi\n' + block('{"type":"reset"}'), doc)
    expect(r.actions).toEqual([])
    expect(r.dropped).toBe(0)
  })

  it('unknown building id inside focus is removed; a step left empty is removed; dropped counts both', () => {
    const r = parseAnswer(wrap([{ type: 'focus', ids: [bId, 'nope'] }, { type: 'highlight', ids: ['x'] }]), doc)
    expect(r.actions).toEqual([{ type: 'focus', ids: [bId] }])
    expect(r.dropped).toBe(3) // 'nope', 'x', and the emptied highlight step
  })

  it('non-string ids are dropped; a non-array ids field empties the step', () => {
    const r = parseAnswer(wrap([{ type: 'focus', ids: [bId, 7] }, { type: 'focus', ids: 'x' }, { type: 'flow' }]), doc)
    expect(r.actions).toEqual([{ type: 'focus', ids: [bId] }])
    expect(r.dropped).toBe(3) // 7, then two steps with nothing
  })

  it('flow keeps only edge ids; openCard with an unknown id is removed', () => {
    const r = parseAnswer(wrap([{ type: 'flow', edgeIds: [eId, bId] }, { type: 'openCard', id: 'zzz' }, { type: 'openCard' }]), doc)
    expect(r.actions).toEqual([{ type: 'flow', edgeIds: [eId] }])
    expect(r.dropped).toBe(1 + 2 + 2)
  })

  it('tour keeps valid steps, drops steps whose ids all vanish, and removes an emptied tour', () => {
    const ok = parseAnswer(wrap([{ type: 'tour', steps: [
      { ids: [bId, 'bad'], caption: 'one' }, { ids: ['bad'], caption: 'two' }, { ids: [dId] }, 'junk'] }]), doc)
    expect(ok.actions).toEqual([{ type: 'tour', steps: [{ ids: [bId], caption: 'one' }, { ids: [dId], caption: '' }] }])
    expect(ok.dropped).toBe(1 + 2 + 1)
    const empty = parseAnswer(wrap([{ type: 'tour', steps: [{ ids: ['bad'], caption: 'x' }] }, { type: 'tour', steps: 'no' }]), doc)
    expect(empty.actions).toEqual([])
    expect(empty.dropped).toBe(1 + 1 + 1 + 1)
  })

  it('tour with 25 steps truncated to 12', () => {
    const steps = Array.from({ length: 25 }, (_, i) => ({ ids: [bId], caption: `s${i}` }))
    const r = parseAnswer(wrap([{ type: 'tour', steps }]), doc)
    const tour = r.actions[0] as Any
    expect(tour.steps).toHaveLength(12)
    expect(tour.steps[11].caption).toBe('s11')
    expect(r.dropped).toBe(13)
  })

  it('draftProposal is rejected in the app (dropped)', () => {
    const r = parseAnswer(wrap([{ type: 'draftProposal', proposalId: 'p' }, { type: 'reset' }]), doc)
    expect(r.actions).toEqual([{ type: 'reset' }])
    expect(r.dropped).toBe(1)
  })

  it('unknown and non-object steps are dropped', () => {
    const r = parseAnswer(wrap([{ type: 'explode' }, null, 5, { nope: 1 }]), doc)
    expect(r.actions).toEqual([])
    expect(r.dropped).toBe(4)
  })

  it('[E2] markers map to evidence from the supplied label table and stay in text', () => {
    const e1: Evidence = { kind: 'file', ref: 'a.ts' }
    const e2: Evidence = { kind: 'symbol', ref: 'b' }
    const r = parseAnswer('See [E2] and [E1], again [E2], missing [E9].', doc, { E1: e1, E2: e2 })
    expect(r.evidence).toEqual([e2, e1])
    expect(r.text).toBe('See [E2] and [E1], again [E2], missing [E9].')
  })

  it('a grouped citation splits into one marker per label, so each becomes a chip (round 3 B)', () => {
    const ev = (n: number): Evidence => ({ kind: 'file', ref: `f${n}.ts` })
    const table = Object.fromEntries([3, 4, 5, 20, 21, 30].map((n) => [`E${n}`, ev(n)]))
    const r = parseAnswer('Orders go out [E20, E21]. Then [E20,E21] and [E3–E5], or [E3-E4]; also [E30 , E21].', doc, table)
    expect(r.text).toBe('Orders go out [E20] [E21]. Then [E20] [E21] and [E3] [E4] [E5], or [E3] [E4]; also [E30] [E21].')
    expect(r.evidence).toEqual([ev(20), ev(21), ev(3), ev(4), ev(5), ev(30)])
    expect(r.uncited).toBe(false)
    expect(r.sentences.map((x) => x.text)).toEqual(['Orders go out [E20] [E21].', 'Then [E20] [E21] and [E3] [E4] [E5], or [E3] [E4]; also [E30] [E21].'])
    // A range runs low to high, at most 12 labels: anything else is left as the model wrote it
    expect(parseAnswer('x [E5–E3] y [E1-E40]', doc, table).text).toBe('x [E5–E3] y [E1-E40]')
    // ...and so is a group that mixes evidence and steps, or chains two dashes
    expect(parseAnswer('m [E1, A2] n [E1-A3] o [E1-E2-E3]', doc, table).text).toBe('m [E1, A2] n [E1-A3] o [E1-E2-E3]')
    // Not a citation: other bracketed text stays
    expect(parseAnswer('a [E1, x] b [A1, A2]', doc, table).text).toBe('a [E1, x] b')
  })

  it('accepts bare numeric label keys too', () => {
    const e: Evidence = { kind: 'commit', ref: 'abc' }
    expect(parseAnswer('x [E3]', doc, { '3': e }).evidence).toEqual([e])
  })

  it('two blocks → only the first used', () => {
    const raw = 'A\n' + block('[{"type":"reset"}]') + '\nB\n' + block(JSON.stringify([{ type: 'focus', ids: [bId] }]))
    const r = parseAnswer(raw, doc)
    expect(r.actions).toEqual([{ type: 'reset' }])
    expect(r.text).toBe('A\n\nB')
  })

  it('HTML in text is returned as-is but never parsed', () => {
    const r = parseAnswer('<img src=x onerror=alert(1)> <b>hi</b>\n' + block('[]'), doc)
    expect(r.text).toBe('<img src=x onerror=alert(1)> <b>hi</b>')
    expect(r.actions).toEqual([])
  })

  it('a truncated (unclosed) fence is stripped from text, with no actions and dropped 0', () => {
    const r = parseAnswer('Partial answer.\n```world-actions\n[{"type":"focus","ids":["' + bId, doc)
    expect(r).toEqual({ text: 'Partial answer.', sentences: [{ text: 'Partial answer.', actions: [], sep: '' }], actions: [], evidence: [], dropped: 0, unsupported: [], uncited: true })
    const both = parseAnswer(wrap([{ type: 'reset' }]) + '\nMore.\n```world-actions\n[{"ty', doc)
    expect(both.text).toBe('Answer text.\n\nMore.')
    expect(both.actions).toEqual([{ type: 'reset' }])
  })

  it('never throws on hostile input', () => {
    expect(parseAnswer(undefined as Any, doc)).toEqual({ text: '', sentences: [], actions: [], evidence: [], dropped: 0, unsupported: [], uncited: false })
    expect(parseAnswer(42 as Any, doc).text).toBe('')
    const bad = parseAnswer(wrap([{ type: 'focus', ids: [bId] }]), null as Any)
    expect(bad.actions).toEqual([])
    expect(bad.text).toBe('Answer text.')
    expect(bad.sentences).toEqual([{ text: 'Answer text.', actions: [], sep: '' }])
    expect(parseAnswer(block('[{"type":"reset"}]'), null as Any).sentences).toEqual([])
    expect(parseAnswer('x [E1]', doc, null as Any).evidence).toEqual([])
  })

  it('ANSWER_PROTOCOL carries the honesty rule and the fog step', () => {
    expect(ANSWER_PROTOCOL).toContain(HONESTY_RULE)
    expect(ANSWER_PROTOCOL).toContain('{"type":"fog","ids":[...]}')
  })

  it('a fog step keeps known ids, drops unknown ones and fills unsupported', () => {
    const a = parseAnswer('Nothing records why. [E1]\n```world-actions\n[{"type":"fog","ids":["' + bId + '","nope"]}]\n```', doc, labels)
    expect(a.actions).toEqual([{ type: 'fog', ids: [bId] }])
    expect(a.unsupported).toEqual([bId])
    expect(a.dropped).toBe(1)
  })

  it('a fog step with no known id is dropped whole; plain answers have nothing unsupported', () => {
    const a = parseAnswer('x [E1]\n```world-actions\n[{"type":"fog","ids":["nope"]}]\n```', doc, labels)
    expect(a.actions).toEqual([])
    expect(a.unsupported).toEqual([])
    expect(a.dropped).toBe(2)
  })

  it('an answer with no [E<n>] marker is uncited; empty text is not', () => {
    expect(parseAnswer('It is fast.', doc, labels).uncited).toBe(true)
    expect(parseAnswer('It is fast. [E1]', doc, labels).uncited).toBe(false)
    expect(parseAnswer('', doc, labels).uncited).toBe(false)
  })
})

describe('answer steps ([A<n>] markers)', () => {
  const two = [{ type: 'focus', ids: [bId] }, { type: 'flow', edgeIds: [eId] }]
  const fence = (steps: unknown): string => '\n' + block(JSON.stringify(steps))

  it('ANSWER_PROTOCOL tells the model to place [A<n>]', () => {
    expect(ANSWER_PROTOCOL).toContain('Put [A<n>] in your text where step n (1-based) should play.')
  })

  it('[A1] and [A2] markers attach steps to their sentences and are removed from the text', () => {
    const a = parseAnswer('Typing goes to the PTY host. [A1] It then reaches the agent. [A2]' + fence(two), doc, labels)
    expect(a.sentences).toEqual([{ text: 'Typing goes to the PTY host.', actions: [0], sep: '' }, { text: 'It then reaches the agent.', actions: [1], sep: ' ' }])
    expect(a.text).toBe('Typing goes to the PTY host. It then reaches the agent.')
    expect(a.dropped).toBe(0)
  })

  it('a numbered list marker opens its item instead of showing alone, and an indented line keeps its indent (fix wave M2)', () => {
    const a = parseAnswer('Two steps:\n1. Typing goes in. [A1]\n2. It reaches\n   the agent.\n\n3.' + fence(two), doc, labels)
    expect(a.sentences).toEqual([
      { text: 'Two steps:\n1. Typing goes in.', actions: [0], sep: '' },
      { text: '2. It reaches\n   the agent.', actions: [], sep: '\n' },
      // A marker alone at the end stays (step 2, placed nowhere, plays with the last sentence).
      { text: '3.', actions: [1], sep: '\n\n' }
    ])
    expect(answerText(a.sentences, 3)).toBe('Two steps:\n1. Typing goes in.\n2. It reaches\n   the agent.\n\n3.')
    // A list that opens the answer, and an item whose next line is indented.
    const b = parseAnswer('1. First item.\n   More of it.\n2. Second.', doc, labels)
    expect(b.sentences).toEqual([
      { text: '1. First item.', actions: [], sep: '' },
      { text: '   More of it.', actions: [], sep: '\n' },
      { text: '2. Second.', actions: [], sep: '\n' }
    ])
    expect(answerText(b.sentences, 3)).toBe('1. First item.\n   More of it.\n2. Second.')
    // A number that ends a sentence mid-line is a sentence like any other.
    expect(parseAnswer('I counted 2. Then 3.', doc, labels).sentences.map((s) => s.text)).toEqual(['I counted 2.', 'Then 3.'])
  })

  it('a marker before the full stop and a marker after an [E1] citation both stay in their sentence', () => {
    const a = parseAnswer('It starts here [A1]. Then it ends [E1] [A2].' + fence(two), doc, labels)
    expect(a.sentences.map((s) => s.actions)).toEqual([[0], [1]])
    expect(a.sentences[1].text).toBe('Then it ends [E1].')
  })

  it('an out-of-range [A9] is dropped and counted', () => {
    const a = parseAnswer('One. [A1] Two. [A9]' + fence(two), doc, labels)
    expect(a.sentences).toEqual([{ text: 'One.', actions: [0], sep: '' }, { text: 'Two.', actions: [1], sep: ' ' }])
    expect(a.dropped).toBe(1)
    expect(parseAnswer('Only. [A0]', doc, labels).dropped).toBe(1)
  })

  it('[A<n>] indexes the raw steps: a step dropped as invalid attaches nothing and is counted', () => {
    const steps = [{ type: 'focus', ids: ['nope'] }, { type: 'flow', edgeIds: [eId] }]
    const a = parseAnswer('First. [A1] Second. [A2]' + fence(steps), doc, labels)
    // Step 1 was dropped (1 for the id, 1 for the step), its marker is one more; step 2 is the only valid action.
    expect(a.actions).toEqual([{ type: 'flow', edgeIds: [eId] }])
    expect(a.sentences).toEqual([{ text: 'First.', actions: [], sep: '' }, { text: 'Second.', actions: [0], sep: ' ' }])
    expect(a.dropped).toBe(3)
  })

  it('a step no marker names plays with the last sentence; a repeated marker plays its step once', () => {
    const a = parseAnswer('One. [A1] Two.' + fence(two), doc, labels)
    expect(a.sentences).toEqual([{ text: 'One.', actions: [0], sep: '' }, { text: 'Two.', actions: [1], sep: ' ' }])
    const b = parseAnswer('One. [A1] Two. [A1]' + fence(two), doc, labels)
    expect(b.sentences).toEqual([{ text: 'One.', actions: [0], sep: '' }, { text: 'Two.', actions: [1], sep: ' ' }])
  })

  it('an answer that is only markers or only a block keeps its steps', () => {
    expect(parseAnswer('[A1]' + fence(two), doc, labels).sentences).toEqual([{ text: '', actions: [0, 1], sep: '' }])
    expect(parseAnswer(fence(two), doc, labels).sentences).toEqual([{ text: '', actions: [0, 1], sep: '' }])
    expect(parseAnswer('[A9]', doc, labels).sentences).toEqual([])
  })

  it('a decimal point does not end a sentence, and text without an end is one sentence', () => {
    expect(parseAnswer('It is v1.5 now! Really', doc, labels).sentences.map((s) => s.text)).toEqual(['It is v1.5 now!', 'Really'])
  })

  it('each sentence keeps the break in front of it, so paragraphs survive the reveal', () => {
    const a = parseAnswer('One. Two.\nThree.\n\nFour.\r\n\r\n  Five.', doc, labels)
    expect(a.sentences.map((s) => s.sep)).toEqual(['', ' ', '\n', '\n\n', '\n\n'])
    expect(answerText(a.sentences, a.sentences.length)).toBe('One. Two.\nThree.\n\nFour.\n\nFive.')
    expect(answerText(a.sentences, 2)).toBe('One. Two.')
    expect(sepOf('\n', true)).toBe('')
    expect(sepOf('\t', false)).toBe(' ')
  })

  it('revealMs: 70 ms a word, at least 600 ms, and 0 with reduced motion', () => {
    expect(REVEAL_MS_PER_WORD).toBe(70)
    expect(MIN_SENTENCE_MS).toBe(600)
    expect(revealMs('Short one.', false)).toBe(600)
    expect(revealMs('one two three four five six seven eight nine ten', false)).toBe(700)
    expect(revealMs('one two three four five six seven eight nine ten', true)).toBe(0)
  })
})
