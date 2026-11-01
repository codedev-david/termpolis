import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  TOOLS, KINDS, SIZES, FLOOR, FIRST_MESSAGE, singleCases, conversationCases, caseBody, type Outcome,
} from './fixtures/lateGoldenCases'

/**
 * The compression policy against what Termpolis v1.54.4 forwarded.
 *
 * fixtures/lateGoldens.json was generated from the v1.54.4 source (942f2177), not from this tree: for
 * every tool x content kind x size, and for a set of whole conversations, it holds a hash of the
 * request body that implementation forwarded. Two things are held against it:
 *
 *  - LEGACY (the Settings kill switch, and the holdout arm) forwards exactly those bytes.
 *  - LATE forwards exactly those bytes too, for every tool result of 40,000 characters or more,
 *    and forwards a smaller tool result whole.
 */

interface GoldenFile { firstMessage: string; single: Record<string, Outcome>; conversations: Record<string, Outcome> }
const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'lateGoldens.json'), 'utf8')) as GoldenFile

const WIRE = '../../src/main/headroomProxy/wireCompress'

interface Rewritten {
  body: string
  changed: boolean
  stashes: Array<{ token: string }>
  stats: { kinds: { plain: number; compact: number; dedup: number; diff: number; aged: number } }
}
interface Wire {
  rewriteMessagesBody: (raw: string, opts?: { decay?: boolean }) => Rewritten
}

/** A fresh module is a fresh launch: the compaction floor and the policy are resolved once per process. */
async function launch(mode: string, policy?: 'late' | 'legacy'): Promise<Wire> {
  vi.resetModules()
  const m = await import(WIRE)
  m.setWireWindow(m.windowForMode(mode))
  if (policy) m.setFirstSightPolicy(policy)
  return m as Wire
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

function outcome(r: { body: string; changed: boolean; stashes: Array<{ token: string }> }): Outcome {
  return { body: sha(r.body), length: r.body.length, changed: r.changed, stashes: r.stashes.length, tokens: sha(r.stashes.map((s) => s.token).join(',')) }
}

describe('the goldens', () => {
  it('cover every tool, kind and size, and every conversation, and were made for the first message the cases use', () => {
    expect(golden.firstMessage).toBe(FIRST_MESSAGE)
    expect(Object.keys(golden.single).sort()).toEqual(singleCases().map((c) => c.id).sort())
    expect(Object.keys(golden.conversations).sort()).toEqual(conversationCases().map((c) => c.id).sort())
    expect(singleCases().length).toBe(TOOLS.length * KINDS.length * SIZES.length + KINDS.length * SIZES.length)
  })
})

describe.each([
  ['with no policy pushed (the default of a module nothing has configured)', undefined],
  ['under the legacy policy (the Settings kill switch)', 'legacy' as const],
])('legacy is v1.54.4, byte for byte, %s', (_name, policy) => {
  it.each(TOOLS)('%s: every kind and size forwards what v1.54.4 forwarded', async (tool) => {
    const m = await launch('aggressive', policy)
    const cases = singleCases().filter((c) => c.tool === tool)
    expect(cases.length).toBeGreaterThan(KINDS.length * SIZES.length - 1)
    for (const c of cases) {
      expect(outcome(m.rewriteMessagesBody(caseBody(c.tool, c.kind, c.chars, c.shape))), c.id).toEqual(golden.single[c.id])
    }
  })

  it.each(conversationCases().map((c) => [c.id, c] as const))('conversation %s forwards what v1.54.4 forwarded', async (_id, c) => {
    const m = await launch(c.mode, policy)
    expect(outcome(m.rewriteMessagesBody(c.body, { decay: c.decay })), c.id).toEqual(golden.conversations[c.id])
  })
})

describe('late: nothing under 40,000 characters is shortened at first sight', () => {
  it.each(TOOLS)('%s: every kind and every size under the floor goes through whole, stashing nothing', async (tool) => {
    const m = await launch('aggressive', 'late')
    const cases = singleCases().filter((c) => c.tool === tool && c.chars < FLOOR)
    expect(cases.length).toBeGreaterThanOrEqual(KINDS.length * 4)
    for (const c of cases) {
      const raw = caseBody(c.tool, c.kind, c.chars, c.shape)
      const r = m.rewriteMessagesBody(raw)
      expect(r.changed, c.id).toBe(false)
      expect(r.body, c.id).toBe(raw)
      expect(r.stashes, c.id).toHaveLength(0)
      expect(r.stats.kinds, c.id).toMatchObject({ plain: 1, compact: 0, dedup: 0, diff: 0, aged: 0 })
    }
  })

  it.each(TOOLS)('%s: from 40,000 characters up it forwards exactly what v1.54.4 forwarded', async (tool) => {
    const m = await launch('aggressive', 'late')
    const cases = singleCases().filter((c) => c.tool === tool && c.chars >= FLOOR)
    expect(cases.length).toBeGreaterThanOrEqual(KINDS.length * 3)
    for (const c of cases) {
      const r = m.rewriteMessagesBody(caseBody(c.tool, c.kind, c.chars, c.shape))
      expect(r.changed, c.id).toBe(true)
      expect(outcome(r), c.id).toEqual(golden.single[c.id])
    }
  })

  it('keeps the edge exactly where the floor is: 39,999 whole, 40,000 shortened', async () => {
    const m = await launch('aggressive', 'late')
    expect(m.rewriteMessagesBody(caseBody('Read', 'code', 39_999)).changed).toBe(false)
    expect(m.rewriteMessagesBody(caseBody('Read', 'code', 40_000)).changed).toBe(true)
  })

  it('holds at every tier: the floor in force is the larger of the tier and the policy, so Maximum does not reach under it', async () => {
    for (const mode of ['conservative', 'balanced', 'aggressive', 'max']) {
      const m = await launch(mode, 'late')
      expect(m.rewriteMessagesBody(caseBody('Bash', 'log', 20_000)).changed, mode).toBe(false)
      expect(m.rewriteMessagesBody(caseBody('Bash', 'log', 1_600)).changed, mode).toBe(false)
    }
  })
})
