import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { rewriteMessagesBody, setWireWindow, windowForMode, setFirstSightPolicy, getFirstSightPolicy } from '../../src/main/headroomProxy/wireCompress'
import { longRun, FIRST_MESSAGE } from './fixtures/lateGoldenCases'

/**
 * THE 50% FLOOR, AS A REGRESSION GATE FOR THE LEGACY POLICY, AND ITS REPLACEMENT FOR `late`.
 *
 * Termpolis v1.34 promised that at least half of the tool text on the wire goes away, and this file
 * held it to that. v1.55 retires the promise for the policy it ships by default, on purpose
 * (headroom/elisionPolicy.ts): since Claude Code 2.1.247 the model asks for about two thirds of the
 * results that are shortened at first sight, each ask is a whole extra turn, and no class of result
 * under about 40,000 characters pays for being shortened. `late` therefore leaves those whole, and the
 * share of tool text removed falls. That is the intent, not a regression, and it is what the second
 * half of this file asserts in its place: nothing of 600 to 39,999 characters is shortened at first
 * sight, what is shortened is still shortened, and the model has fewer reasons to ask.
 *
 * The first half is unchanged and runs under `legacy`, the Settings kill switch and the holdout
 * arm, where the old promise still holds and must keep holding.
 *
 * These numbers are not invented. They were measured by replaying 4,183 real Claude Code requests
 * (35.2 GB of request bodies, 14.9 GB of compressible tool text) from this machine's own transcripts
 * through `rewriteMessagesBody`. At the shipped default tier that corpus compresses to:
 *
 *   tool_result text .... 63.5% removed
 *   tool_use text ....... 51.6% removed   (21.4% of the compressible surface)
 *   both combined ....... 61.0% removed   — 6.2% of requests fell below 50%
 *   at 'max' ............ 72.3% removed   — 0.1% of requests fell below 50%
 *
 * CAVEAT: the tool_use rows above were measured while the proxy still compressed tool_use input.
 * It no longer touches any tool_use field, at any age (TOOL_USE_VERBATIM in wireCompress.ts: the
 * model replays its own inputs, so an elided one corrupted real files, commands and prompts). That
 * surface now contributes nothing and the floor rests on tool_result text alone — on this machine's
 * ledger tool_use was 22.5M of 1.34B saved tokens, ~1.7% of the total.
 *
 * The fixture below reproduces the SHAPE of that traffic — repeated file reads, a near-duplicate
 * re-read after an edit, verbose command output, large `Write` payloads and a subagent dispatch. If
 * a threshold is ever loosened or a surface stops being compressed, this test fails before the
 * ledger notices.
 *
 * The assertions are floors, not equalities: compression is allowed to get better.
 */

const srcFile = (tag: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `  export const ${tag}${i} = compute(${i}) // a representative source line with real length`).join('\n')

const cmdOutput = (n: number): string =>
  Array.from({ length: n }, (_, i) => `2026-08-09T12:00:${String(i % 60).padStart(2, '0')}Z [info] task ${i} completed in ${i * 3}ms (worker ${i % 8})`).join('\n')

/** A conversation shaped like real agent work: read, run, write, re-read, repeat. */
function realisticBody(): string {
  const fileA = srcFile('a', 220)
  const fileAEdited = fileA.replace('export const a7 =', 'export const a7 = /* patched */')
  const fileB = srcFile('b', 180)
  const messages: Array<Record<string, unknown>> = []
  const call = (id: string, name: string, input: Record<string, unknown>): void => {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] })
  }
  const result = (id: string, content: string): void => {
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] })
  }

  call('r1', 'Read', { file_path: '/repo/src/a.ts' })
  result('r1', fileA)
  call('r2', 'Bash', { command: 'npm test' })
  result('r2', cmdOutput(300))
  call('r3', 'Read', { file_path: '/repo/src/b.ts' })
  result('r3', fileB)
  // The agent writes the whole file back — a tool_use payload the proxy never touches.
  call('w1', 'Write', { file_path: '/repo/src/a.ts', content: fileAEdited })
  result('w1', 'File written successfully.')
  // Re-read after the edit: a NEAR-duplicate of what is already on the wire.
  call('r4', 'Read', { file_path: '/repo/src/a.ts' })
  result('r4', fileAEdited)
  // Re-read something unchanged: an EXACT duplicate.
  call('r5', 'Read', { file_path: '/repo/src/b.ts' })
  result('r5', fileB)
  call('r6', 'Bash', { command: 'npm run build' })
  result('r6', cmdOutput(400))
  // A subagent dispatch: bulk tool_use text that rides the wire untouched like every other tool_use
  // input, so it counts toward neither side of the ratio.
  call('t1', 'Task', { description: 'audit', prompt: srcFile('brief', 200) })
  result('t1', 'Subagent finished.')
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Done — the build is green.' }] })

  return JSON.stringify({ model: 'claude-opus-4', messages })
}

const measure = (raw: string): { combined: number; tr: number; tu: number } => {
  const s = rewriteMessagesBody(raw).stats
  const pct = (o: number, c: number): number => (o > 0 ? ((o - c) / o) * 100 : 0)
  return {
    combined: pct(s.trOrigChars + s.tuOrigChars, s.trCompChars + s.tuCompChars),
    tr: pct(s.trOrigChars, s.trCompChars),
    tu: pct(s.tuOrigChars, s.tuCompChars),
  }
}

describe('the 50% savings floor holds on realistic traffic (legacy policy)', () => {
  // Pinned here, once, so the first half cannot depend on a default: the policy is resolved once per
  // process and this module's instance is the one every test below uses.
  beforeAll(() => { setFirstSightPolicy('legacy') })
  afterEach(() => { setWireWindow(windowForMode('aggressive')) })

  it('runs under the legacy policy', () => {
    expect(getFirstSightPolicy()).toBe('legacy')
  })

  it('clears 50% at the Aggressive tier, the default tier (under Legacy, not under the default Late policy)', () => {
    setWireWindow(windowForMode('aggressive'))
    expect(measure(realisticBody()).combined).toBeGreaterThanOrEqual(50)
  })

  it('clears the floor on tool_result text alone — tool_use input adds nothing to either side', () => {
    setWireWindow(windowForMode('aggressive'))
    const raw = realisticBody()
    const m = measure(raw)
    expect(m.tr).toBeGreaterThanOrEqual(50)
    expect(m.combined).toBe(m.tr)
    const s = rewriteMessagesBody(raw).stats
    expect([s.tuBlocks, s.tuOrigChars, s.tuCompChars]).toEqual([0, 0, 0])
  })

  it('reaches the floor WITHOUT touching a byte of any tool_use input', () => {
    // The floor is only worth clearing if what survives is still usable. Every tool_use input in
    // the fixture — file bodies, commands, the subagent prompt — has to come back byte-identical,
    // or the saving was bought by corrupting the agent's own work.
    setWireWindow(windowForMode('aggressive'))
    const raw = realisticBody()
    const inputs = (body: string): string[] =>
      (JSON.parse(body) as { messages: Array<{ content: Array<{ type?: string; input?: unknown }> }> }).messages
        .flatMap((m) => m.content)
        .filter((c) => c.type === 'tool_use')
        .map((c) => JSON.stringify(c.input))
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(true) // the floor WAS reached — by tool_result text
    expect(inputs(r.body)).toEqual(inputs(raw))
    expect(inputs(raw).length).toBeGreaterThan(0) // the fixture actually exercises this
  })

  it('compresses monotonically harder as the tier escalates', () => {
    // The floor controller can only escalate. If a harder tier ever saved LESS, escalation would
    // make the very problem it fires on worse.
    const raw = realisticBody()
    const at = (m: string): number => { setWireWindow(windowForMode(m)); return measure(raw).combined }
    const conservative = at('conservative')
    const balanced = at('balanced')
    const aggressive = at('aggressive')
    const max = at('max')
    expect(balanced).toBeGreaterThanOrEqual(conservative)
    expect(aggressive).toBeGreaterThanOrEqual(balanced)
    expect(max).toBeGreaterThanOrEqual(aggressive)
  })

  it('reaches the measured max-tier level, the escalation target the floor controller aims at', () => {
    setWireWindow(windowForMode('max'))
    expect(measure(realisticBody()).combined).toBeGreaterThanOrEqual(70)
  })

  it('still holds the floor with no duplicates to collapse', () => {
    // Dedup and diffing are the cheapest wins; the floor must not depend on them, or a session
    // that never re-reads a file would quietly fall through it.
    const messages = Array.from({ length: 12 }, (_, i) => [
      { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Write', input: { file_path: `/repo/f${i}.ts`, content: srcFile(`u${i}`, 150) } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: cmdOutput(120 + i) }] },
    ]).flat()
    setWireWindow(windowForMode('aggressive'))
    expect(measure(JSON.stringify({ model: 'claude-opus-4', messages })).combined).toBeGreaterThanOrEqual(50)
  })

  it('leaves the body byte-identical when it cannot beat the floor honestly', () => {
    // Short bodies are passed through untouched rather than padded with footers — the guard that
    // keeps "savings" from ever going negative on small traffic.
    const messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }]
    const raw = JSON.stringify({ model: 'claude-opus-4', messages })
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
  })
})

// ---------------------------------------------------------------------------------------------
// The replacement: what `late` promises instead of 50%.
// ---------------------------------------------------------------------------------------------

const WIRE = '../../src/main/headroomProxy/wireCompress'
const FLOOR = 40_000

interface Wire {
  rewriteMessagesBody: (raw: string) => { body: string; changed: boolean; stats: { trOrigChars: number; trCompChars: number; arm: string } }
}

/** A fresh module is a fresh launch: the policy and the floor are resolved once per process. */
async function launch(policy: 'late' | 'legacy', mode = 'aggressive'): Promise<Wire> {
  vi.resetModules()
  const m = await import(WIRE)
  m.setWireWindow(m.windowForMode(mode))
  m.setFirstSightPolicy(policy)
  return m as Wire
}

type Msg = { role: string; content: unknown }
const textsOf = (body: string): string[] => {
  const out: string[] = []
  for (const m of (JSON.parse(body) as { messages: Msg[] }).messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content as Array<{ type?: string; content?: unknown }>) {
      if (b?.type === 'tool_result' && typeof b.content === 'string') out.push(b.content)
    }
  }
  return out
}
const hasToken = (t: string): boolean => /token "hr_[0-9a-f]{16}"/.test(t)
const isStub = (t: string): boolean => t.startsWith('[headroom] Identical to an earlier tool result') || t.startsWith("[headroom] Aged out")
const isWindow = (t: string): boolean => hasToken(t) && !isStub(t)

describe('under the late policy the 50% floor is retired and this is what holds instead', () => {
  it('shortens no tool result of 600 to 39,999 characters at first sight, at any tier', async () => {
    const raw = realisticBody()
    const original = textsOf(raw)
    expect(original.some((t) => t.length >= 600 && t.length < FLOOR)).toBe(true)
    for (const mode of ['conservative', 'balanced', 'aggressive', 'max']) {
      const m = await launch('late', mode)
      const forwarded = textsOf(m.rewriteMessagesBody(raw).body)
      expect(forwarded).toHaveLength(original.length)
      for (let i = 0; i < original.length; i++) {
        if (original[i].length >= 600 && original[i].length < FLOOR) {
          expect(isWindow(forwarded[i]), `${mode}: result ${i} of ${original[i].length} characters`).toBe(false)
        }
      }
    }
  })

  it('removes less tool text than legacy on the same traffic, and says so: that is the intent', async () => {
    const raw = realisticBody()
    const late = (await launch('late')).rewriteMessagesBody(raw).stats
    const legacy = (await launch('legacy')).rewriteMessagesBody(raw).stats
    const pct = (o: number, c: number): number => (o > 0 ? ((o - c) / o) * 100 : 0)
    const lateTr = pct(late.trOrigChars, late.trCompChars)
    const legacyTr = pct(legacy.trOrigChars, legacy.trCompChars)
    expect(legacyTr).toBeGreaterThanOrEqual(50) // the old promise, still kept under legacy
    expect(lateTr).toBeLessThan(legacyTr)
    expect(lateTr).toBeLessThan(50) // and no longer promised under late
    expect(lateTr).toBeGreaterThan(0) // an exact repeat and a near repeat are still collapsed
  })

  it('still shortens what it should: a result of 40,000 characters or more goes as it did, nearly all of it', async () => {
    const big = (tag: string): string => Array.from({ length: 900 }, (_, i) => `  export const ${tag}${i} = compute(${i}) // a representative source line with real length`).join('\n')
    expect(big('x').length).toBeGreaterThan(FLOOR)
    const messages: Msg[] = [{ role: 'user', content: 'check the three big files' }]
    for (const k of ['p', 'q', 'r']) {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${k}`, name: 'Read', input: { file_path: `/repo/${k}.ts` } }] })
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${k}`, content: big(k) }] })
    }
    const raw = JSON.stringify({ model: 'claude-opus-4', messages })
    const late = (await launch('late')).rewriteMessagesBody(raw).stats
    const legacy = (await launch('legacy')).rewriteMessagesBody(raw).stats
    expect(late.trCompChars).toBe(legacy.trCompChars)
    expect(((late.trOrigChars - late.trCompChars) / late.trOrigChars) * 100).toBeGreaterThanOrEqual(90)
  })

  it('shows the model at least as much as legacy did, in every request of a long conversation', async () => {
    const trace = longRun(FIRST_MESSAGE, 40)
    const all = (JSON.parse(trace) as { messages: Msg[] }).messages
    const late = await launch('late')
    const legacy = await launch('legacy')
    let checked = 0
    for (let end = 3; end <= all.length; end += 6) {
      const body = JSON.stringify({ model: 'claude-opus-4', messages: all.slice(0, end) })
      const l = textsOf(late.rewriteMessagesBody(body).body).reduce((n, t) => n + t.length, 0)
      const g = textsOf(legacy.rewriteMessagesBody(body).body).reduce((n, t) => n + t.length, 0)
      expect(l, `request ending at message ${end}`).toBeGreaterThanOrEqual(g)
      checked++
    }
    expect(checked).toBeGreaterThan(10)
  })

  describe('retrieval turns on a multi-turn trace', () => {
    /**
     * A replay of the trace as the proxy would see it, one request per tool result, with a stand-in
     * for the model: it asks for a shortened result back when that result's token falls under
     * `rate` (a fraction taken from the token itself, so the same result is wanted, or not, under
     * either policy). The rate is an ASSUMPTION about the model, the one the research measured
     * since Claude Code 2.1.247 (0.66); what is under test is the proxy's side of it: how many
     * results it leaves the model something to ask for.
     */
    const wants = (token: string, rate: number): boolean => {
      let h = 0x811c9dc5
      for (let i = 3; i < token.length; i++) { h ^= token.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
      return h / 0x100000000 < rate
    }
    async function replay(policy: 'late' | 'legacy', trace: string, rate: number): Promise<{ turns: number; asked: number; requests: number }> {
      const m = await launch(policy)
      const all = (JSON.parse(trace) as { messages: Msg[] }).messages
      let turns = 0, asked = 0, requests = 0
      for (let end = 1; end <= all.length; end++) {
        const last = all[end - 1]
        if (last.role !== 'user' || !Array.isArray(last.content) || (last.content as Array<{ type?: string }>)[0]?.type !== 'tool_result') continue
        requests++
        const forwarded = textsOf(m.rewriteMessagesBody(JSON.stringify({ model: 'claude-opus-4', messages: all.slice(0, end) })).body)
        const newest = forwarded[forwarded.length - 1] ?? ''
        const token = /token "(hr_[0-9a-f]{16})"/.exec(newest)?.[1]
        if (token) { asked++; if (wants(token, rate)) turns++ }
      }
      return { turns, asked, requests }
    }

    it.each([0.13, 0.66, 1])('needs no more turns than legacy at a redemption rate of %s, on a long mixed-size run', async (rate) => {
      const trace = longRun(FIRST_MESSAGE, 40)
      const late = await replay('late', trace, rate)
      const legacy = await replay('legacy', trace, rate)
      expect(late.requests).toBe(legacy.requests)
      expect(late.requests).toBeGreaterThanOrEqual(40)
      expect(late.asked).toBeLessThanOrEqual(legacy.asked)
      expect(late.turns).toBeLessThanOrEqual(legacy.turns)
    })

    it('and strictly fewer on a conversation made of results under the floor, where there is nothing to ask for', async () => {
      const trace = realisticBody()
      const late = await replay('late', trace, 0.66)
      const legacy = await replay('legacy', trace, 0.66)
      expect(legacy.asked).toBeGreaterThanOrEqual(4)
      expect(late.asked).toBeLessThan(legacy.asked)
      expect(late.turns).toBeLessThanOrEqual(legacy.turns)
    })

    it('leaves the model a way to ask for a result only when it was really shortened: every token on the wire is of a stub, a patch or a result of 40,000 characters or more', async () => {
      const m = await launch('late')
      const all = (JSON.parse(longRun(FIRST_MESSAGE, 40)) as { messages: Msg[] }).messages
      const body = JSON.stringify({ model: 'claude-opus-4', messages: all })
      const original = textsOf(body)
      const forwarded = textsOf(m.rewriteMessagesBody(body).body)
      for (let i = 0; i < original.length; i++) {
        if (hasToken(forwarded[i]) && original[i].length < FLOOR) {
          expect(isStub(forwarded[i]) || forwarded[i].startsWith('[headroom] Identical to an earlier tool result in this conversation except'), `result ${i}`).toBe(true)
        }
      }
    })
  })
})