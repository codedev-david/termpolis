import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The first-sight floor can differ by model (policyFor takes the body's `model`), and the table of
 * per-model floors is empty today. With nothing in it, nothing could notice the rewriter dropping the
 * model on the way to policyFor, and the first floor anyone puts in the table (a Sonnet floor lower
 * than Opus's, the remedy the economics review proposed) would silently do nothing. So the table is
 * filled here, for one made-up model, by wrapping policyFor, and the rewriter is run on whole bodies.
 */
vi.mock('../../src/main/headroom/elisionPolicy', async () => {
  const real = await vi.importActual<typeof import('../../src/main/headroom/elisionPolicy')>('../../src/main/headroom/elisionPolicy')
  return {
    ...real,
    policyFor: (kind: Parameters<typeof real.policyFor>[0], model?: unknown, overrides?: Parameters<typeof real.policyFor>[2]): ReturnType<typeof real.policyFor> =>
      real.policyFor(kind, model, overrides ?? { byModel: { 'claude-x': 10_000 } }),
  }
})

const WIRE = '../../src/main/headroomProxy/wireCompress'
type Wire = typeof import('../../src/main/headroomProxy/wireCompress')

const FIRST = 'Look at the output of that last command and tell me what stands out.'

/** One tool result of about `chars` characters, in a conversation addressed to `model`. */
function body(model: string | undefined, chars: number): string {
  const text = Array.from({ length: Math.ceil(chars / 60) }, (_, i) => `build step ${i}: compiled module ${i * 7} in ${i * 13} ms with 0 errors`).join('\n').slice(0, chars)
  const o: Record<string, unknown> = {
    messages: [
      { role: 'user', content: FIRST },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_0', name: 'Bash', input: { command: 'cat build.log' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: text }] },
    ],
  }
  if (model !== undefined) o.model = model
  return JSON.stringify(o)
}

let wire: Wire
beforeEach(async () => {
  vi.resetModules()
  wire = (await import(WIRE)) as Wire
  wire.setWireWindow(wire.windowForMode('aggressive'))
  wire.setFirstSightPolicy('late')
})

describe('a per-model first-sight floor reaches the rewriter', () => {
  it('shortens a result of 15,000 characters for the model whose floor is 10,000, in a conversation on the Late arm', () => {
    const r = wire.rewriteMessagesBody(body('claude-x', 15_000))
    expect(r.stats.arm).toBe('late') // not the holdout, which runs the old behaviour whatever the model
    expect(r.changed).toBe(true)
    expect(r.stats.kinds.compact).toBe(1)
    expect(r.stashes).toHaveLength(1)
    expect(r.stashes[0].original.length).toBe(15_000)
  })

  it('leaves the same result whole for any other model, and for a body that names none', () => {
    for (const model of ['claude-y', 'claude-x-2', 'CLAUDE-X', '', undefined]) {
      const r = wire.rewriteMessagesBody(body(model, 15_000))
      expect(r.stats.arm, String(model)).toBe('late')
      expect([String(model), r.changed]).toEqual([String(model), false])
      expect(r.stashes).toHaveLength(0)
    }
  })

  it('still leaves a result under the model floor whole, and shortens one over the default floor for any model', () => {
    expect(wire.rewriteMessagesBody(body('claude-x', 9_000)).changed).toBe(false)
    expect(wire.rewriteMessagesBody(body('claude-y', 45_000)).changed).toBe(true)
  })

  it('is a pure function of the body: a second send of it is byte for byte the first', () => {
    const b = body('claude-x', 15_000)
    const first = wire.rewriteMessagesBody(b)
    const second = wire.rewriteMessagesBody(b)
    expect(second.body).toBe(first.body)
    expect(second.stashes.map((s) => s.token)).toEqual(first.stashes.map((s) => s.token))
  })

  it('does not reach the legacy policy: the kill switch shortens by the tier alone, whatever the model', async () => {
    vi.resetModules()
    const legacy = (await import(WIRE)) as Wire
    legacy.setWireWindow(legacy.windowForMode('aggressive'))
    legacy.setFirstSightPolicy('legacy')
    for (const model of ['claude-x', 'claude-y']) expect(legacy.rewriteMessagesBody(body(model, 15_000)).changed, model).toBe(true)
  })
})
