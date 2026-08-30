import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const created: { spec: unknown; dispose: ReturnType<typeof vi.fn> }[] = []

// The only seam that must not be real: `transportFor` would spawn a child process or
// open a socket. Everything else in the runtime — policy, gateway, audit, fs — is real.
vi.mock('../../src/main/mcpGateway/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/main/mcpGateway/client')>()
  return {
    ...actual,
    transportFor: vi.fn((spec: { id: string }) => {
      const dispose = vi.fn()
      created.push({ spec, dispose })
      return {
        id: spec.id,
        listTools: vi.fn(async () => [{ name: 'echo', description: 'echo back' }]),
        callTool: vi.fn(async (_tool: string, args: unknown) => `called with ${JSON.stringify(args)}`),
        dispose,
      }
    }),
  }
})

import {
  initMcpGateway,
  getGatewayPolicy,
  setGatewayPolicy,
  listGatewayServers,
  addGatewayServer,
  removeGatewayServer,
  gatewayListTools,
  gatewayCall,
  disposeGateway,
} from '../../src/main/mcpGatewayRuntime'
import { defaultPolicy } from '../../src/main/mcpGateway'
import { clearGatewayAudit, recentGatewayCalls, setGatewayAuditSink } from '../../src/main/mcpGateway/audit'

let tmp: string
const configFile = () => path.join(tmp, 'gateway', 'gateway.json')
const auditFile = () => path.join(tmp, 'gateway', 'gateway-audit.jsonl')

beforeEach(() => {
  created.length = 0
  clearGatewayAudit()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gw-'))
  initMcpGateway(tmp)
})

afterEach(() => {
  disposeGateway()
  setGatewayAuditSink(null)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* windows lock */ }
})

describe('mcpGatewayRuntime/init', () => {
  it('rejects an empty userData path', () => {
    expect(() => initMcpGateway('')).toThrow('userDataPath required')
  })

  it('starts closed: enabled, but asking, with no servers and no prompter', () => {
    expect(getGatewayPolicy()).toEqual(defaultPolicy())
    expect(listGatewayServers()).toEqual([])
  })

  it('restores a saved policy and server list', () => {
    addGatewayServer({ id: 'files', command: 'srv' })
    setGatewayPolicy({ ...defaultPolicy(), strict: true, rules: [{ server: 'files', tool: '*', decision: 'allow' }] })
    initMcpGateway(tmp)
    expect(getGatewayPolicy().strict).toBe(true)
    expect(listGatewayServers()).toEqual([{ id: 'files', command: 'srv' }])
  })

  it('fails SAFE on a corrupt config rather than inheriting a half-parsed allow-list', () => {
    addGatewayServer({ id: 'files', command: 'srv' })
    setGatewayPolicy({ ...defaultPolicy(), defaultDecision: 'allow' })
    fs.writeFileSync(configFile(), '{ "policy": { "defaultDecision": "allow"', 'utf8')
    initMcpGateway(tmp)
    expect(getGatewayPolicy()).toEqual(defaultPolicy())
    expect(listGatewayServers()).toEqual([])
  })

  it('fills in a partial policy from the defaults rather than leaving a field undefined', () => {
    fs.writeFileSync(configFile(), JSON.stringify({ policy: { strict: true } }), 'utf8')
    initMcpGateway(tmp)
    expect(getGatewayPolicy()).toEqual({ ...defaultPolicy(), strict: true })
  })

  it('ignores a servers field that is not an array', () => {
    fs.writeFileSync(configFile(), JSON.stringify({ servers: 'files' }), 'utf8')
    initMcpGateway(tmp)
    expect(listGatewayServers()).toEqual([])
  })

  it('degrades to in-memory rather than failing app startup on an unwritable dir', () => {
    fs.writeFileSync(path.join(tmp, 'blocker'), 'x', 'utf8')
    expect(() => initMcpGateway(path.join(tmp, 'blocker'))).not.toThrow()
    expect(() => addGatewayServer({ id: 'x', url: 'http://x' })).not.toThrow()
    expect(listGatewayServers()).toHaveLength(1)
  })
})

describe('mcpGatewayRuntime/config', () => {
  it('persists a policy change immediately', () => {
    setGatewayPolicy({ ...defaultPolicy(), enabled: false })
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).policy.enabled).toBe(false)
  })

  it('adds a server and hands back a copy the caller cannot mutate', () => {
    addGatewayServer({ id: 'files', command: 'srv' })
    listGatewayServers().push({ id: 'smuggled', command: 'evil' })
    expect(listGatewayServers().map(s => s.id)).toEqual(['files'])
  })

  it('replaces a server with the same id instead of duplicating it', () => {
    addGatewayServer({ id: 'files', command: 'old' })
    addGatewayServer({ id: 'files', command: 'new' })
    expect(listGatewayServers()).toEqual([{ id: 'files', command: 'new' }])
  })

  it('drops the memoised transport when a server is redefined', async () => {
    addGatewayServer({ id: 'files', command: 'old' })
    await gatewayListTools()
    addGatewayServer({ id: 'files', command: 'new' })
    await gatewayListTools()
    expect(created).toHaveLength(2)
  })

  it('removes a server and disposes its live transport', async () => {
    addGatewayServer({ id: 'files', command: 'srv' })
    await gatewayListTools()
    removeGatewayServer('files')
    expect(created[0].dispose).toHaveBeenCalledTimes(1)
    expect(listGatewayServers()).toEqual([])
  })

  it('removes a server that was never contacted', () => {
    addGatewayServer({ id: 'files', command: 'srv' })
    expect(() => removeGatewayServer('files')).not.toThrow()
    expect(() => removeGatewayServer('never-existed')).not.toThrow()
  })
})

describe('mcpGatewayRuntime/calls', () => {
  const allowAll = { ...defaultPolicy(), rules: [{ server: '*', tool: '*', decision: 'allow' as const }] }

  it('returns nothing when no upstream server is configured', async () => {
    expect(await gatewayListTools()).toEqual([])
  })

  it('namespaces upstream tools by server id', async () => {
    addGatewayServer({ id: 'files', command: 'srv' })
    setGatewayPolicy(allowAll)
    expect(await gatewayListTools()).toEqual([
      expect.objectContaining({ name: 'files/echo', description: 'echo back' }),
    ])
  })

  it('memoises the transport across calls — MCP servers expect initialize once', async () => {
    addGatewayServer({ id: 'files', command: 'srv' })
    await gatewayListTools()
    await gatewayListTools()
    expect(created).toHaveLength(1)
  })

  it('forwards an allowed call and unwraps the result', async () => {
    addGatewayServer({ id: 'files', command: 'srv' })
    setGatewayPolicy(allowAll)
    expect(await gatewayCall({ tool: 'files/echo', arguments: { q: 1 } }))
      .toEqual({ ok: true, text: 'called with {"q":1}' })
  })

  it('defaults the arguments to an empty object', async () => {
    addGatewayServer({ id: 'files', command: 'srv' })
    setGatewayPolicy(allowAll)
    expect(await gatewayCall({ tool: 'files/echo' })).toEqual({ ok: true, text: 'called with {}' })
  })

  it('fails closed on an "ask" with no prompter wired — the shipping default', async () => {
    addGatewayServer({ id: 'files', command: 'srv' })
    const res = await gatewayCall({ tool: 'files/echo' }) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('refuses a call to an unknown server', async () => {
    setGatewayPolicy(allowAll)
    expect(await gatewayCall({ tool: 'ghost/echo' })).toMatchObject({ ok: false })
  })

  it('writes the audit trail to disk without ever writing a secret value', async () => {
    addGatewayServer({ id: 'files', command: 'srv' })
    setGatewayPolicy(allowAll)
    await gatewayCall({ tool: 'files/echo', arguments: { token: `sk-ant-${'a'.repeat(64)}` } })
    const log = fs.readFileSync(auditFile(), 'utf8')
    expect(log.trim().split('\n')).toHaveLength(1)
    expect(log).not.toContain('a'.repeat(64))
    expect(JSON.parse(log.trim())).toMatchObject({ server: 'files', tool: 'echo' })
    expect(recentGatewayCalls()).toHaveLength(1)
  })

  it('keeps serving calls when the audit file cannot be appended to', async () => {
    fs.writeFileSync(path.join(tmp, 'blocker'), 'x', 'utf8')
    initMcpGateway(path.join(tmp, 'blocker'))
    addGatewayServer({ id: 'files', command: 'srv' })
    setGatewayPolicy(allowAll)
    expect(await gatewayCall({ tool: 'files/echo' })).toMatchObject({ ok: true })
  })
})

describe('mcpGatewayRuntime/disposeGateway', () => {
  it('disposes every live transport and forgets them', async () => {
    addGatewayServer({ id: 'a', command: 'srv' })
    addGatewayServer({ id: 'b', command: 'srv' })
    await gatewayListTools()
    disposeGateway()
    expect(created.map(c => c.dispose.mock.calls.length)).toEqual([1, 1])
    await gatewayListTools()
    expect(created).toHaveLength(4)
  })

  it('keeps going when one transport throws on dispose', async () => {
    addGatewayServer({ id: 'a', command: 'srv' })
    addGatewayServer({ id: 'b', command: 'srv' })
    await gatewayListTools()
    created[0].dispose.mockImplementationOnce(() => { throw new Error('already dead') })
    expect(() => disposeGateway()).not.toThrow()
    expect(created[1].dispose).toHaveBeenCalled()
  })

  it('is a no-op with nothing open', () => {
    expect(() => disposeGateway()).not.toThrow()
  })
})
