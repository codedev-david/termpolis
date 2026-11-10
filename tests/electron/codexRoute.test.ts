// v1.58.0 Codex effort per message, the proxy child's half (codexRoute.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as zlib from 'zlib'
import {
  codexTarget, decodeRequest, encodeRequest, bodyEffort, withEffort, countUserItems, lastTypedMessage,
  setCodexAsker, setCodexRoute, planCodexRequest, noteCodexRefused, forgetCodexTerminal, _resetCodexRouteForTests,
  UPGRADE_REFUSAL, MAX_PARSE_CHARS, type CodexAsk,
} from '../../src/main/headroomProxy/codexRoute'

const z = zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer; zstdDecompressSync: (b: Buffer) => Buffer }

type Item = Record<string, unknown>
const user = (...texts: string[]): Item => ({ type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) })
const ENV = '<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>'
/** A Responses body as Codex's serde writes it: compact, `reasoning` right after `parallel_tool_calls`. */
function body(items: Item[], effort: string | null = 'medium'): string {
  const reasoning = effort === null ? 'null' : `{"effort":"${effort}","summary":"auto"}`
  return `{"model":"gpt-5.5","instructions":"be helpful","input":${JSON.stringify(items)},"tools":[],"tool_choice":"auto","parallel_tool_calls":true,"reasoning":${reasoning},"store":false,"stream":true}`
}
const T = 'term-1'

describe('codexTarget', () => {
  it('maps a ChatGPT sign-in to chatgpt.com and an API key to api.openai.com', () => {
    expect(codexTarget(`/termpolis-codex/${T}/backend-api/codex/responses`, 'POST', {})).toEqual({
      terminal: T, host: 'chatgpt.com', path: '/backend-api/codex/responses', responses: true,
    })
    expect(codexTarget(`/termpolis-codex/${T}/backend-api/codex/responses`, 'POST', { authorization: 'Bearer sk-abc' })).toEqual({
      terminal: T, host: 'api.openai.com', path: '/v1/responses', responses: true,
    })
    expect(codexTarget(`/termpolis-codex/${T}/backend-api/codex/models?client_version=1`, 'GET', { authorization: ['Bearer eyJ'] })).toEqual({
      terminal: T, host: 'chatgpt.com', path: '/backend-api/codex/models?client_version=1', responses: false,
    })
    expect(codexTarget(`/termpolis-codex/${T}/backend-api/codex`, 'POST', {})?.path).toBe('/backend-api/codex')
    expect(codexTarget(`/termpolis-codex/${T}/backend-api/codex/responses`, 'GET', {})?.responses).toBe(false)
  })

  it('refuses any other path', () => {
    expect(codexTarget('/v1/messages', 'POST', {})).toBeNull()
    expect(codexTarget('/termpolis-codex/bad id/backend-api/codex/responses', 'POST', {})).toBeNull()
    expect(codexTarget('/termpolis-codex/t/v1/responses', 'POST', {})).toBeNull()
  })

  it('answers an upgrade with a 426', () => {
    expect(UPGRADE_REFUSAL.startsWith('HTTP/1.1 426 ')).toBe(true)
  })
})

describe('encoding', () => {
  it('round-trips plain and zstd bodies, and leaves any other encoding alone', () => {
    const text = body([user('hi')])
    expect(decodeRequest(Buffer.from(text), '')).toBe(text)
    expect(decodeRequest(Buffer.from(text), 'Identity')).toBe(text)
    const packed = encodeRequest(text, 'zstd')
    expect(z.zstdDecompressSync(packed).toString('utf8')).toBe(text)
    expect(decodeRequest(packed, 'ZSTD')).toBe(text)
    expect(encodeRequest(text, '').toString('utf8')).toBe(text)
    expect(decodeRequest(Buffer.from(text), 'gzip')).toBeNull()
    expect(decodeRequest(Buffer.from('not zstd'), 'zstd')).toBeNull()
  })
})

describe('body edits', () => {
  it('finds exactly one effort and swaps it in place', () => {
    const text = body([user('hi')], 'medium')
    expect(bodyEffort(text)?.effort).toBe('medium')
    const edited = withEffort(text, 'low')!
    expect(edited).toBe(text.replace('"effort":"medium"', '"effort":"low"'))
    expect(JSON.parse(edited).reasoning.effort).toBe('low')
  })

  it('leaves a body with no effort, a null one, two of them, or a bad pick', () => {
    expect(bodyEffort(body([user('hi')], null))).toBeNull()
    expect(withEffort(body([user('hi')], null), 'low')).toBeNull()
    const doubled = body([user('hi')]) + body([user('x')])
    expect(bodyEffort(doubled)).toBeNull()
    expect(withEffort(body([user('hi')]), 'LOW"')).toBeNull()
  })

  it('a quoted copy of the field inside a message is escaped, so it is never taken', () => {
    const text = body([user('"parallel_tool_calls":true,"reasoning":{"effort":"xhigh"}')], 'medium')
    expect(bodyEffort(text)?.effort).toBe('medium')
    expect(countUserItems(body([user('"role":"user"')]))).toBe(1)
  })

  it('counts user items and finds the last typed message, skipping what Codex adds itself', () => {
    const items = [user(ENV), user('# AGENTS.md instructions for /repo\n\nbe nice'), user('first ask'), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }, user('second ask', '<turn_aborted>x</turn_aborted>')]
    const text = body(items)
    expect(countUserItems(text)).toBe(4)
    expect(lastTypedMessage(text)).toBe('second ask')
    expect(lastTypedMessage(body([user(ENV)]))).toBeNull()
    expect(lastTypedMessage(body([{ type: 'message', role: 'user', content: 'plain' }, { type: 'function_call_output', call_id: 'c', output: 'x' }, null as unknown as Item]))).toBeNull()
    expect(lastTypedMessage(body([user('a', 'b')]))).toBe('a\nb')
    expect(lastTypedMessage('{"input":"nope"}')).toBeNull()
    expect(lastTypedMessage('not json')).toBeNull()
    expect(lastTypedMessage(' '.repeat(MAX_PARSE_CHARS + 1))).toBeNull()
  })
})

describe('planCodexRequest', () => {
  let asks: CodexAsk[]
  beforeEach(() => {
    _resetCodexRouteForTests()
    asks = []
    setCodexAsker((q) => asks.push(q))
  })

  it('asks main on a new typed message and sends the turn at its answer', async () => {
    const text = body([user(ENV), user('rename this variable')], 'medium')
    const pending = planCodexRequest(T, text, {}, 1000)
    await Promise.resolve()
    expect(asks).toEqual([{ terminal: T, key: 1, task: 'rename this variable', asked: 'medium' }])
    setCodexRoute(T, 1, 'low')
    const plan = await pending
    expect(plan).toEqual({ body: text.replace('"effort":"medium"', '"effort":"low"'), asked: 'medium', effort: 'low' })
    // The tool turns of the same message reuse the answer without asking again.
    const next = body([user(ENV), user('rename this variable'), { type: 'function_call_output', call_id: 'c', output: 'done' }], 'medium')
    expect((await planCodexRequest(T, next, {}, 1000))?.effort).toBe('low')
    expect(asks).toHaveLength(1)
  })

  it('sends as asked when main answers null, the same effort, or not in time', async () => {
    const a = planCodexRequest(T, body([user('one')]), {}, 1000)
    await Promise.resolve()
    setCodexRoute(T, 1, null)
    expect(await a).toBeNull()
    const b = planCodexRequest(T, body([user('one'), user('two')]), {}, 1000)
    await Promise.resolve()
    setCodexRoute(T, 2, 'medium')
    expect(await b).toBeNull()
    vi.useFakeTimers()
    try {
      const c = planCodexRequest(T, body([user('one'), user('two'), user('three')]), {}, 50)
      await vi.advanceTimersByTimeAsync(60)
      expect(await c).toBeNull()
    } finally { vi.useRealTimers() }
    // A late answer still routes the rest of that turn.
    setCodexRoute(T, 3, 'high')
    expect((await planCodexRequest(T, body([user('one'), user('two'), user('three'), { type: 'reasoning' }]), {}, 0))?.effort).toBe('high')
  })

  it('drops a stale or malformed answer, and an effort Codex does not take', async () => {
    const a = planCodexRequest(T, body([user('one')]), {}, 1000)
    await Promise.resolve()
    setCodexRoute(T, 99, 'low')
    setCodexRoute('bad id!', 1, 'low')
    setCodexRoute(T, '1', 'low')
    setCodexRoute(7, 1, 'low')
    setCodexRoute('other', 1, 'low')
    setCodexRoute(T, 1, 'max')
    expect(await a).toBeNull()
  })

  it('leaves subagent requests, bad ids, bodies without one effort, and runs without an asker', async () => {
    expect(await planCodexRequest(T, body([user('x')]), { 'x-openai-subagent': 'review' }, 0)).toBeNull()
    expect(await planCodexRequest('bad id!', body([user('x')]), {}, 0)).toBeNull()
    expect(await planCodexRequest(T, body([user('x')], null), {}, 0)).toBeNull()
    expect(asks).toHaveLength(0)
    setCodexAsker(null)
    expect(await planCodexRequest(T, body([user('y')]), {}, 0)).toBeNull()
    setCodexAsker(() => { throw new Error('gone') })
    expect(await planCodexRequest(T, body([user('y'), user('z')]), {}, 0)).toBeNull()
  })

  it('a resent message (same text, a new item count) asks nothing new', async () => {
    const a = planCodexRequest(T, body([user('same')]), {}, 1000)
    await Promise.resolve()
    setCodexRoute(T, 1, 'low')
    await a
    expect((await planCodexRequest(T, body([user(ENV), user('same')]), {}, 0))?.effort).toBe('low')
    expect(asks).toHaveLength(1)
  })

  it('a refused effort is not sent again: xhigh falls to high, then nothing; three refusals stop routing', async () => {
    const turn = async (n: number, effort: string): Promise<string | undefined> => {
      const items = Array.from({ length: n }, (_, i) => user(`ask ${i}`))
      const p = planCodexRequest(T, body(items), {}, 1000)
      await Promise.resolve()
      setCodexRoute(T, n, effort)
      return (await p)?.effort
    }
    expect(await turn(1, 'xhigh')).toBe('xhigh')
    noteCodexRefused(T, 'xhigh')
    expect(await turn(2, 'xhigh')).toBe('high')
    noteCodexRefused(T, 'high')
    expect(await turn(3, 'xhigh')).toBeUndefined()
    expect(await turn(4, 'low')).toBe('low')
    noteCodexRefused(T, 'low')
    expect(await planCodexRequest(T, body([user('more')]), {}, 0)).toBeNull()
    noteCodexRefused('never-seen', 'low') // no state: nothing to do
  })

  it('forgets a terminal, and keeps at most 256', async () => {
    const a = planCodexRequest(T, body([user('one')]), {}, 1000)
    await Promise.resolve()
    setCodexRoute(T, 1, 'low')
    await a
    forgetCodexTerminal(T)
    forgetCodexTerminal(5)
    // Fresh state: the same message is a new turn again.
    void planCodexRequest(T, body([user('one')]), {}, 0)
    await Promise.resolve()
    expect(asks.map((q) => q.key)).toEqual([1, 1])
    setCodexAsker(null)
    for (let i = 0; i < 300; i++) await planCodexRequest(`t${i}`, body([user('x')]), {}, 0)
    // t0 was evicted, so an answer for it finds nothing (and nothing throws).
    setCodexRoute('t0', 1, 'low')
  })
})
