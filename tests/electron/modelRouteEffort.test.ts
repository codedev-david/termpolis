// v1.57.0 per-message routing, the proxy's half: effort, subagents and struggling.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as http from 'http'
import {
  planRequest, setRoute, routeOf, routeTargetOf, noteRefused, readConversation, bodyEffort, withEffort,
  setAgentRoute, setAgentAsker, agentRouteOf, waitAgentRoute, _resetModelRouteForTests, ROUTE_HEADER,
  AGENT_WAIT_MS, STRUGGLE_ONE, STRUGGLE_TWO, ESCALATE_MAX_BODY, DEFAULT_MODEL_IDS, type AgentAsk, type ConvInfo,
} from '../../src/main/headroomProxy/modelRoute'
import { rewriteMessagesBody } from '../../src/main/headroomProxy/wireCompress'
const { createProxyServer, routeFields } = await import('../../src/main/headroomProxy/proxyMain')

const TOOLS = '"tools":[{"name":"Bash","input_schema":{}}]'
const msgs = (first: string): string => `"messages":[{"role":"user","content":${JSON.stringify(first)}}]`
const body = (model: string, opts: { first?: string; tail?: string } = {}): string =>
  `{"model":"${model}","max_tokens":10,${TOOLS},${msgs(opts.first ?? 'main task')}${opts.tail ?? ''}}`
const H = (terminal = 't', session = 's1'): Record<string, string> => ({ [ROUTE_HEADER]: terminal, 'x-claude-code-session-id': session })
const conv = (b: string): ConvInfo | null => readConversation(JSON.parse(b))

beforeEach(() => _resetModelRouteForTests())

describe('readConversation', () => {
  it('needs messages', () => {
    expect(readConversation(null)).toBeNull()
    expect(readConversation('x')).toBeNull()
    expect(readConversation({ messages: 'no' })).toBeNull()
  })

  it('keys the conversation by its first user message and reads the task past system reminders', () => {
    const c = readConversation({ messages: [
      null, { role: 'assistant', content: 'hi' },
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }, { type: 'text', text: '  grep the repo  ' }, 7, { type: 'image' }] },
    ] })!
    expect(c.task).toBe('grep the repo')
    expect(c.key).toBeGreaterThan(0)
    expect(c.continued).toBe(false)
    expect(c.human).toBe(2)
    expect(readConversation({ messages: [{ role: 'user', content: 'plain text task' }] })!.task).toBe('plain text task')
    expect(readConversation({ messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>only</system-reminder>' }] }] })!.task).toBe('')
    expect(readConversation({ messages: [{ role: 'user', content: 5 }] })!.task).toBe('')
    expect(readConversation({ messages: [] })).toMatchObject({ task: '', human: -1, struggle: 0 })
  })

  it('sees a compaction summary', () => {
    expect(readConversation({ messages: [{ role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' }] })!.continued).toBe(true)
  })

  it('counts the longest run of failing tool turns since the last typed message', () => {
    const fail = { role: 'user', content: [{ type: 'tool_result', is_error: true }] }
    const ok = { role: 'user', content: [{ type: 'tool_result' }] }
    const typed = { role: 'user', content: 'do it' }
    expect(readConversation({ messages: [typed, fail, fail, ok, fail] })).toMatchObject({ struggle: 2, human: 0 })
    // a typed message starts the count again
    expect(readConversation({ messages: [typed, fail, fail, fail, typed, fail] })).toMatchObject({ struggle: 1, human: 4 })
  })
})

describe('bodyEffort and withEffort', () => {
  it('reads the top-level effort at the end of the body only', () => {
    expect(bodyEffort('{"output_config":{"effort":"high"}}')).toBe('high')
    expect(bodyEffort('{"output_config":{"effort":"huge"}}')).toBeUndefined()
    expect(bodyEffort('{"a":1}')).toBeUndefined()
    expect(bodyEffort(`{"output_config":{"effort":"low"},"x":"${'y'.repeat(5000)}"}`)).toBeUndefined()
  })

  it('swaps an effort in place', () => {
    expect(withEffort('{"a":1,"output_config":{"effort":"high"}}', 'low')).toBe('{"a":1,"output_config":{"effort":"low"}}')
    expect(withEffort('{"output_config": { "format":{}, "effort" : "max" }}', 'medium')).toBe('{"output_config": { "format":{}, "effort" : "medium" }}')
  })

  it('adds the effort to an output_config without one', () => {
    expect(withEffort('{"a":1,"output_config":{"format":{"type":"json"}}}', 'xhigh')).toBe('{"a":1,"output_config":{"effort":"xhigh","format":{"type":"json"}}}')
    expect(withEffort('{"a":1,"output_config":{}}', 'low')).toBe('{"a":1,"output_config":{"effort":"low"}}')
  })

  it('adds an output_config to a body without one', () => {
    expect(withEffort('{"a":1}', 'low')).toBe('{"a":1,"output_config":{"effort":"low"}}')
    expect(withEffort('{"a":1}\n', 'low')).toBe('{"a":1,"output_config":{"effort":"low"}}\n')
    expect(withEffort('{ }', 'low')).toBe('{ "output_config":{"effort":"low"}}')
  })

  it('declines what it cannot edit safely', () => {
    expect(withEffort('not json', 'low')).toBeNull()
    expect(withEffort(`{"output_config":{"effort":"low"},"x":"${'y'.repeat(5000)}"}`, 'high')).toBeNull()
    expect(withEffort('{"output_config":{"effort":"weird-value-xx"}}', 'high')).toBeNull() // an effort it cannot read
    expect(withEffort('{"output_config":"oops"}', 'high')).toBeNull()
  })
})

describe('planRequest: effort', () => {
  it('writes the route\'s effort into a main request, and reports both sides', () => {
    setRoute('t', null, 'low')
    expect(routeOf('t')).toBeUndefined()
    expect(routeTargetOf('t')).toEqual({ family: null, effort: 'low' })
    const b = body('claude-opus-5-5', { tail: ',"output_config":{"effort":"high"}' })
    const p = planRequest(b, H(), conv(b))
    expect(p).toMatchObject({ asked: 'opus', used: 'opus', main: true, askedEffort: 'high', effort: 'low', modelChanged: false, effortChanged: true, original: b })
    expect(p.body).toContain('"effort":"low"')
    expect(p.escalated).toBeUndefined()
  })

  it('writes nothing when the route\'s effort is the level the request runs at', () => {
    setRoute('t', null, 'medium') // opus default
    const b = body('claude-opus-5-5')
    const p = planRequest(b, H(), conv(b))
    expect(p.original).toBeUndefined()
    expect(p.body).toBe(b)
  })

  it('a model switch with no effort takes the new model\'s default', () => {
    setRoute('t', 'sonnet')
    const b = body('claude-opus-5-5', { tail: ',"output_config":{"effort":"max"}' })
    const p = planRequest(b, H(), conv(b))
    expect(p).toMatchObject({ used: 'sonnet', effort: 'high', modelChanged: true, effortChanged: true })
    expect(p.body).toContain(`"model":"${DEFAULT_MODEL_IDS.sonnet}"`)
  })

  it('a routed pane with nothing to change sends the body as it came', () => {
    setRoute('t', null, null, true)
    expect(routeTargetOf('t')).toEqual({ family: null, effort: null })
    const b = body('claude-opus-5-5')
    expect(planRequest(b, H(), conv(b))).toMatchObject({ body: b, main: true })
    setRoute('t', null, null)
    expect(routeTargetOf('t')).toBeUndefined()
  })

  it('an effort it cannot place leaves the effort alone', () => {
    setRoute('t', 'haiku', 'low')
    const b = `{"model":"claude-opus-5-5",${TOOLS},"output_config":{"effort":"high"},${msgs('main')},"pad":"${'p'.repeat(5000)}"}`
    const p = planRequest(b, H(), null)
    expect(p).toMatchObject({ used: 'haiku', modelChanged: true, effortChanged: false })
    expect(p.effort).toBeUndefined() // the effort it names is too far in to read
  })

  it('a refused effort is not changed again for that terminal; a refused model keeps the effort', () => {
    setRoute('t', 'haiku', 'low')
    noteRefused('t', 'haiku', true)
    expect(routeTargetOf('t')).toEqual({ family: null, effort: 'low' })
    const b = body('claude-opus-5-5')
    expect(planRequest(b, H(), conv(b)).original).toBeUndefined()
    noteRefused('t', null, false) // nothing more to note
    noteRefused(null, null, true)
  })
})

describe('planRequest: subagents', () => {
  const ask = vi.fn<(q: AgentAsk) => void>()
  beforeEach(() => { ask.mockReset(); setAgentAsker(ask) })
  afterEach(() => setAgentAsker(null))

  function mainThenSub(sub = body('claude-opus-5-5', { first: 'find every caller of routePrompt', tail: ',"output_config":{"effort":"high"}' })) {
    setRoute('t', null, null, true)
    const m = body('claude-opus-5-5')
    expect(planRequest(m, H(), conv(m)).main).toBe(true)
    return { sub, c: conv(sub)! }
  }

  it('a subagent on the session\'s own model is told apart and asks main once', () => {
    const { sub, c } = mainThenSub()
    const p = planRequest(sub, H(), c)
    expect(p).toMatchObject({ main: false, agent: true, ask: { terminal: 't', key: c.key, task: 'find every caller of routePrompt', asked: 'opus', effort: 'high' } })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(agentRouteOf('t', c.key)).toBe('pending')
    // asked already: no second ask, nothing to apply yet
    const again = planRequest(sub, H(), c)
    expect(again.ask).toBeUndefined()
    expect(again).toMatchObject({ agent: true, body: sub })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('applies main\'s answer to every request of that subagent', () => {
    const { sub, c } = mainThenSub()
    planRequest(sub, H(), c)
    setAgentRoute('t', c.key, 'haiku', 'low')
    const p = planRequest(sub, H(), c)
    expect(p).toMatchObject({ agent: true, used: 'haiku', effort: 'low', modelChanged: true, effortChanged: true })
    expect(routeFields(p, Buffer.from(''))).toEqual({ terminal: 't', agent: true })
    // the main conversation is untouched
    const m = body('claude-opus-5-5')
    expect(planRequest(m, H(), conv(m)).original).toBeUndefined()
  })

  it('an answer to leave it alone, or an unrouted pane, sends the subagent as it came', () => {
    const { sub, c } = mainThenSub()
    planRequest(sub, H(), c)
    setAgentRoute('t', c.key, null, null, false)
    expect(agentRouteOf('t', c.key)).toEqual({ family: null, effort: null, off: true })
    expect(planRequest(sub, H(), c).original).toBeUndefined()
    setAgentRoute('t', c.key, 'haiku', null)
    setRoute('t', null, null) // the pane is no longer routed
    expect(planRequest(sub, H(), c)).toMatchObject({ agent: true, body: sub })
  })

  it('does not ask without an asker, a task, or a routed pane; an asker that throws is ignored', () => {
    const { sub, c } = mainThenSub(body('claude-opus-5-5', { first: '<system-reminder>x</system-reminder>' }))
    expect(c.task).toBe('')
    expect(planRequest(sub, H(), c).ask).toBeUndefined()
    _resetModelRouteForTests()
    const m2 = mainThenSub()
    setRoute('t', null, null)
    expect(planRequest(m2.sub, H(), m2.c).ask).toBeUndefined()
    setRoute('t', null, null, true)
    setAgentAsker(() => { throw new Error('gone') })
    expect(planRequest(m2.sub, H(), m2.c).ask).toBeDefined()
  })

  it('setAgentRoute validates its ids', () => {
    setAgentRoute('bad id!', 1, 'haiku', null)
    setAgentRoute(5, 1, 'haiku', null)
    setAgentRoute('t', 0, 'haiku', null)
    setAgentRoute('t', 1.5, 'haiku', null)
    setAgentRoute('t', '1', 'haiku', null)
    expect(agentRouteOf('t', 1)).toBeUndefined()
    setAgentRoute('t', 1, 'fable', 'huge')
    expect(agentRouteOf('t', 1)).toEqual({ family: null, effort: null })
  })

  it('waitAgentRoute resolves on the answer, on the timeout, or at once when nothing is pending', async () => {
    vi.useFakeTimers()
    try {
      const q: AgentAsk = { terminal: 't', key: 9, task: 'x', asked: 'opus', effort: null }
      await waitAgentRoute(q) // nothing pending
      const { sub, c } = mainThenSub()
      planRequest(sub, H(), c)
      const a: AgentAsk = { ...q, key: c.key }
      let done = 0
      void waitAgentRoute(a).then(() => { done++ })
      void waitAgentRoute(a).then(() => { done++ })
      setAgentRoute('t', c.key, 'sonnet', null)
      await vi.advanceTimersByTimeAsync(0)
      expect(done).toBe(2)
      // a second subagent nobody answers: the wait gives up after AGENT_WAIT_MS
      const other = body('claude-opus-5-5', { first: 'another task entirely' })
      const oc = conv(other)!
      planRequest(other, H(), oc)
      let late = false
      void waitAgentRoute({ ...q, key: oc.key }).then(() => { late = true })
      await vi.advanceTimersByTimeAsync(AGENT_WAIT_MS - 1)
      expect(late).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(late).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('compaction keeps the main conversation main under its new key', () => {
    setRoute('t', 'sonnet')
    const m = body('claude-opus-5-5')
    planRequest(m, H(), conv(m))
    const compacted = body('claude-opus-5-5', { first: 'This session is being continued from a previous conversation. Summary...' })
    expect(planRequest(compacted, H(), conv(compacted))).toMatchObject({ main: true, used: 'sonnet' })
    expect(planRequest(compacted, H(), conv(compacted)).main).toBe(true)
    // the old key is now a stranger
    expect(planRequest(m, H(), conv(m)).main).toBe(false)
    // a compaction summary on another model is a subagent
    const other = body('claude-haiku-5-5', { first: 'This session is being continued from a previous conversation. B' })
    expect(planRequest(other, H(), conv(other)).main).toBe(false)
  })

  it('without a key (a body too big to parse) the model tells them apart, and the key is learnt later', () => {
    setRoute('t', 'sonnet')
    const m = body('claude-opus-5-5')
    expect(planRequest(m, H(), null).main).toBe(true)
    expect(planRequest(body('claude-haiku-5-5'), H(), null)).toMatchObject({ main: false })
    expect(planRequest(body('claude-haiku-5-5'), H(), null).agent).toBeUndefined()
    expect(planRequest(m, H(), conv(m)).main).toBe(true) // same model, key learnt
    expect(planRequest(body('claude-opus-5-5', { first: 'other' }), H(), conv(body('claude-opus-5-5', { first: 'other' }))).main).toBe(false)
  })
})

describe('planRequest: struggling', () => {
  const fail = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'boom', is_error: true }] }
  const ok = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'fine' }] }
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] }
  const turns = (...rest: unknown[]) => ({ model: 'claude-sonnet-5-5', max_tokens: 10, tools: [{ name: 'Bash', input_schema: {} }], messages: [{ role: 'user', content: 'fix the build' }, ...rest] })
  const plan = (o: object, pad = '') => {
    const b = JSON.stringify(pad ? { ...o, pad } : o)
    return planRequest(b, H(), readConversation(JSON.parse(b)))
  }

  it('raises the effort one level after STRUGGLE_ONE failing turns, two after STRUGGLE_TWO, capped at xhigh', () => {
    setRoute('t', null, null, true)
    expect(STRUGGLE_ONE).toBe(2)
    expect(plan(turns(call, fail)).original).toBeUndefined()
    const one = plan(turns(call, fail, call, fail))
    expect(one).toMatchObject({ effort: 'xhigh', effortChanged: true, escalated: 1 }) // sonnet's default is high
    const two = plan(turns(...Array(STRUGGLE_TWO).fill([call, fail]).flat()))
    expect(two).toMatchObject({ effort: 'xhigh', escalated: 1 }) // capped
    expect(routeFields(two, Buffer.from(''))).toMatchObject({ escalated: 1, main: true })
  })

  it('from a low route it climbs two levels', () => {
    setRoute('t', null, 'low')
    expect(plan(turns(...Array(STRUGGLE_TWO).fill([call, fail]).flat()))).toMatchObject({ escalated: 2 }) // low + 2 = high, the level sonnet runs at with nothing written
  })

  it('stays raised until the next typed message, even once the calls succeed', () => {
    setRoute('t', null, 'medium')
    expect(plan(turns(call, fail, call, fail)).escalated).toBe(1)
    expect(plan(turns(call, fail, call, fail, call, ok)).escalated).toBe(1)
    expect(plan(turns(call, fail, call, fail, call, ok, { role: 'user', content: 'thanks, next' })).escalated).toBeUndefined()
  })

  it('a body past the limit is not raised, but a raise already made holds', () => {
    setRoute('t', null, 'medium')
    expect(plan(turns(call, fail, call, fail), 'x'.repeat(ESCALATE_MAX_BODY)).escalated).toBeUndefined()
    expect(plan(turns(call, fail, call, fail)).escalated).toBe(1)
    expect(plan(turns(call, fail, call, fail, call, fail, call, fail), 'x'.repeat(ESCALATE_MAX_BODY)).escalated).toBe(1)
  })

  it('no conversation key: no raise', () => {
    setRoute('t', null, 'medium')
    const b = JSON.stringify(turns(call, fail, call, fail))
    expect(planRequest(b, H(), { key: 0, task: '', continued: false, struggle: 9, human: 0 }).escalated).toBeUndefined()
  })
})

describe('wireCompress hands the parsed body to a reader', () => {
  it('calls inspect once with the parsed body, and survives one that throws', () => {
    const raw = body('claude-opus-5-5')
    const seen: unknown[] = []
    rewriteMessagesBody(raw, { inspect: (o) => seen.push(o) })
    expect(seen).toEqual([JSON.parse(raw)])
    expect(() => rewriteMessagesBody(raw, { inspect: () => { throw new Error('reader') } })).not.toThrow()
    rewriteMessagesBody('{"x":1}', { inspect: (o) => seen.push(o) })
    rewriteMessagesBody('nope', { inspect: (o) => seen.push(o) })
    expect(seen).toHaveLength(1)
  })
})

describe('the proxy routes effort and subagents', () => {
  const SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":5000,"cache_creation_input_tokens":40}}}',
    '', 'event: message_stop', 'data: {"type":"message_stop"}', '',
  ].join('\n')
  let stub: http.Server, proxy: http.Server, port: number
  let seen: string[] = []
  let refuse: (b: string) => boolean = () => false
  let results: Array<Record<string, unknown>> = []

  beforeEach(async () => {
    seen = []; results = []; refuse = () => false
    stub = http.createServer((req, res) => {
      const c: Buffer[] = []
      req.on('data', (d) => c.push(d))
      req.on('end', () => {
        const b = Buffer.concat(c).toString('utf8')
        seen.push(b)
        if (refuse(b)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"effort"}'); return }
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE)
      })
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
    proxy = createProxyServer({
      upstreamHost: '127.0.0.1', upstreamPort: (stub.address() as { port: number }).port, useHttps: false,
      onResult: (r) => results.push(r as unknown as Record<string, unknown>),
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
    port = (proxy.address() as { port: number }).port
  })
  afterEach(() => { stub.close(); proxy.close(); setAgentAsker(null) })

  function post(b: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
      req.on('error', reject); req.write(b); req.end()
    })
  }

  it('sends the routed effort and reports it', async () => {
    setRoute('t1', null, 'low')
    expect(await post(body('claude-opus-5-5'), H('t1'))).toBe(200)
    expect(seen[0]).toContain('"output_config":{"effort":"low"}')
    expect(results[0]).toMatchObject({ terminal: 't1', main: true, model: 'opus', effort: 'low' })
  })

  it('a refused effort is retried as asked and not changed again', async () => {
    setRoute('t1', null, 'low')
    refuse = (s) => s.includes('"effort":"low"')
    const b = body('claude-opus-5-5', { tail: ',"output_config":{"effort":"high"}' })
    expect(await post(b, H('t1'))).toBe(200)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toContain('"effort":"high"')
    expect(results[0]).toMatchObject({ model: 'opus', effort: 'high' })
    expect(results[0].refused).toBeUndefined() // the model was not changed
    seen = []
    expect(await post(b, H('t1'))).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('"effort":"high"')
  })

  it('a subagent\'s first request waits for main\'s answer and goes out on it', async () => {
    setRoute('t1', null, null, true)
    setAgentAsker((q) => { setTimeout(() => setAgentRoute(q.terminal, q.key, 'haiku', 'low'), 5) })
    expect(await post(body('claude-opus-5-5'), H('t1'))).toBe(200)
    expect(await post(body('claude-opus-5-5', { first: 'list the test files' }), H('t1'))).toBe(200)
    expect(seen[1]).toContain(`"model":"${DEFAULT_MODEL_IDS.haiku}"`)
    expect(seen[1]).toContain('"effort":"low"')
    expect(results[1]).toMatchObject({ terminal: 't1', agent: true, model: 'haiku', effort: 'low' })
    expect(results[1].main).toBeUndefined()
  })
})
