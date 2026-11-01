import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  TOOLS, KINDS, SIZES, FIRST_MESSAGE, singleCases, conversationCases, caseBody, type Outcome,
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

interface Wire {
  rewriteMessagesBody: (raw: string, opts?: { decay?: boolean }) => { body: string; changed: boolean; stashes: Array<{ token: string }> }
}

/** A fresh module is a fresh launch: the compaction floor is resolved once per process. */
async function launch(mode: string): Promise<Wire> {
  vi.resetModules()
  const m = await import(WIRE)
  m.setWireWindow(m.windowForMode(mode))
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

describe('legacy is v1.54.4, byte for byte', () => {
  it.each(TOOLS)('%s: every kind and size forwards what v1.54.4 forwarded', async (tool) => {
    const m = await launch('aggressive')
    const cases = singleCases().filter((c) => c.tool === tool)
    expect(cases.length).toBeGreaterThan(KINDS.length * SIZES.length - 1)
    for (const c of cases) {
      expect(outcome(m.rewriteMessagesBody(caseBody(c.tool, c.kind, c.chars, c.shape))), c.id).toEqual(golden.single[c.id])
    }
  })

  it.each(conversationCases().map((c) => [c.id, c] as const))('conversation %s forwards what v1.54.4 forwarded', async (_id, c) => {
    const m = await launch(c.mode)
    expect(outcome(m.rewriteMessagesBody(c.body, { decay: c.decay })), c.id).toEqual(golden.conversations[c.id])
  })
})
