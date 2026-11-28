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
  WORLD_ANNOTATE_TOOL,
  NO_ANNOTATE_ROOT_MESSAGE,
  NO_PART_MESSAGE,
  PERSON_EVIDENCE_MESSAGE,
  ANNOTATE_FAILED_MESSAGE,
  AGENT_EVIDENCE,
  DESIGN_PLAN_MESSAGE,
  BAD_DESIGN_KEY_MESSAGE,
  NO_DESIGN_MESSAGE,
  NO_PROPOSE_ROOT_MESSAGE,
  createWorldGatewayTransport,
  parseWorldReadArgs,
  type WorldGatewayClient
} from '../../src/main/world/worldGatewayTransport'
import type { Claim, WorldDoc, WorldQuery, WorldReadResult } from '../../src/shared/world/types'
import { MAX_DESIGN_OPS } from '../../src/shared/world/designPatch'
import { createDesigner, DESIGN_NEEDS_PERSON, DESIGN_NOT_FOUND, DESIGN_NOTHING_APPLIED, DESIGN_SAVE_FAILED, DesignFailure } from '../../src/main/world/designer'
import { keyForSource, type SourceRegistry, type WorldEntry, type WorldSource } from '../../src/main/world/sources'
import { WORLD_SAVED_BY_NEWER, type WorldStore } from '../../src/main/world/worldStore'
import type { ExecDeps } from '../../src/main/headlessExec'
import { MAX_EVIDENCE_EXCERPT, MAX_EVIDENCE_REF } from '../../src/main/world/annotations'

const RESULT = {
  items: [{ id: 'b:auth', kind: 'building', name: 'auth', how: [{ text: 'checks tokens', evidence: [{ kind: 'file', ref: 'src/auth.ts' }] }] }],
  evidence: [{ kind: 'file', ref: 'src/auth.ts' }]
} as unknown as WorldReadResult

const noSecrets = (text: string): SecretScan => ({ hitCount: 0, hits: [], redacted: text })

function setup(opts: { has?: boolean | (() => Promise<boolean>); root?: string | null } = {}) {
  const read = vi.fn(async (_root: string, _q: WorldQuery) => RESULT)
  const has = opts.has ?? true
  const hasWorld = vi.fn(typeof has === 'function' ? has : async () => has)
  const annotate = vi.fn(async (_key: string, _id: string, _claim: Claim) => ({}) as WorldDoc)
  const client: WorldGatewayClient = { read, hasWorld, annotate }
  const rootFor = vi.fn((cwd?: string) => (opts.root !== undefined ? opts.root : cwd ? `${cwd}-root` : null))
  // The fake cwds ('/repos/app') do not exist on disk: a stub stands in for the folder check.
  const isDir = vi.fn(async () => true)
  const transport = createWorldGatewayTransport(client, rootFor, isDir)
  return { transport, read, hasWorld, rootFor, isDir, annotate }
}

describe('createWorldGatewayTransport', () => {
  it('is the trusted built-in "lumopolis", frozen, with its tools', async () => {
    const { transport } = setup()
    expect(transport.id).toBe(WORLD_GATEWAY_ID)
    expect(transport.id).toBe('lumopolis')
    expect(transport.trusted).toBe(true)
    expect(Object.isFrozen(transport)).toBe(true)
    const tools = await transport.listTools()
    expect(tools.map((t) => t.name)).toEqual([WORLD_READ_TOOL, WORLD_ANNOTATE_TOOL])
    expect(tools[0].name).toBe('world_read')
    // Short (one or two sentences) and clean: the gateway shows it unaltered.
    expect((tools[0].description as string).split('. ').length).toBeLessThanOrEqual(2)
    expect(sanitizeToolMetadata('lumopolis', 'world_read', tools[0].description, tools[0].inputSchema).level).toBe('green')
    const schema = tools[0].inputSchema as { type: string; properties: Record<string, { type: string }> }
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties)).toEqual(['ids', 'text', 'limit', 'cwd', 'cards', 'plan'])
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
    const t = createWorldGatewayTransport({ read, hasWorld: async () => true, annotate: vi.fn() }, async (cwd) => `${cwd}!`, async () => true)
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
      const t = createWorldGatewayTransport({ read, hasWorld: async () => true, annotate: vi.fn() }, rootFor)
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
    const t = createWorldGatewayTransport({ read: vi.fn(async () => RESULT), hasWorld: async () => true, annotate: vi.fn() }, rootFor, async () => {
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
    expect((await gw.listTools()).map((t) => t.name)).toEqual(['lumopolis/world_read', 'lumopolis/world_annotate'])
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
      designsDir: '/designs', newId: () => `n${++n}`, now: () => 50,
      annotations: { add: vi.fn(), list: vi.fn(async () => ({})) }
    })
    const readDesign = vi.fn(async (key: string, _q: WorldQuery) => (saved.has(key) ? RESULT : null))
    const base = setup()
    const transport = createWorldGatewayTransport(
      { read: base.read, hasWorld: base.hasWorld, annotate: base.annotate }, base.rootFor, base.isDir, { designer, registry, readDesign }
    )
    return { transport, saved, reg, registry, readDesign, rootFor: base.rootFor }
  }

  it('lists world_propose beside world_read, both short and clean, and world_read takes a designKey', async () => {
    const { transport } = proposeSetup()
    const tools = await transport.listTools()
    expect(tools.map((t) => t.name)).toEqual([WORLD_READ_TOOL, WORLD_ANNOTATE_TOOL, WORLD_PROPOSE_TOOL])
    for (const t of tools) {
      expect((t.description as string).split('. ').length).toBeLessThanOrEqual(2)
      expect(sanitizeToolMetadata('lumopolis', t.name, t.description, t.inputSchema).level).toBe('green')
    }
    expect(Object.keys((tools[0].inputSchema as { properties: object }).properties)).toEqual(['ids', 'text', 'limit', 'cwd', 'cards', 'plan', 'designKey'])
    expect((tools[0].inputSchema as { required?: string[] }).required).toBeUndefined()
    expect(Object.keys((tools[1].inputSchema as { properties: object }).properties)).toEqual(['id', 'text', 'evidence', 'cwd', 'designKey'])
    expect(Object.keys((tools[2].inputSchema as { properties: object }).properties)).toEqual(['ops', 'cwd', 'designKey'])
    expect((tools[2].inputSchema as { required: string[] }).required).toEqual(['ops'])
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

  it("world_propose refuses removing a district that still has buildings, with the person's-OK sentence, and applies none of that change (DSN 2026-11-28)", async () => {
    const { transport, saved, reg } = proposeSetup()
    expect(JSON.parse(await transport.callTool('world_propose', { cwd: ROOT, ops: OPS }))).toEqual({ key: 'design:n1', applied: 3, skipped: 0 })
    const before = structuredClone(saved.get('design:n1'))
    await expect(transport.callTool('world_propose', {
      designKey: 'design:n1', ops: [{ op: 'addBuilding', id: 'pay', districtId: 'core', name: 'Payments' }, { op: 'remove', id: 'core' }]
    })).rejects.toThrow(DESIGN_NEEDS_PERSON)
    expect(saved.get('design:n1')).toEqual(before)
    // An empty district is still removed.
    await transport.callTool('world_propose', { designKey: 'design:n1', ops: [{ op: 'addDistrict', id: 'spare', name: 'Spare' }] })
    expect(JSON.parse(await transport.callTool('world_propose', { designKey: 'design:n1', ops: [{ op: 'remove', id: 'spare' }] })))
      .toEqual({ key: 'design:n1', applied: 1, skipped: 0 })
    expect(saved.get('design:n1')?.districts.map((d) => d.id)).toEqual(['core'])
    // A first propose for a folder that fills a district and removes it makes and links no design.
    const fresh = proposeSetup()
    await expect(fresh.transport.callTool('world_propose', { cwd: ROOT, ops: [...OPS, { op: 'remove', id: 'core' }] })).rejects.toThrow(DESIGN_NEEDS_PERSON)
    expect(fresh.saved.size).toBe(0)
    expect(fresh.reg.size).toBe(0)
    expect(reg.size).toBe(2)
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
    expect((await gw.listTools()).map((t) => t.name)).toEqual(['lumopolis/world_read', 'lumopolis/world_annotate', 'lumopolis/world_propose'])
    expect(await gw.callTool('lumopolis/world_propose', { cwd: '/repos/app', ops: OPS })).toMatchObject({ ok: true })
  })
})

describe('world_read cards and plan flags', () => {
  it('parses them as booleans, and a false or null flag is absent', () => {
    expect(parseWorldReadArgs({ cards: true, plan: true, cwd: '/a' }).query).toEqual({ cards: true, plan: true })
    expect(parseWorldReadArgs({ cards: false, plan: null }).query).toEqual({})
    expect(() => parseWorldReadArgs({ cards: 'yes' })).toThrow('"cards" must be true or false')
    expect(() => parseWorldReadArgs({ plan: 1 })).toThrow('"plan" must be true or false')
  })

  it('passes them to the client', async () => {
    const { transport, read } = setup()
    await transport.callTool('world_read', { cwd: '/repos/app', cards: true, plan: true })
    expect(read).toHaveBeenCalledWith('/repos/app-root', { cards: true, plan: true })
  })
})

describe('world_read plan on a design', () => {
  it('refuses plan with a designKey, saying it is for a project world', async () => {
    const { transport } = setup()
    await expect(transport.callTool('world_read', { designKey: 'design:n1', plan: true })).rejects.toThrow(DESIGN_PLAN_MESSAGE)
    expect(DESIGN_PLAN_MESSAGE).toContain('project')
  })
})

describe('world_annotate', () => {
  const claimOf = (annotate: { mock: { calls: unknown[][] } }, n = 0): Claim => annotate.mock.calls[n][2] as Claim
  const ROOT = process.cwd()
  const here = (...p: string[]): string => join(ROOT, ...p)

  it('stores an observed claim under the project key and says so', async () => {
    const { transport, annotate, hasWorld } = setup({ root: ROOT })
    const out = JSON.parse(await transport.callTool('world_annotate', {
      cwd: '/repos/app', id: 'b:auth', text: '  checks tokens  ', evidence: [{ kind: 'file', ref: 'src/auth.ts', excerpt: 'x' }]
    }))
    expect(out).toEqual({ ok: true, id: 'b:auth', state: 'observed', evidence: 1, dropped: 0 })
    expect(hasWorld).toHaveBeenCalledWith(ROOT)
    expect(annotate).toHaveBeenCalledWith(keyForSource({ kind: 'project', root: ROOT }), 'b:auth', {
      text: 'checks tokens', state: 'observed', evidence: [{ kind: 'file', ref: 'src/auth.ts', excerpt: 'x' }]
    })
  })

  it('forces state observed even when the agent sends verified, and refuses person evidence', async () => {
    const { transport, annotate } = setup({ root: ROOT })
    await transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't', state: 'verified', evidence: [{ kind: 'test', ref: 't.spec.ts' }] })
    expect(claimOf(annotate).state).toBe('observed')
    await expect(transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't', evidence: [{ kind: 'person', ref: 'me' }] })).rejects.toThrow(PERSON_EVIDENCE_MESSAGE)
    expect(annotate).toHaveBeenCalledTimes(1)
  })

  it('says how many evidence items were dropped as outside the root', async () => {
    const { transport } = setup({ root: ROOT })
    const out = JSON.parse(await transport.callTool('world_annotate', {
      cwd: '/a', id: 'b1', text: 't',
      evidence: [{ kind: 'file', ref: join(ROOT, '..', 'x', 'a.ts') }, { kind: 'file', ref: join(ROOT, '..', 'x', 'b.ts') }, { kind: 'symbol', ref: 'ok' }]
    }))
    expect(out).toMatchObject({ evidence: 1, dropped: 2 })
  })

  it('drops an overlong ref unread and cuts an overlong excerpt at the boundary', async () => {
    const { transport, annotate } = setup({ root: ROOT })
    const out = JSON.parse(await transport.callTool('world_annotate', {
      cwd: '/a', id: 'b1', text: 't',
      evidence: [
        { kind: 'file', ref: 'a/'.repeat(MAX_EVIDENCE_REF) + 'x.ts' },
        { kind: 'symbol', ref: 's'.repeat(MAX_EVIDENCE_REF), excerpt: 'e'.repeat(MAX_EVIDENCE_EXCERPT * 50) }
      ]
    }))
    expect(out).toMatchObject({ evidence: 1, dropped: 1 })
    const [kept] = claimOf(annotate).evidence
    expect(kept.ref).toHaveLength(MAX_EVIDENCE_REF)
    expect(kept.excerpt).toHaveLength(MAX_EVIDENCE_EXCERPT)
  })

  it('uses the agent evidence when none was given or none survived', async () => {
    const { transport, annotate } = setup({ root: ROOT })
    await transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't' })
    await transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't', evidence: null })
    await transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't', evidence: [{ kind: 'file', ref: join(ROOT, '..', 'elsewhere', 'x.ts') }] })
    for (const n of [0, 1, 2]) expect(claimOf(annotate, n).evidence).toEqual([AGENT_EVIDENCE])
  })

  it('caps text at 400 chars and evidence at 8, makes inside-root paths relative and drops outside ones', async () => {
    const { transport, annotate } = setup({ root: ROOT })
    const evidence = [
      { kind: 'file', ref: here('src', 'a.ts') },
      { kind: 'file', ref: join(ROOT, '..', 'outside', 'b.ts') },
      ...Array.from({ length: 12 }, (_, i) => ({ kind: 'symbol', ref: `sym${i}` }))
    ]
    await transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 'x'.repeat(500), evidence })
    const c = claimOf(annotate)
    expect(c.text).toHaveLength(400)
    expect(c.evidence).toHaveLength(8)
    expect(c.evidence.map((e) => e.ref)).toEqual(['src/a.ts', ...Array.from({ length: 7 }, (_, i) => `sym${i}`)])
  })

  it('refuses a relative path that climbs out of the root', async () => {
    const { transport, annotate } = setup({ root: ROOT })
    await expect(transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't', evidence: [{ kind: 'file', ref: '../../etc/x' }] })).rejects.toThrow('inside the project folder')
    expect(annotate).not.toHaveBeenCalled()
  })

  it('annotates a design by key, keeping relative paths and dropping absolute ones', async () => {
    const { transport, annotate, hasWorld } = setup()
    const out = JSON.parse(await transport.callTool('world_annotate', {
      designKey: 'design:n1', cwd: null, id: 'auth', text: 'planned', evidence: [{ kind: 'file', ref: 'src/a.ts' }, { kind: 'file', ref: here('x.ts') }]
    }))
    expect(out.evidence).toBe(1)
    expect(annotate).toHaveBeenCalledWith('design:n1', 'auth', { text: 'planned', state: 'observed', evidence: [{ kind: 'file', ref: 'src/a.ts' }] })
    expect(hasWorld).not.toHaveBeenCalled()
  })

  it('validates its arguments in the same style as the other tools', async () => {
    const { transport, annotate } = setup()
    const call = (a: unknown) => transport.callTool('world_annotate', a as Record<string, unknown>)
    await expect(call({ cwd: '/a', text: 't' })).rejects.toThrow('"id" must be the id')
    await expect(call({ cwd: '/a', id: '', text: 't' })).rejects.toThrow('"id" must be the id')
    await expect(call({ cwd: '/a', id: 'b1', text: '  ' })).rejects.toThrow('"text" must be a non-empty string')
    await expect(call({ cwd: '/a', id: 'b1', text: 5 })).rejects.toThrow('"text" must be a non-empty string')
    await expect(call(null)).rejects.toThrow('"id" must be the id')
    await expect(call([])).rejects.toThrow('"id" must be the id')
    await expect(call({ cwd: '/a', id: 'b1', text: 't', evidence: 'x' })).rejects.toThrow('"evidence" must be an array')
    for (const bad of [{ kind: 'nope', ref: 'a' }, { kind: 'file' }, { kind: 'file', ref: ' ' }, null, 'file']) {
      await expect(call({ cwd: '/a', id: 'b1', text: 't', evidence: [bad] })).rejects.toThrow('evidence needs a kind')
    }
    await expect(call({ cwd: 5, id: 'b1', text: 't' })).rejects.toThrow('world_annotate "cwd" must be a string')
    await expect(call({ designKey: 5, id: 'b1', text: 't' })).rejects.toThrow('world_annotate "designKey" must be a string')
    await expect(call({ designKey: 'design:../x', id: 'b1', text: 't' })).rejects.toThrow(BAD_DESIGN_KEY_MESSAGE)
    await expect(call({ id: 'b1', text: 't' })).rejects.toThrow(NO_ANNOTATE_ROOT_MESSAGE)
    await expect(call({ cwd: '  ', id: 'b1', text: 't' })).rejects.toThrow(NO_ANNOTATE_ROOT_MESSAGE)
    await expect(call({ cwd: 'relative', id: 'b1', text: 't' })).rejects.toThrow(BAD_CWD_MESSAGE)
    expect(annotate).not.toHaveBeenCalled()
  })

  it('answers with the same messages as world_read when there is no root or no world', async () => {
    await expect(setup({ root: null }).transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't' })).rejects.toThrow(NO_ANNOTATE_ROOT_MESSAGE)
    await expect(setup({ root: ' ' }).transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't' })).rejects.toThrow(NO_ANNOTATE_ROOT_MESSAGE)
    await expect(setup({ has: false }).transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't' })).rejects.toThrow(NO_WORLD_MESSAGE)
  })

  it('refuses an unknown id with "No part with that id."', async () => {
    const { transport, annotate } = setup({ root: ROOT })
    annotate.mockRejectedValueOnce(new Error(NO_PART_MESSAGE))
    await expect(transport.callTool('world_annotate', { cwd: '/a', id: 'zzz', text: 't' })).rejects.toThrow('No part with that id.')
  })

  it('maps a vanished world and other failures to clean messages', async () => {
    const { transport, annotate } = setup({ root: ROOT })
    annotate.mockRejectedValueOnce(new Error('No world with that key.'))
    await expect(transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't' })).rejects.toThrow(NO_WORLD_MESSAGE)
    annotate.mockRejectedValueOnce(new Error('No world with that key.'))
    await expect(transport.callTool('world_annotate', { designKey: 'design:n1', id: 'b1', text: 't' })).rejects.toThrow(NO_DESIGN_MESSAGE)
    annotate.mockRejectedValueOnce(new Error('disk full: C:/some/path'))
    await expect(transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't' })).rejects.toThrow(ANNOTATE_FAILED_MESSAGE)
    annotate.mockRejectedValueOnce('odd')
    await expect(transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't' })).rejects.toThrow(ANNOTATE_FAILED_MESSAGE)
    // DSN Round 1, item 10: the host's refusal of a world a newer Termpolis saved keeps its own words.
    annotate.mockRejectedValueOnce(Object.assign(new Error(WORLD_SAVED_BY_NEWER), { code: 'WORLD_SAVED_BY_NEWER' }))
    await expect(transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't' })).rejects.toThrow(WORLD_SAVED_BY_NEWER)
  })

  describe("a design's note goes to main's designer, which writes the design under its lock (DSN D1)", () => {
    const withDesign = (annotate: ReturnType<typeof vi.fn>) => {
      const base = setup({ root: ROOT })
      const deps = { designer: { propose: vi.fn(), annotate }, registry: { get: vi.fn(async () => null), upsert: vi.fn() }, readDesign: vi.fn() }
      const transport = createWorldGatewayTransport({ read: base.read, hasWorld: base.hasWorld, annotate: base.annotate }, base.rootFor, base.isDir, deps)
      return { transport, client: base.annotate }
    }

    it('stores an agent note on a design through the designer, and a project note still through the host', async () => {
      const annotate = vi.fn(async () => ({}) as WorldDoc)
      const { transport, client } = withDesign(annotate)
      const out = JSON.parse(await transport.callTool('world_annotate', { designKey: 'design:n1', id: 'auth', text: 'planned', evidence: [{ kind: 'file', ref: 'src/a.ts' }] }))
      expect(out).toEqual({ ok: true, id: 'auth', state: 'observed', evidence: 1, dropped: 0 })
      expect(annotate).toHaveBeenCalledWith('design:n1', 'auth', { text: 'planned', state: 'observed', evidence: [{ kind: 'file', ref: 'src/a.ts' }] })
      expect(client).not.toHaveBeenCalled()
      await transport.callTool('world_annotate', { cwd: '/a', id: 'b1', text: 't' })
      expect(client).toHaveBeenCalledTimes(1)
      expect(annotate).toHaveBeenCalledTimes(1)
    })

    it.each([
      [new DesignFailure(DESIGN_NOT_FOUND), NO_DESIGN_MESSAGE],
      [new DesignFailure(NO_PART_MESSAGE), NO_PART_MESSAGE],
      [new DesignFailure(DESIGN_SAVE_FAILED), ANNOTATE_FAILED_MESSAGE],
      [new Error('disk full: C:/some/path'), ANNOTATE_FAILED_MESSAGE],
      // DSN Round 1, item 10: a design a newer Termpolis saved says so, as the pane does.
      [new DesignFailure(WORLD_SAVED_BY_NEWER), WORLD_SAVED_BY_NEWER]
    ])('answers the designer refusal %s with the message the host path gives', async (e, message) => {
      const { transport } = withDesign(vi.fn(async () => { throw e }))
      await expect(transport.callTool('world_annotate', { designKey: 'design:n1', id: 'b1', text: 't' })).rejects.toThrow(message)
    })
  })

  it('the tool description is at most 300 characters and is listed only through the gateway', async () => {
    const { transport } = setup()
    const tool = (await transport.listTools()).find((t) => t.name === 'world_annotate')
    expect((tool?.description as string).length).toBeLessThanOrEqual(300)
    expect(sanitizeToolMetadata('lumopolis', 'world_annotate', tool?.description, tool?.inputSchema).level).toBe('green')
    expect((tool?.inputSchema as { required: string[] }).required).toEqual(['id', 'text'])
    clearGatewayAudit()
    const gw = createGateway({ getPolicy: () => defaultPolicy(), transports: () => [transport], scanSecrets: noSecrets })
    expect((await gw.listTools()).map((t) => t.name)).toContain('lumopolis/world_annotate')
    const res = await gw.callTool('lumopolis/world_annotate', { cwd: '/a', id: 'b:auth', text: 'ok' })
    expect(res.ok).toBe(true)
  })
})
