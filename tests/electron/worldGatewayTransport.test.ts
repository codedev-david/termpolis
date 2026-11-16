import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { createGateway, defaultPolicy } from '../../src/main/mcpGateway'
import { sanitizeToolMetadata, type SecretScan } from '../../src/main/mcpGateway/guard'
import { clearGatewayAudit } from '../../src/main/mcpGateway/audit'
import {
  MAX_GATEWAY_IDS,
  MAX_GATEWAY_LIMIT,
  BAD_CWD_MESSAGE,
  NO_ROOT_MESSAGE,
  NO_WORLD_MESSAGE,
  WORLD_GATEWAY_ID,
  WORLD_READ_TOOL,
  WORLD_PROPOSE_TOOL,
  BAD_DESIGN_KEY_MESSAGE,
  NO_DESIGN_MESSAGE,
  NO_PROPOSE_ROOT_MESSAGE,
  createWorldGatewayTransport,
  parseWorldReadArgs,
  type WorldGatewayClient
} from '../../src/main/world/worldGatewayTransport'
import type { WorldDoc, WorldQuery, WorldReadResult } from '../../src/shared/world/types'
import { MAX_DESIGN_OPS } from '../../src/shared/world/designPatch'
import { createDesigner, DESIGN_NOT_FOUND, DESIGN_NOTHING_APPLIED, DESIGN_SAVE_FAILED } from '../../src/main/world/designer'
import { keyForSource, type SourceRegistry, type WorldEntry, type WorldSource } from '../../src/main/world/sources'
import type { WorldStore } from '../../src/main/world/worldStore'
import type { ExecDeps } from '../../src/main/headlessExec'

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
  // The fake cwds ('/repos/app') do not exist on disk: a stub stands in for the folder check.
  const isDir = vi.fn(async () => true)
  const transport = createWorldGatewayTransport(client, rootFor, isDir)
  return { transport, read, hasWorld, rootFor, isDir }
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
    expect((tools[0].inputSchema as { required: string[] }).required).toEqual(['cwd'])
    expect(tools[0].description).toContain('"cwd"')
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
    const t = createWorldGatewayTransport({ read, hasWorld: async () => true }, async (cwd) => `${cwd}!`, async () => true)
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
    await expect(transport.callTool('world_read', undefined)).rejects.toThrow('world_read needs {"cwd": "<project folder>"}')
    expect(rootFor).toHaveBeenCalledWith(undefined)
  })

  it('refuses a cwd that is a network path, relative, missing or not a folder, before any root lookup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lumopolis-cwd-'))
    try {
      const file = join(dir, 'a-file.txt')
      await writeFile(file, 'x')
      const read = vi.fn(async () => RESULT)
      const rootFor = vi.fn(async (cwd?: string) => cwd ?? null)
      // No folder check passed in: the real one (an async stat) runs.
      const t = createWorldGatewayTransport({ read, hasWorld: async () => true }, rootFor)
      const unc = String.raw`\\server\share\repo`
      const device = String.raw`\\?\C:\repo`
      for (const cwd of [unc, '//server/share/repo', device, 'repos/app', '.', join(dir, 'missing'), file]) {
        await expect(t.callTool('world_read', { cwd })).rejects.toThrow(BAD_CWD_MESSAGE)
      }
      expect(rootFor).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      // A real local folder passes.
      expect(JSON.parse(await t.callTool('world_read', { cwd: dir }))).toEqual(RESULT)
      expect(rootFor).toHaveBeenCalledWith(dir)
      // An empty cwd is no cwd: the "pass cwd" message, as before.
      rootFor.mockClear()
      await expect(t.callTool('world_read', { cwd: '  ' })).rejects.toThrow(NO_ROOT_MESSAGE)
      expect(BAD_CWD_MESSAGE).toContain('"cwd"')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a folder check that throws counts as not a folder', async () => {
    const rootFor = vi.fn(async () => '/r')
    const t = createWorldGatewayTransport({ read: vi.fn(async () => RESULT), hasWorld: async () => true }, rootFor, async () => {
      throw new Error('EPERM')
    })
    await expect(t.callTool('world_read', { cwd: process.cwd() })).rejects.toThrow(BAD_CWD_MESSAGE)
    expect(rootFor).not.toHaveBeenCalled()
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
    expect(await gw.callTool('lumopolis/world_read', {})).toMatchObject({ ok: false, error: NO_ROOT_MESSAGE })
  })
})

describe('world_propose and design reads', () => {
  const ROOT = '/repos/app-root'
  const OPS = [
    { op: 'addDistrict', id: 'core', name: 'Core' },
    { op: 'addBuilding', id: 'auth', districtId: 'core', name: 'Auth' },
    { op: 'addBuilding', id: 'mail', districtId: 'core', name: 'Mailer' }
  ]

  /** A real designer over an in-memory store and registry, behind the transport. */
  function proposeSetup(entries: WorldEntry[] = []) {
    const saved = new Map<string, WorldDoc>()
    const store = {
      save: vi.fn(async (d: WorldDoc) => {
        saved.set(d.projectKey, d)
      }),
      load: vi.fn(async (k: string) => saved.get(k) ?? null)
    } as unknown as WorldStore
    const reg = new Map(entries.map((e) => [e.key, e]))
    const registry = {
      get: vi.fn(async (k: string) => reg.get(k) ?? null),
      upsert: vi.fn(async (s: WorldSource, title?: string) => {
        const key = keyForSource(s)
        const e: WorldEntry = { key, source: s, title: title ?? reg.get(key)?.title ?? 'untitled', lastOpened: 1 }
        reg.set(key, e)
        return e
      })
    }
    let n = 0
    const designer = createDesigner({
      exec: vi.fn(), execDeps: {} as ExecDeps, store, registry: registry as unknown as SourceRegistry,
      designsDir: '/designs', newId: () => `n${++n}`, now: () => 50
    })
    const readDesign = vi.fn(async (key: string, _q: WorldQuery) => (saved.has(key) ? RESULT : null))
    const base = setup()
    const transport = createWorldGatewayTransport(
      { read: base.read, hasWorld: base.hasWorld }, base.rootFor, base.isDir, { designer, registry, readDesign }
    )
    return { transport, saved, reg, registry, readDesign, rootFor: base.rootFor }
  }

  it('lists world_propose beside world_read, both short and clean, and world_read takes a designKey', async () => {
    const { transport } = proposeSetup()
    const tools = await transport.listTools()
    expect(tools.map((t) => t.name)).toEqual([WORLD_READ_TOOL, WORLD_PROPOSE_TOOL])
    for (const t of tools) {
      expect((t.description as string).split('. ').length).toBeLessThanOrEqual(2)
      expect(sanitizeToolMetadata('lumopolis', t.name, t.description, t.inputSchema).level).toBe('green')
    }
    expect(Object.keys((tools[0].inputSchema as { properties: object }).properties)).toEqual(['ids', 'text', 'limit', 'cwd', 'designKey'])
    expect((tools[0].inputSchema as { required?: string[] }).required).toBeUndefined()
    expect(Object.keys((tools[1].inputSchema as { properties: object }).properties)).toEqual(['ops', 'cwd', 'designKey'])
    expect((tools[1].inputSchema as { required: string[] }).required).toEqual(['ops'])
  })

  it('world_propose creates a linked design and returns counts', async () => {
    const { transport, saved, reg, readDesign, rootFor } = proposeSetup()
    const first = JSON.parse(await transport.callTool('world_propose', { cwd: '/repos/app', ops: OPS }))
    expect(first).toEqual({ key: 'design:n1', applied: 3, skipped: 0 })
    expect(rootFor).toHaveBeenCalledWith('/repos/app')
    const project = reg.get(keyForSource({ kind: 'project', root: ROOT }))
    expect(project?.source).toEqual({ kind: 'project', root: ROOT, linkedDesign: 'design:n1' })
    expect(reg.get('design:n1')?.source).toEqual({ kind: 'design', id: 'n1', title: 'Plan for app-root', linkedRoot: ROOT })
    expect(saved.get('design:n1')?.buildings.map((b) => b.id)).toEqual(['auth', 'mail'])

    // The next call from the same project updates the linked design; it does not make another.
    const second = JSON.parse(await transport.callTool('world_propose', {
      cwd: '/repos/app', ops: [{ op: 'addBuilding', id: 'pay', districtId: 'core', name: 'Payments' }]
    }))
    expect(second).toEqual({ key: 'design:n1', applied: 1, skipped: 0 })
    expect(saved.get('design:n1')?.buildings.map((b) => b.id)).toEqual(['auth', 'mail', 'pay'])
    expect(saved.get('design:n1')?.generatedAt).toBe(50)

    // By key (a null cwd counts as absent), and the design reads back through world_read.
    const third = JSON.parse(await transport.callTool('world_propose', { designKey: 'design:n1', cwd: null, ops: [{ op: 'rename', id: 'pay', name: 'Billing' }] }))
    expect(third).toEqual({ key: 'design:n1', applied: 1, skipped: 0 })
    expect(JSON.parse(await transport.callTool('world_read', { designKey: 'design:n1', text: 'auth' }))).toEqual(RESULT)
    expect(readDesign).toHaveBeenCalledWith('design:n1', { text: 'auth' })
  })

  it('two concurrent first-time cwd proposes end with one linked design that holds both ops', async () => {
    const { transport, saved, reg } = proposeSetup()
    const [a, b] = await Promise.all([
      transport.callTool('world_propose', { cwd: '/repos/app', ops: OPS }),
      transport.callTool('world_propose', { cwd: '/repos/app', ops: [{ op: 'addBuilding', id: 'pay', districtId: 'core', name: 'Payments' }] })
    ])
    expect(JSON.parse(a)).toEqual({ key: 'design:n1', applied: 3, skipped: 0 })
    expect(JSON.parse(b)).toEqual({ key: 'design:n1', applied: 1, skipped: 0 })
    expect([...saved.keys()]).toEqual(['design:n1'])
    expect(saved.get('design:n1')?.buildings.map((x) => x.id)).toEqual(['auth', 'mail', 'pay'])
    expect(reg.get(keyForSource({ kind: 'project', root: ROOT }))?.source).toEqual({ kind: 'project', root: ROOT, linkedDesign: 'design:n1' })
  })

  it('keeps a folder entry a folder when it links the new design, and relinks when the linked design is gone', async () => {
    const key = keyForSource({ kind: 'folder', root: ROOT })
    const { transport, reg } = proposeSetup([{ key, source: { kind: 'folder', root: ROOT, linkedDesign: 'design:gone' }, title: 'App', lastOpened: 1 }])
    const r = JSON.parse(await transport.callTool('world_propose', { cwd: '/repos/app', ops: OPS }))
    expect(r.key).toBe('design:n1')
    expect(reg.get(key)?.source).toEqual({ kind: 'folder', root: ROOT, linkedDesign: 'design:n1' })
    expect(reg.get(key)?.title).toBe('App')
  })

  it('world_propose skips bad ops', async () => {
    const { transport, reg } = proposeSetup()
    const r = JSON.parse(await transport.callTool('world_propose', {
      cwd: '/repos/app',
      ops: [{ op: 'nope' }, 'x', { op: 'addBuilding', id: 'a', districtId: 'missing', name: 'A' }, { op: 'addDistrict', id: 'core', name: 'Core' }]
    }))
    expect(r).toEqual({ key: 'design:n1', applied: 1, skipped: 3 })
    // Updating with only bad ops applies nothing and keeps the design.
    const none = JSON.parse(await transport.callTool('world_propose', { designKey: 'design:n1', ops: [{ op: 'remove', id: 'nothing' }] }))
    expect(none).toEqual({ key: 'design:n1', applied: 0, skipped: 1 })
    expect(reg.size).toBe(2)
    // Nothing usable makes no design and links nothing.
    const fresh = proposeSetup()
    await expect(fresh.transport.callTool('world_propose', { cwd: '/repos/app', ops: [{ op: 'nope' }] })).rejects.toThrow(DESIGN_NOTHING_APPLIED)
    expect(fresh.reg.size).toBe(0)
  })

  it('refuses bad arguments, a missing design and a missing root with clean messages', async () => {
    const { transport, readDesign, rootFor } = proposeSetup()
    await expect(transport.callTool('world_propose', { cwd: '/repos/app' })).rejects.toThrow('world_propose "ops" must be an array')
    await expect(transport.callTool('world_propose', null as unknown as Record<string, unknown>)).rejects.toThrow('"ops" must be an array')
    await expect(transport.callTool('world_propose', { cwd: 5, ops: [] })).rejects.toThrow('world_propose "cwd" must be a string')
    await expect(transport.callTool('world_propose', { designKey: 5, ops: [] })).rejects.toThrow('world_propose "designKey" must be a string')
    await expect(transport.callTool('world_propose', { designKey: 'design:../x', ops: [] })).rejects.toThrow(BAD_DESIGN_KEY_MESSAGE)
    await expect(transport.callTool('world_propose', { ops: new Array(MAX_DESIGN_OPS + 1).fill({ op: 'nope' }) })).rejects.toThrow(`at most ${MAX_DESIGN_OPS}`)
    await expect(transport.callTool('world_propose', { designKey: 'design:none', ops: OPS })).rejects.toThrow(DESIGN_NOT_FOUND)
    await expect(transport.callTool('world_propose', { ops: OPS })).rejects.toThrow(NO_PROPOSE_ROOT_MESSAGE)
    await expect(transport.callTool('world_propose', { cwd: '  ', ops: OPS })).rejects.toThrow(NO_PROPOSE_ROOT_MESSAGE)
    await expect(transport.callTool('world_propose', { cwd: 'relative/dir', ops: OPS })).rejects.toThrow(BAD_CWD_MESSAGE)
    expect(rootFor).not.toHaveBeenCalled()

    await expect(transport.callTool('world_read', { designKey: 'design:none' })).rejects.toThrow(NO_DESIGN_MESSAGE)
    await expect(transport.callTool('world_read', { designKey: 'nope' })).rejects.toThrow(BAD_DESIGN_KEY_MESSAGE)
    await expect(transport.callTool('world_read', { designKey: 7 })).rejects.toThrow('world_read "designKey" must be a string')
    expect(readDesign).toHaveBeenCalledTimes(1)
  })

  it('a root lookup that finds nothing is the propose root message; other designer failures pass through', async () => {
    const propose = vi.fn(async () => {
      throw new Error('disk full')
    })
    const deps = { designer: { propose }, registry: { get: vi.fn(async () => null), upsert: vi.fn() }, readDesign: vi.fn() }
    const rootless = createWorldGatewayTransport({ read: vi.fn(), hasWorld: async () => true }, () => null, async () => true, deps)
    await expect(rootless.callTool('world_propose', { cwd: '/repos/app', ops: OPS })).rejects.toThrow(NO_PROPOSE_ROOT_MESSAGE)
    const linked = createWorldGatewayTransport({ read: vi.fn(), hasWorld: async () => true }, async () => ROOT, async () => true, {
      ...deps,
      registry: { get: vi.fn(async () => ({ key: 'k', source: { kind: 'project' as const, root: ROOT, linkedDesign: 'design:a' }, title: 'A', lastOpened: 1 })), upsert: vi.fn() }
    })
    await expect(linked.callTool('world_propose', { cwd: '/repos/app', ops: OPS })).rejects.toThrow('disk full')
    expect(propose).toHaveBeenCalledTimes(1)
  })

  it('without the design deps a designKey read is refused', async () => {
    const { transport } = setup()
    await expect(transport.callTool('world_read', { designKey: 'design:n1' })).rejects.toThrow(NO_DESIGN_MESSAGE)
    await expect(transport.callTool('world_propose', { cwd: '/repos/app', ops: [] })).rejects.toThrow('unknown Lumopolis tool "world_propose"')
  })

  it('a registry that cannot link the new design is a friendly error', async () => {
    const { transport, registry } = proposeSetup()
    registry.upsert.mockImplementation(async (s: WorldSource) => {
      if (s.kind !== 'design') throw new Error('EPERM C:/Users/someone/registry.json')
      return { key: keyForSource(s), source: s, title: 't', lastOpened: 1 }
    })
    await expect(transport.callTool('world_propose', { cwd: '/repos/app', ops: OPS })).rejects.toThrow(DESIGN_SAVE_FAILED)
  })

  it('world_propose goes through the gateway as lumopolis/world_propose', async () => {
    clearGatewayAudit()
    const { transport } = proposeSetup()
    const gw = createGateway({ getPolicy: () => defaultPolicy(), transports: () => [transport], scanSecrets: noSecrets })
    expect((await gw.listTools()).map((t) => t.name)).toEqual(['lumopolis/world_read', 'lumopolis/world_propose'])
    expect(await gw.callTool('lumopolis/world_propose', { cwd: '/repos/app', ops: OPS })).toMatchObject({ ok: true })
  })
})
