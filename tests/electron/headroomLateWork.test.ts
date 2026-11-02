import { describe, it, expect, vi } from 'vitest'
import { realistic, editLoop, FIRST_MESSAGE } from './fixtures/lateGoldenCases'

/**
 * What the late policy asks the shared proxy child to DO, counted and not timed.
 *
 * headroomLateCost.test.ts bounds the time late takes against legacy's, and has to leave that bound wide
 * (late may not exceed 1.25 times legacy) so a loaded machine cannot fail it. A wide bound cannot see a
 * pass added to the late path that costs a fraction of what late saves: late runs at 0.15 to 0.9 of
 * legacy's time on these bodies, so an extra pass of up to roughly 40% of legacy's time would still pass.
 * A count has no such margin to hide in. Late only ever skips work legacy does (a result left whole is
 * not cut, not hashed for a stash, not cut again), so for the same body every count below must be no
 * more than legacy's, and the ones that do not depend on the policy must be equal:
 *
 *   armOf ............... once per request, under both: it names the conversation whatever the policy
 *   effectiveFloor ...... once per result that gets as far as a floor, under both
 *   SHA-1 updates ....... late no more than legacy; characters hashed, the same
 *   JSON.parse .......... one parse of the whole body, under both (headroomLateCost holds that too)
 *
 * A hidden extra pass over the text would show as a count that goes up. Nothing here reads a clock.
 */

const work = vi.hoisted(() => ({ armOf: 0, effectiveFloor: 0, hashes: 0, hashedChars: 0 }))

vi.mock('../../src/main/headroom/elisionPolicy', async () => {
  const real = await vi.importActual<typeof import('../../src/main/headroom/elisionPolicy')>('../../src/main/headroom/elisionPolicy')
  return {
    ...real,
    armOf: (...a: Parameters<typeof real.armOf>): ReturnType<typeof real.armOf> => { work.armOf++; return real.armOf(...a) },
    effectiveFloor: (...a: Parameters<typeof real.effectiveFloor>): ReturnType<typeof real.effectiveFloor> => { work.effectiveFloor++; return real.effectiveFloor(...a) },
  }
})

vi.mock('crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('crypto')>()
  const createHash = (...args: Parameters<typeof real.createHash>): ReturnType<typeof real.createHash> => {
    const h = real.createHash(...args)
    const update = h.update.bind(h) as (data: unknown, enc?: unknown) => typeof h
    h.update = ((data: string | Buffer, enc?: never) => {
      work.hashes++
      work.hashedChars += data.length
      return update(data, enc)
    }) as typeof h.update
    return h
  }
  return { ...real, default: { ...real, createHash }, createHash }
})

const WIRE = '../../src/main/headroomProxy/wireCompress'
interface Wire {
  rewriteMessagesBody: (raw: string) => { body: string; changed: boolean; stats: { arm: string }; stashes: Array<{ original: string }> }
}

interface Counted { armOf: number; effectiveFloor: number; hashes: number; hashedChars: number; parses: number; arm: string; changed: boolean }

/** One rewrite of `raw` under `policy`, in a fresh module, with every counter read for that rewrite only. */
async function counted(policy: 'late' | 'legacy', raw: string): Promise<Counted> {
  vi.resetModules()
  const m = (await import(WIRE)) as unknown as Wire & { setWireWindow: (w: unknown) => void; windowForMode: (m: string) => unknown; setFirstSightPolicy: (p: string) => void }
  m.setWireWindow(m.windowForMode('aggressive'))
  m.setFirstSightPolicy(policy)
  work.armOf = 0; work.effectiveFloor = 0; work.hashes = 0; work.hashedChars = 0
  const parse = vi.spyOn(JSON, 'parse')
  try {
    const r = m.rewriteMessagesBody(raw)
    return { armOf: work.armOf, effectiveFloor: work.effectiveFloor, hashes: work.hashes, hashedChars: work.hashedChars, parses: parse.mock.calls.length, arm: r.stats.arm, changed: r.changed }
  } finally { parse.mockRestore() }
}

const TOOLS = ['Read', 'Bash', 'Grep', 'Glob', 'PowerShell', 'WebFetch']
const SIZES = [700, 1_800, 3_000, 6_000, 12_000, 25_000, 38_000, 45_000, 90_000]
/** Distinct text of exactly `chars` characters, so nothing in a body collapses as a repeat. */
function textOf(i: number, chars: number): string {
  return Array.from({ length: Math.ceil(chars / 25) }, (_, k) => `r${i}-line ${k}: payload ${(k * 7919 + i * 104729) % 100003}`).join('\n').slice(0, chars)
}
/** `pairs` tool calls with results across every size band, after the first message the fixtures use. */
function bands(pairs: number): string {
  const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: FIRST_MESSAGE }]
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: TOOLS[i % TOOLS.length], input: { n: i } }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: textOf(i, SIZES[i % SIZES.length]) }] })
  }
  return JSON.stringify({ model: 'claude-opus-5-5', system: 'You are a coding agent.', messages })
}

const BODIES: ReadonlyArray<readonly [string, () => string]> = [
  ['results across every size band', () => bands(40)],
  ['a realistic session', () => realistic(FIRST_MESSAGE)],
  ['an edit loop of near-repeats', () => editLoop(FIRST_MESSAGE)],
]

describe('the late path does no more than the legacy path, counted', () => {
  it.each(BODIES)('on %s: the same naming and floor lookups, and no more hashing', async (_name, make) => {
    const raw = make()
    const legacy = await counted('legacy', raw)
    const late = await counted('late', raw)
    // The test is about the Late arm: a body that fell in the holdout would run Legacy inside Late and prove nothing.
    expect(late.arm).toBe('late')
    expect(legacy.arm).toBe('legacy')
    expect(late.armOf).toBe(1)
    expect(legacy.armOf).toBe(1)
    expect(late.effectiveFloor).toBe(legacy.effectiveFloor)
    expect(late.effectiveFloor).toBeGreaterThan(0)
    expect(late.hashes).toBeLessThanOrEqual(legacy.hashes)
    expect(late.hashedChars).toBeLessThanOrEqual(legacy.hashedChars)
    expect(late.parses).toBe(legacy.parses)
    expect(late.parses).toBe(1)
  })

  it('and on the band body late really skips work: it hashes strictly less, because results under the floor are left whole', async () => {
    const raw = bands(40)
    const legacy = await counted('legacy', raw)
    const late = await counted('late', raw)
    expect(late.hashedChars).toBeLessThan(legacy.hashedChars)
    expect(late.hashes).toBeLessThan(legacy.hashes)
  })

  it('the counters see work when there is some: a pass added to the path would raise them (the guard is not vacuous)', async () => {
    const raw = bands(12)
    const once = await counted('late', raw)
    // The same body twice in one request is more to do: more floor lookups and more hashing.
    const doubled = JSON.parse(raw) as { messages: unknown[] }
    doubled.messages = [...doubled.messages, ...doubled.messages.slice(1)]
    const twice = await counted('late', JSON.stringify(doubled))
    expect(twice.effectiveFloor).toBeGreaterThan(once.effectiveFloor)
    expect(twice.hashedChars).toBeGreaterThan(once.hashedChars)
    expect(twice.armOf).toBe(1)
  })
})
