import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { armOf, effectiveFloor, policyFor } from '../../src/main/headroom/elisionPolicy'
import { realistic, editLoop, FIRST_MESSAGE } from './fixtures/lateGoldenCases'

/**
 * What the late policy costs the shared proxy child, and what it saves it.
 *
 * Performance is a gate for this release, in three parts: what the model is shown (headroomLateGoldens,
 * headroomLatePolicy), whether the cached prefix holds still (the prefix-stability cases in
 * headroomLatePolicy and headroomCachePrefixStability), and speed, which is this file. One proxy child
 * serves every Claude session of an app run on a single thread, so anything added to its request path
 * is paid by all of them on every request. Every timing here is RELATIVE: two things measured in the
 * same process, best of several runs, taken alternately so both see the same machine state, with a
 * bound far past what was measured, so that a loaded machine cannot fail it and only a real
 * regression can. Measured on the day, for the record, with the bound beside each:
 *
 *   late rewrite / legacy rewrite, the same body .. 0.15 to 0.75   (bound 1.25: late may not cost more)
 *   arm choice / rewrite, 100 KB first message .... about 0.15%     (bound 10%)
 *   whole-body JSON.parse calls per rewrite ....... 1 and 1         (bound: equal, and exactly one)
 */

const WIRE = '../../src/main/headroomProxy/wireCompress'

interface Wire {
  rewriteMessagesBody: (raw: string, opts?: { decay?: boolean }) => { body: string; changed: boolean; stashes: Array<{ original: string }> }
}
async function launch(policy: 'late' | 'legacy'): Promise<Wire> {
  vi.resetModules()
  const m = await import(WIRE)
  m.setWireWindow(m.windowForMode('aggressive'))
  m.setFirstSightPolicy(policy)
  return m as Wire
}

const TOOLS = ['Read', 'Bash', 'Grep', 'Glob', 'PowerShell', 'WebFetch']
const SIZES = [700, 1_800, 3_000, 6_000, 12_000, 25_000, 38_000, 45_000, 90_000]
/** Distinct text of exactly `chars` characters, so nothing in a body collapses as a repeat. */
function textOf(i: number, chars: number): string {
  return Array.from({ length: Math.ceil(chars / 25) }, (_, k) => `r${i}-line ${k}: payload ${(k * 7919 + i * 104729) % 100003}`).join('\n').slice(0, chars)
}
/** `pairs` tool calls with results across every size band, after a first message of the caller's choosing. */
function body(pairs: number, first: string): string {
  const messages: unknown[] = [{ role: 'user', content: first }]
  for (let k = 0; k < pairs; k++) {
    const tool = TOOLS[k % TOOLS.length]
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${k}`, name: tool, input: tool === 'Read' ? { file_path: `/repo/f${k}.ts` } : { command: `step ${k}` } }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${k}`, content: textOf(k, SIZES[k % SIZES.length]) }] })
  }
  return JSON.stringify({ model: 'claude-opus-5-5', system: 'You are a coding agent.', messages })
}

/** The fastest of `runs` runs of each, taken alternately so both see the same machine state. */
function bestOf(a: () => void, b: () => void, runs: number): [number, number] {
  let ba = Infinity, bb = Infinity
  for (let i = 0; i < runs; i++) {
    const swap = i % 2 === 1
    const first = swap ? b : a, second = swap ? a : b
    const t1 = process.hrtime.bigint(); first(); const d1 = Number(process.hrtime.bigint() - t1)
    const t2 = process.hrtime.bigint(); second(); const d2 = Number(process.hrtime.bigint() - t2)
    if (swap) { bb = Math.min(bb, d1); ba = Math.min(ba, d2) } else { ba = Math.min(ba, d1); bb = Math.min(bb, d2) }
  }
  return [ba, bb]
}

describe('speed: late does less work than legacy, not more', () => {
  it.each([
    ['40 tool calls across every size band', () => body(40, FIRST_MESSAGE)],
    ['a read, edit, re-read conversation', () => realistic(FIRST_MESSAGE)],
    ['an edit loop with a large file', () => editLoop(FIRST_MESSAGE)],
  ] as const)('rewrites %s no slower than legacy does', async (_name, make) => {
    const raw = make()
    const late = await launch('late')
    const legacy = await launch('legacy')
    for (let i = 0; i < 4; i++) { late.rewriteMessagesBody(raw); legacy.rewriteMessagesBody(raw) } // warm both
    const [l, g] = bestOf(() => late.rewriteMessagesBody(raw), () => legacy.rewriteMessagesBody(raw), 9)
    // Measured at 0.15 to 0.75: it skips the content router, the outline and the window for every
    // result under 40,000 characters. A quarter of slack on the other side is what a regression that
    // made the arm choice or the floor lookup expensive would have to exceed.
    expect(l).toBeLessThanOrEqual(g * 1.25)
  })

  it('hands the main process no more originals to store than legacy does, and fewer characters', async () => {
    for (const raw of [body(40, FIRST_MESSAGE), realistic(FIRST_MESSAGE), editLoop(FIRST_MESSAGE)]) {
      const late = (await launch('late')).rewriteMessagesBody(raw)
      const legacy = (await launch('legacy')).rewriteMessagesBody(raw)
      expect(late.stashes.length).toBeLessThanOrEqual(legacy.stashes.length)
      const chars = (r: { stashes: Array<{ original: string }> }): number => r.stashes.reduce((n, s) => n + s.original.length, 0)
      expect(chars(late)).toBeLessThanOrEqual(chars(legacy))
    }
  })
})

describe('speed: the floor lookup that runs for every tool result', () => {
  it('is a constant-time property test, nothing more: it costs within a small factor of one', () => {
    const policy = policyFor('late', 'claude-opus-5-5')
    const tools = ['Read', 'Bash', 'Grep', 'Glob', 'PowerShell', 'WebFetch', 'mcp__claude_ai_Gmail__get_message', undefined]
    const N = 20_000
    const table: Record<string, number> = {}
    const lookup = (): void => { let s = 0; for (let i = 0; i < N; i++) s += effectiveFloor(1_600, policy, tools[i & 7]); if (s < 0) throw new Error('unreachable') }
    // What a lookup has to do at the least: one own-property test and one max.
    const baseline = (): void => {
      let s = 0
      for (let i = 0; i < N; i++) { const t = tools[i & 7]; s += Math.max(1_600, t !== undefined && Object.prototype.hasOwnProperty.call(table, t) ? 1 : 40_000) }
      if (s < 0) throw new Error('unreachable')
    }
    for (let i = 0; i < 20; i++) { lookup(); baseline() }
    const [a, b] = bestOf(lookup, baseline, 15)
    // Measured at a few times the baseline (a closure call and two property tests where the baseline
    // inlines them). A scan, a copy or a regular expression per call would be hundreds of times; fifty
    // is far past any load and far short of that.
    expect(a).toBeLessThanOrEqual(b * 50)
  })
})

describe('speed: choosing the arm', () => {
  it('costs a small fraction of the rewrite it rides in, with a first message the size of a real one', async () => {
    // Claude Code's first message carries the project instructions, the memory index and the skill
    // listing: 50 to 100 KB. Hashing all of it would cost 1.6 ms a request.
    const reminder = `<system-reminder>\n${'Contents of the project instructions file. '.repeat(2_500)}\n</system-reminder>\n\n`
    expect(reminder.length).toBeGreaterThan(100_000)
    const raw = body(40, `${reminder}${FIRST_MESSAGE}`)
    const parsed = JSON.parse(raw)
    const late = await launch('late')
    for (let i = 0; i < 4; i++) { late.rewriteMessagesBody(raw); armOf(parsed) }
    const [rewrite, arm] = bestOf(() => late.rewriteMessagesBody(raw), () => { for (let i = 0; i < 20; i++) armOf(parsed) }, 9)
    // Measured at about a tenth of one percent per call (0.03 ms against 22 ms); taken over 20 calls
    // here, so the figure compared is 20 arm choices against one rewrite.
    expect(arm / 20).toBeLessThanOrEqual(rewrite * 0.1)
  })

  it('does not depend on how long the conversation is: it reads the first message and stops', () => {
    const short = JSON.parse(body(2, FIRST_MESSAGE))
    const long = JSON.parse(body(140, FIRST_MESSAGE))
    for (let i = 0; i < 50; i++) { armOf(short); armOf(long) }
    const [a, b] = bestOf(() => { for (let i = 0; i < 200; i++) armOf(short) }, () => { for (let i = 0; i < 200; i++) armOf(long) }, 15)
    // Measured at 1.0. Walking the later messages would make the long one dozens of times the short one.
    expect(b).toBeLessThanOrEqual(a * 5)
  })
})

describe('speed: nothing is parsed or read that was not before', () => {
  it('parses the request body once, as it always has, and no more often than legacy does', async () => {
    const raw = body(40, FIRST_MESSAGE)
    const parses = async (policy: 'late' | 'legacy'): Promise<{ calls: number; whole: number }> => {
      const m = await launch(policy)
      const real = JSON.parse
      let calls = 0, whole = 0
      JSON.parse = ((t: string, ...rest: unknown[]) => {
        calls++
        if (typeof t === 'string' && t.length === raw.length) whole++
        return (real as (...a: unknown[]) => unknown)(t, ...rest)
      }) as typeof JSON.parse
      try { m.rewriteMessagesBody(raw) } finally { JSON.parse = real }
      return { calls, whole }
    }
    const late = await parses('late')
    const legacy = await parses('legacy')
    expect(late.whole).toBe(1)
    expect(late).toEqual(legacy)
  })

  it('adds no import that reads a file or starts a process to anything the proxy child loads', () => {
    const src = join(__dirname, '..', '..', 'src', 'main')
    const imports = (rel: string): string[] => [...readFileSync(join(src, rel), 'utf8').matchAll(/^import\s[^'"\n]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    // The policy and everything the child takes from it import nothing at all.
    expect(imports('headroom/elisionPolicy.ts')).toEqual([])
    // The ledger and the comparison are the main process's and read counts held in memory: the
    // only thing either imports is the policy module, never fs, child_process or electron.
    expect(imports('headroom/armLedger.ts')).toEqual(['./elisionPolicy'])
    // armCompare takes the ledger's types only: a type import is erased and loads nothing.
    expect(readFileSync(join(src, 'headroom/armCompare.ts'), 'utf8')).toMatch(/^import type \{[^}]*\} from '\.\/armLedger'$/m)
    expect(imports('headroom/armCompare.ts')).toEqual(['./armLedger'])
    for (const rel of ['headroom/armLedger.ts', 'headroom/armCompare.ts', 'headroom/elisionPolicy.ts']) {
      for (const bad of ['fs', 'node:fs', 'child_process', 'node:child_process', 'electron', 'net', 'http', 'https']) expect(imports(rel), rel).not.toContain(bad)
    }
  })

  it('keeps the whole-body parse out of the child: the arm is read from the messages already parsed', () => {
    const wire = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'headroomProxy', 'wireCompress.ts'), 'utf8')
    // requestPolicy hands armOf the parsed object. armOf accepts a string for callers that hold none,
    // and parsing it there would be a second parse of the whole body on every request.
    expect(wire).toContain('const a = armOf(obj)')
    expect(wire).not.toMatch(/armOf\(\s*raw\b/)
    expect(wire).not.toMatch(/armOf\(\s*JSON\.stringify/)
  })
})
