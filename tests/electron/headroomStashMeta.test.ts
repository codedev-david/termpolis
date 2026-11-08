import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as http from 'http'
import { DECAY_FIRST_THRESHOLD } from '../../src/main/headroomProxy/prefixDecay'
const { rewriteMessagesBody, setWireWindow } = await import('../../src/main/headroomProxy/wireCompress')
const { createProxyServer } = await import('../../src/main/headroomProxy/proxyMain')

/**
 * R1 criterion 3, the wire half: every original the proxy stashes now says what it was and how it
 * was replaced, so the main process can count elisions by class. The metadata must be a pure
 * function of the request body, like everything else this file computes, and must not move a
 * single byte of the body itself.
 */

const file = (n: number, edit?: [number, string]): string => {
  const out = Array.from({ length: n }, (_, i) => `  const value${i} = compute(${i}) // a reasonably long source line`)
  if (edit) out[edit[0]] = edit[1]
  return out.join('\n')
}

function bodyWith(texts: string[], opts: { tool?: string; model?: string | null } = {}): string {
  const messages: unknown[] = []
  texts.forEach((t, i) => {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu${i}`, name: opts.tool ?? 'Read', input: {} }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: t }] })
  })
  const body: Record<string, unknown> = { messages }
  if (opts.model !== null) body.model = opts.model ?? 'claude-x'
  return JSON.stringify(body)
}

const resultText = (body: string, idx: number): string => JSON.parse(body).messages[idx * 2 + 1].content[0].content

describe('stash metadata — first-sight compaction', () => {
  it('records the tool, the size removed and the size left, the model and the policy it ran under', () => {
    const big = file(60)
    const r = rewriteMessagesBody(bodyWith([big]))
    expect(r.stashes).toHaveLength(1)
    const view = resultText(r.body, 0)
    // A process that has been told no policy runs the old behaviour, which is the one it records.
    expect(r.stashes[0].meta).toEqual({ kind: 'compact', tool: 'Read', chars: big.length, view: view.length, model: 'claude-x', policy: 'legacy' })
    expect(view.length).toBeLessThan(big.length)
  })

  it('keeps the raw tool name, MCP namespace and all: folding into classes happens when counting', () => {
    const r = rewriteMessagesBody(bodyWith([file(60)], { tool: 'mcp__claude_ai_Gmail__get_message' }))
    expect(r.stashes[0].meta?.tool).toBe('mcp__claude_ai_Gmail__get_message')
  })

  it('has no tool when the result answers nothing in the body, and no model when the body names none', () => {
    const orphan = JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: file(60) }] }] })
    const m = rewriteMessagesBody(orphan).stashes[0].meta
    expect(m).toBeDefined()
    expect('tool' in (m as object)).toBe(false)
    expect('model' in (m as object)).toBe(false)
    expect('model' in (rewriteMessagesBody(bodyWith([file(60)], { model: null })).stashes[0].meta as object)).toBe(false)
  })

  it('measures the segment the compressor saw, not the harness reminder beside it', () => {
    const big = file(60)
    const reminder = '<system-reminder>\nMind the commit rules.\n</system-reminder>'
    const r = rewriteMessagesBody(bodyWith([`${big}\n${reminder}`]))
    expect(r.stashes).toHaveLength(1)
    expect(r.stashes[0].meta?.chars).toBe(big.length + 1) // the segment is everything before the reminder, newline included
    expect(resultText(r.body, 0)).toContain(reminder)
  })

  it('stashes nothing, and records nothing, for a result under the floor', () => {
    expect(rewriteMessagesBody(bodyWith(['short result'])).stashes).toEqual([])
  })
})

describe('stash metadata — duplicates and patches', () => {
  it('marks the repeat of an identical result as a dedup and its first sighting as a compaction', () => {
    const same = file(60)
    const r = rewriteMessagesBody(bodyWith([same, same]))
    expect(r.stashes.map((s) => s.meta?.kind)).toEqual(['compact', 'dedup'])
    expect(r.stashes[0].token).toBe(r.stashes[1].token) // one original, two sightings
    const stub = resultText(r.body, 1)
    expect(r.stashes[1].meta).toMatchObject({ kind: 'dedup', tool: 'Read', chars: same.length, view: stub.length })
  })

  describe('near-duplicates', () => {
    // A window wide enough that ordinary compaction does nothing, so this isolates the diff path.
    beforeEach(() => setWireWindow({ headLines: 5000, tailLines: 5000, maxChars: 1_000_000, floorChars: 0 }))
    afterEach(() => setWireWindow({ headLines: 12, tailLines: 6, maxChars: 1000, floorChars: 1600 }))

    it('marks a result sent as a patch against an earlier one as a diff', () => {
      const first = file(60)
      const second = file(60, [30, '  const value30 = compute(30) + 1 // EDITED'])
      const r = rewriteMessagesBody(bodyWith([first, second]))
      expect(r.stashes).toHaveLength(1)
      const patch = resultText(r.body, 1)
      expect(patch).toContain('except for the lines below')
      expect(r.stashes[0].meta).toMatchObject({ kind: 'diff', tool: 'Read', chars: second.length, view: patch.length })
    })
  })
})

describe('stash metadata — prefix decay', () => {
  const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `  const ${tag}${i} = compute(${i}) // a reasonably long source line`).join('\n')
  const convo = (n: number): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'assistant' : 'user',
    content: [i % 2 === 0
      ? { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `ls ${i}` } }
      : { type: 'tool_result', tool_use_id: `t${i - 1}`, content: lines(12, `r${i}`) }],
  }))

  it('records an aged-out result as a decay, with the tool that produced it', () => {
    const raw = JSON.stringify({ model: 'claude-x', messages: convo(DECAY_FIRST_THRESHOLD + DECAY_FIRST_THRESHOLD / 4) })
    const r = rewriteMessagesBody(raw, { decay: true })
    const decays = r.stashes.filter((s) => s.meta?.kind === 'decay')
    expect(decays.length).toBeGreaterThan(0)
    for (const d of decays) {
      expect(d.meta?.tool).toBe('Bash')
      expect(d.meta?.model).toBe('claude-x')
      expect(d.meta?.chars).toBe(d.original.length)
      expect(d.meta?.view).toBeLessThan(d.original.length)
    }
  })

  it('leaves a decayed result with no tool when nothing in the body answers for it', () => {
    const msgs = convo(DECAY_FIRST_THRESHOLD + DECAY_FIRST_THRESHOLD / 4).map((m) => {
      const c = (m.content as Array<Record<string, unknown>>)[0]
      return c.type === 'tool_use' ? { ...m, content: [{ type: 'text', text: 'working' }] } : m
    })
    const r = rewriteMessagesBody(JSON.stringify({ messages: msgs }), { decay: true })
    const decays = r.stashes.filter((s) => s.meta?.kind === 'decay')
    expect(decays.length).toBeGreaterThan(0)
    for (const d of decays) expect('tool' in (d.meta as object)).toBe(false)
  })
})

describe('stash metadata — purity', () => {
  it('is a function of the body alone: two runs give identical stashes and identical bytes', () => {
    const raw = bodyWith([file(60), file(60), file(60, [10, '  const value10 = EDITED'])])
    const a = rewriteMessagesBody(raw)
    const b = rewriteMessagesBody(raw)
    expect(b.body).toBe(a.body)
    expect(b.stashes).toEqual(a.stashes)
  })

  it('does not change the body: the metadata rides beside it', () => {
    const raw = bodyWith([file(60)])
    const r = rewriteMessagesBody(raw)
    expect(r.body).not.toContain('"meta"')
    expect(r.body).not.toContain('"view"')
  })
})

describe('stash metadata — across the process boundary', () => {
  let stub: http.Server, proxy: http.Server, proxyPort: number
  let posted: Array<{ token: string; original: string; meta?: unknown }> = []
  beforeAll(async () => {
    stub = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"type":"message_stop"}\n') }) })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
    proxy = createProxyServer({
      upstreamHost: '127.0.0.1', upstreamPort: (stub.address() as { port: number }).port, useHttps: false,
      onStash: (s) => { posted.push(...s) },
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
    proxyPort = (proxy.address() as { port: number }).port
  })
  afterAll(() => { stub.close(); proxy.close() })

  it('hands the metadata to the stash frame the child posts to the supervisor', async () => {
    posted = []
    const big = file(60)
    const body = bodyWith([big])
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve()) })
      req.on('error', reject); req.write(body); req.end()
    })
    expect(posted).toHaveLength(1)
    expect(posted[0].original).toBe(big)
    expect(posted[0].meta).toMatchObject({ kind: 'compact', tool: 'Read', chars: big.length, model: 'claude-x' })
  })
})
