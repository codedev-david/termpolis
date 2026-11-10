// v1.58.0 Codex effort per message: the supervisor's frames and the base URL a Codex terminal gets.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  setProxySpawner, startProxy, setProxyEnabled, _resetProxyForTest,
  onProxyCodexTurn, setProxyCodexRoute, forgetProxyCodexTerminal, codexProxyBaseUrl, CODEX_ROUTING_ENV, type ProxyCodexTurnMsg,
} from '../../src/main/headroomProxy/proxySupervisor'

let posted: Array<Record<string, unknown>> = []
let fire: (m: unknown) => void = () => {}
let throwOnPost = false

function spawner(): unknown {
  return {
    postMessage: (m: Record<string, unknown>) => {
      if (throwOnPost && m.kind !== 'init') throw new Error('child gone')
      posted.push(m)
      if (m.kind === 'init') fire({ kind: 'ready', port: m.port })
    },
    onMessage: (cb: (m: unknown) => void) => { fire = cb },
    onExit: () => {},
    kill: () => {},
    pid: 1,
  }
}

beforeEach(() => { _resetProxyForTest(); posted = []; throwOnPost = false; setProxySpawner(spawner) })

describe('Codex frames', () => {
  it('posts codex-route and codex-forget to the child, and never throws without one', () => {
    setProxyCodexRoute('t1', 1, 'low') // no child yet: dropped
    forgetProxyCodexTerminal('t1')
    startProxy({ port: 9999 })
    setProxyCodexRoute('t1', 2, 'high')
    setProxyCodexRoute('t1', 3, null)
    forgetProxyCodexTerminal('t1')
    expect(posted.filter((m) => String(m.kind).startsWith('codex'))).toEqual([
      { kind: 'codex-route', terminal: 't1', key: 2, effort: 'high' },
      { kind: 'codex-route', terminal: 't1', key: 3, effort: null },
      { kind: 'codex-forget', terminal: 't1' },
    ])
    throwOnPost = true
    expect(() => { setProxyCodexRoute('t1', 4, 'low'); forgetProxyCodexTerminal('t1') }).not.toThrow()
  })

  it('hands a codex-turn from the child to the consumer, and survives a throwing or missing one', () => {
    const got: ProxyCodexTurnMsg[] = []
    startProxy({ port: 9999 })
    fire({ kind: 'codex-turn', terminal: 't1', key: 1, task: 'x', asked: 'medium' }) // no consumer yet
    onProxyCodexTurn((q) => got.push(q))
    fire({ kind: 'codex-turn', terminal: 't1', key: 2, task: 'fix it', asked: 'medium' })
    expect(got).toEqual([{ kind: 'codex-turn', terminal: 't1', key: 2, task: 'fix it', asked: 'medium' }])
    onProxyCodexTurn(() => { throw new Error('boom') })
    expect(() => fire({ kind: 'codex-turn', terminal: 't1', key: 3, task: 'y', asked: 'low' })).not.toThrow()
    onProxyCodexTurn(null)
  })
})

describe('codexProxyBaseUrl', () => {
  it('is the prefixed proxy URL once the proxy is healthy', () => {
    expect(codexProxyBaseUrl('t1', {})).toBeNull() // not started
    startProxy({ port: 9999 })
    expect(codexProxyBaseUrl('term-1_a', {})).toBe('http://127.0.0.1:9999/termpolis-codex/term-1_a/backend-api/codex')
  })

  it('steps aside for a bad id, the switch off, or the user routing OpenAI traffic themselves', () => {
    startProxy({ port: 9999 })
    expect(codexProxyBaseUrl('bad id', {})).toBeNull()
    expect(codexProxyBaseUrl('x'.repeat(129), {})).toBeNull()
    for (const k of CODEX_ROUTING_ENV) expect(codexProxyBaseUrl('t1', { [k]: 'http://corp:8080' })).toBeNull()
    expect(codexProxyBaseUrl('t1', { HTTPS_PROXY: '  ' })).not.toBeNull()
    expect(CODEX_ROUTING_ENV).toEqual(expect.arrayContaining(['OPENAI_BASE_URL', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY']))
    setProxyEnabled(false)
    expect(codexProxyBaseUrl('t1', {})).toBeNull()
  })

  it('reads the process environment by default', () => {
    startProxy({ port: 9999 })
    const saved = process.env.OPENAI_BASE_URL
    process.env.OPENAI_BASE_URL = 'http://mine'
    try { expect(codexProxyBaseUrl('t1')).toBeNull() } finally { if (saved === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = saved }
  })
})
