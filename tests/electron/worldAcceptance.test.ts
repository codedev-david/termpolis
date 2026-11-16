// Lumopolis acceptance (spec 5.3, quality bar for compiler stages 1 to 6): compile a world for this
// repository's own src/ with no model (llm: null) and check that it recovers the buildings and
// connections of the hand-made v2 prototype (.superpowers/brainstorm/.../world-relationships.html):
// the screen, the gatekeeper, the terminal host, the memory host, the proxy, the gateway, the code
// graph and the remote bridge, plus the swarm, as distinct buildings, joined by the connections
// between them, and recognisable by name with labelling off.
//
// The code graph is built in-test from src/ with the real extractor (tree-sitter, heuristic
// fallback), exactly as buildCodeGraph builds it in the app, then snapshotted the way worldClient
// snapshots it for the utility process.
import { readdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { _resetCodeGraphForTests, buildCodeGraph, graphSnapshot } from '../../src/main/codeGraph'
import { compileWorld } from '../../src/main/world/compile'
import { nameStem } from '../../src/main/world/group'
import type { Building, WorldDoc, WorldEdge } from '../../src/shared/world/types'

const REPO = resolve(__dirname, '../..').replace(/\\/g, '/')
const KEY = 'lumopolis-acceptance'
const COMPILE_BUDGET_MS = 20_000

/** Every file under src/, absolute and `/`-separated (buildCodeGraph skips what it cannot index). */
function srcFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p)
      } else out.push(p)
    }
  }
  walk(`${REPO}/src`)
  return out.sort()
}

let world: WorldDoc
let compileMs = 0

beforeAll(async () => {
  _resetCodeGraphForTests()
  await buildCodeGraph({ listFiles: async () => srcFiles(), readFile: (f) => readFile(f, 'utf8') }, KEY)
  const snap = graphSnapshot(KEY, REPO)
  const started = performance.now()
  world = await compileWorld(
    { snap, projectKey: KEY, head: { head: '', dirty: false }, previous: null },
    {
      readFile: async (p) => {
        try {
          return await readFile(p, 'utf8')
        } catch {
          return null
        }
      },
      glob: async () => [],
      label: { llm: null, cache: { get: async () => null, set: async () => undefined }, excerpt: async () => '' },
      now: () => 0
    }
  )
  compileMs = performance.now() - started
  // The numbers the task report quotes.
  console.log(
    JSON.stringify(
      {
        compileMs: Math.round(compileMs),
        files: snap.files.length,
        districts: world.districts.map((d) => `${d.id} (${d.members.length})`),
        parts: PROTOTYPE_PARTS.map((p) => {
          const b = ownerOf(p)
          const own = b?.members.filter((m) => (p.endsWith('/') ? m.startsWith(p) : m === p)).length
          return `${p} -> ${b?.id} "${b?.name}" ${own}/${b?.members.length}`
        }),
        boundaryEdges: world.edges.filter((e) => e.label !== 'imports').length,
        buildings: world.buildings.map((b) => `${b.id} "${b.name}" [${b.process}] ${b.members.length}`)
      },
      null,
      1
    )
  )
}, 300_000)

afterAll(() => _resetCodeGraphForTests())

/** The building holding `path`: a file, or for a folder ending in '/' the building holding most of its files. */
function ownerOf(path: string): Building | undefined {
  const count = (b: Building): number => b.members.filter((m) => (path.endsWith('/') ? m.startsWith(path) : m === path)).length
  return [...world.buildings].sort((a, z) => count(z) - count(a)).find((b) => count(b) > 0)
}

/** True when the edge carries a boundary of `kind` (fallback labels read "kind key, kind key"). */
function carries(e: WorldEdge, kind: string): boolean {
  return e.label.split(', ').some((part) => part.startsWith(`${kind} `))
}

const processOf = (id: string): string | undefined => world.buildings.find((b) => b.id === id)?.process

const PTY_HOST = 'src/main/ptyHost.ts'
const MAIN = 'src/main/index.ts'
const PRELOAD = 'src/preload/index.ts'
/** The screen: the renderer's entry, which mounts the page. */
const SCREEN = 'src/renderer/src/main.tsx'
const SWARM = 'src/main/swarmManager.ts'

const PROTOTYPE_PARTS = [
  'src/main/memoryHost.ts',
  'src/main/headroomProxy/',
  'src/main/mcpGateway/',
  'src/main/codeGraph.ts',
  'src/main/remoteBridgeSupervisor.ts',
  PRELOAD,
  PTY_HOST,
  SWARM,
  SCREEN
]

/** What a part is called: a folder's name, an entry file's folder, else the file's base name. */
function partName(p: string): string {
  const segs = p.replace(/\/$/, '').split('/')
  const base = segs[segs.length - 1].replace(/\..*$/, '')
  if (p.endsWith('/')) return base
  return base === 'index' || base === 'main' ? segs[segs.length - 2] : base
}

/**
 * The module a member belongs to, for comparing shares: a file in a sub-folder of `dir`
 * counts as that sub-folder, a file beside it as its leading name word (the name family), a file
 * elsewhere as its own folder.
 */
function moduleOf(member: string, dir: string): string {
  if (!member.startsWith(dir)) return member.slice(0, member.lastIndexOf('/') + 1)
  const rest = member.slice(dir.length)
  const slash = rest.indexOf('/')
  return slash >= 0 ? `${dir}${rest.slice(0, slash)}/` : `${dir}~${nameStem(rest) || rest}`
}

describe('Lumopolis acceptance on the Termpolis repository', () => {
  it('has a building for each part of the v2 prototype', () => {
    for (const p of PROTOTYPE_PARTS) expect(ownerOf(p), p).toBeDefined()
  })

  it('keeps those parts in distinct buildings', () => {
    const ids = PROTOTYPE_PARTS.map((p) => ownerOf(p)?.id)
    expect(new Set(ids).size).toBe(PROTOTYPE_PARTS.length)
  })

  // Electron loads the preload into the renderer process, so the preload's ipcRenderer calls are
  // renderer -> main edges; the page reaches the preload over its contextBridge (window.<name>).
  it('joins the renderer and main over IPC', () => {
    const renderer = world.buildings.filter((b) => b.process === 'renderer')
    const main = world.buildings.filter((b) => b.process === 'main')
    expect(renderer.length).toBeGreaterThan(0)
    expect(main.length).toBeGreaterThan(0)
    const ipc = world.edges.filter(
      (e) => carries(e, 'ipc') && [processOf(e.from), processOf(e.to)].sort().join() === 'main,renderer'
    )
    expect(ipc.length).toBeGreaterThan(0)
  })

  // With labelling off a building is known by its name alone, so the parts must not share one.
  it('names the parts distinctly with labelling off', () => {
    const names = PROTOTYPE_PARTS.map((p) => ownerOf(p)?.name)
    expect(new Set(names).size, names.join(', ')).toBe(PROTOTYPE_PARTS.length)
  })

  // A building named like its district, or like the main process, reads as that district or
  // process. Only the main, renderer and preload entry buildings may carry their own role's name.
  it('names no building after its district or the main process unless it is that entry', () => {
    const mainName = ownerOf(MAIN)?.name
    const entryRole = new Map([
      [ownerOf(MAIN)?.id, 'main'],
      [ownerOf(SCREEN)?.id, 'renderer'],
      [ownerOf(PRELOAD)?.id, 'preload']
    ])
    for (const b of world.buildings) {
      const district = world.districts.find((d) => d.id === b.districtId)
      if (b.name === district?.name || b.name === mainName) expect(entryRole.get(b.id), `${b.id} "${b.name}"`).toBe(b.name)
    }
  })

  // Each part is recognisable in its building: its own module is the largest one there, or the
  // building is named for it (the same leading name word: "swarmMemory" for the swarm).
  it('makes each part the core or the namesake of its building', () => {
    for (const p of PROTOTYPE_PARTS) {
      const b = ownerOf(p) as Building
      const dir = p.endsWith('/') ? p.slice(0, p.slice(0, -1).lastIndexOf('/') + 1) : p.slice(0, p.lastIndexOf('/') + 1)
      const mine = moduleOf(p.endsWith('/') ? `${p}x` : p, dir)
      // Shares are of modules, not of one file: memoryHost.ts alone in its building is its core.
      const counts = new Map<string, number>()
      for (const m of b.members) counts.set(moduleOf(m, dir), (counts.get(moduleOf(m, dir)) ?? 0) + 1)
      const core = Math.max(...counts.values()) === counts.get(mine)
      const namesake = nameStem(b.name) !== '' && nameStem(b.name) === nameStem(partName(p))
      expect(core || namesake, `${p} in ${b.id} "${b.name}" (${counts.get(mine) ?? 0}/${b.members.length})`).toBe(true)
    }
  })

  it('has main fork the memory host', () => {
    const host = ownerOf('src/main/memoryHost.ts') as Building
    const forks = world.edges.filter((e) => e.to === host.id && carries(e, 'fork'))
    expect(forks.length).toBeGreaterThan(0)
    expect(forks.some((e) => processOf(e.from) === 'main')).toBe(true)
  })

  it('has main reach the proxy by fork or by handing over ANTHROPIC_BASE_URL', () => {
    const proxy = ownerOf('src/main/headroomProxy/') as Building
    const reach = world.edges.filter(
      (e) => e.to === proxy.id && (carries(e, 'fork') || e.label.includes('env ANTHROPIC_BASE_URL'))
    )
    expect(reach.length).toBeGreaterThan(0)
    expect(reach.some((e) => processOf(e.from) === 'main')).toBe(true)
  })

  it('stays within 12 districts and 60 buildings', () => {
    expect(world.districts.length).toBeLessThanOrEqual(12)
    expect(world.buildings.length).toBeLessThanOrEqual(60)
  })

  it('compiles in under 20 seconds', () => {
    expect(compileMs).toBeLessThan(COMPILE_BUDGET_MS)
  })

  it('names the main process entry', () => {
    expect(ownerOf(MAIN)?.process).toBe('main')
  })
})
