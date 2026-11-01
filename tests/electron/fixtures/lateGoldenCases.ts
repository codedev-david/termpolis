/**
 * The synthetic request bodies behind tests/electron/headroomLateGoldens.test.ts.
 *
 * Everything here is a pure function of its arguments (no clock, no randomness beyond a seeded
 * generator), so the same case builds the same body on every machine and in every run. The golden
 * file beside it (lateGoldens.json) holds what the v1.54.4 implementation (942f2177) forwarded for
 * each body, as hashes. It was generated from that commit's source, not from the current tree, and
 * must never be regenerated from anything else: it exists so that "legacy is v1.54.4" and "late is
 * v1.54.4 from the floor up" are compared against something the new code did not write.
 */

export const TOOLS = ['Read', 'Bash', 'Grep', 'Glob', 'PowerShell', 'WebFetch', 'WebSearch'] as const
export type GoldenTool = (typeof TOOLS)[number]

export const KINDS = ['code', 'log', 'json', 'markdown', 'html'] as const
export type GoldenKind = (typeof KINDS)[number]

/** Either side of every edge that matters: the tier floor (1,600) and the late floor (40,000). */
export const SIZES = [1600, 5000, 20000, 39999, 40000, 40001, 80000] as const

/** The late floor, restated so a change to the source constant cannot move the goldens' meaning. */
export const FLOOR = 40_000

/**
 * The first user message of every single-result case. Its arm under the late policy is `late`
 * (the golden test asserts it), so the cases measure the policy and not the holdout.
 */
export const FIRST_MESSAGE = 'Look at the output of that last command and tell me what stands out.'

const pad2 = (n: number): string => String(Math.floor(n) % 100).padStart(2, '0')

function codeUnit(i: number): string {
  return [
    `export function compute${i}(input: number, scale = ${(i % 7) + 2}): number {`,
    `  // step ${i}: combine the input with the running total`,
    `  const total = input * scale + ${i}`,
    `  if (total > ${i * 31 + 100}) {`,
    `    return total - ${i}`,
    '  }',
    '  return total',
    '}',
    '',
  ].join('\n')
}
const logUnit = (i: number): string =>
  `2026-08-09T12:${pad2(i / 60)}:${pad2(i)}Z [info] task ${i} completed in ${i * 3}ms (worker ${i % 8})`
const markdownUnit = (i: number): string =>
  [
    `## Section ${i}`,
    '',
    `Paragraph about item ${i}. It has a few sentences so that the line is long enough to matter, and it keeps going a little.`,
    '',
    `- first point of ${i}`,
    `- second point of ${i}`,
    '',
  ].join('\n')
const htmlUnit = (i: number): string =>
  `<div class="row" id="r${i}"><span class="label">Item ${i}</span><a href="/items/${i}">details</a><p>Some text for item ${i} that sits inside a paragraph.</p></div>`

/** Repeat `unit(i)` until there are at least `chars` characters, then cut to exactly `chars`. */
function fit(unit: (i: number) => string, head: string, chars: number): string {
  let out = head
  for (let i = 0; out.length < chars; i++) out += unit(i) + '\n'
  return out.slice(0, chars)
}

/** A JSON array of objects of exactly `chars` characters, valid to the last one. */
function jsonOfLength(chars: number): string {
  const items: string[] = []
  let len = 2 // the brackets
  for (let i = 0; ; i++) {
    const item = JSON.stringify({ id: i, name: `item-${i}`, tags: ['a', 'b', 'c'], score: (i * 3) % 97, note: 'lorem ipsum dolor sit amet' })
    const add = item.length + (items.length > 0 ? 1 : 0)
    if (len + add + 40 > chars) break
    items.push(item)
    len += add
  }
  // The last element is padding that brings the total to exactly `chars`.
  const remaining = chars - len - (items.length > 0 ? 1 : 0)
  items.push(`{"pad":"${'p'.repeat(remaining - '{"pad":""}'.length)}"}`)
  return `[${items.join(',')}]`
}

/** Synthetic tool output of exactly `chars` characters, of the given shape. */
export function makeContent(kind: GoldenKind, chars: number): string {
  switch (kind) {
    case 'code': return fit(codeUnit, '', chars)
    case 'log': return fit(logUnit, '', chars)
    case 'json': return jsonOfLength(chars)
    case 'markdown': return fit(markdownUnit, '# Notes\n\n', chars)
    case 'html': return fit(htmlUnit, '<html><head><title>t</title></head><body>\n', chars)
  }
}

const PATHS: Record<GoldenKind, string> = {
  code: '/repo/src/app.ts', log: '/repo/build.log', json: '/repo/data.json', markdown: '/repo/NOTES.md', html: '/repo/index.html',
}

/** The tool_use input the call that produced this output would have carried. */
export function toolInput(tool: GoldenTool, kind: GoldenKind): Record<string, unknown> {
  switch (tool) {
    case 'Read': return { file_path: PATHS[kind] }
    case 'Bash': return { command: `cat ${PATHS[kind]}`, description: 'show the file' }
    case 'Grep': return { pattern: 'item', path: '/repo' }
    case 'Glob': return { pattern: '**/*.ts' }
    case 'PowerShell': return { command: `Get-Content ${PATHS[kind]}` }
    case 'WebFetch': return { url: 'https://example.com/page', prompt: 'summarise it' }
    case 'WebSearch': return { query: `item ${kind}` }
  }
}

export type ResultShape = 'string' | 'blocks'

/** A request that ran one tool and got `chars` characters of `kind` back. */
export function caseBody(tool: GoldenTool, kind: GoldenKind, chars: number, shape: ResultShape = 'string', firstMessage = FIRST_MESSAGE): string {
  const text = makeContent(kind, chars)
  return JSON.stringify({
    model: 'claude-opus-4',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: firstMessage },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: tool, input: toolInput(tool, kind) }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: shape === 'string' ? text : [{ type: 'text', text }] }] },
    ],
  })
}

export const caseId = (tool: GoldenTool, kind: GoldenKind, chars: number, shape: ResultShape = 'string'): string =>
  `${tool}/${kind}/${chars}${shape === 'blocks' ? '/blocks' : ''}`

export interface SingleCase { id: string; tool: GoldenTool; kind: GoldenKind; chars: number; shape: ResultShape }

/** Every tool x kind x size as a plain string result, and the block form for Bash. */
export function singleCases(): SingleCase[] {
  const out: SingleCase[] = []
  for (const tool of TOOLS) for (const kind of KINDS) for (const chars of SIZES) out.push({ id: caseId(tool, kind, chars), tool, kind, chars, shape: 'string' })
  for (const kind of KINDS) for (const chars of SIZES) out.push({ id: caseId('Bash', kind, chars, 'blocks'), tool: 'Bash', kind, chars, shape: 'blocks' })
  return out
}

// --- whole conversations -----------------------------------------------------------------------

type Msg = Record<string, unknown>
const call = (id: string, name: string, input: Record<string, unknown>): Msg =>
  ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] })
const result = (id: string, content: unknown): Msg =>
  ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] })
const envelope = (messages: Msg[]): string => JSON.stringify({ model: 'claude-opus-4', max_tokens: 1024, messages })

const srcFile = (tag: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `  export const ${tag}${i} = compute(${i}) // a representative source line with real length`).join('\n')
const cmdOutput = (n: number): string =>
  Array.from({ length: n }, (_, i) => `2026-08-09T12:00:${pad2(i)}Z [info] task ${i} completed in ${i * 3}ms (worker ${i % 8})`).join('\n')

/** Read, run, write, read again, repeat: exact repeats, near repeats and bulk tool_use input. */
export function realistic(first: string): string {
  const fileA = srcFile('a', 220)
  const fileAEdited = fileA.replace('export const a7 =', 'export const a7 = /* patched */')
  const fileB = srcFile('b', 180)
  return envelope([
    { role: 'user', content: first },
    call('r1', 'Read', { file_path: '/repo/src/a.ts' }), result('r1', fileA),
    call('r2', 'Bash', { command: 'npm test' }), result('r2', cmdOutput(300)),
    call('r3', 'Read', { file_path: '/repo/src/b.ts' }), result('r3', fileB),
    call('w1', 'Write', { file_path: '/repo/src/a.ts', content: fileAEdited }), result('w1', 'File written successfully.'),
    call('r4', 'Read', { file_path: '/repo/src/a.ts' }), result('r4', fileAEdited),
    call('r5', 'Read', { file_path: '/repo/src/b.ts' }), result('r5', fileB),
    call('r6', 'Bash', { command: 'npm run build' }), result('r6', cmdOutput(400)),
    call('t1', 'Task', { description: 'audit', prompt: srcFile('brief', 200) }), result('t1', 'Subagent finished.'),
    { role: 'assistant', content: [{ type: 'text', text: 'Done: the build is green.' }] },
  ])
}

/** A big file read, edited twice, read again after each edit and once unchanged, with a huge log. */
export function editLoop(first: string): string {
  const v1 = srcFile('m', 600) // about 52k characters
  const v2 = v1.replace('export const m10 =', 'export const m10 = /* one */')
  const small1 = srcFile('s', 90) // about 8k
  const small2 = small1.replace('export const s3 =', 'export const s3 = /* two */')
  // About 21k with forty lines rewritten: a patch (about 7k) clearly beats the whole file but is
  // far longer than the 1.1k window the file would otherwise be shortened to.
  const mid1 = srcFile('q', 250)
  const mid2 = mid1.split('\n').map((l, i) => (i >= 100 && i < 140 ? `${l} // edited` : l)).join('\n')
  return envelope([
    { role: 'user', content: first },
    call('e1', 'Read', { file_path: '/repo/src/big.ts' }), result('e1', v1),
    call('e2', 'Read', { file_path: '/repo/src/small.ts' }), result('e2', small1),
    call('e3', 'Edit', { file_path: '/repo/src/big.ts', old_string: 'export const m10 =', new_string: 'export const m10 = /* one */' }), result('e3', 'The file has been updated.'),
    call('e4', 'Read', { file_path: '/repo/src/big.ts' }), result('e4', v2),
    call('e5', 'Edit', { file_path: '/repo/src/small.ts', old_string: 'export const s3 =', new_string: 'export const s3 = /* two */' }), result('e5', 'The file has been updated.'),
    call('e6', 'Read', { file_path: '/repo/src/small.ts' }), result('e6', small2),
    call('e7', 'Read', { file_path: '/repo/src/small.ts' }), result('e7', small2),
    call('e8', 'Bash', { command: 'cat build.log' }), result('e8', cmdOutput(700)),
    call('e9', 'Read', { file_path: '/repo/src/mid.ts' }), result('e9', mid1),
    call('e10', 'Read', { file_path: '/repo/src/mid.ts' }), result('e10', mid2),
  ])
}

const CYCLE = [700, 2000, 5000, 12_000, 30_000, 45_000, 90_000]
const CYCLE_TOOLS = ['Read', 'Bash', 'Grep', 'Bash', 'Read', 'PowerShell', 'WebFetch']

/** `pairs` tool calls with results whose sizes cycle through every band, 1 + 2 x pairs messages. */
export function longRun(first: string, pairs: number): string {
  const msgs: Msg[] = [{ role: 'user', content: first }]
  for (let k = 0; k < pairs; k++) {
    const size = CYCLE[k % CYCLE.length]
    const tool = CYCLE_TOOLS[k % CYCLE_TOOLS.length]
    // Different text per call, so nothing collapses as a repeat and every result is judged on its
    // own, and exactly `size` characters long so the bands are the ones the case names.
    const text = `run ${k}\n${cmdOutput(Math.ceil(size / 50))}`.slice(0, size)
    msgs.push(call(`k${k}`, tool, tool === 'Read' ? { file_path: `/repo/f${k}.log` } : { command: `step ${k}` }))
    msgs.push(result(`k${k}`, text))
  }
  return envelope(msgs)
}

/** Results with harness reminders in them, which ride through untouched around the compacted text. */
function reminders(first: string): string {
  const reminder = '<system-reminder>\nThe task tools have not been used recently. Consider using them to track progress.\n</system-reminder>'
  return envelope([
    { role: 'user', content: first },
    call('m1', 'Read', { file_path: '/repo/src/a.ts' }), result('m1', `${srcFile('a', 700)}\n${reminder}`),
    call('m2', 'Bash', { command: 'ls' }), result('m2', [{ type: 'text', text: cmdOutput(900) }, { type: 'text', text: reminder }]),
    call('m3', 'Bash', { command: 'ls -la' }), result('m3', `${reminder}\n${cmdOutput(60)}`),
  ])
}

/** Memory, swarm and retrieve_full results are exempt at every size. */
function exempt(first: string): string {
  const big = srcFile('x', 700)
  return envelope([
    { role: 'user', content: first },
    call('x1', 'mcp__termpolis__memory_search', { query: 'q' }), result('x1', big),
    call('x2', 'mcp__termpolis__swarm_list_tasks', {}), result('x2', big),
    call('x3', 'mcp__termpolis__retrieve_full', { token: 'hr_0123456789abcdef' }), result('x3', big),
    call('x4', 'Read', { file_path: '/repo/src/y.ts' }), result('x4', big.replace('x0', 'y0')),
  ])
}

/** Text blocks beside an image block, a thinking block with its signature, and a bare text turn. */
function mixedBlocks(first: string): string {
  return envelope([
    { role: 'user', content: [{ type: 'text', text: first, cache_control: { type: 'ephemeral' } }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me look.', signature: 'c2lnbmF0dXJl' }, { type: 'tool_use', id: 'b1', name: 'Read', input: { file_path: '/repo/shot.png' } }] },
    result('b1', [{ type: 'text', text: cmdOutput(500) }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]),
    { role: 'assistant', content: [{ type: 'text', text: 'It looks fine.' }] },
    { role: 'user', content: 'Thanks. Now run the tests.' },
  ])
}

export interface ConversationCase {
  id: string
  body: string
  /** Prefix decay on or off for this case. */
  decay: boolean
  /** The tier the proxy ran at. */
  mode: 'conservative' | 'aggressive' | 'max'
}

export function conversationCases(first: string = FIRST_MESSAGE): ConversationCase[] {
  const out: ConversationCase[] = []
  const add = (id: string, body: string, decay = false, mode: ConversationCase['mode'] = 'aggressive'): void => { out.push({ id, body, decay, mode }) }
  for (const mode of ['aggressive', 'conservative', 'max'] as const) {
    add(`realistic/${mode}`, realistic(first), false, mode)
    add(`editLoop/${mode}`, editLoop(first), false, mode)
  }
  add('reminders', reminders(first))
  add('exempt', exempt(first))
  add('mixedBlocks', mixedBlocks(first))
  // 127 messages is the last length with no decay; 129 and 257 are the first past each boundary.
  for (const pairs of [63, 64, 128, 129]) {
    add(`longRun/${pairs}/decay`, longRun(first, pairs), true)
    add(`longRun/${pairs}/nodecay`, longRun(first, pairs), false)
  }
  add('longRun/64/decay/max', longRun(first, 64), true, 'max')
  add('longRun/64/decay/conservative', longRun(first, 64), true, 'conservative')
  return out
}

// --- what a case is reduced to for comparison --------------------------------------------------

/** The forwarded request of one rewrite, reduced to what the goldens pin. */
export interface Outcome {
  /** sha256 of the forwarded body. */
  body: string
  length: number
  changed: boolean
  stashes: number
  /** sha256 of the stash tokens in order: a token is a hash of the original it stands for. */
  tokens: string
}
