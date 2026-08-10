import { describe, it, expect, beforeEach } from 'vitest'
const {
  rewriteMessagesBody, compactToolText, setWireWindow, windowStructured,
  collectToolUseHints, hintFromInput, STRUCT_WINDOW_SCALE,
} = await import('../../src/main/headroomProxy/wireCompress')
const { compactText } = await import('../../src/main/headroom/compactText')

/** The shipped default wire window (aggressive), restored before every test. */
const DEFAULT_WINDOW = { headLines: 12, tailLines: 6, maxChars: 1000 }
beforeEach(() => setWireWindow(DEFAULT_WINDOW))

/** A source file big enough that the raw window would keep imports and nothing else. */
function tsFile(fns: number): string {
  const out = [
    "import { readFile } from 'node:fs/promises'",
    "import type { Thing } from './types'",
    '',
    'const LIMIT = 40',
    '',
  ]
  for (let i = 0; i < fns; i++) {
    out.push(`export async function handler${i}(input: string, opts: Thing): Promise<number> {`)
    for (let j = 0; j < 10; j++) out.push(`  const step${j} = await readFile(input + '${j}', 'utf8')`)
    out.push('  if (opts.verbose) {')
    out.push('    console.log(step0)')
    out.push('  }')
    out.push('  return LIMIT')
    out.push('}')
    out.push('')
  }
  return out.join('\n')
}

/**
 * Source with so much body per declaration that the content sniffer will not commit to calling it
 * code — the case where the file path is the only signal there is.
 */
function sparseTs(): string {
  const out = ["import { readFile } from 'node:fs/promises'", "import type { Thing } from './types'", '']
  for (let i = 0; i < 3; i++) {
    out.push(`export async function only${i}(input: string): Promise<number> {`)
    for (let j = 0; j < 80; j++) out.push(`  total += weigh(input, ${j}) * scale`)
    out.push('}')
    out.push('')
  }
  return out.join('\n')
}

/** One assistant tool_use + the user tool_result that answers it. */
function bodyFor(toolResult: string, input: Record<string, unknown> = {}, name = 'Read'): string {
  return JSON.stringify({
    model: 'claude-x',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu0', name, input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu0', content: toolResult }] },
    ],
  })
}

const resultOf = (body: string): string =>
  (JSON.parse(body) as { messages: Array<{ content: Array<{ content: string }> }> }).messages[1].content[0].content

describe('content router — source code', () => {
  const src = tsFile(8)

  it('keeps signatures the raw line window would have thrown away', () => {
    const routed = compactToolText(src, { path: 'src/handlers.ts' }).text
    const windowOnly = compactText(src, DEFAULT_WINDOW).text // exactly what shipped before v1.35

    // The window alone keeps the first 12 lines — the imports and ONE signature.
    expect(windowOnly).toContain('export async function handler0')
    expect(windowOnly).not.toContain('export async function handler5')
    // Routed, the whole API surface comes through instead.
    expect(routed).toContain('export async function handler0')
    expect(routed).toContain('export async function handler5')
    expect(routed).toContain('export async function handler7')
  })

  it('still drops the bodies — fidelity is about structure, not about sending more', () => {
    const routed = compactToolText(src, { path: 'src/handlers.ts' }).text
    expect(routed).not.toContain('const step7 = await readFile')
    expect(routed).not.toContain('console.log(step0)')
  })

  it('stays far smaller than the original and stashes it for retrieve_full', () => {
    const r = compactToolText(src, { path: 'src/handlers.ts' })
    expect(r.text.length).toBeLessThan(src.length / 2)
    expect(r.stash).toBeDefined()
    expect(r.stash!.original).toBe(src)
    expect(r.text).toContain(r.stash!.token)
  })

  it('recognises code with no path at all, from its own shape', () => {
    const r = compactToolText(src)
    expect(r.text).toContain('export async function handler0')
    expect(r.text.length).toBeLessThan(src.length)
  })

  it('honours the user mode — max stays tighter than aggressive', () => {
    setWireWindow({ headLines: 6, tailLines: 3, maxChars: 700 })
    const tight = compactToolText(src, { path: 'a.ts' }).text
    setWireWindow(DEFAULT_WINDOW)
    const loose = compactToolText(src, { path: 'a.ts' }).text
    expect(tight.length).toBeLessThan(loose.length)
  })

  it('leaves prose to the plain window rather than shredding it', () => {
    const prose = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: an ordinary sentence about the design.`).join('\n')
    const r = compactToolText(prose)
    expect(r.text).toContain('… [42 lines elided] …') // 60 - 12 - 6
  })
})

describe('content router — JSON', () => {
  const minified = JSON.stringify({
    ok: true,
    rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `row-${i}`, note: 'x'.repeat(40) })),
  })

  it('compacts a MINIFIED payload the line window could never touch', () => {
    // One line in, so head/tail never fires: before the router this block went out whole.
    expect(minified.split('\n')).toHaveLength(1)
    const plain = { headLines: 12, tailLines: 6, maxChars: 1000 }
    expect(plain).toEqual(DEFAULT_WINDOW)
    const r = compactToolText(minified)
    expect(r.text.length).toBeLessThan(minified.length / 10)
    expect(r.text).toContain('more items elided')
    expect(r.stash).toBeDefined()
  })

  it('compacts a pretty-printed payload too', () => {
    const pretty = JSON.stringify(JSON.parse(minified), null, 2)
    const r = compactToolText(pretty)
    expect(r.text.length).toBeLessThan(pretty.length / 10)
  })

  it('REFUSES a payload with an unsafe integer and falls back to the line window', () => {
    const raw = `{"id":12345678901234567890,"rows":[${Array.from({ length: 200 }, (_, i) => `{"i":${i}}`).join(',')}]}`
    const r = compactToolText(raw)
    // Fallback is the plain window; on a single line it cannot win, so the block is forwarded whole.
    expect(r.text).toBe(raw)
    expect(r.stash).toBeUndefined()
  })

  it('adds no retrieve token when the only saving was whitespace', () => {
    const value = { a: 1, b: 'two', c: { d: true, e: null }, f: [1, 2, 3] }
    const notes = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`n${i}`, 'y'.repeat(100)]))
    const pretty = JSON.stringify({ ...value, ...notes }, null, 2)
    const r = compactToolText(pretty)
    expect(r.stash).toBeUndefined()
    expect(r.text).not.toContain('[headroom]')
    expect(JSON.parse(r.text)).toEqual({ ...value, ...notes }) // nothing was lost
  })
})

describe('windowStructured', () => {
  it('bounds by lines and reports the count', () => {
    const s = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const r = windowStructured(s, { headLines: 3, tailLines: 2, maxChars: 100_000 })
    expect(r.elided).toBe(true)
    expect(r.text.split('\n')).toHaveLength(6)
    expect(r.text).toContain('… [95 lines elided] …')
  })

  it('bounds by chars, which is the case a line window cannot handle', () => {
    const s = 'x'.repeat(5000) // ONE line
    const r = windowStructured(s, { headLines: 12, tailLines: 6, maxChars: 1000 })
    expect(r.elided).toBe(true)
    expect(r.text.startsWith('x'.repeat(1000))).toBe(true)
    expect(r.text).toContain('… [4000 chars elided] …')
  })

  it('passes a block that fits through untouched', () => {
    const s = 'a\nb\nc'
    expect(windowStructured(s, { headLines: 12, tailLines: 6, maxChars: 1000 })).toEqual({ text: s, elided: false })
  })

  it('never duplicates content the way a line window does on one long line', () => {
    const s = 'q'.repeat(3000)
    const r = windowStructured(s, { headLines: 12, tailLines: 6, maxChars: 1000 })
    expect(r.text.length).toBeLessThan(s.length)
  })
})

describe('hint plumbing', () => {
  it('reads the path out of a tool_use input, whichever key names it', () => {
    expect(hintFromInput({ file_path: 'a.ts' }, 'Read')).toEqual({ toolName: 'Read', path: 'a.ts' })
    expect(hintFromInput({ notebook_path: 'n.ipynb' }).path).toBe('n.ipynb')
    expect(hintFromInput({ path: 'b.py' }).path).toBe('b.py')
    expect(hintFromInput({ filePath: 'c.go' }).path).toBe('c.go')
    expect(hintFromInput({ file: 'd.rs' }).path).toBe('d.rs')
  })

  it('prefers file_path when a tool supplies more than one', () => {
    expect(hintFromInput({ path: 'b.py', file_path: 'a.ts' }).path).toBe('a.ts')
  })

  it('yields an empty hint for shapes that name nothing', () => {
    expect(hintFromInput(undefined)).toEqual({})
    expect(hintFromInput(null)).toEqual({})
    expect(hintFromInput(['a.ts'])).toEqual({})
    expect(hintFromInput('a.ts')).toEqual({})
    expect(hintFromInput({ file_path: '' })).toEqual({})
    expect(hintFromInput({ file_path: 7 })).toEqual({})
    expect(hintFromInput({}, 42)).toEqual({})
  })

  it('indexes every tool_use in the body by id, ignoring malformed blocks', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x.ts' } }] },
      { role: 'user', content: 'not an array' },
      { role: 'assistant', content: [null, { type: 'tool_use' }, { type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Write', input: { file_path: 'y.py' } }] },
    ] as Array<{ content?: unknown }>
    const map = collectToolUseHints(messages)
    expect(map.size).toBe(2)
    expect(map.get('a')).toEqual({ toolName: 'Read', path: 'x.ts' })
    expect(map.get('b')).toEqual({ toolName: 'Write', path: 'y.py' })
  })

  it('carries the tool_use path across to the tool_result it answers', () => {
    // Body-heavy source: too little declaration density for the content sniffer to commit, so the
    // path is the ONLY thing that can identify it. Same bytes both ways — only the path differs.
    const sparse = sparseTs()
    const withPath = resultOf(rewriteMessagesBody(bodyFor(sparse, { file_path: 'src/sparse.ts' })).body)
    const noPath = resultOf(rewriteMessagesBody(bodyFor(sparse, { pattern: '*' }, 'Grep')).body)
    expect(withPath).toContain('export async function only2')
    expect(noPath).not.toContain('export async function only2')
    expect(withPath).not.toBe(noPath)
  })

  it('outlines what the agent WROTE, using the Write block\'s own file_path', () => {
    const src = tsFile(8)
    const body = JSON.stringify({
      model: 'claude-x',
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu0', name: 'Write', input: { file_path: 'src/out.ts', content: src } }],
      }],
    })
    const r = rewriteMessagesBody(body)
    expect(r.changed).toBe(true)
    const written = (JSON.parse(r.body) as {
      messages: Array<{ content: Array<{ input: { content: string; file_path: string } }> }>
    }).messages[0].content[0].input
    expect(written.file_path).toBe('src/out.ts') // the path itself is never touched
    expect(written.content).toContain('export async function handler7')
    expect(written.content).not.toContain('const step7 = await readFile')
    expect(r.stats.tuOrigChars).toBe(src.length)
  })
})

describe('cache safety', () => {
  it('is byte-stable: the same body compresses to the same bytes every time', () => {
    const body = bodyFor(tsFile(8), { file_path: 'src/handlers.ts' })
    const a = rewriteMessagesBody(body)
    const b = rewriteMessagesBody(body)
    expect(a.body).toBe(b.body)
    expect(a.stashes.map((s) => s.token)).toEqual(b.stashes.map((s) => s.token))
  })

  it('keeps an unchanged prefix byte-identical when a NEW turn is appended', () => {
    const first = bodyFor(tsFile(8), { file_path: 'src/handlers.ts' })
    const grown = JSON.parse(first) as { messages: unknown[] }
    grown.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'next turn' }] })
    const before = rewriteMessagesBody(first).body
    const after = rewriteMessagesBody(JSON.stringify(grown)).body
    const prefix = (JSON.parse(before) as { messages: unknown[] }).messages
    const grownPrefix = (JSON.parse(after) as { messages: unknown[] }).messages.slice(0, prefix.length)
    expect(JSON.stringify(grownPrefix)).toBe(JSON.stringify(prefix))
  })

  it('leaves a body it cannot round-trip losslessly completely alone', () => {
    // An integer past 2^53 anywhere in the body — reserialising would silently corrupt it.
    const raw = `{"model":"claude-x","seq":12345678901234567890,"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu0","content":${JSON.stringify(tsFile(8))}}]}]}`
    const r = rewriteMessagesBody(raw)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(raw)
  })

  it('never grows a block: every routed path is shrink-only', () => {
    const cases = [
      'short',
      'x'.repeat(500),
      Array.from({ length: 40 }, (_, i) => `plain line ${i}`).join('\n'),
      JSON.stringify({ a: 1, b: [1, 2, 3] }),
      tsFile(1),
      tsFile(8),
      `{"id":12345678901234567890,"pad":"${'z'.repeat(600)}"}`,
    ]
    for (const c of cases) {
      for (const hint of [undefined, { path: 'a.ts' }, { path: 'a.py' }, { path: 'a.json' }]) {
        expect(compactToolText(c, hint).text.length).toBeLessThanOrEqual(c.length)
      }
    }
  })

  it('exposes the structured budget as a multiple of the user mode, not a constant', () => {
    expect(STRUCT_WINDOW_SCALE).toBeGreaterThan(1)
    const src = tsFile(60) // big enough that the outline itself overruns the budget
    setWireWindow({ headLines: 12, tailLines: 6, maxChars: 1000 })
    const at1x = compactToolText(src, { path: 'a.ts' }).text.length
    setWireWindow({ headLines: 24, tailLines: 12, maxChars: 2000 })
    const at2x = compactToolText(src, { path: 'a.ts' }).text.length
    expect(at2x).toBeGreaterThan(at1x)
  })
})
