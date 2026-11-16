import { describe, expect, it, vi } from 'vitest'
import { createGateway, defaultPolicy } from '../../src/main/mcpGateway'
import { sanitizeToolMetadata, type SecretScan } from '../../src/main/mcpGateway/guard'
import { clearGatewayAudit } from '../../src/main/mcpGateway/audit'
import {
  MAX_GATEWAY_IDS,
  MAX_GATEWAY_LIMIT,
  NO_ROOT_MESSAGE,
  NO_WORLD_MESSAGE,
  WORLD_GATEWAY_ID,
  WORLD_READ_TOOL,
  createWorldGatewayTransport,
  parseWorldReadArgs,
  type WorldGatewayClient
} from '../../src/main/world/worldGatewayTransport'
import type { WorldQuery, WorldReadResult } from '../../src/shared/world/types'

const RESULT = {
  items: [{ id: 'b:auth', kind: 'building', name: 'auth', how: [{ text: 'checks tokens', evidence: [{ kind: 'file', ref: 'src/auth.ts' }] }] }],
  evidence: [{ kind: 'file', ref: 'src/auth.ts' }]
} as unknown as WorldReadResult

const noSecrets = (text: string): SecretScan => ({ hitCount: 0, hits: [], redacted: text })

function setup(opts: { has?: boolean | (() => Promise<boolean>); root?: string | null } = {}) {
  const read = vi.fn(async (_root: string, _q: WorldQuery) => RESULT)
  const has = opts.has ?? true
  const hasWorld = vi.fn(typeof has === 'function' ? has : async () => has)
  const client: WorldGatewayClient = { read, hasWorld }
  const rootFor = vi.fn((cwd?: string) => (opts.root !== undefined ? opts.root : cwd ? `${cwd}-root` : null))
  const transport = createWorldGatewayTransport(client, rootFor)
  return { transport, read, hasWorld, rootFor }
}

describe('createWorldGatewayTransport', () => {
  it('is the trusted built-in "lumopolis", frozen, with one tool', async () => {
    const { transport } = setup()
    expect(transport.id).toBe(WORLD_GATEWAY_ID)
    expect(transport.id).toBe('lumopolis')
    expect(transport.trusted).toBe(true)
    expect(Object.isFrozen(transport)).toBe(true)
    const tools = await transport.listTools()
    expect(tools.map((t) => t.name)).toEqual([WORLD_READ_TOOL])
    expect(tools[0].name).toBe('world_read')
    // Short (one or two sentences) and clean: the gateway shows it unaltered.
    expect((tools[0].description as string).split('. ').length).toBeLessThanOrEqual(2)
    expect(sanitizeToolMetadata('lumopolis', 'world_read', tools[0].description, tools[0].inputSchema).level).toBe('green')
    const schema = tools[0].inputSchema as { type: string; properties: Record<string, { type: string }> }
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties)).toEqual(['ids', 'text', 'limit', 'cwd'])
    expect(schema.properties.ids.type).toBe('array')
  })

  it('world_read returns items + evidence', async () => {
    const { transport, read, hasWorld, rootFor } = setup()
    const text = await transport.callTool('world_read', { ids: ['b:auth'], text: 'auth', limit: 5, cwd: '/repos/app' })
    expect(JSON.parse(text)).toEqual(RESULT)
    expect(rootFor).toHaveBeenCalledWith('/repos/app')
    expect(hasWorld).toHaveBeenCalledWith('/repos/app-root')
    expect(read).toHaveBeenCalledWith('/repos/app-root', { ids: ['b:auth'], text: 'auth', limit: 5 })
  })

  it('takes an async rootFor', async () => {
    const read = vi.fn(async () => RESULT)
    const t = createWorldGatewayTransport({ read, hasWorld: async () => true }, async (cwd) => `${cwd}!`)
    await t.callTool('world_read', { cwd: '/x' })
    expect(read).toHaveBeenCalledWith('/x!', {})
  })

  it('a project without a world gets the helpful message, and the host is never asked', async () => {
    const { transport, read } = setup({ has: false })
    await expect(transport.callTool('world_read', { cwd: '/repos/app' })).rejects.toThrow(NO_WORLD_MESSAGE)
    expect(NO_WORLD_MESSAGE).toBe('No Lumopolis map for this project yet. Open Lumopolis in Termpolis to build one.')
    expect(read).not.toHaveBeenCalled()
  })

  it('no project root is a clean error that says to pass cwd', async () => {
    for (const root of [null, '', '   ']) {
      const { transport, hasWorld } = setup({ root })
      await expect(transport.callTool('world_read', {})).rejects.toThrow(NO_ROOT_MESSAGE)
      expect(hasWorld).not.toHaveBeenCalled()
    }
    const { transport, rootFor } = setup()
    await expect(transport.callTool('world_read', undefined)).rejects.toThrow('pass "cwd"')
    expect(rootFor).toHaveBeenCalledWith(undefined)
  })

  it('refuses an unknown tool', async () => {
    const { transport, read } = setup()
    await expect(transport.callTool('world_propose', {})).rejects.toThrow('unknown Lumopolis tool "world_propose"')
    expect(read).not.toHaveBeenCalled()
  })

  it('a host failure surfaces as its message', async () => {
    const { transport, read } = setup()
    read.mockRejectedValueOnce(new Error('Lumopolis host exited (code 1)'))
    await expect(transport.callTool('world_read', { cwd: '/a' })).rejects.toThrow('Lumopolis host exited (code 1)')
  })
})

describe('parseWorldReadArgs', () => {
  it('reads nothing as an empty query; null fields count as absent', () => {
    expect(parseWorldReadArgs(undefined)).toEqual({ query: {} })
    expect(parseWorldReadArgs(null)).toEqual({ query: {} })
    expect(parseWorldReadArgs({})).toEqual({ query: {} })
    expect(parseWorldReadArgs({ ids: null, text: null, limit: null, cwd: null, other: 1 })).toEqual({ query: {} })
  })

  it('keeps well-typed fields', () => {
    expect(parseWorldReadArgs({ ids: ['a', 'b'], text: 'auth', limit: 7, cwd: '/r' })).toEqual({
      query: { ids: ['a', 'b'], text: 'auth', limit: 7 },
      cwd: '/r'
    })
  })

  it('clamps the limit to 1..100 and floors it', () => {
    expect(parseWorldReadArgs({ limit: 0 }).query.limit).toBe(1)
    expect(parseWorldReadArgs({ limit: -50 }).query.limit).toBe(1)
    expect(parseWorldReadArgs({ limit: 1000 }).query.limit).toBe(MAX_GATEWAY_LIMIT)
    expect(MAX_GATEWAY_LIMIT).toBe(100)
    expect(parseWorldReadArgs({ limit: 12.9 }).query.limit).toBe(12)
  })

  it('passes at most 200 ids', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id${i}`)
    const out = parseWorldReadArgs({ ids }).query.ids as string[]
    expect(MAX_GATEWAY_IDS).toBe(200)
    expect(out).toHaveLength(200)
    expect(out[199]).toBe('id199')
  })

  it('rejects wrong types with a clean message', () => {
    expect(() => parseWorldReadArgs('auth')).toThrow('world_read arguments must be an object')
    expect(() => parseWorldReadArgs(['auth'])).toThrow('must be an object')
    expect(() => parseWorldReadArgs({ ids: 'a' })).toThrow('"ids" must be an array of strings')
    expect(() => parseWorldReadArgs({ ids: ['a', 2] })).toThrow('"ids" must be an array of strings')
    expect(() => parseWorldReadArgs({ text: 5 })).toThrow('"text" must be a string')
    expect(() => parseWorldReadArgs({ limit: '5' })).toThrow('"limit" must be a number')
    expect(() => parseWorldReadArgs({ limit: Number.NaN })).toThrow('"limit" must be a number')
    expect(() => parseWorldReadArgs({ limit: Infinity })).toThrow('"limit" must be a number')
    expect(() => parseWorldReadArgs({ cwd: 3 })).toThrow('"cwd" must be a string')
  })
})

describe('world_read through the gateway', () => {
  it("is answered under the default 'ask' policy with no prompter", async () => {
    clearGatewayAudit()
    const { transport } = setup()
    const gw = createGateway({ getPolicy: () => defaultPolicy(), transports: () => [transport], scanSecrets: noSecrets })
    expect((await gw.listTools()).map((t) => t.name)).toEqual(['lumopolis/world_read'])
    const res = await gw.callTool('lumopolis/world_read', { text: 'auth', cwd: '/repos/app' })
    expect(res.ok).toBe(true)
    expect(JSON.parse(res.text as string)).toEqual(RESULT)
  })

  it('wrong arguments and a missing world come back as error results, not thrown stacks', async () => {
    const gw = createGateway({ getPolicy: () => defaultPolicy(), transports: () => [setup().transport], scanSecrets: noSecrets })
    expect(await gw.callTool('lumopolis/world_read', { limit: 'lots', cwd: '/a' })).toMatchObject({
      ok: false,
      error: 'world_read "limit" must be a number'
    })
    const none = createGateway({ getPolicy: () => defaultPolicy(), transports: () => [setup({ has: false }).transport], scanSecrets: noSecrets })
    expect(await none.callTool('lumopolis/world_read', { cwd: '/a' })).toMatchObject({ ok: false, error: NO_WORLD_MESSAGE })
  })
})
