import { describe, it, expect, afterEach } from 'vitest'
import { rewriteMessagesBody, setWireWindow, windowForMode } from '../../src/main/headroomProxy/wireCompress'

/**
 * The 50% floor, as a regression gate.
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

describe('the 50% savings floor holds on realistic traffic', () => {
  afterEach(() => { setWireWindow(windowForMode('aggressive')) })

  it('clears 50% at the shipped default tier', () => {
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
