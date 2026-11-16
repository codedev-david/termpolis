import { describe, it, expect } from 'vitest'
import { ANSWER_PROTOCOL, parseAnswer } from '../../src/shared/world/answerProtocol'
import type { Evidence } from '../../src/shared/world/types'
import minDoc from './fixtures/world.min.json'

type Any = any
const doc: Any = minDoc
const bId: string = doc.buildings[0].id
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
    expect(r).toEqual({ text: 'Just prose.', actions: [], evidence: [], dropped: 0 })
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
    expect(r).toEqual({ text: 'Partial answer.', actions: [], evidence: [], dropped: 0 })
    const both = parseAnswer(wrap([{ type: 'reset' }]) + '\nMore.\n```world-actions\n[{"ty', doc)
    expect(both.text).toBe('Answer text.\n\nMore.')
    expect(both.actions).toEqual([{ type: 'reset' }])
  })

  it('never throws on hostile input', () => {
    expect(parseAnswer(undefined as Any, doc)).toEqual({ text: '', actions: [], evidence: [], dropped: 0 })
    expect(parseAnswer(42 as Any, doc).text).toBe('')
    const bad = parseAnswer(wrap([{ type: 'focus', ids: [bId] }]), null as Any)
    expect(bad.actions).toEqual([])
    expect(bad.text).toBe('Answer text.')
    expect(parseAnswer('x [E1]', doc, null as Any).evidence).toEqual([])
  })
})
