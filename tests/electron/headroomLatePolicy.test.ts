import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  FLOOR, FIRST_MESSAGE, conversationCases, caseBody, longRun, realistic, editLoop,
} from './fixtures/lateGoldenCases'
import { armForBody, armOf, ARM_CLUSTERS } from '../../src/main/headroom/elisionPolicy'
import { ccrPut, resetCcr } from '../../src/main/headroom/ccrStore'
import { retrieveFull } from '../../src/main/headroom/compressToolResult'
import { armState, resetArmLedger } from '../../src/main/headroom/armLedger'
import { recordProxyResult } from '../../src/main/headroomProxy/proxyLedger'
import type { ProxyResultMsg } from '../../src/main/headroomProxy/proxySupervisor'

/**
 * The late policy as a property of whole requests: what the model is shown, whether the cached
 * prefix holds still, that it is the same every time, how it ages, how it is frozen and how a
 * conversation is assigned to an arm. The byte-for-byte comparisons against v1.54.4 are in
 * headroomLateGoldens.test.ts.
 */

const WIRE = '../../src/main/headroomProxy/wireCompress'

interface Rewritten {
  body: string
  changed: boolean
  stashes: Array<{ token: string; original: string; meta?: { kind: string; tool?: string; chars: number; view: number; policy?: string } }>
  stats: { arm: string; armCluster: number; convKey: number; kinds: Record<string, number>; trOrigChars: number; trCompChars: number }
}
interface Wire {
  rewriteMessagesBody: (raw: string, opts?: { decay?: boolean }) => Rewritten
  setFirstSightPolicy: (v: unknown) => void
  getFirstSightPolicy: () => string
  compactToolText: (text: string, hint?: { toolName?: string; path?: string }, policy?: unknown) => { text: string; stash?: unknown }
  setWireWindow: (w: unknown) => void
  windowForMode: (m: string) => unknown
}

async function launch(policy?: unknown, mode = 'aggressive'): Promise<Wire> {
  vi.resetModules()
  const m = (await import(WIRE)) as unknown as Wire
  m.setWireWindow(m.windowForMode(mode))
  if (policy !== undefined) m.setFirstSightPolicy(policy)
  return m
}

type Msg = { role: string; content: unknown }
const parse = (body: string): { messages: Msg[] } => JSON.parse(body) as { messages: Msg[] }
const slice = (body: string, n: number): string => JSON.stringify({ ...parse(body), messages: parse(body).messages.slice(0, n) })

/** Every tool_result text of a body, in order. */
function resultTexts(body: string): string[] {
  const out: string[] = []
  for (const m of parse(body).messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content as Array<{ type?: string; content?: unknown }>) {
      if (b?.type !== 'tool_result') continue
      if (typeof b.content === 'string') out.push(b.content)
      else if (Array.isArray(b.content)) for (const it of b.content as Array<{ type?: string; text?: unknown }>) if (it?.type === 'text' && typeof it.text === 'string') out.push(it.text)
    }
  }
  return out
}

const CYCLE_SIZES = [700, 2_000, 5_000, 12_000, 30_000, 45_000, 90_000]

/**
 * `pairs` tool calls whose results share no line with each other, so nothing collapses as a repeat
 * or a near repeat and every result is judged on its own. Exactly the sizes in CYCLE_SIZES, cycling.
 */
function distinctRun(first: string, pairs: number): string {
  const messages: Msg[] = [{ role: 'user', content: first }]
  for (let k = 0; k < pairs; k++) {
    const size = CYCLE_SIZES[k % CYCLE_SIZES.length]
    // Lines are 30 to 40 characters, so size / 25 of them always cover the size before the cut.
    const text = Array.from({ length: Math.ceil(size / 25) }, (_, i) => `r${k}-line ${i}: payload ${(i * 7919 + k * 104729) % 100003}`).join('\n').slice(0, size)
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `d${k}`, name: k % 2 ? 'Bash' : 'Read', input: k % 2 ? { command: `step ${k}` } : { file_path: `/repo/f${k}.log` } }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `d${k}`, content: text }] })
  }
  return JSON.stringify({ model: 'claude-opus-4', max_tokens: 1024, messages })
}

const isDedup = (t: string): boolean => t.startsWith('[headroom] Identical to an earlier tool result in this conversation — call')
const isDiff = (t: string): boolean => t.startsWith('[headroom] Identical to an earlier tool result in this conversation except')
const isAged = (t: string): boolean => t.startsWith("[headroom] Aged out of this conversation's active context")
const isWindow = (t: string): boolean => t.includes('[headroom] Full result cached') && !isDiff(t)

describe('late never shows the model less than v1.54.4 did', () => {
  it.each(conversationCases().map((c) => [c.id, c] as const))('conversation %s: block by block, late forwards at least what legacy forwarded', async (_id, c) => {
    const legacy = await launch('legacy', c.mode)
    const leg = legacy.rewriteMessagesBody(c.body, { decay: c.decay })
    const late = await launch('late', c.mode)
    const lat = late.rewriteMessagesBody(c.body, { decay: c.decay })
    const orig = resultTexts(c.body)
    const lt = resultTexts(lat.body)
    const gt = resultTexts(leg.body)
    expect(lt).toHaveLength(orig.length)
    expect(gt).toHaveLength(orig.length)
    for (let i = 0; i < orig.length; i++) {
      expect(lt[i].length, `block ${i}`).toBeGreaterThanOrEqual(gt[i].length)
      if (orig[i].length < FLOOR) {
        // Under the floor the model gets the result, or a reference to an identical one it has
        // already been shown, or a patch against one, or (in a long conversation) the aged-out stub.
        // Never a head-and-tail window.
        const whole = lt[i] === orig[i]
        expect(whole || isDedup(lt[i]) || isDiff(lt[i]) || isAged(lt[i]), `block ${i} is ${lt[i].slice(0, 60)}`).toBe(true)
        expect(isWindow(lt[i]), `block ${i}`).toBe(false)
      }
    }
    // And in total.
    expect(lt.reduce((n, t) => n + t.length, 0)).toBeGreaterThanOrEqual(gt.reduce((n, t) => n + t.length, 0))
  })

  it('a block at or above the floor is the same text under both, window and footer included', async () => {
    const body = distinctRun(FIRST_MESSAGE, 14) // sizes 700 .. 90,000, four of them at 45,000 or more
    const lat = (await launch('late')).rewriteMessagesBody(body)
    const leg = (await launch('legacy')).rewriteMessagesBody(body)
    const orig = resultTexts(body)
    const lt = resultTexts(lat.body)
    const gt = resultTexts(leg.body)
    let big = 0
    for (let i = 0; i < orig.length; i++) {
      if (orig[i].length >= FLOOR) { big++; expect(lt[i]).toBe(gt[i]); expect(isWindow(lt[i])).toBe(true) }
      else { expect(lt[i]).toBe(orig[i]) }
    }
    expect(big).toBeGreaterThanOrEqual(4)
  })

  it('still collapses an exact repeat and patches a near repeat of a result under the floor, as the old policy did', async () => {
    const body = realistic(FIRST_MESSAGE)
    const lat = (await launch('late')).rewriteMessagesBody(body)
    const lt = resultTexts(lat.body)
    expect(lt.filter(isDedup).length).toBeGreaterThanOrEqual(1) // r5 reads b.ts again
    expect(lt.filter(isDiff).length).toBeGreaterThanOrEqual(1) // r4 reads the edited a.ts
    // The first sight of each is whole.
    const orig = resultTexts(body)
    expect(lt[0]).toBe(orig[0])
  })

  it('prefers a patch to the whole when a near repeat is under the floor, which the old policy replaced with a window', async () => {
    const body = editLoop(FIRST_MESSAGE)
    const lt = resultTexts((await launch('late')).rewriteMessagesBody(body).body)
    const gt = resultTexts((await launch('legacy')).rewriteMessagesBody(body).body)
    const orig = resultTexts(body)
    const last = orig.length - 1 // mid.ts, edited in forty lines
    expect(isDiff(lt[last])).toBe(true)
    expect(lt[last].length).toBeLessThan(orig[last].length)
    expect(isDiff(gt[last])).toBe(false)
    expect(lt[last].length).toBeGreaterThan(gt[last].length)
  })
})

/**
 * What Settings says the Aggressiveness setting still does under Late: "it decides how hard a result of 40,000
 * characters or more is cut, and the size from which a repeat becomes a reference and a near-repeat a patch".
 * An earlier version of that sentence said "only" the first, and it was wrong: a repeat is judged against the
 * tier's own floor, not Late's, so the note is held to the rewriter here and the pane test holds the note.
 */
describe('under Late the tier still sets where a repeat collapses and how hard a big result is cut', () => {
  const MODES = ['conservative', 'balanced', 'aggressive', 'max'] as const
  const floorOf = (m: Wire, mode: string): number => (m.windowForMode(mode) as { floorChars: number }).floorChars
  // The edit keeps the length (and so the cut at `size`) the same, or the last line would differ and the patch would span the tail.
  const lines = (size: number, edit = false): string => Array.from({ length: Math.ceil(size / 25) }, (_, i) => `${edit && (i === 40 || i === 41) ? 'EDITED-line' : 'repeat-line'} ${i}: payload ${(i * 7919) % 100003}`).join('\n').slice(0, size)
  /** The same Bash result twice, in the order a model re-runs a command. */
  const twice = (first: string, second: string): string => JSON.stringify({
    model: 'claude-opus-4', max_tokens: 1024,
    messages: [
      { role: 'user', content: FIRST_MESSAGE },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Bash', input: { command: 'make' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: first }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a2', name: 'Bash', input: { command: 'make' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a2', content: second }] },
    ],
  })

  it('sends a repeat of 3,000 characters whole on a tier whose floor is above that and as a reference on one whose floor is below, first sight whole on both', async () => {
    const text = lines(3_000)
    const collapsed: boolean[] = []
    for (const mode of MODES) {
      const m = await launch('late', mode)
      const out = resultTexts(m.rewriteMessagesBody(twice(text, text)).body)
      expect(out, mode).toHaveLength(2)
      expect(out[0], `${mode}: first sight`).toBe(text)
      collapsed.push(isDedup(out[1]))
      expect(isDedup(out[1]), `${mode}: floor ${floorOf(m, mode)}`).toBe(floorOf(m, mode) <= text.length)
      if (!isDedup(out[1])) expect(out[1], mode).toBe(text)
    }
    // Both outcomes occur, or this says nothing about the tier.
    expect(collapsed).toContain(true)
    expect(collapsed).toContain(false)
  })

  it('collapses a repeat of 10,000 characters on every tier, which is above the highest floor', async () => {
    const text = lines(10_000)
    for (const mode of MODES) {
      const m = await launch('late', mode)
      expect(floorOf(m, mode), mode).toBeLessThan(text.length)
      expect(isDedup(resultTexts(m.rewriteMessagesBody(twice(text, text)).body)[1]), mode).toBe(true)
    }
  })

  it('sends a near-repeat of 3,000 characters as a patch on a tier whose floor is below that, and whole on one whose floor is above', async () => {
    const first = lines(3_000)
    const second = lines(3_000, true)
    expect(second).not.toBe(first)
    const patched: boolean[] = []
    for (const mode of MODES) {
      const m = await launch('late', mode)
      const out = resultTexts(m.rewriteMessagesBody(twice(first, second)).body)
      expect(out[0], `${mode}: first sight`).toBe(first)
      patched.push(isDiff(out[1]))
      expect(isDiff(out[1]), `${mode}: floor ${floorOf(m, mode)}`).toBe(floorOf(m, mode) <= first.length)
      if (!isDiff(out[1])) expect(out[1], mode).toBe(second)
    }
    expect(patched).toContain(true)
    expect(patched).toContain(false)
  })

  it('cuts a 80,000 character result harder on the Maximum tier than on the Conservative one', async () => {
    const raw = caseBody('Read', 'code', 80_000)
    const size: Record<string, number> = {}
    for (const mode of MODES) {
      const m = await launch('late', mode)
      const [out] = resultTexts(m.rewriteMessagesBody(raw).body)
      expect(isWindow(out), mode).toBe(true)
      size[mode] = out.length
    }
    expect(new Set(Object.values(size)).size).toBeGreaterThan(1)
    expect(size.max).toBeLessThan(size.conservative)
  })
})

describe('late keeps the cached prefix still as a conversation grows', () => {
  const body = realistic(FIRST_MESSAGE)
  const long = longRun(FIRST_MESSAGE, 80)
  const messagesOf = (r: Rewritten): unknown[] => parse(r.body).messages

  it.each([
    ['a conversation with repeats and near repeats', body, [2, 5, 9, 12]],
    ['a long run across every size band', long, [3, 20, 61, 100]],
  ] as const)('%s: the compressed prefix is byte-identical for every append of one to ten messages', async (_name, source, starts) => {
    const m = await launch('late')
    for (const n of starts) {
      const before = JSON.stringify(messagesOf(m.rewriteMessagesBody(slice(source, n))))
      for (let k = 1; k <= 10; k++) {
        const after = messagesOf(m.rewriteMessagesBody(slice(source, n + k)))
        expect(JSON.stringify(after.slice(0, n)), `n=${n} k=${k}`).toBe(before)
      }
    }
  })

  it('holds with decay on, up to the message before the first boundary', async () => {
    const m = await launch('late')
    for (const n of [10, 60, 117]) {
      const before = JSON.stringify(messagesOf(m.rewriteMessagesBody(slice(long, n), { decay: true })))
      for (let k = 1; k <= 10; k++) {
        const after = messagesOf(m.rewriteMessagesBody(slice(long, n + k), { decay: true }))
        expect(JSON.stringify(after.slice(0, n)), `n=${n} k=${k}`).toBe(before)
      }
    }
    // 33 rewrites of a conversation that long take 7 s on a quiet machine, 15 s under coverage: a budget of its own, as the
    // heavy tests beside it have, so a busy machine does not fail it on the default 30 s.
  }, 120_000)

  it('across the decay boundary (127 to 128 messages) only the messages before the cutoff change, and nothing after', async () => {
    const m = await launch('late')
    const distinct = distinctRun(FIRST_MESSAGE, 70)
    const at127 = messagesOf(m.rewriteMessagesBody(slice(distinct, 127), { decay: true }))
    const at128 = messagesOf(m.rewriteMessagesBody(slice(distinct, 128), { decay: true }))
    const cutoff = 64 // DECAY_FIRST_THRESHOLD / 2
    for (let i = cutoff; i < 127; i++) expect(JSON.stringify(at128[i]), `message ${i}`).toBe(JSON.stringify(at127[i]))
    let changed = 0
    for (let i = 0; i < cutoff; i++) if (JSON.stringify(at128[i]) !== JSON.stringify(at127[i])) changed++
    expect(changed).toBeGreaterThan(10) // the boundary does cut, and only there
  })

  it('and the next boundary (255 to 256) the same', async () => {
    const m = await launch('late')
    const huge = distinctRun(FIRST_MESSAGE, 130)
    const at255 = messagesOf(m.rewriteMessagesBody(slice(huge, 255), { decay: true }))
    const at256 = messagesOf(m.rewriteMessagesBody(slice(huge, 256), { decay: true }))
    for (let i = 128; i < 255; i++) expect(JSON.stringify(at256[i]), `message ${i}`).toBe(JSON.stringify(at255[i]))
  })

  it('past the cutoff only a result that pointed at an aged-out one can change at the boundary, as under the old policy', async () => {
    // A repeat is encoded against an earlier result that is on the wire; once that result has aged
    // out the repeat has nothing to point at and is encoded afresh. That is the existing design (the
    // decay pass runs before the dedup index is built), and it is the only thing that may move.
    for (const policy of ['late', 'legacy'] as const) {
      const m = await launch(policy)
      const at127 = messagesOf(m.rewriteMessagesBody(slice(long, 127), { decay: true }))
      const at128 = messagesOf(m.rewriteMessagesBody(slice(long, 128), { decay: true }))
      let moved = 0
      for (let i = 64; i < 127; i++) {
        if (JSON.stringify(at128[i]) === JSON.stringify(at127[i])) continue
        moved++
        const was = resultTexts(JSON.stringify({ messages: [at127[i]] }))[0] ?? ''
        expect(isDedup(was) || isDiff(was), `${policy}: message ${i} was ${was.slice(0, 50)}`).toBe(true)
      }
      expect(moved).toBeGreaterThan(0) // the fixture does contain such a repeat
    }
  })

  it('gives a conversation the same arm on every turn, so the transform cannot change under the cache', async () => {
    // The arm is a function of the first message alone (pinned for 300 different ones in headroomElisionPolicy);
    // what is checked here is that nothing later in a growing conversation reaches the rewriter's choice of it.
    // Fourteen conversations at five depths each show that, and cost a seventh of what forty at nine did.
    const m = await launch('late')
    for (let c = 0; c < 14; c++) {
      const first = `${FIRST_MESSAGE} variant ${c}`
      const convo = longRun(first, 12)
      const arms = new Set<string>()
      for (let n = 1; n <= 25; n += 6) arms.add(m.rewriteMessagesBody(slice(convo, n)).stats.arm)
      expect(arms.size, first).toBe(1)
    }
  }, 120_000)

  it('does not move the prefix for a conversation in the holdout either', async () => {
    const m = await launch('late')
    let first = ''
    for (let i = 0; i < 400 && !first; i++) if (armForBody({ messages: [{ role: 'user', content: `${FIRST_MESSAGE} h${i}` }] }) === 'holdout') first = `${FIRST_MESSAGE} h${i}`
    expect(first).not.toBe('')
    const convo = longRun(first, 30)
    expect(m.rewriteMessagesBody(slice(convo, 6)).stats.arm).toBe('holdout')
    const before = JSON.stringify(messagesOf(m.rewriteMessagesBody(slice(convo, 20))))
    for (let k = 1; k <= 10; k++) expect(JSON.stringify(messagesOf(m.rewriteMessagesBody(slice(convo, 20 + k))).slice(0, 20))).toBe(before)
  })
})

describe('late is deterministic and fails open', () => {
  it('gives the same bytes for the same body, twice in one process and again in a fresh one', async () => {
    for (const c of conversationCases().slice(0, 8)) {
      const m = await launch('late', c.mode)
      const a = m.rewriteMessagesBody(c.body, { decay: c.decay })
      const b = m.rewriteMessagesBody(c.body, { decay: c.decay })
      const fresh = (await launch('late', c.mode)).rewriteMessagesBody(c.body, { decay: c.decay })
      expect(b.body, c.id).toBe(a.body)
      expect(fresh.body, c.id).toBe(a.body)
      expect(b.stashes.map((s) => s.token), c.id).toEqual(a.stashes.map((s) => s.token))
    }
  })

  it('forwards a body that cannot round-trip untouched: an integer past 2^53, an unusual escape', async () => {
    const m = await launch('late')
    const big = caseBody('Read', 'code', 80_000)
    const bodies = [
      big.replace('"max_tokens":1024', '"max_tokens":9007199254740993'),
      big.replace('"model":"claude-opus-4"', '"model":"claude\\u002dopus-4"'),
      big.replace('{"model"', '{ "model"'),
    ]
    for (const raw of bodies) {
      expect(raw).not.toBe(big)
      const r = m.rewriteMessagesBody(raw)
      expect(r.changed).toBe(false)
      expect(r.body).toBe(raw)
      expect(r.stashes).toHaveLength(0)
      expect(r.stats.arm).toBe('none')
    }
  })

  it('forwards anything that is not a Messages request untouched', async () => {
    const m = await launch('late')
    for (const raw of ['', 'not json', '[]', '{}', '{"messages":5}', '{"messages":null}', 'null', '42']) {
      const r = m.rewriteMessagesBody(raw)
      expect(r.body).toBe(raw)
      expect(r.changed).toBe(false)
      expect(r.stats.arm).toBe('none')
    }
  })

  it('does not throw on a first message with nothing to hash, and stays on the default arm', async () => {
    const m = await launch('late')
    const raw = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }] })
    const r = m.rewriteMessagesBody(raw)
    expect(r.stats.arm).toBe('late')
    expect(r.stats.armCluster).toBe(0)
  })
})

describe('late and the aged-out half of a long conversation', () => {
  beforeEach(() => resetCcr())

  it('still ages results under the floor out at 128 messages, and every stub resolves to the exact original', async () => {
    const m = await launch('late')
    const convo = longRun(FIRST_MESSAGE, 63) // 127 messages: nothing aged yet
    const before = m.rewriteMessagesBody(convo, { decay: true })
    expect(before.stats.kinds.aged).toBe(0)
    const grown = longRun(FIRST_MESSAGE, 64) // 129 messages: the older 64 age out
    const r = m.rewriteMessagesBody(grown, { decay: true })
    const decayed = r.stashes.filter((s) => s.meta?.kind === 'decay')
    expect(decayed.length).toBeGreaterThan(10)
    // Some of what aged out was under the floor, which first sight had left whole.
    expect(decayed.some((s) => s.original.length >= 600 && s.original.length < FLOOR)).toBe(true)
    for (const s of decayed) {
      expect(r.body).toContain(s.token)
      ccrPut(s.token, s.original, 'proxy', s.meta as never)
    }
    for (const s of decayed) expect(await retrieveFull(s.token)).toBe(s.original)
    // And every one of those originals is a result the body really carried.
    const originals = new Set(resultTexts(grown))
    for (const s of decayed) expect(originals.has(s.original)).toBe(true)
  })

  it('leaves the newer half whole, under the floor, while the older half is stubs', async () => {
    const m = await launch('late')
    const grown = distinctRun(FIRST_MESSAGE, 64)
    const orig = resultTexts(grown)
    const out = resultTexts(m.rewriteMessagesBody(grown, { decay: true }).body)
    // 64 results; message index of result k is 2k + 2, the cutoff is message 64.
    let checked = 0
    for (let k = 0; k < orig.length; k++) {
      const msgIndex = 2 * k + 2
      if (msgIndex >= 64 && orig[k].length < FLOOR) { expect(out[k]).toBe(orig[k]); checked++ }
      if (msgIndex < 64 && orig[k].length >= 600) expect(isAged(out[k])).toBe(true)
    }
    expect(checked).toBeGreaterThan(10)
  })
})

describe('the policy is resolved once per process, like the floor', () => {
  it('is legacy until something pushes one', async () => {
    const m = await launch()
    expect(m.getFirstSightPolicy()).toBe('legacy')
    expect(m.rewriteMessagesBody(caseBody('Read', 'code', 5_000)).changed).toBe(true)
  })

  it('takes the first usable push and ignores every later one', async () => {
    const m = await launch('late')
    expect(m.getFirstSightPolicy()).toBe('late')
    m.setFirstSightPolicy('legacy')
    expect(m.getFirstSightPolicy()).toBe('late')
    expect(m.rewriteMessagesBody(caseBody('Read', 'code', 5_000)).changed).toBe(false)
    const other = await launch('legacy')
    other.setFirstSightPolicy('late')
    expect(other.getFirstSightPolicy()).toBe('legacy')
    expect(other.rewriteMessagesBody(caseBody('Read', 'code', 5_000)).changed).toBe(true)
  })

  it('does not spend the one resolution on a push that carries no usable policy', async () => {
    const m = await launch()
    for (const bad of [undefined, null, '', 'Late', 'off', 0, 1, {}, []]) m.setFirstSightPolicy(bad)
    expect(m.getFirstSightPolicy()).toBe('legacy')
    m.setFirstSightPolicy('late')
    expect(m.getFirstSightPolicy()).toBe('late')
    expect(m.rewriteMessagesBody(caseBody('Read', 'code', 5_000)).changed).toBe(false)
  })

  it('does not let a window push change the policy, or the policy the window', async () => {
    const m = await launch('late')
    m.setWireWindow(m.windowForMode('max'))
    expect(m.rewriteMessagesBody(caseBody('Read', 'code', 5_000)).changed).toBe(false)
  })
})

describe('every request records the arm it ran under', () => {
  const holdoutFirst = (): string => {
    for (let i = 0; i < 1_000; i++) {
      const t = `${FIRST_MESSAGE} probe ${i}`
      if (armForBody({ messages: [{ role: 'user', content: t }] }) === 'holdout') return t
    }
    throw new Error('no holdout message found')
  }
  const lateFirst = (): string => `${FIRST_MESSAGE} on the main arm`

  it('is late for a conversation on the policy, holdout for one held out, legacy under the kill switch', async () => {
    const late = (await launch('late')).rewriteMessagesBody(caseBody('Read', 'code', 5_000, 'string', lateFirst()))
    expect(armForBody({ messages: [{ role: 'user', content: lateFirst() }] })).toBe('late')
    expect(late.stats.arm).toBe('late')
    const held = (await launch('late')).rewriteMessagesBody(caseBody('Read', 'code', 5_000, 'string', holdoutFirst()))
    expect(held.stats.arm).toBe('holdout')
    const off = (await launch('legacy')).rewriteMessagesBody(caseBody('Read', 'code', 5_000, 'string', lateFirst()))
    expect(off.stats.arm).toBe('legacy')
    expect(off.stats.armCluster).toBe(0)
    for (const r of [late, held]) {
      expect(Number.isInteger(r.stats.armCluster)).toBe(true)
      expect(r.stats.armCluster).toBeGreaterThanOrEqual(0)
      expect(r.stats.armCluster).toBeLessThan(ARM_CLUSTERS)
    }
  })

  it('runs a held-out conversation exactly as v1.54.4 did: the same bytes the legacy policy forwards', async () => {
    const first = holdoutFirst()
    for (const [kind, chars] of [['code', 1_600], ['log', 5_000], ['json', 20_000], ['html', 39_999], ['markdown', 80_000]] as const) {
      const raw = caseBody('Bash', kind, chars, 'string', first)
      const held = (await launch('late')).rewriteMessagesBody(raw)
      const legacy = (await launch('legacy')).rewriteMessagesBody(raw)
      expect(held.body, `${kind}/${chars}`).toBe(legacy.body)
      expect(held.changed).toBe(true)
      expect(held.stashes.map((s) => s.token)).toEqual(legacy.stashes.map((s) => s.token))
    }
  })

  it('reads the arm from the first message and from nothing else in the request', async () => {
    const first = holdoutFirst()
    const raw = caseBody('Read', 'code', 5_000, 'string', first)
    const withSystem = JSON.stringify({ ...JSON.parse(raw), system: [{ type: 'text', text: 'You are a coding agent.' }], model: 'another-model' })
    const m = await launch('late')
    expect(m.rewriteMessagesBody(withSystem).stats.arm).toBe('holdout')
    const steered = JSON.stringify({ ...JSON.parse(raw), system: [{ type: 'text', text: 'Be brief. ⁣termpolis-steer⁣' }] })
    expect(m.rewriteMessagesBody(steered).stats.arm).toBe('holdout')
  })

  it('records the arm, the group and the conversation key armOf chose, for 70 different conversations', async () => {
    const m = await launch('late')
    const groups = new Set<number>()
    let held = 0
    for (let i = 0; i < 70; i++) {
      const first = `Conversation ${i}: ${FIRST_MESSAGE}`
      const raw = caseBody('Read', 'code', 5_000, 'string', first)
      const chosen = armOf(JSON.parse(raw))
      const r = m.rewriteMessagesBody(raw)
      expect(r.stats.arm, first).toBe(chosen.arm)
      expect(r.stats.armCluster, first).toBe(chosen.cluster)
      expect(r.stats.convKey, first).toBe(chosen.key)
      groups.add(chosen.cluster)
      if (chosen.arm === 'holdout') held++
    }
    // A hand-off that dropped the group would put every request in group 0, and the comparison would
    // wait for ever for the five groups it needs.
    expect(groups.size).toBeGreaterThanOrEqual(5)
    expect(held).toBeGreaterThan(0)
  })

  it('and the ledger files a request in the group the rewriter reported', async () => {
    const m = await launch('late')
    resetArmLedger()
    const filed: Array<{ arm: 'late' | 'holdout'; cluster: number }> = []
    for (let i = 0; i < 40; i++) {
      const raw = caseBody('Read', 'code', 5_000, 'string', `Conversation ${i}: ${FIRST_MESSAGE}`)
      const r = m.rewriteMessagesBody(raw)
      const before = armState()
      recordProxyResult({
        kind: 'result', changed: r.changed, stats: r.stats, stashes: [], status: 200,
        usage: { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, output_tokens: 10 },
        turn: { toolCalls: 0, retrieveCalls: 0, pure: false },
      } as unknown as ProxyResultMsg)
      const after = armState()
      const arm = r.stats.arm as 'late' | 'holdout'
      expect(after[arm][r.stats.armCluster].requests - before[arm][r.stats.armCluster].requests).toBe(1)
      filed.push({ arm, cluster: r.stats.armCluster })
    }
    const total = armState()
    const counted = total.late.reduce((n, c) => n + c.requests, 0) + total.holdout.reduce((n, c) => n + c.requests, 0)
    expect(counted).toBe(filed.length)
    expect(new Set(filed.map((f) => `${f.arm}/${f.cluster}`)).size).toBeGreaterThan(5)
  })

  it('stamps each stash with the policy the request really ran under: late, or legacy for the holdout and the kill switch', async () => {
    type Stash = { meta?: { policy?: string; kind: string } }
    const policies = (r: { stashes: Stash[] }): string[] => r.stashes.map((x) => x.meta?.policy ?? 'none')
    // 80,000 characters is shortened under every policy, so each arm has a stash to look at.
    const big = (first: string): string => caseBody('Read', 'code', 80_000, 'string', first)
    const late = (await launch('late')).rewriteMessagesBody(big(lateFirst()))
    expect(late.stats.arm).toBe('late')
    expect(late.stashes.length).toBeGreaterThan(0)
    expect(new Set(policies(late))).toEqual(new Set(['late']))
    const held = (await launch('late')).rewriteMessagesBody(big(holdoutFirst()))
    expect(held.stats.arm).toBe('holdout')
    expect(held.stashes.length).toBeGreaterThan(0)
    expect(new Set(policies(held))).toEqual(new Set(['legacy']))
    const off = (await launch('legacy')).rewriteMessagesBody(big(lateFirst()))
    expect(off.stats.arm).toBe('legacy')
    expect(off.stashes.length).toBeGreaterThan(0)
    expect(new Set(policies(off))).toEqual(new Set(['legacy']))
  })

  it('and a result between the tier floor and 40,000 characters is shortened only by the old behaviour, so only it has a stash', async () => {
    const mid = (first: string): string => caseBody('Bash', 'log', 12_000, 'string', first)
    expect((await launch('late')).rewriteMessagesBody(mid(lateFirst())).stashes).toHaveLength(0)
    const held = (await launch('late')).rewriteMessagesBody(mid(holdoutFirst()))
    expect(held.stashes.length).toBeGreaterThan(0)
    expect(held.stashes.every((x) => x.meta?.policy === 'legacy')).toBe(true)
  })

  it('holds out about one conversation in ten of a realistic mix', async () => {
    const m = await launch('late')
    let held = 0
    const N = 2_000
    for (let i = 0; i < N; i++) {
      const raw = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: `Task ${i}: ${FIRST_MESSAGE}` }] })
      if (m.rewriteMessagesBody(raw).stats.arm === 'holdout') held++
    }
    expect((held / N) * 100).toBeGreaterThan(8)
    expect((held / N) * 100).toBeLessThan(12)
  })
})

describe('compactToolText takes the policy as an argument for callers with no request', () => {
  it('follows the process policy by default and an explicit policy over it', async () => {
    const text = Array.from({ length: 120 }, (_, i) => `line number ${i} with a little padding in it`).join('\n')
    expect(text.length).toBeGreaterThan(1_600)
    expect(text.length).toBeLessThan(FLOOR)
    const def = await launch()
    expect(def.compactToolText(text).text.length).toBeLessThan(text.length) // legacy: shortened
    const late = await launch('late')
    expect(late.compactToolText(text).text).toBe(text) // late: whole
    expect(late.compactToolText(text, { toolName: 'Read' }).text).toBe(text)
    const { LEGACY_POLICY } = await import('../../src/main/headroom/elisionPolicy')
    expect(late.compactToolText(text, undefined, LEGACY_POLICY).text.length).toBeLessThan(text.length)
  })
})
