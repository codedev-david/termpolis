/**
 * The `mcp:` IPC surface.
 *
 * The point of these tests is the pair of invariants the module exists to hold:
 * no secret crosses the bridge, and nothing probes an upstream server unless a
 * human asked. Both are properties of the BOUNDARY, so they are tested here
 * rather than in the component, where a mocked API would prove nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  registerMcpIpc,
  maskSpec,
  sanitizePolicy,
  parseSpec,
  testServer,
  defaultInventoryPaths,
  type McpIpcLike,
} from '../../src/main/mcpIpc'
import { initMcpGateway, addGatewayServer, setGatewayPolicy, getGatewayPolicy } from '../../src/main/mcpGatewayRuntime'
import type { Transport } from '../../src/main/mcpGateway'

type Handler = (event: unknown, input?: unknown) => unknown

function fakeIpc(): { ipc: McpIpcLike; call: (channel: string, input?: unknown) => any } {
  const handlers = new Map<string, Handler>()
  return {
    ipc: { handle: (channel, listener) => void handlers.set(channel, listener) },
    call: (channel, input) => {
      const h = handlers.get(channel)
      if (!h) throw new Error(`no handler registered for ${channel}`)
      return h({}, input)
    },
  }
}

function transportStub(over: Partial<Transport> = {}): Transport {
  return {
    id: 'stub',
    listTools: async () => [],
    callTool: async () => '',
    ...over,
  } as Transport
}

describe('mcpIpc', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tp-mcpipc-'))
    initMcpGateway(dir) // fresh userData => closed default policy, no servers
  })
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  describe('maskSpec', () => {
    it('replaces every env value but keeps the keys', () => {
      const masked = maskSpec({ id: 'a', command: 'npx', args: ['s'], env: { TOKEN: 'ghp_real', OTHER: 'x' } })
      expect(masked.env).toEqual({ TOKEN: '••••', OTHER: '••••' })
      expect(masked.command).toBe('npx')
      expect(masked.args).toEqual(['s'])
    })

    it('masks an env value that no secret scanner would flag', () => {
      // The whole point: `env` exists to carry a credential, so "it did not look
      // like one" is not a reason to ship it to the renderer.
      expect(maskSpec({ id: 'a', url: 'http://x', env: { PASSWORD: 'hunter2' } }).env).toEqual({ PASSWORD: '••••' })
    })

    it('does not invent keys that were absent', () => {
      expect(maskSpec({ id: 'bare' })).toEqual({ id: 'bare' })
    })

    it('copies args rather than aliasing the stored array', () => {
      const spec = { id: 'a', command: 'npx', args: ['one'] }
      maskSpec(spec).args!.push('two')
      expect(spec.args).toEqual(['one'])
    })
  })

  describe('sanitizePolicy', () => {
    it('falls back to the closed default for a junk decision', () => {
      const p = sanitizePolicy({ enabled: true, defaultDecision: 'allow-everything', rules: [] })
      expect(p.defaultDecision).toBe('ask')
    })

    it('rejects non-object input entirely', () => {
      expect(sanitizePolicy(null).defaultDecision).toBe('ask')
      expect(sanitizePolicy('allow').rules).toEqual([])
      expect(sanitizePolicy([{ server: 'a' }]).rules).toEqual([])
    })

    it('keeps well-formed rules and drops malformed ones', () => {
      const p = sanitizePolicy({
        enabled: false,
        defaultDecision: 'deny',
        strict: true,
        rules: [
          { server: 'gh', tool: 'read', decision: 'allow' },
          { server: 'gh', tool: 'write', decision: 'nope' },
          { server: 'gh', decision: 'allow' },
          'not a rule',
          null,
        ],
      })
      expect(p).toEqual({
        enabled: false,
        defaultDecision: 'deny',
        strict: true,
        rules: [{ server: 'gh', tool: 'read', decision: 'allow' }],
      })
    })

    it('ignores a non-array rules field', () => {
      expect(sanitizePolicy({ rules: 'all' }).rules).toEqual([])
    })
  })

  describe('parseSpec', () => {
    it('accepts a stdio spec', () => {
      expect(parseSpec({ id: 'a', command: 'npx', args: ['srv', 1] })).toEqual({
        spec: { id: 'a', command: 'npx', args: ['srv'] },
      })
    })

    it('accepts an http spec', () => {
      expect(parseSpec({ id: ' b ', url: ' https://x.test ' })).toEqual({ spec: { id: 'b', url: 'https://x.test' } })
    })

    it('refuses a spec that names both transports', () => {
      expect(parseSpec({ id: 'a', command: 'npx', url: 'https://x' })).toEqual({
        error: 'Give either a command or a URL, not both',
      })
    })

    it('refuses a spec that names neither', () => {
      expect(parseSpec({ id: 'a' })).toEqual({ error: 'A command (stdio) or a URL (http) is required' })
      expect(parseSpec({ id: 'a', command: '   ' })).toEqual({ error: 'A command (stdio) or a URL (http) is required' })
    })

    it('refuses a missing id', () => {
      expect(parseSpec({ command: 'npx' })).toEqual({ error: 'Server id is required' })
      expect(parseSpec({ id: '  ', command: 'npx' })).toEqual({ error: 'Server id is required' })
      expect(parseSpec(null)).toEqual({ error: 'A server definition is required' })
    })

    it('keeps string env entries and drops the rest', () => {
      expect(parseSpec({ id: 'a', command: 'x', env: { A: '1', B: 2 } })).toEqual({
        spec: { id: 'a', command: 'x', env: { A: '1' } },
      })
      // An env object with nothing usable in it is omitted, not stored empty.
      expect(parseSpec({ id: 'a', command: 'x', env: { B: 2 } })).toEqual({ spec: { id: 'a', command: 'x' } })
      expect(parseSpec({ id: 'a', command: 'x', args: 'nope' })).toEqual({ spec: { id: 'a', command: 'x' } })
    })
  })

  describe('testServer', () => {
    it('counts tools and always disposes the throwaway transport', async () => {
      const dispose = vi.fn()
      const result = await testServer(
        'a',
        [{ id: 'a', command: 'npx' }],
        () => transportStub({ listTools: async () => [{ name: 't1' }, { name: 't2' }] as any, dispose } as any),
      )
      expect(result).toEqual({ ok: true, tools: 2 })
      expect(dispose).toHaveBeenCalledTimes(1)
    })

    it('reports a connection failure instead of throwing, and still disposes', async () => {
      const dispose = vi.fn()
      const result = await testServer(
        'a',
        [{ id: 'a', command: 'npx' }],
        () => transportStub({ listTools: async () => { throw new Error('ENOENT npx') }, dispose } as any),
      )
      expect(result).toEqual({ ok: false, error: 'ENOENT npx' })
      expect(dispose).toHaveBeenCalledTimes(1)
    })

    it('survives a transport that throws on dispose', async () => {
      const result = await testServer(
        'a',
        [{ id: 'a', command: 'npx' }],
        () => transportStub({ dispose: () => { throw new Error('teardown blew up') } } as any),
      )
      // The probe already had its answer; teardown must not overwrite it.
      expect(result).toEqual({ ok: true, tools: 0 })
    })

    it('stringifies a thrown non-Error', async () => {
      const result = await testServer('a', [{ id: 'a', command: 'npx' }], () =>
        transportStub({ listTools: async () => { throw 'raw string' } } as any),
      )
      expect(result).toEqual({ ok: false, error: 'raw string' })
    })

    it('reports an unknown id without constructing a transport', async () => {
      const make = vi.fn()
      const result = await testServer('ghost', [{ id: 'a', command: 'npx' }], make as any)
      expect(result).toEqual({ ok: false, error: 'No such server: ghost' })
      expect(make).not.toHaveBeenCalled()
    })

    it('tolerates a transport with no dispose method', async () => {
      const result = await testServer('a', [{ id: 'a', command: 'npx' }], () => transportStub())
      expect(result).toEqual({ ok: true, tools: 0 })
    })
  })

  describe('defaultInventoryPaths', () => {
    it('resolves the four configs Termpolis already writes to', () => {
      const p = defaultInventoryPaths('/home/me')
      expect(p.claude).toBe(join('/home/me', '.claude', 'settings.json'))
      expect(p.globalMcp).toBe(join('/home/me', '.mcp.json'))
      expect(p.codex).toBe(join('/home/me', '.codex', 'config.toml'))
      expect(p.gemini).toBe(join('/home/me', '.gemini', 'settings.json'))
    })

    it('defaults to the real home directory', () => {
      expect(defaultInventoryPaths().claude).toContain('.claude')
    })
  })

  describe('handlers', () => {
    it('mcp:gateway-servers never emits an env value', () => {
      addGatewayServer({ id: 'gh', command: 'npx', env: { GITHUB_TOKEN: 'ghp_supersecret' } })
      const { ipc, call } = fakeIpc()
      registerMcpIpc(ipc)
      const res = call('mcp:gateway-servers')
      expect(res.success).toBe(true)
      expect(JSON.stringify(res.data)).not.toContain('ghp_supersecret')
      expect(res.data[0].env).toEqual({ GITHUB_TOKEN: '••••' })
    })

    it('mcp:gateway-add-server persists and answers with the new list', () => {
      const { ipc, call } = fakeIpc()
      registerMcpIpc(ipc)
      const res = call('mcp:gateway-add-server', { spec: { id: 'a', command: 'npx', args: ['srv'] } })
      expect(res.success).toBe(true)
      expect(res.data).toEqual([{ id: 'a', command: 'npx', args: ['srv'] }])
    })

    it('mcp:gateway-add-server rejects a bad spec WITHOUT changing the stored list', () => {
      const { ipc, call } = fakeIpc()
      registerMcpIpc(ipc)
      const res = call('mcp:gateway-add-server', { spec: { id: 'a' } })
      expect(res).toEqual({ success: false, error: 'A command (stdio) or a URL (http) is required' })
      expect(call('mcp:gateway-servers').data).toEqual([])
    })

    it('mcp:gateway-remove-server removes by id and requires one', () => {
      addGatewayServer({ id: 'a', command: 'npx' })
      const { ipc, call } = fakeIpc()
      registerMcpIpc(ipc)
      expect(call('mcp:gateway-remove-server', {}).success).toBe(false)
      expect(call('mcp:gateway-remove-server', { id: 'a' }).data).toEqual([])
    })

    it('mcp:gateway-set-policy persists the sanitized policy, not the raw input', () => {
      const { ipc, call } = fakeIpc()
      registerMcpIpc(ipc)
      const res = call('mcp:gateway-set-policy', { policy: { defaultDecision: 'nonsense', enabled: false } })
      expect(res.data.defaultDecision).toBe('ask')
      expect(res.data.enabled).toBe(false)
      // and it really went to the store, not just back out of the handler
      expect(getGatewayPolicy().defaultDecision).toBe('ask')
    })

    it('mcp:gateway-policy reads what was stored', () => {
      setGatewayPolicy({ enabled: true, defaultDecision: 'allow', rules: [], strict: false })
      const { ipc, call } = fakeIpc()
      registerMcpIpc(ipc)
      expect(call('mcp:gateway-policy').data.defaultDecision).toBe('allow')
    })

    it('mcp:gateway-test requires an id', async () => {
      const { ipc, call } = fakeIpc()
      registerMcpIpc(ipc)
      expect(await call('mcp:gateway-test', {})).toEqual({ success: false, error: 'Server id is required' })
    })

    it('mcp:gateway-test answers for an unknown server without spawning anything', async () => {
      const { ipc, call } = fakeIpc()
      registerMcpIpc(ipc)
      const res = await call('mcp:gateway-test', { id: 'ghost' })
      expect(res).toEqual({ success: true, data: { ok: false, error: 'No such server: ghost' } })
    })

    it('mcp:inventory reads the four configs and folds in the gateway', () => {
      const home = join(dir, 'home')
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({ mcpServers: { github: { command: 'npx', env: { TOKEN: 'ghp_secret' } } } }),
      )
      addGatewayServer({ id: 'local', command: 'npx' })

      const { ipc, call } = fakeIpc()
      registerMcpIpc(ipc, () => defaultInventoryPaths(home))
      const res = call('mcp:inventory')

      expect(res.success).toBe(true)
      expect(JSON.stringify(res.data)).not.toContain('ghp_secret')
      expect(res.data.servers.map((s: any) => s.name).sort()).toEqual(['github', 'local'])
      const byId = Object.fromEntries(res.data.sources.map((s: any) => [s.id, s.status]))
      expect(byId.claude).toBe('ok')
      expect(byId.codex).toBe('missing')
      expect(byId.gateway).toBe('ok')
    })

    it('mcp:inventory reports a thrown path resolution as an error rather than crashing', () => {
      const { ipc, call } = fakeIpc()
      registerMcpIpc(ipc, () => { throw new Error('no home directory') })
      expect(call('mcp:inventory')).toEqual({ success: false, error: 'no home directory' })
    })
  })
})
