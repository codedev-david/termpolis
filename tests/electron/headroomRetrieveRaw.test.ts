import { describe, it, expect, beforeEach } from 'vitest'
import { compressToolResult, retrieveFull } from '../../src/main/headroom/compressToolResult'
import { ccrPut, ccrStash, resetCcr } from '../../src/main/headroom/ccrStore'
import { EXEMPT_TOOLS } from '../../src/main/headroom/router'
import { resetLedger } from '../../src/main/headroom/savingsLedger'
import { resetProxyLedger } from '../../src/main/headroomProxy/proxyLedger'

/**
 * retrieve_full hands back text the model asked for. compressToolResult used to quote it as JSON
 * first, so every newline, tab and quote in a file or a command's output came back as a two
 * character escape: about 2.6% more characters on sampled payloads, 12.6 escaped newlines and 9.3
 * escaped tabs per thousand, and the model reads the escapes as extra tokens. A string original now
 * comes back as itself. Nothing else changes: an object original is still pretty JSON, and a tool
 * whose result a program parses (agent_exec) is still JSON.
 */

/** Text shaped like what is stashed: source with indentation, quotes, backslashes and unicode. */
const SAMPLE = [
  'export function render(items: Item[]): string {',
  '\tconst rows = items.map((i) => `${i.name}\\t${i.score}`)',
  '\treturn "<table>" + rows.join("\\n") + \'</table>\'   // the "total" row',
  '}',
  'C:\\Users\\someone\\project\\file.ts   \u00e9\u00e8 \u2014 \ud83d\ude80',
  '',
].join('\n').repeat(40)

describe('retrieve_full returns the text itself', () => {
  beforeEach(() => { resetCcr(); resetLedger(); resetProxyLedger() })

  it('hands a string back unchanged: no leading quote, literal newlines, tabs and quotes', () => {
    const out = compressToolResult('retrieve_full', 'a\n\tb "c" \\ d')
    expect(out).toBe('a\n\tb "c" \\ d')
    expect(out.startsWith('"')).toBe(false)
    expect(out).toContain('\n')
    expect(out).toContain('\t')
  })

  it('is exactly the stored original, for text with every awkward character', () => {
    expect(compressToolResult('retrieve_full', SAMPLE)).toBe(SAMPLE)
    for (const odd of ['', ' ', '\r\n', '\u2028\u2029', '\u0000', 'tab\there', '{"json":"inside"}', '[1,2]', 'null', '"quoted"', "it's", '\ud800']) {
      expect(compressToolResult('retrieve_full', odd), JSON.stringify(odd)).toBe(odd)
    }
  })

  it('is shorter than the quoted form it replaces, by the escapes', () => {
    const quoted = JSON.stringify(SAMPLE, null, 2)
    const raw = compressToolResult('retrieve_full', SAMPLE)
    expect(raw.length).toBeLessThan(quoted.length)
    expect(quoted.length - raw.length).toBeGreaterThan(SAMPLE.split('\n').length) // at least one escape per line
  })

  it('is the same through the namespaced name a client uses', () => {
    expect(compressToolResult('mcp__termpolis__retrieve_full', SAMPLE)).toBe(SAMPLE)
    expect(compressToolResult('mcp__plugin_termpolis_termpolis__retrieve_full', SAMPLE)).toBe(SAMPLE)
  })

  it('returns what a stash held, end to end: put, redeem, present', async () => {
    const token = 'hr_0123456789abcdef'
    ccrPut(token, SAMPLE, 'proxy')
    expect(compressToolResult('retrieve_full', await retrieveFull(token))).toBe(SAMPLE)
  })

  it('still presents an object original as pretty JSON, and so an offloaded array', async () => {
    const original = [{ id: 1, name: 'a\nb' }, { id: 2, name: 'c' }]
    expect(compressToolResult('retrieve_full', original)).toBe(JSON.stringify(original, null, 2))
    expect(compressToolResult('retrieve_full', { a: 1 })).toBe('{\n  "a": 1\n}')
    const token = ccrStash(original)
    expect(compressToolResult('retrieve_full', await retrieveFull(token))).toBe(JSON.stringify(original, null, 2))
  })

  it('still presents the expired message as JSON, so a caller can tell it from content', async () => {
    const out = compressToolResult('retrieve_full', await retrieveFull('hr_gone'))
    expect(JSON.parse(out)).toEqual({ error: 'expired', message: 'This result has expired \u2014 re-run the original tool.' })
  })

  it('leaves a result that is neither a string nor an object as it was', () => {
    for (const v of [5, true, null]) expect(compressToolResult('retrieve_full', v)).toBe(JSON.stringify(v, null, 2))
  })

  it('keeps the fail-open path: a value that cannot be serialised is stringified, as before', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(compressToolResult('retrieve_full', cyclic)).toBe('[object Object]')
  })
})

describe('every other tool is presented exactly as it was', () => {
  const same = (name: string, result: unknown): void => {
    let before: string
    try { before = JSON.stringify(result, null, 2) } catch { before = String(result) }
    expect(compressToolResult(name, result), `${name} ${JSON.stringify(result)?.slice(0, 40)}`).toBe(before)
  }

  it('agent_exec keeps returning JSON, string or object: termpolis-cli parses it', () => {
    same('agent_exec', SAMPLE)
    same('agent_exec', 'hello\nworld')
    same('agent_exec', { ok: true, output: 'line 1\nline 2' })
    expect(JSON.parse(compressToolResult('agent_exec', 'hello\nworld'))).toBe('hello\nworld')
  })

  it('every exempt tool, with a string and with an object', () => {
    const exempt = [...EXEMPT_TOOLS.filter((t) => t !== 'retrieve_full'), 'memory_search', 'memory_write', 'swarm_list_tasks', 'swarm_send_message']
    expect(exempt).toContain('agent_exec')
    expect(exempt).toContain('linked_machines')
    for (const t of exempt) {
      same(t, SAMPLE)
      same(t, { rows: [1, 2, 3], text: 'a\nb' })
    }
  })

  it('a tool that compresses still does, and a name that merely contains retrieve_full is not retrieve_full', () => {
    same('code_search', 'plain text\nwith a newline')
    same('my_retrieve_full', SAMPLE)
    same('retrieve_full_2', SAMPLE)
    same('retrieve_full_extra', { a: 1 })
    same('mcp__other__retrieve_full_x', SAMPLE)
  })

  it('a compressible array result is compressed as it always was', () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, file: `src/module${i}.ts`, line: i * 3, text: `match number ${i} in a reasonably long line of source` }))
    const out = compressToolResult('code_search', rows)
    expect(out.length).toBeLessThan(JSON.stringify(rows, null, 2).length)
    expect(out).toContain('retrieve_full')
  })
})
