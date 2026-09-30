import { describe, it, expect, vi } from 'vitest'

/**
 * The proxy never rewrites a tool_use input — any field, any tool, any tier, any age.
 *
 * A tool_use input is the model's own authored intent, and it replays those bytes as a template on
 * later turns: an elision marker left in a subagent prompt, a SendMessage body or a Workflow script
 * is copied forward into the next prompt, message or script. The artifact fields are still read,
 * but only to index them as dedup keys for the tool_results that later repeat them.
 *
 * Every tier runs in a FRESH module: setWireWindow resolves the compaction floor once per module
 * instance, so reusing one module would silently test every tier at the first tier's floor.
 */

type Mode = 'conservative' | 'balanced' | 'aggressive' | 'max'
const MODES: Mode[] = ['conservative', 'balanced', 'aggressive', 'max']

type Wire = typeof import('../../src/main/headroomProxy/wireCompress')
type Decay = typeof import('../../src/main/headroomProxy/prefixDecay')

async function modulesFor(mode: Mode): Promise<{ wire: Wire; decay: Decay; floorChars: number }> {
  vi.resetModules()
  const wire = await import('../../src/main/headroomProxy/wireCompress')
  const decay = await import('../../src/main/headroomProxy/prefixDecay')
  const win = wire.windowForMode(mode)
  if (!win) throw new Error(`no wire window for ${mode}`)
  wire.setWireWindow(win)
  return { wire, decay, floorChars: win.floorChars }
}

/** Line-shaped text of at least `chars` characters — the shape every tier windows as a tool_result. */
const prose = (tag: string, chars: number): string => {
  const out: string[] = []
  let len = 0
  for (let i = 0; len < chars; i++) {
    const line = `${tag} ${i}: the agent authored this line itself and replays it on a later turn.`
    out.push(line)
    len += line.length + 1
  }
  return out.join('\n')
}

const script = (chars: number): string => {
  const out: string[] = []
  let len = 0
  for (let i = 0; len < chars; i++) {
    const line = `  await runStep('step-${i}', { retries: 3, timeoutMs: ${1000 + i} }) // workflow step ${i}`
    out.push(line)
    len += line.length + 1
  }
  return out.join('\n')
}

interface ToolUse { id: string; name?: string; input: Record<string, unknown> }

/** Authored tool_use inputs that are NOT artifact fields — each would have been compressed before. */
const authored = (): ToolUse[] => [
  { id: 'a1', name: 'Agent', input: { description: 'audit the proxy', subagent_type: 'general-purpose', prompt: prose('prompt', 12_000) } },
  { id: 's1', name: 'SendMessage', input: { to: 'reviewer', message: prose('message', 8_000) } },
  { id: 'w1', name: 'Workflow', input: { name: 'release', script: script(8_000) } },
  { id: 'g1', name: 'mcp__github__create_issue', input: { owner: 'o', repo: 'r', title: 'Proxy rewrote a prompt', body: prose('issue', 8_000) } },
  { id: 'd1', name: 'TaskCreate', input: { subject: 'follow-up', description: prose('desc', 5_000) } },
]

const use = (b: ToolUse): Record<string, unknown> => ({ role: 'assistant', content: [{ type: 'tool_use', ...b }] })
const result = (id: string, content: string): Record<string, unknown> =>
  ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] })
const body = (messages: Array<Record<string, unknown>>): string => JSON.stringify({ model: 'claude-x', messages })

/** Every tool_use input in a body, serialized, keyed by block id. */
const inputsOf = (raw: string): Map<string, string> => {
  const map = new Map<string, string>()
  for (const m of (JSON.parse(raw) as { messages: Array<{ content?: unknown }> }).messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content as Array<{ type?: string; id?: string; input?: unknown }>) {
      if (b.type === 'tool_use' && typeof b.id === 'string') map.set(b.id, JSON.stringify(b.input))
    }
  }
  return map
}

const authoredStrings = (): Set<string> =>
  new Set(authored().flatMap((b) => Object.values(b.input)).filter((v): v is string => typeof v === 'string'))

/** A live conversation: a big tool_result that DOES compress, then every authored tool_use. */
const liveBody = (): string => body([
  use({ id: 'r0', name: 'Read', input: { file_path: '/repo/build.log' } }),
  result('r0', prose('log', 12_000)),
  ...authored().flatMap((b) => [use(b), result(b.id, 'ok')]),
])

/** The same tool_use blocks at the very start of a conversation long enough for them to age out. */
const agedBody = (length: number): string => {
  const messages: Array<Record<string, unknown>> = [
    ...authored().flatMap((b) => [use(b), result(b.id, 'ok')]),
    use({ id: 'r0', name: 'Read', input: { file_path: '/repo/old.log' } }),
    result('r0', prose('old', 3_000)),
  ]
  while (messages.length < length) messages.push({ role: 'user', content: [{ type: 'text', text: 'filler' }] })
  return body(messages)
}

describe.each(MODES)('tool_use input is never rewritten — %s tier', (mode) => {
  it('would compress every one of these fields as a tool_result, so the rest of this block is not vacuous', async () => {
    const { wire, floorChars } = await modulesFor(mode)
    let checked = 0
    for (const v of authoredStrings()) {
      if (v.length < floorChars) continue
      const out = JSON.parse(wire.rewriteMessagesBody(body([result('x', v)])).body).messages[0].content[0].content as string
      expect(out.length).toBeLessThan(v.length)
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(4)
  })

  it('forwards every tool_use input byte-identical through rewriteMessagesBody', async () => {
    const { wire } = await modulesFor(mode)
    const raw = liveBody()
    const r = wire.rewriteMessagesBody(raw)
    expect(r.changed).toBe(true) // the body WAS rewritten — the build log shrank
    expect(inputsOf(r.body)).toEqual(inputsOf(raw))
    expect(inputsOf(raw).size).toBe(authored().length + 1)
    expect([r.stats.tuBlocks, r.stats.tuOrigChars, r.stats.tuCompChars]).toEqual([0, 0, 0])
    const fields = authoredStrings()
    expect(r.stashes.filter((s) => fields.has(s.original))).toEqual([])
  })

  it('leaves a field whole even when it repeats, or nearly repeats, an earlier tool_result', async () => {
    // The dedup/diff path: a field identical to an earlier tool_result used to collapse to an
    // "Identical to an earlier tool result" marker, and a near-duplicate to a diff against it.
    const { wire } = await modulesFor(mode)
    const shared = prose('shared', 12_000)
    const near = shared.replace('shared 7:', 'shared 7 (edited):')
    const raw = body([
      use({ id: 'r0', name: 'Read', input: { file_path: '/repo/notes.md' } }),
      result('r0', shared),
      use({ id: 'a1', name: 'Agent', input: { description: 'forward it', prompt: shared } }),
      result('a1', 'ok'),
      use({ id: 's1', name: 'SendMessage', input: { to: 'reviewer', message: near } }),
      result('s1', 'ok'),
    ])
    const r = wire.rewriteMessagesBody(raw)
    expect(inputsOf(r.body)).toEqual(inputsOf(raw))
    expect([r.stats.tuBlocks, r.stats.tuOrigChars, r.stats.tuCompChars]).toEqual([0, 0, 0])
  })

  it('forwards every tool_use input byte-identical after prefix decay at an old age', async () => {
    const { wire, decay } = await modulesFor(mode)
    const raw = agedBody(decay.DECAY_FIRST_THRESHOLD * 2)
    const r = wire.rewriteMessagesBody(raw, { decay: true })
    expect(r.body).toContain('Aged out') // decay DID run — the old build log became a stub
    expect(inputsOf(r.body)).toEqual(inputsOf(raw))
    expect([r.stats.tuBlocks, r.stats.tuOrigChars, r.stats.tuCompChars]).toEqual([0, 0, 0])
  })

  it('still dedups a tool_result that repeats a VERBATIM field, without touching the field', async () => {
    const { wire } = await modulesFor(mode)
    const content = prose('file', 12_000)
    const raw = body([
      use({ id: 'w1', name: 'Write', input: { file_path: '/repo/a.md', content } }),
      result('w1', 'File written successfully.'),
      use({ id: 'r1', name: 'Read', input: { file_path: '/repo/a.md' } }),
      result('r1', content),
    ])
    const parsed = JSON.parse(wire.rewriteMessagesBody(raw).body)
    expect(parsed.messages[0].content[0].input.content).toBe(content)
    expect(parsed.messages[3].content[0].content).toContain('Identical to an earlier tool result')
  })
})

describe('tool_use input is never rewritten — prefix decay on its own', () => {
  it('ages out only the old tool_result, and books nothing to the tool_use counters', async () => {
    const { decay } = await modulesFor('aggressive')
    const raw = agedBody(decay.DECAY_FIRST_THRESHOLD * 2)
    const messages = (JSON.parse(raw) as { messages: Array<{ content?: unknown }> }).messages
    const stashes: Array<{ token: string; original: string }> = []
    const counts = decay.applyPrefixDecay(messages, stashes)
    const after = JSON.stringify({ model: 'claude-x', messages })
    expect(inputsOf(after)).toEqual(inputsOf(raw))
    expect(counts.blocks).toBe(1)
    expect([counts.tuBlocks, counts.tuOrigChars, counts.tuCompChars]).toEqual([0, 0, 0])
    expect(stashes.map((s) => s.original)).toEqual([prose('old', 3_000)])
  })
})

describe('tool_use indexing — what the walk still reads', () => {
  it('indexes a nameless tool_use too: only a NAMED exempt tool stays out of the index', async () => {
    const { wire } = await modulesFor('aggressive')
    const content = prose('anon', 4_000)
    const raw = body([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'n1', input: { content } }] },
      result('n1', content),
    ])
    const parsed = JSON.parse(wire.rewriteMessagesBody(raw).body)
    expect(parsed.messages[0].content[0].input.content).toBe(content)
    expect(parsed.messages[1].content[0].content).toContain('Identical to an earlier tool result')
  })

  it('keeps an exempt tool out of the index, so its twin tool_result is not deduped against it', async () => {
    const { wire } = await modulesFor('aggressive')
    const content = prose('mem', 4_000)
    const raw = body([
      use({ id: 'm1', name: 'mcp__termpolis__memory_write', input: { content } }),
      result('m1', 'stored'),
      use({ id: 'r1', name: 'Read', input: { file_path: '/repo/mem.md' } }),
      result('r1', content),
    ])
    const parsed = JSON.parse(wire.rewriteMessagesBody(raw).body)
    expect(parsed.messages[0].content[0].input.content).toBe(content)
    expect(parsed.messages[3].content[0].content).not.toContain('Identical to an earlier tool result')
  })
})
