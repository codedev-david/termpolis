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
 * The fixture below reproduces the SHAPE of that traffic — repeated file reads, a near-duplicate
 * re-read after an edit, verbose command output, and large `Write` payloads. If a threshold is ever
 * loosened or a surface stops being compressed, this test fails before the ledger notices.
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
  // The agent writes the whole file back — the tool_use payload that older versions never touched.
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

  it('clears the floor on EACH surface independently — neither carries the other', () => {
    setWireWindow(windowForMode('aggressive'))
    const m = measure(realisticBody())
    expect(m.tr).toBeGreaterThanOrEqual(50)
    expect(m.tu).toBeGreaterThanOrEqual(50)
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
